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
RESERVED_PORTS.add(RELAY_PORT);
const RELAY_PORT_B = await findFreePort(RESERVED_PORTS);
const RELAY_URL = `ws://${RELAY_HOST}:${RELAY_PORT}`;
const RELAY_URL_B = `ws://${RELAY_HOST}:${RELAY_PORT_B}`;
const REMOTE_UUID = '22222222-2222-4222-8222-222222222222';
const REMOTE_UUID_B = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = REMOTE_UUID;
const SESSION_ID_B = REMOTE_UUID_B;
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

function withTimeout(promise, label, timeoutMs = 10_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  let remoteA;
  let remoteB;
  let serverProcess;
  const stateDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-http-e2e-'));

  try {
    if (await probePort(MCP_HTTP_PORT)) {
      throw new Error(`HTTP test port ${MCP_HTTP_PORT} is already in use`);
    }
    if (await probePort(RELAY_PORT)) {
      throw new Error(`Relay test port ${RELAY_PORT} is already in use`);
    }
    if (await probePort(RELAY_PORT_B)) {
      throw new Error(`Relay test port ${RELAY_PORT_B} is already in use`);
    }

    remoteA = startFakeRemoteRelay(RELAY_PORT, REMOTE_UUID, SESSION_ID);
    remoteB = startFakeRemoteRelay(RELAY_PORT_B, REMOTE_UUID_B, SESSION_ID_B);

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
        `${RELAY_URL}/${REMOTE_UUID}`,
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
      remoteA.connected,
      waitForPort(MCP_HTTP_PORT),
    ]);

    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    const client = new Client({ name: 'vibe-mcp-http-e2e', version: '1.0.0' });

    await withTimeout(client.connect(transport), 'MCP client connect');
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

    const tools = await withTimeout(toolsPromise, 'initial tools/list response');
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

    const callResult = await withTimeout(callResultPromise, 'initial echo call response');
    const textContent = callResult.content.find((item) => item.type === 'text');
    if (!textContent || textContent.text !== 'hello from http') {
      throw new Error(`Unexpected tool result: ${JSON.stringify(callResult)}`);
    }

    // Update tools and verify MCP call responses do not include implicit page
    // content fallback when pageId/tabId was not explicitly provided.
    extensionWs.send(JSON.stringify({
      type: 'tools_list',
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
        {
          name: 'new_page',
          description: 'Open a new page',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string' },
            },
            required: ['url'],
          },
        },
        {
          name: 'take_md_snapshot',
          description: 'Take markdown snapshot',
          inputSchema: {
            type: 'object',
            properties: {
              pageId: { type: 'number' },
            },
          },
        },
      ],
    }));
    await delay(50);

    const openToolCallPromise = waitForWebSocketMessage(
      extensionWs,
      (message) => message.type === 'call_tool' && message.data?.name === 'new_page',
    );
    const openResultPromise = client.callTool({
      name: 'new_page',
      arguments: { url: 'https://example.com' },
    });
    const openToolCall = await openToolCallPromise;

    extensionWs.send(JSON.stringify({
      type: 'tool_result',
      requestId: openToolCall.requestId,
      data: {
        success: true,
        content: [{ type: 'text', text: JSON.stringify({ pageId: 77, url: 'https://example.com' }) }],
      },
    }));

    const openResult = await withTimeout(openResultPromise, 'new_page call response');
    const openText = openResult.content.find((item) => item.type === 'text');
    if (!openText || !openText.text.includes('"pageId":77')) {
      throw new Error(`Expected structured new_page response without fallback snapshot: ${JSON.stringify(openResult)}`);
    }
    if (openText.text.includes('# Markdown Snapshot: Example')) {
      throw new Error(`Did not expect implicit snapshot fallback in MCP response: ${JSON.stringify(openResult)}`);
    }

    const setRemoteResultPromise = client.callTool({
      name: 'set_remote',
      arguments: { url: `${RELAY_URL_B}/${REMOTE_UUID_B}` },
    });
    const [extensionWsB, setRemoteResult] = await withTimeout(Promise.all([
      remoteB.connected,
      setRemoteResultPromise,
    ]), 'set_remote response and relay B connection');

    const setRemoteText = setRemoteResult.content.find((item) => item.type === 'text');
    if (!setRemoteText) {
      throw new Error(`Expected set_remote text result: ${JSON.stringify(setRemoteResult)}`);
    }
    const setRemotePayload = JSON.parse(setRemoteText.text);
    if (setRemotePayload.ok !== true || setRemotePayload.mode !== 'remote' || setRemotePayload.target !== '[redacted]') {
      throw new Error(`Unexpected set_remote payload: ${JSON.stringify(setRemotePayload)}`);
    }
    if (setRemoteText.text.includes(REMOTE_UUID_B) || setRemoteText.text.includes(RELAY_URL_B)) {
      throw new Error(`set_remote payload leaked relay credential: ${setRemoteText.text}`);
    }

    const listToolsBPromise = waitForWebSocketMessage(
      extensionWsB,
      (message) => message.type === 'list_tools',
    );
    const toolsBPromise = client.listTools();
    const listToolsBRequest = await listToolsBPromise;

    extensionWsB.send(JSON.stringify({
      type: 'tools_list',
      requestId: listToolsBRequest.requestId,
      data: [
        {
          name: 'echo_b',
          description: 'Echo from relay B',
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

    const toolsB = await withTimeout(toolsBPromise, 'relay B tools/list response');
    if (!toolsB.tools.some((tool) => tool.name === 'set_remote')) {
      throw new Error(`Expected set_remote tool after switching remotes: ${JSON.stringify(toolsB)}`);
    }
    if (!toolsB.tools.some((tool) => tool.name === 'echo_b')) {
      throw new Error(`Expected relay B tool after set_remote: ${JSON.stringify(toolsB)}`);
    }
    if (toolsB.tools.some((tool) => tool.name === 'echo')) {
      throw new Error(`Did not expect stale relay A tools after set_remote: ${JSON.stringify(toolsB)}`);
    }

    const callToolBPromise = waitForWebSocketMessage(
      extensionWsB,
      (message) => message.type === 'call_tool' && message.data?.name === 'echo_b',
    );
    const callResultBPromise = client.callTool({
      name: 'echo_b',
      arguments: { text: 'hello from relay b' },
    });
    const callRequestB = await callToolBPromise;

    extensionWsB.send(JSON.stringify({
      type: 'tool_result',
      requestId: callRequestB.requestId,
      data: {
        success: true,
        content: [{ type: 'text', text: 'hello from relay b' }],
      },
    }));

    const callResultB = await withTimeout(callResultBPromise, 'relay B echo call response');
    const textContentB = callResultB.content.find((item) => item.type === 'text');
    if (!textContentB || textContentB.text !== 'hello from relay b') {
      throw new Error(`Unexpected relay B tool result: ${JSON.stringify(callResultB)}`);
    }

    const redactedErrorRequestPromise = waitForWebSocketMessage(
      extensionWsB,
      (message) => message.type === 'call_tool' && message.data?.name === 'echo_b',
    );
    const redactedErrorResultPromise = client.callTool({
      name: 'echo_b',
      arguments: { text: 'reject' },
    });
    const redactedErrorRequest = await redactedErrorRequestPromise;
    extensionWsB.send(JSON.stringify({
      type: 'error',
      requestId: redactedErrorRequest.requestId,
      error: `Relay rejected ${REMOTE_UUID_B.toUpperCase()}`,
    }));
    const redactedErrorResult = await withTimeout(redactedErrorResultPromise, 'redacted relay error response');
    const redactedErrorText = redactedErrorResult.content.find((item) => item.type === 'text')?.text ?? '';
    if (!redactedErrorText.includes('[redacted]') || redactedErrorText.toLowerCase().includes(REMOTE_UUID_B.toLowerCase())) {
      throw new Error(`MCP error leaked relay credential: ${JSON.stringify(redactedErrorResult)}`);
    }

    await withTimeout(client.close(), 'MCP client close');
    console.log('http e2e ok');
  } finally {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await waitForProcessExit(serverProcess);
    }
    await closeFakeRemoteRelay(remoteA);
    await closeFakeRemoteRelay(remoteB);
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function startFakeRemoteRelay(port, uuid, sessionId) {
  const server = new WebSocketServer({ host: RELAY_HOST, port });
  const connected = new Promise((resolve) => {
    server.on('connection', (ws, req) => {
      if (req.url !== `/${uuid}`) {
        ws.close();
        return;
      }
      ws.send(JSON.stringify({ type: 'extension_status', connected: true }));
      ws.send(JSON.stringify({ type: 'connected', sessionId }));
      resolve(ws);
    });
  });

  return { server, connected };
}

async function closeFakeRemoteRelay(remote) {
  if (!remote) {
    return;
  }

  for (const client of remote.server.clients) {
    client.terminate();
  }

  await new Promise((resolve, reject) => {
    remote.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function waitForProcessExit(child, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, timeoutMs);

    child.once('exit', finish);
    child.once('close', finish);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
