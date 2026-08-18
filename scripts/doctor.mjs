#!/usr/bin/env node
/**
 * vibe-mcp doctor (AGE-574 / AGE-514 deliverable A)
 *
 * WHY
 * ---
 * Twice, a version check reported healthy while a different, older copy of
 * `@vibebrowser/mcp` was what actually served 127.0.0.1:19889:
 *
 *   - 2026-08-14: 0.3.3 was published; the daemon on 19889 came from an
 *     older global install. Publishing was mistaken for deploying.
 *   - 2026-08-17: the global `@vibebrowser/mcp` was an `npm link` symlink
 *     into a checkout 96 commits behind origin/main, pinned at 0.2.12, with
 *     zero `pong` in src/relay.ts. `npm view` reported 0.3.5, so every
 *     check looked green while the pre-fix relay was what would spawn.
 *
 * A source-only reading of relay.ts, or a registry-only version check, is
 * exactly the check that has failed twice. The only value in this script
 * that cannot be faked by a stale file on disk is RUNNING_VERSION, read off
 * the live `pong` handshake frame from the daemon actually bound to the
 * port.
 *
 * Reports drift, exits non-zero on any FAIL. Never auto-remediates: no
 * auto-kill of the daemon, no auto-install, no auto-unlink. Removing a
 * developer's `npm link` without asking is the surprise this ticket exists
 * to reduce, not add.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const PORT = Number(process.env.VIBE_MCP_EXTENSION_PORT) || 19889;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const PACKAGE_NAME = '@vibebrowser/mcp';

const failures = [];

function fail(line) {
  failures.push(line);
  console.log(`FAIL: ${line}`);
}

function info(line) {
  console.log(line);
}

function tryExec(cmd, args, opts = {}) {
  try {
    return { ok: true, stdout: execFileSync(cmd, args, { encoding: 'utf-8', ...opts }).trim() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Step 2: connect to the extension port and demand a `pong` carrying
 * `version`. This is the load-bearing check — it is the running daemon
 * self-reporting its own package version, and cannot be faked by anything
 * on disk.
 *
 * The explicit sessionId is required: without it the relay allocates an
 * anonymous session and broadcasts session state, i.e. the probe
 * masquerades as a real extension to every connected agent.
 */
function handshake(port) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws?.terminate(); } catch { /* ignore */ }
      resolve({ state: 'timeout' });
    }, HANDSHAKE_TIMEOUT_MS);

    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch (error) {
      clearTimeout(timer);
      resolve({ state: 'refused', error });
      return;
    }

    ws.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ state: 'refused', error });
    });

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'connected', sessionId: 'vibebrowser-doctor' }));
    });

    ws.on('message', (raw) => {
      if (settled) return;
      let message = null;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message || message.type !== 'pong') return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      resolve({ state: 'pong', message });
    });
  });
}

async function checkHandshake() {
  const result = await handshake(PORT);

  if (result.state === 'refused') {
    info(`DAEMON: not running on 127.0.0.1:${PORT}`);
    return { running: false };
  }

  if (result.state === 'timeout') {
    fail(`relay predates the pong fix — connected to 127.0.0.1:${PORT} but got no \`pong\` within ${HANDSHAKE_TIMEOUT_MS}ms`);
    return { running: true };
  }

  const { message } = result;
  if (typeof message.version !== 'string' || message.version.length === 0) {
    fail(`relay predates AGE-91 — pong had no \`version\` field (got ${JSON.stringify(message)})`);
    return { running: true };
  }

  info(`RUNNING_VERSION=${message.version} (read from the pong frame on 127.0.0.1:${PORT}, not from a file)`);
  return { running: true, runningVersion: message.version };
}

/**
 * Step 3: registry version vs the version actually on disk in the global
 * install.
 */
function checkRegistryVsInstall(globalRoot, runningVersion) {
  const registry = tryExec('npm', ['view', PACKAGE_NAME, 'version']);
  if (!registry.ok) {
    fail(`could not read \`npm view ${PACKAGE_NAME} version\`: ${registry.error.message}`);
    return {};
  }
  const registryVersion = registry.stdout;
  info(`REGISTRY_VERSION=${registryVersion}`);

  const installPath = join(globalRoot, '@vibebrowser', 'mcp');
  const pkgJsonPath = join(installPath, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    fail(`no global install found at ${installPath}`);
    return { registryVersion, installPath };
  }

  let installVersion;
  try {
    installVersion = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')).version;
  } catch (error) {
    fail(`could not read/parse ${pkgJsonPath}: ${error.message}`);
    return { registryVersion, installPath };
  }
  info(`INSTALLED_VERSION=${installVersion} (${pkgJsonPath})`);

  if (registryVersion !== installVersion) {
    fail(`registry version ${registryVersion} != installed version ${installVersion} at ${pkgJsonPath}`);
  }

  if (runningVersion !== undefined) {
    if (runningVersion !== registryVersion) {
      fail(`RUNNING_VERSION ${runningVersion} != REGISTRY_VERSION ${registryVersion} — the daemon serving the port is not what the registry says is latest`);
    }
    if (runningVersion !== installVersion) {
      fail(`RUNNING_VERSION ${runningVersion} != INSTALLED_VERSION ${installVersion} at ${pkgJsonPath} — the daemon serving the port is not the global install on disk`);
    }
  }

  return { registryVersion, installVersion, installPath };
}

/**
 * Step 4: is the global install a symlink (npm link) into a checkout that is
 * behind origin? A non-symlink real directory is the healthy case.
 */
function checkLink(installPath) {
  if (!existsSync(installPath)) {
    // Already reported by checkRegistryVsInstall.
    return;
  }

  const stat = lstatSync(installPath);
  if (!stat.isSymbolicLink()) {
    info(`LINK: ${installPath} is a real directory (not npm-linked) — healthy`);
    return;
  }

  const target = realpathSync(installPath);
  info(`LINK: ${installPath} is a symlink -> ${target}`);

  const gitDir = join(target, '.git');
  if (!existsSync(gitDir)) {
    info(`LINK: symlink target ${target} is not a git checkout, skipping behind-count`);
    return;
  }

  const branch = tryExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target });
  const shortSha = tryExec('git', ['rev-parse', '--short', 'HEAD'], { cwd: target });
  if (branch.ok) info(`LINK_TARGET_BRANCH=${branch.stdout}`);
  if (shortSha.ok) info(`LINK_TARGET_SHA=${shortSha.stdout}`);

  const fetch = tryExec('git', ['fetch', '--quiet'], { cwd: target });
  if (!fetch.ok) {
    fail(`could not \`git fetch\` in symlink target ${target}: ${fetch.error.message}`);
    return;
  }

  let defaultBranch = 'main';
  const symbolicRef = tryExec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: target });
  if (symbolicRef.ok) {
    defaultBranch = symbolicRef.stdout.replace(/^refs\/remotes\/origin\//, '');
  }

  const behind = tryExec('git', ['rev-list', '--count', `HEAD..origin/${defaultBranch}`], { cwd: target });
  if (!behind.ok) {
    fail(`could not compute behind-count against origin/${defaultBranch} in ${target}: ${behind.error.message}`);
    return;
  }

  const behindCount = Number.parseInt(behind.stdout, 10) || 0;
  info(`LINK_TARGET_BEHIND(origin/${defaultBranch})=${behindCount}`);
  if (behindCount > 0) {
    fail(`global install at ${installPath} is npm-linked to ${target}, which is ${behindCount} commit(s) behind origin/${defaultBranch}`);
  }
}

/**
 * Step 5: process attribution. Secondary, explanatory only — this
 * identifies *which* checkout/package the pid bound to PORT is actually
 * running from, so a human doesn't have to do process forensics by hand.
 *
 * Deliberately does NOT use /proc/<pid>/exe: that resolves to the node
 * binary and is identical for every node process on the box, so a check
 * built on it always passes. The package dir comes from argv[1], nothing
 * else.
 */
function findPid(port) {
  const ss = tryExec('ss', ['-lptnH', `sport = :${port}`]);
  if (ss.ok) {
    const match = ss.stdout.match(/pid=(\d+)/);
    if (match) return match[1];
    if (ss.stdout.length === 0) return null;
  } else if (ss.error.code !== 'ENOENT') {
    // ss exists but failed for some other reason; fall through to lsof.
  }

  const lsof = tryExec('lsof', ['-ti', `tcp:${port}`]);
  if (lsof.ok) {
    const pid = lsof.stdout.split('\n')[0]?.trim();
    return pid || null;
  }

  return null;
}

function findPackageJsonUpward(startDir) {
  let dir = startDir;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function checkProcessAttribution(port) {
  if (process.platform !== 'linux') {
    info(`PROCESS: SKIPPED (platform=${process.platform}, /proc reads are Linux-only)`);
    return;
  }

  const pid = findPid(port);
  if (!pid) {
    info(`PROCESS: no process bound to 127.0.0.1:${port}`);
    return;
  }
  info(`PROCESS_PID=${pid}`);

  let cmdline;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
  } catch (error) {
    fail(`could not read /proc/${pid}/cmdline: ${error.message}`);
    return;
  }
  const argv = cmdline.split('\0').filter((part) => part.length > 0);
  const scriptArg = argv[1];
  if (!scriptArg) {
    fail(`/proc/${pid}/cmdline had no argv[1] to resolve a package dir from (argv=${JSON.stringify(argv)})`);
    return;
  }
  info(`PROCESS_ARGV1=${scriptArg}`);

  let cwdLink;
  try {
    cwdLink = readlinkSync(`/proc/${pid}/cwd`);
  } catch (error) {
    cwdLink = null;
  }
  if (cwdLink && cwdLink.endsWith(' (deleted)')) {
    fail(`pid ${pid} is running with a deleted cwd: ${cwdLink} — likely a zombie from a removed npx cache dir`);
    return;
  }

  const pkgJsonPath = findPackageJsonUpward(dirname(scriptArg));
  if (!pkgJsonPath) {
    fail(`could not find a package.json above ${scriptArg} for pid ${pid}`);
    return;
  }
  const pkgDir = dirname(pkgJsonPath);
  if (!existsSync(pkgDir)) {
    fail(`resolved package dir ${pkgDir} for pid ${pid} does not exist`);
    return;
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  } catch (error) {
    fail(`could not parse ${pkgJsonPath}: ${error.message}`);
    return;
  }
  info(`PROCESS_PACKAGE name=${pkg.name} version=${pkg.version} dir=${pkgDir}`);
}

async function main() {
  info(`vibe-mcp doctor: PORT=${PORT}`);

  const { running, runningVersion } = await checkHandshake();

  const globalRootResult = tryExec('npm', ['root', '-g']);
  if (!globalRootResult.ok) {
    fail(`could not run \`npm root -g\`: ${globalRootResult.error.message}`);
  } else {
    const { installPath } = checkRegistryVsInstall(globalRootResult.stdout, runningVersion);
    if (installPath) checkLink(installPath);
  }

  checkProcessAttribution(PORT);

  if (failures.length > 0) {
    console.log('');
    console.log(`DOCTOR: FAIL (${failures.length} issue(s))`);
    process.exit(1);
  }

  console.log('');
  console.log(running ? 'DOCTOR: OK' : 'DOCTOR: OK (daemon not running)');
  process.exit(0);
}

main().catch((error) => {
  console.error(`FAIL: doctor crashed: ${error.stack || error.message}`);
  process.exit(1);
});
