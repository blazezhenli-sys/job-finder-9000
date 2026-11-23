import { config } from '../config.js';
import { pool } from '../db.js';
import { isRsshubEmptyFeed, parseRsshubFeed } from '../company-social.js';
import type { NormalizedPost } from '../types.js';
import type { SourceAdapter, SourceHealth } from './types.js';

export const defaultXSearchQuery = `("we're hiring" OR "we are hiring" OR "now hiring" OR "join our team" OR "hiring engineers" OR "looking for developers") -is:retweet lang:en`;

export function xSearchFeedUrl(query = config.xSearchQuery): string {
  return `${config.rsshubBaseUrl}/twitter/keyword/${encodeURIComponent(query)}`;
}

export function parseXSearchFeed(xml: string, cutoff: Date): NormalizedPost[] {
  return parseRsshubFeed(xml, cutoff).map((post) => ({
    source: 'x',
    sourceId: post.sourceId,
    authorId: post.authorId,
    authorName: post.authorName,
    authorHandle: post.authorHandle,
    authorUrl: post.authorUrl,
    sourceUrl: post.sourceUrl,
    text: post.text,
    publishedAt: post.publishedAt,
    raw: post.raw
  }));
}

export class XSearchSource implements SourceAdapter {
  readonly source = 'x' as const;
  private stopped = false;
  private polling = false;
  private timer?: NodeJS.Timeout;

  async start(onPost: (post: NormalizedPost, cursor?: string, recovered?: boolean) => Promise<void>, onHealth: (health: Partial<SourceHealth>) => void) {
    this.stopped = false;
    await this.poll(onPost, onHealth);
    if (!this.stopped) this.timer = setInterval(() => void this.poll(onPost, onHealth), config.xPostPollIntervalMs);
  }

  private async poll(onPost: (post: NormalizedPost, cursor?: string, recovered?: boolean) => Promise<void>, onHealth: (health: Partial<SourceHealth>) => void) {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const state = await pool.query('SELECT last_success_at FROM ingestion_states WHERE source=$1', [this.source]);
      const firstRun = !state.rows[0]?.last_success_at;
      const response = await fetch(xSearchFeedUrl(), { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(config.xPostRequestTimeoutMs) });
      const body = await response.text();
      if (!response.ok) {
        if (isRsshubEmptyFeed(body)) {
          await this.markSuccess(onHealth);
          return;
        }
        const detail = body.replace(/\s+/g, ' ').trim().slice(0, 240);
        throw new Error(`X search RSSHub returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      const cutoff = new Date(Date.now() - config.xPostRetentionDays * 86_400_000);
      const posts = parseXSearchFeed(body, cutoff);
      for (const post of posts) await onPost(post, post.sourceId, firstRun);
      await pool.query(`UPDATE ingestion_states SET cursor=$1, last_success_at=now(), last_event_at=now(), last_error=NULL, updated_at=now() WHERE source=$2`, [posts[0]?.sourceId ?? null, this.source]);
      onHealth({ source: this.source, connected: true, lastEventAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), error: null });
    } catch (error) {
      onHealth({ source: this.source, connected: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.polling = false;
    }
  }

  private async markSuccess(onHealth: (health: Partial<SourceHealth>) => void) {
    await pool.query(`UPDATE ingestion_states SET last_success_at=now(), last_event_at=now(), last_error=NULL, updated_at=now() WHERE source=$1`, [this.source]);
    onHealth({ source: this.source, connected: true, lastEventAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), error: null });
  }

  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); }
}
