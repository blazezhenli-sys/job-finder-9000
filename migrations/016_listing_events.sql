CREATE TABLE IF NOT EXISTS listing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES job_listings(id) ON DELETE CASCADE,
  board_id uuid NOT NULL REFERENCES job_boards(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('first_observed', 'reappeared', 'removed', 'title_changed', 'location_changed', 'work_mode_changed', 'employment_type_changed', 'compensation_changed', 'description_changed')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  source_updated_at timestamptz,
  previous_value jsonb NOT NULL DEFAULT '{}',
  current_value jsonb NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS listing_events_listing_time_idx ON listing_events (listing_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS listing_events_board_time_idx ON listing_events (board_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS listing_events_type_time_idx ON listing_events (event_type, observed_at DESC);
