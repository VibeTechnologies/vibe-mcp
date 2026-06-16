---
name: vibebrowser
description: Control the user's real local browser through the Vibe Browser CLI bridge. Use for ANY task against the user's own Vibe-connected browser — their tabs, cookies, logged-in sessions, extensions, opening pages, snapshots, clicks. ALWAYS load this skill before responding to a browser request, so you can recover the user's saved connection (the remote) from memory or workspace and never re-ask for it.
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

## FIRST, EVERY TIME: load the saved remote before asking for it

The user gives their remote value **once**. On **every** browser task — including the
first message of a brand-new conversation — recover it yourself before doing anything
else. Do **not** ask the user for the remote until you have checked **both** stores and
found nothing.

At the very start of any browser task, in this order:

1. **Read the workspace file (canonical source).** Read `vibebrowser-cli.md` from your
   **agent workspace root** (see ["Where to save it"](#where-to-save-it) — NOT the shell's
   current directory, NOT `$HOME` unless they are the same dir). If it has a valid
   `remote:` line, use that value as `--remote` and continue silently. The file is the
   durable store that survives across conversations and works on every runtime.
2. **Else recall from memory.** If the file is missing/empty and your runtime has a
   memory/recall tool, read the key `vibebrowser_remote` and use it.
3. **Only if both are empty** may you ask the user for the remote. When they give it,
   immediately write it to the workspace-root `vibebrowser-cli.md` (mandatory) **and**,
   *if your runtime has a tool to write memory keys*, also store it under
   `vibebrowser_remote`. (Some runtimes — e.g. OpenClaw — can read but not write memory
   keys; the file alone is sufficient.) Then the next conversation never has to ask again.

> If you find yourself about to say "I need your Vibe remote value first," STOP — you
> almost certainly skipped step 1/2. A returning user has already provided it; recall it.

Full details and examples: [## Remembering the remote connection](#remembering-the-remote-connection).

## Use THIS for the user's own browser — not your built-in browser

Many runtimes (OpenClaw, Hermes, etc.) ship a **separate built-in/headless/in-pod browser
tool** (names like `browser_navigate`, `browser`, an in-pod Chrome on `127.0.0.1:9222`,
a generic `web_fetch`). That browser is **empty** — it does not have the user's logins,
cookies, tabs, or extensions.

When the user refers to **their own browser** — phrases like "my browser", "my Chrome",
"my tab(s)", "the page I'm on", "my logged-in session", "open … for me" — they mean their
**real** browser, reachable **only** through this skill (`@vibebrowser/cli` + the saved
remote). For those requests:

- **Use this skill.** Run `vibebrowser-cli` with the recovered remote. Do **not** use the
  built-in/headless browser or `web_fetch` — they hit a different, empty browser and will
  silently give wrong results (you may even fabricate a title/snapshot you never fetched).
- Only use the built-in browser when the user explicitly asks for a throwaway/sandbox
  browser that is *not* their own.
- If you are unsure which browser a request means, default to **this** skill (the user's
  real browser) and confirm with one short question only if truly ambiguous.

> Self-check before answering any browse/open/click/snapshot request: "Am I about to use
> my built-in browser for something the user means to happen in THEIR browser?" If yes,
> switch to `vibebrowser-cli` with the saved remote.

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

3. **Install the skill** (run the line for your agent):
   ```bash
   # OpenClaw (--copy is required, else the symlink escapes the workspace root and is skipped):
   npx -y skills add VibeTechnologies/vibe-mcp -s vibebrowser -a openclaw -g -y --copy --dangerously-accept-openclaw-risks
   # Hermes:
   npx -y skills add VibeTechnologies/vibe-mcp -s vibebrowser -y
   ```
   Verify it registered with `openclaw skills list` (expect a `🌐 vibebrowser … ✓ ready` row) or `npx -y skills list` (Hermes). Installs to `~/.openclaw/skills/vibebrowser/SKILL.md`. Offline/registry-blocked fallback: copy this file there directly.

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

### How to save it

**Primary — Workspace context file (works on every runtime):** Write the value to
a file named `vibebrowser-cli.md` in your **agent workspace root** (see
["Where to save it"](#where-to-save-it) below). Use this exact format so it can be
machine-read back:

```markdown
# VibeBrowser CLI context
remote: <uuid-or-wss-url>
```

This file is the canonical store: it persists across conversations and works even on
runtimes whose memory does not persist or cannot be written (e.g. OpenClaw can read but
**not** write memory keys). Create or overwrite it whenever the value is provided or updated.

**Secondary — Memory key (only if your runtime can WRITE memory):** If, and only if, your
runtime provides a tool to write memory keys, also store the value under `vibebrowser_remote`
as a convenience cache. Do **not** assume this tool exists — if you cannot write memory keys,
skip this; the file above is sufficient. Never fabricate a `remember(...)` call.

#### Where to save it

The file MUST live in your **persistent agent workspace root** — the single directory that
(a) survives across conversations and (b) contains your **`memory/`** folder. (`memory/` is
the reliable anchor; a `skills/` folder may also exist *globally* outside the workspace root,
so do not key off `skills/` alone.) It is **not** the shell's current working directory
(often `/` or a temp dir — ephemeral) and **not necessarily** `$HOME`:

| Runtime  | Workspace root (save `vibebrowser-cli.md` here)        | Note |
|----------|--------------------------------------------------------|------|
| OpenClaw | `~/.openclaw/workspace/<your-agent>/`                  | `$HOME` is `/home/node`, a parent **outside** the persistent root — do not use it. The global `~/.openclaw/skills/` is NOT the workspace root. |
| Hermes   | `$HOME` (e.g. `/root`)                                 | Here `$HOME` *is* the workspace root, so `~/vibebrowser-cli.md` is correct. |

If your runtime is not in the table, resolve the directory that contains your **`memory/`**
folder and write the file there. Always verify after writing with an **absolute-path**
read-back (`cat <abs>/vibebrowser-cli.md`) and confirm the value matches.

**Robust read-back:** when loading, accept the first line matching `remote:` followed by a
UUID or `wss://` URL; ignore surrounding markdown/comments. If the file exists but has no
valid `remote:` line, treat it as empty and fall through to the next store. If memory and
file disagree, **prefer the file** (it is the user-updated canonical store).

### Rules for using the remembered value

1. **On every browser command**, load the remembered remote (read the workspace-root `vibebrowser-cli.md` first, else recall memory key `vibebrowser_remote`) and pass it as `--remote "<remembered-value>"`. Do this on the first message of every new conversation, not just within one session.
2. **Only ask the user** for the remote if none is remembered in **either** store and the user did not provide one in the current message. Treat the remote as a secret — never echo it back in summaries, logs, screenshots, or commits.
3. **If the remembered remote stops working** — for example, `status` returns `extensionConnected: false`, or commands repeatedly fail — tell the user clearly and offer to update the saved value (then overwrite the workspace-root `vibebrowser-cli.md`, and memory if writable, with the new one). Do not silently fall back to local relay mode.

### Example: first use

User: "Open google.com in my browser. My remote is `abc12345-...`."

Agent actions:
1. Save `abc12345-...` to memory under key `vibebrowser_remote` **and** write it to `vibebrowser-cli.md` in your agent workspace root.
2. Run:
   ```bash
   npx -y @vibebrowser/cli@latest --remote "abc12345-..." --json status --wait-for-extension --wait-timeout 10000
   npx -y @vibebrowser/cli@latest --remote "abc12345-..." --json open https://google.com
   ```

### Example: subsequent use (same or later session)

User: "Now open github.com."

Agent actions:
1. Recall `vibebrowser_remote` from memory (or read the workspace-root `vibebrowser-cli.md` → `remote:` line).
2. Run without asking the user:
   ```bash
   npx -y @vibebrowser/cli@latest --remote "<remembered-value>" --json open https://github.com
   ```

## Command form

Prefer this exact command pattern:

```bash
npx -y @vibebrowser/cli@latest --remote "<uuid-or-url>" --json status
```

Pass only one of these remote forms: `--remote <uuid>` for the default public relay, or `--remote <full-ws-url>` for an explicit relay endpoint.

The examples below use `$VIBE_REMOTE_URL` as a stand-in for the remote value — substitute the literal UUID/URL if no environment variable is set. If `VIBE_REMOTE_URL` (or `VIBE_EXTENSION_UUID` / `VIBE_RELAY_UUID`) is exported, `--remote` can be omitted entirely:

```bash
npx -y @vibebrowser/cli@latest --json status
```

## Deterministic runbook (default)

Use this sequence when the task needs reliable, repeatable control:

1. Verify connection:
   ```bash
   npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json status --wait-for-extension --wait-timeout 10000
   ```
2. Resolve a target page id without changing focus:
   ```bash
   PAGE_ID="$(
      npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json tabs \
     | jq -r '.pages[] | select(.active == true) | .id' \
     | head -n1
   )"
   ```
3. Snapshot that page before acting:
   ```bash
   npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json --page-id "$PAGE_ID" snapshot --format aria --interactive
   ```
   If the aria snapshot is too verbose, try the default first and fall back:
   ```bash
   npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json --page-id "$PAGE_ID" snapshot
   # If empty or only title returned, retry with aria:
   npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json --page-id "$PAGE_ID" snapshot --format aria --interactive
   ```
4. Perform action on the same page id:
   ```bash
   npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json --page-id "$PAGE_ID" click 12
   ```

If `jq` is unavailable, parse `.pages` from `tabs --json` directly and still pass `--page-id <id>` on every action.

## Safe operating rules

- **Never use `focus` or `tab select` unless explicitly asked.** The user may be actively working in the browser — switching their active tab is disruptive. Instead, pass `--page-id <id>` (or `--pageId <id>`) to target a specific tab without switching focus. Get the page ID from `tabs` output, then use it on any command:
  ```bash
  npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json --page-id 2 snapshot
  npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json --page-id 2 click 7
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
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json status
```

List pages:

```bash
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json tabs
```

Open a new page:

```bash
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json open https://example.com
```

Take the default AI snapshot:

```bash
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json snapshot
```

Take the ARIA / interactive snapshot:

```bash
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json snapshot --format aria --interactive
```

Click and type using OpenClaw-style refs:

```bash
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json click 12
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json type 23 "hello" --submit
```

Evaluate JavaScript:

```bash
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json evaluate --fn '() => document.title'
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
npx -y @vibebrowser/cli@latest ... snapshot

# Reliable fallback — uses Chrome DevTools Protocol directly, works on background tabs
npx -y @vibebrowser/cli@latest ... snapshot --format aria --interactive
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
