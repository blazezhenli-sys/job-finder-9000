import { adapterFor } from './ats.js';
import { analyzeListing } from './pipeline.js';
import { getPreferences, pool, withTransaction } from '../db.js';
import { config } from '../config.js';
import type { JobBoard, NormalizedJobListing } from '../types.js';
import { events } from '../pipeline-service.js';

let polling = false;

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
  return preferences.listingsNotificationsEnabled && analysis.personalRelevance >= preferences.minimumListingRelevance && analysis.locationFitScore >= preferences.minimumListingLocationFitScore;
}

async function markFailure(board: JobBoard, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(`UPDATE job_boards SET last_attempted_poll=now(), consecutive_failure_count=consecutive_failure_count+1, last_error=$2, updated_at=now() WHERE id=$1`, [board.id, message]);
  events.emit('listing-health', { boardId: board.id, provider: board.provider, error: message });
}

async function processBoard(board: JobBoard, preferences: Awaited<ReturnType<typeof getPreferences>>) {
  const adapter = adapterFor(board.provider);
  await pool.query('UPDATE job_boards SET last_attempted_poll=now(), updated_at=now() WHERE id=$1', [board.id]);
  let listings: NormalizedJobListing[];
  try { listings = await adapter.fetch(board); }
  catch (error) { await markFailure(board, error); return; }
  const observedIds = listings.map((listing) => listing.providerJobId);
  const existing = await pool.query('SELECT id, provider_job_id, first_observed_at FROM job_listings WHERE board_id=$1', [board.id]);
  const existingIds = new Set(existing.rows.map((row) => row.provider_job_id as string));
  const baseline = !board.initializedAt;
  let newCount = 0;
  const checkedAt = new Date();
  await withTransaction(async (client) => {
    for (const listing of listings) {
      const analysis = analyzeListing(listing, preferences);
      const isNew = !existingIds.has(listing.providerJobId);
      if (isNew) newCount += 1;
      const result = await client.query(`INSERT INTO job_listings
        (board_id, provider, provider_job_id, title, description_html, description, department, team, location, secondary_locations, remote_mode, geographic_restrictions, employment_type, seniority, compensation, application_url, original_url, published_at, source_updated_at, first_observed_at, last_observed_at, last_successful_board_check, is_active, consecutive_missing_checks, personal_relevance, relevance_breakdown, location_signals, location_fit, location_fit_score, location_fit_reasons, raw, status, company_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,COALESCE((SELECT first_observed_at FROM job_listings WHERE board_id=$1 AND provider_job_id=$3),$20),$20,$20,true,0,$21,$22,$23,$24,$25,$26,$27,'new',$28)
        ON CONFLICT (board_id, provider_job_id) DO UPDATE SET title=EXCLUDED.title, description_html=EXCLUDED.description_html, description=EXCLUDED.description, department=EXCLUDED.department, team=EXCLUDED.team, location=EXCLUDED.location, secondary_locations=EXCLUDED.secondary_locations, remote_mode=EXCLUDED.remote_mode, geographic_restrictions=EXCLUDED.geographic_restrictions, employment_type=EXCLUDED.employment_type, seniority=EXCLUDED.seniority, compensation=EXCLUDED.compensation, application_url=EXCLUDED.application_url, original_url=EXCLUDED.original_url, published_at=EXCLUDED.published_at, source_updated_at=EXCLUDED.source_updated_at, last_observed_at=EXCLUDED.last_observed_at, last_successful_board_check=EXCLUDED.last_successful_board_check, is_active=true, consecutive_missing_checks=0, personal_relevance=EXCLUDED.personal_relevance, relevance_breakdown=EXCLUDED.relevance_breakdown, location_signals=EXCLUDED.location_signals, location_fit=EXCLUDED.location_fit, location_fit_score=EXCLUDED.location_fit_score, location_fit_reasons=EXCLUDED.location_fit_reasons, raw=EXCLUDED.raw, company_name=EXCLUDED.company_name, updated_at=now()
        RETURNING id`, [board.id, board.provider, listing.providerJobId, listing.title, listing.descriptionHtml ?? '', listing.description, listing.department ?? '', listing.team ?? '', listing.location ?? '', JSON.stringify(listing.secondaryLocations ?? []), listing.remoteMode ?? 'unknown', JSON.stringify(listing.geographicRestrictions ?? []), listing.employmentType ?? '', listing.seniority ?? '', JSON.stringify(listing.compensation ?? {}), listing.applicationUrl, listing.originalUrl, listing.publishedAt, listing.updatedAt, checkedAt, analysis.personalRelevance, JSON.stringify(analysis.relevanceBreakdown), JSON.stringify(analysis.locationSignals), analysis.locationFit, analysis.locationFitScore, JSON.stringify(analysis.locationFitReasons), JSON.stringify(listing.raw), listing.companyName ?? '']);
      if (isNew && !baseline && notificationEligible(analysis, preferences)) await client.query('INSERT INTO listing_notifications (listing_id) VALUES ($1) ON CONFLICT (listing_id) DO NOTHING', [result.rows[0].id]);
    }
    await client.query(`UPDATE job_listings SET consecutive_missing_checks=consecutive_missing_checks+1, is_active=CASE WHEN consecutive_missing_checks+1 >= 3 THEN false ELSE is_active END, updated_at=now()
      WHERE board_id=$1 AND is_active=true AND NOT (provider_job_id = ANY($2::text[]))`, [board.id, observedIds]);
    await client.query(`UPDATE job_boards SET initialized_at=COALESCE(initialized_at, now()), last_successful_poll=now(), last_attempted_poll=now(), last_new_listing_discovered=CASE WHEN $2 > 0 THEN now() ELSE last_new_listing_discovered END, consecutive_failure_count=0, last_error=NULL, updated_at=now() WHERE id=$1`, [board.id, newCount]);
  });
  events.emit('listings', { boardId: board.id, provider: board.provider, newCount, count: listings.length });
}

export async function pollListings() {
  if (polling) return;
  polling = true;
  try {
    await ensureAggregatorBoards();
    const preferences = await getPreferences();
    for (const board of await boardRows()) {
      try { await processBoard(board, preferences); }
      catch (error) { await markFailure(board, error); }
    }
  }
  finally { polling = false; }
}

export function startListingPolling(intervalMs: number) {
  void pollListings().catch((error) => console.error('listing poll failed', error));
  return setInterval(() => void pollListings().catch((error) => console.error('listing poll failed', error)), intervalMs);
}

export function listingNotificationEligibleForTest(analysis: ReturnType<typeof analyzeListing>, preferences: Awaited<ReturnType<typeof getPreferences>>) { return notificationEligible(analysis, preferences); }
