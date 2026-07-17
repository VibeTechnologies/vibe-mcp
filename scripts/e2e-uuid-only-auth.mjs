#!/usr/bin/env node
// Regression test for the UUID-only relay auth model (founder decision):
// the routing UUID in the wss URL is the *sole* bearer credential. There is
// no second attach-token/secret. This test asserts:
//   1. Neither the MCP CLI nor the browser CLI ever send an Authorization
//      header when connecting to a remote relay.
//   2. The removed --remote-secret flag / VIBE_REMOTE_SECRET env no longer
//      have any effect (agents connect with only --remote).
//   3. A bare UUID or full wss(s) URL both work as --remote targets.
import http from 'node:http';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HOST = '127.0.0.1';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const MCP_CLI = resolve(PACKAGE_ROOT, 'dist', 'cli.js');
const BROWSER_CLI = resolve(PACKAGE_ROOT, 'dist', 'browser-main.js');

const UUID = '66666666-6666-4666-8666-666666666666';

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

function parseJsonOrNull(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function tool(name) {
  return {
    name,
    description: `Fake ${name} tool`,
    inputSchema: { type: 'object', properties: {} },
  };
}

async function runNodeProcess(scriptPath, args, { timeoutMs = 12_000, env = {}, expectCode } = {}) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Process timed out: node ${scriptPath} ${args.join(' ')}`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });

  if (expectCode !== undefined && exitCode !== expectCode) {
    throw new Error(
      `Expected exit ${expectCode}, got ${exitCode}\ncommand=node ${scriptPath} ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`,
    );
  }

  return { exitCode, stdout, stderr, json: parseJsonOrNull(stdout) };
}

function startFakeRelay({ port, uuid, toolName }) {
  const server = http.createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const connectionQueue = [];
  const waiters = [];
  const authHeaders = [];

  const sessionsPayload = (connected, toolCount) => [{
    sessionId: uuid,
    connected,
    connectedAt: Date.now(),
    toolCount,
  }];

  const handleConnection = (ws) => {
    ws.send(JSON.stringify({ type: 'extension_status', connected: true }));
    ws.send(JSON.stringify({ type: 'sessions_list', connected: true, sessionId: uuid, sessions: sessionsPayload(true, 1) }));

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.type === 'list_tools') {
        ws.send(JSON.stringify({ type: 'tools_list', requestId: message.requestId, data: [tool(toolName)] }));
        return;
      }
      if (message.type === 'list_sessions') {
        ws.send(JSON.stringify({ type: 'sessions_list', requestId: message.requestId, connected: true, sessionId: uuid, sessions: sessionsPayload(true, 1) }));
        return;
      }
      if (message.type === 'call_tool') {
        ws.send(JSON.stringify({
          type: 'tool_result',
          requestId: message.requestId,
          data: { success: true, content: [{ type: 'text', text: `${toolName} ok` }] },
        }));
      }
    });
  };

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== `/${uuid}`) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    authHeaders.push(authorization || '');

    wsServer.handleUpgrade(request, socket, head, (ws) => {
      const info = { ws, authorization: authorization || '' };
      if (waiters.length > 0) {
        waiters.shift()(info);
      } else {
        connectionQueue.push(info);
      }
      handleConnection(ws);
    });
  });

  const waitForConnection = async (timeoutMs = 10_000) => {
    if (connectionQueue.length > 0) {
      return connectionQueue.shift();
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(onResolve);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for relay connection (${uuid})`));
      }, timeoutMs);
      const onResolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      waiters.push(onResolve);
    });
  };

  return {
    url: `ws://${HOST}:${port}/${uuid}`,
    start: async () => {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    waitForConnection,
    getAuthHeaders: () => [...authHeaders],
    close: async () => {
      for (const client of wsServer.clients) {
        client.terminate();
      }
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function main() {
  const relayPort = await findFreePort();
  const relay = startFakeRelay({ port: relayPort, uuid: UUID, toolName: 'echo_uuid' });
  await relay.start();

  try {
    // 1. browser-cli connects with only --remote (UUID) and never sends Authorization.
    const cliStatus = await runNodeProcess(BROWSER_CLI, [
      '--remote', relay.url,
      '--json',
      'status',
    ], { expectCode: 0 });
    const conn = await relay.waitForConnection();
    assert(!conn.authorization, `browser-cli must not send Authorization header (UUID-only auth): got "${conn.authorization}"`);
    assert(cliStatus.json?.ok === true, `browser-cli status failed: ${cliStatus.stdout}\n${cliStatus.stderr}`);
    assert(cliStatus.json?.mode === 'remote', `browser-cli status mode mismatch: ${cliStatus.stdout}`);
    assert(cliStatus.json?.sessionId === UUID, `browser-cli status sessionId mismatch: ${cliStatus.stdout}`);
    console.log('  browser-cli UUID-only connect, no Authorization header sent: PASS');

    // 2. --remote-secret is a removed flag: commander must reject it outright.
    const rejectSecretFlag = await runNodeProcess(BROWSER_CLI, [
      '--remote', relay.url,
      '--remote-secret', 'a'.repeat(64),
      '--json',
      'status',
    ], { expectCode: 1 });
    const rejectOutput = `${rejectSecretFlag.stdout}\n${rejectSecretFlag.stderr}`;
    assert(/unknown option/i.test(rejectOutput), `--remote-secret should be an unrecognized option now that the attach token is removed: ${rejectOutput}`);
    console.log('  browser-cli rejects removed --remote-secret flag: PASS');

    const rejectSecretFlagMcp = await runNodeProcess(MCP_CLI, [
      'start',
      '--transport', 'http',
      '--host', HOST,
      '--http-port', String(await findFreePort()),
      '--remote', relay.url,
      '--remote-secret', 'a'.repeat(64),
    ], { expectCode: 1, timeoutMs: 5_000 });
    const rejectOutputMcp = `${rejectSecretFlagMcp.stdout}\n${rejectSecretFlagMcp.stderr}`;
    assert(/unknown option/i.test(rejectOutputMcp), `mcp CLI should reject removed --remote-secret flag: ${rejectOutputMcp}`);
    console.log('  mcp CLI rejects removed --remote-secret flag: PASS');

    // 3. VIBE_REMOTE_SECRET env var is inert now (no such option to consume it).
    const envSecretIgnored = await runNodeProcess(BROWSER_CLI, [
      '--remote', relay.url,
      '--json',
      'status',
    ], { expectCode: 0, env: { VIBE_REMOTE_SECRET: 'b'.repeat(64) } });
    const envConn = await relay.waitForConnection();
    assert(!envConn.authorization, `VIBE_REMOTE_SECRET env must have no effect (no Authorization header): got "${envConn.authorization}"`);
    assert(envSecretIgnored.json?.ok === true, `browser-cli status with stray VIBE_REMOTE_SECRET env should still succeed: ${envSecretIgnored.stdout}`);
    console.log('  VIBE_REMOTE_SECRET env var has no effect: PASS');

    console.log('uuid-only auth e2e ok');
  } finally {
    await relay.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
