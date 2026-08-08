# MCP distribution channels — where we can list vibe-mcp

Re-assessed **2026-08-07** against freshly fetched official docs. Supersedes the
version written earlier the same day, whose central premise is now wrong.

Everything below is marked **FACT** (fetched from a cited official URL, or
measured against our live endpoint today) or **ASSUMPTION** (inference, not
verified). Read the marks — several conclusions flip on them.

---

## 0. What changed, and why the old assessment is void

The previous revision concluded we were *structurally rejected* by both big
directories because we had "no hosted endpoint, only localhost". Two things
changed.

**Change 1 — we now have a public remote MCP endpoint.**
`https://relay.api.vibebrowser.app/mcp/<uuid>` is live, bare-URL (no custom
headers), and shipped in VibeTechnologies/platform#64. It is **connected and
verified today inside both Claude web and ChatGPT web** as a manually-added
custom connector: 27 tools discovered in Claude, and both products correctly
answered a live browser task (`2018`). Neither required domain verification, an
allowlist, or OAuth to add by hand.

**Change 2 — Anthropic's directory rules are not what the old doc said.**
This is the bigger correction, and it is not about us at all. The old doc
asserted the Connectors Directory mandates OAuth and rejects per-user URLs.
Reading the current docs, both claims are false:

- The submission portal's Connection step asks "whether every user connects to
  the same URL or **different users connect to different URLs**" — a per-user
  URL is an explicitly modelled shape, not a disqualifier.
  FACT — <https://claude.com/docs/connectors/building/submission>
- Supported auth includes `custom_connection` — "Custom URL or credentials
  supplied at connection time" — and `static_headers`, a fixed API key/bearer
  entered as a request header. OAuth is one of six modes, not the only one.
  FACT — <https://claude.com/docs/connectors/building/authentication>
- Submitted servers are "automatically scanned for policy compliance and, **by
  default, listed in the directory as a community connector**." Human review
  ("verified") is an *escalation* Anthropic initiates, not a gate you must pass
  to be listed. FACT — <https://claude.com/docs/connectors/building/review-criteria>

**So the honest scoreboard moved, but less than "we have a public URL now"
suggests.** Having the endpoint cleared exactly one of several gates. It did not
clear the two that actually bind us: **tool annotations** (we emit none) and
**a reviewer/user story that does not require our Chrome extension**. Do not
read this doc as "we're unblocked."

### Where the old doc was right, and stays right

- OpenAI still wants **one universal URL**. Our per-user UUID URL is a *template*
  URL, and template URLs are "only ... for trusted developers with whom we have
  an established relationship." FACT —
  <https://developers.openai.com/plugins/deploy/app-review#template-mcp-server-urls>
- A reviewer with credentials still cannot exercise a single tool if they have
  no browser for us to drive. This was the old doc's sharpest point and it
  survives intact. (§4 proposes the fix.)

---

## 1. Measured ground truth on our own endpoint

Run today against production, not from memory:

| Probe | Result | Consequence |
|---|---|---|
| `POST /mcp` with no credential | `401` | Correct; endpoint is not open |
| `401` carries `WWW-Authenticate:` | **No** | Blocks OAuth discovery. Claude requires the `401` + `WWW-Authenticate: Bearer resource_metadata=…` handshake, and explicitly does **not** honour the header on a `200`. FACT — [authentication](https://claude.com/docs/connectors/building/authentication) |
| `/.well-known/oauth-protected-resource` | `404` | No RFC 9728 metadata |
| `/.well-known/oauth-authorization-server` | `404` | No RFC 8414 metadata |
| `/.well-known/openai-apps-challenge` | `404` | OpenAI domain verification not yet possible |
| `tools/list` payload shape | `{name, description, inputSchema}` only | **No `title`, no `readOnlyHint`/`destructiveHint`/`openWorldHint`.** See `src/server.ts:284-288` |

That last row is the single most under-rated blocker. Both directories make
annotations a hard requirement:

- Anthropic: "Every tool must include a `title` and the applicable hint".
  FACT — [review-criteria](https://claude.com/docs/connectors/building/review-criteria)
- OpenAI: "Every tool has accurate `readOnlyHint`, `openWorldHint`, and
  `destructiveHint` values" appears in the final checklist, and mismatched hints
  are called out as a top rejection reason. FACT —
  [submission](https://developers.openai.com/plugins/deploy/submission)

We currently fail this on **every tool, in every directory**. It is also the
cheapest thing on this page to fix.

Anthropic additionally rejects catch-all tools: "A single tool that accepts both
safe ... and unsafe methods is rejected. Do not ship a catch-all `api_request`
tool." ASSUMPTION: our browser toolset is already action-specific
(`click`, `navigate`, `take_screenshot`) and does not trip this — worth a
deliberate audit before submitting, not assumed.

---

## 2. The channel table

`Qualify TODAY` means: could be submitted this week with no founder account and
no new auth code.

| Channel | Requirement (FACT unless noted) | Qualify TODAY | What's missing | Effort |
|---|---|---|---|---|
| **Official MCP Registry** | Namespace ownership only; no review. Supports `remotes` with **URL templating** — `https://host/mcp/{id}` + `variables` — the documented multi-tenant shape | **YES — already live**, `io.github.VibeTechnologies/vibe-mcp` v0.3.2, `status=active`, `isLatest=true` | `remotes` entry absent; we advertise stdio only | **S** — done in this PR |
| **GitHub MCP Registry / VS Code gallery** | `code.visualstudio.com/mcp` 302s to `github.com/mcp` (FACT, measured). ASSUMPTION: fed from the official registry | Likely yes, passively | Nothing to do beyond the registry entry | **S** (free rider) |
| **Anthropic MCPB desktop directory** | `.mcpb` bundle + privacy policy in README **and** `privacy_policies` in manifest. "Missing or incomplete privacy policies result in immediate rejection" | Nearly — bundle already built & validates | Privacy policy; separate form at <https://clau.de/desktop-extention-submission> (no Team org needed) | **S** |
| **Anthropic Plugin directory** | Public GitHub repo, `claude plugin validate` | Nearly — plugin built, validates `--strict` | Founder login to a submission portal | **S** + 1 founder click |
| **Anthropic Connectors Directory** | Remote HTTPS + tool `title`/hints + privacy policy + docs URL + icon + reviewer test account + 7 attestations. Per-user URLs supported. `custom_connection` auth needs an email to `mcp-review@anthropic.com`; `static_headers` is Beta | **NO** | (a) annotations, (b) **Team/Enterprise claude.ai org**, (c) reviewer-usable demo browser, (d) privacy policy | **M** |
| **OpenAI Plugins Directory** (ChatGPT + Codex) | **Universal URL**, domain verification via `/.well-known/openai-apps-challenge`, verified business identity, annotations, 5 positive + 3 negative test cases, reviewer creds working "without ... private-network access" | **NO** | Universal URL ⇒ needs OAuth (§4). Plus business verification + demo browser | **L** |
| Smithery | ASSUMPTION: GitHub sign-in + `smithery.yaml`; hosted-first model | No (login) | Founder login | S + login |
| Glama | ASSUMPTION: auto-crawls public GitHub; claim listing after | Passively likely | Claim needs login | S + login |
| mcp.so | Free tier requires Sign In; paid tier **$39** one-time (FACT, measured on `/submit`) | No | Login; paid path excluded by policy | S + login |
| PulseMCP | Returns `403` to non-browser clients (FACT, measured) | Unknown | Could not verify process | S |
| Cursor directory | `cursor.com/directory` returns **404** today (FACT, measured) | N/A | Directory appears moved or retired | — |

### The two hard blockers, stated plainly

1. **No tool annotations.** Fails Anthropic and OpenAI outright. Ours, cheap,
   entirely in our control. Nothing else should be attempted first.
2. **The reviewer has no browser for us to drive.** Our tools are inert without
   a Chrome running our extension. Both directories require a demo account a
   reviewer can exercise end-to-end, and OpenAI bans "private-network access".

**The fix for #2 that the old doc missed:** we host the demo browser. Stand up a
throwaway VM running Chrome + the Vibe extension, generate a UUID for it, and
hand that URL to reviewers as the test credential. The reviewer's tool calls
then drive *our* browser and return real screenshots and page content — no
install on their machine, no private network. ASSUMPTION (untested, but it
follows directly from how the relay routes by UUID): this converts a structural
disqualifier into a ~1-day ops task. It is the highest-leverage unverified idea
in this document and should be prototyped before either big submission.

### Comparable products

ASSUMPTION — not verified today: browser-control MCPs (Chrome DevTools MCP,
Playwright MCP, Browserbase) split into two camps. The local ones ship stdio and
do **not** appear in the hosted connector directories; the ones that do list
remotely (Browserbase-style) run the browser **in their own cloud**, which
sidesteps the reviewer problem entirely because there is nothing to install.
That is the same trick as the hosted-demo-browser proposal above. Worth an hour
of verification before we bet submission effort on it.

---

## 3. Credential-in-URL: the thing we should stop defending

Anthropic's auth doc: tokens in the connector URL "are **not recommended**. A
credential in a URL is a security vulnerability: URLs are routinely recorded in
server logs, proxies, and browsing history". The MCP spec prohibits access
tokens in the query string.
FACT — <https://claude.com/docs/connectors/building/authentication>

Narrow reading: that text names query parameters (`?token=`), and ours is a
**path segment**, so we are not literally in violation. That reading is not
worth much. It is the same credential-in-a-loggable-URL risk class, the UUID is
a bearer capability granting full control of a user's logged-in browser, and a
reviewer assessing "meets Anthropic's security standards" will judge the risk,
not the grammar. Treat the path-segment distinction as a technicality that buys
us time, not a defence.

Present mitigation is session regeneration in the extension, which revokes the
old UUID immediately. That is real but reactive.

---

## 4. The auth gap — minimum design, honest effort

**Goal:** one canonical URL any user can add, authenticating as themselves.

Two candidates:

**Option A — pairing flow, no OAuth.** User adds a generic URL, gets a code,
types it into the extension. Cheap (~1 day). **Rejected as the primary plan:**
it is a bespoke scheme, so Anthropic would classify it as `custom_connection`
(email `mcp-review@anthropic.com`, not out-of-the-box) and OpenAI has no slot
for it at all. It unlocks *neither* big directory. Low cost, near-zero reach.

**Option B — OAuth 2.1 + DCR on the relay, at one canonical `/mcp`.**
**Recommended.** Crucially, this is *not* as expensive as it sounds, because we
have no user database to build: the OAuth "login" step is simply the pairing
code from the extension. We are wrapping the Option A flow in the standard
envelope both directories already speak.

What it unlocks:
- Anthropic `oauth_dcr` — "Supported out of the box". No review-team email, no
  Beta feature, no `custom_connection` special-casing.
- OpenAI **Universal URL** — removes the single biggest OpenAI blocker.
- Deletes the §3 credential-in-URL problem entirely.

Concrete scope:
- `GET /.well-known/oauth-protected-resource` (RFC 9728), `resource` matching
  the MCP URL exactly as the user types it
- `GET /.well-known/oauth-authorization-server` (RFC 8414), advertising
  `code_challenge_methods_supported: ["S256"]`
- `POST /register` — DCR (RFC 7591), `application/json`
- `GET /authorize` — HTML page: "enter the pairing code from your Vibe
  extension"; binds the grant to that browser session
- `POST /token` — **`application/x-www-form-urlencoded`** (a documented footgun:
  JSON-only body parsers return `415`), PKCE S256, refresh-token rotation,
  RFC 6749 error codes (`invalid_grant`, not a custom code)
- `/mcp` returns `401` + `WWW-Authenticate: Bearer resource_metadata="…"`
- Extension: display a short-lived pairing code
- Redirect URI `https://claude.ai/api/mcp/auth_callback`; Claude Code also needs
  port-agnostic `http://localhost/callback` + `http://127.0.0.1/callback`
- Endpoints must answer within **10s** (30s for refresh)

All of the above is specified at
<https://claude.com/docs/connectors/building/authentication>.

**Effort: ~4 engineering days ±1** on the relay, plus ~0.5 day in the extension.
Not the "L / multi-week epic" the old doc implied — that estimate assumed we
also had to build user accounts, and we don't. Prefer **CIMD or Anthropic-held
credentials over DCR** if directory traffic materialises: DCR registers a new
client on every fresh connection (FACT, same doc).

Sequencing note: OAuth does **not** by itself make us listable. Annotations and
the demo-browser story are still required. OAuth is necessary, not sufficient.

---

## 5. Recommended order

1. **Add tool annotations** (`title` + `readOnlyHint`/`destructiveHint`/
   `openWorldHint`) to every tool. **← highest ROI single step.** Roughly a day,
   blocks literally every reviewed directory, and is pure upside regardless of
   which directory we pursue. Nothing else should jump this.
2. Publish a privacy policy URL and add it to README + MCPB `manifest.json`.
   Unblocks the MCPB directory, which needs no Team org.
3. Prototype the **hosted demo browser** (§2). Cheap, and it de-risks the one
   blocker we have no other answer to.
4. Submit **MCPB** + **Plugin** directories — 1 founder click each once 1–3 land.
5. Build **OAuth 2.1 + DCR** (§4, ~4 days).
6. Then, and only then, submit Anthropic Connectors, and OpenAI after business
   verification.

Do not start at step 5. Steps 1–3 are prerequisites for it paying off.

---

## 6. How to add us manually today (works right now, no listing needed)

Directory listings are discovery. Distribution already works.

- **Claude web** — Settings → Connectors → Add custom connector → paste
  `https://relay.api.vibebrowser.app/mcp/<uuid>`. Leave OAuth fields blank.
  Press **Connect**; tools default to "Needs approval".
- **ChatGPT web** — Settings → Security and login → **Developer mode** on, then
  Plugins → Create app → Connection = Server URL, Authentication = **No Auth**
  (default is OAuth and must be changed). Verified on a Free account.

`<uuid>` comes from the extension: Settings → external agent control → Remote
(internet) → Agent connection URL. It grants full control of that browser —
never log, screenshot, or paste it anywhere else.
