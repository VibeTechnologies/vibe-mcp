#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const HOST = '127.0.0.1';
const AGENT_PORT = 19888;
const EXTENSION_PORT = 19889;

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

function captureMessages(ws) {
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

async function main() {
  let relay = null;
  let agent = null;
  let extension1 = null;
  let extension2 = null;

  try {
    await assertPortsFree();

    relay = spawn(process.execPath, ['dist/relay-daemon.js'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    relay.stdout.on('data', (chunk) => process.stdout.write(chunk.toString()));
    relay.stderr.on('data', (chunk) => process.stderr.write(chunk.toString()));

    await Promise.all([waitForPort(AGENT_PORT), waitForPort(EXTENSION_PORT)]);

    extension1 = await connectWebSocket(`ws://${HOST}:${EXTENSION_PORT}`);
    const extension1Messages = captureMessages(extension1);

    agent = await connectWebSocket(`ws://${HOST}:${AGENT_PORT}`);
    const agentMessages = captureMessages(agent);

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

    extension2 = await connectWebSocket(`ws://${HOST}:${EXTENSION_PORT}`);
    const extension2Messages = captureMessages(extension2);

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

    // Trigger replay of in-flight requests after extension reconnect.
    extension2.send(JSON.stringify({ type: 'connected' }));

    const replayedToExtension2 = await waitForMessage(
      extension2Messages,
      (msg) => msg.type === 'call_tool' && msg.requestId === forwardedToExtension1.requestId,
      'replayed call_tool on extension #2'
    );

    extension2.send(JSON.stringify({
      type: 'tool_result',
      requestId: replayedToExtension2.requestId,
      data: { value: 'replayed-ok' },
    }));

    const firstResult = await waitForMessage(
      agentMessages,
      (msg) => msg.type === 'tool_result' && msg.requestId === 'agent_req_1',
      'first tool_result back to agent'
    );
    if (firstResult?.data?.value !== 'replayed-ok') {
      throw new Error(`Unexpected first tool result payload: ${JSON.stringify(firstResult)}`);
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
      (msg) => msg.type === 'call_tool' && msg.requestId !== replayedToExtension2.requestId,
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
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
