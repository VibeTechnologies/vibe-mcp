/**
 * Vibe MCP Server - Relay Connection
 * 
 * Connects to the relay server as a WebSocket client.
 * Supports two modes:
 *   - Local: connects to local relay daemon at ws://127.0.0.1:19888
 *   - Remote: connects to public relay at wss://relay.api.vibebrowser.app/<uuid>
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import {
  ConnectionStatus,
  ExtensionMessage,
  RelaySessionSummary,
  ServerMessage,
  ToolDefinition,
  ToolResult,
} from './types.js';
import { isRelayRunning, AGENT_PORT, EXTENSION_PORT } from './relay.js';

const NO_CONNECTION_MESSAGE = `No connection to Vibe extension. Please:
1. Install the Vibe AI Browser extension from https://vibebrowser.app
2. Click the Vibe extension icon in Chrome
3. Enable "MCP External Control" in Settings`;

const NO_CONNECTION_REMOTE_MESSAGE = `No connection to Vibe extension via remote relay. Please:
1. Install the Vibe AI Browser extension from https://vibebrowser.app
2. Open extension Settings > MCP External
3. Select "Remote" mode and note your Extension UUID
4. Make sure the extension is connected to the relay`;

const RELAY_CONNECT_TIMEOUT = 10000;
const RELAY_RECONNECT_DELAY = 2000;

const DEFAULT_RELAY_URL = 'wss://relay.api.vibebrowser.app';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REMOTE_SECRET_PATTERN = /^[a-f0-9]{64}$/;
const REMOTE_SECRET_ERROR = 'Invalid remote secret: expected 64 lowercase hex characters';

/**
 * Remote relay configuration
 */
export interface RemoteConfig {
  uuid: string;
  relayUrl?: string; // defaults to DEFAULT_RELAY_URL
  secret?: string; // optional bearer token for relay second-factor auth
}

export interface ParsedRemoteRelayUrl {
  relayUrl: string;
  uuid: string;
}

function isRemoteRelayUrl(value: string): boolean {
  return /^wss?:\/\//i.test(value);
}

export function parseRemoteRelayUrl(value: string): ParsedRemoteRelayUrl {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid remote relay URL: ${message}`);
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('Invalid remote relay URL: protocol must be ws:// or wss://');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Invalid remote relay URL: credentials in URL are not allowed (use --remote-secret / VIBE_REMOTE_SECRET)');
  }

  if (parsed.search || parsed.hash) {
    throw new Error('Invalid remote relay URL: query/fragments are not allowed (use --remote-secret / VIBE_REMOTE_SECRET)');
  }

  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  const uuid = pathSegments[pathSegments.length - 1];
  if (!uuid) {
    throw new Error('Invalid remote relay URL: missing UUID path segment');
  }

  pathSegments.pop();
  parsed.pathname = pathSegments.length > 0 ? `/${pathSegments.join('/')}` : '';
  parsed.search = '';
  parsed.hash = '';

  return {
    relayUrl: parsed.toString().replace(/\/$/, ''),
    uuid,
  };
}

export function normalizeRemoteSecret(secret?: string): string | undefined {
  if (secret === undefined) {
    return undefined;
  }

  const trimmed = secret.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (!REMOTE_SECRET_PATTERN.test(trimmed)) {
    throw new Error(REMOTE_SECRET_ERROR);
  }

  return trimmed;
}

function parseRemoteTarget(value: string, currentRelayUrl?: string): ParsedRemoteRelayUrl {
  if (isRemoteRelayUrl(value)) {
    return parseRemoteRelayUrl(value);
  }

  if (!UUID_PATTERN.test(value)) {
    throw new Error('Invalid remote target: expected a UUID or ws(s) relay URL');
  }

  return {
    relayUrl: (currentRelayUrl || DEFAULT_RELAY_URL).replace(/\/$/, ''),
    uuid: value,
  };
}

export function normalizeRemoteConfig(remote?: RemoteConfig): RemoteConfig | undefined {
  if (!remote) {
    return undefined;
  }

  const secret = normalizeRemoteSecret(remote.secret);
  const relayUrl = remote.relayUrl?.replace(/\/$/, '');
  if (!isRemoteRelayUrl(remote.uuid)) {
    return { uuid: remote.uuid, relayUrl, secret };
  }

  const parsed = parseRemoteRelayUrl(remote.uuid);
  if (relayUrl && relayUrl !== parsed.relayUrl) {
    throw new Error(`Remote relay URL mismatch: remote URL includes ${parsed.relayUrl}, but configured relay URL is ${relayUrl}`);
  }

  return {
    uuid: parsed.uuid,
    relayUrl: relayUrl || parsed.relayUrl,
    secret,
  };
}

export interface LocalSessionConfig {
  sessionId?: string;
}

/**
 * Pending request waiting for response
 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  timeoutMs: number;
}

/**
 * Relay connection manager
 * 
 * Connects to a relay server (local or remote) to reach the extension.
 */
export class ExtensionConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestIdCounter = 0;
  private port: number;
  private debug: boolean;
  private tools: ToolDefinition[] = [];
  private sessions: RelaySessionSummary[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private extensionConnected: boolean = false;
  private remoteConfig: RemoteConfig | null = null;
  private localSessionConfig: LocalSessionConfig;
  private stopping = false;

  constructor(port: number = AGENT_PORT, debug: boolean = false, remote?: RemoteConfig, localSessionConfig?: LocalSessionConfig) {
    super();
    this.port = port;
    this.debug = debug;
    this.remoteConfig = normalizeRemoteConfig(remote) || null;
    this.localSessionConfig = localSessionConfig || {};
  }

  /**
   * Start connection to relay server.
   * In local mode: spawns relay daemon if needed, then connects.
   * In remote mode: connects directly to public relay.
   */
  async start(): Promise<void> {
    this.stopping = false;
    if (this.remoteConfig) {
      this.log(`Remote mode: connecting to relay for UUID ${this.remoteConfig.uuid}`);
      await this.connectToRelay();
      return;
    }

    // Local mode: check if relay is already running
    if (!isRelayRunning()) {
      this.log('Starting relay daemon...');
      await this.spawnRelay();
      // Wait for relay to start
      await this.waitForRelay();
    }

    // Connect to relay
    await this.connectToRelay();
  }

  async setRemoteUrl(url: string, secret?: string, preserveExistingSecret: boolean = true): Promise<ParsedRemoteRelayUrl> {
    const parsed = parseRemoteTarget(url, this.remoteConfig?.relayUrl);
    const normalizedSecret = normalizeRemoteSecret(secret);
    const nextSecret = preserveExistingSecret
      ? this.remoteConfig?.secret
      : normalizedSecret;

    this.stopping = true;
    this.clearReconnectTimer();
    this.rejectPendingRequests(new Error('Remote relay changed'));
    this.closeSocket();

    this.remoteConfig = { uuid: parsed.uuid, relayUrl: parsed.relayUrl, secret: nextSecret };
    this.tools = [];
    this.sessions = [];
    this.extensionConnected = false;
    this.status = 'disconnected';
    this.emit('tools_updated', this.tools);
    this.emit('extension_status', false);

    this.stopping = false;
    await this.connectToRelay();
    return parsed;
  }

  /**
   * Spawn relay daemon as detached process (local mode only)
   */
  private async spawnRelay(): Promise<void> {
    // Use __dirname equivalent for ESM
    const relayScript = join(dirname(new URL(import.meta.url).pathname), 'relay-daemon.js');
    
    const child = spawn(process.execPath, [relayScript, this.debug ? '--debug' : ''], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    
    child.unref();
    this.log('Relay daemon spawned');
  }

  /**
   * Wait for local relay to become available
   */
  private async waitForRelay(): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < RELAY_CONNECT_TIMEOUT) {
      try {
        // Try to connect
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
          const timeout = setTimeout(() => {
            ws.removeAllListeners();
            ws.terminate();
            reject(new Error('Timeout'));
          }, 1000);
          
          ws.on('open', () => {
            clearTimeout(timeout);
            ws.removeAllListeners();
            ws.terminate();
            resolve();
          });
          
          ws.on('error', () => {
            clearTimeout(timeout);
            reject(new Error('Connection failed'));
          });
        });
        
        this.log('Relay is ready');
        return;
      } catch (error) {
        // Relay not ready yet, wait and retry
        await new Promise(r => setTimeout(r, 200));
      }
    }
    
    throw new Error('Relay failed to start within timeout');
  }

  /**
   * Get the WebSocket URL for connection.
   * Local mode: ws://127.0.0.1:<port>
   * Remote mode: wss://relay.api.vibebrowser.app/<uuid>
   */
  private getRelayUrl(): string {
    if (this.remoteConfig) {
      const base = this.remoteConfig.relayUrl || DEFAULT_RELAY_URL;
      return `${base}/${this.remoteConfig.uuid}`;
    }
    return `ws://127.0.0.1:${this.port}`;
  }

  getRemoteConfig(): RemoteConfig | null {
    return this.remoteConfig ? { ...this.remoteConfig } : null;
  }

  /**
   * Connect to the relay server (local or remote)
   */
  private async connectToRelay(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.getRelayUrl();
      this.log(`Connecting to relay at ${url}...`);

      try {
        const wsHeaders = this.remoteConfig?.secret
          ? { Authorization: `Bearer ${this.remoteConfig.secret}` }
          : undefined;
        this.ws = wsHeaders
          ? new WebSocket(url, { headers: wsHeaders })
          : new WebSocket(url);

        this.ws.on('open', () => {
          this.log('Connected to relay');
          this.status = 'connected';
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (error) {
            this.log(`Failed to parse message: ${error}`);
          }
        });

        this.ws.on('close', () => {
          this.log('Disconnected from relay');
          this.ws = null;
          this.status = 'disconnected';

          // Reject all pending requests — responses will never arrive on a
          // closed socket.  Without this, requests sit until their individual
          // timeouts fire, and if the server reconnects before that the MCP
          // client may retry, causing duplicate tool execution.
          for (const [id, request] of this.pendingRequests) {
            clearTimeout(request.timeout);
            request.reject(new Error('Relay connection lost'));
          }
          this.pendingRequests.clear();

          this.emit('disconnected');

          if (!this.stopping) {
            // Schedule reconnect
            this.scheduleReconnect();
          }
        });

        this.ws.on('error', (error) => {
          this.log(`WebSocket error: ${error.message}`);
          reject(error);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(async () => {
      this.log('Attempting to reconnect to relay...');
      try {
        await this.connectToRelay();
      } catch (error) {
        this.log(`Reconnect failed: ${error}`);
        this.scheduleReconnect();
      }
    }, RELAY_RECONNECT_DELAY);
  }

  /**
   * Stop the connection
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearReconnectTimer();

    this.rejectPendingRequests(new Error('Connection closed'));
    this.closeSocket();

    this.status = 'disconnected';
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const [, request] of this.pendingRequests) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pendingRequests.clear();
  }

  private closeSocket(): void {
    if (!this.ws) {
      return;
    }

    // Remove listeners so a deliberate reconnect does not trigger stale close
    // handlers or schedule a reconnect against the previous relay URL.
    this.ws.removeAllListeners();
    this.ws.terminate();
    this.ws = null;
  }

  /**
   * Handle message from relay
   */
  private handleMessage(message: ExtensionMessage): void {
    this.log(`Received: ${message.type}`);

    // Handle extension status updates
    if (message.type === 'extension_status') {
      this.extensionConnected = message.connected ?? false;
      this.emit('extension_status', this.extensionConnected);
      return;
    }

    if (message.type === 'extension_disconnected') {
      this.extensionConnected = false;
      this.tools = [];
      this.sessions = [];
      this.emit('extension_disconnected');
      return;
    }

    // Handle responses to pending requests
    if (message.requestId) {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        // Progress signals reset the timeout without completing the request.
        // The extension sends these periodically for long-running tools so
        // the client doesn't time out prematurely.
        if (message.type === 'tool_progress') {
          clearTimeout(pending.timeout);
          pending.timeout = setTimeout(() => {
            this.pendingRequests.delete(message.requestId!);
            pending.reject(new Error(`Request timed out (progress-extended)`));
          }, pending.timeoutMs);
          return;
        }

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.requestId);

        if (message.type === 'error') {
          pending.reject(new Error(message.error || 'Unknown error'));
        } else {
          let payload: unknown = message.data;
          if (message.type === 'sessions_list') {
            payload = Array.isArray(message.sessions) ? message.sessions : message.data;
            this.sessions = Array.isArray(payload) ? payload as RelaySessionSummary[] : [];
            if (!this.remoteConfig) {
              const selected = this.resolveRequestedSessionId(this.sessions);
              this.extensionConnected = this.sessions.some((session) => session.sessionId === selected && session.connected);
            }
            this.emit('sessions_updated', this.sessions);
          }
          pending.resolve(payload);
        }
        return;
      }
    }

    if (message.type === 'sessions_list') {
      this.sessions = Array.isArray(message.sessions)
        ? message.sessions
        : Array.isArray(message.data)
          ? message.data as RelaySessionSummary[]
          : [];

      if (!this.remoteConfig) {
        const selected = this.resolveRequestedSessionId(this.sessions);
        this.extensionConnected = this.sessions.some((session) => session.sessionId === selected && session.connected);
      }
      this.emit('sessions_updated', this.sessions);
      return;
    }

    // Handle unsolicited messages
    switch (message.type) {
      case 'tools_list':
        this.tools = message.data as ToolDefinition[];
        if (this.remoteConfig) {
          this.extensionConnected = true;
        } else if (this.sessions.length === 0) {
          this.extensionConnected = true;
        }
        this.emit('tools_updated', this.tools);
        break;

      case 'error':
        this.log(`Error: ${message.error}`);
        break;
    }
  }

  /**
   * Send a message to the extension via relay and wait for response
   */
  private async sendRequest<T>(
    type: ServerMessage['type'],
    data?: ServerMessage['data'],
    timeoutMs: number = 30000
  ): Promise<T> {
    if (!this.ws || this.status !== 'connected') {
      throw new Error('Not connected to relay');
    }

    const requestId = `req_${++this.requestIdCounter}`;
    
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        timeoutMs,
      });

      const enrichedData = this.withSessionSelection(data);
      const message: ServerMessage = { type, requestId, data: enrichedData };
      this.ws!.send(JSON.stringify(message));
      this.log(`Sent: ${type} (${requestId})`);
    });
  }

  private withSessionSelection(data?: ServerMessage['data']): ServerMessage['data'] | undefined {
    if (this.remoteConfig) {
      return data;
    }

    const sessionId = this.resolveRequestedSessionId(this.sessions);
    if (!sessionId) {
      return data;
    }

    return {
      ...(data || {}),
      sessionId,
    };
  }

  private resolveRequestedSessionId(sessions: RelaySessionSummary[]): string | undefined {
    if (this.localSessionConfig.sessionId) {
      return this.localSessionConfig.sessionId;
    }

    const firstConnected = sessions.find((session) => session.connected);
    return firstConnected?.sessionId;
  }

  private getRequestedSessionConnectionError(sessions: RelaySessionSummary[] = this.sessions): string | undefined {
    if (this.remoteConfig || !this.localSessionConfig.sessionId || sessions.length === 0) {
      return undefined;
    }

    const requested = this.localSessionConfig.sessionId;
    const matched = sessions.find((session) => session.sessionId === requested);
    if (!matched || !matched.connected) {
      return `No browser session connected for sessionId=${requested}`;
    }

    return undefined;
  }

  getConnectionErrorMessage(): string {
    if (this.remoteConfig) {
      return NO_CONNECTION_REMOTE_MESSAGE;
    }

    return this.getRequestedSessionConnectionError() || NO_CONNECTION_MESSAGE;
  }

  /**
   * Refresh available tools from extension
   */
  async refreshTools(timeoutMs: number = 30_000): Promise<ToolDefinition[]> {
    const tools = await this.sendRequest<ToolDefinition[]>('list_tools', undefined, timeoutMs);
    this.tools = tools;
    return tools;
  }

  async listSessions(timeoutMs: number = 5_000): Promise<RelaySessionSummary[]> {
    if (this.remoteConfig) {
      const session: RelaySessionSummary = {
        sessionId: this.remoteConfig.uuid,
        connected: this.extensionConnected,
        toolCount: this.tools.length,
      };
      this.sessions = [session];
      return this.sessions;
    }

    const sessions = await this.sendRequest<RelaySessionSummary[]>('list_sessions', undefined, timeoutMs);
    this.sessions = Array.isArray(sessions) ? sessions : [];
    const selected = this.resolveRequestedSessionId(this.sessions);
    this.extensionConnected = this.sessions.some((session) => session.sessionId === selected && session.connected);
    return this.sessions;
  }

  /**
   * Wait briefly for a tools update event without forcing a request.
   * This keeps MCP startup responsive when extension announces tools asynchronously.
   */
  async waitForToolsUpdate(timeoutMs: number = 1_500): Promise<ToolDefinition[]> {
    if (this.tools.length > 0) {
      return this.tools;
    }

    let resolved = false;

    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('tools_updated', onToolsUpdated);
        this.off('extension_disconnected', onExtensionDisconnected);
      };
      const onToolsUpdated = (tools: ToolDefinition[]) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(tools);
      };
      const onExtensionDisconnected = () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(this.tools);
      };
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(this.tools);
      }, timeoutMs);

      this.on('tools_updated', onToolsUpdated);
      this.on('extension_disconnected', onExtensionDisconnected);
    });
  }

  /**
   * Get cached list of available tools
   */
  getTools(): ToolDefinition[] {
    return this.tools;
  }

  getSessions(): RelaySessionSummary[] {
    return this.sessions;
  }

  /**
   * Call a tool on the extension
   */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult> {
    return this.sendRequest<ToolResult>(
      'call_tool',
      { name, arguments: args },
      timeoutMs,
    );
  }

  /**
   * Check if extension is connected (via relay)
   */
  isConnected(): boolean {
    return this.status === 'connected' && this.extensionConnected;
  }

  /**
   * Get connection status
   */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Check if extension is connected to relay
   */
  isExtensionConnected(): boolean {
    return this.extensionConnected;
  }

  /**
   * Log message if debug is enabled
   */
  private log(message: string): void {
    if (this.debug) {
      console.error(`[vibebrowser-mcp] ${message}`);
    }
  }
}
