#!/usr/bin/env node
/**
 * MCPB bundle entry point.
 *
 * The bundle ships @vibebrowser/mcp and its dependencies in a sibling
 * node_modules/, so this shim just resolves the package's real CLI and executes
 * it in-process. It deliberately does NOT re-implement any server logic: the
 * bundled server must behave identically to `npx @vibebrowser/mcp`.
 *
 * The CLI parses process.argv and defaults to the `start` command over stdio,
 * which is exactly what an MCPB host expects.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);

function resolveServerEntry() {
  // Resolve via package.json so we follow the package's own `bin` declaration
  // rather than hardcoding a dist path that could move between releases.
  const pkgJsonPath = require.resolve('@vibebrowser/mcp/package.json');
  const pkg = require(pkgJsonPath);
  const relative =
    (pkg.bin && (pkg.bin.mcp || pkg.bin['vibebrowser-mcp'] || pkg.bin['vibe-mcp'])) || pkg.main;

  if (!relative) {
    throw new Error(
      '@vibebrowser/mcp declares neither a usable `bin` entry nor `main`; the bundle is malformed.',
    );
  }

  return path.resolve(path.dirname(pkgJsonPath), relative);
}

try {
  await import(pathToFileURL(resolveServerEntry()).href);
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  // stderr only: stdout is the MCP stdio transport and must stay protocol-clean.
  process.stderr.write(`[vibe-browser] failed to start bundled MCP server:\n${message}\n`);
  process.exit(1);
}
