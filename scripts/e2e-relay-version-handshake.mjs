#!/usr/bin/env node
/**
 * Regression test: the local relay daemon MUST report its package version on
 * the extension handshake (AGE-91).
 *
 * WHY
 * ---
 * A published relay fix does not reach a user whose `@vibebrowser/mcp` install
 * is stale, and nothing used to say so. Measured on a real machine on
 * 2026-08-14: npm's latest was 0.3.3 (0.3.4 by the time this landed), but the
 * daemon actually bound to 127.0.0.1:19889 came from a *global* install
 * pinned at 0.2.12
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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const CLI_PACKAGE_ROOT = join(REPO_ROOT, 'packages', 'cli');
// The extension's pong watchdog gives the relay 10 s; the version rides the
// same frame, so anything slower than this is already a bug.
const HANDSHAKE_TIMEOUT_MS = 5_000;

function packageVersion(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')).version;
}

// Both published packages ship and execute this relay: `@vibebrowser/mcp`
// runs `dist/relay-daemon.js`, and `@vibebrowser/cli` gets a full copy of the
// same `dist/` (scripts/prepare-cli-package.mjs) which `src/connection.ts`
// autospawns from its own directory. They are versioned independently, so each
// one must report *its own* version — a root-only constant would make the
// standalone CLI claim a version it was never published under.
const DAEMONS = [
  { label: '@vibebrowser/mcp', cwd: REPO_ROOT, expected: packageVersion(REPO_ROOT) },
  { label: '@vibebrowser/cli', cwd: CLI_PACKAGE_ROOT, expected: packageVersion(CLI_PACKAGE_ROOT) },
];

const RESERVED_PORTS = new Set();

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

async function checkDaemon({ label, cwd, expected }) {
  let relay = null;
  let extension = null;
  const stateDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-relay-ver-'));
  const AGENT_PORT = await findFreePort(RESERVED_PORTS);
  RESERVED_PORTS.add(AGENT_PORT);
  const EXTENSION_PORT = await findFreePort(RESERVED_PORTS);
  RESERVED_PORTS.add(EXTENSION_PORT);

  try {
    relay = spawn(process.execPath, ['dist/relay-daemon.js'], {
      cwd,
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
      `${label} relay pong carried no \`version\` field — Settings cannot tell the user their daemon is stale ` +
      `(got ${JSON.stringify(pong)}).`,
    );
    assert(
      pong.version === expected,
      `${label} relay reported version "${pong.version}" but its package.json says "${expected}" — ` +
      'the reported version must come from the package actually executing the relay, ' +
      'or the outdated warning lies.',
    );
    assert(
      /^\d+\.\d+\.\d+/.test(pong.version),
      `${label} relay reported a non-semver version "${pong.version}"; the extension compares it numerically.`,
    );

    // Steady-state heartbeats must keep carrying it, so a service worker that
    // restarts mid-session re-learns the version without a reconnect.
    pongs.length = 0;
    extension.send(JSON.stringify({ type: 'connected', sessionId: SESSION_ID }));
    const heartbeatPong = await waitFor(pongs, 'steady-state heartbeat pong');
    assert(
      heartbeatPong.version === expected,
      `Heartbeat pong lost the version field (got ${JSON.stringify(heartbeatPong)}).`,
    );

    console.log(`PASS: ${label} relay daemon reports version ${expected} on the extension handshake`);
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

/**
 * Stage a third, synthetic package around the *same* build output and give it a
 * version that appears nowhere in the repo. If the relay still reports it, the
 * lookup is genuinely relative to the executing package; if it reports the root
 * version instead, someone replaced it with a root-only constant. This keeps
 * the guarantee provable even if the real packages ever share a version number.
 *
 * Staged under the repo so `import 'ws'` still resolves via node_modules.
 */
function stageSyntheticPackage() {
  const root = join(REPO_ROOT, '.artifacts', 'relay-version-handshake', 'synthetic-pkg');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(REPO_ROOT, 'dist'), join(root, 'dist'), { recursive: true });
  const version = '99.98.97-e2e';
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: '@vibebrowser/relay-version-probe', version, type: 'module', private: true }, null, 2)}\n`,
  );
  return { label: 'synthetic package (per-package lookup probe)', cwd: root, expected: version, root };
}

async function main() {
  for (const daemon of DAEMONS) {
    await checkDaemon(daemon);
  }

  const synthetic = stageSyntheticPackage();
  try {
    await checkDaemon(synthetic);
  } finally {
    rmSync(synthetic.root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
