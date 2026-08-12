#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const cliPackage = JSON.parse(readFileSync('packages/cli/package.json', 'utf8'));
const testPublishedVersion = process.env.VIBE_TEST_ONLY_PUBLISHED_CLI_VERSION;

function run(file, args, label) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim();
    throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
  }
}

function git(args, label = `git ${args.join(' ')} failed`) {
  return run('git', args, label);
}

function packageAt(ref, path) {
  return JSON.parse(git(['show', `${ref}:${path}`], `Unable to read ${path} at ${ref}`));
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

function compareSemver(current, baseline) {
  const [currentCore, currentPre] = semver(current, 'current CLI');
  const [baselineCore, baselinePre] = semver(baseline, 'published CLI');
  for (let i = 0; i < 3; i += 1) {
    if (currentCore[i] !== baselineCore[i]) return currentCore[i] > baselineCore[i] ? 1 : -1;
  }
  if (!currentPre || !baselinePre) return currentPre ? -1 : baselinePre ? 1 : 0;
  for (let i = 0; i < Math.max(currentPre.length, baselinePre.length); i += 1) {
    if (currentPre[i] === undefined || baselinePre[i] === undefined) return currentPre[i] === undefined ? -1 : 1;
    if (currentPre[i] === baselinePre[i]) continue;
    const currentNumeric = /^\d+$/.test(currentPre[i]);
    const baselineNumeric = /^\d+$/.test(baselinePre[i]);
    if (currentNumeric && baselineNumeric) return BigInt(currentPre[i]) > BigInt(baselinePre[i]) ? 1 : -1;
    if (currentNumeric !== baselineNumeric) return currentNumeric ? -1 : 1;
    return currentPre[i] > baselinePre[i] ? 1 : -1;
  }
  return 0;
}

if (rootPackage.version !== cliPackage.version) {
  throw new Error(`Root and standalone CLI versions must align (${rootPackage.version} != ${cliPackage.version})`);
}

const publishedVersion = testPublishedVersion
  ? testPublishedVersion
  : run('npm', ['view', '@vibebrowser/cli', 'version'], 'Unable to query latest published @vibebrowser/cli version from npm');
semver(publishedVersion, 'published CLI');

const tag = `cli-v${publishedVersion}`;
let tagCommit;
try {
  tagCommit = git(['rev-parse', '--verify', `${tag}^{commit}`]);
} catch {
  throw new Error(`Missing git tag ${tag} for published @vibebrowser/cli ${publishedVersion}`);
}
const taggedCliVersion = packageAt(tagCommit, 'packages/cli/package.json').version;
if (taggedCliVersion !== publishedVersion) {
  throw new Error(`Git tag ${tag} records CLI version ${taggedCliVersion}, expected ${publishedVersion}`);
}

const changed = new Set(git(['diff', '--name-only', tagCommit]).split('\n').filter(Boolean));
for (const line of git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean)) {
  if (line.startsWith('?? ')) changed.add(line.slice(3));
}

let relevant = [...changed].some((path) =>
  path.startsWith('src/')
  || path.startsWith('packages/cli/')
  || path === 'scripts/prepare-cli-package.mjs'
  || /^tsconfig(?:\..+)?\.json$/.test(path)
);

if (changed.has('package.json')) {
  const taggedRoot = packageAt(tagCommit, 'package.json');
  const standaloneInputs = (pkg) => ({
    dependencies: pkg.dependencies,
    optionalDependencies: pkg.optionalDependencies,
    devDependencies: pkg.devDependencies,
    engines: pkg.engines,
    workspaces: pkg.workspaces,
    build: pkg.scripts?.build,
  });
  relevant ||= stable(standaloneInputs(rootPackage)) !== stable(standaloneInputs(taggedRoot));
}

const comparison = compareSemver(cliPackage.version, publishedVersion);
if (comparison < 0) {
  throw new Error(`Current CLI version ${cliPackage.version} is lower than published version ${publishedVersion}`);
}
if (relevant && comparison === 0) {
  throw new Error(`Standalone CLI inputs changed since ${tag}; current version ${cliPackage.version} must be strictly greater than published version ${publishedVersion}`);
}

console.log(`CLI_VERSION_GATE:PASS published=${publishedVersion} tag=${tag} relevant_changes=${relevant}`);
