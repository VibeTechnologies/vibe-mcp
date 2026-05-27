## Decision 1
- question: Which issue should own this work?
- decision: Create new issue #67 instead of reusing #66.
- reasoning: #66 focuses on auth/permissions pipeline failure. Current task goal is delivering latest local startup fix release end-to-end.
- alternatives: Reuse #66.
- evidence: #66 body scoped to org auth mismatch; local code changes not tracked there.

## Decision 2
- question: What speed/quality tradeoff to choose under autopilot?
- decision: Balanced.
- reasoning: Need quick ship, but release-impact path requires regression guard and post-merge verification.
- alternatives: Fast (skip new e2e), Thorough (full test matrix and cross-repo eval before publish).
- evidence: task asks for latest code delivery; core risk is startup regression, addressable with focused e2e.

## Decision 3
- question: Ask user for plan approval at Phase 4?
- decision: Autopilot override applied; proceed without blocking question.
- reasoning: Invocation includes `--autopilot` and skill mandates no AskUserQuestion.
- alternatives: Pause for explicit `go`.
- evidence: skill section `Autopilot (--autopilot): No AskUserQuestion calls. Decide every fork yourself.`

## Decision 4
- question: How to parallelize tasks 2 and 3 without file conflicts?
- decision: Remove `package.json` from task 2 scope; keep task 2 script-only.
- reasoning: Parallel group must avoid shared files; version bump already owned by task 3.
- alternatives: Run tasks sequentially.
- evidence: plan rule in skill: same parallel group must not touch same file.

## Decision 5
- question: Resolve set_remote review blocker by changing docs back or adding UUID support?
- decision: Add real UUID support in `ExtensionConnection.setRemoteUrl`.
- reasoning: design and UX both require UUID-first flow for agents; docs-only rollback keeps friction and violates stated fix intent.
- alternatives: Revert description to URL-only.
- evidence: review blocker line 1; issue goal is easier remote connect path when tools missing.

## Decision 6
- question: How to surface local startup fallback error in non-debug mode?
- decision: Emit explicit `console.error` warning in fallback branch.
- reasoning: `this.log` is debug-gated; degraded startup must be visible by default.
- alternatives: Keep debug-only log.
- evidence: review warning line 2.

## Decision 7
- question: How to continue after post-merge verify failed because npm publish did not deliver 0.2.12?
- decision: Add follow-up workflow fix to token fallback selection and validation, then rerun publish via new PR.
- reasoning: stop contract requires PROD pass; current failure is delivery path, not runtime code path. Fastest controllable fix is publish workflow token handling.
- alternatives: Ask user for manual publish immediately.
- evidence: run 26484844463 failed both OIDC and token fallback; logs show token source filtering/selection is fragile.
