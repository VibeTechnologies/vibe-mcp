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
import { serve } from './ollama.js';

program
  .name('vibe-mcp')
  .description('MCP server for Vibe AI Browser - allows AI agents to control your browser')
  .version('0.2.3');

// Default command — start MCP server (existing behaviour)
program
  .command('start', { isDefault: true })
  .description('Start the MCP server (default)')
  .option('-p, --port <number>', 'WebSocket port for local relay (agent) connection', String(DEFAULT_WS_PORT))
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

// Serve command — one-liner local LLM setup via Ollama
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
