# Evaluation Process

This document describes the validation entrypoints defined by the current `package.json`. It distinguishes deterministic repository checks from opt-in checks that need a browser extension or agent runtime. A script definition shows intended coverage; it does not prove that a workflow or check has run.

## Default Suites

`npm test` and `npm run test:ci` currently run the same deterministic scripts, in this order:

| Script | Boundary covered |
|---|---|
| `test:e2e:relay-race` | extension socket replacement and stale-close race |
| `test:e2e:relay-roundtrip` | agent `call_tool` -> extension -> `tool_result` round trip |
| `test:e2e:cli-relay` | direct browser CLI through the real relay and a fake extension |
| `test:e2e:cli-autospawn` | local relay daemon startup and reuse |
| `test:e2e:http` | local Streamable HTTP MCP transport |
| `test:e2e:uuid-only-auth` | UUID-path bearer capability and rejection of unsupported relay URL forms |
| `test:e2e:tool-annotations` | MCP tool annotations |
| `test:e2e:tools-list-budget` | bounded startup `tools/list` response |
| `test:e2e:browser-cli` | direct browser CLI command and relay routing behavior |
| `test:e2e:cli-package` | packaged CLI binary smoke coverage |
| `test:e2e:devtools-flag` | explicit `--devtools` backend selection |

Run the default validation with:

```bash
npm run build
npm test
```

The CI-equivalent repository entrypoint is:

```bash
npm run test:ci
```

## Opt-In Environment Checks

These scripts are intentionally excluded from both `npm test` and `npm run test:ci`:

| Script | External dependency |
|---|---|
| `test:e2e:browser-cli-live` | a reachable real Vibe extension and browser page |
| `test:e2e:agents` | supported agent CLIs plus a reachable extension or harness-managed browser |

Run them only when their environment is deliberately available:

```bash
npm run test:e2e:browser-cli-live
npm run test:e2e:agents
```

Passing a fake-extension test does not establish live-browser behavior. Passing `list_tools` alone does not establish tool execution. A meaningful relay round trip observes the agent sending `call_tool`, the extension receiving it, the extension returning `tool_result`, and the client receiving the expected payload.

## Cross-Repository Behavioral Eval

The full browser-task eval lives in the sibling `../vibe` repository rather than this package. See that repository's current scripts and environment requirements before running it. Do not infer execution, publication state, hosted-service health, or live-extension coverage from this package's script definitions.

## Transport Boundaries Under Test

- Direct `@vibebrowser/cli` uses `src/browser-cli.ts` and `ExtensionConnection` to exchange project JSON over WS/WSS. This relay protocol is not MCP-over-WebSocket.
- Local `@vibebrowser/mcp` exposes MCP through stdio by default or Streamable HTTP at `http://127.0.0.1:8788/mcp`, then uses local `ws://127.0.0.1:19888` or remote WS/WSS to reach the extension.
- Hosted remote MCP is Streamable HTTP at `https://mcp.api.vibebrowser.app/mcp/<uuid>`.
- The UUID path is the bearer capability. Relay URLs with userinfo, query strings, or fragments are rejected; there is no separate shared secret or header/query authentication mode.
