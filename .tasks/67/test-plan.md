## Modality
CLI / MCP integration test against real server process via stdio transport (no mocks).

## Setup
1. `npm ci` (if dependencies missing)
2. `npm run build`

## Steps
1. Run `node scripts/e2e-local-startup-fallback.mjs`.
   - Expected: script prints fallback warning and pass marker `local startup fallback e2e ok`.
2. During script execution, assert MCP `listTools` returns `set_remote` after forced local relay startup failure.
   - Expected: no MCP startup crash; tools list includes `set_remote`.
3. In same script, call `set_remote` with a full local relay URL and verify JSON response.
   - Expected: `ok: true`, `relayUrl` normalized to relay base, `uuid` matches URL UUID.
4. In same script, call `set_remote` with bare UUID and verify JSON response.
   - Expected: `ok: true`, `relayUrl` reused from current remote base, `uuid` matches bare UUID.

## Pass criterion
Build succeeds and script exits 0 with pass marker; this proves startup fallback remains reachable and `set_remote` works for URL + UUID forms.
