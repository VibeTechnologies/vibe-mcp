# @vibebrowser/cli

Standalone CLI for controlling a Vibe-connected browser session.

> ⚠️ **Security:** A relay URL/UUID (`wss://relay.api.vibebrowser.app/<uuid>`) grants **live control of your browser session** (read tabs, screenshots, page content). Treat it like a password — never share it, paste it into a chat with untrusted parties, or commit it to a repo. Relay second-factor auth uses a separate token (`VIBE_REMOTE_SECRET` / `--remote-secret`) and must never be placed in URL/query params. The `YOUR-EXTENSION-UUID` value below is a non-routable placeholder.

```bash
VIBE_REMOTE_UUID="YOUR-EXTENSION-UUID"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/YOUR-EXTENSION-UUID"
export VIBE_REMOTE_SECRET="<64-lowercase-hex-token>" # only when relay auth is enabled

npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_UUID" --json status
npx -y @vibebrowser/cli@latest --remote "$VIBE_REMOTE_URL" --json tabs
```

`--remote <uuid>` uses the default public Vibe relay. `--remote <full-ws-url>` targets an explicit relay endpoint. Use `VIBE_REMOTE_SECRET` (or `--remote-secret`) only when relay auth is enabled.
