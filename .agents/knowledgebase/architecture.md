# Architecture

## Purpose

`@vibebrowser/mcp` is a Node/TypeScript MCP server package that lets AI agents control a user's Vibe-connected Chrome/Chromium browser. Direct browser CLI docs use the separate `@vibebrowser/cli` package. It supports multiple agents by routing through a shared relay instead of each agent owning a browser connection.

## Main Entry Points

- Package binaries from `package.json`: `vibebrowser-mcp`, legacy alias `vibe-mcp`, and standalone `vibebrowser-cli`.
- `src/cli.ts`: MCP server CLI. Default command is `start`; supports stdio and streamable HTTP transports, local relay mode, remote relay mode, `--devtools`, and `openclaw` config printing.
- `src/server.ts`: MCP protocol server. Exposes tool listing/calling over stdio or HTTP and delegates to an extension/relay connection or Chrome DevTools fallback.
- `src/browser-main.ts` and `src/browser-cli.ts`: OpenClaw-compatible browser CLI surface for status, sessions, tabs, open/navigate, snapshots, clicks, typing, upload/drop, network, and evaluation helpers.
- `src/relay-daemon.ts` starts the local relay daemon; `src/relay.ts` implements relay multiplexing.

## Local Relay Model

Default local flow:

```text
MCP client -> vibebrowser-mcp stdio -> local relay agent WS :19888 -> local relay extension WS :19889 -> Vibe extension -> user's browser
```

Key facts:

- Agent WebSocket port defaults to `19888`; extension WebSocket port defaults to `19889`.
- Ports can be overridden with `VIBE_MCP_AGENT_PORT` and `VIBE_MCP_EXTENSION_PORT`.
- Relay state/log files live under `~/.vibe-mcp` by default, overridable with `VIBE_MCP_STATE_DIR`.
- One local relay daemon can serve many agent connections.
- The relay can track extension sessions and lets CLIs target a session with `--session <id>`.
- The relay owns a single shared `chrome-devtools-mcp` fallback backend so concurrent clients do not spawn competing fallback processes.

## Extension Socket Invariants

- The relay has many agent sockets and extension sessions keyed by session id.
- When an extension socket is replaced or disconnects, stale `close` events from old sockets must not clear the current active session.
- Pending requests must be rejected for the disconnected session rather than allowed to hang or be attributed to a later reconnect.
- If failures say `No extension connected`, inspect relay state transitions and logs before changing prompts or agent behavior.

## Remote Relay Model

Remote mode connects to the public relay instead of the local relay daemon:

```text
MCP client or @vibebrowser/cli -> wss://relay.api.vibebrowser.app/<extension-uuid> -> Vibe extension remote mode -> user's browser
```

Key facts:

- `src/connection.ts` defaults remote relay URL base to `wss://relay.api.vibebrowser.app`.
- `--remote <uuid>` uses the default public relay.
- `--remote <full-ws-url>` targets an explicit relay endpoint.
- `@vibebrowser/cli` also reads the remote value from `VIBE_REMOTE_URL`.
- The extension UUID in the relay URL identifies a browser session; it is not a secret by itself.
- Remote mode is for reaching the user's real local browser from a client or bridge that cannot use the local relay directly.

## HTTP Bridge And OpenClaw

`vibebrowser-mcp start --transport http` exposes streamable HTTP MCP on `http://127.0.0.1:8788/mcp` by default. `vibebrowser-mcp openclaw --remote <uuid>` and `vibebrowser-mcp openclaw --remote <full-ws-url>` print OpenClaw-friendly commands and MCP JSON snippets. The running MCP server also exposes a `set_remote { "url": "wss://relay.api.vibebrowser.app/<uuid>" }` tool for hot-reconnecting without restarting.

Use this split from `docs/openclaw-local-browser.md`:

- Tenant browser in cloud: use the tenant `/browser` stack.
- User's real local browser: use Vibe extension + relay + `vibebrowser-mcp` HTTP bridge or `@vibebrowser/cli`.

## Chrome DevTools Fallback

- `chrome-devtools-mcp` is an optional dependency.
- `--devtools` bypasses extension/relay routing and uses only the Chrome DevTools backend.
- In normal local relay mode, fallback tools are used only when the extension is unavailable/disconnected; extension tools are authoritative when connected.
