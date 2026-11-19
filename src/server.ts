import path from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { getPreferences, getRules, migrate, pool, setPreferences, startDeferredMigrations, withTransaction } from './db.js';
import { sendTestEmail } from './notifications.js';
import { events, processPost } from './pipeline-service.js';
import { createDiscoveryJob, getDiscoveryJobs } from './listings/discovery.js';
import { calculateProspectScore, engineeringSpecialtyLabels } from './listings/company.js';
import { getMarketCurrent, getMarketSummary, marketWhere, type MarketQuery } from './listings/market.js';
import { jobCategoryLabels, LISTING_CLASSIFICATION_VERSION, loadTechnologyTaxonomy } from './listings/classification.js';
import { getMarketDashboard, getMarketTrends } from './listings/analytics.js';
import type { AtsProvider, AuthorClassification, JobListingStatus, NormalizedPost, OpportunityStatus, SignalCategory } from './types.js';
import { normalizeCompanyDomain } from './listings/identity.js';

const app = Fastify({ logger: true });
const publicDir = path.join(process.cwd(), 'public');

function unauthorized(reply: FastifyReply) { return reply.code(401).header('WWW-Authenticate', 'Basic realm="Hiring Signals"').send({ error: 'Authentication required' }); }
async function auth(request: FastifyRequest, reply: FastifyReply) {
  if (request.url === '/api/health') return;
  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return unauthorized(reply);
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0 || decoded.slice(0, separator) !== config.dashboardUsername || decoded.slice(separator + 1) !== config.dashboardPassword) return unauthorized(reply);
}

app.addHook('onRequest', auth);
app.register(fastifyStatic, { root: publicDir, prefix: '/' });

app.get('/api/health', async (_request, reply) => {
  try {
    await pool.query('SELECT 1');
    return { ok: true, database: 'ok', time: new Date().toISOString() };
  } catch (error) {
    return reply.code(503).send({ ok: false, database: 'error', error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/market/summary', async (request) => {
  const query = request.query as MarketQuery & { limit?: string };
  return { ...(await getMarketSummary(query)), labels: { categories: jobCategoryLabels } };
});

app.get('/api/market/current', async (request) => {
  const query = request.query as MarketQuery & { dimension?: string };
  return getMarketCurrent(query, query.dimension);
});

app.get('/api/market/dashboard', async (request) => {
  const query = request.query as { from?: string; to?: string; cohort?: string; dimension?: string; granularity?: string };
  const to = query.to && !Number.isNaN(Date.parse(query.to)) ? query.to : new Date().toISOString().slice(0, 10);
  const from = query.from && !Number.isNaN(Date.parse(query.from)) ? query.from : new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
  return { ...(await getMarketDashboard(from, to, query.cohort, query.dimension, query.granularity)), labels: { categories: jobCategoryLabels } };
});

app.get('/api/market/drilldown', async (request, reply) => {
  const query = request.query as MarketQuery & { dimension?: string; value?: string; limit?: string; offset?: string; from?: string; to?: string };
  const predicates: Record<string, string> = {
    category: `COALESCE(NULLIF(l.job_category,''),'unknown')=$${0}`,
    specialty: `l.engineering_specialties ? $${0}`,
    technology: `l.technologies ? $${0}`,
    region: `l.location_signals->'regions' ? $${0}`,
    country: `(l.location_signals->'countries' ? $${0} OR l.location_signals->'locations' ? $${0})`,
    work_mode: `l.remote_mode=$${0}`,
    employment_type: `l.employment_type ILIKE $${0}`
  };
  if (!query.dimension || !query.value || !predicates[query.dimension]) return reply.code(400).send({ error: 'dimension and value are required' });
  const values: unknown[] = [];
  const filters = { ...query, limit: undefined, offset: undefined };
  const whereParts = [marketWhere(filters, values)];
  values.push(query.dimension === 'employment_type' ? `%${query.value}%` : query.value);
  const dimensionPredicate = predicates[query.dimension].replaceAll('$0', `$${values.length}`);
  whereParts.push(dimensionPredicate);
  if (query.from && !Number.isNaN(Date.parse(query.from))) { values.push(query.from); whereParts.push(`l.first_observed_at >= $${values.length}::timestamptz`); }
  if (query.to && !Number.isNaN(Date.parse(query.to))) { values.push(query.to); whereParts.push(`l.first_observed_at < ($${values.length}::date + interval '1 day')`); }
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  const offset = Math.max(0, Number(query.offset) || 0);
  const where = whereParts.join(' AND ');
  const from = `job_listings l JOIN job_boards b ON b.id=l.board_id JOIN employers e ON e.id=b.employer_id`;
  const [companies, total] = await Promise.all([
    pool.query(`SELECT e.id AS employer_id, e.name AS employer_name, count(*)::int AS listings, count(*) FILTER (WHERE jsonb_array_length(COALESCE(l.engineering_specialties,'[]'::jsonb)) > 0)::int AS engineering, count(*) FILTER (WHERE l.remote_mode='remote')::int AS remote, count(*) FILTER (WHERE l.first_observed_at >= now() - interval '7 days')::int AS new_last_7_days FROM ${from} WHERE ${where} GROUP BY e.id, e.name ORDER BY listings DESC, e.name LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]),
    pool.query(`SELECT count(DISTINCT e.id)::int AS count FROM ${from} WHERE ${where}`, values)
  ]);
  const evidenceLimit = Math.min(50, Math.max(1, Number(query.limit) || 25));
  const evidenceOffset = Math.max(0, Number(query.offset) || 0);
  const evidence = await pool.query('SELECT l.id, l.title, l.location, l.remote_mode, l.job_category, l.primary_specialty, l.application_url, l.original_url, l.first_observed_at, l.source_updated_at, b.provider, b.board_identifier, e.id AS employer_id, e.name AS employer_name FROM ' + from + ' WHERE ' + where + ' ORDER BY l.first_observed_at DESC NULLS LAST, l.source_updated_at DESC NULLS LAST LIMIT $' + (values.length + 1) + ' OFFSET $' + (values.length + 2), [...values, evidenceLimit, evidenceOffset]);
  return { dimension: query.dimension, value: query.value, companies: companies.rows, evidence: evidence.rows, total: total.rows[0].count, limit, offset, evidencePagination: { limit: evidenceLimit, offset: evidenceOffset } };
});

app.get('/api/market/employers', async (request) => {
  const query = request.query as MarketQuery;
  const values: unknown[] = [];
  const where = marketWhere(query, values);
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
  const offset = Math.max(0, Number(query.offset) || 0);
  const from = `job_listings l JOIN job_boards b ON b.id=l.board_id JOIN employers e ON e.id=b.employer_id`;
  const [employers, total] = await Promise.all([
    pool.query(`SELECT e.id AS employer_id, e.name AS employer_name, count(*)::int AS listings, count(*) FILTER (WHERE jsonb_array_length(COALESCE(l.engineering_specialties,'[]'::jsonb)) > 0)::int AS engineering, count(*) FILTER (WHERE l.remote_mode='remote')::int AS remote, count(*) FILTER (WHERE l.first_observed_at >= now() - interval '7 days' AND l.first_observed_at > b.initialized_at)::int AS new_last_7_days FROM ${from} WHERE ${where} GROUP BY e.id, e.name ORDER BY engineering DESC, listings DESC, e.name LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]),
    pool.query(`SELECT count(DISTINCT e.id)::int AS count FROM ${from} WHERE ${where}`, values)
  ]);
  return { employers: employers.rows, total: total.rows[0].count, limit, offset };
});

app.get('/api/market/trends', async (request) => {
  const query = request.query as { from?: string; to?: string; cohort?: string; dimension?: string; granularity?: string };
  const to = query.to && !Number.isNaN(Date.parse(query.to)) ? query.to : new Date().toISOString().slice(0, 10);
  const from = query.from && !Number.isNaN(Date.parse(query.from)) ? query.from : new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
  return getMarketTrends(from, to, query.cohort, query.dimension, query.granularity);
});

app.get('/api/market/signals', async (request) => {
  const query = request.query as { limit?: string };
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  const result = await pool.query(`SELECT s.*, e.name AS employer_name FROM market_signals s LEFT JOIN employers e ON e.id=s.employer_id WHERE s.status='active' ORDER BY s.last_seen_at DESC LIMIT $1`, [limit]);
  return { signals: result.rows };
});

app.get('/api/market/signals/:id', async (request, reply) => {
  const signalId = (request.params as { id: string }).id;
  const signal = await pool.query(`SELECT s.*, e.name AS employer_name
    FROM market_signals s LEFT JOIN employers e ON e.id=s.employer_id WHERE s.id=$1`, [signalId]);
  if (!signal.rows[0]) return reply.code(404).send({ error: 'Market signal not found' });
  const evidenceIds = Array.isArray(signal.rows[0].supporting_listing_ids)
    ? signal.rows[0].supporting_listing_ids.filter((value: unknown): value is string => typeof value === 'string')
    : [];
  const evidence = evidenceIds.length ? await pool.query(`SELECT l.id, l.title, l.location, l.remote_mode, l.job_category,
      l.primary_specialty, l.application_url, l.original_url, l.source_updated_at, l.first_observed_at,
      b.provider, b.board_identifier, e.id AS employer_id, e.name AS employer_name
      FROM job_listings l JOIN job_boards b ON b.id=l.board_id JOIN employers e ON e.id=b.employer_id
      WHERE l.id = ANY($1::uuid[]) ORDER BY l.source_updated_at DESC NULLS LAST, l.first_observed_at DESC`, [evidenceIds]) : { rows: [] };
  const companies = [...new Map(evidence.rows.map((row) => [row.employer_id, { id: row.employer_id, name: row.employer_name }])).values()];
  return { signal: signal.rows[0], companies, evidence: evidence.rows };
});

app.get('/api/market/taxonomy/technologies', async () => ({ terms: (await pool.query('SELECT canonical, alias, enabled, classification_version FROM listing_technology_aliases ORDER BY canonical, alias')).rows }));

app.patch('/api/market/taxonomy/technologies', async (request, reply) => {
  const body = request.body as { canonical?: string; alias?: string; enabled?: boolean };
  if (!body.canonical?.trim() || !body.alias?.trim()) return reply.code(400).send({ error: 'canonical and alias are required' });
  const result = await pool.query(`INSERT INTO listing_technology_aliases (canonical, alias, enabled)
    VALUES ($1,$2,$3) ON CONFLICT (canonical, alias) DO UPDATE SET enabled=EXCLUDED.enabled RETURNING *`, [body.canonical.trim().toLowerCase(), body.alias.trim().toLowerCase(), body.enabled !== false]);
  await loadTechnologyTaxonomy();
  await pool.query('UPDATE job_listings SET classification_backfilled_at=NULL WHERE classification_version <= $1', [LISTING_CLASSIFICATION_VERSION]);
  return result.rows[0];
});

app.get('/api/market/compare', async (request, reply) => {
  const query = request.query as { a?: string; b?: string };
  let segmentA: MarketQuery = {};
  let segmentB: MarketQuery = {};
  try {
    if (query.a) segmentA = JSON.parse(query.a) as MarketQuery;
    if (query.b) segmentB = JSON.parse(query.b) as MarketQuery;
  } catch {
    return reply.code(400).send({ error: 'Segments must be valid JSON filter objects' });
  }
  const [a, b] = await Promise.all([getMarketSummary({ ...segmentA, active: segmentA.active ?? 'true', limit: '1' } as MarketQuery), getMarketSummary({ ...segmentB, active: segmentB.active ?? 'true', limit: '1' } as MarketQuery)]);
  const shape = (summary: Awaited<ReturnType<typeof getMarketSummary>>) => {
    const totals = summary.totals;
    const active = Number(totals.active_listings) || 0;
    return {
      totals,
      shares: {
        remote: active ? Number(totals.remote_openings) / active : 0,
        contract: active ? Number(totals.contract_openings) / active : 0,
        salary_coverage: active ? Number(totals.listings_with_compensation) / active : 0
      },
      topSpecialties: summary.facets.specialties.slice(0, 8),
      topTechnologies: summary.facets.technologies.slice(0, 8),
      topRegions: summary.facets.regions.slice(0, 8),
      employmentTypes: summary.facets.employmentTypes.slice(0, 8)
    };
  };
  return { segments: { a: { filters: segmentA, ...shape(a) }, b: { filters: segmentB, ...shape(b) } } };
});

app.get('/api/opportunities', async (request) => {
  const query = request.query as { source?: string; status?: string; sort?: string; minQuality?: string; signalCategory?: string; workMode?: string; includeSuppressed?: string; limit?: string; offset?: string };
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (query.source && ['bluesky', 'hacker_news', 'mastodon', 'reddit'].includes(query.source)) { values.push(query.source); conditions.push(`source = $${values.length}`); }
  if (query.status && ['unread', 'interesting', 'dismissed', 'contacted'].includes(query.status)) { values.push(query.status); conditions.push(`status = $${values.length}`); }
  if (query.minQuality && Number.isFinite(Number(query.minQuality))) { values.push(Number(query.minQuality)); conditions.push(`signal_quality >= $${values.length}`); }
  if (query.signalCategory && ['direct_hiring', 'service_request', 'employee_referral', 'firsthand_announcement', 'aggregated_listing', 'uncertain'].includes(query.signalCategory)) { values.push(query.signalCategory); conditions.push(`signal_category = $${values.length}`); }
  if (query.workMode && ['remote', 'hybrid', 'onsite', 'unknown'].includes(query.workMode)) { values.push(query.workMode); conditions.push(`location_signals->>'workMode' = $${values.length}`); }
  const sort = query.sort === 'quality' ? 'signal_quality DESC, published_at DESC' : query.sort === 'published' ? 'published_at DESC' : 'first_seen_at DESC';
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  const offset = Math.max(0, Number(query.offset) || 0);
  values.push(limit, offset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(`SELECT * FROM opportunities ${where} ORDER BY ${sort} LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  const total = await pool.query(`SELECT count(*)::int AS count FROM opportunities ${where}`, values.slice(0, -2));
  return { opportunities: result.rows, total: total.rows[0].count };
});

app.get('/api/opportunities/:id', async (request, reply) => {
  const result = await pool.query(`SELECT o.*, row_to_json(a) AS author_profile FROM opportunities o LEFT JOIN author_profiles a ON a.id = o.author_profile_id WHERE o.id = $1`, [(request.params as { id: string }).id]);
  if (!result.rows[0]) return reply.code(404).send({ error: 'Opportunity not found' });
  return result.rows[0];
});

const atsProviders: AtsProvider[] = ['greenhouse', 'ashby', 'lever', 'remotive', 'adzuna'];
const listingStatuses: JobListingStatus[] = ['new', 'saved', 'dismissed', 'applied'];
function provider(value: unknown): value is AtsProvider { return typeof value === 'string' && atsProviders.includes(value as AtsProvider); }
function boardIdentifier(value: unknown, providerName: AtsProvider): string {
  const raw = String(value ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (!raw) return '';
  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 1) return raw;
  if (providerName === 'greenhouse' && parts[0] === 'boards.greenhouse.io') return parts[1] ?? '';
  if (providerName === 'ashby' && parts[0] === 'jobs.ashbyhq.com') return parts[1] ?? '';
  if (providerName === 'remotive') return 'remote-jobs';
  if (providerName === 'adzuna') return parts.at(-1) ?? '';
  if (providerName === 'greenhouse' && parts.includes('job_board')) return parts[parts.indexOf('job_board') + 1] ?? '';
  if (providerName === 'ashby' && parts.includes('job-board')) return parts[parts.indexOf('job-board') + 1] ?? '';
  if (providerName === 'lever' && parts[0] === 'jobs.lever.co') return parts[1] ?? '';
  return parts.at(-1) ?? '';
}

app.get('/api/listings', async (request) => {
  const query = request.query as { provider?: string; status?: string; employer?: string; employerId?: string; department?: string; category?: string; specialty?: string; technology?: string; region?: string; country?: string; employmentType?: string; seniority?: string; location?: string; salaryCurrency?: string; minSalary?: string; maxAgeDays?: string; workMode?: string; sort?: string; active?: string; limit?: string; offset?: string };
  const values: unknown[] = []; const conditions: string[] = [];
  if (provider(query.provider)) { values.push(query.provider); conditions.push(`l.provider = $${values.length}`); }
  if (query.status && listingStatuses.includes(query.status as JobListingStatus)) { values.push(query.status); conditions.push(`l.status = $${values.length}`); }
  if (query.employer) { values.push(`%${query.employer}%`); conditions.push(`e.name ILIKE $${values.length}`); }
  if (query.employerId) { values.push(query.employerId); conditions.push(`e.id = $${values.length}`); }
  if (query.department) { values.push(`%${query.department}%`); conditions.push(`l.department ILIKE $${values.length}`); }
  if (query.category) { values.push(query.category); conditions.push(`COALESCE(NULLIF(l.job_category,''),'unknown') = $${values.length}`); }
  if (query.specialty) { values.push(query.specialty); conditions.push(`l.engineering_specialties ? $${values.length}`); }
  if (query.technology) { values.push(query.technology); conditions.push(`l.technologies ? $${values.length}`); }
  if (query.region) { if (query.region.toLowerCase() === 'unknown') conditions.push(`jsonb_array_length(COALESCE(l.location_signals->'regions','[]'::jsonb)) = 0`); else { values.push(query.region); conditions.push(`l.location_signals->'regions' ? $${values.length}`); } }
  if (query.country) { if (query.country.toLowerCase() === 'unknown') conditions.push(`jsonb_array_length(COALESCE(l.location_signals->'countries','[]'::jsonb)) = 0`); else { values.push(query.country); conditions.push(`(l.location_signals->'countries' ? $${values.length} OR l.location_signals->'locations' ? $${values.length})`); } }
  if (query.employmentType) { values.push(`%${query.employmentType}%`); conditions.push(`l.employment_type ILIKE $${values.length}`); }
  if (query.seniority) { values.push(`%${query.seniority}%`); conditions.push(`l.seniority ILIKE $${values.length}`); }
  if (query.location) { values.push(`%${query.location}%`); conditions.push(`(l.location ILIKE $${values.length} OR l.secondary_locations::text ILIKE $${values.length} OR l.geographic_restrictions::text ILIKE $${values.length})`); }
  if (query.salaryCurrency) { values.push(query.salaryCurrency.toUpperCase()); conditions.push(`l.compensation_currency = $${values.length}`); }
  if (query.minSalary && Number.isFinite(Number(query.minSalary)) && Number(query.minSalary) > 0) { values.push(Number(query.minSalary)); conditions.push(`COALESCE(l.compensation_max, l.compensation_min) >= $${values.length}`); }
  if (query.maxAgeDays && Number.isFinite(Number(query.maxAgeDays)) && Number(query.maxAgeDays) > 0) { values.push(Number(query.maxAgeDays)); conditions.push(`l.published_at IS NOT NULL AND l.published_at >= now() - ($${values.length}::text || ' days')::interval`); }
  if (query.workMode && ['remote', 'hybrid', 'onsite', 'unknown'].includes(query.workMode)) { values.push(query.workMode); conditions.push(`l.remote_mode = $${values.length}`); }
  if (query.active !== 'false') conditions.push('l.is_active = true');
  const sort = query.sort === 'updated' ? 'l.source_updated_at DESC NULLS LAST' : 'l.first_observed_at DESC';
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 100)); const offset = Math.max(0, Number(query.offset) || 0);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit, offset);
  const result = await pool.query(`SELECT l.*, b.board_identifier, b.board_url, b.status AS board_status, e.id AS employer_id, e.name AS employer_name, e.website AS employer_website FROM job_listings l JOIN job_boards b ON b.id = l.board_id JOIN employers e ON e.id = b.employer_id ${where} ORDER BY ${sort} LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  const total = await pool.query(`SELECT count(*)::int AS count FROM job_listings l JOIN job_boards b ON b.id = l.board_id JOIN employers e ON e.id = b.employer_id ${where}`, values.slice(0, -2));
  return { listings: result.rows, total: total.rows[0].count };
});

app.get('/api/listing-departments', async (request) => {
  const query = request.query as { q?: string; limit?: string };
  const search = query.q?.trim() ?? '';
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 25));
  const values: unknown[] = [];
  const conditions = ['is_active=true', "department <> ''"];
  if (search) { values.push(search); conditions.push(`department ILIKE '%' || $${values.length} || '%'`); }
  values.push(limit);
  const order = search
    ? `ORDER BY CASE WHEN lower(department)=lower($1) THEN 0 ELSE 1 END, listing_count DESC, lower(department)`
    : 'ORDER BY listing_count DESC, lower(department)';
  const result = await pool.query(`SELECT department, count(*)::int AS listing_count
    FROM job_listings
    WHERE ${conditions.join(' AND ')}
    GROUP BY department
    ${order}
    LIMIT $${values.length}`, values);
  return { departments: result.rows };
});

const companySorts: Record<string, string> = {
  name: 'lower(e.name) ASC',
  engineering: 'active_listing_count DESC, lower(e.name) ASC',
  new: 'new_listings_7d DESC, lower(e.name) ASC',
  recent: 'latest_listing_date DESC NULLS LAST, lower(e.name) ASC',
  score: `LEAST(100, active_listing_count * 3 + new_listings_7d * 10 + CASE WHEN latest_hiring_activity >= now() - interval '30 days' THEN 20 ELSE 0 END) DESC, lower(e.name) ASC`
};

app.get('/api/companies', async (request) => {
  const query = request.query as { q?: string; provider?: string; specialty?: string; remote?: string; contract?: string; prospectStatus?: string; sort?: string; limit?: string; offset?: string };
  const values: unknown[] = [];
  const conditions: string[] = [];
  if (query.q?.trim()) { values.push(`%${query.q.trim()}%`); conditions.push(`e.name ILIKE $${values.length}`); }
  if (provider(query.provider)) { values.push(query.provider); conditions.push(`EXISTS (SELECT 1 FROM job_boards filter_b WHERE filter_b.employer_id=e.id AND filter_b.provider=$${values.length})`); }
  if (query.specialty && Object.keys(requirementSpecialties).includes(query.specialty)) { values.push(query.specialty); conditions.push(`EXISTS (SELECT 1 FROM job_listings filter_l JOIN job_boards filter_b ON filter_b.id=filter_l.board_id WHERE filter_b.employer_id=e.id AND filter_l.is_active AND filter_l.engineering_specialties ? $${values.length})`); }
  if (query.remote === 'true') conditions.push(`EXISTS (SELECT 1 FROM job_listings filter_l JOIN job_boards filter_b ON filter_b.id=filter_l.board_id WHERE filter_b.employer_id=e.id AND filter_l.is_active AND filter_l.remote_mode='remote')`);
  if (query.contract === 'true') conditions.push(`EXISTS (SELECT 1 FROM job_listings filter_l JOIN job_boards filter_b ON filter_b.id=filter_l.board_id WHERE filter_b.employer_id=e.id AND filter_l.is_active AND lower(filter_l.employment_type) LIKE '%contract%'` + `)`);
  if (query.prospectStatus && ['unreviewed', 'interesting', 'contacted', 'follow_up', 'not_interested'].includes(query.prospectStatus)) { values.push(query.prospectStatus); conditions.push(`e.prospect_status=$${values.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  const offset = Math.max(0, Number(query.offset) || 0);
  const select = `WITH metrics AS (
    SELECT e.id,
      count(DISTINCT b.id)::int AS board_count,
      count(DISTINCT b.id) FILTER (WHERE b.status='active')::int AS active_board_count,
      count(l.id) FILTER (WHERE l.is_active)::int AS active_listing_count,
      count(l.id) FILTER (WHERE l.is_active AND l.first_observed_at >= now() - interval '7 days' AND b.initialized_at IS NOT NULL AND l.first_observed_at > b.initialized_at)::int AS new_listings_7d,
      count(l.id) FILTER (WHERE l.is_active AND l.first_observed_at >= now() - interval '30 days' AND b.initialized_at IS NOT NULL AND l.first_observed_at > b.initialized_at)::int AS new_listings_30d,
      count(l.id) FILTER (WHERE l.is_active AND jsonb_array_length(l.engineering_specialties) > 0)::int AS active_engineering,
      count(l.id) FILTER (WHERE l.is_active AND l.first_observed_at >= now() - interval '7 days' AND b.initialized_at IS NOT NULL AND l.first_observed_at > b.initialized_at AND jsonb_array_length(l.engineering_specialties) > 0)::int AS new_engineering_7d,
      count(l.id) FILTER (WHERE l.is_active AND l.first_observed_at >= now() - interval '30 days' AND b.initialized_at IS NOT NULL AND l.first_observed_at > b.initialized_at AND jsonb_array_length(l.engineering_specialties) > 0)::int AS new_engineering_30d,
      count(l.id) FILTER (WHERE l.is_active AND l.remote_mode='remote')::int AS remote_listing_count,
      count(l.id) FILTER (WHERE l.is_active AND lower(l.employment_type) LIKE '%contract%')::int AS contract_listing_count,
      max(l.last_observed_at) AS latest_hiring_activity,
      max(COALESCE(l.source_updated_at, l.first_observed_at)) FILTER (WHERE l.is_active) AS latest_listing_date,
      COALESCE(array_agg(DISTINCT b.provider) FILTER (WHERE b.id IS NOT NULL), '{}') AS providers
    FROM employers e LEFT JOIN job_boards b ON b.employer_id=e.id LEFT JOIN job_listings l ON l.board_id=b.id
    GROUP BY e.id
  )
  SELECT e.id, e.name, e.website, e.identity_domain, e.identity_name_source, e.identity_domain_source, e.identity_confidence, e.verified_domain, e.description, e.industry, e.headquarters, e.company_size, e.prospect_status, e.first_discovered_at, e.updated_at,
    metrics.board_count, metrics.active_board_count, metrics.active_listing_count, metrics.new_listings_7d, metrics.new_listings_30d, metrics.active_engineering, metrics.new_engineering_7d, metrics.new_engineering_30d, metrics.remote_listing_count, metrics.contract_listing_count, metrics.latest_hiring_activity, metrics.latest_listing_date, metrics.providers
  FROM employers e JOIN metrics ON metrics.id=e.id ${where}`;
  const sort = companySorts[query.sort ?? ''] ?? companySorts.name;
  const result = await pool.query(`${select} ORDER BY ${sort} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]);
  const companies = result.rows.map((row) => ({ ...row, prospect_score: calculateProspectScore({ activeListings: Number(row.active_listing_count), newListings7d: Number(row.new_listings_7d), hasRecentActivity: Boolean(row.latest_hiring_activity && new Date(row.latest_hiring_activity).getTime() >= Date.now() - 30 * 86_400_000) }).score }));
  const total = await pool.query(`SELECT count(*)::int AS count FROM employers e ${where}`, values);
  return { companies, total: total.rows[0].count, limit, offset };
});

const requirementSpecialties: Record<string, true> = {
  backend_api: true, frontend: true, full_stack: true, infrastructure_devops: true, data_engineering: true,
  machine_learning_ai: true, mobile: true, security: true, qa_testing: true, embedded_systems: true, platform_infrastructure: true, other_software: true
};

app.get('/api/companies/:id', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const company = await pool.query(`SELECT id, name, website, career_url, identity_domain, identity_name_source, identity_domain_source, identity_confidence, verified_domain, description, industry, headquarters, company_size, prospect_status, prospect_notes, follow_up_at, contacted_at, first_discovered_at, updated_at FROM employers WHERE id=$1`, [id]);
  if (!company.rows[0]) return reply.code(404).send({ error: 'Company not found' });
  const [boards, summary, specialties, listings, activity, dailyActivity, storedSignals, events, socialLinks, socialActivity] = await Promise.all([
    pool.query(`SELECT b.*, count(l.id) FILTER (WHERE l.is_active)::int AS active_listing_count FROM job_boards b LEFT JOIN job_listings l ON l.board_id=b.id WHERE b.employer_id=$1 GROUP BY b.id ORDER BY b.status, b.provider, b.board_identifier`, [id]),
    pool.query(`SELECT count(l.id) FILTER (WHERE l.is_active)::int AS active_listing_count,
      count(l.id) FILTER (WHERE l.is_active AND jsonb_array_length(l.engineering_specialties) > 0)::int AS active_engineering_count,
      count(l.id) FILTER (WHERE l.is_active AND l.first_observed_at >= now() - interval '7 days' AND b.initialized_at IS NOT NULL AND l.first_observed_at > b.initialized_at)::int AS new_listing_count_7d,
      count(l.id) FILTER (WHERE l.is_active AND l.first_observed_at >= now() - interval '30 days' AND b.initialized_at IS NOT NULL AND l.first_observed_at > b.initialized_at)::int AS new_listing_count_30d,
      count(l.id) FILTER (WHERE l.is_active AND l.remote_mode='remote')::int AS remote_listing_count,
      count(l.id) FILTER (WHERE l.is_active AND lower(l.employment_type) LIKE '%contract%')::int AS contract_listing_count,
      max(b.last_successful_poll) AS last_successful_monitoring
      FROM job_boards b LEFT JOIN job_listings l ON l.board_id=b.id WHERE b.employer_id=$1`, [id]),
    pool.query(`SELECT specialty_values.value AS specialty, count(*)::int AS listing_count FROM job_listings l JOIN job_boards b ON b.id=l.board_id CROSS JOIN LATERAL jsonb_array_elements_text(l.engineering_specialties) AS specialty_values(value) WHERE b.employer_id=$1 AND l.is_active GROUP BY specialty_values.value ORDER BY listing_count DESC, specialty_values.value`, [id]),
    pool.query(`SELECT l.id, l.title, l.department, l.location, l.remote_mode, l.employment_type, l.seniority, l.application_url, l.original_url, l.published_at, l.source_updated_at, l.first_observed_at, l.engineering_specialties, l.technologies, b.provider, b.board_identifier FROM job_listings l JOIN job_boards b ON b.id=l.board_id WHERE b.employer_id=$1 AND l.is_active ORDER BY l.source_updated_at DESC NULLS LAST, l.first_observed_at DESC LIMIT 100`, [id])
    ,pool.query(`SELECT date_trunc('day', o.observed_at) AS day, sum(o.listings_seen)::int AS listings_seen, sum(o.active_engineering)::int AS active_engineering, sum(o.new_listings)::int AS new_listings, sum(o.new_engineering)::int AS new_engineering, sum(o.missing_listings)::int AS missing_listings FROM listing_board_observations o JOIN job_boards b ON b.id=o.board_id WHERE b.employer_id=$1 GROUP BY date_trunc('day', o.observed_at) ORDER BY day ASC LIMIT 180`, [id])
    ,pool.query(`SELECT snapshot_date AS day, active_listings AS listings_seen, active_engineering, new_listings AS new_engineering, new_listings, removed_listings AS missing_listings, specialty_counts, technology_counts, employment_type_counts, work_mode_counts FROM company_daily_metrics WHERE employer_id=$1 ORDER BY snapshot_date ASC LIMIT 180`, [id]),
    pool.query(`SELECT signal_type AS type, signal_type AS label, explanation, data_quality FROM market_signals WHERE employer_id=$1 AND status='active' ORDER BY last_seen_at DESC LIMIT 25`, [id])
    ,pool.query(`SELECT ev.listing_id, ev.event_type, ev.observed_at, ev.source_updated_at, l.title, l.application_url, l.original_url FROM listing_events ev JOIN job_listings l ON l.id=ev.listing_id JOIN job_boards b ON b.id=ev.board_id WHERE b.employer_id=$1 ORDER BY ev.observed_at DESC LIMIT 100`, [id])
    ,pool.query(`SELECT id, platform, profile_url, source_url, first_seen_at, last_seen_at, social_poll_last_attempted_at, social_poll_last_success_at, social_poll_next_at, social_poll_error, social_poll_consecutive_failures FROM company_social_links WHERE employer_id=$1 AND is_active ORDER BY platform, profile_url`, [id])
    ,pool.query(`SELECT id, social_link_id, platform, author_name, author_handle, author_url, source_url, text, published_at, fetched_at FROM company_social_posts WHERE employer_id=$1 ORDER BY published_at DESC LIMIT 50`, [id])
  ]);
  const summaryRow = summary.rows[0] ?? {};
  const prospect = calculateProspectScore({ activeListings: Number(summaryRow.active_listing_count), newListings7d: Number(summaryRow.new_listing_count_7d), hasRecentActivity: Boolean(summaryRow.last_successful_monitoring && new Date(summaryRow.last_successful_monitoring).getTime() >= Date.now() - 30 * 86_400_000) });
  const signals: Array<{ type: string; label: string; explanation: string }> = [];
  const recentNewListings = (dailyActivity.rows.length ? dailyActivity.rows : activity.rows).filter((row) => new Date(row.day).getTime() >= Date.now() - 30 * 86_400_000).reduce((total, row) => total + Number(row.new_listings), 0);
  if (recentNewListings >= 3) signals.push({ type: 'hiring_expansion', label: 'Hiring expansion', explanation: `${recentNewListings} openings were observed after board baselines in the last 30 days.` });
  return { company: { ...company.rows[0], prospect_score: prospect.score, prospect_score_factors: prospect.factors }, boards: boards.rows, summary: summaryRow, specialties: specialties.rows.map((row) => ({ ...row, label: engineeringSpecialtyLabels[row.specialty] || row.specialty })), listings: listings.rows, activity: activity.rows, dailyActivity: dailyActivity.rows, signals: [...signals, ...storedSignals.rows], events: events.rows, socialLinks: socialLinks.rows, socialActivity: socialActivity.rows };
});

app.get('/api/companies/:id/social-activity', async (request) => {
  const id = (request.params as { id: string }).id;
  const query = request.query as { limit?: string; before?: string };
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  const values: unknown[] = [id];
  const conditions = ['employer_id=$1'];
  if (query.before) { values.push(query.before); conditions.push(`published_at < $${values.length}`); }
  const result = await pool.query(`SELECT id, social_link_id, platform, author_name, author_handle, author_url, source_url, text, published_at, fetched_at
    FROM company_social_posts WHERE ${conditions.join(' AND ')} ORDER BY published_at DESC LIMIT $${values.length + 1}`, [...values, limit + 1]);
  const hasMore = result.rows.length > limit;
  return { activity: result.rows.slice(0, limit), hasMore, nextBefore: hasMore ? result.rows[limit - 1]?.published_at : null };
});

app.patch('/api/companies/:id', async (request, reply) => {
  const body = request.body as { name?: string; website?: string; verifiedDomain?: string; description?: string; industry?: string; headquarters?: string; companySize?: string; prospectStatus?: string; prospectNotes?: string; followUpAt?: string | null; contactedAt?: string | null };
  if (body.prospectStatus !== undefined && !['unreviewed', 'interesting', 'contacted', 'follow_up', 'not_interested'].includes(body.prospectStatus)) return reply.code(400).send({ error: 'Invalid prospect status' });
  const fields: Array<[string, string | null | undefined]> = [['name', body.name], ['website', body.website], ['verified_domain', body.verifiedDomain], ['description', body.description], ['industry', body.industry], ['headquarters', body.headquarters], ['company_size', body.companySize], ['prospect_status', body.prospectStatus], ['prospect_notes', body.prospectNotes], ['follow_up_at', body.followUpAt], ['contacted_at', body.contactedAt]];
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of fields) if (value !== undefined) { values.push(value === null ? null : value.trim()); assignments.push(`${field}=$${values.length}`); }
  if (body.name !== undefined) { values.push('manual'); assignments.push(`identity_name_source=$${values.length}`); }
  if (body.website !== undefined || body.verifiedDomain !== undefined) {
    const identityDomain = normalizeCompanyDomain(body.verifiedDomain ?? body.website ?? '');
    values.push(identityDomain); assignments.push(`identity_domain=$${values.length}`);
    values.push('manual'); assignments.push(`identity_domain_source=$${values.length}`);
  }
  if (!assignments.length) return reply.code(400).send({ error: 'No changes supplied' });
  values.push((request.params as { id: string }).id);
  const result = await pool.query(`UPDATE employers SET ${assignments.join(', ')}, updated_at=now() WHERE id=$${values.length} RETURNING *`, values);
  if (!result.rows[0]) return reply.code(404).send({ error: 'Company not found' });
  return result.rows[0];
});

app.get('/api/listings/:id', async (request, reply) => {
  const listingId = (request.params as { id: string }).id;
  const [result, eventsResult] = await Promise.all([
    pool.query(`SELECT l.*, b.board_identifier, b.board_url, e.id AS employer_id, e.name AS employer_name, e.website AS employer_website FROM job_listings l JOIN job_boards b ON b.id = l.board_id JOIN employers e ON e.id = b.employer_id WHERE l.id = $1`, [listingId]),
    pool.query(`SELECT event_type, observed_at, source_updated_at, previous_value, current_value, metadata FROM listing_events WHERE listing_id=$1 ORDER BY observed_at DESC LIMIT 100`, [listingId])
  ]);
  if (!result.rows[0]) return reply.code(404).send({ error: 'Listing not found' });
  return { ...result.rows[0], events: eventsResult.rows };
});

app.patch('/api/listings/:id', async (request, reply) => {
  const body = request.body as { status?: string };
  if (!body.status || !listingStatuses.includes(body.status as JobListingStatus)) return reply.code(400).send({ error: 'status must be new, saved, dismissed, or applied' });
  const result = await pool.query('UPDATE job_listings SET status=$1, updated_at=now() WHERE id=$2 RETURNING *', [body.status, (request.params as { id: string }).id]);
  if (!result.rows[0]) return reply.code(404).send({ error: 'Listing not found' });
  return result.rows[0];
});

app.get('/api/job-boards', async (request) => {
  const query = request.query as { limit?: string; offset?: string; status?: string; provider?: string; employer?: string };
  const values: unknown[] = []; const conditions: string[] = [];
  if (query.status && ['active', 'disabled'].includes(query.status)) { values.push(query.status); conditions.push(`b.status=$${values.length}`); }
  if (provider(query.provider)) { values.push(query.provider); conditions.push(`b.provider=$${values.length}`); }
  if (query.employer) { values.push(`%${query.employer}%`); conditions.push(`e.name ILIKE $${values.length}`); }
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50)); const offset = Math.max(0, Number(query.offset) || 0); const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const boards = await pool.query(`SELECT b.*, e.name AS employer_name, e.website AS company_website, (SELECT count(*)::int FROM job_listings l WHERE l.board_id=b.id AND l.is_active) AS active_listing_count FROM job_boards b JOIN employers e ON e.id=b.employer_id ${where} ORDER BY b.status, e.name, b.provider LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]);
  const total = await pool.query(`SELECT count(*)::int AS count FROM job_boards b JOIN employers e ON e.id=b.employer_id ${where}`, values);
  return { boards: boards.rows, total: total.rows[0].count, limit, offset };
});

app.get('/api/listing-poll-tasks', async (request) => {
  const query = request.query as { limit?: string; historyLimit?: string };
  const activeLimit = Math.min(500, Math.max(1, Number(query.limit) || 200));
  const historyLimit = Math.min(200, Math.max(1, Number(query.historyLimit) || 100));
  const select = `SELECT t.*, e.id AS employer_id, b.provider, b.board_identifier, b.board_url, e.name AS employer_name,
      ROUND(EXTRACT(EPOCH FROM (COALESCE(t.completed_at, now()) - t.started_at)) * 1000)::int AS duration_ms`;
  const [active, history] = await Promise.all([
    pool.query(`${select}, ROW_NUMBER() OVER (ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END, t.queued_at)::int AS queue_position
      FROM listing_poll_tasks t JOIN job_boards b ON b.id=t.board_id JOIN employers e ON e.id=b.employer_id
      WHERE t.status IN ('queued', 'running')
      ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END, t.queued_at
      LIMIT $1`, [activeLimit]),
    pool.query(`${select}
      FROM listing_poll_tasks t JOIN job_boards b ON b.id=t.board_id JOIN employers e ON e.id=b.employer_id
      WHERE t.status IN ('completed', 'failed')
      ORDER BY t.completed_at DESC NULLS LAST
      LIMIT $1`, [historyLimit])
  ]);
  return { active: active.rows, history: history.rows, tasks: [...active.rows, ...history.rows] };
});

app.get('/api/company-enrichment-tasks', async (request) => {
  const query = request.query as { limit?: string; historyLimit?: string };
  const activeLimit = Math.min(500, Math.max(1, Number(query.limit) || 200));
  const historyLimit = Math.min(200, Math.max(1, Number(query.historyLimit) || 100));
  const select = `SELECT t.*, e.name AS employer_name, e.website AS company_website,
      ROUND(EXTRACT(EPOCH FROM (COALESCE(t.completed_at, now()) - t.started_at)) * 1000)::int AS duration_ms`;
  const [active, history] = await Promise.all([
    pool.query(`${select}, ROW_NUMBER() OVER (ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END, t.queued_at)::int AS queue_position
      FROM company_enrichment_tasks t JOIN employers e ON e.id=t.employer_id
      WHERE t.status IN ('queued', 'running')
      ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END, t.queued_at
      LIMIT $1`, [activeLimit]),
    pool.query(`${select}
      FROM company_enrichment_tasks t JOIN employers e ON e.id=t.employer_id
      WHERE t.status IN ('completed', 'failed')
      ORDER BY t.completed_at DESC NULLS LAST
      LIMIT $1`, [historyLimit])
  ]);
  return { active: active.rows, history: history.rows, tasks: [...active.rows, ...history.rows] };
});

app.get('/api/company-social-tasks', async (request) => {
  const query = request.query as { limit?: string; historyLimit?: string };
  const activeLimit = Math.min(500, Math.max(1, Number(query.limit) || 200));
  const historyLimit = Math.min(200, Math.max(1, Number(query.historyLimit) || 100));
  const select = `SELECT t.*, e.name AS employer_name,
      ROUND(EXTRACT(EPOCH FROM (COALESCE(t.completed_at, now()) - t.started_at)) * 1000)::int AS duration_ms`;
  const [active, history] = await Promise.all([
    pool.query(`${select}, ROW_NUMBER() OVER (ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END, t.queued_at)::int AS queue_position
      FROM company_social_poll_tasks t JOIN employers e ON e.id=t.employer_id
      WHERE t.status IN ('queued', 'running')
      ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END, t.queued_at LIMIT $1`, [activeLimit]),
    pool.query(`${select}
      FROM company_social_poll_tasks t JOIN employers e ON e.id=t.employer_id
      WHERE t.status IN ('completed', 'failed')
      ORDER BY t.completed_at DESC NULLS LAST LIMIT $1`, [historyLimit])
  ]);
  return { active: active.rows, history: history.rows, tasks: [...active.rows, ...history.rows] };
});

app.post('/api/job-boards', async (request, reply) => {
  const body = request.body as { employerName?: string; companyWebsite?: string; provider?: string; boardIdentifier?: string; boardUrl?: string; discoverySource?: string; pollingIntervalSeconds?: number };
  if (!provider(body.provider) || !body.employerName?.trim()) return reply.code(400).send({ error: 'provider and employerName are required' });
  const identifier = boardIdentifier(body.boardIdentifier || body.boardUrl, body.provider);
  if (!identifier) return reply.code(400).send({ error: 'boardIdentifier or boardUrl is required' });
  const employerName = body.employerName.trim();
  const board = await withTransaction(async (client) => {
    const companyWebsite = body.companyWebsite?.trim() ?? '';
    const employer = await client.query(`INSERT INTO employers (name, website, identity_domain, identity_name_source, identity_domain_source) VALUES ($1,$2,$3,'manual',CASE WHEN $3='' THEN 'legacy' ELSE 'manual' END) ON CONFLICT (name, website) DO UPDATE SET updated_at=now() RETURNING id`, [employerName, companyWebsite, normalizeCompanyDomain(companyWebsite)]);
    const host = body.provider === 'greenhouse' ? 'boards.greenhouse.io' : body.provider === 'ashby' ? 'jobs.ashbyhq.com' : body.provider === 'lever' ? 'jobs.lever.co' : body.provider === 'remotive' ? 'remotive.com/remote-jobs' : 'adzuna.com';
    const result = await client.query(`INSERT INTO job_boards (employer_id, provider, board_identifier, board_url, discovery_source, polling_interval_seconds) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider, board_identifier) DO UPDATE SET employer_id=EXCLUDED.employer_id, board_url=EXCLUDED.board_url, discovery_source=EXCLUDED.discovery_source, polling_interval_seconds=EXCLUDED.polling_interval_seconds, status='active', updated_at=now() RETURNING *`, [employer.rows[0].id, body.provider, identifier, body.boardUrl?.trim() || `https://${host}/${identifier}`, body.discoverySource?.trim() || 'manual', Math.max(60, Number(body.pollingIntervalSeconds) || 3_600)]);
    return result.rows[0];
  });
  return reply.code(201).send(board);
});

app.patch('/api/job-boards/:id', async (request, reply) => {
  const body = request.body as { status?: string; pollingIntervalSeconds?: number };
  const assignments: string[] = []; const values: unknown[] = [];
  if (body.status !== undefined) { if (!['active', 'disabled'].includes(body.status)) return reply.code(400).send({ error: 'status must be active or disabled' }); values.push(body.status); assignments.push(`status=$${values.length}`); }
  if (body.pollingIntervalSeconds !== undefined) { values.push(Math.max(60, Number(body.pollingIntervalSeconds) || 3_600)); assignments.push(`polling_interval_seconds=$${values.length}`); }
  if (!assignments.length) return reply.code(400).send({ error: 'No changes supplied' });
  values.push((request.params as { id: string }).id);
  const result = await pool.query(`UPDATE job_boards SET ${assignments.join(',')}, updated_at=now() WHERE id=$${values.length} RETURNING *`, values);
  if (!result.rows[0]) return reply.code(404).send({ error: 'Board not found' });
  return result.rows[0];
});

app.delete('/api/job-boards/:id', async (request) => { await pool.query(`UPDATE job_boards SET status='disabled', updated_at=now() WHERE id=$1`, [(request.params as { id: string }).id]); return { ok: true }; });

app.get('/api/listing-discovery/jobs', async (request) => ({ jobs: await getDiscoveryJobs(Number((request.query as { limit?: string }).limit) || 20) }));

app.get('/api/listing-discovery/candidates', async (request) => {
  const query = request.query as { status?: string; provider?: string; limit?: string };
  const values: unknown[] = []; const conditions: string[] = [];
  if (query.status && ['candidate', 'validated', 'rejected', 'imported'].includes(query.status)) { values.push(query.status); conditions.push(`status=$${values.length}`); }
  if (query.provider && atsProviders.includes(query.provider as AtsProvider)) { values.push(query.provider); conditions.push(`provider=$${values.length}`); }
  values.push(Math.min(500, Math.max(1, Number(query.limit) || 100)));
  return { candidates: (await pool.query(`SELECT * FROM listing_discovery_candidates ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT $${values.length}`, values)).rows };
});

app.post('/api/listing-discovery/jobs', async (request, reply) => {
  const body = request.body as { mode?: string; providers?: string[] };
  if (body.mode && !['full', 'recent'].includes(body.mode)) return reply.code(400).send({ error: 'mode must be full or recent' });
  const mode = body.mode === 'full' ? 'full' : 'recent';
  return reply.code(202).send(await createDiscoveryJob(mode, body.providers ?? ['greenhouse', 'ashby', 'lever']));
});

app.patch('/api/opportunities/:id', async (request, reply) => {
  const body = request.body as { status?: OpportunityStatus; signal_category?: SignalCategory; suppressed?: boolean };
  if (body.status && !['unread', 'interesting', 'dismissed', 'contacted'].includes(body.status)) return reply.code(400).send({ error: 'Invalid status' });
  if (body.signal_category && !['direct_hiring', 'service_request', 'employee_referral', 'firsthand_announcement', 'aggregated_listing', 'uncertain'].includes(body.signal_category)) return reply.code(400).send({ error: 'Invalid signal category' });
  if (!body.status && !body.signal_category && body.suppressed === undefined) return reply.code(400).send({ error: 'No changes supplied' });
  const values: unknown[] = []; const assignments: string[] = [];
  if (body.status) { values.push(body.status); assignments.push(`status = $${values.length}`); }
  if (body.signal_category) { values.push(body.signal_category); assignments.push(`signal_category = $${values.length}, classification_version = classification_version + 1`); }
  if (body.suppressed !== undefined) { values.push(Boolean(body.suppressed)); assignments.push(`suppressed = $${values.length}`); }
  values.push((request.params as { id: string }).id);
  const result = await pool.query(`UPDATE opportunities SET ${assignments.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
  if (!result.rows[0]) return reply.code(404).send({ error: 'Opportunity not found' });
  events.emit('opportunity', result.rows[0]);
  return result.rows[0];
});

app.get('/api/rules', async () => ({ rules: await getRules() }));

app.get('/api/authors', async (request) => {
  const classification = (request.query as { classification?: string }).classification;
  const values: unknown[] = []; const where = classification && ['unknown', 'aggregator', 'employer', 'legitimate_employer'].includes(classification) ? (values.push(classification), `WHERE classification = $${values.length}`) : '';
  const result = await pool.query(`SELECT * FROM author_profiles ${where} ORDER BY observed_hiring_posts DESC, updated_at DESC LIMIT 100`, values);
  return { authors: result.rows };
});

app.get('/api/authors/:id', async (request, reply) => {
  const result = await pool.query('SELECT * FROM author_profiles WHERE id = $1', [(request.params as { id: string }).id]);
  if (!result.rows[0]) return reply.code(404).send({ error: 'Author not found' });
  return result.rows[0];
});

app.patch('/api/authors/:id', async (request, reply) => {
  const body = request.body as { classification?: AuthorClassification; is_known_aggregator?: boolean; suspected_automated_syndication?: boolean };
  if (body.classification && !['unknown', 'aggregator', 'employer', 'legitimate_employer'].includes(body.classification)) return reply.code(400).send({ error: 'Invalid author classification' });
  const values: unknown[] = []; const assignments: string[] = [];
  for (const field of ['classification', 'is_known_aggregator', 'suspected_automated_syndication'] as const) if (body[field] !== undefined) { values.push(field === 'classification' ? body[field] : Boolean(body[field])); assignments.push(`${field} = $${values.length}`); }
  if (!assignments.length) return reply.code(400).send({ error: 'No changes supplied' });
  values.push((request.params as { id: string }).id);
  const result = await pool.query(`UPDATE author_profiles SET ${assignments.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`, values);
  if (!result.rows[0]) return reply.code(404).send({ error: 'Author not found' });
  return result.rows[0];
});

app.get('/api/aggregator-registry', async () => ({ entries: (await pool.query('SELECT * FROM aggregator_registry ORDER BY created_at')).rows }));

app.post('/api/aggregator-registry', async (request, reply) => {
  const body = request.body as { match_type?: string; pattern?: string; label?: string; notes?: string; enabled?: boolean };
  if (!body.pattern?.trim() || !body.label?.trim() || !['account', 'domain', 'text'].includes(body.match_type ?? '')) return reply.code(400).send({ error: 'match_type, pattern, and label are required' });
  const result = await pool.query(`INSERT INTO aggregator_registry (match_type, pattern, label, notes, enabled) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [body.match_type, body.pattern.trim().toLowerCase(), body.label.trim(), body.notes ?? '', body.enabled !== false]);
  return reply.code(201).send(result.rows[0]);
});

app.patch('/api/aggregator-registry/:id', async (request, reply) => {
  const body = request.body as { pattern?: string; label?: string; notes?: string; enabled?: boolean };
  const values: unknown[] = []; const assignments: string[] = [];
  for (const field of ['pattern', 'label', 'notes', 'enabled'] as const) if (body[field] !== undefined) { values.push(field === 'enabled' ? Boolean(body[field]) : String(body[field]).trim()); assignments.push(`${field} = $${values.length}`); }
  if (!assignments.length) return reply.code(400).send({ error: 'No changes supplied' });
  values.push((request.params as { id: string }).id);
  const result = await pool.query(`UPDATE aggregator_registry SET ${assignments.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`, values);
  if (!result.rows[0]) return reply.code(404).send({ error: 'Registry entry not found' });
  return result.rows[0];
});

app.delete('/api/aggregator-registry/:id', async (request) => { await pool.query('DELETE FROM aggregator_registry WHERE id = $1', [(request.params as { id: string }).id]); return { ok: true }; });

app.post('/api/rules', async (request, reply) => {
  const body = request.body as Partial<{ name: string; pattern: string; match_type: string; category: string; weight: number; negative: boolean; enabled: boolean }>;
  if (!body.name?.trim() || !body.pattern?.trim() || !['phrase', 'regex'].includes(body.match_type ?? '')) return reply.code(400).send({ error: 'name, pattern, and match_type are required' });
  if (body.match_type === 'regex') { try { new RegExp(body.pattern, 'iu'); } catch { return reply.code(400).send({ error: 'Invalid regular expression' }); } }
  const result = await pool.query(`INSERT INTO detection_rules (name, pattern, match_type, category, weight, negative, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [body.name.trim(), body.pattern.trim(), body.match_type, body.category ?? 'hiring', Number(body.weight) || 0, Boolean(body.negative), body.enabled !== false]);
  return reply.code(201).send(result.rows[0]);
});

app.patch('/api/rules/:id', async (request, reply) => {
  const body = request.body as Partial<{ name: string; pattern: string; match_type: string; category: string; weight: number; negative: boolean; enabled: boolean }>;
  if (body.match_type && !['phrase', 'regex'].includes(body.match_type)) return reply.code(400).send({ error: 'Invalid match_type' });
  if (body.match_type === 'regex' && body.pattern) { try { new RegExp(body.pattern, 'iu'); } catch { return reply.code(400).send({ error: 'Invalid regular expression' }); } }
  const fields = ['name', 'pattern', 'match_type', 'category', 'weight', 'negative', 'enabled'];
  const values: unknown[] = [];
  const assignments: string[] = [];
  for (const field of fields) if (body[field as keyof typeof body] !== undefined) { values.push(field === 'weight' ? Number(body[field as keyof typeof body]) || 0 : body[field as keyof typeof body]); assignments.push(`${field} = $${values.length}`); }
  if (!assignments.length) return reply.code(400).send({ error: 'No changes supplied' });
  values.push((request.params as { id: string }).id);
  const result = await pool.query(`UPDATE detection_rules SET ${assignments.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`, values);
  if (!result.rows[0]) return reply.code(404).send({ error: 'Rule not found' });
  return result.rows[0];
});

app.delete('/api/rules/:id', async (request, reply) => {
  await pool.query('DELETE FROM detection_rules WHERE id = $1', [(request.params as { id: string }).id]);
  return { ok: true };
});

app.get('/api/settings', async () => {
  const preferences = await getPreferences();
  return { preferences, smtp: { configured: Boolean(config.smtp.host && config.smtp.from && config.smtp.recipient) }, devMode: config.devMode };
});

app.put('/api/settings', async (request, reply) => {
  const body = request.body as Record<string, unknown>;
  const current = await getPreferences();
  const allowed = ['notificationsEnabled', 'notifyRecovered', 'listingsNotificationsEnabled'];
  const changes: Record<string, unknown> = {};
  for (const key of allowed) if (body[key] !== undefined) changes[key] = body[key];
  return { preferences: await setPreferences({ ...current, ...changes }) };
});

app.post('/api/notifications/test', async (_request, reply) => {
  try { await sendTestEmail(); return { ok: true }; }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});

app.get('/api/monitoring', async () => {
  const states = await pool.query('SELECT * FROM ingestion_states ORDER BY source');
  const notification = await pool.query(`SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status IN ('pending','failed'))::int AS pending, count(*) FILTER (WHERE status = 'failed')::int AS failed FROM notifications`);
  const listingBoards = await pool.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status='active')::int AS active, count(*) FILTER (WHERE last_successful_poll IS NOT NULL)::int AS polled, count(*) FILTER (WHERE consecutive_failure_count > 0)::int AS failing FROM job_boards`);
  const listingCounts = await pool.query(`SELECT count(*) FILTER (WHERE is_active)::int AS active, count(*) FILTER (WHERE status='saved')::int AS saved, count(*) FILTER (WHERE status='applied')::int AS applied, count(*) FILTER (WHERE status='dismissed')::int AS dismissed FROM job_listings`);
  const listingNotifications = await pool.query(`SELECT count(*) FILTER (WHERE status='sent')::int AS sent, count(*) FILTER (WHERE status IN ('pending','failed'))::int AS pending, count(*) FILTER (WHERE status='failed')::int AS failed FROM listing_notifications`);
  const discovery = await pool.query(`SELECT j.*, (SELECT count(*)::int FROM listing_discovery_candidates c WHERE c.discovery_job_id=j.id) AS candidate_count, (SELECT count(*)::int FROM listing_discovery_candidates c WHERE c.discovery_job_id=j.id AND c.status='imported') AS imported_count FROM listing_discovery_jobs j ORDER BY j.created_at DESC LIMIT 1`);
  return { sources: states.rows, notifications: notification.rows[0], listingBoards: listingBoards.rows[0], listingCounts: listingCounts.rows[0], listingNotifications: listingNotifications.rows[0], discovery: discovery.rows[0] ?? null, smtpConfigured: Boolean(config.smtp.host && config.smtp.from && config.smtp.recipient) };
});

app.get('/api/events', async (request, reply) => {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const opportunity = (data: unknown) => send('opportunity', data);
  const health = (data: unknown) => send('health', data);
  const listings = (data: unknown) => send('listings', data);
  const discovery = (data: unknown) => send('listing-discovery', data);
  const listingTask = (data: unknown) => send('listing-task', data);
  const companyEnrichmentTask = (data: unknown) => send('company-enrichment-task', data);
  const companySocialTask = (data: unknown) => send('company-social-task', data);
  events.on('opportunity', opportunity); events.on('health', health); events.on('listings', listings); events.on('listing-health', health); events.on('listing-discovery', discovery); events.on('listing-task', listingTask); events.on('company-enrichment-task', companyEnrichmentTask); events.on('company-social-task', companySocialTask);
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
  request.raw.on('close', () => { clearInterval(heartbeat); events.off('opportunity', opportunity); events.off('health', health); events.off('listings', listings); events.off('listing-health', health); events.off('listing-discovery', discovery); events.off('listing-task', listingTask); events.off('company-enrichment-task', companyEnrichmentTask); events.off('company-social-task', companySocialTask); });
});

app.post('/api/dev/sample', async (_request, reply) => {
  if (!config.devMode) return reply.code(404).send({ error: 'Development mode is disabled' });
  const now = new Date();
  const samples: NormalizedPost[] = [
    { source: 'bluesky', sourceId: `sample-${Date.now()}-1`, authorName: 'Maya Chen', authorHandle: '@maya.example', authorUrl: 'https://bsky.app/profile/maya.example', sourceUrl: 'https://bsky.app/profile/maya.example/post/sample', text: "We're hiring a remote backend TypeScript contractor to help with our infrastructure. DM me if interested!", publishedAt: now, raw: { sample: true } },
    { source: 'hacker_news', sourceId: `sample-${Date.now()}-2`, authorName: 'founder', authorHandle: 'founder', authorUrl: 'https://news.ycombinator.com/user?id=founder', sourceUrl: 'https://news.ycombinator.com/item?id=sample', text: 'Our startup is looking for its first engineering hire. Worldwide remote, Node.js and PostgreSQL.', publishedAt: now, raw: { sample: true } }
  ];
  for (const sample of samples) await processPost(sample);
  return { ok: true, count: samples.length };
});

app.get('/', async (_request, reply) => reply.sendFile('index.html'));

export async function startServer() {
  if (config.runMigrations) {
    await migrate();
    await startDeferredMigrations();
  }
  await app.listen({ port: config.port, host: '0.0.0.0' });
  return app;
}

export { app };
