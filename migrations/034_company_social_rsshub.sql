ALTER TABLE company_social_posts
  DROP CONSTRAINT IF EXISTS company_social_posts_platform_check;
ALTER TABLE company_social_posts
  ADD CONSTRAINT company_social_posts_platform_check
  CHECK (platform IN ('linkedin', 'facebook', 'youtube', 'x', 'bluesky', 'mastodon'));

ALTER TABLE company_social_poll_tasks
  DROP CONSTRAINT IF EXISTS company_social_poll_tasks_platform_check;
ALTER TABLE company_social_poll_tasks
  ADD CONSTRAINT company_social_poll_tasks_platform_check
  CHECK (platform IN ('linkedin', 'facebook', 'youtube', 'x', 'bluesky', 'mastodon'));
