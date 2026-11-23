DO $$
BEGIN
  ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_source_check;
  ALTER TABLE opportunities ADD CONSTRAINT opportunities_source_check CHECK (source IN ('bluesky', 'hacker_news', 'mastodon', 'reddit', 'x'));
END $$;

INSERT INTO ingestion_states (source) VALUES ('x') ON CONFLICT DO NOTHING;
