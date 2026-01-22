/**
 * Vibe MCP Server - Extension Connection
 * 
 * Manages WebSocket connection to the Vibe browser extension.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import {
  DEFAULT_WS_PORT,
  ConnectionStatus,
  ExtensionMessage,
  ServerMessage,
  ToolDefinition,
  ToolResult,
  SnapshotResult,
} from './types.js';

const NO_CONNECTION_MESSAGE = `No connection to Vibe extension. Please:
1. Install the Vibe AI Browser extension from https://vibebrowser.app
2. Click the Vibe extension icon in Chrome
3. Click "Connect to MCP" to enable external control`;

/**
 * Pending request waiting for response
 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Extension connection manager
 */
export class ExtensionConnection extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestIdCounter = 0;
  private port: number;
  private debug: boolean;
  private tools: ToolDefinition[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(port: number = DEFAULT_WS_PORT, debug: boolean = false) {
    super();
    this.port = port;
    this.debug = debug;
  }

  /**
   * Start the WebSocket server and wait for extension connection
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ port: this.port, host: '127.0.0.1' });
        
        this.wss.on('listening', () => {
          this.log(`WebSocket server listening on ws://127.0.0.1:${this.port}`);
          resolve();
        });

        this.wss.on('connection', (ws) => {
          this.handleConnection(ws);
        });

        this.wss.on('error', (error) => {
          this.log(`WebSocket server error: ${error.message}`);
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the WebSocket server
   */
  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending requests
    for (const [id, request] of this.pendingRequests) {
      clearTimeout(request.timeout);
      request.reject(new Error('Server shutting down'));
    }
    this.pendingRequests.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.wss) {
      return new Promise((resolve) => {
        this.wss!.close(() => {
          this.wss = null;
          this.status = 'disconnected';
          resolve();
        });
      });
    }
  }

  /**
   * Handle new WebSocket connection from extension
   */
  private handleConnection(ws: WebSocket): void {
    this.log('Extension connected');
    
    // Close previous connection if any
    if (this.ws) {
      this.ws.close();
    }
    
    this.ws = ws;
    this.status = 'connected';
    this.emit('connected');

    ws.on('message', (data) => {
      try {
        const message: ExtensionMessage = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (error) {
        this.log(`Failed to parse message: ${error}`);
      }
    });

    ws.on('close', () => {
      this.log('Extension disconnected');
      this.ws = null;
      this.status = 'disconnected';
      this.tools = [];
      this.emit('disconnected');
    });

    ws.on('error', (error) => {
      this.log(`WebSocket error: ${error.message}`);
    });

    // Request available tools
    this.refreshTools().catch((error) => {
      this.log(`Failed to get tools: ${error.message}`);
    });
  }

  /**
   * Handle message from extension
   */
  private handleMessage(message: ExtensionMessage): void {
    this.log(`Received: ${message.type}`);

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
        this.emit('tools_updated', this.tools);
        break;

      case 'snapshot':
        this.emit('snapshot', message.data);
        break;

      case 'error':
        this.log(`Extension error: ${message.error}`);
        break;
    }
  }

  /**
   * Send a message to the extension and wait for response
   */
  private async sendRequest<T>(
    type: ServerMessage['type'],
    data?: ServerMessage['data'],
    timeoutMs: number = 30000
  ): Promise<T> {
    if (!this.ws || this.status !== 'connected') {
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
   * Check if extension is connected
   */
  isConnected(): boolean {
    return this.status === 'connected';
  }

  /**
   * Get connection status
   */
  getStatus(): ConnectionStatus {
    return this.status;
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
