# MCP distribution channels — where we can list vibe-mcp

Per-product status for getting vibe-mcp in front of users who cannot run a
local process — i.e. Claude on the web and ChatGPT on the web. Both accept a
remote MCP server URL, no command, no args, **no custom headers**, which is why
`https://relay.api.vibebrowser.app/mcp/<uuid>` (VibeTechnologies/platform#64)
exists at all: the header forms (`X-Remote-Session`, `Authorization: Bearer`)
are unusable in a connector form.

`<uuid>` is the routing UUID from the extension: Settings -> external agent
control -> Remote (internet) -> Agent connection URL. It is a bearer capability
granting full control of that browser — never paste it anywhere except the
connector form, never log or screenshot it.

## Status — verified 2026-08-07

| Product | Surface | Custom MCP allowed | Status | Evidence |
|---|---|---|---|---|
| Claude (web) | Settings -> Connectors -> Add -> Add custom connector | Yes, no domain verification, no allowlist | **Connected + verified** | 27 tools discovered; live prompt answered `2018` via `New page` + `Take snapshot` tool calls |
| ChatGPT (web) | Settings -> Security and login -> Developer mode ON, then Plugins -> Create app | Yes, gated behind developer mode | **Connected + verified** | Actions discovered; live prompt answered `2018` after 6 tool calls incl. `Navigate page` |

Verification prompt used in both:

> Using the vibebrowser connector, open a NEW browser tab, go to duckduckgo.com
> and find out when the first GPT model was released. Answer with the year.

Both returned **2018** (GPT-1, June 2018) and the tool calls were visibly
attributed to the `vibebrowser` connector.

## What each product actually demands

### Claude (web)
- Form fields: **Name**, **Remote MCP server URL**. OAuth client id/secret are
  optional under "Advanced settings" — leaving them blank works, our endpoint
  authenticates by path segment.
- No OAuth requirement, no verified-domain requirement, no allowlist.
- After adding, the connector shows "You are not connected to <name> yet" with a
  **Connect** button. Clicking it performs `initialize` + `tools/list`. Only then
  does it count as connected.
- Tools default to **Needs approval**: the first call of each tool prompts
  Allow once / Always allow in the conversation.
- Per-conversation the connector must be toggled on under
  `+` -> Connectors. It is on by default after adding.

### ChatGPT (web)
- Custom MCP servers require **Developer mode** (Settings -> Security and login
  -> Developer mode, flagged ELEVATED RISK). Without it there is no create form.
- Then Plugins -> **Create app**: Name, Description, Connection = **Server URL**,
  Authentication = **No Auth** (default is OAuth and must be changed), plus a
  mandatory "I understand and want to continue" acknowledgement.
- Worked on a **Free** account. Some first-party connectors (Gmail, Drive) are
  paywalled, custom MCP was not.
- Connector then shows a "Add vibebrowser to ChatGPT" consent sheet with a
  **Connect** button; actions are listed after connecting.

## Consequences for us

- The bare-URL path is the only viable connector form for hosted assistants, so
  it must stay supported. A bad UUID still returns 401; `POST /mcp` with no
  credential still returns 401.
- Both products put the credential in a URL the user pastes into a vendor cloud.
  That is inherent to connector UIs. The mitigation is session regeneration
  (extension Settings), which revokes the old UUID immediately.
- Neither product required a listing, review, or partner program to add us —
  distribution via "paste this URL" works today. A directory listing (Claude
  connector directory, ChatGPT plugin directory) is a separate, additive effort.
