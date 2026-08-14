#!/usr/bin/env node
/**
 * Regression for #14: an intermittent `tools/list` startup timeout when the
 * extension is connected but has not yet published its tools.
 *
 * Repro: a fake relay accepts the MCP server's connection and reports the
 * extension connected, but NEVER answers the `list_tools` request. Before the fix
 * the server's tools/list handler blocked on refreshTools (4s) + waitForToolsUpdate
 * (1.5s) = ~5.5s, which could stack with relay/extension startup and blow a client's
 * 10s tools/list budget. The fix caps the whole handler at STARTUP_TOOLS_LIST_BUDGET_MS
 * (3s) and relies on tools.listChanged to push tools that arrive later.
 *
 * Assertion: client.listTools() resolves well within the client budget (we use a
 * 4.5s bound — comfortably below 10s, and below the old ~5.5s blocking path), and
 * returns at least the always-present set_remote tool rather than timing out.
 */
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

const HOST = '127.0.0.1';
const REMOTE_UUID = '77777777-7777-4777-8777-777777777777';
const SESSION_ID = REMOTE_UUID;
// Must beat a typical client startup budget (10s) and the old ~5.5s blocking path.
const TOOLS_LIST_MAX_MS = 4_500;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, HOST, () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
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

/** A relay that connects the extension but deliberately never answers list_tools. */
function startSilentRelay(port, uuid, sessionId) {
  const server = new WebSocketServer({ host: HOST, port });
  let sawListTools = false;
  const connected = new Promise((resolve) => {
    server.on('connection', (ws, req) => {
      if (req.url !== `/${uuid}`) { ws.close(); return; }
      ws.send(JSON.stringify({ type: 'extension_status', connected: true }));
      ws.send(JSON.stringify({ type: 'connected', sessionId }));
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'list_tools') sawListTools = true;
        } catch { /* ignore */ }
        // Intentionally never reply to list_tools — this is the repro.
      });
      resolve(ws);
    });
  });
  return { server, connected, sawListTools: () => sawListTools };
}

async function closeRelay(relay) {
  if (!relay) return;
  for (const c of relay.server.clients) c.terminate();
  await new Promise((resolve, reject) => relay.server.close((e) => (e ? reject(e) : resolve())));
}

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
    const t = setTimeout(() => { child.kill('SIGKILL'); finish(); }, timeoutMs);
    child.once('exit', finish);
    child.once('close', finish);
  });
}

async function main() {
  const httpPort = await findFreePort();
  const relayPort = await findFreePort();
  const relayUrl = `ws://${HOST}:${relayPort}`;
  const mcpUrl = `http://${HOST}:${httpPort}/mcp`;
  const stateDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-budget-e2e-'));

  let relay;
  let serverProcess;
  let client;
  try {
    relay = startSilentRelay(relayPort, REMOTE_UUID, SESSION_ID);

    serverProcess = spawn(
      process.execPath,
      ['dist/cli.js', 'start', '--transport', 'http', '--host', HOST,
        '--http-port', String(httpPort), '--remote', `${relayUrl}/${REMOTE_UUID}`],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VIBE_MCP_STATE_DIR: stateDir } },
    );

    await Promise.all([relay.connected, waitForPort(httpPort)]);

    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    client = new Client({ name: 'vibe-mcp-budget-e2e', version: '1.0.0' });
    await client.connect(transport);

    // The key assertion: tools/list must return within the budget even though the
    // extension never publishes tools. Before the fix this blocked ~5.5s.
    const started = Date.now();
    const tools = await client.listTools();
    const elapsed = Date.now() - started;

    assert(
      elapsed < TOOLS_LIST_MAX_MS,
      `tools/list took ${elapsed}ms, expected < ${TOOLS_LIST_MAX_MS}ms (startup budget regression #14)`,
    );
    assert(
      tools.tools.some((t) => t.name === 'set_remote'),
      `Expected set_remote tool in bounded tools/list response: ${JSON.stringify(tools.tools.map((t) => t.name))}`,
    );
    assert(relay.sawListTools(), 'Expected the server to have attempted a list_tools refresh');

    console.log(`tools/list startup budget e2e ok (${elapsed}ms, ${tools.tools.length} tools)`);
  } finally {
    if (client) { try { await client.close(); } catch { /* ignore */ } }
    if (serverProcess) { serverProcess.kill('SIGTERM'); await waitForExit(serverProcess); }
    await closeRelay(relay);
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
