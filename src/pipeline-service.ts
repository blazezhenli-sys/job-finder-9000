import { EventEmitter } from 'node:events';
import { pool, getAggregatorRegistry, getPreferences, getRules, withTransaction } from './db.js';
import { analyzePost, detectionLatencyMs, extractOutboundDomains, notificationEligible } from './pipeline.js';
import type { NormalizedPost, SourceName } from './types.js';

export const events = new EventEmitter();

let cachedConfig: { rules: Awaited<ReturnType<typeof getRules>>; preferences: Awaited<ReturnType<typeof getPreferences>>; registry: Awaited<ReturnType<typeof getAggregatorRegistry>>; expiresAt: number } | undefined;
const pendingStats = new Map<SourceName, { processed: number; matched: number; threshold: number; cursor?: string }>();
let statsTimer: NodeJS.Timeout | undefined;
const pendingHealth = new Map<SourceName, { lastEventAt?: string; lastSuccessAt?: string; error?: string | null; errors: number }>();
const lastHealthEvent = new Map<SourceName, number>();
let healthTimer: NodeJS.Timeout | undefined;

async function pipelineConfig() {
  if (cachedConfig && cachedConfig.expiresAt > Date.now()) return cachedConfig;
  cachedConfig = { rules: await getRules(), preferences: await getPreferences(), registry: await getAggregatorRegistry(), expiresAt: Date.now() + 5_000 };
  return cachedConfig;
}

async function existingAuthor(source: SourceName, authorId: string) {
  const result = await pool.query('SELECT classification, is_known_aggregator, aggregator_evidence FROM author_profiles WHERE source = $1 AND author_id = $2', [source, authorId]);
  return result.rows[0] as { classification?: 'unknown' | 'aggregator' | 'employer' | 'legitimate_employer'; is_known_aggregator?: boolean; aggregator_evidence?: string[] } | undefined;
}

async function upsertAuthor(client: import('pg').PoolClient, post: NormalizedPost, evidence: string[]) {
  const authorId = post.authorId ?? post.authorHandle ?? post.authorName;
  const result = await client.query(`INSERT INTO author_profiles (source, author_id, handle, display_name, profile_url, bio, website_links, observed_posts, observed_hiring_posts, outbound_domains, aggregator_evidence, classification, is_known_aggregator, suspected_automated_syndication, last_checked_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,$8,$9,CASE WHEN jsonb_array_length($9::jsonb) > 0 THEN 'aggregator' ELSE 'unknown' END, jsonb_array_length($9::jsonb) > 0, jsonb_array_length($9::jsonb) > 0,now())
    ON CONFLICT (source, author_id) DO UPDATE SET handle = EXCLUDED.handle, display_name = EXCLUDED.display_name, profile_url = EXCLUDED.profile_url,
      bio = CASE WHEN EXCLUDED.bio <> '' THEN EXCLUDED.bio ELSE author_profiles.bio END, website_links = CASE WHEN EXCLUDED.website_links <> '[]'::jsonb THEN EXCLUDED.website_links ELSE author_profiles.website_links END,
      observed_posts = author_profiles.observed_posts + 1, observed_hiring_posts = author_profiles.observed_hiring_posts + 1,
      outbound_domains = author_profiles.outbound_domains || EXCLUDED.outbound_domains, aggregator_evidence = author_profiles.aggregator_evidence || EXCLUDED.aggregator_evidence,
      classification = CASE WHEN jsonb_array_length(EXCLUDED.aggregator_evidence) > 0 AND author_profiles.classification <> 'legitimate_employer' THEN 'aggregator' ELSE author_profiles.classification END,
      is_known_aggregator = author_profiles.is_known_aggregator OR jsonb_array_length(EXCLUDED.aggregator_evidence) > 0,
      suspected_automated_syndication = author_profiles.suspected_automated_syndication OR jsonb_array_length(EXCLUDED.aggregator_evidence) > 0,
      last_checked_at = now(), updated_at = now() RETURNING id`, [post.source, authorId, post.authorHandle, post.authorName, post.authorUrl, post.authorBio ?? '', JSON.stringify(post.authorWebsites ?? []), JSON.stringify(extractOutboundDomains(post.text)), JSON.stringify(evidence)]);
  return result.rows[0].id as string;
}

function queueStats(source: SourceName, values: { matched?: boolean; threshold?: boolean; cursor?: string }) {
  const current = pendingStats.get(source) ?? { processed: 0, matched: 0, threshold: 0 };
  current.processed += 1;
  if (values.matched) current.matched += 1;
  if (values.threshold) current.threshold += 1;
  if (values.cursor) current.cursor = values.cursor;
  pendingStats.set(source, current);
  if (!statsTimer) statsTimer = setTimeout(() => { statsTimer = undefined; void flushStats().catch((error) => console.error('stats flush failed', error)); }, 1_000);
}

async function flushStats() {
  const batch = Array.from(pendingStats.entries());
  pendingStats.clear();
  await Promise.all(batch.map(([source, values]) => pool.query(`UPDATE ingestion_states SET processed_count = processed_count + $1, matched_count = matched_count + $2,
    threshold_count = threshold_count + $3, cursor = COALESCE($4, cursor), updated_at = now() WHERE source = $5`, [values.processed, values.matched, values.threshold, values.cursor ?? null, source])));
}

async function flushHealth() {
  const batch = Array.from(pendingHealth.entries());
  pendingHealth.clear();
  await Promise.all(batch.map(([source, values]) => pool.query(`UPDATE ingestion_states SET last_event_at = COALESCE($1, last_event_at), last_success_at = COALESCE($2, last_success_at),
    last_error = $3, error_count = error_count + $4, updated_at = now() WHERE source = $5`, [
    values.lastEventAt ?? null, values.lastSuccessAt ?? null, values.error ?? null, values.errors, source
  ])));
}

export async function processPost(post: NormalizedPost, cursor?: string, recovered = false, options: { notify?: boolean } = {}) {
  const notify = options.notify !== false;
  const { rules, preferences, registry } = await pipelineConfig();
  let author: Awaited<ReturnType<typeof existingAuthor>>;
  let analysis = analyzePost(post, rules, preferences, undefined, registry);
  const firstSeen = new Date();
  const latency = detectionLatencyMs(post.publishedAt, firstSeen);
  let opportunityId: string | undefined;
  const hasPositiveMatch = analysis.matchedRules.some((rule) => !rule.negative);
  if (analysis.blocked || !hasPositiveMatch) {
    queueStats(post.source, { cursor });
    return;
  }

  author = await existingAuthor(post.source, post.authorId ?? post.authorHandle ?? post.authorName);
  analysis = analyzePost(post, rules, preferences, author, registry);
  let authorProfileId: string | undefined;

  await withTransaction(async (client) => {
    authorProfileId = await upsertAuthor(client, post, analysis.classificationReasons.filter((reason) => reason.toLowerCase().includes('aggregator')));
    const inserted = await client.query(`INSERT INTO opportunities
      (source, source_id, author_profile_id, author_name, author_handle, author_url, source_url, text, published_at, first_seen_at, detection_latency_ms, matched_rules, technologies, employment_types, score, score_breakdown, raw, signal_category, signal_quality, signal_quality_breakdown, personal_relevance, personal_relevance_breakdown, contact_methods, classification_reasons, location_signals, location_fit, location_fit_score, location_fit_reasons, suppressed, classification_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
      ON CONFLICT (source, source_id) DO NOTHING RETURNING id`, [
      post.source, post.sourceId, authorProfileId, post.authorName, post.authorHandle, post.authorUrl, post.sourceUrl, post.text,
      post.publishedAt, firstSeen, latency, JSON.stringify(analysis.matchedRules), JSON.stringify(analysis.technologies),
      JSON.stringify(analysis.employmentTypes), analysis.personalRelevance, JSON.stringify(analysis.personalRelevanceBreakdown), JSON.stringify(post.raw ?? {}), analysis.category, analysis.signalQuality, JSON.stringify(analysis.signalQualityBreakdown), analysis.personalRelevance, JSON.stringify(analysis.personalRelevanceBreakdown), JSON.stringify(analysis.contactMethods), JSON.stringify(analysis.classificationReasons), JSON.stringify(analysis.locationSignals), analysis.locationFit, analysis.locationFitScore, JSON.stringify(analysis.locationFitReasons), analysis.suppressed, 4
    ]);
    if (!inserted.rows[0]) return;
    opportunityId = inserted.rows[0].id as string;
    if (notify && notificationEligible(analysis, recovered, preferences)) {
      await client.query(`INSERT INTO notifications (opportunity_id) VALUES ($1) ON CONFLICT (opportunity_id) DO NOTHING`, [opportunityId]);
    }
  });

  queueStats(post.source, { matched: Boolean(opportunityId), threshold: notify && Boolean(opportunityId) && notificationEligible(analysis, recovered, preferences), cursor });

  if (opportunityId) {
    const result = await pool.query('SELECT * FROM opportunities WHERE id = $1', [opportunityId]);
    events.emit('opportunity', result.rows[0]);
  }
}

export async function reclassifyExistingOpportunities(force = false) {
  const { rules, preferences, registry } = await pipelineConfig();
  const rows = await pool.query(`SELECT * FROM opportunities WHERE $1 OR classification_version < 2 ORDER BY created_at`, [force]).then((result) => result.rows);
  for (const row of rows) {
    const post: NormalizedPost = { source: row.source, sourceId: row.source_id, authorId: row.author_handle, authorName: row.author_name, authorHandle: row.author_handle, authorUrl: row.author_url, sourceUrl: row.source_url, text: row.text, publishedAt: new Date(row.published_at), raw: row.raw };
    const author = await existingAuthor(post.source, post.authorId!);
    const analysis = analyzePost(post, rules, preferences, author, registry);
    await withTransaction(async (client) => {
      const authorProfileId = row.author_profile_id ?? await upsertAuthor(client, post, analysis.classificationReasons.filter((reason) => reason.toLowerCase().includes('aggregator')));
      if (authorProfileId && analysis.category === 'aggregated_listing') await client.query(`UPDATE author_profiles SET classification = CASE WHEN classification = 'legitimate_employer' THEN classification ELSE 'aggregator' END, is_known_aggregator = CASE WHEN classification = 'legitimate_employer' THEN is_known_aggregator ELSE true END, suspected_automated_syndication = true, updated_at = now() WHERE id = $1`, [authorProfileId]);
      await client.query(`UPDATE opportunities SET author_profile_id=$2, signal_category=$3, signal_quality=$4, signal_quality_breakdown=$5, personal_relevance=$6, personal_relevance_breakdown=$7,
        score=$6, score_breakdown=$7, contact_methods=$8, classification_reasons=$9, location_signals=$10, location_fit=$11, location_fit_score=$12, location_fit_reasons=$13, suppressed=$14, classification_version=4 WHERE id=$1`, [row.id, authorProfileId, analysis.category, analysis.signalQuality, JSON.stringify(analysis.signalQualityBreakdown), analysis.personalRelevance, JSON.stringify(analysis.personalRelevanceBreakdown), JSON.stringify(analysis.contactMethods), JSON.stringify(analysis.classificationReasons), JSON.stringify(analysis.locationSignals), analysis.locationFit, analysis.locationFitScore, JSON.stringify(analysis.locationFitReasons), analysis.suppressed]);
    });
  }
  return rows.length;
}

export function updateHealth(source: SourceName, values: { connected?: boolean; lastEventAt?: string; lastSuccessAt?: string; error?: string | null }) {
  const current = pendingHealth.get(source) ?? { errors: 0 };
  if (values.lastEventAt) current.lastEventAt = values.lastEventAt;
  if (values.lastSuccessAt) current.lastSuccessAt = values.lastSuccessAt;
  if (values.error !== undefined) current.error = values.error;
  if (values.error) current.errors += 1;
  pendingHealth.set(source, current);
  if (!healthTimer) healthTimer = setTimeout(() => { healthTimer = undefined; void flushHealth().catch((error) => console.error('health flush failed', error)); }, 1_000);
  const now = Date.now();
  const shouldEmit = Boolean(values.error) || values.connected !== undefined || now - (lastHealthEvent.get(source) ?? 0) > 5_000;
  if (shouldEmit) {
    lastHealthEvent.set(source, now);
    events.emit('health', { source, ...values });
  }
}

export async function removeExpired() {
  const preferences = await getPreferences();
  const days = Number(process.env.RETENTION_DAYS ?? 30);
  if (!Number.isFinite(days) || days <= 0) return;
  await pool.query(`DELETE FROM opportunities WHERE created_at < now() - ($1::text || ' days')::interval AND status = 'dismissed'`, [days]);
  // Keep the preference read here so the retention task also exercises the DB on quiet installations.
  void preferences;
}
