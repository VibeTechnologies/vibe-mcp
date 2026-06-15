---
name: vibebrowser
description: Control the user's local browser through the Vibe Browser CLI bridge. Use this when the task must run against the user's real Vibe-connected browser session, tabs, cookies, or installed extensions.
metadata:
  {
    "openclaw":
      {
        "emoji": "🌐",
        "requires":
          {
            "bins": ["npx"],
          },
      },
  }
---

# Vibe Local Browser

## Installation

1. **Get the remote value**:
   - Install the Vibe extension in Chrome
   - Open extension Settings → **AI Agent Control**
   - Toggle **Enable external AI agent control** to ON
   - Set **Connection mode** to **Remote (internet)**
   - Copy the relay URL from the **Relay access** section

2. **Provide the remote value** (one of):
   - Pass it directly on every command with `--remote <uuid-or-url>` — no environment variable needed.
   - Or set it once as an environment variable so `--remote` can be omitted (the CLI picks it up automatically):
     ```bash
     export VIBE_REMOTE_URL="<uuid-or-full-ws-url>"
     ```
   - **Preferred: save it for the session** — see [## Remembering the remote connection](#remembering-the-remote-connection) below.

3. **Install the skill**:
   Copy this file to your OpenClaw skills directory (typically `~/.openclaw/skills/` or your project's `openclaw/skills/` folder).

Use the `@vibebrowser/cli` command when the user wants OpenClaw to drive their real local browser through the Vibe extension.

Prefer this skill when the task depends on:

- the user's real browser profile
- existing logged-in sessions
- local tabs already open on the user's machine
- browser extensions or stored site state

Do not use this skill for OpenClaw tenant cloud browsing.

## Remote value

Every command needs a remote value: the extension UUID (uses the default public relay) or a full `ws(s)` relay URL (explicit relay endpoint).

Pass it with `--remote <uuid-or-url>`. No environment variable is required when `--remote` is set.

Optionally, set it once via environment instead — the CLI uses it as the default when `--remote` is omitted (checked in this order):

```bash
export VIBE_REMOTE_URL="<uuid-or-full-ws-url>"
# Also honored: VIBE_EXTENSION_UUID, VIBE_RELAY_UUID

# Optional compatibility label. Vibe always targets the real local browser path.
# export VIBE_BROWSER_PROFILE="user"
```

> **Warning:** if neither `--remote` nor one of these environment variables is set, the CLI silently falls back to *local* relay mode (it waits for an extension on a local WebSocket port) instead of failing with a clear error. When driving a remote browser, always confirm a remote value is in effect.

## Remembering the remote connection

The user should only have to provide their remote value once. After receiving it, save it immediately and reuse it on every subsequent browser command without asking again.

### What counts as a "remote value"

Either of these forms is valid for `--remote`:

- A bare UUID: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
- A full relay URL: `wss://relay.api.vibebrowser.app/<uuid>`

### How to save it (priority order)

**Option A — Memory tool (preferred):** If the agent runtime provides a memory or "remember" tool, store the value under the key `vibebrowser_remote`:

```
remember("vibebrowser_remote", "<uuid-or-wss-url>")
```

On later turns, recall it before running any browser command:

```
recall("vibebrowser_remote")  # → use as --remote value
```

**Option B — Local context file (fallback):** If no memory tool is available, write the value to a file named `vibebrowser-cli.md` in the agent's working directory. Use this exact format so it can be machine-read back:

```markdown
# VibeBrowser CLI context
remote: <uuid-or-wss-url>
```

At the start of any browser task, check whether `vibebrowser-cli.md` exists and read the `remote:` line to recover the value. Create or overwrite the file when the value is first provided or updated.

### Rules for using the remembered value

1. **On every browser command**, load the remembered remote (from memory or `vibebrowser-cli.md`) and pass it as `--remote "<remembered-value>"`.
2. **Only ask the user** for the remote if none is remembered and the user did not provide one in the current message.
3. **If the remembered remote stops working** — for example, `status` returns `extensionConnected: false`, or commands repeatedly fail — tell the user clearly and offer to update the saved value (then overwrite memory / `vibebrowser-cli.md` with the new one).

### Example: first use

User: "Open google.com in my browser. My remote is `abc12345-...`."

Agent actions:
1. Save `abc12345-...` to memory under key `vibebrowser_remote` (or write to `vibebrowser-cli.md`).
2. Run:
   ```bash
   npx @vibebrowser/cli --remote "abc12345-..." --json status --wait-for-extension --wait-timeout 10000
   npx @vibebrowser/cli --remote "abc12345-..." --json open https://google.com
   ```

### Example: subsequent use (same or later session)

User: "Now open github.com."

Agent actions:
1. Recall `vibebrowser_remote` from memory (or read `vibebrowser-cli.md` → `remote:` line).
2. Run without asking the user:
   ```bash
   npx @vibebrowser/cli --remote "<remembered-value>" --json open https://github.com
   ```

## Command form

Prefer this exact command pattern:

```bash
npx @vibebrowser/cli --remote "<uuid-or-url>" --json status
```

Pass only one of these remote forms: `--remote <uuid>` for the default public relay, or `--remote <full-ws-url>` for an explicit relay endpoint.

The examples below use `$VIBE_REMOTE_URL` as a stand-in for the remote value — substitute the literal UUID/URL if no environment variable is set. If `VIBE_REMOTE_URL` (or `VIBE_EXTENSION_UUID` / `VIBE_RELAY_UUID`) is exported, `--remote` can be omitted entirely:

```bash
npx @vibebrowser/cli --json status
```

## Deterministic runbook (default)

Use this sequence when the task needs reliable, repeatable control:

1. Verify connection:
   ```bash
   npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json status --wait-for-extension --wait-timeout 10000
   ```
2. Resolve a target page id without changing focus:
   ```bash
   PAGE_ID="$(
      npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json tabs \
     | jq -r '.pages[] | select(.active == true) | .id' \
     | head -n1
   )"
   ```
3. Snapshot that page before acting:
   ```bash
   npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json --page-id "$PAGE_ID" snapshot --format aria --interactive
   ```
   If the aria snapshot is too verbose, try the default first and fall back:
   ```bash
   npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json --page-id "$PAGE_ID" snapshot
   # If empty or only title returned, retry with aria:
   npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json --page-id "$PAGE_ID" snapshot --format aria --interactive
   ```
4. Perform action on the same page id:
   ```bash
   npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json --page-id "$PAGE_ID" click 12
   ```

If `jq` is unavailable, parse `.pages` from `tabs --json` directly and still pass `--page-id <id>` on every action.

## Safe operating rules

- **Never use `focus` or `tab select` unless explicitly asked.** The user may be actively working in the browser — switching their active tab is disruptive. Instead, pass `--page-id <id>` (or `--pageId <id>`) to target a specific tab without switching focus. Get the page ID from `tabs` output, then use it on any command:
  ```bash
  npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json --page-id 2 snapshot
  npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json --page-id 2 click 7
  ```
- Prefer `tabs` or `snapshot` before acting.
- `snapshot` is tool-only and maps to the extension's `take_snapshot` tool (with `format` param for markdown vs aria).
- Use `open <url>` to create a fresh page when possible.
- Use `evaluate --fn ...` only for simple compatibility-safe expressions such as:
  - `() => 21 + 21`
  - `() => document.title`
  - `() => location.href`
  - `() => location.hostname`
  - `() => location.origin`
- Avoid destructive actions unless the user explicitly asks.
- If the CLI returns a connection error, report it clearly and stop guessing.
- The OpenClaw-compatible `--browser-profile` flag is accepted by the CLI, but Vibe always targets the user's real browser path rather than an isolated managed browser.

## Common commands

Status:

```bash
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json status
```

List pages:

```bash
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json tabs
```

Open a new page:

```bash
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json open https://example.com
```

Take the default AI snapshot:

```bash
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json snapshot
```

Take the ARIA / interactive snapshot:

```bash
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json snapshot --format aria --interactive
```

Click and type using OpenClaw-style refs:

```bash
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json click 12
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json type 23 "hello" --submit
```

Evaluate JavaScript:

```bash
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json evaluate --fn '() => document.title'
```

## Snapshot format: `ai` vs `aria`

The `snapshot` command supports two extraction formats:

| Format | Flag | Engine | Best for |
|--------|------|--------|----------|
| `ai` (default) | `--format ai` | Content script (in-page JS) | Simple pages, articles, search results |
| `aria` | `--format aria` | CDP accessibility tree | **SPAs, background tabs, Notion, Gmail, complex apps** |

**When the default `--format ai` returns only the page title or empty content**, switch to `--format aria`:

```bash
# Default — may return empty for background tabs or SPAs like Notion
npx @vibebrowser/cli ... snapshot

# Reliable fallback — uses Chrome DevTools Protocol directly, works on background tabs
npx @vibebrowser/cli ... snapshot --format aria --interactive
```

**Known limitations of `--format ai`:**
- Returns empty for **background tabs** (content script not injected or `getBoundingClientRect` returns 0x0)
- Returns `"Could not establish connection"` when the content script is unreachable
- May miss content behind `aria-hidden` containers in SPAs like Notion

**Rule of thumb:** If `snapshot` returns suspiciously little content, retry with `--format aria --interactive` before reporting failure.

## Success criteria

A successful run usually looks like:

1. confirm the relay is reachable
2. list current tabs or create a fresh one
3. navigate or snapshot if needed
4. evaluate `document.title` or `location.href` to verify the result
5. summarize what happened for the user
