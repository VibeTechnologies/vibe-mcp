# Chrome DevTools Relay — System Design

> ⚠️ **Security:** A relay URL/UUID (`wss://relay.api.vibebrowser.app/<uuid>`) grants **live control of your browser session** (read tabs, screenshots, page content). Treat it like a password — never share it, paste it into a chat with untrusted parties, or commit it to a repo. Any example UUIDs are placeholders (`00000000-0000-0000-0000-000000000000`) and are not routable. The browser UUID must be paired with an access token; it is **not** a standalone credential.

## Problem

Cloud AI agents (OpenClaw tenants, coding assistants, automation pipelines) need to
control a user's **local Chrome browser** — the one with their cookies, bookmarks,
logged-in sessions, and extensions. Today this requires the agent and browser to
be on the same machine or network.

The user's browser is behind NAT, on a laptop, on a home network. The agent runs
in a cloud Kubernetes pod. There is no direct path.

## Solution

A **secure relay** that bridges the gap:

> Current `vibebrowser-mcp` behavior: relay+extension remains the primary backend.
> If `chrome-devtools-mcp` is available locally, the server also starts it in
> `--autoConnect` mode as a fallback inside the shared relay daemon (single
> instance for all local agents/CLIs). When extension is connected, extension
> tools remain authoritative. Fallback tools are exposed and used only when the
> extension is unavailable/disconnected.

```
┌──────────────────────────────────────────────────────────────────┐
│                         CLOUD                                    │
│                                                                  │
│  ┌─────────────────────┐        ┌──────────────────────────┐     │
│  │  OpenClaw Skill      │        │  Vibe Relay Backend       │     │
│  │  (or any REST caller)│──POST─▶│  relay.vibebrowser.com    │     │
│  │                      │◀─resp──│                          │     │
│  │  Authorization:      │        │  • authenticates bearer   │     │
│  │  Bearer <token>      │        │  • routes by browser_uuid │     │
│  └─────────────────────┘        │  • queues tool calls      │     │
│                                  │  • returns results        │     │
│                                  └────────────┬─────────────┘     │
│                                               │                   │
└───────────────────────────────────────────────│───────────────────┘
                                                │ WSS (outbound
                                                │  from user machine)
┌───────────────────────────────────────────────│───────────────────┐
│                        USER MACHINE           │                   │
│                                               ▼                   │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  Relay Client (local process)                              │   │
│  │  • connects outbound to wss://relay.vibebrowser.com        │   │
│  │  • registers browser_uuid                                  │   │
│  │  • receives tool calls from relay                          │   │
│  │  • executes them via chrome-devtools-mcp tools             │   │
│  │  • returns results through relay                           │   │
│  └──────────────────────────┬─────────────────────────────────┘   │
│                             │ CDP (localhost:9222)                 │
│                             ▼                                     │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  Chrome (user's browser)                                   │   │
│  │  --remote-debugging-port=9222                              │   │
│  │  User's cookies, sessions, extensions, bookmarks           │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Key properties

- **No inbound ports** on the user's machine. The relay client connects outbound.
- **Bearer token auth** on every cloud API call. The browser UUID alone is not a secret.
- **Full chrome-devtools-mcp toolset** — 27 tools: click, fill, navigate, screenshot,
  snapshot, network interception, performance tracing, Lighthouse, etc.
- **User stays in control** — they start/stop the relay client, they see their browser.
- **Works with any cloud caller** — OpenClaw skills, CI pipelines, REST scripts.

---

## Components

### 1. Relay Client (this repo, forked from chrome-devtools-mcp)

A local CLI process the user runs. Based on a fork of
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
(Apache 2.0, by Google/ChromeDevTools team).

**What chrome-devtools-mcp already provides:**

- 27 browser automation tools (input, navigation, emulation, performance,
  network, console, debugging, Lighthouse)
- Puppeteer-based Chrome control via CDP
- Connection to running Chrome via `--browser-url` or `--autoConnect`
- WebSocket endpoint connection with custom headers
- Slim mode (3 tools) for basic tasks
- Requires Node.js v20.19+, Chrome stable+

**What we add:**

- Outbound WebSocket connection to cloud relay
- Tool call receive/execute/respond loop
- Auth handshake (browser_uuid + access_token)
- Reconnection with backoff
- Local config persistence (~/.vibe-relay/)

**CLI interface:**

```bash
# First time: authenticate
vibe-relay login --token <access_token>

# Connect to relay (browser must be running with --remote-debugging-port)
vibe-relay connect

# Or with explicit browser URL
vibe-relay connect --browser-url http://localhost:9222

# Check status
vibe-relay status
```

### 2. Vibe Relay Backend (cloud service)

Stateless relay that authenticates callers and routes tool calls to connected
browser sessions.

**API endpoints:**

```
GET  /v1/browser-sessions/:uuid/status
     → { connected: bool, tools: string[], connectedAt: ISO8601 }

GET  /v1/browser-sessions/:uuid/tools
     → { tools: [ { name, description, inputSchema } ] }

POST /v1/browser-sessions/:uuid/tools/:toolName
     → { result: ... }
     Body: { arguments: { ... } }

All require: Authorization: Bearer <token>
```

**Responsibilities:**

- Validate bearer tokens (scope: user, session, optional tenant/workspace)
- Maintain WebSocket connections to relay clients
- Queue tool call requests, match to responses
- Timeout handling (30s default, configurable)
- Rate limiting per token

**Not responsible for:**

- Executing any browser commands (that's the relay client)
- Storing browser state or screenshots
- Managing Chrome processes

### 3. OpenClaw Integration (skill + config)

OpenClaw does not speak MCP. It uses skills that call CLI tools or REST APIs.

**Skill definition:**

```yaml
name: vibe-browser
description: Control the user's local Chrome browser through Vibe relay
tools:
  - navigate_page
  - take_snapshot
  - take_screenshot
  - click
  - fill
  - press_key
  - evaluate_script
  - list_network_requests
  - get_network_request
  - lighthouse_audit
  # ... all 27 chrome-devtools-mcp tools
```

Each tool in the skill calls the relay REST API:

```bash
curl -X POST \
  -H "Authorization: Bearer $VIBE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  "https://relay.vibebrowser.com/v1/browser-sessions/$BROWSER_UUID/tools/navigate_page" \
  -d '{"arguments": {"url": "https://example.com", "type": "url"}}'
```

---

## Security Model

### Identifiers vs Secrets

| Value          | Purpose                        | Secret? | Rotatable? |
|----------------|--------------------------------|---------|------------|
| browser_uuid   | Identifies which browser       | No      | Yes        |
| access_token   | Proves caller is authorized    | Yes     | Yes        |

### Token Scoping

Access tokens are scoped to:

- **User** — which user owns this token
- **Session** (optional) — which browser session(s) it can access
- **Tenant/Workspace** (optional) — for multi-tenant scenarios
- **Expiration** — TTL, default 24h
- **Permissions** (future) — which tools are allowed

### Auth Flow

```
1. User generates access_token via Vibe dashboard or CLI
2. User starts relay client with token (stored in ~/.vibe-relay/config.json)
3. Relay client connects to cloud relay, sends { browser_uuid, access_token }
4. Cloud relay validates token, registers session
5. Cloud caller (OpenClaw) sends tool call with Authorization: Bearer <token>
6. Cloud relay validates caller's token, checks session access, forwards to client
7. Client executes tool locally, returns result through relay
```

### Threat Model

| Threat                           | Mitigation                                     |
|----------------------------------|-------------------------------------------------|
| Stolen browser_uuid              | UUID alone grants nothing; need valid token      |
| Stolen access_token              | Scoped + expiring; revocable via dashboard       |
| MITM on relay connection         | WSS (TLS) for client↔relay; HTTPS for API calls |
| Relay client compromise          | Runs as user process; same trust as the browser  |
| Cloud relay compromise           | No browser access stored; just routing + auth    |
| Unauthorized tool execution      | Token scope + optional tool allowlists           |

---

## Why Not Other Approaches

### Why not HTTP MCP bridge on vibebrowser-mcp?

We explored adding `--transport http` to vibebrowser-mcp to expose a URL-addressable MCP
endpoint. This doesn't work for OpenClaw because:

1. **OpenClaw doesn't speak MCP** — it calls CLI tools and REST APIs from skills.
2. **MCP HTTP still requires a reachable endpoint** — the user's machine is behind
   NAT, so a localhost MCP server isn't reachable from cloud.
3. **It solves the wrong problem** — the issue isn't MCP vs HTTP, it's
   cloud-to-local connectivity.

### Why not CDP shim over Vibe browser extension?

The Vibe browser extension (`chrome.debugger` API) only exposes a restricted
subset of CDP domains:

- **Missing:** `Browser.*`, `SystemInfo.*`, `Security.*`, `ServiceWorker.*`,
  `HeapProfiler`, `Memory`, `LayerTree`, `Media`
- **Conflict:** Opening Chrome DevTools terminates the extension's debugger session
- **Limited:** No `Browser.getWindowForTarget`, no full network interception

The chrome-devtools-mcp approach via Puppeteer/CDP gives full access to all
Chrome DevTools Protocol domains.

### Why not tunnel/ngrok?

- Requires the user to install and configure a separate tunneling tool
- Exposes a raw CDP endpoint to the internet (massive attack surface)
- No built-in auth, rate limiting, or tool-level access control
- CDP is designed for localhost trust, not internet exposure

### Why fork chrome-devtools-mcp instead of building from scratch?

- **27 production-tested tools** with proper error handling and edge cases
- **Apache 2.0 license** — fork-friendly, no copyleft concerns
- **Active maintenance** by Google/ChromeDevTools team
- **Puppeteer integration** — handles Chrome lifecycle, reconnection, tab management
- We only need to add the relay transport layer; the tool implementations stay as-is

---

## Data Flow: Tool Execution

```
OpenClaw skill                    Cloud Relay                     Relay Client              Chrome
     │                                │                               │                      │
     │  POST /tools/take_snapshot     │                               │                      │
     │  Authorization: Bearer xxx     │                               │                      │
     │ ──────────────────────────────▶│                               │                      │
     │                                │  validate token               │                      │
     │                                │  lookup browser session       │                      │
     │                                │                               │                      │
     │                                │  WS: { call: take_snapshot }  │                      │
     │                                │ ─────────────────────────────▶│                      │
     │                                │                               │  CDP: getDocument    │
     │                                │                               │ ────────────────────▶│
     │                                │                               │                      │
     │                                │                               │  CDP: a11y snapshot  │
     │                                │                               │◀────────────────────│
     │                                │                               │                      │
     │                                │  WS: { result: snapshot }     │                      │
     │                                │◀─────────────────────────────│                      │
     │                                │                               │                      │
     │  200 { result: snapshot }      │                               │                      │
     │◀──────────────────────────────│                               │                      │
     │                                │                               │                      │
```

---

## Implementation Plan

### Phase 1: Relay Client (fork + relay layer)

1. Fork `chrome-devtools-mcp` → `vibe-relay-client`
2. Add WebSocket client that connects outbound to relay backend
3. Implement tool call receive → execute → respond loop
4. Add `login`, `connect`, `status` CLI commands
5. Add config persistence (~/.vibe-relay/)
6. Test locally with a mock relay server

### Phase 2: Relay Backend (cloud service)

1. Minimal relay server (Node.js/Bun, deployable to Fly.io or AKS)
2. WebSocket handler for relay client connections
3. REST API for tool calls with bearer auth
4. Token validation + session management
5. Timeout + error handling
6. Deploy behind `relay.vibebrowser.com`

### Phase 3: OpenClaw Skill

1. Write skill that wraps relay REST API calls
2. Include setup instructions (install relay client, get token, connect)
3. Test with real OpenClaw tenant
4. Ship in OpenClawBot repo or as standalone installable skill

### Phase 4: Polish

1. Dashboard UI for token management
2. Session monitoring (connected browsers, active tools)
3. Tool-level permissions
4. Usage analytics
5. Documentation site / blog post

---

## Open Questions

1. **Relay backend hosting** — Fly.io (simple, edge-deployed) vs AKS sidecar
   (co-located with OpenClaw tenants, lower latency)?
2. **Binary vs screenshot transport** — should screenshots go through the relay
   as base64, or should the relay client upload to object storage and return a URL?
3. **Multi-tab support** — should one relay client session expose all Chrome tabs,
   or should users explicitly attach to specific tabs?
4. **Extension integration** — should the Vibe browser extension be able to act
   as a relay client directly (no separate process)?

---

## References

- [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) — base for relay client
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) — CDP spec
- [Puppeteer](https://pptr.dev/) — Chrome automation library used by chrome-devtools-mcp
- [OpenClaw Skills](https://github.com/openclaw/openclaw) — skill system documentation
- [Vibe Browser Extension](https://github.com/AnomalyCo/AnomalyBrowser) — existing Vibe browser tools
