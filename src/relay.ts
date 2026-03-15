/**
 * Vibe MCP Relay Server
 * 
 * Daemon that multiplexes multiple MCP agents to a single browser extension.
 * - Listens on port 19889 for extension connection (one client)
 * - Listens on port 19888 for MCP agent connections (multiple clients)
 * - Routes tool calls from agents to extension, responses back to agents
 * 
 * Note: Using 19888/19889 to avoid conflict with Playwriter MCP (uses 19988/19989)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { EventEmitter } from 'events';

// Ports (19888/19889 to avoid conflict with Playwriter MCP which uses 19988/19989)
export const EXTENSION_PORT = 19889;
export const AGENT_PORT = 19888;

// PID file location
const VIBE_DIR = join(homedir(), '.vibe-mcp');
const PID_FILE = join(VIBE_DIR, 'relay.pid');
const LOG_FILE = join(VIBE_DIR, 'relay.log');

/**
 * Message from extension
 */
interface ExtensionMessage {
  type: 'connected' | 'disconnected' | 'tool_result' | 'tools_list' | 'error' | 'snapshot';
  requestId?: string;
  data?: unknown;
  error?: string;
}

/**
 * Message to extension
 */
interface ServerMessage {
  type: 'list_tools' | 'call_tool' | 'get_snapshot' | 'ping';
  requestId: string;
  data?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

/**
 * Agent connection info
 */
interface AgentConnection {
  ws: WebSocket;
  id: string;
  connectedAt: number;
}

/**
 * Pending request from an agent
 */
interface PendingRequest {
  agentId: string;
  originalRequestId: string;
  lastSentAt: number;
}

/**
 * Vibe MCP Relay Server
 */
export class RelayServer extends EventEmitter {
  private extensionWss: WebSocketServer | null = null;
  private agentWss: WebSocketServer | null = null;
  private extensionWs: WebSocket | null = null;
  private agents: Map<string, AgentConnection> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private tools: unknown[] = [];
  private requestIdCounter = 0;
  private debug: boolean;
  private toolsSyncTimer: NodeJS.Timeout | null = null;

  constructor(debug: boolean = false) {
    super();
    this.debug = debug;
  }

  /**
   * Start the relay server
   */
  async start(): Promise<void> {
    // Ensure directory exists
    if (!existsSync(VIBE_DIR)) {
      mkdirSync(VIBE_DIR, { recursive: true });
    }

    // Start extension WebSocket server
    await this.startExtensionServer();
    
    // Start agent WebSocket server
    await this.startAgentServer();

    // Write PID file
    writeFileSync(PID_FILE, String(process.pid));
    this.log(`Relay started (PID: ${process.pid})`);

    // Handle shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  /**
   * Start WebSocket server for extension connection
   */
  private async startExtensionServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.extensionWss = new WebSocketServer({ port: EXTENSION_PORT, host: '127.0.0.1' });

      this.extensionWss.on('listening', () => {
        this.log(`Extension server listening on ws://127.0.0.1:${EXTENSION_PORT}`);
        resolve();
      });

      this.extensionWss.on('connection', (ws) => {
        this.handleExtensionConnection(ws);
      });

      this.extensionWss.on('error', (error) => {
        this.log(`Extension server error: ${error.message}`);
        reject(error);
      });
    });
  }

  /**
   * Start WebSocket server for agent connections
   */
  private async startAgentServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.agentWss = new WebSocketServer({ port: AGENT_PORT, host: '127.0.0.1' });

      this.agentWss.on('listening', () => {
        this.log(`Agent server listening on ws://127.0.0.1:${AGENT_PORT}`);
        resolve();
      });

      this.agentWss.on('connection', (ws) => {
        this.handleAgentConnection(ws);
      });

      this.agentWss.on('error', (error) => {
        this.log(`Agent server error: ${error.message}`);
        reject(error);
      });
    });
  }

  /**
   * Handle extension connection
   */
  private handleExtensionConnection(ws: WebSocket): void {
    // Replace prior extension connection (background/sidepanel can reconnect).
    if (this.extensionWs) {
      this.extensionWs.close();
      // Reject pending requests immediately — the old connection is gone and the
      // extension will send 'connected' again, but we don't want a window where
      // new requests could slip through to the new socket before rejection.
      this.rejectPendingRequests('Extension reconnected — previous connection replaced');
    }

    this.log('Extension connected');
    this.extensionWs = ws;

    ws.on('message', (data) => {
      try {
        const message: ExtensionMessage = JSON.parse(data.toString());
        this.handleExtensionMessage(ws, message);
      } catch (error) {
        this.log(`Failed to parse extension message: ${error}`);
      }
    });

    ws.on('close', (code, reasonBuffer) => {
      const reason = reasonBuffer?.toString() || '';
      this.log(`Extension disconnected (code=${code}${reason ? `, reason=${reason}` : ''})`);
      // Ignore stale close events from replaced sockets.
      if (this.extensionWs !== ws) {
        return;
      }

      this.extensionWs = null;
      this.tools = [];
      this.stopToolsSyncLoop();

      // Notify all agents
      this.broadcastToAgents({ type: 'extension_disconnected' });
    });

    ws.on('error', (error) => {
      this.log(`Extension WebSocket error: ${error.message}`);
    });

    // Request tools list, with retries in case the extension wasn't ready yet.
    this.startToolsSyncLoop();
  }

  /**
   * Handle agent connection
   */
  private handleAgentConnection(ws: WebSocket): void {
    const agentId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    const agent: AgentConnection = {
      ws,
      id: agentId,
      connectedAt: Date.now(),
    };
    
    this.agents.set(agentId, agent);
    this.log(`Agent connected: ${agentId} (total: ${this.agents.size})`);

    // Send current tools list
    if (this.tools.length > 0) {
      ws.send(JSON.stringify({ type: 'tools_list', data: this.tools }));
    }

    // Send extension status
    ws.send(JSON.stringify({ 
      type: 'extension_status', 
      connected: this.extensionWs !== null 
    }));

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleAgentMessage(agentId, message);
      } catch (error) {
        this.log(`Failed to parse agent message: ${error}`);
      }
    });

    ws.on('close', () => {
      this.agents.delete(agentId);
      this.log(`Agent disconnected: ${agentId} (total: ${this.agents.size})`);
      
      // Clean up pending requests for this agent
      for (const [relayId, pending] of this.pendingRequests) {
        if (pending.agentId === agentId) {
          this.pendingRequests.delete(relayId);
        }
      }
    });

    ws.on('error', (error) => {
      this.log(`Agent WebSocket error: ${error.message}`);
    });
  }

  /**
   * Handle message from extension
   */
  private handleExtensionMessage(sourceWs: WebSocket, message: ExtensionMessage): void {
    if (this.extensionWs !== sourceWs) {
      this.log(`Ignoring stale extension message: ${message.type}`);
      return;
    }

    this.log(`Extension message: ${message.type}`);

    if (message.type === 'connected') {
      // Reject any remaining pending requests (belt-and-suspenders —
      // handleExtensionConnection already rejects when replacing, but this
      // covers the case where extension reconnects without a new WS connection).
      this.rejectPendingRequests('Extension reconnected — request may have been lost');
    }

    // Handle tools list
    if (message.type === 'tools_list') {
      this.tools = message.data as unknown[];
      this.stopToolsSyncLoop();
      // Broadcast to all agents
      this.broadcastToAgents({ type: 'tools_list', data: this.tools });
      return;
    }

    // Handle response to a request
    if (message.requestId) {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        this.pendingRequests.delete(message.requestId);
        
        // Forward response to the requesting agent
        const agent = this.agents.get(pending.agentId);
        if (agent) {
          agent.ws.send(JSON.stringify({
            ...message,
            requestId: pending.originalRequestId,
          }));
        }
        return;
      }
    }

    // Broadcast other messages to all agents
    this.broadcastToAgents(message);
  }

  /**
   * Handle message from an agent
   */
  private handleAgentMessage(agentId: string, message: ServerMessage): void {
    this.log(`Agent ${agentId} message: ${message.type}`);

    if (!this.extensionWs) {
      // No extension connected, send error back
      const agent = this.agents.get(agentId);
      if (agent && message.requestId) {
        agent.ws.send(JSON.stringify({
          type: 'error',
          requestId: message.requestId,
          error: 'No extension connected',
        }));
      }
      return;
    }

    // Generate relay request ID
    const relayRequestId = `relay_${++this.requestIdCounter}`;
    
    // Store pending request mapping (without forwardMessage — no replay)
    this.pendingRequests.set(relayRequestId, {
      agentId,
      originalRequestId: message.requestId,
      lastSentAt: Date.now(),
    });

    // Forward to extension with relay request ID
    this.extensionWs.send(JSON.stringify({
      ...message,
      requestId: relayRequestId,
    }));
  }

  /**
   * Request tools list from extension
   */
  private requestToolsFromExtension(): void {
    if (!this.extensionWs) return;

    const requestId = `relay_${++this.requestIdCounter}`;
    this.extensionWs.send(JSON.stringify({
      type: 'list_tools',
      requestId,
    }));
  }

  /**
   * Reject all pending requests and notify agents of the error.
   * Called when the extension reconnects — responses to in-flight requests
   * from the previous connection are lost, so we surface an error to let
   * the MCP client retry if appropriate.
   */
  private rejectPendingRequests(reason: string): void {
    if (this.pendingRequests.size === 0) return;

    this.log(`Rejecting ${this.pendingRequests.size} pending request(s): ${reason}`);

    for (const [relayRequestId, pending] of this.pendingRequests) {
      const agent = this.agents.get(pending.agentId);
      if (agent) {
        try {
          agent.ws.send(JSON.stringify({
            type: 'error',
            requestId: pending.originalRequestId,
            error: reason,
          }));
        } catch (error) {
          this.log(`Failed to notify agent for ${relayRequestId}: ${error}`);
        }
      }
    }
    this.pendingRequests.clear();
  }

  /**
   * Keep requesting tools until extension responds with tools_list.
   */
  private startToolsSyncLoop(): void {
    this.stopToolsSyncLoop();
    this.requestToolsFromExtension();
    this.toolsSyncTimer = setInterval(() => {
      if (!this.extensionWs) {
        this.stopToolsSyncLoop();
        return;
      }
      this.requestToolsFromExtension();
    }, 1_000);
  }

  private stopToolsSyncLoop(): void {
    if (this.toolsSyncTimer) {
      clearInterval(this.toolsSyncTimer);
      this.toolsSyncTimer = null;
    }
  }

  /**
   * Broadcast message to all connected agents
   */
  private broadcastToAgents(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const agent of this.agents.values()) {
      try {
        agent.ws.send(payload);
      } catch (error) {
        this.log(`Failed to send to agent ${agent.id}: ${error}`);
      }
    }
  }

  /**
   * Shutdown the relay server
   */
  private async shutdown(): Promise<void> {
    this.log('Shutting down relay...');

    // Clean up PID file
    try {
      if (existsSync(PID_FILE)) {
        unlinkSync(PID_FILE);
      }
    } catch (error) {
      // Ignore
    }

    // Close all agent connections
    for (const agent of this.agents.values()) {
      try {
        agent.ws.close();
      } catch (error) {
        // Ignore
      }
    }
    this.agents.clear();

    // Close extension connection
    if (this.extensionWs) {
      this.extensionWs.close();
      this.extensionWs = null;
    }
    this.stopToolsSyncLoop();

    // Close servers
    if (this.agentWss) {
      this.agentWss.close();
      this.agentWss = null;
    }

    if (this.extensionWss) {
      this.extensionWss.close();
      this.extensionWss = null;
    }

    process.exit(0);
  }

  /**
   * Log message
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}`;
    
    if (this.debug) {
      console.error(`[relay] ${message}`);
    }

    // Also append to log file
    try {
      const fs = require('fs');
      fs.appendFileSync(LOG_FILE, line + '\n');
    } catch (error) {
      // Ignore log errors
    }
  }
}

/**
 * Check if relay is already running
 */
export function isRelayRunning(): boolean {
  if (!existsSync(PID_FILE)) {
    return false;
  }

  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    // Check if process is alive
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Process not running, clean up stale PID file
    try {
      unlinkSync(PID_FILE);
    } catch (e) {
      // Ignore
    }
    return false;
  }
}

/**
 * Get relay PID if running
 */
export function getRelayPid(): number | null {
  if (!existsSync(PID_FILE)) {
    return null;
  }

  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return null;
  }
}

/**
 * Start relay as a detached daemon
 */
export function spawnRelayDaemon(debug: boolean = false): void {
  const { spawn } = require('child_process');
  const { dirname } = require('path');

  // Get path to this module (relay.js after compilation)
  const relayScript = join(dirname(__dirname), 'dist', 'relay-daemon.js');
  
  // Spawn detached process
  const child = spawn(process.execPath, [relayScript, debug ? '--debug' : ''], {
    detached: true,
    stdio: 'ignore',
    cwd: VIBE_DIR,
  });

  child.unref();
}

/**
 * Main entry point for relay daemon
 */
export async function startRelayDaemon(debug: boolean = false): Promise<void> {
  const relay = new RelayServer(debug);
  await relay.start();
  
  // Keep process alive
  console.error(`[relay] Daemon running (PID: ${process.pid})`);
}
