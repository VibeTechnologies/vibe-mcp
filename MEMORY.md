# MEMORY.md — vibe-mcp

## Purpose
- Local and remote MCP bridge for Vibe Browser extension control.
- Supports stdio and HTTP transport for external agents.

## Durable Notes
- 2026-03-19: Fixed a stack overflow in the HTTP transport lifecycle. Root cause: `transport.onclose` called `server.close()`, which closes the transport again and re-entered `onclose` recursively until `RangeError: Maximum call stack size exceeded`. Fix: keep session cleanup in `transport.onclose`, but do **not** call `server.close()` there.
- 2026-03-19: Verified local browser control via HTTP transport with a live connected extension. `tools/list` returned 45 browser tools and `list_pages` succeeded against a real browser session.
- The local control path does not need any extra relay-side service: `vibe-mcp` on the same machine as the browser is enough.
