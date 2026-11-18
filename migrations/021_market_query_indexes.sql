CREATE INDEX IF NOT EXISTS job_listings_engineering_specialties_gin_idx ON job_listings USING gin (engineering_specialties);
CREATE INDEX IF NOT EXISTS job_listings_technologies_gin_idx ON job_listings USING gin (technologies);
CREATE INDEX IF NOT EXISTS job_listings_location_signals_gin_idx ON job_listings USING gin (location_signals);
CREATE INDEX IF NOT EXISTS job_listings_observation_time_idx ON job_listings (first_observed_at DESC, is_active);
CREATE INDEX IF NOT EXISTS job_listings_publication_time_idx ON job_listings (published_at DESC, is_active);
CREATE INDEX IF NOT EXISTS listing_board_observations_board_day_idx ON listing_board_observations (board_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS listing_events_observed_day_idx ON listing_events (observed_at DESC, event_type);
CREATE INDEX IF NOT EXISTS job_listings_market_search_idx ON job_listings USING gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '')));
