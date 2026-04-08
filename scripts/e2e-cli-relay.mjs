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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const SESSION_A = 'browser-alpha';
const SESSION_B = 'browser-beta';

const COMMON_TOOLS = [
  tool('list_pages', {}),
  tool('navigate_page', { pageId: { type: 'number' }, url: { type: 'string' }, type: { type: 'string' } }),
  tool('new_page', { url: { type: 'string' } }),
  tool('close_page', { pageId: { type: 'number' } }),
  tool('click', { ref: { type: 'string' } }),
  tool('fill', { ref: { type: 'string' }, value: { type: 'string' } }),
  tool('take_screenshot', { detail: { type: 'string' } }),
  tool('press_key', { keys: { type: 'string' } }),
  tool('evaluate_script', { function: { type: 'string' } }),
  tool('resize_page', { width: { type: 'number' }, height: { type: 'number' } }),
  tool('handle_dialog', { action: { type: 'string' }, promptText: { type: 'string' } }),
  tool('scroll_page', { direction: { type: 'string' }, numPages: { type: 'number' } }),
  tool('wait_for', { text: { type: 'array' }, timeout: { type: 'number' } }),
  tool('hover', { ref: { type: 'string' } }),
];

const SESSION_A_TOOLS = [
  ...COMMON_TOOLS,
  tool('file_upload', {
    uid: { type: 'string' },
    file: {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        mimeType: { type: 'string' },
        contentBase64: { type: 'string' },
      },
    },
  }),
];

const SESSION_B_TOOLS = [
  ...COMMON_TOOLS,
  tool('upload_file', { uid: { type: 'string' }, filePath: { type: 'string' } }),
];

function tool(name, properties) {
  return { name, description: `Fake ${name}`, inputSchema: { type: 'object', properties } };
}

function handleToolCall(name, args, sessionId) {
  switch (name) {
    case 'list_pages':
      // Return plain-text format matching real ListPagesTool output
      if (sessionId === SESSION_B) {
        return {
          content: [{
            type: 'text',
            text: 'Found 2 page(s):\nPage 201 [ACTIVE]: "Beta Home" - https://beta.example.com\nPage 202: "Beta Docs" - https://beta.example.com/docs',
          }],
        };
      }
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

function runCliExpectFailure(args, timeoutMs = MAX_CLI_MS) {
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
      if (code === 0) {
        reject(new Error(`CLI unexpectedly succeeded: ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
        return;
      }
      try {
        resolve({ data: JSON.parse(stdout), stderr, elapsed });
      } catch (error) {
        reject(new Error(`CLI did not emit valid JSON for failed command ${args.join(' ')}: ${stdout}\nstderr=${stderr}\n${error}`));
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
  let extensionA = null;
  let extensionB = null;
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

    // ------ Connect fake extensions (two local browser sessions) ------
    const attachFakeExtension = async (sessionId) => {
      const sessionTools = sessionId === SESSION_B ? SESSION_B_TOOLS : SESSION_A_TOOLS;
      const extension = await connectWebSocket(`ws://${HOST}:${EXTENSION_PORT}`);
      extension.send(JSON.stringify({ type: 'connected', sessionId }));
      extension.send(JSON.stringify({
        type: 'sessions_list',
        connected: true,
        sessionId,
        sessions: [{ sessionId, connected: true, connectedAt: Date.now(), toolCount: sessionTools.length }],
      }));

      extension.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === 'list_tools' && msg.requestId) {
          extension.send(JSON.stringify({
            type: 'tools_list',
            requestId: msg.requestId,
            sessionId,
            data: sessionTools,
          }));
        }

        if (msg.type === 'call_tool' && msg.requestId) {
          extension.send(JSON.stringify({
            type: 'tool_result',
            requestId: msg.requestId,
            sessionId,
            data: handleToolCall(msg.data?.name, msg.data?.arguments ?? {}, sessionId),
          }));
        }
      });

      return extension;
    };

    // =================================================================
    // TEST 0: status --wait-for-extension waits up to timeout when disconnected
    // =================================================================
    {
      const { data, elapsed } = await runCli([
        'status',
        '--wait-for-extension',
        '--wait-timeout',
        '400',
        '--poll-interval',
        '100',
      ]);
      assert(data.ok === true, `waited status not ok: ${JSON.stringify(data)}`);
      assert(data.extensionConnected === false, `waited status should time out disconnected: ${JSON.stringify(data)}`);
      assert(data.waitForExtension === true, `waited status should report waitForExtension: ${JSON.stringify(data)}`);
      assert(Number(data.waitedMs) >= 300, `waited status should wait near timeout: ${JSON.stringify(data)}`);
      assert(elapsed >= 300, `status --wait-for-extension should not return immediately: ${elapsed}ms`);
      console.log(`  status+w:${elapsed}ms (budget: ${MAX_CLI_MS}ms) — waited for timeout ✓`);
    }

    extensionA = await attachFakeExtension(SESSION_A);
    extensionB = await attachFakeExtension(SESSION_B);

    // Give relay a moment to finish tool sync with the extensions
    await delay(500);

    // =================================================================
    // TEST 1: `vibebrowser-cli sessions` lists all connected sessions and
    // defaults to the first connected session when --session is omitted.
    // =================================================================
    {
      const { data, elapsed } = await runCli(['sessions']);
      assert(Array.isArray(data.sessions), `sessions missing array: ${JSON.stringify(data)}`);
      assert(data.sessions.length === 2, `expected 2 sessions, got ${data.sessions.length}: ${JSON.stringify(data)}`);
      assert(data.sessionId === SESSION_A, `default selected session should be ${SESSION_A}: ${JSON.stringify(data)}`);
      console.log(`  sessions:${elapsed}ms (budget: ${MAX_CLI_MS}ms) — ${data.sessions.length} sessions ✓`);
    }

    // =================================================================
    // TEST 2: `vibebrowser-cli status` completes quickly
    // =================================================================
    {
      const { data, elapsed } = await runCli(['status']);
      assert(data.ok === true, `status not ok: ${JSON.stringify(data)}`);
      assert(data.extensionConnected === true, `extension not connected: ${JSON.stringify(data)}`);
      assert(Number(data.toolCount) === SESSION_A_TOOLS.length, `toolCount mismatch (${data.toolCount} != ${SESSION_A_TOOLS.length}): ${JSON.stringify(data)}`);
      assert(data.sessionId === SESSION_A, `status should select ${SESSION_A} by default: ${JSON.stringify(data)}`);
      console.log(`  status:  ${elapsed}ms (budget: ${MAX_CLI_MS}ms) — ${data.toolCount} tools ✓`);
    }

    // =================================================================
    // TEST 3: `vibebrowser-cli tabs` returns parsed tab data quickly
    // =================================================================
    {
      const { data, elapsed } = await runCli(['tabs']);
      assert(Array.isArray(data.pages), `tabs missing pages array: ${JSON.stringify(data)}`);
      assert(data.pages.length === 3, `expected 3 pages, got ${data.pages.length}: ${JSON.stringify(data)}`);
      assert(data.sessionId === SESSION_A, `tabs should select ${SESSION_A} by default: ${JSON.stringify(data)}`);

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
    // TEST 4: `vibebrowser-cli --session <id> tabs` routes to that session
    // =================================================================
    {
      const { data, elapsed } = await runCli(['--session', SESSION_B, 'tabs']);
      assert(Array.isArray(data.pages), `session tabs missing pages array: ${JSON.stringify(data)}`);
      assert(data.sessionId === SESSION_B, `tabs should use requested session ${SESSION_B}: ${JSON.stringify(data)}`);
      const active = data.pages.find((p) => p.active === true);
      assert(active?.title === 'Beta Home', `wrong session selected for tabs: ${JSON.stringify(data.pages)}`);
      console.log(`  tabs+s:  ${elapsed}ms (budget: ${MAX_CLI_MS}ms) — session override ✓`);
    }

    // =================================================================
    // TEST 5: invalid requested session should fail with precise error
    // =================================================================
    {
      const missingSession = 'browser-missing';
      const { data, elapsed } = await runCliExpectFailure(['--session', missingSession, 'tabs']);
      assert(data.ok === false, `invalid session should not be ok: ${JSON.stringify(data)}`);
      assert(typeof data.error === 'string', `missing error message: ${JSON.stringify(data)}`);
      assert(data.error.includes(`No browser session connected for sessionId=${missingSession}`), `wrong invalid-session error: ${JSON.stringify(data)}`);
      assert(data.sessionId !== missingSession, `should not report missing session as active: ${JSON.stringify(data)}`);
      console.log(`  tabs!s:  ${elapsed}ms (budget: ${MAX_CLI_MS}ms) — invalid session error ✓`);
    }

    // =================================================================
    // TEST 6: `vibebrowser-cli open <url>` calls new_page through relay
    // =================================================================
    {
      const { data, elapsed } = await runCli(['open', 'https://example.com']);
      assert(data.ok === true, `open not ok: ${JSON.stringify(data)}`);
      assert(data.tool === 'new_page', `open used wrong tool: ${JSON.stringify(data)}`);
      console.log(`  open:    ${elapsed}ms (budget: ${MAX_CLI_MS}ms) ✓`);
    }

    // =================================================================
    // TEST 7: `vibebrowser-cli click <ref>` calls click through relay
    // =================================================================
    {
      const { data, elapsed } = await runCli(['click', '42']);
      assert(data.ok === true, `click not ok: ${JSON.stringify(data)}`);
      assert(data.tool === 'click', `click used wrong tool: ${JSON.stringify(data)}`);
      console.log(`  click:   ${elapsed}ms (budget: ${MAX_CLI_MS}ms) ✓`);
    }

    // =================================================================
    // TEST 8: `vibebrowser-cli resize <w> <h>` calls resize_page
    // =================================================================
    {
      const { data, elapsed } = await runCli(['resize', '1280', '720']);
      assert(data.ok === true, `resize not ok: ${JSON.stringify(data)}`);
      assert(data.tool === 'resize_page', `resize used wrong tool: ${JSON.stringify(data)}`);
      console.log(`  resize:  ${elapsed}ms (budget: ${MAX_CLI_MS}ms) ✓`);
    }

    // =================================================================
    // TEST 9: `vibebrowser-cli upload <ref> <path>` maps extension payload schema
    // =================================================================
    {
      const { data, elapsed } = await runCli(['upload', 'A7', 'docs/chrome-devtools-relay.md']);
      assert(data.ok === true, `upload not ok: ${JSON.stringify(data)}`);
      const expectedBase64 = readFileSync(resolve(PACKAGE_ROOT, 'docs/chrome-devtools-relay.md')).toString('base64');
      assert(data.tool === 'file_upload', `upload used wrong tool: ${JSON.stringify(data)}`);
      const echoed = JSON.parse(data.raw?.content?.[0]?.text ?? '{}');
      assert(echoed.args?.file?.filename === 'chrome-devtools-relay.md', `upload filename mismatch: ${JSON.stringify(data)}`);
      assert(echoed.args?.file?.mimeType === 'text/markdown', `upload mimeType mismatch: ${JSON.stringify(data)}`);
      assert(echoed.args?.file?.contentBase64 === expectedBase64, `upload content payload mismatch: ${JSON.stringify(data)}`);
      console.log(`  upload-e:${elapsed}ms (budget: ${MAX_CLI_MS}ms) — extension payload ✓`);
    }

    // =================================================================
    // TEST 10: `vibebrowser-cli upload <ref> <path>` maps devtools path schema
    // =================================================================
    {
      const { data, elapsed } = await runCli(['--session', SESSION_B, 'upload', 'A7', 'docs/chrome-devtools-relay.md']);
      assert(data.ok === true, `upload not ok: ${JSON.stringify(data)}`);
      assert(data.tool === 'upload_file', `upload used wrong tool: ${JSON.stringify(data)}`);
      const echoed = JSON.parse(data.raw?.content?.[0]?.text ?? '{}');
      assert(echoed.args?.filePath === 'docs/chrome-devtools-relay.md', `upload filePath mismatch: ${JSON.stringify(data)}`);
      console.log(`  upload-d:${elapsed}ms (budget: ${MAX_CLI_MS}ms) — devtools path ✓`);
    }

    // =================================================================
    // TEST 11: `vibebrowser-cli dialog --dismiss` calls handle_dialog
    // =================================================================
    {
      const { data, elapsed } = await runCli(['dialog', '--dismiss']);
      assert(data.ok === true, `dialog not ok: ${JSON.stringify(data)}`);
      assert(data.tool === 'handle_dialog', `dialog used wrong tool: ${JSON.stringify(data)}`);
      console.log(`  dialog:  ${elapsed}ms (budget: ${MAX_CLI_MS}ms) ✓`);
    }

    console.log('cli relay e2e ok');
  } finally {
    if (extensionA && extensionA.readyState === WebSocket.OPEN) extensionA.close();
    if (extensionB && extensionB.readyState === WebSocket.OPEN) extensionB.close();
    if (relay) relay.kill('SIGTERM');
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
