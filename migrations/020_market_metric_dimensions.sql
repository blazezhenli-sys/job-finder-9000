ALTER TABLE company_daily_metrics ADD COLUMN IF NOT EXISTS specialty_counts jsonb NOT NULL DEFAULT '{}';
ALTER TABLE company_daily_metrics ADD COLUMN IF NOT EXISTS technology_counts jsonb NOT NULL DEFAULT '{}';
ALTER TABLE company_daily_metrics ADD COLUMN IF NOT EXISTS employment_type_counts jsonb NOT NULL DEFAULT '{}';
ALTER TABLE company_daily_metrics ADD COLUMN IF NOT EXISTS work_mode_counts jsonb NOT NULL DEFAULT '{}';

ALTER TABLE market_daily_metrics ADD COLUMN IF NOT EXISTS removed_listings integer NOT NULL DEFAULT 0;
ALTER TABLE market_daily_metrics ADD COLUMN IF NOT EXISTS remote_listings integer NOT NULL DEFAULT 0;
ALTER TABLE market_daily_metrics ADD COLUMN IF NOT EXISTS contract_listings integer NOT NULL DEFAULT 0;

ALTER TABLE market_snapshot_runs ADD COLUMN IF NOT EXISTS newly_discovered_boards integer NOT NULL DEFAULT 0;
ALTER TABLE market_snapshot_runs ADD COLUMN IF NOT EXISTS coverage_days integer NOT NULL DEFAULT 0;
