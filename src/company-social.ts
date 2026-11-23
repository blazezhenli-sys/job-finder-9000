import { instanceBase, stripHtml } from './sources/mastodon.js';
import { config } from './config.js';
import { getPreferences, getRules, pool } from './db.js';
import { scoreCompanySocialPost } from './company-social-analysis.js';
import { events } from './pipeline-service.js';
import type { DetectionRule, Preferences } from './types.js';

export type CompanySocialPlatform = 'bluesky' | 'mastodon' | 'youtube' | 'linkedin' | 'facebook' | 'x';
type SocialLink = { id: string; employer_id: string; employer_name: string; platform: CompanySocialPlatform; profile_url: string };
type CompanySocialPost = { sourceId: string; authorId: string; authorName: string; authorHandle: string; authorUrl: string; sourceUrl: string; text: string; publishedAt: Date; raw: unknown };
type SocialPollResult = { status: 'completed' | 'failed'; postsSeen: number; newPosts: number; error?: string; retryAfterMs?: number };

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isRsshubPlatform(platform: CompanySocialPlatform): platform is 'linkedin' | 'facebook' | 'x' {
  return platform === 'linkedin' || platform === 'facebook' || platform === 'x';
}

class RsshubRateLimitError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
    this.name = 'RsshubRateLimitError';
  }
}

const rsshubCooldownUntil: Record<'linkedin' | 'facebook' | 'x', number> = { linkedin: 0, facebook: 0, x: 0 };
const youtubeChannelIdCache = new Map<string, string>();

function retryAfterMilliseconds(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : Math.max(0, timestamp - Date.now());
}

function looksRateLimited(platform: 'linkedin' | 'facebook' | 'x', status: number, body: string): boolean {
  if (status === 429) return true;
  if (status === 503 && (platform === 'facebook' || /rate[ -]?limit|too many requests|temporarily blocked|throttl|checkpoint|blocked/i.test(body))) return true;
  return status === 403 && /rate[ -]?limit|too many requests|temporarily blocked|throttl|checkpoint|blocked/i.test(body);
}

export function isRsshubEmptyFeed(body: string): boolean {
  return /this route is empty, please check the original site/i.test(body);
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
    posts.push({ sourceId: uri, authorId: did, authorName: String(author.displayName || handle), authorHandle: handle, authorUrl: `https://bsky.app/profile/${handle}`, sourceUrl: String(post.url || `https://bsky.app/profile/${handle}/post/${rkey}`), text: String(record.text), publishedAt, raw: itemValue });
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
    posts.push({ sourceId, authorId: String(account.id || handle), authorName: String(account.display_name || handle), authorHandle: handle, authorUrl: String(account.url || ''), sourceUrl: String(status.url || status.uri || ''), text: stripHtml(String(status.content)), publishedAt, raw: statusValue });
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

export function youtubeChannelId(profileUrl: string): string {
  const parsed = new URL(profileUrl);
  const segments = parsed.pathname.split('/').filter(Boolean).map(routePart);
  const first = segments[0]?.toLowerCase() ?? '';
  if (first === 'channel' && segments[1]?.startsWith('UC')) return segments[1];
  throw new Error(`Unsupported YouTube channel URL: ${profileUrl}`);
}

function extractYoutubeChannelId(html: string): string {
  const ids = new Set<string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (/\bitemprop\s*=\s*["']channelId["']/i.test(tag)) {
      const channelId = tag.match(/\bcontent\s*=\s*["'](UC[a-zA-Z0-9_-]+)["']/i)?.[1];
      if (channelId) ids.add(channelId);
    }
  }
  for (const match of html.matchAll(/(?:\\?"channelId\\?"\s*:\s*\\?")(UC[a-zA-Z0-9_-]+)/g)) ids.add(match[1]);
  for (const match of html.matchAll(/\/channel\/(UC[a-zA-Z0-9_-]+)/g)) ids.add(match[1]);
  if (ids.size !== 1) throw new Error('Could not resolve a unique YouTube channel ID');
  return [...ids][0];
}

async function resolveYoutubeChannelId(profileUrl: string): Promise<string> {
  const cached = youtubeChannelIdCache.get(profileUrl);
  if (cached) return cached;
  try {
    const direct = youtubeChannelId(profileUrl);
    youtubeChannelIdCache.set(profileUrl, direct);
    return direct;
  } catch {
    const response = await fetch(profileUrl, { headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'hiring-signal-discovery-youtube/0.1' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`YouTube channel lookup returned HTTP ${response.status}`);
    const channelId = extractYoutubeChannelId(await response.text());
    youtubeChannelIdCache.set(profileUrl, channelId);
    return channelId;
  }
}

export function parseYoutubeFeed(xml: string, cutoff: Date): CompanySocialPost[] {
  const posts: CompanySocialPost[] = [];
  const seen = new Set<string>();
  for (const block of feedBlocks(xml)) {
    const channelId = xmlTagValue(block, 'yt:channelId');
    const videoId = xmlTagValue(block, 'yt:videoId');
    const sourceUrl = xmlLinkValue(block);
    const sourceId = videoId || xmlTagValue(block, 'id') || sourceUrl;
    const publishedAt = new Date(xmlTagValue(block, 'published') || xmlTagValue(block, 'updated'));
    const text = stripHtml(xmlTagValue(block, 'media:description') || xmlTagValue(block, 'description') || xmlTagValue(block, 'content') || xmlTagValue(block, 'title'));
    if (!sourceId || !sourceUrl || !/^https?:\/\//i.test(sourceUrl) || Number.isNaN(publishedAt.getTime()) || publishedAt < cutoff || !text || seen.has(sourceId)) continue;
    seen.add(sourceId);
    const author = xmlTagValue(block, 'name') || xmlTagValue(block, 'author') || 'YouTube channel';
    posts.push({ sourceId, authorId: channelId || author, authorName: author, authorHandle: '', authorUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : '', sourceUrl, text, publishedAt, raw: { xml: block } });
  }
  return posts;
}

async function fetchYoutube(link: SocialLink, cutoff: Date): Promise<CompanySocialPost[]> {
  const channelId = await resolveYoutubeChannelId(link.profile_url);
  const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { headers: { Accept: 'application/atom+xml, application/xml, text/xml', 'User-Agent': 'hiring-signal-discovery-youtube/0.1' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`YouTube feed returned HTTP ${response.status}`);
  return parseYoutubeFeed(await response.text(), cutoff);
}

function routePart(value: string): string { return decodeURIComponent(value).trim(); }

export function rsshubFeedUrl(platform: 'linkedin' | 'facebook' | 'x', profileUrl: string): string {
  const parsed = new URL(profileUrl);
  const segments = parsed.pathname.split('/').filter(Boolean).map(routePart);
  let id = '';
  const facebookProfileSuffixes = new Set(['about', 'events', 'followers', 'following', 'mentions', 'photos', 'posts', 'reels', 'reviews', 'videos']);
  if (platform === 'x') {
    if (segments.length !== 1 || !segments[0] || ['compose', 'explore', 'hashtag', 'home', 'i', 'intent', 'login', 'messages', 'notifications', 'search', 'settings', 'share'].includes(segments[0].toLowerCase())) throw new Error(`Unsupported X profile URL: ${profileUrl}`);
    id = segments[0];
  } else if (platform === 'linkedin') {
    const hasPostsSuffix = segments.length === 3 && segments[2].toLowerCase() === 'posts';
    if (segments[0]?.toLowerCase() !== 'company' || !segments[1] || (segments.length !== 2 && !hasPostsSuffix)) throw new Error(`Unsupported LinkedIn company profile URL: ${profileUrl}`);
    id = segments[1];
  } else if (segments[0]?.toLowerCase() === 'pages' && segments.length === 3) {
    id = segments.at(-1) || '';
  } else if (segments[0]?.toLowerCase() === 'page' && segments[1] && segments.length === 2) {
    id = segments[1];
  } else if (segments[0]?.toLowerCase() === 'people' && segments.length === 3 && /^\d+$/.test(segments[2])) {
    id = segments[2];
  } else if (segments[0]?.toLowerCase() === 'profile.php') {
    id = parsed.searchParams.get('id') || '';
  } else if (segments.length === 2 && facebookProfileSuffixes.has(segments[1].toLowerCase())) {
    id = segments[0];
  } else if (segments.length === 1 && !['home', 'watch', 'marketplace', 'groups', 'events', 'login', 'share', 'reel', 'stories'].includes(segments[0].toLowerCase())) {
    id = segments[0];
  }
  if (!id) throw new Error(`Unsupported ${platform} profile URL: ${profileUrl}`);
  const route = platform === 'linkedin' ? `/linkedin/company/${encodeURIComponent(id)}/posts` : platform === 'x' ? `/twitter/user/${encodeURIComponent(id)}` : `/facebook/page/${encodeURIComponent(id)}`;
  return `${config.rsshubBaseUrl}${route}`;
}

function decodeXml(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/&#([0-9]+);/g, (_, number: string) => String.fromCodePoint(Number(number))).replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'");
}

function xmlTagValue(block: string, tag: string): string {
  const escaped = tag.replace(':', '\\:');
  const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? decodeXml(match[1]).trim() : '';
}

function xmlLinkValue(block: string): string {
  const linkTag = block.match(/<link\b([^>]*)\/?>(?:<\/link>)?/i);
  const href = linkTag?.[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  return decodeXml(href || xmlTagValue(block, 'link')).trim();
}

function feedBlocks(xml: string): string[] {
  return [...xml.matchAll(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1>/gi)].map((match) => match[0]);
}

function obviousReshare(block: string): boolean {
  return /\b(?:repost|reblog|reshare|shared|reply(?:ing)?\s+to)\b/i.test(stripHtml(decodeXml(`${xmlTagValue(block, 'title')} ${xmlTagValue(block, 'description')} ${xmlTagValue(block, 'content:encoded')} ${xmlTagValue(block, 'content')}`)));
}

export function parseRsshubFeed(xml: string, cutoff: Date): CompanySocialPost[] {
  const posts: CompanySocialPost[] = [];
  const seen = new Set<string>();
  for (const block of feedBlocks(xml)) {
    if (obviousReshare(block)) continue;
    const sourceUrl = xmlLinkValue(block);
    const guid = xmlTagValue(block, 'guid') || xmlTagValue(block, 'id') || sourceUrl;
    const publishedAt = new Date(xmlTagValue(block, 'pubDate') || xmlTagValue(block, 'published') || xmlTagValue(block, 'updated'));
    const text = stripHtml(xmlTagValue(block, 'content:encoded') || xmlTagValue(block, 'content') || xmlTagValue(block, 'description') || xmlTagValue(block, 'title'));
    if (!guid || !sourceUrl || !/^https?:\/\//i.test(sourceUrl) || Number.isNaN(publishedAt.getTime()) || publishedAt < cutoff || !text) continue;
    if (seen.has(guid)) continue;
    seen.add(guid);
    const author = xmlTagValue(block, 'dc:creator') || xmlTagValue(block, 'author') || 'Company account';
    posts.push({ sourceId: guid, authorId: author, authorName: author, authorHandle: '', authorUrl: '', sourceUrl, text, publishedAt, raw: { xml: block } });
  }
  return posts;
}

async function fetchRsshub(link: SocialLink & { platform: 'linkedin' | 'facebook' | 'x' }, cutoff: Date): Promise<CompanySocialPost[]> {
  const feedUrl = rsshubFeedUrl(link.platform, link.profile_url);
  const response = await fetch(feedUrl, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(config.companySocialRsshubTimeoutMs) });
  const body = await response.text();
  if (!response.ok) {
    const detail = body.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (isRsshubEmptyFeed(body)) return [];
    if (looksRateLimited(link.platform, response.status, body)) {
      const retryAfterMs = Math.max(config.companySocialRsshubRateLimitCooldownMs, retryAfterMilliseconds(response.headers.get('retry-after')));
      throw new RsshubRateLimitError(`RSSHub rate limited HTTP ${response.status}${detail ? `: ${detail}` : ''}`, retryAfterMs);
    }
    throw new Error(`RSSHub returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return parseRsshubFeed(body, cutoff);
}

async function fetchAccount(link: SocialLink, cutoff: Date): Promise<CompanySocialPost[]> {
  if (link.platform === 'bluesky') return fetchBluesky(link, cutoff);
  if (link.platform === 'mastodon') return fetchMastodon(link, cutoff);
  if (link.platform === 'youtube') return fetchYoutube(link, cutoff);
  if (isRsshubPlatform(link.platform)) return fetchRsshub(link as SocialLink & { platform: 'linkedin' | 'facebook' | 'x' }, cutoff);
  throw new Error(`Unsupported company social platform: ${link.platform}`);
}

async function finishTask(taskId: string, link: SocialLink, result: SocialPollResult) {
  await pool.query(`UPDATE company_social_poll_tasks SET status=$2, completed_at=now(), posts_seen=$3, new_posts=$4, error=$5 WHERE id=$1`, [taskId, result.status, result.postsSeen, result.newPosts, result.error ?? null]);
  const successIntervalMs = isRsshubPlatform(link.platform) ? config.companySocialRsshubPollIntervalMs : config.companySocialPollIntervalMs;
  const failureIntervalMs = result.retryAfterMs ?? (isRsshubPlatform(link.platform) ? config.companySocialRsshubPollIntervalMs : 3_600_000);
  if (result.status === 'completed') {
    await pool.query(`UPDATE company_social_links SET social_poll_last_attempted_at=now(), social_poll_last_success_at=now(), social_poll_next_at=now() + ($2::text || ' milliseconds')::interval, social_poll_error=NULL, social_poll_consecutive_failures=0, updated_at=now() WHERE id=$1`, [link.id, successIntervalMs]);
  } else {
    await pool.query(`UPDATE company_social_links SET social_poll_last_attempted_at=now(), social_poll_next_at=now() + ($2::text || ' milliseconds')::interval, social_poll_error=$3, social_poll_consecutive_failures=social_poll_consecutive_failures+1, updated_at=now() WHERE id=$1`, [link.id, failureIntervalMs, result.error ?? 'Social polling failed']);
  }
  events.emit('company-social-task', { taskId, employerId: link.employer_id, platform: link.platform, ...result });
}

async function queueDueTasks(platforms: CompanySocialPlatform[]): Promise<Array<{ taskId: string; link: SocialLink }>> {
  const nonXPlatforms = platforms.filter((platform) => platform !== 'x');
  const linkRows: SocialLink[] = [];
  if (nonXPlatforms.length) {
    const links = await pool.query(`SELECT l.id, l.employer_id, e.name AS employer_name, l.platform, l.profile_url
      FROM company_social_links l JOIN employers e ON e.id=l.employer_id
      WHERE l.is_active AND l.platform = ANY($1::text[])
        AND (l.social_poll_next_at IS NULL OR l.social_poll_next_at <= now())
      ORDER BY l.social_poll_next_at NULLS FIRST, l.last_seen_at DESC LIMIT 500`, [nonXPlatforms]);
    linkRows.push(...links.rows as SocialLink[]);
  }
  // X has a provider-wide limit. Queue one due account per scheduler cycle;
  // the X-enabled scheduler runs no more frequently than the configured
  // minimum queue interval below.
  if (platforms.includes('x')) {
    const xLinks = await pool.query(`SELECT l.id, l.employer_id, e.name AS employer_name, l.platform, l.profile_url
      FROM company_social_links l JOIN employers e ON e.id=l.employer_id
      WHERE l.is_active AND l.platform='x'
        AND (l.social_poll_next_at IS NULL OR l.social_poll_next_at <= now())
      ORDER BY l.social_poll_next_at NULLS FIRST, l.last_seen_at DESC LIMIT 1`);
    linkRows.push(...xLinks.rows as SocialLink[]);
  }
  const queued: Array<{ taskId: string; link: SocialLink }> = [];
  for (const row of linkRows) {
    const task = await pool.query(`INSERT INTO company_social_poll_tasks (employer_id, social_link_id, platform, profile_url, status)
      VALUES ($1,$2,$3,$4,'queued') ON CONFLICT DO NOTHING RETURNING id`, [row.employer_id, row.id, row.platform, row.profile_url]);
    if (task.rows[0]) queued.push({ taskId: task.rows[0].id, link: row });
  }
  return queued;
}

async function processTask(task: { taskId: string; link: SocialLink }) {
  await pool.query(`UPDATE company_social_poll_tasks SET status='running', started_at=now() WHERE id=$1`, [task.taskId]);
  events.emit('company-social-task', { taskId: task.taskId, employerId: task.link.employer_id, platform: task.link.platform, profileUrl: task.link.profile_url, status: 'running' });
  if (isRsshubPlatform(task.link.platform)) {
    const remainingCooldownMs = rsshubCooldownUntil[task.link.platform] - Date.now();
    if (remainingCooldownMs > 0) {
      await finishTask(task.taskId, task.link, { status: 'failed', postsSeen: 0, newPosts: 0, retryAfterMs: Math.max(config.companySocialRsshubRateLimitCooldownMs, remainingCooldownMs), error: `Deferred after RSSHub ${task.link.platform} rate limit; no request made` });
      return;
    }
  }
  const cutoff = new Date(Date.now() - config.companySocialRetentionDays * 86_400_000);
  try {
    const posts = await fetchAccount(task.link, cutoff);
    let newPosts = 0;
    let scoringConfig: Promise<[DetectionRule[], Preferences]> | undefined;
    for (const post of posts) {
      const inserted = await pool.query(`INSERT INTO company_social_posts
        (employer_id, social_link_id, platform, source_id, author_id, author_name, author_handle, author_url, source_url, text, published_at, raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (social_link_id, source_id) DO NOTHING RETURNING id`, [task.link.employer_id, task.link.id, task.link.platform, post.sourceId, post.authorId, post.authorName, post.authorHandle, post.authorUrl, post.sourceUrl, post.text, post.publishedAt, JSON.stringify(post.raw ?? {})]);
      if (!inserted.rows[0]) continue;
      newPosts++;
      scoringConfig ??= Promise.all([getRules(), getPreferences()]);
      const [rules, preferences] = await scoringConfig;
      const result = scoreCompanySocialPost(post.text, rules, preferences);
      await pool.query(`UPDATE company_social_posts
        SET analysis=$2, analyzed_at=now(), signal_category=$3, signal_quality=$4, signal_qualifies=$5
        WHERE id=$1 AND analysis IS NULL`, [inserted.rows[0].id, JSON.stringify(result.analysis), result.signalCategory, result.signalQuality, result.qualifies]);
    }
    await finishTask(task.taskId, task.link, { status: 'completed', postsSeen: posts.length, newPosts });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryAfterMs = error instanceof RsshubRateLimitError ? error.retryAfterMs : undefined;
    if (retryAfterMs && isRsshubPlatform(task.link.platform)) rsshubCooldownUntil[task.link.platform] = Date.now() + retryAfterMs;
    await finishTask(task.taskId, task.link, { status: 'failed', postsSeen: 0, newPosts: 0, retryAfterMs, error: message });
  }
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
    while (next < items.length) { const item = items[next++]; if (item) await worker(item); }
  }));
}

async function recoverStaleTasks() {
  const recovered = await pool.query(`
    WITH stale AS (
      SELECT id
      FROM company_social_poll_tasks
      WHERE status IN ('queued', 'running')
        AND COALESCE(started_at, queued_at) < now() - ($1::text || ' milliseconds')::interval
    ), recovered AS (
      UPDATE company_social_poll_tasks t
      SET status = 'failed',
          completed_at = now(),
          error = COALESCE(t.error, 'Recovered stale task after worker interruption')
      FROM stale s
      WHERE t.id = s.id
      RETURNING t.id, t.social_link_id, t.employer_id, t.platform, t.profile_url, t.error
    )
    UPDATE company_social_links l
    SET social_poll_last_attempted_at = now(),
        social_poll_next_at = now(),
        social_poll_error = r.error,
        social_poll_consecutive_failures = l.social_poll_consecutive_failures + 1,
        updated_at = now()
    FROM recovered r
    WHERE l.id = r.social_link_id
    RETURNING r.id, r.employer_id, r.platform, r.profile_url, r.error
  `, [config.companySocialStaleTaskMs]);

  for (const task of recovered.rows) {
    events.emit('company-social-task', {
      taskId: task.id,
      employerId: task.employer_id,
      platform: task.platform,
      profileUrl: task.profile_url,
      status: 'failed',
      postsSeen: 0,
      newPosts: 0,
      error: task.error,
    });
  }
  if (recovered.rowCount) console.warn(`Recovered ${recovered.rowCount} stale company social task(s)`);
}

async function pollCompanySocialLane(platforms: CompanySocialPlatform[], concurrency: number) {
  await recoverStaleTasks();
  await pool.query(`DELETE FROM company_social_posts WHERE published_at < now() - ($1::text || ' days')::interval`, [config.companySocialRetentionDays]);
  const queued = await queueDueTasks(platforms);
  await runWithConcurrency(queued, concurrency, processTask);
}

let running = false;
export async function pollCompanySocial() {
  if (running) return;
  running = true;
  try { await pollCompanySocialLane(['bluesky', 'mastodon', 'youtube'], config.companySocialConcurrency); }
  finally { running = false; }
}

let rsshubRunning = false;
export async function pollCompanySocialRsshub() {
  if (rsshubRunning) return;
  rsshubRunning = true;
  try {
    const platforms: CompanySocialPlatform[] = ['linkedin', 'facebook'];
    if (config.enableCompanySocialX) platforms.push('x');
    await pollCompanySocialLane(platforms, config.companySocialRsshubConcurrency);
  }
  finally { rsshubRunning = false; }
}

export function startCompanySocialPolling(intervalMs: number) {
  void pollCompanySocial().catch((error) => console.error('company social polling failed', error));
  return setInterval(() => void pollCompanySocial().catch((error) => console.error('company social polling failed', error)), intervalMs);
}

export function startCompanySocialRsshubPolling(intervalMs: number) {
  void pollCompanySocialRsshub().catch((error) => console.error('RSSHub company social polling failed', error));
  const schedulerIntervalMs = config.enableCompanySocialX ? config.companySocialXQueueIntervalMs : intervalMs;
  return setInterval(() => void pollCompanySocialRsshub().catch((error) => console.error('RSSHub company social polling failed', error)), schedulerIntervalMs);
}
