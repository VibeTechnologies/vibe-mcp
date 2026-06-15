/**
 * Zero-dependency Chrome DevTools Protocol client over Node's global WebSocket.
 *
 * Connects to the browser-level endpoint (ws://127.0.0.1:<port>/devtools/browser/<id>)
 * and uses flattened sessions: page-level commands carry a `sessionId` obtained via
 * Target.attachToTarget({ flatten: true }). No Puppeteer, no npm deps.
 *
 * Adapted from the `chrome-use` skill (skills/chrome-use/scripts/lib/cdp.ts).
 */
import type { CdpClient } from './types.js';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** Subset of the WHATWG WebSocket the CDP client relies on. */
interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: unknown) => void, opts?: { once?: boolean }): void;
}

/** Factory for a WebSocket; injectable for tests. Defaults to global WebSocket. */
export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_OPEN = 1;

export class Cdp implements CdpClient {
  private readonly ws: WebSocketLike;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>();
  private readonly openPromise: Promise<void>;
  private isClosed = false;

  private constructor(ws: WebSocketLike) {
    this.ws = ws;
    this.openPromise = new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket connection error')), { once: true });
    });
    ws.addEventListener('message', (ev) => this.onMessage(String((ev as { data: unknown }).data)));
    ws.addEventListener('close', () => {
      this.isClosed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  /** Connect to a browser-level ws endpoint and resolve once the socket is open. */
  static async connect(
    wsEndpoint: string,
    timeoutMs = 10_000,
    wsFactory?: WebSocketFactory,
  ): Promise<Cdp> {
    const make = wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    const ws = make(wsEndpoint);
    const client = new Cdp(ws);
    try {
      await withTimeout(client.openPromise, timeoutMs, `CDP connect timed out after ${timeoutMs}ms`);
    } catch (err) {
      // Close the dangling socket so it stops keeping the Node event loop alive
      // (otherwise the one-shot CLI hangs after printing the error).
      client.close();
      throw err;
    }
    return client;
  }

  get connected(): boolean {
    return !this.isClosed && this.ws.readyState === WS_OPEN;
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number;
      method?: string;
      params?: unknown;
      sessionId?: string;
      result?: unknown;
      error?: { message?: string; code?: number };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message ?? 'CDP error'} (code ${msg.error.code ?? '?'})`));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      const set = this.listeners.get(msg.method);
      if (set) {
        for (const fn of set) {
          try {
            fn(msg.params, msg.sessionId);
          } catch {
            /* listener errors are non-fatal */
          }
        }
      }
    }
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.isClosed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  on(method: string, handler: (params: unknown, sessionId?: string) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  close(): void {
    this.isClosed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
