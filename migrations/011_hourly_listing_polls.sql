ALTER TABLE job_boards ALTER COLUMN polling_interval_seconds SET DEFAULT 3600;

-- Move boards that still have the former default to the new hourly cadence.
-- Explicitly customized intervals are left alone.
UPDATE job_boards
SET polling_interval_seconds = 3600,
    updated_at = now()
WHERE polling_interval_seconds = 900;
