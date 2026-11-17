import type { AtsProvider, JobBoard, NormalizedJobListing, WorkMode } from '../types.js';

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

export function adapterFor(provider: AtsProvider): AtsAdapter { return provider === 'greenhouse' ? new GreenhouseAdapter() : provider === 'ashby' ? new AshbyAdapter() : new LeverAdapter(); }
