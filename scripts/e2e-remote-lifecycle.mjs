#!/usr/bin/env node
import http from 'node:http';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import {
  ExtensionConnection,
  parseRemoteRelayUrl,
  REDACTED_REMOTE_ID,
} from '../dist/connection.js';

const HOST = '127.0.0.1';
const UUID_A = '88888888-8888-4888-8888-888888888888';
const UUID_B = '99999999-9999-4999-8999-999999999999';
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

async function testHttpHandshakeRejection() {
  const port = await findFreePort();
  let attempts = 0;
  const server = http.createServer();
  server.on('upgrade', (_request, socket) => {
    attempts += 1;
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });
  const connection = new ExtensionConnection(0, false, {
    uuid: UUID_A,
    relayUrl: `ws://${HOST}:${port}`,
  }, undefined, 500);
  try {
    await expectReject(() => connection.start(), /HTTP 403/, 'HTTP relay rejection');
    await delay(2_250);
    assert(attempts === 1, `HTTP 403 rejection retried ${attempts} times`);
  } finally {
    await connection.stop();
    await new Promise((resolve) => server.close(resolve));
  }
}

await testUrlValidation();
await testHandshakeTimeout();
await testStateCleanupAndPermanentClose();
await testConcurrentSetRemote();
await testStopWhileConnecting();
await testHttpHandshakeRejection();
console.log('remote lifecycle e2e ok');
