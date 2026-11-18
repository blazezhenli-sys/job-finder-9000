CREATE INDEX CONCURRENTLY IF NOT EXISTS job_listings_engineering_specialties_gin_idx ON job_listings USING gin (engineering_specialties);
