import path from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { getPreferences, getRules, migrate, pool, setPreferences, withTransaction } from './db.js';
import { sendTestEmail } from './notifications.js';
import { events, processPost } from './pipeline-service.js';
import { createDiscoveryJob, getDiscoveryJobs } from './listings/discovery.js';
import type { AtsProvider, AuthorClassification, JobListingStatus, NormalizedPost, OpportunityStatus, SignalCategory } from './types.js';

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

app.get('/api/opportunities', async (request) => {
  const query = request.query as { source?: string; status?: string; sort?: string; minScore?: string; minQuality?: string; minLocationFit?: string; signalCategory?: string; locationFit?: string; workMode?: string; includeSuppressed?: string; limit?: string; offset?: string };
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (query.source && ['bluesky', 'hacker_news', 'mastodon', 'reddit'].includes(query.source)) { values.push(query.source); conditions.push(`source = $${values.length}`); }
  if (query.status && ['unread', 'interesting', 'dismissed', 'contacted'].includes(query.status)) { values.push(query.status); conditions.push(`status = $${values.length}`); }
  if (query.minScore && Number.isFinite(Number(query.minScore))) { values.push(Number(query.minScore)); conditions.push(`score >= $${values.length}`); }
  if (query.minQuality && Number.isFinite(Number(query.minQuality))) { values.push(Number(query.minQuality)); conditions.push(`signal_quality >= $${values.length}`); }
  if (query.minLocationFit && Number.isFinite(Number(query.minLocationFit))) { values.push(Number(query.minLocationFit)); conditions.push(`location_fit_score >= $${values.length}`); }
  if (query.signalCategory && ['direct_hiring', 'software_request', 'employee_referral', 'firsthand_announcement', 'aggregated_listing', 'uncertain'].includes(query.signalCategory)) { values.push(query.signalCategory); conditions.push(`signal_category = $${values.length}`); }
  if (query.locationFit && ['excellent', 'good', 'possible', 'poor', 'unknown'].includes(query.locationFit)) { values.push(query.locationFit); conditions.push(`location_fit = $${values.length}`); }
  if (query.workMode && ['remote', 'hybrid', 'onsite', 'unknown'].includes(query.workMode)) { values.push(query.workMode); conditions.push(`location_signals->>'workMode' = $${values.length}`); }
  const sort = query.sort === 'location' ? 'location_fit_score DESC, signal_quality DESC, personal_relevance DESC, published_at DESC' : query.sort === 'score' ? 'personal_relevance DESC, signal_quality DESC, published_at DESC' : query.sort === 'quality' ? 'signal_quality DESC, personal_relevance DESC, published_at DESC' : query.sort === 'published' ? 'published_at DESC' : 'first_seen_at DESC';
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
  const query = request.query as { provider?: string; status?: string; employer?: string; employmentType?: string; seniority?: string; location?: string; salaryCurrency?: string; minSalary?: string; locationFit?: string; workMode?: string; minScore?: string; minLocationFit?: string; sort?: string; active?: string; limit?: string; offset?: string };
  const values: unknown[] = []; const conditions: string[] = [];
  if (provider(query.provider)) { values.push(query.provider); conditions.push(`l.provider = $${values.length}`); }
  if (query.status && listingStatuses.includes(query.status as JobListingStatus)) { values.push(query.status); conditions.push(`l.status = $${values.length}`); }
  if (query.employer) { values.push(`%${query.employer}%`); conditions.push(`e.name ILIKE $${values.length}`); }
  if (query.employmentType) { values.push(`%${query.employmentType}%`); conditions.push(`l.employment_type ILIKE $${values.length}`); }
  if (query.seniority) { values.push(`%${query.seniority}%`); conditions.push(`l.seniority ILIKE $${values.length}`); }
  if (query.location) { values.push(`%${query.location}%`); conditions.push(`(l.location ILIKE $${values.length} OR l.secondary_locations::text ILIKE $${values.length} OR l.geographic_restrictions::text ILIKE $${values.length})`); }
  if (query.salaryCurrency) { values.push(query.salaryCurrency.toUpperCase()); conditions.push(`l.compensation_currency = $${values.length}`); }
  if (query.minSalary && Number.isFinite(Number(query.minSalary))) { values.push(Number(query.minSalary)); conditions.push(`COALESCE(l.compensation_max, l.compensation_min) >= $${values.length}`); }
  if (query.locationFit && ['excellent', 'good', 'possible', 'poor', 'unknown'].includes(query.locationFit)) { values.push(query.locationFit); conditions.push(`l.location_fit = $${values.length}`); }
  if (query.workMode && ['remote', 'hybrid', 'onsite', 'unknown'].includes(query.workMode)) { values.push(query.workMode); conditions.push(`l.remote_mode = $${values.length}`); }
  if (query.minScore && Number.isFinite(Number(query.minScore))) { values.push(Number(query.minScore)); conditions.push(`l.personal_relevance >= $${values.length}`); }
  if (query.minLocationFit && Number.isFinite(Number(query.minLocationFit))) { values.push(Number(query.minLocationFit)); conditions.push(`l.location_fit_score >= $${values.length}`); }
  if (query.active !== 'false') conditions.push('l.is_active = true');
  const sort = query.sort === 'location' ? 'l.location_fit_score DESC, l.personal_relevance DESC, l.source_updated_at DESC NULLS LAST' : query.sort === 'relevance' ? 'l.personal_relevance DESC, l.location_fit_score DESC, l.source_updated_at DESC NULLS LAST' : query.sort === 'updated' ? 'l.source_updated_at DESC NULLS LAST' : 'l.first_observed_at DESC';
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 100)); const offset = Math.max(0, Number(query.offset) || 0);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit, offset);
  const result = await pool.query(`SELECT l.*, b.board_identifier, b.board_url, b.status AS board_status, e.id AS employer_id, e.name AS employer_name, e.website AS employer_website FROM job_listings l JOIN job_boards b ON b.id = l.board_id JOIN employers e ON e.id = b.employer_id ${where} ORDER BY ${sort} LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  const total = await pool.query(`SELECT count(*)::int AS count FROM job_listings l JOIN job_boards b ON b.id = l.board_id JOIN employers e ON e.id = b.employer_id ${where}`, values.slice(0, -2));
  return { listings: result.rows, total: total.rows[0].count };
});

app.get('/api/listings/:id', async (request, reply) => {
  const result = await pool.query(`SELECT l.*, b.board_identifier, b.board_url, e.id AS employer_id, e.name AS employer_name, e.website AS employer_website FROM job_listings l JOIN job_boards b ON b.id = l.board_id JOIN employers e ON e.id = b.employer_id WHERE l.id = $1`, [(request.params as { id: string }).id]);
  if (!result.rows[0]) return reply.code(404).send({ error: 'Listing not found' });
  return result.rows[0];
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

app.post('/api/job-boards', async (request, reply) => {
  const body = request.body as { employerName?: string; companyWebsite?: string; provider?: string; boardIdentifier?: string; boardUrl?: string; discoverySource?: string; pollingIntervalSeconds?: number };
  if (!provider(body.provider) || !body.employerName?.trim()) return reply.code(400).send({ error: 'provider and employerName are required' });
  const identifier = boardIdentifier(body.boardIdentifier || body.boardUrl, body.provider);
  if (!identifier) return reply.code(400).send({ error: 'boardIdentifier or boardUrl is required' });
  const employerName = body.employerName.trim();
  const board = await withTransaction(async (client) => {
    const employer = await client.query(`INSERT INTO employers (name, website) VALUES ($1,$2) ON CONFLICT (name, website) DO UPDATE SET updated_at=now() RETURNING id`, [employerName, body.companyWebsite?.trim() ?? '']);
    const host = body.provider === 'greenhouse' ? 'boards.greenhouse.io' : body.provider === 'ashby' ? 'jobs.ashbyhq.com' : body.provider === 'lever' ? 'jobs.lever.co' : body.provider === 'remotive' ? 'remotive.com/remote-jobs' : 'adzuna.com';
    const result = await client.query(`INSERT INTO job_boards (employer_id, provider, board_identifier, board_url, discovery_source, polling_interval_seconds) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider, board_identifier) DO UPDATE SET employer_id=EXCLUDED.employer_id, board_url=EXCLUDED.board_url, discovery_source=EXCLUDED.discovery_source, polling_interval_seconds=EXCLUDED.polling_interval_seconds, status='active', updated_at=now() RETURNING *`, [employer.rows[0].id, body.provider, identifier, body.boardUrl?.trim() || `https://${host}/${identifier}`, body.discoverySource?.trim() || 'manual', Math.max(60, Number(body.pollingIntervalSeconds) || 900)]);
    return result.rows[0];
  });
  return reply.code(201).send(board);
});

app.patch('/api/job-boards/:id', async (request, reply) => {
  const body = request.body as { status?: string; pollingIntervalSeconds?: number };
  const assignments: string[] = []; const values: unknown[] = [];
  if (body.status !== undefined) { if (!['active', 'disabled'].includes(body.status)) return reply.code(400).send({ error: 'status must be active or disabled' }); values.push(body.status); assignments.push(`status=$${values.length}`); }
  if (body.pollingIntervalSeconds !== undefined) { values.push(Math.max(60, Number(body.pollingIntervalSeconds) || 900)); assignments.push(`polling_interval_seconds=$${values.length}`); }
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
  if (body.signal_category && !['direct_hiring', 'software_request', 'employee_referral', 'firsthand_announcement', 'aggregated_listing', 'uncertain'].includes(body.signal_category)) return reply.code(400).send({ error: 'Invalid signal category' });
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
  const allowed = ['minimumNotificationScore', 'minimumNotificationSignalQuality', 'minimumNotificationPersonalRelevance', 'minimumNotificationLocationFitScore', 'notificationsEnabled', 'notifyRecovered', 'listingsNotificationsEnabled', 'minimumListingRelevance', 'minimumListingLocationFitScore', 'technologyTerms', 'roleTerms', 'remoteTerms', 'internationalTerms', 'contractTerms', 'contactTerms', 'weights', 'locationProfile'];
  const changes: Record<string, unknown> = {};
  for (const key of allowed) if (body[key] !== undefined) changes[key] = body[key];
  for (const key of ['minimumNotificationScore', 'minimumNotificationSignalQuality', 'minimumNotificationPersonalRelevance', 'minimumNotificationLocationFitScore']) if (changes[key] !== undefined && (!Number.isFinite(Number(changes[key])) || Number(changes[key]) < 0 || Number(changes[key]) > 100)) return reply.code(400).send({ error: `${key} must be 0-100` });
  for (const key of ['minimumListingRelevance', 'minimumListingLocationFitScore']) if (changes[key] !== undefined && (!Number.isFinite(Number(changes[key])) || Number(changes[key]) < 0 || Number(changes[key]) > 100)) return reply.code(400).send({ error: `${key} must be 0-100` });
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
  const listingCounts = await pool.query(`SELECT count(*) FILTER (WHERE is_active)::int AS active, count(*) FILTER (WHERE status='saved')::int AS saved, count(*) FILTER (WHERE status='applied')::int AS applied, count(*) FILTER (WHERE status='dismissed')::int AS dismissed, count(*) FILTER (WHERE location_fit IN ('excellent','good'))::int AS good_location FROM job_listings`);
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
  events.on('opportunity', opportunity); events.on('health', health); events.on('listings', listings); events.on('listing-health', health); events.on('listing-discovery', discovery);
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
  request.raw.on('close', () => { clearInterval(heartbeat); events.off('opportunity', opportunity); events.off('health', health); events.off('listings', listings); events.off('listing-health', health); events.off('listing-discovery', discovery); });
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
  await migrate();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  return app;
}

export { app };
