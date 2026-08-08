# OpenAI Plugins Directory — verification pack

Everything an authorised founder needs to complete OpenAI domain verification
and business verification for **vibe-mcp**, in one place, so the portal session
is copy-paste rather than research.

Assembled **2026-08-08**. Companion to `mcp-distribution-channels.md` (PR #124),
which holds the channel-by-channel assessment; this file holds only the OpenAI
submission inputs.

Every row is marked **FACT** (from a cited official source, our own filed
documents, or measured against production today) or **ASSUMPTION**. Do not
paste an ASSUMPTION into a verification form without checking it.

---

## 0. Two different verifications — do not conflate them

The portal gates a submission on two independent checks. They fail for
different reasons and are fixed in different places.

| | Domain verification | Business verification |
|---|---|---|
| Proves | We control the host serving the MCP endpoint | We are a real, named legal entity |
| Mechanism | A token served over HTTPS at a well-known path | Identity documents reviewed by OpenAI |
| Where it happens | Our infrastructure (**done — §2**) | OpenAI Platform org settings (**founder-only — §4**) |
| Blocking on | Nothing; awaiting the portal-minted token | Founder account access |

**There is no DNS TXT record involved in either.** This is worth stating
explicitly because most directory verifications (Google, Microsoft, Brevo — all
three of which appear in our apex TXT records today) use DNS. OpenAI does not:
it is an HTTPS file fetch only.
FACT — <https://developers.openai.com/plugins/deploy/submission#domain-verification>

---

## 1. What domain verification actually requires

Quoting the current docs:

> Plugins with MCP must verify control of the domain that hosts the server.
> When the portal shows a domain verification challenge, place the exact
> verification token at the generated well-known URL:
> `https://<challenge-base-host>/.well-known/openai-apps-challenge`

and:

> The challenge endpoint must return only that plugin's verification token. Do
> not return JSON, a list of tokens, or multiple tokens from the same URL.

FACT — <https://developers.openai.com/plugins/deploy/submission#domain-verification>

So the complete requirement is:

1. A single HTTPS `GET` endpoint at `/.well-known/openai-apps-challenge`
2. Body = the exact token, and **nothing else** — no JSON envelope, no list
3. Hosted on the MCP host name **or a parent host name** (paths are ignored)

### Which host we must serve it from

Our MCP host is `relay.api.vibebrowser.app`. Candidate challenge bases:

| Candidate | Valid per docs? | Serves cleanly? | Verdict |
|---|---|---|---|
| `relay.api.vibebrowser.app` | yes — the host itself, and the portal default | yes | **chosen** |
| `api.vibebrowser.app` | yes — parent | no service listening | rejected |
| `vibebrowser.app` | yes — parent | **307 → `www.vibebrowser.app`** (measured) | rejected |
| `www.vibebrowser.app` | **no** — sibling of the MCP host, not a parent | yes | ineligible |

The apex looks like the obvious home for a `.well-known` file, and it is the
wrong answer: it redirects to `www`, and `www.vibebrowser.app` is **not** a
parent of `relay.api.vibebrowser.app` — it is a sibling. Serving from the relay
host itself is both redirect-free and what the portal checks by default.

FACT — apex redirect measured 2026-08-08:
`curl -sI https://vibebrowser.app/privacy` → `307` → `https://www.vibebrowser.app/privacy`

---

## 2. Domain verification — status: **infrastructure complete**

Shipped in **VibeTechnologies/platform#69** (merged 2026-08-08).

| Item | Value |
|---|---|
| Endpoint | `https://relay.api.vibebrowser.app/.well-known/openai-apps-challenge` |
| Implementation | `subscriptions/relay-service/server.js`, routed before OAuth and `/mcp` |
| Response when configured | `200`, `Content-Type: text/plain; charset=utf-8`, body = exact token, no trailing newline |
| Response when unconfigured | `404` — deliberately **not** an empty `200` |
| Token source | env `OPENAI_APPS_CHALLENGE_TOKEN` → k8s secret `vibe-secrets` (`optional: true`) |
| Tests | `subscriptions/relay-service/tests/relay-openai-apps-challenge.test.mjs` — real server, real HTTP, 10 assertions |

Why the token is injected rather than committed: the portal mints it **per
plugin**, so a committed value would need a code change plus an image rebuild
to rotate. Why unset returns `404` rather than an empty `200`: an empty body
would present to the verifier as a valid-but-wrong token and could burn a
verification attempt.

### The one remaining action

The token does not exist until the portal generates it, so this cannot be
completed without the founder's OpenAI account. Exact remaining step:

1. Open <https://platform.openai.com/plugins> → the vibe-mcp draft → **MCP** tab.
2. Copy the value shown under the **Domain not verified** challenge.
3. Set it as the repo secret `OPENAI_APPS_CHALLENGE_TOKEN` in
   `VibeTechnologies/platform` (flows into `.env.secrets.prod` → `vibe-secrets`),
   or hand the token over for an immediate `kubectl patch` of `vibe-secrets` in
   the `vibe` namespace — the deployment already reads the key.
4. Confirm the endpoint echoes it:
   `curl -s https://relay.api.vibebrowser.app/.well-known/openai-apps-challenge`
5. Press **Verify** in the portal.

No code change is required at any point in that sequence.

---

## 3. Business-verification pack

### 3.1 Legal entity

Source: Washington Secretary of State Initial Report filed 2025-11-10 (Work
Order #2025110600842248-1). FACT.

| Field | Value |
|---|---|
| Legal name | VIBE TECHNOLOGIES, LLC |
| Entity type | Washington domestic limited liability company |
| Jurisdiction | State of Washington, United States |
| Washington UBI | 606 003 933 |
| Federal EIN | 41-2492929 |
| D-U-N-S | 142059652 (Active, Single Location) |
| Formation / effective date | 2025-11-10 |
| Nature of business | Professional, Scientific & Technical Services |
| Best-fit NAICS | 541511 — Custom Computer Programming Services (**ASSUMPTION**: not stated on the certificate) |

### 3.2 Addresses and officers

| Field | Value |
|---|---|
| Principal office | 519 S Henderson St, Seattle, WA 98108-4522, United States |
| Mailing address | same as principal office |
| Registered agent | Dzianis Vashchuk, 519 S Henderson St, Seattle, WA 98108-4522 (consent on file) |
| Governor / officer | Dzianis Vashchuk, Governor, individual |
| Company phone | 360-504-8967 |
| Company email | `vibeteaichnologies@gmail.com` (note the intentional `eai` spelling — matches the WA SOS filing) |

### 3.3 Public URLs required by the listing form

All measured live 2026-08-08. FACT.

| Form field | URL | Status |
|---|---|---|
| Website | `https://vibebrowser.app` | `200` (via `www`) |
| Privacy policy | `https://www.vibebrowser.app/privacy` | `200` |
| Terms of service | `https://www.vibebrowser.app/terms` | `200` |
| Product / support page | `https://www.vibebrowser.app/mcp` | `200` |
| Support contact | `info@vibebrowser.app` | published on the privacy page |
| Source repository | `https://github.com/VibeTechnologies/vibe-mcp` | public |

**Consistency requirement.** The docs state reviewers *"use this identity to
confirm the submission matches the name, website, support contact, privacy
policy, and terms in your public listing."* The publisher name entered in the
portal must therefore read **VIBE TECHNOLOGIES, LLC** — matching the entity
verified in org settings — and the same entity name should be discoverable on
the privacy and terms pages. **ASSUMPTION, unverified:** the live privacy/terms
pages may still name the product rather than the LLC. Worth one look before
submitting, because a mismatch here is a stated rejection reason.
FACT (the requirement) — <https://developers.openai.com/plugins/deploy/submission>

### 3.4 Product description (paste-ready)

**Name:** Vibe MCP — Real Chrome, Remotely

**Short description (≤ ~120 chars):**
> Let ChatGPT drive your own logged-in Chrome — read pages, fill forms, and take screenshots in your real browser session.

**Long description:**
> Vibe MCP connects ChatGPT to the Chrome browser you already use, with the
> sessions you are already signed in to. Instead of a fresh, anonymous cloud
> browser that hits a login wall on every useful site, the assistant works in
> your real profile: it can open and switch tabs, read page content, take
> screenshots and accessibility snapshots, click, type, fill forms, wait for
> page state, and inspect network requests and console output.
>
> A browser extension holds the session and connects outbound to a hosted relay,
> so nothing needs to be exposed on the user's machine and no inbound port is
> opened. Every tool call is scoped to the browser session the user explicitly
> connected, and the user can revoke access at any time by regenerating the
> session in the extension.

**Category:** Productivity / Developer tools (**ASSUMPTION** — pick from the
portal's actual list at submission time).

### 3.5 MCP server details

| Field | Value | Note |
|---|---|---|
| URL type | **Universal** | `https://relay.api.vibebrowser.app/mcp` — a single fixed URL that works for all users |
| Authentication | OAuth 2.1 + Dynamic Client Registration | live; see §3.6 |
| Origin | `https://relay.api.vibebrowser.app` | **immutable after publication** — the docs state the origin cannot change between versions; changing it requires submitting a wholly new plugin |
| Content security policy | not applicable | the server returns no UI; per the docs, do not attach screenshots for a no-UI plugin |

Choosing **Universal** matters. The registry entry advertises a per-session
template URL (`/mcp/{session_id}`), and template URLs are supported *"only for
trusted developers with whom we have an established relationship"* — so
submitting the template shape would be rejected on that ground alone. The OAuth
work below is what makes a single universal URL viable.
FACT — <https://developers.openai.com/plugins/deploy/app-review#template-mcp-server-urls>

### 3.6 Auth posture — measured live 2026-08-08

| Probe | Result |
|---|---|
| `POST /mcp` unauthenticated | `401` |
| `WWW-Authenticate` on that `401` | `Bearer resource_metadata="https://relay.api.vibebrowser.app/.well-known/oauth-protected-resource", scope="browser:read browser:control"` |
| `/.well-known/oauth-protected-resource` | `200` |
| `/.well-known/oauth-authorization-server` | `200` |

All FACT. Shipped in platform#67 / #68. This clears the universal-URL blocker
recorded in `mcp-distribution-channels.md` §4, which was written before those
merged — treat that section as superseded.

---

## 4. What only the founder can do

Neither item below is a research gap; both are account-access gates.

| # | Action | Where | Prepared for you |
|---|---|---|---|
| 1 | Complete **business verification** under the name VIBE TECHNOLOGIES, LLC | <https://platform.openai.com/settings/organization/general> → business verification | Entity data, §3.1–3.2 |
| 2 | Grant the submitter **Apps Management = Write** | <https://platform.openai.com/settings/organization/people/roles> | — |
| 3 | Copy the domain challenge token into `OPENAI_APPS_CHALLENGE_TOKEN` | portal → repo secret | Endpoint already live, §2 |

Publish under a **business** identity, not an individual one: the listing
should read VIBE TECHNOLOGIES, LLC to match the privacy policy and terms.
Individual verification would create exactly the publisher/listing mismatch the
docs call out as a rejection reason.

Also note, before creating the draft: *"projects with EU data residency cannot
submit plugins with MCP servers for review"* — use a global-data-residency
project. FACT — <https://developers.openai.com/plugins/deploy/app-review>

---

## 5. Still blocking submission (not verification)

Verification is necessary, not sufficient. Two items still fail the review
checklist and are tracked in `mcp-distribution-channels.md`:

1. **Tool annotations are absent on the hosted path.** `tool-annotations.ts`
   (vibe-mcp#125) covers the npm **stdio** package only. The relay proxies
   `tools/list` straight through from the browser extension, whose
   `McpServerToolDefinition` carries no `title` and no hints — so the endpoint
   OpenAI actually scans still advertises none. FACT — read from
   `platform/subscriptions/relay-service/server.js:handleMcpToolsList` and
   `vibe/lib/mcp/server/types.ts:97`.
2. **A reviewer has no browser to drive**, so `Scan Tools` and all eight test
   cases fail. See the demo-browser recommendation in
   `mcp-distribution-channels.md`.

Do not open a submission until both are resolved: a rejection consumes the
review slot ("only one version may be in review at a time") and the queue has
no published SLA.
