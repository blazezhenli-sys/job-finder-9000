CREATE INDEX CONCURRENTLY IF NOT EXISTS job_listings_market_search_idx ON job_listings USING gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '')));
