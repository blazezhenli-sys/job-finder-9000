CREATE INDEX CONCURRENTLY IF NOT EXISTS job_listings_observation_time_idx ON job_listings (first_observed_at DESC, is_active);
