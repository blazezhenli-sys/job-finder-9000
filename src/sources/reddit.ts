import { Buffer } from 'node:buffer';
import { config } from '../config.js';
import type { NormalizedPost } from '../types.js';
import type { SourceAdapter, SourceHealth } from './types.js';

interface RedditChild { kind?: string; data?: { id?: string; name?: string; title?: string; selftext?: string; body?: string; author?: string; permalink?: string; link_permalink?: string; created_utc?: number; subreddit?: string; url?: string } }
interface RedditListing { data?: { children?: RedditChild[] } }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function redditPostUrl(permalink: string | undefined): string { return permalink ? `https://www.reddit.com${permalink}` : 'https://www.reddit.com'; }

export class RedditSource implements SourceAdapter {
  readonly source = 'reddit' as const;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private token = '';
  private initial = true;

  async start(onPost: (post: NormalizedPost, cursor?: string, recovered?: boolean) => Promise<void>, onHealth: (health: Partial<SourceHealth>) => void) {
    this.stopped = false;
    if (!config.redditClientId || !config.redditClientSecret) {
      onHealth({ source: this.source, connected: false, error: 'REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are required when Reddit is enabled' });
      return;
    }
    await this.poll(onPost, onHealth);
    if (!this.stopped) this.timer = setInterval(() => void this.poll(onPost, onHealth), config.redditPollIntervalMs);
  }

  private async accessToken() {
    const basic = Buffer.from(`${config.redditClientId}:${config.redditClientSecret}`).toString('base64');
    const response = await fetch('https://www.reddit.com/api/v1/access_token', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': config.redditUserAgent }, body: 'grant_type=client_credentials' });
    if (!response.ok) throw new Error(`Reddit OAuth returned HTTP ${response.status}`);
    const body = await response.json() as { access_token?: string };
    if (!body.access_token) throw new Error('Reddit OAuth response did not include an access token');
    this.token = body.access_token;
  }

  private async listing(path: string): Promise<RedditListing> {
    if (!this.token) await this.accessToken();
    let response = await fetch(`https://oauth.reddit.com${path}`, { headers: { Authorization: `Bearer ${this.token}`, 'User-Agent': config.redditUserAgent } });
    if (response.status === 401) { await this.accessToken(); response = await fetch(`https://oauth.reddit.com${path}`, { headers: { Authorization: `Bearer ${this.token}`, 'User-Agent': config.redditUserAgent } }); }
    if (!response.ok) throw new Error(`Reddit API returned HTTP ${response.status} for ${path}`);
    return await response.json() as RedditListing;
  }

  private async poll(onPost: (post: NormalizedPost, cursor?: string, recovered?: boolean) => Promise<void>, onHealth: (health: Partial<SourceHealth>) => void) {
    if (this.stopped) return;
    try {
      for (const subreddit of config.redditSubreddits) {
        const paths = [`/r/${encodeURIComponent(subreddit)}/new.json?limit=100&raw_json=1`, `/r/${encodeURIComponent(subreddit)}/comments.json?limit=100&raw_json=1`];
        for (const path of paths) {
          const listing = await this.listing(path);
          for (const child of listing.data?.children ?? []) {
            const data = child.data;
            if (!data?.id || !data.created_utc || !data.author || (!data.title && !data.body && !data.selftext)) continue;
            const isComment = child.kind === 't1' || Boolean(data.body);
            const text = isComment ? data.body || '' : [data.title, data.selftext].filter(Boolean).join('\n');
            const permalink = data.permalink || data.link_permalink;
            await onPost({
              source: this.source,
              sourceId: data.name || `${isComment ? 't1' : 't3'}_${data.id}`,
              authorId: data.author,
              authorName: data.author,
              authorHandle: `u/${data.author}`,
              authorUrl: `https://www.reddit.com/user/${encodeURIComponent(data.author)}`,
              sourceUrl: redditPostUrl(permalink),
              text,
              publishedAt: new Date(data.created_utc * 1000),
              raw: { subreddit, kind: child.kind, data }
            }, `${subreddit}:${data.name || data.id}`, this.initial);
          }
          await sleep(250);
        }
      }
      this.initial = false;
      onHealth({ source: this.source, connected: true, lastEventAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), error: null });
    } catch (error) {
      onHealth({ source: this.source, connected: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); }
}
