# Vibe MCP - Browser Automation for AI Agents

[![npm version](https://img.shields.io/npm/v/@vibebrowser/mcp.svg)](https://www.npmjs.com/package/@vibebrowser/mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

MCP server for [Vibe AI Browser](https://vibebrowser.app) - the **only browser automation tool that supports multiple AI agents simultaneously**.

## Why Vibe MCP?

| Feature | Vibe MCP | Playwright MCP | BrowserMCP |
|---------|----------|----------------|------------|
| **Multi-Agent Support** | Yes | No | No |
| Uses Your Browser Profile | Yes | No | No |
| Logged-In Sessions | Yes | No | No |
| No Separate Browser | Yes | No | No |
| Local & Private | Yes | Yes | Partial |
| Content Script Based | Yes | No | No |

### Multi-Agent Architecture

Vibe MCP is the **only solution that allows multiple AI agents to control the same browser simultaneously**. Run Claude Desktop, Cursor, VS Code Copilot, and OpenCode all at once - they all share control of your browser through our relay architecture.

```
Claude Desktop       Cursor          VS Code         OpenCode
     |                  |                |               |
     v                  v                v               v
 [vibebrowser-mcp] [vibebrowser-mcp] [vibebrowser-mcp] [vibebrowser-mcp]
     |                  |                |               |
     +------------------+----------------+---------------+
                        |
                        v
                  [Relay Daemon]  <-- Auto-spawned, handles multiplexing
                        |
                        v
                 [Vibe Extension]
                        |
                        v
                   [Your Chrome]
```

**Competitors like Playwright MCP and BrowserMCP fail when you try to run multiple agents** - they get port conflicts or connection errors. Vibe MCP just works.

## Features

- **Multi-Agent Ready** - Run Claude, Cursor, VS Code, and more simultaneously
- **Uses Your Browser** - No separate browser instance, uses your existing Chrome with all your logins
- **Fast & Local** - Automation happens on your machine, no cloud latency
- **Private** - Your browsing data never leaves your device
- **Stable** - Content script based, no flaky CDP connections
- **Direct Chrome DevTools mode** - Extension tools stay primary by default; use `--devtools` to drive your real running Chrome directly over the DevTools Protocol (no extension required)

## Quick Start

### 1. Install the Vibe Extension

Install the Vibe AI Browser extension in Chrome, Brave, or any Chromium browser:

**Option A: Chrome Web Store (Recommended)**
1. Visit the [Chrome Web Store](https://chromewebstore.google.com/detail/vibe-ai-browser-co-pilot/djodpgokbmobeclicaicnnidccoinado)
2. Click "Add to Chrome"
3. The Vibe icon will appear in your toolbar

**Option B: Developer Version**
1. Download the [latest release ZIP](https://github.com/VibeTechnologies/VibeWebAgent/releases/latest/download/vibe-ai-copilot-latest.zip)
2. Extract to a permanent folder
3. Go to `chrome://extensions`, enable Developer Mode
4. Click "Load unpacked" and select the extracted folder

For detailed instructions, see the [installation guide](https://docs.vibebrowser.app/getting-started/extension).

### 2. Configure Your AI Application

<details>
<summary><strong>Claude Desktop</strong></summary>

Edit your Claude Desktop config file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "vibe": {
      "command": "npx",
      "args": ["-y", "@vibebrowser/mcp"]
    }
  }
}
```

Restart Claude Desktop after saving.

</details>

<details>
<summary><strong>Cursor</strong></summary>

1. Open Cursor Settings (Cmd/Ctrl + ,)
2. Go to "Features" -> "MCP Servers"
3. Click "Add Server" and add:

```json
{
  "vibe": {
    "command": "npx",
    "args": ["-y", "@vibebrowser/mcp"]
  }
}
```

Or edit `~/.cursor/mcp.json` directly.

</details>

<details>
<summary><strong>VS Code (GitHub Copilot)</strong></summary>

Add to your VS Code settings.json:

```json
{
  "github.copilot.chat.mcpServers": {
    "vibe": {
      "command": "npx",
      "args": ["-y", "@vibebrowser/mcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>Windsurf</strong></summary>

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "vibe": {
      "command": "npx",
      "args": ["-y", "@vibebrowser/mcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>OpenCode</strong></summary>

Add to your `.opencode/config.json`:

```json
{
  "mcp": {
    "servers": {
      "vibe": {
        "command": "npx",
        "args": ["-y", "@vibebrowser/mcp"]
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "vibe": {
      "command": "npx",
      "args": ["-y", "@vibebrowser/mcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>OpenAI Codex CLI</strong></summary>

Add to your Codex configuration:

```json
{
  "mcp": {
    "vibe": {
      "command": "npx",
      "args": ["-y", "@vibebrowser/mcp"]
    }
  }
}
```

</details>

### MCP command forms

Use the shortest direct package invocation for the MCP server:

```bash
npx -y @vibebrowser/mcp@latest --help
npx -y @vibebrowser/mcp@latest start --transport http
npx -y @vibebrowser/mcp@latest openclaw --remote "$VIBE_REMOTE_UUID"
```

Backward-compatible aliases still work when you need explicit binaries:

```bash
npx -y -p @vibebrowser/mcp@latest vibebrowser-mcp --help
npx -y -p @vibebrowser/mcp@latest vibe-mcp --help
```

### 3. Connect the Extension

1. Open Chrome with the Vibe extension installed
2. Click the Vibe extension icon in the toolbar
3. Go to Settings and enable "MCP External Control"
4. The status should show "Connected"

If the extension is not connected, `vibebrowser-mcp` can optionally fall back to
`chrome-devtools-mcp` (started in `--autoConnect` mode) when that package is installed.
This fallback runs once in the shared local relay daemon (multi-agent safe), so
both `vibebrowser-mcp` and `vibebrowser-cli` use the same backend instance.
When extension is connected, extension tools are authoritative.

### `--devtools` mode (drive your real Chrome over CDP)

Pass `--devtools` to either CLI to bypass relay/extension routing entirely and
drive your **real running Chrome** directly over the Chrome DevTools Protocol.
This backend (ported from the `chrome-use` skill) reads Chrome's
`DevToolsActivePort` file and autoConnects to your live profile — no extension,
no external MCP server, zero extra dependencies. Requires Chrome 144+; the
permission dialog fires once per profile.

`--devtools` exposes a focused tool set: `navigate`, `snapshot` (accessibility
tree with `@eN` refs), `click`, `fill`, `type`, `press_key`, `hover`, `scroll`,
`screenshot`, `eval`, `get_text`, `get_url`, `get_title`, and tab management
(`list_tabs`, `new_tab`, `select_tab`, `close_tab`). Use `snapshot` to get
`@eN` element refs, then pass them as selectors to `click`/`fill`/`type`.

Override the Chrome profile/channel with `VIBE_CHROME_USER_DATA_DIR` and
`VIBE_CHROME_CHANNEL` (`stable` | `canary` | `beta` | `dev`).

Not yet covered by `--devtools` v1 (addable later as more CDP domains are wired):
network request inspection, console logs, performance traces, Lighthouse, memory
snapshots, device emulation, dialog handling, file upload, and drag.

## Available Tools

| Tool | Description |
|------|-------------|
| `navigate_to_url` | Navigate to any URL |
| `go_back` / `go_forward` | Browser history navigation |
| `click` | Click elements on the page |
| `type` / `fill` | Enter text into inputs |
| `scroll` | Scroll the page |
| `take_screenshot` | Capture screenshots |
| `get_page_content` | Extract page text/HTML |
| `get_tabs` / `create_new_tab` / `switch_to_tab` / `close_tab` | Tab management |
| `keyboard_shortcut` | Press keyboard combinations |
| `web_search` | Search the web |

## How It Works

Default local mode (no flags):

```
Claude / Cursor / VS Code (stdio)
            │
            ▼
   [vibebrowser-mcp]
            │  ws://127.0.0.1:19888
            ▼
     Local Relay (auto-spawned)
            │  ws://127.0.0.1:19889
            ▼
     Vibe Extension (Chrome)
```

1. AI applications connect via MCP over stdio
2. `vibebrowser-mcp` connects to the local relay on port `19888`
3. The relay forwards commands to the extension on port `19889`
4. Results flow back to the agent

### Multi-Agent Mode

When multiple agents connect, Vibe MCP automatically spawns a relay daemon:

- First agent starts the relay (listens on ports 19888 and 19889)
- Additional agents connect to the relay as clients
- Relay multiplexes all agent requests to the single extension connection
- Each agent receives only its own responses

### Cloud OpenClaw -> Local Browser

If your agent runs in the cloud but you want it to control the user's real local browser, run `vibebrowser-mcp` in HTTP mode and connect it to the Vibe extension in remote relay mode. Pass either the extension UUID or the full WebSocket relay URL to `--remote`.

```bash
VIBE_REMOTE_UUID="2d2f60a1-2031-4279-aa25-358f2c5b6f84"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/2d2f60a1-2031-4279-aa25-358f2c5b6f84"

npx -y @vibebrowser/mcp@latest start --transport http --remote "$VIBE_REMOTE_UUID"
npx -y @vibebrowser/mcp@latest start --transport http --remote "$VIBE_REMOTE_URL"
```

This exposes a local MCP endpoint at `http://127.0.0.1:8788/mcp` by default.

When OpenClaw runs on a different machine (for example cloud-hosted), provide a reachable URL:

```bash
VIBE_REMOTE_UUID="2d2f60a1-2031-4279-aa25-358f2c5b6f84"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/2d2f60a1-2031-4279-aa25-358f2c5b6f84"
PUBLIC_MCP_URL="https://browser-bridge.example.com/mcp"

npx -y @vibebrowser/mcp@latest openclaw --remote "$VIBE_REMOTE_UUID" --public-url "$PUBLIC_MCP_URL"
npx -y @vibebrowser/mcp@latest openclaw --remote "$VIBE_REMOTE_URL" --public-url "$PUBLIC_MCP_URL"
```

You can print the exact OpenClaw-friendly setup with:

```bash
VIBE_REMOTE_UUID="2d2f60a1-2031-4279-aa25-358f2c5b6f84"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/2d2f60a1-2031-4279-aa25-358f2c5b6f84"

npx -y @vibebrowser/mcp@latest openclaw --remote "$VIBE_REMOTE_UUID"
npx -y @vibebrowser/mcp@latest openclaw --remote "$VIBE_REMOTE_URL"
```

Use `--remote <uuid>` with the default public relay, or `--remote <full-ws-url>` when you need an explicit relay endpoint.

For direct browser CLI checks, use `@vibebrowser/cli`:

```bash
VIBE_REMOTE_UUID="2d2f60a1-2031-4279-aa25-358f2c5b6f84"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/2d2f60a1-2031-4279-aa25-358f2c5b6f84"

npx @vibebrowser/cli --remote "$VIBE_REMOTE_UUID" --json status
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json status
```

`--remote <uuid>` uses the default public relay. `--remote <full-ws-url>` targets an explicit relay endpoint.

For the full walkthrough, see `docs/openclaw-local-browser.md`.

### OpenClaw-Compatible Browser CLI

`@vibebrowser/cli` mirrors the OpenClaw browser CLI shape for the real local-browser path:

```bash
npx @vibebrowser/cli sessions
VIBE_REMOTE_UUID="2d2f60a1-2031-4279-aa25-358f2c5b6f84"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/2d2f60a1-2031-4279-aa25-358f2c5b6f84"
npx @vibebrowser/cli --remote "$VIBE_REMOTE_UUID" status
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" tabs
npx @vibebrowser/cli --remote "$VIBE_REMOTE_UUID" open https://example.com
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" snapshot
npx @vibebrowser/cli --remote "$VIBE_REMOTE_UUID" click 12
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" type 23 "hello" --submit
npx @vibebrowser/cli --devtools status
```

Use the MCP package for MCP server workflows and the CLI package for direct browser control:

- `vibebrowser-mcp` for MCP server, HTTP bridge, and helper commands
- `@vibebrowser/cli` for OpenClaw-inspired browser control against the real Vibe-connected session

`@vibebrowser/cli` accepts the OpenClaw-style `--browser-profile` flag for compatibility and supports `--json` for machine-readable output. Unlike OpenClaw's managed `openclaw` browser profile, this CLI always targets the real Vibe-connected browser session.

Local-session selection:

- `npx @vibebrowser/cli sessions` lists connected local browser sessions.
- `npx @vibebrowser/cli --session <id> ...` targets a specific local session.
- If `--session` is omitted in local mode, the CLI uses the first connected session.
- In remote mode, pass either `--remote <uuid>` to use the default public relay or `--remote <full-ws-url>` to use an explicit relay endpoint.

Snapshot behavior is tool-only (no legacy snapshot RPC shortcut):

- `snapshot` (default, `--format ai`) resolves via the `take_md_snapshot` tool — uses the content script's in-page markdown extractor. Fast and readable, but **may return empty for background tabs or complex SPAs** (Notion, Gmail) where the content script is unreachable or layout is not computed.
- `snapshot --format aria` resolves via the `take_a11y_snapshot` tool — uses Chrome DevTools Protocol `Accessibility.getFullAXTree` directly. **Reliable for all tabs including background tabs and SPAs.** Use this as a fallback when the default format returns empty or only a page title.

This keeps CLI behavior aligned with extension-supported tools and ensures page targeting works consistently with `--page-id`/`--pageId`.

For navigation-style operations, responses now include page content when page state changes:

- CLI `open` / `navigate` include `pageContent` in JSON output.
- MCP tool calls for navigation-style tools return text content that includes current page state (with snapshot fallback when needed).

### Install Prompt for AI Agents (OpenClaw / Hermes)

Copy-paste the block below into an agent (e.g. OpenClaw or Hermes) to install and set up the Vibe Browser CLI skill via `npx -y` and prove it can control the browser. Replace `<REMOTE>` with your extension's remote value — the extension UUID or the full `wss://relay.api.vibebrowser.app/<uuid>` URL from the Vibe extension's **Settings → AI Agent Control → Remote (internet) → Relay access**.

```text
Install and test the "Vibe Browser CLI" skill so you can control my real Chrome browser.

The skill is the npm package @vibebrowser/cli, run with npx (no global install needed). My browser runs the Vibe extension in Remote mode; reach it via the public relay using this remote value:

  REMOTE = <REMOTE>

Do each step and paste the exact output. If any command returns "Extension reconnecting", wait 3 seconds and retry it (up to 5 times):

1. Install / sanity-check the CLI (first run downloads it):
   npx -y @vibebrowser/cli@latest --help

2. Confirm you can reach my browser (wait for the extension):
   npx -y @vibebrowser/cli@latest --remote "$REMOTE" --json status --wait-for-extension --wait-timeout 20000
   -> confirm "extensionConnected": true and report toolCount.

3. List my open tabs:
   npx -y @vibebrowser/cli@latest --remote "$REMOTE" --json tabs

4. Read the active page (proves control):
   npx -y @vibebrowser/cli@latest --remote "$REMOTE" --json snapshot --format aria

5. Report back: did status show extensionConnected=true, and did the snapshot return real page content? Paste the snapshot text.

Optional (changes browser state): pick a page id from step 3 and run
   npx -y @vibebrowser/cli@latest --remote "$REMOTE" --json --page-id <ID> navigate https://example.com
A navigation reloads the page and can briefly drop the relay, so retry on "Extension reconnecting".

If status shows extensionConnected=false, tell me so I can put the extension into Remote mode.
```

For a deeper skill definition (when to prefer this over a managed browser, env-var setup, selector/snapshot guidance), install `openclaw/vibebrowser/SKILL.md` into the agent's skills directory.

### OpenClaw Integration

There are two ways to use Vibe with OpenClaw:

**Option A: Cloud OpenClaw controlling local browser**

If OpenClaw runs in the cloud but you want it to control your local browser:

1. Install the Vibe extension and enable **Remote** mode (see [docs/openclaw-local-browser.md](docs/openclaw-local-browser.md))
2. Start the local HTTP bridge: `vibebrowser-mcp openclaw --remote "$VIBE_REMOTE_UUID" [--public-url "$PUBLIC_MCP_URL"]` or `vibebrowser-mcp openclaw --remote "$VIBE_REMOTE_URL" [--public-url "$PUBLIC_MCP_URL"]`
3. Register the MCP URL in OpenClaw

**Option B: OpenClaw skill for local agents**

For OpenClaw agents that need your real browser context (logged-in sessions, existing tabs):

1. Copy the Vibe skill from this package to your OpenClaw skills folder
2. Use the extension UUID or full WebSocket relay URL with `--remote`
3. Use `@vibebrowser/cli` commands in your agent prompts

The skill is located at [`openclaw/vibebrowser/SKILL.md`](openclaw/vibebrowser/SKILL.md) and provides:
- Full OpenClaw-compatible CLI commands (`status`, `tabs`, `snapshot`, `click`, `type`, etc.)
- Fallback-safe commands for DevTools-backed flows (`resize`, `upload`, `dialog`)
- `--json` output for machine parsing
- Environment-based configuration

See [docs/openclaw-local-browser.md](docs/openclaw-local-browser.md) for the complete walkthrough.

## Local LLM: `serve` Command

Run a local LLM with one command — no cloud API keys required. Automatically installs [Ollama](https://ollama.com), downloads the model, and starts serving an OpenAI-compatible API.

```bash
npx -y @vibebrowser/mcp@latest serve qwen3.5
```

That's it. Works on **macOS**, **Linux**, and **Windows**.

### What it does

1. **Detects Ollama** → installs it if missing (via `brew`, `curl`, or `winget`)
2. **Starts the server** → launches `ollama serve` in the background
3. **Downloads the model** → streams download progress to your terminal
4. **Prints connection info** → ready to use with VibeBrowser or any OpenAI-compatible client

### Recommended models

```bash
npx -y @vibebrowser/mcp@latest serve qwen3.5      # Best overall for agentic tasks
npx -y @vibebrowser/mcp@latest serve llama4        # Strong general reasoning
npx -y @vibebrowser/mcp@latest serve deepseek-r1   # Reasoning chains
npx -y @vibebrowser/mcp@latest serve mistral       # Lightweight & fast (7B)
```

### Options

```text
npx -y @vibebrowser/mcp@latest serve <model> [options]

Options:
  -p, --port <number>  Ollama API port (default: 11434)
  -y, --yes            Skip install confirmation prompts
  -d, --debug          Enable debug logging
```

### Using with VibeBrowser extension

After `serve` completes, configure the extension:
- **Model provider** → `ollama`
- **Model name** → the model you served (e.g., `qwen3.5`)

The extension connects to `http://localhost:11434/v1` automatically.

## CLI Options

```text
npx -y @vibebrowser/mcp@latest --help
npx @vibebrowser/cli --help

# MCP server (default)
npx -y @vibebrowser/mcp@latest [start] [options]
  -p, --port <number>  WebSocket port for local relay (agent) connection (default: 19888)
  -d, --debug          Enable debug logging
  --transport <mode>   MCP transport to expose: stdio or http (default: stdio)
  --host <host>        Host to bind the HTTP server to (default: 127.0.0.1)
  --http-port <number> Port for streamable HTTP MCP transport (default: 8788)
  --http-path <path>   Path for streamable HTTP MCP transport (default: /mcp)
  --allow-host <host>  Allowed host header for HTTP transport (repeatable)
  -r, --remote <uuid-or-url>  Extension UUID, or full ws(s) remote URL
  --devtools           Drive your real running Chrome directly over the DevTools Protocol (bypasses the extension relay)

# MCP server tool
set_remote { "url": "wss://relay.api.vibebrowser.app/<extension-uuid>" }
```

The `set_remote` MCP server tool hot-reconnects the running MCP server to a different remote relay URL. It is an MCP tool, not a browser CLI subcommand.

```bash
# OpenClaw helper
VIBE_REMOTE_UUID="2d2f60a1-2031-4279-aa25-358f2c5b6f84"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/2d2f60a1-2031-4279-aa25-358f2c5b6f84"
PUBLIC_MCP_URL="https://browser-bridge.example.com/mcp"
npx -y @vibebrowser/mcp@latest openclaw --remote "$VIBE_REMOTE_UUID" --public-url "$PUBLIC_MCP_URL"
npx -y @vibebrowser/mcp@latest openclaw --remote "$VIBE_REMOTE_URL" --public-url "$PUBLIC_MCP_URL"

# OpenClaw-compatible browser CLI
npx @vibebrowser/cli --remote "$VIBE_REMOTE_UUID" status
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" status --wait-for-extension --wait-timeout 10000
npx @vibebrowser/cli --remote "$VIBE_REMOTE_UUID" tabs
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" snapshot --json
npx @vibebrowser/cli --remote "$VIBE_REMOTE_UUID" click 12
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" type 23 "hello" --submit
npx @vibebrowser/cli --devtools tabs

# Local LLM server
MODEL="qwen3.5"
npx -y @vibebrowser/mcp@latest serve "$MODEL"
  -p, --port <number>  Ollama API port (default: 11434)
  -y, --yes            Skip confirmation prompts
  -d, --debug          Enable debug logging
```

## Troubleshooting

### "No connection to Vibe extension"

1. Ensure the Vibe extension is installed in Chrome
2. Click the extension icon and enable "MCP External Control" in Settings
3. Check that no firewall is blocking localhost connections

### "OpenClaw cannot reach my local browser bridge"

1. Start `vibebrowser-mcp` in HTTP mode instead of stdio
2. Make sure the bridge process is still running on the user's machine
3. Confirm the extension is in `Remote` mode and connected
4. Verify the MCP URL in OpenClaw matches the bridge URL. If OpenClaw is cloud-hosted, do not use `127.0.0.1`; use `openclaw --public-url` with a reachable host.

### Debug mode

Enable debug logging to diagnose issues:

```json
{
  "mcpServers": {
    "vibe": {
      "command": "npx",
      "args": ["-y", "@vibebrowser/mcp", "--debug"]
    }
  }
}
```

## Development

```bash
git clone https://github.com/VibeTechnologies/vibe-mcp.git
cd vibe-mcp
npm install
npm run build
node dist/cli.js --debug
```

## Keywords

browser automation, mcp server, model context protocol, ai browser control, claude desktop browser, cursor browser automation, web automation, chrome automation, ai agent browser, multi-agent browser control, playwright alternative, puppeteer alternative, browser mcp, web scraping ai, ai web agent

## License

Apache-2.0

## Links

- [Vibe AI Browser](https://vibebrowser.app) - Main product
- [Documentation](https://docs.vibebrowser.app) - Full docs
- [Chrome Extension](https://chromewebstore.google.com/detail/vibe-ai-web-agent/ajfjlohdpfgngdjfafhhcnpmijbbdgln) - Install extension
- [GitHub Issues](https://github.com/VibeTechnologies/vibe-mcp/issues) - Report bugs
- [npm Package](https://www.npmjs.com/package/@vibebrowser/mcp) - npm registry
