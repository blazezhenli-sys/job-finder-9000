ALTER TABLE company_social_links ADD COLUMN IF NOT EXISTS social_poll_last_attempted_at timestamptz;
ALTER TABLE company_social_links ADD COLUMN IF NOT EXISTS social_poll_last_success_at timestamptz;
ALTER TABLE company_social_links ADD COLUMN IF NOT EXISTS social_poll_next_at timestamptz;
ALTER TABLE company_social_links ADD COLUMN IF NOT EXISTS social_poll_error text;
ALTER TABLE company_social_links ADD COLUMN IF NOT EXISTS social_poll_consecutive_failures integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS company_social_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id uuid NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  social_link_id uuid NOT NULL REFERENCES company_social_links(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('bluesky', 'mastodon')),
  source_id text NOT NULL,
  author_id text NOT NULL DEFAULT '',
  author_name text NOT NULL DEFAULT '',
  author_handle text NOT NULL DEFAULT '',
  author_url text NOT NULL DEFAULT '',
  source_url text NOT NULL DEFAULT '',
  text text NOT NULL DEFAULT '',
  published_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (social_link_id, source_id)
);

CREATE INDEX IF NOT EXISTS company_social_posts_employer_idx
  ON company_social_posts (employer_id, published_at DESC);
CREATE INDEX IF NOT EXISTS company_social_posts_retention_idx
  ON company_social_posts (published_at);

CREATE TABLE IF NOT EXISTS company_social_poll_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id uuid NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  social_link_id uuid NOT NULL REFERENCES company_social_links(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('bluesky', 'mastodon')),
  profile_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  posts_seen integer NOT NULL DEFAULT 0,
  new_posts integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS company_social_poll_tasks_status_idx
  ON company_social_poll_tasks (status, queued_at DESC);
CREATE INDEX IF NOT EXISTS company_social_poll_tasks_completed_idx
  ON company_social_poll_tasks (completed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS company_social_poll_tasks_active_link_idx
  ON company_social_poll_tasks (social_link_id)
  WHERE status IN ('queued', 'running');
