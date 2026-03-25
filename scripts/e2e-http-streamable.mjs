#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const RELAY_HOST = '127.0.0.1';
const configuredHttpPort = getConfiguredPort('VIBE_MCP_TEST_HTTP_PORT', 'E2E_HTTP_PORT');
const configuredRelayPort = getConfiguredPort('VIBE_MCP_TEST_RELAY_PORT', 'E2E_RELAY_PORT');
const RESERVED_PORTS = new Set();
const MCP_HTTP_PORT = configuredHttpPort ?? await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(MCP_HTTP_PORT);
const RELAY_PORT = configuredRelayPort ?? await findFreePort(RESERVED_PORTS);
const RELAY_URL = `ws://${RELAY_HOST}:${RELAY_PORT}`;
const REMOTE_UUID = 'test-http-relay-uuid';
const MCP_URL = `http://${RELAY_HOST}:${MCP_HTTP_PORT}/mcp`;

function getConfiguredPort(...names) {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) continue;
    const port = Number.parseInt(raw, 10);
    if (Number.isFinite(port) && port > 0 && port <= 65535) {
      return port;
    }
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return null;
}

function findFreePort(exclude) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, RELAY_HOST, () => {
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
    const socket = net.connect({ host: RELAY_HOST, port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
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

function waitForWebSocketMessage(ws, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for websocket message'));
    }, timeoutMs);

    const onMessage = (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (!predicate(parsed)) {
          return;
        }
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(parsed);
      } catch {
        // ignore malformed harness messages
      }
    };

    ws.on('message', onMessage);
  });
}

async function main() {
  let wss;
  let serverProcess;
  const stateDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-http-e2e-'));

  try {
    if (await probePort(MCP_HTTP_PORT)) {
      throw new Error(`HTTP test port ${MCP_HTTP_PORT} is already in use`);
    }
    if (await probePort(RELAY_PORT)) {
      throw new Error(`Relay test port ${RELAY_PORT} is already in use`);
    }

    wss = new WebSocketServer({ host: RELAY_HOST, port: RELAY_PORT });

    const extensionConnected = new Promise((resolve) => {
      wss.on('connection', (ws, req) => {
        if (req.url !== `/${REMOTE_UUID}`) {
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: 'extension_status', connected: true }));
        resolve(ws);
      });
    });

    serverProcess = spawn(
      process.execPath,
      [
        'dist/cli.js',
        'start',
        '--transport',
        'http',
        '--host',
        RELAY_HOST,
        '--http-port',
        String(MCP_HTTP_PORT),
        '--remote',
        REMOTE_UUID,
        '--relay-url',
        RELAY_URL,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          VIBE_MCP_STATE_DIR: stateDir,
        },
      },
    );

    let stderr = '';
    serverProcess.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const [extensionWs] = await Promise.all([
      extensionConnected,
      waitForPort(MCP_HTTP_PORT),
    ]);

    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    const client = new Client({ name: 'vibe-mcp-http-e2e', version: '1.0.0' });

    await client.connect(transport);
    const listToolsPromise = waitForWebSocketMessage(
      extensionWs,
      (message) => message.type === 'list_tools',
    );
    const toolsPromise = client.listTools();
    const listToolsRequest = await listToolsPromise;

    extensionWs.send(JSON.stringify({
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

    const tools = await toolsPromise;
    if (!tools.tools.some((tool) => tool.name === 'echo')) {
      throw new Error(`Expected echo tool in listTools response: ${JSON.stringify(tools)}`);
    }

    const callToolPromise = waitForWebSocketMessage(
      extensionWs,
      (message) => message.type === 'call_tool' && message.data?.name === 'echo',
    );
    const callResultPromise = client.callTool({
      name: 'echo',
      arguments: { text: 'hello from http' },
    });
    const callRequest = await callToolPromise;

    extensionWs.send(JSON.stringify({
      type: 'tool_result',
      requestId: callRequest.requestId,
      data: {
        success: true,
        content: [{ type: 'text', text: 'hello from http' }],
      },
    }));

    const callResult = await callResultPromise;
    const textContent = callResult.content.find((item) => item.type === 'text');
    if (!textContent || textContent.text !== 'hello from http') {
      throw new Error(`Unexpected tool result: ${JSON.stringify(callResult)}`);
    }

    await client.close();
    console.log('http e2e ok');
  } finally {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await onceProcessExit(serverProcess);
    }
    if (wss) {
      await new Promise((resolve, reject) => {
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function onceProcessExit(child) {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.once('close', () => resolve());
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
