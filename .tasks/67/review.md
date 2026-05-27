.github/workflows/publish.yml:121: INFO Token fallback now accepts all non-empty configured token candidates (no brittle `npm_` prefix gate), which avoids rejecting valid npm token formats. Keep candidate filtering based on auth checks, not string prefix.
.github/workflows/publish.yml:131: INFO `npm whoami` preflight validates each token before publish attempts, reducing noisy publish failures and limiting fallback to authenticated tokens. Keep this preflight before `npm publish`.
.github/workflows/publish.yml:153: INFO Fallback iterates all configured token sources instead of stopping at first candidate, improving recovery when one token is stale or under-scoped. Keep source-by-source retry behavior.
.github/workflows/publish.yml:166: INFO Workflow output records the successful fallback source (`token:<source>`) without exposing token material, which is useful for debugging and safe for logs. Keep source-only logging.

VERDICT: pass
