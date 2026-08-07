#!/usr/bin/env node
/**
 * Real end-to-end check for the two distribution artifacts:
 *
 *   1. the Claude Code plugin under plugins/vibe-browser
 *   2. the .mcpb desktop bundle built from mcpb/
 *
 * This deliberately avoids fixture-shaped assertions. Every check either runs a
 * real external validator (`mcpb validate`, `claude plugin validate`) or boots
 * the real server and speaks real MCP over stdio to it. If the artifact would
 * not work for a user, this test fails.
 *
 * Run: node scripts/e2e-plugin-bundle.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let checks = 0;

function check(name, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// 1. Plugin structure + manifest agreement with the rest of the repo
// ---------------------------------------------------------------------------
console.log('\n[1/4] Claude Code plugin');

const pluginDir = path.join(repoRoot, 'plugins', 'vibe-browser');
const pluginManifest = readJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'));
const marketplace = readJson(path.join(repoRoot, '.claude-plugin', 'marketplace.json'));
const rootPkg = readJson(path.join(repoRoot, 'package.json'));

check('plugin components sit at the plugin root, not inside .claude-plugin/', () => {
  for (const dir of ['skills', 'commands', 'agents', 'hooks']) {
    assert(
      !fs.existsSync(path.join(pluginDir, '.claude-plugin', dir)),
      `${dir}/ must not live inside .claude-plugin/ - Claude Code will not discover it`,
    );
  }
});

check('setup skill exists and declares a description', () => {
  const skill = path.join(pluginDir, 'skills', 'setup', 'SKILL.md');
  assert(fs.existsSync(skill), 'skills/setup/SKILL.md is missing');
  const body = fs.readFileSync(skill, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---/.exec(body);
  assert(fm, 'SKILL.md has no YAML frontmatter');
  assert(/\bdescription:\s*\S/.test(fm[1]), 'SKILL.md frontmatter has no description');
});

check('setup skill points at a Chrome Web Store listing that resolves', () => {
  const body = fs.readFileSync(path.join(pluginDir, 'skills', 'setup', 'SKILL.md'), 'utf8');
  const m = /chromewebstore\.google\.com\/detail\/[a-z0-9-]+\/([a-z]{32})/.exec(body);
  assert(m, 'no Chrome Web Store extension link found in the setup skill');
  // Network check is opt-in so the suite stays runnable offline.
  if (process.env.E2E_SKIP_NETWORK === '1') return;
  const html = execFileSync(
    'curl',
    ['-sL', '-A', 'Mozilla/5.0', `https://chromewebstore.google.com/detail/${m[1]}`],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert(
    /<title>[^<]*Vibe[^<]*<\/title>/i.test(html),
    `extension id ${m[1]} does not resolve to a Vibe listing (dead or unpublished link)`,
  );
});

check('plugin .mcp.json pins the version this repo actually publishes', () => {
  const mcp = readJson(path.join(pluginDir, '.mcp.json'));
  const server = mcp.mcpServers && mcp.mcpServers.vibe;
  assert(server, '.mcp.json has no "vibe" server');
  const spec = (server.args || []).find((a) => a.startsWith(rootPkg.name));
  assert(spec, `.mcp.json args do not reference ${rootPkg.name}`);
  assert(
    spec === `${rootPkg.name}@${rootPkg.version}`,
    `.mcp.json pins ${spec} but package.json is at ${rootPkg.version}`,
  );
});

check('marketplace entry resolves to the real plugin directory and version', () => {
  const entry = (marketplace.plugins || []).find((p) => p.name === pluginManifest.name);
  assert(entry, `marketplace.json has no entry named ${pluginManifest.name}`);
  const resolved = path.resolve(repoRoot, entry.source);
  assert(fs.existsSync(resolved), `marketplace source ${entry.source} does not exist`);
  assert(
    resolved === pluginDir,
    `marketplace source resolves to ${resolved}, expected ${pluginDir}`,
  );
  assert(
    entry.version === pluginManifest.version,
    `marketplace pins ${entry.version} but plugin.json is ${pluginManifest.version}`,
  );
  assert(
    pluginManifest.version === rootPkg.version,
    `plugin.json is ${pluginManifest.version} but package.json is ${rootPkg.version}`,
  );
});

// `claude` is not installed everywhere; when it is, defer to the real validator
// that Anthropic's review pipeline runs.
console.log('\n[2/4] claude plugin validate');
let claudeAvailable = true;
try {
  execFileSync('claude', ['--version'], { stdio: 'ignore' });
} catch {
  claudeAvailable = false;
}

if (!claudeAvailable) {
  console.log('  skip  claude CLI not installed (CI installs it; local runs may skip)');
} else {
  check('claude plugin validate --strict passes for the plugin', () => {
    execFileSync('claude', ['plugin', 'validate', pluginDir, '--strict'], {
      encoding: 'utf8',
      timeout: 120_000,
    });
  });

  check('claude plugin validate --strict passes for the marketplace', () => {
    execFileSync('claude', ['plugin', 'validate', repoRoot, '--strict'], {
      encoding: 'utf8',
      timeout: 120_000,
    });
  });
}

// ---------------------------------------------------------------------------
// 3. Build the real bundle and validate it with Anthropic's own tool
// ---------------------------------------------------------------------------
console.log('\n[3/4] .mcpb bundle');

const stageDir = path.join(repoRoot, 'build', 'mcpb');

check('bundle builds from source', () => {
  execFileSync('node', [path.join('mcpb', 'build.mjs'), '--no-pack'], {
    cwd: repoRoot,
    stdio: 'inherit',
    timeout: 300_000,
  });
  assert(fs.existsSync(stageDir), 'build/mcpb was not produced');
});

check('bundled manifest passes `mcpb validate`', () => {
  execFileSync('npx', ['-y', '@anthropic-ai/mcpb@latest', 'validate', path.join(stageDir, 'manifest.json')], {
    encoding: 'utf8',
    timeout: 180_000,
  });
});

check('bundle is self-contained (declared entry + dependency tree present)', () => {
  const manifest = readJson(path.join(stageDir, 'manifest.json'));
  const entry = path.join(stageDir, manifest.server.entry_point);
  assert(fs.existsSync(entry), `entry_point ${manifest.server.entry_point} missing from bundle`);
  assert(
    fs.existsSync(path.join(stageDir, 'node_modules', rootPkg.name)),
    `${rootPkg.name} was not vendored into the bundle - install would need the network`,
  );
  for (const dep of Object.keys(rootPkg.dependencies || {})) {
    assert(
      fs.existsSync(path.join(stageDir, 'node_modules', dep)),
      `runtime dependency ${dep} is missing from the bundle`,
    );
  }
});

// Hard requirements copied from Anthropic's MCPB Desktop Extensions submission
// form. A drift here gets the submission rejected, so fail the build instead.
check('bundle meets the MCPB directory submission requirements', () => {
  const manifest = readJson(path.join(stageDir, 'manifest.json'));
  assert(
    manifest.server.type === 'node',
    `directory expects a Node.js extension, manifest declares "${manifest.server.type}"`,
  );
  assert(
    manifest.author && /^https:\/\/github\.com\/[^/]+\/?$/.test(manifest.author.url || ''),
    `manifest author.url must point at a GitHub profile, got "${(manifest.author || {}).url}"`,
  );
  assert(
    Array.isArray(manifest.privacy_policies) && manifest.privacy_policies.length > 0,
    'manifest must declare privacy_policies: the server reaches an external relay',
  );
  assert(
    manifest.repository && /^https:\/\/github\.com\//.test(manifest.repository.url || ''),
    'manifest must declare a public GitHub repository',
  );
});

check('bundle packs into a loadable .mcpb archive', () => {
  const out = path.join(repoRoot, 'build', 'vibe-browser.mcpb');
  fs.rmSync(out, { force: true });
  execFileSync('npx', ['-y', '@anthropic-ai/mcpb@latest', 'pack', stageDir, out], {
    encoding: 'utf8',
    timeout: 300_000,
  });
  assert(fs.existsSync(out), '.mcpb archive was not produced');
  // Claude Desktop reads manifest.json from the archive root; prove it is there.
  const listing = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' });
  const names = listing.split('\n');
  assert(names.includes('manifest.json'), '.mcpb archive has no manifest.json at its root');
  assert(
    names.some((n) => n === 'server/index.js'),
    '.mcpb archive is missing server/index.js',
  );
  const bytes = fs.statSync(out).size;
  assert(bytes > 10_000, `.mcpb archive is implausibly small (${bytes} bytes)`);
  console.log(`       archive: ${(bytes / 1024).toFixed(0)} KiB, ${names.length - 1} entries`);
});

// ---------------------------------------------------------------------------
// 4. Boot the bundled server exactly as the manifest declares and speak MCP
// ---------------------------------------------------------------------------
console.log('\n[4/4] live MCP handshake against the bundled server');

async function handshake() {
  const manifest = readJson(path.join(stageDir, 'manifest.json'));
  const args = manifest.server.mcp_config.args.map((a) => a.replace('${__dirname}', stageDir));

  const child = spawn(manifest.server.mcp_config.command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Same env shape the host produces when the user leaves remote_uuid blank.
    env: { ...process.env, VIBE_REMOTE_URL: '' },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => {
    stdout += c;
  });
  child.stderr.on('data', (c) => {
    stderr += c;
  });

  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcpb-bundle-e2e', version: '1.0.0' },
    },
  });

  const deadline = Date.now() + 60_000;
  let result = null;
  while (Date.now() < deadline && !result) {
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === 1) result = msg;
    }
    if (!result) await new Promise((r) => setTimeout(r, 200));
  }

  child.kill('SIGKILL');

  if (!result) {
    throw new Error(
      `bundled server never answered initialize within 60s.\nstderr:\n${stderr.slice(0, 2000)}`,
    );
  }
  if (result.error) {
    throw new Error(`initialize returned an error: ${JSON.stringify(result.error)}`);
  }
  assert(
    result.result && result.result.protocolVersion,
    `initialize result missing protocolVersion: ${JSON.stringify(result.result)}`,
  );
  assert(
    result.result.serverInfo && result.result.serverInfo.name,
    'initialize result missing serverInfo.name',
  );
  return result.result;
}

let handshakeResult = null;
try {
  handshakeResult = await handshake();
  checks += 1;
  console.log(
    `  ok   bundled server completed MCP initialize ` +
      `(server: ${handshakeResult.serverInfo.name} ${handshakeResult.serverInfo.version || ''}, ` +
      `protocol: ${handshakeResult.protocolVersion})`,
  );
} catch (error) {
  checks += 1;
  failures.push(`bundled server MCP initialize: ${error.message}`);
  console.log(`  FAIL bundled server MCP initialize\n       ${error.message}`);
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.error(`e2e FAILED - ${failures.length}/${checks} checks failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`e2e ok - ${checks} checks passed`);
