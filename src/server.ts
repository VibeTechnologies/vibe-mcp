/**
 * Vibe MCP Server - Main Server
 *
 * MCP server that bridges AI clients with the Vibe browser extension.
 */

import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ExtensionConnection, type RemoteConfig } from './connection.js';
import { DevtoolsFallbackConnection } from './devtools-fallback.js';
import {
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  DEFAULT_WS_PORT,
  type ServerConfig,
  type ServerTransportMode,
  type ToolDefinition,
  type ToolResult,
} from './types.js';
import { getPackageVersion } from './version.js';

const SERVER_NAME = 'vibebrowser-mcp';
const SERVER_VERSION = getPackageVersion();
const STARTUP_TOOLS_REFRESH_TIMEOUT_MS = 4_000;
const STARTUP_TOOLS_EVENT_WAIT_TIMEOUT_MS = 1_500;
/**
 * Timeout for tool execution via the relay/extension pipeline.
 * Page-interacting tools can take up to ~40s (CDP execution + post-action
 * stabilization + page content extraction) and the relay adds forwarding
 * latency.  120s provides headroom for heavy pages while still failing
 * promptly on genuine hangs.
 */
const CALL_TOOL_TIMEOUT_MS = 120_000;
const SET_REMOTE_TOOL: ToolDefinition = {
  name: 'set_remote',
  description: 'Set the remote relay target for this MCP server. If browser tools are missing, call set_remote first to connect to a Vibe relay.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Remote target as either an extension UUID or a full websocket relay URL (for example wss://relay.api.vibebrowser.app/<extension-uuid>). Call set_remote first when browser tools are unavailable.',
      },
    },
    required: ['url'],
  },
};

type HttpTransport = StreamableHTTPServerTransport;
type HttpRequest = IncomingMessage & { body?: unknown };

interface SessionState {
  server: Server;
  transport: HttpTransport;
}

/**
 * Vibe MCP Server
 *
 * Exposes Vibe browser tools to MCP clients via stdio or streamable HTTP transport.
 */
export class VibeMcpServer {
  private readonly connection: ExtensionConnection | DevtoolsFallbackConnection;
  private readonly config: ServerConfig;
  private readonly sessions = new Map<string, SessionState>();
  private stdioServer: Server | null = null;
  private httpApp: ReturnType<typeof createMcpExpressApp> | null = null;
  private httpServer: http.Server | null = null;
  private shutdownStarted = false;

  constructor(config: Partial<ServerConfig> = {}) {
    this.config = {
      port: config.port ?? DEFAULT_WS_PORT,
      host: config.host ?? '127.0.0.1',
      debug: config.debug ?? false,
      devtools: config.devtools ?? false,
      transport: config.transport ?? 'stdio',
      httpPort: config.httpPort ?? DEFAULT_HTTP_PORT,
      httpPath: normalizeHttpPath(config.httpPath ?? DEFAULT_HTTP_PATH),
      allowedHosts: config.allowedHosts,
      remoteUuid: config.remoteUuid,
      sessionId: config.sessionId,
      remoteRelayUrl: config.remoteRelayUrl,
    };

    if (this.config.devtools) {
      this.connection = new DevtoolsFallbackConnection(this.config.debug);
    } else {
      const remoteConfig: RemoteConfig | undefined = this.config.remoteUuid
        ? { uuid: this.config.remoteUuid, relayUrl: this.config.remoteRelayUrl }
        : undefined;

      this.connection = new ExtensionConnection(
        this.config.port,
        this.config.debug,
        remoteConfig,
        this.config.remoteUuid ? undefined : { sessionId: this.config.sessionId },
      );
    }
    this.setupConnectionEvents();
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    try {
      await this.connection.start();
    } catch (error) {
      if (!this.config.remoteUuid && !this.config.devtools) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Local extension startup failed; continuing without tools: ${message}`);
      } else {
        throw error;
      }
    }

    if (this.config.devtools) {
      if (this.connection instanceof DevtoolsFallbackConnection && this.connection.isAvailable()) {
        this.log('Connected to chrome-devtools backend');
      } else {
        this.log('chrome-devtools backend unavailable; server started without tools');
      }
    } else if (this.config.remoteUuid) {
      this.log(`Connected to remote relay for UUID ${this.config.remoteUuid}`);
    } else {
      this.log(`Waiting for Vibe extension connection on port ${this.config.port}...`);
    }

    if (this.config.transport === 'http') {
      await this.startHttpServer();
    } else {
      await this.startStdioServer();
    }

    this.registerProcessHandlers();
  }

  /**
   * Shutdown the server
   */
  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.httpServer = null;
      this.httpApp = null;
    }

    for (const [sessionId, session] of this.sessions) {
      try {
        await session.transport.close();
      } catch {
        // ignore shutdown cleanup errors
      }
      try {
        await session.server.close();
      } catch {
        // ignore shutdown cleanup errors
      }
      this.sessions.delete(sessionId);
    }

    if (this.stdioServer) {
      try {
        await this.stdioServer.close();
      } catch {
        // ignore shutdown cleanup errors
      }
      this.stdioServer = null;
    }

    await this.connection.stop();
  }

  /**
   * Return the configured MCP endpoint URL in HTTP mode.
   */
  getHttpUrl(): string | null {
    if (this.config.transport !== 'http') {
      return null;
    }

    const host = this.config.host.includes(':') && !this.config.host.startsWith('[')
      ? `[${this.config.host}]`
      : this.config.host;

    return `http://${host}:${this.config.httpPort}${this.config.httpPath}`;
  }

  /**
   * Return the configured transport mode.
   */
  getTransportMode(): ServerTransportMode {
    return this.config.transport;
  }

  /**
   * Set up extension connection events
   */
  private setupConnectionEvents(): void {
    if (this.connection instanceof DevtoolsFallbackConnection) {
      this.connection.on('connected', () => {
        this.log('chrome-devtools backend connected');
      });
      this.connection.on('unavailable', (reason: string) => {
        this.log(reason);
        this.notifyToolListChanged();
      });
      this.connection.on('tools_updated', (tools: ToolDefinition[]) => {
        this.log(`Received ${tools.length} tools from chrome-devtools backend`);
        this.notifyToolListChanged();
      });
      return;
    }

    this.connection.on('connected', () => {
      this.log('Extension connected');
    });

    this.connection.on('disconnected', () => {
      this.log('Extension disconnected');
      this.notifyToolListChanged();
    });

    this.connection.on('tools_updated', (tools: ToolDefinition[]) => {
      this.log(`Received ${tools.length} tools from extension`);
      this.notifyToolListChanged();
    });

    this.connection.on('extension_disconnected', () => {
      this.log('Extension disconnected from relay');
      this.notifyToolListChanged();
    });
  }

  /**
   * Create a configured MCP server instance.
   */
  private createProtocolServer(): Server {
    const server = new Server(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {
            listChanged: true,
          },
        },
      }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (this.connection.getTools().length === 0) {
        try {
          await this.connection.refreshTools(STARTUP_TOOLS_REFRESH_TIMEOUT_MS);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log(`tools/list refresh failed: ${message}`);
        }
      }

      if (this.connection.getTools().length === 0) {
        if (this.connection instanceof ExtensionConnection) {
          await this.connection.waitForToolsUpdate(STARTUP_TOOLS_EVENT_WAIT_TIMEOUT_MS);
        }
      }

      return {
        tools: [SET_REMOTE_TOOL, ...this.connection.getTools()].map((tool: ToolDefinition) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        if (normalizeToolName(name) === SET_REMOTE_TOOL.name) {
          return await this.handleSetRemoteTool(toRecord(args));
        }

        // Validate tool exists before forwarding to extension
        const availableTools = this.connection.getTools();
        const matchedTool = this.findToolByName(name);
        if (!matchedTool && availableTools.length > 0) {
          const toolNames = availableTools.map(t => t.name);
          return {
            content: [{ type: 'text', text: `Error: Tool '${name}' does not exist. Available tools: ${toolNames.join(', ')}` }],
            isError: true,
          };
        }

        const preparedArgs = this.withDefaultPageStateFormat(name, toRecord(args));
        const result = await this.connection.callTool(matchedTool?.name ?? name, preparedArgs, CALL_TOOL_TIMEOUT_MS);
        const enriched = await this.withFallbackPageContent(name, preparedArgs, result);

        return {
          content: enriched.content,
          isError: enriched.isError,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    });

    return server;
  }

  private async handleSetRemoteTool(args: Record<string, unknown>): Promise<{ content: ToolResult['content']; isError?: boolean }> {
    if (!(this.connection instanceof ExtensionConnection)) {
      return {
        content: [{ type: 'text', text: 'Error: set_remote is not supported when using the chrome-devtools fallback backend' }],
        isError: true,
      };
    }

    if (typeof args.url !== 'string' || args.url.trim().length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: set_remote requires a non-empty string url' }],
        isError: true,
      };
    }

    const remote = await this.connection.setRemoteUrl(args.url.trim());
    this.notifyToolListChanged();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          mode: 'remote',
          relayUrl: remote.relayUrl,
          uuid: remote.uuid,
        }),
      }],
    };
  }

  private withDefaultPageStateFormat(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const tool = this.findToolByName(name);
    if (!tool) {
      return args;
    }

    if (args.pageStateFormat !== undefined || args.page_state_format !== undefined) {
      return args;
    }

    const properties = tool.inputSchema.properties ?? {};
    if (Object.prototype.hasOwnProperty.call(properties, 'pageStateFormat')) {
      return { ...args, pageStateFormat: 'markdown' };
    }
    if (Object.prototype.hasOwnProperty.call(properties, 'page_state_format')) {
      return { ...args, page_state_format: 'markdown' };
    }
    return args;
  }

  private async withFallbackPageContent(
    name: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): Promise<ToolResult> {
    if (result.isError) {
      return result;
    }

    if (!shouldFallbackToSnapshot(name)) {
      return result;
    }

    if (!hasExplicitPageContext(args) || shouldNeverFallbackToSnapshot(name)) {
      return result;
    }

    const primaryText = firstToolText(result);
    if (looksLikePageContentText(primaryText)) {
      return result;
    }

    const snapshotText = await this.takeMarkdownSnapshot(extractPageId(args, result));
    if (!snapshotText) {
      return result;
    }

    return {
      ...result,
      content: [
        { type: 'text', text: snapshotText },
        ...result.content,
      ],
    };
  }

  private async takeMarkdownSnapshot(pageId?: number): Promise<string | undefined> {
    if (this.connection.getTools().length === 0) {
      try {
        await this.connection.refreshTools(STARTUP_TOOLS_REFRESH_TIMEOUT_MS);
      } catch {
        // ignore and continue with cached tools
      }
    }

    const snapshotTool = this.findToolByName('take_snapshot');
    if (!snapshotTool) {
      return undefined;
    }

    const callArgs: Record<string, unknown> = {};
    const properties = snapshotTool.inputSchema.properties ?? {};

    if (typeof pageId === 'number' && Number.isFinite(pageId)) {
      if (Object.prototype.hasOwnProperty.call(properties, 'pageId')) {
        callArgs.pageId = pageId;
      } else if (Object.prototype.hasOwnProperty.call(properties, 'tabId')) {
        callArgs.tabId = pageId;
      }
    }

    if (Object.prototype.hasOwnProperty.call(properties, 'format')) {
      callArgs.format = 'markdown';
    } else if (Object.prototype.hasOwnProperty.call(properties, 'pageStateFormat')) {
      callArgs.pageStateFormat = 'markdown';
    } else if (Object.prototype.hasOwnProperty.call(properties, 'page_state_format')) {
      callArgs.page_state_format = 'markdown';
    }

    try {
      const snapshot = await this.connection.callTool(snapshotTool.name, callArgs, STARTUP_TOOLS_REFRESH_TIMEOUT_MS);
      const text = firstToolText(snapshot);
      return text || undefined;
    } catch {
      return undefined;
    }
  }

  private findToolByName(name: string): ToolDefinition | undefined {
    const needle = normalizeToolName(name);
    return this.connection.getTools().find((tool) => normalizeToolName(tool.name) === needle);
  }

  /**
   * Start stdio MCP transport.
   */
  private async startStdioServer(): Promise<void> {
    const server = this.createProtocolServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    this.stdioServer = server;
    this.log('MCP server started on stdio');
  }

  /**
   * Start streamable HTTP MCP transport.
   */
  private async startHttpServer(): Promise<void> {
    this.httpApp = createMcpExpressApp({
      host: this.config.host,
      allowedHosts: this.config.allowedHosts,
    });

    const healthHandler = (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        transport: 'http',
        mcpPath: this.config.httpPath,
        extensionConnected: this.connection instanceof DevtoolsFallbackConnection
          ? this.connection.isAvailable()
          : this.connection.isExtensionConnected(),
        cachedTools: this.connection.getTools().length,
      }));
    };

    this.httpApp.get('/health', healthHandler);
    this.httpApp.get('/', healthHandler);

    this.httpApp.post(this.config.httpPath, async (req: HttpRequest, res: ServerResponse) => {
      await this.handleHttpRequest(req, res, req.body);
    });
    this.httpApp.get(this.config.httpPath, async (req: HttpRequest, res: ServerResponse) => {
      await this.handleHttpRequest(req, res);
    });
    this.httpApp.delete(this.config.httpPath, async (req: HttpRequest, res: ServerResponse) => {
      await this.handleHttpRequest(req, res);
    });

    this.httpServer = await new Promise<http.Server>((resolve, reject) => {
      const server = this.httpApp!.listen(this.config.httpPort, this.config.host, () => resolve(server));
      server.once('error', reject);
    });

    this.log(`MCP server started on ${this.getHttpUrl()}`);
  }

  /**
   * Handle a streamable HTTP request.
   */
  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    try {
      const transport = await this.resolveHttpTransport(req, res, parsedBody);
      if (!transport) {
        return;
      }

      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Error handling HTTP MCP request: ${message}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        }));
      }
    }
  }

  /**
   * Resolve or create the HTTP session transport for a request.
   */
  private async resolveHttpTransport(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<HttpTransport | null> {
    const sessionId = getSessionId(req);
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (!existing) {
        writeJsonRpcError(res, 404, 'Session not found');
        return null;
      }
      return existing.transport;
    }

    if (req.method === 'POST' && parsedBody && isInitializeRequest(parsedBody)) {
      const session = await this.createHttpSession();
      return session.transport;
    }

    writeJsonRpcError(res, 400, 'Bad Request: No valid session ID provided');
    return null;
  }

  /**
   * Create a new streamable HTTP session.
   */
  private async createHttpSession(): Promise<SessionState> {
    const server = this.createProtocolServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, { server, transport });
        this.log(`HTTP session initialized: ${sessionId}`);
      },
    });

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        this.sessions.delete(sessionId);
        this.log(`HTTP session closed: ${sessionId}`);
      }
      // Do not call server.close() here: server.close() closes the transport,
      // which re-enters transport.onclose() and can recurse until stack overflow.
    };

    transport.onerror = (error) => {
      const sessionId = transport.sessionId ?? 'unknown';
      this.log(`HTTP transport error (${sessionId}): ${error.message}`);
    };

    await server.connect(transport);
    return { server, transport };
  }

  /**
   * Notify all connected transports that the tool list changed.
   */
  private notifyToolListChanged(): void {
    if (this.stdioServer) {
      this.sendToolListChanged(this.stdioServer);
    }

    for (const { server } of this.sessions.values()) {
      this.sendToolListChanged(server);
    }
  }

  private sendToolListChanged(server: Server): void {
    if (!(server as { transport?: unknown }).transport) {
      return;
    }

    server.sendToolListChanged().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Failed to send tools/list_changed: ${message}`);
    });
  }

  /**
   * Handle process termination.
   */
  private registerProcessHandlers(): void {
    const onSignal = () => {
      void this.shutdown();
    };

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    if (this.config.transport === 'stdio') {
      process.stdin.on('close', onSignal);
    }
  }

  private async shutdown(): Promise<void> {
    if (this.shutdownStarted) {
      return;
    }
    this.shutdownStarted = true;

    this.log('Shutting down...');

    try {
      await this.stop();
    } catch {
      // ignore shutdown errors
    }

    process.exit(0);
  }

  /**
   * Log message if debug is enabled
   */
  private log(message: string): void {
    if (this.config.debug) {
      console.error(`[${SERVER_NAME}] ${message}`);
    }
  }
}

/**
 * Create and start the MCP server
 */
export async function createServer(config?: Partial<ServerConfig>): Promise<VibeMcpServer> {
  const server = new VibeMcpServer(config);
  await server.start();
  return server;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function normalizeToolName(value: string): string {
  return value.replace(/[-\s]/g, '_').toLowerCase();
}

function hasExplicitPageContext(args: Record<string, unknown>): boolean {
  const candidates = [args.pageId, args.tabId, args.page_id, args.tab_id];
  return candidates.some((candidate) => {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return true;
    }
    if (typeof candidate === 'string') {
      return /^\d+$/.test(candidate.trim());
    }
    return false;
  });
}

function shouldNeverFallbackToSnapshot(name: string): boolean {
  const normalized = normalizeToolName(name);
  return normalized === 'close_page' || normalized === 'close_tab';
}

function shouldFallbackToSnapshot(name: string): boolean {
  const normalized = normalizeToolName(name);
  return new Set([
    'open',
    'navigate',
    'new_page',
    'create_new_tab',
    'navigate_page',
    'navigate_to_url',
    'click',
    'fill',
    'fill_form',
    'type_text',
    'press_key',
    'hover',
    'drag',
    'scroll_page',
    'media_control',
  ]).has(normalized);
}

function firstToolText(result: ToolResult): string {
  const textItem = result.content.find((entry) => entry.type === 'text');
  if (!textItem || !('text' in textItem)) {
    return '';
  }
  return typeof textItem.text === 'string' ? textItem.text : '';
}

function looksLikePageContentText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (/Error retrieving page content/i.test(trimmed) || /page content extraction failed/i.test(trimmed)) {
    return false;
  }
  return /Page State Format:/i.test(trimmed)
    || /#\s*(?:Markdown Snapshot|Accessibility Snapshot|HTML Snapshot):/i.test(trimmed)
    || /```(?:markdown|text|html)/i.test(trimmed);
}

function extractPageId(args: Record<string, unknown>, result: ToolResult): number | undefined {
  const direct = firstNumber(args, ['pageId', 'tabId']);
  if (direct !== undefined) {
    return direct;
  }

  const text = firstToolText(result);
  const parsedJson = parseMaybeJsonText(text);
  if (parsedJson && typeof parsedJson === 'object') {
    const parsedId = firstNumber(parsedJson as Record<string, unknown>, ['pageId', 'tabId', 'id']);
    if (parsedId !== undefined) {
      return parsedId;
    }
  }

  const createdMatch = /new background page \(ID:\s*(\d+)\)/i.exec(text);
  if (createdMatch) {
    return Number.parseInt(createdMatch[1], 10);
  }
  const tabMatch = /\bTab ID:\s*(\d+)\b/i.exec(text);
  if (tabMatch) {
    return Number.parseInt(tabMatch[1], 10);
  }
  const pageMatch = /\bPage ID:\s*(\d+)\b/i.exec(text);
  if (pageMatch) {
    return Number.parseInt(pageMatch[1], 10);
  }
  return undefined;
}

function parseMaybeJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function normalizeHttpPath(path: string): string {
  if (!path || path === '/') {
    return DEFAULT_HTTP_PATH;
  }
  return path.startsWith('/') ? path : `/${path}`;
}

function getSessionId(req: IncomingMessage): string | null {
  const value = req.headers['mcp-session-id'];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function writeJsonRpcError(res: ServerResponse, statusCode: number, message: string): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message,
    },
    id: null,
  }));
}
