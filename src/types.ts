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
 * Connection status
 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

/**
 * Message from extension to MCP server
 */
export interface ExtensionMessage {
  type: 'connected' | 'disconnected' | 'tool_result' | 'tools_list' | 'error' | 'snapshot' | 'extension_status' | 'extension_disconnected';
  requestId?: string;
  data?: unknown;
  error?: string;
  connected?: boolean;
}

/**
 * Message from MCP server to extension
 */
export interface ServerMessage {
  type: 'list_tools' | 'call_tool' | 'get_snapshot' | 'ping';
  requestId: string;
  data?: {
    name?: string;
    arguments?: Record<string, unknown>;
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
  | { type: 'image'; data: string; mimeType: string };

/**
 * Accessibility snapshot result
 */
export interface SnapshotResult {
  url: string;
  title: string;
  snapshot: string;
}

/**
 * Server configuration
 */
export interface ServerConfig {
  port: number;
  host: string;
  debug: boolean;
  /** Remote relay UUID — when set, connects to public relay instead of local */
  remoteUuid?: string;
  /** Remote relay URL — defaults to wss://relay.api.vibebrowser.app */
  remoteRelayUrl?: string;
}
