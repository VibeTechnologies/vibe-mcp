#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const base = process.env.CLI_VERSION_BASE_SHA || process.argv[2] || 'origin/main';
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const cliPackage = JSON.parse(readFileSync('packages/cli/package.json', 'utf8'));

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function packageAt(ref, path) {
  return JSON.parse(git(['show', `${ref}:${path}`]));
}

function stable(value) {
  return JSON.stringify(value ?? null);
}

function semver(value, label) {
  const match = typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || match[4]?.split('.').some((id) => /^0\d+$/.test(id))) {
    throw new Error(`Invalid ${label} SemVer: ${value}`);
  }
  return [match.slice(1, 4).map(BigInt), match[4]?.split('.')];
}

function compareSemver(current, baseVersion) {
  const [currentCore, currentPre] = semver(current, 'current CLI');
  const [baseCore, basePre] = semver(baseVersion, 'base CLI');
  for (let i = 0; i < 3; i += 1) {
    if (currentCore[i] !== baseCore[i]) return currentCore[i] > baseCore[i] ? 1 : -1;
  }
  if (!currentPre || !basePre) return currentPre ? -1 : basePre ? 1 : 0;
  for (let i = 0; i < Math.max(currentPre.length, basePre.length); i += 1) {
    if (currentPre[i] === undefined || basePre[i] === undefined) return currentPre[i] === undefined ? -1 : 1;
    if (currentPre[i] === basePre[i]) continue;
    const currentNumeric = /^\d+$/.test(currentPre[i]);
    const baseNumeric = /^\d+$/.test(basePre[i]);
    if (currentNumeric && baseNumeric) return BigInt(currentPre[i]) > BigInt(basePre[i]) ? 1 : -1;
    if (currentNumeric !== baseNumeric) return currentNumeric ? -1 : 1;
    return currentPre[i] > basePre[i] ? 1 : -1;
  }
  return 0;
}

if (rootPackage.version !== cliPackage.version) {
  throw new Error(`Root and standalone CLI versions must align (${rootPackage.version} != ${cliPackage.version})`);
}

git(['rev-parse', '--verify', `${base}^{commit}`]);
// Comparing the base directly includes both committed branch changes and local
// edits, which makes the same gate useful before a commit and in CI.
const changed = git(['diff', '--name-only', base]).split('\n').filter(Boolean);
let relevant = changed.some((path) =>
  path.startsWith('src/')
  || path.startsWith('packages/cli/')
  || path === 'scripts/prepare-cli-package.mjs'
  || /^tsconfig(?:\..+)?\.json$/.test(path)
);

if (changed.includes('package.json')) {
  const baseRoot = packageAt(base, 'package.json');
  const standaloneInputs = (pkg) => ({
    dependencies: pkg.dependencies,
    optionalDependencies: pkg.optionalDependencies,
    devDependencies: pkg.devDependencies,
    engines: pkg.engines,
    workspaces: pkg.workspaces,
    build: pkg.scripts?.build,
  });
  relevant ||= stable(standaloneInputs(rootPackage)) !== stable(standaloneInputs(baseRoot));
}

if (relevant) {
  const baseCli = packageAt(base, 'packages/cli/package.json');
  if (compareSemver(cliPackage.version, baseCli.version) <= 0) {
    throw new Error(`Standalone CLI inputs changed since ${base}; current version ${cliPackage.version} must increase from base version ${baseCli.version}`);
  }
}

console.log(`CLI_VERSION_GATE:PASS base=${base} relevant_changes=${relevant}`);
