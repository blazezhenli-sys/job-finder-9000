import { pool } from '../db.js';
import type { AtsProvider, NormalizedJobListing } from '../types.js';

export const LISTING_CLASSIFICATION_VERSION = 1;

export const jobCategoryLabels: Record<string, string> = {
  software_engineering: 'Software engineering',
  it_infrastructure: 'IT / infrastructure',
  data_analytics: 'Data / analytics',
  product: 'Product',
  design: 'Design',
  sales: 'Sales',
  marketing: 'Marketing',
  operations: 'Operations',
  finance: 'Finance',
  customer_support: 'Customer support',
  other: 'Other',
  unknown: 'Unknown'
};

export const engineeringSpecialtyLabels: Record<string, string> = {
  backend_api: 'Backend / API',
  frontend: 'Frontend',
  full_stack: 'Full-stack',
  infrastructure_devops: 'DevOps / SRE',
  platform_infrastructure: 'Platform / infrastructure',
  data_engineering: 'Data engineering',
  machine_learning_ai: 'Machine learning / AI',
  mobile: 'Mobile',
  security: 'Security',
  qa_testing: 'QA / testing',
  embedded_systems: 'Embedded / systems',
  other_software: 'Other software engineering'
};

type ListingText = Pick<NormalizedJobListing, 'title' | 'description' | 'department' | 'team'>;

const specialtyPatterns: Array<[string, RegExp]> = [
  ['backend_api', /\b(back[ -]?end|api|server[ -]?side|node\.?js|golang|go engineer|java engineer|ruby|django|rails)\b/i],
  ['frontend', /\b(front[ -]?end|ui engineer|react|vue|angular|svelte|css)\b/i],
  ['full_stack', /\b(full[ -]?stack)\b/i],
  ['infrastructure_devops', /\b(devops|sre|site reliability|infrastructure engineer|kubernetes|terraform|cloud engineer)\b/i],
  ['platform_infrastructure', /\b(platform engineer|platform infrastructure|systems platform|developer platform)\b/i],
  ['data_engineering', /\b(data engineer|analytics engineer|etl|data platform)\b/i],
  ['machine_learning_ai', /\b(machine learning|ml engineer|artificial intelligence|ai engineer|large language model|llm|generative ai)\b/i],
  ['mobile', /\b(mobile engineer|ios|android|swift|kotlin)\b/i],
  ['security', /\b(security engineer|application security|appsec|cybersecurity|cloud security)\b/i],
  ['qa_testing', /\b(qa engineer|quality assurance|test automation|software tester|sdet|test engineer)\b/i],
  ['embedded_systems', /\b(embedded|firmware|systems engineer|real[- ]time systems)\b/i],
  ['other_software', /\b(software engineer|software developer|engineering manager|engineering lead|developer)\b/i]
];

const technologyTaxonomy: Array<{ label: string; aliases: string[] }> = [
  { label: 'typescript', aliases: ['typescript', 'type script'] },
  { label: 'javascript', aliases: ['javascript', 'ecmascript'] },
  { label: 'python', aliases: ['python'] },
  { label: 'node.js', aliases: ['node.js', 'nodejs', 'node js'] },
  { label: 'react', aliases: ['react', 'react.js', 'reactjs'] },
  { label: 'vue', aliases: ['vue', 'vue.js', 'vuejs'] },
  { label: 'angular', aliases: ['angular'] },
  { label: 'java', aliases: ['java'] },
  { label: 'c#', aliases: ['c#', 'c-sharp'] },
  { label: 'go', aliases: ['golang'] },
  { label: 'rust', aliases: ['rust'] },
  { label: 'ruby', aliases: ['ruby'] },
  { label: 'postgresql', aliases: ['postgresql', 'postgres'] },
  { label: 'sql', aliases: ['sql'] },
  { label: 'aws', aliases: ['aws', 'amazon web services'] },
  { label: 'gcp', aliases: ['gcp', 'google cloud'] },
  { label: 'azure', aliases: ['azure', 'microsoft azure'] },
  { label: 'kubernetes', aliases: ['kubernetes', 'k8s'] },
  { label: 'terraform', aliases: ['terraform'] },
  { label: 'docker', aliases: ['docker'] },
  { label: 'graphql', aliases: ['graphql'] },
  { label: 'llm', aliases: ['llm', 'large language model'] },
  { label: 'pytorch', aliases: ['pytorch'] },
  { label: 'tensorflow', aliases: ['tensorflow'] }
];

function body(listing: ListingText): string {
  return [listing.title, listing.description, listing.department, listing.team].filter(Boolean).join(' ');
}

function boundaryPattern(alias: string): RegExp {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
}

export function classifyEngineeringSpecialties(listing: ListingText): string[] {
  const text = body(listing);
  return specialtyPatterns.filter(([, pattern]) => pattern.test(text)).map(([specialty]) => specialty);
}

export function extractListingTechnologies(listing: ListingText): string[] {
  const text = body(listing);
  return technologyTaxonomy.filter(({ label, aliases }) => aliases.some((alias) => boundaryPattern(alias).test(text))).map(({ label }) => label);
}

export function classifyJobCategory(listing: ListingText, specialties = classifyEngineeringSpecialties(listing)): string {
  const text = body(listing);
  if (specialties.some((specialty) => ['backend_api', 'frontend', 'full_stack', 'mobile', 'security', 'qa_testing', 'embedded_systems', 'other_software'].includes(specialty))) return 'software_engineering';
  if (specialties.includes('infrastructure_devops') || specialties.includes('platform_infrastructure')) return 'it_infrastructure';
  if (specialties.includes('data_engineering') || specialties.includes('machine_learning_ai')) return 'data_analytics';
  const patterns: Array<[string, RegExp]> = [
    ['product', /\b(product manager|product management|product owner|product designer)\b/i],
    ['design', /\b(ux|ui designer|visual designer|design lead|user researcher)\b/i],
    ['sales', /\b(sales|account executive|business development|sales development)\b/i],
    ['marketing', /\b(marketing|seo|content strategist|growth marketer|brand)\b/i],
    ['operations', /\b(operations|program manager|project manager|recruiter|people operations|human resources)\b/i],
    ['finance', /\b(finance|accounting|controller|bookkeeper|financial analyst)\b/i],
    ['customer_support', /\b(customer support|customer success|technical support|help desk)\b/i],
    ['data_analytics', /\b(data analyst|data science|data scientist|analytics|business intelligence)\b/i]
  ];
  return patterns.find(([, pattern]) => pattern.test(text))?.[0] ?? (text.trim() ? 'other' : 'unknown');
}

export function classifyListing(listing: ListingText) {
  const engineeringSpecialties = classifyEngineeringSpecialties(listing);
  const technologies = extractListingTechnologies(listing);
  const primarySpecialty = engineeringSpecialties[0] ?? '';
  return {
    jobCategory: classifyJobCategory(listing, engineeringSpecialties),
    primarySpecialty,
    engineeringSpecialties,
    technologies,
    version: LISTING_CLASSIFICATION_VERSION,
    method: 'deterministic-taxonomy'
  };
}

type ClassificationRow = { id: string; title: string; description: string; department: string; team: string };

export async function backfillListingClassification() {
  let processed = 0;
  while (true) {
    const result = await pool.query<ClassificationRow>(`SELECT id, title, description, department, team
      FROM job_listings
      WHERE classification_backfilled_at IS NULL
      ORDER BY id
      LIMIT 500`);
    if (!result.rows.length) break;
    const updates = result.rows.map((row) => ({ id: row.id, ...classifyListing(row) }));
    await pool.query(`UPDATE job_listings AS listing
      SET job_category=updates.job_category,
          primary_specialty=updates.primary_specialty,
          engineering_specialties=updates.engineering_specialties,
          technologies=updates.technologies,
          classification_version=updates.classification_version,
          classification_method=updates.classification_method,
          classification_backfilled_at=now(),
          updated_at=now()
      FROM jsonb_to_recordset($1::jsonb) AS updates(
        id uuid,
        job_category text,
        primary_specialty text,
        engineering_specialties jsonb,
        technologies jsonb,
        classification_version integer,
        classification_method text
      )
      WHERE listing.id=updates.id`, [JSON.stringify(updates)]);
    processed += result.rows.length;
    if (processed % 5_000 === 0) console.info(`Listing classification backfill: ${processed} listings processed`);
  }
  console.info(`Listing classification backfill complete: ${processed} listings processed`);
}
