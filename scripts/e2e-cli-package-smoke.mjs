#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const HOST = '127.0.0.1';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const CLI_PACKAGE_ROOT = resolve(PACKAGE_ROOT, 'packages', 'cli');
const WORK_ROOT = resolve(PACKAGE_ROOT, '.artifacts', 'cli-package-smoke');
const PACK_DEST = resolve(WORK_ROOT, 'pack');
const INSTALL_PROJECT = resolve(WORK_ROOT, 'install-project');
const CERT_PATH = resolve(SCRIPT_DIR, 'fixtures', 'localhost-cert.pem');
const KEY_PATH = resolve(SCRIPT_DIR, 'fixtures', 'localhost-key.pem');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const CLI_BIN = resolve(INSTALL_PROJECT, 'node_modules', '.bin', process.platform === 'win32' ? 'vibebrowser-cli.cmd' : 'vibebrowser-cli');
const KEEP_ARTIFACTS = process.env.KEEP_CLI_PACK_GATE_ARTIFACTS === '1';
const SESSION_ID = 'packed-cli-local-wss-session';
const PROXY_PATH = `/relay/nested/${SESSION_ID}`;
const EXPECTED_PAGES = [{ id: 7, title: 'Packed CLI WSS roundtrip', url: 'https://example.test/', active: true }];
const EXPECTED_PAYLOAD = { pages: EXPECTED_PAGES };
const EXPECTED_RAW = {
  success: true,
  ...EXPECTED_PAYLOAD,
  content: [{ type: 'text', text: JSON.stringify(EXPECTED_PAYLOAD) }],
};
const TOOLS = [{
  name: 'list_pages',
  description: 'List pages in the deterministic package smoke harness',
  inputSchema: { type: 'object', properties: {} },
}];
let relayStderr = '';

function cleanupArtifacts() {
  if (!KEEP_ARTIFACTS) rmSync(WORK_ROOT, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`Package setup command failed (${result.status}): ${command}`);
  return result;
}

function parsePackFilename(stdout) {
  const payload = JSON.parse(stdout);
  const filename = Array.isArray(payload) ? payload[0]?.filename : undefined;
  if (!filename) throw new Error('npm pack --json did not report a filename');
  return filename;
}

function reservePort(excluded) {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) return reject(error);
        if (!port || excluded.has(port)) return reservePort(excluded).then(resolvePort, reject);
        excluded.add(port);
        resolvePort(port);
      });
    });
  });
}

async function waitForPort(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listening = await new Promise((resolveProbe) => {
      const socket = net.connect({ host: HOST, port });
      socket.once('connect', () => { socket.destroy(); resolveProbe(true); });
      socket.once('error', () => resolveProbe(false));
    });
    if (listening) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => { cleanup(); resolveExit(false); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
    };
    const onExit = () => { cleanup(); resolveExit(true); };
    child.once('exit', onExit);
  });
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolveValue(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 2_000)) return;
  child.kill('SIGKILL');
  await waitForExit(child, 2_000);
}

async function closeWebSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolveClose) => {
    const timer = setTimeout(() => { ws.terminate(); resolveClose(); }, 500);
    ws.once('close', () => { clearTimeout(timer); resolveClose(); });
  });
  if (ws.readyState === WebSocket.OPEN) ws.close();
  else ws.terminate();
  await closed;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolveClose) => server.close(() => resolveClose()));
}

async function runCli(env, childRef) {
  const child = spawn(CLI_BIN, ['--json', 'tabs'], {
    cwd: INSTALL_PROJECT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  childRef.current = child;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((resolveStatus, reject) => {
    const timer = setTimeout(async () => {
      await terminateChild(child);
      reject(new Error('Packed CLI roundtrip timed out'));
    }, 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolveStatus(code ?? 1); });
  });
  if (status !== 0) throw new Error(`Packed CLI exited ${status}; stderr length=${stderr.length}`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('Packed CLI did not emit valid JSON');
  }
}

async function main() {
  console.log('CLI_PACK_WSS_GATE:START');
  const browserMain = resolve(CLI_PACKAGE_ROOT, 'dist', 'browser-main.js');
  if (!existsSync(browserMain)) throw new Error('Standalone CLI build output is missing; run npm run build first');

  cleanupArtifacts();
  mkdirSync(PACK_DEST, { recursive: true });
  mkdirSync(INSTALL_PROJECT, { recursive: true });
  const packResult = run(NPM_BIN, ['pack', '--json', '--pack-destination', PACK_DEST], CLI_PACKAGE_ROOT);
  const tarballPath = resolve(PACK_DEST, parsePackFilename(packResult.stdout));
  run(NPM_BIN, ['init', '-y'], INSTALL_PROJECT);
  run(NPM_BIN, ['install', tarballPath], INSTALL_PROJECT);
  console.log('CLI_PACK_WSS_GATE:INSTALL_OK');

  const ports = new Set();
  const proxyPort = await reservePort(ports);
  const agentPort = await reservePort(ports);
  const extensionPort = await reservePort(ports);
  let stateDir = null;
  let harnessError = null;
  let relay = null;
  let tlsServer = null;
  let wss = null;
  const downstreamSockets = new Set();
  const upstreamSockets = new Set();
  const cliChild = { current: null };
  let extension = null;
  let toolsAnnouncementTimer = null;
  let observedCallTool = false;
  let resolveToolsReady;
  const toolsReady = new Promise((resolveReady) => { resolveToolsReady = resolveReady; });

  try {
    stateDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-cli-pack-'));
    relay = spawn(process.execPath, ['dist/relay-daemon.js'], {
      cwd: PACKAGE_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        VIBE_MCP_AGENT_PORT: String(agentPort),
        VIBE_MCP_EXTENSION_PORT: String(extensionPort),
        VIBE_MCP_STATE_DIR: stateDir,
      },
    });
    relay.stderr.on('data', (chunk) => { relayStderr += chunk; });
    relay.on('error', (error) => { harnessError = error; });

    tlsServer = createServer({ key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) });
    wss = new WebSocketServer({ noServer: true });
    tlsServer.on('upgrade', (request, socket, head) => {
      if (request.url !== PROXY_PATH) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });
    wss.on('connection', (downstream) => {
      downstreamSockets.add(downstream);
      const upstream = new WebSocket(`ws://${HOST}:${agentPort}`);
      upstreamSockets.add(upstream);
      const pending = [];
      downstream.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else pending.push([data, isBinary]);
      });
      upstream.on('open', () => {
        for (const [data, isBinary] of pending.splice(0)) upstream.send(data, { binary: isBinary });
      });
      upstream.on('message', (data, isBinary) => {
        if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary: isBinary });
      });
      downstream.on('close', () => { downstreamSockets.delete(downstream); void closeWebSocket(upstream); });
      upstream.on('close', () => { upstreamSockets.delete(upstream); void closeWebSocket(downstream); });
      downstream.on('error', () => { void closeWebSocket(upstream); });
      upstream.on('error', () => { void closeWebSocket(downstream); });
    });

    await Promise.all([waitForPort(agentPort), waitForPort(extensionPort)]);

    extension = new WebSocket(`ws://${HOST}:${extensionPort}`);
    extension.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === 'list_tools' && message.requestId) {
        extension.send(JSON.stringify({
          type: 'tools_list',
          requestId: message.requestId,
          sessionId: SESSION_ID,
          data: TOOLS,
        }));
        resolveToolsReady();
      } else if (message.type === 'call_tool' && message.requestId) {
        if (message.data?.name !== 'list_pages') {
          harnessError = new Error(`Packed CLI called unexpected tool: ${message.data?.name}`);
          return;
        }
        const firstCall = !observedCallTool;
        observedCallTool = true;
        extension.send(JSON.stringify({
          type: 'tool_result',
          requestId: message.requestId,
          sessionId: SESSION_ID,
          data: EXPECTED_RAW,
        }));
        if (firstCall) console.log('CLI_PACK_WSS_GATE:EXTENSION_CALL_OK');
      }
    });
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting fake extension')), 10_000);
      extension.once('open', () => { clearTimeout(timer); resolveOpen(); });
      extension.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    extension.send(JSON.stringify({ type: 'connected', sessionId: SESSION_ID }));
    await withTimeout(toolsReady, 10_000, 'Timed out waiting for relay list_tools');
    toolsAnnouncementTimer = setInterval(() => {
      if (extension?.readyState === WebSocket.OPEN) {
        extension.send(JSON.stringify({ type: 'tools_list', sessionId: SESSION_ID, data: TOOLS }));
      }
    }, 250);

    await new Promise((resolveListen, reject) => {
      tlsServer.once('error', reject);
      tlsServer.listen(proxyPort, HOST, resolveListen);
    });
    console.log('CLI_PACK_WSS_GATE:REAL_RELAY_OK');

    const result = await runCli({
      ...process.env,
      NODE_EXTRA_CA_CERTS: CERT_PATH,
      VIBE_REMOTE_URL: `wss://${HOST}:${proxyPort}${PROXY_PATH}`,
    }, cliChild);
    if (harnessError) throw harnessError;
    if (!observedCallTool) throw new Error('Fake extension did not observe relay-forwarded call_tool');
    const expected = {
      ok: true,
      command: 'tabs',
      profile: process.env.VIBE_BROWSER_PROFILE || 'user',
      mode: 'remote',
      sessionId: SESSION_ID,
      ignoredCompatibilityOptions: [],
      tool: 'list_pages',
      pages: EXPECTED_PAGES,
      raw: EXPECTED_RAW,
    };
    if (JSON.stringify(result) !== JSON.stringify(expected)) {
      throw new Error('Packed CLI output did not exactly match the expected pages and raw payload');
    }
    console.log('CLI_PACK_WSS_GATE:ROUNDTRIP_OK');
    console.log('CLI_PACK_WSS_GATE:PASS');
  } finally {
    if (toolsAnnouncementTimer) clearInterval(toolsAnnouncementTimer);
    await terminateChild(cliChild.current);
    await Promise.all([...downstreamSockets, ...upstreamSockets].map(closeWebSocket));
    await closeWebSocket(extension);
    if (wss) {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolveClose) => wss.close(() => resolveClose()));
    }
    await closeServer(tlsServer);
    await terminateChild(relay);
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  }
}

try {
  await main();
  cleanupArtifacts();
} catch (error) {
  console.error('CLI_PACK_WSS_GATE:FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`CLI_PACK_WSS_GATE:RELAY_STDERR_LENGTH:${relayStderr.length}`);
  if (KEEP_ARTIFACTS) console.error(`CLI_PACK_WSS_GATE:ARTIFACTS:${WORK_ROOT}`);
  else cleanupArtifacts();
  process.exit(1);
}
