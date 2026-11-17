import type { AtsProvider, JobBoard, NormalizedJobListing, WorkMode } from '../types.js';
import { config } from '../config.js';

export interface AtsAdapter {
  provider: AtsProvider;
  fetch(board: JobBoard): Promise<NormalizedJobListing[]>;
}

const userAgent = 'hiring-signal-discovery-listings/0.1';

function date(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 10_000_000_000 ? value * 1000 : value);
  if (typeof value === 'string' && value.trim()) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed; }
  return null;
}

export function stripListingHtml(value: string): string {
  return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&rsquo;/gi, "'").replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function workMode(text: string, explicit?: unknown): WorkMode {
  const value = String(explicit ?? '').toLowerCase();
  if (value.includes('hybrid')) return 'hybrid';
  if (value.includes('remote')) return 'remote';
  if (value.includes('on-site') || value.includes('onsite') || value.includes('office')) return 'onsite';
  const hybrid = /\bhybrid\b/i.test(text);
  const remote = /\bremote|distributed|work from anywhere\b/i.test(text);
  const onsite = /\bon[- ]?site|in[- ]office|office[- ]based\b/i.test(text);
  return hybrid || (remote && onsite) ? 'hybrid' : remote ? 'remote' : onsite ? 'onsite' : 'unknown';
}

function stringValue(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }

export type NormalizedCompensation = { min?: number; max?: number; currency?: string; period?: string; estimated?: boolean; description?: string };

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[$€£¥₹,\s]/g, '').trim();
  if (!cleaned) return undefined;
  const multiplier = /k$/i.test(cleaned) ? 1_000 : 1;
  const parsed = Number(cleaned.replace(/k$/i, '')) * multiplier;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCompensationText(value: string): NormalizedCompensation {
  const numbers = [...value.matchAll(/(?:[$€£¥₹]\s*)?(\d[\d,]*(?:\.\d+)?\s*[kK]?)/g)].map((match) => numericValue(match[1])).filter((number): number is number => number !== undefined);
  const currency = value.match(/\b(USD|EUR|GBP|CAD|AUD|SGD|HKD|TWD|JPY|CNY|INR)\b/i)?.[1]?.toUpperCase() || (value.match(/[$€£¥₹]/)?.[0] ?? '');
  const period = value.match(/\b(hour|hourly|day|daily|week|weekly|month|monthly|year|annual|annually)\b/i)?.[1]?.toLowerCase();
  return { min: numbers[0], max: numbers[1] ?? numbers[0], currency: currency || undefined, period, estimated: /estimate|predicted/i.test(value), description: value };
}

export function normalizeCompensation(value: unknown): NormalizedCompensation {
  if (typeof value === 'string') return parseCompensationText(value);
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  const nested = source.range && typeof source.range === 'object' ? source.range as Record<string, unknown> : source;
  const description = stringValue(source.description || source.summary || source.salaryDescription);
  const parsed = description ? parseCompensationText(description) : {};
  const min = numericValue(nested.min ?? nested.minimum ?? nested.salary_min) ?? parsed.min;
  const max = numericValue(nested.max ?? nested.maximum ?? nested.salary_max) ?? parsed.max;
  const currency = stringValue(nested.currency || nested.currencyCode || nested.currency_code) || parsed.currency;
  const period = stringValue(nested.period || nested.interval || nested.payPeriod || nested.frequency) || parsed.period;
  const estimated = Boolean(nested.estimated ?? nested.isEstimated ?? nested.salary_is_predicted ?? parsed.estimated);
  return { min, max, currency: currency || undefined, period: period || undefined, estimated, description: description || undefined };
}

function locations(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => typeof item === 'string' ? [item] : item && typeof item === 'object' ? [stringValue((item as { location?: unknown }).location)] : []).filter(Boolean);
  return value && typeof value === 'object' ? [stringValue((value as { name?: unknown }).name)].filter(Boolean) : [stringValue(value)].filter(Boolean);
}

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': userAgent }, signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`ATS request returned HTTP ${response.status}`);
  return await response.json();
}

export function parseGreenhouseJobs(payload: unknown): NormalizedJobListing[] {
  const jobs = Array.isArray((payload as { jobs?: unknown[] })?.jobs) ? (payload as { jobs: Record<string, unknown>[] }).jobs : [];
  return jobs.filter((job) => job.id != null && stringValue(job.title)).map((job) => {
    const html = stringValue(job.content);
    const location = stringValue((job.location as { name?: unknown } | undefined)?.name ?? job.location);
    const offices = Array.isArray(job.offices) ? job.offices.flatMap((office) => [stringValue((office as { location?: unknown }).location), stringValue((office as { name?: unknown }).name)]).filter(Boolean) : [];
    const description = stripListingHtml(html);
    return { providerJobId: String(job.id), title: stringValue(job.title), descriptionHtml: html, description, department: Array.isArray(job.departments) ? job.departments.map((item) => stringValue((item as { name?: unknown }).name)).filter(Boolean).join(', ') : '', location, secondaryLocations: [...new Set(offices.filter((item) => item !== location))], remoteMode: workMode([location, description].join('\n')), applicationUrl: stringValue(job.absolute_url), originalUrl: stringValue(job.absolute_url), publishedAt: date(job.first_published), updatedAt: date(job.updated_at), raw: job };
  });
}

export function parseAshbyJobs(payload: unknown): NormalizedJobListing[] {
  const jobs = Array.isArray((payload as { jobs?: unknown[] })?.jobs) ? (payload as { jobs: Record<string, unknown>[] }).jobs : [];
  return jobs.filter((job) => stringValue(job.jobUrl || job.applyUrl) && stringValue(job.title)).map((job) => {
    const secondary = Array.isArray(job.secondaryLocations) ? job.secondaryLocations.flatMap((item) => [stringValue(item), stringValue((item as { location?: unknown }).location)]).filter(Boolean) : [];
    const location = stringValue(job.location);
    const description = stripListingHtml(stringValue(job.description || job.descriptionHtml || job.body));
    return { providerJobId: String(job.id || job.jobUrl || job.applyUrl), title: stringValue(job.title), descriptionHtml: stringValue(job.descriptionHtml || job.description), description, department: stringValue(job.department), team: stringValue(job.team), location, secondaryLocations: [...new Set(secondary.filter((item) => item !== location))], remoteMode: workMode([location, description].join('\n'), job.isRemote ? 'remote' : job.workplaceType), employmentType: stringValue(job.employmentType || job.employmentStatus), compensation: job.compensation, applicationUrl: stringValue(job.applyUrl || job.jobUrl), originalUrl: stringValue(job.jobUrl || job.applyUrl), publishedAt: date(job.publishedAt || job.published_at), updatedAt: date(job.updatedAt || job.updated_at), raw: job };
  });
}

export function parseLeverJobs(payload: unknown): NormalizedJobListing[] {
  const jobs = Array.isArray(payload) ? payload as Record<string, unknown>[] : Array.isArray((payload as { data?: unknown[] })?.data) ? (payload as { data: Record<string, unknown>[] }).data : [];
  return jobs.filter((job) => stringValue(job.id) && stringValue(job.text)).map((job) => {
    const categories = (job.categories ?? {}) as Record<string, unknown>;
    const descriptionHtml = stringValue(job.description || job.descriptionHtml || job.descriptionBody);
    const description = stripListingHtml(stringValue(job.descriptionPlain || descriptionHtml));
    const location = stringValue(categories.location || job.location);
    return { providerJobId: String(job.id), title: stringValue(job.text), descriptionHtml, description, department: stringValue(categories.department), team: stringValue(categories.team), location, remoteMode: workMode([location, description].join('\n'), job.workplaceType), employmentType: stringValue(categories.commitment || job.commitment), seniority: stringValue(categories.level), compensation: job.salaryRange || (job.salaryDescription ? { description: job.salaryDescription } : undefined), applicationUrl: stringValue(job.applyUrl || (job.urls as { apply?: unknown } | undefined)?.apply), originalUrl: stringValue(job.hostedUrl || (job.urls as { show?: unknown } | undefined)?.show), publishedAt: date(job.createdAt), updatedAt: date(job.updatedAt), raw: job };
  });
}

export function parseRemotiveJobs(payload: unknown): NormalizedJobListing[] {
  const jobs = Array.isArray((payload as { jobs?: unknown[] })?.jobs) ? (payload as { jobs: Record<string, unknown>[] }).jobs : [];
  return jobs.filter((job) => job.id != null && stringValue(job.title) && stringValue(job.url)).map((job) => {
    const location = stringValue(job.candidate_required_location);
    const description = stripListingHtml(stringValue(job.description));
    return { providerJobId: String(job.id), companyName: stringValue(job.company_name), title: stringValue(job.title), descriptionHtml: stringValue(job.description), description, department: stringValue(job.category), secondaryLocations: Array.isArray(job.tags) ? job.tags.map(stringValue).filter(Boolean) : [], location, geographicRestrictions: location ? [location] : [], remoteMode: 'remote', employmentType: stringValue(job.job_type), compensation: stringValue(job.salary) ? { description: stringValue(job.salary) } : undefined, applicationUrl: stringValue(job.url), originalUrl: stringValue(job.url), publishedAt: date(job.publication_date), updatedAt: date(job.publication_date), raw: job };
  });
}

export function parseAdzunaJobs(payload: unknown): NormalizedJobListing[] {
  const jobs = Array.isArray((payload as { results?: unknown[] })?.results) ? (payload as { results: Record<string, unknown>[] }).results : [];
  return jobs.filter((job) => stringValue(job.id) && stringValue(job.title) && stringValue(job.redirect_url)).map((job) => {
    const location = stringValue((job.location as { display_name?: unknown } | undefined)?.display_name ?? job.location);
    const company = stringValue((job.company as { display_name?: unknown } | undefined)?.display_name ?? job.company);
    const salary = { min: job.salary_min, max: job.salary_max, currency: job.salary_currency, period: job.salary_is_predicted ? 'estimated' : undefined };
    const description = stripListingHtml(stringValue(job.description));
    return { providerJobId: String(job.id), companyName: company, title: stringValue(job.title), descriptionHtml: stringValue(job.description), description, department: stringValue((job.category as { label?: unknown } | undefined)?.label), location, geographicRestrictions: location ? [location] : [], remoteMode: workMode([location, description].join('\n')), employmentType: [stringValue(job.contract_time), stringValue(job.contract_type)].filter(Boolean).join(' · '), compensation: Object.values(salary).some(Boolean) ? salary : undefined, applicationUrl: stringValue(job.redirect_url), originalUrl: stringValue(job.redirect_url), publishedAt: date(job.created), updatedAt: date(job.created), raw: job };
  });
}

export class GreenhouseAdapter implements AtsAdapter {
  readonly provider = 'greenhouse' as const;
  async fetch(board: JobBoard) { return parseGreenhouseJobs(await json(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.boardIdentifier)}/jobs?content=true`)); }
}

export class AshbyAdapter implements AtsAdapter {
  readonly provider = 'ashby' as const;
  async fetch(board: JobBoard) { return parseAshbyJobs(await json(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.boardIdentifier)}?includeCompensation=true`)); }
}

export class LeverAdapter implements AtsAdapter {
  readonly provider = 'lever' as const;
  async fetch(board: JobBoard) {
    const base = board.boardIdentifier.includes('/') ? board.boardIdentifier : board.boardIdentifier;
    return parseLeverJobs(await json(`https://api.lever.co/v0/postings/${encodeURIComponent(base)}?mode=json`));
  }
}

export class RemotiveAdapter implements AtsAdapter {
  readonly provider = 'remotive' as const;
  async fetch(board: JobBoard) { return parseRemotiveJobs(await json(`https://remotive.com/api/remote-jobs?limit=100`)); }
}

export class AdzunaAdapter implements AtsAdapter {
  readonly provider = 'adzuna' as const;
  async fetch(board: JobBoard) {
    if (!config.adzunaAppId || !config.adzunaAppKey) throw new Error('ADZUNA_APP_ID and ADZUNA_APP_KEY are required');
    const params = new URLSearchParams({ app_id: config.adzunaAppId, app_key: config.adzunaAppKey, results_per_page: '100', what: config.adzunaQuery, 'content-type': 'application/json' });
    if (config.adzunaWhere) params.set('where', config.adzunaWhere);
    return parseAdzunaJobs(await json(`https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(board.boardIdentifier)}/search/1?${params}`));
  }
}

export function adapterFor(provider: AtsProvider): AtsAdapter { return provider === 'greenhouse' ? new GreenhouseAdapter() : provider === 'ashby' ? new AshbyAdapter() : provider === 'lever' ? new LeverAdapter() : provider === 'remotive' ? new RemotiveAdapter() : new AdzunaAdapter(); }
