CREATE INDEX CONCURRENTLY IF NOT EXISTS listing_events_observed_day_idx ON listing_events (observed_at DESC, event_type);
