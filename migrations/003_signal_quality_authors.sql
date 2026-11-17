CREATE TABLE IF NOT EXISTS author_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  author_id text NOT NULL,
  handle text NOT NULL DEFAULT '',
  display_name text NOT NULL DEFAULT '',
  profile_url text NOT NULL DEFAULT '',
  bio text NOT NULL DEFAULT '',
  website_links jsonb NOT NULL DEFAULT '[]',
  observed_posts bigint NOT NULL DEFAULT 0,
  observed_hiring_posts bigint NOT NULL DEFAULT 0,
  outbound_domains jsonb NOT NULL DEFAULT '[]',
  classification text NOT NULL DEFAULT 'unknown' CHECK (classification IN ('unknown', 'aggregator', 'employer', 'legitimate_employer')),
  is_known_aggregator boolean NOT NULL DEFAULT false,
  suspected_automated_syndication boolean NOT NULL DEFAULT false,
  aggregator_evidence jsonb NOT NULL DEFAULT '[]',
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, author_id)
);

CREATE TABLE IF NOT EXISTS aggregator_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_type text NOT NULL CHECK (match_type IN ('account', 'domain', 'text')),
  pattern text NOT NULL,
  label text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_type, pattern)
);

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS author_profile_id uuid REFERENCES author_profiles(id) ON DELETE SET NULL;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS signal_category text NOT NULL DEFAULT 'uncertain';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS signal_quality integer NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS signal_quality_breakdown jsonb NOT NULL DEFAULT '[]';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS personal_relevance integer NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS personal_relevance_breakdown jsonb NOT NULL DEFAULT '[]';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS contact_methods jsonb NOT NULL DEFAULT '[]';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS classification_reasons jsonb NOT NULL DEFAULT '[]';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS suppressed boolean NOT NULL DEFAULT false;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS classification_version integer NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunities_signal_category_check') THEN
    ALTER TABLE opportunities ADD CONSTRAINT opportunities_signal_category_check CHECK (signal_category IN ('direct_hiring', 'software_request', 'employee_referral', 'firsthand_announcement', 'aggregated_listing', 'uncertain'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS opportunities_signal_quality_idx ON opportunities (signal_quality DESC);
CREATE INDEX IF NOT EXISTS opportunities_signal_category_idx ON opportunities (signal_category);
CREATE INDEX IF NOT EXISTS author_profiles_classification_idx ON author_profiles (classification);

UPDATE opportunities SET personal_relevance = score, personal_relevance_breakdown = score_breakdown WHERE personal_relevance = 0 AND score > 0;
