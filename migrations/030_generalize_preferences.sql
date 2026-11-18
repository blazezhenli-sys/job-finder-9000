-- Remove the previous location-profile decision layer and retire seeded,
-- engineering-specific rules from existing installations. Location fields stay
-- on records as source facts, but no saved geography or fit threshold controls
-- relevance, sorting, or notifications.
UPDATE app_settings
SET value = value - 'locationProfile' - 'minimumNotificationLocationFitScore' - 'minimumListingLocationFitScore', updated_at = now()
WHERE key = 'preferences';

-- Clear only the exact seeded vocabulary from the old defaults. Any terms a
-- user deliberately entered remain available for their own relevance model.
UPDATE app_settings
SET value = jsonb_set(value, '{technologyTerms}', '[]'::jsonb)
          || jsonb_build_object('roleTerms', '[]'::jsonb, 'remoteTerms', '[]'::jsonb,
                                'internationalTerms', '[]'::jsonb, 'contractTerms', '[]'::jsonb,
                                'contactTerms', '[]'::jsonb), updated_at = now()
WHERE key = 'preferences'
  AND value->'technologyTerms' = '["typescript", "javascript", "node.js", "nodejs", "python", "backend", "full-stack", "full stack", "infrastructure", "devops", "react", "postgresql", "kubernetes"]'::jsonb
  AND value->'roleTerms' = '["software engineer", "backend engineer", "full-stack engineer", "developer", "engineering hire", "founding engineer"]'::jsonb;

UPDATE app_settings
SET value = jsonb_set(value, '{heuristics}', (COALESCE(value->'heuristics', '{}'::jsonb) - 'softwareRequestTerms' - 'softwareEvidenceTerms')), updated_at = now()
WHERE key = 'preferences' AND value ? 'heuristics';

UPDATE detection_rules
SET enabled = false, updated_at = now()
WHERE name IN (
  'Looking for an engineer', 'Looking for a developer', 'Founding engineer',
  'Need a contractor', 'Contractor mention', 'Freelance help', 'Freelance mention',
  'Know good developers', 'Expanding engineering team', 'Hiring remote',
  'Looking for someone to build', 'Need an engineer or developer',
  'Seeking an engineer or developer', 'Engineer wanted', 'Engineering hire',
  'Backend engineer role', 'Software engineer role', 'Infrastructure help'
);

ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_signal_category_check;
UPDATE opportunities SET signal_category = 'service_request' WHERE signal_category = 'software_request';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunities_signal_category_check') THEN
    ALTER TABLE opportunities ADD CONSTRAINT opportunities_signal_category_check
      CHECK (signal_category IN ('direct_hiring', 'service_request', 'employee_referral', 'firsthand_announcement', 'aggregated_listing', 'uncertain'));
  END IF;
END $$;
