import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { adapterFor, normalizeCompensation } from './ats.js';
import { analyzeListing } from './pipeline.js';
import { classifyListing } from './classification.js';
import { getPreferences, pool, withTransaction } from '../db.js';
import { config } from '../config.js';
import type { JobBoard, NormalizedJobListing } from '../types.js';
import { events } from '../pipeline-service.js';

let polling = false;

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }));
}

async function boardRows(): Promise<JobBoard[]> {
  const result = await pool.query(`SELECT b.*, e.name AS employer_name, e.website AS company_website
    FROM job_boards b JOIN employers e ON e.id = b.employer_id WHERE b.status = 'active'
    AND (b.last_successful_poll IS NULL OR b.last_successful_poll + (b.polling_interval_seconds * interval '1 second') <= now())
    ORDER BY b.last_successful_poll NULLS FIRST, b.created_at`);
  return result.rows.map((row) => ({
    id: row.id, employerId: row.employer_id, employerName: row.employer_name, companyWebsite: row.company_website,
    provider: row.provider, boardIdentifier: row.board_identifier, boardUrl: row.board_url, status: row.status, discoverySource: row.discovery_source,
    firstDiscoveredAt: row.first_discovered_at, initializedAt: row.initialized_at, lastSuccessfulPoll: row.last_successful_poll,
    lastAttemptedPoll: row.last_attempted_poll, lastNewListingDiscovered: row.last_new_listing_discovered,
    pollingIntervalSeconds: Number(row.polling_interval_seconds), consecutiveFailureCount: Number(row.consecutive_failure_count), lastError: row.last_error
  }));
}

async function ensureAggregatorBoards() {
  const sources: Array<{ provider: 'remotive' | 'adzuna'; identifier: string; employer: string; url: string; interval: number }> = [
    { provider: 'remotive', identifier: 'remote-jobs', employer: 'Remotive', url: 'https://remotive.com/remote-jobs', interval: config.remotiveBoardPollIntervalSeconds }
  ];
  if (config.adzunaAppId && config.adzunaAppKey) for (const country of config.adzunaCountries) sources.push({ provider: 'adzuna', identifier: country, employer: `Adzuna (${country.toUpperCase()})`, url: `https://www.adzuna.com/${country}`, interval: config.adzunaBoardPollIntervalSeconds });
  for (const source of sources) {
    const employer = await pool.query(`INSERT INTO employers (name, website) VALUES ($1,$2) ON CONFLICT (name, website) DO UPDATE SET updated_at=now() RETURNING id`, [source.employer, source.url]);
    await pool.query(`INSERT INTO job_boards (employer_id, provider, board_identifier, board_url, discovery_source, polling_interval_seconds) VALUES ($1,$2,$3,$4,'aggregator-default',$5) ON CONFLICT (provider, board_identifier) DO UPDATE SET polling_interval_seconds=EXCLUDED.polling_interval_seconds, updated_at=now()`, [employer.rows[0].id, source.provider, source.identifier, source.url, source.interval]);
  }
}

function notificationEligible(analysis: ReturnType<typeof analyzeListing>, preferences: Awaited<ReturnType<typeof getPreferences>>) {
  return preferences.listingsNotificationsEnabled && analysis.locationFitScore >= preferences.minimumListingLocationFitScore;
}

type PollTaskResult = { status: 'completed' | 'failed'; listingsSeen: number; newListings: number; error?: string };

async function finishPollTask(taskId: string, result: PollTaskResult) {
  await pool.query(`UPDATE listing_poll_tasks
    SET status=$2, completed_at=now(), listings_seen=$3, new_listings=$4, error=$5
    WHERE id=$1`, [taskId, result.status, result.listingsSeen, result.newListings, result.error ?? null]);
  events.emit('listing-task', { taskId, ...result });
}

async function queuePollTask(board: JobBoard): Promise<string | null> {
  const result = await pool.query(`INSERT INTO listing_poll_tasks (board_id, status)
    VALUES ($1, 'queued') ON CONFLICT DO NOTHING RETURNING id`, [board.id]);
  return result.rows[0]?.id ?? null;
}

async function markFailure(board: JobBoard, error: unknown): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(`UPDATE job_boards SET last_attempted_poll=now(), consecutive_failure_count=consecutive_failure_count+1, last_error=$2, updated_at=now() WHERE id=$1`, [board.id, message]);
  events.emit('listing-health', { boardId: board.id, provider: board.provider, error: message });
  return message;
}

async function recordListingEvent(client: PoolClient, listingId: string, boardId: string, eventType: string, observedAt: Date, sourceUpdatedAt: Date | null | undefined, previousValue: unknown, currentValue: unknown) {
  await client.query(`INSERT INTO listing_events (listing_id, board_id, event_type, observed_at, source_updated_at, previous_value, current_value)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [listingId, boardId, eventType, observedAt, sourceUpdatedAt ?? null, JSON.stringify(previousValue ?? {}), JSON.stringify(currentValue ?? {})]);
}

function descriptionHash(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

async function processBoard(board: JobBoard, preferences: Awaited<ReturnType<typeof getPreferences>>, taskId: string): Promise<PollTaskResult> {
  await pool.query(`UPDATE listing_poll_tasks SET status='running', started_at=now() WHERE id=$1`, [taskId]);
  events.emit('listing-task', { taskId, status: 'running', boardId: board.id, provider: board.provider, boardIdentifier: board.boardIdentifier });
  const adapter = adapterFor(board.provider);
  await pool.query('UPDATE job_boards SET last_attempted_poll=now(), updated_at=now() WHERE id=$1', [board.id]);
  let listings: NormalizedJobListing[];
  try { listings = await adapter.fetch(board); }
  catch (error) {
    const message = await markFailure(board, error);
    const result = { status: 'failed' as const, listingsSeen: 0, newListings: 0, error: message };
    await finishPollTask(taskId, result);
    return result;
  }
  const observedIds = listings.map((listing) => listing.providerJobId);
  const existing = await pool.query(`SELECT id, provider_job_id, first_observed_at, is_active, consecutive_missing_checks,
      title, location, remote_mode, employment_type, compensation_min, compensation_max, compensation_currency, compensation_period,
      job_category, engineering_specialties, technologies, location_signals,
      md5(description) AS description_hash
    FROM job_listings WHERE board_id=$1`, [board.id]);
  const existingIds = new Set(existing.rows.map((row) => row.provider_job_id as string));
  const baseline = !board.initializedAt;
  let newCount = 0;
  let newEngineeringCount = 0;
  let engineeringCount = 0;
  const missingCount = existing.rows.filter((row) => row.is_active && !observedIds.includes(row.provider_job_id as string)).length;
  const checkedAt = new Date();
  await withTransaction(async (client) => {
    for (const listing of listings) {
      const analysis = analyzeListing(listing, preferences);
      const classification = classifyListing(listing);
      const engineeringSpecialties = classification.engineeringSpecialties;
      const technologies = classification.technologies;
      if (engineeringSpecialties.length) engineeringCount += 1;
      const compensation = normalizeCompensation(listing.compensation);
      const isNew = !existingIds.has(listing.providerJobId);
      if (isNew) newCount += 1;
      if (isNew && engineeringSpecialties.length) newEngineeringCount += 1;
      const result = await client.query(`INSERT INTO job_listings
        (board_id, provider, provider_job_id, title, description_html, description, department, team, location, secondary_locations, remote_mode, geographic_restrictions, employment_type, seniority, compensation, compensation_min, compensation_max, compensation_currency, compensation_period, compensation_estimated, salary_backfilled_at, application_url, original_url, published_at, source_updated_at, first_observed_at, last_observed_at, last_successful_board_check, is_active, consecutive_missing_checks, personal_relevance, relevance_breakdown, location_signals, location_fit, location_fit_score, location_fit_reasons, raw, status, company_name, engineering_specialties, technologies, job_category, primary_specialty, classification_version, classification_method, classification_backfilled_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now(),$21,$22,$23,$24,COALESCE((SELECT first_observed_at FROM job_listings WHERE board_id=$1 AND provider_job_id=$3),$25),$25,$25,true,0,$26,$27,$28,$29,$30,$31,$32,'new',$33,$34,$35,$36,$37,$38,$39,now())
        ON CONFLICT (board_id, provider_job_id) DO UPDATE SET title=EXCLUDED.title, description_html=EXCLUDED.description_html, description=EXCLUDED.description, department=EXCLUDED.department, team=EXCLUDED.team, location=EXCLUDED.location, secondary_locations=EXCLUDED.secondary_locations, remote_mode=EXCLUDED.remote_mode, geographic_restrictions=EXCLUDED.geographic_restrictions, employment_type=EXCLUDED.employment_type, seniority=EXCLUDED.seniority, compensation=EXCLUDED.compensation, compensation_min=EXCLUDED.compensation_min, compensation_max=EXCLUDED.compensation_max, compensation_currency=EXCLUDED.compensation_currency, compensation_period=EXCLUDED.compensation_period, compensation_estimated=EXCLUDED.compensation_estimated, salary_backfilled_at=now(), application_url=EXCLUDED.application_url, original_url=EXCLUDED.original_url, published_at=EXCLUDED.published_at, source_updated_at=EXCLUDED.source_updated_at, last_observed_at=EXCLUDED.last_observed_at, last_successful_board_check=EXCLUDED.last_successful_board_check, is_active=true, consecutive_missing_checks=0, personal_relevance=EXCLUDED.personal_relevance, relevance_breakdown=EXCLUDED.relevance_breakdown, location_signals=EXCLUDED.location_signals, location_fit=EXCLUDED.location_fit, location_fit_score=EXCLUDED.location_fit_score, location_fit_reasons=EXCLUDED.location_fit_reasons, raw=EXCLUDED.raw, company_name=EXCLUDED.company_name, engineering_specialties=EXCLUDED.engineering_specialties, technologies=EXCLUDED.technologies, job_category=EXCLUDED.job_category, primary_specialty=EXCLUDED.primary_specialty, classification_version=EXCLUDED.classification_version, classification_method=EXCLUDED.classification_method, classification_backfilled_at=now(), updated_at=now()
        RETURNING id`, [board.id, board.provider, listing.providerJobId, listing.title, listing.descriptionHtml ?? '', listing.description, listing.department ?? '', listing.team ?? '', listing.location ?? '', JSON.stringify(listing.secondaryLocations ?? []), listing.remoteMode ?? 'unknown', JSON.stringify(listing.geographicRestrictions ?? []), listing.employmentType ?? '', listing.seniority ?? '', JSON.stringify(listing.compensation ?? {}), compensation.min ?? null, compensation.max ?? null, compensation.currency ?? '', compensation.period ?? '', Boolean(compensation.estimated), listing.applicationUrl, listing.originalUrl, listing.publishedAt, listing.updatedAt, checkedAt, analysis.personalRelevance, JSON.stringify(analysis.relevanceBreakdown), JSON.stringify(analysis.locationSignals), analysis.locationFit, analysis.locationFitScore, JSON.stringify(analysis.locationFitReasons), JSON.stringify(listing.raw), listing.companyName ?? '', JSON.stringify(engineeringSpecialties), JSON.stringify(technologies), classification.jobCategory, classification.primarySpecialty, classification.version, classification.method]);
      const listingId = result.rows[0].id as string;
      const previous = existing.rows.find((row) => row.provider_job_id === listing.providerJobId);
      const currentCompensation = { min: compensation.min ?? null, max: compensation.max ?? null, currency: compensation.currency ?? '', period: compensation.period ?? '' };
      const currentDescriptionHash = descriptionHash(listing.description);
      if (isNew) {
        if (!baseline) await recordListingEvent(client, listingId, board.id, 'first_observed', checkedAt, listing.updatedAt, {}, { title: listing.title, providerJobId: listing.providerJobId });
      } else {
        if (!previous.is_active) await recordListingEvent(client, listingId, board.id, 'reappeared', checkedAt, listing.updatedAt, { isActive: false }, { isActive: true });
        if (previous.title !== listing.title) await recordListingEvent(client, listingId, board.id, 'title_changed', checkedAt, listing.updatedAt, { title: previous.title }, { title: listing.title });
        if (previous.location !== (listing.location ?? '')) await recordListingEvent(client, listingId, board.id, 'location_changed', checkedAt, listing.updatedAt, { location: previous.location }, { location: listing.location ?? '' });
        if (previous.remote_mode !== (listing.remoteMode ?? 'unknown')) await recordListingEvent(client, listingId, board.id, 'work_mode_changed', checkedAt, listing.updatedAt, { workMode: previous.remote_mode }, { workMode: listing.remoteMode ?? 'unknown' });
        if (previous.employment_type !== (listing.employmentType ?? '')) await recordListingEvent(client, listingId, board.id, 'employment_type_changed', checkedAt, listing.updatedAt, { employmentType: previous.employment_type }, { employmentType: listing.employmentType ?? '' });
        const previousCompensation = { min: previous.compensation_min ?? null, max: previous.compensation_max ?? null, currency: previous.compensation_currency ?? '', period: previous.compensation_period ?? '' };
        if (JSON.stringify(previousCompensation) !== JSON.stringify(currentCompensation)) await recordListingEvent(client, listingId, board.id, 'compensation_changed', checkedAt, listing.updatedAt, previousCompensation, currentCompensation);
        if (previous.description_hash !== currentDescriptionHash) await recordListingEvent(client, listingId, board.id, 'description_changed', checkedAt, listing.updatedAt, { hash: previous.description_hash }, { hash: currentDescriptionHash });
      }
      if (isNew && !baseline && notificationEligible(analysis, preferences)) await client.query('INSERT INTO listing_notifications (listing_id) VALUES ($1) ON CONFLICT (listing_id) DO NOTHING', [result.rows[0].id]);
    }
    for (const row of existing.rows) {
      if (row.is_active && !observedIds.includes(row.provider_job_id) && Number(row.consecutive_missing_checks) + 1 >= 3) {
        await recordListingEvent(client, row.id, board.id, 'removed', checkedAt, null,
          { isActive: true, jobCategory: row.job_category, specialties: row.engineering_specialties, technologies: row.technologies, locationSignals: row.location_signals, remoteMode: row.remote_mode, employmentType: row.employment_type },
          { isActive: false, jobCategory: row.job_category, specialties: row.engineering_specialties, technologies: row.technologies, locationSignals: row.location_signals, remoteMode: row.remote_mode, employmentType: row.employment_type });
      }
    }
    await client.query(`UPDATE job_listings SET consecutive_missing_checks=consecutive_missing_checks+1, is_active=CASE WHEN consecutive_missing_checks+1 >= 3 THEN false ELSE is_active END, updated_at=now()
      WHERE board_id=$1 AND is_active=true AND NOT (provider_job_id = ANY($2::text[]))`, [board.id, observedIds]);
    await client.query(`UPDATE job_boards SET initialized_at=COALESCE(initialized_at, now()), last_successful_poll=now(), last_attempted_poll=now(), last_new_listing_discovered=CASE WHEN $2 > 0 THEN now() ELSE last_new_listing_discovered END, consecutive_failure_count=0, last_error=NULL, updated_at=now() WHERE id=$1`, [board.id, newCount]);
    await client.query(`INSERT INTO listing_board_observations (board_id, listings_seen, active_engineering, new_listings, new_engineering, missing_listings) VALUES ($1,$2,$3,$4,$5,$6)`, [board.id, listings.length, engineeringCount, baseline ? 0 : newCount, baseline ? 0 : newEngineeringCount, missingCount]);
  });
  const result = { status: 'completed' as const, listingsSeen: listings.length, newListings: newCount };
  await finishPollTask(taskId, result);
  events.emit('listings', { boardId: board.id, provider: board.provider, newCount, count: listings.length });
  return result;
}

export async function pollListings() {
  if (polling) return;
  polling = true;
  try {
    await ensureAggregatorBoards();
    await pool.query(`UPDATE listing_poll_tasks
      SET status='failed', completed_at=now(), error=COALESCE(error, 'Poller stopped before task completed')
      WHERE status IN ('queued', 'running')`);
    const preferences = await getPreferences();
    const queued = [];
    for (const board of await boardRows()) {
      const taskId = await queuePollTask(board);
      if (taskId) queued.push({ board, taskId });
    }
    if (queued.length) events.emit('listing-task', { status: 'queued', count: queued.length });
    await runWithConcurrency(queued, config.listingsPollConcurrency, async ({ board, taskId }) => {
      try { await processBoard(board, preferences, taskId); }
      catch (error) {
        const message = await markFailure(board, error);
        await finishPollTask(taskId, { status: 'failed', listingsSeen: 0, newListings: 0, error: message });
      }
    });
  }
  finally { polling = false; }
}

export function startListingPolling(intervalMs: number) {
  void pollListings().catch((error) => console.error('listing poll failed', error));
  return setInterval(() => void pollListings().catch((error) => console.error('listing poll failed', error)), intervalMs);
}

export function listingNotificationEligibleForTest(analysis: ReturnType<typeof analyzeListing>, preferences: Awaited<ReturnType<typeof getPreferences>>) { return notificationEligible(analysis, preferences); }
