ALTER TABLE employers ADD COLUMN IF NOT EXISTS social_enrichment_last_attempted_at timestamptz;
ALTER TABLE employers ADD COLUMN IF NOT EXISTS social_enrichment_last_success_at timestamptz;
ALTER TABLE employers ADD COLUMN IF NOT EXISTS social_enrichment_next_at timestamptz;
ALTER TABLE employers ADD COLUMN IF NOT EXISTS social_enrichment_error text;
ALTER TABLE employers ADD COLUMN IF NOT EXISTS career_url text NOT NULL DEFAULT '';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS career_url_source text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS company_social_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id uuid NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('linkedin', 'x', 'github', 'bluesky', 'mastodon', 'youtube', 'instagram', 'facebook', 'tiktok', 'threads')),
  profile_url text NOT NULL,
  source_url text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employer_id, platform, profile_url)
);

CREATE INDEX IF NOT EXISTS company_social_links_employer_idx ON company_social_links (employer_id, platform, is_active);

CREATE TABLE IF NOT EXISTS company_enrichment_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id uuid NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  links_found integer NOT NULL DEFAULT 0,
  career_url text NOT NULL DEFAULT '',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS company_enrichment_tasks_status_idx ON company_enrichment_tasks (status, queued_at DESC);
CREATE INDEX IF NOT EXISTS company_enrichment_tasks_completed_idx ON company_enrichment_tasks (completed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS company_enrichment_tasks_active_employer_idx
  ON company_enrichment_tasks (employer_id)
  WHERE status IN ('queued', 'running');
