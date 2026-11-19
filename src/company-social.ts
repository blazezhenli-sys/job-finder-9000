import { instanceBase, stripHtml } from './sources/mastodon.js';
import { config } from './config.js';
import { pool } from './db.js';
import { events } from './pipeline-service.js';

type SocialLink = { id: string; employer_id: string; employer_name: string; platform: 'bluesky' | 'mastodon'; profile_url: string };
type CompanySocialPost = { sourceId: string; authorId: string; authorName: string; authorHandle: string; authorUrl: string; sourceUrl: string; text: string; publishedAt: Date; raw: unknown };
type SocialPollResult = { status: 'completed' | 'failed'; postsSeen: number; newPosts: number; error?: string };

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Social API returned HTTP ${response.status}`);
  return response.json();
}

export function blueskyActor(profileUrl: string): string {
  const parsed = new URL(profileUrl);
  const match = parsed.pathname.match(/^\/profile\/([^/]+)/);
  if (!match) throw new Error(`Unsupported Bluesky profile URL: ${profileUrl}`);
  return decodeURIComponent(match[1]);
}

export function parseBlueskyFeed(payload: unknown, cutoff: Date): CompanySocialPost[] {
  const feed: unknown[] = Array.isArray(jsonObject(payload).feed) ? jsonObject(payload).feed as unknown[] : [];
  const posts: CompanySocialPost[] = [];
  for (const itemValue of feed) {
    const item = jsonObject(itemValue);
    const post = jsonObject(item.post);
    const author = jsonObject(post.author);
    const record = jsonObject(post.record);
    if (item.reason || record.reply || typeof record.text !== 'string') continue;
    const publishedAt = new Date(String(record.createdAt || post.indexedAt || ''));
    if (Number.isNaN(publishedAt.getTime()) || publishedAt < cutoff) continue;
    const uri = String(post.uri || '');
    const rkey = uri.split('/').at(-1) || '';
    const did = String(author.did || '');
    const handle = String(author.handle || did);
    if (!uri || !did) continue;
    posts.push({
      sourceId: uri,
      authorId: did,
      authorName: String(author.displayName || handle),
      authorHandle: handle,
      authorUrl: `https://bsky.app/profile/${handle}`,
      sourceUrl: String(post.url || `https://bsky.app/profile/${handle}/post/${rkey}`),
      text: String(record.text),
      publishedAt,
      raw: itemValue
    });
  }
  return posts;
}

async function fetchBluesky(link: SocialLink, cutoff: Date): Promise<CompanySocialPost[]> {
  const actor = blueskyActor(link.profile_url);
  const posts: CompanySocialPost[] = [];
  let cursor = '';
  while (posts.length < config.companySocialBackfillLimit) {
    const params = new URLSearchParams({ actor, limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const payload = await fetchJson(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?${params}`);
    const page = parseBlueskyFeed(payload, cutoff);
    posts.push(...page);
    const feed: unknown[] = Array.isArray(jsonObject(payload).feed) ? jsonObject(payload).feed as unknown[] : [];
    const oldest = page.at(-1)?.publishedAt;
    if (!feed.length || !jsonObject(payload).cursor || (oldest && oldest < cutoff)) break;
    cursor = String(jsonObject(payload).cursor);
  }
  return posts.slice(0, config.companySocialBackfillLimit);
}

function mastodonEndpoint(host: string): { url: string; accessToken: string } | undefined {
  return config.mastodonEndpoints.find((endpoint) => {
    try { return new URL(instanceBase(endpoint.url)).hostname.toLowerCase() === host.toLowerCase(); } catch { return false; }
  });
}

function mastodonProfile(profileUrl: string): { instance: string; account: string; endpoint?: { url: string; accessToken: string } } {
  const parsed = new URL(profileUrl);
  const match = parsed.pathname.match(/^\/@([^/]+)|^\/users\/([^/]+)/);
  const account = decodeURIComponent(match?.[1] || match?.[2] || '');
  if (!account) throw new Error(`Unsupported Mastodon profile URL: ${profileUrl}`);
  const instance = instanceBase(parsed.origin);
  return { instance, account, endpoint: mastodonEndpoint(parsed.hostname) };
}

export function parseMastodonStatuses(payload: unknown, cutoff: Date): CompanySocialPost[] {
  const statuses = Array.isArray(payload) ? payload : [];
  const posts: CompanySocialPost[] = [];
  for (const statusValue of statuses) {
    const status = jsonObject(statusValue);
    if (status.visibility !== 'public' || status.reblog || status.in_reply_to_id || typeof status.content !== 'string') continue;
    const publishedAt = new Date(String(status.created_at || ''));
    if (Number.isNaN(publishedAt.getTime()) || publishedAt < cutoff) continue;
    const account = jsonObject(status.account);
    const sourceId = String(status.id || '');
    if (!sourceId) continue;
    const handle = String(account.acct || account.username || '');
    posts.push({
      sourceId,
      authorId: String(account.id || handle),
      authorName: String(account.display_name || handle),
      authorHandle: handle,
      authorUrl: String(account.url || ''),
      sourceUrl: String(status.url || status.uri || ''),
      text: stripHtml(String(status.content)),
      publishedAt,
      raw: statusValue
    });
  }
  return posts;
}

async function fetchMastodon(link: SocialLink, cutoff: Date): Promise<CompanySocialPost[]> {
  const profile = mastodonProfile(link.profile_url);
  const headers: Record<string, string> = profile.endpoint?.accessToken ? { Authorization: `Bearer ${profile.endpoint.accessToken}` } : {};
  const accountPayload = await fetchJson(`${profile.instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(profile.account)}`, headers);
  const account = jsonObject(accountPayload);
  const accountId = String(account.id || '');
  if (!accountId) throw new Error(`Mastodon account not found: ${link.profile_url}`);
  const posts: CompanySocialPost[] = [];
  let maxId = '';
  while (posts.length < config.companySocialBackfillLimit) {
    const params = new URLSearchParams({ limit: '40', exclude_replies: 'true', exclude_reblogs: 'true' });
    if (maxId) params.set('max_id', maxId);
    const payload = await fetchJson(`${profile.instance}/api/v1/accounts/${encodeURIComponent(accountId)}/statuses?${params}`, headers);
    const page = parseMastodonStatuses(payload, cutoff);
    posts.push(...page);
    const statuses = Array.isArray(payload) ? payload : [];
    if (!statuses.length || statuses.length < 40 || (page.at(-1)?.publishedAt && page.at(-1)!.publishedAt < cutoff)) break;
    maxId = String(jsonObject(statuses.at(-1)).id || '');
    if (!maxId) break;
  }
  return posts.slice(0, config.companySocialBackfillLimit);
}

async function fetchAccount(link: SocialLink, cutoff: Date): Promise<CompanySocialPost[]> {
  return link.platform === 'bluesky' ? fetchBluesky(link, cutoff) : fetchMastodon(link, cutoff);
}

async function finishTask(taskId: string, link: SocialLink, result: SocialPollResult) {
  await pool.query(`UPDATE company_social_poll_tasks SET status=$2, completed_at=now(), posts_seen=$3, new_posts=$4, error=$5 WHERE id=$1`, [taskId, result.status, result.postsSeen, result.newPosts, result.error ?? null]);
  if (result.status === 'completed') {
    await pool.query(`UPDATE company_social_links SET social_poll_last_attempted_at=now(), social_poll_last_success_at=now(), social_poll_next_at=now() + ($2::text || ' milliseconds')::interval, social_poll_error=NULL, social_poll_consecutive_failures=0, updated_at=now() WHERE id=$1`, [link.id, config.companySocialPollIntervalMs]);
  } else {
    await pool.query(`UPDATE company_social_links SET social_poll_last_attempted_at=now(), social_poll_next_at=now() + interval '1 hour', social_poll_error=$2, social_poll_consecutive_failures=social_poll_consecutive_failures+1, updated_at=now() WHERE id=$1`, [link.id, result.error ?? 'Social polling failed']);
  }
  events.emit('company-social-task', { taskId, employerId: link.employer_id, platform: link.platform, ...result });
}

async function queueDueTasks(): Promise<Array<{ taskId: string; link: SocialLink }>> {
  const links = await pool.query(`SELECT l.id, l.employer_id, e.name AS employer_name, l.platform, l.profile_url
    FROM company_social_links l JOIN employers e ON e.id=l.employer_id
    WHERE l.is_active AND l.platform IN ('bluesky','mastodon')
      AND (l.social_poll_next_at IS NULL OR l.social_poll_next_at <= now())
    ORDER BY l.social_poll_next_at NULLS FIRST, l.last_seen_at DESC LIMIT 500`);
  const queued: Array<{ taskId: string; link: SocialLink }> = [];
  for (const row of links.rows as SocialLink[]) {
    const task = await pool.query(`INSERT INTO company_social_poll_tasks (employer_id, social_link_id, platform, profile_url, status)
      VALUES ($1,$2,$3,$4,'queued') ON CONFLICT DO NOTHING RETURNING id`, [row.employer_id, row.id, row.platform, row.profile_url]);
    if (task.rows[0]) queued.push({ taskId: task.rows[0].id, link: row });
  }
  return queued;
}

async function processTask(task: { taskId: string; link: SocialLink }) {
  await pool.query(`UPDATE company_social_poll_tasks SET status='running', started_at=now() WHERE id=$1`, [task.taskId]);
  events.emit('company-social-task', { taskId: task.taskId, employerId: task.link.employer_id, platform: task.link.platform, profileUrl: task.link.profile_url, status: 'running' });
  const cutoff = new Date(Date.now() - config.companySocialRetentionDays * 86_400_000);
  try {
    const posts = await fetchAccount(task.link, cutoff);
    let newPosts = 0;
    for (const post of posts) {
      const inserted = await pool.query(`INSERT INTO company_social_posts
        (employer_id, social_link_id, platform, source_id, author_id, author_name, author_handle, author_url, source_url, text, published_at, raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (social_link_id, source_id) DO NOTHING`, [task.link.employer_id, task.link.id, task.link.platform, post.sourceId, post.authorId, post.authorName, post.authorHandle, post.authorUrl, post.sourceUrl, post.text, post.publishedAt, JSON.stringify(post.raw ?? {})]);
      newPosts += inserted.rowCount ?? 0;
    }
    await finishTask(task.taskId, task.link, { status: 'completed', postsSeen: posts.length, newPosts });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishTask(task.taskId, task.link, { status: 'failed', postsSeen: 0, newPosts: 0, error: message });
  }
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
    while (next < items.length) { const item = items[next++]; if (item) await worker(item); }
  }));
}

let running = false;
export async function pollCompanySocial() {
  if (running) return;
  running = true;
  try {
    await pool.query(`DELETE FROM company_social_posts WHERE published_at < now() - ($1::text || ' days')::interval`, [config.companySocialRetentionDays]);
    const queued = await queueDueTasks();
    await runWithConcurrency(queued, config.companySocialConcurrency, processTask);
  } finally { running = false; }
}

export function startCompanySocialPolling(intervalMs: number) {
  void pollCompanySocial().catch((error) => console.error('company social polling failed', error));
  return setInterval(() => void pollCompanySocial().catch((error) => console.error('company social polling failed', error)), intervalMs);
}
