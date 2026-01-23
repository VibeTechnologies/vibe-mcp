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
 [vibe-mcp]        [vibe-mcp]       [vibe-mcp]      [vibe-mcp]
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

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ AI Application  │────>│  Vibe MCP       │────>│ Vibe Extension  │
│ (Claude/Cursor) │stdio│  (this package) │ WS  │ (Chrome)        │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

1. AI applications connect via MCP protocol (stdio)
2. Vibe MCP forwards commands to the browser extension via WebSocket
3. The extension executes actions in your actual browser
4. Results flow back to the AI

### Multi-Agent Mode

When multiple agents connect, Vibe MCP automatically spawns a relay daemon:

- First agent starts the relay (listens on ports 19988 and 19989)
- Additional agents connect to the relay as clients
- Relay multiplexes all agent requests to the single extension connection
- Each agent receives only its own responses

## CLI Options

```bash
npx @vibebrowser/mcp --help

Options:
  -p, --port <number>  WebSocket port for extension (default: 19989)
  -d, --debug          Enable debug logging
  -h, --help           Show help
```

## Troubleshooting

### "No connection to Vibe extension"

1. Ensure the Vibe extension is installed in Chrome
2. Click the extension icon and enable "MCP External Control" in Settings
3. Check that no firewall is blocking localhost connections

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
