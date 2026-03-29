#!/usr/bin/env node
/**
 * Regression test: relay round-trip latency for list_tools and call_tool.
 *
 * Spawns the REAL relay daemon, connects a fake extension and a fake agent,
 * then verifies that:
 *   1. list_tools request → tools_list response resolves within 2 s
 *   2. call_tool  request → tool_result  response resolves within 2 s
 *   3. A second list_tools (tools refresh) also resolves within 2 s
 *
 * This catches the exact regression from issue #893 where the relay's
 * tools_list handler returned early before resolving the pending request,
 * causing every refreshTools() call to hang until the 30 s timeout.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const HOST = '127.0.0.1';
const MAX_ROUNDTRIP_MS = 2_000; // must resolve well under the old 30 s timeout
const RESERVED_PORTS = new Set();
const AGENT_PORT = await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(AGENT_PORT);
const EXTENSION_PORT = await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(EXTENSION_PORT);

// ---------------------------------------------------------------------------
// Helpers (shared with the other relay e2e scripts)
// ---------------------------------------------------------------------------

function findFreePort(exclude) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) { reject(error); return; }
        if (!port || exclude.has(port)) { findFreePort(exclude).then(resolve, reject); return; }
        resolve(port);
      });
    });
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { resolve(false); });
  });
}

async function waitForPort(port, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

function connectWebSocket(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`Timed out connecting to ${url}`)); }, timeoutMs);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function captureMessages(ws) {
  const messages = [];
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Test body
// ---------------------------------------------------------------------------

const FAKE_TOOLS = [
  { name: 'list_pages', inputSchema: { type: 'object', properties: {} } },
  { name: 'click', inputSchema: { type: 'object', properties: { ref: { type: 'string' } } } },
];

async function main() {
  let relay = null;
  let agent = null;
  let extension = null;
  const stateDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-relay-rt-'));

  try {
    // ------ Start the REAL relay daemon ------
    relay = spawn(process.execPath, ['dist/relay-daemon.js'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        VIBE_MCP_AGENT_PORT: String(AGENT_PORT),
        VIBE_MCP_EXTENSION_PORT: String(EXTENSION_PORT),
        VIBE_MCP_STATE_DIR: stateDir,
      },
    });
    relay.stdout.on('data', () => {});
    relay.stderr.on('data', () => {});

    await Promise.all([waitForPort(AGENT_PORT), waitForPort(EXTENSION_PORT)]);

    // ------ Connect fake extension ------
    extension = await connectWebSocket(`ws://${HOST}:${EXTENSION_PORT}`);
    const extMessages = captureMessages(extension);

    // Extension receives initial list_tools from relay — respond immediately.
    const initialListTools = await waitForMessage(
      extMessages,
      (msg) => msg.type === 'list_tools',
      'initial list_tools to extension',
    );
    extension.send(JSON.stringify({
      type: 'tools_list',
      requestId: initialListTools.requestId,
      data: FAKE_TOOLS,
    }));

    // ------ Connect fake agent ------
    agent = await connectWebSocket(`ws://${HOST}:${AGENT_PORT}`);
    const agentMessages = captureMessages(agent);

    // Wait for the agent to see extension_status connected.
    await waitForMessage(
      agentMessages,
      (msg) => msg.type === 'extension_status' && msg.connected === true,
      'agent sees extension connected',
    );

    // Drain any initial tools_list broadcast the relay sends to the agent.
    await waitForMessage(
      agentMessages,
      (msg) => msg.type === 'tools_list',
      'initial tools_list broadcast to agent',
    );

    // ------ Hook: extension auto-responds to relay messages ------
    // This simulates the extension responding to list_tools and call_tool
    // messages exactly as the real extension would.
    extension.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'list_tools' && msg.requestId) {
        extension.send(JSON.stringify({
          type: 'tools_list',
          requestId: msg.requestId,
          data: FAKE_TOOLS,
        }));
      }

      if (msg.type === 'call_tool' && msg.requestId) {
        extension.send(JSON.stringify({
          type: 'tool_result',
          requestId: msg.requestId,
          data: {
            content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: msg.data?.name }) }],
          },
        }));
      }
    });

    // ===================================================================
    // TEST 1: list_tools round-trip must resolve within MAX_ROUNDTRIP_MS
    // ===================================================================
    {
      const requestId = 'rt_list_tools_1';
      const t0 = Date.now();
      agent.send(JSON.stringify({ type: 'list_tools', requestId }));

      const response = await waitForMessage(
        agentMessages,
        (msg) => msg.type === 'tools_list' && (msg.requestId === requestId || Array.isArray(msg.data)),
        'list_tools round-trip response',
        MAX_ROUNDTRIP_MS,
      );
      const elapsed = Date.now() - t0;

      assert(Array.isArray(response.data), `list_tools response missing data array: ${JSON.stringify(response)}`);
      assert(response.data.length === FAKE_TOOLS.length, `list_tools returned wrong tool count: ${response.data.length}`);
      assert(elapsed < MAX_ROUNDTRIP_MS, `list_tools took ${elapsed}ms — exceeds ${MAX_ROUNDTRIP_MS}ms budget`);
      console.log(`  list_tools round-trip: ${elapsed}ms (budget: ${MAX_ROUNDTRIP_MS}ms) ✓`);
    }

    // ===================================================================
    // TEST 2: call_tool round-trip must resolve within MAX_ROUNDTRIP_MS
    // ===================================================================
    {
      const requestId = 'rt_call_tool_1';
      const t0 = Date.now();
      agent.send(JSON.stringify({
        type: 'call_tool',
        requestId,
        data: { name: 'click', arguments: { ref: '42' } },
      }));

      const response = await waitForMessage(
        agentMessages,
        (msg) => msg.type === 'tool_result' && msg.requestId === requestId,
        'call_tool round-trip response',
        MAX_ROUNDTRIP_MS,
      );
      const elapsed = Date.now() - t0;

      assert(response.data != null, `call_tool response missing data: ${JSON.stringify(response)}`);
      assert(elapsed < MAX_ROUNDTRIP_MS, `call_tool took ${elapsed}ms — exceeds ${MAX_ROUNDTRIP_MS}ms budget`);
      console.log(`  call_tool  round-trip: ${elapsed}ms (budget: ${MAX_ROUNDTRIP_MS}ms) ✓`);
    }

    // ===================================================================
    // TEST 3: second list_tools (refresh) must also resolve quickly
    // This specifically guards against the old bug where the first
    // list_tools might work (via broadcast) but subsequent ones hang.
    // ===================================================================
    {
      const requestId = 'rt_list_tools_2';
      const t0 = Date.now();
      agent.send(JSON.stringify({ type: 'list_tools', requestId }));

      const response = await waitForMessage(
        agentMessages,
        (msg) => msg.type === 'tools_list' && (msg.requestId === requestId || Array.isArray(msg.data)),
        'second list_tools round-trip response',
        MAX_ROUNDTRIP_MS,
      );
      const elapsed = Date.now() - t0;

      assert(Array.isArray(response.data), `second list_tools response missing data: ${JSON.stringify(response)}`);
      assert(elapsed < MAX_ROUNDTRIP_MS, `second list_tools took ${elapsed}ms — exceeds ${MAX_ROUNDTRIP_MS}ms budget`);
      console.log(`  list_tools refresh:    ${elapsed}ms (budget: ${MAX_ROUNDTRIP_MS}ms) ✓`);
    }

    console.log('relay roundtrip e2e ok');
  } finally {
    if (agent && agent.readyState === WebSocket.OPEN) agent.close();
    if (extension && extension.readyState === WebSocket.OPEN) extension.close();
    if (relay) relay.kill('SIGTERM');
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
