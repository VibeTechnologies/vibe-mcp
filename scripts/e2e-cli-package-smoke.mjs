#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

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
const EXPECTED_TITLE = 'Packed CLI WSS roundtrip';
const TOOLS = [{
  name: 'list_pages',
  description: 'List pages in the deterministic package smoke harness',
  inputSchema: { type: 'object', properties: {} },
}];

function cleanup() {
  if (!KEEP_ARTIFACTS) rmSync(WORK_ROOT, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`Package setup command failed (${result.status}): ${command}`);
  }
  return result;
}

function parsePackFilename(stdout) {
  const payload = JSON.parse(stdout);
  const filename = Array.isArray(payload) ? payload[0]?.filename : undefined;
  if (!filename) throw new Error('npm pack --json did not report a filename');
  return filename;
}

async function runCli(env) {
  const child = spawn(CLI_BIN, ['--json', 'tabs'], {
    cwd: INSTALL_PROJECT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((resolveStatus, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Packed CLI roundtrip timed out'));
    }, 10_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveStatus(code ?? 1);
    });
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

  cleanup();
  mkdirSync(PACK_DEST, { recursive: true });
  mkdirSync(INSTALL_PROJECT, { recursive: true });
  const packResult = run(NPM_BIN, ['pack', '--json', '--pack-destination', PACK_DEST], CLI_PACKAGE_ROOT);
  const tarballPath = resolve(PACK_DEST, parsePackFilename(packResult.stdout));
  run(NPM_BIN, ['init', '-y'], INSTALL_PROJECT);
  run(NPM_BIN, ['install', tarballPath], INSTALL_PROJECT);
  console.log('CLI_PACK_WSS_GATE:INSTALL_OK');

  const server = createServer({ key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) });
  const wss = new WebSocketServer({ server });
  let observedListTools = false;
  let observedCallTool = false;
  wss.on('connection', (ws, request) => {
    if (request.url !== `/relay/nested/${SESSION_ID}`) {
      ws.close();
      return;
    }
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'list_tools') {
        observedListTools = true;
        ws.send(JSON.stringify({ type: 'tools_list', requestId: message.requestId, data: TOOLS }));
      } else if (message.type === 'call_tool') {
        if (message.data?.name !== 'list_pages') throw new Error('Packed CLI called an unexpected tool');
        observedCallTool = true;
        const payload = { pages: [{ id: 7, title: EXPECTED_TITLE, url: 'https://example.test/', active: true }] };
        ws.send(JSON.stringify({
          type: 'tool_result',
          requestId: message.requestId,
          data: { success: true, ...payload, content: [{ type: 'text', text: JSON.stringify(payload) }] },
        }));
      }
    });
  });

  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TLS harness did not bind a TCP port');
    const result = await runCli({
      ...process.env,
      NODE_EXTRA_CA_CERTS: CERT_PATH,
      VIBE_REMOTE_URL: `wss://127.0.0.1:${address.port}/relay/nested/${SESSION_ID}`,
    });
    if (!observedListTools) throw new Error('Harness did not observe list_tools discovery');
    if (!observedCallTool) throw new Error('Harness did not observe call_tool');
    if (result.pages?.[0]?.title !== EXPECTED_TITLE) throw new Error('Packed CLI output did not contain the exact harness payload');
    if (result.raw?.pages?.[0]?.title !== EXPECTED_TITLE) throw new Error('Packed CLI raw result did not contain the exact harness payload');
    console.log('CLI_PACK_WSS_GATE:ROUNDTRIP_OK');
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolveClose) => wss.close(() => server.close(resolveClose)));
  }
  console.log('CLI_PACK_WSS_GATE:PASS');
}

try {
  await main();
  cleanup();
} catch (error) {
  console.error('CLI_PACK_WSS_GATE:FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  if (KEEP_ARTIFACTS) console.error(`CLI_PACK_WSS_GATE:ARTIFACTS:${WORK_ROOT}`);
  else cleanup();
  process.exit(1);
}
