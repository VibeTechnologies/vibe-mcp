#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const HOST = '127.0.0.1';
const configuredAgentPort = getConfiguredPort('VIBE_MCP_TEST_AGENT_PORT', 'E2E_AGENT_PORT');
const configuredExtensionPort = getConfiguredPort('VIBE_MCP_TEST_EXTENSION_PORT', 'E2E_EXTENSION_PORT');
const RESERVED_PORTS = new Set();
const AGENT_PORT = configuredAgentPort ?? await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(AGENT_PORT);
const EXTENSION_PORT = configuredExtensionPort ?? await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(EXTENSION_PORT);
const SESSION_ID = 'race-session';

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
    socket.on('error', () => {
      resolve(false);
    });
  });
}

async function assertPortsFree() {
  const [agentBusy, extensionBusy] = await Promise.all([
    probePort(AGENT_PORT),
    probePort(EXTENSION_PORT),
  ]);
  if (agentBusy || extensionBusy) {
    throw new Error(
      `Relay ports are already in use (${AGENT_PORT}/${EXTENSION_PORT}). Stop existing relay daemon and retry.`
    );
  }
}

async function waitForPort(port, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

function attachMessageCapture(ws) {
  const messages = [];
  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()));
    } catch {
      // Ignore malformed messages in test harness.
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
    const messages = attachMessageCapture(ws);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out connecting to ${url}`));
    }, timeoutMs);

    ws.once('open', () => {
      clearTimeout(timer);
      resolve({ ws, messages });
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  let relay = null;
  let agent = null;
  let extension1 = null;
  let extension2 = null;
  let agentMessages = null;
  let extension1Messages = null;
  let extension2Messages = null;
  const stateDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-relay-race-'));

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

    ({ ws: extension1, messages: extension1Messages } = await connectWebSocket(`ws://${HOST}:${EXTENSION_PORT}`));
    extension1.send(JSON.stringify({ type: 'connected', sessionId: SESSION_ID }));

    ({ ws: agent, messages: agentMessages } = await connectWebSocket(`ws://${HOST}:${AGENT_PORT}`));

    const extensionStatus = await waitForMessage(
      agentMessages,
      (msg) => msg.type === 'extension_status',
      'agent extension_status'
    );
    if (extensionStatus.connected !== true) {
      throw new Error('Agent did not see extension connected=true after extension #1 joined');
    }

    await waitForMessage(
      extension1Messages,
      (msg) => msg.type === 'list_tools',
      'list_tools to extension #1'
    );
    extension1.send(JSON.stringify({
      type: 'tools_list',
      data: [
        {
          name: 'wait',
          inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        },
      ],
    }));

    await waitForMessage(
      agentMessages,
      (msg) => msg.type === 'tools_list' && Array.isArray(msg.data) && msg.data.length > 0,
      'tools_list broadcast to agent'
    );

    agent.send(JSON.stringify({
      type: 'call_tool',
      requestId: 'agent_req_1',
      data: {
        name: 'wait',
        arguments: { seconds: 0.1 },
      },
    }));

    const forwardedToExtension1 = await waitForMessage(
      extension1Messages,
      (msg) => msg.type === 'call_tool' && typeof msg.requestId === 'string',
      'initial call_tool forwarded to extension #1'
    );

    ({ ws: extension2, messages: extension2Messages } = await connectWebSocket(`ws://${HOST}:${EXTENSION_PORT}`));
    extension2.send(JSON.stringify({ type: 'connected', sessionId: SESSION_ID }));

    await waitForMessage(
      extension2Messages,
      (msg) => msg.type === 'list_tools',
      'list_tools to extension #2'
    );
    extension2.send(JSON.stringify({
      type: 'tools_list',
      data: [
        {
          name: 'wait',
          inputSchema: { type: 'object', properties: {}, additionalProperties: true },
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
      data: { value: 'replayed-ok' },
    }));

    const firstResult = await waitForMessage(
      agentMessages,
      (msg) => msg.type === 'tool_result' && msg.requestId === 'agent_req_1',
      'tool_result back to agent for replayed in-flight request'
    );
    if (firstResult?.data?.value !== 'replayed-ok') {
      throw new Error(`Unexpected replayed tool result payload: ${JSON.stringify(firstResult)}`);
    }

    // Ensure stale close from extension #1 does not invalidate live extension #2.
    await delay(200);
    const staleCloseDisconnected = agentMessages.some((msg) => msg.type === 'extension_disconnected');
    if (staleCloseDisconnected) {
      throw new Error('Agent observed extension_disconnected from stale extension close event');
    }

    agent.send(JSON.stringify({
      type: 'call_tool',
      requestId: 'agent_req_2',
      data: {
        name: 'wait',
        arguments: { seconds: 0.1 },
      },
    }));

    const secondForwarded = await waitForMessage(
      extension2Messages,
      (msg) => msg.type === 'call_tool',
      'second call_tool routed to extension #2'
    );
    extension2.send(JSON.stringify({
      type: 'tool_result',
      requestId: secondForwarded.requestId,
      data: { value: 'fresh-ok' },
    }));

    const secondResult = await waitForMessage(
      agentMessages,
      (msg) => msg.type === 'tool_result' && msg.requestId === 'agent_req_2',
      'second tool_result back to agent'
    );
    if (secondResult?.data?.value !== 'fresh-ok') {
      throw new Error(`Unexpected second tool result payload: ${JSON.stringify(secondResult)}`);
    }

    const reconnectError = agentMessages.find(
      (msg) => msg.type === 'error' && /Extension reconnected/i.test(String(msg.error || ''))
    );
    if (reconnectError) {
      throw new Error(`Observed unexpected reconnect error: ${JSON.stringify(reconnectError)}`);
    }

    const noConnectionError = agentMessages.find(
      (msg) => msg.type === 'error' && /No extension connected/i.test(String(msg.error || ''))
    );
    if (noConnectionError) {
      throw new Error(`Observed unexpected relay error: ${JSON.stringify(noConnectionError)}`);
    }

    console.log('e2e ok');
  } finally {
    if (agent && agent.readyState === WebSocket.OPEN) {
      agent.close();
    }
    if (extension1 && extension1.readyState === WebSocket.OPEN) {
      extension1.close();
    }
    if (extension2 && extension2.readyState === WebSocket.OPEN) {
      extension2.close();
    }
    if (relay) {
      relay.kill('SIGTERM');
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
