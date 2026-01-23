#!/usr/bin/env node
/**
 * Vibe MCP Relay Daemon Entry Point
 * 
 * This script is spawned as a detached daemon process.
 */

import { startRelayDaemon } from './relay.js';

const debug = process.argv.includes('--debug');
startRelayDaemon(debug).catch((error) => {
  console.error(`[relay] Fatal error: ${error.message}`);
  process.exit(1);
});
