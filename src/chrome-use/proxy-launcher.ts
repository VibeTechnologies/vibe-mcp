/**
 * Lifecycle helpers for the long-lived chrome-use CDP proxy.
 *
 * The proxy (proxy.ts) is a background daemon that holds the single approved CDP
 * connection to Chrome and relays frames over a Unix socket. Both the `--devtools`
 * MCP server and the one-shot `browser --devtools` CLI connect to the SAME socket,
 * so Chrome's "Allow remote debugging?" dialog fires once per proxy lifetime and
 * is shared across every client — never once per request.
 *
 * Adapted from the chrome-use skill (scripts/cli.ts ensureProxy/proxyAlive).
 */
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ProxyClient } from './proxy-client.js';

/** Unix socket the proxy listens on. Namespaced to vibe so it never collides with
 * the standalone chrome-use skill's own proxy. Overridable for tests. */
export function getSocketPath(): string {
  return process.env.VIBE_CHROME_USE_SOCKET ?? `/tmp/vibe-chrome-use-${os.userInfo().uid}.sock`;
}

/** Absolute path to the compiled proxy entry (dist/chrome-use/proxy.js). */
export function getProxyPath(): string {
  return fileURLToPath(new URL('./proxy.js', import.meta.url));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Probe whether a proxy answers a control `__status` within `timeoutMs`. */
export async function proxyAlive(socketPath: string, timeoutMs = 2000): Promise<boolean> {
  let client: ProxyClient | null = null;
  try {
    client = await ProxyClient.open(socketPath, timeoutMs);
    const status = await client.send<{ socketPath?: string }>('__status');
    return Boolean(status);
  } catch {
    return false;
  } finally {
    client?.close();
  }
}

/**
 * Ensure the proxy is running, starting it (detached double-fork) if not. Polls
 * until it answers `__status` or the attempt budget is exhausted.
 * @throws if the proxy does not come up in time.
 */
export async function ensureProxy(
  socketPath = getSocketPath(),
  proxyPath = getProxyPath(),
  extraEnv: Record<string, string> = {},
): Promise<void> {
  if (await proxyAlive(socketPath, 2000)) return;

  const child = spawn(process.execPath, [proxyPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...extraEnv, VIBE_CHROME_USE_SOCKET: socketPath },
  });
  child.unref();

  // The proxy connects to Chrome eagerly and waits up to 5 min for the one-time
  // approval dialog. We only need it to be LISTENING here; the first CDP command
  // through ProxyClient blocks on the approval. Poll the socket for ~10s.
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    if (await proxyAlive(socketPath, 2000)) return;
  }
  throw new Error(
    `chrome-use proxy did not start in time (socket ${socketPath}).\n` +
      'Make sure Chrome 144+ is running and remote debugging is allowed at chrome://inspect/#remote-debugging.',
  );
}
