ALTER TABLE employers ADD COLUMN IF NOT EXISTS verified_domain text NOT NULL DEFAULT '';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS industry text NOT NULL DEFAULT '';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS headquarters text NOT NULL DEFAULT '';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS company_size text NOT NULL DEFAULT '';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS prospect_status text NOT NULL DEFAULT 'unreviewed' CHECK (prospect_status IN ('unreviewed', 'interesting', 'contacted', 'follow_up', 'not_interested'));
ALTER TABLE employers ADD COLUMN IF NOT EXISTS prospect_notes text NOT NULL DEFAULT '';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS follow_up_at timestamptz;
ALTER TABLE employers ADD COLUMN IF NOT EXISTS contacted_at timestamptz;

ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS engineering_specialties jsonb NOT NULL DEFAULT '[]';
ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS technologies jsonb NOT NULL DEFAULT '[]';
ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS company_metadata_backfilled_at timestamptz;

CREATE TABLE IF NOT EXISTS listing_board_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES job_boards(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  listings_seen integer NOT NULL DEFAULT 0,
  active_engineering integer NOT NULL DEFAULT 0,
  new_listings integer NOT NULL DEFAULT 0,
  new_engineering integer NOT NULL DEFAULT 0,
  missing_listings integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS employers_name_idx ON employers (lower(name));
CREATE INDEX IF NOT EXISTS employers_verified_domain_idx ON employers (lower(verified_domain));
CREATE INDEX IF NOT EXISTS job_listings_engineering_specialties_idx ON job_listings USING gin (engineering_specialties);
CREATE INDEX IF NOT EXISTS job_listings_technologies_idx ON job_listings USING gin (technologies);
CREATE INDEX IF NOT EXISTS job_listings_company_metadata_backfill_idx ON job_listings (company_metadata_backfilled_at) WHERE company_metadata_backfilled_at IS NULL;
CREATE INDEX IF NOT EXISTS listing_board_observations_board_time_idx ON listing_board_observations (board_id, observed_at DESC);

-- Existing listings are classified asynchronously after the application starts.
-- This keeps the health endpoint available while a large registry is backfilled.
