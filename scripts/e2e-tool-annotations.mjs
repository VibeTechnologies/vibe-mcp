#!/usr/bin/env node
/**
 * E2E: MCP tool annotations.
 *
 * Three things are proven here, in order:
 *
 *   A. CONTRACT   — every tool this server can expose has a hand-written
 *                   classification, and no classification contradicts what the
 *                   tool actually does.
 *   B. SELF-CHECK — the part-A checks are shown to go RED on broken input. This
 *                   test asserts on real data, so it must demonstrate it can
 *                   fail; a check that cannot fail is a false green. (See
 *                   VibeWebAgent#1856 — a batch of synthetic-fixture tests was
 *                   deleted for reporting green while production was broken.)
 *   C. WIRE       — a real server process, driven by a real MCP client over
 *                   streamable HTTP, returns those annotations in its
 *                   `tools/list` response. Nothing is stubbed on the server
 *                   side; only the Chrome extension (which needs a browser) is
 *                   faked, and it advertises the genuine 27-tool core profile.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  TOOL_ANNOTATIONS,
  EXTENSION_CORE_TOOL_NAMES,
  assertAnnotationCoverage,
  getToolAnnotations,
  normalizeAnnotationKey,
} from '../dist/tool-annotations.js';
import { CHROME_USE_TOOLS } from '../dist/chrome-use-connection.js';
import { SET_REMOTE_TOOL } from '../dist/server.js';

const RELAY_HOST = '127.0.0.1';
const REMOTE_UUID = 'test-annotations-uuid';

const REQUIRED_HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

/**
 * Tools that demonstrably change something — they click, type, navigate, close,
 * resize, or execute page JavaScript. None of these may claim readOnlyHint.
 *
 * This list is the "consistency" half of the requirement: it is derived from
 * what the implementation does, so a future edit that marks (say) `click` as
 * read-only to silence a prompt is caught here rather than shipping.
 */
const MUST_NOT_BE_READ_ONLY = [
  'set_remote',
  'new_page', 'close_page', 'navigate_page', 'switch_to_page',
  'click', 'fill', 'fill_form', 'type_text', 'scroll_page',
  'press_key', 'hover', 'drag', 'evaluate_script', 'upload_file', 'resize_page',
  // Reads like an observer; actually runs caller-supplied JS via new Function().
  'wait_for_condition',
  'navigate', 'type', 'scroll', 'eval', 'new_tab', 'select_tab', 'close_tab',
  'navigate_to_url', 'go_back', 'go_forward', 'create_new_tab', 'switch_to_tab',
  'keyboard_shortcut', 'typein_secret', 'media_control',
  'storage_set', 'storage_clear',
];

/**
 * Tools that can reach a host the caller chooses — navigation, fetching,
 * arbitrary JS (it can `fetch()`), or a click that follows a link.
 */
const MUST_BE_OPEN_WORLD = [
  'set_remote',
  'new_page', 'navigate_page', 'click', 'press_key', 'evaluate_script',
  'web_fetch', 'upload_file', 'wait_for_condition',
  'navigate', 'eval', 'new_tab',
  'navigate_to_url', 'go_back', 'go_forward', 'create_new_tab',
  'keyboard_shortcut', 'web_search',
];

/**
 * Tools that only observe. Asserted positively so that an over-cautious blanket
 * edit (marking everything non-read-only) is caught too — a directory reviewer
 * rejects inaccurate hints in either direction.
 */
const MUST_BE_READ_ONLY = [
  'list_pages', 'wait_for', 'wait_for_url', 'wait_for_network_idle',
  'take_screenshot', 'take_snapshot', 'list_network_requests',
  'get_network_request', 'web_fetch', 'list_console_messages',
  // `list` / `read` of credential metadata only; never writes, never returns plaintext.
  'secrets_manager',
  'snapshot', 'get_text', 'get_url', 'get_title', 'list_tabs',
  'get_page_content', 'get_tabs', 'take_md_snapshot', 'take_a11y_snapshot',
  'take_html_snapshot', 'storage_get',
];

/** Every tool name the server can put on the wire, across all backends. */
function toolUniverse() {
  return [
    SET_REMOTE_TOOL.name,
    ...EXTENSION_CORE_TOOL_NAMES,
    ...CHROME_USE_TOOLS.map((tool) => tool.name),
  ];
}

/**
 * Validate one tool's annotations. Returns a list of human-readable violations
 * (empty when valid) rather than throwing, so every problem is reported at once.
 */
function violationsFor(name, annotations, title) {
  const problems = [];
  const key = normalizeAnnotationKey(name);

  if (!annotations || typeof annotations !== 'object') {
    return [`${name}: no annotations object`];
  }
  if (typeof title !== 'string' || title.trim() === '') {
    problems.push(`${name}: missing or empty title`);
  }
  for (const hint of REQUIRED_HINTS) {
    if (typeof annotations[hint] !== 'boolean') {
      problems.push(`${name}: ${hint} is ${JSON.stringify(annotations[hint])}, expected a boolean`);
    }
  }
  // Spec: destructiveHint is meaningful only when readOnlyHint is false. A tool
  // claiming to be both read-only and destructive is self-contradictory.
  if (annotations.readOnlyHint === true && annotations.destructiveHint === true) {
    problems.push(`${name}: readOnlyHint and destructiveHint are both true`);
  }
  if (MUST_NOT_BE_READ_ONLY.includes(key) && annotations.readOnlyHint !== false) {
    problems.push(`${name}: marked read-only, but it mutates page or browser state`);
  }
  if (MUST_BE_READ_ONLY.includes(key) && annotations.readOnlyHint !== true) {
    problems.push(`${name}: only observes, but is not marked read-only`);
  }
  if (MUST_BE_OPEN_WORLD.includes(key) && annotations.openWorldHint !== true) {
    problems.push(`${name}: reaches caller-chosen hosts, but openWorldHint is not true`);
  }
  return problems;
}

function checkAll(entries) {
  const problems = [];
  for (const entry of entries) {
    problems.push(...violationsFor(entry.name, entry.annotations, entry.title));
  }
  return problems;
}

function assertOk(problems, label) {
  if (problems.length > 0) {
    throw new Error(`${label} failed:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Assert that `fn` throws — used to prove a check is capable of going red. */
function assertThrows(fn, label) {
  let threw = false;
  let message = '';
  try {
    fn();
  } catch (error) {
    threw = true;
    message = error instanceof Error ? error.message : String(error);
  }
  if (!threw) {
    throw new Error(`SELF-CHECK FAILED: ${label} did not fail on deliberately broken input`);
  }
  return message;
}

// ---------------------------------------------------------------------------
// Part A — contract
// ---------------------------------------------------------------------------

function partAContract() {
  const universe = toolUniverse();
  const unique = [...new Set(universe)];

  assertAnnotationCoverage(unique);

  const entries = unique.map((name) => {
    const annotations = getToolAnnotations(name);
    return { name, annotations, title: annotations?.title };
  });
  assertOk(checkAll(entries), 'Tool annotation contract');

  // The whole registry, including alias spellings not in the universe above.
  const registryEntries = Object.entries(TOOL_ANNOTATIONS).map(([name, annotations]) => ({
    name,
    annotations,
    title: annotations.title,
  }));
  assertOk(checkAll(registryEntries), 'Tool annotation registry');

  const readOnly = entries.filter((e) => e.annotations.readOnlyHint).length;
  const destructive = entries.filter((e) => e.annotations.destructiveHint).length;
  const openWorld = entries.filter((e) => e.annotations.openWorldHint).length;
  const idempotent = entries.filter((e) => e.annotations.idempotentHint).length;

  console.log(`[A] contract ok — ${unique.length} exposed tools annotated ` +
    `(${Object.keys(TOOL_ANNOTATIONS).length} registry entries incl. aliases)`);
  console.log(`[A] readOnly=${readOnly} destructive=${destructive} ` +
    `openWorld=${openWorld} idempotent=${idempotent}`);

  return { count: unique.length, readOnly, destructive, openWorld, idempotent };
}

// ---------------------------------------------------------------------------
// Part B — self-check: prove the part-A checks fail on broken input
// ---------------------------------------------------------------------------

function partBSelfCheck() {
  // B1. A new tool added to a backend with no classification.
  const m1 = assertThrows(
    () => assertAnnotationCoverage([...toolUniverse(), 'totally_new_unannotated_tool']),
    'coverage check on an unannotated tool'
  );
  if (!m1.includes('totally_new_unannotated_tool')) {
    throw new Error(`SELF-CHECK FAILED: coverage error did not name the offending tool: ${m1}`);
  }

  // B2. A tool that mutates state but claims to be read-only.
  assertThrows(
    () => assertOk(checkAll([{
      name: 'click',
      title: 'Click Element',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }]), 'x'),
    'consistency check on a mutating tool marked read-only'
  );

  // B3. Missing hints entirely — the pre-annotation status quo.
  assertThrows(
    () => assertOk(checkAll([{ name: 'click', title: 'Click Element', annotations: {} }]), 'x'),
    'completeness check on a tool with no hints'
  );

  // B4. Missing title.
  assertThrows(
    () => assertOk(checkAll([{
      name: 'take_screenshot',
      title: '',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }]), 'x'),
    'title check on a tool with an empty title'
  );

  // B5. Self-contradictory: read-only and destructive at once.
  assertThrows(
    () => assertOk(checkAll([{
      name: 'take_snapshot',
      title: 'Take Page Snapshot',
      annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }]), 'x'),
    'contradiction check on readOnly+destructive'
  );

  // B6. An observer wrongly marked as mutating (blanket-default regression).
  assertThrows(
    () => assertOk(checkAll([{
      name: 'take_screenshot',
      title: 'Take Screenshot',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }]), 'x'),
    'accuracy check on a read-only tool marked mutating'
  );

  // B7. An internet-reaching tool not flagged open-world.
  assertThrows(
    () => assertOk(checkAll([{
      name: 'navigate_page',
      title: 'Navigate Page',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }]), 'x'),
    'open-world check on a navigation tool'
  );

  console.log('[B] self-check ok — all 7 broken-input cases went red as required');
}

// ---------------------------------------------------------------------------
// Part C — wire
// ---------------------------------------------------------------------------

function findFreePort(exclude = new Set()) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, RELAY_HOST, () => {
      const port = server.address()?.port ?? 0;
      server.close((error) => {
        if (error) return reject(error);
        if (!port || exclude.has(port)) return findFreePort(exclude).then(resolve, reject);
        resolve(port);
      });
    });
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: RELAY_HOST, port });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

function withTimeout(promise, label, timeoutMs = 20_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)),
  ]);
}

function waitForWebSocketMessage(ws, predicate, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for websocket message'));
    }, timeoutMs);
    function onMessage(raw) {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    }
    ws.on('message', onMessage);
  });
}

function startFakeRelay(port, uuid) {
  const server = new WebSocketServer({ host: RELAY_HOST, port });
  const connected = new Promise((resolve) => {
    server.on('connection', (ws, req) => {
      if (req.url !== `/${uuid}`) { ws.close(); return; }
      ws.send(JSON.stringify({ type: 'extension_status', connected: true }));
      ws.send(JSON.stringify({ type: 'connected', sessionId: uuid }));
      resolve(ws);
    });
  });
  return { server, connected };
}

async function closeFakeRelay(relay) {
  if (!relay) return;
  for (const client of relay.server.clients) client.terminate();
  await new Promise((resolve) => relay.server.close(() => resolve()));
}

function waitForProcessExit(child, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, timeoutMs);
    child.once('exit', finish);
    child.once('close', finish);
  });
}

async function partCWire() {
  const reserved = new Set();
  const httpPort = await findFreePort(reserved); reserved.add(httpPort);
  const relayPort = await findFreePort(reserved); reserved.add(relayPort);
  const stateDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-annotations-'));
  const relay = startFakeRelay(relayPort, REMOTE_UUID);
  let serverProcess = null;

  try {
    serverProcess = spawn(
      process.execPath,
      [
        'dist/cli.js',
        'start',
        '--transport', 'http',
        '--host', RELAY_HOST,
        '--http-port', String(httpPort),
        '--remote', `ws://${RELAY_HOST}:${relayPort}/${REMOTE_UUID}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VIBE_MCP_STATE_DIR: stateDir } }
    );
    serverProcess.stderr.on('data', () => {});

    const [extensionWs] = await Promise.all([relay.connected, waitForPort(httpPort)]);

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${RELAY_HOST}:${httpPort}/mcp`)
    );
    const client = new Client({ name: 'vibe-mcp-annotations-e2e', version: '1.0.0' });
    await withTimeout(client.connect(transport), 'MCP client connect');

    const listToolsRequestPromise = waitForWebSocketMessage(
      extensionWs, (m) => m.type === 'list_tools'
    );
    const toolsPromise = client.listTools();
    const listToolsRequest = await listToolsRequestPromise;

    // The genuine core profile the extension advertises, plus one tool the
    // registry has never seen — that one must come back with the cautious
    // fallback rather than with no annotations at all.
    const advertised = [
      ...EXTENSION_CORE_TOOL_NAMES,
      'some_future_tool_we_have_not_classified',
    ].map((name) => ({
      name,
      description: `${name} (fake extension)`,
      inputSchema: { type: 'object', properties: {} },
    }));

    extensionWs.send(JSON.stringify({
      type: 'tools_list',
      requestId: listToolsRequest.requestId,
      data: advertised,
    }));

    const listed = await withTimeout(toolsPromise, 'tools/list response');
    const tools = listed.tools;

    // Every tool on the wire carries a title and all four hints.
    const missing = tools.filter(
      (t) => !t.annotations || typeof t.title !== 'string' || t.title === '' ||
        REQUIRED_HINTS.some((h) => typeof t.annotations[h] !== 'boolean')
    );
    if (missing.length > 0) {
      throw new Error(`Tools missing annotations on the wire: ${missing.map((t) => t.name).join(', ')}`);
    }

    // set_remote and the whole core profile must be present.
    for (const expected of ['set_remote', ...EXTENSION_CORE_TOOL_NAMES]) {
      if (!tools.some((t) => t.name === expected)) {
        throw new Error(`Expected ${expected} in tools/list`);
      }
    }

    // Classifications on the wire must match the registry, not just be present.
    assertOk(
      checkAll(tools
        .filter((t) => getToolAnnotations(t.name))
        .map((t) => ({ name: t.name, annotations: t.annotations, title: t.title }))),
      'Wire annotation consistency'
    );

    // The unclassified tool gets the cautious fallback.
    const unknown = tools.find((t) => t.name === 'some_future_tool_we_have_not_classified');
    if (unknown.annotations.readOnlyHint !== false ||
        unknown.annotations.destructiveHint !== true ||
        unknown.annotations.openWorldHint !== true) {
      throw new Error(`Unclassified tool did not get cautious defaults: ${JSON.stringify(unknown)}`);
    }

    console.log(`[C] wire ok — ${tools.length} tools in tools/list, all annotated`);
    const sample = ['set_remote', 'take_screenshot', 'click', 'wait_for_condition', 'secrets_manager', 'web_fetch']
      .map((n) => tools.find((t) => t.name === n))
      .filter(Boolean);
    console.log('[C] tools/list sample (verbatim from the wire):');
    console.log(JSON.stringify(sample.map((t) => ({
      name: t.name, title: t.title, annotations: t.annotations,
    })), null, 2));

    await withTimeout(client.close(), 'MCP client close');
    return tools.length;
  } finally {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await waitForProcessExit(serverProcess);
    }
    await closeFakeRelay(relay);
    rmSync(stateDir, { recursive: true, force: true });
  }
}

async function main() {
  const summary = partAContract();
  partBSelfCheck();
  const wireCount = await partCWire();
  console.log(`tool annotations e2e ok — ${summary.count} exposed tools, ${wireCount} on the wire`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
