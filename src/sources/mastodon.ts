import WebSocket from 'ws';
import { config } from '../config.js';
import type { NormalizedPost } from '../types.js';
import type { SourceAdapter, SourceHealth } from './types.js';

interface MastodonStatus { id: string; created_at: string; content?: string; url?: string; uri?: string; visibility?: string; account?: { id?: string; username?: string; acct?: string; display_name?: string; url?: string } }
interface MastodonFrame { event?: string; payload?: string }
interface MastodonInstance { configuration?: { urls?: { streaming?: string } } }

export function instanceBase(value: string): string { const input = /^https?:\/\//i.test(value) ? value : `https://${value}`; return new URL(input).origin; }
export function stripHtml(value: string): string { return value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&rsquo;|&#39;|&#x27;/gi, "'").replace(/&lsquo;/gi, "'").replace(/&ldquo;/gi, '"').replace(/&rdquo;/gi, '"').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim(); }

export class MastodonSource implements SourceAdapter {
  readonly source = 'mastodon' as const;
  private stopped = false;
  private sockets = new Set<WebSocket>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  async start(onPost: (post: NormalizedPost, cursor?: string, recovered?: boolean) => Promise<void>, onHealth: (health: Partial<SourceHealth>) => void) {
    this.stopped = false;
    for (const endpoint of config.mastodonEndpoints) {
      let instance: string;
      try { instance = instanceBase(endpoint.url); } catch (error) { onHealth({ source: this.source, error: `Invalid Mastodon instance ${endpoint.url}: ${String(error)}` }); continue; }
      if (!endpoint.accessToken) { onHealth({ source: this.source, connected: false, error: `No token configured for Mastodon endpoint ${instance}` }); continue; }
      void this.connect(instance, endpoint.accessToken, onPost, onHealth, false);
    }
  }

  private async connect(instance: string, accessToken: string, onPost: (post: NormalizedPost, cursor?: string, recovered?: boolean) => Promise<void>, onHealth: (health: Partial<SourceHealth>) => void, recovered: boolean) {
    if (this.stopped) return;
    const streamingBase = await this.streamingBase(instance);
    const socket = new WebSocket(`${streamingBase}/api/v1/streaming?stream=public`, { headers: { Authorization: `Bearer ${accessToken}` } });
    this.sockets.add(socket);
    socket.on('open', () => onHealth({ source: this.source, connected: true, lastSuccessAt: new Date().toISOString(), error: null }));
    socket.on('message', (data) => {
      try {
        const frame = JSON.parse(data.toString()) as MastodonFrame;
        if (frame.event !== 'update' || !frame.payload) return;
        const status = JSON.parse(frame.payload) as MastodonStatus;
        if (!status.id || status.visibility !== 'public' || !status.account) return;
        const publishedAt = new Date(status.created_at);
        void onPost({ source: this.source, sourceId: `${instance}|${status.id}`, authorId: status.account.id || status.account.acct || status.account.username, authorName: status.account.display_name || status.account.acct || status.account.username || 'unknown', authorHandle: status.account.acct || status.account.username || '', authorUrl: status.account.url || '', sourceUrl: status.url || status.uri || `${instance}/@${status.account.acct}/${status.id}`, text: stripHtml(status.content || ''), publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt, raw: { instance, status } }, status.id, recovered).then(() => onHealth({ source: this.source, lastEventAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString() })).catch((error) => onHealth({ source: this.source, error: error instanceof Error ? error.message : String(error) }));
      } catch (error) { onHealth({ source: this.source, error: error instanceof Error ? error.message : String(error) }); }
    });
    socket.on('error', (error) => onHealth({ source: this.source, connected: false, error: error.message }));
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (!this.stopped && !this.reconnectTimers.has(instance)) {
        onHealth({ source: this.source, connected: false });
        const timer = setTimeout(() => { this.reconnectTimers.delete(instance); void this.connect(instance, accessToken, onPost, onHealth, true); }, 3_000);
        this.reconnectTimers.set(instance, timer);
      }
    });
  }

  private async streamingBase(instance: string): Promise<string> {
    try {
      const response = await fetch(`${instance}/api/v2/instance`);
      if (response.ok) {
        const metadata = await response.json() as MastodonInstance;
        if (metadata.configuration?.urls?.streaming) return metadata.configuration.urls.streaming.replace(/\/$/, '');
      }
    } catch { /* Use the instance origin when metadata is unavailable. */ }
    return instance.replace(/^http/i, 'ws');
  }

  stop() { this.stopped = true; for (const timer of this.reconnectTimers.values()) clearTimeout(timer); this.reconnectTimers.clear(); for (const socket of this.sockets) socket.close(); this.sockets.clear(); }
}
