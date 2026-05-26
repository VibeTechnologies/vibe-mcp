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
