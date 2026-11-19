UPDATE company_social_links
SET is_active = false, updated_at = now()
WHERE platform = 'instagram'
  AND profile_url !~* '^https?://(www\.)?instagram\.com/[a-z0-9._]{1,30}/?$';
