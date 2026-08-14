#!/usr/bin/env node
/**
 * Regression test: the local relay daemon MUST answer the extension heartbeat.
 *
 * The Vibe extension (vibe `lib/mcp/external-client.ts`) sends
 * `{ type: 'connected' }` every CLIENT_HEARTBEAT_INTERVAL_MS (15 s) and treats
 * ANY inbound frame as the pong. After MAX_MISSED_PONGS (2) unanswered
 * heartbeats it declares the socket dead and force-reconnects.
 *
 * The daemon used to `return` on `connected` without replying, so a perfectly
 * healthy extension socket was torn down and rebuilt every ~30 s forever.
 * Measured on a real machine: the extension's socket to 127.0.0.1:19889 lived
 * 17-27 s, vanished for ~2 s, and came back on a new ephemeral port, in a loop.
 * Any tool call that spanned a swap failed ("Extension reconnecting" on the
 * hosted relay, dropped in-flight request locally).
 *
 * The hosted relay (platform/subscriptions/relay-service/server.js) already
 * replies `{ type: 'pong' }`; this test pins the same behaviour for the daemon.
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
// The extension gives the relay PONG_TIMEOUT_MS (10 s) to answer; anything
// slower than a second here already means the watchdog is at risk.
const MAX_PONG_LATENCY_MS = 2_000;
const HEARTBEATS = 3;
const SESSION_ID = 'heartbeat-pong-session';
const FAKE_TOOLS = [
  { name: 'list_pages', inputSchema: { type: 'object', properties: {} } },
];

const RESERVED_PORTS = new Set();
const AGENT_PORT = await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(AGENT_PORT);
const EXTENSION_PORT = await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(EXTENSION_PORT);

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  let relay = null;
  let extension = null;
  const stateDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-relay-hb-'));

  try {
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

    extension = await connectWebSocket(`ws://${HOST}:${EXTENSION_PORT}`);

    // Every inbound frame counts as the pong for the extension's watchdog, so
    // the test asserts on "any frame arrived", exactly like the real client.
    let inbound = [];
    extension.on('message', (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw.toString()); } catch { msg = { type: 'unparsed' }; }
      inbound.push({ at: Date.now(), msg });

      // Behave like the real extension: answer the relay's tools probe. Without
      // this the relay keeps re-probing and its own retries would masquerade as
      // heartbeat replies, hiding the regression this test exists to catch.
      if (msg && msg.type === 'list_tools' && msg.requestId) {
        extension.send(JSON.stringify({
          type: 'tools_list',
          requestId: msg.requestId,
          sessionId: SESSION_ID,
          data: FAKE_TOOLS,
        }));
      }
    });

    // Handshake: the extension announces itself with `connected`.
    extension.send(JSON.stringify({ type: 'connected', sessionId: SESSION_ID }));

    // Let the relay finish its startup chatter (tools probe + broadcasts) and go
    // quiet, so the only thing that can answer a heartbeat is the heartbeat
    // handler itself.
    await waitForQuiet(() => inbound, 'relay startup chatter');

    // Now simulate the steady-state heartbeats and require a reply to each one.
    for (let i = 1; i <= HEARTBEATS; i++) {
      inbound.length = 0;

      const sentAt = Date.now();
      extension.send(JSON.stringify({ type: 'connected', sessionId: SESSION_ID }));
      const reply = await waitForInbound(inbound, `heartbeat #${i}`);
      const latency = reply.at - sentAt;
      assert(
        latency <= MAX_PONG_LATENCY_MS,
        `Heartbeat #${i} answered after ${latency}ms (limit ${MAX_PONG_LATENCY_MS}ms)`,
      );
      console.log(`  heartbeat #${i}: answered with "${reply.msg.type}" in ${latency}ms`);
      await delay(250);
    }

    console.log('PASS: local relay daemon answers extension heartbeats (no 30s reconnect churn)');
  } finally {
    if (extension) { try { extension.terminate(); } catch { /* ignore */ } }
    if (relay) { try { relay.kill('SIGKILL'); } catch { /* ignore */ } }
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Wait until the relay stops sending unsolicited frames for `quietMs`, so a
 * later assertion cannot be satisfied by leftover startup traffic.
 */
async function waitForQuiet(getQueue, label, quietMs = 1_500, timeoutMs = 15_000) {
  const start = Date.now();
  let lastLen = getQueue().length;
  let lastChange = Date.now();
  while (Date.now() - start < timeoutMs) {
    await delay(50);
    const len = getQueue().length;
    if (len !== lastLen) { lastLen = len; lastChange = Date.now(); continue; }
    if (Date.now() - lastChange >= quietMs) return;
  }
  throw new Error(`Relay never went quiet while waiting out ${label}`);
}

async function waitForInbound(queue, label, timeoutMs = MAX_PONG_LATENCY_MS + 3_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (queue.length > 0) return queue[0];
    await delay(10);
  }
  throw new Error(
    `Relay never answered the extension ${label} — the extension's pong watchdog ` +
    `would force-reconnect after 2 missed heartbeats (~30s churn loop).`,
  );
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
