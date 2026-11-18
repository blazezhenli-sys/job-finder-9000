DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'salary_backfill_v2_reset') THEN
    UPDATE job_listings SET salary_backfilled_at = NULL WHERE salary_backfilled_at IS NOT NULL;
    INSERT INTO app_settings (key, value) VALUES ('salary_backfill_v2_reset', '{"completed":true}');
  END IF;
END $$;
