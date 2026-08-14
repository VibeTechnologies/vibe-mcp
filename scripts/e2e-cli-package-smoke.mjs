#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const CLI_PACKAGE_ROOT = resolve(PACKAGE_ROOT, 'packages', 'cli');
const WORK_ROOT = resolve(PACKAGE_ROOT, '.artifacts', 'cli-package-smoke');
const PACK_DEST = resolve(WORK_ROOT, 'pack');
const INSTALL_PROJECT = resolve(WORK_ROOT, 'install-project');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const KEEP_ARTIFACTS = process.env.KEEP_CLI_PACK_GATE_ARTIFACTS === '1';

function cleanup() {
  if (!KEEP_ARTIFACTS) {
    rmSync(WORK_ROOT, { recursive: true, force: true });
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed (${result.status}): ${command} ${args.join(' ')}`,
        `cwd=${cwd}`,
        `stdout=${result.stdout}`,
        `stderr=${result.stderr}`,
      ].join('\n'),
    );
  }
  return result;
}

function parsePackFilename(stdout, stderr) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Failed to parse npm pack --json output\nstdout=${stdout}\nstderr=${stderr}\n${error}`);
  }
  const filename = Array.isArray(payload) ? payload[0]?.filename : undefined;
  if (!filename) {
    throw new Error(`npm pack --json did not report a filename\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return filename;
}

function main() {
  console.log('CLI_PACK_GATE:START');

  const browserMain = resolve(CLI_PACKAGE_ROOT, 'dist', 'browser-main.js');
  if (!existsSync(browserMain)) {
    throw new Error(`Missing ${browserMain}. Run npm run build first.`);
  }

  cleanup();
  mkdirSync(PACK_DEST, { recursive: true });
  mkdirSync(INSTALL_PROJECT, { recursive: true });

  const packResult = run(NPM_BIN, ['pack', '--json', '--pack-destination', PACK_DEST], CLI_PACKAGE_ROOT);
  const packFilename = parsePackFilename(packResult.stdout, packResult.stderr);
  const tarballPath = resolve(PACK_DEST, packFilename);
  console.log(`CLI_PACK_GATE:PACK_OK:${packFilename}`);

  run(NPM_BIN, ['init', '-y'], INSTALL_PROJECT);
  run(NPM_BIN, ['install', tarballPath], INSTALL_PROJECT);
  console.log('CLI_PACK_GATE:INSTALL_OK');

  const helpResult = run(NPX_BIN, ['--yes', 'vibebrowser-cli', '--help'], INSTALL_PROJECT);
  const helpOutput = `${helpResult.stdout}\n${helpResult.stderr}`;
  if (!/Usage:\s+vibebrowser-cli\b/i.test(helpOutput)) {
    throw new Error(`CLI help output missing usage marker\nstdout=${helpResult.stdout}\nstderr=${helpResult.stderr}`);
  }
  console.log('CLI_PACK_GATE:HELP_OK');

  const remoteHelpIndex = helpOutput.indexOf('--remote');
  const remoteHelpText = remoteHelpIndex >= 0 ? helpOutput.slice(remoteHelpIndex, remoteHelpIndex + 600) : '';
  if (!remoteHelpText.includes('/mcp/<uuid>')) {
    throw new Error(`CLI --remote help does not advertise the /mcp/<uuid> connector URL form\nhelp=${helpOutput}`);
  }
  console.log('CLI_PACK_GATE:REMOTE_HELP_OK');
  console.log('CLI_PACK_GATE:PASS');
}

try {
  main();
  cleanup();
} catch (error) {
  console.error('CLI_PACK_GATE:FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  if (KEEP_ARTIFACTS) {
    console.error(`CLI_PACK_GATE:ARTIFACTS:${WORK_ROOT}`);
  } else {
    cleanup();
  }
  process.exit(1);
}
