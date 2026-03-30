#!/usr/bin/env node
/**
 * E2E: CLI commands through the REAL relay daemon.
 *
 * This test exercises the exact user path that was broken in production
 * (#893): `vibebrowser-cli status` and `vibebrowser-cli tabs` are
 * spawned as child processes, connecting through the real relay daemon
 * to a fake extension.
 *
 * Unlike e2e-browser-cli.mjs (which uses a fake WebSocket server acting
 * as the relay), this test starts the real relay-daemon.js and connects:
 *
 *   CLI (child process) ──ws──▶ RELAY (agent port)
 *   RELAY (extension port) ◀──ws── fake extension (in-process)
 *
 * This catches:
 *   - relay pending-request resolution bugs (#893 root cause)
 *   - CLI ↔ relay negotiation/handshake issues
 *   - tool list caching / refresh hangs that the fake-relay test masks
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HOST = '127.0.0.1';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const LOCAL_BROWSER_CLI = resolve(PACKAGE_ROOT, 'dist', 'browser-main.js');
const MAX_CLI_MS = 8_000; // CLI commands must complete well under old 30s hang

const RESERVED_PORTS = new Set();
const AGENT_PORT = await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(AGENT_PORT);
const EXTENSION_PORT = await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(EXTENSION_PORT);

// ---------------------------------------------------------------------------
// Helpers
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Fake extension tool handler
// ---------------------------------------------------------------------------

const FAKE_TOOLS = [
  tool('list_pages', {}),
  tool('navigate_page', { pageId: { type: 'number' }, url: { type: 'string' }, type: { type: 'string' } }),
  tool('new_page', { url: { type: 'string' } }),
  tool('close_page', { pageId: { type: 'number' } }),
  tool('click', { ref: { type: 'string' } }),
  tool('fill', { ref: { type: 'string' }, value: { type: 'string' } }),
  tool('take_screenshot', { detail: { type: 'string' } }),
  tool('press_key', { keys: { type: 'string' } }),
  tool('evaluate_script', { function: { type: 'string' } }),
  tool('scroll_page', { direction: { type: 'string' }, numPages: { type: 'number' } }),
  tool('wait_for', { text: { type: 'array' }, timeout: { type: 'number' } }),
  tool('hover', { ref: { type: 'string' } }),
];

function tool(name, properties) {
  return { name, description: `Fake ${name}`, inputSchema: { type: 'object', properties } };
}

function handleToolCall(name, args) {
  switch (name) {
    case 'list_pages':
      // Return plain-text format matching real ListPagesTool output
      return {
        content: [{
          type: 'text',
          text: 'Found 3 page(s):\nPage 101 [ACTIVE]: "GitHub" - https://github.com\nPage 102: "Google" - https://google.com\nPage 103: "Docs" - https://docs.example.com',
        }],
      };
    default:
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name, args }) }],
      };
  }
}

// ---------------------------------------------------------------------------
// CLI runner — spawns the REAL CLI binary pointing at the relay's agent port
// ---------------------------------------------------------------------------

function runCli(args, timeoutMs = MAX_CLI_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        LOCAL_BROWSER_CLI,
        '--port', String(AGENT_PORT),
        '--json',
        ...args,
      ],
      {
        cwd: PACKAGE_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${timeoutMs}ms: vibebrowser-cli ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);

    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const elapsed = Date.now() - t0;
      if (code !== 0) {
        reject(new Error(`CLI exited ${code}: ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
        return;
      }
      try {
        resolve({ data: JSON.parse(stdout), elapsed });
      } catch (error) {
        reject(new Error(`CLI did not emit valid JSON for ${args.join(' ')}: ${stdout}\nstderr=${stderr}\n${error}`));
      }
    });

    const t0 = Date.now();
  });
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
  let relay = null;
  let extension = null;
  const stateDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-cli-relay-'));

  try {
    // ------ Start real relay daemon ------
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

    // Extension auto-responds to ALL relay messages
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
          data: handleToolCall(msg.data?.name, msg.data?.arguments ?? {}),
        }));
      }
    });

    // Give relay a moment to finish tool sync with the extension
    await delay(500);

    // =================================================================
    // TEST 1: `vibebrowser-cli status` completes quickly
    // =================================================================
    {
      const { data, elapsed } = await runCli(['status']);
      assert(data.ok === true, `status not ok: ${JSON.stringify(data)}`);
      assert(data.extensionConnected === true, `extension not connected: ${JSON.stringify(data)}`);
      assert(Number(data.toolCount) >= 10, `toolCount too low (${data.toolCount}): ${JSON.stringify(data)}`);
      console.log(`  status:  ${elapsed}ms (budget: ${MAX_CLI_MS}ms) — ${data.toolCount} tools ✓`);
    }

    // =================================================================
    // TEST 2: `vibebrowser-cli tabs` returns parsed tab data quickly
    // =================================================================
    {
      const { data, elapsed } = await runCli(['tabs']);
      assert(Array.isArray(data.pages), `tabs missing pages array: ${JSON.stringify(data)}`);
      assert(data.pages.length === 3, `expected 3 pages, got ${data.pages.length}: ${JSON.stringify(data)}`);

      // Verify parsed fields
      const active = data.pages.find((p) => p.active === true);
      assert(active != null, `no active page found: ${JSON.stringify(data.pages)}`);
      assert(active.title === 'GitHub', `wrong active title: ${active.title}`);
      assert(active.url === 'https://github.com', `wrong active url: ${active.url}`);

      const inactive = data.pages.filter((p) => !p.active);
      assert(inactive.length === 2, `expected 2 inactive pages: ${JSON.stringify(data.pages)}`);

      console.log(`  tabs:    ${elapsed}ms (budget: ${MAX_CLI_MS}ms) — ${data.pages.length} pages ✓`);
    }

    // =================================================================
    // TEST 3: `vibebrowser-cli open <url>` calls new_page through relay
    // =================================================================
    {
      const { data, elapsed } = await runCli(['open', 'https://example.com']);
      assert(data.ok === true, `open not ok: ${JSON.stringify(data)}`);
      assert(data.tool === 'new_page', `open used wrong tool: ${JSON.stringify(data)}`);
      console.log(`  open:    ${elapsed}ms (budget: ${MAX_CLI_MS}ms) ✓`);
    }

    // =================================================================
    // TEST 4: `vibebrowser-cli click <ref>` calls click through relay
    // =================================================================
    {
      const { data, elapsed } = await runCli(['click', '42']);
      assert(data.ok === true, `click not ok: ${JSON.stringify(data)}`);
      assert(data.tool === 'click', `click used wrong tool: ${JSON.stringify(data)}`);
      console.log(`  click:   ${elapsed}ms (budget: ${MAX_CLI_MS}ms) ✓`);
    }

    console.log('cli relay e2e ok');
  } finally {
    if (extension && extension.readyState === WebSocket.OPEN) extension.close();
    if (relay) relay.kill('SIGTERM');
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
