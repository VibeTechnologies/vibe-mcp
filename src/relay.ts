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

function parseEnvPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${name} value: ${raw}`);
  }
  return port;
}

// Ports (19888/19889 to avoid conflict with Playwriter MCP which uses 19988/19989)
export const EXTENSION_PORT = parseEnvPort('VIBE_MCP_EXTENSION_PORT', 19889);
export const AGENT_PORT = parseEnvPort('VIBE_MCP_AGENT_PORT', 19888);

// PID file location
const VIBE_DIR = process.env.VIBE_MCP_STATE_DIR || join(homedir(), '.vibe-mcp');
const PID_FILE = join(VIBE_DIR, 'relay.pid');
const LOG_FILE = join(VIBE_DIR, 'relay.log');

/**
 * Message from extension
 */
interface ExtensionMessage {
  type: 'connected' | 'disconnected' | 'tool_result' | 'tools_list' | 'error';
  requestId?: string;
  data?: unknown;
  error?: string;
  sessionId?: string;
}

/**
 * Message to extension
 */
interface ServerMessage {
  type: 'list_tools' | 'call_tool' | 'ping' | 'list_sessions';
  requestId: string;
  data?: {
    name?: string;
    arguments?: Record<string, unknown>;
    sessionId?: string;
  };
}

interface RelaySessionSummary {
  sessionId: string;
  connected: boolean;
  connectedAt: number;
  toolCount: number;
}

interface ExtensionSession {
  ws: WebSocket;
  sessionId: string;
  connectedAt: number;
  tools: unknown[];
  toolsSyncTimer: NodeJS.Timeout | null;
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
  forwardMessage: ServerMessage;
  sessionId: string;
}

/**
 * Vibe MCP Relay Server
 */
export class RelayServer extends EventEmitter {
  private extensionWss: WebSocketServer | null = null;
  private agentWss: WebSocketServer | null = null;
  private extensionSessions: Map<string, ExtensionSession> = new Map();
  private socketToSessionId: Map<WebSocket, string> = new Map();
  private agents: Map<string, AgentConnection> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestIdCounter = 0;
  private anonymousSessionCounter = 0;
  private debug: boolean;

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
    this.log('Extension socket connected; waiting for session handshake');

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
      const sessionId = this.socketToSessionId.get(ws);
      this.log(`Extension disconnected${sessionId ? ` (${sessionId})` : ''} (code=${code}${reason ? `, reason=${reason}` : ''})`);
      if (!sessionId) {
        return;
      }

      const session = this.extensionSessions.get(sessionId);
      if (!session || session.ws !== ws) {
        this.socketToSessionId.delete(ws);
        return;
      }

      this.socketToSessionId.delete(ws);
      this.extensionSessions.delete(sessionId);
      this.stopToolsSyncLoop(session);
      this.rejectPendingRequestsForSession(sessionId, `Extension session disconnected: ${sessionId}`);
      this.broadcastSessionState();
      if (this.extensionSessions.size === 0) {
        this.broadcastToAgents({ type: 'extension_disconnected' });
      }
    });

    ws.on('error', (error) => {
      this.log(`Extension WebSocket error: ${error.message}`);
    });

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

    this.sendSessionStateToAgent(ws);

    const defaultSession = this.getDefaultSession();
    if (defaultSession && defaultSession.tools.length > 0) {
      ws.send(JSON.stringify({ type: 'tools_list', data: defaultSession.tools, sessionId: defaultSession.sessionId }));
    }

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
    const session = this.ensureSessionForSocket(sourceWs, message);
    if (!session) {
      this.log(`Ignoring extension message before handshake: ${message.type}`);
      return;
    }

    this.log(`Extension message (${session.sessionId}): ${message.type}`);

    if (message.type === 'connected') {
      return;
    }

    // Handle response to a pending request first — this must run before the
    // tools_list broadcast so that `refreshTools()` resolves promptly instead
    // of waiting for its 30 s timeout.
    if (message.requestId) {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        this.pendingRequests.delete(message.requestId);

        // Forward response to the requesting agent
        const agent = this.agents.get(pending.agentId);
        if (agent) {
          agent.ws.send(JSON.stringify({
            ...message,
            sessionId: session.sessionId,
            requestId: pending.originalRequestId,
          }));
        }

        // For tools_list we still want to cache + broadcast to *other* agents
        // so they stay in sync, but the requesting agent already got its copy.
        if (message.type === 'tools_list') {
          session.tools = message.data as unknown[];
          this.stopToolsSyncLoop(session);
          this.broadcastToAgents({ type: 'tools_list', data: session.tools, sessionId: session.sessionId }, pending.agentId);
          this.broadcastSessionState();
        }
        return;
      }
    }

    // Handle unsolicited tools list (e.g. extension announces on connect)
    if (message.type === 'tools_list') {
      session.tools = message.data as unknown[];
      this.stopToolsSyncLoop(session);
      this.broadcastToAgents({ type: 'tools_list', data: session.tools, sessionId: session.sessionId });
      this.broadcastSessionState();
      return;
    }

    // Broadcast other messages to all agents
    this.broadcastToAgents({ ...message, sessionId: session.sessionId });
  }

  /**
   * Handle message from an agent
   */
  private handleAgentMessage(agentId: string, message: ServerMessage): void {
    this.log(`Agent ${agentId} message: ${message.type}`);

    if (message.type === 'list_sessions') {
      const agent = this.agents.get(agentId);
      if (agent && message.requestId) {
        agent.ws.send(JSON.stringify({
          type: 'sessions_list',
          requestId: message.requestId,
          sessions: this.buildSessionsList(),
        }));
      }
      return;
    }

    const requestedSessionId = typeof message.data?.sessionId === 'string' ? message.data.sessionId : undefined;
    const targetSession = this.resolveTargetSession(requestedSessionId);

    if (!targetSession) {
      // No extension connected, send error back
      const agent = this.agents.get(agentId);
      if (agent && message.requestId) {
        agent.ws.send(JSON.stringify({
          type: 'error',
          requestId: message.requestId,
          error: requestedSessionId
            ? `No browser session connected for sessionId=${requestedSessionId}`
            : 'No extension connected',
        }));
      }
      return;
    }

    // Generate relay request ID
    const relayRequestId = `relay_${++this.requestIdCounter}`;
    const cleanData = message.data ? { ...message.data } : undefined;
    if (cleanData && 'sessionId' in cleanData) {
      delete cleanData.sessionId;
    }
    const forwardMessage: ServerMessage = {
      ...message,
      requestId: relayRequestId,
      ...(cleanData ? { data: cleanData } : {}),
    };

    // Store pending request mapping so it can be replayed if the extension
    // swaps sockets mid-flight.
    this.pendingRequests.set(relayRequestId, {
      agentId,
      originalRequestId: message.requestId,
      lastSentAt: Date.now(),
      forwardMessage,
      sessionId: targetSession.sessionId,
    });

    // Forward to extension with relay request ID
    targetSession.ws.send(JSON.stringify(forwardMessage));
  }

  /**
   * Request tools list from extension
   */
  private requestToolsFromExtension(session: ExtensionSession): void {
    if (session.ws.readyState !== WebSocket.OPEN) return;

    const requestId = `relay_${++this.requestIdCounter}`;
    session.ws.send(JSON.stringify({
      type: 'list_tools',
      requestId,
    }));
  }

  /**
   * Replay pending requests on a replacement extension connection.
   *
   * The browser-side client deduplicates repeated request IDs, so keeping the
   * same relay request ID lets us survive a transient socket swap without
   * dropping the original MCP call or double-running it under normal reconnects.
   */
  private replayPendingRequests(session: ExtensionSession): void {
    if (this.pendingRequests.size === 0) return;
    if (session.ws.readyState !== WebSocket.OPEN) return;

    const pendingForSession = [...this.pendingRequests.entries()].filter(([, pending]) => pending.sessionId === session.sessionId);
    if (pendingForSession.length === 0) return;

    this.log(`Replaying ${pendingForSession.length} pending request(s) on replacement connection for ${session.sessionId}`);

    for (const [relayRequestId, pending] of pendingForSession) {
      pending.lastSentAt = Date.now();
      try {
        session.ws.send(JSON.stringify(pending.forwardMessage));
      } catch (error) {
        this.log(`Failed to replay ${relayRequestId}: ${error}`);
      }
    }
  }

  /**
   * Keep requesting tools until extension responds with tools_list.
   */
  private startToolsSyncLoop(session: ExtensionSession): void {
    this.stopToolsSyncLoop(session);
    this.requestToolsFromExtension(session);
    session.toolsSyncTimer = setInterval(() => {
      if (session.ws.readyState !== WebSocket.OPEN) {
        this.stopToolsSyncLoop(session);
        return;
      }
      this.requestToolsFromExtension(session);
    }, 1_000);
  }

  private stopToolsSyncLoop(session: ExtensionSession): void {
    if (session.toolsSyncTimer) {
      clearInterval(session.toolsSyncTimer);
      session.toolsSyncTimer = null;
    }
  }

  /**
   * Broadcast message to all connected agents
   */
  private broadcastToAgents(message: unknown, excludeAgentId?: string): void {
    const payload = JSON.stringify(message);
    for (const agent of this.agents.values()) {
      if (agent.id === excludeAgentId) continue;
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

    // Close extension connections
    for (const session of this.extensionSessions.values()) {
      try {
        session.ws.close();
      } catch (error) {
        // Ignore
      }
      this.stopToolsSyncLoop(session);
    }
    this.extensionSessions.clear();
    this.socketToSessionId.clear();

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

  private ensureSessionForSocket(ws: WebSocket, message: ExtensionMessage): ExtensionSession | null {
    const existingSessionId = this.socketToSessionId.get(ws);
    if (existingSessionId) {
      return this.extensionSessions.get(existingSessionId) || null;
    }

    const announcedSessionId = this.extractAnnouncedSessionId(message) || `session_${++this.anonymousSessionCounter}`;
    const existing = this.extensionSessions.get(announcedSessionId);

    if (existing) {
      const previousWs = existing.ws;
      if (previousWs !== ws) {
        this.log(`Extension session ${announcedSessionId} reconnecting, replacing previous socket`);
        this.socketToSessionId.delete(previousWs);
        existing.ws = ws;
        existing.connectedAt = Date.now();
        this.socketToSessionId.set(ws, announcedSessionId);
        this.broadcastSessionState();
        this.startToolsSyncLoop(existing);
        this.replayPendingRequests(existing);
        try {
          previousWs.close();
        } catch (error) {
          // ignore close errors on replaced sockets
        }
      }
      return existing;
    }

    const session: ExtensionSession = {
      ws,
      sessionId: announcedSessionId,
      connectedAt: Date.now(),
      tools: [],
      toolsSyncTimer: null,
    };
    this.extensionSessions.set(announcedSessionId, session);
    this.socketToSessionId.set(ws, announcedSessionId);
    this.broadcastSessionState();
    this.startToolsSyncLoop(session);
    return session;
  }

  private extractAnnouncedSessionId(message: ExtensionMessage): string | undefined {
    if (typeof message.sessionId === 'string' && message.sessionId.trim().length > 0) {
      return message.sessionId.trim();
    }
    if (message.data && typeof message.data === 'object') {
      const candidate = (message.data as Record<string, unknown>).sessionId;
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    return undefined;
  }

  private buildSessionsList(): RelaySessionSummary[] {
    return [...this.extensionSessions.values()].map((session) => ({
      sessionId: session.sessionId,
      connected: session.ws.readyState === WebSocket.OPEN,
      connectedAt: session.connectedAt,
      toolCount: session.tools.length,
    }));
  }

  private getDefaultSession(): ExtensionSession | null {
    for (const session of this.extensionSessions.values()) {
      if (session.ws.readyState === WebSocket.OPEN) {
        return session;
      }
    }
    return null;
  }

  private resolveTargetSession(requestedSessionId?: string): ExtensionSession | null {
    if (requestedSessionId) {
      const session = this.extensionSessions.get(requestedSessionId);
      if (session && session.ws.readyState === WebSocket.OPEN) {
        return session;
      }
      return null;
    }
    return this.getDefaultSession();
  }

  private sendSessionStateToAgent(ws: WebSocket): void {
    const sessions = this.buildSessionsList();
    const defaultSession = this.getDefaultSession();
    ws.send(JSON.stringify({
      type: 'sessions_list',
      sessions,
      sessionIds: sessions.map((session) => session.sessionId),
      connected: sessions.some((session) => session.connected),
      sessionId: defaultSession?.sessionId,
    }));
    ws.send(JSON.stringify({
      type: 'extension_status',
      connected: sessions.some((session) => session.connected),
      sessionIds: sessions.map((session) => session.sessionId),
      sessionId: defaultSession?.sessionId,
    }));
  }

  private broadcastSessionState(): void {
    const sessions = this.buildSessionsList();
    const defaultSession = this.getDefaultSession();
    this.broadcastToAgents({
      type: 'sessions_list',
      sessions,
      sessionIds: sessions.map((session) => session.sessionId),
      connected: sessions.some((session) => session.connected),
      sessionId: defaultSession?.sessionId,
    });
    this.broadcastToAgents({
      type: 'extension_status',
      connected: sessions.some((session) => session.connected),
      sessionIds: sessions.map((session) => session.sessionId),
      sessionId: defaultSession?.sessionId,
    });
  }

  private rejectPendingRequestsForSession(sessionId: string, errorMessage: string): void {
    for (const [relayId, pending] of this.pendingRequests) {
      if (pending.sessionId !== sessionId) {
        continue;
      }
      this.pendingRequests.delete(relayId);
      const agent = this.agents.get(pending.agentId);
      if (agent && agent.ws.readyState === WebSocket.OPEN) {
        agent.ws.send(JSON.stringify({
          type: 'error',
          requestId: pending.originalRequestId,
          error: errorMessage,
          sessionId,
        }));
      }
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
    env: process.env,
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
