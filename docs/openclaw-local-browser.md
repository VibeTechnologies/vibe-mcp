---
title: "Use Vibe Co-Pilot to Let Cloud OpenClaw Control Your Local Browser"
description: "How to connect a cloud OpenClaw agent to a user's local browser with the Vibe Co-Pilot extension, remote relay mode, and the new vibebrowser-mcp HTTP bridge."
date: "2026-03-15"
author: "Dzianis Vashchuk"
published: true
---

If you are running OpenClaw in the cloud, one of the most useful upgrades is giving it access to a real browser.

But there are actually two different browser problems hiding inside that sentence:

- **tenant browser**: a browser that lives inside the hosted OpenClaw runtime
- **local browser**: the user's actual Chrome or Chromium profile on their own machine

Those are not the same product problem, and they should not use the same architecture.

For the tenant browser, the right answer is still the hosted browser stack inside the tenant.

For the user's local browser, the right answer is the Vibe Co-Pilot extension plus `vibebrowser-mcp` in remote relay mode.

That is what this setup enables.

## The architecture that works

The flow looks like this:

```text
Cloud OpenClaw agent
        |
        | MCP over HTTP
        v
  local vibebrowser-mcp bridge
        |
        | secure outbound relay connection
        v
   Vibe remote relay
        |
        v
Vibe Co-Pilot browser extension
        |
        v
User's local Chrome / Chromium browser
```

The important point is that the browser still stays on the user's machine.

The cloud runtime does not need direct access to the user's laptop, an exposed CDP port, or a custom reverse tunnel into Chrome. The Vibe extension connects outward to the relay, and `vibebrowser-mcp` exposes a local MCP HTTP endpoint that OpenClaw can attach to.

## Why we added HTTP mode to `vibebrowser-mcp`

Before this change, `vibebrowser-mcp` worked well for local MCP clients such as Claude Desktop, Cursor, OpenCode, and VS Code because they can launch an MCP server over stdio.

Cloud OpenClaw is different.

In OpenClawBot and similar hosted deployments, MCP servers are configured as URLs. That means a stdio-only MCP bridge is not enough. We needed `vibebrowser-mcp` to expose a proper network MCP endpoint.

So the missing piece was a streamable HTTP MCP transport.

That is what `vibebrowser-mcp start --transport http` now provides.

## Prerequisites

You need:

1. **Node.js 18+** - `vibebrowser-mcp` requires Node.js
2. **Chrome/Brave/Chromium** with the Vibe extension installed
3. **OpenClaw** configured with an MCP server URL

## What gets installed

The user needs three pieces:

1. the Vibe Co-Pilot browser extension
2. `vibebrowser-mcp` on the same machine as the browser
3. an OpenClaw MCP server entry pointing to the local `vibebrowser-mcp` HTTP endpoint

## Step 1: Install the Vibe extension

1. Install the Vibe Co-Pilot extension from [Chrome Web Store](https://chromewebstore.google.com/detail/vibe-ai-browser-co-pilot/djodpgokbmobeclicaicnnidccoinado)
2. Open Chrome and click the Vibe extension icon
3. Go to **Settings** (gear icon)
4. Find **MCP External** (or "MCP External Control")
5. Enable it and select **Remote** mode
6. Copy either the extension UUID or the full WebSocket relay URL shown, for example `wss://relay.api.vibebrowser.app/YOUR-EXTENSION-UUID`

> **Note**: `--remote <uuid>` uses the default public relay. `--remote <full-ws-url>` targets an explicit relay endpoint.

## Step 2: Start the local HTTP bridge

On the same machine where the browser extension is installed, run one of these remote forms.

**Option A: Using the helper command (recommended)**

```bash
VIBE_REMOTE_UUID="YOUR-EXTENSION-UUID"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/YOUR-EXTENSION-UUID"

npx -y @vibebrowser/mcp@latest openclaw --remote "$VIBE_REMOTE_UUID"
npx -y @vibebrowser/mcp@latest openclaw --remote "$VIBE_REMOTE_URL"
```

This prints the exact commands and MCP URL you need.

If OpenClaw is running on another machine (for example in the cloud), provide a reachable URL:

```bash
VIBE_REMOTE_UUID="YOUR-EXTENSION-UUID"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/YOUR-EXTENSION-UUID"
PUBLIC_MCP_URL="https://browser-bridge.example.com/mcp"

npx -y @vibebrowser/mcp@latest openclaw --remote "$VIBE_REMOTE_UUID" --public-url "$PUBLIC_MCP_URL"
npx -y @vibebrowser/mcp@latest openclaw --remote "$VIBE_REMOTE_URL" --public-url "$PUBLIC_MCP_URL"
```

**Option B: Manual command**

```bash
VIBE_REMOTE_UUID="YOUR-EXTENSION-UUID"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/YOUR-EXTENSION-UUID"

npx -y @vibebrowser/mcp@latest start --transport http --remote "$VIBE_REMOTE_UUID"
npx -y @vibebrowser/mcp@latest start --transport http --remote "$VIBE_REMOTE_URL"
```

By default this starts a local MCP endpoint at:

```
http://127.0.0.1:8788/mcp
```

That loopback URL only works when OpenClaw can reach the same machine. For cloud OpenClaw, register a reachable URL (`--public-url`) instead.

Keep this terminal open - the bridge must stay running for OpenClaw to connect.

For operator workflows and OpenClaw skills, you can also use the OpenClaw-compatible browser CLI surface directly:

```bash
npx -y @vibebrowser/cli@latest sessions
VIBE_REMOTE_UUID="YOUR-EXTENSION-UUID"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/YOUR-EXTENSION-UUID"
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_UUID" status
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" tabs
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_UUID" snapshot --json
```

The CLI accepts only these remote forms:

```bash
VIBE_REMOTE_UUID="YOUR-EXTENSION-UUID"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/YOUR-EXTENSION-UUID"

npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_UUID" --json status
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json status
```

`--remote <uuid>` uses the default public relay. `--remote <full-ws-url>` targets an explicit relay endpoint.

`snapshot` in `vibebrowser-cli` is tool-only and maps directly to extension snapshot tools:

- default (`--format ai`) -> `take_snapshot` (format: markdown)
- ARIA (`--format aria`) -> `take_snapshot` (format: aria)

Use `--page-id <id>` (or `--pageId <id>`) to target a specific tab without switching user focus.

For local relay mode with multiple connected browsers/profiles:

- run `npx -y @vibebrowser/cli@latest sessions` to list available local session IDs
- pass `--session <id>` to target one explicitly
- if omitted, the CLI uses the first connected local session

`open` and `navigate` responses include extracted page content in JSON output (`pageContent`) when page state is modified, so agents can continue without an immediate extra snapshot call.

That CLI accepts the same style of verbs and flags OpenClaw operators expect, but it still targets the Vibe real-browser path rather than an isolated OpenClaw-managed browser profile.

## Step 3: add the MCP server to OpenClaw

Register the bridge URL in OpenClaw:

```json
{
  "mcpServers": {
    "vibe": {
      "url": "http://127.0.0.1:8788/mcp"
    }
  }
}
```

Use that loopback URL only for same-machine setups. For cloud OpenClaw, set `"url"` to the reachable value you passed through `--public-url`.

Once that is configured, the cloud OpenClaw agent can use the Vibe browser tools through the local bridge.

If the browser relay URL changes while the MCP server is already running, call the MCP server tool `set_remote` with the new full URL to hot-reconnect without restarting the server:

```json
{ "url": "wss://relay.api.vibebrowser.app/<extension-uuid>" }
```

`set_remote` is an MCP tool exposed by the server, not a `vibebrowser-cli` subcommand.

## Optional: Use the OpenClaw skill for local agents

For OpenClaw agents running locally (not in the cloud) that need access to your real browser, you can use the Vibe skill instead of configuring an MCP server URL.

### Install the skill

Copy `openclaw/vibebrowser/SKILL.md` from this package to your OpenClaw skills directory. The skill provides OpenClaw-compatible CLI commands that target your Vibe-connected browser.

### Configure environment

Use either remote form in commands:

```bash
VIBE_REMOTE_UUID="YOUR-EXTENSION-UUID"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/YOUR-EXTENSION-UUID"

npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_UUID" --json status
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json status
```

### Available commands

```bash
# Check status
VIBE_REMOTE_UUID="YOUR-EXTENSION-UUID"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/YOUR-EXTENSION-UUID"
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_UUID" --json status

# List tabs
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json tabs

# Open a page
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_UUID" --json open https://example.com

# Click element by index
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json click 12

# Type into element
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_UUID" --json type 23 "hello"
```

See [`openclaw/vibebrowser/SKILL.md`](../openclaw/vibebrowser/SKILL.md) for the full command reference.

## When to use this setup

This architecture is the right fit when the agent needs the **user's own browser context**, for example:

- websites where the user is already logged in locally
- workflows that depend on cookies or browser extensions
- tasks on tabs the user already opened
- browsing in the exact local profile the user uses every day

## When not to use this setup

Do **not** use this as a replacement for the hosted tenant browser.

If the user wants a browser that lives inside the OpenClaw tenant itself, keep using the existing tenant browser stack. That remains the correct architecture for hosted cloud browsing because it is reproducible, self-contained, and lives entirely inside the tenant runtime.

So the rule is simple:

- **tenant browser in cloud** -> tenant `/browser` stack
- **user's real local browser** -> Vibe extension + relay + `vibebrowser-mcp` HTTP bridge

## Why this split matters

Trying to force one model to solve both cases creates product confusion.

The tenant browser is about a cloud runtime having its own browser environment.

The Vibe extension path is about letting a cloud agent borrow the user's real browser safely and intentionally.

They sound similar from the outside, but they optimize for different things:

- tenant browser -> repeatability, isolation, hosted runtime control
- local browser bridge -> real sessions, real profile, real user context

That distinction is what made the implementation plan finally click.

## What this unlocks

With this bridge, OpenClaw users can keep the intelligence and orchestration in the cloud while still letting the agent act inside the browser they already use.

That is a much better fit than asking users to move their life into a fresh cloud browser profile just to get browser automation.

The end result is simple:

**OpenClaw stays in the cloud. The browser stays local. Vibe MCP connects them cleanly.**

## Troubleshooting

### "Remote relay URL not found"

Make sure you've enabled **Remote** mode in the Vibe extension settings. Use `--remote <uuid>` for the default public relay or `--remote <full-ws-url>` for an explicit relay endpoint.

### "Connection refused" errors

1. Ensure the `vibebrowser-mcp` process is still running
2. Check the terminal for error messages
3. Verify the MCP URL matches exactly (including the `/mcp` path) and is reachable from OpenClaw (not `127.0.0.1` for cloud-hosted OpenClaw)

### "No extension connected"

1. Open Chrome and click the Vibe extension icon
2. Verify MCP External is enabled in Settings
3. Check the extension shows "Connected" status

### MCP URL format

The correct format is:
```
http://127.0.0.1:8788/mcp
```

Not `http://127.0.0.1:8788` (missing `/mcp` path).
