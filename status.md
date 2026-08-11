# status — Anthropic Connectors Directory submission pack

```
ROADMAP  ██████████████████░░  9/10 done
 [x] 1. Fetch CURRENT Anthropic docs — portal, not a GitHub repo
 [x] 2. Enumerate all 11 portal steps + every field
 [x] 3. Screenshots: NOT required (MCP Apps only) — icon IS required
 [x] 4. Verify 10 URLs + 401 handshake + both .well-known + DCR 201 live
 [x] 5. Dump 27-tool inventory w/ annotations (11 read-only / 16 write / 5 destr)
 [x] 6. Icon 512x512 verified visually, no PII -> assets/directory-icon-512.png
 [x] 7. Write worklog/anthropic-submission-pack.md, every field pre-filled
 [x] 8. Name 2 blockers: Team/Enterprise plan gate; docs still show UUID path
 [x] 9. build + tsc + validate:skill + test:ci all green; PR merged
 [~] 10. Founder-only: clear 2 blockers, then paste the form  <-- YOU ARE HERE
```

## Key findings

- Submission is a **web portal inside Claude.ai admin settings**
  (`https://claude.ai/admin-settings/directory/submissions/new`), not a GitHub
  PR. The earlier `claude-plugins-official` / `claude-community` repo theory is
  wrong and appears nowhere in the current docs.
- **Screenshots are NOT required.** Carousel screenshots apply only to *MCP
  Apps* (servers with interactive UI). We are a plain remote MCP server. One
  image is required: the listing icon.
- **Functional testing confirmed as escalation-only.** Automated policy scan →
  Community listing by default; a human runs every tool only if Anthropic
  escalates to Verified, which we cannot request. Prior conclusion holds.
  Caveat: portal step 3 syncs `tools/list` **live**, so the founder must have
  their browser + extension connected while filling in the form.
- **Blocker 1 — plan gate.** The portal needs a **Team or Enterprise** org;
  admin settings do not exist on individual plans. Could not check which plan
  the founder is on (not authorized to log into claude.ai).
- **Blocker 2 — docs mismatch.** `/integrations/claude-connector` and `/mcp`
  still document the legacy `/mcp/<uuid>` credential-in-URL path and say "no
  OAuth". `oauth` appears zero times on `/mcp`. Must be fixed in
  `VibeBrowserProductPage` before submitting.

## Proof (measured in prod 2026-08-11)

```
POST /mcp (no creds) -> 401
  www-authenticate: Bearer resource_metadata="…", scope="browser:read browser:control"
/.well-known/oauth-protected-resource   -> 200   (resource matches entered URL exactly)
/.well-known/oauth-authorization-server -> 200   (S256 + offline_access advertised)
POST /oauth/register                    -> 201   (accepts claude.ai/api/mcp/auth_callback)
privacy, terms, mcp, integrations, claude-connector, chatgpt-connector, cli, / -> 200
```

## Next

- Founder: confirm Claude plan is Team/Enterprise; fix the two docs pages; then
  run §9 of `worklog/anthropic-submission-pack.md`.
