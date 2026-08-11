#!/usr/bin/env node
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { relayChildEnv } from '../dist/child-env.js';

const RELAY_HOST = '127.0.0.1';
const configuredHttpPort = getConfiguredPort('VIBE_MCP_TEST_HTTP_PORT', 'E2E_HTTP_PORT');
const configuredRelayPort = getConfiguredPort('VIBE_MCP_TEST_RELAY_PORT', 'E2E_RELAY_PORT');
const RESERVED_PORTS = new Set();
const MCP_HTTP_PORT = configuredHttpPort ?? await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(MCP_HTTP_PORT);
const RELAY_PORT = configuredRelayPort ?? await findFreePort(RESERVED_PORTS);
RESERVED_PORTS.add(RELAY_PORT);
const RELAY_PORT_B = await findFreePort(RESERVED_PORTS);
const RELAY_URL = `ws://${RELAY_HOST}:${RELAY_PORT}`;
const RELAY_URL_B = `ws://${RELAY_HOST}:${RELAY_PORT_B}`;
const REMOTE_UUID = 'test-routing-id-a';
const REMOTE_UUID_B = 'test-routing-id-b';
const HTTP_BEARER_TOKEN = 'fake-http-e2e-secret';
const SESSION_ID = REMOTE_UUID;
const SESSION_ID_B = REMOTE_UUID_B;
const MCP_URL = `http://${RELAY_HOST}:${MCP_HTTP_PORT}/mcp`;
const PUBLIC_HOST = 'bridge.example.test';
const INITIALIZE_REQUEST = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'auth-probe', version: '1.0.0' } },
};

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

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: RELAY_HOST, port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

async function waitForHostPort(host, port, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeHostPort(host, port)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

function probeHostPort(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

function waitForWebSocketMessage(ws, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for websocket message'));
    }, timeoutMs);

    const onMessage = (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (!predicate(parsed)) {
          return;
        }
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(parsed);
      } catch {
        // ignore malformed harness messages
      }
    };

    ws.on('message', onMessage);
  });
}

function withTimeout(promise, label, timeoutMs = 10_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  let remoteA;
  let remoteB;
  let serverProcess;
  const stateDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-http-e2e-'));

  try {
    if (await probePort(MCP_HTTP_PORT)) {
      throw new Error(`HTTP test port ${MCP_HTTP_PORT} is already in use`);
    }
    if (await probePort(RELAY_PORT)) {
      throw new Error(`Relay test port ${RELAY_PORT} is already in use`);
    }
    if (await probePort(RELAY_PORT_B)) {
      throw new Error(`Relay test port ${RELAY_PORT_B} is already in use`);
    }

    remoteA = startFakeRemoteRelay(RELAY_PORT, REMOTE_UUID, SESSION_ID);
    remoteB = startFakeRemoteRelay(RELAY_PORT_B, REMOTE_UUID_B, SESSION_ID_B);

    verifyRelayChildEnv();
    await verifyOpenClawOutput(stateDir);
    await verifyUnsafeBindRefusals(stateDir, remoteA);
    await verifyAlternateLoopbackHostFiltering(stateDir, remoteA);
    await verifyCustomHttpPathRouting(stateDir, remoteA);

    serverProcess = spawnHttpServer(stateDir);
    await Promise.all([remoteA.nextConnection(), waitForPort(MCP_HTTP_PORT)]);
    const compatibilityTransport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    const compatibilityClient = new Client({ name: 'vibe-mcp-http-loopback-e2e', version: '1.0.0' });
    await withTimeout(compatibilityClient.connect(compatibilityTransport), 'loopback no-token MCP connect');
    await withTimeout(compatibilityClient.close(), 'loopback no-token MCP close');
    serverProcess.kill('SIGTERM');
    await waitForProcessExit(serverProcess);
    serverProcess = undefined;

    serverProcess = spawnHttpServer(stateDir, HTTP_BEARER_TOKEN, RELAY_HOST, [RELAY_HOST, PUBLIC_HOST]);

    let stderr = '';
    serverProcess.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const [extensionWs] = await Promise.all([
      remoteA.nextConnection(),
      waitForPort(MCP_HTTP_PORT),
    ]);

    await verifyHttpAuthentication();

    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${HTTP_BEARER_TOKEN}` } },
      fetch: (url, init) => fetch(url, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), Host: PUBLIC_HOST },
      }),
    });
    const client = new Client({ name: 'vibe-mcp-http-e2e', version: '1.0.0' });

    await withTimeout(client.connect(transport), 'MCP client connect');
    const listToolsPromise = waitForWebSocketMessage(
      extensionWs,
      (message) => message.type === 'list_tools',
    );
    const toolsPromise = client.listTools();
    const listToolsRequest = await listToolsPromise;

    extensionWs.send(JSON.stringify({
      type: 'tools_list',
      requestId: listToolsRequest.requestId,
      data: [
        {
          name: 'echo',
          description: 'Echo a string',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
            },
            required: ['text'],
          },
        },
      ],
    }));

    const tools = await withTimeout(toolsPromise, 'initial tools/list response');
    if (!tools.tools.some((tool) => tool.name === 'echo')) {
      throw new Error(`Expected echo tool in listTools response: ${JSON.stringify(tools)}`);
    }

    const callToolPromise = waitForWebSocketMessage(
      extensionWs,
      (message) => message.type === 'call_tool' && message.data?.name === 'echo',
    );
    const callResultPromise = client.callTool({
      name: 'echo',
      arguments: { text: 'hello from http' },
    });
    const callRequest = await callToolPromise;

    extensionWs.send(JSON.stringify({
      type: 'tool_result',
      requestId: callRequest.requestId,
      data: {
        success: true,
        content: [{ type: 'text', text: 'hello from http' }],
      },
    }));

    const callResult = await withTimeout(callResultPromise, 'initial echo call response');
    const textContent = callResult.content.find((item) => item.type === 'text');
    if (!textContent || textContent.text !== 'hello from http') {
      throw new Error(`Unexpected tool result: ${JSON.stringify(callResult)}`);
    }

    // Update tools and verify MCP call responses do not include implicit page
    // content fallback when pageId/tabId was not explicitly provided.
    extensionWs.send(JSON.stringify({
      type: 'tools_list',
      data: [
        {
          name: 'echo',
          description: 'Echo a string',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
            },
            required: ['text'],
          },
        },
        {
          name: 'new_page',
          description: 'Open a new page',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string' },
            },
            required: ['url'],
          },
        },
        {
          name: 'take_md_snapshot',
          description: 'Take markdown snapshot',
          inputSchema: {
            type: 'object',
            properties: {
              pageId: { type: 'number' },
            },
          },
        },
      ],
    }));
    await delay(50);

    const openToolCallPromise = waitForWebSocketMessage(
      extensionWs,
      (message) => message.type === 'call_tool' && message.data?.name === 'new_page',
    );
    const openResultPromise = client.callTool({
      name: 'new_page',
      arguments: { url: 'https://example.com' },
    });
    const openToolCall = await openToolCallPromise;

    extensionWs.send(JSON.stringify({
      type: 'tool_result',
      requestId: openToolCall.requestId,
      data: {
        success: true,
        content: [{ type: 'text', text: JSON.stringify({ pageId: 77, url: 'https://example.com' }) }],
      },
    }));

    const openResult = await withTimeout(openResultPromise, 'new_page call response');
    const openText = openResult.content.find((item) => item.type === 'text');
    if (!openText || !openText.text.includes('"pageId":77')) {
      throw new Error(`Expected structured new_page response without fallback snapshot: ${JSON.stringify(openResult)}`);
    }
    if (openText.text.includes('# Markdown Snapshot: Example')) {
      throw new Error(`Did not expect implicit snapshot fallback in MCP response: ${JSON.stringify(openResult)}`);
    }

    const setRemoteResultPromise = client.callTool({
      name: 'set_remote',
      arguments: { url: `${RELAY_URL_B}/${REMOTE_UUID_B}` },
    });
    const [extensionWsB, setRemoteResult] = await withTimeout(Promise.all([
      remoteB.nextConnection(),
      setRemoteResultPromise,
    ]), 'set_remote response and relay B connection');

    const setRemoteText = setRemoteResult.content.find((item) => item.type === 'text');
    if (!setRemoteText) {
      throw new Error(`Expected set_remote text result: ${JSON.stringify(setRemoteResult)}`);
    }
    const setRemotePayload = JSON.parse(setRemoteText.text);
    if (setRemotePayload.ok !== true || setRemotePayload.mode !== 'remote' || setRemotePayload.relayUrl !== RELAY_URL_B || setRemotePayload.uuid !== REMOTE_UUID_B) {
      throw new Error(`Unexpected set_remote payload: ${JSON.stringify(setRemotePayload)}`);
    }

    const listToolsBPromise = waitForWebSocketMessage(
      extensionWsB,
      (message) => message.type === 'list_tools',
    );
    const toolsBPromise = client.listTools();
    const listToolsBRequest = await listToolsBPromise;

    extensionWsB.send(JSON.stringify({
      type: 'tools_list',
      requestId: listToolsBRequest.requestId,
      data: [
        {
          name: 'echo_b',
          description: 'Echo from relay B',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
            },
            required: ['text'],
          },
        },
      ],
    }));

    const toolsB = await withTimeout(toolsBPromise, 'relay B tools/list response');
    if (!toolsB.tools.some((tool) => tool.name === 'set_remote')) {
      throw new Error(`Expected set_remote tool after switching remotes: ${JSON.stringify(toolsB)}`);
    }
    if (!toolsB.tools.some((tool) => tool.name === 'echo_b')) {
      throw new Error(`Expected relay B tool after set_remote: ${JSON.stringify(toolsB)}`);
    }
    if (toolsB.tools.some((tool) => tool.name === 'echo')) {
      throw new Error(`Did not expect stale relay A tools after set_remote: ${JSON.stringify(toolsB)}`);
    }

    const callToolBPromise = waitForWebSocketMessage(
      extensionWsB,
      (message) => message.type === 'call_tool' && message.data?.name === 'echo_b',
    );
    const callResultBPromise = client.callTool({
      name: 'echo_b',
      arguments: { text: 'hello from relay b' },
    });
    const callRequestB = await callToolBPromise;

    extensionWsB.send(JSON.stringify({
      type: 'tool_result',
      requestId: callRequestB.requestId,
      data: {
        success: true,
        content: [{ type: 'text', text: 'hello from relay b' }],
      },
    }));

    const callResultB = await withTimeout(callResultBPromise, 'relay B echo call response');
    const textContentB = callResultB.content.find((item) => item.type === 'text');
    if (!textContentB || textContentB.text !== 'hello from relay b') {
      throw new Error(`Unexpected relay B tool result: ${JSON.stringify(callResultB)}`);
    }

    await withTimeout(transport.terminateSession(), 'authenticated MCP session termination');
    await withTimeout(client.close(), 'MCP client close');
    console.log('http e2e ok');
  } finally {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await waitForProcessExit(serverProcess);
    }
    await closeFakeRemoteRelay(remoteA);
    await closeFakeRemoteRelay(remoteB);
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function spawnHttpServer(stateDir, bearerToken, host = RELAY_HOST, allowedHosts = []) {
  const args = [
    'dist/cli.js', 'start', '--transport', 'http', '--host', host,
    '--http-port', String(MCP_HTTP_PORT), '--remote', `${RELAY_URL}/${REMOTE_UUID}`,
  ];
  for (const allowedHost of allowedHosts) {
    args.push('--allow-host', allowedHost);
  }
  return spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(stateDir, bearerToken),
  });
}

function childEnv(stateDir, bearerToken) {
  const {
    VIBE_MCP_HTTP_BEARER_TOKEN: _ambientToken,
    VIBE_MCP_ALLOW_INSECURE_HTTP: _ambientInsecureHttp,
    ...env
  } = process.env;
  return {
    ...env,
    VIBE_MCP_STATE_DIR: stateDir,
    ...(bearerToken ? { VIBE_MCP_HTTP_BEARER_TOKEN: bearerToken } : {}),
  };
}

async function verifyOpenClawOutput(stateDir) {
  const whitespaceToken = 'fake token must stay secret';
  const invalidToken = await runCli([
    'openclaw', '--remote', REMOTE_UUID,
  ], childEnv(stateDir, whitespaceToken));
  if (invalidToken.code === 0
    || !invalidToken.stderr.includes('single non-whitespace credential')
    || invalidToken.stdout.length > 0
    || invalidToken.stderr.includes(whitespaceToken)) {
    throw new Error('Expected OpenClaw whitespace token refusal before safe output');
  }

  const withoutToken = await runCli([
    'openclaw', '--remote', REMOTE_UUID, '--public-url', 'https://bridge.example.test/mcp',
  ], childEnv(stateDir));
  if (withoutToken.code === 0 || !withoutToken.stderr.includes('--public-url requires')) {
    throw new Error(`Expected public URL without token refusal, code=${withoutToken.code}`);
  }

  const insecureUrl = await runCli([
    'openclaw', '--remote', REMOTE_UUID, '--public-url', 'http://bridge.example.test/mcp',
  ], childEnv(stateDir, HTTP_BEARER_TOKEN));
  if (insecureUrl.code === 0 || !insecureUrl.stderr.includes('--public-url must use https://')) {
    throw new Error(`Expected insecure public URL refusal, code=${insecureUrl.code}`);
  }

  const unsafeBind = await runCli([
    'openclaw', '--remote', REMOTE_UUID, '--host', '0.0.0.0',
    '--public-url', 'https://bridge.example.test/mcp',
  ], childEnv(stateDir, HTTP_BEARER_TOKEN));
  if (unsafeBind.code === 0 || !unsafeBind.stderr.includes('--public-url requires --host to be')) {
    throw new Error(`Expected unsafe public bridge bind refusal, code=${unsafeBind.code}`);
  }

  const localWithToken = await runCli([
    'openclaw', '--remote', REMOTE_UUID,
  ], childEnv(stateDir, HTTP_BEARER_TOKEN));
  if (localWithToken.code !== 0
    || !localWithToken.stdout.includes('Bearer ${VIBE_MCP_HTTP_BEARER_TOKEN}')
    || localWithToken.stdout.includes(HTTP_BEARER_TOKEN)
    || localWithToken.stderr.includes(HTTP_BEARER_TOKEN)) {
    throw new Error('Expected local OpenClaw config to reference, but never expose, the environment token');
  }

  const success = await runCli([
    'openclaw', '--remote', REMOTE_UUID, '--public-url', 'https://bridge.example.test/mcp',
  ], childEnv(stateDir, HTTP_BEARER_TOKEN));
  if (success.code !== 0) {
    throw new Error(`Expected OpenClaw helper success, code=${success.code}, stderr=${success.stderr}`);
  }
  if (!success.stdout.includes('"transport": "streamable-http"')
    || !success.stdout.includes('Bearer ${VIBE_MCP_HTTP_BEARER_TOKEN}')) {
    throw new Error('Expected safe OpenClaw transport and Authorization template');
  }
  if (success.stdout.includes(HTTP_BEARER_TOKEN) || success.stderr.includes(HTTP_BEARER_TOKEN)) {
    throw new Error('OpenClaw helper output exposed the configured bearer token');
  }
  const startCommand = success.stdout.split('\n').find((line) => line.startsWith('npx ')) ?? '';
  if (startCommand.includes('bearer-token') || startCommand.includes('VIBE_MCP_HTTP_BEARER_TOKEN')) {
    throw new Error('OpenClaw bridge start command must inherit auth from the environment');
  }
  if (!startCommand.includes(`--allow-host ${PUBLIC_HOST}`)) {
    throw new Error('OpenClaw bridge start command must allow its public proxy Host');
  }
}

async function verifyUnsafeBindRefusals(stateDir, remote) {
  await verifyStartupRefusal(stateDir, remote, ['--host', '127.0.0.2'], 'Non-loopback HTTP bindings require');
  await verifyStartupRefusal(
    stateDir,
    remote,
    ['--host', RELAY_HOST, '--allow-host', PUBLIC_HOST],
    'Proxy-exposed HTTP endpoints require',
  );
  await verifyStartupRefusal(
    stateDir,
    remote,
    ['--host', RELAY_HOST, '--allow-host', 'attacker@localhost'],
    'Invalid --allow-host authority',
  );
  await verifyStartupRefusal(
    stateDir,
    remote,
    ['--host', RELAY_HOST, '--allow-host', 'localhost:8788'],
    'Invalid --allow-host authority',
  );
  await verifyStartupRefusal(
    stateDir,
    remote,
    ['--host', RELAY_HOST, '--http-bearer-token', 'invalid token'],
    'single non-whitespace credential',
  );
  await verifyStartupRefusal(
    stateDir,
    remote,
    ['--host', '0.0.0.0', '--http-bearer-token', HTTP_BEARER_TOKEN],
    'require --allow-insecure-http',
  );
  await verifyStartupRefusal(
    stateDir,
    remote,
    ['--host', '0.0.0.0', '--http-bearer-token', HTTP_BEARER_TOKEN, '--allow-insecure-http'],
    'require at least one --allow-host',
  );
}

function verifyRelayChildEnv() {
  const source = {
    VIBE_MCP_HTTP_BEARER_TOKEN: 'fake-detached-relay-token',
    VIBE_MCP_E2E_MARKER: 'preserved',
  };
  const child = relayChildEnv(source);
  if (source.VIBE_MCP_HTTP_BEARER_TOKEN === undefined
    || child.VIBE_MCP_HTTP_BEARER_TOKEN !== undefined
    || child.VIBE_MCP_E2E_MARKER !== 'preserved') {
    throw new Error('Detached relay child environment did not scrub only the HTTP bearer token');
  }
}

async function verifyCustomHttpPathRouting(stateDir, remote) {
  const port = await findFreePort(RESERVED_PORTS);
  RESERVED_PORTS.add(port);
  const customPath = '/custom-mcp';
  const child = spawn(process.execPath, [
    'dist/cli.js', 'start', '--transport', 'http', '--host', RELAY_HOST,
    '--http-port', String(port), '--http-path', customPath,
    '--remote', `${RELAY_URL}/${REMOTE_UUID}`, '--http-bearer-token', HTTP_BEARER_TOKEN,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(stateDir),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await Promise.all([
      remote.nextConnection(),
      Promise.race([
        waitForPort(port),
        new Promise((_, reject) => child.once('exit', (code) => {
          reject(new Error(`Custom-path server exited with ${code}: ${redact(stderr)}`));
        })),
      ]),
    ]);
    const exact = await rawMcpRequest('{', RELAY_HOST, undefined, RELAY_HOST, port, `${customPath}?query`);
    if (exact !== 401) {
      throw new Error(`Expected custom MCP path query to be preflighted with 401, got ${exact}`);
    }
    for (const path of ['/mcp', '/CUSTOM-MCP', '/custom-mcp/', '/custom-mcp/.']) {
      const malformedStatus = await rawMcpRequest('{', RELAY_HOST, undefined, RELAY_HOST, port, path);
      if (malformedStatus !== 400 && malformedStatus !== 404) {
        throw new Error(`Expected malformed non-exact custom MCP path ${path} to be rejected before MCP, got ${malformedStatus}`);
      }
      const validStatus = await rawMcpRequest(JSON.stringify(INITIALIZE_REQUEST), RELAY_HOST, undefined, RELAY_HOST, port, path);
      if (validStatus !== 400 && validStatus !== 404) {
        throw new Error(`Expected non-exact custom MCP path ${path} not to reach MCP, got ${validStatus}`);
      }
    }
  } finally {
    child.kill('SIGTERM');
    await waitForProcessExit(child);
  }
}

async function verifyAlternateLoopbackHostFiltering(stateDir, remote) {
  const bindHost = '127.0.0.2';
  const port = await findFreePort(RESERVED_PORTS);
  RESERVED_PORTS.add(port);
  const child = spawn(process.execPath, [
    'dist/cli.js', 'start', '--transport', 'http', '--host', bindHost,
    '--http-port', String(port), '--remote', `${RELAY_URL}/${REMOTE_UUID}`,
    '--http-bearer-token', HTTP_BEARER_TOKEN, '--allow-insecure-http',
    '--allow-host', bindHost,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(stateDir),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await Promise.all([
      remote.nextConnection(),
      Promise.race([
        waitForHostPort(bindHost, port),
        new Promise((_, reject) => child.once('exit', (code) => {
          reject(new Error(`127.0.0.2 server exited with ${code}: ${redact(stderr)}`));
        })),
      ]),
    ]);
    const status = await rawMcpRequest(
      '{',
      'hostile.example',
      `Bearer ${HTTP_BEARER_TOKEN}`,
      bindHost,
      port,
    );
    if (status !== 403) {
      throw new Error(`Expected hostile Host on 127.0.0.2 to fail pre-parser with 403, got ${status}`);
    }
  } finally {
    child.kill('SIGTERM');
    await waitForProcessExit(child);
  }
}

async function verifyStartupRefusal(stateDir, remote, extraArgs, expectedMessage) {
  const port = await findFreePort(RESERVED_PORTS);
  RESERVED_PORTS.add(port);
  const child = spawn(process.execPath, [
    'dist/cli.js', 'start', '--transport', 'http', '--http-port', String(port),
    '--remote', `${RELAY_URL}/${REMOTE_UUID}`, ...extraArgs,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(stateDir),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const code = await withTimeout(new Promise((resolve) => child.once('exit', resolve)), 'unsafe bind startup refusal');
  if (code === 0 || !stderr.includes(expectedMessage)) {
    throw new Error(`Expected startup refusal containing ${expectedMessage}, code=${code}, stderr=${redact(stderr)}`);
  }
  if (await probePort(port)) {
    throw new Error('Non-loopback refusal must occur before HTTP listen');
  }
  if (remote.connectionCount !== 0) {
    throw new Error('Non-loopback refusal must occur before relay connection');
  }
}

async function verifyHttpAuthentication() {
  const initialize = INITIALIZE_REQUEST;
  const request = (method, authorization) => fetch(`${MCP_URL}?preflight=query-safe`, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(initialize) } : {}),
  });

  for (const method of ['POST', 'GET', 'DELETE']) {
    for (const authorization of [
      undefined,
      'Bearer invalid-token',
      `Basic ${HTTP_BEARER_TOKEN}`,
      `Bearer ${HTTP_BEARER_TOKEN} trailing`,
      'Bearer',
    ]) {
      const response = await request(method, authorization);
      await response.arrayBuffer();
      if (response.status !== 401 || !response.headers.get('www-authenticate')?.startsWith('Bearer')) {
        throw new Error(`Expected ${method} bearer challenge, got ${response.status}`);
      }
    }
  }

  for (const method of ['GET', 'DELETE']) {
    const response = await request(method, `Bearer ${HTTP_BEARER_TOKEN}`);
    await response.arrayBuffer();
    if (response.status !== 400) {
      throw new Error(`Expected authenticated ${method} to reach session routing, got ${response.status}`);
    }
  }

  const malformedUnauthorized = await rawMcpRequest('{', RELAY_HOST);
  if (malformedUnauthorized !== 401) {
    throw new Error(`Expected malformed unauthenticated JSON to fail pre-parser with 401, got ${malformedUnauthorized}`);
  }

  const queryUnauthorized = await rawMcpRequest('{', RELAY_HOST, undefined, RELAY_HOST, MCP_HTTP_PORT, '/mcp?query');
  if (queryUnauthorized !== 401) {
    throw new Error(`Expected MCP query path to be preflighted with 401, got ${queryUnauthorized}`);
  }

  for (const path of ['/MCP', '/mcp/', '/MCP/', '/mcp/.']) {
    const malformedStatus = await rawMcpRequest('{', RELAY_HOST, undefined, RELAY_HOST, MCP_HTTP_PORT, path);
    if (malformedStatus !== 400 && malformedStatus !== 404) {
      throw new Error(`Expected malformed non-exact MCP path ${path} to be rejected before MCP, got ${malformedStatus}`);
    }
    const validStatus = await rawMcpRequest(JSON.stringify(initialize), RELAY_HOST, undefined, RELAY_HOST, MCP_HTTP_PORT, path);
    if (validStatus !== 400 && validStatus !== 404) {
      throw new Error(`Expected non-exact MCP path ${path} not to reach MCP, got ${validStatus}`);
    }
  }

  const malformedHostile = await rawMcpRequest('{', 'untrusted.example', `Bearer ${HTTP_BEARER_TOKEN}`);
  if (malformedHostile !== 403) {
    throw new Error(`Expected hostile Host to fail before auth/parser with 403, got ${malformedHostile}`);
  }

  const deceptiveHost = await rawMcpRequest('{', `attacker@${RELAY_HOST}`, `Bearer ${HTTP_BEARER_TOKEN}`);
  if (deceptiveHost !== 403) {
    throw new Error(`Expected malformed Host authority to fail before auth/parser with 403, got ${deceptiveHost}`);
  }

  const missingHost = await rawHttpStatus([
    'POST /mcp HTTP/1.0',
    `Authorization: Bearer ${HTTP_BEARER_TOKEN}`,
    'Content-Type: application/json',
    'Content-Length: 1',
    'Connection: close',
    '',
    '{',
  ].join('\r\n'));
  if (missingHost !== 403) {
    throw new Error(`Expected missing Host to fail before auth/parser with 403, got ${missingHost}`);
  }

  const mixedCaseBearer = await rawMcpRequest(
    JSON.stringify(initialize),
    RELAY_HOST,
    ` \t bEaReR \t ${HTTP_BEARER_TOKEN}  `,
  );
  if (mixedCaseBearer !== 200) {
    throw new Error(`Expected mixed-case Bearer with whitespace to authenticate, got ${mixedCaseBearer}`);
  }

  const hostStatus = await rawMcpRequest(JSON.stringify(initialize), 'untrusted.example', `Bearer ${HTTP_BEARER_TOKEN}`);
  if (hostStatus !== 403) {
    throw new Error(`Expected Host validation with valid auth, got ${hostStatus}`);
  }

  const healthResponse = await fetch(`http://${RELAY_HOST}:${MCP_HTTP_PORT}/health`);
  if (healthResponse.status !== 200) {
    throw new Error(`Expected health endpoint to remain auth-free, got ${healthResponse.status}`);
  }
}

function rawMcpRequest(body, host, authorization, connectHost = RELAY_HOST, port = MCP_HTTP_PORT, path = '/mcp') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: connectHost,
      port,
      path,
      method: 'POST',
      setHost: host !== undefined,
      headers: {
        ...(host !== undefined ? { Host: host } : {}),
        ...(authorization ? { Authorization: authorization } : {}),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
    }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end(body);
  });
}

function rawHttpStatus(request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: RELAY_HOST, port: MCP_HTTP_PORT });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.end(request));
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('error', reject);
    socket.once('close', () => {
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(response);
      if (!match) {
        reject(new Error(`Invalid raw HTTP response: ${response}`));
        return;
      }
      resolve(Number.parseInt(match[1], 10));
    });
  });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli.js', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function redact(value) {
  return value.split(HTTP_BEARER_TOKEN).join('[redacted]');
}

function startFakeRemoteRelay(port, uuid, sessionId) {
  const server = new WebSocketServer({ host: RELAY_HOST, port });
  const waiters = [];
  const pending = [];
  let connectionCount = 0;
  server.on('connection', (ws, req) => {
      if (req.url !== `/${uuid}`) {
        ws.close();
        return;
      }
      connectionCount += 1;
      ws.send(JSON.stringify({ type: 'extension_status', connected: true }));
      ws.send(JSON.stringify({ type: 'connected', sessionId }));
      const waiter = waiters.shift();
      if (waiter) waiter(ws);
      else pending.push(ws);
  });
  const nextConnection = () => new Promise((resolve) => {
    const ws = pending.shift();
    if (ws) resolve(ws);
    else waiters.push(resolve);
  });

  return { server, nextConnection, get connectionCount() { return connectionCount; } };
}

async function closeFakeRemoteRelay(remote) {
  if (!remote) {
    return;
  }

  for (const client of remote.server.clients) {
    client.terminate();
  }

  await new Promise((resolve, reject) => {
    remote.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function waitForProcessExit(child, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
