#!/usr/bin/env node
// Validate openclaw/vibebrowser/SKILL.md frontmatter the way the skills.sh CLI does:
// it must be a parseable YAML block with `name` and `description`. A description (or any
// scalar) containing an unquoted ": " breaks the YAML ("mapping values are not allowed
// here") and makes `skills add` report "No valid skills found" — that shipped once (#95)
// and the old grep-only check missed it. This guards that whole class.
import { readFileSync } from 'node:fs';

const path = process.argv[2] || 'openclaw/vibebrowser/SKILL.md';
const fail = (msg) => { console.error(`SKILL VALIDATION FAILED (${path}): ${msg}`); process.exit(1); };

let text;
try { text = readFileSync(path, 'utf8'); } catch { fail('file not found'); }

if (!text.startsWith('---')) fail('missing opening --- frontmatter fence');
const end = text.indexOf('\n---', 3);
if (end === -1) fail('missing closing --- frontmatter fence');
const fm = text.slice(3, end);

// Parse top-level `key: value` lines; tolerate nested/flow blocks (metadata) by tracking
// indentation. We only need to validate the scalar top-level keys (name, description).
const lines = fm.split('\n');
const top = {};
for (const raw of lines) {
  if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
  if (/^\s/.test(raw)) continue;            // nested line — skip (e.g. metadata block)
  const m = raw.match(/^([A-Za-z0-9_-]+):(.*)$/);
  if (!m) continue;
  const key = m[1];
  const val = m[2].replace(/^\s+/, '');
  top[key] = val;
  // The exact hazard that broke #95: an unquoted scalar value containing ": ".
  const quoted = (val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"));
  if (val && !quoted && /:\s/.test(val)) {
    fail(`key "${key}" has an unquoted ": " in its value — invalid YAML. Quote the value or remove the colon-space.\n  value: ${val}`);
  }
}

if (!top.name) fail('frontmatter has no `name`');
if (!top.description) fail('frontmatter has no `description`');
if (top.name.trim() !== 'vibebrowser') fail(`name must be "vibebrowser", got "${top.name}"`);
if (top.description.length < 40) fail('description suspiciously short');

console.log(`SKILL.md OK: name="${top.name}", description ${top.description.length} chars, frontmatter parses.`);
