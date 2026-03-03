#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const EXTENSION_PORT = 19889;
const AGENT_PORT = 19888;
const RELAY_HOST = '127.0.0.1';
const TIMEOUT_MS = 120_000;
const REAL_E2E = process.env.E2E_REAL === '1';
const REAL_TASK = process.env.E2E_TASK;
const TOOLS_TIMEOUT_MS = REAL_E2E ? 60_000 : 10_000;
const DEBUG_E2E = process.env.E2E_DEBUG === '1';
const RELAY_PID_FILE = join(homedir(), '.vibe-mcp', 'relay.pid');

const TOOL = {
  name: 'noop',
  description: 'No-op tool for e2e test',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

const stripAnsi = (input) => input.replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  });
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
    try {
      const ws = new WebSocket(`ws://${RELAY_HOST}:${EXTENSION_PORT}`);
      await new Promise((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', (err) => reject(err));
      });
      ws.close();
      await delay(200);
    } catch {
      return;
    }
  }
}

async function waitForRelayReady() {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    try {
      const ws = new WebSocket(`ws://${RELAY_HOST}:${EXTENSION_PORT}`);
      await new Promise((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', (err) => reject(err));
      });
      ws.close();
      return;
    } catch {
      await delay(200);
    }
  }
  throw new Error('Relay did not become ready on port 19889');
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
    const relay = spawn(process.execPath, ['dist/relay-daemon.js'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForRelayReady();
    await waitForRelayPid();
    return relay;
  }
}

async function startFakeExtension() {
  const ws = new WebSocket(`ws://${RELAY_HOST}:${EXTENSION_PORT}`);
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'list_tools') {
      if (DEBUG_E2E) {
        console.error('[e2e] fake extension received list_tools');
      }
      ws.send(JSON.stringify({
        type: 'tools_list',
        requestId: message.requestId,
        data: [TOOL],
      }));
      if (DEBUG_E2E) {
        console.error('[e2e] fake extension sent tools_list');
      }
      return;
    }

    if (message.type === 'call_tool') {
      if (DEBUG_E2E) {
        console.error('[e2e] fake extension received call_tool');
      }
      ws.send(JSON.stringify({
        type: 'tool_result',
        requestId: message.requestId,
        data: {
          success: true,
          content: [{ type: 'text', text: 'ok' }],
        },
      }));
      if (DEBUG_E2E) {
        console.error('[e2e] fake extension sent tool_result');
      }
    }
  });

  await new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });

  return ws;
}

async function waitForExtensionConnection(timeoutMs) {
  const ws = new WebSocket(`ws://${RELAY_HOST}:${AGENT_PORT}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Extension did not connect to relay within ${timeoutMs}ms`));
    }, timeoutMs);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'extension_status' && message.connected === true) {
          clearTimeout(timer);
          ws.close();
          resolve();
          return;
        }
        if (message.type === 'tools_list' && Array.isArray(message.data) && message.data.length > 0) {
          clearTimeout(timer);
          ws.close();
          resolve();
          return;
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function buildCodexPrompt() {
  if (!REAL_E2E) {
    return 'Respond with OK and exit.';
  }

  return REAL_TASK || [
    'You are running an e2e test for vibe-mcp using open-source MiniWoB++ tasks.',
    'Use the vibe-browser MCP tools to complete these tasks in order:',
    '1) https://miniwob.farama.org/demos/miniwob/click-test-2.html',
    '2) https://miniwob.farama.org/demos/miniwob/enter-text-2.html',
    '3) https://miniwob.farama.org/demos/miniwob/use-slider.html',
    '',
    'For each page:',
    '- Read the instruction text shown on the page.',
    '- Perform the required action to complete the task.',
    '- If a new instruction appears or a success indicator shows, mark result as ok.',
    '',
    'Return exactly one line of JSON and nothing else:',
    '{"status":"ok|error","tasks":[{"name":"click-test-2","instruction":"<text>","result":"ok|error"},{"name":"enter-text-2","instruction":"<text>","result":"ok|error"},{"name":"use-slider","instruction":"<text>","result":"ok|error"}],"note":"miniwob++","reason":"<only if error>"}',
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

async function main() {
  let relay;
  let extension;
  let client;
  try {
    await stopExistingRelay();
    relay = await startRelay();
    await waitForRelayPid();
    if (!REAL_E2E) {
      extension = await startFakeExtension();
    }
    await waitForExtensionConnection(TOOLS_TIMEOUT_MS);

    const npxArgs = ['-y', '@vibebrowser/mcp@latest'];
    if (DEBUG_E2E) {
      npxArgs.push('--debug');
    }
    const transport = new StdioClientTransport({
      command: 'npx',
      args: npxArgs,
      cwd: process.cwd(),
      stderr: 'pipe',
    });
    if (transport.stderr) {
      transport.stderr.on('data', (chunk) => process.stderr.write(chunk));
    }
    client = new Client({ name: 'vibe-mcp-e2e', version: '0.0.0' });
    await client.connect(transport);

    if (!REAL_E2E) {
      const start = Date.now();
      let tools = [];
      while (Date.now() - start < TOOLS_TIMEOUT_MS) {
        const result = await client.listTools();
        if (result.tools.length > 0) {
          tools = result.tools;
          break;
        }
        await delay(200);
      }
      if (tools.length === 0) {
        throw new Error(`MCP tools did not populate from extension within ${TOOLS_TIMEOUT_MS}ms`);
      }

      const toolName = 'noop';
      const callStart = Date.now();
      let toolResult;
      let lastCallError;
      while (Date.now() - callStart < 10_000) {
        try {
          toolResult = await client.callTool({ name: toolName, arguments: {} });
          const contentText = (toolResult?.content || [])
            .filter((item) => item.type === 'text' && typeof item.text === 'string')
            .map((item) => item.text)
            .join(' ');
          if (/No connection to Vibe extension/i.test(contentText)) {
            await delay(200);
            continue;
          }
          break;
        } catch (error) {
          lastCallError = error;
          const message = error instanceof Error ? error.message : String(error);
          if (!/No connection to Vibe extension/i.test(message)) {
            throw error;
          }
          await delay(200);
        }
      }
      if (!toolResult) {
        throw new Error(`Tool call did not succeed. ${lastCallError instanceof Error ? lastCallError.message : String(lastCallError)}`);
      }
      const toolText = (toolResult.content || [])
        .filter((item) => item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join(' ');
      if (!toolText.includes('ok')) {
        throw new Error(`Tool call did not return expected response. Got: ${toolText || 'empty'}`);
      }
    }

    const opencodeResult = await run('opencode', ['mcp', 'list']);
    const opencodeOutput = stripAnsi(opencodeResult.stdout + opencodeResult.stderr);
    if (!/vibe-browser\s+connected/i.test(opencodeOutput)) {
      throw new Error(`OpenCode MCP check failed. Output:\n${opencodeOutput}`);
    }

    const codexPrompt = buildCodexPrompt();
    const codexArgs = ['exec', codexPrompt];
    const codexResult = await run('codex', codexArgs, {
      timeoutMs: REAL_E2E ? 240_000 : TIMEOUT_MS,
    });
    const codexCombined = stripAnsi(codexResult.stdout + codexResult.stderr);
    if (/MCP client for `vibe-browser` failed to start/i.test(codexCombined)) {
      throw new Error(`Codex MCP startup failed. Output:\n${codexCombined}`);
    }
    if (REAL_E2E) {
      const codexJson = parseCodexJson(codexCombined);
      if (!codexJson) {
        throw new Error(`Codex did not return JSON output. Output:\n${codexCombined}`);
      }
      const tasks = Array.isArray(codexJson.tasks) ? codexJson.tasks : [];
      const expected = ['click-test-2', 'enter-text-2', 'use-slider'];
      const names = tasks.map((task) => task?.name);
      const results = tasks.map((task) => task?.result);
      const hasExpected = expected.every((name) => names.includes(name));
      const allOk = results.length === expected.length && results.every((result) => result === 'ok');
      if (codexJson.status !== 'ok' || !hasExpected || !allOk) {
        throw new Error(`Codex task failed. Output:\n${JSON.stringify(codexJson)}`);
      }
    }

    console.log('e2e ok');
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
    if (extension && extension.readyState === WebSocket.OPEN) {
      extension.close();
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
