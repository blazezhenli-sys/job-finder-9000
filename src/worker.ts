import { config } from './config.js';
import { migrate } from './db.js';
import { deliverNotifications } from './notifications.js';
import { removeExpired, processPost, reclassifyExistingOpportunities, updateHealth } from './pipeline-service.js';
import { BlueskySource } from './sources/bluesky.js';
import { HackerNewsSource } from './sources/hacker-news.js';
import { MastodonSource } from './sources/mastodon.js';
import { RedditSource } from './sources/reddit.js';
import type { SourceAdapter } from './sources/types.js';
import { startListingPolling } from './listings/service.js';
import { startListingDiscovery } from './listings/discovery.js';
import { backfillListingMetadata } from './listings/company.js';
import { backfillListingCompensation } from './listings/salary.js';

let started = false;
const sources: SourceAdapter[] = [];
let listingTimer: NodeJS.Timeout | undefined;
let discoveryTimer: NodeJS.Timeout | undefined;

export async function startWorkers() {
  if (started) return;
  started = true;
  await migrate();
  if (config.enablePosts) {
    const reclassified = await reclassifyExistingOpportunities(true);
    if (reclassified) console.info(`Reclassified ${reclassified} historical opportunities without notifying`);
    if (config.enableBluesky) sources.push(new BlueskySource());
    if (config.enableHackerNews) sources.push(new HackerNewsSource());
    if (config.enableMastodon) sources.push(new MastodonSource());
    if (config.enableReddit) sources.push(new RedditSource());
  }
  for (const source of sources) {
    void source.start(processPost, (health) => void updateHealth(source.source, health));
  }
  setInterval(() => void deliverNotifications(), 15_000);
  setInterval(() => void removeExpired(), 60 * 60 * 1000);
  if (config.enableListings) listingTimer = startListingPolling(config.listingsPollIntervalMs);
  if (config.enableListings && config.enableListingDiscovery) discoveryTimer = await startListingDiscovery(config.listingDiscoveryIntervalMs);
  if (config.enableListings) void backfillListingMetadata().catch((error) => console.error('company metadata backfill failed', error));
  if (config.enableListings) void backfillListingCompensation().catch((error) => console.error('salary backfill failed', error));
  void deliverNotifications();
}

export function stopWorkers() { for (const source of sources) source.stop(); if (listingTimer) clearInterval(listingTimer); if (discoveryTimer) clearInterval(discoveryTimer); }
