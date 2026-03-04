/**
 * Vibe MCP Server - Main Server
 * 
 * MCP server that bridges AI clients with the Vibe browser extension.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ExtensionConnection, RemoteConfig } from './connection.js';
import { DEFAULT_WS_PORT, MCP_PROTOCOL_VERSION, ServerConfig, ToolDefinition } from './types.js';

const SERVER_NAME = 'vibe-mcp';
const SERVER_VERSION = '0.1.0';

/**
 * Vibe MCP Server
 * 
 * Exposes Vibe browser tools to MCP clients via stdio transport.
 */
export class VibeMcpServer {
  private server: Server;
  private connection: ExtensionConnection;
  private config: ServerConfig;

  constructor(config: Partial<ServerConfig> = {}) {
    this.config = {
      port: config.port ?? DEFAULT_WS_PORT,
      host: config.host ?? '127.0.0.1',
      debug: config.debug ?? false,
      remoteUuid: config.remoteUuid,
      remoteRelayUrl: config.remoteRelayUrl,
    };

    const remoteConfig: RemoteConfig | undefined = this.config.remoteUuid
      ? { uuid: this.config.remoteUuid, relayUrl: this.config.remoteRelayUrl }
      : undefined;

    this.connection = new ExtensionConnection(this.config.port, this.config.debug, remoteConfig);

    this.server = new Server(
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

    this.setupHandlers();
    this.setupConnectionEvents();
  }

  /**
   * Set up MCP request handlers
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (this.connection.getTools().length === 0 && this.connection.isExtensionConnected()) {
        try {
          await this.connection.refreshTools();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log(`tools/list refresh failed: ${message}`);
        }
      }

      const tools = this.connection.getTools();
      
      return {
        tools: tools.map((tool: ToolDefinition) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    });

    // Call a tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        const result = await this.connection.callTool(name, args ?? {});

        return {
          content: result.content,
          isError: result.isError,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    });
  }

  /**
   * Set up extension connection events
   */
  private setupConnectionEvents(): void {
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
   * Start the MCP server
   */
  async start(): Promise<void> {
    // Start connection to extension (local relay or remote)
    await this.connection.start();
    if (this.config.remoteUuid) {
      this.log(`Connected to remote relay for UUID ${this.config.remoteUuid}`);
    } else {
      this.log(`Waiting for Vibe extension connection on port ${this.config.port}...`);
    }

    // Connect MCP server to stdio transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.log('MCP server started on stdio');

    // Handle process termination
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
    process.stdin.on('close', () => this.shutdown());
  }

  /**
   * Shutdown the server
   */
  private async shutdown(): Promise<void> {
    this.log('Shutting down...');
    
    try {
      await this.connection.stop();
      await this.server.close();
    } catch (error) {
      // Ignore errors during shutdown
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

  private notifyToolListChanged(): void {
    if (!(this.server as { transport?: unknown }).transport) {
      return;
    }
    this.server.sendToolListChanged().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Failed to send tools/list_changed: ${message}`);
    });
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
