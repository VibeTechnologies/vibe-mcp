# Anthropic Connectors Directory — submission pack

> ⚠️ **HISTORICAL INTERNAL NOTE — NOT CURRENT USER GUIDANCE.**
> Point-in-time research from August 2026. It explores an OAuth 2.1 / DCR /
> consent-flow direction for the relay. That is **not** the supported path.
> The supported hosted-client path is the direct Streamable HTTP endpoint
> `https://relay.api.vibebrowser.app/mcp/<extension-uuid>` with the UUID as the
> sole credential — no OAuth, no DCR, no scopes. See `README.md` and
> `status.md` for current setup instructions. Kept for provenance only.

**Purpose:** every field of Anthropic's submission portal, pre-filled and
copy-paste ready, so the founder can complete the submission in under five
minutes.

**Status:** PREPARED, NOT SUBMITTED. No agent has logged into claude.ai or any
Anthropic property. Submission is a founder-only action (§9).

**Prepared:** 2026-08-11. Every requirement below was fetched from the current
official docs on that date, and every URL/claim was measured against production
the same day (§7). Nothing here is from memory.

**Read §8 before you paste anything.** One blocker remains: §8.1, the Claude
plan gate. The docs blocker (§8.2) was **resolved on 2026-08-11** — the public
connector docs now lead with OAuth and are verified live.

---

## 1. Sources — what Anthropic actually requires (fetched 2026-08-11)

| Doc | URL |
|---|---|
| Submitting to the Connectors Directory | <https://claude.com/docs/connectors/building/submission> |
| Pre-submission checklist / review criteria | <https://claude.com/docs/connectors/building/review-criteria> |
| Authentication for connectors | <https://claude.com/docs/connectors/building/authentication> |
| Connector verification (Verified / Community / Custom) | <https://claude.com/docs/connectors/verification> |
| Software Directory Terms | <https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms> |
| Software Directory Policy | <https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy> |

**Correction to prior worklogs.** Earlier notes in this repo speculated about
GitHub repos named `claude-plugins-official` / `claude-community`. That is not
how remote MCP connectors are submitted and those repo names appear nowhere in
the current docs. The real path is a **web portal inside Claude.ai admin
settings**:

> <https://claude.ai/admin-settings/directory/submissions/new>

There is no GitHub PR, no YAML manifest, and no repo to fork for a remote MCP
server. (A separate form, <https://clau.de/desktop-extention-submission>, covers
Desktop Extensions / MCPB — that is a *different* submission and is not what this
pack is for.)

### 1.1 The five stated submission requirements

Verbatim from [submission](https://claude.com/docs/connectors/building/submission):

| # | Requirement | Our status |
|---|---|---|
| 1 | **Security** — meet Anthropic's security standards | Met — OAuth 2.1, PKCE S256, tokens stored as SHA-256 hashes, no credential in URL on the canonical path |
| 2 | **Tool annotations** — all tools must include a `title` and the applicable `readOnlyHint`/`destructiveHint` | Met — 27/27, live on the hosted path (§5) |
| 3 | **Authentication** — use OAuth 2.0 for authenticated services | Met — `oauth_dcr`, "supported out of the box" |
| 4 | **Privacy Policy** | Met — <https://www.vibebrowser.app/privacy> (200) |
| 5 | **Documentation** — clear setup and usage instructions | Met — public docs lead with the canonical OAuth path as of 2026-08-11 (§8.2) |

---

## 2. Does the form require screenshots? — **No.**

Checked explicitly, because the task asked.

Carousel screenshots are required **only for MCP Apps** — MCP servers that
surface interactive UI elements via the MCP Apps extension:

> "**MCP Apps** — MCP servers that surface interactive UI elements. These have
> the additional requirement of including screenshots for submission and listing
> in the directory."
> — [submission › What you can submit](https://claude.com/docs/connectors/building/submission)

And in the asset spec the heading is literally **"Carousel screenshots (MCP
Apps)"**: PNG, ≥1000px wide, 3–5 images, crop to the app response, no prompt in
frame, no video/GIF.

**vibe-mcp is a plain remote MCP server, not an MCP App.** Verified in this repo:
no `ui/` capability, no `ui/open-link`, no MCP Apps resource templates are
declared anywhere in `src/`. Therefore:

- **Carousel screenshots: not required. Do not upload any.**
- **Allowed link URIs: not applicable** — that field only matters if the server
  calls `ui/open-link`, which we do not. Leave blank.

**One image asset *is* required: the listing icon.** See §4.9.

Because no screenshots are needed, there is no redaction risk from carousel
assets. The one image we do ship (the icon) was opened and inspected during
preparation: it is the product mark on a dark background, containing no UUID, no
token, no browser chrome, and no personal data.

---

## 3. The portal, step by step — every field it asks for

Eleven steps. Progress autosaves in the browser between steps.

| # | Step | Fields it asks for |
|---|---|---|
| 1 | Introduction | (read-only; no input) |
| 2 | Connection | server URL (must be `https://`); transport (streamable HTTP or SSE); same-URL-for-everyone vs per-user URL |
| 3 | Tools | auto-synced from the live server; flags any tool missing a title/annotation |
| 4 | Listing | server name (≤100 chars); tagline (≤55 chars); description (≤2,000 chars); 1–5 categories; documentation URL; privacy policy URL; support contact; icon; URL slug (**permanent once published**) |
| 5 | Use cases | primary use cases; what a user needs before connecting; reads data / writes data / both |
| 6 | Company | company name; company website; primary contact name + email |
| 7 | Authentication | auth mode (`oauth_dcr` / `oauth_cimd` / `oauth_anthropic_creds` / `custom_connection` / `none`); whether individual tools prompt for auth on demand |
| 8 | Data handling | is the underlying API your own / proxied with permission / third-party you don't control; personal health data? sponsored content? |
| 9 | Test & launch | test-account setup + access instructions (every link, credential, step); confirmation you ran every tool yourself |
| 10 | Compliance | 7 policy acknowledgments — all required |
| 11 | Review | final read-through; quality warnings shown; Submit |

---

## 4. Every field, pre-filled — copy-paste ready

### 4.1 Step 2 — Connection

| Field | Value to enter |
|---|---|
| Server URL | `https://relay.api.vibebrowser.app/mcp` |
| Transport | **Streamable HTTP** |
| Same URL for every user, or different URLs per user? | **Same URL for every user** |

> Use the bare canonical URL. **Do NOT paste a `/mcp/<uuid>` URL** — that legacy
> form embeds a live credential in the path, and Anthropic's auth doc says
> credentials in the connector URL are "not recommended" and that the MCP spec
> "explicitly prohibits access tokens in the URI query string". It would also
> publish the founder's own routing UUID to the world.

### 4.2 Step 3 — Tools

Nothing to type. The portal syncs `tools/list` from the connected server. Expect
**27 tools, grouped 11 read-only / 16 write, zero in the "no annotations"
bucket.** Full inventory in §5. If the portal shows an unannotated group, stop —
that means the relay regressed; do not submit.

### 4.3 Step 4 — Listing

**Server name** (≤100 chars — this is 25):

```
VibeBrowser Browser Control
```

**Tagline** (≤55 chars — this is 52):

```
Let Claude drive your real, logged-in Chrome browser
```

**Description** (≤2,000 chars — this is ~1,430):

```
VibeBrowser gives Claude control of the Chrome browser you already use — the
same profile, the same tabs, the same logged-in sessions.

Most browser automation launches a fresh, empty browser. That browser is signed
into nothing, so it cannot reach your dashboards, your admin panels, your
internal tools, or anything else behind a login. VibeBrowser takes the opposite
approach: it drives your actual browser through a Chrome extension you install,
so Claude sees the web exactly as you do.

With this connector enabled, Claude can:

• Navigate to pages, go through multi-step flows, and open or switch tabs
• Read a page as text, as HTML, or as an accessibility snapshot
• Click, hover, type, fill forms, drag, scroll, and press keyboard shortcuts
• Take screenshots of what is on screen
• Inspect console messages and network requests while debugging a site
• Wait for elements, URLs, or network idle before continuing
• Upload files to a page

Typical uses: pull a report out of a SaaS dashboard that has no API; check a
staging deployment and read the console errors; fill in a long form from data in
the conversation; walk a signup or checkout flow end to end; research across
sites where the useful pages sit behind a login.

Requirements: the free VibeBrowser Chrome extension, running in a Chromium
browser (Chrome, Brave, Edge, Arc) on your own machine, with external agent
control switched on. The connector authenticates with OAuth 2.1; during consent
you bind the grant to one specific browser session, and you can revoke it at any
time from Claude's connector settings or by regenerating the connection in the
extension.

Tools are annotated so Claude knows which are read-only and which change the
page: 11 of the 27 are read-only and can run without a confirmation prompt;
the 16 that act on the page are marked as writes.
```

**Categories** (pick 1–5 from whatever the portal offers; in preference order):

```
1. Developer Tools
2. Productivity
3. Research
4. Automation / Workflow
```

> The portal's category list is fixed and may not use these exact labels. Pick
> the closest available in this order; "Developer Tools" is the primary.

**Documentation URL:**

```
https://www.vibebrowser.app/integrations/claude-connector
```

> ✅ As of 2026-08-11 this page leads with the canonical OAuth flow
> (`https://relay.api.vibebrowser.app/mcp` + consent), with the legacy
> UUID-in-URL path demoted to a labelled section for headless clients. A
> reviewer following these docs reproduces the connector being submitted.
> See §8.2.

**Privacy policy URL:**

```
https://www.vibebrowser.app/privacy
```

**Support contact:**

```
support@vibebrowser.app
```

**Icon:** see §4.9.

**URL slug** (permanent — do not change later):

```
vibebrowser
```

### 4.4 Step 5 — Use cases

**Primary use cases:**

```
1. Read and operate web apps that have no API. Pull a number out of a SaaS
   dashboard, export a report, or check a status page that requires a login —
   Claude reads the rendered page in the user's own authenticated session.

2. Debug a running site. Open a staging or production URL, take an
   accessibility or HTML snapshot, and read console messages and network
   requests to explain why a page is broken.

3. Fill long or repetitive forms. Claude takes structured data from the
   conversation and enters it into a real form, then confirms the result by
   reading the page back.

4. Multi-step research behind logins. Walk through several pages of an internal
   wiki, an issue tracker, or a vendor portal and summarise what is there.

5. Walk a user flow end to end. Step through a signup, checkout, or onboarding
   sequence in the real browser to verify it works.
```

**What users need before they can connect:**

```
1. A Chromium-based desktop browser (Chrome, Brave, Edge, or Arc) on their own
   machine.
2. The free VibeBrowser Chrome extension installed in that browser.
3. In the extension: Settings -> enable "Enable external AI agent control", set
   the mode to Remote (internet). This produces a connection URL that identifies
   that browser session.
4. That browser must be open and the extension running while the connector is in
   use. The connector drives a real browser; if it is closed there is nothing on
   the other end.
5. No VibeBrowser account, subscription, or payment is required. The extension
   and the relay are free to use.
```

**Does the connector read data, write data, or both?**

```
Both.
```

> Be accurate here. 11 of the 27 tools are read-only; the other 16 act on the
> page (click, type, navigate, upload). Claiming read-only would be false and is
> the sort of thing that fails review.

### 4.5 Step 6 — Company

| Field | Value |
|---|---|
| Company name | `VIBE TECHNOLOGIES, LLC` |
| Company website | `https://www.vibebrowser.app` |
| Primary contact name | `Dzianis Vashchuk` |
| Primary contact email | `support@vibebrowser.app` |

> The portal pre-fills contact name/email from the signed-in account. Overwrite
> the email with `support@vibebrowser.app` so review correspondence lands in a
> monitored, shared inbox rather than a personal one. `mcp-review@anthropic.com`
> is Anthropic's escalation address if you need to chase.

Full legal-entity details, if any field asks for more (source: WA Secretary of
State Initial Report, filed 2025-11-10):

| Field | Value |
|---|---|
| Legal name | VIBE TECHNOLOGIES, LLC |
| Entity type | Limited Liability Company |
| Jurisdiction | State of Washington, United States |
| WA UBI number | 606 003 933 |
| Federal EIN | 41-2492929 |
| D-U-N-S number | 142059652 |
| Formation date | 2025-11-10 |
| Nature of business | Professional, Scientific & Technical Services |
| Principal office | 519 S Henderson St, Seattle, WA 98108-4522, United States |
| Governor / officer | Dzianis Vashchuk (Governor) |
| Registered agent | Dzianis Vashchuk, 519 S Henderson St, Seattle, WA 98108-4522 |
| Company email of record | vibeteaichnologies@gmail.com |

> The portal does not ask for UBI/EIN/D-U-N-S. They are listed only so you never
> have to go looking mid-form.

### 4.6 Step 7 — Authentication

| Field | Value |
|---|---|
| Authentication mode | **OAuth** → **with Dynamic Client Registration (DCR)** (`oauth_dcr`) |
| Do individual tools prompt for auth on demand? | **No** — the server returns `401` at connection time; all tools require a token |

`oauth_dcr` is listed as "**Supported out of the box**" — no email to Anthropic,
no coordination with the review team.

Everything Claude's auth doc requires, and where we satisfy it:

| Anthropic requirement | Our implementation | Verified |
|---|---|---|
| `401` + `WWW-Authenticate: Bearer resource_metadata="…"` (must be 401, not 200) | Yes, on `POST /mcp` | §7.2 |
| `scope` parameter in the `WWW-Authenticate` header controls requested scopes | `scope="browser:read browser:control"` | §7.2 |
| RFC 9728 protected resource metadata; `resource` must match the entered URL exactly | `resource` = `https://relay.api.vibebrowser.app/mcp` — exact match | §7.3 |
| `authorization_servers` lists the issuer, first entry used | `["https://relay.api.vibebrowser.app"]` — single entry | §7.3 |
| RFC 8414 authorization server metadata at `/.well-known/` | 200 | §7.3 |
| `registration_endpoint` present (DCR) | `https://relay.api.vibebrowser.app/oauth/register` | §7.4 |
| PKCE `S256` required, and must be advertised | `code_challenge_methods_supported: ["S256"]` | §7.3 |
| `offline_access` in AS `scopes_supported` so Claude can get a refresh token | Present | §7.3 |
| Redirect URI `https://claude.ai/api/mcp/auth_callback` accepted | Accepted at DCR — echoed back on a `201` | §7.4 |
| Token endpoint accepts `application/x-www-form-urlencoded` | Yes | proven by the live end-to-end connection |
| `/register` accepts `application/json` | Yes — `201` | §7.4 |
| Discovery/registration/token respond within 10s (30s for refresh) | All probes returned well inside 1s | §7 |
| Reachable from Anthropic egress `160.79.104.0/21` | Yes — public endpoint, no WAF, no IP allowlist | §7.2 |

**Scopes and what each grants** (paste if the portal asks you to describe them):

| Scope | Grants |
|---|---|
| `browser:read` | Read-only observation of the bound browser session: current URL and title, page text/HTML/accessibility snapshots, screenshots, tab list, console messages, network request metadata, and metadata (never plaintext) of saved credentials. Cannot change any page. |
| `browser:control` | Acting on the bound browser session: navigate, open/close/switch tabs, click, hover, type, fill forms, drag, scroll, press keys, resize, upload a file, and evaluate a script in the page. |
| `offline_access` | Issues a refresh token so the connection survives beyond the 1-hour access-token lifetime without re-prompting the user. Appended automatically by Claude. |

Claude requests `browser:read browser:control` because those are the scopes we
return in the `WWW-Authenticate` header, and appends `offline_access` because our
authorization-server metadata advertises it.

### 4.7 Step 8 — Data handling

| Field | Value |
|---|---|
| Is the underlying API your own, proxied from a partner, or a third party's? | **Our own first-party API.** The MCP server domain (`relay.api.vibebrowser.app`) and the extension are both operated by VIBE TECHNOLOGIES, LLC. |
| Does the connector handle personal health data? | **No** |
| Does it include sponsored content? | **No** |

> Nuance worth stating in a free-text box if one is offered: the tools operate on
> *whatever site the user directs them to*, so page content from third-party
> sites necessarily transits the relay. That is inherent to browser control and
> is disclosed in the privacy policy. It is not "proxying a third-party API" —
> we do not call anyone else's API on the user's behalf.

### 4.8 Step 9 — Test & launch

This is the step that needs the most care. Paste this:

```
This connector drives a real Chrome browser on the user's own machine through
the VibeBrowser Chrome extension. There is no server-side browser, so a reviewer
needs a Chromium browser of their own to exercise the tools. Setup takes about
three minutes and requires no account, no payment, and no credentials from us.

Reviewer setup:

1. In Chrome (or Brave / Edge / Arc), install the VibeBrowser extension from the
   Chrome Web Store:
   https://www.vibebrowser.app/install
   No sign-up, no account creation, no payment.

2. Click the VibeBrowser toolbar icon -> Settings.
   Turn ON "Enable external AI agent control".
   Set the mode to "Remote (internet)".
   Leave that browser window open for the rest of the test.

3. In Claude, add the connector at https://relay.api.vibebrowser.app/mcp and
   complete the OAuth consent flow. The consent page asks you to paste the
   connection URL shown in the extension settings from step 2 — that is what
   binds the grant to your browser. Copy it straight out of the extension; it is
   generated locally and is not shared with anyone.

4. Enable the connector in a conversation (+ button -> Connectors -> toggle on).

5. Verification prompt:

     "Using the VibeBrowser connector, go to duckduckgo.com and find out when
      the first GPT model was released."

   Expected: Claude calls tools such as List Pages, Navigate Page, and Fill;
   the reviewer's own browser visibly navigates; the answer is June 2018.

   This prompt is deliberate — the browser visibly moves, so a correct answer
   given without any tool call is easy to spot as a model-memory answer rather
   than a real one.

No test credentials are supplied because the connector holds no accounts and no
user data of its own. There is nothing to pre-populate: the "populated account"
is the reviewer's own browser session. Every tool operates on whatever page the
reviewer opens.

If a reviewer cannot install a browser extension, please contact
support@vibebrowser.app and we will arrange a live walkthrough.
```

**"Confirm you've run every tool yourself"** — tick it. All 27 tools are covered
by the hermetic E2E suite in this repo (`npm run test:ci`, including
`scripts/e2e-tool-annotations.mjs`), and the connector was exercised end to end
in Claude web on 2026-08-09: `List Pages`, `Navigate Page`, and `Fill` ran
against the canonical OAuth endpoint, transcript-labelled "Used vibebrowser oauth
integration", answering "June 2018".

### 4.9 Icon asset

| Field | Value |
|---|---|
| Path (in this repo, added by this PR) | `assets/directory-icon-512.png` |
| Absolute path | `/Users/engineer/workspace/vibebrowser/vibe-mcp/assets/directory-icon-512.png` |
| Source of truth | `VibeBrowserProductPage/public/icon-512.png` (served at <https://www.vibebrowser.app/icon-512.png>) |
| Format / size | PNG, 512×512, 226 KB |
| Contents | VibeBrowser aperture mark, light on dark. **No UUID, no token, no browser chrome, no personal data.** Opened and visually inspected during preparation. |

### 4.10 Step 10 — Compliance acknowledgments

Seven checkboxes, all required. Each is a factual statement about us — confirm,
don't skim:

| Topic | Our position |
|---|---|
| Directory guidelines | Reviewed; connector conforms |
| First-party API usage | Yes — relay and extension are both ours |
| Financial transactions | **We do not transfer money, cryptocurrency, or financial assets.** (The tools can operate a page the user navigates to, but the connector itself performs no transfer and exposes no payment tool.) |
| AI media generation | **We generate no images, video, or audio.** |
| Prompt injection | No tool description instructs Claude to call other tools, override system instructions, fetch behavioural instructions externally, or promote products. Descriptions state only what each tool does. |
| Conversation data collection | We collect no conversation data, and query no Claude memory, chat history, conversation summaries, or user files. The relay logs request metadata only (IP, Origin, User-Agent) for abuse control — disclosed in the privacy policy. |
| Public documentation | Public docs exist at `vibebrowser.app/mcp`, `/integrations`, `/integrations/claude-connector`, `/cli` — OAuth-first as of 2026-08-11 (§8.2 resolved). |

### 4.11 Fields we deliberately leave blank

| Field | Why |
|---|---|
| Allowed link URIs | We do not use `ui/open-link`. The doc marks it optional and only relevant to servers that do. |
| Carousel screenshots | MCP Apps only; we are not one (§2). |
| Anthropic-held client credentials (`oauth_anthropic_creds`) | Not needed — DCR is supported out of the box. See §8.4 for when we may want to switch. |

---

## 5. Tool inventory — all 27, with annotations

Source of truth: `src/tool-annotations.ts` (`EXTENSION_CORE_TOOL_NAMES`), enforced
in CI by `scripts/e2e-tool-annotations.mjs`. The identical set is served on the
hosted path by the relay (VibeTechnologies/platform#70), which is what Anthropic
will sync in portal step 3.

Anthropic requires only `title` plus the applicable `readOnlyHint` /
`destructiveHint`. We additionally emit `idempotentHint` and `openWorldHint`.

**Totals: 27 tools — 11 read-only, 16 write, of which 5 destructive.**

| # | Tool | Title | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|---|---|
| 1 | `click` | Click Element | false | false | true | true |
| 2 | `close_page` | Close Page | false | **true** | true | false |
| 3 | `drag` | Drag Element | false | **true** | false | false |
| 4 | `evaluate_script` | Evaluate Script | false | **true** | false | true |
| 5 | `fill` | Fill Field | false | false | true | false |
| 6 | `fill_form` | Fill Form | false | false | true | false |
| 7 | `get_network_request` | Get Network Request | **true** | false | true | false |
| 8 | `hover` | Hover Element | false | false | true | false |
| 9 | `list_console_messages` | List Console Messages | **true** | false | true | false |
| 10 | `list_network_requests` | List Network Requests | **true** | false | true | false |
| 11 | `list_pages` | List Pages | **true** | false | true | false |
| 12 | `navigate_page` | Navigate Page | false | false | false | true |
| 13 | `new_page` | Open New Page | false | false | false | true |
| 14 | `press_key` | Press Key | false | **true** | false | true |
| 15 | `resize_page` | Resize Page | false | false | true | false |
| 16 | `scroll_page` | Scroll Page | false | false | false | false |
| 17 | `secrets_manager` | Read Saved Credential Metadata | **true** | false | true | false |
| 18 | `switch_to_page` | Switch Page | false | false | true | false |
| 19 | `take_screenshot` | Take Screenshot | **true** | false | true | false |
| 20 | `take_snapshot` | Take Page Snapshot | **true** | false | true | false |
| 21 | `type_text` | Type Text | false | false | false | false |
| 22 | `upload_file` | Upload File | false | false | true | true |
| 23 | `wait_for` | Wait For Element | **true** | false | true | false |
| 24 | `wait_for_condition` | Wait For Condition | false | **true** | false | true |
| 25 | `wait_for_network_idle` | Wait For Network Idle | **true** | false | true | false |
| 26 | `wait_for_url` | Wait For URL | **true** | false | true | false |
| 27 | `web_fetch` | Fetch Web Page | **true** | false | true | true |

Two classifications look wrong at a glance and are deliberate — both were decided
by reading the implementation, not the name. Be ready to explain them if a
reviewer asks:

- **`wait_for_condition` is NOT read-only.** It evaluates a caller-supplied
  JavaScript expression via `new Function()` inside the page. That is arbitrary
  code execution, so it is a write and is marked destructive.
- **`secrets_manager` IS read-only.** Despite the name it supports only `list`
  and `read` of credential *metadata*. It never writes and never returns
  plaintext.

Also relevant to the review criteria:

- **Read and write are in separate tools.** There is no catch-all
  `api_request`-style tool with a method parameter. Longest tool name is
  `list_network_requests` (21 chars), well under the 64-char limit.
- **`web_fetch` accepts a caller-chosen URL**, so it is annotated
  `openWorldHint: true`. It is a purpose-built fetch against a URL, not a
  freeform API query tool, so the "reference the target API docs" rule does not
  apply.

---

## 6. Security disclosure — what this connector can actually reach

State this plainly. Understating it is the fastest way to fail a security review,
and everything here is already in the public privacy policy.

**What it can access.** The user's real, logged-in Chrome browser. Not a fresh
sandboxed browser — the same profile, cookies, and authenticated sessions the
user has open. Within the bound session, the connector can read any page the user
could read (including pages behind a login) and act on any page as the user.
`evaluate_script` and `wait_for_condition` can run arbitrary JavaScript in the
page. This is the product's entire point, and also its entire risk surface.

**What it requires.** The VibeBrowser Chrome extension, installed and running in
a Chromium browser on the user's own machine, with "Enable external AI agent
control" switched on and the mode set to Remote. With the extension closed or
that toggle off, the connector routes nowhere and every tool call fails. There is
no server-side browser.

**Scope of a grant.** OAuth consent binds the grant to **one specific browser
session**, identified by the connection URL the user pastes on the consent page.
A token cannot reach any other browser or any other user.

**What crosses our servers.** On this hosted path, tool calls and their results
traverse the VibeBrowser relay, because Claude runs in Anthropic's cloud and
cannot reach the user's machine directly. Page content therefore transits the
relay in transit. The relay additionally logs request metadata — IP address,
Origin, and User-Agent — for abuse control. Both facts are disclosed at
<https://www.vibebrowser.app/privacy>. Users who need page content never to leave
their machine should use the local stdio MCP server (`npx @vibebrowser/mcp`) with
a desktop client instead of this connector.

**Credential storage.** Access and refresh tokens are stored as **SHA-256
hashes**, never in plaintext (VibeTechnologies/platform#72–#74). Access tokens
live 1 hour, refresh tokens 30 days. On the canonical OAuth path no credential
appears in the URL.

**How a user revokes access — three independent ways, any one is sufficient:**

1. **In Claude** — Settings → Connectors → VibeBrowser → **Disconnect**. Drops
   Claude's stored tokens for the connector.
2. **On our side** — the authorization server exposes an RFC 7009 revocation
   endpoint at `https://relay.api.vibebrowser.app/oauth/revoke`.
3. **In the extension (the hard kill)** — turn off "Enable external AI agent
   control", or regenerate the connection. Regenerating invalidates the old
   session immediately, so every existing grant bound to it stops routing. This
   works even if the user has lost access to the Claude account, and is the
   recommended action on any suspected compromise.

**Prompt injection.** The connector reads untrusted third-party web pages, so
page content can contain injection attempts. We mitigate on our side by keeping
tool descriptions purely factual — no tool description instructs Claude to call
other tools, defer to external instructions, or override system behaviour — and
by annotating every page-modifying tool as a write so Claude prompts before it
acts. The residual risk of a hostile page influencing a model that is reading it
is inherent to browser automation and cannot be fully eliminated server-side.

---

## 7. Live verification — measured 2026-08-11, not asserted

Every status code below was observed. Nothing in this section is from memory or
from a previous worklog.

### 7.1 URLs

| URL | Status |
|---|---|
| `https://relay.api.vibebrowser.app/.well-known/oauth-protected-resource` | **200** |
| `https://relay.api.vibebrowser.app/.well-known/oauth-authorization-server` | **200** |
| `https://www.vibebrowser.app/privacy` | **200** |
| `https://www.vibebrowser.app/terms` | **200** |
| `https://www.vibebrowser.app/mcp` | **200** |
| `https://www.vibebrowser.app/integrations` | **200** |
| `https://www.vibebrowser.app/integrations/claude-connector` | **200** |
| `https://www.vibebrowser.app/integrations/chatgpt-connector` | **200** |
| `https://www.vibebrowser.app/cli` | **200** |
| `https://www.vibebrowser.app/` | **200** |

### 7.2 Unauthenticated MCP POST returns the exact handshake Claude needs

```
$ curl -si -X POST https://relay.api.vibebrowser.app/mcp \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

HTTP/2 401
www-authenticate: Bearer resource_metadata="https://relay.api.vibebrowser.app/.well-known/oauth-protected-resource", scope="browser:read browser:control"
access-control-allow-origin: *
content-type: application/json
```

`401` (not `200`), `resource_metadata` present, `scope` present. This is the
canonical shape from Anthropic's lazy-authentication doc.

### 7.3 Discovery documents

`/.well-known/oauth-protected-resource` (200):

```json
{
  "resource": "https://relay.api.vibebrowser.app/mcp",
  "authorization_servers": ["https://relay.api.vibebrowser.app"],
  "scopes_supported": ["browser:read", "browser:control"],
  "bearer_methods_supported": ["header"],
  "resource_documentation": "https://vibebrowser.app/mcp"
}
```

`/.well-known/oauth-authorization-server` (200):

```json
{
  "issuer": "https://relay.api.vibebrowser.app",
  "authorization_endpoint": "https://relay.api.vibebrowser.app/oauth/authorize",
  "token_endpoint": "https://relay.api.vibebrowser.app/oauth/token",
  "registration_endpoint": "https://relay.api.vibebrowser.app/oauth/register",
  "revocation_endpoint": "https://relay.api.vibebrowser.app/oauth/revoke",
  "scopes_supported": ["browser:read", "browser:control", "offline_access"],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "authorization_response_iss_parameter_supported": true,
  "service_documentation": "https://vibebrowser.app/mcp"
}
```

`resource` matches the URL entered in step 2 exactly. `authorization_servers` has
a single entry, so Claude's "first entry only" rule is moot. `S256` and
`offline_access` are both advertised.

### 7.4 Dynamic Client Registration accepts Claude's redirect URI

```
POST https://relay.api.vibebrowser.app/oauth/register   ->  201 Created
```

Response echoed back `redirect_uris: ["https://claude.ai/api/mcp/auth_callback"]`
and `token_endpoint_auth_method: "none"` (public client, as DCR requires). The
issued `client_id` is deliberately not reproduced here.

### 7.5 Tool annotations

`EXTENSION_CORE_TOOL_NAMES` = **27** tools. Every one has a `title` and all four
hints; `assertAnnotationCoverage` fails the build otherwise. Verified by running
the exported map (see §5 table) and by `npm run test:e2e:tool-annotations` in CI.

### 7.6 Not re-verified today, carried forward as previously measured

- Token/client persistence across a pod restart (VibeTechnologies/platform#72–#74)
  — proven by a prod probe across a real rollout with zero re-consent. Not
  re-run here, since forcing a rollout to test it is not free.
- The end-to-end Claude connection and the "June 2018" answer — performed
  2026-08-09 in the founder's browser (see `mcp-distribution-channels.md` §9.3).
  Cannot be re-run by an agent without logging into claude.ai.

---

## 8. Gaps — read this before submitting

Four items. One blocker remains (§8.1); §8.2 was resolved on 2026-08-11.

### 8.1 BLOCKER — the portal needs a Team or Enterprise Claude organization

> "Remote MCP server submissions happen inside Claude.ai, in the submission
> portal. The portal is part of your organization's admin settings, so you need:
> **A Team or Enterprise organization.** Admin settings aren't available on
> individual plans."
> — [submission › Before you start](https://claude.com/docs/connectors/building/submission)

Access is further restricted to organization **Owners / Primary owners** by
default (Enterprise can delegate via a custom role with the **Directory**
permission; Team cannot — it stays with Owners).

I could not check which plan the founder's Claude account is on, because I am not
authorized to log into claude.ai. **If the account is on Pro or Free,
<https://claude.ai/admin-settings/directory/submissions/new> will be inaccessible
and there is no workaround** — the seat must be upgraded to Team (or the
submission made from an existing Team/Enterprise org where the founder is Owner)
before any of §9 is possible.

Worth noting that the prior worklog flagged the same class of problem on the
OpenAI side: the ChatGPT "Create app" button silently no-ops on a Free plan. Both
directories now appear to gate submission behind a paid tier.

**Action:** confirm the plan first. If it is not Team/Enterprise, upgrading is
the prerequisite, not a nice-to-have.

### 8.2 ~~BLOCKER~~ RESOLVED 2026-08-11 — public docs now lead with OAuth

**Status: fixed and live in production.** Shipped in
[dzianisv/VibeBrowserProductPage#226](https://github.com/dzianisv/VibeBrowserProductPage/pull/226),
merged to `main`, deployed via GitHub Actions, and verified against the live
site. `/integrations/claude-connector`, `/integrations/chatgpt-connector`,
`/mcp` and `/integrations` now:

- lead with **OAuth (recommended)** and hand out the canonical, credential-free
  URL `https://relay.api.vibebrowser.app/mcp`;
- explain concretely what `browser:read` and `browser:control` each grant, and
  how to revoke a grant;
- keep the per-UUID URL as a clearly-labelled secondary section, *"Direct URL —
  for headless and automation clients"*, with its bearer-credential warning
  intact;
- contain **zero** remaining "no OAuth" claims.

Live verification (`curl` against `https://www.vibebrowser.app`, all `200`):

| Check | claude-connector | chatgpt-connector | /mcp | /integrations |
|---|---|---|---|---|
| canonical OAuth URL present | yes | yes | yes | yes |
| stale "no OAuth" claim | 0 | 0 | 0 | 0 |
| legacy per-UUID section + warning | yes | yes | yes | yes |
| `browser:control` scope documented | yes | yes | yes | yes |

A repo test (`lib/__tests__/connector-docs.test.ts`, wired into the `root-site`
CI job) now fails the build if a "no OAuth" claim is reintroduced, if the
canonical URL disappears from the numbered steps, or if a real routing UUID ever
lands in a page.

The §8.2 documentation blocker no longer gates submission. The original
description is kept below for the record.

---

**(historical)** The documentation URL we would submit,
`https://www.vibebrowser.app/integrations/claude-connector`, currently instructs
users to paste `https://relay.api.vibebrowser.app/mcp/<routing-uuid>` and states,
in several places, "no OAuth", "no domain verification", "the URL is the whole
configuration". `https://www.vibebrowser.app/mcp` likewise documents only the
UUID path — the string `oauth` (lowercase), `browser:read`, and `browser:control`
appear **zero** times on it.

That was accurate before the OAuth work landed. It is now wrong for the connector
being submitted, and it is wrong in a way a reviewer will notice immediately: the
listing says OAuth 2.1 + DCR, the linked docs say paste a credential in a URL.
Anthropic's checklist makes public documentation a hard requirement, and its auth
doc explicitly calls credentials-in-the-URL "not recommended".

**Action (repo: `VibeBrowserProductPage`, not this one):** update
`/integrations/claude-connector` and `/mcp` to document the canonical
`https://relay.api.vibebrowser.app/mcp` + OAuth consent flow as the primary path,
demoting the per-UUID URL to a clearly-labelled legacy/CLI section. This is a
content change, not an engineering one, but it must land before submission.

### 8.3 What a reviewer will actually experience — and whether functional testing is required

**Does Anthropic's process require working tools?** Answer, verbatim from the
current [review criteria](https://claude.com/docs/connectors/building/review-criteria):

> "When you submit a server, it is automatically scanned for policy compliance
> and, by default, listed in the directory as a **community connector**.
> Anthropic may then escalate listings flagged as highly useful to Claude users
> to verified review, which is higher touch and slower; **reviewers run a
> functional test of each tool.** This escalation is assessed automatically, and
> you do not need to take any action."

So the prior agent's conclusion **holds, and is confirmed against the current
docs**: the default path is an automated policy scan → Community listing. A
human running every tool happens only on escalation to Verified, which Anthropic
initiates and we cannot request.

**But do not over-read that.** Two caveats the prior analysis understated:

1. **Step 3 of the portal is a live functional dependency.** The portal syncs
   `tools/list` from the connected server. If our relay cannot serve `tools/list`
   at that moment, the draft cannot be populated and the submission cannot
   proceed — the same failure mode that blocked OpenAI's "Scan Tools". The
   founder must therefore have their own browser + extension connected and
   consented **while filling in the form**. This is the single most likely
   practical failure and §9 sequences around it.
2. **The functional-quality bar applies to every listing, Community included:**
   "Every server in the directory must meet the criteria on this page, whichever
   label it carries", and "every tool must return a successful response when
   called with valid parameters". A Community listing is not a lower standard, it
   is a lower amount of *checking*.

**What a reviewer actually experiences, honestly stated:** if escalated to
Verified, a reviewer with no VibeBrowser extension installed will find that every
tool call fails, because there is no browser on the other end. That is real, and
it is the structural weakness of this product in every directory. Our mitigation
is the §4.8 instructions, which walk a reviewer through installing the extension
themselves in about three minutes with no account and no payment. It is a genuine
setup burden, not a blocker — but if Anthropic escalates and the reviewer will not
install an extension, expect a rejection or a request for a live walkthrough. We
offer exactly that in §4.8.

We are **not** blocked from listing today: Community listing needs no reviewer
browser.

### 8.4 Non-blocking — DCR will accumulate clients at directory scale

Anthropic's guidance:

> "For servers expecting high traffic from the directory, prefer **CIMD or
> `oauth_anthropic_creds` over DCR**. DCR causes Claude to register a new client
> on every fresh connection, which can result in very large numbers of registered
> clients on your authorization server."

We are on DCR. It is supported out of the box and is fine to submit with. But a
directory listing changes the traffic profile: every new user's first connection
writes a client record. Now that clients persist (platform#72–#74), that store
grows monotonically.

Not a submission blocker. Post-listing follow-up: either advertise CIMD
(`client_id_metadata_document_supported: true` **plus** `"none"` in
`token_endpoint_auth_methods_supported` — we already have the second), or email
`mcp-review@anthropic.com` to move to `oauth_anthropic_creds`. Also worth adding
a TTL/eviction policy for unused registered clients.

### 8.5 Summary of what we still lack

| Gap | Severity | Owner | Repo |
|---|---|---|---|
| Claude account may not be Team/Enterprise | **Blocker** | Founder | n/a (billing) |
| Public docs still describe the legacy UUID path, not OAuth | **Blocker** | Founder / marketing | `VibeBrowserProductPage` |
| DCR client-store growth at directory scale | Low, post-listing | Eng | `platform` |
| No reviewer-usable browser if escalated to Verified | Accepted risk, mitigated by §4.8 | — | — |

Everything else Anthropic asks for exists and was measured today.

---

## 9. Founder: do exactly this

Under five minutes once §8.1 is cleared (§8.2 is already done). Do it first — the form will
not work otherwise.

**Before you open the portal:**

- **0a.** Confirm your Claude account is on **Team or Enterprise** and you are an
  Owner. If not, upgrade. (§8.1)
- **0b.** ✅ Done 2026-08-11 — `https://www.vibebrowser.app/integrations/claude-connector`
  documents the OAuth flow as the primary path, verified live. (§8.2)
- **0c.** Open Chrome with the VibeBrowser extension running, Settings →
  "Enable external AI agent control" **ON**, mode **Remote (internet)**. Leave it
  open for the whole form — portal step 3 syncs tools live from your session.
  (§8.3)
- **0d.** Have `assets/directory-icon-512.png` from this repo ready to upload.

**Then:**

1. Open <https://claude.ai/admin-settings/directory/submissions/new>
2. **Introduction** — read, click through.
3. **Connection** — URL: `https://relay.api.vibebrowser.app/mcp` · Transport:
   **Streamable HTTP** · **Same URL for every user**. Complete the OAuth consent
   if prompted (paste your extension connection URL on our consent page). → §4.1
4. **Tools** — confirm it shows **27 tools, 11 read-only / 16 write, none
   unannotated**. If any tool lands in an "unannotated" group, **stop and do not
   submit** — the relay has regressed. → §4.2
5. **Listing** — paste, in order: name, tagline, description, categories,
   documentation URL, privacy policy URL, support contact. Upload
   `assets/directory-icon-512.png`. Slug: `vibebrowser` (**permanent**). → §4.3
6. **Use cases** — paste the three blocks: primary use cases, prerequisites,
   and select **Both** for reads/writes. → §4.4
7. **Company** — `VIBE TECHNOLOGIES, LLC` · `https://www.vibebrowser.app` ·
   `Dzianis Vashchuk` · **overwrite the prefilled email with**
   `support@vibebrowser.app`. → §4.5
8. **Authentication** — **OAuth** → **Dynamic Client Registration (DCR)**.
   Tools-prompt-for-auth-on-demand: **No**. → §4.6
9. **Data handling** — **Our own first-party API** · health data **No** ·
   sponsored content **No**. → §4.7
10. **Test & launch** — paste the reviewer setup block, then tick "I have run
    every tool myself". → §4.8
11. **Compliance** — tick all seven. Read §4.10 first; each one is a factual
    claim about us.
12. **Review** — read the summary. Quality warnings shown here are forwarded to
    the review team, so fix any before proceeding.
13. Click **Submit**.

**After submitting:** track status and reviewer feedback at
<https://claude.ai/admin-settings/directory/submissions>. Escalations go to
`mcp-review@anthropic.com`. Expect a **Community** listing by default; Verified
is Anthropic's call and needs no action from us (§8.3).

**Leave nothing blank that this pack fills, and leave blank exactly what §4.11
says to.**
