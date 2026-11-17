import type { NormalizedJobListing } from '../types.js';
import { pool } from '../db.js';

export const engineeringSpecialtyLabels: Record<string, string> = {
  backend_api: 'Backend / API',
  frontend: 'Frontend',
  full_stack: 'Full-stack',
  infrastructure_devops: 'Infrastructure / DevOps / SRE',
  data_engineering: 'Data engineering',
  machine_learning_ai: 'Machine learning / AI',
  mobile: 'Mobile',
  security: 'Security',
  other_software: 'Other software engineering'
};

export const technologyVocabulary = ['typescript', 'javascript', 'python', 'node.js', 'react', 'vue', 'angular', 'java', 'c#', 'go', 'rust', 'ruby', 'postgresql', 'sql', 'aws', 'gcp', 'azure', 'kubernetes', 'terraform', 'docker', 'graphql', 'llm', 'pytorch', 'tensorflow'];

const specialtyPatterns: Array<[string, RegExp]> = [
  ['backend_api', /\b(back[ -]?end|api|server[ -]?side|node\.?js|golang|go engineer|java engineer|ruby|django|rails)\b/i],
  ['frontend', /\b(front[ -]?end|ui engineer|react|vue|angular|svelte|css)\b/i],
  ['full_stack', /\b(full[ -]?stack)\b/i],
  ['infrastructure_devops', /\b(devops|sre|site reliability|platform engineer|infrastructure engineer|kubernetes|terraform|cloud engineer)\b/i],
  ['data_engineering', /\b(data engineer|analytics engineer|etl|data platform)\b/i],
  ['machine_learning_ai', /\b(machine learning|ml engineer|artificial intelligence|ai engineer|large language model|llm|generative ai)\b/i],
  ['mobile', /\b(mobile engineer|ios|android|swift|kotlin)\b/i],
  ['security', /\b(security engineer|application security|appsec|cybersecurity|cloud security)\b/i],
  ['other_software', /\b(software engineer|software developer|systems engineer|developer|engineering manager|engineering lead)\b/i]
];

export function classifyEngineeringSpecialties(listing: Pick<NormalizedJobListing, 'title' | 'description' | 'department' | 'team'>): string[] {
  const body = [listing.title, listing.description, listing.department, listing.team].filter(Boolean).join(' ');
  return specialtyPatterns.filter(([, pattern]) => pattern.test(body)).map(([specialty]) => specialty);
}

export function isEngineeringListing(specialties: string[]): boolean { return specialties.length > 0; }

export function extractListingTechnologies(listing: Pick<NormalizedJobListing, 'title' | 'description' | 'department' | 'team'>): string[] {
  const body = [listing.title, listing.description, listing.department, listing.team].filter(Boolean).join(' ').toLowerCase();
  return technologyVocabulary.filter((technology) => {
    const escaped = technology.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped.replace('node\\.js', 'node\\.?js')}([^a-z0-9]|$)`, 'i').test(body);
  });
}

export type CompanyScoreInputs = { activeEngineering: number; newEngineering7d: number; contractListings: number; remoteListings: number; hasRecentActivity?: boolean };

export function calculateProspectScore(inputs: CompanyScoreInputs): { score: number; factors: Array<{ label: string; points: number; evidence: string }> } {
  const factors = [
    { label: 'Active engineering openings', points: Math.min(30, inputs.activeEngineering * 5), evidence: `${inputs.activeEngineering} active engineering opening${inputs.activeEngineering === 1 ? '' : 's'}` },
    { label: 'New engineering openings in 7 days', points: Math.min(25, inputs.newEngineering7d * 8), evidence: `${inputs.newEngineering7d} engineering opening${inputs.newEngineering7d === 1 ? '' : 's'} newly observed in 7 days` },
    { label: 'Contract hiring', points: Math.min(20, inputs.contractListings * 10), evidence: `${inputs.contractListings} active contract listing${inputs.contractListings === 1 ? '' : 's'}` },
    { label: 'Remote hiring', points: Math.min(10, inputs.remoteListings * 2), evidence: `${inputs.remoteListings} active remote listing${inputs.remoteListings === 1 ? '' : 's'}` },
    { label: 'Recent monitoring activity', points: inputs.hasRecentActivity ? 5 : 0, evidence: inputs.hasRecentActivity ? 'Observed activity in the last 30 days' : 'No recent activity evidence' }
  ].filter((factor) => factor.points > 0);
  return { score: Math.min(100, factors.reduce((total, factor) => total + factor.points, 0)), factors };
}

export async function backfillListingMetadata() {
  const marker = await pool.query(`SELECT 1 FROM app_settings WHERE key='company_listing_metadata_backfill_v1'`);
  if (marker.rows[0]) return;
  let processed = 0;
  while (true) {
    const result = await pool.query(`SELECT id, title, description, department, team FROM job_listings WHERE company_metadata_backfilled_at IS NULL ORDER BY id LIMIT 500`);
    if (!result.rows.length) break;
    const updates = result.rows.map((row) => ({ id: row.id, engineering_specialties: classifyEngineeringSpecialties(row), technologies: extractListingTechnologies(row) }));
    await pool.query(`UPDATE job_listings AS listing
      SET engineering_specialties=CASE WHEN listing.engineering_specialties='[]'::jsonb THEN updates.engineering_specialties ELSE listing.engineering_specialties END,
          technologies=CASE WHEN listing.technologies='[]'::jsonb THEN updates.technologies ELSE listing.technologies END,
          company_metadata_backfilled_at=now(),
          updated_at=now()
      FROM jsonb_to_recordset($1::jsonb) AS updates(id uuid, engineering_specialties jsonb, technologies jsonb)
      WHERE listing.id=updates.id`, [JSON.stringify(updates)]);
    processed += result.rows.length;
    if (processed % 5_000 === 0) console.info(`Company metadata backfill: ${processed} listings processed`);
  }
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('company_listing_metadata_backfill_v1', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify({ completed: true, processed })]);
  console.info(`Company metadata backfill complete: ${processed} listings processed`);
}
