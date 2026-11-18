import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import pg from 'pg';
import { config } from './config.js';
import { defaultHeuristics } from './pipeline.js';
import type { DetectionRule, Preferences } from './types.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30_000 });

const migrationLock = [873291, 20261118];
let migrationPromise: Promise<void> | undefined;
let deferredMigrationPromise: Promise<void> | undefined;
const deferredMigrationFiles = new Set([
  '022_market_index_engineering_specialties.sql',
  '023_market_index_technologies.sql',
  '024_market_index_location_signals.sql',
  '025_market_index_observation_time.sql',
  '026_market_index_publication_time.sql',
  '027_market_index_board_observations.sql',
  '028_market_index_listing_events.sql',
  '029_market_index_full_text.sql'
]);
const deferredIndexNames: Record<string, string> = {
  '022_market_index_engineering_specialties.sql': 'job_listings_engineering_specialties_gin_idx',
  '023_market_index_technologies.sql': 'job_listings_technologies_gin_idx',
  '024_market_index_location_signals.sql': 'job_listings_location_signals_gin_idx',
  '025_market_index_observation_time.sql': 'job_listings_observation_time_idx',
  '026_market_index_publication_time.sql': 'job_listings_publication_time_idx',
  '027_market_index_board_observations.sql': 'listing_board_observations_board_day_idx',
  '028_market_index_listing_events.sql': 'listing_events_observed_day_idx',
  '029_market_index_full_text.sql': 'job_listings_market_search_idx'
};

async function runMigrationFiles(files: string[], seed: boolean) {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', migrationLock);
    locked = true;
    for (const file of files) await client.query(await readFile(join(process.cwd(), 'migrations', file), 'utf8'));
    if (seed) await seedDefaults(client);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1, $2)', migrationLock);
    client.release();
  }
}

async function runDeferredIndexMigrations(files: string[]) {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', migrationLock);
    locked = true;
    for (const file of files) {
      const indexName = deferredIndexNames[file];
      const existing = await client.query('SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.relname=$1', [indexName]);
      if (existing.rows[0]?.indisvalid) continue;
      if (existing.rows[0]) await client.query('DROP INDEX CONCURRENTLY IF EXISTS "' + indexName + '"');
      await client.query(await readFile(join(process.cwd(), 'migrations', file), 'utf8'));
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1, $2)', migrationLock);
    client.release();
  }
}

export function migrate() {
  if (!migrationPromise) {
    migrationPromise = readdir(join(process.cwd(), 'migrations'))
      .then((files) => files.filter((file) => file.endsWith('.sql') && !deferredMigrationFiles.has(file)).sort())
      .then((files) => runMigrationFiles(files, true))
      .catch((error) => {
        migrationPromise = undefined;
        throw error;
      });
  }
  return migrationPromise;
}

export function startDeferredMigrations() {
  if (!deferredMigrationPromise) {
    deferredMigrationPromise = readdir(join(process.cwd(), 'migrations'))
      .then((files) => files.filter((file) => deferredMigrationFiles.has(file)).sort())
      .then((files) => runDeferredIndexMigrations(files))
      .catch((error) => {
        deferredMigrationPromise = undefined;
        throw error;
      });
  }
  return deferredMigrationPromise;
}

const defaultRules = [
  ['Hiring keyword', 'hiring', 'phrase', 'hiring', 8, false],
  ['Looking to hire', 'looking to hire', 'phrase', 'hiring', 12, false],
  ['Hiring for a role', 'hiring (for|a|an)', 'regex', 'hiring', 12, false],
  ['We are hiring', "we're hiring|we are hiring", 'regex', 'hiring', 20, false],
  ['I am hiring', "i'm hiring|i am hiring", 'regex', 'hiring', 18, false],
  ['Looking for an engineer', 'looking for (a |an )?(software )?engineer', 'regex', 'role', 14, false],
  ['Looking for a developer', 'looking for (a |an )?(software )?developer', 'regex', 'role', 14, false],
  ['Founding engineer', 'founding engineer', 'phrase', 'role', 18, false],
  ['Join our team', 'join our team', 'phrase', 'hiring', 12, false],
  ['Need a contractor', 'need a contractor', 'phrase', 'contract', 16, false],
  ['Contractor mention', 'contractor', 'phrase', 'contract', 8, false],
  ['Freelance help', 'looking for freelance help', 'phrase', 'contract', 16, false],
  ['Freelance mention', 'freelance', 'phrase', 'contract', 8, false],
  ['DM me if interested', 'dm me if interested', 'phrase', 'contact', 10, false],
  ['Know good developers', 'know any good developers', 'phrase', 'contact', 12, false],
  ['Expanding engineering team', 'expanding our engineering team', 'phrase', 'hiring', 18, false],
  ['Hiring remote', 'hiring remote', 'phrase', 'remote', 12, false],
  ['Looking for someone to build', 'looking for someone to build', 'phrase', 'role', 12, false],
  ['Need an engineer or developer', 'need (a |an )?(backend |frontend |full[- ]stack )?(engineer|developer)', 'regex', 'role', 14, false],
  ['Seeking an engineer or developer', 'seeking (a |an )?(engineer|developer)', 'regex', 'role', 14, false],
  ['Engineer wanted', '(engineer|developer) wanted|engineering role', 'regex', 'role', 12, false],
  ['Engineering hire', 'looking for an engineering hire', 'phrase', 'role', 14, false],
  ['Backend engineer role', 'backend engineer', 'phrase', 'role', 10, false],
  ['Software engineer role', 'software engineer', 'phrase', 'role', 10, false],
  ['Job opening', 'job opening|open role', 'regex', 'hiring', 10, false],
  ['Infrastructure help', 'need help with our infrastructure', 'phrase', 'technology', 16, false],
  ['Who is hiring thread', 'who is hiring', 'phrase', 'hiring', 10, false],
  ['Hiring closed', 'hiring (is )?(closed|over)|no longer hiring|position (is )?filled', 'regex', 'negative', 0, true],
  ['Historical announcement', 'last year we (were )?hiring|previously hired|we hired', 'regex', 'negative', 0, true]
];

export const defaultPreferences: Preferences = {
  minimumNotificationScore: 55,
  minimumNotificationSignalQuality: 60,
  minimumNotificationPersonalRelevance: 55,
  minimumNotificationLocationFitScore: 40,
  listingsNotificationsEnabled: true,
  minimumListingRelevance: 55,
  minimumListingLocationFitScore: 40,
  notificationsEnabled: true,
  notifyRecovered: config.notifyRecovered,
  technologyTerms: ['typescript', 'javascript', 'node.js', 'nodejs', 'python', 'backend', 'full-stack', 'full stack', 'infrastructure', 'devops', 'react', 'postgresql', 'kubernetes'],
  roleTerms: ['software engineer', 'backend engineer', 'full-stack engineer', 'developer', 'engineering hire', 'founding engineer'],
  remoteTerms: ['remote', 'distributed', 'work from anywhere'],
  internationalTerms: ['worldwide', 'anywhere in the world', 'international', 'global', 'timezone overlap', 'taiwan'],
  contractTerms: ['contract', 'contractor', 'freelance', 'consulting', 'part-time'],
  contactTerms: ['dm me', 'direct message', 'email me', 'reach out', 'founder', 'hiring manager'],
  weights: { hiring: 20, role: 18, technology: 28, remote: 12, international: 8, contract: 10, contact: 8 },
  heuristics: { ...defaultHeuristics },
  locationProfile: { baseLocation: '', timeZone: 'UTC', utcOffset: 0, preferredRegions: [] }
};

async function seedDefaults(client: pg.PoolClient) {
  for (const [name, pattern, matchType, category, weight, negative] of defaultRules) {
    await client.query(`INSERT INTO detection_rules (name, pattern, match_type, category, weight, negative)
      SELECT $1, $2, $3, $4, $5, $6 WHERE NOT EXISTS (SELECT 1 FROM detection_rules WHERE name = $1)`,
      [name, pattern, matchType, category, weight, negative]);
  }
  await client.query(`INSERT INTO app_settings (key, value) VALUES ('preferences', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(defaultPreferences)]);
  await client.query(`INSERT INTO ingestion_states (source) VALUES ('bluesky'), ('hacker_news'), ('mastodon'), ('reddit') ON CONFLICT DO NOTHING`);
  for (const [pattern, label] of [
    ['nearskill.in', 'Observed job-board domain: NearSkill'],
    ['remote-work.app', 'Observed job-board domain: Remote Work'],
    ['hiring.lat', 'Observed job-board domain: Hiring LAT'],
    ['jobicy.com', 'Observed job-board domain: Jobicy'],
    ['remoteitjobs.app', 'Observed job-board domain: Remote IT Jobs'],
    ['remoteornothing.com', 'Observed job-board domain: Remote or Nothing'],
    ['freelapp.nl', 'Observed job-board domain: Freelapp'],
    ['topgenaijobs.com', 'Observed job-board domain: Top Gen AI Jobs']
  ]) await client.query(`INSERT INTO aggregator_registry (match_type, pattern, label) VALUES ('domain', $1, $2) ON CONFLICT (match_type, pattern) DO NOTHING`, [pattern, label]);
}

export async function getPreferences(): Promise<Preferences> {
  const result = await pool.query('SELECT value FROM app_settings WHERE key = $1', ['preferences']);
  const saved = result.rows[0]?.value ?? {};
  return {
    ...defaultPreferences,
    ...saved,
    weights: { ...defaultPreferences.weights, ...(saved.weights ?? {}) },
    heuristics: { ...defaultPreferences.heuristics, ...(saved.heuristics ?? {}) },
    locationProfile: { ...defaultPreferences.locationProfile, ...(saved.locationProfile ?? {}) }
  };
}

export async function setPreferences(value: Partial<Preferences>) {
  const next = { ...(await getPreferences()), ...value };
  await pool.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('preferences', $1, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(next)]);
  return next;
}

export async function getRules(): Promise<DetectionRule[]> {
  const result = await pool.query('SELECT id, name, pattern, match_type, category, weight, negative, enabled FROM detection_rules ORDER BY created_at');
  return result.rows.map((row) => ({ ...row, weight: Number(row.weight) }));
}

export async function getAggregatorRegistry() {
  const result = await pool.query('SELECT id, match_type, pattern, label, enabled, notes FROM aggregator_registry WHERE enabled = true ORDER BY created_at');
  return result.rows;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
