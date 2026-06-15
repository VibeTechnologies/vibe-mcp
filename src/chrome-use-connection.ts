/**
 * Vibe MCP Server - chrome-use DevTools backend
 *
 * Drives the user's REAL running Chrome directly over the Chrome DevTools Protocol
 * (autoConnect via the DevToolsActivePort file), replacing the old `--devtools`
 * path that proxied the external, buggy chrome-devtools-mcp server.
 *
 * The CDP driver core under `./chrome-use/` is adapted from the `chrome-use` skill
 * (skills/chrome-use/scripts). This class exposes a fixed catalog of MCP tools and
 * dispatches each call to that core. It implements the same connection surface as
 * DevtoolsFallbackConnection so the MCP server (src/server.ts) can use it
 * interchangeably in `--devtools` mode.
 */
import { EventEmitter } from 'node:events';
import { type Channel } from './chrome-use/devtools-port.js';
import { ProxyClient } from './chrome-use/proxy-client.js';
import { ensureProxy, getSocketPath } from './chrome-use/proxy-launcher.js';
import { SessionManager } from './chrome-use/session.js';
import { resolve as resolveSelector } from './chrome-use/selectors.js';
import { takeSnapshot } from './chrome-use/snapshot.js';
import {
  clickElement,
  fillElement,
  typeText,
  pressKey,
  hoverElement,
  scrollBy,
} from './chrome-use/input.js';
import type { CdpClient, TabSession } from './chrome-use/types.js';
import type { ToolDefinition, ToolResult, ToolResultContent } from './types.js';

const UNAVAILABLE_PREFIX = 'chrome-use DevTools backend unavailable';

/** How a CDP connection is established. Injectable so tests can supply a fake. */
export interface CdpConnector {
  connect(): Promise<CdpClient>;
}

/**
 * Default connector: route through the long-lived chrome-use proxy (gateway).
 *
 * Instead of opening a fresh CDP WebSocket per request (which re-triggers Chrome's
 * "Allow remote debugging?" dialog every time and starves the single autoConnect
 * debugger slot), this auto-starts a background proxy that holds ONE approved CDP
 * connection and relays frames over a Unix socket. The dialog fires once per proxy
 * lifetime, and the same proxy is shared by the `--devtools` MCP server and every
 * one-shot `browser --devtools` CLI invocation.
 *
 * The profile directory and release channel can be overridden via
 * `VIBE_CHROME_USER_DATA_DIR` / `VIBE_CHROME_CHANNEL` (e.g. to target Chrome
 * Canary or a custom profile); they are forwarded to the proxy process.
 */
class AutoConnectCdpConnector implements CdpConnector {
  private readonly channel: Channel;
  private readonly userDataDir?: string;

  constructor(channel?: Channel, userDataDir?: string) {
    const envChannel = process.env.VIBE_CHROME_CHANNEL as Channel | undefined;
    this.channel = channel ?? (envChannel || 'stable');
    this.userDataDir = userDataDir ?? process.env.VIBE_CHROME_USER_DATA_DIR ?? undefined;
  }

  async connect(): Promise<CdpClient> {
    const socketPath = getSocketPath();
    const extraEnv: Record<string, string> = { VIBE_CHROME_CHANNEL: this.channel };
    if (this.userDataDir) extraEnv.VIBE_CHROME_USER_DATA_DIR = this.userDataDir;
    await ensureProxy(socketPath, undefined, extraEnv);
    return ProxyClient.open(socketPath, 320_000);
  }
}

interface ChromeUseConnectionOptions {
  /** Override the CDP connector (tests inject a fake here). */
  connector?: CdpConnector;
  channel?: Channel;
  userDataDir?: string;
}

function text(value: string): ToolResultContent {
  return { type: 'text', text: value };
}

function ok(value: string): ToolResult {
  return { success: true, isError: false, content: [text(value)] };
}

function arg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'navigate',
    description: 'Navigate the active tab to a URL (bare domains get https://). Waits for load.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL or bare domain to open' } },
      required: ['url'],
    },
  },
  {
    name: 'snapshot',
    description:
      'Accessibility snapshot of the active page as an indented tree of @eN refs. Use these refs as selectors for click/fill/type. Pass interactive=true for interactive elements only.',
    inputSchema: {
      type: 'object',
      properties: {
        interactive: { type: 'boolean', description: 'Interactive elements only' },
        selector: { type: 'string', description: 'Scope the snapshot to a CSS selector' },
      },
    },
  },
  {
    name: 'click',
    description: 'Click an element. Selector may be a @eN snapshot ref, text=…, or a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: '@eN ref, text=…, or CSS selector' } },
      required: ['selector'],
    },
  },
  {
    name: 'fill',
    description: 'Clear an input/textarea/contenteditable and fill it with text (fires input/change).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '@eN ref, text=…, or CSS selector' },
        text: { type: 'string', description: 'Text to fill' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'type',
    description: 'Focus an element and type text as trusted input (no clearing).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '@eN ref, text=…, or CSS selector' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a key chord on the active page, e.g. Enter, Control+a, Shift+Tab.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key chord, e.g. Enter or Control+a' } },
      required: ['key'],
    },
  },
  {
    name: 'hover',
    description: 'Move the mouse over an element (hover).',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: '@eN ref, text=…, or CSS selector' } },
      required: ['selector'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the active page in a direction by a pixel amount.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Pixels to scroll (default 400)' },
      },
    },
  },
  {
    name: 'screenshot',
    description: 'Capture a PNG screenshot of the active page, returned as a base64 image.',
    inputSchema: {
      type: 'object',
      properties: { fullPage: { type: 'boolean', description: 'Capture beyond the viewport' } },
    },
  },
  {
    name: 'eval',
    description: 'Evaluate a JavaScript expression in the active page and return the JSON result.',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'JavaScript expression to evaluate' } },
      required: ['expression'],
    },
  },
  {
    name: 'get_text',
    description: 'Get the visible innerText of the active page (or an element when selector is given).',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'Optional CSS selector / @eN ref / text=…' } },
    },
  },
  {
    name: 'get_url',
    description: 'Get the current URL of the active page.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_title',
    description: 'Get the document title of the active page.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tabs',
    description: 'List the open browser tabs with their tab id, url, and title.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'new_tab',
    description: 'Open a new browser tab (optionally at a URL) and make it active.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Optional URL to open' } },
    },
  },
  {
    name: 'select_tab',
    description: 'Switch the active tab by tab id (e.g. t2) or index.',
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'string', description: 'Tab id (t1, t2…) or index' } },
      required: ['tab'],
    },
  },
  {
    name: 'close_tab',
    description: 'Close a browser tab (active tab if none specified).',
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'string', description: 'Tab id (t1, t2…) or index; defaults to active' } },
    },
  },
];

/** Normalize a tool name for matching (chrome-use exposes snake/lower forms). */
function normalizeToolName(value: string): string {
  return value.replace(/[-\s]/g, '_').toLowerCase();
}

export class ChromeUseConnection extends EventEmitter {
  private readonly debug: boolean;
  private readonly connector: CdpConnector;
  private cdp: CdpClient | null = null;
  private session: SessionManager | null = null;
  private available = false;
  private unavailableReason?: string;

  constructor(debug: boolean, options: ChromeUseConnectionOptions = {}) {
    super();
    this.debug = debug;
    this.connector =
      options.connector ?? new AutoConnectCdpConnector(options.channel, options.userDataDir);
  }

  async start(): Promise<void> {
    try {
      this.cdp = await this.connector.connect();
      this.session = new SessionManager(this.cdp);
      // Probe the connection so we fail fast with a clear reason if Chrome is gone.
      // But do NOT block startup on the one-time "Allow remote debugging?" approval:
      // if the probe is still pending after a short window, the proxy is up and the
      // dialog is showing — mark available now and let the first real command await
      // approval. This keeps MCP tools/list responsive (no startup hang).
      await this.probeConnection();
      this.available = true;
      this.unavailableReason = undefined;
      this.emit('connected');
      this.emit('tools_updated', this.getTools());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.unavailableReason = `${UNAVAILABLE_PREFIX}: ${message}`;
      this.available = false;
      // Close the client transport (proxy socket / WS) so it doesn't keep the
      // Node event loop alive and hang a one-shot CLI after it prints output.
      if (this.cdp) {
        try {
          this.cdp.close();
        } catch {
          /* ignore */
        }
      }
      this.cdp = null;
      this.session = null;
      this.log(this.unavailableReason);
      this.emit('unavailable', this.unavailableReason);
    }
  }

  /**
   * Probe Browser.getVersion to detect a dead/absent Chrome, but cap the wait so a
   * pending approval dialog never blocks startup. Resolves on success; rethrows if
   * the probe fails fast (Chrome gone); resolves as "deferred" if still pending.
   */
  private async probeConnection(timeoutMs = 4000): Promise<void> {
    const probe = (this.cdp as CdpClient).send('Browser.getVersion');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<'pending'>((resolveRace) => {
      timer = setTimeout(() => resolveRace('pending'), timeoutMs);
    });
    try {
      const outcome = await Promise.race([probe.then(() => 'ok' as const), pending]);
      if (outcome === 'pending') {
        // Approval likely in progress: don't fail, don't await it here. Swallow the
        // probe's eventual settling so it can't raise an unhandled rejection.
        probe.catch(() => {});
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    this.available = false;
    if (this.session) {
      try {
        await this.session.dispose();
      } catch {
        /* ignore */
      }
      this.session = null;
    }
    if (this.cdp) {
      try {
        this.cdp.close();
      } catch {
        /* ignore */
      }
      this.cdp = null;
    }
  }

  /** Tool catalog is static; refresh just re-confirms availability. */
  async refreshTools(_timeoutMs?: number): Promise<ToolDefinition[]> {
    return this.getTools();
  }

  getTools(): ToolDefinition[] {
    return this.available ? TOOLS : [];
  }

  hasTool(name: string): boolean {
    const needle = normalizeToolName(name);
    return this.getTools().some((tool) => normalizeToolName(tool.name) === needle);
  }

  isAvailable(): boolean {
    return this.available;
  }

  getUnavailableReason(): string | undefined {
    return this.unavailableReason;
  }

  async callTool(name: string, args: Record<string, unknown>, _timeoutMs?: number): Promise<ToolResult> {
    if (!this.available || !this.cdp || !this.session) {
      throw new Error(this.unavailableReason || UNAVAILABLE_PREFIX);
    }
    const tool = normalizeToolName(name);

    switch (tool) {
      case 'navigate':
        return this.navigate(args);
      case 'snapshot':
        return this.snapshot(args);
      case 'click':
        return this.actOnElement(args, 'click');
      case 'fill':
        return this.fill(args);
      case 'type':
        return this.type(args);
      case 'press_key':
        return this.pressKey(args);
      case 'hover':
        return this.actOnElement(args, 'hover');
      case 'scroll':
        return this.scroll(args);
      case 'screenshot':
        return this.screenshot(args);
      case 'eval':
        return this.evaluate(args);
      case 'get_text':
        return this.getText(args);
      case 'get_url':
        return this.getUrl();
      case 'get_title':
        return this.getTitle();
      case 'list_tabs':
        return this.listTabs();
      case 'new_tab':
        return this.newTab(args);
      case 'select_tab':
        return this.selectTab(args);
      case 'close_tab':
        return this.closeTab(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ── Tool implementations ───────────────────────────────────────────────────

  private async waitForLoad(tab: TabSession, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await sleep(150);
    while (Date.now() < deadline) {
      try {
        const res = await this.cdp!.send<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
          tab.sessionId,
        );
        if (res?.result?.value === 'complete') return;
      } catch {
        /* page may be mid-navigation; keep polling */
      }
      await sleep(150);
    }
  }

  private normalizeUrl(raw: string): string {
    if (!raw) return raw;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
    if (raw.startsWith('//')) return 'https:' + raw;
    if (raw === 'about:blank') return raw;
    if (/^localhost(:\d+)?(\/|$)/.test(raw) || /\.[a-z]{2,}/i.test(raw)) {
      return 'https://' + raw;
    }
    return raw;
  }

  private async navigate(args: Record<string, unknown>): Promise<ToolResult> {
    const raw = arg(args, 'url');
    if (!raw) throw new Error('navigate: url is required');
    const url = this.normalizeUrl(raw);
    const tab = await this.session!.getActiveTab();
    await this.cdp!.send('Page.navigate', { url }, tab.sessionId);
    await this.waitForLoad(tab);
    try {
      const res = await this.cdp!.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: 'location.href', returnByValue: true },
        tab.sessionId,
      );
      if (typeof res?.result?.value === 'string') tab.url = res.result.value;
    } catch {
      tab.url = url;
    }
    return ok(`Opened ${tab.url}`);
  }

  private async snapshot(args: Record<string, unknown>): Promise<ToolResult> {
    const tab = await this.session!.getActiveTab();
    const r = await takeSnapshot(this.cdp!, tab, {
      interactive: args.interactive === true,
      selector: arg(args, 'selector'),
    });
    tab.refRegistry = r.refs;
    return ok(`${r.text}\n${r.refs.size} refs`);
  }

  private async actOnElement(args: Record<string, unknown>, action: 'click' | 'hover'): Promise<ToolResult> {
    const selector = arg(args, 'selector');
    if (!selector) throw new Error(`${action}: selector is required`);
    const tab = await this.session!.getActiveTab();
    const el = await resolveSelector(this.cdp!, tab, selector);
    if (action === 'click') {
      await clickElement(this.cdp!, tab.sessionId, el);
      return ok(`Clicked ${selector}`);
    }
    await hoverElement(this.cdp!, tab.sessionId, el);
    return ok(`Hovered ${selector}`);
  }

  private async fill(args: Record<string, unknown>): Promise<ToolResult> {
    const selector = arg(args, 'selector');
    const value = typeof args.text === 'string' ? args.text : '';
    if (!selector) throw new Error('fill: selector is required');
    const tab = await this.session!.getActiveTab();
    const el = await resolveSelector(this.cdp!, tab, selector);
    await fillElement(this.cdp!, tab.sessionId, el, value);
    return ok(`Filled ${selector}`);
  }

  private async type(args: Record<string, unknown>): Promise<ToolResult> {
    const selector = arg(args, 'selector');
    const value = typeof args.text === 'string' ? args.text : '';
    if (!selector) throw new Error('type: selector is required');
    const tab = await this.session!.getActiveTab();
    const el = await resolveSelector(this.cdp!, tab, selector);
    await typeText(this.cdp!, tab.sessionId, el, value);
    return ok(`Typed into ${selector}`);
  }

  private async pressKey(args: Record<string, unknown>): Promise<ToolResult> {
    const key = arg(args, 'key');
    if (!key) throw new Error('press_key: key is required');
    const tab = await this.session!.getActiveTab();
    await pressKey(this.cdp!, tab.sessionId, key);
    return ok(`Pressed ${key}`);
  }

  private async scroll(args: Record<string, unknown>): Promise<ToolResult> {
    const raw = (arg(args, 'direction') ?? 'down').toLowerCase();
    const dir = (['up', 'down', 'left', 'right'] as const).includes(raw as 'up')
      ? (raw as 'up' | 'down' | 'left' | 'right')
      : 'down';
    const px = typeof args.amount === 'number' ? args.amount : 400;
    const tab = await this.session!.getActiveTab();
    await scrollBy(this.cdp!, tab.sessionId, dir, px);
    return ok(`Scrolled ${dir} ${px}px`);
  }

  private async screenshot(args: Record<string, unknown>): Promise<ToolResult> {
    const tab = await this.session!.getActiveTab();
    const res = await this.cdp!.send<{ data?: string }>(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: args.fullPage === true, fromSurface: true },
      tab.sessionId,
    );
    if (!res?.data) throw new Error('screenshot: no image data returned');
    return {
      success: true,
      isError: false,
      content: [{ type: 'image', data: res.data, mimeType: 'image/png' }],
    };
  }

  private async evaluate(args: Record<string, unknown>): Promise<ToolResult> {
    const expression = arg(args, 'expression');
    if (!expression) throw new Error('eval: expression is required');
    const tab = await this.session!.getActiveTab();
    const res = await this.cdp!.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string };
    }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      tab.sessionId,
    );
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.text ?? 'eval failed');
    }
    return ok(JSON.stringify(res?.result?.value ?? null, null, 2));
  }

  private async getText(args: Record<string, unknown>): Promise<ToolResult> {
    const selector = arg(args, 'selector');
    const tab = await this.session!.getActiveTab();
    if (!selector) {
      const res = await this.cdp!.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: 'document.body ? document.body.innerText : ""', returnByValue: true },
        tab.sessionId,
      );
      return ok(String(res?.result?.value ?? ''));
    }
    const el = await resolveSelector(this.cdp!, tab, selector);
    const res = await this.cdp!.send<{ result?: { value?: unknown } }>(
      'Runtime.callFunctionOn',
      { objectId: el.objectId, functionDeclaration: 'function(){ return this.innerText; }', returnByValue: true },
      tab.sessionId,
    );
    return ok(String(res?.result?.value ?? ''));
  }

  private async getUrl(): Promise<ToolResult> {
    const tab = await this.session!.getActiveTab();
    const res = await this.cdp!.send<{ result?: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: 'location.href', returnByValue: true },
      tab.sessionId,
    );
    const url = typeof res?.result?.value === 'string' ? res.result.value : tab.url;
    return ok(url);
  }

  private async getTitle(): Promise<ToolResult> {
    const tab = await this.session!.getActiveTab();
    const res = await this.cdp!.send<{ result?: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: 'document.title', returnByValue: true },
      tab.sessionId,
    );
    return ok(String(res?.result?.value ?? ''));
  }

  private async listTabs(): Promise<ToolResult> {
    await this.session!.syncTabs();
    const lines: string[] = [];
    for (const t of this.session!.tabs.values()) {
      const active = t.targetId === this.session!.activeTargetId;
      lines.push(`${active ? '*' : ' '} ${t.tabId}  ${t.url}`);
    }
    return ok(lines.join('\n') || 'No tabs open');
  }

  private async newTab(args: Record<string, unknown>): Promise<ToolResult> {
    const url = arg(args, 'url');
    const created = await this.session!.newTab(url ? this.normalizeUrl(url) : undefined);
    return ok(`Opened ${created.tabId}`);
  }

  private async selectTab(args: Record<string, unknown>): Promise<ToolResult> {
    const id = arg(args, 'tab');
    if (!id) throw new Error('select_tab: tab is required');
    const found = await this.session!.getTab(id);
    if (!found) throw new Error(`No such tab: ${id}`);
    this.session!.setActive(found.targetId);
    return ok(`Switched to ${found.tabId}`);
  }

  private async closeTab(args: Record<string, unknown>): Promise<ToolResult> {
    const id = arg(args, 'tab');
    let victim: TabSession | undefined;
    if (id) {
      victim = await this.session!.getTab(id);
      if (!victim) throw new Error(`No such tab: ${id}`);
    } else {
      victim = await this.session!.getActiveTab();
    }
    const tabId = victim.tabId;
    await this.session!.closeTab(victim.targetId);
    return ok(`Closed tab ${tabId}`);
  }

  private log(message: string): void {
    if (this.debug) {
      console.error(`[vibebrowser-mcp] ${message}`);
    }
  }
}
