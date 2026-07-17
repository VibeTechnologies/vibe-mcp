/**
 * Vibe MCP Server - Types
 * 
 * Type definitions for the MCP server protocol and extension communication.
 */

/**
 * MCP Protocol version supported
 */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * Default WebSocket port for local relay (agent) connection
 */
export const DEFAULT_WS_PORT = 19888;

/**
 * Default HTTP port for streamable HTTP MCP transport
 */
export const DEFAULT_HTTP_PORT = 8788;

/**
 * Default HTTP path for streamable HTTP MCP transport
 */
export const DEFAULT_HTTP_PATH = '/mcp';

/**
 * MCP server transport mode
 */
export type ServerTransportMode = 'stdio' | 'http';

/**
 * Connection status
 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface RelaySessionSummary {
  sessionId: string;
  connected: boolean;
  connectedAt?: number;
  toolCount?: number;
}

/**
 * Message from extension to MCP server
 */
export interface ExtensionMessage {
  type: 'connected' | 'disconnected' | 'tool_result' | 'tool_progress' | 'tools_list' | 'error' | 'extension_status' | 'extension_disconnected' | 'sessions_list';
  requestId?: string;
  data?: unknown;
  error?: string;
  connected?: boolean;
  sessionId?: string;
  sessionIds?: string[];
  sessions?: RelaySessionSummary[];
}

/**
 * Message from MCP server to extension
 */
export interface ServerMessage {
  type: 'list_tools' | 'call_tool' | 'ping' | 'list_sessions';
  requestId: string;
  data?: {
    name?: string;
    arguments?: Record<string, unknown>;
    sessionId?: string;
  };
}

/**
 * Tool definition from extension
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
}

/**
 * JSON Schema property
 */
export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
}

/**
 * Tool execution result
 */
export interface ToolResult {
  success: boolean;
  content: ToolResultContent[];
  isError?: boolean;
}

/**
 * Tool result content types
 */
export type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: unknown }
  | { type: 'resource_link'; uri: string; name?: string };

/**
 * Server configuration
 */
export interface ServerConfig {
  port: number;
  host: string;
  debug: boolean;
  /** Drive the real Chrome directly over CDP (chrome-use backend), bypassing relay/extension routing. */
  devtools?: boolean;
  transport: ServerTransportMode;
  httpPort: number;
  httpPath: string;
  allowedHosts?: string[];
  /** Remote relay UUID — when set, connects to public relay instead of local */
  remoteUuid?: string;
  /** Local relay session ID — when set, targets a specific connected browser session */
  sessionId?: string;
  /** Remote relay URL — defaults to wss://relay.api.vibebrowser.app */
  remoteRelayUrl?: string;
}
