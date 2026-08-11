# Relay And MCP Architecture

Vibe Browser supports direct CLI, local MCP, and hosted MCP paths. The WebSocket relay speaks Vibe's proprietary project JSON protocol, not MCP-over-WebSocket. The hosted production platform is separate from this repository's local package.

## Transport Matrix

| Path | Client-facing transport | Browser-facing transport | Ownership / entry point |
|---|---|---|---|
| Direct `@vibebrowser/cli` relay | command output | WS/WSS proprietary project JSON at relay root | This repo: `src/browser-main.ts` -> `src/browser-cli.ts` -> `ExtensionConnection` |
| Direct CLI with `--devtools` | command output | direct CDP; no extension or relay | This repo: `src/browser-main.ts` -> `src/browser-cli.ts` -> `src/chrome-use-connection.ts` |
| Local `@vibebrowser/mcp` relay | MCP over stdio by default, or local Streamable HTTP at `http://127.0.0.1:8788/mcp` | local `ws://127.0.0.1:19888` or remote WS/WSS with `--remote` | This repo: `src/cli.ts` -> `src/server.ts` -> `ExtensionConnection` |
| Local relay fallback when the extension is unavailable | existing local relay clients | shared `chrome-devtools-mcp` backend; local relay daemon/path only | This repo: `src/relay.ts` -> `DevtoolsFallbackConnection` |
| Local MCP with `--devtools` | MCP over stdio or loopback HTTP | direct CDP; no extension or relay | This repo: `src/cli.ts` -> `src/server.ts` -> `src/chrome-use-connection.ts` |
| Canonical hosted MCP | Streamable HTTP with OAuth 2.1/DCR at `https://relay.api.vibebrowser.app/mcp` | hosted platform routes to extension relay | Separate hosted production platform |
| Legacy hosted MCP | Streamable HTTP path UUID, or `/mcp` compatibility routing via header/bearer | hosted platform routes to extension relay | Separate hosted production platform |

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
                                                +--project JSON over WS/WSS--> relay --> extension or shared local fallback
```

The default client transport is stdio. `start --transport http` binds to `127.0.0.1`, port `8788`, path `/mcp` unless overridden. The MCP server's relay connection remains WebSocket: local mode uses `ws://127.0.0.1:19888`; `--remote` uses a WS/WSS relay target.

Local HTTP has no client authentication and must remain loopback-only. `--allow-host` only validates the HTTP `Host` header; it is not authentication and does not authorize non-loopback or public exposure. Use hosted OAuth for remote MCP clients.

The local relay daemon in `src/relay.ts` listens for agents on `19888` and extensions on `19889`. It multiplexes agent requests, tracks extension sessions, routes responses to the requesting agent, and guards extension socket replacement races. It also owns one shared `chrome-devtools-mcp` fallback through `DevtoolsFallbackConnection`: extension tools are authoritative while connected, and local relay clients use the shared fallback when the extension is unavailable. This fallback is limited to the local relay daemon/path; it is not used by `--remote` or hosted MCP modes.

Explicit `--devtools` is different: it bypasses both relay and extension through `src/chrome-use-connection.ts` rather than using the relay-owned fallback.

## Hosted MCP

Clients that cannot spawn a local stdio process should use the canonical hosted Streamable HTTP endpoint:

```text
https://relay.api.vibebrowser.app/mcp
```

It uses OAuth 2.1 with Dynamic Client Registration. An unauthenticated request receives `401` plus discovery metadata. `browser:read` is sufficient for MCP `initialize`, `ping`, and `tools/list`; every `tools/call` requires `browser:control`, including tools annotated read-only. `browser:control` implies `browser:read`.

The legacy hosted URL remains supported and grants unscoped full control:

```text
https://relay.api.vibebrowser.app/mcp/00000000-0000-0000-0000-000000000000
```

API-capable clients may also send `X-Remote-Session` to hosted `/mcp`, containing either a bare UUID or the canonical full WSS URL. Hosted production resolves credentials/routing in this order: OAuth bearer, `X-Remote-Session`, legacy non-OAuth bearer compatibility, then path UUID. Prefer OAuth.

These HTTPS endpoints carry MCP. They are distinct from `wss://relay.api.vibebrowser.app/<uuid>`, which carries proprietary relay JSON at the relay root. Hosted compatibility routing is also distinct from the WS/WSS URL validation implemented by `src/connection.ts`.

## Source Components

- `src/browser-cli.ts`: direct browser commands and tool selection.
- `src/connection.ts`: local and remote relay URL handling, WS/WSS lifecycle, project JSON requests, and response correlation.
- `src/server.ts`: MCP protocol server, stdio transport, and local Streamable HTTP transport.
- `src/cli.ts`: command-line transport and remote-target options.
- `src/relay.ts`: local multi-agent relay, extension session routing, and the shared `DevtoolsFallbackConnection` fallback.
- `src/chrome-use-connection.ts`: explicit `--devtools` backend that bypasses the extension relay.
- Hosted OAuth, discovery, and compatibility routing belong to the separate production platform, not this repository's local server implementation.

## Security

The canonical hosted endpoint should be used with scoped OAuth. `browser:read` is sufficient for MCP `initialize`, `ping`, and `tools/list`; every `tools/call` requires `browser:control`, including tools annotated read-only. `browser:control` implies `browser:read`.

Legacy UUID URLs are bearer capabilities. Possession of either complete legacy URL can authorize full browser access:

```text
wss://relay.api.vibebrowser.app/00000000-0000-0000-0000-000000000000
https://relay.api.vibebrowser.app/mcp/00000000-0000-0000-0000-000000000000
```

Treat the complete URL like a password. Do not commit it, publish it, place it in shared logs, or use a real value in documentation. Regenerate the UUID in extension settings if it is exposed.

Hosted production supports OAuth `Authorization: Bearer`, `X-Remote-Session`, legacy bearer compatibility, and path-UUID routing as described above. By contrast, `src/connection.ts` validates browser-facing relay WS/WSS URLs and rejects userinfo, query strings, and fragments; that source rule does not describe hosted MCP authentication.

TLS protects hosted HTTPS/WSS traffic in transit. By default, local relay listeners and the unauthenticated local HTTP MCP endpoint bind to `127.0.0.1`; never override the HTTP bind for public exposure or place it behind a public reverse proxy.

## Test Boundaries

The hermetic E2E sub-suite run by `npm test` and `npm run test:ci` is exactly: `test:e2e:relay-race`, `test:e2e:relay-roundtrip`, `test:e2e:cli-relay`, `test:e2e:cli-autospawn`, `test:e2e:http`, `test:e2e:uuid-only-auth`, `test:e2e:tool-annotations`, `test:e2e:tools-list-budget`, `test:e2e:browser-cli`, `test:e2e:cli-package`, and `test:e2e:devtools-flag`. These package scripts are not all CI workflow gates.

`test:e2e:browser-cli-live` and `test:e2e:agents` are excluded because they require a deliberately prepared real extension/browser or harness and external agent runtimes. Fake-extension coverage does not prove live browser behavior, and package scripts do not prove a workflow has executed. See `docs/eval.md` for the current matrix.
