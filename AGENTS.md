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
