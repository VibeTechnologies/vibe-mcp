## Post-merge verification

- PR: `#68`
- Merge commit: `94712f0c76487bee8cc42952292e1fa4f34e9ccf`
- Workflow: `Publish to npm` run `26484844463`

## Checks executed
1. `gh run view 26484844463 --log-failed`
2. `npm view @vibebrowser/mcp version`
3. `npm view @vibebrowser/cli version`
4. `npx -g @vibebrowser/mcp --version` (pre-merge remained at 0.2.11)

## Runtime evidence
- Publish workflow failed in both OIDC and token fallback paths with npm registry error:
  - `npm error 404 Not Found - PUT https://registry.npmjs.org/@vibebrowser%2fmcp - Not found`
- npm latest stayed unchanged:
  - `@vibebrowser/mcp`: `0.2.11`
  - `@vibebrowser/cli`: `0.2.11`

## Result
PROD: fail (release delivery blocked by npm publish auth/ownership mismatch; latest package not updated)

## Recovery iteration evidence
- Workflow dispatch run on recovery branch: `26485372331`
- Outcome unchanged: OIDC publish returns npm `E404`, all token sources fail `npm whoami` preflight.
- Conclusion unchanged: delivery blocked by external npm credential/ownership configuration.

## Recovery iteration 2 evidence
- Branch/workflow: `own/67-publish-recovery-2` / run `26488104816`
- Workflow behavior change confirmed:
  - Token preflight is diagnostic-only.
  - Publish fallback attempts now run for `NODE_AUTH_TOKEN`, `NPM_TOKEN`, and `NODE_AUTH_TOKEN_FALLBACK` even when `npm whoami` fails.
- Runtime outcome unchanged:
  - OIDC attempt still fails with `404 Not Found - PUT https://registry.npmjs.org/@vibebrowser%2fmcp - Not found`.
  - Token publish attempts for all three sources also fail with same npm `E404`.
- Dist-tag check after run:
  - `npm view @vibebrowser/mcp version` -> `0.2.11`
  - `npm view @vibebrowser/cli version` -> `0.2.11`

## Result (current)
PROD: fail (workflow fallback behavior improved and verified; delivery still blocked by external npm publisher auth/ownership)
