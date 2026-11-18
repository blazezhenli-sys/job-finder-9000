import { pool, withTransaction } from '../db.js';
export { engineeringSpecialtyLabels, classifyEngineeringSpecialties, extractListingTechnologies } from './classification.js';
import { classifyEngineeringSpecialties, extractListingTechnologies } from './classification.js';
import { listingLocationSignals } from './pipeline.js';

export function isEngineeringListing(specialties: string[]): boolean { return specialties.length > 0; }

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

export async function backfillListingLocationSignals() {
  const marker = await pool.query(`SELECT 1 FROM app_settings WHERE key='listing_location_signals_backfill_v2'`);
  if (marker.rows[0]) return;
  const progressResult = await pool.query<{ value: { lastId?: string; processed?: number } }>(`SELECT value FROM app_settings WHERE key='listing_location_signals_backfill_v2_progress'`);
  let processed = Number(progressResult.rows[0]?.value?.processed || 0);
  let lastId: string | null = progressResult.rows[0]?.value?.lastId || null;
  const batchSize = 250;
  while (true) {
    type LocationBackfillRow = { id: string; location: string; secondary_locations: string[]; geographic_restrictions: string[]; remote_mode: string; description: string };
    let batch: { count: number; lastId: string } | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        batch = await withTransaction(async (client) => {
          const locationRows = await client.query<LocationBackfillRow>(`SELECT id, location, secondary_locations, geographic_restrictions, remote_mode, description
            FROM job_listings WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT ${batchSize} FOR UPDATE`, [lastId]);
          if (!locationRows.rows.length) return null;
          const updates = locationRows.rows.map((row) => ({
            id: row.id,
            location_signals: listingLocationSignals({
              location: row.location,
              secondaryLocations: row.secondary_locations ?? [],
              geographicRestrictions: row.geographic_restrictions ?? [],
              remoteMode: row.remote_mode as 'remote' | 'hybrid' | 'onsite' | 'unknown',
              description: row.description ?? ''
            })
          }));
          await client.query(`UPDATE job_listings AS listing
            SET location_signals=updates.location_signals, updated_at=now()
            FROM jsonb_to_recordset($1::jsonb) AS updates(id uuid, location_signals jsonb)
            WHERE listing.id=updates.id`, [JSON.stringify(updates)]);
          return { count: locationRows.rows.length, lastId: locationRows.rows.at(-1)!.id };
        });
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== '40P01' || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    if (!batch) break;
    processed += batch.count;
    lastId = batch.lastId;
    await pool.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('listing_location_signals_backfill_v2_progress', $1, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`, [JSON.stringify({ lastId, processed })]);
    if (processed % 5_000 === 0) console.info(`Listing location backfill: ${processed} listings processed`);
  }
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('listing_location_signals_backfill_v2', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify({ completed: true, processed })]);
  console.info(`Listing location backfill complete: ${processed} listings processed`);
}
