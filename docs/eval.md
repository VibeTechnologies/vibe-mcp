# vibebrowser-mcp Evaluation Process

This document tracks the current validation matrix for the `vibebrowser-mcp` and `vibebrowser-cli` binaries, with an explicit split between:

- local workspace validation
- packed package artifact validation (`npm pack`)
- published npm validation (`@vibebrowser/mcp@latest`)
- real-extension browser evals versus fake-extension protocol evals

Evaluation date: **March 25, 2026 (America/Los_Angeles)**.

## Coverage Matrix

| Surface | Harness | Source Modes | Backend | What It Proves |
|---|---|---|---|---|
| Relay race regression | `npm run test:e2e:relay-race` | local | fake extension socket | relay preserves in-flight tool calls across extension reconnects |
| HTTP MCP transport | `npm run test:e2e:http` | local | fake extension socket | streamable HTTP MCP path works end to end |
| OpenClaw-compatible browser CLI | `npm run test:e2e:browser-cli` | `local`, `pack`, `npm` | fake extension socket | `vibebrowser-cli` command shape, JSON output, and tool routing work end to end |
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

### 4. Real-extension agent eval

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

### 5. Full OpenCode browser eval in sibling repo

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
| `E2E_MCP_SOURCE=pack node scripts/e2e-mcp-agents.mjs` | FAIL (environment) | timed out waiting for a live Vibe extension connection on the relay path |
| `npx -y --package @vibebrowser/mcp@latest vibebrowser-mcp --help` | PASS, but stale | published npm has the `vibebrowser-mcp` alias, but not the full new standalone CLI release shape |
| `npx -y --package @vibebrowser/mcp@latest vibebrowser-cli --help` | FAIL | `vibebrowser-cli` is not present in the current npm `latest` release |
| `npm whoami` | FAIL | `ENEEDAUTH`; publish from this machine is currently blocked |

Observed real-extension agent failure:

```text
Error: Extension did not connect to relay within 120000ms. Ensure Vibe extension has MCP External enabled in the active Chrome profile.
```

Interpretation:

- packaged artifacts are valid locally
- the standalone CLI branding and binaries are correct in the tarball
- published npm `latest` is **not yet** updated to the new branded binaries
- real-agent validation currently depends on a live extension session and was not satisfiable in this shell session

## Publish Reality

Current npm state:

- `npm view @vibebrowser/mcp version dist-tags.latest --json` returned `0.2.4`
- `@latest` still resolves to a partial older package surface
- `npm whoami` failed with `ENEEDAUTH`

Consequences:

- the new `vibebrowser-mcp` / `vibebrowser-cli` binaries are verified in a local tarball artifact
- they are **not yet published** to npm from this machine
- do not claim npm end-to-end availability until:
  - a new version is cut
  - publish auth is configured
  - `npx -y --package @vibebrowser/mcp@<new-version> vibebrowser-cli --help` succeeds

## Tracking

- Tracking issue: `VibeTechnologies/vibe-mcp#22`
