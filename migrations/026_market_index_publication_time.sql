CREATE INDEX CONCURRENTLY IF NOT EXISTS job_listings_publication_time_idx ON job_listings (published_at DESC, is_active);
