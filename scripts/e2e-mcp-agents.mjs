#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RELAY_HOST = '127.0.0.1';
const TIMEOUT_MS = 120_000;
const REAL_TASK = process.env.E2E_TASK;
const TOOLS_TIMEOUT_MS = 60_000;
const DEBUG_E2E = process.env.E2E_DEBUG === '1';
const CODEX_MODEL = process.env.E2E_CODEX_MODEL || 'gpt-5';
const CODEX_REASONING_EFFORT = process.env.E2E_CODEX_REASONING_EFFORT
  || (/^gpt-5\.4/i.test(CODEX_MODEL) ? 'medium' : 'low');
const CODEX_TIMEOUT_MS = Number(process.env.E2E_CODEX_TIMEOUT_MS) || 480_000;
const ENABLE_TEST_BROWSER = /^(1|true|yes)$/i.test(process.env.E2E_TEST_BROWSER || '');
const configuredAgentPort = getConfiguredPort('VIBE_MCP_TEST_AGENT_PORT', 'E2E_AGENT_PORT');
const configuredExtensionPort = getConfiguredPort('VIBE_MCP_TEST_EXTENSION_PORT', 'E2E_EXTENSION_PORT');
const RESERVED_PORTS = new Set();
const TEST_AGENT_PORT = configuredAgentPort ?? await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(TEST_AGENT_PORT);
const TEST_EXTENSION_PORT = configuredExtensionPort ?? await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(TEST_EXTENSION_PORT);
const TEST_BROWSER_CDP_PORT = getConfiguredPort('E2E_TEST_BROWSER_CDP_PORT') ?? await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(TEST_BROWSER_CDP_PORT);
const RELAY_STATE_DIR = process.env.E2E_RELAY_STATE_DIR || join(tmpdir(), `vibe-mcp-e2e-relay-${process.pid}`);
const RELAY_PID_FILE = join(RELAY_STATE_DIR, 'relay.pid');
const EXTENSION_CONNECT_TIMEOUT_MS = Number(process.env.E2E_EXTENSION_TIMEOUT_MS)
  || 120_000;
// Managed Chrome bootstrap must be explicit opt-in.
// Default behavior is to use an already running browser/extension session.
const ENABLE_MANAGED_CHROME = /^(1|true|yes)$/i.test(process.env.E2E_MANAGED_CHROME || '');
const MANAGED_CHROME_APP = process.env.E2E_MANAGED_CHROME_APP || 'Google Chrome Dev';
const MANAGED_CHROME_SOURCE_PROFILE = process.env.E2E_MANAGED_CHROME_PROFILE || 'Default';
const MANAGED_CHROME_USER_DATA = process.env.E2E_MANAGED_CHROME_USER_DATA
  || join(homedir(), 'Library/Application Support/Google/Chrome Dev');
const MANAGED_CHROME_CDP_PORT = Number(process.env.E2E_MANAGED_CHROME_CDP_PORT) || 9223;
const E2E_MCP_SOURCE = (process.env.E2E_MCP_SOURCE || 'local').toLowerCase();
const E2E_MCP_PACKAGE = process.env.E2E_MCP_PACKAGE;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const VIBE_REPO_ROOT = process.env.E2E_VIBE_REPO_ROOT
  ? resolve(process.cwd(), process.env.E2E_VIBE_REPO_ROOT)
  : (
      existsSync(resolve(process.cwd(), '..', 'vibe'))
        ? resolve(process.cwd(), '..', 'vibe')
        : resolve(SCRIPT_DIR, '..', '..', 'vibe')
    );
const DEFAULT_TEST_EXTENSION_PATH = resolve(VIBE_REPO_ROOT, 'dist', 'extension', 'dev');
const TEST_EXTENSION_PATH = process.env.E2E_TEST_EXTENSION_PATH
  ? resolve(process.cwd(), process.env.E2E_TEST_EXTENSION_PATH)
  : DEFAULT_TEST_EXTENSION_PATH;
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const LOCAL_MCP_CLI = resolve(SCRIPT_DIR, '..', 'dist', 'cli.js');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';
let packedPackageDir = null;
let packedPackageSpec = null;

if (ENABLE_TEST_BROWSER && ENABLE_MANAGED_CHROME) {
  throw new Error('E2E_TEST_BROWSER and E2E_MANAGED_CHROME are mutually exclusive.');
}

const stripAnsi = (input) => input.replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

function getConfiguredPort(...names) {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) continue;
    const port = Number.parseInt(raw, 10);
    if (Number.isFinite(port) && port > 0 && port <= 65535) {
      return port;
    }
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return null;
}

function findFreePort(exclude) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, RELAY_HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port || exclude.has(port)) {
          findFreePort(exclude).then(resolve, reject);
          return;
        }
        resolve(port);
      });
    });
  });
}

function getE2EMcpCommand() {
  if (!['local', 'pack', 'npm'].includes(E2E_MCP_SOURCE)) {
    throw new Error(`Invalid E2E_MCP_SOURCE="${E2E_MCP_SOURCE}". Expected one of: local, pack, npm`);
  }

  if (E2E_MCP_SOURCE === 'local') {
    if (!existsSync(LOCAL_MCP_CLI)) {
      throw new Error(`Local MCP CLI not found at ${LOCAL_MCP_CLI}. Build first with: npm run build`);
    }
    const args = [LOCAL_MCP_CLI];
    args.push('--port', String(TEST_AGENT_PORT));
    if (DEBUG_E2E) args.push('--debug');
    return {
      source: 'local',
      command: process.execPath,
      args,
    };
  }

  const packageSpec = E2E_MCP_SOURCE === 'pack'
    ? resolvePackedPackageSpec()
    : '@vibebrowser/mcp@latest';
  const args = ['-y', '--package', packageSpec, 'vibebrowser-mcp', '--port', String(TEST_AGENT_PORT)];
  if (DEBUG_E2E) args.push('--debug');
  return {
    source: E2E_MCP_SOURCE,
    command: NPX_BIN,
    args,
  };
}

function resolvePackedPackageSpec() {
  if (E2E_MCP_PACKAGE) {
    return normalizePackageSpec(E2E_MCP_PACKAGE);
  }

  if (!existsSync(LOCAL_MCP_CLI)) {
    throw new Error(`Local MCP CLI not found at ${LOCAL_MCP_CLI}. Build first with: npm run build`);
  }

  if (!packedPackageSpec) {
    packedPackageDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-pack-e2e-'));
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

    packedPackageSpec = join(packedPackageDir, filename);
  }

  return packedPackageSpec;
}

function normalizePackageSpec(spec) {
  return spec.endsWith('.tgz') || spec.startsWith('.') || spec.startsWith('/')
    ? resolve(process.cwd(), spec)
    : spec;
}

function assertSafeCliValue(value, label) {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`Unsafe ${label}: contains control characters`);
  }
}

function validateMcpCommandConfig(mcpCmd) {
  assertSafeCliValue(String(mcpCmd.command || ''), 'MCP command');
  for (const arg of mcpCmd.args || []) {
    assertSafeCliValue(String(arg), 'MCP arg');
  }
}

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const stream = opts.stream === true;
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout += text;
    if (stream) process.stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderr += text;
    if (stream) process.stderr.write(text);
  });
  child.on('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  });
});

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} from ${url}: ${body || response.statusText}`);
  }
  return response.json();
}

async function waitForCdpReady(port, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const version = await fetchJson(`http://${RELAY_HOST}:${port}/json/version`);
      if (version?.webSocketDebuggerUrl) return;
    } catch {
      // keep retrying until timeout
    }
    await delay(300);
  }
  throw new Error(`Managed Chrome CDP endpoint did not become ready on port ${port}`);
}

function resolveChromeForTestingExecutable() {
  if (process.env.E2E_TEST_BROWSER_EXECUTABLE) {
    const explicitPath = process.env.E2E_TEST_BROWSER_EXECUTABLE;
    if (!existsSync(explicitPath)) {
      throw new Error(`E2E_TEST_BROWSER_EXECUTABLE does not exist: ${explicitPath}`);
    }
    return explicitPath;
  }

  const probes = [
    {
      cwd: VIBE_REPO_ROOT,
      code: 'const p=require("puppeteer"); process.stdout.write(p.executablePath())',
    },
    {
      cwd: VIBE_REPO_ROOT,
      code: 'const { chromium }=require("playwright"); process.stdout.write(chromium.executablePath())',
    },
  ];

  for (const probe of probes) {
    const result = spawnSync(process.execPath, ['-e', probe.code], {
      cwd: probe.cwd,
      encoding: 'utf-8',
    });
    const executablePath = result.status === 0 ? result.stdout.trim() : '';
    if (executablePath && existsSync(executablePath)) {
      return executablePath;
    }
  }

  throw new Error(
    `Could not resolve a Chrome for Testing executable. Install Puppeteer or Playwright in ${VIBE_REPO_ROOT}, or set E2E_TEST_BROWSER_EXECUTABLE.`
  );
}

function getTestExtensionId(extensionPath) {
  if (process.env.E2E_EXTENSION_ID) {
    return process.env.E2E_EXTENSION_ID;
  }

  const manifestPath = join(extensionPath, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Extension manifest not found at ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (!manifest?.key) {
    throw new Error(`Extension manifest at ${manifestPath} does not include a key, so the extension ID cannot be derived deterministically.`);
  }

  const digest = createHash('sha256')
    .update(Buffer.from(manifest.key, 'base64'))
    .digest()
    .subarray(0, 16);
  const alphabet = 'abcdefghijklmnop';
  let extensionId = '';
  for (const byte of digest) {
    extensionId += alphabet[(byte >> 4) & 0x0f];
    extensionId += alphabet[byte & 0x0f];
  }
  return extensionId;
}

function pickVibeExtensionId(securePreferencesPath) {
  if (!existsSync(securePreferencesPath)) return null;
  try {
    const securePrefs = JSON.parse(readFileSync(securePreferencesPath, 'utf-8'));
    const settings = securePrefs?.extensions?.settings || {};
    const entries = Object.entries(settings);

    const explicitId = process.env.E2E_EXTENSION_ID;
    if (explicitId && settings[explicitId]) return explicitId;

    const vibeEntry = entries.find(([, value]) => {
      const location = Number(value?.location);
      const manifestName = String(value?.manifest?.name || '');
      const extensionPath = String(value?.path || '');
      return location === 4
        && (/vibe|vibebrowser/i.test(extensionPath) || /vibe\s*ai\s*browser|vibe\s*browser/i.test(manifestName));
    });
    return vibeEntry?.[0] || null;
  } catch {
    return null;
  }
}

function copyProfileArtifacts({ sourceUserDataDir, sourceProfile, targetUserDataDir }) {
  mkdirSync(join(targetUserDataDir, sourceProfile), { recursive: true });

  const filesToCopy = [
    ['Local State', 'Local State'],
    [join(sourceProfile, 'Preferences'), join(sourceProfile, 'Preferences')],
    [join(sourceProfile, 'Secure Preferences'), join(sourceProfile, 'Secure Preferences')],
  ];
  for (const [fromRel, toRel] of filesToCopy) {
    const fromPath = join(sourceUserDataDir, fromRel);
    const toPath = join(targetUserDataDir, toRel);
    if (!existsSync(fromPath)) {
      if (DEBUG_E2E) {
        console.error(`[e2e] profile artifact missing, skipping: ${fromPath}`);
      }
      continue;
    }
    cpSync(fromPath, toPath, { force: true });
  }

  const localExtensionSettings = join(sourceUserDataDir, sourceProfile, 'Local Extension Settings');
  const targetLocalExtensionSettings = join(targetUserDataDir, sourceProfile, 'Local Extension Settings');
  if (existsSync(localExtensionSettings)) {
    cpSync(localExtensionSettings, targetLocalExtensionSettings, { recursive: true, force: true });
  }
}

function pruneSecurePreferencesToSingleVibeExtension(securePreferencesPath, keepExtensionId) {
  if (!existsSync(securePreferencesPath)) return;
  try {
    const securePrefs = JSON.parse(readFileSync(securePreferencesPath, 'utf-8'));
    const settings = securePrefs?.extensions?.settings;
    if (!settings || typeof settings !== 'object') return;

    for (const [id, value] of Object.entries(settings)) {
      if (id === keepExtensionId) continue;
      const location = Number(value?.location);
      const extensionPath = String(value?.path || '');
      const manifestName = String(value?.manifest?.name || '');
      const isVibeLike = location === 4
        && (/vibe|vibebrowser/i.test(extensionPath) || /vibe\s*ai\s*browser|vibe\s*browser/i.test(manifestName));
      if (isVibeLike) {
        delete settings[id];
      }
    }

    securePrefs.extensions.settings = settings;
    // Preserve single-line JSON format used by Chrome preference files.
    // Write atomically to avoid profile corruption on interruption.
    const tmpPath = `${securePreferencesPath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(securePrefs));
    renameSync(tmpPath, securePreferencesPath);
  } catch {
    // best effort sanitization only
  }
}

async function cdpEvaluate(wsUrl, expression, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new Error('CDP evaluate timed out'));
    }, timeoutMs);

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      if (err) reject(err);
      else resolve(value);
    };

    const send = (method, params = {}) => new Promise((sendResolve, sendReject) => {
      const requestId = ++id;
      pending.set(requestId, { sendResolve, sendReject });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!message.id || !pending.has(message.id)) return;
      const { sendResolve } = pending.get(message.id);
      pending.delete(message.id);
      sendResolve(message);
    });

    ws.on('error', (error) => finish(error));

    ws.on('open', async () => {
      try {
        await send('Runtime.enable');
        const response = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        const exception = response?.result?.exceptionDetails;
        if (exception) {
          throw new Error(`CDP runtime exception: ${exception.text || 'unknown error'}`);
        }
        finish(null, response?.result?.result?.value);
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function openExtensionHomeTarget({ cdpPort, extensionId }) {
  const targetUrl = `chrome-extension://${extensionId}/home.html`;
  const target = await fetchJson(
    `http://${RELAY_HOST}:${cdpPort}/json/new?${encodeURIComponent(targetUrl)}`,
    { method: 'PUT' }
  );
  if (!target?.webSocketDebuggerUrl) {
    throw new Error('Managed Chrome did not return a debuggable extension page target');
  }
  return target;
}

async function sendExtensionRuntimeMessageViaPage({ pageWsUrl, message }) {
  const expression = `new Promise((resolve) => {
    chrome.runtime.sendMessage(${JSON.stringify(message)}, (response) => {
      resolve({ response, error: chrome.runtime.lastError?.message || null });
    });
  })`;
  const result = await cdpEvaluate(pageWsUrl, expression);
  if (result?.error) {
    throw new Error(`Extension runtime message failed: ${result.error}`);
  }
  return result?.response;
}

async function enableExtensionKeepaliveViaPage({ pageWsUrl }) {
  const result = await cdpEvaluate(pageWsUrl, `(() => {
    try {
      if (!globalThis.__vibeMcpKeepalivePort) {
        const port = chrome.runtime.connect({ name: 'keepalive' });
        globalThis.__vibeMcpKeepalivePort = port;
        globalThis.__vibeMcpKeepaliveTimer = setInterval(() => {
          try {
            port.postMessage({ type: 'ping' });
          } catch {}
        }, 20000);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  })()`);

  if (!result?.ok) {
    throw new Error(`Failed to enable extension keepalive: ${result?.error || 'unknown error'}`);
  }
}

async function bootstrapManagedChromeForRealE2E() {
  if (!ENABLE_MANAGED_CHROME) return null;

  const sourceSecurePrefs = join(
    MANAGED_CHROME_USER_DATA,
    MANAGED_CHROME_SOURCE_PROFILE,
    'Secure Preferences'
  );
  const sourceExtensionId = process.env.E2E_EXTENSION_ID || pickVibeExtensionId(sourceSecurePrefs);
  if (!sourceExtensionId) {
    throw new Error(
      `Could not determine Vibe extension ID from ${sourceSecurePrefs}. Set E2E_EXTENSION_ID to continue.`
    );
  }

  let tempUserDataDir = null;
  try {
    tempUserDataDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-managed-chrome-'));
    copyProfileArtifacts({
      sourceUserDataDir: MANAGED_CHROME_USER_DATA,
      sourceProfile: MANAGED_CHROME_SOURCE_PROFILE,
      targetUserDataDir: tempUserDataDir,
    });
    pruneSecurePreferencesToSingleVibeExtension(
      join(tempUserDataDir, MANAGED_CHROME_SOURCE_PROFILE, 'Secure Preferences'),
      sourceExtensionId
    );

    await run('open', [
      '-na',
      MANAGED_CHROME_APP,
      '--args',
      `--remote-debugging-port=${MANAGED_CHROME_CDP_PORT}`,
      `--user-data-dir=${tempUserDataDir}`,
      `--profile-directory=${MANAGED_CHROME_SOURCE_PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
      '--window-size=1920,1080',
      'about:blank',
    ], { timeoutMs: 20_000 });

    await waitForCdpReady(MANAGED_CHROME_CDP_PORT, 30_000);

    const extensionPage = await openExtensionHomeTarget({
      cdpPort: MANAGED_CHROME_CDP_PORT,
      extensionId: sourceExtensionId,
    });

    const pageWsUrl = extensionPage.webSocketDebuggerUrl;
    await enableExtensionKeepaliveViaPage({ pageWsUrl });
    await delay(2_000);
    // Hard reset MCP external client state to avoid stale reconnect timers.
    await sendExtensionRuntimeMessageViaPage({
      pageWsUrl,
      message: { type: 'MCP_EXTERNAL:DISCONNECT' },
    }).catch(() => null);
    await delay(500);
      await sendExtensionRuntimeMessageViaPage({
        pageWsUrl,
        message: { type: 'MCP_EXTERNAL:CONNECT', port: TEST_EXTENSION_PORT, mode: 'local' },
      });
    await delay(500);
    const connectResult = await sendExtensionRuntimeMessageViaPage({
      pageWsUrl,
      message: { type: 'MCP_EXTERNAL:GET_STATUS' },
    }).catch(() => null);
    if (DEBUG_E2E) {
      console.error(`[e2e] managed extension connect result: ${JSON.stringify(connectResult)}`);
    }

    return {
      cleanup: async () => {
        await stopBrowserByUserDataDir(tempUserDataDir);
        await delay(300);
        rmSync(tempUserDataDir, { recursive: true, force: true });
      },
      poke: async () => {
        try {
          await sendExtensionRuntimeMessageViaPage({
            pageWsUrl,
            message: { type: 'MCP_EXTERNAL:GET_STATUS' },
          });
        } catch {
          // best effort keepalive only
        }
      },
    };
  } catch (error) {
    if (tempUserDataDir) {
      await stopBrowserByUserDataDir(tempUserDataDir).catch(() => {});
      rmSync(tempUserDataDir, { recursive: true, force: true });
    }
    throw error;
  }
}

async function bootstrapTestBrowserWithExtension() {
  if (!ENABLE_TEST_BROWSER) return null;
  if (!existsSync(TEST_EXTENSION_PATH)) {
    throw new Error(`Test extension path does not exist: ${TEST_EXTENSION_PATH}`);
  }

  const executablePath = resolveChromeForTestingExecutable();
  const extensionId = getTestExtensionId(TEST_EXTENSION_PATH);
  const tempUserDataDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-test-browser-'));

  const launchArgs = [
    `--remote-debugging-port=${TEST_BROWSER_CDP_PORT}`,
    `--user-data-dir=${tempUserDataDir}`,
    `--disable-extensions-except=${TEST_EXTENSION_PATH}`,
    `--load-extension=${TEST_EXTENSION_PATH}`,
    '--no-first-run',
    '--disable-default-apps',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-setuid-sandbox',
    '--window-size=1920,1080',
    '--window-position=-2400,-2400',
    'about:blank',
  ];

  const browserProcess = spawn(executablePath, launchArgs, {
    stdio: DEBUG_E2E ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });

  if (!DEBUG_E2E) {
    browserProcess.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.trim()) process.stderr.write(text);
    });
  }

  try {
    await waitForCdpReady(TEST_BROWSER_CDP_PORT, 30_000);
    const extensionPage = await openExtensionHomeTarget({
      cdpPort: TEST_BROWSER_CDP_PORT,
      extensionId,
    });

    const pageWsUrl = extensionPage.webSocketDebuggerUrl;
    await enableExtensionKeepaliveViaPage({ pageWsUrl });
    await delay(2_000);
    await sendExtensionRuntimeMessageViaPage({
      pageWsUrl,
      message: { type: 'MCP_EXTERNAL:DISCONNECT' },
    }).catch(() => null);
    await delay(500);
    await sendExtensionRuntimeMessageViaPage({
      pageWsUrl,
      message: { type: 'MCP_EXTERNAL:CONNECT', port: TEST_EXTENSION_PORT, mode: 'local' },
    });
    await delay(500);

    return {
      cleanup: async () => {
        try {
          browserProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
        await stopBrowserByUserDataDir(tempUserDataDir);
        await delay(300);
        rmSync(tempUserDataDir, { recursive: true, force: true });
      },
      poke: async () => {
        try {
          await sendExtensionRuntimeMessageViaPage({
            pageWsUrl,
            message: { type: 'MCP_EXTERNAL:GET_STATUS' },
          });
        } catch {
          // best effort keepalive only
        }
      },
    };
  } catch (error) {
    try {
      browserProcess.kill('SIGTERM');
    } catch {
      // ignore
    }
    await stopBrowserByUserDataDir(tempUserDataDir).catch(() => {});
    rmSync(tempUserDataDir, { recursive: true, force: true });
    throw error;
  }
}

const probePort = (port, timeoutMs = 400) => new Promise((resolve) => {
  const socket = net.createConnection({ host: RELAY_HOST, port });
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(value);
  };
  socket.setTimeout(timeoutMs);
  socket.on('connect', () => finish(true));
  socket.on('timeout', () => finish(false));
  socket.on('error', () => finish(false));
});

async function stopExistingRelay() {
  if (!existsSync(RELAY_PID_FILE)) {
    return;
  }
  const pid = parseInt(readFileSync(RELAY_PID_FILE, 'utf-8').trim(), 10);
  if (!Number.isFinite(pid)) {
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    const extensionOpen = await probePort(TEST_EXTENSION_PORT);
    const agentOpen = await probePort(TEST_AGENT_PORT);
    if (!extensionOpen && !agentOpen) {
      return;
    }
    await delay(200);
  }
}

async function stopConflictingExtensionPortClients() {
  const ps = await run('ps', ['-axo', 'pid=,command=']);
  const lines = ps.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const cmd = match[2];
    if (!Number.isFinite(pid) || pid === process.pid) continue;

    try {
      const isConflictingMcpClient = /vibe-mcp\/dist\/cli\.js|vibebrowser-mcp|@vibebrowser\/mcp/.test(cmd)
        && new RegExp(`--port\\s+${TEST_EXTENSION_PORT}\\b`).test(cmd);
      if (isConflictingMcpClient) {
        process.kill(pid, 'SIGTERM');
      }
    } catch {
      // best effort cleanup only
    }
  }
}

async function stopBrowserByUserDataDir(userDataDir) {
  const ps = await run('ps', ['-axo', 'pid=,command=']);
  const lines = ps.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const cmd = match[2];
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    if (!cmd.includes(`--user-data-dir=${userDataDir}`)) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // best effort shutdown only
    }
  }
}

async function waitForRelayReady() {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const extensionOpen = await probePort(TEST_EXTENSION_PORT);
    const agentOpen = await probePort(TEST_AGENT_PORT);
    if (extensionOpen && agentOpen) {
      return;
    }
    await delay(200);
  }
  throw new Error(`Relay did not become ready on ports ${TEST_AGENT_PORT}/${TEST_EXTENSION_PORT}`);
}

async function waitForRelayPid() {
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    if (existsSync(RELAY_PID_FILE)) {
      const pid = parseInt(readFileSync(RELAY_PID_FILE, 'utf-8').trim(), 10);
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 0);
          return;
        } catch {
          // keep waiting if pid not alive
        }
      }
    }
    await delay(100);
  }
}

async function startRelay() {
  try {
    await waitForRelayReady();
    return null;
  } catch {
    const relayArgs = ['dist/relay-daemon.js'];
    if (DEBUG_E2E) relayArgs.push('--debug');
      const relay = spawn(process.execPath, relayArgs, {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          ...process.env,
          VIBE_MCP_AGENT_PORT: String(TEST_AGENT_PORT),
          VIBE_MCP_EXTENSION_PORT: String(TEST_EXTENSION_PORT),
          VIBE_MCP_STATE_DIR: RELAY_STATE_DIR,
        },
      });
    await waitForRelayReady();
    await waitForRelayPid();
    return relay;
  }
}

async function probeExtensionConnection() {
  const ws = new WebSocket(`ws://${RELAY_HOST}:${TEST_AGENT_PORT}`);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(false), 2_000);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'extension_status') {
          clearTimeout(timer);
          finish(message.connected === true);
          return;
        }
        if (message.type === 'tools_list' && Array.isArray(message.data) && message.data.length > 0) {
          clearTimeout(timer);
          finish(true);
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      finish(false);
    });

    ws.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

async function waitForExtensionConnection(timeoutMs, options = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (typeof options.beforeProbe === 'function') {
      await options.beforeProbe();
    }
    const connected = await probeExtensionConnection();
    if (connected) return;
    await delay(1_000);
  }
  const hint = ENABLE_TEST_BROWSER
    ? `Ensure the latest extension is built at ${TEST_EXTENSION_PATH} and Chrome for Testing can launch it.`
    : 'Ensure Vibe extension has MCP External enabled in the active Chrome profile.';
  throw new Error(`Extension did not connect to relay within ${timeoutMs}ms. ${hint}`);
}

async function waitForTools(client, timeoutMs, options = {}) {
  const start = Date.now();
  let lastError = '';
  while (Date.now() - start < timeoutMs) {
    if (typeof options.beforeAttempt === 'function') {
      await options.beforeAttempt();
    }
    try {
      const result = await client.listTools();
      if (result.tools.length > 0) return result.tools;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`MCP tools did not populate from extension within ${timeoutMs}ms${lastError ? ` (last error: ${lastError})` : ''}`);
}

function getResultText(result) {
  return (result?.content || [])
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join(' ');
}

function isRetryablePreflightFailure(message) {
  return /No connection to Vibe extension|Request timed out/i.test(String(message || ''));
}

async function ensureLiveToolCall(client, tools, timeoutMs, options = {}) {
  const probeCandidates = [
    {
      name: 'wait',
      arguments: { seconds: 0.1, reasoning: 'e2e preflight' },
    },
    {
      name: 'create_new_tab',
      arguments: { url: 'about:blank', waitForReady: false },
    },
  ];

  const genericProbeTool = tools.find((tool) => {
    const required = tool?.inputSchema?.required;
    return Array.isArray(required) ? required.length === 0 : true;
  });
  if (genericProbeTool?.name) {
    probeCandidates.push({
      name: genericProbeTool.name,
      arguments: {},
    });
  }
  if (probeCandidates.length === 0) return;

  const start = Date.now();
  let lastReason = '';
  while (Date.now() - start < timeoutMs) {
    if (typeof options.beforeProbe === 'function') {
      await options.beforeProbe();
    }
    const connected = await probeExtensionConnection();
    if (!connected) {
      lastReason = 'Extension not connected';
      await delay(500);
      continue;
    }

    for (const candidate of probeCandidates) {
      try {
        const result = await client.callTool({
          name: candidate.name,
          arguments: candidate.arguments,
        });
        const text = getResultText(result);
        if (isRetryablePreflightFailure(text)) {
          lastReason = text;
          continue;
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isRetryablePreflightFailure(message)) {
          lastReason = message;
          continue;
        }
        lastReason = message;
      }
    }
    await delay(300);
  }

  throw new Error(`Live tool preflight failed within ${timeoutMs}ms. Last error: ${lastReason || 'unknown'}`);
}

function createTempOpencodeConfig(tmpDir, mcpCmd) {
  const config = {
    '$schema': 'https://opencode.ai/config.json',
    permission: {
      edit: 'deny',
      bash: 'deny',
      skill: 'allow',
      webfetch: 'deny',
      doom_loop: 'allow',
      external_directory: 'deny',
    },
    mcp: {
      'vibe-browser': {
        type: 'local',
        command: [mcpCmd.command, ...mcpCmd.args],
        enabled: true,
      },
    },
  };

  writeFileSync(join(tmpDir, 'opencode.json'), JSON.stringify(config, null, 2));

  const isolatedConfigDir = join(tmpDir, '.config');
  const isolatedOpencodeDir = join(isolatedConfigDir, 'opencode');
  mkdirSync(isolatedOpencodeDir, { recursive: true });
  writeFileSync(join(isolatedOpencodeDir, 'opencode.json'), '{}');

  return { isolatedConfigDir };
}

async function waitForOpencodeMcpReady({ cwd, env, timeoutMs = 30_000 }) {
  const start = Date.now();
  let lastOutput = '';

  while (Date.now() - start < timeoutMs) {
    // Recheck extension connectivity between retries; this can flap briefly.
    await waitForExtensionConnection(5_000).catch(() => {});

    try {
      const opencodeResult = await run('opencode', ['mcp', 'list'], {
        cwd,
        env,
      });
      const opencodeOutput = stripAnsi(opencodeResult.stdout + opencodeResult.stderr);
      if (/vibe-browser\s+connected/i.test(opencodeOutput)) {
        return opencodeOutput;
      }
      lastOutput = opencodeOutput;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastOutput = `${lastOutput}\n${message}`.trim();
    }

    await delay(1_000);
  }

  throw new Error(`OpenCode MCP check failed after retries. Last output:\n${lastOutput}`);
}

function buildCodexPrompt() {
  return REAL_TASK || [
    'You are running an e2e test for vibe-mcp using open-source MiniWoB++ tasks.',
    'Use only vibe-browser MCP tools.',
    'Do not run shell commands or local scripts.',
    'Use the vibe-browser MCP tools to complete these tasks in order:',
    '1) https://miniwob.farama.org/demos/miniwob/click-test.html',
    '2) https://miniwob.farama.org/demos/miniwob/click-test-2.html',
    '3) https://miniwob.farama.org/demos/miniwob/click-button-sequence.html',
    '',
    'Open a fresh page for each URL instead of reusing or navigating an existing tab.',
    'For each page:',
    '- Read the instruction text shown on the page (if present).',
    '- Perform the required action to complete the task.',
    '- Do not wait for reward text or success indicators; proceed after the action.',
    '',
    'After the final click, return exactly one line of JSON and nothing else:',
    '{"status":"ok|error","tasks":[{"name":"click-test","instruction":"<text>","result":"ok|error"},{"name":"click-test-2","instruction":"<text>","result":"ok|error"},{"name":"click-button-sequence","instruction":"<text>","result":"ok|error"}],"note":"miniwob++","reason":"<only if error>"}',
    'If any task fails, set status="error" and fill reason.',
  ].join('\n');
}

function parseCodexJson(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

function parseCodexToolCalls(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^tool\s+([a-zA-Z0-9_-]+\.[a-zA-Z0-9_/-]+)/);
      return match?.[1] || null;
    })
    .filter(Boolean);
}

async function main() {
  let relay;
  let managedChrome;
  let client;
  let opencodeTmpDir;
  try {
    const shouldCleanRelay = process.env.E2E_FORCE_CLEAN_RELAY === '1'
      || ENABLE_MANAGED_CHROME
      || ENABLE_TEST_BROWSER;
    if (shouldCleanRelay) {
      await stopExistingRelay();
      await stopConflictingExtensionPortClients();
    }
    relay = await startRelay();
    if (relay) {
      await waitForRelayPid();
    }
    const connected = ENABLE_TEST_BROWSER ? false : await probeExtensionConnection();
    if (!connected) {
      const bootstrap = ENABLE_TEST_BROWSER
        ? bootstrapTestBrowserWithExtension
        : bootstrapManagedChromeForRealE2E;
      managedChrome = await bootstrap().catch((error) => {
        if (DEBUG_E2E) {
          console.error(`[e2e] managed chrome bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return null;
      });
    }
    const keepExtensionAlive = typeof managedChrome?.poke === 'function'
      ? () => managedChrome.poke()
      : undefined;
    await waitForExtensionConnection(EXTENSION_CONNECT_TIMEOUT_MS, {
      beforeProbe: keepExtensionAlive,
    });

    const mcpCmd = getE2EMcpCommand();
    validateMcpCommandConfig(mcpCmd);
    if (DEBUG_E2E) {
      console.error(`[e2e] MCP source: ${mcpCmd.source}`);
      console.error(`[e2e] MCP command: ${mcpCmd.command} ${mcpCmd.args.join(' ')}`);
    }
    const transport = new StdioClientTransport({
      command: mcpCmd.command,
      args: mcpCmd.args,
      cwd: process.cwd(),
      env: {
        ...process.env,
        VIBE_MCP_AGENT_PORT: String(TEST_AGENT_PORT),
        VIBE_MCP_EXTENSION_PORT: String(TEST_EXTENSION_PORT),
        VIBE_MCP_STATE_DIR: RELAY_STATE_DIR,
      },
      stderr: 'pipe',
    });
    if (transport.stderr) {
      transport.stderr.on('data', (chunk) => process.stderr.write(chunk));
    }
    client = new Client({ name: 'vibe-mcp-e2e', version: '0.0.0' });
    await client.connect(transport);
    let tools = [];
    try {
      tools = await waitForTools(client, TOOLS_TIMEOUT_MS, {
        beforeAttempt: keepExtensionAlive,
      });
    } catch (error) {
      if (DEBUG_E2E) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[e2e] tools discovery warning: ${message}`);
      }
    }

    await ensureLiveToolCall(client, tools, 20_000, {
      beforeProbe: keepExtensionAlive,
    });

    opencodeTmpDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-opencode-e2e-'));
    const { isolatedConfigDir } = createTempOpencodeConfig(opencodeTmpDir, mcpCmd);
    await waitForOpencodeMcpReady({
      cwd: opencodeTmpDir,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: isolatedConfigDir,
      },
      timeoutMs: 45_000,
    });

    const codexPrompt = buildCodexPrompt();
    const codexArgs = [
      'exec',
      '-c',
      `model=${JSON.stringify(CODEX_MODEL)}`,
      '-c',
      `model_reasoning_effort=${JSON.stringify(CODEX_REASONING_EFFORT)}`,
      '-c',
      'model_verbosity="low"',
      '-c',
      'reflection.enabled=false',
    ];
    codexArgs.push(
      '-c',
      'mcp_servers.chrome-devtools.enabled=false',
      '-c',
      'mcp_servers.playwriter.enabled=false',
      '-c',
      'mcp_servers.knowledge-graph.enabled=false',
      '-c',
      'mcp_servers.github.enabled=false',
      '-c',
      'mcp_servers.context7.enabled=false',
      '-c',
      'mcp_servers.whisper-mcp.enabled=false',
      '-c',
      'mcp_servers.vibe-browser.enabled=true',
      '-c',
      `mcp_servers.vibe-browser.command=${JSON.stringify(mcpCmd.command)}`,
      '-c',
      `mcp_servers.vibe-browser.args=${JSON.stringify(mcpCmd.args)}`
    );
    if (process.env.E2E_CODEX_CONFIG) {
      codexArgs.push('-c', process.env.E2E_CODEX_CONFIG);
    }
    codexArgs.push(codexPrompt);
    const codexResult = await run('codex', codexArgs, {
      timeoutMs: CODEX_TIMEOUT_MS,
      stream: true,
    });
    const codexCombined = stripAnsi(codexResult.stdout + codexResult.stderr);
    if (/MCP client for `vibe-browser` failed to start/i.test(codexCombined)) {
      throw new Error(`Codex MCP startup failed. Output:\n${codexCombined}`);
    }
    const mcpToolCalls = parseCodexToolCalls(codexCombined);
    const usedVibeMcp = mcpToolCalls.some((name) => name.startsWith('vibe-browser.'));
    if (!usedVibeMcp) {
      throw new Error(`Codex did not use vibe-browser MCP tools.\nObserved tool calls: ${mcpToolCalls.join(', ') || 'none'}`);
    }
    const codexJson = parseCodexJson(codexCombined);
    if (!codexJson) {
      throw new Error(`Codex did not return JSON output. Output:\n${codexCombined}`);
    }
    const tasks = Array.isArray(codexJson.tasks) ? codexJson.tasks : [];
    const expected = ['click-test', 'click-test-2', 'click-button-sequence'];
    const names = tasks.map((task) => task?.name);
    const results = tasks.map((task) => task?.result);
    const hasExpected = expected.every((name) => names.includes(name));
    const allOk = results.length === expected.length && results.every((result) => result === 'ok');
    if (codexJson.status !== 'ok' || !hasExpected || !allOk) {
      throw new Error(`Codex task failed. Output:\n${JSON.stringify(codexJson)}`);
    }

    console.log('e2e ok');
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
    if (managedChrome?.cleanup) {
      await managedChrome.cleanup().catch(() => {});
    }
    if (opencodeTmpDir) {
      rmSync(opencodeTmpDir, { recursive: true, force: true });
    }
    if (packedPackageDir) {
      rmSync(packedPackageDir, { recursive: true, force: true });
    }
    if (relay) {
      relay.kill('SIGTERM');
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
