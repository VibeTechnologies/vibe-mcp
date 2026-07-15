#!/usr/bin/env node
/**
 * Vibe MCP Server - CLI Entry Point
 *
 * Modes:
 *   Local (default): connects to local relay daemon on localhost
 *   Remote (--remote <uuid-or-url>): connects to public relay at relay.api.vibebrowser.app
 */

import { program } from 'commander';
import { registerBrowserCommand } from './browser-cli.js';
import { normalizeRemoteSecret } from './connection.js';
import { createServer } from './server.js';
import {
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  DEFAULT_WS_PORT,
  type ServerTransportMode,
} from './types.js';
import { serve } from './ollama.js';
import { getPackageVersion } from './version.js';

const DEFAULT_REMOTE = process.env.VIBE_REMOTE_URL || process.env.VIBE_EXTENSION_UUID || process.env.VIBE_RELAY_UUID;
const DEFAULT_REMOTE_SECRET = process.env.VIBE_REMOTE_SECRET;

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
  .option('--devtools', 'Drive your real running Chrome directly over the DevTools Protocol (bypasses the extension relay)', false)
  .option('-r, --remote <uuid-or-url>', 'Connect to a remote extension via relay (provide extension UUID or full ws(s) relay URL; never include auth token in URL/query)')
  .option('-s, --session <id>', 'Target a specific local browser session ID; defaults to the first connected session')
  .option('--transport <mode>', 'MCP transport to expose: stdio or http', 'stdio')
  .option('--host <host>', 'Host to bind the HTTP server to', '127.0.0.1')
  .option('--http-port <number>', 'Port for streamable HTTP MCP transport', String(DEFAULT_HTTP_PORT))
  .option('--http-path <path>', 'Path for streamable HTTP MCP transport', DEFAULT_HTTP_PATH)
  .option('--allow-host <host>', 'Allowed host header for HTTP transport (repeatable)', collectRepeatedOption, [])
  .option('--remote-secret <token>', 'Optional remote relay bearer token (64 lowercase hex chars). Never put it in URL/query.', DEFAULT_REMOTE_SECRET)
  .action(async (options) => {
    const transport = parseTransportMode(options.transport);
    const port = parsePort(options.port, 'Relay port');
    const httpPort = parsePort(options.httpPort, 'HTTP port');

    try {
      const remoteSecret = normalizeRemoteSecret(options.remoteSecret);
      const remote = options.remote || DEFAULT_REMOTE;

      if (remoteSecret && !remote) {
        console.error('Error: --remote-secret requires --remote (or VIBE_REMOTE_URL)');
        process.exit(1);
      }

      const server = await createServer({
        port,
        host: options.host,
        debug: options.debug,
        devtools: options.devtools,
        transport,
        httpPort,
        httpPath: options.httpPath,
        allowedHosts: options.allowHost.length > 0 ? options.allowHost : undefined,
        remoteUuid: remote,
        remoteSecret,
        sessionId: options.session,
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
  .requiredOption('-r, --remote <uuid-or-url>', 'Extension UUID or full ws(s) relay URL from Vibe extension Settings > MCP External > Remote (token must be separate)')
  .option('--remote-secret <token>', 'Optional remote relay bearer token (64 lowercase hex chars). Never put it in URL/query.', DEFAULT_REMOTE_SECRET)
  .option('--host <host>', 'Host to bind the HTTP server to', '127.0.0.1')
  .option('--http-port <number>', 'Port for streamable HTTP MCP transport', String(DEFAULT_HTTP_PORT))
  .option('--http-path <path>', 'Path for streamable HTTP MCP transport', DEFAULT_HTTP_PATH)
  .option('--public-url <url>', 'Publicly reachable MCP URL for OpenClaw when different from local bind URL')
  .option('--allow-host <host>', 'Allowed host header for HTTP transport (repeatable)', collectRepeatedOption, [])
  .action((options) => {
    try {
      const httpPort = parsePort(options.httpPort, 'HTTP port');
      const httpPath = normalizePath(options.httpPath);
      const host = options.host;
      const remoteSecret = normalizeRemoteSecret(options.remoteSecret);
      const localHttpUrl = `http://${formatHost(host)}:${httpPort}${httpPath}`;
      const openClawUrl = options.publicUrl
        ? normalizePublicUrl(String(options.publicUrl), httpPath)
        : localHttpUrl;

      const cliArgs = [
        '-y',
        '@vibebrowser/mcp@latest',
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

      if (remoteSecret) {
        cliArgs.push('--remote-secret', '$VIBE_REMOTE_SECRET');
      }

      for (const allowedHost of options.allowHost as string[]) {
        cliArgs.push('--allow-host', allowedHost);
      }

      const openClawConfig = {
        mcpServers: {
          vibe: {
            url: openClawUrl,
          },
        },
      };

      console.log('Start a local bridge on the machine running the Vibe extension:');
      if (remoteSecret) {
        console.log('Prefer env for secrets to reduce process-list leakage:');
        console.log('export VIBE_REMOTE_SECRET="<64-lowercase-hex-token>"');
      }
      console.log(`npx ${cliArgs.join(' ')}`);
      console.log('');
      console.log('Local bridge MCP URL:');
      console.log(localHttpUrl);
      console.log('');
      console.log('Use this MCP server URL in OpenClaw:');
      console.log(openClawUrl);
      if (isLoopbackUrl(openClawUrl)) {
        console.log('');
        console.log('Warning: this URL uses loopback/localhost and is only reachable from the same machine.');
        console.log('If OpenClaw runs in the cloud, pass --public-url with a reachable host.');
      }
      console.log('');
      console.log('OpenClaw JSON snippet:');
      console.log(JSON.stringify(openClawConfig, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
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

function normalizePublicUrl(value: string, fallbackPath: string): string {
  const parsed = parseHttpUrl(value, '--public-url');
  if (!parsed.pathname || parsed.pathname === '/') {
    parsed.pathname = fallbackPath;
  }
  return parsed.toString();
}

function parseHttpUrl(value: string, label: string): URL {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('protocol must be http:// or https://');
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${label} must be a valid HTTP(S) URL (${message})`);
    process.exit(1);
  }
}

function isLoopbackUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}
