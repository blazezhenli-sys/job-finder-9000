CREATE TABLE IF NOT EXISTS company_daily_metrics (
  snapshot_date date NOT NULL,
  employer_id uuid NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  active_listings integer NOT NULL DEFAULT 0,
  active_engineering integer NOT NULL DEFAULT 0,
  new_listings integer NOT NULL DEFAULT 0,
  removed_listings integer NOT NULL DEFAULT 0,
  remote_listings integer NOT NULL DEFAULT 0,
  contract_listings integer NOT NULL DEFAULT 0,
  monitored_boards integer NOT NULL DEFAULT 0,
  successful_boards integer NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_date, employer_id)
);

CREATE TABLE IF NOT EXISTS market_daily_metrics (
  snapshot_date date NOT NULL,
  cohort text NOT NULL CHECK (cohort IN ('all', 'stable_28d')),
  dimension text NOT NULL,
  dimension_value text NOT NULL,
  active_listings integer NOT NULL DEFAULT 0,
  employers integer NOT NULL DEFAULT 0,
  new_listings integer NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_date, cohort, dimension, dimension_value)
);

CREATE TABLE IF NOT EXISTS market_snapshot_runs (
  snapshot_date date PRIMARY KEY,
  generated_at timestamptz NOT NULL DEFAULT now(),
  monitored_boards integer NOT NULL DEFAULT 0,
  stable_boards integer NOT NULL DEFAULT 0,
  monitored_employers integer NOT NULL DEFAULT 0,
  stable_employers integer NOT NULL DEFAULT 0,
  coverage_note text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS company_daily_metrics_employer_idx ON company_daily_metrics (employer_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS market_daily_metrics_lookup_idx ON market_daily_metrics (cohort, dimension, snapshot_date DESC);
