import type { AtsProvider, NormalizedJobListing } from '../types.js';

export type IdentityConfidence = 'high' | 'medium' | 'low' | 'unknown';

export type CompanyIdentity = {
  name?: string;
  website?: string;
  domain?: string;
  confidence: IdentityConfidence;
  sources: string[];
  evidence: Record<string, unknown>;
};

// Include hosted-board and vendor-marketing domains. Neither is an employer
// identity, including their CDN/subdomain variants.
const atsDomains = new Set([
  'greenhouse.com', 'greenhouse.io', 'boards.greenhouse.io', 'job-boards.greenhouse.io',
  'ashbyhq.com', 'jobs.ashbyhq.com',
  'lever.co', 'jobs.lever.co'
]);
const blockedDomains = new Set(['linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com', 'github.com']);
const genericNames = /^(?:careers?|jobs?|job board|job openings?|greenhouse|ashby|lever|apply|home|homepage|company|our company)$/i;

function isAtsHost(host: string): boolean {
  return [...atsDomains].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function decodeHtml(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#x2F;|&#47;/gi, '/');
}

export function normalizeCompanyName(value: string): string {
  return text(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(incorporated|inc|corp|corporation|company|co|limited|ltd|llc|plc|gmbh|ag|s\.a\.?|p\.c\.?)\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

export function normalizeCompanyDomain(value: string): string {
  const raw = text(value);
  if (!raw) return '';
  let url: URL;
  try { url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { return ''; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  // A relative link such as `about-us` must not become a company domain.
  // Requiring a dotted hostname also filters localhost-like values and other
  // path fragments that URL() accepts as hosts when given a synthetic scheme.
  if (!host || !host.includes('.') || host.includes('..') || isAtsHost(host) || blockedDomains.has(host) || [...blockedDomains].some((domain) => host.endsWith(`.${domain}`))) return '';
  return host;
}

export function isAtsDomain(value: string): boolean {
  const raw = text(value);
  try {
    const host = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, '');
    return isAtsHost(host);
  } catch { return false; }
}

function websiteForDomain(domain: string): string {
  return domain ? `https://${domain}` : '';
}

function valueAt(source: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    const object = record(current);
    if (!object) return undefined;
    current = object[key];
  }
  return current;
}

function firstText(source: Record<string, unknown>, paths: string[][]): string {
  for (const path of paths) {
    const value = text(valueAt(source, path));
    if (value && !genericNames.test(value)) return value;
  }
  return '';
}

function firstDomain(source: Record<string, unknown>, paths: string[][]): string {
  for (const path of paths) {
    const value = normalizeCompanyDomain(text(valueAt(source, path)));
    if (value) return value;
  }
  return '';
}

const namePaths = [
  ['company_name'], ['companyName'], ['employer_name'], ['employerName'],
  ['company', 'display_name'], ['company', 'name'], ['employer', 'name'],
  ['organization', 'name'], ['hiringOrganization', 'name'], ['hiring_organization', 'name']
];
const domainPaths = [
  ['company_website'], ['companyWebsite'], ['company_url'], ['companyUrl'], ['employer_website'], ['employerWebsite'],
  ['company', 'website'], ['company', 'url'], ['company', 'domain'], ['employer', 'website'], ['employer', 'url'],
  ['organization', 'url'], ['organization', 'website'], ['organization', 'publicWebsite'], ['organization', 'customJobsPageUrl'],
  ['hiringOrganization', 'url'], ['hiringOrganization', 'website'], ['hiringOrganization', 'publicWebsite'], ['hiring_organization', 'url'],
  ['website'], ['domain']
];

export function identityFromPayload(value: unknown, source = 'ats_payload'): CompanyIdentity {
  const sourceRecord = record(value);
  if (!sourceRecord) return { confidence: 'unknown', sources: [], evidence: {} };
  const name = firstText(sourceRecord, namePaths);
  const domain = firstDomain(sourceRecord, domainPaths);
  return {
    ...(name ? { name } : {}),
    ...(domain ? { domain, website: websiteForDomain(domain) } : {}),
    confidence: name && domain ? 'high' : name || domain ? 'medium' : 'unknown',
    sources: name || domain ? [source] : [],
    evidence: name || domain ? { source, name, domain } : {}
  };
}

function mergeIdentities(values: CompanyIdentity[]): CompanyIdentity {
  const usable = values.filter((value) => value.name || value.domain);
  const names = new Map<string, { value: string; count: number; sources: Set<string> }>();
  const domains = new Map<string, { value: string; count: number; sources: Set<string> }>();
  for (const value of usable) {
    if (value.name) {
      const key = normalizeCompanyName(value.name);
      if (key) {
        const current = names.get(key) ?? { value: value.name, count: 0, sources: new Set<string>() };
        current.count += 1; value.sources.forEach((source) => current.sources.add(source)); names.set(key, current);
      }
    }
    if (value.domain) {
      const current = domains.get(value.domain) ?? { value: value.domain, count: 0, sources: new Set<string>() };
      current.count += 1; value.sources.forEach((source) => current.sources.add(source)); domains.set(value.domain, current);
    }
  }
  const name = [...names.values()].sort((a, b) => b.count - a.count || a.value.length - b.value.length)[0];
  const domain = [...domains.values()].sort((a, b) => b.count - a.count || a.value.length - b.value.length)[0];
  const sources = [...new Set([...usable.flatMap((value) => value.sources)])];
  const evidence = { observations: usable.map((value) => value.evidence).filter((value) => Object.keys(value).length) };
  return {
    ...(name ? { name: name.value } : {}),
    ...(domain ? { domain: domain.value, website: websiteForDomain(domain.value) } : {}),
    confidence: name && domain ? (sources.includes('ats_board_page') || sources.includes('ats_payload') ? 'high' : 'medium') : name || domain ? 'medium' : 'unknown',
    sources,
    evidence
  };
}

export function identityFromListings(listings: NormalizedJobListing[]): CompanyIdentity {
  const identities: CompanyIdentity[] = listings.map((listing) => {
    const fromPayload = identityFromPayload(listing.raw);
    const rawContent = record(listing.raw)?.content;
    const content = [typeof rawContent === 'string' ? rawContent : '', listing.descriptionHtml ?? ''].filter(Boolean).join('\n');
    const decodedContent = decodeHtml(content);
    const contentDomain = anchorWebsite(decodedContent) || textWebsite(decodedContent);
    const contentIdentity: CompanyIdentity = contentDomain
      ? { domain: contentDomain, website: websiteForDomain(contentDomain), confidence: 'medium', sources: ['ats_payload'], evidence: { listingContentDomain: contentDomain } }
      : { confidence: 'unknown', sources: [], evidence: {} };
    const merged = mergeCompanyIdentities(fromPayload, contentIdentity);
    if (listing.companyName && !merged.name) return { ...merged, name: listing.companyName, confidence: merged.domain ? 'high' : 'medium', sources: [...merged.sources, 'ats_payload'], evidence: { ...merged.evidence, listingCompanyName: listing.companyName } };
    return merged;
  });
  return mergeIdentities(identities);
}

function jsonLdValues(html: string): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  const scripts = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scripts)) {
    try {
      const parsed: unknown = JSON.parse(decodeHtml(match[1]));
      const visit = (value: unknown) => {
        if (Array.isArray(value)) return value.forEach(visit);
        const object = record(value); if (!object) return;
        values.push(object);
        if (object['@graph']) visit(object['@graph']);
      };
      visit(parsed);
    } catch { /* A page may contain invalid or templated JSON-LD. */ }
  }
  return values;
}

function metaValue(html: string, key: string): string {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  return decodeHtml(html.match(pattern)?.[1] ?? '');
}

function titleValue(html: string): string {
  return decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/<[^>]+>/g, '').trim();
}

function assignedJsonObject(html: string, assignment: string): Record<string, unknown> | undefined {
  const assignmentIndex = html.indexOf(assignment);
  if (assignmentIndex < 0) return undefined;
  const start = html.indexOf('{', assignmentIndex + assignment.length);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(html.slice(start, index + 1));
        return record(parsed);
      } catch { return undefined; }
    }
  }
  return undefined;
}

function nameFromTitle(title: string, provider: AtsProvider): string {
  const cleaned = text(title).replace(/\s+/g, ' ');
  const explicit = cleaned.match(/^(?:careers?|jobs?|job openings?)\s+(?:at|with|for)\s+([^|–—-]+)/i)?.[1]
    ?? cleaned.match(/^(.+?)\s+(?:careers?|jobs?|job openings?)$/i)?.[1];
  const candidates = [explicit ?? '', ...cleaned.split(/\s*[|–—-]\s*/g)];
  const providerName = provider === 'greenhouse' ? 'greenhouse' : provider;
  return candidates.map((candidate) => candidate.replace(new RegExp(`\\b${providerName}\\b`, 'ig'), '').replace(/[|]+$/, '').trim()).find((candidate) => candidate && !genericNames.test(candidate) && !genericPageName(candidate) && candidate.length > 2) ?? '';
}

function anchorWebsite(html: string): string {
  const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let best: { domain: string; score: number } | undefined;
  for (const match of html.matchAll(anchors)) {
    const attributes = match[1];
    const href = decodeHtml(attributes.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? '').trim();
    // Only absolute links are evidence of a public company website. Relative
    // paths are common in career sites and are not domains.
    if (!/^https?:\/\//i.test(href)) continue;
    const domain = normalizeCompanyDomain(href);
    if (!domain) continue;
    const label = text(match[2].replace(/<[^>]+>/g, ''));
    const context = `${label} ${attributes}`;
    let score = 0;
    if (/company|website|homepage|visit|about|learn more|logo|home/i.test(context)) score += 10;
    try {
      if (/\b(?:careers?|jobs?|openings?|opportunities|join|work-with-us)\b/i.test(new URL(href).pathname)) score += 8;
    } catch { /* the absolute URL was already normalized above */ }
    if (!score) continue;
    if (!best || score > best.score) best = { domain, score };
  }
  return best?.domain ?? '';
}

function textWebsite(value: string): string {
  let best: { domain: string; score: number } | undefined;
  for (const match of value.matchAll(/https?:\/\/[^\s<>'"]+/gi)) {
    const href = match[0].replace(/[),.;!?]+$/, '');
    const domain = normalizeCompanyDomain(href);
    if (!domain) continue;
    let score = 0;
    try {
      if (/\b(?:careers?|jobs?|openings?|opportunities|join|work-with-us)\b/i.test(new URL(href).pathname)) score += 8;
    } catch { continue; }
    const context = value.slice(Math.max(0, (match.index ?? 0) - 100), match.index ?? 0);
    if (/company|website|homepage|visit|about|learn more|logo|home/i.test(context)) score += 10;
    if (score && (!best || score > best.score)) best = { domain, score };
  }
  return best?.domain ?? '';
}

function companyNameFromDomain(domain: string): string {
  const label = domain.split('.')[0] ?? '';
  return label.replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase()).trim();
}

function genericPageName(value: string): boolean {
  const normalized = normalizeCompanyName(value);
  return !normalized || /^(explore|open|join|careers|jobs|jobopenings|careersat|joinourteam|workwithus|pagenotfound|pagetitle|justamoment)/.test(normalized);
}

export function identityFromAtsHtml(html: string, provider: AtsProvider): CompanyIdentity {
  const observations: CompanyIdentity[] = [];
  if (provider === 'ashby') {
    const appData = assignedJsonObject(html, 'window.__appData');
    if (appData?.organization) observations.push(identityFromPayload({ organization: appData.organization }, 'ats_board_page'));
  }
  for (const value of jsonLdValues(html)) {
    const type = text(value['@type']).toLowerCase();
    const nested = record(value.hiringOrganization) ?? record(value.organization);
    const source = nested ? { organization: nested, hiringOrganization: nested } : { organization: value };
    if (type.includes('organization') || type.includes('jobposting') || nested) observations.push(identityFromPayload(source, 'ats_board_page'));
  }
  const siteName = metaValue(html, 'og:site_name') || metaValue(html, 'application-name');
  const titleName = nameFromTitle(titleValue(html), provider);
  const domain = anchorWebsite(html);
  if (siteName && !genericNames.test(siteName)) observations.push({ name: siteName, confidence: domain ? 'high' : 'medium', sources: ['ats_board_page'], evidence: { meta: 'site_name', name: siteName } });
  if (titleName) observations.push({ name: titleName, confidence: domain ? 'high' : 'medium', sources: ['ats_board_title'], evidence: { title: titleValue(html), name: titleName } });
  if (domain) observations.push({ domain, website: websiteForDomain(domain), confidence: titleName || siteName ? 'high' : 'medium', sources: ['ats_board_page'], evidence: { anchorDomain: domain } });
  return mergeIdentities(observations);
}

export function mergeCompanyIdentities(...values: CompanyIdentity[]): CompanyIdentity {
  return mergeIdentities(values);
}

function publicBoardUrl(provider: Extract<AtsProvider, 'greenhouse' | 'ashby' | 'lever'>, identifier: string): string {
  if (provider === 'greenhouse') return `https://boards.greenhouse.io/${encodeURIComponent(identifier)}`;
  if (provider === 'ashby') return `https://jobs.ashbyhq.com/${encodeURIComponent(identifier)}`;
  return `https://jobs.lever.co/${encodeURIComponent(identifier)}`;
}

export async function resolveAtsBoardIdentity(provider: Extract<AtsProvider, 'greenhouse' | 'ashby' | 'lever'>, identifier: string, listings: NormalizedJobListing[] = []): Promise<CompanyIdentity> {
  const fromListings = identityFromListings(listings);
  if (fromListings.name && fromListings.domain) return fromListings;
  try {
    const response = await fetch(publicBoardUrl(provider, identifier), { headers: { Accept: 'text/html', 'User-Agent': 'hiring-signal-discovery-identity/0.1' }, signal: AbortSignal.timeout(15_000) });
    const finalDomain = normalizeCompanyDomain(response.url);
    const pageIdentity = response.ok ? identityFromAtsHtml(await response.text(), provider) : { confidence: 'unknown' as const, sources: [], evidence: {} };
    const merged = mergeCompanyIdentities(fromListings, pageIdentity);
    if (finalDomain) {
      const redirectName = companyNameFromDomain(finalDomain);
      const name = merged.name && !genericPageName(merged.name) ? merged.name : redirectName;
      return {
        ...(name ? { name } : {}),
        domain: finalDomain,
        website: websiteForDomain(finalDomain),
        confidence: name ? 'high' : 'medium',
        sources: [...new Set([...merged.sources, 'ats_redirect'])],
        evidence: { ...merged.evidence, redirect: { url: response.url, domain: finalDomain, name: redirectName } }
      };
    }
    if (response.ok) return merged;
  } catch { /* Identity discovery should never make a listing poll fail. */ }
  return fromListings;
}
