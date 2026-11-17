CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS detection_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  pattern text NOT NULL,
  match_type text NOT NULL CHECK (match_type IN ('phrase', 'regex')),
  category text NOT NULL DEFAULT 'hiring',
  weight numeric NOT NULL DEFAULT 0,
  negative boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('bluesky', 'hacker_news', 'mastodon', 'reddit')),
  source_id text NOT NULL,
  author_name text NOT NULL DEFAULT '',
  author_handle text NOT NULL DEFAULT '',
  author_url text NOT NULL DEFAULT '',
  source_url text NOT NULL DEFAULT '',
  text text NOT NULL,
  published_at timestamptz NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  detection_latency_ms bigint,
  matched_rules jsonb NOT NULL DEFAULT '[]',
  technologies jsonb NOT NULL DEFAULT '[]',
  employment_types jsonb NOT NULL DEFAULT '[]',
  score integer NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  score_breakdown jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'interesting', 'dismissed', 'contacted')),
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb NOT NULL DEFAULT '{}',
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS opportunities_published_idx ON opportunities (published_at DESC);
CREATE INDEX IF NOT EXISTS opportunities_score_idx ON opportunities (score DESC);
CREATE INDEX IF NOT EXISTS opportunities_status_idx ON opportunities (status);

CREATE TABLE IF NOT EXISTS ingestion_states (
  source text PRIMARY KEY,
  cursor text,
  last_event_at timestamptz,
  last_success_at timestamptz,
  processed_count bigint NOT NULL DEFAULT 0,
  matched_count bigint NOT NULL DEFAULT 0,
  threshold_count bigint NOT NULL DEFAULT 0,
  error_count bigint NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL UNIQUE REFERENCES opportunities(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
