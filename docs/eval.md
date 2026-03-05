# vibe-mcp Evaluation Process

## Scope

This document tracks the current end-to-end evaluation process for `vibe-mcp` against real agent flows and clarifies the difference between local-source validation and npm-production validation.

Evaluation date: **March 4, 2026 (America/Los_Angeles)**.

---

## Current Status Snapshot

| Test | Command | Source | Result |
|---|---|---|---|
| Relay race e2e (fake extension reconnect, local source) | `npm run test:e2e:relay-race` | local workspace | PASS (`e2e ok`) |
| Agent bridge e2e (`vibe-mcp`, real path, local source) | `npm run test:e2e:agents` | local workspace | ENV-DEPENDENT (requires live extension session) |
| Agent bridge e2e (`vibe-mcp`, published source) | `E2E_MCP_SOURCE=npm npm run test:e2e:agents` | npm (`npx @vibebrowser/mcp@latest`) | PASS (`e2e ok`) |
| Financial MCP eval (`vibe`) | `node tests/mcp-eval.test.js --skip-build --model github-copilot/gpt-4.1 --mcp-source npm` | npm (`npx @vibebrowser/mcp@latest`) | PASS (OpenCode/Codex both `6/6`, score `1`) |

Production readiness verdict for `npx -y @vibebrowser/mcp@latest`: **PASSING in current verification runs**.

Stability note:
- One transient `Connection closed` failure was observed at eval startup; immediate rerun passed end-to-end with the same command.
- In the latest local run, `npm run test:e2e:agents` failed at extension preflight (`Extension did not connect to relay`) because no live extension socket was present on `127.0.0.1:19889`.

---

## Required Command Set

### 1. Relay race regression check (extension-independent)

```bash
cd /Users/engineer/workspace/vibebrowser/vibe-mcp
npm run test:e2e:relay-race
```

Pass signal:
- output contains `e2e ok`
- verifies `call_tool -> tool_result` across extension socket replacement
- verifies stale extension close does not emit false `extension_disconnected`

### 2. Local regression check (real extension path)

```bash
cd /Users/engineer/workspace/vibebrowser/vibe-mcp
npm run test:e2e:agents
```

Pass signal:
- output contains `e2e ok`

### 3. Real-stack production check (published package)

```bash
cd /Users/engineer/workspace/vibebrowser/vibe-mcp
E2E_MCP_SOURCE=npm npm run test:e2e:agents
```

Pass signal:
- all MiniWoB tasks return `ok`
- no MCP request timeouts

Note:
- `scripts/e2e-mcp-agents.mjs` always runs the real-extension path now (no `E2E_REAL` toggle).
- Managed Chrome bootstrap is explicit opt-in (`E2E_MANAGED_CHROME=1`).
- By default, real-stack eval expects an already running browser + extension session.

### 4. Cross-repo financial eval (production source)

```bash
cd /Users/engineer/workspace/vibebrowser/vibe
node tests/mcp-eval.test.js --skip-build --model github-copilot/gpt-4.1 --mcp-source npm
```

Pass criteria:
- `MCP tools used: PASS`
- `MCP tool calls >= 4`
- `Google Finance visited: PASS`
- `FINAL_TABLE marker: PASS`
- `Tickers found: 6/6`
- process exits `0`

---

## Why Earlier Evals Could Mislead

`mcp-eval.test.js` now supports explicit source selection:
- `--mcp-source local`
- `--mcp-source npm`
- `--mcp-source auto`

Using local source can validate unpublished fixes and pass while npm `@latest` is still broken. Production claims must be based on `--mcp-source npm`.

---

## Publish Pipeline Reality (Blocking Release)

Publish workflow file:
- `.github/workflows/publish.yml`

Improvements landed:
- trigger includes `main` (and `master` for compatibility)
- publish step attempts token path first, then provenance path fallback

Current blocker:
- CI publish fails with `ENEEDAUTH`.
- `NPM_TOKEN` secret is empty.
- npm trusted publishing is not configured for `@vibebrowser/mcp`.

Until one of those is fixed, npm `@latest` cannot be updated from CI.

---

## References

- Tracking issue: `VibeTechnologies/vibe-mcp#11`
- Fix PR: `VibeTechnologies/vibe-mcp#12`
