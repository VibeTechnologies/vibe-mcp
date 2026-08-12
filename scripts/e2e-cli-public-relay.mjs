#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const remote = process.env.VIBE_PUBLIC_RELAY_URL_SECRET;
const version = process.env.VIBE_PUBLIC_CLI_VERSION;
const runner = process.env.VIBE_TEST_ONLY_PUBLIC_CLI_RUNNER
  || (process.platform === 'win32' ? 'npx.cmd' : 'npx');
const versionAttempts = 3;
const retryDelayMs = process.env.VIBE_TEST_ONLY_PUBLIC_CLI_RUNNER ? 0 : 2_000;

if (!remote) {
  console.log('CLI_PUBLIC_RELAY_GATE:SKIP (VIBE_PUBLIC_RELAY_URL_SECRET is not set)');
  process.exit(0);
}

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
if (!semver.test(version || '') || version.match(/-([^+]+)/)?.[1].split('.').some((id) => /^0\d+$/.test(id))) {
  console.error('CLI_PUBLIC_RELAY_GATE:FAIL (VIBE_PUBLIC_CLI_VERSION must be a strict SemVer when the public relay is configured)');
  process.exit(1);
}
if (!/^wss:\/\/[^\s]+$/i.test(remote)) {
  console.error('CLI_PUBLIC_RELAY_GATE:FAIL (relay secret must be a full wss URL)');
  process.exit(1);
}

const packageSpec = `@vibebrowser/cli@${version}`;
const { VIBE_PUBLIC_RELAY_URL_SECRET: _redacted, ...baseEnv } = process.env;

async function execute(args, timeoutMessage, includeRemote = false) {
  const child = spawn(runner, ['--yes', packageSpec, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: includeRemote ? { ...baseEnv, VIBE_REMOTE_URL: remote } : baseEnv,
  });
  let stdout = '';
  let stderrLength = 0;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderrLength += chunk.length; });

  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(timeoutMessage));
    }, 30_000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('public relay CLI could not start'));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  return { status, stdout, stderrLength };
}

try {
  let versionResult;
  for (let attempt = 1; attempt <= versionAttempts; attempt += 1) {
    versionResult = await execute(['--version'], 'public relay CLI version check timed out');
    if (versionResult.status === 0 && versionResult.stdout.trim() === version) break;
    if (attempt < versionAttempts) await delay(retryDelayMs);
  }
  if (versionResult.status !== 0 || versionResult.stdout.trim() !== version) {
    throw new Error(`exact CLI version unavailable after ${versionAttempts} attempt(s); stderr bytes=${versionResult.stderrLength}`);
  }

  const tabsResult = await execute(['--json', 'tabs'], 'public relay CLI tabs check timed out', true);
  if (tabsResult.status !== 0) {
    throw new Error(`tabs check exited ${tabsResult.status}; stderr bytes=${tabsResult.stderrLength}`);
  }
  let result;
  try {
    result = JSON.parse(tabsResult.stdout);
  } catch {
    throw new Error('tabs output was not JSON');
  }
  if (result.ok !== true || !Array.isArray(result.pages) || result.pages.length === 0) {
    throw new Error('tabs returned no real page payload');
  }
} catch (error) {
  console.error(`CLI_PUBLIC_RELAY_GATE:FAIL (${error.message})`);
  process.exit(1);
}

console.log('CLI_PUBLIC_RELAY_GATE:PASS');
