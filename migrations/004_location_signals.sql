ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS location_signals jsonb NOT NULL DEFAULT '{"workMode":"unknown","locations":[],"constraint":"unknown","timezoneRequirements":[],"evidence":[]}';
CREATE INDEX IF NOT EXISTS opportunities_work_mode_idx ON opportunities ((location_signals->>'workMode'));
