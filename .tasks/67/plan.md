## Approach Summary
Implement startup resilience + stronger `set_remote` guidance in `src/server.ts`, then release via patch version bump so npm `latest` ships new behavior. Validate with build and targeted e2e startup-failure regression plus npm/npx post-merge checks.

## Tradeoff: Speed vs Quality
- chosen: balanced
- rationale: task small code delta but release impact high; add one focused regression test + release verification without broad refactors.

## Tasks
| # | Title | Files | Depends on | Parallel group | Suggested model |
|---|-------|-------|------------|----------------|-----------------|
| 1 | Update `set_remote` metadata and local startup fallback handling | `src/server.ts` | - | A | sonnet |
| 2 | Add focused regression e2e for local startup failure path | `scripts/e2e-local-startup-fallback.mjs` | 1 | B | gpt-5.1-codex |
| 3 | Bump package versions for publishable release | `package.json`, `packages/cli/package.json`, `package-lock.json` | 1 | B | sonnet |
| 4 | Run build + focused e2e and capture reports | `.tasks/67/test-report.md` | 2,3 | C | sonnet |
| 5 | Open PR, watch CI, final review, merge, post-merge verify npm delivery | `.tasks/67/review.md`, `.tasks/67/verify.md`, `.tasks/67/STATE.md` | 4 | D | sonnet |

## Parallel Groups
- **A**: task 1.
- **B**: tasks 2 and 3 can run together after task 1 (no shared files).
- **C**: task 4 after B.
- **D**: task 5 after C.

## Done Criteria
- Task 1: `src/server.ts` catches local non-devtools startup failures and `set_remote` description clearly documents first-call behavior and input forms.
- Task 2: new e2e script fails on old behavior and passes on new behavior by proving MCP starts and exposes `set_remote` after forced local relay startup failure.
- Task 3: package versions incremented to unreleased patch value consistently across root + CLI + lockfile.
- Task 4: `npm run build` and `node scripts/e2e-local-startup-fallback.mjs` pass; outputs recorded in test report.
- Task 5: PR merged, publish workflow green, npm latest equals new version, `npx -g @vibebrowser/mcp --version` + `--help` succeed.

## Rollback Plan
If regression found after merge, revert merge commit from `main`, unpublish not required (npm immutable). Ship follow-up patch restoring previous startup behavior and preserving compatible `set_remote` metadata.
