#!/usr/bin/env node
/**
 * E2E: zero-config localhost auto-spawn + pidfile protection.
 *
 * Proves the four behaviours of the "vibebrowser-cli works zero-config on
 * localhost" feature, exercising the REAL spawn/connect path (no mocks of the
 * relay lifecycle — a real detached relay-daemon.js is spawned by the CLI):
 *
 *   (A) No `--remote`  → the CLI auto-spawns a LOCAL relay, the pidfile is
 *       created at <state>/vibebrowser-relay.pid, a fake browser (extension)
 *       connects, and a basic command (`status`) succeeds — with NO auth.
 *   (B) A second `vibebrowser-cli` invocation REUSES the running relay via the
 *       pidfile (pid is unchanged — no duplicate daemon).
 *   (C) A STALE pidfile (owner process dead) is recovered: the CLI spawns a
 *       fresh relay and the command still works.
 *   (D) `--remote <url>` BYPASSES local spawn entirely: no local relay is
 *       started and no local pidfile is written; the CLI talks to the remote.
 *
 * Layout:
 *   CLI (child) ──ws(agent)──▶ REAL relay daemon ◀──ws(ext)── fake extension
 *   CLI (child, --remote) ──ws──▶ fake remote relay (agent protocol)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const HOST = '127.0.0.1';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const LOCAL_BROWSER_CLI = resolve(PACKAGE_ROOT, 'dist', 'browser-main.js');
const PID_FILE_NAME = 'vibebrowser-relay.pid';
const MAX_CLI_MS = 12_000;

// Strip any ambient remote config so "no --remote" truly means local mode.
const BASE_ENV = { ...process.env };
delete BASE_ENV.VIBE_REMOTE_URL;
delete BASE_ENV.VIBE_EXTENSION_UUID;
delete BASE_ENV.VIBE_RELAY_UUID;
delete BASE_ENV.VIBE_REMOTE_SECRET;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findFreePort(exclude = new Set()) {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) { reject(error); return; }
        if (!port || exclude.has(port)) { findFreePort(exclude).then(resolvePort, reject); return; }
        resolvePort(port);
      });
    });
  });
}

function probePort(port) {
  return new Promise((resolvePort) => {
    const socket = net.connect({ host: HOST, port });
    socket.on('connect', () => { socket.destroy(); resolvePort(true); });
    socket.on('error', () => { resolvePort(false); });
  });
}

async function waitForPort(port, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPidFile(pidFile) {
  if (!existsSync(pidFile)) return null;
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}

/**
 * Run the CLI against a local auto-spawned relay. Passes --port (so the test is
 * hermetic on custom ports) but NEVER --remote — this is the auto-spawn path.
 */
function runLocalCli(args, env, agentPort, timeoutMs = MAX_CLI_MS) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [LOCAL_BROWSER_CLI, '--port', String(agentPort), '--json', ...args],
      { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out (${timeoutMs}ms): ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      try {
        resolvePromise({ code, data: JSON.parse(stdout), stderr });
      } catch (e) {
        reject(new Error(`CLI did not emit JSON for ${args.join(' ')} (exit ${code}): ${stdout}\nstderr=${stderr}\n${e}`));
      }
    });
  });
}

/**
 * Run the CLI in remote mode (--remote). Used to prove bypass of local spawn.
 */
function runRemoteCli(args, env, remoteUrl, timeoutMs = MAX_CLI_MS) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [LOCAL_BROWSER_CLI, '--remote', remoteUrl, '--browser-profile', 'user', '--json', ...args],
      { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`remote CLI timed out (${timeoutMs}ms): ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      try {
        resolvePromise({ code, data: JSON.parse(stdout), stderr });
      } catch (e) {
        reject(new Error(`remote CLI did not emit JSON for ${args.join(' ')} (exit ${code}): ${stdout}\nstderr=${stderr}\n${e}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Fake browser extension (connects to the real relay's extension port)
// ---------------------------------------------------------------------------

const FAKE_TOOLS = [
  { name: 'list_pages', description: 'Fake list_pages', inputSchema: { type: 'object', properties: {} } },
  { name: 'new_page', description: 'Fake new_page', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
];

function attachFakeExtension(extensionPort, sessionId) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${extensionPort}`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('extension connect timeout')); }, 8_000);
    // Register handlers BEFORE open (harness rule).
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'list_tools' && msg.requestId) {
        ws.send(JSON.stringify({ type: 'tools_list', requestId: msg.requestId, sessionId, data: FAKE_TOOLS }));
      }
      if (msg.type === 'call_tool' && msg.requestId) {
        ws.send(JSON.stringify({
          type: 'tool_result',
          requestId: msg.requestId,
          sessionId,
          data: { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: msg.data?.name }) }] },
        }));
      }
    });
    ws.on('open', () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ type: 'connected', sessionId }));
      ws.send(JSON.stringify({
        type: 'sessions_list',
        connected: true,
        sessionId,
        sessions: [{ sessionId, connected: true, connectedAt: Date.now(), toolCount: FAKE_TOOLS.length }],
      }));
      resolvePromise(ws);
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// ---------------------------------------------------------------------------
// Fake remote relay (agent-facing protocol) for the --remote bypass test
// ---------------------------------------------------------------------------

const REMOTE_UUID = '55555555-5555-4555-8555-555555555555';

function startFakeRemoteRelay(port) {
  const wss = new WebSocketServer({ host: HOST, port });
  wss.on('connection', (ws, req) => {
    if (req.url !== `/${REMOTE_UUID}`) { ws.close(); return; }
    ws.send(JSON.stringify({ type: 'extension_status', connected: true }));
    ws.send(JSON.stringify({
      type: 'sessions_list',
      connected: true,
      sessionId: REMOTE_UUID,
      sessions: [{ sessionId: REMOTE_UUID, connected: true, connectedAt: Date.now(), toolCount: FAKE_TOOLS.length }],
    }));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'list_tools') {
        ws.send(JSON.stringify({ type: 'tools_list', requestId: msg.requestId, data: FAKE_TOOLS }));
      } else if (msg.type === 'list_sessions') {
        ws.send(JSON.stringify({
          type: 'sessions_list',
          requestId: msg.requestId,
          connected: true,
          sessionId: REMOTE_UUID,
          sessions: [{ sessionId: REMOTE_UUID, connected: true, connectedAt: Date.now(), toolCount: FAKE_TOOLS.length }],
        }));
      } else if (msg.type === 'call_tool') {
        ws.send(JSON.stringify({
          type: 'tool_result',
          requestId: msg.requestId,
          data: { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: msg.data?.name }) }] },
        }));
      }
    });
  });
  return wss;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const reserved = new Set();
  const agentPort = await findFreePort(reserved); reserved.add(agentPort);
  const extensionPort = await findFreePort(reserved); reserved.add(extensionPort);
  const remotePort = await findFreePort(reserved); reserved.add(remotePort);

  const stateDir = mkdtempSync(join(tmpdir(), 'vibe-autospawn-'));
  const pidFile = join(stateDir, PID_FILE_NAME);
  const localEnv = {
    ...BASE_ENV,
    VIBE_MCP_AGENT_PORT: String(agentPort),
    VIBE_MCP_EXTENSION_PORT: String(extensionPort),
    VIBE_MCP_STATE_DIR: stateDir,
  };

  let extA = null;
  let extC = null;
  let fakeRemote = null;
  const daemonPids = new Set();

  try {
    // =====================================================================
    // TEST A: no --remote → auto-spawn local relay + browser connects + cmd
    // =====================================================================
    {
      const cliPromise = runLocalCli(
        ['status', '--wait-for-extension', '--wait-timeout', '6000', '--poll-interval', '150'],
        localEnv, agentPort,
      );
      // The CLI auto-spawns the relay; attach the fake browser once its
      // extension port is up.
      await waitForPort(extensionPort, 9_000);
      extA = await attachFakeExtension(extensionPort, 'browser-A');

      const { code, data } = await cliPromise;
      assert(code === 0, `A: CLI exit ${code}: ${JSON.stringify(data)}`);
      assert(data.ok === true, `A: status not ok: ${JSON.stringify(data)}`);
      assert(data.mode === 'local', `A: expected local mode (no auth path): ${JSON.stringify(data)}`);
      assert(data.extensionConnected === true, `A: browser did not connect through auto-spawned relay: ${JSON.stringify(data)}`);
      assert(Number(data.toolCount) === FAKE_TOOLS.length, `A: toolCount mismatch: ${JSON.stringify(data)}`);

      const pidA = readPidFile(pidFile);
      assert(pidA !== null, `A: pidfile not created at ${pidFile}`);
      assert(pidAlive(pidA), `A: pidfile owner ${pidA} is not alive`);
      daemonPids.add(pidA);
      console.log(`  A auto-spawn: relay pid ${pidA}, extensionConnected, ${data.toolCount} tools, mode=local (no auth) ✓`);

      // =====================================================================
      // TEST B: second invocation REUSES the relay via pidfile (same pid)
      // =====================================================================
      const { code: codeB, data: dataB } = await runLocalCli(['status'], localEnv, agentPort);
      assert(codeB === 0, `B: CLI exit ${codeB}: ${JSON.stringify(dataB)}`);
      assert(dataB.ok === true, `B: status not ok: ${JSON.stringify(dataB)}`);
      assert(dataB.extensionConnected === true, `B: extension should still be connected: ${JSON.stringify(dataB)}`);
      const pidB = readPidFile(pidFile);
      assert(pidB === pidA, `B: relay was NOT reused — pid changed ${pidA} -> ${pidB} (duplicate daemon)`);
      console.log(`  B reuse: second invocation reused relay pid ${pidB} (no duplicate) ✓`);

      // =====================================================================
      // TEST C: stale pidfile is recovered (owner dead → fresh relay spawns)
      // =====================================================================
      // Kill the daemon with SIGKILL so it CANNOT clean its own pidfile,
      // leaving a stale pidfile pointing at a dead pid.
      process.kill(pidA, 'SIGKILL');
      if (extA && extA.readyState === WebSocket.OPEN) extA.close();
      extA = null;
      // Wait until the ports are released and the owner is confirmed dead.
      const deadlineC = Date.now() + 8_000;
      while (Date.now() < deadlineC && (pidAlive(pidA) || (await probePort(agentPort)) || (await probePort(extensionPort)))) {
        await delay(100);
      }
      const staleBefore = readPidFile(pidFile);
      assert(staleBefore === pidA, `C: expected stale pidfile still pointing at dead ${pidA}, got ${staleBefore}`);
      assert(!pidAlive(pidA), `C: previous daemon ${pidA} should be dead`);

      const cliPromiseC = runLocalCli(
        ['status', '--wait-for-extension', '--wait-timeout', '6000', '--poll-interval', '150'],
        localEnv, agentPort,
      );
      await waitForPort(extensionPort, 9_000);
      extC = await attachFakeExtension(extensionPort, 'browser-C');
      const { code: codeC, data: dataC } = await cliPromiseC;
      assert(codeC === 0, `C: CLI exit ${codeC}: ${JSON.stringify(dataC)}`);
      assert(dataC.ok === true, `C: status not ok after stale recovery: ${JSON.stringify(dataC)}`);
      assert(dataC.extensionConnected === true, `C: extension did not reconnect after recovery: ${JSON.stringify(dataC)}`);
      const pidC = readPidFile(pidFile);
      assert(pidC !== null && pidC !== pidA, `C: stale pidfile not recovered — pid still ${pidC}`);
      assert(pidAlive(pidC), `C: recovered relay ${pidC} is not alive`);
      daemonPids.add(pidC);
      console.log(`  C stale recovery: dead pid ${pidA} cleaned, fresh relay pid ${pidC} serving ✓`);
    }

    // =====================================================================
    // TEST D: --remote bypasses local spawn (no local relay / no pidfile)
    // =====================================================================
    {
      const stateDirD = mkdtempSync(join(tmpdir(), 'vibe-autospawn-remote-'));
      const pidFileD = join(stateDirD, PID_FILE_NAME);
      const remoteAgentPort = await findFreePort(reserved); reserved.add(remoteAgentPort);
      const remoteEnv = {
        ...BASE_ENV,
        // Point local relay config at fresh ports/dir so we can prove nothing
        // local was ever started.
        VIBE_MCP_AGENT_PORT: String(remoteAgentPort),
        VIBE_MCP_EXTENSION_PORT: String(await findFreePort(reserved)),
        VIBE_MCP_STATE_DIR: stateDirD,
      };
      fakeRemote = startFakeRemoteRelay(remotePort);
      await waitForPort(remotePort, 5_000);

      const remoteUrl = `ws://${HOST}:${remotePort}/${REMOTE_UUID}`;
      const { code, data } = await runRemoteCli(['status'], remoteEnv, remoteUrl);
      assert(code === 0, `D: remote CLI exit ${code}: ${JSON.stringify(data)}`);
      assert(data.ok === true, `D: remote status not ok: ${JSON.stringify(data)}`);
      assert(data.mode === 'remote', `D: expected remote mode: ${JSON.stringify(data)}`);
      assert(data.extensionConnected === true, `D: remote extension should be connected: ${JSON.stringify(data)}`);
      assert(data.sessionId === undefined, `D: expected no synthetic remote sessionId: ${JSON.stringify(data)}`);

      // Proof of bypass: no local relay was spawned → no local pidfile, and the
      // local agent port stays closed.
      assert(!existsSync(pidFileD), `D: --remote must NOT create a local pidfile, found ${pidFileD}`);
      assert(!(await probePort(remoteAgentPort)), `D: --remote must NOT open a local relay agent port ${remoteAgentPort}`);
      console.log('  D remote bypass: no local relay/pidfile, connected to configured remote target ✓');

      rmSync(stateDirD, { recursive: true, force: true });
    }

    console.log('cli autospawn e2e ok');
  } finally {
    if (extA && extA.readyState === WebSocket.OPEN) extA.close();
    if (extC && extC.readyState === WebSocket.OPEN) extC.close();
    if (fakeRemote) await new Promise((r) => fakeRemote.close(() => r()));
    for (const pid of daemonPids) {
      if (pidAlive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ } }
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
