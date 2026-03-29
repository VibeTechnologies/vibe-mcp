#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HOST = '127.0.0.1';
const REMOTE_UUID = 'browser-cli-test-uuid';
const RELAY_PORT = await findFreePort();
const RELAY_URL = `ws://${HOST}:${RELAY_PORT}`;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const LOCAL_BROWSER_CLI = resolve(PACKAGE_ROOT, 'dist', 'browser-main.js');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const E2E_BROWSER_CLI_SOURCE = (process.env.E2E_BROWSER_CLI_SOURCE || 'local').toLowerCase();
const E2E_BROWSER_CLI_PACKAGE = process.env.E2E_BROWSER_CLI_PACKAGE;
const TEST_DIR = mkdtempSync(join(tmpdir(), 'vibe-mcp-browser-cli-'));
const SCREENSHOT_PATH = join(TEST_DIR, 'shot.png');
const UPLOAD_PATH = join(TEST_DIR, 'upload.txt');
let packedPackageDir = null;
let cliInvocation = null;

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W6n8AAAAASUVORK5CYII=';

// When true, list_pages returns plain-text format (like the real extension does)
let listPagesPlainText = false;

const TOOLS = [
  tool('list_pages', {}),
  tool('new_page', { url: { type: 'string' } }),
  tool('navigate_page', { pageId: { type: 'number' }, url: { type: 'string' }, type: { type: 'string' } }),
  tool('select_page', { pageId: { type: 'number' } }),
  tool('close_page', { pageId: { type: 'number' } }),
  tool('take_screenshot', {
    fullPage: { type: 'boolean' },
    ref: { type: 'string' },
    detail: { type: 'string' },
    grayscale: { type: 'boolean' },
  }),
  tool('click', { ref: { type: 'string' }, dblClick: { type: 'boolean' } }),
  tool('fill', { ref: { type: 'string' }, value: { type: 'string' } }),
  tool('press_key', { keys: { type: 'string' } }),
  tool('hover', { ref: { type: 'string' } }),
  tool('drag', { source: { type: 'string' }, target: { type: 'string' } }),
  tool('list_network_requests', { limit: { type: 'number' } }),
  tool('get_network_request', { requestId: { type: 'string' } }),
  tool('evaluate_script', { function: { type: 'string' }, args: { type: 'array' } }),
  tool('performance_start_trace', { reload: { type: 'boolean' }, filePath: { type: 'string' } }),
  tool('performance_stop_trace', { filePath: { type: 'string' } }),
  tool('upload_file', { filePath: { type: 'string' }, ref: { type: 'string' } }),
  tool('handle_dialog', { action: { type: 'string' }, promptText: { type: 'string' } }),
  tool('wait_for', { text: { type: 'array' }, timeout: { type: 'number' } }),
  tool('pdf', {}),
];

writeFileSync(UPLOAD_PATH, 'upload payload');

let wss;

try {
  wss = new WebSocketServer({ host: HOST, port: RELAY_PORT });
  wss.on('connection', (ws, req) => {
    if (req.url !== `/${REMOTE_UUID}`) {
      ws.close();
      return;
    }

    ws.send(JSON.stringify({ type: 'extension_status', connected: true }));

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

      if (message.type === 'get_snapshot') {
        ws.send(JSON.stringify({
          type: 'snapshot',
          requestId: message.requestId,
          data: {
            url: 'https://example.com',
            title: 'Example Domain',
            snapshot: '[12] More information\n[23] Search input',
          },
        }));
        return;
      }

      if (message.type === 'call_tool') {
        ws.send(JSON.stringify({
          type: 'tool_result',
          requestId: message.requestId,
          data: handleToolCall(message.data?.name, message.data?.arguments ?? {}),
        }));
      }
    });
  });

  const status = await runCli(['status']);
  assert(status.ok === true, `status failed: ${JSON.stringify(status)}`);
  assert(status.extensionConnected === true, `expected extension connected: ${JSON.stringify(status)}`);
  assert(Number(status.toolCount) >= 10, `expected toolCount >= 10: ${JSON.stringify(status)}`);

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

  const selected = await runCli(['tab', 'select', '2']);
  assert(selected.ok === true && selected.tool === 'select_page', `tab select failed: ${JSON.stringify(selected)}`);

  const closed = await runCli(['close', '2']);
  assert(closed.ok === true && closed.tool === 'close_page', `close failed: ${JSON.stringify(closed)}`);

  const snapshot = await runCli(['snapshot']);
  assert(snapshot.snapshot && String(snapshot.snapshot).includes('More information'), `snapshot missing content: ${JSON.stringify(snapshot)}`);

  const screenshot = await runCli(['screenshot', '--ref', '12', '--output', SCREENSHOT_PATH]);
  assert(screenshot.ok === true, `screenshot failed: ${JSON.stringify(screenshot)}`);
  assert(readFileSync(SCREENSHOT_PATH).length > 0, 'screenshot file is empty');

  const clicked = await runCli(['click', '12', '--double']);
  assert(clicked.ok === true && clicked.tool === 'click', `click failed: ${JSON.stringify(clicked)}`);

  const typed = await runCli(['type', '23', 'hello world', '--submit']);
  assert(typed.ok === true && typed.tool === 'fill', `type failed: ${JSON.stringify(typed)}`);

  const pressed = await runCli(['press', 'Enter']);
  assert(pressed.ok === true && pressed.tool === 'press_key', `press failed: ${JSON.stringify(pressed)}`);

  const requests = await runCli(['requests', '--filter', 'api']);
  assert(Array.isArray(requests.requests) && requests.requests.length === 1, `requests failed: ${JSON.stringify(requests)}`);

  const responseBody = await runCli(['responsebody', 'api', '--max-chars', '20']);
  assert(String(responseBody.responseBody).includes('{"ok":true}'), `responsebody failed: ${JSON.stringify(responseBody)}`);

  const evaluated = await runCli(['evaluate', '--fn', '() => document.title']);
  assert(evaluated.ok === true && evaluated.tool === 'evaluate_script', `evaluate failed: ${JSON.stringify(evaluated)}`);

  const uploaded = await runCli(['upload', UPLOAD_PATH, '--ref', '44']);
  assert(uploaded.ok === true && uploaded.tool === 'upload_file', `upload failed: ${JSON.stringify(uploaded)}`);

  const traceStart = await runCli(['trace', 'start', '--reload']);
  assert(traceStart.ok === true && traceStart.tool === 'performance_start_trace', `trace start failed: ${JSON.stringify(traceStart)}`);

  const traceStop = await runCli(['trace', 'stop']);
  assert(traceStop.ok === true && traceStop.tool === 'performance_stop_trace', `trace stop failed: ${JSON.stringify(traceStop)}`);

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
  switch (name) {
    case 'list_pages':
      if (listPagesPlainText) {
        // Matches the real ListPagesTool.call() output format
        return {
          success: true,
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
      return jsonResult({ pageId: 3, url: args.url ?? 'about:blank' });
    case 'navigate_page':
      return jsonResult({ pageId: args.pageId ?? 1, url: args.url, type: args.type ?? 'url' });
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
      return jsonResult({ clicked: args.ref ?? null, double: Boolean(args.dblClick) });
    case 'fill':
      return jsonResult({ ref: args.ref ?? null, value: args.value ?? '' });
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
    case 'performance_start_trace':
      return jsonResult({ started: true, reload: Boolean(args.reload) });
    case 'performance_stop_trace':
      return jsonResult({ stopped: true, trace: 'TRACE:/tmp/fake-trace.json' });
    case 'upload_file':
      return jsonResult({ uploaded: resolve(String(args.filePath)), ref: args.ref ?? null });
    case 'handle_dialog':
      return jsonResult({ action: args.action, promptText: args.promptText ?? null });
    case 'wait_for':
      return jsonResult({ text: args.text ?? [], timeout: args.timeout ?? 0 });
    case 'pdf':
      return jsonResult({ ok: true });
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

async function runCli(args) {
  const invocation = getCliInvocation();
  const child = spawn(
    invocation.command,
    [
      ...invocation.args,
      '--remote',
      REMOTE_UUID,
      '--relay-url',
      RELAY_URL,
      '--browser-profile',
      'user',
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
    : '@vibebrowser/mcp@latest';

  cliInvocation = {
    source: E2E_BROWSER_CLI_SOURCE,
    command: NPX_BIN,
    args: ['-y', '--package', packageSpec, 'vibebrowser-cli'],
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
      cwd: PACKAGE_ROOT,
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

  return join(packedPackageDir, filename);
}

function normalizePackageSpec(spec) {
  return spec.endsWith('.tgz') || spec.startsWith('.') || spec.startsWith('/')
    ? resolve(process.cwd(), spec)
    : spec;
}
