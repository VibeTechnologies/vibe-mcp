/**
 * CdpClient implementation that forwards raw CDP commands over a Unix socket to
 * the long-lived transparent proxy (proxy.ts). All command payloads are built on
 * the client side (in chrome-use-connection.ts); the proxy just relays them to
 * Chrome on its single approved connection. Because the proxy outlives individual
 * requests, Chrome's "Allow remote debugging?" dialog fires once per proxy
 * lifetime instead of once per request.
 *
 * Wire protocol: newline-delimited JSON. Request `{ id, method, params, sessionId? }`,
 * response `{ id, result }` or `{ id, error }`. Control methods are prefixed `__`
 * (e.g. `__status`, `__stop`) and are answered by the proxy without touching Chrome.
 *
 * Adapted from the chrome-use skill (scripts/lib/proxy-client.ts).
 */
import net from 'node:net';
import type { CdpClient } from './types.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ProxyClient implements CdpClient {
  private readonly socket: net.Socket;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly ready: Promise<void>;
  private isClosed = false;
  private readonly defaultTimeout: number;

  private constructor(socket: net.Socket, defaultTimeout: number) {
    this.socket = socket;
    this.defaultTimeout = defaultTimeout;
    socket.setEncoding('utf8');
    this.ready = new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', (e) => reject(e));
    });
    socket.on('data', (chunk) => this.onData(String(chunk)));
    socket.on('close', () => {
      this.isClosed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('Proxy connection closed'));
      }
      this.pending.clear();
    });
    socket.on('error', () => {
      /* surfaced via the ready promise / pending rejections */
    });
  }

  /** Open a client connection to the proxy socket and wait until connected. */
  static async open(socketPath: string, defaultTimeout = 320_000): Promise<ProxyClient> {
    const socket = net.createConnection({ path: socketPath });
    const client = new ProxyClient(socket, defaultTimeout);
    await client.ready;
    return client;
  }

  get connected(): boolean {
    return !this.isClosed;
  }

  /** The proxy relays request/response only; no CDP events are delivered. Nothing
   * in the chrome-use backend subscribes to events, so this is a no-op. */
  on(): () => void {
    return () => {};
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined) {
        p.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.isClosed) return Promise.reject(new Error('Proxy connection closed'));
    const id = this.nextId++;
    const frame: Record<string, unknown> = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, this.defaultTimeout);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.socket.write(JSON.stringify(frame) + '\n');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    this.isClosed = true;
    // Clear any pending request timers so they can't keep a one-shot CLI's event
    // loop alive after the socket is torn down.
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
  }
}
