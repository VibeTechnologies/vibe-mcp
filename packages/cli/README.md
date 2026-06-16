# @vibebrowser/cli

Standalone CLI for controlling a Vibe-connected browser session.

```bash
VIBE_REMOTE_UUID="YOUR-EXTENSION-UUID"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/YOUR-EXTENSION-UUID"

npx @vibebrowser/cli --remote "$VIBE_REMOTE_UUID" --json status
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json tabs
```

`--remote <uuid>` uses the default public Vibe relay. `--remote <full-ws-url>` targets an explicit relay endpoint.
