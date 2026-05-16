# Operations

## Common Commands

- Install dependencies: `npm install`
- Build: `npm run build`
- TypeScript watch: `npm run dev`
- Start local stdio MCP server from built output: `npm start`
- Start HTTP MCP endpoint: `npm run build && node dist/cli.js start --transport http`
- Print OpenClaw bridge config: `npx -y @vibebrowser/mcp@latest openclaw --remote <uuid>` or `npx -y @vibebrowser/mcp@latest openclaw --remote <full-ws-url>`
- Standalone CLI status: `npx @vibebrowser/cli --remote <uuid> --json status`
- Standalone CLI tabs: `npx @vibebrowser/cli --remote <full-ws-url> --json tabs`
- Prefer `--page-id <id>` for browser actions to avoid disrupting the user's active tab.

## Test And Eval Commands

- Full local test script: `npm test`
- Relay race regression: `npm run test:e2e:relay-race`
- Relay roundtrip: `npm run test:e2e:relay-roundtrip`
- CLI relay: `npm run test:e2e:cli-relay`
- Streamable HTTP MCP: `npm run test:e2e:http`
- Browser CLI fake-extension harness: `npm run test:e2e:browser-cli`
- Agent harness with real extension: `npm run test:e2e:agents`
- Debug agent harness: `E2E_DEBUG=1 npm run test:e2e:agents`
- Live browser CLI regression: `npm run test:e2e:browser-cli-live`
- DevTools flag harness: `npm run test:e2e:devtools-flag`

Pass signals from `docs/eval.md` and `AGENTS.md`:

- `npm test` should exit `0` and include `e2e ok`, `http e2e ok`, and `browser cli e2e ok`.
- Meaningful MCP e2e is not just `list_tools`; it must prove `call_tool` reaches extension/fallback and returns the expected payload.
- Real-extension tests require an active Vibe extension session with MCP External enabled; failures waiting for extension connection can be environment-only.
- Full behavioral eval lives in sibling repo `../vibe`, not here: `cd ../vibe && node tests/mcp-eval.test.js --skip-build --model github-copilot/gpt-4.1`.
- Full scenario sweep in sibling repo: `cd ../vibe && node tests/eval.test.js --headless --model github-copilot/gpt-4.1`.

## Source Selectors

- Browser CLI harness supports `E2E_BROWSER_CLI_SOURCE=local|pack|npm` and optional `E2E_BROWSER_CLI_PACKAGE=<tgz>`.
- MCP agent harness supports `E2E_MCP_SOURCE=local|pack|npm` and optional `E2E_MCP_PACKAGE=<tgz>`.
- Cross-repo `../vibe/tests/mcp-eval.test.js` supports `--mcp-source auto|local|pack|npm` and `--mcp-package <tarball-or-package-spec>`.
- Use `pack` mode for release candidates before publishing.

## Publishing And Packaged Files

- `prepublishOnly` runs `npm run build`.
- Published npm package includes `dist`, `openclaw`, `docs`, `README.md`, and `LICENSE`.
- Current MCP package binaries are `mcp`, `vibebrowser-mcp`, `vibe-mcp`, and `vibebrowser-cli`; normal direct browser CLI docs use the separate `@vibebrowser/cli` package.
- Package smoke check pattern: create a tarball with `npm pack --json --pack-destination <tmp>` and verify `vibebrowser-mcp --help` plus browser CLI help via the relevant package under test.
- `docs/eval.md` records npm/publish verification history and should be updated when evaluation scope or pass criteria changes.

## Docs And Skill Locations

- User docs: `README.md`.
- Eval runbook: `docs/eval.md`.
- Remote relay design: `docs/chrome-devtools-relay.md`.
- OpenClaw/local browser article: `docs/openclaw-local-browser.md`.
- Shipped OpenClaw skill: `openclaw/vibebrowser/SKILL.md`.
- The OpenClaw skill is installed by copying `openclaw/vibebrowser/SKILL.md` to an OpenClaw skills directory, typically `~/.openclaw/skills/` or a project `openclaw/skills/` folder.

## Debugging Notes

- Use `E2E_DEBUG=1` to start relay daemon with debug logging in relevant harnesses.
- Inspect relay logs around `call_tool` before changing agent prompts.
- Fake extension harnesses should register message handlers before waiting on socket `open`, periodically announce `tools_list`, reconnect on socket close, and never treat stale `No connection` payloads as final success.
- If default `vibebrowser-cli snapshot` returns little content, retry with `snapshot --format aria --interactive`.
