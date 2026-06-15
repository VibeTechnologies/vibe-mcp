/**
 * Internal type contracts for the chrome-use CDP driver.
 *
 * Adapted from the `chrome-use` skill (skills/chrome-use/scripts/lib/types.ts),
 * a zero-dependency Chrome DevTools Protocol browser driver. Ported into vibe-mcp
 * so the `--devtools` MCP mode can drive the user's real running Chrome directly
 * over CDP instead of proxying the external chrome-devtools-mcp server.
 */

/** A minimal Chrome DevTools Protocol client over a raw WebSocket. */
export interface CdpClient {
  /**
   * Send a CDP command and await its result. If `sessionId` is given the command
   * is routed to that flattened target session (page-level domains); otherwise it
   * runs at the browser level.
   */
  send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  on(method: string, handler: (params: unknown, sessionId?: string) => void): () => void;
  /** True while the underlying socket is open. */
  readonly connected: boolean;
  /** Close the socket. */
  close(): void;
}

/** Per-tab (per CDP target) session. */
export interface TabSession {
  /** CDP target id of the page. */
  targetId: string;
  /** Flattened CDP session id used for page-level domains (DOM, Input, Runtime…). */
  sessionId: string;
  /** Snapshot ref registry: ref key without the leading "@" (e.g. "e1") → list index. */
  refRegistry: Map<string, number>;
  /** Last known URL (updated on navigation). */
  url: string;
  /** Stable short tab id exposed to the user, e.g. "t1". */
  tabId: string;
}

/** A resolved DOM element reference usable with CDP DOM/Runtime/Input. */
export interface ResolvedElement {
  backendNodeId?: number;
  objectId?: string;
}

export interface SnapshotOptions {
  /** Interactive elements only (buttons, links, inputs, …). */
  interactive?: boolean;
  /** Scope the snapshot to a CSS selector. */
  selector?: string;
}

export interface SnapshotResult {
  /** Indented ref tree, e.g. `@e1 [button] "Submit"`. */
  text: string;
  /** ref key (without "@") → list index, to install into the tab registry. */
  refs: Map<string, number>;
  /** Structured node list. */
  nodes: SnapshotNode[];
}

export interface SnapshotNode {
  ref: string; // "e1"
  role: string; // "button", "textbox", "link", "heading", "text", …
  name: string; // accessible name / text content
  backendNodeId: number;
  depth: number;
  url?: string; // for links
}
