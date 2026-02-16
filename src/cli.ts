#!/usr/bin/env node
/**
 * Vibe MCP Server - CLI Entry Point
 * 
 * Command-line interface for starting the MCP server.
 * 
 * Modes:
 *   Local (default): connects to local relay daemon on localhost
 *   Remote (--remote <uuid>): connects to public relay at relay.api.vibebrowser.app
 */

import { program } from 'commander';
import { createServer } from './server.js';
import { DEFAULT_WS_PORT } from './types.js';

program
  .name('vibe-mcp')
  .description('MCP server for Vibe AI Browser - allows AI agents to control your browser')
  .version('0.1.0')
  .option('-p, --port <number>', 'WebSocket port for local extension connection', String(DEFAULT_WS_PORT))
  .option('-d, --debug', 'Enable debug logging', false)
  .option('-r, --remote <uuid>', 'Connect to a remote extension via public relay (provide the extension UUID)')
  .option('--relay-url <url>', 'Custom relay server URL (default: wss://relay.api.vibebrowser.app)')
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    
    if (isNaN(port) || port < 1024 || port > 65535) {
      console.error('Error: Port must be a number between 1024 and 65535');
      process.exit(1);
    }

    try {
      await createServer({
        port,
        debug: options.debug,
        remoteUuid: options.remote,
        remoteRelayUrl: options.relayUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to start server: ${message}`);
      process.exit(1);
    }
  });

program.parse();
