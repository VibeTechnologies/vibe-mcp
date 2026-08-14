#!/usr/bin/env node
/**
 * Builds the `.mcpb` desktop-extension bundle for Claude Desktop.
 *
 * The bundle is self-contained: it ships @vibebrowser/mcp plus its runtime
 * dependencies in node_modules/, so installing it never hits the network.
 *
 * Usage:
 *   node mcpb/build.mjs            # build into build/mcpb and pack
 *   node mcpb/build.mjs --no-pack  # stage only (used by the test harness)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const stageDir = path.join(repoRoot, 'build', 'mcpb');

const manifestPath = path.join(here, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

// Invariant: the bundle must advertise the same version as the package it ships.
// A drift here would publish a bundle whose manifest lies about its contents.
if (manifest.version !== rootPkg.version) {
  throw new Error(
    `Version drift: mcpb/manifest.json is ${manifest.version} but package.json is ${rootPkg.version}. ` +
      'Bump both together.',
  );
}

const serverSpec = `${rootPkg.name}@${rootPkg.version}`;

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stageDir, 'server'), { recursive: true });

// Bundle THIS checkout, not whatever the registry happens to hold.
//
// This used to depend on `${name}@${version}` and let npm resolve it from the
// registry, which made the build — and the plugin-bundle e2e that runs it — fail
// on every version bump, because the new version is by definition not published
// yet. That is a release deadlock: you cannot publish without green CI and CI
// cannot go green until you publish. Packing the local package also makes the
// bundle byte-for-byte the code in this commit instead of a same-numbered
// release that may have been built from something else.
const packDir = path.join(repoRoot, 'build');
fs.mkdirSync(packDir, { recursive: true });
const tarballName = execFileSync('npm', ['pack', '--silent', '--pack-destination', packDir], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .pop()
  .trim();
const tarballPath = path.join(packDir, tarballName);
if (!fs.existsSync(tarballPath)) {
  throw new Error(`npm pack did not produce ${tarballPath}`);
}

fs.copyFileSync(manifestPath, path.join(stageDir, 'manifest.json'));
fs.copyFileSync(path.join(here, 'server-entry.mjs'), path.join(stageDir, 'server', 'index.js'));

// A minimal package.json so Node treats server/index.js as ESM and npm has a
// place to install the bundled dependency tree.
fs.writeFileSync(
  path.join(stageDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'vibe-browser-mcpb',
      version: manifest.version,
      private: true,
      type: 'module',
      dependencies: { [rootPkg.name]: `file:${tarballPath}` },
    },
    null,
    2,
  )}\n`,
);

console.log(`Installing ${serverSpec} into the bundle...`);
// --omit=optional keeps chrome-devtools-mcp (a large optional fallback) out of
// the bundle; the relay/extension path is the supported one for Claude Desktop.
run('npm', ['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'], {
  cwd: stageDir,
});

// npm writes a lockfile into the stage dir; harmless, but keep the bundle tidy.
fs.rmSync(path.join(stageDir, 'package-lock.json'), { force: true });
fs.rmSync(tarballPath, { force: true });

// The staged package.json must not leak the absolute `file:` path of a build
// host into the shipped bundle.
const stagedPkgPath = path.join(stageDir, 'package.json');
const stagedPkg = JSON.parse(fs.readFileSync(stagedPkgPath, 'utf8'));
stagedPkg.dependencies = { [rootPkg.name]: rootPkg.version };
fs.writeFileSync(stagedPkgPath, `${JSON.stringify(stagedPkg, null, 2)}\n`);

const entry = path.join(stageDir, manifest.server.entry_point);
if (!fs.existsSync(entry)) {
  throw new Error(`Bundle is missing its declared entry_point: ${manifest.server.entry_point}`);
}

if (process.argv.includes('--no-pack')) {
  console.log(`Staged bundle at ${stageDir} (skipping pack).`);
} else {
  console.log('Packing .mcpb...');
  run('npx', ['-y', '@anthropic-ai/mcpb@latest', 'pack', stageDir, path.join(repoRoot, 'build', 'vibe-browser.mcpb')]);
  console.log(`Built ${path.join(repoRoot, 'build', 'vibe-browser.mcpb')}`);
}
