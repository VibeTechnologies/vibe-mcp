#!/usr/bin/env node
// Stop hook — task-readiness-check
// Self-orchestrating: runs triage → parallel verifiers → synthesize via claude -p calls.
// Fails open (allows stop) on any unexpected error — never deadlocks the user.

'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.env.CLAUDE_STOP_HOOK_ACTIVE === 'true') process.exit(0);

const MAX_BLOCKS = 2;
const CLAUDE = process.env.CLAUDE_CLI_PATH || 'claude';

function extractJson(text) {
  if (typeof text !== 'string') return text;
  // Strip markdown fences: ```json\n...\n``` or ```\n...\n```
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  return JSON.parse(raw);
}

function runClaude(prompt, schemaHint) {
  return new Promise((resolve) => {
    const args = ['--dangerously-skip-permissions', '--output-format', 'json', '-p', prompt];
    const proc = spawn(CLAUDE, args, {
      env: { ...process.env, CLAUDE_STOP_HOOK_ACTIVE: 'true' },
    });
    let out = '';
    proc.stdout.on('data', d => (out += d));
    proc.stderr.on('data', () => {});
    proc.on('close', (code) => {
      if (code !== 0) { resolve(null); return; }
      try {
        const envelope = JSON.parse(out);
        // claude --output-format json: {"type":"result","result":"<text>"}
        const text = envelope.result ?? envelope.content ?? out;
        resolve(schemaHint ? extractJson(text) : text);
      } catch {
        try { resolve(JSON.parse(out)); } catch { resolve(null); }
      }
    });
    proc.on('error', () => resolve(null));
  });
}

async function main() {
  let input = '';
  await new Promise(res => {
    const t = setTimeout(res, 5000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => (input += c));
    process.stdin.on('end', () => { clearTimeout(t); res(); });
  });

  let data;
  try { data = JSON.parse(input); } catch { process.exit(0); }

  const transcriptPath = data.transcript_path || '';
  const cwd = data.cwd || process.cwd();
  const sessionId = (data.session_id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');

  const blockCountFile = path.join(os.tmpdir(), `trc-blocks-${sessionId}`);
  let blockCount = 0;
  try { blockCount = parseInt(fs.readFileSync(blockCountFile, 'utf8') || '0', 10) || 0; } catch {}
  if (blockCount >= MAX_BLOCKS) {
    try { fs.unlinkSync(blockCountFile); } catch {}
    process.exit(0);
  }

  const CTX =
    `Working dir: ${cwd}\n` +
    `Session transcript (JSONL): ${transcriptPath}\n` +
    `To inspect this turn: read the tail of the transcript and run git commands in the working dir.`;

  // ── Phase 1: Triage ──────────────────────────────────────────────────────────
  const triagePrompt =
    `You are a fast triage step for a completion gate. ${CTX}\n\n` +
    `Decide if the agent's most recent turn is SUBSTANTIVE: it changed files, ran/merged/pushed/shipped/published something, ` +
    `or made a claim that work is done/verified/complete/fixed. ` +
    `Read the transcript tail (the last assistant message) and run \`git status --porcelain\` and \`git log --oneline -5\` in the working dir.\n` +
    `Return ONLY a raw JSON object (no markdown): { "substantive": true|false, "note": "one line reason" }`;

  const triage = await runClaude(triagePrompt, true);

  if (!triage || !triage.substantive) {
    block_or_pass(true, [], 'Triage: turn not substantive; nothing to verify.', blockCountFile, blockCount);
    return;
  }

  // ── Phase 2: Parallel verifiers (always run all 4 when substantive) ──────────
  const CHECKS = [
    {
      key: 'real-channel',
      prompt:
        `Adversarially check the REAL-CHANNEL claim. ${CTX}\n` +
        `Find every "done/verified/complete/shipped/works" claim in the last turn. For each: is there evidence IN THIS TURN of the actual user-facing thing being exercised (exact command the USER runs, with pasted real output)? ` +
        `Default pass=false if proof is missing or indirect.\n` +
        `Return ONLY raw JSON: { "check": "real-channel", "pass": true|false, "findings": ["..."] }`,
    },
    {
      key: 'claim-vs-git',
      prompt:
        `Verify CLAIMS MATCH GIT. ${CTX}\n` +
        `Run git status/log/branch and \`gh pr list --state all -L 10\` if available. Do the turn's statements about changed/committed/pushed/merged match reality? ` +
        `Flag any "merged/pushed/shipped" with no git/PR evidence, and uncommitted work described as delivered.\n` +
        `Return ONLY raw JSON: { "check": "claim-vs-git", "pass": true|false, "findings": ["..."] }`,
    },
    {
      key: 'artifact-integrity',
      prompt:
        `Verify ARTIFACT INTEGRITY of changed files. ${CTX}\n` +
        `From \`git diff --name-only HEAD~3\` (and unstaged), identify touched files. Run build/typecheck/validate/test scripts relevant to them. ` +
        `Parse/validate any config/frontmatter/schema files changed. Report failures with exact output.\n` +
        `Return ONLY raw JSON: { "check": "artifact-integrity", "pass": true|false, "findings": ["..."] }`,
    },
    {
      key: 'adversarial-untested',
      prompt:
        `ADVERSARIAL untested-paths review. ${CTX}\n` +
        `Assume the work is wrong until proven. What runtimes, inputs, edge cases, or flows are claimed working but never actually executed this turn? ` +
        `Be concrete and specific to the diff.\n` +
        `Return ONLY raw JSON: { "check": "adversarial-untested", "pass": true|false, "findings": ["..."] }`,
    },
  ];

  const checkResults = await Promise.all(CHECKS.map(c => runClaude(c.prompt, true)));
  const checks = checkResults.filter(Boolean);

  // ── Phase 3: Synthesize ───────────────────────────────────────────────────────
  const synthPrompt =
    `Synthesize a single completion-gate verdict from these per-check results:\n${JSON.stringify(checks, null, 2)}\n\n` +
    `Rules: pass=true ONLY if there are zero real blockers. ` +
    `Be strict about real-channel proof and artifact failures. ` +
    `Treat adversarial-untested findings as blockers only when they represent a claim of done on an unverified path. ` +
    `Block count so far this turn: ${blockCount}.\n\n` +
    `Return ONLY raw JSON: { "pass": bool, "blockers": [strings], "summary": string }\n` +
    `The summary must be actionable: name the exact unproven claim and the exact command/output that would prove it.`;

  const verdict = await runClaude(synthPrompt, true);
  if (!verdict) { process.exit(0); }

  block_or_pass(verdict.pass, verdict.blockers || [], verdict.summary || '', blockCountFile, blockCount);
}

function block_or_pass(pass, blockers, summary, blockCountFile, blockCount) {
  if (!pass && blockers.length > 0) {
    try { fs.writeFileSync(blockCountFile, String(blockCount + 1)); } catch {}
    process.stdout.write(JSON.stringify({ decision: 'block', reason: summary || blockers.join(' | ') }));
    process.exit(0);
  }
  try { fs.unlinkSync(blockCountFile); } catch {}
  process.exit(0);
}

main().catch(() => process.exit(0));
