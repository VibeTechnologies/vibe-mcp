#!/usr/bin/env node
/**
 * Vibe MCP Server - CLI Entry Point
 *
 * Modes:
 *   Local (default): connects to local relay daemon on localhost
 *   Remote (--remote <uuid>): connects to public relay at relay.api.vibebrowser.app
 */

import { program } from 'commander';
import { registerBrowserCommand } from './browser-cli.js';
import { createServer } from './server.js';
import {
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  DEFAULT_WS_PORT,
  type ServerTransportMode,
} from './types.js';
import { serve } from './ollama.js';
import { getPackageVersion } from './version.js';

program
  .name('vibebrowser-mcp')
  .description('MCP server for Vibe AI Browser - allows AI agents to control your browser')
  .version(getPackageVersion());

registerBrowserCommand(program);

program
  .command('start', { isDefault: true })
  .description('Start the MCP server (default)')
  .option('-p, --port <number>', 'WebSocket port for local relay (agent) connection', String(DEFAULT_WS_PORT))
  .option('-d, --debug', 'Enable debug logging', false)
  .option('--devtools', 'Use only chrome-devtools backend (bypasses extension relay)', false)
  .option('-r, --remote <uuid>', 'Connect to a remote extension via public relay (provide the extension UUID)')
  .option('-s, --session <id>', 'Target a specific local browser session ID; defaults to the first connected session')
  .option('--relay-url <url>', 'Custom relay server URL (default: wss://relay.api.vibebrowser.app)')
  .option('--transport <mode>', 'MCP transport to expose: stdio or http', 'stdio')
  .option('--host <host>', 'Host to bind the HTTP server to', '127.0.0.1')
  .option('--http-port <number>', 'Port for streamable HTTP MCP transport', String(DEFAULT_HTTP_PORT))
  .option('--http-path <path>', 'Path for streamable HTTP MCP transport', DEFAULT_HTTP_PATH)
  .option('--allow-host <host>', 'Allowed host header for HTTP transport (repeatable)', collectRepeatedOption, [])
  .action(async (options) => {
    const transport = parseTransportMode(options.transport);
    const port = parsePort(options.port, 'Relay port');
    const httpPort = parsePort(options.httpPort, 'HTTP port');

    try {
      const server = await createServer({
        port,
        host: options.host,
        debug: options.debug,
        devtools: options.devtools,
        transport,
        httpPort,
        httpPath: options.httpPath,
        allowedHosts: options.allowHost.length > 0 ? options.allowHost : undefined,
        remoteUuid: options.remote,
        sessionId: options.session,
        remoteRelayUrl: options.relayUrl,
      });

      const httpUrl = server.getHttpUrl();
      if (httpUrl) {
        console.error(`vibebrowser-mcp HTTP endpoint ready at ${httpUrl}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to start server: ${message}`);
      process.exit(1);
    }
  });

program
  .command('openclaw')
  .description('Print OpenClaw-friendly configuration for cloud agent -> local browser relay')
  .requiredOption('-r, --remote <uuid>', 'Extension UUID from Vibe extension Settings > MCP External > Remote')
  .option('--relay-url <url>', 'Custom relay server URL (default: wss://relay.api.vibebrowser.app)')
  .option('--host <host>', 'Host to bind the HTTP server to', '127.0.0.1')
  .option('--http-port <number>', 'Port for streamable HTTP MCP transport', String(DEFAULT_HTTP_PORT))
  .option('--http-path <path>', 'Path for streamable HTTP MCP transport', DEFAULT_HTTP_PATH)
  .option('--allow-host <host>', 'Allowed host header for HTTP transport (repeatable)', collectRepeatedOption, [])
  .action((options) => {
    const httpPort = parsePort(options.httpPort, 'HTTP port');
    const httpPath = normalizePath(options.httpPath);
    const host = options.host;
    const httpUrl = `http://${formatHost(host)}:${httpPort}${httpPath}`;

    const cliArgs = [
      '-y',
      '--package',
      '@vibebrowser/mcp',
      'vibebrowser-mcp',
      'start',
      '--transport',
      'http',
      '--host',
      host,
      '--http-port',
      String(httpPort),
      '--http-path',
      httpPath,
      '--remote',
      options.remote,
    ];

    if (options.relayUrl) {
      cliArgs.push('--relay-url', options.relayUrl);
    }
    for (const allowedHost of options.allowHost as string[]) {
      cliArgs.push('--allow-host', allowedHost);
    }

    const openClawConfig = {
      mcpServers: {
        vibe: {
          url: httpUrl,
        },
      },
    };

    console.log('Start a local bridge on the machine running the Vibe extension:');
    console.log(`npx ${cliArgs.join(' ')}`);
    console.log('');
    console.log('Then add this MCP server URL in OpenClaw:');
    console.log(httpUrl);
    console.log('');
    console.log('OpenClaw JSON snippet:');
    console.log(JSON.stringify(openClawConfig, null, 2));
  });

program
  .command('serve')
  .description('Install Ollama (if needed), download a model, and start serving it locally')
  .argument('<model>', 'Model to serve (e.g., qwen3.5, llama4, deepseek-r1, mistral)')
  .option('-p, --port <number>', 'Ollama API port', '11434')
  .option('-y, --yes', 'Skip confirmation prompts (auto-install)', false)
  .option('-d, --debug', 'Enable debug logging', false)
  .action(async (model: string, options) => {
    try {
      await serve(model, {
        port: parseInt(options.port, 10),
        yes: options.yes,
        debug: options.debug,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to serve model: ${message}`);
      process.exit(1);
    }
  });

program.parse();

function parseTransportMode(value: string): ServerTransportMode {
  if (value === 'stdio' || value === 'http') {
    return value;
  }
  console.error('Error: --transport must be one of: stdio, http');
  process.exit(1);
}

function parsePort(value: string, label: string): number {
  const port = parseInt(value, 10);
  if (Number.isNaN(port) || port < 1024 || port > 65535) {
    console.error(`Error: ${label} must be a number between 1024 and 65535`);
    process.exit(1);
  }
  return port;
}

function collectRepeatedOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function normalizePath(value: string): string {
  if (!value || value === '/') {
    return DEFAULT_HTTP_PATH;
  }
  return value.startsWith('/') ? value : `/${value}`;
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
