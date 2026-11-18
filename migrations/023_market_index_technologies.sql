CREATE INDEX CONCURRENTLY IF NOT EXISTS job_listings_technologies_gin_idx ON job_listings USING gin (technologies);
