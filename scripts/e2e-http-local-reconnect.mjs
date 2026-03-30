#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HOST = '127.0.0.1';
const RESERVED_PORTS = new Set();
const MCP_HTTP_PORT = await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(MCP_HTTP_PORT);
const AGENT_PORT = await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(AGENT_PORT);
const EXTENSION_PORT = await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(EXTENSION_PORT);
const SESSION_ID = 'http-local-reconnect-session';
const MCP_URL = `http://${HOST}:${MCP_HTTP_PORT}/mcp`;

function findFreePort(exclude) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port || exclude.has(port)) {
          findFreePort(exclude).then(resolve, reject);
          return;
        }
        resolve(port);
      });
    });
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

async function assertPortsFree() {
  const [httpBusy, agentBusy, extensionBusy] = await Promise.all([
    probePort(MCP_HTTP_PORT),
    probePort(AGENT_PORT),
    probePort(EXTENSION_PORT),
  ]);

  if (httpBusy || agentBusy || extensionBusy) {
    throw new Error(
      `Test ports are already in use (${MCP_HTTP_PORT}/${AGENT_PORT}/${EXTENSION_PORT}). Stop existing processes and retry.`
    );
  }
}

async function waitForPort(port, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

function captureMessages(ws) {
  const messages = [];
  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()));
    } catch {
      // Ignore malformed harness messages.
    }
  });
  return messages;
}

async function waitForMessage(queue, predicate, label, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const idx = queue.findIndex(predicate);
    if (idx >= 0) {
      const [message] = queue.splice(idx, 1);
      return message;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for message: ${label}`);
}

function connectWebSocket(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out connecting to ${url}`));
    }, timeoutMs);

    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function onceProcessExit(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('exit', finish);
    child.once('close', finish);
  });
}

async function main() {
  let relay = null;
  let serverProcess = null;
  let extension1 = null;
  let extension2 = null;
  let client = null;
  const stateDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-http-local-reconnect-'));

  try {
    await assertPortsFree();

    relay = spawn(process.execPath, ['dist/relay-daemon.js'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        VIBE_MCP_AGENT_PORT: String(AGENT_PORT),
        VIBE_MCP_EXTENSION_PORT: String(EXTENSION_PORT),
        VIBE_MCP_STATE_DIR: stateDir,
      },
    });
    relay.stdout.on('data', (chunk) => process.stdout.write(chunk.toString()));
    relay.stderr.on('data', (chunk) => process.stderr.write(chunk.toString()));

    await Promise.all([waitForPort(AGENT_PORT), waitForPort(EXTENSION_PORT)]);

    serverProcess = spawn(
      process.execPath,
      [
        'dist/cli.js',
        'start',
        '--transport',
        'http',
        '--host',
        HOST,
        '--http-port',
        String(MCP_HTTP_PORT),
        '--port',
        String(AGENT_PORT),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          VIBE_MCP_STATE_DIR: stateDir,
        },
      },
    );
    serverProcess.stdout.on('data', (chunk) => process.stdout.write(chunk.toString()));
    serverProcess.stderr.on('data', (chunk) => process.stderr.write(chunk.toString()));

    await waitForPort(MCP_HTTP_PORT);

    extension1 = await connectWebSocket(`ws://${HOST}:${EXTENSION_PORT}`);
    const extension1Messages = captureMessages(extension1);
    extension1.send(JSON.stringify({ type: 'connected', sessionId: SESSION_ID }));

    client = new Client({ name: 'vibe-mcp-http-local-reconnect', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    await client.connect(transport);

    const listToolsPromise = client.listTools();
    const listToolsRequest = await waitForMessage(
      extension1Messages,
      (msg) => msg.type === 'list_tools',
      'initial list_tools to extension #1'
    );
    extension1.send(JSON.stringify({
      type: 'tools_list',
      requestId: listToolsRequest.requestId,
      data: [
        {
          name: 'echo',
          description: 'Echo a string',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
            },
            required: ['text'],
          },
        },
      ],
    }));

    const tools = await listToolsPromise;
    if (!tools.tools.some((tool) => tool.name === 'echo')) {
      throw new Error(`Expected echo tool in listTools response: ${JSON.stringify(tools)}`);
    }

    const callResultPromise = client.callTool({
      name: 'echo',
      arguments: { text: 'hello after reconnect' },
    });
    const forwardedToExtension1 = await waitForMessage(
      extension1Messages,
      (msg) => msg.type === 'call_tool' && msg.data?.name === 'echo',
      'initial call_tool forwarded to extension #1'
    );

    extension2 = await connectWebSocket(`ws://${HOST}:${EXTENSION_PORT}`);
    const extension2Messages = captureMessages(extension2);
    extension2.send(JSON.stringify({ type: 'connected', sessionId: SESSION_ID }));

    const listToolsToExtension2 = await waitForMessage(
      extension2Messages,
      (msg) => msg.type === 'list_tools',
      'list_tools to extension #2 after reconnect'
    );
    extension2.send(JSON.stringify({
      type: 'tools_list',
      requestId: listToolsToExtension2.requestId,
      data: [
        {
          name: 'echo',
          description: 'Echo a string',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
            },
            required: ['text'],
          },
        },
      ],
    }));
    const replayedToExtension2 = await waitForMessage(
      extension2Messages,
      (msg) => msg.type === 'call_tool' && msg.requestId === forwardedToExtension1.requestId,
      'replayed call_tool routed to extension #2'
    );
    extension2.send(JSON.stringify({
      type: 'tool_result',
      requestId: replayedToExtension2.requestId,
      data: {
        success: true,
        content: [{ type: 'text', text: 'hello after reconnect' }],
      },
    }));

    const callResult = await callResultPromise;
    const textContent = callResult.content.find((item) => item.type === 'text');
    if (!textContent || textContent.text !== 'hello after reconnect') {
      throw new Error(`Unexpected tool result after reconnect: ${JSON.stringify(callResult)}`);
    }

    await client.close();
    console.log('http local reconnect e2e ok');
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore cleanup errors
      }
    }
    if (extension1 && extension1.readyState === WebSocket.OPEN) {
      extension1.close();
    }
    if (extension2 && extension2.readyState === WebSocket.OPEN) {
      extension2.close();
    }
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await onceProcessExit(serverProcess);
    }
    if (relay) {
      relay.kill('SIGTERM');
      await onceProcessExit(relay);
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
