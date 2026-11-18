ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS salary_backfilled_at timestamptz;
CREATE INDEX IF NOT EXISTS job_listings_salary_backfill_idx ON job_listings (salary_backfilled_at) WHERE salary_backfilled_at IS NULL;
