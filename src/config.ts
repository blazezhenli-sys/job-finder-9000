import process from 'node:process';

const bool = (value: string | undefined, fallback: boolean) => value === undefined ? fallback : value.toLowerCase() === 'true';
const num = (value: string | undefined, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export interface MastodonEndpoint { url: string; accessToken: string }

function mastodonEndpoints(): MastodonEndpoint[] {
  const legacyToken = process.env.MASTODON_ACCESS_TOKEN ?? '';
  const tokenMap = (() => { try { return JSON.parse(process.env.MASTODON_TOKENS_JSON ?? '{}') as Record<string, string>; } catch { return {}; } })();
  const raw = process.env.MASTODON_ENDPOINTS?.trim();
  let values: Array<string | { url?: string; accessToken?: string }> = [];
  if (raw) {
    try { values = JSON.parse(raw) as Array<string | { url?: string; accessToken?: string }>; }
    catch { values = raw.split(',').map((url) => url.trim()); }
  } else if (process.env.MASTODON_INSTANCES) {
    values = process.env.MASTODON_INSTANCES.split(',').map((url) => url.trim());
  } else {
    values = ['mastodon.social', 'hachyderm.io', 'infosec.exchange'];
  }
  return values.map((value, index) => {
    const url = typeof value === 'string' ? value : value.url ?? '';
    const host = url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    return { url, accessToken: typeof value === 'string' ? tokenMap[host] ?? (index === 0 ? legacyToken : '') : value.accessToken ?? tokenMap[host] ?? (index === 0 ? legacyToken : '') };
  }).filter((endpoint) => endpoint.url);
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://hiring:hiring@localhost:5432/hiring',
  databasePoolMax: Math.max(1, Math.floor(num(process.env.DB_POOL_MAX, 10))),
  dashboardUsername: process.env.DASHBOARD_USERNAME ?? 'admin',
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? 'change-me',
  enablePosts: bool(process.env.ENABLE_POSTS, false),
  enableBluesky: bool(process.env.ENABLE_BLUESKY, true),
  jetstreamUrl: process.env.BLUESKY_JETSTREAM_URL ?? 'wss://jetstream1.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post',
  enableHackerNews: bool(process.env.ENABLE_HACKER_NEWS, true),
  hnPollIntervalMs: num(process.env.HN_POLL_INTERVAL_MS, 30_000),
  enableMastodon: bool(process.env.ENABLE_MASTODON, false),
  mastodonEndpoints: mastodonEndpoints(),
  enableReddit: bool(process.env.ENABLE_REDDIT, false),
  redditClientId: process.env.REDDIT_CLIENT_ID ?? '',
  redditClientSecret: process.env.REDDIT_CLIENT_SECRET ?? '',
  redditUserAgent: process.env.REDDIT_USER_AGENT ?? 'hiring-signal-discovery/0.1 by personal-use',
  redditSubreddits: (process.env.REDDIT_SUBREDDITS ?? 'forhire,startups,Entrepreneur,remotejs').split(',').map((value) => value.trim().replace(/^r\//, '')).filter(Boolean),
  redditPollIntervalMs: num(process.env.REDDIT_POLL_INTERVAL_MS, 60_000),
  enableListings: bool(process.env.ENABLE_LISTINGS, true),
  listingsPollIntervalMs: num(process.env.LISTINGS_POLL_INTERVAL_MS, 3_600_000),
  listingsPollConcurrency: Math.max(1, Math.floor(num(process.env.LISTINGS_POLL_CONCURRENCY, 4))),
  companyEnrichmentIntervalMs: num(process.env.COMPANY_ENRICHMENT_INTERVAL_MS, 3_600_000),
  companyEnrichmentConcurrency: Math.max(1, Math.floor(num(process.env.COMPANY_ENRICHMENT_CONCURRENCY, 2))),
  enableListingDiscovery: bool(process.env.ENABLE_LISTING_DISCOVERY, true),
  listingDiscoveryIntervalMs: num(process.env.LISTING_DISCOVERY_INTERVAL_MS, 86_400_000),
  listingDiscoveryValidationConcurrency: Math.max(1, Math.floor(num(process.env.LISTING_DISCOVERY_VALIDATION_CONCURRENCY, 4))),
  remotiveBoardPollIntervalSeconds: num(process.env.REMOTIVE_POLL_INTERVAL_SECONDS, 21_600),
  adzunaAppId: process.env.ADZUNA_APP_ID ?? '',
  adzunaAppKey: process.env.ADZUNA_APP_KEY ?? '',
  adzunaCountries: (process.env.ADZUNA_COUNTRIES ?? 'us,gb,au,sg').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
  adzunaQuery: process.env.ADZUNA_QUERY ?? 'software engineer developer backend full stack',
  adzunaWhere: process.env.ADZUNA_WHERE ?? '',
  adzunaBoardPollIntervalSeconds: num(process.env.ADZUNA_POLL_INTERVAL_SECONDS, 3_600),
  devMode: bool(process.env.DEV_MODE, false),
  notifyRecovered: bool(process.env.NOTIFY_RECOVERED, false),
  retentionDays: num(process.env.RETENTION_DAYS, 30),
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: num(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER ?? '',
    password: process.env.SMTP_PASSWORD ?? '',
    from: process.env.SMTP_FROM ?? '',
    recipient: process.env.NOTIFICATION_EMAIL ?? ''
  }
};
