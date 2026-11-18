CREATE INDEX CONCURRENTLY IF NOT EXISTS listing_board_observations_board_day_idx ON listing_board_observations (board_id, observed_at DESC);
