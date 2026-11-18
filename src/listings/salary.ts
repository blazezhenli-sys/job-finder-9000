import { compensationForAts, normalizeCompensation } from './ats.js';
import { pool } from '../db.js';
import type { AtsProvider } from '../types.js';

type SalaryRow = {
  id: string;
  provider: AtsProvider;
  raw: unknown;
  description: string;
  compensation: unknown;
};

function mergedCompensation(existing: unknown, detected: ReturnType<typeof normalizeCompensation>) {
  const current = normalizeCompensation(existing);
  return {
    min: detected.min ?? current.min,
    max: detected.max ?? current.max,
    currency: detected.currency ?? current.currency,
    period: detected.period ?? current.period,
    estimated: detected.estimated ?? current.estimated ?? false,
    description: detected.description ?? current.description
  };
}

export async function backfillListingCompensation() {
  let processed = 0;
  let enriched = 0;
  while (true) {
    const result = await pool.query<SalaryRow>(`SELECT id, provider, raw, description, compensation
      FROM job_listings
      WHERE salary_backfilled_at IS NULL
      ORDER BY id
      LIMIT 500`);
    if (!result.rows.length) break;
    const updates = result.rows.map((row) => {
      const detected = compensationForAts(row.provider, row.raw, row.description);
      const compensation = mergedCompensation(row.compensation, detected);
      if (detected.min !== undefined || detected.max !== undefined || detected.description) enriched += 1;
      return {
        id: row.id,
        compensation,
        compensation_min: compensation.min ?? null,
        compensation_max: compensation.max ?? null,
        compensation_currency: compensation.currency ?? '',
        compensation_period: compensation.period ?? '',
        compensation_estimated: Boolean(compensation.estimated)
      };
    });
    await pool.query(`UPDATE job_listings AS listing
      SET compensation=updates.compensation,
          compensation_min=updates.compensation_min,
          compensation_max=updates.compensation_max,
          compensation_currency=updates.compensation_currency,
          compensation_period=updates.compensation_period,
          compensation_estimated=updates.compensation_estimated,
          salary_backfilled_at=now(),
          updated_at=now()
      FROM jsonb_to_recordset($1::jsonb) AS updates(
        id uuid,
        compensation jsonb,
        compensation_min numeric,
        compensation_max numeric,
        compensation_currency text,
        compensation_period text,
        compensation_estimated boolean
      )
      WHERE listing.id=updates.id`, [JSON.stringify(updates)]);
    processed += result.rows.length;
    if (processed % 5_000 === 0) console.info(`Salary backfill: ${processed} listings processed, ${enriched} with salary data`);
  }
  console.info(`Salary backfill complete: ${processed} listings processed, ${enriched} with salary data`);
}
