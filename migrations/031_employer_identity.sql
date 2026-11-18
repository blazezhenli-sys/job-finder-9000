ALTER TABLE employers ADD COLUMN IF NOT EXISTS identity_domain text NOT NULL DEFAULT '';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS identity_name_source text NOT NULL DEFAULT 'legacy';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS identity_domain_source text NOT NULL DEFAULT 'legacy';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS identity_confidence text NOT NULL DEFAULT 'unknown' CHECK (identity_confidence IN ('high', 'medium', 'low', 'unknown'));
ALTER TABLE employers ADD COLUMN IF NOT EXISTS identity_evidence jsonb NOT NULL DEFAULT '{}';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS identity_last_observed_at timestamptz;

CREATE INDEX IF NOT EXISTS employers_identity_domain_idx ON employers (lower(identity_domain)) WHERE identity_domain <> '';
