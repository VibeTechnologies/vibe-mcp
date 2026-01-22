# Vibe MCP

MCP server for [Vibe AI Browser](https://vibebrowser.app) - allows AI agents to control your browser.

## What is this?

Vibe MCP connects AI applications like Claude Desktop, Cursor, VS Code, and others to your Chrome browser through the Vibe extension. This enables AI to:

- Navigate to websites
- Click buttons and links
- Fill out forms
- Take screenshots
- Extract page content
- And much more

## Features

- **Fast** - Automation happens locally on your machine
- **Private** - Your browser activity stays on your device
- **Logged In** - Uses your existing browser profile with all your sessions
- **Stable** - Uses content scripts instead of CDP, avoiding common disconnection issues

## Installation

### 1. Install the Vibe Extension

Install the Vibe AI Browser extension from [vibebrowser.app](https://vibebrowser.app) or the [Chrome Web Store](https://chrome.google.com/webstore).

### 2. Configure Your AI Application

Add the Vibe MCP server to your AI application's configuration:

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
2. Go to "Features" → "MCP Servers"
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

Or use the MCP extension settings UI.

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
3. Click "Connect to MCP" to enable external control
4. The status should show "Connected"

## Available Tools

The MCP server exposes all Vibe browser tools:

| Tool | Description |
|------|-------------|
| `navigate_to_url` | Navigate to a URL |
| `go_back` | Go back in history |
| `go_forward` | Go forward in history |
| `click` | Click an element |
| `type` | Type text into an element |
| `fill` | Fill a form field |
| `scroll` | Scroll the page |
| `take_screenshot` | Capture a screenshot |
| `get_page_content` | Get page text content |
| `list_tabs` | List open browser tabs |
| `create_new_tab` | Open a new tab |
| `switch_to_tab` | Switch to a tab |
| `close_tab` | Close a tab |
| `keyboard_shortcut` | Press keyboard shortcuts |
| `web_search` | Search the web |

## CLI Options

```bash
npx @anthropic/vibe-mcp --help

Options:
  -p, --port <number>  WebSocket port for extension connection (default: 19989)
  -d, --debug          Enable debug logging
  -h, --help           Show help
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ AI Application  │────►│ Vibe MCP Server │────►│ Vibe Extension  │
│ (Claude/Cursor) │stdio│ (this package)  │ WS  │ (Chrome)        │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

The MCP server:
1. Receives tool calls from AI applications via stdio (MCP protocol)
2. Forwards them to the Vibe extension via WebSocket
3. Returns results back to the AI application

## Troubleshooting

### "No connection to Vibe extension"

1. Make sure the Vibe extension is installed in Chrome
2. Click the extension icon and ensure "Connect to MCP" is enabled
3. Check that no other application is using port 19989

### Port already in use

Use a different port:

```json
{
  "mcpServers": {
    "vibe": {
      "command": "npx",
      "args": ["-y", "@anthropic/vibe-mcp", "--port", "19990"]
    }
  }
}
```

Make sure to also update the port in the extension settings.

### Debug mode

Enable debug logging to see what's happening:

```json
{
  "mcpServers": {
    "vibe": {
      "command": "npx",
      "args": ["-y", "@anthropic/vibe-mcp", "--debug"]
    }
  }
}
```

## Development

```bash
# Clone the repository
git clone https://github.com/VibeTechnologies/vibe-mcp.git
cd vibe-mcp

# Install dependencies
npm install

# Build
npm run build

# Run locally
node dist/cli.js --debug
```

## License

Apache-2.0

## Links

- [Vibe AI Browser](https://vibebrowser.app)
- [Documentation](https://docs.vibebrowser.app)
- [GitHub](https://github.com/VibeTechnologies/vibe-mcp)
- [Report Issues](https://github.com/VibeTechnologies/vibe-mcp/issues)
