import { EventEmitter } from 'node:events';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDefinition, ToolResult, ToolResultContent } from './types.js';

const TOOLS_REFRESH_TIMEOUT_MS = 6_000;
const TOOL_CALL_TIMEOUT_MS = 30_000;

interface ChromeDevtoolsPackageMeta {
  bin?: string | Record<string, string>;
}

function normalizeToolName(value: string): string {
  return value.replace(/[-\s]/g, '_').toLowerCase();
}

function toToolDefinition(input: {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, object>;
    required?: string[];
  };
}): ToolDefinition {
  return {
    name: input.name,
    description: input.description ?? '',
    inputSchema: {
      type: 'object',
      properties: input.inputSchema.properties as Record<string, never> | undefined,
      required: input.inputSchema.required,
    },
  };
}

export class DevtoolsFallbackConnection extends EventEmitter {
  private readonly debug: boolean;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: ToolDefinition[] = [];
  private available = false;
  private unavailableReason?: string;

  constructor(debug: boolean) {
    super();
    this.debug = debug;
  }

  async start(): Promise<void> {
    const binaryPath = this.resolveBinaryPath();
    if (!binaryPath) {
      this.unavailableReason = 'chrome-devtools-mcp is not installed';
      this.log(this.unavailableReason);
      return;
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [binaryPath, '--autoConnect'],
      stderr: this.debug ? 'inherit' : 'pipe',
    });
    const client = new Client(
      {
        name: 'vibebrowser-mcp-devtools-fallback',
        version: '1.0.0',
      },
      { capabilities: {} },
    );

    try {
      await client.connect(transport, { timeout: TOOLS_REFRESH_TIMEOUT_MS });
      this.client = client;
      this.transport = transport;
      this.available = true;
      this.unavailableReason = undefined;
      await this.refreshTools(TOOLS_REFRESH_TIMEOUT_MS);
      this.emit('connected');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.unavailableReason = `chrome-devtools fallback unavailable: ${message}`;
      this.log(this.unavailableReason);
      this.available = false;
      this.client = null;
      this.transport = null;
      this.tools = [];
      this.emit('unavailable', this.unavailableReason);
      try {
        await transport.close();
      } catch {
        // ignore cleanup errors
      }
    }
  }

  async stop(): Promise<void> {
    this.available = false;
    this.tools = [];

    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore shutdown errors
      }
      this.client = null;
    }

    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // ignore shutdown errors
      }
      this.transport = null;
    }
  }

  async refreshTools(timeoutMs: number = TOOLS_REFRESH_TIMEOUT_MS): Promise<ToolDefinition[]> {
    if (!this.client || !this.available) {
      return this.tools;
    }

    try {
      const listed = await this.client.listTools(undefined, { timeout: timeoutMs });
      const nextTools = listed.tools.map(toToolDefinition);
      const previousNames = this.tools.map((tool) => normalizeToolName(tool.name)).join(',');
      const nextNames = nextTools.map((tool) => normalizeToolName(tool.name)).join(',');
      this.tools = nextTools;
      if (previousNames !== nextNames) {
        this.emit('tools_updated', this.tools);
      }
      return this.tools;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Unable to refresh chrome-devtools tools: ${message}`);
      return this.tools;
    }
  }

  getTools(): ToolDefinition[] {
    return this.tools;
  }

  hasTool(name: string): boolean {
    const needle = normalizeToolName(name);
    return this.tools.some((tool) => normalizeToolName(tool.name) === needle);
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number = TOOL_CALL_TIMEOUT_MS): Promise<ToolResult> {
    if (!this.client || !this.available) {
      throw new Error(this.unavailableReason || 'chrome-devtools fallback is unavailable');
    }

    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: timeoutMs },
    );

    const content = Array.isArray(result.content)
      ? (result.content as ToolResultContent[])
      : [{ type: 'text', text: JSON.stringify(result) } as ToolResultContent];
    const isError = typeof result.isError === 'boolean' ? result.isError : false;

    return {
      success: !isError,
      isError,
      content,
    };
  }

  isAvailable(): boolean {
    return this.available;
  }

  getUnavailableReason(): string | undefined {
    return this.unavailableReason;
  }

  private resolveBinaryPath(): string | undefined {
    try {
      const require = createRequire(import.meta.url);
      const packageJsonPath = require.resolve('chrome-devtools-mcp/package.json');
      const metadata = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as ChromeDevtoolsPackageMeta;
      const bin = typeof metadata.bin === 'string'
        ? metadata.bin
        : metadata.bin?.['chrome-devtools-mcp'] ?? metadata.bin?.['chrome-devtools'];
      if (!bin) {
        return undefined;
      }
      return resolve(dirname(packageJsonPath), bin);
    } catch {
      return undefined;
    }
  }

  private log(message: string): void {
    if (this.debug) {
      console.error(`[vibebrowser-mcp] ${message}`);
    }
  }
}
