src/server.ts:42: INFO `set_remote` metadata now matches design: call-first guidance is explicit and both UUID/full URL inputs are documented. Keep docs and parser behavior in sync.
src/server.ts:113: INFO Startup fallback is scoped to local non-devtools mode, while remote/devtools still fail fast. Keep this guard narrow to avoid masking remote failures.
src/connection.ts:85: INFO Bare UUID targets are supported and normalized against relay base, satisfying the design contract for low-friction reconnect. Keep UUID validation centralized here.
scripts/e2e-local-startup-fallback.mjs:84: INFO Regression coverage verifies MCP availability after local startup failure and `set_remote` behavior for URL + UUID. Keep this in release-gating checks.
.github/workflows/publish.yml:1: INFO CI for PR #68 is green (`gh pr checks 68` shows `build: pass`), so no blocking pipeline failures are present pre-merge.
FINAL: ship.
