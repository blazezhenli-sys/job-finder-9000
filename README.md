# Hiring Signal Discovery

Self-hosted, deterministic hiring-signal monitoring for Bluesky, Hacker News, Mastodon, and Reddit, with a separate ATS listings stream for Greenhouse, Ashby, and Lever. It runs a Fastify dashboard and durable background worker against PostgreSQL. No browser session is needed for ingestion.

## Quick start

1. Copy `.env.example` to `.env` and change `DASHBOARD_PASSWORD`.
2. Run `docker compose up -d --build`.
3. Open `http://your-server:3000` and sign in with the configured basic-auth credentials.

Coolify can deploy this repository as a Docker Compose project. Keep the Postgres volume persistent. Set the same environment variables in Coolify; SMTP values stay server-side and are never returned by the API.

For local development, run PostgreSQL, set `DATABASE_URL`, then use `npm install && npm run dev`. Set `DEV_MODE=true` to enable the “Load sample posts” action in the dashboard. The app runs migrations automatically at startup.

## Architecture and limitations

- `src/sources` contains source adapters. Bluesky uses the public Jetstream WebSocket and resumes with its last event cursor; Hacker News polls the public API; Mastodon consumes configurable public-instance authenticated WebSocket streams; Reddit uses an OAuth application token and polls selected subreddit posts/comments.
- `src/pipeline.ts` normalizes text, applies editable phrase/regex rules, extracts explicitly mentioned technologies and employment terms, and deterministically classifies each match as direct hiring, software request, employee referral, firsthand announcement, aggregated listing, or uncertain. Signal quality is kept separate from personal relevance; there is no LLM classification.
- Every persisted post retains its original source URL, contact methods, classification reasons, and an author profile. Aggregated posts remain available through the category filter and are excluded from notifications when suppressed. Author classifications and an exact account/domain/text aggregator registry are editable in the dashboard.
- Location requirements are extracted conservatively from explicit wording: work mode, named places, allowed/restricted scope, time zones, and the source evidence used. Ambiguous posts remain `unknown` rather than being guessed.
- A location-fit layer evaluates those signals against the saved base location and timezone, producing excellent/good/possible/poor/unknown results. The feed can sort/filter by fit and minimum score, and notification eligibility includes the configurable minimum fit score.
- The Listings tab is an independent pipeline. It automatically polls Remotive’s public remote-jobs API, and can optionally poll Adzuna when `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` are configured. You can still add public Greenhouse, Ashby, or Lever boards by provider and identifier/URL. The first successful poll establishes a baseline, later new postings are scored and can enter a separate email notification queue. Each listing retains the source page and direct application URL, plus the original employer, location, work mode, employment type, compensation, freshness, and saved/applied/dismissed state.
- `src/worker.ts` is the always-on worker loop. The default Docker command starts it with the web server in one process; `start:web` and `start:worker` are also available for separate Coolify services.
- PostgreSQL provides idempotency, notification retry state, source health counters, and restart recovery. Irrelevant matched-free posts are not stored; a configurable retention task removes old opportunities.
- Bluesky Jetstream is high-volume, so only posts matching a positive rule are persisted. On a first run, it starts at the current stream position; set `NOTIFY_RECOVERED=true` if recovered posts should notify. Mastodon and Reddit are disabled by default; enable them with `ENABLE_MASTODON=true` or `ENABLE_REDDIT=true`. Reddit requires `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, a descriptive `REDDIT_USER_AGENT`, and a comma-separated `REDDIT_SUBREDDITS` allowlist. Mastodon accepts `MASTODON_ENDPOINTS` as a JSON array of hostnames plus `MASTODON_TOKENS_JSON` mapping each hostname to its own user token with `read:statuses`. Legacy `MASTODON_INSTANCES` and `MASTODON_ACCESS_TOKEN` remain supported for one endpoint. Historical opportunities are reclassified on worker startup without creating old notifications.
- Listings are enabled by default and poll every 15 minutes; configure `ENABLE_LISTINGS` and `LISTINGS_POLL_INTERVAL_MS` as needed. A board’s initial snapshot does not generate notifications, preventing a newly added board from flooding the inbox. Remotive is polled every six hours by default because its public feed is delayed and intended for low-frequency access; configure `REMOTIVE_POLL_INTERVAL_SECONDS` if needed. Adzuna supports configurable countries, query, location, and poll interval through the `ADZUNA_*` variables.

## Tests

`npm test` covers normalization, rule detection, scoring, deduplication semantics, timestamp handling, and notification eligibility. `npm run build` verifies the production TypeScript build.
