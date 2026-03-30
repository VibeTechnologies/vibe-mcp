#!/usr/bin/env node

import { spawn } from 'node:child_process';
import process from 'node:process';

const TEST_URL = process.env.BROWSER_LIVE_URL
  || 'https://x.com/search?q=("YC W26" OR "YC Demo Day" OR "W26 Demo Day")&src=typed_query&f=live';
const COMMAND_TIMEOUT_MS = parseIntEnv('BROWSER_LIVE_TIMEOUT_MS', 60_000);
const MIN_CONTENT_CHARS = parseIntEnv('BROWSER_LIVE_MIN_CONTENT_CHARS', 200);
const REQUIRE_SNAPSHOT = parseBoolEnv('BROWSER_LIVE_REQUIRE_SNAPSHOT', false);

async function main() {
  console.log('Live browser CLI regression test');
  console.log(`URL: ${TEST_URL}`);
  console.log(`Timeout: ${COMMAND_TIMEOUT_MS}ms`);
  console.log(`Require snapshot: ${REQUIRE_SNAPSHOT}`);

  const status = await runCli(['status'], 15_000);
  if (!status.ok) {
    throw new Error(`status failed: ${JSON.stringify(status, null, 2)}`);
  }
  if (!status.extensionConnected) {
    throw new Error('Live extension is not connected. Open Vibe browser and enable the extension session first.');
  }

  const startedAt = Date.now();
  const openResult = await runCli(
    ['--timeout', String(COMMAND_TIMEOUT_MS), 'open', TEST_URL],
    COMMAND_TIMEOUT_MS + 10_000,
  );
  const elapsedMs = Date.now() - startedAt;

  if (!openResult.ok) {
    throw new Error(`open failed: ${JSON.stringify(openResult, null, 2)}`);
  }

  const openContent = readPageContent(openResult);
  if (!openContent || openContent.length < MIN_CONTENT_CHARS) {
    throw new Error(
      `open returned insufficient page content (len=${openContent?.length ?? 0}): ${JSON.stringify(openResult, null, 2)}`,
    );
  }

  const targetHost = hostOf(TEST_URL);
  if (targetHost && !openContent.toLowerCase().includes(targetHost.toLowerCase())) {
    throw new Error(`open page content does not mention target host (${targetHost}): ${JSON.stringify(openResult, null, 2)}`);
  }

  const openPageId = extractPageId(openResult);

  const tabs = await runCli(['tabs'], 20_000);
  if (!tabs.ok || !Array.isArray(tabs.pages)) {
    throw new Error(`tabs failed or malformed: ${JSON.stringify(tabs, null, 2)}`);
  }

  const matchedFromTabs = findBestPageByUrl(tabs.pages, TEST_URL);
  const matchedPage = {
    id: openPageId ?? matchedFromTabs?.id,
    url: matchedFromTabs?.url,
  };

  if (!matchedPage.id) {
    const message = `Could not find opened page for URL in tabs output: ${JSON.stringify(tabs, null, 2)}`;
    if (REQUIRE_SNAPSHOT) {
      throw new Error(message);
    }
    console.warn(`snapshot check warning: ${message}`);
  }

  let snapshotText = '';
  if (REQUIRE_SNAPSHOT) {
    if (!matchedPage.id) {
      throw new Error('snapshot check requested but no pageId could be resolved from open/tabs output');
    }
    const snapshotResult = await runCli(
      ['--timeout', String(COMMAND_TIMEOUT_MS), '--page-id', String(matchedPage.id), 'snapshot', '--format', 'ai'],
      COMMAND_TIMEOUT_MS + 10_000,
    );
    if (!snapshotResult.ok) {
      throw new Error(`snapshot failed: ${JSON.stringify(snapshotResult, null, 2)}`);
    }

    snapshotText = String(snapshotResult.snapshot || snapshotResult.pageContent || '');
    if (snapshotText.length < MIN_CONTENT_CHARS) {
      throw new Error(`snapshot content too short (len=${snapshotText.length}): ${JSON.stringify(snapshotResult, null, 2)}`);
    }
  }

  console.log('live browser cli e2e ok');
  console.log(`open latency: ${elapsedMs}ms`);
  console.log(`open content chars: ${openContent.length}`);
  console.log(`snapshot content chars: ${snapshotText.length}`);
  console.log(`pageId: ${matchedPage.id ?? 'n/a'}`);
}

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function readPageContent(payload) {
  if (typeof payload.pageContent === 'string' && payload.pageContent.trim()) {
    return payload.pageContent;
  }
  const firstText = payload?.raw?.content?.find?.((item) => item?.type === 'text' && typeof item.text === 'string');
  return firstText?.text || '';
}

function findBestPageByUrl(pages, targetUrl) {
  const target = normalizeUrl(targetUrl);
  let fallback = null;
  for (const page of pages) {
    const pageUrl = typeof page?.url === 'string' ? page.url : '';
    const id = toNumber(page?.id);
    if (!id || !pageUrl) {
      continue;
    }
    const candidates = candidateUrls(pageUrl);
    const hasExact = candidates.some((candidate) => candidate === target);
    const hasPartial = candidates.some((candidate) => candidate.includes(target) || target.includes(candidate));

    if (hasExact) {
      return { id, url: pageUrl };
    }
    if (!fallback && hasPartial) {
      fallback = { id, url: pageUrl };
    }
  }
  return fallback;
}

function candidateUrls(url) {
  const out = [normalizeUrl(url)];
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/i/flow/login') {
      const redirect = parsed.searchParams.get('redirect_after_login');
      if (redirect) {
        const decoded = safeDecode(redirect);
        if (decoded.startsWith('/')) {
          out.push(normalizeUrl(`https://x.com${decoded}`));
        } else if (/^https?:\/\//i.test(decoded)) {
          out.push(normalizeUrl(decoded));
        }
      }
    }
  } catch {
    // ignore malformed URL parsing and keep base candidate
  }
  return out;
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/$/, '');
  if (!trimmed) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    return safeDecode(`${parsed.origin}${parsed.pathname}${parsed.search}`.replace(/\/$/, ''));
  } catch {
    return safeDecode(trimmed);
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function extractPageId(payload) {
  const direct = toNumber(payload?.pageId);
  if (direct) {
    return direct;
  }

  const text = readPageContent(payload) || '';
  const match = /\(ID:\s*(\d+)\)/i.exec(text) || /\bTab ID:\s*(\d+)\b/i.exec(text) || /\bPage ID:\s*(\d+)\b/i.exec(text);
  if (match) {
    return toNumber(match[1]);
  }
  return undefined;
}

async function runCli(args, timeoutMs) {
  const child = spawn(process.execPath, ['dist/browser-main.js', '--json', ...args], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI command timed out after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode ?? 1);
    });
  });

  if (code !== 0) {
    throw new Error([
      `Command failed (code ${code}): ${args.join(' ')}`,
      stdout.trim(),
      stderr.trim(),
    ].filter(Boolean).join('\n'));
  }

  const payload = parseLastJson(stdout);
  if (!payload) {
    throw new Error(`Could not parse JSON output for command: ${args.join(' ')}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
  return payload;
}

function parseLastJson(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const chunk = lines.slice(i).join('\n').trim();
    try {
      return JSON.parse(chunk);
    } catch {
      // keep scanning upward
    }
  }
  return null;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
