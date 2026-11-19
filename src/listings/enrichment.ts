import { isIP } from 'node:net';

export type SocialPlatform = 'linkedin' | 'x' | 'github' | 'bluesky' | 'mastodon' | 'youtube' | 'instagram' | 'facebook' | 'tiktok' | 'threads';

export type SocialLink = { platform: SocialPlatform; profileUrl: string; sourceUrl: string };
export type CompanyEnrichment = { socialLinks: SocialLink[]; careerUrl: string };

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

function normalizeSocialUrl(value: string, sourceUrl: string): string {
  try {
    const parsed = new URL(value, sourceUrl);
    const platform = socialPlatform(parsed.href);
    if (isUnsafeCompanyUrl(parsed) || !platform || !isSocialProfileUrl(parsed.href, platform)) return '';
    parsed.hash = '';
    if (!(platform === 'facebook' && parsed.pathname.toLowerCase() === '/profile.php' && parsed.searchParams.has('id'))) parsed.search = '';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
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

export async function fetchCompanySocialLinks(website: string): Promise<SocialLink[]> {
  return (await fetchCompanyEnrichment(website)).socialLinks;
}

export async function fetchCompanyEnrichment(website: string): Promise<CompanyEnrichment> {
  let url = publicHttpUrl(website);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(url, { redirect: 'manual', headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'hiring-signal-discovery-company-enrichment/0.1' }, signal: AbortSignal.timeout(20_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Company website redirected without a location (HTTP ${response.status})`);
      url = publicHttpUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new Error(`Company website returned HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !/html|xhtml/i.test(contentType)) return { socialLinks: [], careerUrl: '' };
    const html = await readLimitedBody(response);
    return { socialLinks: extractSocialLinks(html, url.href), careerUrl: extractCareerUrl(html, url.href) };
  }
  throw new Error('Company website exceeded the redirect limit');
}
