#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gateScript = join(root, 'scripts/check-cli-version.mjs');
const publicScript = join(root, 'scripts/e2e-cli-public-relay.mjs');
let assertions = 0;
const temporaryDirectories = [];
process.once('exit', () => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

function run(file, args, options = {}) {
  return spawnSync(file, args, { encoding: 'utf8', ...options });
}

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function packageJson(version, extra = {}) {
  return `${JSON.stringify({ version, scripts: { build: 'build' }, ...extra }, null, 2)}\n`;
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'vibe-release-gate-'));
  temporaryDirectories.push(repo);
  mkdirSync(join(repo, 'packages/cli'), { recursive: true });
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  cpSync(gateScript, join(repo, 'scripts/check-cli-version.mjs'));
  writeFileSync(join(repo, 'package.json'), packageJson('1.2.3'));
  writeFileSync(join(repo, 'packages/cli/package.json'), packageJson('1.2.3'));
  writeFileSync(join(repo, 'src/index.ts'), 'export const value = 1;\n');
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Release Gate Test');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'published');
  git(repo, 'tag', 'cli-v1.2.3');
  return repo;
}

function check(repo, published = '1.2.3') {
  return run(process.execPath, ['scripts/check-cli-version.mjs'], {
    cwd: repo,
    env: { ...process.env, VIBE_TEST_ONLY_PUBLISHED_CLI_VERSION: published },
  });
}

{
  const repo = fixture();
  writeFileSync(join(repo, 'notes.txt'), 'irrelevant\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'irrelevant intermediate change');
  writeFileSync(join(repo, 'src/index.ts'), 'export const value = 2;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'relevant accumulated change');
  const result = check(repo);
  assert(result.status !== 0 && result.stderr.includes('must be strictly greater'), 'unchanged version must fail accumulated relevant changes');

  writeFileSync(join(repo, 'package.json'), packageJson('1.2.4'));
  writeFileSync(join(repo, 'packages/cli/package.json'), packageJson('1.2.4'));
  assert(check(repo).status === 0, 'increased aligned version must pass');

  writeFileSync(join(repo, 'package.json'), packageJson('1.2.2'));
  writeFileSync(join(repo, 'packages/cli/package.json'), packageJson('1.2.2'));
  const downgrade = check(repo);
  assert(downgrade.status !== 0 && downgrade.stderr.includes('lower than published'), 'downgrade must fail');
}

{
  const repo = fixture();
  const missing = check(repo, '9.9.9');
  assert(missing.status !== 0 && missing.stderr.includes('Missing git tag cli-v9.9.9'), 'missing published-version tag must fail clearly');
}

{
  const repo = fixture();
  git(repo, 'tag', 'cli-v1.2.4');
  const wrongTag = check(repo, '1.2.4');
  assert(wrongTag.status !== 0 && wrongTag.stderr.includes('records CLI version 1.2.3'), 'published-version tag must record the matching CLI version');
}

{
  const repo = fixture();
  writeFileSync(join(repo, 'package.json'), packageJson('1.2.4'));
  const mismatch = check(repo);
  assert(mismatch.status !== 0 && mismatch.stderr.includes('must align'), 'root and CLI mismatch must fail');
}

const publicFixture = mkdtempSync(join(tmpdir(), 'vibe-public-gate-'));
temporaryDirectories.push(publicFixture);
const callsPath = join(publicFixture, 'calls.jsonl');
const runnerPath = join(publicFixture, 'runner.mjs');
writeFileSync(runnerPath, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.TEST_CALLS_PATH, JSON.stringify({ args: process.argv.slice(2), hasRemote: Boolean(process.env.VIBE_REMOTE_URL) }) + '\\n');
if (process.env.TEST_LEAK_SECRET === '1' && process.env.VIBE_REMOTE_URL) {
  console.error(process.env.VIBE_REMOTE_URL || 'no-remote');
  process.exit(8);
}
if (process.argv.includes('--version') && process.env.TEST_VERSION_FAILURES_PATH) {
  const remaining = Number(readFileSync(process.env.TEST_VERSION_FAILURES_PATH, 'utf8'));
  if (remaining > 0) {
    writeFileSync(process.env.TEST_VERSION_FAILURES_PATH, String(remaining - 1));
    process.exit(9);
  }
}
if (process.argv.includes('--version')) console.log('2.3.4');
else if (process.env.VIBE_REMOTE_URL) console.log(JSON.stringify({ ok: true, pages: [{ id: 'page' }] }));
else process.exit(7);
`);
chmodSync(runnerPath, 0o755);
const syntheticSecret = 'wss://synthetic.invalid/redaction-token';
const publicEnv = {
  ...process.env,
  VIBE_PUBLIC_RELAY_URL_SECRET: syntheticSecret,
  VIBE_PUBLIC_CLI_VERSION: '2.3.4',
  VIBE_TEST_ONLY_PUBLIC_CLI_RUNNER: runnerPath,
  TEST_CALLS_PATH: callsPath,
};

const publicPass = run(process.execPath, [publicScript], { cwd: root, env: publicEnv });
assert(publicPass.status === 0, 'public gate synthetic runner must pass');
const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(JSON.parse);
assert(calls.length === 2 && calls.every((call) => call.args[1] === '@vibebrowser/cli@2.3.4'), 'public gate must invoke only the exact package spec twice');
assert(calls[0].args.includes('--version') && calls[1].args.includes('tabs'), 'public gate must verify version before tabs');
assert(calls[0].hasRemote === false && calls[1].hasRemote === true, 'only the browser tool child may receive the relay credential');

const retryCallsPath = join(publicFixture, 'retry-calls.jsonl');
const failuresPath = join(publicFixture, 'version-failures.txt');
writeFileSync(failuresPath, '2');
const retryPass = run(process.execPath, [publicScript], {
  cwd: root,
  env: { ...publicEnv, TEST_CALLS_PATH: retryCallsPath, TEST_VERSION_FAILURES_PATH: failuresPath },
});
assert(retryPass.status === 0, 'public gate must tolerate bounded exact-version registry propagation failures');
const retryCalls = readFileSync(retryCallsPath, 'utf8').trim().split('\n').map(JSON.parse);
assert(retryCalls.length === 4 && retryCalls.slice(0, 3).every((call) => call.args.includes('--version')), 'public gate must retry exact version three times before tabs');
assert(retryCalls.slice(0, 3).every((call) => call.hasRemote === false) && retryCalls[3].hasRemote === true, 'registry retries must remain credential-free');

for (const candidate of [undefined, 'latest', '1.2', '1.2.3-01']) {
  const env = { ...publicEnv };
  if (candidate === undefined) delete env.VIBE_PUBLIC_CLI_VERSION;
  else env.VIBE_PUBLIC_CLI_VERSION = candidate;
  assert(run(process.execPath, [publicScript], { cwd: root, env }).status !== 0, `configured remote must reject candidate version ${candidate ?? '<missing>'}`);
}

const leak = run(process.execPath, [publicScript], {
  cwd: root,
  env: { ...publicEnv, TEST_LEAK_SECRET: '1' },
});
assert(leak.status !== 0, 'synthetic child failure must fail public gate');
assert(!`${leak.stdout}${leak.stderr}`.includes(syntheticSecret), 'child secret output must be redacted from parent output');

const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
assert(!ci.includes('VIBE_PUBLIC_RELAY_URL_SECRET') && !ci.includes('test:e2e:cli-public-relay'), 'PR/push CI must not reference public relay secret or test');
assert(!ci.includes('CLI_VERSION_BASE_SHA'), 'CI must not use a base SHA');

const publish = readFileSync(join(root, '.github/workflows/publish.yml'), 'utf8');
for (const path of ['src/**', 'packages/cli/**', 'scripts/prepare-cli-package.mjs', 'package.json', 'tsconfig*.json', 'scripts/check-cli-version.mjs', 'scripts/e2e-cli-package-smoke.mjs', 'scripts/e2e-cli-public-relay.mjs', 'scripts/test-release-gates.mjs', '.github/workflows/publish.yml']) {
  assert(publish.includes(`'${path}'`), `publish path filter must include ${path}`);
}
assert(publish.includes('needs: publish') && publish.includes('environment: public-relay'), 'post-publish test must use the protected environment and depend on publish');
assert(publish.includes("github.event_name == 'release'") && publish.includes("refs/heads/main") && publish.includes("refs/heads/master"), 'post-publish condition must cover only trusted events/branches');
assert(publish.includes("require('./packages/cli/package.json').version") && publish.includes('VIBE_PUBLIC_CLI_VERSION: ${{ steps.cli-version.outputs.version }}'), 'post-publish test must pass the exact package version');
assert(!publish.includes('CLI_VERSION_BASE_SHA'), 'publish workflow must not use a base SHA');
assert((publish.match(/secrets\.VIBE_PUBLIC_RELAY_URL_SECRET/g) || []).length === 1, 'relay secret must be referenced only by the protected post-publish job');
assert(!readFileSync(publicScript, 'utf8').includes('@vibebrowser/cli@latest'), 'public relay gate must never default to latest');

console.log(`RELEASE_GATE_REGRESSION:PASS assertions=${assertions}`);
