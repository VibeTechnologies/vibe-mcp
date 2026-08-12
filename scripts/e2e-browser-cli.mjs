#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HOST = '127.0.0.1';
const REMOTE_UUID = '11111111-1111-4111-8111-111111111111';
const REDACTED_REMOTE_ID = '[redacted]';
const RELAY_PORT = await findFreePort();
const RELAY_URL = `ws://${HOST}:${RELAY_PORT}`;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const LOCAL_BROWSER_CLI = resolve(PACKAGE_ROOT, 'dist', 'browser-main.js');
const DIST_CONNECTION = resolve(PACKAGE_ROOT, 'dist', 'connection.js');
const CLI_PACKAGE_ROOT = resolve(PACKAGE_ROOT, 'packages', 'cli');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const E2E_BROWSER_CLI_SOURCE = (process.env.E2E_BROWSER_CLI_SOURCE || 'local').toLowerCase();
const E2E_BROWSER_CLI_PACKAGE = process.env.E2E_BROWSER_CLI_PACKAGE;
const TEST_DIR = mkdtempSync(join(tmpdir(), 'vibe-mcp-browser-cli-'));
const SCREENSHOT_PATH = join(TEST_DIR, 'shot.png');
let packedPackageDir = null;
let cliInvocation = null;
let delayToolResultMs = 0;
let missingPageIdMode = false;
let fillCompatibilityErrorMode = false;
let credentialErrorMode = false;
let credentialToolResultMode = false;

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W6n8AAAAASUVORK5CYII=';

// When true, list_pages returns plain-text format (like the real extension does)
let listPagesPlainText = false;

const TOOLS = [
  tool('list_pages', {}),
  tool('new_page', { url: { type: 'string' }, waitForReady: { type: 'boolean' } }),
  tool('navigate_page', { pageId: { type: 'number' }, url: { type: 'string' }, type: { type: 'string' }, timeoutMs: { type: 'number' } }),
  tool('switch_to_page', { pageId: { type: 'number' } }),
  tool('select_page', { pageId: { type: 'number' } }),
  tool('close_page', { pageId: { type: 'number' } }),
  tool('take_screenshot', {
    fullPage: { type: 'boolean' },
    ref: { type: 'string' },
    detail: { type: 'string' },
    grayscale: { type: 'boolean' },
    pageId: { type: 'number' },
  }),
  tool('click', { ref: { type: 'string' }, dblClick: { type: 'boolean' }, pageId: { type: 'number' } }),
  tool('fill', { ref: { type: 'string' }, value: { type: 'string' }, pageId: { type: 'number' } }),
  tool('type_text', { text: { type: 'string' }, submitKey: { type: 'string' }, pageId: { type: 'number' } }),
  tool('press_key', { keys: { type: 'string' }, pageId: { type: 'number' } }),
  tool('hover', { ref: { type: 'string' }, pageId: { type: 'number' } }),
  tool('drag', { source: { type: 'string' }, target: { type: 'string' }, pageId: { type: 'number' } }),
  tool('list_network_requests', { limit: { type: 'number' }, pageId: { type: 'number' } }),
  tool('get_network_request', { requestId: { type: 'string' }, pageId: { type: 'number' } }),
  tool('evaluate_script', { function: { type: 'string' }, args: { type: 'array' }, pageId: { type: 'number' } }),

  tool('wait_for', { text: { type: 'array' }, timeout: { type: 'number' } }),
  tool('take_md_snapshot', { pageId: { type: 'number' } }),
  tool('take_a11y_snapshot', { pageId: { type: 'number' }, selector: { type: 'string' }, frameSelector: { type: 'string' } }),
];


let wss;

try {
  wss = new WebSocketServer({ host: HOST, port: RELAY_PORT });
  wss.on('connection', (ws, req) => {
    if (req.url !== `/${REMOTE_UUID}`) {
      ws.close();
      return;
    }

    ws.send(JSON.stringify({ type: 'extension_status', connected: true }));
    ws.send(JSON.stringify({
      type: 'sessions_list',
      connected: true,
      sessionId: REMOTE_UUID,
      sessions: [{ sessionId: REMOTE_UUID, connected: true, connectedAt: Date.now(), toolCount: TOOLS.length }],
    }));

    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'list_tools') {
        ws.send(JSON.stringify({
          type: 'tools_list',
          requestId: message.requestId,
          data: TOOLS,
        }));
        return;
      }

      if (message.type === 'list_sessions') {
        ws.send(JSON.stringify({
          type: 'sessions_list',
          requestId: message.requestId,
          connected: true,
          sessionId: REMOTE_UUID,
          sessions: [{ sessionId: REMOTE_UUID, connected: true, connectedAt: Date.now(), toolCount: TOOLS.length }],
        }));
        return;
      }

      if (message.type === 'call_tool') {
        if (credentialToolResultMode) {
          ws.send(JSON.stringify({
            type: 'tool_result',
            requestId: message.requestId,
            data: {
              success: false,
              isError: true,
              detail: `Relay rejected ${REMOTE_UUID.toUpperCase()}`,
              content: [{ type: 'text', text: `Relay rejected ${REMOTE_UUID.toUpperCase()}` }],
            },
          }));
          return;
        }
        if (credentialErrorMode) {
          ws.send(JSON.stringify({
            type: 'error',
            requestId: message.requestId,
            error: `Relay rejected ${REMOTE_UUID.toUpperCase()}`,
          }));
          return;
        }
        if (
          missingPageIdMode
          && (message.data?.name === 'navigate_page' || message.data?.name === 'click')
          && message.data?.arguments?.pageId === undefined
        ) {
          ws.send(JSON.stringify({
            type: 'error',
            requestId: message.requestId,
            error: 'Missing required pageId',
          }));
          return;
        }
        if (fillCompatibilityErrorMode && message.data?.name === 'fill') {
          ws.send(JSON.stringify({
            type: 'error',
            requestId: message.requestId,
            error: 'Invalid arguments: fill does not accept ref in this backend',
          }));
          return;
        }
        const send = () => {
          ws.send(JSON.stringify({
            type: 'tool_result',
            requestId: message.requestId,
            data: handleToolCall(message.data?.name, message.data?.arguments ?? {}),
          }));
        };
        if (delayToolResultMs > 0) {
          setTimeout(send, delayToolResultMs);
        } else {
          send();
        }
      }
    });
  });

  const { parseRemoteRelayUrl } = await import(DIST_CONNECTION);
  const parsedWssRemote = parseRemoteRelayUrl(`wss://relay.example.test/nested/${REMOTE_UUID}`);
  assert(parsedWssRemote.relayUrl === 'wss://relay.example.test/nested', `wss remote relay base parsed incorrectly: ${JSON.stringify(parsedWssRemote)}`);
  assert(parsedWssRemote.uuid === REMOTE_UUID, `wss remote UUID parsed incorrectly: ${JSON.stringify(parsedWssRemote)}`);
  let queryRejected = false;
  try {
    parseRemoteRelayUrl(`wss://relay.example.test/nested/${REMOTE_UUID}?token=${'a'.repeat(64)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    queryRejected = /query|remote-secret/i.test(message);
  }
  assert(queryRejected, 'remote relay URL with query params should be rejected (token must be separate)');

  const status = await runCli(['status']);
  assert(status.ok === true, `status failed: ${JSON.stringify(status)}`);
  assert(status.extensionConnected === true, `expected extension connected: ${JSON.stringify(status)}`);
  assert(Number(status.toolCount) >= 10, `expected toolCount >= 10: ${JSON.stringify(status)}`);
  assert(status.sessionId === REDACTED_REMOTE_ID, `expected redacted remote session: ${JSON.stringify(status)}`);
  assert(!JSON.stringify(status).includes(REMOTE_UUID), `status leaked remote UUID: ${JSON.stringify(status)}`);

  const uuidStatus = await runCli(['status'], { remoteValue: REMOTE_UUID });
  if (E2E_BROWSER_CLI_SOURCE === 'local') {
    assert(uuidStatus.ok === true, `UUID-only remote should return structured status locally: ${JSON.stringify(uuidStatus)}`);
    assert(uuidStatus.mode === 'remote', `UUID-only status should still be remote mode: ${JSON.stringify(uuidStatus)}`);
    assert(uuidStatus.extensionConnected === false, `UUID-only remote without public relay should report disconnected extension locally: ${JSON.stringify(uuidStatus)}`);
    assert(uuidStatus.sessionId === REDACTED_REMOTE_ID, `UUID-only status should redact sessionId: ${JSON.stringify(uuidStatus)}`);
  }

  const envStatus = await runCli(['status'], {
    remoteFromEnv: true,
    env: { VIBE_REMOTE_URL: `${RELAY_URL}/${REMOTE_UUID}` },
  });
  assert(envStatus.ok === true, `status via VIBE_REMOTE_URL failed: ${JSON.stringify(envStatus)}`);
  assert(envStatus.extensionConnected === true, `VIBE_REMOTE_URL should connect extension: ${JSON.stringify(envStatus)}`);
  assert(envStatus.sessionId === REDACTED_REMOTE_ID, `VIBE_REMOTE_URL should redact sessionId: ${JSON.stringify(envStatus)}`);

  const sessions = await runCli(['sessions']);
  assert(Array.isArray(sessions.sessions) && sessions.sessions.length === 1, `sessions missing session list: ${JSON.stringify(sessions)}`);
  assert(sessions.sessions[0].sessionId === REDACTED_REMOTE_ID, `remote session id should be redacted: ${JSON.stringify(sessions)}`);

  const tabs = await runCli(['tabs']);
  assert(Array.isArray(tabs.pages) && tabs.pages.length === 2, `tabs missing pages: ${JSON.stringify(tabs)}`);

  // Test plain-text format (matches real ListPagesTool output)
  listPagesPlainText = true;
  const tabsText = await runCli(['tabs']);
  assert(Array.isArray(tabsText.pages) && tabsText.pages.length === 2, `tabs (plain-text) missing pages: ${JSON.stringify(tabsText)}`);
  assert(tabsText.pages[0].title === 'Example Domain', `tabs (plain-text) wrong title: ${JSON.stringify(tabsText.pages[0])}`);
  assert(tabsText.pages[0].active === true, `tabs (plain-text) wrong active: ${JSON.stringify(tabsText.pages[0])}`);
  assert(tabsText.pages[1].url === 'https://example.com/docs', `tabs (plain-text) wrong url: ${JSON.stringify(tabsText.pages[1])}`);
  assert(tabsText.pages[1].active === false, `tabs (plain-text) second page should not be active: ${JSON.stringify(tabsText.pages[1])}`);
  listPagesPlainText = false;
  const opened = await runCli(['open', 'https://example.com/docs']);
  assert(opened.ok === true && opened.tool === 'new_page', `open failed: ${JSON.stringify(opened)}`);
  assert(opened.raw?.waitForReady === false, `open should set waitForReady=false: ${JSON.stringify(opened.raw)}`);
  assert(opened.pageContent === undefined, `open should not include implicit pageContent without explicit pageId: ${JSON.stringify(opened)}`);
  assert(!JSON.stringify(opened.raw || {}).includes('# Example Domain'), `open raw should not contain implicit snapshot fallback: ${JSON.stringify(opened.raw)}`);

  const navigated = await runCli(['--page-id', '3', 'navigate', 'https://example.com/docs']);
  assert(navigated.ok === true && navigated.tool === 'navigate_page', `navigate failed: ${JSON.stringify(navigated)}`);
  assert(
    typeof navigated.pageContent === 'string' && navigated.pageContent.includes('# Example Domain'),
    `navigate should include pageContent: ${JSON.stringify(navigated)}`,
  );

  const navigatedTimeout = await runCli(['--timeout', '12345', '--page-id', '3', 'navigate', 'https://example.com/docs']);
  assert(navigatedTimeout.ok === true && navigatedTimeout.tool === 'navigate_page', `navigate with timeout failed: ${JSON.stringify(navigatedTimeout)}`);
  assert(navigatedTimeout.raw?.timeoutMs === 12345, `navigate should pass timeoutMs=12345: ${JSON.stringify(navigatedTimeout.raw)}`);

  const closed = await runCli(['close', '2']);
  assert(closed.ok === true && closed.tool === 'close_page', `close failed: ${JSON.stringify(closed)}`);
  assert(closed.pageContent === undefined, `close should never include fallback pageContent: ${JSON.stringify(closed)}`);
  assert(!JSON.stringify(closed.raw || {}).includes('# Example Domain'), `close raw should not contain fallback snapshot content: ${JSON.stringify(closed.raw)}`);

  const focused = await runCli(['focus', '2']);
  assert(focused.ok === true && focused.tool === 'switch_to_page', `focus failed: ${JSON.stringify(focused)}`);

  const tabSelected = await runCli(['tab', 'select', '1']);
  assert(tabSelected.ok === true && tabSelected.tool === 'switch_to_page', `tab select failed: ${JSON.stringify(tabSelected)}`);

  const snapshot = await runCli(['snapshot']);
  assert(snapshot.ok === true && snapshot.tool === 'take_md_snapshot', `snapshot failed: ${JSON.stringify(snapshot)}`);
  assert(snapshot.snapshot && String(snapshot.snapshot).includes('Example Domain'), `snapshot missing content: ${JSON.stringify(snapshot)}`);

  const screenshot = await runCli(['screenshot', '--ref', '12', '--output', SCREENSHOT_PATH]);
  assert(screenshot.ok === true, `screenshot failed: ${JSON.stringify(screenshot)}`);
  assert(readFileSync(SCREENSHOT_PATH).length > 0, 'screenshot file is empty');

  const clicked = await runCli(['click', '12', '--double']);
  assert(clicked.ok === true && clicked.tool === 'click', `click failed: ${JSON.stringify(clicked)}`);
  assert(clicked.raw?.pageId === undefined, `click without --page-id should not inject pageId: ${JSON.stringify(clicked.raw)}`);

  // --page-id should inject pageId into tool calls that accept it
  const clickedWithPage = await runCli(['--page-id', '2', 'click', '12']);
  assert(clickedWithPage.ok === true && clickedWithPage.tool === 'click', `click with --page-id failed: ${JSON.stringify(clickedWithPage)}`);
  assert(clickedWithPage.raw?.pageId === 2, `--page-id 2 should inject pageId=2: ${JSON.stringify(clickedWithPage.raw)}`);

  // --pageId alias should behave the same as --page-id
  const clickedWithPageAlias = await runCli(['--pageId', '4', 'click', '12']);
  assert(clickedWithPageAlias.ok === true && clickedWithPageAlias.tool === 'click', `click with --pageId failed: ${JSON.stringify(clickedWithPageAlias)}`);
  assert(clickedWithPageAlias.raw?.pageId === 4, `--pageId 4 should inject pageId=4: ${JSON.stringify(clickedWithPageAlias.raw)}`);

  const typed = await runCli(['type', '23', 'hello world', '--submit']);
  assert(typed.ok === true && typed.tool === 'fill', `type failed: ${JSON.stringify(typed)}`);

  fillCompatibilityErrorMode = true;
  const typedFallback = await runCli(['type', '23', 'hello via fallback']);
  assert(typedFallback.ok === true && typedFallback.tool === 'type_text', `type fallback failed: ${JSON.stringify(typedFallback)}`);
  fillCompatibilityErrorMode = false;

  const pressed = await runCli(['press', 'Enter']);
  assert(pressed.ok === true && pressed.tool === 'press_key', `press failed: ${JSON.stringify(pressed)}`);

  const requests = await runCli(['requests', '--filter', 'api']);
  assert(Array.isArray(requests.requests) && requests.requests.length === 1, `requests failed: ${JSON.stringify(requests)}`);

  const responseBody = await runCli(['responsebody', 'api', '--max-chars', '20']);
  assert(String(responseBody.responseBody).includes('{"ok":true}'), `responsebody failed: ${JSON.stringify(responseBody)}`);

  const evaluated = await runCli(['evaluate', '--fn', '() => document.title']);
  assert(evaluated.ok === true && evaluated.tool === 'evaluate_script', `evaluate failed: ${JSON.stringify(evaluated)}`);

  // ── Regression tests (issues #905, #906, #907) ──────────────────────────
  // These tests exercise behaviour that was broken on main:
  //   - snapshot with --page-id must inject pageId
  //   - tool-only snapshot path must be used consistently
  //   - snapshot --format aria with --page-id must inject pageId

  // #907 / #906: snapshot --format ai (default) with --page-id should use
  // take_md_snapshot and inject pageId into the tool call.
  const snapshotWithPage = await runCli(['--page-id', '3', 'snapshot']);
  assert(snapshotWithPage.ok === true, `snapshot --page-id failed: ${JSON.stringify(snapshotWithPage)}`);
  assert(snapshotWithPage.tool === 'take_md_snapshot',
    `snapshot --page-id should use take_md_snapshot tool, got: ${snapshotWithPage.tool}`);
  assert(snapshotWithPage.raw?.pageId === 3,
    `snapshot --page-id 3 should inject pageId=3: ${JSON.stringify(snapshotWithPage.raw)}`);

  // #907: snapshot --format aria with --page-id should inject pageId into
  // the take_a11y_snapshot tool call.
  const ariaWithPage = await runCli(['--page-id', '5', 'snapshot', '--format', 'aria']);
  assert(ariaWithPage.ok === true, `aria snapshot --page-id failed: ${JSON.stringify(ariaWithPage)}`);
  assert(ariaWithPage.tool === 'take_a11y_snapshot',
    `aria snapshot should use take_a11y_snapshot, got: ${ariaWithPage.tool}`);
  assert(ariaWithPage.raw?.pageId === 5,
    `aria snapshot --page-id 5 should inject pageId=5: ${JSON.stringify(ariaWithPage.raw)}`);

  // snapshot without --page-id should still use tool-only snapshot path.
  const snapshotNoPage = await runCli(['snapshot']);
  assert(snapshotNoPage.ok === true, `snapshot (no page-id) failed: ${JSON.stringify(snapshotNoPage)}`);
  assert(snapshotNoPage.tool === 'take_md_snapshot',
    `snapshot without --page-id should use take_md_snapshot, got tool: ${snapshotNoPage.tool}`);
  assert(String(snapshotNoPage.snapshot).includes('Example Domain'),
    `snapshot without --page-id content mismatch: ${JSON.stringify(snapshotNoPage)}`);

  // #907: --timeout should control actual tool-call timeout budget.
  delayToolResultMs = 800;
  await expectCliFailure(['--timeout', '200', 'snapshot', '--format', 'aria'], /Request timed out after 200ms/);
  delayToolResultMs = 0;

  // Missing required pageId should include actionable hint.
  missingPageIdMode = true;
  const missingPageMessage = await expectCliFailure(
    ['click', '12'],
    /Hint: use `tabs` to list pages, then pass --page-id <id> to target a specific tab\./,
  );
  assert(/"mode":\s*"remote"/.test(missingPageMessage), `error payload should report remote mode: ${missingPageMessage}`);
  assert(/"profile":\s*"user"/.test(missingPageMessage), `error payload should report user profile: ${missingPageMessage}`);
  missingPageIdMode = false;

  credentialErrorMode = true;
  const redactedRelayError = await expectCliFailure(['tabs'], /\[redacted\]/);
  assert(!redactedRelayError.toLowerCase().includes(REMOTE_UUID.toLowerCase()), `CLI error leaked remote UUID: ${redactedRelayError}`);
  credentialErrorMode = false;

  credentialToolResultMode = true;
  const redactedToolResult = await expectCliFailure(['tabs'], /\[redacted\]/);
  assert(!redactedToolResult.toLowerCase().includes(REMOTE_UUID.toLowerCase()), `CLI tool_result leaked remote UUID: ${redactedToolResult}`);
  credentialToolResultMode = false;

  console.log('browser cli e2e ok');
} finally {
  if (wss) {
    await new Promise((resolve, reject) => {
      wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
  if (packedPackageDir) {
    rmSync(packedPackageDir, { recursive: true, force: true });
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
}

function handleToolCall(name, args) {
  const hasExplicitPageContext = Number.isFinite(args.pageId) || Number.isFinite(args.tabId);

  if ((name === 'navigate_page' || name === 'select_page' || name === 'close_page' || name === 'switch_to_page' || name === 'click' || name === 'fill')
    && hasExplicitPageContext
    && args.__skipPageContent === true) {
    throw new Error(`Did not expect __skipPageContent for explicit page-context tool ${name}: ${JSON.stringify(args)}`);
  }

  switch (name) {
    case 'list_pages':
      if (listPagesPlainText) {
        // Matches the real extension's executeBrowserTool() output — no
        // success field, no structured pages/tabs keys, just MCP content.
        return {
          content: [{
            type: 'text',
            text: 'Found 2 page(s):\nPage 1 [ACTIVE]: "Example Domain" - https://example.com\nPage 2: "Docs" - https://example.com/docs',
          }],
        };
      }
      return jsonResult({
        pages: [
          { id: 1, title: 'Example Domain', url: 'https://example.com', active: true },
          { id: 2, title: 'Docs', url: 'https://example.com/docs', active: false },
        ],
      });
    case 'new_page':
      return jsonResult({ pageId: 3, url: args.url ?? 'about:blank', waitForReady: args.waitForReady ?? null });
    case 'navigate_page':
      return jsonResult({ pageId: args.pageId ?? 1, url: args.url, type: args.type ?? 'url', timeoutMs: args.timeoutMs ?? null });
    case 'switch_to_page':
      return jsonResult({ pageId: args.pageId, switched: true });
    case 'select_page':
      return jsonResult({ pageId: args.pageId, selected: true });
    case 'close_page':
      return jsonResult({ pageId: args.pageId, closed: true });
    case 'take_screenshot':
      return {
        success: true,
        content: [
          { type: 'image', data: ONE_PIXEL_PNG_BASE64, mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify({ ok: true, ref: args.ref ?? null }) },
        ],
      };
    case 'click':
      return jsonResult({ clicked: args.ref ?? null, double: Boolean(args.dblClick), ...(args.pageId !== undefined ? { pageId: args.pageId } : {}) });
    case 'fill':
      return jsonResult({ ref: args.ref ?? null, value: args.value ?? '' });
    case 'type_text':
      return jsonResult({ text: args.text ?? '', submitKey: args.submitKey ?? null });
    case 'press_key':
      return jsonResult({ keys: args.keys ?? '' });
    case 'hover':
      return jsonResult({ hovered: args.ref ?? null });
    case 'drag':
      return jsonResult({ source: args.source ?? null, target: args.target ?? null });
    case 'list_network_requests':
      return jsonResult({
        requests: [
          { requestId: 'req-1', method: 'GET', url: 'https://example.com/api/health', status: 200 },
          { requestId: 'req-2', method: 'GET', url: 'https://example.com/assets/app.js', status: 200 },
        ],
      });
    case 'get_network_request':
      return jsonResult({ requestId: args.requestId, responseBody: '{"ok":true}' });
    case 'evaluate_script':
      return jsonResult({ result: 'Example Domain', args: args.args ?? [] });
    case 'wait_for':
      return jsonResult({ text: args.text ?? [], timeout: args.timeout ?? 0 });
    case 'take_md_snapshot':
      return {
        success: true,
        content: [{ type: 'text', text: '# Example Domain\n\nThis domain is for use in illustrative examples.' }],
        ...(args.pageId !== undefined ? { pageId: args.pageId } : {}),
      };
    case 'take_a11y_snapshot':
      return {
        success: true,
        content: [{ type: 'text', text: '[12] More information (a11y)\n[23] Search input' }],
        ...(args.pageId !== undefined ? { pageId: args.pageId } : {}),
      };
    default:
      return jsonResult({ tool: name, args });
  }
}

function jsonResult(payload) {
  return {
    success: true,
    ...payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function tool(name, properties) {
  return {
    name,
    description: `Fake ${name} tool`,
    inputSchema: {
      type: 'object',
      properties,
    },
  };
}

async function runCli(args, options = {}) {
  const invocation = getCliInvocation();
  const remoteArgs = options.remoteFromEnv
    ? []
    : ['--remote', options.remoteValue ?? `${RELAY_URL}/${REMOTE_UUID}`];
  const child = spawn(
    invocation.command,
    [
      ...invocation.args,
      ...remoteArgs,
      '--browser-profile',
      'user',
      '--json',
      ...args,
    ],
    {
      cwd: PACKAGE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}`));
    }, 10_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`CLI exited ${exitCode}: ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`);
  }

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`CLI did not emit JSON for ${args.join(' ')}: ${stdout}\nstderr=${stderr}\n${error}`);
  }
}

async function expectCliFailure(args, pattern) {
  try {
    await runCli(args);
    throw new Error(`Expected command to fail but it succeeded: ${args.join(' ')}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), `Expected failure matching ${pattern}, got:\n${message}`);
    return message;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function getCliInvocation() {
  if (cliInvocation) {
    return cliInvocation;
  }

  if (!['local', 'pack', 'npm'].includes(E2E_BROWSER_CLI_SOURCE)) {
    throw new Error(
      `Invalid E2E_BROWSER_CLI_SOURCE="${E2E_BROWSER_CLI_SOURCE}". Expected one of: local, pack, npm`,
    );
  }

  if (E2E_BROWSER_CLI_SOURCE === 'local') {
    cliInvocation = {
      source: 'local',
      command: process.execPath,
      args: [LOCAL_BROWSER_CLI],
    };
    return cliInvocation;
  }

  const packageSpec = E2E_BROWSER_CLI_SOURCE === 'pack'
    ? resolvePackedPackageSpec()
    : '@vibebrowser/cli@latest';

  cliInvocation = {
    source: E2E_BROWSER_CLI_SOURCE,
    command: NPX_BIN,
    args: ['-y', packageSpec],
  };
  return cliInvocation;
}

function resolvePackedPackageSpec() {
  if (E2E_BROWSER_CLI_PACKAGE) {
    return normalizePackageSpec(E2E_BROWSER_CLI_PACKAGE);
  }

  if (!existsSync(LOCAL_BROWSER_CLI)) {
    throw new Error(`Local browser CLI not found at ${LOCAL_BROWSER_CLI}. Build first with: npm run build`);
  }

  packedPackageDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-browser-cli-pack-'));
  const result = spawnSync(
    NPM_BIN,
    ['pack', '--json', '--pack-destination', packedPackageDir],
    {
      cwd: CLI_PACKAGE_ROOT,
      encoding: 'utf-8',
    },
  );

  if (result.status !== 0) {
    throw new Error(`npm pack failed with status ${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Failed to parse npm pack output: ${result.stdout}\n${error}`);
  }

  const filename = Array.isArray(payload) ? payload[0]?.filename : null;
  if (!filename) {
    throw new Error(`npm pack did not report a filename: ${result.stdout}`);
  }

  return `file:${join(packedPackageDir, filename)}`;
}

function normalizePackageSpec(spec) {
  return spec.endsWith('.tgz') || spec.startsWith('.') || spec.startsWith('/')
    ? resolve(process.cwd(), spec)
    : spec;
}
