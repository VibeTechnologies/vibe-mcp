#!/usr/bin/env node
/**
 * Hermetic docs contract guard — NO network, NO production dependency.
 *
 * Asserts the user-facing delivery contract for hosted MCP clients:
 *   - the direct Streamable HTTP endpoint https://relay.api.vibebrowser.app/mcp/<uuid>
 *     is documented in README and advertised in server.json `remotes`
 *   - no OAuth / DCR / authorize / scope SETUP INSTRUCTIONS survive in
 *     user-facing docs (negations such as "no OAuth" are allowed)
 *   - historical worklogs stay explicitly historical
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const fails = [];
const checks = [];
const ok = (name, cond, detail = '') => {
  checks.push([name, cond]);
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const HOSTED = 'https://relay.api.vibebrowser.app/mcp/';
const readme = read('README.md');
const status = read('status.md');
const server = JSON.parse(read('server.json'));

// 1. direct hosted URL present in README
ok('README documents direct hosted /mcp/<uuid> URL', readme.includes(HOSTED));

// 2. server.json advertises exactly the direct streamable-http remote
const remotes = server.remotes ?? [];
ok('server.json has exactly one remote', remotes.length === 1, `got ${remotes.length}`);
const remote = remotes[0] ?? {};
ok('server.json remote is streamable-http', remote.type === 'streamable-http', String(remote.type));
ok('server.json remote url is the direct /mcp path', String(remote.url).startsWith(HOSTED), String(remote.url));
ok('server.json remote credential is marked secret',
  remote.variables?.session_id?.isSecret === true);
ok('server.json onboarding path points at extension Settings',
  /Settings\s*->\s*AI Agent Control\s*->\s*Remote \(internet\)\s*->\s*Relay access/i
    .test(remote.variables?.session_id?.description ?? ''));

// 3. no OAuth SETUP instructions in any ACTIVE user-facing surface.
//    Tightened: a mention is allowed only when the SAME line explicitly denies
//    or retires the mechanism (e.g. "no OAuth", "OAuth is retired"), or when it
//    sits under an explicit historical marker. Loose words elsewhere in the line
//    ("no command", "not required") no longer buy a pass.
// OAuth-specific vocabulary only. A bare "scope" is ordinary English and appears
// in unrelated design docs, so only OAuth-shaped scope wording counts.
const OAUTHY = /(oauth|dynamic client registration|\bDCR\b|\/authorize\b|\/oauth\/|scopes?[ _-]supported|scope setup|requested scopes|consent (flow|screen)|browser:(read|control))/i;
const DENIAL = new RegExp(
  String.raw`(\b(no|not|never|without|zero)\b[^.]{0,60}?` +
  String.raw`(oauth|dynamic client registration|\bDCR\b|/authorize|scopes?|consent|register|authorize))` +
  '|' +
  String.raw`((oauth|dcr|consent flow|that path|this path|it)\b[^.]{0,60}?` +
  String.raw`\b(retired|superseded|unsupported|removed|legacy|historical|no longer|not supported)\b)` +
  '|' +
  String.raw`\b(retired|superseded|unsupported|historical|legacy|no longer)\b[^.]{0,40}?\b(oauth|dcr|consent|scopes?)\b`,
  'i',
);
// Lines inside an explicitly historical block are exempt.
const HIST_MARK = /(HISTORICAL INTERNAL NOTE|\*\*SUPERSEDED\.\*\*)/;

// ACTIVE surfaces = things a user is expected to follow right now.
const ACTIVE = [
  ['README.md', readme],
  ['status.md', status],
  ['server.json', read('server.json')],
  ['openclaw/vibebrowser/SKILL.md', read('openclaw/vibebrowser/SKILL.md')],
  ['mcpb/manifest.json', read('mcpb/manifest.json')],
  ...readdirSync(join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => [`docs/${f}`, read(join('docs', f))]),
];
let oauthViolations = 0;
for (const [file, text] of ACTIVE) {
  const lines = text.split('\n');
  const historical = HIST_MARK.test(lines.slice(0, 15).join('\n'));
  ok(`${file} is an active (non-historical) surface`, !historical || file.startsWith('worklog/'));
  lines.forEach((line, i) => {
    if (!OAUTHY.test(line)) return;
    if (DENIAL.test(line)) return;
    oauthViolations += 1;
    ok(`${file}:${i + 1} carries no OAuth setup instruction`, false, line.trim().slice(0, 110));
  });
}
ok('active user-facing docs carry no OAuth setup instructions', oauthViolations === 0,
  `${oauthViolations} line(s)`);

// 4. historical worklogs stay labelled historical
for (const f of readdirSync(join(root, 'worklog')).filter((f) => f.endsWith('.md'))) {
  const text = read(join('worklog', f));
  if (!OAUTHY.test(text)) continue;
  ok(`worklog/${f} is marked HISTORICAL`, /HISTORICAL INTERNAL NOTE/.test(text));
}

// 5. no markdown link from an active surface into worklog/ (historical material
//     must never be reachable as clickable setup guidance)
const MD_LINK_TO_WORKLOG = /\]\(\s*(\.\/)?worklog\/[^)]*\)/i;
for (const [file, text] of ACTIVE) {
  ok(`${file} has no markdown link into worklog/`, !MD_LINK_TO_WORKLOG.test(text),
    (text.match(MD_LINK_TO_WORKLOG) || [''])[0]);
}

// 6. hosted-client table pins HTTPS only — never a wss:// URL
const table = readme.split('<!-- docs-contract: hosted-table start -->')[1]
  ?.split('<!-- docs-contract: hosted-table end -->')[0];
ok('README has the marked hosted-client table', Boolean(table));
ok('hosted-client table contains no wss:// URL', Boolean(table) && !table.includes('wss://'));
ok('hosted-client table pins https:// endpoint only',
  Boolean(table) && (!table.includes('://') || table.includes('https://relay.api.vibebrowser.app/mcp/')));

// 7. exact Codex remote-add command is documented, verbatim
ok('README documents the exact `codex mcp add vibe --url` command',
  readme.includes('codex mcp add vibe --url https://relay.api.vibebrowser.app/mcp/<your-extension-uuid>'));

// 8. migration note away from the retired consent-screen connector
ok('README carries the OAuth-connector migration note',
  /Migrating away from the retired OAuth-style connector guidance/i.test(readme));
ok('server.json describes the migration', /Migration:/i.test(remote.variables?.session_id?.description ?? ''));

// 9. the historical submission pack marks its OAuth-first section superseded
const pack = read('worklog/anthropic-submission-pack.md');
ok('submission pack marks the OAuth-first section SUPERSEDED', pack.includes('**SUPERSEDED.**'));

for (const [name, pass] of checks) console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
if (fails.length) {
  console.error(`\ndocs-contract FAILED (${fails.length}):`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\ndocs-contract ok (${checks.length} assertions, hermetic — no network)`);
