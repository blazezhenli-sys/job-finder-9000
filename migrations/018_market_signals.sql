CREATE TABLE IF NOT EXISTS market_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_key text NOT NULL UNIQUE,
  scope text NOT NULL CHECK (scope IN ('company', 'market')),
  employer_id uuid REFERENCES employers(id) ON DELETE CASCADE,
  signal_type text NOT NULL,
  dimension text NOT NULL DEFAULT '',
  period_start date NOT NULL,
  period_end date NOT NULL,
  baseline_value numeric NOT NULL DEFAULT 0,
  observed_value numeric NOT NULL DEFAULT 0,
  change_ratio numeric,
  sample_size integer NOT NULL DEFAULT 0,
  explanation text NOT NULL,
  data_quality text NOT NULL DEFAULT '',
  supporting_listing_ids jsonb NOT NULL DEFAULT '[]',
  detected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved'))
);

CREATE INDEX IF NOT EXISTS market_signals_scope_time_idx ON market_signals (scope, detected_at DESC);
CREATE INDEX IF NOT EXISTS market_signals_employer_time_idx ON market_signals (employer_id, detected_at DESC);
