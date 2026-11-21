import { isIP } from 'node:net';
import { extractEmails, type EmailObservation } from './emails.js';

export type SocialPlatform = 'linkedin' | 'x' | 'github' | 'bluesky' | 'mastodon' | 'youtube' | 'instagram' | 'facebook' | 'tiktok' | 'threads';

export type SocialLink = { platform: SocialPlatform; profileUrl: string; sourceUrl: string };
export type CompanyEnrichment = { socialLinks: SocialLink[]; careerUrl: string; emails: EmailObservation[]; scannedEmailPageUrls: string[]; pagesFetched: number };

const socialHosts: Array<[SocialPlatform, Set<string>]> = [
  ['linkedin', new Set(['linkedin.com'])],
  ['x', new Set(['x.com', 'twitter.com'])],
  ['github', new Set(['github.com'])],
  ['bluesky', new Set(['bsky.app'])],
  ['youtube', new Set(['youtube.com', 'youtu.be'])],
  ['instagram', new Set(['instagram.com'])],
  ['facebook', new Set(['facebook.com', 'fb.com'])],
  ['tiktok', new Set(['tiktok.com'])],
  ['threads', new Set(['threads.net'])],
  ['mastodon', new Set(['mastodon.social', 'hachyderm.io', 'infosec.exchange', 'fosstodon.org', 'mstdn.social', 'mastodon.online'])]
];

const socialHostsByName = new Map(socialHosts.flatMap(([platform, hosts]) => [...hosts].map((host) => [host, platform] as const)));
const instagramNonProfileRoutes = new Set(['accounts', 'about', 'ar', 'challenge', 'direct', 'developer', 'emails', 'explore', 'legal', 'oauth', 'p', 'privacy', 'reel', 'reels', 'session', 'stories', 'tv', 'web']);
const xNonProfileRoutes = new Set(['compose', 'explore', 'hashtag', 'home', 'i', 'intent', 'login', 'messages', 'notifications', 'search', 'settings', 'share']);
const facebookProfileSuffixes = new Set(['about', 'events', 'followers', 'following', 'mentions', 'photos', 'posts', 'reels', 'reviews', 'videos']);

function text(value: unknown): string { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''; }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function decodeHtml(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function attribute(attributes: string, name: string): string {
  return decodeHtml(attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1] ?? '');
}

function isUnsafeCompanyUrl(value: URL): boolean {
  const host = value.hostname.toLowerCase();
  if (value.protocol !== 'http:' && value.protocol !== 'https:') return true;
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const addressType = isIP(host);
  if (addressType === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (addressType === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  return false;
}

function socialPlatform(value: string): SocialPlatform | undefined {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const known = socialHostsByName.get(host);
    if (known) return known;
    if (parsed.pathname.startsWith('/@') && (host.includes('mastodon') || host.endsWith('.social'))) return 'mastodon';
  } catch { /* ignore malformed links */ }
  return undefined;
}

function isSocialProfileUrl(value: string, platform: SocialPlatform): boolean {
  if (platform !== 'instagram') return true;
  try {
    const segments = new URL(value).pathname.split('/').filter(Boolean);
    const handle = segments[0]?.toLowerCase() ?? '';
    return segments.length === 1 && /^[a-z0-9._]{1,30}$/i.test(handle) && !instagramNonProfileRoutes.has(handle);
  } catch { return false; }
}

function canonicalSocialPath(parsed: URL, platform: SocialPlatform): string {
  const segments = parsed.pathname.split('/').filter(Boolean);
  const first = segments[0]?.toLowerCase() ?? '';
  if (!segments.length) return '';
  if (platform === 'linkedin') {
    if (['company', 'showcase', 'in'].includes(first) && segments[1]) return `/${first}/${segments[1]}`;
    return '';
  }
  if (platform === 'x') {
    if (xNonProfileRoutes.has(first)) return '';
    return `/${segments[0]}`;
  }
  if (platform === 'facebook') {
    if (first === 'profile.php') return parsed.searchParams.has('id') ? '/profile.php' : '';
    if (first === 'pages' || first === 'people' || first === 'page') return parsed.pathname.replace(/\/+$/, '') || '/';
    if (segments.length === 1 || (segments.length === 2 && facebookProfileSuffixes.has(segments[1].toLowerCase()))) return `/${segments[0]}`;
    return '';
  }
  if (platform === 'bluesky' && first === 'profile' && segments[1]) return `/profile/${segments[1]}`;
  if (platform === 'youtube') {
    if (first === 'channel' && segments[1]) return `/channel/${segments[1]}`;
    if (segments[0].startsWith('@')) return `/${segments[0]}`;
    if (['c', 'user'].includes(first) && segments[1]) return `/${first}/${segments[1]}`;
    return '';
  }
  if (platform === 'mastodon' && segments[0].startsWith('@')) return `/${segments[0]}`;
  return parsed.pathname.replace(/\/+$/, '') || '/';
}

function normalizeSocialUrl(value: string, sourceUrl: string): string {
  try {
    const parsed = new URL(value, sourceUrl);
    const platform = socialPlatform(parsed.href);
    if (isUnsafeCompanyUrl(parsed) || !platform || !isSocialProfileUrl(parsed.href, platform)) return '';
    const canonicalPath = canonicalSocialPath(parsed, platform);
    if (!canonicalPath) return '';
    parsed.hash = '';
    if (!(platform === 'facebook' && parsed.pathname.toLowerCase() === '/profile.php' && parsed.searchParams.has('id'))) parsed.search = '';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (platform === 'x') parsed.hostname = 'x.com';
    parsed.pathname = canonicalPath;
    return parsed.href;
  } catch { return ''; }
}

function normalizePublicUrl(value: string, sourceUrl: string): string {
  try {
    const parsed = new URL(value, sourceUrl);
    if (isUnsafeCompanyUrl(parsed)) return '';
    parsed.hash = '';
    parsed.search = '';
    return parsed.href;
  } catch { return ''; }
}

function sameSite(value: string, sourceUrl: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    const sourceHost = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, '');
    return host === sourceHost || host.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${host}`);
  } catch { return false; }
}

export function extractRelevantPageUrls(html: string, sourceUrl: string, maxPages = 8): string[] {
  const candidates = new Map<string, { url: string; score: number }>();
  const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchors)) {
    const href = normalizePublicUrl(attribute(match[1], 'href'), sourceUrl);
    if (!href || !sameSite(href, sourceUrl)) continue;
    try {
      const parsed = new URL(href);
      if (parsed.href === new URL(sourceUrl).href || parsed.pathname === '/') continue;
      const label = text(match[2].replace(/<[^>]+>/g, ''));
      const context = `${label} ${parsed.pathname}`;
      if (!/\b(contact|about|team|career|careers|jobs?|hiring|recruit(?:ing)?|work-with-us|join-us|people)\b/i.test(context)) continue;
      let score = 0;
      if (/\b(contact|about|career|careers|jobs?|hiring|recruit(?:ing)?|team)\b/i.test(label)) score += 10;
      if (/\b(contact|about|team|career|careers|jobs?|hiring|recruit(?:ing)?|work-with-us|join-us|people)\b/i.test(parsed.pathname)) score += 6;
      const current = candidates.get(parsed.href);
      if (!current || current.score < score) candidates.set(parsed.href, { url: parsed.href, score });
    } catch { /* ignore malformed links */ }
  }
  return [...candidates.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url)).slice(0, maxPages).map((candidate) => candidate.url);
}

export function extractCareerUrl(html: string, sourceUrl: string): string {
  let best: { url: string; score: number } | undefined;
  const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchors)) {
    const href = normalizePublicUrl(attribute(match[1], 'href'), sourceUrl);
    if (!href || socialPlatform(href)) continue;
    const label = text(match[2].replace(/<[^>]+>/g, ''));
    let score = 0;
    if (/\b(careers?|jobs?|open roles?|openings?|opportunities|join (?:our|the) team|work with us)\b/i.test(label)) score += 10;
    try {
      const path = new URL(href).pathname;
      if (/\b(careers?|jobs?|openings?|opportunities|join|work-with-us)\b/i.test(path)) score += 6;
    } catch { /* normalized URLs should parse, but a bad link should not stop enrichment */ }
    if (score && (!best || score > best.score)) best = { url: href, score };
  }
  return best?.url ?? '';
}

function jsonLdObjects(html: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  const scripts = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scripts)) {
    try {
      const visit = (value: unknown) => {
        if (Array.isArray(value)) return value.forEach(visit);
        const current = record(value); if (!current) return;
        objects.push(current);
        if (current['@graph']) visit(current['@graph']);
        for (const nested of Object.values(current)) if (nested && typeof nested === 'object') visit(nested);
      };
      visit(JSON.parse(decodeHtml(match[1])));
    } catch { /* ignore malformed JSON-LD */ }
  }
  return objects;
}

export function extractSocialLinks(html: string, sourceUrl: string): SocialLink[] {
  const found = new Map<string, SocialLink>();
  const add = (value: unknown) => {
    const raw = text(value);
    const url = normalizeSocialUrl(raw, sourceUrl);
    if (!url) return;
    const platform = socialPlatform(url);
    if (!platform) return;
    found.set(`${platform}:${url}`, { platform, profileUrl: url, sourceUrl });
  };
  for (const object of jsonLdObjects(html)) {
    const sameAs = object.sameAs;
    if (Array.isArray(sameAs)) sameAs.forEach(add);
    else add(sameAs);
  }
  const anchors = /<a\b([^>]*)>[\s\S]*?<\/a>/gi;
  for (const match of html.matchAll(anchors)) add(attribute(match[1], 'href'));
  const links = /<link\b([^>]*)>/gi;
  for (const match of html.matchAll(links)) if (/\brel\s*=\s*["'][^"']*\bme\b/i.test(match[1])) add(attribute(match[1], 'href'));
  return [...found.values()].sort((a, b) => a.platform.localeCompare(b.platform) || a.profileUrl.localeCompare(b.profileUrl));
}

function publicHttpUrl(value: string): URL {
  const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  if (isUnsafeCompanyUrl(parsed)) throw new Error('Company website is not a public HTTP(S) URL');
  parsed.hash = '';
  return parsed;
}

async function readLimitedBody(response: Response, maxBytes = 2_000_000): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new Error('Company homepage exceeded the 2 MB limit'); }
    chunks.push(next.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fetchCompanyPage(website: string, sameSiteAs?: string): Promise<{ url: string; html: string }> {
  let url = publicHttpUrl(website);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(url, { redirect: 'manual', headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'hiring-signal-discovery-company-enrichment/0.1' }, signal: AbortSignal.timeout(20_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Company website redirected without a location (HTTP ${response.status})`);
      const redirected = publicHttpUrl(new URL(location, url).href);
      if (sameSiteAs && !sameSite(redirected.href, sameSiteAs)) throw new Error('Company page redirected off the company site');
      url = redirected;
      continue;
    }
    if (!response.ok) throw new Error(`Company website returned HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !/html|xhtml/i.test(contentType)) return { url: url.href, html: '' };
    return { url: url.href, html: await readLimitedBody(response) };
  }
  throw new Error('Company website exceeded the redirect limit');
}

export async function fetchCompanySocialLinks(website: string): Promise<SocialLink[]> {
  return (await fetchCompanyEnrichment(website)).socialLinks;
}

export async function fetchCompanyEnrichment(website: string): Promise<CompanyEnrichment> {
  const homepage = await fetchCompanyPage(website);
  if (!homepage.html) return { socialLinks: [], careerUrl: '', emails: [], scannedEmailPageUrls: [homepage.url], pagesFetched: 1 };
  const pages: Array<{ url: string; html: string }> = [homepage];
  for (const pageUrl of extractRelevantPageUrls(homepage.html, homepage.url)) {
    try {
      const page = await fetchCompanyPage(pageUrl, homepage.url);
      if (page.html) pages.push(page);
    } catch {
      // The homepage remains a successful enrichment source. Failed linked
      // pages are omitted from the scan so their previous observations remain active.
    }
  }
  const socialLinks = [...new Map(pages.flatMap((page) => extractSocialLinks(page.html, page.url)).map((link) => [`${link.platform}:${link.profileUrl}`, link])).values()]
    .sort((a, b) => a.platform.localeCompare(b.platform) || a.profileUrl.localeCompare(b.profileUrl));
  const careerUrl = pages.map((page) => extractCareerUrl(page.html, page.url)).find(Boolean) ?? '';
  const emails = pages.flatMap((page) => extractEmails(page.html, page.url, 'company_page'))
    .sort((a, b) => a.email.localeCompare(b.email) || a.sourceUrl.localeCompare(b.sourceUrl));
  return { socialLinks, careerUrl, emails, scannedEmailPageUrls: pages.map((page) => page.url), pagesFetched: pages.length };
}
