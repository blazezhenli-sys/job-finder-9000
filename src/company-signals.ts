import { config } from './config.js';
import { getPreferences, getRules, pool } from './db.js';
import { analyzeCompanySocialPost } from './pipeline.js';
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
    const analysis = analyzeCompanySocialPost(row.text, rules, preferences);
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

type CompanySocialSignalSnapshot = {
  signals: CompanySocialSignal[];
  retentionDays: number;
};

const signalCacheTtlMs = 5_000;
let signalCache: { expiresAt: number; value: CompanySocialSignalSnapshot } | undefined;
let signalSnapshotPromise: Promise<CompanySocialSignalSnapshot> | undefined;

async function buildCompanySocialSignalSnapshot(): Promise<CompanySocialSignalSnapshot> {
  const [rules, preferences] = await Promise.all([getRules(), getPreferences()]);
  const cutoff = new Date(Date.now() - config.companySocialRetentionDays * 86_400_000).toISOString();
  const result = await pool.query<CompanySocialPostInput>(`SELECT p.id, p.employer_id, e.name AS employer_name, e.website AS employer_website,
      p.platform, p.source_url, p.text, p.published_at
    FROM company_social_posts p
    JOIN employers e ON e.id = p.employer_id
    JOIN company_social_links l ON l.id = p.social_link_id AND l.is_active
    WHERE p.published_at >= $1::timestamptz`, [cutoff]);

  return {
    signals: coalesceCompanySocialPosts(result.rows, rules, preferences),
    retentionDays: config.companySocialRetentionDays
  };
}

async function getCompanySocialSignalSnapshot(): Promise<CompanySocialSignalSnapshot> {
  if (signalCache && signalCache.expiresAt > Date.now()) return signalCache.value;
  if (!signalSnapshotPromise) {
    signalSnapshotPromise = buildCompanySocialSignalSnapshot()
      .then((value) => {
        signalCache = { value, expiresAt: Date.now() + signalCacheTtlMs };
        return value;
      })
      .finally(() => {
        signalSnapshotPromise = undefined;
      });
  }
  return signalSnapshotPromise;
}

export async function getCompanySocialSignals(query: { limit?: string; offset?: string } = {}) {
  const snapshot = await getCompanySocialSignalSnapshot();
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 25));
  const offset = Math.max(0, Number(query.offset) || 0);
  return { signals: snapshot.signals.slice(offset, offset + limit), total: snapshot.signals.length, limit, offset, retentionDays: snapshot.retentionDays };
}
