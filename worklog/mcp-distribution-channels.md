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

---

## 7. Update — 2026-08-08: what moved, and one correction

Three things changed since §0–§6 were written, and one claim in them is now
wrong. Read this section before acting on anything above.

### 7.1 The OAuth gap in §4 is closed (shipped)

§4 estimated ~4 engineering days for OAuth 2.1 + DCR. It landed in
platform#67/#68. Measured against production today — all FACT:

| Probe | Result |
|---|---|
| `POST /mcp` unauthenticated | `401` |
| `WWW-Authenticate` on that `401` | `Bearer resource_metadata="https://relay.api.vibebrowser.app/.well-known/oauth-protected-resource", scope="browser:read browser:control"` |
| `/.well-known/oauth-protected-resource` | `200` |
| `/.well-known/oauth-authorization-server` | `200` |

So we now have a **universal URL**: `https://relay.api.vibebrowser.app/mcp`.
That removes the template-URL disqualifier §2 flagged for OpenAI, and the
`custom_connection` special-casing §2 flagged for Anthropic. Treat §4 as a
record of the design, not as outstanding work.

### 7.2 Domain verification is now possible (shipped)

`/.well-known/openai-apps-challenge` returned `404` in §1's probe table. It is
now implemented and live (platform#69). Details, and the full business-
verification pack, are in `openai-verification-pack.md`. Summary of the
requirement, since §2 left it vague: it is a **`.well-known` HTTPS file only —
there is no DNS TXT record**, and the file must return the bare token as
`text/plain` with no JSON envelope.
FACT — <https://developers.openai.com/plugins/deploy/submission#domain-verification>

### 7.3 Correction: annotations are NOT done on the path that matters

vibe-mcp#125 added a full annotation table (`src/tool-annotations.ts`) and the
follow-up commit recorded the blocker as closed. **On the hosted endpoint it is
not.** FACT, read from source today:

- The relay does not own a tool list. `handleMcpToolsList` proxies whatever the
  connected extension reports — `session.tools`, else a `list_tools` round-trip.
  `platform/subscriptions/relay-service/server.js`
- The extension's tool shape is `McpServerToolDefinition { name, description,
  inputSchema }` — **no `title`, no annotations**.
  `vibe/lib/mcp/server/types.ts:97`
- `grep -c 'readOnlyHint|destructiveHint|annotations'` over the relay source and
  over `vibe/lib/mcp/` both return **0**.

`tool-annotations.ts` is applied by the **npm stdio package**. Both directories
scan the **remote** endpoint, which is fed by the extension. So the endpoint
OpenAI and Anthropic actually inspect still advertises zero annotations, and
hard-fails both:

- Anthropic: "Every tool must include a `title` and the applicable hint."
- OpenAI: "Every tool has accurate `readOnlyHint`, `openWorldHint`, and
  `destructiveHint` values."

**Cheapest fix: enrich in the relay, not the extension.** The relay already
mediates `tools/list`; it can join the extension's tool names against the same
classification table and emit `title` + hints. That is a relay deploy (minutes)
versus an extension change that must clear Chrome Web Store review (days, and
users must update). Do this before anything in §8.

---

## 8. Hosted demo browser for reviewers — assessment and recommendation

The question: reviewers install nothing, so our tools have no browser to drive.
Do we have to host one?

### 8.1 Does each directory actually require working tools?

**Anthropic — NO, not to get listed.** FACT
(<https://claude.com/docs/connectors/building/review-criteria>):

> When you submit a server, it is automatically scanned for policy compliance
> and, **by default, listed in the directory as a community connector**.
> Anthropic may then escalate listings flagged as highly useful ... to verified
> review, which is higher touch and slower; **reviewers run a functional test of
> each tool**. This escalation is assessed automatically, and you do not need to
> take any action.

A human functional test happens only on an escalation we cannot request and do
not control. "Test credentials ... must be a fully populated account" is a
stated submission field, and "every tool must return a successful response when
called with valid parameters" is a stated criterion — but the default path to a
community listing is an automated policy scan, not a tool-by-tool exercise.

**OpenAI — YES, hard, in three independent places.** FACT
(<https://developers.openai.com/plugins/deploy/submission>):

1. **`Scan Tools` cannot populate the draft.** Our relay answers `tools/list`
   with JSON-RPC error `-32002` when no extension is connected. The portal
   imports tool metadata by scanning the live endpoint, so with no browser
   attached the submission cannot even be *built*, let alone reviewed.
2. **Five positive and three negative test cases**, which reviewers run.
3. Credentials must work "without MFA, email confirmation, SMS confirmation, or
   **private-network access**", and the single most-cited rejection reason is
   *"We're unable to connect to your MCP server using the MCP URL and/or test
   credentials we were given."*

Docs and a video do **not** substitute for either directory. Neither offers a
documentation-only route.

**Consequence:** a demo browser is required for OpenAI only. Building one to
reach Anthropic's directory would be unjustified.

### 8.2 Cheapest viable design (if we proceed for OpenAI)

Our architecture already solves the hard part. The extension dials **outbound**
to the relay; nothing needs an inbound port. So the demo browser can live
anywhere with egress and does not need to be a hosted service at all.

**Ephemeral CI session, on demand:**

- Reuse `vibe/tests/cua/` — it already runs Xvfb + real Chrome with the
  extension loaded, and four CUA workflows depend on it today. This is existing,
  working, exercised code, not a new system.
- Add a `workflow_dispatch` job that starts Chrome + extension, registers a
  **pre-provisioned review session UUID**, and idles for the job's lifetime.
- A GitHub-hosted job caps at 6 hours, which gives the time box for free — the
  session cannot outlive the window even if we forget to tear it down.
- Trigger it for an announced review window; revoke the session afterwards by
  regenerating it (the relay already supports revocation, per §3).

**Capacity, if we instead used the existing cluster** (measured today):
3 nodes × 2 vCPU; memory at 35% / 51% / 72%, so roughly 2.5 GB free on the
least-loaded node. Chrome plus the extension needs ~1–1.5 GB and bursts CPU.
One concurrent session would fit. **We should still not do it — see 8.4.**

### 8.3 Cost — honest number

No new paid services and no new cloud spend under either option.

| Option | Cash | Real cost |
|---|---|---|
| Ephemeral CI session | $0 new | GitHub Actions minutes. `VibeWebAgent` is **private**, so minutes are metered: ~360 per 6-hour window at the 1× Linux rate. A realistic review needs several windows — call it **1,000–2,000 minutes**, drawn from the existing plan allowance. |
| Existing k8s cluster | $0 new | No minutes, spare capacity exists — but see 8.4. |

So: it can be done with **no new spend**, but "free" overstates it for the CI
option — it consumes an existing metered budget. If that allowance is exhausted,
overage is billed per-minute; that is the only path to real money here.

### 8.4 Security — the part that decides this

An agent-drivable browser is a serious abuse surface. Enumerated:

| # | Risk | Why it is real here |
|---|---|---|
| 1 | **SSRF into our own infrastructure** | Our toolset includes `evaluate_script` (arbitrary JS) and `web_fetch` (arbitrary URL). A browser inside our cluster can reach the cloud metadata endpoint (`169.254.169.254`) and cluster-internal services, escalating toward node credentials — in a cluster that holds `vibe-secrets`, LiteLLM, and the Stripe service. **This is the dominant risk and it is created purely by the "keep it free, put it on the existing cluster" choice.** |
| 2 | Open proxy / anonymising egress | Anyone holding the token browses arbitrary sites from our IP: illegal content, abuse, fraud. Our IP and cloud account carry the consequences. |
| 3 | Credential harvesting | Anthropic asks for a "fully populated account". Any real logged-in session in the demo profile is readable via `get_page_content` / `take_screenshot` by whoever holds the token. |
| 4 | Token leakage | The session id is a bearer capability in a URL (§3). Review URLs get pasted into portals, tickets and screenshots. |
| 5 | Noisy neighbour | Chrome on a 2-vCPU node beside the production relay can degrade the live product. |

Required mitigations, all of them, not a subset:

- Run **off** the production cluster; never in a namespace that can see
  `vibe-secrets`.
- **Egress allowlist** to the handful of benign domains the test cases need.
  This is the single highest-value control: an allowlisted browser is not an
  open proxy, which collapses risks 1 and 2.
- Block link-local and RFC1918 (`169.254/16`, `10/8`, `172.16/12`, `192.168/16`).
- **No real credentials** in the demo profile — use a throwaway account on a
  property we control.
- Live only during an announced review window; revoke the session afterwards.
- Hard wall-clock cap and per-session rate limiting.

### 8.5 Recommendation

**Do not build a general hosted browser. Recommend AGAINST the persistent,
open, cluster-hosted version outright.** It is free in cash and expensive in
risk: a tool that executes arbitrary JavaScript, running inside the cluster that
holds our production secrets, is a plausible metadata-service SSRF path to those
secrets. No directory listing justifies that.

**Do not build anything for Anthropic.** Community listing is automatic (8.1);
the functional test only happens on an escalation we cannot request. There is no
demo-browser-shaped blocker there to solve.

**For OpenAI only, build the narrow version**: an ephemeral, allowlisted,
credential-free CI session (8.2), live only during a review window. Scoped that
way it is not a hosted browser product — it is a test fixture that happens to be
reachable, and the abuse surface is small enough to accept.

**Sequence it last.** §7.3 is the binding constraint: the hosted endpoint
advertises no annotations, and both directories reject on that alone. A demo
browser built today would let a reviewer connect to a server that still fails
the checklist. Fix annotations in the relay first (hours), then reconsider the
demo session. Do not open an OpenAI submission before both are done — only one
version may be in review at a time, and the queue has no published SLA, so a
predictable rejection is expensive.

### 8.6 Revised order (supersedes §5)

1. **Emit `title` + annotations from the relay's `tools/list`** (§7.3). Hours,
   not days; unblocks every reviewed directory.
2. Publish the privacy policy in the MCPB manifest + README, then submit
   **MCPB** and **Plugin** directories — neither needs a demo browser.
3. Submit **Anthropic Connectors**. Community listing is automatic; no demo
   browser required.
4. Complete OpenAI **business verification** and paste the domain token
   (`openai-verification-pack.md` §4) — the endpoint is already live.
5. Only then, build the narrow ephemeral demo session (8.2/8.4) and submit to
   **OpenAI**.

Steps 1–4 need no new infrastructure and carry no security risk. Step 5 is the
only one that does, and it is last for that reason.

---

## 9. Update — 2026-08-09: the OAuth connector is finished and verified in Claude

§7.1 shipped the OAuth 2.1 + DCR endpoints. It did **not** finish the client-side
flow — a prior run reached our consent page and stopped. That is now done, in the
founder's real logged-in Chrome. Everything in this section is FACT, measured
today, not inferred.

### 9.1 Per-product status

| Product | Connector | URL | Status |
|---|---|---|---|
| **Claude web** | `vibebrowser oauth` | `https://relay.api.vibebrowser.app/mcp` (canonical) | **Connected + functionally verified** |
| **Claude web** | `vibebrowser` (legacy) | `https://relay.api.vibebrowser.app/mcp/<uuid>` | **Still connected + still works** |
| **ChatGPT web** | `vibebrowser` (legacy, dev-mode app) | legacy per-uuid URL | Installed, untouched |
| **ChatGPT web** | canonical OAuth URL | `https://relay.api.vibebrowser.app/mcp` | **Blocked** — see 9.4 |

### 9.2 What the Claude flow actually required

The OAuth handshake itself was clean: `401` → RFC 9728 discovery → DCR → our
consent page with PKCE S256, `resource` pinned to the canonical MCP URL. The
consent page then asks for the extension's connection URL
(`wss://relay.api.vibebrowser.app/<uuid>`), which binds the grant to that
browser session, and redirects to `https://claude.ai/api/mcp/auth_callback`.

Claude's connector detail page now shows **Disconnect** (i.e. connected) against
`https://relay.api.vibebrowser.app/mcp`, and lists **27 tools split 11
read-only / 16 write**, each with a human `title` ("Take Screenshot", "Navigate
Page", …). That is the relay-side annotation work from §7.3 / platform#70 showing
up on the OAuth path too — the gap §7.3 flagged is closed on the hosted endpoint.

### 9.3 Functional verification — not just "Connected"

With the legacy `vibebrowser` connector **disabled** in Claude's connector picker,
so the request could only be served by the new OAuth connector, this prompt was
run:

> Using the vibebrowser connector, go to duckduckgo.com and find out when the
> first GPT model was released.

Claude called `List Pages`, `Navigate Page` and `Fill`, each labelled in the
transcript as **"Used vibebrowser oauth integration"**, and answered:

> **June 2018.** OpenAI's first GPT model — GPT-1 — was introduced in the paper
> "Improving Language Understanding by Generative Pre-Training" … Wikipedia's
> infobox lists the initial release as June 2018 … GPT-2 followed in February
> 2019 with 1.5B parameters.

So the tool calls demonstrably routed through the canonical OAuth endpoint into
the founder's real browser. The legacy connector was re-enabled afterwards.

One incidental defect surfaced by the run, worth a follow-up issue: Claude
targeted an existing `about:blank` tab and `navigate_page` rejected it as a
restricted page. It recovered by opening a new tab, but `navigate_page` should
fall back to `new_page` when the current target is a system page.

**Legacy connector re-verified independently** at the protocol level: a real
`tools/call` (`list_pages`) against `https://relay.api.vibebrowser.app/mcp/<uuid>`
returned `200` with live page data, and `tools/list` returns 27 tools, all
titled and annotated. The legacy connector carries no stored credential — it is
a bare URL — so "the URL works" is the whole of its health. **Recommendation:
keep it for now.** The new connector supersedes it functionally, but the legacy
per-uuid URL is what `vibe-mcp`'s own docs, the npm package and the MCPB bundle
still hand to users, and it is the only path that works without an interactive
consent step (so it stays the right answer for headless/CLI callers). Retire it
only when those surfaces have been migrated — not before.

### 9.4 ChatGPT — exact blocker

The dev-mode entry point exists and works: **Settings → Plugins → Create app**
(Developer mode was already on) opens a *New Plugin* dialog. Pasting the
canonical URL, ChatGPT **successfully auto-discovered our OAuth metadata** and
pre-filled, with no manual entry:

- Registration method: **Dynamic Client Registration (DCR)** (selectable, and
  the only sensible option — CIMD was correctly reported unavailable because we
  do not advertise it)
- Auth URL, Token URL, Registration URL, Authorization server base, Resource —
  all resolved to our endpoints
- Default scopes: `browser:read`, `browser:control`, both pre-ticked

So the *server side is fully acceptable to ChatGPT*. The blocker is on their
side: **clicking `Create` does nothing.** No navigation, no error, no toast, no
network request. Confirmed not a UI-automation artefact —

- the button reports `disabled: false` and a trusted CDP click lands on it;
- clearing the URL and clicking `Create` **does** raise client-side validation
  ("required", "Enter a valid MCP Server URL…"), which proves the click handler
  runs and the form is wired up;
- with valid input, the same click silently no-ops;
- it also no-ops with Authentication set to **No Auth**, so this is **not
  OAuth-specific** — this account cannot create *any* new custom plugin.

The account is on the **Free** plan (`Den Washington · Free · Upgrade` in the
sidebar). Custom-connector *creation* being a paid-plan capability is the only
hypothesis consistent with every observation, and it explains why §6's note
("verified on a Free account") no longer reproduces — the pre-existing
`vibebrowser` app predates whatever gate now applies. ASSUMPTION, not proven:
OpenAI surfaces no message at all, so this is inference from behaviour.

**Next step for ChatGPT is therefore commercial, not technical:** upgrade the
account (or use a Business/organisation account) and re-run the same dialog. No
relay change is required — discovery already passes.

### 9.5 Token persistence — a real operational risk, but it did not bite today

The OAuth stores (`clients`, `authCodes`, `accessTokens`, `refreshTokens`) are
`Map`s in the relay process, deliberately matching `registeredCredentials` in
`server.js`. FACT — `platform/subscriptions/relay-service/oauth.js:78-91`.

Access tokens live 1 hour; refresh tokens 30 days. Neither survives a process
restart. **Did it bite us? No** — the `client_id` registered by the earlier run
was still valid today, and the serving pod (`relay-service-78b698c8f7-rjb8c`)
has been up **24 days with 0 restarts**, so nothing was lost.

That is luck, not design. Any redeploy of the relay wipes every registered
client and every token, and each affected user must repeat the *whole* consent
flow — including re-pasting their extension connection URL, which is the one
step that cannot be automated away. A 30-day refresh TTL is meaningless when the
store cannot outlive a deploy.

**Recommendation:** persist at minimum `clients` and `refreshTokens` before we
point any directory listing at this endpoint. Losing every user's connector on
an unrelated relay deploy is the kind of thing a Connectors-Directory listing
turns from an annoyance into a support incident.

### 9.6 Revised order (supersedes §8.6)

1. ~~Emit `title` + annotations from the relay's `tools/list`~~ — **done**,
   confirmed live on both the OAuth and legacy paths.
2. **Persist the OAuth client/refresh stores** (9.5). New, and it now leads,
   because everything downstream assumes connections survive a deploy.
3. Publish the privacy policy in the MCPB manifest + README, then submit
   **MCPB** and **Plugin** directories — neither needs a demo browser.
4. Submit **Anthropic Connectors**. The canonical URL is live, OAuth+DCR works
   end to end, and tools are annotated — the three things §2 listed as missing.
5. ChatGPT: upgrade the account plan, then re-run *Create app* (9.4).
6. Only then, build the narrow ephemeral demo session (8.2/8.4) and submit to
   **OpenAI**.
