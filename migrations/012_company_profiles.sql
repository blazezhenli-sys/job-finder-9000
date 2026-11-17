ALTER TABLE employers ADD COLUMN IF NOT EXISTS verified_domain text NOT NULL DEFAULT '';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS industry text NOT NULL DEFAULT '';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS headquarters text NOT NULL DEFAULT '';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS company_size text NOT NULL DEFAULT '';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS prospect_status text NOT NULL DEFAULT 'unreviewed' CHECK (prospect_status IN ('unreviewed', 'interesting', 'contacted', 'follow_up', 'not_interested'));
ALTER TABLE employers ADD COLUMN IF NOT EXISTS prospect_notes text NOT NULL DEFAULT '';
ALTER TABLE employers ADD COLUMN IF NOT EXISTS follow_up_at timestamptz;
ALTER TABLE employers ADD COLUMN IF NOT EXISTS contacted_at timestamptz;

ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS engineering_specialties jsonb NOT NULL DEFAULT '[]';
ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS technologies jsonb NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS listing_board_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES job_boards(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  listings_seen integer NOT NULL DEFAULT 0,
  active_engineering integer NOT NULL DEFAULT 0,
  new_listings integer NOT NULL DEFAULT 0,
  new_engineering integer NOT NULL DEFAULT 0,
  missing_listings integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS employers_name_idx ON employers (lower(name));
CREATE INDEX IF NOT EXISTS employers_verified_domain_idx ON employers (lower(verified_domain));
CREATE INDEX IF NOT EXISTS job_listings_engineering_specialties_idx ON job_listings USING gin (engineering_specialties);
CREATE INDEX IF NOT EXISTS job_listings_technologies_idx ON job_listings USING gin (technologies);
CREATE INDEX IF NOT EXISTS listing_board_observations_board_time_idx ON listing_board_observations (board_id, observed_at DESC);

WITH source AS (
  SELECT id, lower(concat_ws(' ', title, description, department, team)) AS body
  FROM job_listings
), classifications AS (
  SELECT source.id, (
    SELECT COALESCE(jsonb_agg(specialty), '[]'::jsonb)
    FROM (
    VALUES
      ('backend_api', body ~* '\m(back[ -]?end|api|server[ -]?side|node\.?js|golang|go engineer|java engineer|ruby|django|rails)\M'),
      ('frontend', body ~* '\m(front[ -]?end|ui engineer|react|vue|angular|svelte|css)\M'),
      ('full_stack', body ~* '\m(full[ -]?stack)\M'),
      ('infrastructure_devops', body ~* '\m(devops|sre|site reliability|platform engineer|infrastructure engineer|kubernetes|terraform|cloud engineer)\M'),
      ('data_engineering', body ~* '\m(data engineer|analytics engineer|etl|data platform)\M'),
      ('machine_learning_ai', body ~* '\m(machine learning|ml engineer|artificial intelligence|ai engineer|large language model|llm|generative ai)\M'),
      ('mobile', body ~* '\m(mobile engineer|ios|android|swift|kotlin)\M'),
      ('security', body ~* '\m(security engineer|application security|appsec|cybersecurity|cloud security)\M'),
      ('other_software', body ~* '\m(software engineer|software developer|systems engineer|developer|engineering manager|engineering lead)\M')
    ) AS specialties(specialty, matched)
    WHERE matched
  ) AS engineering_specialties
  FROM source
)
UPDATE job_listings
SET engineering_specialties = classifications.engineering_specialties
FROM classifications
WHERE job_listings.id = classifications.id
  AND job_listings.engineering_specialties = '[]'::jsonb;

WITH source AS (
  SELECT id, lower(concat_ws(' ', title, description, department, team)) AS body
  FROM job_listings
), classifications AS (
  SELECT source.id, (
    SELECT COALESCE(jsonb_agg(technology), '[]'::jsonb)
    FROM (
      VALUES
        ('typescript', body ~* '\mtypescript\M'), ('javascript', body ~* '\mjavascript\M'), ('python', body ~* '\mpython\M'),
        ('node.js', body ~* '\mnode\.?js\M'), ('react', body ~* '\mreact\M'), ('vue', body ~* '\mvue\M'),
        ('angular', body ~* '\mangular\M'), ('java', body ~* '\mjava\M'), ('c#', body ~* '\mc#\M'),
        ('go', body ~* '\mgolang\M|\mgo\M'), ('rust', body ~* '\mrust\M'), ('ruby', body ~* '\mruby\M'),
        ('postgresql', body ~* '\mpostgres(?:ql)?\M'), ('sql', body ~* '\msql\M'), ('aws', body ~* '\maws\M'),
        ('gcp', body ~* '\mgcp\M|\mgoogle cloud\M'), ('azure', body ~* '\mazure\M'), ('kubernetes', body ~* '\mkubernetes\M'),
        ('terraform', body ~* '\mterraform\M'), ('docker', body ~* '\mdocker\M'), ('graphql', body ~* '\mgraphql\M'),
        ('llm', body ~* '\mllm\M|\mlarge language model\M'), ('pytorch', body ~* '\mpytorch\M'), ('tensorflow', body ~* '\mtensorflow\M')
    ) AS technologies(technology, matched)
    WHERE matched
  ) AS technologies
  FROM source
)
UPDATE job_listings
SET technologies = classifications.technologies
FROM classifications
WHERE job_listings.id = classifications.id
  AND job_listings.technologies = '[]'::jsonb;
