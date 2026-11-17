ALTER TABLE job_boards DROP CONSTRAINT IF EXISTS job_boards_provider_check;
ALTER TABLE job_boards ADD CONSTRAINT job_boards_provider_check CHECK (provider IN ('greenhouse', 'ashby', 'lever', 'remotive', 'adzuna'));

ALTER TABLE job_listings DROP CONSTRAINT IF EXISTS job_listings_provider_check;
ALTER TABLE job_listings ADD CONSTRAINT job_listings_provider_check CHECK (provider IN ('greenhouse', 'ashby', 'lever', 'remotive', 'adzuna'));

ALTER TABLE listing_discovery_candidates DROP CONSTRAINT IF EXISTS listing_discovery_candidates_provider_check;
ALTER TABLE listing_discovery_candidates ADD CONSTRAINT listing_discovery_candidates_provider_check CHECK (provider IN ('greenhouse', 'ashby', 'lever', 'remotive', 'adzuna'));

ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS company_name text NOT NULL DEFAULT '';
