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
- **Chrome DevTools Fallback** - Extension tools stay primary by default; use `--devtools` to force chrome-devtools-only mode

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

### 3. Connect the Extension

1. Open Chrome with the Vibe extension installed
2. Click the Vibe extension icon in the toolbar
3. Go to Settings and enable "MCP External Control"
4. The status should show "Connected"

If the extension is not connected, `vibebrowser-mcp` can optionally fall back to
`chrome-devtools-mcp` (started in `--autoConnect` mode) when that package is installed.
This fallback runs once in the shared local relay daemon (multi-agent safe), so
both `vibebrowser-mcp` and `vibebrowser-cli` use the same backend instance.
When extension is connected, extension tools are authoritative. Chrome DevTools
fallback tools are exposed only when extension is unavailable/disconnected.
Pass `--devtools` to either CLI to bypass relay/extension routing and use only
the chrome-devtools backend.

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

If your agent runs in the cloud but you want it to control the user's real local browser, run `vibebrowser-mcp` in HTTP mode and connect it to the Vibe extension in remote relay mode.

```bash
npx -y --package @vibebrowser/mcp vibebrowser-mcp start --transport http --remote <extension-uuid>
```

This exposes a local MCP endpoint at `http://127.0.0.1:8788/mcp` by default.

When OpenClaw runs on a different machine (for example cloud-hosted), provide a reachable URL:

```bash
npx -y --package @vibebrowser/mcp vibebrowser-mcp openclaw --remote <extension-uuid> --public-url https://<reachable-host>/mcp
```

You can print the exact OpenClaw-friendly setup with:

```bash
npx -y --package @vibebrowser/mcp vibebrowser-mcp openclaw --remote <extension-uuid>
```

For the full walkthrough, see `docs/openclaw-local-browser.md`.

### OpenClaw-Compatible Browser CLI

`vibebrowser-cli` mirrors the OpenClaw browser CLI shape for the real local-browser path:

```bash
npx -y --package @vibebrowser/mcp vibebrowser-cli sessions
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote <extension-uuid> status
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote <extension-uuid> tabs
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote <extension-uuid> open https://example.com
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote <extension-uuid> snapshot
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote <extension-uuid> click 12
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote <extension-uuid> type 23 "hello" --submit
npx -y --package @vibebrowser/mcp vibebrowser-cli --devtools status
```

The package now exposes two executables:

- `vibebrowser-mcp` for MCP server, HTTP bridge, and helper commands
- `vibebrowser-cli` for OpenClaw-inspired browser control against the real Vibe-connected session

`vibebrowser-cli` accepts the OpenClaw-style `--browser-profile` flag for compatibility and supports `--json` for machine-readable output. Unlike OpenClaw's managed `openclaw` browser profile, this CLI always targets the real Vibe-connected browser session.

Local-session selection:

- `vibebrowser-cli sessions` lists connected local browser sessions.
- `vibebrowser-cli --session <id> ...` targets a specific local session.
- If `--session` is omitted in local mode, the CLI uses the first connected session.
- In remote mode, `--remote <extension-uuid>` remains the explicit browser selector.

Snapshot behavior is tool-only (no legacy snapshot RPC shortcut):

- `snapshot` (default, `--format ai`) resolves via `take_md_snapshot` — uses the content script's in-page markdown extractor. Fast and readable, but **may return empty for background tabs or complex SPAs** (Notion, Gmail) where the content script is unreachable or layout is not computed.
- `snapshot --format aria` resolves via `take_a11y_snapshot` — uses Chrome DevTools Protocol `Accessibility.getFullAXTree` directly. **Reliable for all tabs including background tabs and SPAs.** Use this as a fallback when the default format returns empty or only a page title.

This keeps CLI behavior aligned with extension-supported tools and ensures page targeting works consistently with `--page-id`/`--pageId`.

For navigation-style operations, responses now include page content when page state changes:

- CLI `open` / `navigate` include `pageContent` in JSON output.
- MCP tool calls for navigation-style tools return text content that includes current page state (with snapshot fallback when needed).

### OpenClaw Integration

There are two ways to use Vibe with OpenClaw:

**Option A: Cloud OpenClaw controlling local browser**

If OpenClaw runs in the cloud but you want it to control your local browser:

1. Install the Vibe extension and enable **Remote** mode (see [docs/openclaw-local-browser.md](docs/openclaw-local-browser.md))
2. Start the local HTTP bridge: `vibebrowser-mcp openclaw --remote <extension-uuid> [--public-url <url>]`
3. Register the MCP URL in OpenClaw

**Option B: OpenClaw skill for local agents**

For OpenClaw agents that need your real browser context (logged-in sessions, existing tabs):

1. Copy the Vibe skill from this package to your OpenClaw skills folder
2. Set `VIBE_EXTENSION_UUID` environment variable
3. Use `vibebrowser-cli` commands in your agent prompts

The skill is located at [`openclaw/vibebrowser/SKILL.md`](openclaw/vibebrowser/SKILL.md) and provides:
- Full OpenClaw-compatible CLI commands (`status`, `tabs`, `snapshot`, `click`, `type`, etc.)
- Fallback-safe commands for DevTools-backed flows (`resize`, `upload`, `dialog`)
- `--json` output for machine parsing
- Environment-based configuration

See [docs/openclaw-local-browser.md](docs/openclaw-local-browser.md) for the complete walkthrough.

## Local LLM: `serve` Command

Run a local LLM with one command — no cloud API keys required. Automatically installs [Ollama](https://ollama.com), downloads the model, and starts serving an OpenAI-compatible API.

```bash
npx -y --package @vibebrowser/mcp vibebrowser-mcp serve qwen3.5
```

That's it. Works on **macOS**, **Linux**, and **Windows**.

### What it does

1. **Detects Ollama** → installs it if missing (via `brew`, `curl`, or `winget`)
2. **Starts the server** → launches `ollama serve` in the background
3. **Downloads the model** → streams download progress to your terminal
4. **Prints connection info** → ready to use with VibeBrowser or any OpenAI-compatible client

### Recommended models

```bash
npx -y --package @vibebrowser/mcp vibebrowser-mcp serve qwen3.5      # Best overall for agentic tasks
npx -y --package @vibebrowser/mcp vibebrowser-mcp serve llama4        # Strong general reasoning
npx -y --package @vibebrowser/mcp vibebrowser-mcp serve deepseek-r1   # Reasoning chains
npx -y --package @vibebrowser/mcp vibebrowser-mcp serve mistral       # Lightweight & fast (7B)
```

### Options

```bash
npx -y --package @vibebrowser/mcp vibebrowser-mcp serve <model> [options]

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

```bash
npx -y --package @vibebrowser/mcp vibebrowser-mcp --help
npx -y --package @vibebrowser/mcp vibebrowser-cli --help

# MCP server (default)
npx -y --package @vibebrowser/mcp vibebrowser-mcp [start] [options]
  -p, --port <number>  WebSocket port for local relay (agent) connection (default: 19888)
  -d, --debug          Enable debug logging
  --transport <mode>   MCP transport to expose: stdio or http (default: stdio)
  --host <host>        Host to bind the HTTP server to (default: 127.0.0.1)
  --http-port <number> Port for streamable HTTP MCP transport (default: 8788)
  --http-path <path>   Path for streamable HTTP MCP transport (default: /mcp)
  --allow-host <host>  Allowed host header for HTTP transport (repeatable)
  -r, --remote <uuid>  Connect to a remote extension via public relay
  --devtools           Use only chrome-devtools backend (bypasses extension relay)
  --relay-url <url>    Custom relay server URL

# OpenClaw helper
npx -y --package @vibebrowser/mcp vibebrowser-mcp openclaw --remote <extension-uuid> [--public-url <url>]

# OpenClaw-compatible browser CLI
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote <extension-uuid> status
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote <extension-uuid> status --wait-for-extension --wait-timeout 10000
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote <extension-uuid> tabs
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote <extension-uuid> snapshot --json
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote <extension-uuid> click 12
npx -y --package @vibebrowser/mcp vibebrowser-cli --remote <extension-uuid> type 23 "hello" --submit
npx -y --package @vibebrowser/mcp vibebrowser-cli --devtools tabs

# Local LLM server
npx -y --package @vibebrowser/mcp vibebrowser-mcp serve <model> [options]
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
      "args": ["-y", "--package", "@vibebrowser/mcp", "vibebrowser-mcp", "--debug"]
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
