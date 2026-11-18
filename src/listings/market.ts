import { pool } from '../db.js';
import { LISTING_CLASSIFICATION_VERSION } from './classification.js';

export type MarketQuery = {
  active?: string;
  provider?: string;
  category?: string;
  specialty?: string;
  technology?: string;
  employer?: string;
  q?: string;
  region?: string;
  country?: string;
  remoteEligibility?: string;
  workMode?: string;
  employmentType?: string;
  seniority?: string;
  location?: string;
  salaryCurrency?: string;
  minSalary?: string;
  maxSalary?: string;
  publishedAfter?: string;
  publishedBefore?: string;
  maxAgeDays?: string;
  firstObservedAfter?: string;
  limit?: string;
  offset?: string;
  sort?: string;
};

const providers = ['greenhouse', 'ashby', 'lever', 'remotive', 'adzuna'];
const workModes = ['remote', 'hybrid', 'onsite', 'unknown'];
const eligibilityModes = ['worldwide', 'regional', 'country_specific', 'unknown'];

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function marketWhere(query: MarketQuery, values: unknown[], alias = 'l'): string {
  const conditions: string[] = [];
  if (query.active !== 'all') conditions.push(`${alias}.is_active = ${query.active === 'false' ? 'false' : 'true'}`);
  if (query.provider && providers.includes(query.provider)) { values.push(query.provider); conditions.push(`${alias}.provider = $${values.length}`); }
  if (query.category) { values.push(query.category); conditions.push(`COALESCE(NULLIF(${alias}.job_category, ''), 'unknown') = $${values.length}`); }
  if (query.specialty) { values.push(query.specialty); conditions.push(`${alias}.engineering_specialties ? $${values.length}`); }
  if (query.technology) { values.push(query.technology); conditions.push(`${alias}.technologies ? $${values.length}`); }
  if (query.employer) { values.push(`%${query.employer}%`); conditions.push(`e.name ILIKE $${values.length}`); }
  if (query.q) { values.push(query.q); conditions.push(`to_tsvector('simple', coalesce(${alias}.title, '') || ' ' || coalesce(${alias}.description, '')) @@ plainto_tsquery('simple', $${values.length})`); }
  if (query.region) { values.push(query.region); conditions.push(`${alias}.location_signals->'regions' ? $${values.length}`); }
  if (query.country) { values.push(query.country); conditions.push(`(${alias}.location_signals->'countries' ? $${values.length} OR ${alias}.location_signals->'locations' ? $${values.length})`); }
  if (query.remoteEligibility && eligibilityModes.includes(query.remoteEligibility)) { values.push(query.remoteEligibility); conditions.push(`${alias}.location_signals->>'workEligibility' = $${values.length}`); }
  if (query.workMode && workModes.includes(query.workMode)) { values.push(query.workMode); conditions.push(`${alias}.remote_mode = $${values.length}`); }
  if (query.employmentType) { values.push(`%${query.employmentType}%`); conditions.push(`${alias}.employment_type ILIKE $${values.length}`); }
  if (query.seniority) { values.push(`%${query.seniority}%`); conditions.push(`${alias}.seniority ILIKE $${values.length}`); }
  if (query.location) { values.push(`%${query.location}%`); conditions.push(`(${alias}.location ILIKE $${values.length} OR ${alias}.secondary_locations::text ILIKE $${values.length} OR ${alias}.geographic_restrictions::text ILIKE $${values.length})`); }
  if (query.salaryCurrency) { values.push(query.salaryCurrency.toUpperCase()); conditions.push(`${alias}.compensation_currency = $${values.length}`); }
  const minSalary = finiteNumber(query.minSalary);
  if (minSalary !== undefined && minSalary > 0) { values.push(minSalary); conditions.push(`COALESCE(${alias}.compensation_max, ${alias}.compensation_min) >= $${values.length}`); }
  const maxSalary = finiteNumber(query.maxSalary);
  if (maxSalary !== undefined && maxSalary > 0) { values.push(maxSalary); conditions.push(`COALESCE(${alias}.compensation_min, ${alias}.compensation_max) <= $${values.length}`); }
  const maxAgeDays = finiteNumber(query.maxAgeDays);
  if (maxAgeDays !== undefined && maxAgeDays > 0) { values.push(maxAgeDays); conditions.push(`${alias}.published_at IS NOT NULL AND ${alias}.published_at >= now() - ($${values.length}::text || ' days')::interval`); }
  if (query.publishedAfter && !Number.isNaN(Date.parse(query.publishedAfter))) { values.push(query.publishedAfter); conditions.push(`${alias}.published_at >= $${values.length}::timestamptz`); }
  if (query.publishedBefore && !Number.isNaN(Date.parse(query.publishedBefore))) { values.push(query.publishedBefore); conditions.push(`${alias}.published_at < ($${values.length}::date + interval '1 day')`); }
  if (query.firstObservedAfter && !Number.isNaN(Date.parse(query.firstObservedAfter))) { values.push(query.firstObservedAfter); conditions.push(`${alias}.first_observed_at >= $${values.length}::timestamptz`); }
  return conditions.length ? conditions.join(' AND ') : 'TRUE';
}

export async function getMarketSummary(query: MarketQuery) {
  const values: unknown[] = [];
  const where = marketWhere(query, values);
  const from = `job_listings l JOIN job_boards b ON b.id=l.board_id JOIN employers e ON e.id=b.employer_id`;
  const limit = Math.min(100, Math.max(1, finiteNumber(query.limit) ?? 50));
  const offset = Math.max(0, finiteNumber(query.offset) ?? 0);
  const orderBy = query.sort === 'first_observed' ? 'l.first_observed_at DESC NULLS LAST, l.id' : query.sort === 'salary' ? 'COALESCE(l.compensation_max, l.compensation_min) DESC NULLS LAST, l.id' : 'l.source_updated_at DESC NULLS LAST, l.first_observed_at DESC, l.id';
  const [totals, categories, specialties, technologies, providersResult, workModesResult, employmentTypes, seniority, regions, countries, employers, quality, listings] = await Promise.all([
    pool.query(`SELECT count(*)::int AS active_listings,
      count(DISTINCT e.id)::int AS monitored_employers,
      count(*) FILTER (WHERE jsonb_array_length(COALESCE(l.engineering_specialties,'[]'::jsonb)) > 0)::int AS engineering_openings,
      count(*) FILTER (WHERE l.remote_mode='remote')::int AS remote_openings,
      count(*) FILTER (WHERE l.employment_type ILIKE '%contract%' OR l.employment_type ILIKE '%freelance%')::int AS contract_openings,
      count(*) FILTER (WHERE l.compensation_min IS NOT NULL OR l.compensation_max IS NOT NULL)::int AS listings_with_compensation,
      count(*) FILTER (WHERE l.first_observed_at >= now() - interval '7 days')::int AS observed_last_7_days,
      count(*) FILTER (WHERE l.first_observed_at >= now() - interval '7 days' AND l.first_observed_at > b.initialized_at)::int AS new_listings_last_7_days
      FROM ${from} WHERE ${where}`, values),
    pool.query(`SELECT COALESCE(NULLIF(l.job_category,''),'unknown') AS value, count(*)::int AS count FROM ${from} WHERE ${where} GROUP BY 1 ORDER BY count DESC, value`, values),
    pool.query(`SELECT facet.value, count(*)::int AS count FROM ${from} CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(l.engineering_specialties,'[]'::jsonb)) AS facet(value) WHERE ${where} GROUP BY facet.value ORDER BY count DESC, facet.value`, values),
    pool.query(`SELECT facet.value, count(*)::int AS count FROM ${from} CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(l.technologies,'[]'::jsonb)) AS facet(value) WHERE ${where} GROUP BY facet.value ORDER BY count DESC, facet.value`, values),
    pool.query(`SELECT l.provider AS value, count(*)::int AS count FROM ${from} WHERE ${where} GROUP BY l.provider ORDER BY count DESC, l.provider`, values),
    pool.query(`SELECT l.remote_mode AS value, count(*)::int AS count FROM ${from} WHERE ${where} GROUP BY l.remote_mode ORDER BY count DESC, l.remote_mode`, values),
    pool.query(`SELECT COALESCE(NULLIF(l.employment_type,''),'unknown') AS value, count(*)::int AS count FROM ${from} WHERE ${where} GROUP BY 1 ORDER BY count DESC, value LIMIT 25`, values),
    pool.query(`SELECT COALESCE(NULLIF(l.seniority,''),'unknown') AS value, count(*)::int AS count FROM ${from} WHERE ${where} GROUP BY 1 ORDER BY count DESC, value LIMIT 25`, values),
    pool.query(`SELECT facet.value, count(*)::int AS count FROM ${from} CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(l.location_signals->'regions','[]'::jsonb)) AS facet(value) WHERE ${where} GROUP BY facet.value ORDER BY count DESC, facet.value LIMIT 25`, values),
    pool.query(`SELECT facet.value, count(*)::int AS count FROM ${from} CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(l.location_signals->'countries', l.location_signals->'locations', '[]'::jsonb)) AS facet(value) WHERE facet.value IN ('United States','Canada','Mexico','United Kingdom','Ireland','Germany','France','Netherlands','Spain','Portugal','Switzerland','Poland','Taiwan','Japan','South Korea','Singapore','Hong Kong','India','Australia','New Zealand','Israel','Brazil') AND ${where} GROUP BY facet.value ORDER BY count DESC, facet.value LIMIT 25`, values),
    pool.query(`SELECT e.id AS employer_id, e.name AS value, count(*)::int AS listings, count(*) FILTER (WHERE jsonb_array_length(COALESCE(l.engineering_specialties,'[]'::jsonb)) > 0)::int AS engineering, count(*) FILTER (WHERE l.remote_mode='remote')::int AS remote FROM ${from} WHERE ${where} GROUP BY e.id, e.name ORDER BY engineering DESC, listings DESC, e.name LIMIT 50`, values),
    pool.query(`SELECT count(*)::int AS listings,
      count(*) FILTER (WHERE l.classification_version >= $${values.length + 1})::int AS classified,
      count(*) FILTER (WHERE l.location_signals ? 'workEligibility')::int AS location_classified,
      count(*) FILTER (WHERE l.compensation_min IS NOT NULL OR l.compensation_max IS NOT NULL)::int AS salary_extracted
      FROM ${from} WHERE ${where}`, [...values, LISTING_CLASSIFICATION_VERSION]),
    pool.query(`SELECT l.id, l.title, l.provider, l.company_name, e.id AS employer_id, e.name AS employer_name, l.location, l.remote_mode, l.job_category, l.primary_specialty, l.engineering_specialties, l.technologies, l.compensation_min, l.compensation_max, l.compensation_currency, l.compensation_period, l.application_url, l.original_url, l.published_at, l.first_observed_at
      FROM ${from} WHERE ${where} ORDER BY ${orderBy} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset])
  ]);
  return {
    filters: query,
    totals: totals.rows[0],
    facets: {
      categories: categories.rows,
      specialties: specialties.rows,
      technologies: technologies.rows,
      providers: providersResult.rows,
      workModes: workModesResult.rows,
      employmentTypes: employmentTypes.rows,
      seniority: seniority.rows,
      regions: regions.rows,
      countries: countries.rows,
      employers: employers.rows
    },
    dataQuality: quality.rows[0],
    listings: listings.rows,
    pagination: { limit, offset, total: Number(totals.rows[0]?.active_listings || 0) }
  };
}
