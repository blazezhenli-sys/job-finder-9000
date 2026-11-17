import { config } from '../config.js';
import { pool } from '../db.js';
import { events } from '../pipeline-service.js';
import type { AtsProvider } from '../types.js';

export type DiscoveryProvider = Extract<AtsProvider, 'greenhouse' | 'ashby' | 'lever'>;
type DiscoveryMode = 'full' | 'recent';
type Candidate = { provider: DiscoveryProvider; identifier: string; boardUrl: string; sourceUrl: string; source: string; metadata?: Record<string, unknown> };

const providers: DiscoveryProvider[] = ['greenhouse', 'ashby', 'lever'];
const domains: Record<DiscoveryProvider, string[]> = {
  greenhouse: ['boards.greenhouse.io', 'job-boards.greenhouse.io'],
  ashby: ['jobs.ashbyhq.com'],
  lever: ['jobs.lever.co']
};
const junk = new Set(['_next', 'api', 'static', 'assets', 'meeting', 'b', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'embed', 'css', 'js', 'images', 'img']);
const slugShape = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,60}$/;
const userAgent = 'hiring-signal-discovery-board-discovery/0.1 (public ATS discovery)';
let lastArchiveRequest = 0;
let discoveryRunning = false;
let opportunityListener: ((data: unknown) => void) | undefined;

function boardUrl(provider: DiscoveryProvider, identifier: string) {
  if (provider === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(identifier)}/jobs`;
  if (provider === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(identifier)}`;
  return `https://api.lever.co/v0/postings/${encodeURIComponent(identifier)}?mode=json`;
}

function publicBoardUrl(provider: DiscoveryProvider, identifier: string) {
  if (provider === 'greenhouse') return `https://boards.greenhouse.io/${encodeURIComponent(identifier)}`;
  if (provider === 'ashby') return `https://jobs.ashbyhq.com/${encodeURIComponent(identifier)}`;
  return `https://jobs.lever.co/${encodeURIComponent(identifier)}`;
}

function plausible(identifier: string, provider: DiscoveryProvider) {
  const lower = identifier.toLowerCase();
  return slugShape.test(identifier) && !junk.has(lower) && !(provider === 'ashby' && lower.startsWith('root.')) && !/^[0-9a-f-]{30,}$/i.test(identifier);
}

export function extractAtsBoardFromUrl(value: string): Candidate | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const provider = (Object.entries(domains).find(([, hosts]) => hosts.includes(host))?.[0] ?? '') as DiscoveryProvider;
  if (!provider) return null;
  const identifier = decodeURIComponent(url.pathname.replace(/^\/+/, '').split('/')[0] ?? '').trim();
  if (!identifier || !plausible(identifier, provider)) return null;
  return { provider, identifier, boardUrl: publicBoardUrl(provider, identifier), sourceUrl: value, source: 'url' };
}

export function extractAtsBoardsFromText(text: string): Candidate[] {
  const seen = new Set<string>(); const found: Candidate[] = [];
  for (const match of text.match(/https?:\/\/[^\s<>'")]+/gi) ?? []) {
    const value = match.replace(/[),.;!?]+$/, ''); const candidate = extractAtsBoardFromUrl(value); if (!candidate) continue;
    const key = `${candidate.provider}:${candidate.identifier.toLowerCase()}`;
    if (!seen.has(key)) { seen.add(key); found.push(candidate); }
  }
  return found;
}

async function request(url: string, init: RequestInit = {}, retries = 3): Promise<{ status: number; headers: Headers; body: string }> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const wait = Math.max(0, 250 - (Date.now() - lastArchiveRequest));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastArchiveRequest = Date.now();
    try {
      const response = await fetch(url, { ...init, headers: { 'User-Agent': userAgent, Accept: 'application/json,text/plain', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60_000) });
      const body = await response.text();
      if (response.status === 429 || response.status === 403 || response.status >= 500) {
        if (attempt + 1 >= retries) return { status: response.status, headers: response.headers, body };
        const retryAfter = Number(response.headers.get('retry-after'));
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, Number.isFinite(retryAfter) ? retryAfter * 1000 : 2 ** attempt * 1000)));
        continue;
      }
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      if (attempt + 1 >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
    }
  }
  throw new Error(`Request failed: ${url}`);
}

function addUrl(seen: Map<string, Candidate>, provider: DiscoveryProvider, url: string, source: string, metadata: Record<string, unknown> = {}) {
  const candidate = extractAtsBoardFromUrl(url); if (!candidate || candidate.provider !== provider) return;
  const key = `${provider}:${candidate.identifier.toLowerCase()}`;
  if (!seen.has(key)) seen.set(key, { ...candidate, source, metadata });
}

async function archiveCandidates(provider: DiscoveryProvider, mode: DiscoveryMode) {
  const seen = new Map<string, Candidate>();
  const from = mode === 'recent' ? `&from=${new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '')}` : '';
  for (const domain of domains[provider]) {
    const endpoint = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&matchType=domain&fl=original&collapse=urlkey&output=json&filter=statuscode:200${from}`;
    const response = await request(endpoint, {}, 3);
    if (response.status >= 400) throw new Error(`Wayback returned HTTP ${response.status} for ${domain}`);
    const rows = JSON.parse(response.body) as unknown;
    if (!Array.isArray(rows)) continue;
    for (const row of rows.slice(1)) if (Array.isArray(row) && typeof row[0] === 'string') addUrl(seen, provider, row[0], 'internet_archive_cdx', { domain, mode });
  }
  if (mode === 'recent') {
    for (const domain of domains[provider]) {
      const response = await request(`https://urlscan.io/api/v1/search/?q=page.domain%3A${encodeURIComponent(domain)}&size=10000`, {}, 2);
      if (response.status >= 400) continue;
      const results = (JSON.parse(response.body) as { results?: Array<{ page?: { url?: string } }> }).results ?? [];
      for (const result of results) if (result.page?.url) addUrl(seen, provider, result.page.url, 'urlscan', { domain, mode });
    }
  }
  return [...seen.values()];
}

async function commonCrawlCandidates(provider: DiscoveryProvider) {
  const seen = new Map<string, Candidate>();
  const collectionsResponse = await request('https://index.commoncrawl.org/collinfo.json', {}, 3);
  const collections = JSON.parse(collectionsResponse.body) as Array<{ 'cdx-api': string }>;
  const cdx = collections[0]?.['cdx-api']; if (!cdx) return [];
  for (const domain of domains[provider]) {
    for (let page = 0; page < 20; page += 1) {
      const response = await request(`${cdx}?url=${encodeURIComponent(`${domain}/*`)}&output=json&fl=url&page=${page}`, {}, 3);
      if (!response.body.trim()) break;
      for (const line of response.body.split('\n')) { if (!line.trim()) continue; try { addUrl(seen, provider, (JSON.parse(line) as { url?: string }).url ?? '', 'common_crawl_cdx', { domain }); } catch { /* ignore malformed index rows */ } }
      if (page) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return [...seen.values()];
}

async function upsertCandidate(candidate: Candidate, jobId?: string) {
  await pool.query(`INSERT INTO listing_discovery_candidates (provider, board_identifier, board_url, employer_name, discovery_source, status, metadata, source_url, discovery_job_id)
    VALUES ($1,$2,$3,$4,$5,'candidate',$6,$7,$8)
    ON CONFLICT (provider, board_identifier) DO UPDATE SET board_url=EXCLUDED.board_url, employer_name=CASE WHEN listing_discovery_candidates.employer_name='' THEN EXCLUDED.employer_name ELSE listing_discovery_candidates.employer_name END, discovery_source=CASE WHEN listing_discovery_candidates.discovery_source='manual' THEN EXCLUDED.discovery_source ELSE listing_discovery_candidates.discovery_source END, metadata=listing_discovery_candidates.metadata || EXCLUDED.metadata, source_url=CASE WHEN listing_discovery_candidates.source_url='' THEN EXCLUDED.source_url ELSE listing_discovery_candidates.source_url END, last_seen_at=now(), discovery_job_id=COALESCE(EXCLUDED.discovery_job_id, listing_discovery_candidates.discovery_job_id), next_validation_at=now(), updated_at=now()`, [candidate.provider, candidate.identifier, candidate.boardUrl, candidate.identifier, candidate.source, JSON.stringify(candidate.metadata ?? {}), candidate.sourceUrl, jobId ?? null]);
}

async function extractExistingOpportunityUrls(jobId: string) {
  const result = await pool.query('SELECT id, source_url, text, signal_category FROM opportunities');
  for (const row of result.rows) for (const candidate of extractAtsBoardsFromText(`${row.source_url ?? ''}\n${row.text ?? ''}`)) await upsertCandidate({ ...candidate, source: `post_url:${row.signal_category}`, metadata: { opportunityId: row.id, signalCategory: row.signal_category } }, jobId);
}

async function importCandidate(row: { id: string; provider: DiscoveryProvider; board_identifier: string; board_url: string; employer_name: string; discovery_source: string }) {
  const employer = await pool.query(`INSERT INTO employers (name, website) VALUES ($1,$2) ON CONFLICT (name, website) DO UPDATE SET updated_at=now() RETURNING id`, [row.employer_name || row.board_identifier, row.board_url]);
  const board = await pool.query(`INSERT INTO job_boards (employer_id, provider, board_identifier, board_url, discovery_source) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (provider, board_identifier) DO UPDATE SET board_url=EXCLUDED.board_url, discovery_source=EXCLUDED.discovery_source, updated_at=now() RETURNING id`, [employer.rows[0].id, row.provider, row.board_identifier, row.board_url, `discovery:${row.discovery_source}`]);
  await pool.query(`UPDATE listing_discovery_candidates SET status='imported', imported_board_id=$2, updated_at=now() WHERE id=$1`, [row.id, board.rows[0].id]);
}

async function validateCandidate(row: { id: string; provider: DiscoveryProvider; board_identifier: string; board_url: string; employer_name: string; discovery_source: string; validation_attempts: number }) {
  const response = await request(boardUrl(row.provider, row.board_identifier), { method: 'HEAD', headers: { Accept: 'application/json' } }, 2);
  const valid = response.status >= 200 && response.status < 300;
  await pool.query(`UPDATE listing_discovery_candidates SET validation_attempts=validation_attempts+1, last_validation_at=now(), last_validation_status=$2, status=CASE WHEN $2 BETWEEN 200 AND 299 THEN 'validated' WHEN $2=404 THEN 'rejected' ELSE 'candidate' END, next_validation_at=CASE WHEN $2 BETWEEN 200 AND 299 OR $2=404 THEN now() ELSE now() + ((LEAST(validation_attempts+1, 6) * 30)::text || ' seconds')::interval END, last_error=CASE WHEN $2 BETWEEN 200 AND 299 OR $2=404 THEN NULL ELSE $3 END, updated_at=now() WHERE id=$1`, [row.id, response.status, valid ? null : `HTTP ${response.status}`]);
  if (valid) await importCandidate(row);
  return valid;
}

async function updateJob(jobId: string, values: Record<string, unknown>) {
  const assignments = Object.keys(values).map((key, index) => `${key}=$${index + 2}`); await pool.query(`UPDATE listing_discovery_jobs SET ${assignments.join(',')}, updated_at=now() WHERE id=$1`, [jobId, ...Object.values(values)]);
}

async function refreshJobCounts(jobId: string) {
  const counts = await pool.query(`SELECT count(*)::int AS seen, count(*) FILTER (WHERE status IN ('validated','imported'))::int AS validated, count(*) FILTER (WHERE status='imported')::int AS imported FROM listing_discovery_candidates WHERE discovery_job_id=$1`, [jobId]);
  await updateJob(jobId, { candidates_seen: counts.rows[0].seen, candidates_validated: counts.rows[0].validated, boards_imported: counts.rows[0].imported });
}

export async function createDiscoveryJob(mode: DiscoveryMode = 'recent', selectedProviders: string[] = providers) {
  const active = await pool.query(`SELECT * FROM listing_discovery_jobs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 1`);
  if (active.rows[0]) return active.rows[0];
  const selected = selectedProviders.filter((value): value is DiscoveryProvider => providers.includes(value as DiscoveryProvider));
  const result = await pool.query(`INSERT INTO listing_discovery_jobs (mode, providers) VALUES ($1,$2) RETURNING *`, [mode, JSON.stringify(selected.length ? selected : providers)]);
  return result.rows[0];
}

async function runDiscoveryJob(jobId: string) {
  const jobResult = await pool.query('SELECT * FROM listing_discovery_jobs WHERE id=$1', [jobId]); const job = jobResult.rows[0]; if (!job) return;
  await updateJob(jobId, { status: 'running', started_at: job.started_at ?? new Date() });
  const selected = (job.providers as string[]).filter((value): value is DiscoveryProvider => providers.includes(value as DiscoveryProvider));
  const cursor = (job.cursor ?? {}) as { collected?: string[]; postsExtracted?: boolean; currentProvider?: DiscoveryProvider };
  try {
    if (!cursor.postsExtracted) { await extractExistingOpportunityUrls(jobId); cursor.postsExtracted = true; await updateJob(jobId, { cursor: JSON.stringify(cursor) }); }
    for (const provider of selected) {
      if (cursor.collected?.includes(provider)) continue;
      cursor.currentProvider = provider;
      await updateJob(jobId, { cursor: JSON.stringify(cursor) });
      let candidates: Candidate[];
      try { candidates = await archiveCandidates(provider, job.mode as DiscoveryMode); }
      catch (error) { candidates = await commonCrawlCandidates(provider); if (!candidates.length) throw error; }
      for (const candidate of candidates) await upsertCandidate(candidate, jobId);
      cursor.collected = [...(cursor.collected ?? []), provider]; delete cursor.currentProvider; await updateJob(jobId, { cursor: JSON.stringify(cursor), request_count: Number(job.request_count) + candidates.length });
      await refreshJobCounts(jobId);
    }
    await pool.query(`UPDATE listing_discovery_candidates SET discovery_job_id=$1 WHERE discovery_job_id IS NULL AND status='candidate'`, [jobId]);
    const candidates = await pool.query(`SELECT id, provider, board_identifier, board_url, employer_name, discovery_source, validation_attempts FROM listing_discovery_candidates WHERE discovery_job_id=$1 AND status='candidate' AND next_validation_at <= now() ORDER BY created_at LIMIT 200`, [jobId]);
    let errors = 0;
    for (let index = 0; index < candidates.rows.length; index += 4) {
      const batch = candidates.rows.slice(index, index + 4); const results = await Promise.all(batch.map((row) => validateCandidate(row).catch(() => { errors += 1; return false; }))); if (results.some(Boolean)) await refreshJobCounts(jobId);
    }
    await refreshJobCounts(jobId);
    const remaining = await pool.query(`SELECT count(*)::int AS count FROM listing_discovery_candidates WHERE discovery_job_id=$1 AND status='candidate'`, [jobId]);
    if (remaining.rows[0].count === 0 && selected.every((value) => cursor.collected?.includes(value))) await updateJob(jobId, { status: 'completed', finished_at: new Date(), error_count: errors });
    else await updateJob(jobId, { status: 'queued', error_count: errors });
    events.emit('listing-discovery', { jobId, status: remaining.rows[0].count === 0 ? 'completed' : 'queued' });
  } catch (error) {
    await updateJob(jobId, { status: 'failed', last_error: error instanceof Error ? error.message : String(error), error_count: Number(job.error_count) + 1 });
    events.emit('listing-discovery', { jobId, status: 'failed' });
  }
}

async function runDiscoveryCycle() {
  if (discoveryRunning) return; discoveryRunning = true;
  try {
    const active = await pool.query(`SELECT * FROM listing_discovery_jobs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 1`);
    let job = active.rows[0];
    if (!job) { const completed = await pool.query(`SELECT 1 FROM listing_discovery_jobs WHERE status='completed' LIMIT 1`); job = await createDiscoveryJob(completed.rows.length ? 'recent' : 'full'); }
    await runDiscoveryJob(job.id);
  } finally { discoveryRunning = false; }
}

export async function startListingDiscovery(intervalMs: number) {
  if (!opportunityListener) { opportunityListener = (data) => { const row = data as { source_url?: string; text?: string; signal_category?: string }; void Promise.all(extractAtsBoardsFromText(`${row.source_url ?? ''}\n${row.text ?? ''}`).map((candidate) => upsertCandidate({ ...candidate, source: `post_event:${row.signal_category ?? 'unknown'}` }))).catch((error) => console.error('ATS URL discovery failed', error)); }; events.on('opportunity', opportunityListener); }
  void runDiscoveryCycle().catch((error) => console.error('listing discovery failed', error));
  return setInterval(() => void runDiscoveryCycle().catch((error) => console.error('listing discovery failed', error)), intervalMs);
}

export async function getDiscoveryJobs(limit = 20) { return (await pool.query('SELECT * FROM listing_discovery_jobs ORDER BY created_at DESC LIMIT $1', [Math.min(100, Math.max(1, limit))])).rows; }
