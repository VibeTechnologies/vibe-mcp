/**
 * Ollama integration — detect, install, pull, serve.
 *
 * Provides a cross-platform (macOS / Linux / Windows) one-liner experience:
 *   npx @vibebrowser/mcp serve qwen3.5
 */

import { execSync, spawn, ChildProcess, execFileSync, SpawnOptions } from 'child_process';
import { platform } from 'os';
import { createInterface } from 'readline';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const OLLAMA_API = 'http://127.0.0.1:11434';
const HEALTH_POLL_MS = 500;
const HEALTH_TIMEOUT_MS = 15_000;

export interface ServeOptions {
  /** Custom Ollama API port (default 11434) */
  port?: number;
  /** Skip auto-install prompt */
  yes?: boolean;
  /** Enable debug logging */
  debug?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function log(msg: string): void {
  console.error(`[vibe-mcp] ${msg}`);
}

function debug(msg: string, opts?: ServeOptions): void {
  if (opts?.debug) console.error(`[vibe-mcp:debug] ${msg}`);
}

/** Run a command and return trimmed stdout, or null on failure. */
function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  1. Detection                                                       */
/* ------------------------------------------------------------------ */

export function isOllamaInstalled(): boolean {
  return tryExec('ollama --version') !== null;
}

/* ------------------------------------------------------------------ */
/*  2. Installation                                                    */
/* ------------------------------------------------------------------ */

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} [Y/n] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() !== 'n');
    });
  });
}

export async function installOllama(opts?: ServeOptions): Promise<void> {
  const os = platform();

  if (!opts?.yes) {
    const ok = await promptYesNo('Ollama is not installed. Install it now?');
    if (!ok) {
      log('Aborted. Install Ollama manually: https://ollama.com/download');
      process.exit(1);
    }
  }

  log('Installing Ollama…');

  switch (os) {
    case 'darwin': {
      // Prefer Homebrew, fall back to official script
      const hasBrew = tryExec('brew --version') !== null;
      if (hasBrew) {
        execSync('brew install ollama', { stdio: 'inherit' });
      } else {
        execSync('curl -fsSL https://ollama.com/install.sh | sh', { stdio: 'inherit' });
      }
      break;
    }
    case 'linux':
      execSync('curl -fsSL https://ollama.com/install.sh | sh', { stdio: 'inherit' });
      break;
    case 'win32':
      // winget is available on Windows 10 1709+ and Windows 11
      try {
        execSync('winget install Ollama.Ollama --silent --accept-source-agreements --accept-package-agreements', { stdio: 'inherit' });
      } catch {
        log('winget install failed. Download Ollama from https://ollama.com/download');
        process.exit(1);
      }
      break;
    default:
      log(`Unsupported platform: ${os}. Install Ollama manually: https://ollama.com/download`);
      process.exit(1);
  }

  // Verify installation
  if (!isOllamaInstalled()) {
    log('Installation succeeded but `ollama` is not on PATH. You may need to restart your terminal.');
    process.exit(1);
  }

  log('Ollama installed ✓');
}

/* ------------------------------------------------------------------ */
/*  3. Server lifecycle                                                */
/* ------------------------------------------------------------------ */

async function isOllamaRunning(base: string = OLLAMA_API): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForOllama(base: string = OLLAMA_API, timeoutMs = HEALTH_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOllamaRunning(base)) return;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new Error(`Ollama API did not become ready within ${timeoutMs / 1000}s`);
}

export async function ensureOllamaServing(opts?: ServeOptions): Promise<string> {
  const port = opts?.port ?? 11434;
  const base = `http://127.0.0.1:${port}`;

  if (await isOllamaRunning(base)) {
    debug('Ollama already running', opts);
    return base;
  }

  log('Starting Ollama server…');

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (port !== 11434) env.OLLAMA_HOST = `0.0.0.0:${port}`;

  const spawnOpts: SpawnOptions = {
    detached: true,
    stdio: 'ignore',
    env,
  };

  const child: ChildProcess = spawn('ollama', ['serve'], spawnOpts);
  child.unref();

  await waitForOllama(base);
  log(`Ollama server ready on ${base}`);
  return base;
}

/* ------------------------------------------------------------------ */
/*  4. Model pull                                                      */
/* ------------------------------------------------------------------ */

export async function isModelAvailable(model: string, base: string = OLLAMA_API): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/tags`);
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    return body.models?.some((m) => m.name === model || m.name.startsWith(`${model}:`)) ?? false;
  } catch {
    return false;
  }
}

export async function pullModel(model: string, base: string = OLLAMA_API): Promise<void> {
  log(`Pulling model "${model}"… (this may take a while on first run)`);

  const res = await fetch(`${base}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Failed to pull model: HTTP ${res.status}`);
  }

  // Stream progress to stderr
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let lastPercent = -1;
  let lastStatus = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n').filter(Boolean)) {
      try {
        const msg = JSON.parse(line) as {
          status?: string;
          completed?: number;
          total?: number;
          error?: string;
        };

        if (msg.error) throw new Error(`Pull failed: ${msg.error}`);

        if (msg.total && msg.completed) {
          const pct = Math.round((msg.completed / msg.total) * 100);
          if (pct !== lastPercent) {
            process.stderr.write(`\r[vibe-mcp] Downloading… ${pct}%`);
            lastPercent = pct;
          }
        } else if (msg.status && msg.status !== lastStatus) {
          // Only print new status transitions (e.g. "pulling manifest" → "verifying")
          // Skip repetitive "pulling <digest>" lines during download
          if (!msg.status.startsWith('pulling ') || msg.status === 'pulling manifest') {
            if (lastPercent >= 0) process.stderr.write('\n');
            log(msg.status);
            lastPercent = -1;
          }
          lastStatus = msg.status;
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue; // partial JSON
        throw e;
      }
    }
  }

  if (lastPercent >= 0) process.stderr.write('\n');

  log(`Model "${model}" ready ✓`);
}

/* ------------------------------------------------------------------ */
/*  5. Top-level orchestrator                                          */
/* ------------------------------------------------------------------ */

export async function serve(model: string, opts?: ServeOptions): Promise<void> {
  // 1. Ensure Ollama is installed
  if (!isOllamaInstalled()) {
    await installOllama(opts);
  }

  // 2. Ensure Ollama server is running
  const base = await ensureOllamaServing(opts);

  // 3. Pull model if not already available
  if (!(await isModelAvailable(model, base))) {
    await pullModel(model, base);
  } else {
    log(`Model "${model}" already available ✓`);
  }

  // 4. Done — print connection info
  const openaiBase = `${base}/v1`;
  console.error('');
  log('═══════════════════════════════════════════════════');
  log(`  Model:    ${model}`);
  log(`  API:      ${openaiBase}`);
  log(`  Health:   ${base}/api/tags`);
  log('');
  log('  Use with VibeBrowser extension:');
  log(`    Model provider → ollama`);
  log(`    Model name     → ${model}`);
  log('');
  log('  Use with vibe-cli:');
  log(`    npx tsx cli.ts run "your task" --model ollama:${model}`);
  log('');
  log('  OpenAI-compatible endpoint (for any client):');
  log(`    ${openaiBase}/chat/completions`);
  log('═══════════════════════════════════════════════════');
}
