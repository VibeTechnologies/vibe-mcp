#!/usr/bin/env node
/**
 * Regression test: the local relay daemon MUST report its package version on
 * the extension handshake (AGE-91).
 *
 * WHY
 * ---
 * A published relay fix does not reach a user whose `@vibebrowser/mcp` install
 * is stale, and nothing used to say so. Measured on a real machine on
 * 2026-08-14: npm served 0.3.3, but the daemon actually bound to
 * 127.0.0.1:19889 came from a *global* install pinned at 0.2.12
 * (`grep -c pong dist/relay.js` -> 0), so the merged heartbeat fix was live on
 * the registry while the ~30 s reconnect churn still reproduced locally. The
 * only way to find that out was process/socket forensics.
 *
 * The extension (vibe `lib/mcp/external-client.ts`) sends `{type:'connected'}`
 * on open and every 15 s after; the daemon answers `{type:'pong'}`. This test
 * pins that the pong carries `version` and that it equals the daemon's own
 * package.json version, which is what Settings renders as
 * "Local relay <v> - outdated (expected <min>+)".
 *
 * A relay that answers WITHOUT a version field is, by construction, older than
 * the build that added it — the extension treats that as outdated too, so this
 * test is the whole contract on the daemon side.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HOST = '127.0.0.1';
const SESSION_ID = 'version-handshake-session';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')).version;
// The extension's pong watchdog gives the relay 10 s; the version rides the
// same frame, so anything slower than this is already a bug.
const HANDSHAKE_TIMEOUT_MS = 5_000;

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
  const stateDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-relay-ver-'));

  try {
    relay = spawn(process.execPath, ['dist/relay-daemon.js'], {
      cwd: REPO_ROOT,
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

    const pongs = [];
    extension.on('message', (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg && msg.type === 'pong') pongs.push(msg);
    });

    // Exactly what the extension does on open.
    extension.send(JSON.stringify({ type: 'connected', sessionId: SESSION_ID }));

    const pong = await waitFor(pongs, 'handshake pong');

    assert(
      typeof pong.version === 'string' && pong.version.length > 0,
      'Relay pong carried no `version` field — Settings cannot tell the user their daemon is stale ' +
      `(got ${JSON.stringify(pong)}).`,
    );
    assert(
      pong.version === EXPECTED_VERSION,
      `Relay reported version "${pong.version}" but package.json says "${EXPECTED_VERSION}" — ` +
      'the reported version must be the running package version or the outdated warning lies.',
    );
    assert(
      /^\d+\.\d+\.\d+/.test(pong.version),
      `Relay reported a non-semver version "${pong.version}"; the extension compares it numerically.`,
    );

    // Steady-state heartbeats must keep carrying it, so a service worker that
    // restarts mid-session re-learns the version without a reconnect.
    pongs.length = 0;
    extension.send(JSON.stringify({ type: 'connected', sessionId: SESSION_ID }));
    const heartbeatPong = await waitFor(pongs, 'steady-state heartbeat pong');
    assert(
      heartbeatPong.version === EXPECTED_VERSION,
      `Heartbeat pong lost the version field (got ${JSON.stringify(heartbeatPong)}).`,
    );

    console.log(`PASS: local relay daemon reports version ${EXPECTED_VERSION} on the extension handshake`);
  } finally {
    if (extension) { try { extension.terminate(); } catch { /* ignore */ } }
    if (relay) { try { relay.kill('SIGKILL'); } catch { /* ignore */ } }
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function waitFor(queue, label, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (queue.length > 0) return queue[0];
    await delay(10);
  }
  throw new Error(`Relay never sent a ${label} within ${timeoutMs}ms`);
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
