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
            "env": ["VIBE_EXTENSION_UUID"],
          },
      },
  }
---

# Vibe Local Browser

## Installation

1. **Get the Extension UUID**:
   - Install the Vibe extension in Chrome
   - Open extension Settings → MCP External
   - Enable Remote mode and copy the Extension UUID

2. **Set environment variable**:
   ```bash
   export VIBE_EXTENSION_UUID="<your-extension-uuid>"
   ```

3. **Install the skill**:
   Copy this file to your OpenClaw skills directory (typically `~/.openclaw/skills/` or your project's `openclaw/skills/` folder).

Use the `vibebrowser-cli` command when the user wants OpenClaw to drive their real local browser through the Vibe extension.

Prefer this skill when the task depends on:

- the user's real browser profile
- existing logged-in sessions
- local tabs already open on the user's machine
- browser extensions or stored site state

Do not use this skill for OpenClaw tenant cloud browsing.

## Required environment

The shell running OpenClaw must have:

```bash
export VIBE_EXTENSION_UUID="<extension-uuid>"

# Optional if you use a custom relay URL.
# export VIBE_REMOTE_RELAY_URL="wss://relay.api.vibebrowser.app"
# export VIBE_RELAY_URL="wss://relay.api.vibebrowser.app"  # legacy alias

# Optional compatibility label. Vibe always targets the real local browser path.
# export VIBE_BROWSER_PROFILE="user"
```

## Command form

Prefer this exact command pattern:

```bash
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json <subcommand> ...
```

If the package is already installed locally, you can use:

```bash
vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json <subcommand> ...
```

If you set `VIBE_RELAY_URL`, append:

```bash
--relay-url "$VIBE_RELAY_URL"
```

If you set `VIBE_REMOTE_RELAY_URL`, use:

```bash
--relay-url "$VIBE_REMOTE_RELAY_URL"
```

## Deterministic runbook (default)

Use this sequence when the task needs reliable, repeatable control:

1. Verify connection:
   ```bash
   npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json status --wait-for-extension --wait-timeout 10000
   ```
2. Resolve a target page id without changing focus:
   ```bash
   PAGE_ID="$(
     npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json tabs \
     | jq -r '.pages[] | select(.active == true) | .id' \
     | head -n1
   )"
   ```
3. Snapshot that page before acting:
   ```bash
   npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json --page-id "$PAGE_ID" snapshot --format aria --interactive
   ```
   If the aria snapshot is too verbose, try the default first and fall back:
   ```bash
   npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json --page-id "$PAGE_ID" snapshot
   # If empty or only title returned, retry with aria:
   npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json --page-id "$PAGE_ID" snapshot --format aria --interactive
   ```
4. Perform action on the same page id:
   ```bash
   npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json --page-id "$PAGE_ID" click 12
   ```

If `jq` is unavailable, parse `.pages` from `tabs --json` directly and still pass `--page-id <id>` on every action.

## Safe operating rules

- **Never use `focus` or `tab select` unless explicitly asked.** The user may be actively working in the browser — switching their active tab is disruptive. Instead, pass `--page-id <id>` (or `--pageId <id>`) to target a specific tab without switching focus. Get the page ID from `tabs` output, then use it on any command:
  ```bash
  vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json --page-id 2 snapshot
  vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json --page-id 2 click 7
  ```
- Prefer `tabs` or `snapshot` before acting.
- `snapshot` is tool-only and maps to extension snapshot tools (`take_md_snapshot` by default, `take_a11y_snapshot` for `--format aria`).
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
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json status
```

List pages:

```bash
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json tabs
```

Open a new page:

```bash
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json open https://example.com
```

Take the default AI snapshot:

```bash
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json snapshot
```

Take the ARIA / interactive snapshot:

```bash
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json snapshot --format aria --interactive
```

Click and type using OpenClaw-style refs:

```bash
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json click 12
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json type 23 "hello" --submit
```

Evaluate JavaScript:

```bash
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote "$VIBE_EXTENSION_UUID" --json evaluate --fn '() => document.title'
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
vibebrowser-cli ... snapshot

# Reliable fallback — uses Chrome DevTools Protocol directly, works on background tabs
vibebrowser-cli ... snapshot --format aria --interactive
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
