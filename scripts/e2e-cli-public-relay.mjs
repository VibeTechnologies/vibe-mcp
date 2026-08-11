#!/usr/bin/env node
import { spawn } from 'node:child_process';

const remote = process.env.VIBE_PUBLIC_RELAY_URL_SECRET;
const packageSpec = process.env.VIBE_PUBLIC_CLI_PACKAGE || '@vibebrowser/cli@latest';
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';

if (!remote) {
  console.log('CLI_PUBLIC_RELAY_GATE:SKIP (VIBE_PUBLIC_RELAY_URL_SECRET is not set)');
  process.exit(0);
}

if (!/^wss:\/\/[^\s]+$/i.test(remote)) {
  console.error('CLI_PUBLIC_RELAY_GATE:FAIL (secret must be a full wss URL)');
  process.exit(1);
}

const { VIBE_PUBLIC_RELAY_URL_SECRET: _redacted, ...childEnv } = process.env;
const child = spawn(NPX_BIN, ['--yes', packageSpec, '--json', 'tabs'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...childEnv, VIBE_REMOTE_URL: remote },
});
let stdout = '';
let stderrLength = 0;
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderrLength += chunk.length; });

const status = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error('public relay CLI timed out'));
  }, 30_000);
  child.once('error', () => reject(new Error('public relay CLI could not start')));
  child.once('exit', (code) => {
    clearTimeout(timer);
    resolve(code ?? 1);
  });
}).catch((error) => {
  console.error(`CLI_PUBLIC_RELAY_GATE:FAIL (${error.message})`);
  process.exit(1);
});

if (status !== 0) {
  console.error(`CLI_PUBLIC_RELAY_GATE:FAIL (CLI exit ${status}; stderr bytes=${stderrLength})`);
  process.exit(1);
}

let result;
try {
  result = JSON.parse(stdout);
} catch {
  console.error('CLI_PUBLIC_RELAY_GATE:FAIL (CLI output was not JSON)');
  process.exit(1);
}
if (result.ok !== true || !Array.isArray(result.pages) || result.pages.length === 0) {
  console.error('CLI_PUBLIC_RELAY_GATE:FAIL (tabs returned no real page payload)');
  process.exit(1);
}
console.log('CLI_PUBLIC_RELAY_GATE:PASS');
