CREATE TABLE IF NOT EXISTS listing_technology_aliases (
  canonical text NOT NULL,
  alias text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  classification_version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (canonical, alias)
);

INSERT INTO listing_technology_aliases (canonical, alias) VALUES
  ('typescript', 'typescript'), ('typescript', 'type script'),
  ('javascript', 'javascript'), ('javascript', 'ecmascript'),
  ('python', 'python'),
  ('node.js', 'node.js'), ('node.js', 'nodejs'), ('node.js', 'node js'),
  ('react', 'react'), ('react', 'react.js'), ('react', 'reactjs'),
  ('vue', 'vue'), ('vue', 'vue.js'), ('vue', 'vuejs'),
  ('angular', 'angular'), ('java', 'java'), ('c#', 'c#'), ('c#', 'c-sharp'),
  ('go', 'golang'), ('rust', 'rust'), ('ruby', 'ruby'),
  ('postgresql', 'postgresql'), ('postgresql', 'postgres'), ('sql', 'sql'),
  ('aws', 'aws'), ('aws', 'amazon web services'), ('gcp', 'gcp'), ('gcp', 'google cloud'),
  ('azure', 'azure'), ('azure', 'microsoft azure'), ('kubernetes', 'kubernetes'), ('kubernetes', 'k8s'),
  ('terraform', 'terraform'), ('docker', 'docker'), ('graphql', 'graphql'),
  ('llm', 'llm'), ('llm', 'large language model'), ('pytorch', 'pytorch'), ('tensorflow', 'tensorflow')
ON CONFLICT (canonical, alias) DO NOTHING;

CREATE INDEX IF NOT EXISTS listing_technology_aliases_enabled_idx ON listing_technology_aliases (enabled, canonical);
