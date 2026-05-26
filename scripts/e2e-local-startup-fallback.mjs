#!/usr/bin/env node
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HOST = '127.0.0.1';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const CLI_PATH = resolve(PACKAGE_ROOT, 'dist', 'cli.js');
const PASS_MARKER = 'local startup fallback e2e ok';

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
        if (!port) {
          reject(new Error('Failed to allocate a free port'));
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function main() {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`Missing built CLI at ${CLI_PATH}. Run npm run build first.`);
  }

  const stateDir = mkdtempSync(join(tmpdir(), 'vibe-mcp-local-startup-fallback-'));
  const mismatchedAgentPort = await findFreePort();
  let client = null;

  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        CLI_PATH,
        'start',
        '--port',
        String(mismatchedAgentPort),
      ],
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        VIBE_MCP_STATE_DIR: stateDir,
      },
      stderr: 'pipe',
    });

    if (transport.stderr) {
      transport.stderr.on('data', (chunk) => {
        process.stderr.write(chunk.toString());
      });
    }

    client = new Client({ name: 'vibe-mcp-e2e-local-startup-fallback', version: '1.0.0' });
    await client.connect(transport);

    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((tool) => tool.name);
    if (!toolNames.includes('set_remote')) {
      throw new Error(`Expected set_remote in tools list, got: ${JSON.stringify(toolNames)}`);
    }

    console.log(PASS_MARKER);
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }

    const relayPidFile = join(stateDir, 'relay.pid');
    if (existsSync(relayPidFile)) {
      try {
        const relayPid = Number.parseInt(readFileSync(relayPidFile, 'utf-8').trim(), 10);
        if (Number.isFinite(relayPid) && relayPid > 0) {
          process.kill(relayPid, 'SIGTERM');
        }
      } catch {
        // Ignore cleanup errors.
      }
    }

    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
