CREATE TABLE IF NOT EXISTS listing_discovery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed')),
  mode text NOT NULL DEFAULT 'recent' CHECK (mode IN ('full', 'recent')),
  providers jsonb NOT NULL DEFAULT '["greenhouse","ashby","lever"]',
  cursor jsonb NOT NULL DEFAULT '{}',
  candidates_seen integer NOT NULL DEFAULT 0,
  candidates_validated integer NOT NULL DEFAULT 0,
  boards_imported integer NOT NULL DEFAULT 0,
  request_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE listing_discovery_candidates ADD COLUMN IF NOT EXISTS source_url text NOT NULL DEFAULT '';
ALTER TABLE listing_discovery_candidates ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE listing_discovery_candidates ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE listing_discovery_candidates ADD COLUMN IF NOT EXISTS validation_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE listing_discovery_candidates ADD COLUMN IF NOT EXISTS next_validation_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE listing_discovery_candidates ADD COLUMN IF NOT EXISTS last_validation_at timestamptz;
ALTER TABLE listing_discovery_candidates ADD COLUMN IF NOT EXISTS last_validation_status integer;
ALTER TABLE listing_discovery_candidates ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE listing_discovery_candidates ADD COLUMN IF NOT EXISTS discovery_job_id uuid REFERENCES listing_discovery_jobs(id) ON DELETE SET NULL;
ALTER TABLE listing_discovery_candidates ADD COLUMN IF NOT EXISTS imported_board_id uuid REFERENCES job_boards(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS listing_discovery_jobs_status_idx ON listing_discovery_jobs (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS listing_discovery_candidates_validation_idx ON listing_discovery_candidates (status, next_validation_at);
CREATE INDEX IF NOT EXISTS listing_discovery_candidates_job_idx ON listing_discovery_candidates (discovery_job_id, status);
