/**
 * Vibe MCP Server - Main Server
 *
 * MCP server that bridges AI clients with the Vibe browser extension.
 */
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { ExtensionConnection } from './connection.js';
import { DEFAULT_HTTP_PATH, DEFAULT_HTTP_PORT, DEFAULT_WS_PORT, } from './types.js';
import { getPackageVersion } from './version.js';
const SERVER_NAME = 'vibebrowser-mcp';
const SERVER_VERSION = getPackageVersion();
const STARTUP_TOOLS_REFRESH_TIMEOUT_MS = 4_000;
const STARTUP_TOOLS_EVENT_WAIT_TIMEOUT_MS = 1_500;
/**
 * Vibe MCP Server
 *
 * Exposes Vibe browser tools to MCP clients via stdio or streamable HTTP transport.
 */
export class VibeMcpServer {
    connection;
    config;
    sessions = new Map();
    stdioServer = null;
    httpApp = null;
    httpServer = null;
    shutdownStarted = false;
    constructor(config = {}) {
        this.config = {
            port: config.port ?? DEFAULT_WS_PORT,
            host: config.host ?? '127.0.0.1',
            debug: config.debug ?? false,
            transport: config.transport ?? 'stdio',
            httpPort: config.httpPort ?? DEFAULT_HTTP_PORT,
            httpPath: normalizeHttpPath(config.httpPath ?? DEFAULT_HTTP_PATH),
            allowedHosts: config.allowedHosts,
            remoteUuid: config.remoteUuid,
            remoteRelayUrl: config.remoteRelayUrl,
        };
        const remoteConfig = this.config.remoteUuid
            ? { uuid: this.config.remoteUuid, relayUrl: this.config.remoteRelayUrl }
            : undefined;
        this.connection = new ExtensionConnection(this.config.port, this.config.debug, remoteConfig);
        this.setupConnectionEvents();
    }
    /**
     * Start the MCP server
     */
    async start() {
        await this.connection.start();
        if (this.config.remoteUuid) {
            this.log(`Connected to remote relay for UUID ${this.config.remoteUuid}`);
        }
        else {
            this.log(`Waiting for Vibe extension connection on port ${this.config.port}...`);
        }
        if (this.config.transport === 'http') {
            await this.startHttpServer();
        }
        else {
            await this.startStdioServer();
        }
        this.registerProcessHandlers();
    }
    /**
     * Shutdown the server
     */
    async stop() {
        if (this.httpServer) {
            await new Promise((resolve, reject) => {
                this.httpServer.close((error) => {
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
            }
            catch {
                // ignore shutdown cleanup errors
            }
            try {
                await session.server.close();
            }
            catch {
                // ignore shutdown cleanup errors
            }
            this.sessions.delete(sessionId);
        }
        if (this.stdioServer) {
            try {
                await this.stdioServer.close();
            }
            catch {
                // ignore shutdown cleanup errors
            }
            this.stdioServer = null;
        }
        await this.connection.stop();
    }
    /**
     * Return the configured MCP endpoint URL in HTTP mode.
     */
    getHttpUrl() {
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
    getTransportMode() {
        return this.config.transport;
    }
    /**
     * Set up extension connection events
     */
    setupConnectionEvents() {
        this.connection.on('connected', () => {
            this.log('Extension connected');
        });
        this.connection.on('disconnected', () => {
            this.log('Extension disconnected');
            this.notifyToolListChanged();
        });
        this.connection.on('tools_updated', (tools) => {
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
    createProtocolServer() {
        const server = new Server({
            name: SERVER_NAME,
            version: SERVER_VERSION,
        }, {
            capabilities: {
                tools: {
                    listChanged: true,
                },
            },
        });
        server.setRequestHandler(ListToolsRequestSchema, async () => {
            if (this.connection.getTools().length === 0 && this.connection.isExtensionConnected()) {
                try {
                    await this.connection.refreshTools(STARTUP_TOOLS_REFRESH_TIMEOUT_MS);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.log(`tools/list refresh failed: ${message}`);
                }
            }
            if (this.connection.getTools().length === 0 && this.connection.isExtensionConnected()) {
                await this.connection.waitForToolsUpdate(STARTUP_TOOLS_EVENT_WAIT_TIMEOUT_MS);
            }
            return {
                tools: this.connection.getTools().map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                })),
            };
        });
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            try {
                const result = await this.connection.callTool(name, args ?? {});
                return {
                    content: result.content,
                    isError: result.isError,
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: 'text', text: `Error: ${message}` }],
                    isError: true,
                };
            }
        });
        return server;
    }
    /**
     * Start stdio MCP transport.
     */
    async startStdioServer() {
        const server = this.createProtocolServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
        this.stdioServer = server;
        this.log('MCP server started on stdio');
    }
    /**
     * Start streamable HTTP MCP transport.
     */
    async startHttpServer() {
        this.httpApp = createMcpExpressApp({
            host: this.config.host,
            allowedHosts: this.config.allowedHosts,
        });
        const healthHandler = (_req, res) => {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
                name: SERVER_NAME,
                version: SERVER_VERSION,
                transport: 'http',
                mcpPath: this.config.httpPath,
                extensionConnected: this.connection.isExtensionConnected(),
                cachedTools: this.connection.getTools().length,
            }));
        };
        this.httpApp.get('/health', healthHandler);
        this.httpApp.get('/', healthHandler);
        this.httpApp.post(this.config.httpPath, async (req, res) => {
            await this.handleHttpRequest(req, res, req.body);
        });
        this.httpApp.get(this.config.httpPath, async (req, res) => {
            await this.handleHttpRequest(req, res);
        });
        this.httpApp.delete(this.config.httpPath, async (req, res) => {
            await this.handleHttpRequest(req, res);
        });
        this.httpServer = await new Promise((resolve, reject) => {
            const server = this.httpApp.listen(this.config.httpPort, this.config.host, () => resolve(server));
            server.once('error', reject);
        });
        this.log(`MCP server started on ${this.getHttpUrl()}`);
    }
    /**
     * Handle a streamable HTTP request.
     */
    async handleHttpRequest(req, res, parsedBody) {
        try {
            const transport = await this.resolveHttpTransport(req, res, parsedBody);
            if (!transport) {
                return;
            }
            await transport.handleRequest(req, res, parsedBody);
        }
        catch (error) {
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
    async resolveHttpTransport(req, res, parsedBody) {
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
    async createHttpSession() {
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
    notifyToolListChanged() {
        if (this.stdioServer) {
            this.sendToolListChanged(this.stdioServer);
        }
        for (const { server } of this.sessions.values()) {
            this.sendToolListChanged(server);
        }
    }
    sendToolListChanged(server) {
        if (!server.transport) {
            return;
        }
        server.sendToolListChanged().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`Failed to send tools/list_changed: ${message}`);
        });
    }
    /**
     * Handle process termination.
     */
    registerProcessHandlers() {
        const onSignal = () => {
            void this.shutdown();
        };
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);
        if (this.config.transport === 'stdio') {
            process.stdin.on('close', onSignal);
        }
    }
    async shutdown() {
        if (this.shutdownStarted) {
            return;
        }
        this.shutdownStarted = true;
        this.log('Shutting down...');
        try {
            await this.stop();
        }
        catch {
            // ignore shutdown errors
        }
        process.exit(0);
    }
    /**
     * Log message if debug is enabled
     */
    log(message) {
        if (this.config.debug) {
            console.error(`[${SERVER_NAME}] ${message}`);
        }
    }
}
/**
 * Create and start the MCP server
 */
export async function createServer(config) {
    const server = new VibeMcpServer(config);
    await server.start();
    return server;
}
function normalizeHttpPath(path) {
    if (!path || path === '/') {
        return DEFAULT_HTTP_PATH;
    }
    return path.startsWith('/') ? path : `/${path}`;
}
function getSessionId(req) {
    const value = req.headers['mcp-session-id'];
    if (Array.isArray(value)) {
        return value[0] ?? null;
    }
    return typeof value === 'string' && value.length > 0 ? value : null;
}
function writeJsonRpcError(res, statusCode, message) {
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
//# sourceMappingURL=server.js.map