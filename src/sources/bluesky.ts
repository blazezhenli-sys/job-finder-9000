import WebSocket from 'ws';
import { pool } from '../db.js';
import { config } from '../config.js';
import type { NormalizedPost } from '../types.js';
import type { SourceAdapter, SourceHealth } from './types.js';

interface JetstreamEvent { did?: string; time_us?: number; kind?: string; commit?: { collection?: string; rkey?: string; record?: { text?: string; createdAt?: string; langs?: string[] } } }

export class BlueskySource implements SourceAdapter {
  readonly source = 'bluesky' as const;
  private socket?: WebSocket;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;
  private queue: Array<{ post: NormalizedPost; cursor?: string }> = [];
  private draining = false;

  async start(onPost: (post: NormalizedPost, cursor?: string, recovered?: boolean) => Promise<void>, onHealth: (health: Partial<SourceHealth>) => void) {
    this.stopped = false;
    const state = await pool.query('SELECT cursor FROM ingestion_states WHERE source = $1', [this.source]);
    await this.connect(onPost, onHealth, state.rows[0]?.cursor || undefined);
  }

  private async connect(onPost: (post: NormalizedPost, cursor?: string, recovered?: boolean) => Promise<void>, onHealth: (health: Partial<SourceHealth>) => void, cursor?: string) {
    if (this.stopped) return;
    const separator = config.jetstreamUrl.includes('?') ? '&' : '?';
    const url = `${config.jetstreamUrl}${cursor ? `${separator}cursor=${encodeURIComponent(cursor)}` : ''}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.on('open', () => onHealth({ source: this.source, connected: true, error: null }));
    socket.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString()) as JetstreamEvent;
        if (event.kind !== 'commit' || event.commit?.collection !== 'app.bsky.feed.post' || !event.commit.record?.text || !event.did || !event.commit.rkey) return;
        const publishedAt = new Date(event.commit.record.createdAt ?? Date.now());
        const post: NormalizedPost = {
          source: this.source,
          sourceId: `at://${event.did}/app.bsky.feed.post/${event.commit.rkey}`,
          authorId: event.did,
          authorName: event.did,
          authorHandle: event.did,
          authorUrl: `https://bsky.app/profile/${event.did}`,
          sourceUrl: `https://bsky.app/profile/${event.did}/post/${event.commit.rkey}`,
          text: event.commit.record.text,
          publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
          raw: event
        };
        const eventCursor = event.time_us ? String(event.time_us) : undefined;
        if (this.queue.length >= 500) this.queue.shift();
        this.queue.push({ post, cursor: eventCursor });
        void this.drain(onPost, onHealth, Boolean(cursor));
      } catch (error) {
        onHealth({ source: this.source, error: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on('close', () => {
      onHealth({ source: this.source, connected: false });
      if (!this.stopped) this.reconnectTimer = setTimeout(async () => {
        const latest = await pool.query('SELECT cursor FROM ingestion_states WHERE source = $1', [this.source]);
        await this.connect(onPost, onHealth, latest.rows[0]?.cursor || cursor);
      }, 2_000);
    });
    socket.on('error', (error) => onHealth({ source: this.source, connected: false, error: error.message }));
  }

  private async drain(onPost: (post: NormalizedPost, cursor?: string, recovered?: boolean) => Promise<void>, onHealth: (health: Partial<SourceHealth>) => void, recovered: boolean) {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.queue.length) {
        const item = this.queue.shift();
        if (!item) continue;
        await onPost(item.post, item.cursor, recovered);
        onHealth({ source: this.source, lastEventAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString() });
      }
    } catch (error) {
      onHealth({ source: this.source, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.draining = false;
      if (!this.stopped && this.queue.length) void this.drain(onPost, onHealth, recovered);
    }
  }

  stop() { this.stopped = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.socket?.close(); }
}
