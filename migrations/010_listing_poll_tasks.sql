CREATE TABLE IF NOT EXISTS listing_poll_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES job_boards(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  listings_seen integer NOT NULL DEFAULT 0,
  new_listings integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listing_poll_tasks_status_idx ON listing_poll_tasks (status, queued_at DESC);
CREATE INDEX IF NOT EXISTS listing_poll_tasks_completed_idx ON listing_poll_tasks (completed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS listing_poll_tasks_active_board_idx
  ON listing_poll_tasks (board_id)
  WHERE status IN ('queued', 'running');
