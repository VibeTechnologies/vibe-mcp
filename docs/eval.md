# vibebrowser-mcp Evaluation Process

This document tracks the current validation matrix for the `vibebrowser-mcp` and `vibebrowser-cli` binaries, with an explicit split between:

- local workspace validation
- packed package artifact validation (`npm pack`)
- published npm validation (`@vibebrowser/mcp@latest`)
- real-extension browser evals versus fake-extension protocol evals

Command convention for this document:

- Direct package exec (preferred for MCP server): `npx -y @vibebrowser/mcp@latest ...`
- Explicit bin aliases (backward compatibility checks): `npx -y -p @vibebrowser/mcp@latest vibebrowser-mcp ...` and `npx -y -p @vibebrowser/mcp@latest vibe-mcp ...`

Evaluation date: **March 26, 2026 (America/Los_Angeles)**.

## Coverage Matrix

| Surface | Harness | Source Modes | Backend | What It Proves |
|---|---|---|---|---|
| Relay race regression | `npm run test:e2e:relay-race` | local | fake extension socket | relay preserves in-flight tool calls across extension reconnects |
| HTTP MCP transport | `npm run test:e2e:http` | local | fake extension socket | streamable HTTP MCP path works end to end |
| OpenClaw-compatible browser CLI | `npm run test:e2e:browser-cli` | `local`, `pack`, `npm` | fake extension socket | `vibebrowser-cli` command shape, JSON output, and tool routing work end to end |
| Live browser CLI regression | `npm run test:e2e:browser-cli-live` | local | real extension session | validates `open`/`snapshot` behavior on a real URL against the connected Vibe extension |
| Codex + OpenCode MCP bridge | `npm run test:e2e:agents` | `local`, `pack`, `npm` | real extension session | packaged `vibebrowser-mcp` can be launched by Codex/OpenCode tooling and route MCP traffic to a real Vibe-connected browser |
| OpenCode financial eval (`../vibe`) | `node tests/mcp-eval.test.js --skip-build --model github-copilot/gpt-4.1 --mcp-source ...` | `auto`, `local`, `pack`, `npm` | harness-managed browser + extension | full OpenCode browser task execution against the Vibe extension |

Important scope note:
- There is **not yet** a full hosted OpenClaw runtime eval in this repo.
- Current OpenClaw coverage is the **OpenClaw-compatible CLI surface** (`vibebrowser-cli`) plus the `openclaw` helper and HTTP bridge docs.
- Do not claim full hosted OpenClaw runtime parity based only on the CLI test.

## Source Selectors

### Browser CLI harness

`scripts/e2e-browser-cli.mjs` now supports:

- `E2E_BROWSER_CLI_SOURCE=local`
- `E2E_BROWSER_CLI_SOURCE=pack`
- `E2E_BROWSER_CLI_SOURCE=npm`

Optional override:

- `E2E_BROWSER_CLI_PACKAGE=/absolute/or/relative/path/to/package.tgz`

`pack` mode creates a temporary tarball with `npm pack --json --pack-destination ...` and runs:

```bash
npx -y --package <local-tarball> vibebrowser-cli ...
```

### MCP agent harness

`scripts/e2e-mcp-agents.mjs` now supports:

- `E2E_MCP_SOURCE=local`
- `E2E_MCP_SOURCE=pack`
- `E2E_MCP_SOURCE=npm`

Optional override:

- `E2E_MCP_PACKAGE=/absolute/or/relative/path/to/package.tgz`

`pack` mode creates a temporary tarball and runs:

```bash
npx -y --package <local-tarball> vibebrowser-mcp ...
```

### Cross-repo OpenCode eval

`../vibe/tests/mcp-eval.test.js` now accepts:

- `--mcp-source auto`
- `--mcp-source local`
- `--mcp-source pack`
- `--mcp-source npm`
- `--mcp-package <tarball-or-package-spec>`

Use `--mcp-source pack` when validating a release candidate before publish.

## Required Commands

### 1. Local regression suite

```bash
cd /Users/engineer/workspace/vibebrowser/vibe-mcp
npm run build
npm test
```

Pass signal:

- `npm test` exits `0`
- output contains:
  - `e2e ok`
  - `http e2e ok`
  - `browser cli e2e ok`

### 2. Packaged CLI artifact validation

```bash
cd /Users/engineer/workspace/vibebrowser/vibe-mcp
E2E_BROWSER_CLI_SOURCE=pack node scripts/e2e-browser-cli.mjs
```

Pass signal:

- output contains `browser cli e2e ok`
- `vibebrowser-cli` is installed from a `.tgz` package artifact, not from the workspace

### 3. Packaged binary smoke check

```bash
cd /Users/engineer/workspace/vibebrowser/vibe-mcp
TMP_DIR="$(mktemp -d)"
npm pack --json --pack-destination "$TMP_DIR"
npx -y --package "$TMP_DIR"/vibebrowser-mcp-*.tgz vibebrowser-mcp --help
npx -y --package "$TMP_DIR"/vibebrowser-mcp-*.tgz vibebrowser-cli --help
```

Pass signal:

- `vibebrowser-mcp --help` prints the branded CLI
- `vibebrowser-cli --help` prints the standalone OpenClaw-compatible CLI

### 4. Published npm CLI validation

```bash
cd /Users/engineer/workspace/vibebrowser/vibe-mcp
npx -y @vibebrowser/mcp@latest --version
npx -y -p @vibebrowser/mcp@latest vibebrowser-mcp --version
npx -y -p @vibebrowser/mcp@latest vibe-mcp --version
npx -y -p @vibebrowser/mcp@latest vibebrowser-cli --version
E2E_BROWSER_CLI_SOURCE=npm node scripts/e2e-browser-cli.mjs
```

Pass signal:

- direct package invocation and all aliases print the published version
- `browser cli e2e ok` proves `vibebrowser-cli` works from the npm registry package, not only from a local tarball

### 5. Real-extension agent eval

```bash
cd /Users/engineer/workspace/vibebrowser/vibe-mcp
E2E_MCP_SOURCE=pack node scripts/e2e-mcp-agents.mjs
```

Pass signal:

- output contains `e2e ok`
- Codex uses `vibe-browser.*` tools
- OpenCode can resolve the same MCP config and report `vibe-browser connected`

Hard requirement:

- a live Vibe extension session must already be connected or connectable on the relay path
- this harness does **not** prove anything if the extension is absent
- default Codex settings are tuned for current CLI compatibility:
  - `E2E_CODEX_MODEL=gpt-5`
  - `E2E_CODEX_REASONING_EFFORT=low`
  - `E2E_CODEX_TIMEOUT_MS=480000`

### 5a. Live browser CLI regression (real extension)

```bash
cd /Users/engineer/workspace/vibebrowser/vibe-mcp
npm run test:e2e:browser-cli-live
```

Optional env overrides:

- `BROWSER_LIVE_URL` (default: X search URL from issue repro)
- `BROWSER_LIVE_TIMEOUT_MS` (default: `60000`)
- `BROWSER_LIVE_MIN_CONTENT_CHARS` (default: `200`)

Pass signal:

- output contains `live browser cli e2e ok`
- output prints measured `open latency`, content lengths, and matched `pageId`
- test proves real-extension `open` + page-content + `snapshot --page-id` flow (not mocked)

### 5b. Latest built extension eval via Chrome for Testing

Build the dev extension first:

```bash
cd /Users/engineer/workspace/vibebrowser/vibe
npm run build:extension:dev
```

Use the direct script form when debugging the isolated path, especially from a detached worktree where `../vibe` discovery may not point at the intended sibling repo:

```bash
cd /Users/engineer/workspace/vibebrowser/vibe-mcp
E2E_DEBUG=1 \
E2E_TEST_BROWSER=1 \
E2E_VIBE_REPO_ROOT=/Users/engineer/workspace/vibebrowser/vibe \
E2E_TEST_EXTENSION_PATH=/Users/engineer/workspace/vibebrowser/vibe/dist/extension/dev \
E2E_MCP_SOURCE=npm \
node scripts/e2e-mcp-agents.mjs
```

Use the package-script entrypoint for the canonical repo-level check:

```bash
cd /Users/engineer/workspace/vibebrowser/vibe-mcp
E2E_TEST_BROWSER=1 \
E2E_VIBE_REPO_ROOT=/Users/engineer/workspace/vibebrowser/vibe \
E2E_TEST_EXTENSION_PATH=/Users/engineer/workspace/vibebrowser/vibe/dist/extension/dev \
E2E_MCP_SOURCE=npm \
npm run test:e2e:agents
```

Pass signal:

- output contains `e2e ok`
- the eval launches a separate Chrome for Testing instance
- the loaded extension comes from `../vibe/dist/extension/dev`, not the user’s daily Chrome profile

### 6. Full OpenCode browser eval in sibling repo

```bash
cd /Users/engineer/workspace/vibebrowser/vibe
node tests/mcp-eval.test.js --skip-build --model github-copilot/gpt-4.1 --mcp-source pack
```

Pass criteria:

- `MCP External enabled: PASS`
- `Relay connected: PASS`
- `MCP tools used: PASS`
- `Tickers found: 6/6`
- process exits `0`

Note:

- this harness launches its own browser test environment from the `vibe` repo
- use it when you explicitly want the full browser-task eval, not just package smoke coverage

## Latest Verification Snapshot

Commands executed in this session:

| Command | Result | Notes |
|---|---|---|
| `npm run build` | PASS | local TypeScript build succeeded |
| `npm test` | PASS | relay race, HTTP, and local browser CLI e2e all passed |
| `E2E_BROWSER_CLI_SOURCE=pack node scripts/e2e-browser-cli.mjs` | PASS | tarball-installed `vibebrowser-cli` passed end to end |
| `npm pack --json --pack-destination <tmp>` | PASS | tarball includes both `dist/cli.js` and `dist/browser-main.js` plus docs/openclaw skill files |
| `npx -y --package <local-tarball> vibebrowser-mcp --help` | PASS | branded `vibebrowser-mcp` binary available from package artifact |
| `npx -y --package <local-tarball> vibebrowser-cli --help` | PASS | standalone `vibebrowser-cli` binary available from package artifact |
| `gh workflow run "Publish to npm" --ref release/vibebrowser-cli-0.2.5` | PASS | GitHub publish workflow completed successfully |
| `npm view @vibebrowser/mcp version dist-tags.latest bin --json` | PASS | npm `latest` is now `0.2.5` and includes `mcp`, `vibebrowser-mcp`, `vibe-mcp`, and `vibebrowser-cli` |
| `npx -y @vibebrowser/mcp@latest --version` | PASS | direct package invocation resolves to published CLI |
| `npx -y -p @vibebrowser/mcp@latest vibebrowser-mcp --version` | PASS | published explicit binary resolves to `0.2.5` |
| `npx -y -p @vibebrowser/mcp@latest vibe-mcp --version` | PASS | legacy alias still resolves to `0.2.5` |
| `npm run test:e2e:agents` | PASS | local `dist/cli.js` path completed all three MiniWoB tasks with Codex + OpenCode against the live extension session |
| `E2E_MCP_SOURCE=npm npm run test:e2e:agents` | PASS | published npm binary path completed the same three MiniWoB tasks end to end |
| `E2E_DEBUG=1 E2E_TEST_BROWSER=1 E2E_VIBE_REPO_ROOT=/Users/engineer/workspace/vibebrowser/vibe E2E_TEST_EXTENSION_PATH=/Users/engineer/workspace/vibebrowser/vibe/dist/extension/dev E2E_MCP_SOURCE=npm node scripts/e2e-mcp-agents.mjs` | PASS | debug run against a separate Chrome for Testing instance with the unpacked extension build |
| `E2E_TEST_BROWSER=1 E2E_VIBE_REPO_ROOT=/Users/engineer/workspace/vibebrowser/vibe E2E_TEST_EXTENSION_PATH=/Users/engineer/workspace/vibebrowser/vibe/dist/extension/dev E2E_MCP_SOURCE=npm npm run test:e2e:agents` | PASS | canonical repo entrypoint passed against the latest built extension in isolated browser mode |
| `npx -y -p @vibebrowser/mcp@latest vibebrowser-cli --version` | PASS | standalone CLI is now available from npm `latest` |
| `E2E_BROWSER_CLI_SOURCE=npm node scripts/e2e-browser-cli.mjs` | PASS | npm-installed `vibebrowser-cli` passed end to end |
| `npm run test:e2e:browser-cli-live` | PASS | real extension run against X search URL; reported open latency `60718ms`, open content `9119` chars, snapshot content `9564` chars |
| `E2E_MCP_SOURCE=pack node scripts/e2e-mcp-agents.mjs` | FAIL (environment) | timed out waiting for a live Vibe extension connection on the relay path |

Observed real-extension agent failure:

```text
Error: Extension did not connect to relay within 120000ms. Ensure Vibe extension has MCP External enabled in the active Chrome profile.
```

Interpretation:

- packaged artifacts are valid locally
- the standalone CLI branding and binaries are correct in the tarball
- published npm `latest` is now updated to `0.2.5` with all intended binaries
- real-agent validation currently depends on a live extension session and was not satisfiable in this shell session

## Publish Reality

Current npm state:

- `npm view @vibebrowser/mcp version dist-tags.latest bin --json` returns `0.2.5`
- `@latest` now includes:
  - `mcp`
  - `vibebrowser-mcp`
  - `vibe-mcp`
  - `vibebrowser-cli`
- publish succeeded via GitHub Actions workflow `Publish to npm`

Consequences:

- the new `vibebrowser-mcp` / `vibebrowser-cli` binaries are published to npm and verified from the registry
- the remaining non-green item is the real-extension agent eval, which still requires a live Vibe extension session on the relay path

## Known root causes & regressions

### `tools/list` startup timeout (#14)

**Symptom:** Codex/OpenCode intermittently reported `MCP startup failed: timed out
awaiting tools/list after 10s`, or showed `vibe-browser` enabled with 0 tools.

**Root cause:** when the tool cache was empty at startup, the `tools/list` handler
blocked on `refreshTools` (4s) **then** `waitForToolsUpdate` (1.5s) — up to ~5.5s
of in-handler blocking. Stacked on top of relay/extension connection setup, a
single `tools/list` could exceed the client's 10s startup budget, especially when
the extension was connected but had not yet published its tools.

**Fix:** the handler now bounds the whole wait with a single
`STARTUP_TOOLS_LIST_BUDGET_MS` (3s) deadline (`src/server.ts`). Whatever is cached
at the deadline is returned (always at least `set_remote`); tools that arrive later
are pushed to the client via the `notifications/tools/list_changed` capability
(already advertised). This caps handler latency well under any client budget
regardless of connection state.

**Regression test:** `npm run test:e2e:tools-list-budget`
(`scripts/e2e-tools-list-startup-budget.mjs`) — a fake relay reports the extension
connected but never answers `list_tools`; the test asserts `tools/list` returns in
< 4.5s with `set_remote` present. Runs in CI via `npm run test:ci`.

## Tracking

- Tracking issue: `VibeTechnologies/vibe-mcp#22`
- Release PR: `VibeTechnologies/vibe-mcp#23`
