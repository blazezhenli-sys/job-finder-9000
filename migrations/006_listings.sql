CREATE TABLE IF NOT EXISTS employers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  website text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, website)
);

CREATE TABLE IF NOT EXISTS job_boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id uuid NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('greenhouse', 'ashby', 'lever')),
  board_identifier text NOT NULL,
  board_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  discovery_source text NOT NULL DEFAULT 'manual',
  first_discovered_at timestamptz NOT NULL DEFAULT now(),
  initialized_at timestamptz,
  last_successful_poll timestamptz,
  last_attempted_poll timestamptz,
  last_new_listing_discovered timestamptz,
  polling_interval_seconds integer NOT NULL DEFAULT 900,
  consecutive_failure_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, board_identifier)
);

CREATE TABLE IF NOT EXISTS job_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES job_boards(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('greenhouse', 'ashby', 'lever')),
  provider_job_id text NOT NULL,
  title text NOT NULL,
  description_html text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  department text NOT NULL DEFAULT '',
  team text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  secondary_locations jsonb NOT NULL DEFAULT '[]',
  remote_mode text NOT NULL DEFAULT 'unknown' CHECK (remote_mode IN ('remote', 'hybrid', 'onsite', 'unknown')),
  geographic_restrictions jsonb NOT NULL DEFAULT '[]',
  employment_type text NOT NULL DEFAULT '',
  seniority text NOT NULL DEFAULT '',
  compensation jsonb NOT NULL DEFAULT '{}',
  application_url text NOT NULL DEFAULT '',
  original_url text NOT NULL DEFAULT '',
  published_at timestamptz,
  source_updated_at timestamptz,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  last_successful_board_check timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  consecutive_missing_checks integer NOT NULL DEFAULT 0,
  personal_relevance integer NOT NULL DEFAULT 0 CHECK (personal_relevance BETWEEN 0 AND 100),
  relevance_breakdown jsonb NOT NULL DEFAULT '[]',
  location_signals jsonb NOT NULL DEFAULT '{}',
  location_fit text NOT NULL DEFAULT 'unknown' CHECK (location_fit IN ('excellent', 'good', 'possible', 'poor', 'unknown')),
  location_fit_score integer NOT NULL DEFAULT 0,
  location_fit_reasons jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'saved', 'dismissed', 'applied')),
  raw jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (board_id, provider_job_id)
);

CREATE TABLE IF NOT EXISTS listing_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL UNIQUE REFERENCES job_listings(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listing_discovery_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('greenhouse', 'ashby', 'lever')),
  board_identifier text NOT NULL,
  board_url text NOT NULL DEFAULT '',
  employer_name text NOT NULL DEFAULT '',
  discovery_source text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'validated', 'rejected', 'imported')),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, board_identifier)
);

CREATE INDEX IF NOT EXISTS job_boards_status_idx ON job_boards (status);
CREATE INDEX IF NOT EXISTS job_listings_active_idx ON job_listings (is_active, last_observed_at DESC);
CREATE INDEX IF NOT EXISTS job_listings_relevance_idx ON job_listings (personal_relevance DESC);
CREATE INDEX IF NOT EXISTS job_listings_location_fit_idx ON job_listings (location_fit_score DESC);
CREATE INDEX IF NOT EXISTS job_listings_provider_idx ON job_listings (provider);
