# Relay And MCP Architecture

Vibe Browser supports three implemented paths to the same extension-backed browser tools. The WebSocket relay speaks Vibe's project JSON protocol, not MCP.

## Transport Matrix

| Path | Client-facing transport | Relay-facing transport | Entry point |
|---|---|---|---|
| Direct browser CLI | command output | WS/WSS project JSON | `src/browser-main.ts` -> `src/browser-cli.ts` -> `ExtensionConnection` |
| Local MCP server | MCP over stdio by default, or Streamable HTTP at `http://127.0.0.1:8788/mcp` | local `ws://127.0.0.1:19888` or remote WS/WSS with `--remote` | `src/cli.ts` -> `src/server.ts` -> `ExtensionConnection` |
| Hosted remote MCP | Streamable HTTP at `https://mcp.api.vibebrowser.app/mcp/<uuid>` | hosted service to extension relay | hosted endpoint |

## Direct CLI

`@vibebrowser/cli` does not start an MCP server. `src/browser-cli.ts` creates an `ExtensionConnection`, which connects locally or to:

```text
wss://relay.api.vibebrowser.app/00000000-0000-0000-0000-000000000000
```

Messages are project JSON such as `list_tools`, `call_tool`, `tools_list`, and `tool_result`. Calling this MCP-over-WebSocket is incorrect.

## Local MCP

`@vibebrowser/mcp` exposes the Model Context Protocol to an MCP client:

```text
MCP client --stdio----------------------> Vibe MCP server
MCP client --Streamable HTTP /mcp------> Vibe MCP server
                                                |
                                                +--project JSON over WS/WSS--> relay --> extension
```

The default client transport is stdio. `start --transport http` binds to `127.0.0.1`, port `8788`, path `/mcp` unless overridden. The browser-facing connection remains WebSocket: local mode uses `ws://127.0.0.1:19888`; `--remote` uses a WS/WSS relay target.

The local relay daemon in `src/relay.ts` listens for agents on `19888` and extensions on `19889`. It multiplexes agent requests, tracks extension sessions, routes responses to the requesting agent, and guards extension socket replacement races.

## Hosted MCP

Clients that cannot spawn a local stdio process can use the hosted Streamable HTTP endpoint:

```text
https://mcp.api.vibebrowser.app/mcp/00000000-0000-0000-0000-000000000000
```

This HTTPS endpoint is MCP. It is distinct from `wss://relay.api.vibebrowser.app/<uuid>`, which is the proprietary relay WebSocket used by `ExtensionConnection`.

## Source Components

- `src/browser-cli.ts`: direct browser commands and tool selection.
- `src/connection.ts`: local and remote relay URL handling, WS/WSS lifecycle, project JSON requests, and response correlation.
- `src/server.ts`: MCP protocol server, stdio transport, and local Streamable HTTP transport.
- `src/cli.ts`: command-line transport and remote-target options.
- `src/relay.ts`: local multi-agent relay and extension session routing.
- `src/chrome-use-connection.ts`: explicit `--devtools` backend that bypasses the extension relay.

## Security

The UUID path is a bearer capability. Possession of either complete URL can authorize browser access:

```text
wss://relay.api.vibebrowser.app/<uuid>
https://mcp.api.vibebrowser.app/mcp/<uuid>
```

Treat the complete URL like a password. Do not commit it, publish it, place it in shared logs, or use a real value in documentation. Regenerate the UUID in extension settings if it is exposed.

There is no separate shared secret, `Authorization: Bearer` mode, `X-Remote-Session` mode, or query-string authentication mode. `src/connection.ts` rejects relay URLs containing userinfo, query strings, or fragments.

TLS protects hosted HTTPS/WSS traffic in transit. Local relay listeners bind to `127.0.0.1`.

## Test Boundaries

The deterministic suites in `npm test` and `npm run test:ci` cover relay races, full fake-extension round trips, CLI routing and startup, local Streamable HTTP, UUID-only authorization behavior, tool metadata and startup budget, package smoke behavior, and the explicit DevTools flag.

`test:e2e:browser-cli-live` and `test:e2e:agents` are opt-in because they depend on a real extension/browser or external agent runtimes. Fake-extension coverage does not prove live browser behavior, and package scripts do not prove a workflow has executed. See `docs/eval.md` for the current matrix.
