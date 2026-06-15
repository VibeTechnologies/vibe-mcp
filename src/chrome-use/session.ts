/**
 * Browser/tab state for the long-lived MCP server process. Owns the single CDP
 * connection plus all attached page tabs and the active-tab pointer.
 *
 * Adapted from the `chrome-use` skill (skills/chrome-use/scripts/lib/session.ts),
 * with the cross-invocation /tmp active-file removed: the MCP server is a
 * long-lived process, so the active-tab pointer lives in memory here.
 */
import type { CdpClient, TabSession } from './types.js';

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

/** A page target we are willing to drive (skip devtools/extension surfaces). */
function drivable(t: TargetInfo): boolean {
  return (
    t.type === 'page' &&
    !t.url.startsWith('devtools://') &&
    !t.url.startsWith('chrome-extension://')
  );
}

export class SessionManager {
  readonly cdp: CdpClient;
  readonly tabs = new Map<string, TabSession>();
  activeTargetId: string | null = null;
  /** Sessions attached this connection, detached on dispose() to keep Chrome clean. */
  private readonly attached = new Set<string>();

  constructor(cdp: CdpClient) {
    this.cdp = cdp;
  }

  private async pages(): Promise<TargetInfo[]> {
    const { targetInfos } = await this.cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    return targetInfos.filter(drivable);
  }

  private async attach(targetId: string): Promise<string> {
    const { sessionId } = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    this.attached.add(sessionId);
    return sessionId;
  }

  /** Detach every session this connection created (best-effort). */
  async dispose(): Promise<void> {
    for (const sessionId of this.attached) {
      try {
        await this.cdp.send('Target.detachFromTarget', { sessionId });
      } catch {
        /* ignore */
      }
    }
    this.attached.clear();
    this.tabs.clear();
  }

  async syncTabs(): Promise<void> {
    const pages = await this.pages();
    const seen = new Set<string>();
    let i = 0;
    for (const p of pages) {
      i++;
      seen.add(p.targetId);
      const existing = this.tabs.get(p.targetId);
      if (existing) {
        existing.url = p.url;
        existing.tabId = 't' + i;
        continue;
      }
      const sessionId = await this.attach(p.targetId);
      this.tabs.set(p.targetId, {
        targetId: p.targetId,
        sessionId,
        url: p.url,
        tabId: 't' + i,
        refRegistry: new Map(),
      });
    }
    for (const targetId of [...this.tabs.keys()]) {
      if (!seen.has(targetId)) this.tabs.delete(targetId);
    }
    if (this.activeTargetId && !this.tabs.has(this.activeTargetId)) this.activeTargetId = null;
  }

  async getActiveTab(): Promise<TabSession> {
    await this.syncTabs();
    if (!this.tabs.size) throw new Error('No page open in Chrome');
    if (!this.activeTargetId || !this.tabs.has(this.activeTargetId)) {
      this.activeTargetId = [...this.tabs.keys()][0];
    }
    return this.tabs.get(this.activeTargetId)!;
  }

  async getTab(idOrIndex: string): Promise<TabSession | undefined> {
    if (!this.tabs.size) await this.syncTabs();
    for (const t of this.tabs.values()) if (t.tabId === idOrIndex) return t;
    const n = Number(idOrIndex);
    if (!Number.isNaN(n)) return [...this.tabs.values()][n];
    return undefined;
  }

  setActive(targetId: string): void {
    this.activeTargetId = targetId;
  }

  async newTab(url?: string): Promise<TabSession> {
    const { targetId } = await this.cdp.send<{ targetId: string }>('Target.createTarget', {
      url: url || 'about:blank',
    });
    const sessionId = await this.attach(targetId);
    this.setActive(targetId);
    const tab: TabSession = {
      targetId,
      sessionId,
      url: url || 'about:blank',
      tabId: 't' + (this.tabs.size + 1),
      refRegistry: new Map(),
    };
    this.tabs.set(targetId, tab);
    return tab;
  }

  async closeTab(targetId: string): Promise<void> {
    await this.cdp.send('Target.closeTarget', { targetId });
    this.tabs.delete(targetId);
    if (this.activeTargetId === targetId) this.activeTargetId = null;
  }
}
