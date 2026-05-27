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
