#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { DevtoolsFallbackConnection } from '../dist/devtools-fallback.js';

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

function runJsonCli(scriptPath, args, timeoutMs = 10_000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [scriptPath, '--json', ...args], {
      cwd: PACKAGE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
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

    const originalResolveBinaryPath = DevtoolsFallbackConnection.prototype.resolveBinaryPath;
    // eslint-disable-next-line no-param-reassign
    DevtoolsFallbackConnection.prototype.resolveBinaryPath = function () {
      return undefined;
    };
    try {
      const unavailable = new DevtoolsFallbackConnection(false);
      await unavailable.start();
      try {
        await unavailable.callTool('list_pages', {});
        throw new Error('Expected callTool to fail when backend is unavailable');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert(
          message === 'chrome-devtools backend unavailable: chrome-devtools-mcp is not installed',
          `Unexpected unavailable error message: ${message}`,
        );
      } finally {
        await unavailable.stop();
      }
    } finally {
      DevtoolsFallbackConnection.prototype.resolveBinaryPath = originalResolveBinaryPath;
    }

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
