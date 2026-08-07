---
name: setup
description: Set up Vibe Browser so Claude Code can drive the user's real Chrome. Use when the vibe MCP tools are missing, return "No connection to Vibe extension", time out, or when the user asks how to install/connect/configure Vibe, the Vibe Chrome extension, or remote browser control.
---

# Set up Vibe Browser

The `vibe` MCP server is only a **relay**. It has no browser of its own: it forwards
tool calls to the **Vibe Chrome extension** running in the user's real Chrome. Until
that extension is installed and connected, every browser tool will fail.

Work through the steps below **in order**. Stop as soon as Step 4 verifies.

## Step 1 — Install the Vibe extension

Ask the user to install the extension in Chrome, Brave, or any Chromium browser:

**Chrome Web Store (recommended)**
<https://chromewebstore.google.com/detail/vibe-ai-browser-co-pilot/djodpgokbmobeclicaicnnidccoinado>

Click **Add to Chrome**. The Vibe icon appears in the toolbar.

**Developer version (if the store is blocked)**
1. Download <https://github.com/VibeTechnologies/VibeWebAgent/releases/latest/download/vibe-ai-copilot-latest.zip>
2. Extract it to a permanent folder (deleting it later uninstalls the extension).
3. Open `chrome://extensions`, turn on **Developer mode**.
4. Click **Load unpacked** and select the extracted folder.

## Step 2 — Turn on external control

The extension refuses external control until the user opts in:

1. Click the **Vibe icon** in the Chrome toolbar.
2. Open **Settings**.
3. Enable **MCP External Control**.
4. The status indicator should read **Connected**.

Chrome must stay open. Closing the browser drops the connection.

## Step 3 — Choose local or remote

**Local (default).** Claude Code and Chrome are on the same machine. Nothing more to
configure — the server auto-spawns a localhost relay daemon and the extension finds it.

**Remote.** Chrome runs on a different machine from Claude Code (for example Claude Code
on a dev box, Chrome on the user's laptop). This needs no inbound port:

1. In the extension **Settings**, switch to **Remote** mode.
2. Copy the **remote UUID** it shows.
3. Pass it to the server, either as an argument (`--remote <uuid>`) or via the
   `VIBE_REMOTE_URL` environment variable.

> The remote UUID is the **only** bearer credential for that browser. Treat it like a
> password. Never paste it into a file the user tracks in git, and never print it back
> in full. If it leaks, regenerate it in extension Settings.

## Step 4 — Verify (do not skip)

Prove the whole chain works before telling the user setup is done. Call the `vibe`
MCP server's tab-listing tool, or run:

```bash
npx -y @vibebrowser/cli@latest tabs
```

A list of the user's **actual open tabs** means the extension, relay, and server are all
connected. Anything else means setup is not finished — go to Troubleshooting.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No connection to Vibe extension` | Extension not installed, or **MCP External Control** is off | Redo Steps 1–2 |
| Tools listed but every call times out | Chrome closed, or the machine went to sleep | Reopen Chrome, confirm the extension shows **Connected** |
| Works locally, fails remotely | Wrong or regenerated UUID | Re-copy the UUID from extension Settings (Step 3) |
| Connects, then drops after an update | Extension auto-updated and reset its toggle | Re-enable **MCP External Control** |

Add `--debug` to the server args to get verbose logs when the table above doesn't resolve it.

## Fallback: no extension at all

If the user cannot install the extension, the server can drive their already-running
Chrome directly over the Chrome DevTools Protocol instead:

```bash
npx -y @vibebrowser/cli@latest --devtools tabs
```

This requires **Chrome 144+** and triggers a one-time permission dialog per profile.
It exposes a smaller tool set (`navigate`, `snapshot`, `click`, `fill`, `type`,
`press_key`, `hover`, `scroll`, `screenshot`, `eval`, `get_text`, `get_url`,
`get_title`, and tab management). Use `snapshot` to get `@eN` element refs, then pass
those refs as selectors to `click`/`fill`/`type`.
