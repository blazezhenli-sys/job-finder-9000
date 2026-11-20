import { config } from './config.js';
import { migrate, startDeferredMigrations } from './db.js';
import { deliverNotifications } from './notifications.js';
import { processPost, removeExpired, updateHealth } from './pipeline-service.js';
import { BlueskySource } from './sources/bluesky.js';
import { HackerNewsSource } from './sources/hacker-news.js';
import type { SourceAdapter } from './sources/types.js';
import { startListingPolling } from './listings/service.js';
import { startListingDiscovery } from './listings/discovery.js';
import { backfillListingLocationSignals, backfillListingMetadata } from './listings/company.js';
import { backfillListingCompensation } from './listings/salary.js';
import { backfillListingClassification, loadTechnologyTaxonomy } from './listings/classification.js';
import { detectMarketSignals, runDailyMarketSnapshot } from './listings/analytics.js';
import { startCompanyEnrichment } from './listings/enrichment-worker.js';
import { startCompanySocialPolling, startCompanySocialRsshubPolling } from './company-social.js';
import { scoreUnanalyzedCompanySocialPosts } from './company-social-analysis.js';

let started = false;
const sources: SourceAdapter[] = [];
let listingTimer: NodeJS.Timeout | undefined;
let discoveryTimer: NodeJS.Timeout | undefined;
let analyticsTimer: NodeJS.Timeout | undefined;
let classificationTimer: NodeJS.Timeout | undefined;
let companyEnrichmentTimer: NodeJS.Timeout | undefined;
let companySocialTimer: NodeJS.Timeout | undefined;
let companySocialRsshubTimer: NodeJS.Timeout | undefined;
let classificationReady: Promise<void> | undefined;
let locationSignalsReady: Promise<void> | undefined;

export async function startWorkers() {
  if (started) return;
  started = true;
  if (config.runMigrations) {
    await migrate();
    await startDeferredMigrations();
  }
  await loadTechnologyTaxonomy();
  if (config.enablePosts) {
    if (config.enableBluesky) sources.push(new BlueskySource());
    if (config.enableHackerNews) sources.push(new HackerNewsSource());
  }
  const processFeedPost = (post: Parameters<typeof processPost>[0], cursor?: string, recovered?: boolean) => processPost(post, cursor, recovered, { notify: false });
  for (const source of sources) {
    void source.start(processFeedPost, (health) => void updateHealth(source.source, health))
      .catch((error) => updateHealth(source.source, { connected: false, error: error instanceof Error ? error.message : String(error) }));
  }
  setInterval(() => void deliverNotifications(), 15_000);
  setInterval(() => void removeExpired(), 60 * 60 * 1000);
  if (config.enableListings) listingTimer = startListingPolling(config.listingsPollIntervalMs);
  if (config.enableListings) companyEnrichmentTimer = startCompanyEnrichment(config.companyEnrichmentIntervalMs);
  if (config.enableCompanySocialActivity) companySocialTimer = startCompanySocialPolling(config.companySocialPollIntervalMs);
  if (config.enableCompanySocialActivity) companySocialRsshubTimer = startCompanySocialRsshubPolling(config.companySocialRsshubSchedulerIntervalMs);
  if (config.enableCompanySocialActivity) void scoreUnanalyzedCompanySocialPosts().catch((error) => console.error('company social analysis backfill failed', error));
  if (config.enableListings && config.enableListingDiscovery) discoveryTimer = await startListingDiscovery(config.listingDiscoveryIntervalMs);
  if (config.enableListings) void backfillListingMetadata().catch((error) => console.error('company metadata backfill failed', error));
  if (config.enableListings) void backfillListingCompensation().catch((error) => console.error('salary backfill failed', error));
  if (config.enableListings) locationSignalsReady = backfillListingLocationSignals().catch((error) => console.error('listing location backfill failed', error));
  if (config.enableListings) {
    classificationReady = backfillListingClassification().catch((error) => console.error('listing classification backfill failed', error));
    classificationTimer = setInterval(() => void loadTechnologyTaxonomy().then(() => backfillListingClassification()).catch((error) => console.error('listing classification refresh failed', error)), 60 * 60 * 1000);
  }
  if (config.enableListings) {
    const runAnalytics = async () => { await classificationReady; await locationSignalsReady; await runDailyMarketSnapshot(); await detectMarketSignals(); };
    void runAnalytics().catch((error) => console.error('market analytics failed', error));
    analyticsTimer = setInterval(() => void runAnalytics().catch((error) => console.error('market analytics failed', error)), 60 * 60 * 1000);
  }
  void deliverNotifications();
}

export function stopWorkers() { for (const source of sources) source.stop(); if (listingTimer) clearInterval(listingTimer); if (companyEnrichmentTimer) clearInterval(companyEnrichmentTimer); if (companySocialTimer) clearInterval(companySocialTimer); if (companySocialRsshubTimer) clearInterval(companySocialRsshubTimer); if (discoveryTimer) clearInterval(discoveryTimer); if (analyticsTimer) clearInterval(analyticsTimer); if (classificationTimer) clearInterval(classificationTimer); }
