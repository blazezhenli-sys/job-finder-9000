import { pool } from '../db.js';
import { config } from '../config.js';
import type { NormalizedPost } from '../types.js';
import type { SourceAdapter, SourceHealth } from './types.js';

interface HnItem { id: number; type?: string; by?: string; time?: number; title?: string; text?: string; url?: string; deleted?: boolean; dead?: boolean; }
const API = 'https://hacker-news.firebaseio.com/v0';

export class HackerNewsSource implements SourceAdapter {
  readonly source = 'hacker_news' as const;
  private stopped = false;
  private timer?: NodeJS.Timeout;

  async start(onPost: (post: NormalizedPost, cursor?: string, recovered?: boolean) => Promise<void>, onHealth: (health: Partial<SourceHealth>) => void) {
    this.stopped = false;
    await this.poll(onPost, onHealth);
    this.timer = setInterval(() => void this.poll(onPost, onHealth), config.hnPollIntervalMs);
  }

  private async poll(onPost: (post: NormalizedPost, cursor?: string, recovered?: boolean) => Promise<void>, onHealth: (health: Partial<SourceHealth>) => void) {
    if (this.stopped) return;
    try {
      const max = await fetch(`${API}/maxitem.json`).then((r) => r.json() as Promise<number>);
      const result = await pool.query('SELECT cursor FROM ingestion_states WHERE source = $1', [this.source]);
      const last = Number(result.rows[0]?.cursor ?? 0);
      const firstRun = !last;
      const start = firstRun ? Math.max(1, max - 99) : last + 1;
      // A first run is intentionally bounded to the latest 100 items to avoid a historical flood.
      const ids = Array.from({ length: Math.min(max - start + 1, firstRun ? 100 : 500) }, (_, index) => max - index).filter((id) => id >= start).reverse();
      for (const id of ids) {
        const item = await fetch(`${API}/item/${id}.json`).then((r) => r.json() as Promise<HnItem | null>);
        if (!item || item.deleted || item.dead || !item.by || (!item.title && !item.text)) continue;
        const text = [item.title, item.text?.replace(/<[^>]*>/g, ' ')].filter(Boolean).join('\n');
        await onPost({
          source: this.source,
          sourceId: String(item.id),
          authorId: item.by,
          authorName: item.by,
          authorHandle: item.by,
          authorUrl: `https://news.ycombinator.com/user?id=${encodeURIComponent(item.by)}`,
          sourceUrl: `https://news.ycombinator.com/item?id=${item.id}`,
          text,
          publishedAt: new Date((item.time ?? Date.now() / 1000) * 1000),
          raw: item
        }, String(item.id), firstRun);
      }
      await pool.query(`UPDATE ingestion_states SET cursor = $1, last_success_at = now(), updated_at = now(), last_error = NULL WHERE source = $2`, [String(max), this.source]);
      onHealth({ source: this.source, connected: true, lastEventAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), error: null });
    } catch (error) {
      onHealth({ source: this.source, connected: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); }
}
