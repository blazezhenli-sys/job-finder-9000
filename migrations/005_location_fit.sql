ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS location_fit text NOT NULL DEFAULT 'unknown';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS location_fit_score integer NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS location_fit_reasons jsonb NOT NULL DEFAULT '[]';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunities_location_fit_check') THEN
    ALTER TABLE opportunities ADD CONSTRAINT opportunities_location_fit_check CHECK (location_fit IN ('excellent', 'good', 'possible', 'poor', 'unknown'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS opportunities_location_fit_idx ON opportunities (location_fit_score DESC);
