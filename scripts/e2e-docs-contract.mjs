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

// 3. no OAuth SETUP instructions in user-facing surfaces.
//    A line mentioning oauth/dcr/authorize/scope is only allowed if it is a
//    negation ("no OAuth", "not supported", "never", "zero").
const NEGATION = /\b(no|not|never|without|zero|drop|removed|unsupported|historical)\b/i;
const OAUTHY = /(oauth|dynamic client registration|\bDCR\b|\/authorize\b|scope setup)/i;
for (const [file, text] of [['README.md', readme], ['status.md', status], ['server.json', read('server.json')]]) {
  text.split('\n').forEach((line, i) => {
    if (OAUTHY.test(line) && !NEGATION.test(line)) {
      ok(`${file}:${i + 1} has no OAuth setup instruction`, false, line.trim().slice(0, 100));
    }
  });
}
ok('user-facing docs carry no OAuth setup instructions', !fails.some((f) => /has no OAuth setup/.test(f)));

// 4. historical worklogs stay labelled historical
for (const f of readdirSync(join(root, 'worklog')).filter((f) => f.endsWith('.md'))) {
  const text = read(join('worklog', f));
  if (!OAUTHY.test(text)) continue;
  ok(`worklog/${f} is marked HISTORICAL`, /HISTORICAL INTERNAL NOTE/.test(text));
}

// 5. worklogs are not linked as user setup guidance
ok('README does not link worklogs as setup guidance', !readme.includes('worklog/'));

for (const [name, pass] of checks) console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
if (fails.length) {
  console.error(`\ndocs-contract FAILED (${fails.length}):`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\ndocs-contract ok (${checks.length} assertions, hermetic — no network)`);
