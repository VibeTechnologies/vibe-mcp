import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Command } from 'commander';
import { ExtensionConnection } from './connection.js';
import { DEFAULT_WS_PORT, type RelaySessionSummary, type ToolDefinition, type ToolResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Short timeout for the `status` command — it should never block for 30 s. */
const STATUS_TOOLS_TIMEOUT_MS = 2_000;
const DEFAULT_BROWSER_PROFILE = process.env.VIBE_BROWSER_PROFILE || 'user';
const DEFAULT_REMOTE_UUID = process.env.VIBE_EXTENSION_UUID || process.env.VIBE_RELAY_UUID;
const DEFAULT_REMOTE_RELAY_URL = process.env.VIBE_REMOTE_RELAY_URL || process.env.VIBE_RELAY_URL;

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface BrowserCommandOptions {
  browserProfile: string;
  target?: string;
  port: string;
  debug: boolean;
  remote?: string;
  session?: string;
  relayUrl?: string;
  json: boolean;
  timeout: string;
  pageId?: string;
}

interface PageSummary {
  id?: string | number;
  title?: string;
  url?: string;
  active?: boolean;
  [key: string]: JsonValue | undefined;
}

interface RequestSummary {
  requestId?: string;
  url?: string;
  method?: string;
  status?: number;
  [key: string]: JsonValue | undefined;
}

interface CommandOutput {
  ok: boolean;
  command: string;
  profile: string;
  mode: 'local' | 'remote';
  sessionId?: string;
  requestedSessionId?: string;
  sessions?: RelaySessionSummary[];
  ignoredCompatibilityOptions?: string[];
  [key: string]: unknown;
}

interface InvocationResult {
  tool: string;
  args: Record<string, unknown>;
  result: ToolResult & Record<string, unknown>;
}

interface CommandContextInit {
  port: number;
  debug: boolean;
  remoteUuid?: string;
  sessionId?: string;
  relayUrl?: string;
  profile: string;
  json: boolean;
  timeoutMs: number;
  target?: string;
  pageId?: number;
}

interface RefTarget {
  raw: string;
  numeric?: number;
}

export function registerBrowserCommand(program: Command): void {
  const browser = buildBrowserCommand(
    program.command('browser')
  );
  registerBrowserSubcommands(browser);
}

export function registerStandaloneBrowserCli(program: Command): void {
  const browser = buildBrowserCommand(program);
  registerBrowserSubcommands(browser);
}

function buildBrowserCommand(command: Command): Command {
  return command
    .description('OpenClaw-compatible browser CLI for the connected Vibe browser session')
    .option('--browser-profile <name>', 'Compatibility profile name', DEFAULT_BROWSER_PROFILE)
    .option('--target <target>', 'OpenClaw compatibility target selector (accepted, not used by the Vibe browser CLI)')
    .option('-p, --port <number>', 'WebSocket port for local relay (agent) connection', String(DEFAULT_WS_PORT))
    .option('-d, --debug', 'Enable debug logging', false)
    .option('-r, --remote <uuid>', 'Connect to a remote extension via public relay (provide the extension UUID)', DEFAULT_REMOTE_UUID)
    .option('-s, --session <id>', 'Target a specific local browser session ID; defaults to the first connected session')
    .option('--relay-url <url>', 'Custom relay server URL', DEFAULT_REMOTE_RELAY_URL)
    .option('--json', 'Emit machine-readable JSON output', false)
    .option('--timeout <ms>', 'Command timeout in milliseconds', String(DEFAULT_TIMEOUT_MS))
    .option('--page-id <id>', 'Target a specific page/tab by its numeric ID (avoids switching the user\'s active tab)')
    .option('--pageId <id>', 'Alias for --page-id');
}

function registerBrowserSubcommands(browser: Command): void {

  browser
    .command('status')
    .description('Show browser bridge status')
    .action(async function (this: Command) {
      await runBrowserCommand(this, 'status', false, async (ctx) => ctx.status());
    });

  browser
    .command('start')
    .description('Connect to the browser bridge and verify the session is reachable')
    .action(async function (this: Command) {
      await runBrowserCommand(this, 'start', false, async (ctx) => {
        const status = await ctx.status();
        return {
          ...status,
          started: status.extensionConnected,
          managedLifecycle: false,
          note: status.extensionConnected
            ? 'Connected to Vibe browser session'
            : 'Vibe uses an attach-only browser session; no managed browser process was started',
        };
      });
    });

  browser
    .command('stop')
    .description('Compatibility no-op: the Vibe browser bridge does not manage browser process lifecycle')
    .action(async function (this: Command) {
      await runBrowserCommand(this, 'stop', false, async (ctx) => ({
        ...await ctx.status(),
        stopped: false,
        managedLifecycle: false,
        note: 'The Vibe browser bridge does not own the browser process, so stop only disconnects this CLI session',
      }));
    });

  browser
    .command('sessions')
    .description('List connected browser sessions')
    .action(async function (this: Command) {
      await runBrowserCommand(this, 'sessions', false, async (ctx) => ctx.listSessions());
    });

  browser
    .command('tabs')
    .description('List browser tabs/pages')
    .action(async function (this: Command) {
      await runBrowserCommand(this, 'tabs', true, async (ctx) => ctx.listPages());
    });

  const tab = browser.command('tab').description('Tab helpers');
  tab
    .action(async function (this: Command) {
      await runBrowserCommand(this, 'tab', true, async (ctx) => ctx.listPages());
    });

  tab
    .command('new [url]')
    .description('Open a new tab')
    .action(async function (this: Command, url?: string) {
      await runBrowserCommand(this, 'tab new', true, async (ctx) => ctx.open(url));
    });

  tab
    .command('select <id>')
    .description('Switch to a tab/page by its ID (rarely needed — most commands accept a tab id argument instead, prefer that to avoid disrupting the user\'s browser)')
    .action(async function (this: Command, id: string) {
      await runBrowserCommand(this, 'tab select', true, async (ctx) => ctx.focus(id));
    });

  tab
    .command('close <id>')
    .description('Close a tab/page')
    .action(async function (this: Command, id: string) {
      await runBrowserCommand(this, 'tab close', true, async (ctx) => ctx.close(id));
    });

  browser
    .command('open <url>')
    .description('Open a URL in a new page or navigate using the best available tool')
    .action(async function (this: Command, url: string) {
      await runBrowserCommand(this, 'open', true, async (ctx) => ctx.open(url));
    });

  browser
    .command('navigate <url>')
    .description('Navigate the active page to a URL')
    .action(async function (this: Command, url: string) {
      await runBrowserCommand(this, 'navigate', true, async (ctx) => ctx.navigate(url));
    });

  browser
    .command('focus <id>')
    .description('Switch focus to a tab/page by its ID (rarely needed — most commands accept a tab id argument instead, prefer that to avoid disrupting the user\'s browser)')
    .action(async function (this: Command, id: string) {
      await runBrowserCommand(this, 'focus', true, async (ctx) => ctx.focus(id));
    });

  browser
    .command('close <id>')
    .description('Close a tab/page')
    .action(async function (this: Command, id: string) {
      await runBrowserCommand(this, 'close', true, async (ctx) => ctx.close(id));
    });

  browser
    .command('snapshot')
    .description('Capture a textual browser snapshot')
    .option('--format <format>', 'Snapshot format (ai or aria)', 'ai')
    .option('--limit <count>', 'Max visible lines/items to print in human mode')
    .option('--interactive', 'Prefer interactive/ARIA-flavored snapshot output', false)
    .option('--selector <selector>', 'Selector to scope the snapshot to')
    .option('--frame <selector>', 'Frame selector for the snapshot')
    .option('--compact', 'Compatibility flag', false)
    .option('--depth <depth>', 'Compatibility flag')
    .option('--efficient', 'Compatibility flag', false)
    .option('--labels', 'Include labels when supported by backend', false)
    .action(async function (this: Command) {
      await runBrowserCommand(this, 'snapshot', true, async (ctx, options) =>
        ctx.snapshot({
          format: String(options.format || 'ai'),
          limit: options.limit ? parsePositiveInteger(String(options.limit), '--limit') : undefined,
          interactive: Boolean(options.interactive),
          selector: options.selector ? String(options.selector) : undefined,
          frame: options.frame ? String(options.frame) : undefined,
          compact: Boolean(options.compact),
          depth: options.depth ? parsePositiveInteger(String(options.depth), '--depth') : undefined,
          efficient: Boolean(options.efficient),
          labels: Boolean(options.labels),
        })
      );
    });

  browser
    .command('screenshot')
    .description('Capture a browser screenshot')
    .option('--full-page', 'Request a full page screenshot when supported', false)
    .option('--ref <ref>', 'Element ref/index')
    .option('--output <path>', 'Write screenshot bytes to a file')
    .option('--detail <level>', 'Screenshot detail level')
    .option('--grayscale', 'Use grayscale when supported', false)
    .action(async function (this: Command) {
      await runBrowserCommand(this, 'screenshot', true, async (ctx, options) =>
        ctx.screenshot({
          fullPage: Boolean(options.fullPage),
          ref: options.ref ? String(options.ref) : undefined,
          outputPath: options.output ? String(options.output) : undefined,
          detail: options.detail ? String(options.detail) : undefined,
          grayscale: Boolean(options.grayscale),
        })
      );
    });

  // NOTE: pdf, console, errors commands removed — no matching browser tools.

  browser
    .command('requests')
    .description('List network requests')
    .option('--filter <pattern>', 'Substring filter')
    .option('--limit <count>', 'Maximum requests to print')
    .option('--clear', 'Compatibility flag', false)
    .action(async function (this: Command) {
      await runBrowserCommand(this, 'requests', true, async (ctx, options) =>
        ctx.requests({
          filter: options.filter ? String(options.filter) : undefined,
          limit: options.limit ? parsePositiveInteger(String(options.limit), '--limit') : undefined,
        })
      );
    });

  browser
    .command('responsebody [pattern]')
    .description('Show a matching response body when network inspection is available')
    .option('--max-chars <count>', 'Truncate response body output')
    .action(async function (this: Command, pattern?: string) {
      await runBrowserCommand(this, 'responsebody', true, async (ctx, options) =>
        ctx.responseBody({
          pattern,
          maxChars: options.maxChars
            ? parsePositiveInteger(String(options.maxChars), '--max-chars')
            : undefined,
        })
      );
    });

  browser
    .command('resize <width> <height>')
    .description('Resize the current page viewport/window')
    .action(async function (this: Command, width: string, height: string) {
      await runBrowserCommand(this, 'resize', true, async (ctx) =>
        ctx.resize(
          parsePositiveInteger(width, '<width>'),
          parsePositiveInteger(height, '<height>'),
        )
      );
    });

  browser
    .command('click <ref>')
    .description('Click an element by ref/index')
    .option('--double', 'Double click when supported', false)
    .action(async function (this: Command, ref: string) {
      await runBrowserCommand(this, 'click', true, async (ctx, options) =>
        ctx.click(ref, { double: Boolean(options.double) })
      );
    });

  browser
    .command('type <ref> <text>')
    .description('Type/fill text into an element')
    .option('--submit', 'Submit after typing', false)
    .action(async function (this: Command, ref: string, text: string) {
      await runBrowserCommand(this, 'type', true, async (ctx, options) =>
        ctx.type(ref, text, { submit: Boolean(options.submit) })
      );
    });

  browser
    .command('press <keys>')
    .description('Press a key or key chord')
    .action(async function (this: Command, keys: string) {
      await runBrowserCommand(this, 'press', true, async (ctx) => ctx.press(keys));
    });

  browser
    .command('hover <ref>')
    .description('Hover an element by ref/index')
    .action(async function (this: Command, ref: string) {
      await runBrowserCommand(this, 'hover', true, async (ctx) => ctx.hover(ref));
    });

  browser
    .command('upload <ref> <path>')
    .description('Upload a local file via an input element reference')
    .action(async function (this: Command, ref: string, path: string) {
      await runBrowserCommand(this, 'upload', true, async (ctx) => ctx.upload(ref, path));
    });

  // NOTE: scrollintoview, download, waitfordownload commands removed — no matching tools.

  browser
    .command('drag <source> <target>')
    .description('Drag one element to another')
    .action(async function (this: Command, source: string, target: string) {
      await runBrowserCommand(this, 'drag', true, async (ctx) => ctx.drag(source, target));
    });

  browser
    .command('select <ref> <values...>')
    .description('Select one or more values in a field')
    .action(async function (this: Command, ref: string, values: string[]) {
      await runBrowserCommand(this, 'select', true, async (ctx) => ctx.select(ref, values));
    });

  browser
    .command('fill')
    .description('Fill a form using JSON field descriptors')
    .requiredOption('--fields <json>', 'JSON array of field descriptors')
    .action(async function (this: Command) {
      await runBrowserCommand(this, 'fill', true, async (ctx, options) =>
        ctx.fillForm(String(options.fields))
      );
    });

  browser
    .command('dialog')
    .description('Handle browser dialog (accept/dismiss prompt/confirm/alert)')
    .option('--accept', 'Accept dialog', false)
    .option('--dismiss', 'Dismiss dialog', false)
    .option('--prompt <text>', 'Optional prompt text when accepting')
    .action(async function (this: Command) {
      await runBrowserCommand(this, 'dialog', true, async (ctx, options) =>
        ctx.dialog({
          accept: Boolean(options.accept),
          dismiss: Boolean(options.dismiss),
          promptText: options.prompt ? String(options.prompt) : undefined,
        })
      );
    });

  browser
    .command('wait')
    .description('Wait for text or a short delay')
    .option('--text <value...>', 'Texts to wait for')
    .option('--seconds <seconds>', 'Wait for a fixed number of seconds')
    .option('--timeout <ms>', 'Override command timeout')
    .action(async function (this: Command) {
      await runBrowserCommand(this, 'wait', true, async (ctx, options, baseOptions) =>
        ctx.wait({
          text: Array.isArray(options.text) ? options.text.map(String) : undefined,
          seconds: options.seconds ? Number(options.seconds) : undefined,
          timeoutMs: options.timeout ? parsePositiveInteger(String(options.timeout), '--timeout') : parsePositiveInteger(baseOptions.timeout, '--timeout'),
        })
      );
    });

  browser
    .command('evaluate')
    .description('Evaluate JavaScript through the browser tool backend')
    .requiredOption('--fn <function>', 'Function to evaluate')
    .option('--ref <ref>', 'Element ref/index argument')
    .option('--args <json>', 'JSON array of additional arguments')
    .action(async function (this: Command) {
      await runBrowserCommand(this, 'evaluate', true, async (ctx, options) =>
        ctx.evaluate({
          fn: String(options.fn),
          ref: options.ref ? String(options.ref) : undefined,
          argsJson: options.args ? String(options.args) : undefined,
        })
      );
    });

  // NOTE: highlight command removed — no highlight tool; users can use 'hover' directly.
  // NOTE: trace commands removed — no performance_start_trace/performance_stop_trace tools.
}

async function runBrowserCommand(
  command: Command,
  commandName: string,
  requireExtension: boolean,
  handler: (
    ctx: BrowserCliContext,
    localOptions: Record<string, unknown>,
    globalOptions: BrowserCommandOptions,
  ) => Promise<CommandOutput>,
): Promise<void> {
  const globalOptions = command.optsWithGlobals<BrowserCommandOptions>();
  const localOptions = command.opts<Record<string, unknown>>();
  const ctx = new BrowserCliContext({
    port: parsePositiveInteger(globalOptions.port, '--port'),
    debug: Boolean(globalOptions.debug),
    remoteUuid: globalOptions.remote,
    sessionId: globalOptions.session,
    relayUrl: globalOptions.relayUrl,
    profile: globalOptions.browserProfile || DEFAULT_BROWSER_PROFILE,
    json: Boolean(globalOptions.json),
    timeoutMs: parsePositiveInteger(globalOptions.timeout, '--timeout'),
    target: globalOptions.target,
    pageId: globalOptions.pageId ? parsePositiveInteger(globalOptions.pageId, '--page-id') : undefined,
  });

  try {
    await ctx.connect();
    if (requireExtension) {
      await ctx.ensureExtensionConnected();
    }

    const output = await handler(ctx, localOptions, globalOptions);
    emitOutput(Boolean(globalOptions.json), output, formatHumanOutput(commandName, output));
  } catch (error) {
    emitError(Boolean(globalOptions.json), commandName, ctx, error);
    process.exitCode = 1;
  } finally {
    await ctx.shutdown();
  }
}

class BrowserCliContext {
  private readonly connection: ExtensionConnection;
  private readonly profile: string;
  private readonly json: boolean;
  private readonly timeoutMs: number;
  private readonly remoteUuid?: string;
  private readonly requestedSessionId?: string;
  private readonly target?: string;
  private readonly pageId?: number;
  private toolsLoaded = false;
  private tools: ToolDefinition[] = [];
  private sessions: RelaySessionSummary[] = [];
  private readonly ignoredCompatibilityOptions: string[];

  constructor(init: CommandContextInit) {
    this.connection = new ExtensionConnection(
      init.port,
      init.debug,
      init.remoteUuid ? { uuid: init.remoteUuid, relayUrl: init.relayUrl } : undefined,
      init.remoteUuid ? undefined : { sessionId: init.sessionId },
    );
    this.profile = init.profile;
    this.json = init.json;
    this.timeoutMs = init.timeoutMs;
    this.remoteUuid = init.remoteUuid;
    this.requestedSessionId = init.sessionId;
    this.target = init.target;
    this.pageId = init.pageId;
    this.ignoredCompatibilityOptions = [];
    if (this.target) {
      this.ignoredCompatibilityOptions.push(`target=${this.target}`);
    }
  }

  async connect(): Promise<void> {
    await this.connection.start();
    await delay(100);
    this.sessions = await this.connection.listSessions(1_500).catch(() => this.connection.getSessions());
    await this.connection.waitForToolsUpdate(500);
  }

  async shutdown(): Promise<void> {
    await this.connection.stop();
  }

  async ensureExtensionConnected(): Promise<void> {
    if (this.connection.isExtensionConnected()) {
      return;
    }
    this.sessions = await this.connection.listSessions(1_500).catch(() => this.connection.getSessions());
    this.toolsLoaded = false;
    await this.ensureToolsLoaded();
    if (!this.connection.isExtensionConnected() && this.tools.length === 0) {
      throw new Error(this.connection.getConnectionErrorMessage());
    }
  }

  async listSessions(): Promise<CommandOutput> {
    this.sessions = await this.connection.listSessions(this.timeoutMs);
    return {
      ok: true,
      command: 'sessions',
      profile: this.profile,
      mode: this.mode(),
      ignoredCompatibilityOptions: this.ignoredCompatibilityOptions,
      sessionId: this.currentSessionId(),
      requestedSessionId: this.requestedSessionId,
      sessions: this.sessions,
    };
  }

  async status(): Promise<CommandOutput> {
    this.sessions = await this.connection.listSessions(STATUS_TOOLS_TIMEOUT_MS).catch(() => this.connection.getSessions());
    await this.ensureToolsLoaded(STATUS_TOOLS_TIMEOUT_MS);

    return {
      ok: true,
      command: 'status',
      profile: this.profile,
      mode: this.remoteUuid ? 'remote' : 'local',
      sessionId: this.currentSessionId(),
      requestedSessionId: this.requestedSessionId,
      sessions: this.sessions,
      ignoredCompatibilityOptions: this.ignoredCompatibilityOptions,
      relayConnected: this.connection.getStatus() === 'connected',
      extensionConnected: this.connection.isExtensionConnected(),
      managedLifecycle: false,
      transport: 'vibebrowser-mcp',
      toolCount: this.tools.length,
      tools: this.tools.map((tool) => tool.name),
    };
  }

  async listPages(): Promise<CommandOutput> {
    const invocation = await this.callTool(
      'tabs',
      [
        { names: ['list_pages', 'get_tabs'] },
      ],
      {}
    );
    const pages = extractPages(invocation.result);
    return {
      ok: true,
      command: 'tabs',
      profile: this.profile,
      mode: this.mode(),
      sessionId: this.currentSessionId(),
      requestedSessionId: this.requestedSessionId,
      ignoredCompatibilityOptions: this.ignoredCompatibilityOptions,
      tool: invocation.tool,
      pages,
      raw: normalizeToolResult(invocation.result),
    };
  }

  async open(url?: string): Promise<CommandOutput> {
    if (!url) {
      return this.callGenericCommand('open', [{ names: ['new_page', 'create_new_tab'] }], {});
    }

    try {
      const invocation = await this.callTool(
        'open',
        [
          {
            names: ['new_page', 'create_new_tab'],
            buildArgs: (tool) => withOpenArgs(tool, url),
          },
          {
            names: ['navigate_page', 'navigate_to_url'],
            buildArgs: (tool) => withNavigateArgs(tool, url, this.timeoutMs),
          },
        ],
        {}
      );

      const output = this.outputFromInvocation('open', invocation);
      return this.ensurePageContentInOutput('open', invocation, output, url);
    } catch (error) {
      const recovered = await this.recoverPageContentAfterTimeout('open', url, error);
      if (recovered) {
        return recovered;
      }
      throw error;
    }
  }

  async navigate(url: string): Promise<CommandOutput> {
    try {
      const invocation = await this.callTool(
        'navigate',
        [
          {
            names: ['navigate_page', 'navigate_to_url'],
            buildArgs: (tool) => withNavigateArgs(tool, url, this.timeoutMs),
          },
          {
            names: ['new_page', 'create_new_tab'],
            buildArgs: (tool) => withOpenArgs(tool, url),
          },
        ],
        {}
      );
      const output = this.outputFromInvocation('navigate', invocation);
      return this.ensurePageContentInOutput('navigate', invocation, output, url);
    } catch (error) {
      const recovered = await this.recoverPageContentAfterTimeout('navigate', url, error);
      if (recovered) {
        return recovered;
      }
      throw error;
    }
  }

  async close(id: string): Promise<CommandOutput> {
    const invocation = await this.callTool(
      'close',
      [
        {
          names: ['close_page', 'close_tab'],
          buildArgs: (tool) => withPageArgs(tool, id),
        },
      ],
      {}
    );
    return this.outputFromInvocation('close', invocation);
  }

  async focus(id: string): Promise<CommandOutput> {
    const invocation = await this.callTool(
      'focus',
      [
        {
          names: ['switch_to_page', 'switch_to_tab', 'select_page', 'focus_tab'],
          buildArgs: (tool) => withPageArgs(tool, id),
        },
      ],
      {}
    );
    return this.outputFromInvocation('focus', invocation);
  }

  async snapshot(options: {
    format: string;
    limit?: number;
    interactive: boolean;
    selector?: string;
    frame?: string;
    compact: boolean;
    depth?: number;
    efficient: boolean;
    labels: boolean;
  }): Promise<CommandOutput> {
    const wantsAria = options.format === 'aria' || options.interactive || Boolean(options.selector) || Boolean(options.frame);
    const invocation = await this.callTool(
      'snapshot',
      [
        {
          names: [wantsAria ? 'take_a11y_snapshot' : 'take_md_snapshot'],
          buildArgs: (tool: ToolDefinition) => withSnapshotArgs(tool, options),
        },
      ],
      {}
    );

    const text = firstText(invocation.result);
    return {
      ok: true,
      command: 'snapshot',
      profile: this.profile,
      mode: this.mode(),
      ignoredCompatibilityOptions: this.ignoredCompatibilityOptions,
      tool: invocation.tool,
      format: wantsAria ? 'aria' : options.format,
      snapshot: limitText(text, options.limit),
      raw: normalizeToolResult(invocation.result),
    };
  }

  async screenshot(options: {
    fullPage: boolean;
    ref?: string;
    outputPath?: string;
    detail?: string;
    grayscale: boolean;
  }): Promise<CommandOutput> {
    const invocation = await this.callTool(
      'screenshot',
      [
        {
          names: ['take_screenshot', 'screenshot'],
          buildArgs: (tool) => withScreenshotArgs(tool, options),
        },
      ],
      {}
    );
    const savedPath = maybeWriteBinaryOutput(invocation.result, options.outputPath);
    return {
      ok: true,
      command: 'screenshot',
      profile: this.profile,
      mode: this.mode(),
      ignoredCompatibilityOptions: this.ignoredCompatibilityOptions,
      tool: invocation.tool,
      outputPath: savedPath || options.outputPath,
      raw: normalizeToolResult(invocation.result),
    };
  }

  async requests(options: {
    filter?: string;
    limit?: number;
  }): Promise<CommandOutput> {
    const invocation = await this.callTool(
      'requests',
      [
        {
          names: ['list_network_requests'],
          buildArgs: (tool) => withRequestListArgs(tool, options),
        },
      ],
      {}
    );

    let requests = extractRequests(invocation.result);
    if (options.filter) {
      const needle = options.filter.toLowerCase();
      requests = requests.filter((request) =>
        JSON.stringify(request).toLowerCase().includes(needle)
      );
    }
    if (options.limit) {
      requests = requests.slice(0, options.limit);
    }

    return {
      ok: true,
      command: 'requests',
      profile: this.profile,
      mode: this.mode(),
      ignoredCompatibilityOptions: this.ignoredCompatibilityOptions,
      tool: invocation.tool,
      requests,
      raw: normalizeToolResult(invocation.result),
    };
  }

  async responseBody(options: {
    pattern?: string;
    maxChars?: number;
  }): Promise<CommandOutput> {
    const requests = await this.requests({ filter: options.pattern, limit: 1 });
    const list = Array.isArray(requests.requests) ? requests.requests as RequestSummary[] : [];
    const first = list[0];
    const requestId = first?.requestId ?? guessRequestId(requests.raw);
    if (!requestId) {
      throw new Error('No matching network request found');
    }

    const invocation = await this.callTool(
      'responsebody',
      [
        {
          names: ['get_network_request'],
          buildArgs: (tool) => withRequestDetailsArgs(tool, requestId),
        },
      ],
      {}
    );

    const body = limitText(extractResponseBody(invocation.result), options.maxChars);
    return {
      ok: true,
      command: 'responsebody',
      profile: this.profile,
      mode: this.mode(),
      ignoredCompatibilityOptions: this.ignoredCompatibilityOptions,
      requestId,
      tool: invocation.tool,
      responseBody: body,
      raw: normalizeToolResult(invocation.result),
    };
  }

  async click(ref: string, options: { double: boolean }): Promise<CommandOutput> {
    const invocation = await this.callTool(
      'click',
      [
        {
          names: ['click'],
          buildArgs: (tool) => withRefArgs(tool, ref, { dblClick: options.double }),
        },
      ],
      {}
    );
    return this.outputFromInvocation('click', invocation);
  }

  async type(ref: string, text: string, options: { submit: boolean }): Promise<CommandOutput> {
    const invocation = await this.callTool(
      'type',
      [
        {
          names: ['fill'],
          buildArgs: (tool) => withFillArgs(tool, ref, text),
        },
        {
          names: ['type_text', 'type'],
          buildArgs: (tool) => withTypeArgs(tool, text, options.submit ? 'Enter' : undefined),
        },
      ],
      {}
    );
    return this.outputFromInvocation('type', invocation);
  }

  async press(keys: string): Promise<CommandOutput> {
    const invocation = await this.callTool(
      'press',
      [
        {
          names: ['press_key', 'keyboard_shortcut'],
          buildArgs: (tool) => withKeysArgs(tool, keys),
        },
      ],
      {}
    );
    return this.outputFromInvocation('press', invocation);
  }

  async hover(ref: string): Promise<CommandOutput> {
    const invocation = await this.callTool(
      'hover',
      [
        {
          names: ['hover'],
          buildArgs: (tool) => withRefArgs(tool, ref),
        },
      ],
      {}
    );
    return this.outputFromInvocation('hover', invocation);
  }

  async drag(source: string, target: string): Promise<CommandOutput> {
    const invocation = await this.callTool(
      'drag',
      [
        {
          names: ['drag'],
          buildArgs: (tool) => withDragArgs(tool, source, target),
        },
      ],
      {}
    );
    return this.outputFromInvocation('drag', invocation);
  }

  async select(ref: string, values: string[]): Promise<CommandOutput> {
    const invocation = await this.callTool(
      'select',
      [
        {
          names: ['fill'],
          buildArgs: (tool) => withFillArgs(tool, ref, values.length === 1 ? values[0] : values),
        },
        {
          names: ['select_option', 'select'],
          buildArgs: (tool) => withSelectArgs(tool, ref, values),
        },
      ],
      {}
    );
    return this.outputFromInvocation('select', invocation);
  }

  async fillForm(fieldsJson: string): Promise<CommandOutput> {
    const fields = parseJsonValue(fieldsJson, '--fields');
    if (!Array.isArray(fields)) {
      throw new Error('--fields must be a JSON array');
    }
    const invocation = await this.callTool(
      'fill',
      [
        {
          names: ['fill_form'],
          buildArgs: (tool) => withFillFormArgs(tool, fields),
        },
      ],
      {}
    );
    return this.outputFromInvocation('fill', invocation);
  }

  async wait(options: {
    text?: string[];
    seconds?: number;
    timeoutMs: number;
  }): Promise<CommandOutput> {
    if (options.text && options.text.length > 0) {
      const invocation = await this.callTool(
        'wait',
        [
          {
            names: ['wait_for'],
            buildArgs: (tool) => withWaitArgs(tool, options.text!, options.timeoutMs),
          },
        ],
        {}
      );
      return this.outputFromInvocation('wait', invocation);
    }

    if (typeof options.seconds === 'number' && Number.isFinite(options.seconds) && options.seconds >= 0) {
      await delay(Math.round(options.seconds * 1000));
      return {
        ok: true,
        command: 'wait',
        profile: this.profile,
        mode: this.mode(),
        ignoredCompatibilityOptions: this.ignoredCompatibilityOptions,
        waitedSeconds: options.seconds,
      };
    }

    throw new Error('wait requires either --text or --seconds');
  }

  async evaluate(options: {
    fn: string;
    ref?: string;
    argsJson?: string;
  }): Promise<CommandOutput> {
    const invocation = await this.callTool(
      'evaluate',
      [
        {
          names: ['evaluate_script'],
          buildArgs: (tool) => withEvaluateArgs(tool, options.fn, options.ref, options.argsJson),
        },
      ],
      {}
    );
    return this.outputFromInvocation('evaluate', invocation);
  }

  async resize(width: number, height: number): Promise<CommandOutput> {
    const invocation = await this.callTool(
      'resize',
      [
        {
          names: ['resize_page'],
          buildArgs: (tool) => withResizeArgs(tool, width, height),
        },
      ],
      {}
    );
    return this.outputFromInvocation('resize', invocation);
  }

  async upload(ref: string, path: string): Promise<CommandOutput> {
    const invocation = await this.callTool(
      'upload',
      [
        {
          names: ['upload_file', 'file_upload'],
          buildArgs: (tool) => withUploadArgs(tool, ref, path),
        },
      ],
      {}
    );
    return this.outputFromInvocation('upload', invocation);
  }

  async dialog(options: {
    accept: boolean;
    dismiss: boolean;
    promptText?: string;
  }): Promise<CommandOutput> {
    if (options.accept && options.dismiss) {
      throw new Error('dialog supports either --accept or --dismiss, not both');
    }
    const accept = options.dismiss ? false : true;
    const invocation = await this.callTool(
      'dialog',
      [
        {
          names: ['handle_dialog'],
          buildArgs: (tool) => withDialogArgs(tool, accept, options.promptText),
        },
      ],
      {}
    );
    return this.outputFromInvocation('dialog', invocation);
  }

  private async callGenericCommand(
    commandName: string,
    candidates: ToolCandidate[],
    canonicalArgs: Record<string, unknown>,
  ): Promise<CommandOutput> {
    const invocation = await this.callTool(commandName, candidates, canonicalArgs);
    return this.outputFromInvocation(commandName, invocation);
  }

  private async callTool(
    commandName: string,
    candidates: ToolCandidate[],
    canonicalArgs: Record<string, unknown>,
  ): Promise<InvocationResult> {
    await this.ensureToolsLoaded();

    const available = new Map(this.tools.map((tool) => [normalizeName(tool.name), tool]));
    for (const candidate of candidates) {
      for (const candidateName of candidate.names) {
        const tool = available.get(normalizeName(candidateName));
        if (!tool) {
          continue;
        }
        const args = candidate.buildArgs
          ? candidate.buildArgs(tool)
          : withCanonicalArgs(tool, canonicalArgs);
        // Inject --page-id into every tool call that accepts pageId/tabId,
        // so the agent doesn't need to use focus/tab select (which disrupts
        // the user's active browser tab).
        if (this.pageId !== undefined) {
          const pageKey = hasProperty(tool, 'pageId', 'tabId');
          if (pageKey && !(pageKey in args)) {
            args[pageKey] = this.pageId;
          }
        }
        if (shouldRequestPageStateForCommand(commandName)) {
          const pageStateKey = hasProperty(tool, 'pageStateFormat', 'page_state_format');
          if (pageStateKey && !('pageStateFormat' in args) && !('page_state_format' in args)) {
            args[pageStateKey] = 'markdown';
          }
        }
        const result = await this.connection.callTool(tool.name, args, this.timeoutMs);
        return { tool: tool.name, args, result: result as ToolResult & Record<string, unknown> };
      }
    }

    const requested = candidates.flatMap((candidate) => candidate.names);
    throw new Error(
      `No compatible browser tool found for "${commandName}". Tried ${requested.join(', ')}. Available tools: ${this.tools.map((tool) => tool.name).join(', ')}`
    );
  }

  private async ensureToolsLoaded(timeoutMs?: number): Promise<void> {
    if (this.toolsLoaded && this.tools.length > 0) {
      return;
    }
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    try {
      this.tools = await this.connection.refreshTools(effectiveTimeout);
    } catch {
      // Refresh timed out or failed — fall back to cached tools or a short
      // passive wait so the status command is not blocked.
      this.tools = this.connection.getTools();
      if (this.tools.length === 0) {
        this.tools = await this.connection.waitForToolsUpdate(1_000);
      }
    }
    this.toolsLoaded = true;
  }

  private outputFromInvocation(commandName: string, invocation: InvocationResult): CommandOutput {
    const pageContent = firstText(invocation.result);
    return {
      ok: !invocation.result.isError,
      command: commandName,
      profile: this.profile,
      mode: this.mode(),
      sessionId: this.currentSessionId(),
      requestedSessionId: this.requestedSessionId,
      ignoredCompatibilityOptions: this.ignoredCompatibilityOptions,
      tool: invocation.tool,
      ...(looksLikePageContentText(pageContent) ? { pageContent } : {}),
      raw: normalizeToolResult(invocation.result),
    };
  }

  private async ensurePageContentInOutput(
    commandName: 'open' | 'navigate',
    invocation: InvocationResult,
    output: CommandOutput,
    targetUrl?: string,
  ): Promise<CommandOutput> {
    if (!output.ok) {
      return output;
    }

    if (!hasExplicitPageContext(invocation.args)) {
      return output;
    }

    const currentText = firstText(invocation.result);
    if (looksLikePageContentText(currentText) && !isLikelyIncompletePageContent(currentText, targetUrl)) {
      return output;
    }

    const targetPageId = extractPageIdFromResult(invocation.result) ?? this.pageId;
    if (targetPageId === undefined) {
      return output;
    }

    const fallback = await this.takeMarkdownSnapshotForTarget(targetPageId, targetUrl);
    if (!fallback.content) {
      return output;
    }

    return {
      ...output,
      pageContent: fallback.content,
      pageContentSource: 'take_md_snapshot',
      ...(fallback.pageId !== targetPageId ? { pageId: fallback.pageId } : {}),
    };
  }

  private async recoverPageContentAfterTimeout(
    commandName: 'open' | 'navigate',
    url: string,
    error: unknown,
  ): Promise<CommandOutput | undefined> {
    if (!isTimeoutError(error)) {
      return undefined;
    }

    if (this.pageId === undefined) {
      return undefined;
    }

    const recoveryTimeoutMs = Math.max(this.timeoutMs, 10_000);

    let targetPageId = this.pageId;

    if (targetPageId === undefined) {
      return undefined;
    }

    const fallback = await this.takeMarkdownSnapshotForTarget(targetPageId, url, recoveryTimeoutMs);
    if (!fallback.content) {
      return undefined;
    }

    return {
      ok: true,
      command: commandName,
      profile: this.profile,
      mode: this.mode(),
      sessionId: this.currentSessionId(),
      requestedSessionId: this.requestedSessionId,
      ignoredCompatibilityOptions: this.ignoredCompatibilityOptions,
      tool: 'take_md_snapshot',
      recoveredFromTimeout: true,
      pageId: fallback.pageId,
      url,
      pageContent: fallback.content,
      raw: {
        recovery: 'timeout_fallback',
      },
    };
  }

  private async takeMarkdownSnapshotForTarget(
    initialPageId: number,
    targetUrl?: string,
    timeoutMs: number = this.timeoutMs,
  ): Promise<{ content?: string; pageId: number }> {
    let latest: string | undefined;
    let pageId = initialPageId;
    const recoveryTimeoutMs = Math.max(timeoutMs, 10_000);
    const attempts = 8;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      latest = await this.takeMarkdownSnapshotForPage(pageId, recoveryTimeoutMs);
      if (latest && !isLikelyIncompletePageContent(latest, targetUrl)) {
        return { content: latest, pageId };
      }

      if (targetUrl) {
        const pages = await this.listPagesForRecovery(recoveryTimeoutMs);
        const matched = findBestPageMatchByUrl(pages, targetUrl);
        if (matched) {
          pageId = matched.id;
        }
      }

      if (attempt < attempts - 1) {
        await delay(750);
      }
    }
    return { content: latest, pageId };
  }

  private async listPagesForRecovery(timeoutMs: number): Promise<PageSummary[]> {
    try {
      await this.ensureToolsLoaded(timeoutMs);
      const listTool = this.tools.find((tool) => {
        const normalized = normalizeName(tool.name);
        return normalized === 'list_pages' || normalized === 'get_tabs';
      });
      if (!listTool) {
        return [];
      }

      const result = await this.connection.callTool(listTool.name, {}, timeoutMs);
      return extractPages(result as ToolResult & Record<string, unknown>);
    } catch {
      return [];
    }
  }

  private async takeMarkdownSnapshotForPage(pageId: number, timeoutMs: number = this.timeoutMs): Promise<string | undefined> {
    await this.ensureToolsLoaded();
    const snapshotTool = this.tools.find((tool) => normalizeName(tool.name) === 'take_md_snapshot');
    if (!snapshotTool) {
      return undefined;
    }

    const args: Record<string, unknown> = {};
    const pageKey = hasProperty(snapshotTool, 'pageId', 'tabId');
    if (pageKey) {
      args[pageKey] = pageId;
    }
    const pageStateKey = hasProperty(snapshotTool, 'pageStateFormat', 'page_state_format');
    if (pageStateKey) {
      args[pageStateKey] = 'markdown';
    }

    try {
      const result = await this.connection.callTool(snapshotTool.name, args, timeoutMs);
      const text = firstText(result as ToolResult & Record<string, unknown>);
      if (!text) {
        return undefined;
      }
      const trimmed = text.trim();
      if (/^Error:/i.test(trimmed) || /Failed to get valid tab/i.test(trimmed)) {
        return undefined;
      }
      return text;
    } catch {
      return undefined;
    }
  }

  private mode(): 'local' | 'remote' {
    return this.remoteUuid ? 'remote' : 'local';
  }

  private currentSessionId(): string | undefined {
    if (this.remoteUuid) {
      return this.remoteUuid;
    }

    const connectedSessionIds = new Set(
      this.sessions
        .filter((session) => session.connected)
        .map((session) => session.sessionId)
    );

    if (this.requestedSessionId && connectedSessionIds.has(this.requestedSessionId)) {
      return this.requestedSessionId;
    }

    return this.sessions.find((session) => session.connected)?.sessionId;
  }
}

interface ToolCandidate {
  names: string[];
  buildArgs?: (tool: ToolDefinition) => Record<string, unknown>;
}

function shouldRequestPageStateForCommand(commandName: string): boolean {
  return new Set([
    'open',
    'navigate',
    'click',
    'type',
    'press',
    'hover',
    'drag',
    'select',
    'fill',
  ]).has(commandName);
}

function looksLikePageContentText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (/Error retrieving page content/i.test(trimmed) || /page content extraction failed/i.test(trimmed)) {
    return false;
  }
  return /```(?:markdown|text|html)/i.test(trimmed) || /Page State Format:/i.test(trimmed);
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

function shouldAttachImplicitPageContent(commandName: string, args: Record<string, unknown>): boolean {
  if (!hasExplicitPageContext(args)) {
    return false;
  }

  return commandName !== 'close';
}

function stripImplicitPageContent(result: ToolResult & Record<string, unknown>): ToolResult & Record<string, unknown> {
  const firstTextIndex = result.content.findIndex((entry) => entry.type === 'text');
  if (firstTextIndex < 0) {
    return result;
  }

  const firstTextEntry = result.content[firstTextIndex];
  if (!('text' in firstTextEntry) || !looksLikePageContentText(firstTextEntry.text)) {
    return result;
  }

  return {
    ...result,
    content: result.content.filter((_, index) => index !== firstTextIndex),
  };
}

function isLikelyIncompletePageContent(text: string, targetUrl?: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }

  const interactiveRefCount = (trimmed.match(/\[M\d+:/g) || []).length;

  // Common in early snapshots right after new_page(waitForReady=false):
  // tab exists but title/url are still empty.
  if (/Tab ID:[^\n]*\nTitle:\s*\nURL:\s*(?:\n|$)/i.test(trimmed)) {
    return true;
  }

  if (/#\s*Markdown Snapshot:\s*Untitled/i.test(trimmed) && interactiveRefCount < 5) {
    return true;
  }

  if (targetUrl) {
    const normalizedTarget = normalizeUrlForMatch(targetUrl);
    const hasAnyUrl = /\bURL:\s*\S+/i.test(trimmed);
    const textNormalized = normalizeUrlForMatch(trimmed);
    if (!hasAnyUrl) {
      return true;
    }
    if (normalizedTarget && !textNormalized.includes(normalizedTarget)) {
      return true;
    }
  }

  return false;
}

function extractPageIdFromResult(result: ToolResult & Record<string, unknown>): number | undefined {
  const direct = firstDefined(result, ['pageId', 'tabId', 'id']);
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct;
  }

  const parsed = parseResultText(result);
  if (parsed && typeof parsed === 'object') {
    const parsedId = firstDefined(parsed as Record<string, unknown>, ['pageId', 'tabId', 'id']);
    if (typeof parsedId === 'number' && Number.isFinite(parsedId)) {
      return parsedId;
    }
  }

  const text = firstText(result);
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

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|timeout/i.test(message);
}

function findBestPageMatchByUrl(pages: PageSummary[], targetUrl: string): { id: number; url?: string } | undefined {
  const normalizedTarget = normalizeUrlForMatch(targetUrl);
  let bestExact: { id: number; url?: string } | undefined;
  let bestPartial: { id: number; url?: string } | undefined;

  for (const page of pages) {
    const id = toFinitePageId(page.id);
    if (id === undefined || typeof page.url !== 'string') {
      continue;
    }
    const normalizedPage = normalizeUrlForMatch(page.url);
    if (normalizedPage === normalizedTarget) {
      if (!bestExact || id > bestExact.id) {
        bestExact = { id, url: page.url };
      }
    }
    if (normalizedPage.includes(normalizedTarget) || normalizedTarget.includes(normalizedPage)) {
      if (!bestPartial || id > bestPartial.id) {
        bestPartial = { id, url: page.url };
      }
    }
  }

  return bestExact ?? bestPartial;
}

function toFinitePageId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeUrlForMatch(value: string): string {
  const trimmed = value.trim().replace(/\/$/, '');
  if (!trimmed) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    return safeDecode(`${parsed.origin}${parsed.pathname}${parsed.search}`.replace(/\/$/, ''));
  } catch {
    return safeDecode(trimmed);
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function emitOutput(asJson: boolean, data: CommandOutput, humanOutput: string): void {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(humanOutput);
}

function emitError(
  asJson: boolean,
  commandName: string,
  ctx: BrowserCliContext,
  error: unknown,
): void {
  let message = error instanceof Error ? error.message : String(error);
  // Improve guidance when the extension requires a pageId that wasn't provided
  if (/\bpageId\b/i.test(message) && /\bmissing\b|\brequired\b/i.test(message)) {
    message += '\nHint: use `tabs` to list pages, then pass --page-id <id> to target a specific tab.';
  }
  if (asJson) {
    console.log(JSON.stringify({
      ok: false,
      command: commandName,
      profile: DEFAULT_BROWSER_PROFILE,
      mode: 'local',
      error: message,
    }, null, 2));
    return;
  }
  console.error(`Error: ${message}`);
}

function formatHumanOutput(commandName: string, output: CommandOutput): string {
  switch (commandName) {
    case 'status':
    case 'start':
    case 'stop':
      return [
        `Profile: ${String(output.profile)}`,
        `Mode: ${String(output.mode)}`,
        output.sessionId ? `Session: ${String(output.sessionId)}` : null,
        output.requestedSessionId && output.requestedSessionId !== output.sessionId ? `Requested session: ${String(output.requestedSessionId)}` : null,
        `Relay connected: ${boolText(output.relayConnected)}`,
        `Extension connected: ${boolText(output.extensionConnected)}`,
        `Managed lifecycle: ${boolText(output.managedLifecycle)}`,
        output.toolCount !== undefined ? `Tools: ${String(output.toolCount)}` : null,
        output.note ? String(output.note) : null,
      ].filter(Boolean).join('\n');
    case 'sessions': {
      const sessions = Array.isArray(output.sessions) ? output.sessions as RelaySessionSummary[] : [];
      if (sessions.length === 0) {
        return 'No browser sessions connected';
      }
      return sessions.map((session, index) => {
        const selected = output.sessionId === session.sessionId ? ' [selected]' : '';
        const connected = session.connected ? 'connected' : 'disconnected';
        const tools = session.toolCount !== undefined ? ` tools=${session.toolCount}` : '';
        return `${index + 1}. ${session.sessionId}${selected} - ${connected}${tools}`;
      }).join('\n');
    }
    case 'tabs':
    case 'tab': {
      const pages = Array.isArray(output.pages) ? output.pages as PageSummary[] : [];
      if (pages.length === 0) {
        return firstDefinedText(output.raw, 'No tabs reported by browser');
      }
      return [
        output.sessionId ? `Session: ${String(output.sessionId)}` : null,
        ...pages.map((page, index) =>
        `${index + 1}. ${page.active ? '[active] ' : ''}${page.title || '(untitled)'}${page.url ? ` — ${page.url}` : ''}${page.id !== undefined ? ` [id=${page.id}]` : ''}`
      ),
      ].filter(Boolean).join('\n');
    }
    case 'snapshot':
      return [
        output.title ? `Title: ${String(output.title)}` : null,
        output.url ? `URL: ${String(output.url)}` : null,
        output.snapshot ? String(output.snapshot) : firstDefinedText(output.raw, ''),
      ].filter(Boolean).join('\n');
    case 'requests': {
      const requests = Array.isArray(output.requests) ? output.requests as RequestSummary[] : [];
      if (requests.length === 0) {
        return firstDefinedText(output.raw, 'No requests reported by browser');
      }
      return requests.map((request, index) =>
        `${index + 1}. ${request.method || 'GET'} ${request.url || '(unknown)'}${request.status !== undefined ? ` [${request.status}]` : ''}${request.requestId ? ` [id=${request.requestId}]` : ''}`
      ).join('\n');
    }
    case 'responsebody':
      return String(output.responseBody ?? firstDefinedText(output.raw, ''));
    default:
      if (output.outputPath) {
        return `Saved to ${String(output.outputPath)}`;
      }
      return firstDefinedText(output.raw, JSON.stringify(output, null, 2));
  }
}

function boolText(value: unknown): string {
  return value ? 'yes' : 'no';
}

function firstDefinedText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (value && typeof value === 'object') {
    // Direct { text: "..." } wrapper
    if ('text' in value && typeof (value as { text?: unknown }).text === 'string') {
      return (value as { text: string }).text;
    }
    // MCP tool result: { content: [{ type: 'text', text: '...' }] }
    const rec = value as Record<string, unknown>;
    if (Array.isArray(rec.content)) {
      const textItem = rec.content.find(
        (entry: unknown) =>
          entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'text'
      ) as { text?: string } | undefined;
      if (textItem && typeof textItem.text === 'string' && textItem.text.length > 0) {
        return textItem.text;
      }
    }
  }
  return fallback;
}

function normalizeToolResult(result: ToolResult & Record<string, unknown>): JsonValue {
  return sanitizeUnknown(result) ?? null;
}

function sanitizeUnknown(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item) ?? null);
  if (value && typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const sanitized = sanitizeUnknown(entry);
      if (sanitized !== undefined) {
        output[key] = sanitized;
      }
    }
    return output;
  }
  return undefined;
}

function maybeWriteBinaryOutput(
  result: ToolResult & Record<string, unknown>,
  outputPath?: string,
): string | undefined {
  if (!outputPath) {
    return undefined;
  }

  const image = result.content?.find((item) => item.type === 'image');
  if (!image || !('data' in image) || typeof image.data !== 'string') {
    return undefined;
  }

  const target = resolve(outputPath);
  writeFileSync(target, Buffer.from(image.data, 'base64'));
  return target;
}

function extractPages(result: ToolResult & Record<string, unknown>): PageSummary[] {
  const direct = extractStructured(result, ['pages', 'tabs', 'targets']);
  if (Array.isArray(direct)) {
    return direct.map((entry) => normalizePage(entry));
  }

  const parsed = parseResultText(result);
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => normalizePage(entry));
  }
  if (parsed && typeof parsed === 'object') {
    for (const key of ['pages', 'tabs', 'targets']) {
      const candidate = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) {
        return candidate.map((entry) => normalizePage(entry));
      }
    }
  }

  // Fallback: parse the plain-text format produced by ListPagesTool
  // e.g. 'Page 123 [ACTIVE]: "Google" - https://www.google.com'
  const text = firstText(result);
  if (text) {
    const textPages = parsePlainTextPages(text);
    if (textPages.length > 0) {
      return textPages;
    }
  }
  return [];
}

// Matches ListPagesTool output: 'Page <id>[ [ACTIVE]]: "title" - url'
const PAGE_LINE_RE = /^Page\s+(\d+)\s*(\[ACTIVE\])?\s*:\s*"(.*)"\s*-\s*(.+)$/i;

function parsePlainTextPages(text: string): PageSummary[] {
  const pages: PageSummary[] = [];
  for (const line of text.split('\n')) {
    const match = PAGE_LINE_RE.exec(line.trim());
    if (match) {
      pages.push({
        id: Number(match[1]),
        active: match[2] !== undefined,
        title: match[3],
        url: match[4].trim(),
      });
    }
  }
  return pages;
}

function normalizePage(value: unknown): PageSummary {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    ...sanitizeUnknown(record) as Record<string, JsonValue>,
    id: firstDefined(record, ['pageId', 'tabId', 'id', 'targetId']) as string | number | undefined,
    title: firstString(record, ['title', 'name']),
    url: firstString(record, ['url']),
    active: firstBoolean(record, ['active', 'selected', 'focused']),
  };
}

function extractRequests(result: ToolResult & Record<string, unknown>): RequestSummary[] {
  const direct = extractStructured(result, ['requests']);
  if (Array.isArray(direct)) {
    return direct.map((entry) => normalizeRequest(entry));
  }

  const parsed = parseResultText(result);
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => normalizeRequest(entry));
  }
  if (parsed && typeof parsed === 'object') {
    const requests = (parsed as Record<string, unknown>).requests;
    if (Array.isArray(requests)) {
      return requests.map((entry) => normalizeRequest(entry));
    }
  }
  return [];
}

function normalizeRequest(value: unknown): RequestSummary {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    ...sanitizeUnknown(record) as Record<string, JsonValue>,
    requestId: firstString(record, ['requestId', 'reqid', 'id']),
    url: firstString(record, ['url']),
    method: firstString(record, ['method']),
    status: firstNumber(record, ['status']),
  };
}

function extractResponseBody(result: ToolResult & Record<string, unknown>): string {
  const direct = extractStructured(result, ['responseBody', 'body']);
  if (typeof direct === 'string') {
    return direct;
  }
  const parsed = parseResultText(result);
  if (parsed && typeof parsed === 'object') {
    for (const key of ['responseBody', 'body']) {
      const candidate = (parsed as Record<string, unknown>)[key];
      if (typeof candidate === 'string') {
        return candidate;
      }
    }
  }
  return firstText(result);
}

function guessRequestId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.requestId === 'string') {
    return record.requestId;
  }
  return undefined;
}

function extractStructured(
  result: ToolResult & Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (key in result) {
      return result[key];
    }
  }
  return undefined;
}

function parseResultText(result: ToolResult & Record<string, unknown>): unknown {
  const text = firstText(result);
  if (!text) {
    return undefined;
  }
  return parseJsonText(text);
}

function firstText(result: ToolResult & Record<string, unknown>): string {
  const item = result.content?.find((entry) => entry.type === 'text');
  return item && 'text' in item && typeof item.text === 'string' ? item.text : '';
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidates = [trimmed];
  if (trimmed.startsWith('```')) {
    const fenced = trimmed
      .replace(/^```[a-zA-Z0-9_-]*\n/, '')
      .replace(/\n```$/, '')
      .trim();
    candidates.push(fenced);
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next candidate.
    }
  }
  return undefined;
}

function parseJsonValue(text: string, label: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} must be valid JSON: ${message}`);
  }
}

function stringifyJson(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function limitText(text: string, limit?: number): string {
  if (!limit || limit <= 0) {
    return text;
  }
  const lines = text.split('\n');
  return lines.length <= limit ? text : `${lines.slice(0, limit).join('\n')}\n...`;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeName(value: string): string {
  return value.replace(/[-\s]/g, '_').toLowerCase();
}

function toolProperties(tool: ToolDefinition): Record<string, unknown> {
  return tool.inputSchema.properties ?? {};
}

function hasProperty(tool: ToolDefinition, ...names: string[]): string | undefined {
  const properties = toolProperties(tool);
  return names.find((name) => Object.prototype.hasOwnProperty.call(properties, name));
}

function withCanonicalArgs(tool: ToolDefinition, canonicalArgs: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(canonicalArgs)) {
    if (value === undefined) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(toolProperties(tool), key)) {
      output[key] = value;
    }
  }
  return output;
}

function withUrlArgs(tool: ToolDefinition, url: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const urlKey = hasProperty(tool, 'url');
  if (urlKey) args[urlKey] = url;
  const typeKey = hasProperty(tool, 'type');
  if (typeKey && normalizeName(tool.name) === 'navigate_page') {
    args[typeKey] = 'url';
  }
  return args;
}

function withOpenArgs(tool: ToolDefinition, url: string): Record<string, unknown> {
  const args = withUrlArgs(tool, url);
  const waitForReadyKey = hasProperty(tool, 'waitForReady');
  if (waitForReadyKey) {
    args[waitForReadyKey] = false;
  }
  return stripUndefined(args);
}

function withNavigateArgs(tool: ToolDefinition, url: string, timeoutMs?: number): Record<string, unknown> {
  const args = withUrlArgs(tool, url);
  const pageIdKey = hasProperty(tool, 'pageId', 'tabId');
  if (pageIdKey && !(pageIdKey in args)) {
    args[pageIdKey] = undefined;
  }
  const timeoutKey = hasProperty(tool, 'timeoutMs', 'timeout');
  if (timeoutKey && typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) {
    args[timeoutKey] = timeoutMs;
  }
  return stripUndefined(args);
}

function withPageArgs(tool: ToolDefinition, id: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const numeric = Number.parseInt(id, 10);
  const key = hasProperty(tool, 'pageId', 'tabId', 'id');
  if (key) {
    args[key] = Number.isFinite(numeric) && String(numeric) === id ? numeric : id;
  }
  return args;
}

function withSnapshotArgs(
  tool: ToolDefinition,
  options: {
    format: string;
    selector?: string;
    frame?: string;
    compact: boolean;
    depth?: number;
    efficient: boolean;
    labels: boolean;
  },
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  maybeAssign(args, tool, 'format', options.format);
  maybeAssign(args, tool, 'selector', options.selector);
  maybeAssign(args, tool, 'frame', options.frame);
  maybeAssign(args, tool, 'compact', options.compact || undefined);
  maybeAssign(args, tool, 'depth', options.depth);
  maybeAssign(args, tool, 'efficient', options.efficient || undefined);
  maybeAssign(args, tool, 'labels', options.labels || undefined);
  maybeAssign(args, tool, 'a11y', true);
  maybeAssign(args, tool, 'markdown', false);
  return args;
}

function withScreenshotArgs(
  tool: ToolDefinition,
  options: {
    fullPage: boolean;
    ref?: string;
    detail?: string;
    grayscale: boolean;
  },
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (options.ref) {
    Object.assign(args, withRefArgs(tool, options.ref));
  }
  maybeAssign(args, tool, 'fullPage', options.fullPage || undefined);
  maybeAssign(args, tool, 'detail', options.detail);
  maybeAssign(args, tool, 'grayscale', options.grayscale || undefined);
  return args;
}

function withRequestListArgs(
  tool: ToolDefinition,
  options: {
    limit?: number;
  },
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (options.limit) {
    maybeAssign(args, tool, 'limit', options.limit);
    maybeAssign(args, tool, 'pageSize', options.limit);
  }
  return args;
}

function withRequestDetailsArgs(tool: ToolDefinition, requestId: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  maybeAssign(args, tool, 'requestId', requestId);
  maybeAssign(args, tool, 'reqid', requestId);
  return args;
}

function withResizeArgs(tool: ToolDefinition, width: number, height: number): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  maybeAssign(args, tool, 'width', width);
  maybeAssign(args, tool, 'height', height);
  return args;
}

function withRefArgs(
  tool: ToolDefinition,
  ref: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...extra };
  const parsedRef = parseRef(ref);
  if (hasProperty(tool, 'ref')) {
    args.ref = parsedRef.raw;
  }
  if (parsedRef.numeric !== undefined && hasProperty(tool, 'index')) {
    args.index = parsedRef.numeric;
  }
  if (hasProperty(tool, 'uid')) {
    args.uid = parsedRef.raw;
  }
  if (hasProperty(tool, 'selector')) {
    args.selector = parsedRef.raw;
  }
  return args;
}

function withFillArgs(tool: ToolDefinition, ref: string, value: string | string[]): Record<string, unknown> {
  const args = withRefArgs(tool, ref);
  if (hasProperty(tool, 'value')) {
    args.value = Array.isArray(value) ? value[0] : value;
  }
  if (hasProperty(tool, 'text')) {
    args.text = Array.isArray(value) ? value.join(' ') : value;
  }
  return args;
}

function withTypeArgs(tool: ToolDefinition, text: string, submitKey?: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  maybeAssign(args, tool, 'text', text);
  maybeAssign(args, tool, 'value', text);
  if (submitKey) {
    maybeAssign(args, tool, 'submitKey', submitKey);
  }
  return args;
}

function withKeysArgs(tool: ToolDefinition, keys: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  maybeAssign(args, tool, 'keys', keys);
  maybeAssign(args, tool, 'shortcut', keys);
  maybeAssign(args, tool, 'key', keys);
  return args;
}

function withDragArgs(tool: ToolDefinition, source: string, target: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (hasProperty(tool, 'source')) {
    args.source = source;
  }
  if (hasProperty(tool, 'target')) {
    args.target = target;
  }
  if (hasProperty(tool, 'from_uid')) {
    args.from_uid = source;
  }
  if (hasProperty(tool, 'to_uid')) {
    args.to_uid = target;
  }
  return args;
}

function withSelectArgs(tool: ToolDefinition, ref: string, values: string[]): Record<string, unknown> {
  const args = withRefArgs(tool, ref);
  maybeAssign(args, tool, 'value', values.length === 1 ? values[0] : values);
  maybeAssign(args, tool, 'values', values);
  return args;
}

function withFillFormArgs(tool: ToolDefinition, fields: JsonValue[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  maybeAssign(args, tool, 'fields', fields);
  maybeAssign(args, tool, 'elements', fields);
  return args;
}

function withUploadArgs(tool: ToolDefinition, ref: string, path: string): Record<string, unknown> {
  const args = withRefArgs(tool, ref);
  maybeAssign(args, tool, 'filePath', path);
  maybeAssign(args, tool, 'path', path);
  if (hasProperty(tool, 'paths')) {
    args.paths = [path];
  }
  return args;
}

function withDialogArgs(tool: ToolDefinition, accept: boolean, promptText?: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (hasProperty(tool, 'action')) {
    args.action = accept ? 'accept' : 'dismiss';
  }
  if (hasProperty(tool, 'accept')) {
    args.accept = accept;
  }
  if (promptText !== undefined) {
    maybeAssign(args, tool, 'promptText', promptText);
    maybeAssign(args, tool, 'prompt', promptText);
    if (hasProperty(tool, 'prompt_text')) {
      args.prompt_text = promptText;
    }
  }
  return args;
}

function withWaitArgs(tool: ToolDefinition, text: string[], timeoutMs: number): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  maybeAssign(args, tool, 'text', text);
  maybeAssign(args, tool, 'timeout', timeoutMs);
  return args;
}

function withEvaluateArgs(
  tool: ToolDefinition,
  fn: string,
  ref?: string,
  argsJson?: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  maybeAssign(args, tool, 'function', fn);

  const values: string[] = [];
  if (ref) {
    values.push(ref);
  }
  if (argsJson) {
    const parsed = parseJsonValue(argsJson, '--args');
    if (!Array.isArray(parsed)) {
      throw new Error('--args must be a JSON array');
    }
    for (const entry of parsed) {
      values.push(typeof entry === 'string' ? entry : JSON.stringify(entry));
    }
  }

  if (values.length > 0) {
    maybeAssign(args, tool, 'args', values);
  }
  return args;
}

function maybeAssign(target: Record<string, unknown>, tool: ToolDefinition, property: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (hasProperty(tool, property)) {
    target[property] = value;
  }
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function parseRef(ref: string): RefTarget {
  const numeric = Number.parseInt(ref, 10);
  return {
    raw: ref,
    numeric: Number.isFinite(numeric) && String(numeric) === ref ? numeric : undefined,
  };
}

function firstDefined(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  const value = firstDefined(record, keys);
  return typeof value === 'string' ? value : undefined;
}

function firstBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  const value = firstDefined(record, keys);
  return typeof value === 'boolean' ? value : undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  const value = firstDefined(record, keys);
  return typeof value === 'number' ? value : undefined;
}
