import { config } from './config.js';
import { getPreferences, getRules, pool } from './db.js';
import { analyzeCompanySocialPost } from './pipeline.js';
import type { Analysis, DetectionRule, Preferences, SignalCategory } from './types.js';

const qualifyingCategories = new Set<SignalCategory>(['direct_hiring', 'service_request', 'employee_referral', 'firsthand_announcement']);

export function companySocialAnalysisQualifies(analysis: Analysis): boolean {
  return analysis.matchedRules.some((rule) => !rule.negative) && !analysis.blocked && !analysis.suppressed && qualifyingCategories.has(analysis.category);
}

export function scoreCompanySocialPost(text: string, rules: DetectionRule[], preferences: Preferences): { analysis: Analysis; signalCategory: SignalCategory; signalQuality: number; qualifies: boolean } {
  const analysis = analyzeCompanySocialPost(text, rules, preferences);
  return { analysis, signalCategory: analysis.category, signalQuality: analysis.signalQuality, qualifies: companySocialAnalysisQualifies(analysis) };
}

let backfillPromise: Promise<number> | undefined;

/** Scores only rows that have never been scored. Existing scores remain stable even if rules change. */
export function scoreUnanalyzedCompanySocialPosts(batchSize = 500): Promise<number> {
  if (backfillPromise) return backfillPromise;
  backfillPromise = (async () => {
    const [rules, preferences] = await Promise.all([getRules(), getPreferences()]);
    let scored = 0;
    while (true) {
      const pending = await pool.query<{ id: string; text: string }>(`SELECT id, text
        FROM company_social_posts
        WHERE analysis IS NULL
          AND published_at >= now() - ($1::text || ' days')::interval
        ORDER BY published_at ASC, id ASC
        LIMIT $2`, [config.companySocialRetentionDays, batchSize]);
      if (!pending.rows.length) break;
      const scoredRows = pending.rows.map((row) => {
        const result = scoreCompanySocialPost(row.text, rules, preferences);
        return { id: row.id, analysis: result.analysis, signalCategory: result.signalCategory, signalQuality: result.signalQuality, qualifies: result.qualifies };
      });
      const updated = await pool.query(`UPDATE company_social_posts AS p
        SET analysis=s.analysis, analyzed_at=now(), signal_category=s.signal_category,
          signal_quality=s.signal_quality, signal_qualifies=s.signal_qualifies
        FROM jsonb_to_recordset($1::jsonb) AS s(
          id uuid, analysis jsonb, signal_category text, signal_quality integer, signal_qualifies boolean
        )
        WHERE p.id=s.id AND p.analysis IS NULL`, [JSON.stringify(scoredRows.map((row) => ({
        id: row.id,
        analysis: row.analysis,
        signal_category: row.signalCategory,
        signal_quality: row.signalQuality,
        signal_qualifies: row.qualifies
      })))]);
      const batchScored = updated.rowCount ?? 0;
      scored += batchScored;
      if (!batchScored) break;
    }
    return scored;
  })().finally(() => {
    backfillPromise = undefined;
  });
  return backfillPromise;
}
