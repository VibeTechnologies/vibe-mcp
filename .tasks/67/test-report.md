## Commands
- `npm run build`
- `node scripts/e2e-local-startup-fallback.mjs`

## Results
1. `npm run build` - PASS
   - Output: TypeScript compile and `prepare-cli-package` completed.
2. `node scripts/e2e-local-startup-fallback.mjs` - PASS
   - Output included:
     - `[vibebrowser-mcp] Warning: local extension startup failed; continuing without tools: Relay failed to start within timeout`
     - `local startup fallback e2e ok`

## Assertions Verified
- MCP server remains available after forced local relay startup failure.
- `listTools` includes `set_remote` in fallback state.
- `set_remote` accepts full `ws://.../<uuid>` URL and returns `{ ok: true, relayUrl, uuid }`.
- `set_remote` accepts bare UUID and reuses remote relay base from existing remote config.

## RESULT
RESULT: pass

---

## Recovery iteration test (publish path)

## Commands
- `gh workflow run "Publish to npm" --ref own/67-publish-recovery`
- `gh run watch 26485372331`
- `gh run view 26485372331 --log-failed`

## Results
1. Workflow dispatch run `26485372331` - FAIL (expected for current credential state)
   - OIDC attempt reached npm publish but returned:
     - `npm error 404 Not Found - PUT https://registry.npmjs.org/@vibebrowser%2fmcp - Not found`
   - Token fallback diagnostics now show per-source preflight:
     - `Skipping token from NODE_AUTH_TOKEN: npm whoami failed`
     - `Skipping token from NPM_TOKEN: npm whoami failed`
     - `Skipping token from NODE_AUTH_TOKEN_FALLBACK: npm whoami failed`

## Assertions Verified
- New fallback logic tries all token sources.
- New preflight diagnostics clearly identify token auth failure across all configured secrets.

## RESULT (Recovery iteration)
RESULT: fail (external npm credentials/ownership still invalid for publish)

---

## Recovery iteration 2 test (non-blocking token preflight)

## Commands
- `gh workflow run "Publish to npm" --ref own/67-publish-recovery-2`
- `gh run watch 26488104816`
- `gh run view 26488104816 --log-failed`

## Results
1. Workflow dispatch run `26488104816` - FAIL (expected while npm auth/ownership remains unresolved)
   - OIDC attempt still fails with:
     - `npm error 404 Not Found - PUT https://registry.npmjs.org/@vibebrowser%2fmcp - Not found`
   - Token fallback now attempts publish for each configured source even after `npm whoami` preflight failure:
     - `Token from NODE_AUTH_TOKEN failed npm whoami preflight; attempting publish anyway`
     - `Trying token fallback from NODE_AUTH_TOKEN for @vibebrowser/mcp...`
     - `Token from NPM_TOKEN failed npm whoami preflight; attempting publish anyway`
     - `Trying token fallback from NPM_TOKEN for @vibebrowser/mcp...`
     - `Token from NODE_AUTH_TOKEN_FALLBACK failed npm whoami preflight; attempting publish anyway`
     - `Trying token fallback from NODE_AUTH_TOKEN_FALLBACK for @vibebrowser/mcp...`

## Assertions Verified
- `npm whoami` no longer gates/skips token publish attempts.
- Publish fallback executes for all configured token sources.
- External blocker unchanged: registry still rejects publish with npm `E404`.

## RESULT (Recovery iteration 2)
RESULT: fail (workflow behavior corrected; publish still blocked by external npm credential/ownership state)
