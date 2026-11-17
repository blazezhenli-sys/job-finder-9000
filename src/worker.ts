import { config } from './config.js';
import { migrate } from './db.js';
import { deliverNotifications } from './notifications.js';
import { removeExpired, processPost, reclassifyExistingOpportunities, updateHealth } from './pipeline-service.js';
import { BlueskySource } from './sources/bluesky.js';
import { HackerNewsSource } from './sources/hacker-news.js';
import { MastodonSource } from './sources/mastodon.js';
import { RedditSource } from './sources/reddit.js';
import type { SourceAdapter } from './sources/types.js';

let started = false;
const sources: SourceAdapter[] = [];

export async function startWorkers() {
  if (started) return;
  started = true;
  await migrate();
  const reclassified = await reclassifyExistingOpportunities(true);
  if (reclassified) console.info(`Reclassified ${reclassified} historical opportunities without notifying`);
  if (config.enableBluesky) sources.push(new BlueskySource());
  if (config.enableHackerNews) sources.push(new HackerNewsSource());
  if (config.enableMastodon) sources.push(new MastodonSource());
  if (config.enableReddit) sources.push(new RedditSource());
  for (const source of sources) {
    void source.start(processPost, (health) => void updateHealth(source.source, health));
  }
  setInterval(() => void deliverNotifications(), 15_000);
  setInterval(() => void removeExpired(), 60 * 60 * 1000);
  void deliverNotifications();
}

export function stopWorkers() { for (const source of sources) source.stop(); }
