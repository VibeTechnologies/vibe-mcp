#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { ChromeUseConnection } from '../dist/chrome-use-connection.js';

const HOST = '127.0.0.1';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const BROWSER_CLI = resolve(PACKAGE_ROOT, 'dist', 'browser-main.js');
const MCP_CLI = resolve(PACKAGE_ROOT, 'dist', 'cli.js');
const REMOTE_UUID = 'devtools-mode-test-uuid';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findFreePort() {
  return new Promise((resolvePort, reject) => {
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
        resolvePort(port);
      });
    });
  });
}

function probePort(port) {
  return new Promise((resolveConnected) => {
    const socket = net.connect({ host: HOST, port });
    socket.on('connect', () => {
      socket.destroy();
      resolveConnected(true);
    });
    socket.on('error', () => resolveConnected(false));
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

// Point Chrome discovery at a directory with no DevToolsActivePort so the
// chrome-use backend reports unavailable fast — keeps the test hermetic (no
// live browser), mirroring how the relay tests fake the extension.
const HERMETIC_ENV = {
  ...process.env,
  VIBE_CHROME_USER_DATA_DIR: join(tmpdir(), `vibe-no-chrome-${process.pid}`),
};

function runJsonCli(scriptPath, args, timeoutMs = 10_000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [scriptPath, '--json', ...args], {
      cwd: PACKAGE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: HERMETIC_ENV,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`CLI exited ${code}: ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
        return;
      }
      try {
        resolveResult(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`CLI did not emit JSON: ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}\n${error}`));
      }
    });
  });
}

function runCliText(scriptPath, args, timeoutMs = 10_000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: PACKAGE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: HERMETIC_ENV,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`CLI exited ${code}: ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
        return;
      }
      resolveResult(`${stdout}\n${stderr}`);
    });
  });
}

/**
 * A minimal in-memory fake of the CDP client used by ChromeUseConnection. It
 * answers just enough of the protocol to drive the tool dispatch path (one page
 * tab, a snapshot with a single button ref, a clickable element) without a real
 * browser — mirroring how the relay e2e tests fake the extension.
 */
function makeFakeCdp() {
  const state = {
    connected: true,
    clicked: false,
    close() { state.connected = false; },
    on() { return () => {}; },
    async send(method, params = {}) {
      switch (method) {
        case 'Browser.getVersion':
          return { product: 'HeadlessChrome/144.0.0' };
        case 'Target.getTargets':
          return { targetInfos: [{ targetId: 'T1', type: 'page', url: 'https://example.com/' }] };
        case 'Target.attachToTarget':
          return { sessionId: 'S1' };
        case 'Target.detachFromTarget':
        case 'Target.closeTarget':
        case 'Page.navigate':
        case 'DOM.focus':
        case 'Input.insertText':
        case 'Input.dispatchKeyEvent':
          return {};
        case 'Target.createTarget':
          return { targetId: 'T2' };
        case 'Input.dispatchMouseEvent':
          if (params.type === 'mousePressed') state.clicked = true;
          return {};
        case 'DOM.getBoxModel':
          return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
        case 'Page.captureScreenshot':
          return { data: 'ZmFrZQ==' };
        case 'Runtime.callFunctionOn':
          return { result: { value: 'Example Domain' } };
        case 'Runtime.evaluate': {
          const expr = String(params.expression || '');
          if (expr.includes('document.readyState')) return { result: { value: 'complete' } };
          if (expr.includes('location.href')) return { result: { value: 'https://example.com/' } };
          if (expr.includes('document.title')) return { result: { value: 'Example Domain' } };
          if (expr.includes('document.body.innerText')) return { result: { value: 'Example body text' } };
          if (expr.includes('window.__chromeUseRefs = []')) {
            // Snapshot walker IIFE: pretend one interactive button was found.
            return { result: { value: { nodes: [{ ref: 'e1', role: 'button', name: 'Submit', backendNodeId: 0, depth: 0 }] } } };
          }
          if (expr.includes('__chromeUseRefs')) {
            // Ref resolution: return a remote objectId for @e1.
            return { result: { type: 'object', objectId: 'OBJ-e1' } };
          }
          return { result: { value: null } };
        }
        default:
          return {};
      }
    },
  };
  return state;
}

async function main() {
  const relayPort = await findFreePort();
  const httpPort = await findFreePort();
  const relayUrl = `ws://${HOST}:${relayPort}`;

  let relayConnections = 0;
  let relayMessages = 0;
  const wss = new WebSocketServer({ host: HOST, port: relayPort });
  wss.on('connection', (ws) => {
    relayConnections += 1;
    ws.on('message', () => {
      relayMessages += 1;
    });
  });

  let serverProcess;
  try {
    const mcpHelp = await runCliText(MCP_CLI, ['start', '--help']);
    assert(mcpHelp.includes('--devtools'), 'vibebrowser-mcp start --help must include --devtools');
    const browserHelp = await runCliText(BROWSER_CLI, ['--help']);
    assert(browserHelp.includes('--devtools'), 'vibebrowser-cli --help must include --devtools');

    const browserStatus = await runJsonCli(BROWSER_CLI, [
      '--devtools',
      '--remote',
      `${relayUrl}/${REMOTE_UUID}`,
      'status',
    ]);
    assert(browserStatus.command === 'status', `Unexpected browser status payload: ${JSON.stringify(browserStatus)}`);
    assert(browserStatus.mode === 'devtools', `Expected mode=devtools, got ${browserStatus.mode}`);
    assert(relayConnections === 0 && relayMessages === 0, 'vibebrowser-cli --devtools should not touch relay');

    serverProcess = spawn(
      process.execPath,
      [
        MCP_CLI,
        'start',
        '--transport',
        'http',
        '--host',
        HOST,
        '--http-port',
        String(httpPort),
        '--devtools',
        '--remote',
        `${relayUrl}/${REMOTE_UUID}`,
      ],
      {
        cwd: PACKAGE_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: HERMETIC_ENV,
      },
    );

    let serverStderr = '';
    serverProcess.stderr.on('data', (chunk) => {
      serverStderr += chunk.toString();
    });

    await waitForPort(httpPort);
    assert(relayConnections === 0 && relayMessages === 0, 'vibebrowser-mcp start --devtools should not touch relay');

    const health = await fetch(`http://${HOST}:${httpPort}/health`);
    assert(health.ok, `health endpoint failed: ${health.status}`);
    const payload = await health.json();
    assert(payload.transport === 'http', `Unexpected health payload: ${JSON.stringify(payload)}`);
    assert(typeof payload.cachedTools === 'number', `Expected cachedTools number: ${JSON.stringify(payload)}`);

    // When Chrome cannot be reached, the chrome-use DevTools backend reports
    // unavailable (it never throws on start) and callTool surfaces that reason.
    const failingConnector = {
      connect() {
        return Promise.reject(new Error('DevToolsActivePort not found'));
      },
    };
    const unavailable = new ChromeUseConnection(false, { connector: failingConnector });
    let sawUnavailable = false;
    unavailable.on('unavailable', () => { sawUnavailable = true; });
    await unavailable.start();
    assert(unavailable.isAvailable() === false, 'Expected backend to be unavailable when Chrome is unreachable');
    assert(sawUnavailable, 'Expected an "unavailable" event when Chrome is unreachable');
    assert(unavailable.getTools().length === 0, 'Unavailable backend must expose no tools');
    assert(
      /DevToolsActivePort not found/.test(unavailable.getUnavailableReason() ?? ''),
      `Unexpected unavailable reason: ${unavailable.getUnavailableReason()}`,
    );
    try {
      await unavailable.callTool('navigate', { url: 'https://example.com' });
      throw new Error('Expected callTool to fail when backend is unavailable');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert(
        message.includes('chrome-use DevTools backend unavailable'),
        `Unexpected unavailable error message: ${message}`,
      );
    } finally {
      await unavailable.stop();
    }

    // A fake CDP transport lets us exercise the real tool dispatch (navigate →
    // snapshot → click) without a live browser, the way the relay e2e fakes the
    // extension. This proves tool wiring end-to-end through ChromeUseConnection.
    const fakeCdp = makeFakeCdp();
    const live = new ChromeUseConnection(false, { connector: { connect: async () => fakeCdp } });
    await live.start();
    assert(live.isAvailable(), 'Expected fake-CDP backend to be available');
    const toolNames = live.getTools().map((t) => t.name);
    for (const required of ['navigate', 'snapshot', 'click', 'fill', 'type', 'screenshot', 'eval', 'get_text', 'get_url', 'get_title']) {
      assert(toolNames.includes(required), `Missing tool: ${required}`);
    }

    const nav = await live.callTool('navigate', { url: 'example.com' });
    assert(!nav.isError, `navigate failed: ${JSON.stringify(nav)}`);
    assert(/example\.com/.test(nav.content[0].text), `navigate text unexpected: ${JSON.stringify(nav)}`);

    const snap = await live.callTool('snapshot', { interactive: true });
    assert(!snap.isError, `snapshot failed: ${JSON.stringify(snap)}`);
    assert(/@e1 \[button\]/.test(snap.content[0].text), `snapshot text unexpected: ${JSON.stringify(snap)}`);

    const click = await live.callTool('click', { selector: '@e1' });
    assert(!click.isError, `click failed: ${JSON.stringify(click)}`);
    assert(fakeCdp.clicked, 'Expected a trusted mouse press/release to be dispatched on click');

    const shot = await live.callTool('screenshot', {});
    assert(shot.content[0].type === 'image', `screenshot should return an image: ${JSON.stringify(shot)}`);
    assert(shot.content[0].data === 'ZmFrZQ==', 'screenshot should return the fake base64 image data');

    const title = await live.callTool('get_title', {});
    assert(title.content[0].text === 'Example Domain', `get_title unexpected: ${JSON.stringify(title)}`);

    await live.stop();

    console.log('devtools flag e2e ok');
  } finally {
    await new Promise((resolveClose) => wss.close(() => resolveClose()));
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
