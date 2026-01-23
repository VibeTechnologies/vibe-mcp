/**
 * Vibe MCP Server - Relay Connection
 * 
 * Connects to the relay server as a WebSocket client.
 * The relay handles the actual extension connection.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import {
  ConnectionStatus,
  ExtensionMessage,
  ServerMessage,
  ToolDefinition,
  ToolResult,
  SnapshotResult,
} from './types.js';
import { isRelayRunning, AGENT_PORT, EXTENSION_PORT } from './relay.js';

const NO_CONNECTION_MESSAGE = `No connection to Vibe extension. Please:
1. Install the Vibe AI Browser extension from https://vibebrowser.app
2. Click the Vibe extension icon in Chrome
3. Enable "MCP External Control" in Settings`;

const RELAY_CONNECT_TIMEOUT = 10000;
const RELAY_RECONNECT_DELAY = 2000;

/**
 * Pending request waiting for response
 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Relay connection manager
 * 
 * Connects to the relay server instead of directly to the extension.
 */
export class ExtensionConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestIdCounter = 0;
  private port: number;
  private debug: boolean;
  private tools: ToolDefinition[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private extensionConnected: boolean = false;

  constructor(port: number = AGENT_PORT, debug: boolean = false) {
    super();
    this.port = port;
    this.debug = debug;
  }

  /**
   * Start connection to relay server
   * Spawns relay daemon if not already running
   */
  async start(): Promise<void> {
    // Check if relay is already running
    if (!isRelayRunning()) {
      this.log('Starting relay daemon...');
      await this.spawnRelay();
      // Wait for relay to start
      await this.waitForRelay();
    }

    // Connect to relay
    await this.connectToRelay();
  }

  /**
   * Spawn relay daemon as detached process
   */
  private async spawnRelay(): Promise<void> {
    // Use __dirname equivalent for ESM
    const relayScript = join(dirname(new URL(import.meta.url).pathname), 'relay-daemon.js');
    
    const child = spawn(process.execPath, [relayScript, this.debug ? '--debug' : ''], {
      detached: true,
      stdio: 'ignore',
    });
    
    child.unref();
    this.log('Relay daemon spawned');
  }

  /**
   * Wait for relay to become available
   */
  private async waitForRelay(): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < RELAY_CONNECT_TIMEOUT) {
      try {
        // Try to connect
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${AGENT_PORT}`);
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('Timeout'));
          }, 1000);
          
          ws.on('open', () => {
            clearTimeout(timeout);
            ws.close();
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
   * Connect to the relay server
   */
  private async connectToRelay(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${AGENT_PORT}`;
      this.log(`Connecting to relay at ${url}...`);

      try {
        this.ws = new WebSocket(url);

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
          this.emit('disconnected');
          
          // Schedule reconnect
          this.scheduleReconnect();
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending requests
    for (const [id, request] of this.pendingRequests) {
      clearTimeout(request.timeout);
      request.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.status = 'disconnected';
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
      this.emit('extension_disconnected');
      return;
    }

    // Handle responses to pending requests
    if (message.requestId) {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.requestId);

        if (message.type === 'error') {
          pending.reject(new Error(message.error || 'Unknown error'));
        } else {
          pending.resolve(message.data);
        }
        return;
      }
    }

    // Handle unsolicited messages
    switch (message.type) {
      case 'tools_list':
        this.tools = message.data as ToolDefinition[];
        this.extensionConnected = true;
        this.emit('tools_updated', this.tools);
        break;

      case 'snapshot':
        this.emit('snapshot', message.data);
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

    if (!this.extensionConnected) {
      throw new Error(NO_CONNECTION_MESSAGE);
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
      });

      const message: ServerMessage = { type, requestId, data };
      this.ws!.send(JSON.stringify(message));
      this.log(`Sent: ${type} (${requestId})`);
    });
  }

  /**
   * Refresh available tools from extension
   */
  async refreshTools(): Promise<ToolDefinition[]> {
    const tools = await this.sendRequest<ToolDefinition[]>('list_tools');
    this.tools = tools;
    return tools;
  }

  /**
   * Get cached list of available tools
   */
  getTools(): ToolDefinition[] {
    return this.tools;
  }

  /**
   * Call a tool on the extension
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.sendRequest<ToolResult>('call_tool', { name, arguments: args });
  }

  /**
   * Get accessibility snapshot of current page
   */
  async getSnapshot(): Promise<SnapshotResult> {
    return this.sendRequest<SnapshotResult>('get_snapshot');
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
      console.error(`[vibe-mcp] ${message}`);
    }
  }
}
