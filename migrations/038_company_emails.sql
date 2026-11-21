ALTER TABLE employers ADD COLUMN IF NOT EXISTS email_enrichment_last_attempted_at timestamptz;
ALTER TABLE employers ADD COLUMN IF NOT EXISTS email_enrichment_last_success_at timestamptz;
ALTER TABLE employers ADD COLUMN IF NOT EXISTS email_enrichment_next_at timestamptz;
ALTER TABLE employers ADD COLUMN IF NOT EXISTS email_enrichment_error text;

ALTER TABLE company_enrichment_tasks ADD COLUMN IF NOT EXISTS emails_found integer NOT NULL DEFAULT 0;
ALTER TABLE company_enrichment_tasks ADD COLUMN IF NOT EXISTS pages_fetched integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS company_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id uuid NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  email text NOT NULL,
  category text NOT NULL CHECK (category IN ('recruiting', 'careers', 'hiring', 'applications', 'contact', 'support', 'sales', 'press', 'legal', 'privacy', 'personal', 'other')),
  is_active boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employer_id, email)
);

CREATE TABLE IF NOT EXISTS job_listing_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES job_listings(id) ON DELETE CASCADE,
  email text NOT NULL,
  category text NOT NULL CHECK (category IN ('recruiting', 'careers', 'hiring', 'applications', 'contact', 'support', 'sales', 'press', 'legal', 'privacy', 'personal', 'other')),
  source_url text NOT NULL DEFAULT '',
  source_key text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company_email_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_email_id uuid NOT NULL REFERENCES company_emails(id) ON DELETE CASCADE,
  listing_id uuid REFERENCES job_listings(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('company_page', 'job_listing')),
  source_url text NOT NULL DEFAULT '',
  source_key text NOT NULL UNIQUE,
  evidence text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS company_emails_employer_idx ON company_emails (employer_id, is_active, email);
CREATE INDEX IF NOT EXISTS job_listing_emails_listing_idx ON job_listing_emails (listing_id, is_active, email);
CREATE INDEX IF NOT EXISTS company_email_sources_email_idx ON company_email_sources (company_email_id, is_active);
CREATE INDEX IF NOT EXISTS company_email_sources_listing_idx ON company_email_sources (listing_id, is_active);
