CREATE INDEX CONCURRENTLY IF NOT EXISTS job_listings_location_signals_gin_idx ON job_listings USING gin (location_signals);
