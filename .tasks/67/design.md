## Problem
Latest local fixes for MCP startup reliability are not shipped in npm latest. Agents running `npx -g @vibebrowser/mcp` can still miss improved behavior when local relay startup fails before MCP transport is ready and can miss clear guidance that `set_remote` should be called first when browser tools are unavailable.

## Goal
Ship a new npm release containing startup resilience + stronger `set_remote` metadata so npx users get fixes without local binary override.

## Success Metric
`npm view @vibebrowser/mcp dist-tags.latest --json` equals released version from this branch, and `npx -g @vibebrowser/mcp --version` returns same version while `npx -g @vibebrowser/mcp --help` succeeds.

## Out of Scope
- Changing relay protocol semantics.
- Reworking publish workflow auth model.
- Extension-side tool broadcast behavior.

## Current State
- `src/server.ts:45` has old `set_remote` description that does not signal "call first" behavior.
- `src/server.ts:116` calls `await this.connection.start()` directly; local relay startup failure can abort server startup before MCP transport is available.
- Package currently at `0.2.11` in `package.json:3`; npm latest already `0.2.11`, so new delivery needs version bump.
- Publish workflow exists in `.github/workflows/publish.yml` and auto-publishes changed versions.

## Proposed Design
1. Update `SET_REMOTE_TOOL` description/input docs in `src/server.ts` to explicitly instruct clients to call `set_remote` first when browser tools are missing and clarify accepted inputs (UUID or full relay URL).
2. Wrap `this.connection.start()` in `start()` with guarded error handling: in local non-devtools mode, log and continue server startup instead of failing hard; keep remote/devtools behavior strict.
3. Bump package version for both root and CLI workspace so publish workflow pushes a new tag/version.
4. Run local build + focused reconnect e2e to validate no regression before PR.
5. Merge PR; monitor publish workflow; verify npm latest and npx behavior.

## Alternatives Considered
1. Keep hard-fail startup and rely on users to retry/restart.
   - Rejected: does not deliver resilient startup path; leaves zero-tool startup failures unresolved.
2. Move resilience into `ExtensionConnection.start()` instead of server wrapper.
   - Rejected: wider side effects across callers and modes; server-level policy is simpler and explicit.
3. Skip release bump and rely on direct local binary path.
   - Rejected: user asked for npx package path; no npm delivery means fix unavailable for default users.

## Risks & Open Questions
- Risk: Catching local startup errors may mask real defects.
  - Mitigation: only allow non-fatal path in local non-devtools mode; keep remote/devtools strict and log full message.
- Risk: version bump may trigger publish conflict if version already exists.
  - Mitigation: bump to new patch version and verify `npm view` before merge if needed.
- Open question: none blocking for this task.

## Touched Surface
- `src/server.ts`
- `package.json`
- `package-lock.json`
- `packages/cli/package.json`
- `.tasks/67/*`
