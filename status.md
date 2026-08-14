# status — public MCP docs aligned to the direct HTTP connector

```
ROADMAP  ████████████████████  9/9 done
 [x] 1. Audit docs: no relay OAuth guidance, no stale hosted claims
 [x] 2. README remote-connector section = direct HTTP /mcp/<uuid> only
 [x] 3. Credential warning + real Settings onboarding path documented
 [x] 4. Historical internal worklogs banner-marked, not current guidance
 [x] 5. build + tsc + validate:skill green; committed 62b1c74
 [x] 6. Re-verify pass: no OAuth instructions, no worklog links, worktree clean
 [x] 7. Review fixes: server.json onboarding, ChatGPT-desktop=stdio label,
        hermetic docs-contract guard in test/test:ci
 [x] 8. Cross-review: contract pins HTTPS-only hosted table, exact
        `codex mcp add vibe --url`, migration note, pack section superseded
 [x] 9. Guard hardened: same-line denial required, real markdown-link check,
        scan covers SKILL.md/docs/mcpb; Claude Desktop marked alternative

WHY SLOW
 - not slow; docs-only change, no blockers

NEXT
 - open PR; close/supersede stale PR #141 (no longer valid guidance)
```

## Supported user-facing shape

| Path | Transport | Credential |
|---|---|---|
| Hosted Claude (web, Cowork, mobile, Desktop), Codex desktop, ChatGPT web | `https://relay.api.vibebrowser.app/mcp/<uuid>` (Streamable HTTP) | UUID in URL |
| Anything that can send headers (Codex CLI, scripts) | `POST /mcp` + `X-Remote-Session` / `Authorization: Bearer` | UUID in header |
| Local MCP clients (Claude Desktop, Cursor, VS Code, OpenCode) | stdio via `npx -y @vibebrowser/mcp` | none (localhost) |
| CLI / OpenClaw skill | `wss://relay.api.vibebrowser.app/<uuid>` | UUID in URL |

Onboarding path for the UUID: **Vibe icon → Settings → AI Agent Control →
Remote (internet) → Relay access**.

## Not supported in the user-facing path

- Never document as setup: relay OAuth consent, `/oauth/authorize` (not a
  supported endpoint for users), token exchange, no dynamic client registration,
  no scope configuration. No public doc may instruct a user to do any of these.
- The UUID is the sole bearer credential. It grants live control of the
  logged-in browser session — treat it like a password; regenerate in extension
  Settings if it leaks.

## Historical material

`worklog/anthropic-submission-pack.md`, `worklog/openai-verification-pack.md`
and `worklog/mcp-distribution-channels.md` are point-in-time internal research
from Aug 2026. The OAuth/DCR direction they describe is retired and is **not**
the supported user path. Each now carries a HISTORICAL banner. Kept for provenance,
not as setup instructions.

## Next

- None for docs. Reopen only if the relay's supported transport changes.
