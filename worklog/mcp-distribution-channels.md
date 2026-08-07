# MCP distribution channels — where we can list vibe-mcp

Research date: 2026-08-07. Read-only investigation. No product code changed.

## One-sentence answer

**No, there is no store you must publish to** — every client that matters (Claude Code, Claude
Desktop, Claude Cowork desktop sessions, the ChatGPT desktop app / Codex, Cursor, VS Code,
Windsurf) lets a user add a local stdio MCP server by hand, and that is how all of our users
install us today; the stores are *discovery* channels, and the two biggest ones (Anthropic
Connectors Directory, OpenAI Plugins Directory) structurally **reject** our architecture until we
ship a hosted HTTPS MCP endpoint with OAuth.

---

## 0. What we actually ship (ground truth, from this repo)

| Property | Value | Source |
|---|---|---|
| Distribution | npm package `@vibebrowser/mcp` | `package.json` |
| Transports | stdio (default), local streamable-HTTP (`--transport http` → `127.0.0.1:8788/mcp`), WebSocket relay (`wss://relay.api.vibebrowser.app/<uuid>`) | `README.md`, `src/` |
| Hosted public MCP endpoint | **None** | — |
| OAuth 2.0 / DCR | **None** | — |
| Hard runtime dependency | User's real Chrome + the Vibe extension (or `--devtools` against a running Chrome) | `README.md` |
| License / repo | Apache-2.0, public GitHub `VibeTechnologies/vibe-mcp` | `package.json` |
| Already-documented clients | Claude Desktop, Claude Code, Cursor, VS Code Copilot, Windsurf, Gemini CLI, OpenAI Codex CLI, OpenCode | `VibeBrowserProductPage/app/integrations` |

Two architectural facts drive everything below:

1. We are a **local** MCP server. The tools only mean anything on the machine where the user's
   Chrome is running.
2. We have **no OAuth and no public URL**. Every "app store"-grade directory wants both.

---

## 1. Claude Cowork

### Does it exist? Yes.

**FACT.** Claude Cowork is a real, shipping Anthropic product — <https://claude.com/product/cowork>.
It is Claude Code's agentic architecture aimed at non-coding knowledge work, available on paid
plans (Pro, Max, Team, Enterprise) via Claude Desktop for macOS/Windows, claude.ai on the web, and
the Claude mobile apps.
Source: <https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork>

It is **not** a rename of Claude Code or Claude Desktop. Claude Desktop is the host app; Cowork is
a mode inside it (and inside claude.ai / mobile) that you pick from the same message box as Chat.

### How does it consume MCP?

Three routes, and the difference between them is the whole story:

| Route | What it accepts | Works for us? |
|---|---|---|
| claude.ai **Connectors** (`claude.ai/settings/connectors`) | Remote MCP over Streamable HTTP/SSE, OAuth | ❌ we have no hosted endpoint |
| **Plugins** (bundle of skills + MCP + sub-agents + slash commands) | "any MCP, including remote MCPs, **local MCPs**, and MCPBs" | ✅ but desktop-only (below) |
| Locally-configured MCP servers / MCPB desktop extensions | stdio | ✅ but desktop-only |

Sources: <https://claude.com/docs/plugins/submit>,
<https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview>

### The blocker nobody will tell you at the pitch meeting

**FACT, verbatim from Anthropic's Cowork architecture doc:**

> "Local MCP servers don't run in sessions in the cloud."

and from the Cowork getting-started doc, under *Current limitations*:

> "Some features are desktop-only: Live artifacts and **plugins that include local MCP servers work
> through the desktop app only**."

Cowork now runs **in the cloud by default** — the agent loop and code execution happen on
Anthropic's servers in an isolated sandbox; local execution is described as remaining available
"for existing desktop deployments." A cloud session reaches the user's machine only through the
Claude Desktop app, and only for connected folders and the browser — **not** for local MCP servers.

Translation: as Cowork's centre of gravity moves to the cloud, a local stdio MCP server like ours
becomes reachable on a shrinking share of Cowork sessions. There is also an enterprise MDM kill
switch (`isLocalDevMcpEnabled=false`, `isDesktopExtensionEnabled=false`) that blocks us outright on
managed devices.

### Competitive note (unprompted, but you need it)

Cowork ships a native **"Browser actions"** capability — "Claude can open Chrome and work on
websites — clicking, typing, navigating, and filling forms" — powered by Claude in Chrome.
Source: <https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork>

That is a first-party competitor to our core value proposition, bundled free inside the surface we
want to be listed on. Our differentiator (multi-agent simultaneous control of one browser, works
from Cursor/Codex/OpenCode too, not just Claude) still holds, but "list vibe-mcp in Cowork" is not
a greenfield land grab.

### Verdict

There **is** a directory: the **Claude plugin directory**, <https://claude.com/plugins-for/cowork>.
It is community-driven, serves both Cowork and Claude Code (where it surfaces as the
`claude-plugins-official` marketplace, auto-available to every user), and — uniquely among the
first-party stores — **explicitly accepts local MCP servers**. Submission is a public GitHub link.
This is our single best first-party listing opportunity.

---

## 2. Codex desktop / OpenAI Codex

### What it actually is

**FACT.** "Codex desktop" = the **ChatGPT desktop app** running the Codex surface. Codex is
available on: ChatGPT desktop app, Codex CLI, Codex IDE extension, ChatGPT web, Codex cloud.
Source: <https://developers.openai.com/codex/extend/mcp>

### How it consumes MCP

**FACT.** Local Codex clients (ChatGPT desktop app, Codex CLI, IDE extension) support:

- **STDIO servers** — local process, with env vars, `cwd`, per-tool approval modes
- **Streamable HTTP servers** — bearer token, OAuth, or ChatGPT session auth

All three share one config at `~/.codex/config.toml` (or project-scoped `.codex/config.toml`).
Adding a server in the desktop app: **Settings → MCP servers → Add server → STDIO**, enter command,
Save, Restart. Or from a shell:

```bash
codex mcp add vibe -- npx -y @vibebrowser/mcp
```

**No directory, no review, no submission required.** We work in Codex desktop *today*, unchanged.
The right move here is documentation, not distribution.

Notable: OpenAI's own docs already list **Chrome DevTools MCP** and **Playwright MCP** as
"useful MCP servers" — we compete directly in a slot they already advertise.

### Is there an official directory? Yes — and we're disqualified

**FACT.** The **Plugins Directory** is shared by ChatGPT and Codex. Submission via
<https://platform.openai.com/plugins>. Hard requirements (all from
<https://developers.openai.com/plugins/deploy/submission>):

- **"The MCP server uses a public, production URL"** — Universal (one fixed URL for all users) or
  Template (approved partners only)
- **Domain verification** — host an exact token at
  `https://<host>/.well-known/openai-apps-challenge`
- **Verified developer/business identity** in the OpenAI Platform
- **Apps Management** write permission on the org
- Tool annotations (`readOnlyHint`, `openWorldHint`, `destructiveHint`) on every tool
- Reviewer demo credentials that work **without MFA, SMS, email confirmation, or private-network
  access**
- 5 positive + 3 negative test cases, starter prompts, privacy policy / terms / support URLs
- OpenAI review, then developer-triggered publish

We fail on the first line and on the reviewer-credentials line simultaneously: our server has no
public URL, and a reviewer cannot exercise our tools at all without installing a Chrome extension
on their own machine. **Not listable as-is. Not close.**

---

## 3. Anthropic MCP directory / connectors / MCPB

**FACT.** Anthropic runs **three separate surfaces**. People conflate them; they have different
rules.

### 3a. Connectors Directory — `claude.ai/directory`

- Submission portal: `https://claude.ai/admin-settings/directory/submissions/new`
- **Portal accepts remote MCP servers only.** Verbatim: *"The portal accepts remote MCP servers
  only. Local servers are distributed as desktop extensions or plugins instead."*
- Requires a **Team or Enterprise** claude.ai org + Directory management access (Owner by default)
- Requires: `https://` URL, Streamable HTTP or SSE, **OAuth 2.0** for authenticated services, tool
  `title` + `readOnlyHint`/`destructiveHint` annotations, privacy policy, documentation URL, test
  account credentials a reviewer can use end-to-end, 7 compliance acknowledgments
- Escalation: `mcp-review@anthropic.com`

Source: <https://claude.com/docs/connectors/building/submission>

**Our status: disqualified as-is.** Blocked on "remote only" + OAuth.

### 3b. Desktop Extensions — MCPB (`.mcpb`, formerly DXT `.dxt`)

- Spec + CLI: <https://github.com/modelcontextprotocol/mcpb> (`npm i -g @anthropic-ai/mcpb`,
  `mcpb init`, `mcpb pack`)
- A `.mcpb` is a zip containing the local MCP server + `manifest.json`. Claude for macOS/Windows
  loads them with **single-click install**, auto-updates, and a **curated directory**
- Separate submission form: <https://clau.de/desktop-extention-submission> (no admin portal needed)
- Requirements for directory inclusion: "Privacy Policy" section in README.md, `privacy_policies`
  array in `manifest.json` (manifest_version 0.2+), HTTPS privacy-policy URLs. *"Missing or
  incomplete privacy policies result in immediate rejection."*
- Anthropic explicitly recommends Node.js servers because Node ships inside Claude Desktop

Sources: <https://github.com/modelcontextprotocol/mcpb>,
<https://claude.com/docs/connectors/building/submission>

**Our status: qualifies as-is.** We're a Node stdio server — this is exactly the shape MCPB wants.
No signing requirement documented. Cost: package the bundle, write a privacy-policy section, submit
a form.

### 3c. Plugin Directory — `claude.com/plugins-for/cowork`

- Community-driven, serves **Cowork and Claude Code**; in Claude Code it appears as the
  `claude-plugins-official` marketplace, auto-available to all users
- **"Plugins can contain any MCP, including remote MCPs, local MCPs, and MCPBs."**
- Submit: share a **public GitHub link**. Closed-source not accepted (we're Apache-2.0 — fine)
- Pre-flight: `claude plugin validate`
- Forms: `https://claude.ai/admin-settings/directory/submissions/plugins/new` (needs Team/Enterprise)
  **or** `https://platform.claude.com/plugins/submit` (needs Console Developer/Admin/Owner — the
  route for anyone without a Team/Enterprise org)
- Automated review; "Anthropic Verified" badge is a separate, non-guaranteed higher tier
- After publish, **GitHub pushes are mirrored automatically** — no re-submission for updates
- Anthropic nudges plugins toward connectors already in the Connectors Directory "to reduce the
  number of warnings shown to users" — expect a scary-permissions warning on our local MCP

Source: <https://claude.com/docs/plugins/submit>

**Our status: qualifies as-is.** Best first-party listing available to us. Caveat from §1: inside
Cowork it only fires in desktop sessions, never cloud sessions.

---

## 4. OpenAI equivalent

Covered in §2. One directory (**Plugins Directory**, shared ChatGPT + Codex), requires public
production MCP URL + domain verification + verified business identity + review. **Disqualified
until the hosted HTTP MCP endpoint exists.**

ASSUMPTION (not verified): OpenAI has published a blog post *"Making private MCP servers reachable
without making them public"* (<https://developers.openai.com/blog/connect-private-mcp-servers-to-openai-products>)
and a **Secure MCP Tunnel** guide (<https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>).
Both are about reaching a *private network* server, and are aimed at enterprise deployments rather
than public directory listings — but they are worth 30 minutes of reading before we conclude the
hosted-endpoint epic is the only path, because a tunnel-shaped answer might be cheaper.

---

## 5. Other registries

| Registry | Exists? | Accepts local/stdio? | How to submit | Verified |
|---|---|---|---|---|
| **Official MCP Registry** (`registry.modelcontextprotocol.io`) | Yes, preview / API-freeze v0.1 | **Yes** — npm packages with `transport: stdio` | `mcp-publisher` CLI; GitHub OAuth for the `io.github.*` namespace, then `mcp-publisher publish` | FACT — the metadata prep **already landed** on `main` in PR #116 (`server.json` + `"mcpName": "io.github.VibeTechnologies/vibe-mcp"` in `package.json`), but the publish step has **not** run: `?search=io.github.VibeTechnologies` → 0 results. `server.json` also declares `0.3.2` while npm's latest is `0.3.1` |
| **GitHub MCP Registry** (`github.com/mcp`) | Yes, 210 servers | Yes (Playwright-class local servers listed) | ASSUMPTION: curated / partner-led; no public self-serve form found | FACT that it exists and has 210 servers |
| **VS Code MCP gallery** | Yes — `@mcp` in the Extensions view | Yes (docs use local stdio `npx` Playwright as the worked example) | ASSUMPTION: populated from GitHub MCP Registry — `code.visualstudio.com/mcp` redirects to `github.com/mcp` with a `vscode-website` UTM tag | FACT for the gallery + stdio support |
| **Cursor directory** | ASSUMPTION: yes (`cursor.com/directory`), plus one-click "Add to Cursor" deeplinks | ASSUMPTION: yes | ASSUMPTION: GitHub-PR-based | Not verified — JS-rendered page, could not confirm from docs |
| **Smithery** (`smithery.ai`) | Yes | Partially — Smithery's own hosted URLs (`server.smithery.ai/...`) appear in the official registry, implying a hosted-first model | ASSUMPTION: GitHub connect + `smithery.yaml` | Low confidence |
| **Glama** (`glama.ai/mcp/servers`) | Yes (HTTP 200) | ASSUMPTION: yes, auto-crawls public GitHub repos | ASSUMPTION: automatic; claim your listing | Existence only |
| **mcp.so** | Yes (HTTP 200, `/submit` live) | ASSUMPTION: yes | Web form | Existence only |
| **PulseMCP** | Yes (HTTP 403 to bots, site live; PulseMCP's Tadas Antanavicius sits on the MCP Registry working group) | ASSUMPTION: yes | ASSUMPTION: web form / auto-crawl | Existence only |

The aggregators (Glama, mcp.so, PulseMCP, Smithery) are SEO surfaces, not install surfaces. Their
value is backlinks and "browsing developer stumbles on us," not conversion. Treat as a batch of
30-minute chores, not a project.

---

## 6. Brutally honest blocker analysis

### What actually stops us

| Blocker | Kills us on |
|---|---|
| No public HTTPS MCP endpoint | OpenAI Plugins Directory, Anthropic Connectors Directory, Cowork **cloud** sessions, ChatGPT web |
| No OAuth 2.0 / DCR | Anthropic Connectors Directory, most enterprise-grade listings |
| Requires user to install a Chrome extension first | **Every reviewer-tested directory.** A reviewer with demo credentials still cannot exercise a single tool. OpenAI explicitly demands credentials that work "without private-network access" — a browser on *our* machine is exactly that |
| Requires user's real Chrome to be running | Same as above |
| Enterprise MDM can hard-disable local MCP + MCPB | Team/Enterprise Claude deployments |

### Where we can realistically be accepted **today, unchanged**

- ✅ Official MCP Registry (no review at all — namespace ownership only)
- ✅ Anthropic **Plugin** Directory (local MCPs explicitly allowed; automated review)
- ✅ Anthropic **MCPB** desktop extension directory (built for local servers)
- ✅ GitHub MCP Registry / VS Code gallery (local stdio is a first-class citizen; curation risk)
- ✅ Glama / mcp.so / PulseMCP / Cursor directory (low bar)

### Where we cannot, and no amount of listing copy fixes it

- ❌ OpenAI Plugins Directory — needs public production MCP URL + domain verification
- ❌ Anthropic Connectors Directory — portal literally rejects local servers
- ❌ Claude Cowork **cloud** sessions — "Local MCP servers don't run in sessions in the cloud"
- ❌ ChatGPT web — "doesn't read local Codex configuration files"

### Does the hosted HTTP MCP endpoint epic get pulled forward?

**Recommendation: not yet — but put it on the roadmap with a decision date, not "deferred."**

Arguments for pulling it forward now:

- It is the single unlock for *four* blocked surfaces at once (OpenAI directory, Anthropic
  connectors, Cowork cloud, ChatGPT web)
- Cowork's default execution is already cloud, and it's trending further that way. Our reachable
  share of that surface is shrinking on Anthropic's timeline, not ours

Arguments against, which I find stronger for the next 4–6 weeks:

- **A hosted endpoint alone does not make us listable.** We would still need OAuth 2.0 with DCR,
  domain verification, a verified business identity, *and* a reviewer story that works without a
  Chrome extension on the reviewer's laptop. The endpoint is maybe 40% of the work to a passing
  submission
- The relay already exists (`wss://relay.api.vibebrowser.app/<uuid>`). Turning it into a
  spec-compliant Streamable-HTTP MCP endpoint with per-user OAuth is an L, and it inherits a real
  security surface: a public URL that proxies commands into someone's logged-in browser
- We have not yet spent the ~2 days of effort that gets us into 5 directories for free. Do the
  cheap distribution first, measure whether directory traffic converts at all, *then* spend the L

**Decision gate:** ship the S/M items below, instrument install source, and re-decide the hosted
epic once we can see whether directory-sourced installs are >10% of new installs. If Cowork kills
local desktop sessions entirely before then, pull it forward immediately regardless.

---

## 7. The table

| Channel | Exists today? | Accepts our architecture? | Effort | Expected reach | Blocker |
|---|---|---|---|---|---|
| Official MCP Registry | Yes (preview, v0.1 freeze) | **Yes** | **S** | Medium — feeds other clients/registries | None |
| Anthropic Plugin Directory (Cowork + Claude Code) | Yes | **Yes** — local MCPs explicitly allowed | **M** | **High** — auto-available in every Claude Code install | Desktop-only inside Cowork; needs Console or Team/Ent org; permissions warning |
| Anthropic MCPB desktop extension directory | Yes | **Yes** — built for local servers | **M** | Medium-High — one-click install in Claude Desktop | Needs privacy policy in README + `manifest.json` |
| Codex desktop / Codex CLI / IDE ext (direct config) | Yes | **Yes** — works today, no listing needed | **S** (docs only) | Medium | None — pure documentation gap |
| VS Code MCP gallery / GitHub MCP Registry | Yes (210 servers) | **Yes** — local stdio is first-class | **M** | High if accepted | Curated; no confirmed self-serve path |
| Cursor directory | Yes (assumed) | Yes (assumed) | **S** | Medium | Unverified process |
| Glama / mcp.so / PulseMCP / Smithery | Yes | Yes (Smithery: partial) | **S** each | Low — SEO only | Smithery is hosted-first |
| **Anthropic Connectors Directory** | Yes | **No** | **L** | High | Remote-only + OAuth 2.0 + Team/Ent org |
| **OpenAI Plugins Directory** (ChatGPT + Codex) | Yes | **No** | **L** | **Highest** | Public production MCP URL + domain verification + verified business identity + reviewer-runnable demo |
| Claude Cowork **cloud** sessions | Yes | **No** | **L** | High | "Local MCP servers don't run in sessions in the cloud" |

---

## 8. Prioritized shortlist — what to actually do

**1. Finish the Official MCP Registry publish.** *(S, this week, zero review risk — half-done already)*
PR #116 already added `server.json` and `"mcpName": "io.github.VibeTechnologies/vibe-mcp"` to
`package.json`, but nothing was ever pushed to the registry — I confirmed via the live API that
`io.github.VibeTechnologies/*` returns 0 results. `server.json` also claims `0.3.2` while npm's
latest published version is `0.3.1`, so a publish today would fail validation.
Concrete next action: `npm publish` 0.3.2 (or drop `server.json` back to 0.3.1), then
`brew install mcp-publisher`, `mcp-publisher login github`, `mcp-publisher publish`. Verify with
`curl "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.VibeTechnologies"`.

**2. Submit a Vibe plugin to the Anthropic Plugin Directory.** *(M, next 2 weeks, highest ROI)*
Concrete next action: create a `plugin.json` + `.mcp.json` in a public repo wrapping
`npx -y @vibebrowser/mcp`, add a `SETUP.md` skill that walks the user through installing the Chrome
extension (this directly addresses our worst onboarding blocker — Anthropic built `SETUP.md` for
exactly this), run `claude plugin validate`, then submit at
`https://platform.claude.com/plugins/submit`. Lands us in `claude-plugins-official`, which every
Claude Code user already has.

**3. Ship an `.mcpb` desktop extension + submit it.** *(M, next 2–3 weeks)*
Concrete next action: `npm i -g @anthropic-ai/mcpb`, `mcpb init` in a build dir containing the
bundled server, add a "Privacy Policy" section to README.md and a `privacy_policies` array to
`manifest.json` pointing at `https://vibebrowser.app/privacy`, `mcpb pack`, submit at
<https://clau.de/desktop-extention-submission>. Turns our install story into one click for Claude
Desktop users.

Then, in order: document the ChatGPT-desktop-app MCP settings flow on `/integrations` (we already
have `openai-codex-cli` — the desktop app shares `~/.codex/config.toml` and is a different, larger
audience); batch-submit Glama / mcp.so / PulseMCP / Cursor; investigate the GitHub MCP Registry
listing path.

**Explicitly not now:** the hosted HTTP MCP endpoint + OAuth epic. See §6 for the decision gate.

---

## FACT vs ASSUMPTION index

**FACT (cited, fetched 2026-08-07):**
Claude Cowork exists and is a distinct product; Cowork runs in the cloud by default and local MCP
servers do not run in cloud sessions; Cowork/Claude Code plugin directory accepts local MCPs;
Anthropic Connectors Directory portal accepts remote servers only; MCPB is the local-server
distribution format with its own submission form; ChatGPT desktop app + Codex CLI + IDE extension
support stdio MCP via shared `~/.codex/config.toml` with no directory requirement; OpenAI Plugins
Directory requires a public production MCP URL, domain verification, and verified business
identity; the official MCP Registry is live, accepts npm/stdio, and does not currently list us;
VS Code has an `@mcp` gallery supporting local stdio; GitHub MCP Registry has 210 servers; our
`server.json` + `mcpName` metadata exists on `main` (PR #116) but we are not published to the
registry, and `server.json` (0.3.2) is ahead of npm's latest (0.3.1).

**ASSUMPTION (stated, not verified):**
VS Code's gallery is sourced from the GitHub MCP Registry; Cursor's directory details and
submission process; Smithery/Glama/mcp.so/PulseMCP submission mechanics; the GitHub MCP Registry
has no public self-serve submission form; OpenAI's Secure MCP Tunnel is not a viable directory
path for us.
