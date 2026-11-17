ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS compensation_min numeric;
ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS compensation_max numeric;
ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS compensation_currency text NOT NULL DEFAULT '';
ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS compensation_period text NOT NULL DEFAULT '';
ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS compensation_estimated boolean NOT NULL DEFAULT false;

UPDATE job_listings
SET compensation_min = CASE WHEN COALESCE(compensation->>'min', compensation->>'minimum', compensation->>'salary_min') ~ '^[0-9]+(\.[0-9]+)?$' THEN (COALESCE(compensation->>'min', compensation->>'minimum', compensation->>'salary_min'))::numeric END,
    compensation_max = CASE WHEN COALESCE(compensation->>'max', compensation->>'maximum', compensation->>'salary_max') ~ '^[0-9]+(\.[0-9]+)?$' THEN (COALESCE(compensation->>'max', compensation->>'maximum', compensation->>'salary_max'))::numeric END,
    compensation_currency = COALESCE(compensation->>'currency', compensation->>'currencyCode', compensation->>'currency_code', ''),
    compensation_period = COALESCE(compensation->>'period', compensation->>'interval', compensation->>'payPeriod', compensation->>'frequency', ''),
    compensation_estimated = CASE WHEN compensation->>'estimated' IN ('true', 'false') THEN (compensation->>'estimated')::boolean WHEN compensation->>'isEstimated' IN ('true', 'false') THEN (compensation->>'isEstimated')::boolean ELSE false END
WHERE compensation_min IS NULL AND compensation <> '{}'::jsonb;

CREATE INDEX IF NOT EXISTS job_listings_compensation_idx ON job_listings (compensation_currency, compensation_max, compensation_min);
CREATE INDEX IF NOT EXISTS job_listings_employment_type_idx ON job_listings (employment_type);
CREATE INDEX IF NOT EXISTS job_listings_seniority_idx ON job_listings (seniority);
