# vibe-mcp Agent Memory

Facts from production debugging that must not be forgotten.

## Canonical Eval Reference

- Current evaluation process, commands, latest measured results, and LLM feedback summary are documented in `docs/eval.md`.
- Keep `docs/eval.md` updated whenever MCP evaluation scope or pass criteria changes.

## Relay and Connection Semantics

- The relay has one active extension socket and many agent sockets.
- When replacing the extension socket, stale `close` events from the old socket must be ignored.
- If stale `close` sets `extensionWs = null`, agents will fail `call_tool` with `No extension connected` even while tools are still being broadcast.
- Extension socket race fix lives in [src/relay.ts](/Users/engineer/workspace/vibebrowser/vibe-mcp/src/relay.ts).

### "Extension reconnecting" errors (root-caused AGE-10 / AGE-133, fixed in #143 + #144)

How Claude Desktop actually reaches the browser: **Claude -> hosted remote MCP
connector (`https://relay.api.vibebrowser.app/mcp`, an account-level connector,
not a local stdio server or `.mcpb` extension) -> extension WebSocket**. Confirm
this before debugging anything else — `claude_desktop_config.json` normally has
no `mcpServers` block for this path, and `~/Library/Logs/Claude/main.log` lists
`vibebrowser` under `replaceRemoteMcpServers` alongside other remote connectors.

Two independent faults can each produce the user-visible `Extension
reconnecting` string (the relay's `notifyPendingRequests(session, 'Extension
reconnecting')`, which fails every in-flight call instantly with no re-queue):

1. **Local daemon never answered the extension heartbeat -> permanent ~30 s
   reconnect churn (fixed in [#143](https://github.com/VibeTechnologies/vibe-mcp/pull/143)).**
   The extension (`vibe/lib/mcp/external-client.ts`) sends `{type:'connected'}`
   every `CLIENT_HEARTBEAT_INTERVAL_MS` (15 s) and treats any inbound frame as
   the pong; after `MAX_MISSED_PONGS` (2) unanswered heartbeats it force-reconnects.
   The local `relay.ts` used to return early on `connected` without replying —
   the hosted relay already answered it, so only the local daemon churned.
   Diagnose with 1s-interval `lsof` sampling of the extension's local port
   (`19889`): a healthy connection is stable; the bug shows teardown/rebuild on
   a new ephemeral port every ~17-27 s.
2. **Publishing is not deploying — a stale global/npx install silently keeps
   every already-fixed bug** (fixed in [#144](https://github.com/VibeTechnologies/vibe-mcp/pull/144)).
   `npm view @vibebrowser/mcp version` reporting the fixed version proves
   nothing about what is actually running. Check the *executing* binary:
   `grep -c pong $(which -a node | xargs -I{} echo)/../lib/node_modules/@vibebrowser/mcp/dist/relay.js`,
   or simpler, `lsof -p <relay-daemon pid> | grep cwd`/`ps -o command= -p <pid>`
   to see which install (`-g`, `npx` cache, or a stale worktree) actually spawned
   it. Since #144 the pong the relay sends back to the extension carries a
   `version` field precisely so this stops requiring process forensics — a pong
   with no `version` is by construction an install older than #144.

Separately: `chrome.storage.local`'s `mcp_external_enabled: true` with
`mcp_external_mode` **absent** resolves to `'local'` (`background.ts`'s
`|| 'local'` fallback), so the extension can hold a perfectly healthy *local*
relay connection while the *hosted* connector (what Claude/ChatGPT actually
talk to) has no session for that UUID at all (`/api/v1/extensions/<uuid>/status`
-> `connected: false`, `tools/list` -> `-32002`). This is a mode/settings
mismatch, not a relay bug — verify Settings -> AI Agent Control -> Remote
before assuming the relay is broken. Do not flip this automatically; it changes
the browser's exposure posture and is the user's call.

Full forensic write-up with every probe and timestamped measurement: the
`investigation` document on [AGE-10](/AGE/issues/AGE-10) (frozen; live re-home
is [AGE-133](/AGE/issues/AGE-133)).

## What Counts as Real E2E

- `list_tools` success is not enough.
- A meaningful MCP e2e must verify this chain:
  - agent sends `call_tool`
  - extension receives `call_tool`
  - extension returns `tool_result`
  - MCP client reads expected payload (`ok` in test harness)
- If that chain is not observed, the test is not proving MCP tool execution.

## Fake Extension Test Harness Rules

- Register message handlers before waiting on socket `open`.
- Keep fake extension resilient:
  - periodically announce `tools_list` so clients recover from ordering races
  - reconnect on socket close so background reconnect noise does not invalidate the test
- Retry logic must never accept stale `No connection` payloads as final tool results.

## Debugging Rules

- Start relay daemon with `--debug` when `E2E_DEBUG=1`.
- Always inspect relay logs for request flow around `call_tool` before changing agent prompts.
- If failure says `No extension connected`, check relay state transitions first, not model output first.

## Known Operational Reality

- Local relay ports are fixed:
  - extension: `19889`
  - agent: `19888`
- Other background extension clients can connect/reconnect and trigger race conditions if relay socket ownership is not guarded.

## Minimum Verification Commands

- Fast check:
  - `npm run test:e2e:agents`
- Deep check:
  - `E2E_DEBUG=1 npm run test:e2e:agents`
- Success condition:
  - command exits `0`
  - output contains `e2e ok`

## Full MCP Evaluation (Cross-Repo, Required Before Claiming Stability)

- The full MCP behavioral eval lives in sibling repo `../vibe`, not in this repo.
- Always run with `gpt-4.1` agent model for parity with current free Copilot setup.
- See `docs/eval.md` for the concrete runbook and latest known-good result profile.

### 1) Run Full MCP-Focused Eval

- Command:
  - `cd ../vibe && node tests/mcp-eval.test.js --skip-build --model github-copilot/gpt-4.1`
- Pass criteria:
  - `MCP External enabled: PASS`
  - `Relay connected: PASS`
  - `MCP tools used: PASS`
  - `MCP tool calls >= 4`
  - `FINAL_TABLE marker: PASS`
  - `Tickers found: 6/6`
  - process exits `0`

### 2) Run Full Scenario Sweep (All Eval Scenarios)

- Command:
  - `cd ../vibe && node tests/eval.test.js --headless --model github-copilot/gpt-4.1`
- Notes:
  - This runs the whole scenario catalog (currently 28 scenarios).
  - Use `--scenarios`, `--category`, or `--limit` only for debugging, not final verification.

### 3) Enable LLM-as-Judge + Langfuse Logging

- `tests/lib/langfuse-eval.js` expects:
  - `LANGFUSE_BASE_URL`
  - `LANGFUSE_PUBLIC_KEY` or `LANGFUSE_PUBLIC_KEY_DEV`
  - `LANGFUSE_SECRET_KEY` or `LANGFUSE_SECRET_KEY_DEV`
  - `AZURE_OPENAI_API_KEY` (or fallback `LITELLM_AZURE_OPENAI_API_KEY`)
  - `AZURE_OPENAI_ENDPOINT` (or fallback URL envs)
  - optional `AZURE_OPENAI_EVAL_MODEL` (default `gpt-4.1-mini`)
- If only Azure creds exist, LLM judge still runs, but trace logging is disabled.
- If these keys are stored outside `../vibe/.env`, export them before running eval:
  - `set -a; source ../VibeTeam/.env; set +a`

### 4) Analyze Langfuse Eval Output

- Pull latest eval traces:
  - `curl -sS -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" "$LANGFUSE_BASE_URL/api/public/traces?limit=30&orderBy=timestamp.desc"`
- Pull latest eval scores:
  - `curl -sS -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" "$LANGFUSE_BASE_URL/api/public/scores?limit=30&orderBy=timestamp.desc"`
- Focus on traces named:
  - `eval-mcp-eval-google-finance` (current)
  - `eval-mcp-eval-morningstar` (legacy runs)
- Review:
  - score trend (`task_completion`)
  - judge comment for missing data points
  - correlation with local artifact logs in `../vibe/.test/.../logs/opencode-response.txt`
