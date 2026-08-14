# @vibebrowser/cli

Standalone CLI for controlling a Vibe-connected browser session.

> ⚠️ **Security:** A relay URL/UUID/connector URL (`https://relay.api.vibebrowser.app/mcp/<uuid>`) grants **live control of your browser session** (read tabs, screenshots, page content). It is the *sole* bearer credential — there is no second-factor secret. Treat it like a password — never share it, paste it into a chat with untrusted parties, or commit it to a repo — and if it leaks, regenerate it in the Vibe extension Settings. The `YOUR-EXTENSION-UUID` value below is a non-routable placeholder.

`--remote` accepts three forms, all normalized to the same relay connection:

| Form | Example | Status |
|---|---|---|
| Connector URL | `https://relay.api.vibebrowser.app/mcp/00000000-0000-0000-0000-000000000000` | **Recommended** — the same string shown in the extension's Settings and pasted into Claude/ChatGPT connectors |
| Bare extension UUID | `00000000-0000-0000-0000-000000000000` | Advanced / compatibility — uses the default public relay |
| ws(s) relay URL | `wss://relay.api.vibebrowser.app/00000000-0000-0000-0000-000000000000` | Advanced / compatibility — targets an explicit relay endpoint |

```bash
VIBE_REMOTE_URL="https://relay.api.vibebrowser.app/mcp/00000000-0000-0000-0000-000000000000"

npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json status
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json tabs
```

`--remote <connector-url>` (preferred) and `--remote <uuid>` both use the default public Vibe relay. `--remote <full-ws-url>` targets an explicit relay endpoint. No second-factor secret is needed or accepted — whichever form you pass is the sole credential that authorizes the session. Rejected: an invalid UUID; a URL with embedded credentials, a query string, or a fragment; plaintext `http://`/`ws://` for a non-loopback host; and any HTTP(S) URL that doesn't end in the exact `/mcp/<uuid>` suffix.
