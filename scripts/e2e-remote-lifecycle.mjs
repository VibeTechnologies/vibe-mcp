#!/usr/bin/env node
import http from 'node:http';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import {
  ExtensionConnection,
  isPermanentRelayCloseCode,
  isPermanentRelayHttpStatus,
  parseRemoteRelayUrl,
  redactRemoteTarget,
  REDACTED_REMOTE_ID,
} from '../dist/connection.js';

const HOST = '127.0.0.1';
const UUID_A = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const UUID_B = 'fedcbafe-dcba-4fed-8cba-fedcbafedcba';
const RECONNECT_DELAY_MS = 40;
const TOOL = {
  name: 'lifecycle_test',
  description: 'Lifecycle test tool',
  inputSchema: { type: 'object', properties: {} },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectReject(fn, pattern, label) {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), `${label}: expected ${pattern}, got ${message}`);
    return message;
  }
  throw new Error(`${label}: expected rejection`);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startSilentTcpServer(port) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function withTimeout(promise, label, timeoutMs = 3_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function waitForEvent(emitter, event, predicate = () => true, timeoutMs = 3_000) {
  return withTimeout(new Promise((resolve) => {
    const listener = (value) => {
      if (!predicate(value)) return;
      emitter.off(event, listener);
      resolve(value);
    };
    emitter.on(event, listener);
  }), event, timeoutMs);
}

function startRelay(port, uuid) {
  const wss = new WebSocketServer({ host: HOST, port });
  let connectionCount = 0;
  const connected = new Promise((resolve) => {
    wss.on('connection', (ws, request) => {
      assert(request.url === `/${uuid}`, `unexpected relay path: ${request.url}`);
      connectionCount += 1;
      ws.send(JSON.stringify({ type: 'extension_status', connected: true }));
      ws.send(JSON.stringify({ type: 'tools_list', data: [TOOL] }));
      ws.send(JSON.stringify({
        type: 'sessions_list',
        sessions: [{ sessionId: uuid, connected: true, toolCount: 1 }],
      }));
      resolve(ws);
    });
  });
  return {
    url: `ws://${HOST}:${port}/${uuid}`,
    connected,
    getConnectionCount: () => connectionCount,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function startClosingRelay(port, uuid, code, reason = '') {
  const wss = new WebSocketServer({ host: HOST, port });
  let connectionCount = 0;
  wss.on('connection', (ws, request) => {
    assert(request.url === `/${uuid}`, `unexpected relay path: ${request.url}`);
    connectionCount += 1;
    setTimeout(() => ws.close(code, reason), 5);
  });
  return {
    url: `ws://${HOST}:${port}/${uuid}`,
    getConnectionCount: () => connectionCount,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function startErrorRelay(port, uuid) {
  const wss = new WebSocketServer({ host: HOST, port });
  const connected = new Promise((resolve) => {
    wss.on('connection', (ws, request) => {
      assert(request.url === `/${uuid}`, `unexpected relay path: ${request.url}`);
      ws.send(JSON.stringify({ type: 'extension_status', connected: true }));
      ws.send(JSON.stringify({ type: 'tools_list', data: [TOOL] }));
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'call_tool') {
          ws.send(JSON.stringify({
            type: 'error',
            requestId: message.requestId,
            error: `Relay rejected WSS://${HOST}:${port}/${uuid.toUpperCase()} for ${uuid.toUpperCase()}`,
          }));
        }
      });
      resolve(ws);
    });
  });
  return {
    url: `ws://${HOST}:${port}/${uuid}`,
    connected,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function startAdversarialErrorRelay(port, uuid) {
  const wss = new WebSocketServer({ host: HOST, port });
  const connected = new Promise((resolve) => {
    wss.on('connection', (ws, request) => {
      assert(request.url === `/${uuid}`, `unexpected relay path: ${request.url}`);
      ws.send(JSON.stringify({ type: 'extension_status', connected: true }));
      ws.send(JSON.stringify({ type: 'tools_list', data: [TOOL] }));
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== 'call_tool') return;
        if (message.data?.arguments?.malformed) {
          ws.send(JSON.stringify({
            type: 'error',
            requestId: message.requestId,
            error: { credential: uuid.toUpperCase() },
          }));
          return;
        }
        ws.send(JSON.stringify({
          type: 'tool_result',
          requestId: message.requestId,
          data: {
            success: false,
            isError: true,
            content: [{ type: 'text', text: `Relay rejected ${uuid.toUpperCase()}` }],
          },
        }));
      });
      resolve(ws);
    });
  });
  return {
    url: `ws://${HOST}:${port}/${uuid}`,
    connected,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function startHttpRejectingRelay(port, statusCode) {
  let attempts = 0;
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (_request, socket) => {
    attempts += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.end(`HTTP/1.1 ${statusCode} Rejected\r\nConnection: close\r\n\r\n`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });
  return {
    getAttempts: () => attempts,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function startStallingReconnectRelay(port, uuid) {
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  let upgrades = 0;
  let resolveReconnect;
  const reconnectStarted = new Promise((resolve) => { resolveReconnect = resolve; });
  server.on('upgrade', (request, socket, head) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    upgrades += 1;
    if (upgrades === 1) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
        setTimeout(() => ws.close(1012, 'restart'), 5);
      });
      return;
    }
    resolveReconnect();
    // Leave the stale reconnect handshake in CONNECTING until set_remote cancels it.
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });
  return {
    url: `ws://${HOST}:${port}/${uuid}`,
    reconnectStarted,
    getUpgradeCount: () => upgrades,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function testUrlValidation() {
  const valid = parseRemoteRelayUrl(`wss://relay.example.test/nested/${UUID_A}`);
  assert(valid.uuid === UUID_A, 'valid WSS URL UUID was not parsed');
  parseRemoteRelayUrl(`ws://localhost:19888/${UUID_A}`);
  parseRemoteRelayUrl(`ws://127.42.0.1:19888/${UUID_A}`);
  parseRemoteRelayUrl(`ws://[::1]:19888/${UUID_A}`);

  await expectReject(
    () => Promise.resolve(parseRemoteRelayUrl(`wss://relay.example.test/not-a-uuid`)),
    /UUID path segment is not valid/,
    'invalid full URL UUID',
  );
  await expectReject(
    () => Promise.resolve(parseRemoteRelayUrl(`ws://relay.example.test/${UUID_A}`)),
    /must use wss/,
    'non-loopback plaintext relay',
  );
  await expectReject(
    () => Promise.resolve(parseRemoteRelayUrl(`ws://192.0.2.10/${UUID_A}`)),
    /must use wss/,
    'private/development non-loopback plaintext relay',
  );
}

function testRetryPolicyMatrix() {
  for (const code of [1002, 1003, 1007, 1008, 4001, 4003, 4004, 4009, 4401, 4403]) {
    assert(isPermanentRelayCloseCode(code), `WS close ${code} should be permanent`);
  }
  for (const code of [1000, 1001, 1006, 1011, 1012, 4000, 4008]) {
    assert(!isPermanentRelayCloseCode(code), `WS close ${code} should be retryable`);
  }
  for (const status of [400, 401, 403, 404]) {
    assert(isPermanentRelayHttpStatus(status), `HTTP ${status} should be permanent`);
  }
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert(!isPermanentRelayHttpStatus(status), `HTTP ${status} should be retryable`);
  }
}

function testCaseInsensitiveRedaction() {
  const fullUrl = `wss://relay.example.test/${UUID_A}`;
  const upperUuid = UUID_A.toUpperCase();
  const message = `Relay rejected ${fullUrl.toUpperCase()} and ${upperUuid}`;
  const redacted = redactRemoteTarget(message, fullUrl);
  assert(!redacted.toLowerCase().includes(UUID_A.toLowerCase()), `redactor leaked UUID: ${redacted}`);
  assert(!redacted.toLowerCase().includes(fullUrl.toLowerCase()), `redactor leaked full URL: ${redacted}`);
  assert(redacted.includes(REDACTED_REMOTE_ID), `redactor omitted placeholder: ${redacted}`);
}

async function testHandshakeTimeout() {
  const port = await findFreePort();
  const server = await startSilentTcpServer(port);
  const connection = new ExtensionConnection(0, false, {
    uuid: UUID_A,
    relayUrl: `ws://${HOST}:${port}`,
  }, undefined, 75);
  const started = Date.now();
  try {
    await expectReject(() => connection.start(), /handshake timed out after 75ms/, 'handshake timeout');
    assert(Date.now() - started < 1_000, 'handshake timeout was not bounded');
  } finally {
    await connection.stop();
    await server.close();
  }
}

async function testUntrustedRelayErrorRedaction() {
  const port = await findFreePort();
  const relay = startErrorRelay(port, UUID_A);
  const debugOutput = [];
  const originalConsoleError = console.error;
  console.error = (...args) => debugOutput.push(args.map(String).join(' '));
  const connection = new ExtensionConnection(0, true, { uuid: relay.url });
  try {
    await connection.start();
    await relay.connected;
    const message = await expectReject(
      () => connection.callTool(TOOL.name, {}),
      /\[redacted\]/,
      'untrusted relay error redaction',
    );
    assert(!message.toLowerCase().includes(UUID_A.toLowerCase()), `relay error leaked UUID: ${message}`);
    assert(!message.toLowerCase().includes(relay.url.toLowerCase()), `relay error leaked full URL: ${message}`);
    assert(!debugOutput.join('\n').toLowerCase().includes(UUID_A.toLowerCase()), `debug output leaked UUID: ${debugOutput.join('\n')}`);
  } finally {
    await connection.stop();
    await relay.close();
    console.error = originalConsoleError;
  }
}

async function testAdversarialRelayErrorsSettleAndRedact() {
  const port = await findFreePort();
  const relay = startAdversarialErrorRelay(port, UUID_A);
  const connection = new ExtensionConnection(0, false, { uuid: relay.url });
  try {
    await connection.start();
    await relay.connected;

    const malformed = await expectReject(
      () => withTimeout(connection.callTool(TOOL.name, { malformed: true }), 'malformed relay error settlement', 500),
      /Unknown relay error/,
      'malformed relay error',
    );
    assert(!malformed.toLowerCase().includes(UUID_A.toLowerCase()), `malformed relay error leaked UUID: ${malformed}`);

    const result = await connection.callTool(TOOL.name, {});
    const resultText = result.content?.find((entry) => entry.type === 'text')?.text ?? '';
    assert(result.isError === true, `expected error tool_result: ${JSON.stringify(result)}`);
    assert(resultText.includes(REDACTED_REMOTE_ID), `error tool_result omitted redaction: ${JSON.stringify(result)}`);
    assert(!JSON.stringify(result).toLowerCase().includes(UUID_A.toLowerCase()), `error tool_result leaked UUID: ${JSON.stringify(result)}`);
  } finally {
    await connection.stop();
    await relay.close();
  }
}

async function testRepeatedStartIsIdempotent() {
  const port = await findFreePort();
  const relay = startRelay(port, UUID_A);
  const connection = new ExtensionConnection(0, false, { uuid: relay.url }, undefined, 500, RECONNECT_DELAY_MS);
  try {
    await Promise.all([connection.start(), connection.start()]);
    const socket = await relay.connected;
    await connection.start();

    const toolsUpdated = waitForEvent(connection, 'tools_updated', (tools) => tools.some((tool) => tool.name === 'after_repeat_start'));
    socket.send(JSON.stringify({
      type: 'tools_list',
      data: [{ ...TOOL, name: 'after_repeat_start' }],
    }));
    await toolsUpdated;
    assert(relay.getConnectionCount() === 1, `repeated start created ${relay.getConnectionCount()} sockets`);

    const disconnected = waitForEvent(connection, 'disconnected');
    socket.close(1012, 'restart');
    await disconnected;
    await delay(RECONNECT_DELAY_MS * 3);
    assert(relay.getConnectionCount() >= 2, 'repeated start invalidated reconnect callbacks');
    assert(connection.getStatus() === 'connected', `repeated start left status ${connection.getStatus()}`);
  } finally {
    await connection.stop();
    await relay.close();
  }
}

async function testStateCleanupAndPermanentClose() {
  const port = await findFreePort();
  const relay = startRelay(port, UUID_A);
  const debugOutput = [];
  const originalConsoleError = console.error;
  console.error = (...args) => debugOutput.push(args.map(String).join(' '));
  const connection = new ExtensionConnection(0, true, { uuid: relay.url });
  try {
    await connection.start();
    const socket = await relay.connected;
    await waitForEvent(connection, 'tools_updated', (tools) => tools.length === 1).catch(() => {});
    await delay(25);
    assert(connection.getTools().length === 1, 'tools did not populate before cleanup test');
    assert(connection.getSessions().length === 1, 'sessions did not populate before cleanup test');

    const statusCleared = waitForEvent(connection, 'extension_status', (connected) => connected === false);
    socket.send(JSON.stringify({ type: 'extension_status', connected: false }));
    await statusCleared;
    assert(connection.getTools().length === 0, 'extension_status:false retained tools');
    assert(connection.getSessions().length === 0, 'extension_status:false retained sessions');
    assert(connection.isExtensionConnected() === false, 'extension_status:false retained connected state');

    socket.send(JSON.stringify({ type: 'extension_status', connected: true }));
    socket.send(JSON.stringify({ type: 'tools_list', data: [TOOL] }));
    socket.send(JSON.stringify({
      type: 'sessions_list',
      sessions: [{ sessionId: UUID_A, connected: true, toolCount: 1 }],
    }));
    await delay(25);

    const disconnected = waitForEvent(connection, 'disconnected');
    socket.close(1008, `credential rejected: ${UUID_A}`);
    const close = await disconnected;
    assert(close.code === 1008, `close code was not surfaced: ${JSON.stringify(close)}`);
    assert(close.permanent === true, `permanent close was not classified: ${JSON.stringify(close)}`);
    assert(close.reason.includes(REDACTED_REMOTE_ID), `close reason was not redacted: ${JSON.stringify(close)}`);
    assert(!close.reason.includes(UUID_A), `close reason leaked UUID: ${JSON.stringify(close)}`);
    assert(connection.getTools().length === 0, 'socket close retained tools');
    assert(connection.getSessions().length === 0, 'socket close retained sessions');
    assert(connection.getConnectionErrorMessage().includes('code 1008'), 'connection error omitted close code');
    assert(!connection.getConnectionErrorMessage().includes(UUID_A), 'connection error leaked UUID');

    await delay(2_250);
    assert(relay.getConnectionCount() === 1, `permanent close retried ${relay.getConnectionCount()} times`);
    assert(!debugOutput.join('\n').includes(UUID_A), `debug output leaked remote UUID: ${debugOutput.join('\n')}`);
  } finally {
    await connection.stop();
    await relay.close();
    console.error = originalConsoleError;
  }
}

async function testPermanentRelayCloseMatrix() {
  for (const code of [4004, 4009]) {
    const port = await findFreePort();
    const relay = startClosingRelay(port, UUID_A, code, code === 4004 ? 'unknown UUID' : 'revoked UUID');
    const connection = new ExtensionConnection(
      0,
      false,
      { uuid: relay.url },
      undefined,
      500,
      RECONNECT_DELAY_MS,
    );
    try {
      await connection.start();
      const close = await waitForEvent(connection, 'disconnected');
      assert(close.code === code && close.permanent === true, `WS ${code} was not permanent: ${JSON.stringify(close)}`);
      await delay(RECONNECT_DELAY_MS * 3);
      assert(relay.getConnectionCount() === 1, `WS ${code} retried ${relay.getConnectionCount()} times`);
    } finally {
      await connection.stop();
      await relay.close();
    }
  }
}

async function testConcurrentSetRemote() {
  const slowPort = await findFreePort();
  const finalPort = await findFreePort();
  const slowServer = await startSilentTcpServer(slowPort);
  const finalRelay = startRelay(finalPort, UUID_B);
  const connection = new ExtensionConnection(0, false, undefined, undefined, 100);
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    const first = connection.setRemoteUrl(`ws://${HOST}:${slowPort}/${UUID_A}`);
    const second = connection.setRemoteUrl(finalRelay.url);
    await expectReject(() => first, /handshake timed out/, 'first concurrent set_remote');
    await withTimeout(second, 'second concurrent set_remote');
    await finalRelay.connected;
    assert(connection.getRemoteConfig()?.uuid === UUID_B, 'last concurrent set_remote did not win');
    assert(connection.getStatus() === 'connected', 'final concurrent set_remote is not connected');
    await delay(50);
    assert(uncaught.length === 0, `concurrent set_remote raised uncaught errors: ${uncaught}`);
  } finally {
    process.off('uncaughtException', onUncaught);
    await connection.stop();
    await slowServer.close();
    await finalRelay.close();
  }
}

async function testReconnectRaceWithSetRemote() {
  const oldPort = await findFreePort();
  const finalPort = await findFreePort();
  const oldRelay = await startStallingReconnectRelay(oldPort, UUID_A);
  const finalRelay = startRelay(finalPort, UUID_B);
  const connection = new ExtensionConnection(
    0,
    false,
    { uuid: oldRelay.url },
    undefined,
    500,
    RECONNECT_DELAY_MS,
  );
  try {
    await connection.start();
    await waitForEvent(connection, 'disconnected');
    await withTimeout(oldRelay.reconnectStarted, 'stale reconnect start');
    await connection.setRemoteUrl(finalRelay.url);
    await finalRelay.connected;
    await delay(RECONNECT_DELAY_MS * 3);
    assert(connection.getRemoteConfig()?.uuid === UUID_B, 'reconnect race replaced final remote config');
    assert(connection.getStatus() === 'connected', 'reconnect race disconnected final target');
    assert(finalRelay.getConnectionCount() === 1, `reconnect race created ${finalRelay.getConnectionCount()} final sockets`);
    assert(oldRelay.getUpgradeCount() === 2, `expected one stale reconnect, got ${oldRelay.getUpgradeCount() - 1}`);
  } finally {
    await connection.stop();
    await oldRelay.close();
    await finalRelay.close();
  }
}

async function testStopCancelsQueuedSetRemote() {
  const slowPort = await findFreePort();
  const queuedPort = await findFreePort();
  const slowServer = await startSilentTcpServer(slowPort);
  const queuedRelay = startRelay(queuedPort, UUID_B);
  const connection = new ExtensionConnection(0, false, undefined, undefined, 500, RECONNECT_DELAY_MS);
  try {
    const active = connection.setRemoteUrl(`ws://${HOST}:${slowPort}/${UUID_A}`);
    const queued = connection.setRemoteUrl(queuedRelay.url);
    await delay(25);
    await connection.stop();
    await expectReject(() => active, /closed before the connection was established|connection closed/i, 'active set_remote after stop');
    await expectReject(() => queued, /Connection closed/, 'queued set_remote after stop');
    await delay(RECONNECT_DELAY_MS * 2);
    assert(queuedRelay.getConnectionCount() === 0, 'queued set_remote connected after stop');
    assert(connection.getStatus() === 'disconnected', 'queued set_remote changed stopped status');
  } finally {
    await connection.stop();
    await slowServer.close();
    await queuedRelay.close();
  }
}

async function testStopWhileConnecting() {
  const port = await findFreePort();
  const server = await startSilentTcpServer(port);
  const connection = new ExtensionConnection(0, false, {
    uuid: UUID_A,
    relayUrl: `ws://${HOST}:${port}`,
  }, undefined, 2_000);
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    const start = connection.start();
    await delay(25);
    await connection.stop();
    await expectReject(() => start, /closed before the connection was established|connection closed/i, 'stop while CONNECTING');
    await delay(25);
    assert(uncaught.length === 0, `stop while CONNECTING raised uncaught errors: ${uncaught}`);
  } finally {
    process.off('uncaughtException', onUncaught);
    await connection.stop();
    await server.close();
  }
}

async function testHttpHandshakeRejectionMatrix() {
  for (const { status, permanent } of [
    { status: 403, permanent: true },
    { status: 408, permanent: false },
    { status: 429, permanent: false },
  ]) {
    const port = await findFreePort();
    const relay = await startHttpRejectingRelay(port, status);
    const connection = new ExtensionConnection(0, false, {
      uuid: UUID_A,
      relayUrl: `ws://${HOST}:${port}`,
    }, undefined, 500, RECONNECT_DELAY_MS);
    try {
      await expectReject(() => connection.start(), new RegExp(`HTTP ${status}`), `HTTP ${status} relay rejection`);
      await delay(RECONNECT_DELAY_MS * 3);
      const attempts = relay.getAttempts();
      if (permanent) {
        assert(attempts === 1, `HTTP ${status} retried ${attempts} times`);
      } else {
        assert(attempts >= 2, `HTTP ${status} did not retry: ${attempts} attempt(s)`);
      }
      const lastClose = connection.getLastClose();
      assert(lastClose?.code === status, `HTTP ${status} diagnostic was overwritten: ${JSON.stringify(lastClose)}`);
      assert(lastClose?.reason.includes(`HTTP ${status}`), `HTTP ${status} reason was overwritten: ${JSON.stringify(lastClose)}`);
    } finally {
      await connection.stop();
      await relay.close();
    }
  }
}

await testUrlValidation();
testRetryPolicyMatrix();
testCaseInsensitiveRedaction();
await testHandshakeTimeout();
await testUntrustedRelayErrorRedaction();
await testAdversarialRelayErrorsSettleAndRedact();
await testRepeatedStartIsIdempotent();
await testStateCleanupAndPermanentClose();
await testPermanentRelayCloseMatrix();
await testConcurrentSetRemote();
await testReconnectRaceWithSetRemote();
await testStopCancelsQueuedSetRemote();
await testStopWhileConnecting();
await testHttpHandshakeRejectionMatrix();
console.log('remote lifecycle e2e ok');
