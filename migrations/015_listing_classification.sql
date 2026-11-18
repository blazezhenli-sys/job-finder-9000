ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS job_category text NOT NULL DEFAULT 'unknown';
ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS primary_specialty text NOT NULL DEFAULT '';
ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS classification_version integer NOT NULL DEFAULT 0;
ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS classification_method text NOT NULL DEFAULT '';
ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS classification_backfilled_at timestamptz;

CREATE INDEX IF NOT EXISTS job_listings_category_idx ON job_listings (job_category, is_active);
CREATE INDEX IF NOT EXISTS job_listings_primary_specialty_idx ON job_listings (primary_specialty, is_active);
CREATE INDEX IF NOT EXISTS job_listings_classification_backfill_idx ON job_listings (classification_backfilled_at) WHERE classification_backfilled_at IS NULL;
