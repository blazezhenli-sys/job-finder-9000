ALTER TABLE company_social_posts
  ADD COLUMN IF NOT EXISTS analysis jsonb;
ALTER TABLE company_social_posts
  ADD COLUMN IF NOT EXISTS analyzed_at timestamptz;
ALTER TABLE company_social_posts
  ADD COLUMN IF NOT EXISTS signal_category text;
ALTER TABLE company_social_posts
  ADD COLUMN IF NOT EXISTS signal_quality integer NOT NULL DEFAULT 0;
ALTER TABLE company_social_posts
  ADD COLUMN IF NOT EXISTS signal_qualifies boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS company_social_posts_unanalyzed_idx
  ON company_social_posts (published_at)
  WHERE analysis IS NULL;
CREATE INDEX IF NOT EXISTS company_social_posts_qualifying_activity_idx
  ON company_social_posts (published_at DESC, employer_id)
  WHERE signal_qualifies = true;
