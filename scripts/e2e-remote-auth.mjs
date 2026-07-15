#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketServer } from 'ws';

const HOST = '127.0.0.1';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const MCP_CLI = resolve(PACKAGE_ROOT, 'dist', 'cli.js');
const BROWSER_CLI = resolve(PACKAGE_ROOT, 'dist', 'browser-main.js');

const UUID_AUTH = '11111111-1111-4111-8111-111111111111';
const UUID_DROP = '44444444-4444-4444-8444-444444444444';
const UUID_ROTATED = '22222222-2222-4222-8222-222222222222';
const UUID_LEGACY = '33333333-3333-4333-8333-333333333333';

const TOKEN_AUTH = 'a'.repeat(64);
const TOKEN_ROTATED = 'b'.repeat(64);
const TOKEN_WRONG = 'c'.repeat(64);
const TOKEN_MALFORMED = 'ABC123';

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

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port)) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

async function waitForAuthHeaderCount(relay, minCount, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (relay.getAuthHeaders().length >= minCount) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for auth header count >= ${minCount}`);
}

function parseJsonOrNull(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function assertNoTokenLeak(context, output, ...tokens) {
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    assert(!output.includes(token), `${context} leaked secret token in output`);
  }
}

function extractTextContent(result) {
  if (!result || !Array.isArray(result.content)) {
    return '';
  }
  const textEntry = result.content.find((entry) => entry?.type === 'text');
  return textEntry && typeof textEntry.text === 'string' ? textEntry.text : '';
}

function tool(name) {
  return {
    name,
    description: `Fake ${name} tool`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  };
}

async function runNodeProcess(scriptPath, args, {
  timeoutMs = 12_000,
  env = {},
  expectCode,
} = {}) {
  const child = spawn(
    process.execPath,
    [scriptPath, ...args],
    {
      cwd: PACKAGE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
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

  return {
    exitCode,
    stdout,
    stderr,
    json: parseJsonOrNull(stdout),
  };
}

async function waitForProcessExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, timeoutMs);
    child.once('exit', finish);
    child.once('close', finish);
  });
}

async function startMcpServer({ remoteUrl, remoteSecret, httpPort }) {
  const args = [
    MCP_CLI,
    'start',
    '--transport',
    'http',
    '--host',
    HOST,
    '--http-port',
    String(httpPort),
    '--remote',
    remoteUrl,
  ];
  if (remoteSecret !== undefined) {
    args.push('--remote-secret', remoteSecret);
  }

  const child = spawn(process.execPath, args, {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const waitUntilReady = async () => {
    const start = Date.now();
    while (Date.now() - start < 12_000) {
      if (child.exitCode !== null) {
        throw new Error(`MCP server exited early (${child.exitCode})\nstdout=${stdout}\nstderr=${stderr}`);
      }
      if (await probePort(httpPort)) {
        return;
      }
      await delay(50);
    }
    throw new Error(`Timed out waiting for MCP HTTP port ${httpPort}\nstdout=${stdout}\nstderr=${stderr}`);
  };

  await waitUntilReady();

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
      }
      await waitForProcessExit(child);
    },
  };
}

function startFakeRelay({ port, uuid, toolName, requiredToken }) {
  const server = http.createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const connectionQueue = [];
  const waiters = [];
  const authHeaders = [];
  let upgradeCount = 0;

  const sessionsPayload = () => [{
    sessionId: uuid,
    connected: true,
    connectedAt: Date.now(),
    toolCount: 1,
  }];

  const handleConnection = (ws, request) => {
    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;

    const info = {
      ws,
      authorization: authorization || '',
    };
    if (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve(info);
    } else {
      connectionQueue.push(info);
    }

    ws.send(JSON.stringify({ type: 'extension_status', connected: true }));
    ws.send(JSON.stringify({
      type: 'sessions_list',
      connected: true,
      sessionId: uuid,
      sessions: sessionsPayload(),
    }));

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.type === 'list_tools') {
        ws.send(JSON.stringify({
          type: 'tools_list',
          requestId: message.requestId,
          data: [tool(toolName)],
        }));
        return;
      }

      if (message.type === 'list_sessions') {
        ws.send(JSON.stringify({
          type: 'sessions_list',
          requestId: message.requestId,
          connected: true,
          sessionId: uuid,
          sessions: sessionsPayload(),
        }));
        return;
      }

      if (message.type === 'call_tool') {
        if (message.data?.name !== toolName) {
          ws.send(JSON.stringify({
            type: 'error',
            requestId: message.requestId,
            error: `Unknown tool: ${String(message.data?.name)}`,
          }));
          return;
        }

        ws.send(JSON.stringify({
          type: 'tool_result',
          requestId: message.requestId,
          data: {
            success: true,
            content: [{ type: 'text', text: `${toolName} ok` }],
          },
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

    upgradeCount += 1;
    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    const authValue = authorization || '';
    authHeaders.push(authValue);

    if (requiredToken && authValue !== `Bearer ${requiredToken}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (ws) => {
      handleConnection(ws, request);
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
    getUpgradeCount: () => upgradeCount,
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

async function withMcpClient(httpPort, callback) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://${HOST}:${httpPort}/mcp`));
  const client = new Client({ name: 'remote-auth-e2e', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}

async function main() {
  const relayAuthPort = await findFreePort();
  const relayDropPort = await findFreePort();
  const relayRotatePort = await findFreePort();
  const relayLegacyPort = await findFreePort();
  const httpPortAuth = await findFreePort();
  const httpPortLegacy = await findFreePort();

  const relayAuth = startFakeRelay({
    port: relayAuthPort,
    uuid: UUID_AUTH,
    toolName: 'echo_auth',
    requiredToken: TOKEN_AUTH,
  });
  const relayDrop = startFakeRelay({
    port: relayDropPort,
    uuid: UUID_DROP,
    toolName: 'echo_drop',
  });
  const relayRotate = startFakeRelay({
    port: relayRotatePort,
    uuid: UUID_ROTATED,
    toolName: 'echo_rotated',
    requiredToken: TOKEN_ROTATED,
  });
  const relayLegacy = startFakeRelay({
    port: relayLegacyPort,
    uuid: UUID_LEGACY,
    toolName: 'echo_legacy',
  });

  let authServer = null;
  let legacyServer = null;

  await relayAuth.start();
  await relayDrop.start();
  await relayRotate.start();
  await relayLegacy.start();

  try {
    // -----------------------------------------------------------------------
    // Browser CLI auth checks
    // -----------------------------------------------------------------------
    const cliValid = await runNodeProcess(BROWSER_CLI, [
      '--remote',
      relayAuth.url,
      '--remote-secret',
      TOKEN_AUTH,
      '--json',
      'status',
    ], { expectCode: 0 });
    const cliValidConn = await relayAuth.waitForConnection();
    assert(cliValidConn.authorization === `Bearer ${TOKEN_AUTH}`, 'browser-cli valid token did not send Authorization header');
    assert(cliValid.json?.ok === true, `browser-cli valid token failed: ${cliValid.stdout}\n${cliValid.stderr}`);
    assert(cliValid.json?.mode === 'remote', `browser-cli valid token mode mismatch: ${cliValid.stdout}`);
    assertNoTokenLeak('browser-cli valid token', `${cliValid.stdout}\n${cliValid.stderr}`, TOKEN_AUTH);
    console.log('  browser-cli valid token: PASS');

    const cliMissing = await runNodeProcess(BROWSER_CLI, [
      '--remote',
      relayAuth.url,
      '--json',
      'status',
    ], { expectCode: 1 });
    const cliMissingOutput = `${cliMissing.stdout}\n${cliMissing.stderr}`;
    assert(/401|unauthorized/i.test(cliMissingOutput), `browser-cli missing token should fail with 401: ${cliMissingOutput}`);
    assertNoTokenLeak('browser-cli missing token', cliMissingOutput, TOKEN_AUTH);
    console.log('  browser-cli missing token rejected: PASS');

    const cliWrong = await runNodeProcess(BROWSER_CLI, [
      '--remote',
      relayAuth.url,
      '--remote-secret',
      TOKEN_WRONG,
      '--json',
      'status',
    ], { expectCode: 1 });
    const cliWrongOutput = `${cliWrong.stdout}\n${cliWrong.stderr}`;
    assert(/401|unauthorized/i.test(cliWrongOutput), `browser-cli wrong token should fail with 401: ${cliWrongOutput}`);
    assertNoTokenLeak('browser-cli wrong token', cliWrongOutput, TOKEN_AUTH, TOKEN_WRONG);
    console.log('  browser-cli wrong token rejected: PASS');

    const upgradesBeforeMalformed = relayAuth.getUpgradeCount();
    const cliMalformed = await runNodeProcess(BROWSER_CLI, [
      '--remote',
      relayAuth.url,
      '--remote-secret',
      TOKEN_MALFORMED,
      '--json',
      'status',
    ], { expectCode: 1 });
    const cliMalformedOutput = `${cliMalformed.stdout}\n${cliMalformed.stderr}`;
    assert(/invalid remote secret/i.test(cliMalformedOutput), `browser-cli malformed token should fail closed: ${cliMalformedOutput}`);
    assert(relayAuth.getUpgradeCount() === upgradesBeforeMalformed, 'browser-cli malformed token should fail before network connect');
    assertNoTokenLeak('browser-cli malformed token', cliMalformedOutput, TOKEN_MALFORMED, TOKEN_AUTH);
    console.log('  browser-cli malformed token fails closed: PASS');

    const cliLegacy = await runNodeProcess(BROWSER_CLI, [
      '--remote',
      relayLegacy.url,
      '--json',
      'status',
    ], { expectCode: 0 });
    const cliLegacyConn = await relayLegacy.waitForConnection();
    assert(cliLegacy.json?.ok === true, `browser-cli legacy mode failed: ${cliLegacy.stdout}\n${cliLegacy.stderr}`);
    assert(!cliLegacyConn.authorization, `browser-cli legacy mode should not send auth header: ${cliLegacyConn.authorization}`);
    console.log('  browser-cli legacy tokenless compatibility: PASS');

    // -----------------------------------------------------------------------
    // MCP server auth checks
    // -----------------------------------------------------------------------
    authServer = await startMcpServer({
      remoteUrl: relayAuth.url,
      remoteSecret: TOKEN_AUTH,
      httpPort: httpPortAuth,
    });
    await waitForPort(httpPortAuth);
    const mcpAuthConn = await relayAuth.waitForConnection();
    assert(mcpAuthConn.authorization === `Bearer ${TOKEN_AUTH}`, 'mcp start did not send Authorization header with valid token');

    await withMcpClient(httpPortAuth, async (client) => {
      const initialTools = await client.listTools();
      assert(initialTools.tools.some((toolDef) => toolDef.name === 'set_remote'), `mcp tools missing set_remote: ${JSON.stringify(initialTools)}`);
      assert(initialTools.tools.some((toolDef) => toolDef.name === 'echo_auth'), `mcp tools missing relay-auth tool: ${JSON.stringify(initialTools)}`);

      const initialCall = await client.callTool({ name: 'echo_auth', arguments: {} });
      assert(extractTextContent(initialCall).includes('echo_auth ok'), `mcp call_tool failed before set_remote: ${JSON.stringify(initialCall)}`);

      const sameOriginUrl = relayAuth.url.replace(/^ws:\/\//, 'WS://');
      const [sameOriginResult, sameOriginConn] = await Promise.all([
        client.callTool({
          name: 'set_remote',
          arguments: {
            url: sameOriginUrl,
          },
        }),
        relayAuth.waitForConnection(),
      ]);
      assert(sameOriginConn.authorization === `Bearer ${TOKEN_AUTH}`, 'same-origin set_remote should preserve Authorization header');
      const sameOriginText = extractTextContent(sameOriginResult);
      assert(sameOriginText.length > 0, `same-origin set_remote result missing text payload: ${JSON.stringify(sameOriginResult)}`);
      const sameOriginPayload = parseJsonOrNull(sameOriginText);
      assert(sameOriginPayload?.ok === true, `same-origin set_remote result invalid: ${sameOriginText}`);
      assert(sameOriginPayload?.uuid === UUID_AUTH, `same-origin set_remote should keep UUID_AUTH: ${sameOriginText}`);
      assert(sameOriginPayload?.secretConfigured === true, `same-origin set_remote should keep secretConfigured=true: ${sameOriginText}`);
      assertNoTokenLeak('same-origin set_remote result', sameOriginText, TOKEN_AUTH, TOKEN_ROTATED, TOKEN_WRONG);

      const malformedDropAttemptsBefore = relayDrop.getUpgradeCount();
      const malformedSetRemote = await client.callTool({
        name: 'set_remote',
        arguments: {
          url: `${relayDrop.url}?token=${TOKEN_WRONG}`,
        },
      });
      const malformedSetRemoteText = extractTextContent(malformedSetRemote);
      assert(malformedSetRemote.isError === true, `malformed set_remote should return isError=true: ${JSON.stringify(malformedSetRemote)}`);
      assert(/query|fragment|remote-secret/i.test(malformedSetRemoteText), `malformed set_remote should mention query/secret rejection: ${malformedSetRemoteText}`);
      assert(relayDrop.getUpgradeCount() === malformedDropAttemptsBefore, 'malformed set_remote URL should fail before network connect');
      assertNoTokenLeak('malformed set_remote result', malformedSetRemoteText, TOKEN_AUTH, TOKEN_ROTATED, TOKEN_WRONG);

      const [crossOriginResult, dropConn] = await Promise.all([
        client.callTool({
          name: 'set_remote',
          arguments: {
            url: relayDrop.url,
          },
        }),
        relayDrop.waitForConnection(),
      ]);
      assert(!dropConn.authorization, `cross-origin set_remote without secret must not send Authorization: ${dropConn.authorization}`);
      const crossOriginText = extractTextContent(crossOriginResult);
      assert(crossOriginText.length > 0, `cross-origin set_remote result missing text payload: ${JSON.stringify(crossOriginResult)}`);
      const crossOriginPayload = parseJsonOrNull(crossOriginText);
      assert(crossOriginPayload?.ok === true, `cross-origin set_remote result invalid: ${crossOriginText}`);
      assert(crossOriginPayload?.uuid === UUID_DROP, `cross-origin set_remote should switch to UUID_DROP: ${crossOriginText}`);
      assert(crossOriginPayload?.secretConfigured === false, `cross-origin set_remote should report secretConfigured=false: ${crossOriginText}`);
      assertNoTokenLeak('cross-origin set_remote result', crossOriginText, TOKEN_AUTH, TOKEN_ROTATED, TOKEN_WRONG);

      const droppedTools = await client.listTools();
      assert(droppedTools.tools.some((toolDef) => toolDef.name === 'echo_drop'), `mcp tools missing drop-origin relay tool: ${JSON.stringify(droppedTools)}`);
      assert(!droppedTools.tools.some((toolDef) => toolDef.name === 'echo_auth'), `mcp tools should not include stale auth-origin tool: ${JSON.stringify(droppedTools)}`);
      const droppedCall = await client.callTool({ name: 'echo_drop', arguments: {} });
      assert(extractTextContent(droppedCall).includes('echo_drop ok'), `mcp call_tool failed after cross-origin secret drop: ${JSON.stringify(droppedCall)}`);

      const rotateAttemptsBefore = relayRotate.getAuthHeaders().length;
      const rotateWithoutSecret = await client.callTool({
        name: 'set_remote',
        arguments: {
          url: relayRotate.url,
        },
      });
      await waitForAuthHeaderCount(relayRotate, rotateAttemptsBefore + 1);
      const rotateWithoutSecretAuth = relayRotate.getAuthHeaders()[relayRotate.getAuthHeaders().length - 1] || '';
      assert(!rotateWithoutSecretAuth, `cross-origin set_remote without secret should not forward prior bearer token: ${rotateWithoutSecretAuth}`);
      const rotateWithoutSecretText = extractTextContent(rotateWithoutSecret);
      assert(rotateWithoutSecret.isError === true, `set_remote to token-enabled origin without secret should fail: ${JSON.stringify(rotateWithoutSecret)}`);
      assert(/401|unauthorized/i.test(rotateWithoutSecretText), `set_remote without secret should fail unauthorized: ${rotateWithoutSecretText}`);
      assertNoTokenLeak('set_remote without secret result', rotateWithoutSecretText, TOKEN_AUTH, TOKEN_ROTATED, TOKEN_WRONG);

      const [setRemoteResult, rotatedConn] = await Promise.all([
        client.callTool({
          name: 'set_remote',
          arguments: {
            url: relayRotate.url,
            secret: TOKEN_ROTATED,
          },
        }),
        relayRotate.waitForConnection(),
      ]);
      assert(rotatedConn.authorization === `Bearer ${TOKEN_ROTATED}`, 'set_remote did not apply rotated Authorization header');
      const setRemoteText = extractTextContent(setRemoteResult);
      assert(setRemoteText.length > 0, `set_remote result missing text payload: ${JSON.stringify(setRemoteResult)}`);
      const setRemotePayload = parseJsonOrNull(setRemoteText);
      assert(setRemotePayload?.ok === true, `set_remote result invalid: ${setRemoteText}`);
      assert(setRemotePayload?.uuid === UUID_ROTATED, `set_remote did not switch UUID: ${setRemoteText}`);
      assert(setRemotePayload?.secretConfigured === true, `set_remote should report secretConfigured=true: ${setRemoteText}`);
      assertNoTokenLeak('set_remote result', setRemoteText, TOKEN_ROTATED, TOKEN_AUTH);

      const rotatedTools = await client.listTools();
      assert(rotatedTools.tools.some((toolDef) => toolDef.name === 'echo_rotated'), `mcp tools missing rotated relay tool: ${JSON.stringify(rotatedTools)}`);
      assert(!rotatedTools.tools.some((toolDef) => toolDef.name === 'echo_drop'), `mcp tools should not include stale drop-origin relay tool: ${JSON.stringify(rotatedTools)}`);

      const rotatedCall = await client.callTool({ name: 'echo_rotated', arguments: {} });
      assert(extractTextContent(rotatedCall).includes('echo_rotated ok'), `mcp call_tool failed after set_remote: ${JSON.stringify(rotatedCall)}`);
    });

    assertNoTokenLeak('mcp auth server logs', `${authServer.getStdout()}\n${authServer.getStderr()}`, TOKEN_AUTH, TOKEN_ROTATED, TOKEN_WRONG);
    console.log('  mcp origin-bound secret handling + set_remote rotation: PASS');

    const mcpMissing = await runNodeProcess(MCP_CLI, [
      'start',
      '--transport',
      'http',
      '--host',
      HOST,
      '--http-port',
      String(await findFreePort()),
      '--remote',
      relayAuth.url,
    ], { expectCode: 1 });
    const mcpMissingOutput = `${mcpMissing.stdout}\n${mcpMissing.stderr}`;
    assert(/401|unauthorized/i.test(mcpMissingOutput), `mcp missing token should fail with 401: ${mcpMissingOutput}`);
    assertNoTokenLeak('mcp missing token output', mcpMissingOutput, TOKEN_AUTH);
    console.log('  mcp missing token rejected: PASS');

    const mcpWrong = await runNodeProcess(MCP_CLI, [
      'start',
      '--transport',
      'http',
      '--host',
      HOST,
      '--http-port',
      String(await findFreePort()),
      '--remote',
      relayAuth.url,
      '--remote-secret',
      TOKEN_WRONG,
    ], { expectCode: 1 });
    const mcpWrongOutput = `${mcpWrong.stdout}\n${mcpWrong.stderr}`;
    assert(/401|unauthorized/i.test(mcpWrongOutput), `mcp wrong token should fail with 401: ${mcpWrongOutput}`);
    assertNoTokenLeak('mcp wrong token output', mcpWrongOutput, TOKEN_AUTH, TOKEN_WRONG);
    console.log('  mcp wrong token rejected: PASS');

    const mcpMalformedUpgradesBefore = relayAuth.getUpgradeCount();
    const mcpMalformed = await runNodeProcess(MCP_CLI, [
      'start',
      '--transport',
      'http',
      '--host',
      HOST,
      '--http-port',
      String(await findFreePort()),
      '--remote',
      relayAuth.url,
      '--remote-secret',
      TOKEN_MALFORMED,
    ], { expectCode: 1 });
    const mcpMalformedOutput = `${mcpMalformed.stdout}\n${mcpMalformed.stderr}`;
    assert(/invalid remote secret/i.test(mcpMalformedOutput), `mcp malformed token should fail closed: ${mcpMalformedOutput}`);
    assert(relayAuth.getUpgradeCount() === mcpMalformedUpgradesBefore, 'mcp malformed token should fail before network connect');
    assertNoTokenLeak('mcp malformed token output', mcpMalformedOutput, TOKEN_MALFORMED, TOKEN_AUTH);
    console.log('  mcp malformed token fails closed: PASS');

    legacyServer = await startMcpServer({
      remoteUrl: relayLegacy.url,
      httpPort: httpPortLegacy,
    });
    await waitForPort(httpPortLegacy);
    const legacyConn = await relayLegacy.waitForConnection();
    assert(!legacyConn.authorization, `legacy mcp mode should not send auth header: ${legacyConn.authorization}`);
    await withMcpClient(httpPortLegacy, async (client) => {
      const tools = await client.listTools();
      assert(tools.tools.some((toolDef) => toolDef.name === 'echo_legacy'), `legacy mcp tools missing expected relay tool: ${JSON.stringify(tools)}`);
      const call = await client.callTool({ name: 'echo_legacy', arguments: {} });
      assert(extractTextContent(call).includes('echo_legacy ok'), `legacy mcp call failed: ${JSON.stringify(call)}`);
    });
    console.log('  mcp legacy tokenless compatibility: PASS');

    console.log('remote auth e2e ok');
  } finally {
    if (authServer) {
      await authServer.stop();
    }
    if (legacyServer) {
      await legacyServer.stop();
    }
    await relayAuth.close();
    await relayDrop.close();
    await relayRotate.close();
    await relayLegacy.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
