import { config } from './config.js';
import { pool } from './db.js';
import { analyzeCompanySocialPost } from './pipeline.js';
import { scoreUnanalyzedCompanySocialPosts } from './company-social-analysis.js';
import type { Analysis, SignalCategory } from './types.js';

const qualifyingCategories = new Set<SignalCategory>(['direct_hiring', 'service_request', 'employee_referral', 'firsthand_announcement']);

export type CompanySocialPostInput = {
  id: string;
  employer_id: string;
  employer_name: string;
  employer_website: string | null;
  platform: string;
  source_url: string;
  text: string;
  published_at: string;
  analysis?: Analysis | null;
};

type QualifyingPost = CompanySocialPostInput & { analysis: Analysis };

export interface CompanySocialSignal {
  company: { id: string; name: string; website: string | null };
  primaryCategory: SignalCategory;
  categories: SignalCategory[];
  signalQuality: number;
  firstPostAt: string;
  lastPostAt: string;
  matchingPostCount: number;
  posts: Array<{
    id: string;
    platform: string;
    sourceUrl: string;
    text: string;
    publishedAt: string;
    category: SignalCategory;
    signalQuality: number;
    matchedRules: string[];
    classificationReasons: string[];
  }>;
}
function qualifies(analysis: Analysis): boolean {
  return analysis.matchedRules.some((rule) => !rule.negative) && !analysis.blocked && !analysis.suppressed && qualifyingCategories.has(analysis.category);
}

function signalFromPosts(posts: QualifyingPost[]): CompanySocialSignal {
  const ordered = [...posts].sort((left, right) => new Date(right.published_at).getTime() - new Date(left.published_at).getTime());
  const strongest = [...ordered].sort((left, right) => right.analysis.signalQuality - left.analysis.signalQuality || new Date(right.published_at).getTime() - new Date(left.published_at).getTime())[0];
  const categories = [...new Set(ordered.map((post) => post.analysis.category))];
  const publishedAt = (value: string) => new Date(value).toISOString();
  return {
    company: { id: strongest.employer_id, name: strongest.employer_name, website: strongest.employer_website },
    primaryCategory: strongest.analysis.category,
    categories,
    signalQuality: strongest.analysis.signalQuality,
    firstPostAt: publishedAt(ordered.at(-1)!.published_at),
    lastPostAt: publishedAt(ordered[0].published_at),
    matchingPostCount: ordered.length,
    posts: ordered.slice(0, 10).map((post) => ({
      id: post.id,
      platform: post.platform,
      sourceUrl: post.source_url,
      text: post.text,
      publishedAt: publishedAt(post.published_at),
      category: post.analysis.category,
      signalQuality: post.analysis.signalQuality,
      matchedRules: post.analysis.matchedRules.map((rule) => rule.name),
      classificationReasons: post.analysis.classificationReasons
    }))
  };
}

export function coalesceCompanySocialPosts(rows: CompanySocialPostInput[], rules: Parameters<typeof analyzeCompanySocialPost>[1], preferences: Parameters<typeof analyzeCompanySocialPost>[2]): CompanySocialSignal[] {
  const grouped = new Map<string, QualifyingPost[]>();
  for (const row of rows) {
    const analysis = row.analysis ?? analyzeCompanySocialPost(row.text, rules, preferences);
    if (!qualifies(analysis)) continue;
    const posts = grouped.get(row.employer_id) ?? [];
    posts.push({ ...row, analysis });
    grouped.set(row.employer_id, posts);
  }
  return [...grouped.values()]
    .map(signalFromPosts)
    .sort((left, right) => new Date(right.lastPostAt).getTime() - new Date(left.lastPostAt).getTime() || left.company.name.localeCompare(right.company.name) || left.company.id.localeCompare(right.company.id));
}

export function filterCompanySocialPosts(rows: CompanySocialPostInput[], now = new Date(), retentionDays = config.companySocialRetentionDays): CompanySocialPostInput[] {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  return rows.filter((row) => new Date(row.published_at).getTime() >= cutoff);
}

const signalCacheTtlMs = 5_000;
type StoredEvidence = { id: string; platform: string; sourceUrl: string; text: string; publishedAt: string; analysis: Analysis };
type StoredSignalRow = {
  company_id: string;
  company_name: string;
  company_website: string | null;
  signal_quality: number;
  first_post_at: string;
  last_post_at: string;
  matching_post_count: number;
  categories: string[];
  strongest_analysis: Analysis;
  posts: StoredEvidence[];
};
type CompanySocialSignalPage = { signals: CompanySocialSignal[]; total: number; retentionDays: number };

const signalCache = new Map<string, { expiresAt: number; value: CompanySocialSignalPage }>();
const signalPagePromises = new Map<string, Promise<CompanySocialSignalPage>>();

async function buildCompanySocialSignalPage(limit: number, offset: number): Promise<CompanySocialSignalPage> {
  // This is a no-op after ingestion/backfill has scored every retained row.
  await scoreUnanalyzedCompanySocialPosts();
  const cutoff = new Date(Date.now() - config.companySocialRetentionDays * 86_400_000).toISOString();
  const [result, totalResult] = await Promise.all([
    pool.query<StoredSignalRow>(`WITH qualifying AS (
      SELECT p.id, p.employer_id, e.name AS company_name, e.website AS company_website,
        p.platform, p.source_url, p.text, p.published_at, p.analysis,
        p.signal_category, p.signal_quality,
        row_number() OVER (PARTITION BY p.employer_id ORDER BY p.published_at DESC, p.id DESC) AS evidence_rank
      FROM company_social_posts p
      JOIN employers e ON e.id = p.employer_id
      JOIN company_social_links l ON l.id = p.social_link_id AND l.is_active
      WHERE p.published_at >= $1::timestamptz
        AND p.signal_qualifies = true
        AND p.analysis IS NOT NULL
    ), company_rollup AS (
      SELECT employer_id AS company_id,
        max(company_name) AS company_name,
        max(company_website) AS company_website,
        max(signal_quality)::int AS signal_quality,
        min(published_at) AS first_post_at,
        max(published_at) AS last_post_at,
        count(*)::int AS matching_post_count,
        array_agg(DISTINCT signal_category) AS categories
      FROM qualifying
      GROUP BY employer_id
    ), strongest AS (
      SELECT DISTINCT ON (employer_id) employer_id, analysis AS strongest_analysis
      FROM qualifying
      ORDER BY employer_id, signal_quality DESC, published_at DESC, id DESC
    ), paged AS (
      SELECT r.*, s.strongest_analysis
      FROM company_rollup r JOIN strongest s ON s.employer_id = r.company_id
      ORDER BY r.last_post_at DESC, r.company_name ASC, r.company_id ASC
      LIMIT $2 OFFSET $3
    )
    SELECT paged.company_id, paged.company_name, paged.company_website, paged.signal_quality,
      paged.first_post_at, paged.last_post_at, paged.matching_post_count, paged.categories,
      paged.strongest_analysis,
      jsonb_agg(jsonb_build_object(
        'id', q.id,
        'platform', q.platform,
        'sourceUrl', q.source_url,
        'text', q.text,
        'publishedAt', q.published_at,
        'analysis', q.analysis
      ) ORDER BY q.published_at DESC, q.id DESC) FILTER (WHERE q.evidence_rank <= 10) AS posts
    FROM paged JOIN qualifying q ON q.employer_id = paged.company_id
    GROUP BY paged.company_id, paged.company_name, paged.company_website, paged.signal_quality,
      paged.first_post_at, paged.last_post_at, paged.matching_post_count, paged.categories, paged.strongest_analysis
    ORDER BY paged.last_post_at DESC, paged.company_name ASC, paged.company_id ASC`, [cutoff, limit, offset]),
    pool.query<{ total: number }>(`SELECT count(DISTINCT p.employer_id)::int AS total
      FROM company_social_posts p
      JOIN company_social_links l ON l.id = p.social_link_id AND l.is_active
      WHERE p.published_at >= $1::timestamptz
        AND p.signal_qualifies = true
        AND p.analysis IS NOT NULL`, [cutoff])
  ]);

  const signals = result.rows.map((row) => ({
    company: { id: row.company_id, name: row.company_name, website: row.company_website },
    primaryCategory: row.strongest_analysis.category,
    categories: row.categories.filter((category): category is SignalCategory => qualifyingCategories.has(category as SignalCategory)),
    signalQuality: row.signal_quality,
    firstPostAt: new Date(row.first_post_at).toISOString(),
    lastPostAt: new Date(row.last_post_at).toISOString(),
    matchingPostCount: row.matching_post_count,
    posts: row.posts.map((post) => ({
      id: post.id,
      platform: post.platform,
      sourceUrl: post.sourceUrl,
      text: post.text,
      publishedAt: new Date(post.publishedAt).toISOString(),
      category: post.analysis.category,
      signalQuality: post.analysis.signalQuality,
      matchedRules: post.analysis.matchedRules.map((rule) => rule.name),
      classificationReasons: post.analysis.classificationReasons
    }))
  }));

  return {
    signals,
    total: totalResult.rows[0]?.total ?? 0,
    retentionDays: config.companySocialRetentionDays
  };
}

async function getCompanySocialSignalPage(limit: number, offset: number): Promise<CompanySocialSignalPage> {
  const key = `${limit}:${offset}`;
  const cached = signalCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let pagePromise = signalPagePromises.get(key);
  if (!pagePromise) {
    pagePromise = buildCompanySocialSignalPage(limit, offset)
      .then((value) => {
        signalCache.set(key, { value, expiresAt: Date.now() + signalCacheTtlMs });
        return value;
      })
      .finally(() => {
        signalPagePromises.delete(key);
      });
    signalPagePromises.set(key, pagePromise);
  }
  return pagePromise;
}

export async function getCompanySocialSignals(query: { limit?: string; offset?: string } = {}) {
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 25));
  const offset = Math.max(0, Number(query.offset) || 0);
  const page = await getCompanySocialSignalPage(limit, offset);
  return { signals: page.signals, total: page.total, limit, offset, retentionDays: page.retentionDays };
}
