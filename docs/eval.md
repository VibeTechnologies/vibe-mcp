# Evaluation Process

This document separates hermetic repository checks, environment-dependent checks, CI workflow gates, and cross-repository behavioral evaluation. Script definitions prove intended coverage, not that a workflow ran. Output wording and timing need not be deterministic.

## Hermetic E2E Sub-Suite

`npm test` and `npm run test:ci` run the same hermetic E2E sub-suite. They are not all of CI. The current suite contains exactly these scripts:

| Script | Boundary covered |
|---|---|
| `test:e2e:relay-race` | extension socket replacement and stale-close race |
| `test:e2e:relay-roundtrip` | agent `call_tool` -> extension -> `tool_result` round trip |
| `test:e2e:cli-relay` | direct browser CLI through the relay and a fake extension |
| `test:e2e:cli-autospawn` | local relay daemon startup and reuse |
| `test:e2e:http` | local Streamable HTTP MCP transport |
| `test:e2e:uuid-only-auth` | fake WS relay verifies browser CLI sends no `Authorization` for UUID-only outbound WS; browser and MCP CLIs reject removed `--remote-secret`; `VIBE_REMOTE_SECRET` is inert |
| `test:e2e:tool-annotations` | MCP tool annotations |
| `test:e2e:tools-list-budget` | bounded startup `tools/list` response |
| `test:e2e:browser-cli` | direct browser CLI command and relay routing behavior |
| `test:e2e:cli-package` | packaged CLI binary smoke coverage |
| `test:e2e:devtools-flag` | explicit `--devtools` backend selection |

The UUID-only test does not validate hosted `/mcp` authentication, OAuth, `X-Remote-Session`, bare UUID normalization, or general URL-form rejection.

```bash
npm test
npm run test:ci
```

## Environment-Dependent Checks

These are excluded from the hermetic sub-suite:

| Script | External dependency |
|---|---|
| `test:e2e:browser-cli-live` | a reachable real Vibe extension and browser page |
| `test:e2e:agents` | supported agent CLIs plus a reachable extension or harness-managed browser |

```bash
npm run test:e2e:browser-cli-live
npm run test:e2e:agents
E2E_DEBUG=1 npm run test:e2e:agents
```

The live browser check defaults to `https://x.com/search?q=("YC W26" OR "YC Demo Day" OR "W26 Demo Day")&src=typed_query&f=live`, a `60000ms` command timeout, and `Require snapshot: false`. It passes when the process exits `0` and prints `live browser cli e2e ok`. The agents check passes only when the process exits `0` and prints `e2e ok`; the debug form exercises the same check with relay diagnostics. Both checks require a deliberately prepared real-browser or harness environment and are excluded from `test:ci`.

A meaningful relay E2E observes `call_tool` sent by the agent, received by the extension, answered with `tool_result`, and read by the MCP client. `list_tools` success alone is insufficient.

## CI Workflow Gates

`.github/workflows/ci.yml` runs these gates in order:

1. `npm ci`
2. `npm run build`
3. `npx tsc --noEmit`
4. `npm run validate:skill`
5. `npm run test:ci`
6. `npm install -g @anthropic-ai/claude-code` (networked)
7. `npm run test:e2e:plugin-bundle`

The package scripts do not prove that the GitHub Actions workflow executed.

## Cross-Repository Behavioral Eval

The full MCP behavioral eval lives in sibling repository `../vibe`. Use `gpt-4.1` for parity with the current free Copilot setup:

```bash
cd ../vibe && node tests/mcp-eval.test.js --skip-build --model github-copilot/gpt-4.1
```

Supported source selectors are exactly `--mcp-source auto|local|pack|npm`; use `--mcp-package <tarball-or-package-spec>` to supply the package tested by `pack`. `local` validates workspace source, `pack` validates a release candidate, and `npm` validates the published package. Use `npm` for published-production claims; `auto` is not valid evidence for a production claim.

```bash
cd ../vibe && node tests/mcp-eval.test.js --skip-build --model github-copilot/gpt-4.1 --mcp-source npm
```

Pass criteria are all of:

- `MCP External enabled: PASS`
- `Relay connected: PASS`
- `MCP tools used: PASS`
- MCP tool calls >= 4
- `FINAL_TABLE marker: PASS`
- `Tickers found: 6/6`
- process exits `0`

Run the final full scenario sweep with:

```bash
cd ../vibe && node tests/eval.test.js --headless --model github-copilot/gpt-4.1
```

The catalog currently has 28 scenarios. Use `--scenarios`, `--category`, or `--limit` only for debugging, not final verification.

## LLM Judge And Langfuse

`tests/lib/langfuse-eval.js` expects these environment variable names:

- `LANGFUSE_BASE_URL`
- `LANGFUSE_PUBLIC_KEY` or `LANGFUSE_PUBLIC_KEY_DEV`
- `LANGFUSE_SECRET_KEY` or `LANGFUSE_SECRET_KEY_DEV`
- `AZURE_OPENAI_API_KEY`, falling back to `LITELLM_AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_ENDPOINT`, with fallback URL environment variables supported by the evaluator
- optional `AZURE_OPENAI_EVAL_MODEL` (default `gpt-4.1-mini`)

With Azure credentials only, the judge still runs but Langfuse trace logging is disabled. Review traces named `eval-mcp-eval-google-finance` (current) and `eval-mcp-eval-morningstar` (legacy). Inspect `task_completion`, judge comments about missing data, and the corresponding `../vibe/.test/.../logs/opencode-response.txt` artifact.

## Latest Preserved Cross-Repository Profile

This is historical evidence, not a rerun for the current documentation change. At commit `7d4173f` dated 2026-03-05:

- Published-source `E2E_MCP_SOURCE=npm npm run test:e2e:agents` passed with `e2e ok`.
- The cross-repository production-source financial eval passed OpenCode and Codex at 6/6, with recorded score 1.
- One startup attempt ended with transient `Connection closed`; the immediate rerun passed.
- A local live-extension run can fail preflight when no extension socket is connected.
- The preserved profile records a score of 1 and complete ticker coverage (6/6); no newer Langfuse result is asserted here.
