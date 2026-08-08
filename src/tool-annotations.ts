/**
 * MCP tool annotations.
 *
 * The MCP spec lets a server describe each tool's behaviour so that clients can
 * decide what needs a confirmation prompt, what is safe to retry, and what
 * reaches the open internet. Both the Anthropic Connectors directory and the
 * OpenAI plugins directory make these a hard listing requirement.
 *
 * Shape (fetched from the current spec, not from memory —
 * <https://modelcontextprotocol.io/specification/latest/schema>, `ToolAnnotations`):
 *
 *   interface ToolAnnotations {
 *     title?: string;
 *     readOnlyHint?: boolean;      // tool does not modify its environment.  Default false
 *     destructiveHint?: boolean;   // may perform destructive updates.       Default true
 *                                  //   (meaningful only when readOnlyHint == false)
 *     idempotentHint?: boolean;    // repeat calls w/ same args add no effect. Default false
 *     openWorldHint?: boolean;     // interacts with an open, external world. Default true
 *   }
 *
 * `Tool.title` is a separate top-level field on the tool itself; we emit both so
 * that clients reading either location get a human-readable name.
 *
 * ---------------------------------------------------------------------------
 * Classification rules used below (applied by reading each implementation, not
 * by guessing from the tool's name):
 *
 *   readOnlyHint    true only if the call cannot change the browser, the page,
 *                   or anything the page can reach. Reading is fine; *anything*
 *                   that clicks, types, navigates, resizes, closes, or executes
 *                   page JavaScript is not read-only.
 *   destructiveHint true if a single call can irreversibly lose state — a closed
 *                   tab, a submitted form, an arbitrary script, a drag that
 *                   reorders or deletes. Additive-only edits are false.
 *   idempotentHint  true if calling twice with identical arguments leaves the
 *                   same end state. Relative operations (scroll by N, type more
 *                   text, navigate through a flow) are false.
 *   openWorldHint   true if the call can reach a URL/host the caller chooses —
 *                   navigation, fetching, arbitrary JS (it can `fetch()`), or
 *                   clicking a link.
 *
 * Two entries are deliberately counter-intuitive; both were resolved by reading
 * the extension source rather than the tool name:
 *
 *   wait_for_condition  reads like an observer, but evaluates a caller-supplied
 *                       JavaScript expression through `new Function()` in the
 *                       page. That is arbitrary code execution, so it is NOT
 *                       read-only.  (vibe: lib/extension/tools/InteractionTools.js)
 *   secrets_manager     reads like a mutator, but only supports `list` and
 *                       `read` of credential *metadata*, never writes and never
 *                       returns plaintext. It IS read-only.
 *                       (vibe: lib/extension/tools/CredentialManagerTool.js)
 */

import type { ToolDefinition } from './types.js';

/** The four behavioural hints plus a display title, all required internally. */
export interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** A tool definition enriched with its title and annotations, ready for `tools/list`. */
export interface AnnotatedToolDefinition extends ToolDefinition {
  title: string;
  annotations: McpToolAnnotations;
}

/**
 * Normalize a tool name for registry lookup.
 *
 * Backends spell the same tool differently (`press_key` vs `keyboard-shortcut`
 * vs `Press Key`), so match on a canonical lower-snake form.
 */
export function normalizeAnnotationKey(value: string): string {
  return value.replace(/[-\s]/g, '_').toLowerCase();
}

/** Terser helper so the table below stays readable. */
function annotate(
  title: string,
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean
): McpToolAnnotations {
  return { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}

/**
 * Annotations applied when a backend advertises a tool we have never classified.
 *
 * Deliberately the most cautious combination the spec allows — assume it writes,
 * assume it can destroy, assume it is unsafe to retry, assume it touches the
 * internet. A client will then prompt the user, which is the correct failure
 * mode for an unknown capability. `assertAnnotationCoverage` exists so that this
 * fallback never silently becomes the answer for a tool we actually ship.
 */
export const FALLBACK_TOOL_ANNOTATIONS: Omit<McpToolAnnotations, 'title'> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * The classification table.
 *
 *                                                         readOnly  destructive  idempotent  openWorld
 */
export const TOOL_ANNOTATIONS: Record<string, McpToolAnnotations> = {
  // ---- server meta-tool -------------------------------------------------
  // Repoints this server at a different relay, dropping the current session's
  // connection. Same URL twice lands in the same place, hence idempotent.
  set_remote: annotate('Set Relay Target', false, true, true, true),

  // ---- extension core profile (CORE_BROWSER_PROFILE, 27 tools) -----------
  list_pages: annotate('List Pages', true, false, true, false),
  new_page: annotate('Open New Page', false, false, false, true),
  close_page: annotate('Close Page', false, true, true, false),
  navigate_page: annotate('Navigate Page', false, false, false, true),
  switch_to_page: annotate('Switch Page', false, false, true, false),
  // A click dispatches a real DOM click: it can submit a form, follow a link to
  // any host, or open a new tab. Not read-only, and open-world.
  // (vibe: lib/extension/tools/IndexedInteractionTools.js — `action: 'click'`,
  //  with a new-tab tracker armed specifically for clicks.)
  click: annotate('Click Element', false, false, true, true),
  fill: annotate('Fill Field', false, false, true, false),
  fill_form: annotate('Fill Form', false, false, true, false),
  type_text: annotate('Type Text', false, false, false, false),
  wait_for: annotate('Wait For Element', true, false, true, false),
  wait_for_url: annotate('Wait For URL', true, false, true, false),
  wait_for_network_idle: annotate('Wait For Network Idle', true, false, true, false),
  // Executes a caller-supplied JS expression in the page — see header note.
  wait_for_condition: annotate('Wait For Condition', false, true, false, true),
  scroll_page: annotate('Scroll Page', false, false, false, false),
  // Enter submits, Ctrl+W closes a tab — a key chord can destroy state.
  press_key: annotate('Press Key', false, true, false, true),
  hover: annotate('Hover Element', false, false, true, false),
  drag: annotate('Drag Element', false, true, false, false),
  take_screenshot: annotate('Take Screenshot', true, false, true, false),
  take_snapshot: annotate('Take Page Snapshot', true, false, true, false),
  evaluate_script: annotate('Evaluate Script', false, true, false, true),
  list_network_requests: annotate('List Network Requests', true, false, true, false),
  get_network_request: annotate('Get Network Request', true, false, true, false),
  // Fetches a caller-chosen URL. Reads only, but reaches the open internet.
  web_fetch: annotate('Fetch Web Page', true, false, true, true),
  // Pushes local file contents into a page that may upload them anywhere.
  upload_file: annotate('Upload File', false, false, true, true),
  resize_page: annotate('Resize Page', false, false, true, false),
  list_console_messages: annotate('List Console Messages', true, false, true, false),
  // `list` / `read` of credential metadata only — see header note.
  secrets_manager: annotate('Read Saved Credential Metadata', true, false, true, false),

  // ---- chrome-use `--devtools` backend (src/chrome-use-connection.ts) ----
  navigate: annotate('Navigate', false, false, false, true),
  snapshot: annotate('Accessibility Snapshot', true, false, true, false),
  type: annotate('Type Text', false, false, false, false),
  scroll: annotate('Scroll Page', false, false, false, false),
  screenshot: annotate('Take Screenshot', true, false, true, false),
  eval: annotate('Evaluate JavaScript', false, true, false, true),
  get_text: annotate('Get Page Text', true, false, true, false),
  get_url: annotate('Get Page URL', true, false, true, false),
  get_title: annotate('Get Page Title', true, false, true, false),
  list_tabs: annotate('List Tabs', true, false, true, false),
  new_tab: annotate('Open New Tab', false, false, false, true),
  select_tab: annotate('Select Tab', false, false, true, false),
  close_tab: annotate('Close Tab', false, true, true, false),

  // ---- aliases other backends / older builds advertise -------------------
  // Same behaviour, different spelling; classified identically to their twin.
  navigate_to_url: annotate('Navigate To URL', false, false, false, true),
  go_back: annotate('Go Back', false, false, false, true),
  go_forward: annotate('Go Forward', false, false, false, true),
  get_page_content: annotate('Get Page Content', true, false, true, false),
  get_tabs: annotate('List Tabs', true, false, true, false),
  create_new_tab: annotate('Open New Tab', false, false, false, true),
  switch_to_tab: annotate('Switch Tab', false, false, true, false),
  keyboard_shortcut: annotate('Press Keyboard Shortcut', false, true, false, true),
  web_search: annotate('Web Search', true, false, true, true),
  take_md_snapshot: annotate('Take Markdown Snapshot', true, false, true, false),
  take_a11y_snapshot: annotate('Take Accessibility Snapshot', true, false, true, false),
  take_html_snapshot: annotate('Take HTML Snapshot', true, false, true, false),
  // Types a stored secret into a field; overwrites that field only.
  typein_secret: annotate('Type Saved Secret', false, false, true, false),
  media_control: annotate('Control Media Playback', false, false, false, false),
  storage_get: annotate('Read Page Storage', true, false, true, false),
  storage_set: annotate('Write Page Storage', false, false, true, false),
  storage_clear: annotate('Clear Page Storage', false, true, true, false),
};

/**
 * Look up a tool's annotations, or `undefined` when it is not classified.
 *
 * Callers that need a value regardless should use {@link annotateTool}, which
 * falls back to the cautious defaults.
 */
export function getToolAnnotations(name: string): McpToolAnnotations | undefined {
  return TOOL_ANNOTATIONS[normalizeAnnotationKey(name)];
}

/**
 * Derive a display title for an unclassified tool: `press_key` -> `Press Key`.
 *
 * Only used alongside {@link FALLBACK_TOOL_ANNOTATIONS}; a shipped tool should
 * always have a hand-written title in the table above.
 */
function deriveTitle(name: string): string {
  return normalizeAnnotationKey(name)
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Attach `title` + `annotations` to a tool definition for the `tools/list` reply. */
export function annotateTool(tool: ToolDefinition): AnnotatedToolDefinition {
  const known = getToolAnnotations(tool.name);
  const annotations: McpToolAnnotations = known ?? {
    title: deriveTitle(tool.name),
    ...FALLBACK_TOOL_ANNOTATIONS,
  };

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    title: annotations.title,
    annotations,
  };
}

/**
 * Every tool name this server can expose, across all backends.
 *
 * Kept explicit (rather than derived at runtime) so the coverage test can run
 * without a browser: it is the contract that each of these has a hand-written
 * classification. Adding a tool to a backend without adding it here — or here
 * without adding it to {@link TOOL_ANNOTATIONS} — fails the test.
 */
export const EXTENSION_CORE_TOOL_NAMES: readonly string[] = [
  'list_pages', 'new_page', 'close_page', 'navigate_page', 'switch_to_page',
  'click', 'fill', 'fill_form', 'type_text', 'wait_for', 'wait_for_url',
  'wait_for_network_idle', 'wait_for_condition', 'scroll_page',
  'press_key', 'hover', 'drag',
  'take_screenshot', 'take_snapshot',
  'evaluate_script',
  'list_network_requests', 'get_network_request', 'web_fetch',
  'upload_file',
  'resize_page',
  'list_console_messages',
  'secrets_manager',
];

/**
 * Assert that every supplied tool name has a hand-written classification.
 *
 * Throws listing the offenders, so the failure names the tool that needs
 * classifying rather than just going red.
 */
export function assertAnnotationCoverage(names: readonly string[]): void {
  const missing = names.filter((name) => !getToolAnnotations(name));
  if (missing.length > 0) {
    throw new Error(
      `Missing MCP tool annotations for: ${missing.join(', ')}. ` +
        `Add an entry to TOOL_ANNOTATIONS in src/tool-annotations.ts.`
    );
  }
}
