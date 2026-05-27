.github/workflows/publish.yml:121: INFO Previous prefix-based token filtering could reject valid npm secrets. Keep non-empty token collection with auth-based validation.
.github/workflows/publish.yml:131: INFO Fallback now gates publish attempts with `npm whoami`, so invalid tokens fail fast with actionable source-level diagnostics. Keep this preflight before `npm publish`.
.github/workflows/publish.yml:153: INFO Trying all configured token sources is a safe resilience improvement and directly useful for mixed secret rotation states. Keep ordered multi-source retry behavior.
.github/workflows/publish.yml:166: INFO Outputting `token:<source>` improves operability without leaking credentials. Keep source-only reporting and avoid token value logging.
.tasks/67/test-report.md:32: INFO Recovery test correctly proves this PR does not solve external npm ownership/credential failure by itself; it improves failure observability. Keep this limitation explicit in task docs.
CI(PR #69):1: INFO `build` check is passing and no CI failures are present for this change set. Keep CI green gate before merge.
FINAL: ship
