# Vibe Browser - Claude Code plugin

Drive your **real, logged-in Chrome** from Claude Code. Not a headless throwaway
browser: the tabs, cookies, and sessions you already have.

The browser can even be on a **different machine** from Claude Code, with no inbound
port open on either side.

## Install

```shell
/plugin marketplace add VibeTechnologies/vibe-mcp
/plugin install vibe-browser@vibe-browser
```

## Setup

This plugin needs the **Vibe Chrome extension** — the MCP server is a relay and has no
browser of its own. Run the bundled setup skill and it will walk you through it:

```shell
/vibe-browser:setup
```

Short version:

1. Install the extension: [Chrome Web Store](https://chromewebstore.google.com/detail/vibe-ai-browser-co-pilot/djodpgokbmobeclicaicnnidccoinado)
2. Click the Vibe icon -> **Settings** -> enable **MCP External Control**
3. Verify: `npx -y @vibebrowser/cli@latest tabs` should list your real open tabs

## What you get

`navigate_to_url`, `go_back` / `go_forward`, `click`, `type` / `fill`, `scroll`,
`take_screenshot`, `get_page_content`, tab management (`get_tabs`, `create_new_tab`,
`switch_to_tab`, `close_tab`), `keyboard_shortcut`, and `web_search`.

Multiple agents can drive the same browser at once.

## Links

- Source: <https://github.com/VibeTechnologies/vibe-mcp>
- npm: [`@vibebrowser/mcp`](https://www.npmjs.com/package/@vibebrowser/mcp)
- MCP registry: `io.github.VibeTechnologies/vibe-mcp`
- Issues: <https://github.com/VibeTechnologies/vibe-mcp/issues>

Apache-2.0
