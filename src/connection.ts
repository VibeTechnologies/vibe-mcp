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
export const DEFAULT_RELAY_HANDSHAKE_TIMEOUT_MS = 10_000;
export const REDACTED_REMOTE_ID = '[redacted]';

const DEFAULT_RELAY_URL = 'wss://relay.api.vibebrowser.app';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MCP_CONNECTOR_SEGMENT = 'mcp';
const PERMANENT_RELAY_CLOSE_CODES = new Set([
  1002, 1003, 1007, 1008,
  4001, 4003, 4004, 4009,
  4401, 4403,
]);
const PERMANENT_RELAY_HTTP_STATUS_CODES = new Set([400, 401, 403, 404]);

/**
 * Remote relay configuration.
 *
 * The routing UUID (in the wss URL path) is the sole bearer capability for
 * relay access. Treat it like a password: if it leaks, regenerate it in the
 * Vibe extension Settings. There is no second-factor secret/attach token.
 */
export interface RemoteConfig {
  uuid: string;
  relayUrl?: string; // defaults to DEFAULT_RELAY_URL
}

export interface ParsedRemoteRelayUrl {
  relayUrl: string;
  uuid: string;
}

export interface RelayCloseInfo {
  code: number;
  reason: string;
  permanent: boolean;
}

export function isPermanentRelayCloseCode(code: number): boolean {
  return PERMANENT_RELAY_CLOSE_CODES.has(code);
}

export function isPermanentRelayHttpStatus(statusCode: number): boolean {
  return PERMANENT_RELAY_HTTP_STATUS_CODES.has(statusCode);
}

export function redactRemoteTarget(message: string, target?: string): string {
  if (!target) {
    return message;
  }

  const candidates = new Set([target]);
  try {
    const parsed = new URL(target);
    const uuid = parsed.pathname.split('/').filter(Boolean).at(-1);
    if (uuid) candidates.add(uuid);
  } catch {
    // A bare UUID is already included as the target candidate.
  }

  return [...candidates]
    .sort((a, b) => b.length - a.length)
    .reduce((redacted, candidate) => {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return redacted.replace(new RegExp(escaped, 'gi'), REDACTED_REMOTE_ID);
    }, message);
}

function isRemoteRelayUrl(value: string): boolean {
  return /^wss?:\/\//i.test(value);
}

function isHttpConnectorUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isRemoteTargetUrl(value: string): boolean {
  return isRemoteRelayUrl(value) || isHttpConnectorUrl(value);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }

  const octets = normalized.split('.');
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

function validateRelayUrl(parsed: URL): void {
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('Invalid remote relay URL: protocol must be ws:// or wss://');
  }
  if (parsed.protocol === 'ws:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error('Invalid remote relay URL: non-loopback relays must use wss://');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Invalid remote relay URL: credentials in URL are not allowed');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Invalid remote relay URL: query/fragments are not allowed');
  }
}

function normalizeRelayBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid remote relay URL');
  }

  validateRelayUrl(parsed);
  return parsed.toString().replace(/\/$/, '');
}

export function parseRemoteRelayUrl(value: string): ParsedRemoteRelayUrl {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid remote relay URL: ${message}`);
  }

  validateRelayUrl(parsed);

  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  const uuid = pathSegments[pathSegments.length - 1];
  if (!uuid) {
    throw new Error('Invalid remote relay URL: missing UUID path segment');
  }
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error('Invalid remote relay URL: UUID path segment is not valid');
  }

  pathSegments.pop();
  parsed.pathname = pathSegments.length > 0 ? `/${pathSegments.join('/')}` : '';
  parsed.search = '';
  parsed.hash = '';

  return {
    relayUrl: normalizeRelayBaseUrl(parsed.toString()),
    uuid,
  };
}

/**
 * Parse the canonical HTTPS MCP connector URL exposed in the extension UI:
 *   https://host[/prefix]/mcp/<uuid>  -> relayUrl wss://host[/prefix]
 *   http://<loopback>[/prefix]/mcp/<uuid> -> relayUrl ws://<loopback>[/prefix]
 *
 * Error messages intentionally never echo the input value or the UUID, since
 * this value is a bearer credential.
 */
export function parseHttpMcpConnectorUrl(value: string): ParsedRemoteRelayUrl {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid MCP connector URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid MCP connector URL: protocol must be http:// or https://');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Invalid MCP connector URL: credentials in URL are not allowed');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Invalid MCP connector URL: query/fragments are not allowed');
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  const uuid = segments.pop();
  const mcpSegment = segments.pop();
  if (!uuid || mcpSegment !== MCP_CONNECTOR_SEGMENT) {
    throw new Error('Invalid MCP connector URL: expected an MCP connector path ending in /mcp/<uuid>');
  }
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error('Invalid MCP connector URL: UUID path segment is not valid');
  }

  const relayProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = segments.length > 0 ? `/${segments.join('/')}` : '';
  parsed.search = '';
  parsed.hash = '';
  parsed.protocol = relayProtocol;

  return {
    relayUrl: normalizeRelayBaseUrl(parsed.toString()),
    uuid,
  };
}

export function parseRemoteTarget(value: string, currentRelayUrl?: string): ParsedRemoteRelayUrl {
  if (isRemoteRelayUrl(value)) {
    return parseRemoteRelayUrl(value);
  }

  if (isHttpConnectorUrl(value)) {
    return parseHttpMcpConnectorUrl(value);
  }

  if (!UUID_PATTERN.test(value)) {
    throw new Error('Invalid remote target: expected a UUID, an https://host/mcp/<uuid> connector URL, or a ws(s) relay URL');
  }

  return {
    relayUrl: normalizeRelayBaseUrl(currentRelayUrl || DEFAULT_RELAY_URL),
    uuid: value,
  };
}

export function normalizeRemoteConfig(remote?: RemoteConfig): RemoteConfig | undefined {
  if (!remote) {
    return undefined;
  }

  const relayUrl = remote.relayUrl ? normalizeRelayBaseUrl(remote.relayUrl) : undefined;
  const parsed = parseRemoteTarget(remote.uuid, relayUrl);
  if (relayUrl && isRemoteTargetUrl(remote.uuid) && relayUrl !== parsed.relayUrl) {
    throw new Error('Remote relay URL mismatch');
  }

  return {
    uuid: parsed.uuid,
    relayUrl: parsed.relayUrl,
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
  private connectionGeneration = 0;
  private lifecycleEpoch = 0;
  private shutdownEpoch = 0;
  private startPromise: Promise<void> | null = null;
  private remoteUpdate: Promise<void> = Promise.resolve();
  private reconnectSuppressed = false;
  private lastClose: { code: number; reason: string } | null = null;
  private readonly handshakeTimeoutMs: number;

  constructor(
    port: number = AGENT_PORT,
    debug: boolean = false,
    remote?: RemoteConfig,
    localSessionConfig?: LocalSessionConfig,
    handshakeTimeoutMs: number = DEFAULT_RELAY_HANDSHAKE_TIMEOUT_MS,
    private readonly reconnectDelayMs: number = RELAY_RECONNECT_DELAY,
  ) {
    super();
    this.port = port;
    this.debug = debug;
    this.remoteConfig = normalizeRemoteConfig(remote) || null;
    this.localSessionConfig = localSessionConfig || {};
    this.handshakeTimeoutMs = handshakeTimeoutMs;
  }

  /**
   * Start connection to relay server.
   * In local mode: spawns relay daemon if needed, then connects.
   * In remote mode: connects directly to public relay.
   */
  start(): Promise<void> {
    if (this.ws && this.status === 'connected') {
      return Promise.resolve();
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const operation = (async () => {
      this.stopping = false;
      this.reconnectSuppressed = false;
      const lifecycleEpoch = ++this.lifecycleEpoch;
      if (this.remoteConfig) {
        this.log('Remote mode: connecting to configured relay target');
        await this.connectToRelay(lifecycleEpoch);
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
      await this.connectToRelay(lifecycleEpoch);
    })();

    this.startPromise = operation;
    void operation.finally(() => {
      if (this.startPromise === operation) {
        this.startPromise = null;
      }
    }).catch(() => {});
    return operation;
  }

  async setRemoteUrl(url: string): Promise<ParsedRemoteRelayUrl> {
    if (this.stopping) {
      throw new Error('Connection closed');
    }
    const shutdownEpoch = this.shutdownEpoch;
    const update = this.remoteUpdate.then(async () => {
      if (this.stopping || shutdownEpoch !== this.shutdownEpoch) {
        throw new Error('Connection closed');
      }

      const parsed = parseRemoteTarget(url, this.remoteConfig?.relayUrl);
      const lifecycleEpoch = ++this.lifecycleEpoch;

      this.clearReconnectTimer();
      this.rejectPendingRequests(new Error('Remote relay changed'));
      this.closeSocket();

      this.remoteConfig = { uuid: parsed.uuid, relayUrl: parsed.relayUrl };
      this.status = 'disconnected';
      this.lastClose = null;
      this.reconnectSuppressed = false;
      this.clearExtensionState();

      await this.connectToRelay(lifecycleEpoch);
      return parsed;
    });

    this.remoteUpdate = update.then(() => undefined, () => undefined);
    return update;
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

  getLastClose(): RelayCloseInfo | null {
    return this.lastClose
      ? { ...this.lastClose, permanent: this.reconnectSuppressed }
      : null;
  }

  /**
   * Connect to the relay server (local or remote)
   */
  private async connectToRelay(lifecycleEpoch: number): Promise<void> {
    if (this.stopping || lifecycleEpoch !== this.lifecycleEpoch) {
      throw new Error('Relay connection superseded');
    }
    if (this.ws) {
      if (this.status === 'connected') {
        return;
      }
      throw new Error('Relay connection already in progress');
    }

    return new Promise((resolve, reject) => {
      const url = this.getRelayUrl();
      const generation = ++this.connectionGeneration;
      let settled = false;
      let handshakeTimer: NodeJS.Timeout | null = null;
      let handshakeFailure: { error: Error; info: RelayCloseInfo } | null = null;
      let ws: WebSocket;
      this.log(this.remoteConfig ? 'Connecting to configured remote relay...' : `Connecting to local relay at ${url}...`);

      const isCurrent = () => lifecycleEpoch === this.lifecycleEpoch
        && generation === this.connectionGeneration
        && this.ws === ws
        && url === this.getRelayUrl();

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        if (handshakeTimer) clearTimeout(handshakeTimer);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        if (handshakeTimer) clearTimeout(handshakeTimer);
        reject(error);
      };

      try {
        ws = new WebSocket(url);
        this.ws = ws;
        this.status = 'connecting';
        handshakeTimer = setTimeout(() => {
          const error = new Error(`Relay handshake timed out after ${this.handshakeTimeoutMs}ms`);
          this.log(error.message);
          settleReject(error);
          if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
            ws.terminate();
          }
        }, this.handshakeTimeoutMs);

        ws.on('open', () => {
          if (!isCurrent()) {
            ws.terminate();
            settleReject(new Error('Relay connection superseded'));
            return;
          }
          this.log('Connected to relay');
          this.status = 'connected';
          this.lastClose = null;
          this.emit('connected');
          settleResolve();
        });

        ws.on('message', (data) => {
          if (!isCurrent()) {
            return;
          }
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (error) {
            this.log(`Failed to parse message: ${error}`);
          }
        });

        ws.on('close', (code, reasonBuffer) => {
          const reason = reasonBuffer.toString();
          const safeReason = this.redactRemoteCredential(reason);
          const closeInfo = handshakeFailure?.info ?? {
            code,
            reason: safeReason,
            permanent: isPermanentRelayCloseCode(code),
          };
          const closeError = handshakeFailure?.error ?? new Error(this.formatCloseMessage(code, reason));
          settleReject(closeError);

          if (!isCurrent()) {
            return;
          }

          this.lastClose = { code: closeInfo.code, reason: closeInfo.reason };
          this.reconnectSuppressed = closeInfo.permanent;
          if (!handshakeFailure) {
            this.log(this.formatCloseMessage(code, reason));
          }
          this.ws = null;
          this.status = 'disconnected';
          this.rejectPendingRequests(closeError);
          this.clearExtensionState();
          this.emit('disconnected', closeInfo);

          if (!this.stopping && !this.reconnectSuppressed) {
            this.scheduleReconnect(lifecycleEpoch);
          }
        });

        ws.on('error', (error) => {
          const safeError = new Error(this.redactRemoteCredential(error.message));
          if (isCurrent()) {
            this.log(`WebSocket error: ${safeError.message}`);
          }
          settleReject(safeError);
        });

        ws.on('unexpected-response', (_request, response) => {
          const statusCode = response.statusCode ?? 0;
          const safeError = new Error(`Relay handshake rejected with HTTP ${statusCode || 'unknown status'}`);
          const permanent = isPermanentRelayHttpStatus(statusCode);
          handshakeFailure = {
            error: safeError,
            info: { code: statusCode, reason: safeError.message, permanent },
          };
          if (isCurrent()) {
            this.reconnectSuppressed = permanent;
            this.lastClose = { code: statusCode, reason: safeError.message };
            this.status = 'disconnected';
            this.log(safeError.message);
          }
          settleReject(safeError);
          response.resume();
          ws.terminate();
        });

      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        settleReject(new Error(this.redactRemoteCredential(message)));
      }
    });
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(lifecycleEpoch: number): void {
    if (this.stopping || this.reconnectSuppressed || lifecycleEpoch !== this.lifecycleEpoch || this.ws) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopping || this.reconnectSuppressed || lifecycleEpoch !== this.lifecycleEpoch || this.ws) {
        return;
      }
      this.log('Attempting to reconnect to relay...');
      try {
        await this.connectToRelay(lifecycleEpoch);
      } catch (error) {
        this.log(`Reconnect failed: ${error}`);
        this.scheduleReconnect(lifecycleEpoch);
      }
    }, this.reconnectDelayMs);
  }

  /**
   * Stop the connection
   */
  async stop(): Promise<void> {
    this.stopping = true;
    ++this.shutdownEpoch;
    ++this.lifecycleEpoch;
    this.startPromise = null;
    this.clearReconnectTimer();

    this.rejectPendingRequests(new Error('Connection closed'));
    this.closeSocket();

    this.status = 'disconnected';
    this.clearExtensionState();
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

    const ws = this.ws;
    ++this.connectionGeneration;
    this.ws = null;
    // Keep the attempt's error listener attached: terminating CONNECTING sockets
    // emits an error before close. Generation checks make both callbacks stale.
    ws.terminate();
  }

  private clearExtensionState(): void {
    const toolsChanged = this.tools.length > 0;
    const sessionsChanged = this.sessions.length > 0;
    this.extensionConnected = false;
    this.tools = [];
    this.sessions = [];
    if (toolsChanged) this.emit('tools_updated', this.tools);
    if (sessionsChanged) this.emit('sessions_updated', this.sessions);
    this.emit('extension_status', false);
  }

  /**
   * Handle message from relay
   */
  private handleMessage(message: ExtensionMessage): void {
    this.log(`Received: ${message.type}`);

    // Handle extension status updates
    if (message.type === 'extension_status') {
      if (message.connected) {
        this.extensionConnected = true;
        this.emit('extension_status', true);
      } else {
        this.rejectPendingRequests(new Error('Extension disconnected from relay'));
        this.clearExtensionState();
      }
      return;
    }

    if (message.type === 'extension_disconnected') {
      this.rejectPendingRequests(new Error('Extension disconnected from relay'));
      this.clearExtensionState();
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

        if (message.type === 'error') {
          const errorMessage = typeof message.error === 'string' ? message.error : 'Unknown relay error';
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(message.requestId);
          pending.reject(new Error(this.redactRemoteCredential(errorMessage)));
        } else {
          let payload: unknown = message.data;
          if (message.type === 'tool_result') {
            payload = this.redactErrorToolResult(payload);
          }
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(message.requestId);
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
    if (message.requestId) {
      return;
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
      if (this.lastClose) {
        return `${this.formatCloseMessage(this.lastClose.code, this.lastClose.reason)}. ${NO_CONNECTION_REMOTE_MESSAGE}`;
      }
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
        sessionId: REDACTED_REMOTE_ID,
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
      console.error(`[vibebrowser-mcp] ${this.redactRemoteCredential(message)}`);
    }
  }

  private redactRemoteCredential(message: string): string {
    return redactRemoteTarget(message, this.remoteConfig ? this.getRelayUrl() : undefined);
  }

  private redactErrorToolResult(payload: unknown): unknown {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return payload;
    }

    const result = payload as Record<string, unknown>;
    if (result.isError !== true && result.success !== false) {
      return payload;
    }

    return this.redactUnknownStrings(result);
  }

  private redactUnknownStrings(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.redactRemoteCredential(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.redactUnknownStrings(entry));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, this.redactUnknownStrings(entry)]),
      );
    }
    return value;
  }

  redactErrorMessage(message: string): string {
    return this.redactRemoteCredential(message);
  }

  private formatCloseMessage(code: number, reason: string): string {
    const safeReason = this.redactRemoteCredential(reason.trim());
    return safeReason
      ? `Relay connection closed (code ${code}: ${safeReason})`
      : `Relay connection closed (code ${code})`;
  }
}
