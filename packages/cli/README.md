# @vibebrowser/cli

Standalone CLI for controlling a Vibe-connected browser session.

```bash
VIBE_REMOTE_UUID="2d2f60a1-2031-4279-aa25-358f2c5b6f84"
VIBE_REMOTE_URL="wss://relay.api.vibebrowser.app/2d2f60a1-2031-4279-aa25-358f2c5b6f84"

npx @vibebrowser/cli --remote "$VIBE_REMOTE_UUID" --json status
npx @vibebrowser/cli --remote "$VIBE_REMOTE_URL" --json tabs
```

`--remote <uuid>` uses the default public Vibe relay. `--remote <full-ws-url>` targets an explicit relay endpoint.
