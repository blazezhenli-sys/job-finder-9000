import { pool, withTransaction } from '../db.js';

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function runDailyMarketSnapshot(snapshotDate = isoDate(new Date())) {
  await withTransaction(async (client) => {
    const coverage = await client.query(`WITH stable_boards AS (
        SELECT b.id, b.employer_id
        FROM job_boards b JOIN listing_board_observations o ON o.board_id=b.id
        WHERE b.status='active' AND o.observed_at >= ($1::date - interval '27 days') AND o.observed_at < ($1::date + interval '1 day')
        GROUP BY b.id, b.employer_id
        HAVING count(DISTINCT o.observed_at::date) >= 25
      )
      SELECT (SELECT count(*)::int FROM job_boards WHERE status='active') AS monitored_boards,
        (SELECT count(*)::int FROM stable_boards) AS stable_boards,
        (SELECT count(DISTINCT employer_id)::int FROM job_boards WHERE status='active') AS monitored_employers,
        (SELECT count(DISTINCT employer_id)::int FROM stable_boards) AS stable_employers,
        (SELECT count(*)::int FROM job_boards WHERE first_discovered_at::date=$1::date) AS newly_discovered_boards,
        (SELECT count(DISTINCT o.observed_at::date)::int FROM listing_board_observations o JOIN stable_boards s ON s.id=o.board_id WHERE o.observed_at >= ($1::date - interval '27 days') AND o.observed_at < ($1::date + interval '1 day')) AS coverage_days`, [snapshotDate]);
    await client.query(`INSERT INTO market_snapshot_runs (snapshot_date, generated_at, monitored_boards, stable_boards, monitored_employers, stable_employers, newly_discovered_boards, coverage_days, coverage_note)
      VALUES ($1, now(), $2, $3, $4, $5, $6, $7, 'stable_28d requires at least 25 successful observation days in the preceding 28-day window; initial imports are not counted as new activity')
      ON CONFLICT (snapshot_date) DO UPDATE SET generated_at=EXCLUDED.generated_at, monitored_boards=EXCLUDED.monitored_boards, stable_boards=EXCLUDED.stable_boards, monitored_employers=EXCLUDED.monitored_employers, stable_employers=EXCLUDED.stable_employers, newly_discovered_boards=EXCLUDED.newly_discovered_boards, coverage_days=EXCLUDED.coverage_days, coverage_note=EXCLUDED.coverage_note`, [snapshotDate, coverage.rows[0].monitored_boards, coverage.rows[0].stable_boards, coverage.rows[0].monitored_employers, coverage.rows[0].stable_employers, coverage.rows[0].newly_discovered_boards, coverage.rows[0].coverage_days]);

    await client.query(`WITH listing_counts AS (
        SELECT b.employer_id,
          count(*) FILTER (WHERE l.is_active)::int AS active_listings,
          count(*) FILTER (WHERE l.is_active AND jsonb_array_length(COALESCE(l.engineering_specialties,'[]'::jsonb)) > 0)::int AS active_engineering,
          count(*) FILTER (WHERE l.is_active AND l.first_observed_at::date=$1 AND l.first_observed_at > b.initialized_at)::int AS new_listings,
          count(*) FILTER (WHERE l.is_active AND l.remote_mode='remote')::int AS remote_listings,
          count(*) FILTER (WHERE l.is_active AND (l.employment_type ILIKE '%contract%' OR l.employment_type ILIKE '%freelance%'))::int AS contract_listings
        FROM job_boards b LEFT JOIN job_listings l ON l.board_id=b.id
        GROUP BY b.employer_id
      ), event_counts AS (
        SELECT b.employer_id, count(*) FILTER (WHERE ev.event_type='removed')::int AS removed_listings
        FROM job_boards b LEFT JOIN listing_events ev ON ev.board_id=b.id AND ev.observed_at::date=$1
        GROUP BY b.employer_id
      ), board_counts AS (
        SELECT b.employer_id, count(*) FILTER (WHERE b.status='active')::int AS monitored_boards,
          count(*) FILTER (WHERE b.status='active' AND EXISTS (SELECT 1 FROM listing_board_observations o WHERE o.board_id=b.id AND o.observed_at::date=$1))::int AS successful_boards
        FROM job_boards b GROUP BY b.employer_id
      ), specialty_counts AS (
        SELECT employer_id, jsonb_object_agg(value, listing_count) AS counts FROM (
          SELECT b.employer_id, specialties.value, count(*)::int AS listing_count
          FROM job_boards b JOIN job_listings l ON l.board_id=b.id
            CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(l.engineering_specialties,'[]'::jsonb)) AS specialties(value)
          WHERE l.is_active GROUP BY b.employer_id, specialties.value
        ) grouped GROUP BY employer_id
      ), technology_counts AS (
        SELECT employer_id, jsonb_object_agg(value, listing_count) AS counts FROM (
          SELECT b.employer_id, technologies.value, count(*)::int AS listing_count
          FROM job_boards b JOIN job_listings l ON l.board_id=b.id
            CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(l.technologies,'[]'::jsonb)) AS technologies(value)
          WHERE l.is_active GROUP BY b.employer_id, technologies.value
        ) grouped GROUP BY employer_id
      ), employment_type_counts AS (
        SELECT employer_id, jsonb_object_agg(value, listing_count) AS counts FROM (
          SELECT b.employer_id, COALESCE(NULLIF(l.employment_type,''),'unknown') AS value, count(*)::int AS listing_count
          FROM job_boards b JOIN job_listings l ON l.board_id=b.id
          WHERE l.is_active GROUP BY b.employer_id, COALESCE(NULLIF(l.employment_type,''),'unknown')
        ) grouped GROUP BY employer_id
      ), work_mode_counts AS (
        SELECT employer_id, jsonb_object_agg(value, listing_count) AS counts FROM (
          SELECT b.employer_id, l.remote_mode AS value, count(*)::int AS listing_count
          FROM job_boards b JOIN job_listings l ON l.board_id=b.id
          WHERE l.is_active GROUP BY b.employer_id, l.remote_mode
        ) grouped GROUP BY employer_id
      )
      INSERT INTO company_daily_metrics (snapshot_date, employer_id, active_listings, active_engineering, new_listings, removed_listings, remote_listings, contract_listings, monitored_boards, successful_boards, specialty_counts, technology_counts, employment_type_counts, work_mode_counts)
      SELECT $1, e.id, COALESCE(lc.active_listings,0), COALESCE(lc.active_engineering,0), COALESCE(lc.new_listings,0), COALESCE(ec.removed_listings,0), COALESCE(lc.remote_listings,0), COALESCE(lc.contract_listings,0), COALESCE(bc.monitored_boards,0), COALESCE(bc.successful_boards,0), COALESCE(sc.counts,'{}'::jsonb), COALESCE(tc.counts,'{}'::jsonb), COALESCE(etc.counts,'{}'::jsonb), COALESCE(wmc.counts,'{}'::jsonb)
      FROM employers e LEFT JOIN listing_counts lc ON lc.employer_id=e.id LEFT JOIN event_counts ec ON ec.employer_id=e.id LEFT JOIN board_counts bc ON bc.employer_id=e.id LEFT JOIN specialty_counts sc ON sc.employer_id=e.id LEFT JOIN technology_counts tc ON tc.employer_id=e.id LEFT JOIN employment_type_counts etc ON etc.employer_id=e.id LEFT JOIN work_mode_counts wmc ON wmc.employer_id=e.id
      ON CONFLICT (snapshot_date, employer_id) DO UPDATE SET active_listings=EXCLUDED.active_listings, active_engineering=EXCLUDED.active_engineering, new_listings=EXCLUDED.new_listings, removed_listings=EXCLUDED.removed_listings, remote_listings=EXCLUDED.remote_listings, contract_listings=EXCLUDED.contract_listings, monitored_boards=EXCLUDED.monitored_boards, successful_boards=EXCLUDED.successful_boards, specialty_counts=EXCLUDED.specialty_counts, technology_counts=EXCLUDED.technology_counts, employment_type_counts=EXCLUDED.employment_type_counts, work_mode_counts=EXCLUDED.work_mode_counts`, [snapshotDate]);

    for (const cohort of ['all', 'stable_28d']) {
      await client.query('DELETE FROM market_daily_metrics WHERE snapshot_date=$1 AND cohort=$2', [snapshotDate, cohort]);
      const cohortFilter = cohort === 'all' ? '' : `AND l.board_id IN (
        SELECT o.board_id FROM listing_board_observations o
        WHERE o.observed_at >= ($1::date - interval '27 days') AND o.observed_at < ($1::date + interval '1 day')
        GROUP BY o.board_id HAVING count(DISTINCT o.observed_at::date) >= 25
      )`;
      await client.query(`WITH base AS (
          SELECT l.*, b.employer_id, (l.first_observed_at::date=$1 AND l.first_observed_at > b.initialized_at) AS is_new
          FROM job_listings l JOIN job_boards b ON b.id=l.board_id
          WHERE l.is_active ${cohortFilter}
        ), dimensions AS (
          SELECT 'category' AS dimension, COALESCE(NULLIF(job_category,''),'unknown') AS dimension_value, employer_id, is_new, remote_mode='remote' AS is_remote, (employment_type ILIKE '%contract%' OR employment_type ILIKE '%freelance%') AS is_contract FROM base
          UNION ALL SELECT 'work_mode', remote_mode, employer_id, is_new, remote_mode='remote', (employment_type ILIKE '%contract%' OR employment_type ILIKE '%freelance%') FROM base
          UNION ALL SELECT 'employment_type', COALESCE(NULLIF(employment_type,''),'unknown'), employer_id, is_new, remote_mode='remote', (employment_type ILIKE '%contract%' OR employment_type ILIKE '%freelance%') FROM base
          UNION ALL SELECT 'specialty', facet.value, employer_id, is_new, remote_mode='remote', (employment_type ILIKE '%contract%' OR employment_type ILIKE '%freelance%') FROM base CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(engineering_specialties,'[]'::jsonb)) AS facet(value)
          UNION ALL SELECT 'technology', facet.value, employer_id, is_new, remote_mode='remote', (employment_type ILIKE '%contract%' OR employment_type ILIKE '%freelance%') FROM base CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(technologies,'[]'::jsonb)) AS facet(value)
          UNION ALL SELECT 'region', COALESCE(facet.value,'unknown'), employer_id, is_new, remote_mode='remote', (employment_type ILIKE '%contract%' OR employment_type ILIKE '%freelance%') FROM base LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(location_signals->'regions','[]'::jsonb)) AS facet(value) ON TRUE
          UNION ALL SELECT 'country', COALESCE(facet.value,'unknown'), employer_id, is_new, remote_mode='remote', (employment_type ILIKE '%contract%' OR employment_type ILIKE '%freelance%') FROM base LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(location_signals->'countries','[]'::jsonb)) AS facet(value) ON TRUE
        )
        INSERT INTO market_daily_metrics (snapshot_date, cohort, dimension, dimension_value, active_listings, employers, new_listings, removed_listings, remote_listings, contract_listings)
        SELECT $1, $2, dimension, dimension_value, count(*)::int, count(DISTINCT employer_id)::int, count(*) FILTER (WHERE is_new)::int, 0, count(*) FILTER (WHERE is_remote)::int, count(*) FILTER (WHERE is_contract)::int
        FROM dimensions GROUP BY dimension, dimension_value
        ON CONFLICT (snapshot_date, cohort, dimension, dimension_value) DO UPDATE SET active_listings=EXCLUDED.active_listings, employers=EXCLUDED.employers, new_listings=EXCLUDED.new_listings, removed_listings=EXCLUDED.removed_listings, remote_listings=EXCLUDED.remote_listings, contract_listings=EXCLUDED.contract_listings`, [snapshotDate, cohort]);
      await client.query(`WITH base AS (
          SELECT l.*, b.employer_id, (l.first_observed_at::date=$1 AND l.first_observed_at > b.initialized_at) AS is_new
          FROM job_listings l JOIN job_boards b ON b.id=l.board_id
          WHERE l.is_active ${cohortFilter}
        ), removed AS (
          SELECT count(*)::int AS removed_listings FROM listing_events ev JOIN job_boards b ON b.id=ev.board_id
          WHERE ev.event_type='removed' AND ev.observed_at::date=$1 ${cohort === 'all' ? '' : `AND ev.board_id IN (SELECT o.board_id FROM listing_board_observations o WHERE o.observed_at >= ($1::date - interval '27 days') AND o.observed_at < ($1::date + interval '1 day') GROUP BY o.board_id HAVING count(DISTINCT o.observed_at::date) >= 25)`}
        )
        INSERT INTO market_daily_metrics (snapshot_date, cohort, dimension, dimension_value, active_listings, employers, new_listings, removed_listings, remote_listings, contract_listings)
        SELECT $1, $2, 'all', 'all', count(*)::int, count(DISTINCT employer_id)::int, count(*) FILTER (WHERE is_new)::int, (SELECT removed_listings FROM removed), count(*) FILTER (WHERE remote_mode='remote')::int, count(*) FILTER (WHERE employment_type ILIKE '%contract%' OR employment_type ILIKE '%freelance%')::int FROM base
        ON CONFLICT (snapshot_date, cohort, dimension, dimension_value) DO UPDATE SET active_listings=EXCLUDED.active_listings, employers=EXCLUDED.employers, new_listings=EXCLUDED.new_listings, removed_listings=EXCLUDED.removed_listings, remote_listings=EXCLUDED.remote_listings, contract_listings=EXCLUDED.contract_listings`, [snapshotDate, cohort]);
      await client.query(`WITH removed_base AS (
          SELECT ev.current_value, b.id AS board_id
          FROM listing_events ev JOIN job_boards b ON b.id=ev.board_id
          WHERE ev.event_type='removed' AND ev.observed_at::date=$1 ${cohort === 'all' ? '' : `AND ev.board_id IN (SELECT o.board_id FROM listing_board_observations o WHERE o.observed_at >= ($1::date - interval '27 days') AND o.observed_at < ($1::date + interval '1 day') GROUP BY o.board_id HAVING count(DISTINCT o.observed_at::date) >= 25)`}
        ), removed_dimensions AS (
          SELECT 'category' AS dimension, COALESCE(NULLIF(current_value->>'jobCategory',''),'unknown') AS dimension_value FROM removed_base
          UNION ALL SELECT 'work_mode', COALESCE(NULLIF(current_value->>'remoteMode',''),'unknown') FROM removed_base
          UNION ALL SELECT 'employment_type', COALESCE(NULLIF(current_value->>'employmentType',''),'unknown') FROM removed_base
          UNION ALL SELECT 'specialty', facet.value FROM removed_base CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(current_value->'specialties','[]'::jsonb)) AS facet(value)
          UNION ALL SELECT 'technology', facet.value FROM removed_base CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(current_value->'technologies','[]'::jsonb)) AS facet(value)
          UNION ALL SELECT 'region', COALESCE(facet.value,'unknown') FROM removed_base LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(current_value->'locationSignals'->'regions','[]'::jsonb)) AS facet(value) ON TRUE
          UNION ALL SELECT 'country', COALESCE(facet.value,'unknown') FROM removed_base LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(current_value->'locationSignals'->'countries','[]'::jsonb)) AS facet(value) ON TRUE
        ), counts AS (
          SELECT dimension, dimension_value, count(*)::int AS removed_listings FROM removed_dimensions GROUP BY dimension, dimension_value
        )
        UPDATE market_daily_metrics metrics SET removed_listings=counts.removed_listings FROM counts
        WHERE metrics.snapshot_date=$1 AND metrics.cohort=$2 AND metrics.dimension=counts.dimension AND metrics.dimension_value=counts.dimension_value`, [snapshotDate, cohort]);
    }
  });
  console.info(`Market snapshot complete: ${snapshotDate}`);
}

export async function getMarketTrends(from: string, to: string, cohort = 'all', dimension = 'category', granularity = 'day') {
  const safeCohort = ['all', 'stable_28d'].includes(cohort) ? cohort : 'all';
  const safeDimension = ['category', 'specialty', 'technology', 'region', 'country', 'work_mode', 'employment_type', 'all'].includes(dimension) ? dimension : 'category';
  const safeGranularity = ['day', 'week', 'month'].includes(granularity) ? granularity : 'day';
  const [metrics, runs] = await Promise.all([
    pool.query(`WITH grouped AS (
        SELECT date_trunc($5, snapshot_date::timestamp)::date AS period, dimension_value,
          (array_agg(active_listings ORDER BY snapshot_date DESC))[1]::int AS active_listings,
          (array_agg(employers ORDER BY snapshot_date DESC))[1]::int AS employers,
          sum(new_listings)::int AS new_listings, sum(removed_listings)::int AS removed_listings,
          (array_agg(remote_listings ORDER BY snapshot_date DESC))[1]::int AS remote_listings,
          (array_agg(contract_listings ORDER BY snapshot_date DESC))[1]::int AS contract_listings
        FROM market_daily_metrics
        WHERE snapshot_date BETWEEN $1::date AND $2::date AND cohort=$3 AND dimension=$4
        GROUP BY date_trunc($5, snapshot_date::timestamp)::date, dimension_value
      ), totals AS (
        SELECT grouped.*, sum(active_listings) OVER (PARTITION BY period) AS period_active,
          sum(new_listings) OVER (PARTITION BY period) AS period_new
        FROM grouped
      )
      SELECT period AS snapshot_date, dimension_value, active_listings, employers, new_listings, removed_listings, remote_listings, contract_listings,
        CASE WHEN period_active > 0 THEN round(active_listings::numeric / period_active, 6) ELSE 0 END AS active_share,
        CASE WHEN period_new > 0 THEN round(new_listings::numeric / period_new, 6) ELSE 0 END AS new_share,
        CASE WHEN employers > 0 THEN round(active_listings::numeric / employers, 3) ELSE 0 END AS active_per_employer,
        CASE WHEN employers > 0 THEN round(new_listings::numeric / employers, 3) ELSE 0 END AS new_per_employer,
        CASE WHEN active_listings > 0 THEN round(remote_listings::numeric / active_listings, 6) ELSE 0 END AS remote_share,
        CASE WHEN active_listings > 0 THEN round(contract_listings::numeric / active_listings, 6) ELSE 0 END AS contract_share
      FROM totals ORDER BY period, active_listings DESC`, [from, to, safeCohort, safeDimension, safeGranularity]),
    pool.query(`SELECT * FROM market_snapshot_runs WHERE snapshot_date BETWEEN $1::date AND $2::date ORDER BY snapshot_date`, [from, to])
  ]);
  return { from, to, cohort: safeCohort, dimension: safeDimension, granularity: safeGranularity, metrics: metrics.rows, coverage: runs.rows };
}

function shiftDate(value: string, days: number): string {
  const date = new Date(value + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function periodDays(from: string, to: string): number {
  return Math.max(1, Math.round((new Date(to + 'T00:00:00Z').getTime() - new Date(from + 'T00:00:00Z').getTime()) / 86400000) + 1);
}

function latestMetric(metrics: any[]) {
  return metrics.reduce((latest, row) => !latest || String(row.snapshot_date) > String(latest.snapshot_date) ? row : latest, undefined);
}

export function marketDashboardPeriods(from: string, to: string) {
  const previousTo = shiftDate(from, -1);
  return { previousFrom: shiftDate(previousTo, -(periodDays(from, to) - 1)), previousTo };
}

export function marketDashboardRankings(currentMetrics: any[], previousMetrics: any[]) {
  const currentDate = currentMetrics.reduce((latest: string | undefined, row: any) => !latest || String(row.snapshot_date) > latest ? String(row.snapshot_date) : latest, undefined);
  const previousDate = previousMetrics.reduce((latest: string | undefined, row: any) => !latest || String(row.snapshot_date) > latest ? String(row.snapshot_date) : latest, undefined);
  const previousByValue = new Map(previousDate ? previousMetrics.filter((row: any) => String(row.snapshot_date) === previousDate).map((row: any) => [row.dimension_value, row]) : []);
  return (currentDate ? currentMetrics.filter((row: any) => String(row.snapshot_date) === currentDate) : [])
    .map((row: any) => {
      const prior = previousByValue.get(row.dimension_value);
      return {
        dimension_value: row.dimension_value,
        active_listings: Number(row.active_listings || 0),
        employers: Number(row.employers || 0),
        new_listings: Number(row.new_listings || 0),
        removed_listings: Number(row.removed_listings || 0),
        active_share: Number(row.active_share || 0),
        new_share: Number(row.new_share || 0),
        share_delta: Math.round((Number(row.active_share || 0) - Number(prior?.active_share || 0)) * 1000000) / 1000000,
        active_delta: Number(row.active_listings || 0) - Number(prior?.active_listings || 0),
        prior_active_listings: Number(prior?.active_listings || 0)
      };
    })
    .sort((a, b) => b.active_listings - a.active_listings || a.dimension_value.localeCompare(b.dimension_value));
}

export async function getMarketDashboard(from: string, to: string, cohort = 'stable_28d', dimension = 'category', granularity = 'week') {
  const safeCohort = ['all', 'stable_28d'].includes(cohort) ? cohort : 'stable_28d';
  const safeDimension = ['category', 'specialty', 'technology', 'region', 'country'].includes(dimension) ? dimension : 'category';
  const safeGranularity = ['day', 'week', 'month'].includes(granularity) ? granularity : 'week';
  const { previousFrom, previousTo } = marketDashboardPeriods(from, to);
  const [current, previous, totalCurrent, totalPrevious, signals] = await Promise.all([
    getMarketTrends(from, to, safeCohort, safeDimension, safeGranularity),
    getMarketTrends(previousFrom, previousTo, safeCohort, safeDimension, safeGranularity),
    getMarketTrends(from, to, safeCohort, 'all', safeGranularity),
    getMarketTrends(previousFrom, previousTo, safeCohort, 'all', safeGranularity),
    pool.query('SELECT s.*, e.name AS employer_name FROM market_signals s LEFT JOIN employers e ON e.id=s.employer_id WHERE s.status=\'active\' ORDER BY s.last_seen_at DESC LIMIT 12')
  ]);
  const rankings = marketDashboardRankings(current.metrics, previous.metrics);
  const currentTotal = latestMetric(totalCurrent.metrics);
  const previousTotal = latestMetric(totalPrevious.metrics);
  const currentCoverage = current.coverage.at(-1) ?? null;
  const previousCoverage = previous.coverage.at(-1) ?? null;
  return {
    from,
    to,
    previousFrom,
    previousTo,
    cohort: safeCohort,
    dimension: safeDimension,
    granularity: safeGranularity,
    summary: {
      active_listings: Number(currentTotal?.active_listings || 0),
      new_listings: Number(currentTotal?.new_listings || 0),
      removed_listings: Number(currentTotal?.removed_listings || 0),
      employers: Number(currentTotal?.employers || 0),
      remote_listings: Number(currentTotal?.remote_listings || 0),
      contract_listings: Number(currentTotal?.contract_listings || 0),
      remote_share: Number(currentTotal?.remote_share || 0),
      contract_share: Number(currentTotal?.contract_share || 0),
      prior_active_listings: Number(previousTotal?.active_listings || 0),
      prior_new_listings: Number(previousTotal?.new_listings || 0),
      active_delta: Number(currentTotal?.active_listings || 0) - Number(previousTotal?.active_listings || 0)
    },
    coverage: {
      current: currentCoverage,
      previous: previousCoverage,
      snapshots: current.coverage.length,
      monitored_boards: Number(currentCoverage?.monitored_boards || 0),
      stable_boards: Number(currentCoverage?.stable_boards || 0),
      monitored_employers: Number(currentCoverage?.monitored_employers || 0),
      stable_employers: Number(currentCoverage?.stable_employers || 0),
      newly_discovered_boards: Number(currentCoverage?.newly_discovered_boards || 0),
      coverage_note: currentCoverage?.coverage_note || 'Snapshots begin after deployment.'
    },
    series: current.metrics,
    total_series: totalCurrent.metrics,
    rankings,
    signals: signals.rows
  };
}

export async function detectMarketSignals(snapshotDate = isoDate(new Date())) {
  await pool.query(`UPDATE market_signals SET status='resolved' WHERE status='active' AND last_seen_at < now() - interval '2 hours'`);
  const candidates = await pool.query(`WITH stats AS (
      SELECT employer_id,
        sum(new_listings) FILTER (WHERE snapshot_date >= ($1::date - interval '6 days'))::int AS recent_new,
        sum(new_listings) FILTER (WHERE snapshot_date >= ($1::date - interval '55 days') AND snapshot_date < ($1::date - interval '6 days'))::int AS baseline_new,
        count(*) FILTER (WHERE snapshot_date >= ($1::date - interval '55 days') AND snapshot_date < ($1::date - interval '6 days') AND successful_boards > 0)::int AS baseline_days,
        count(DISTINCT snapshot_date) FILTER (WHERE snapshot_date >= ($1::date - interval '6 days'))::int AS recent_days
      FROM company_daily_metrics
      WHERE snapshot_date >= ($1::date - interval '55 days') AND snapshot_date <= $1::date
      GROUP BY employer_id
    )
    SELECT stats.*, e.name AS employer_name,
      COALESCE((SELECT jsonb_agg(l.id) FROM job_listings l JOIN job_boards b ON b.id=l.board_id WHERE b.employer_id=stats.employer_id AND l.is_active AND l.first_observed_at >= ($1::date - interval '6 days') AND l.first_observed_at <= ($1::date + interval '1 day') AND jsonb_array_length(COALESCE(l.engineering_specialties,'[]'::jsonb)) > 0), '[]'::jsonb) AS supporting_listing_ids
    FROM stats JOIN employers e ON e.id=stats.employer_id
    WHERE recent_new >= 3 AND baseline_days >= 28 AND recent_days >= 5
      AND recent_new >= GREATEST(3, ((baseline_new::numeric / 7) * 3))`, [snapshotDate]);
  for (const row of candidates.rows) {
    const baselineWeekly = Number(row.baseline_new) / 7;
    const signalKey = `company:${row.employer_id}:hiring_surge`;
    await pool.query(`INSERT INTO market_signals (signal_key, scope, employer_id, signal_type, dimension, period_start, period_end, baseline_value, observed_value, change_ratio, sample_size, explanation, data_quality, supporting_listing_ids)
      VALUES ($1,'company',$2,'hiring_surge','engineering',$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (signal_key) DO UPDATE SET period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, baseline_value=EXCLUDED.baseline_value, observed_value=EXCLUDED.observed_value, change_ratio=EXCLUDED.change_ratio, sample_size=EXCLUDED.sample_size, explanation=EXCLUDED.explanation, data_quality=EXCLUDED.data_quality, supporting_listing_ids=EXCLUDED.supporting_listing_ids, last_seen_at=now(), status='active'`, [signalKey, row.employer_id, new Date(new Date(snapshotDate).getTime() - 6 * 86400000).toISOString().slice(0, 10), snapshotDate, baselineWeekly, row.recent_new, baselineWeekly ? Number(row.recent_new) / baselineWeekly : null, Number(row.baseline_days), `${row.employer_name} observed ${row.recent_new} new engineering openings in the last 7 days versus a baseline of ${baselineWeekly.toFixed(1)} per week.`, 'Requires at least 28 successful baseline observation days.', JSON.stringify(row.supporting_listing_ids ?? [])]);
  }

  const specialtySurges = await pool.query(`WITH observed AS (
      SELECT b.employer_id, specialties.value AS specialty, l.id, l.first_observed_at::date AS observed_date
      FROM job_listings l JOIN job_boards b ON b.id=l.board_id
        CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(l.engineering_specialties,'[]'::jsonb)) AS specialties(value)
      WHERE l.first_observed_at > COALESCE(b.initialized_at, '-infinity'::timestamptz)
    ), stats AS (
      SELECT employer_id, specialty,
        count(*) FILTER (WHERE observed_date >= ($1::date - interval '6 days') AND observed_date <= $1::date)::int AS recent_new,
        count(*) FILTER (WHERE observed_date >= ($1::date - interval '55 days') AND observed_date < ($1::date - interval '6 days'))::int AS baseline_new,
        jsonb_agg(id) FILTER (WHERE observed_date >= ($1::date - interval '6 days') AND observed_date <= $1::date) AS supporting_listing_ids
      FROM observed GROUP BY employer_id, specialty
    ), reliable AS (
      SELECT employer_id, count(*) FILTER (WHERE snapshot_date >= ($1::date - interval '55 days') AND snapshot_date < ($1::date - interval '6 days') AND successful_boards > 0)::int AS baseline_days
      FROM company_daily_metrics GROUP BY employer_id
    )
    SELECT stats.*, reliable.baseline_days, e.name AS employer_name
    FROM stats JOIN reliable USING (employer_id) JOIN employers e ON e.id=stats.employer_id
    WHERE recent_new >= 3 AND reliable.baseline_days >= 28 AND recent_new >= GREATEST(3, ((baseline_new::numeric / 7) * 3))`, [snapshotDate]);
  for (const row of specialtySurges.rows) {
    const baselineWeekly = Number(row.baseline_new || 0) / 7;
    await pool.query(`INSERT INTO market_signals (signal_key, scope, employer_id, signal_type, dimension, period_start, period_end, baseline_value, observed_value, change_ratio, sample_size, explanation, data_quality, supporting_listing_ids)
      VALUES ($1,'company',$2,'specialty_surge',$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (signal_key) DO UPDATE SET period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, baseline_value=EXCLUDED.baseline_value, observed_value=EXCLUDED.observed_value, change_ratio=EXCLUDED.change_ratio, sample_size=EXCLUDED.sample_size, explanation=EXCLUDED.explanation, data_quality=EXCLUDED.data_quality, supporting_listing_ids=EXCLUDED.supporting_listing_ids, last_seen_at=now(), status='active'`,
    [`company:${row.employer_id}:specialty_surge:${row.specialty}`, row.employer_id, row.specialty, new Date(new Date(snapshotDate).getTime() - 6 * 86400000).toISOString().slice(0, 10), snapshotDate, baselineWeekly, row.recent_new, baselineWeekly ? Number(row.recent_new) / baselineWeekly : null, Number(row.baseline_days), `${row.employer_name} observed ${row.recent_new} new ${row.specialty} openings in the last 7 days versus a baseline of ${baselineWeekly.toFixed(1)} per week.`, 'Requires at least 28 reliable baseline observation days.', JSON.stringify(row.supporting_listing_ids ?? [])]);
  }

  const companyBehavior = await pool.query(`WITH stats AS (
      SELECT employer_id,
        avg(active_engineering) FILTER (WHERE snapshot_date >= ($1::date - interval '6 days') AND successful_boards > 0) AS recent_engineering,
        avg(active_engineering) FILTER (WHERE snapshot_date >= ($1::date - interval '34 days') AND snapshot_date < ($1::date - interval '6 days') AND successful_boards > 0) AS baseline_engineering,
        avg(contract_listings) FILTER (WHERE snapshot_date >= ($1::date - interval '6 days') AND successful_boards > 0) AS recent_contract,
        avg(contract_listings) FILTER (WHERE snapshot_date >= ($1::date - interval '34 days') AND snapshot_date < ($1::date - interval '6 days') AND successful_boards > 0) AS baseline_contract,
        count(*) FILTER (WHERE snapshot_date >= ($1::date - interval '6 days') AND successful_boards > 0)::int AS recent_days,
        count(*) FILTER (WHERE snapshot_date >= ($1::date - interval '34 days') AND snapshot_date < ($1::date - interval '6 days') AND successful_boards > 0)::int AS baseline_days
      FROM company_daily_metrics
      WHERE snapshot_date >= ($1::date - interval '34 days') AND snapshot_date <= $1::date
      GROUP BY employer_id
    )
    SELECT stats.*, e.name AS employer_name
    FROM stats JOIN employers e ON e.id=stats.employer_id
    WHERE baseline_days >= 21 AND recent_days >= 5`, [snapshotDate]);
  for (const row of companyBehavior.rows) {
    const recentEngineering = Number(row.recent_engineering || 0);
    const baselineEngineering = Number(row.baseline_engineering || 0);
    const recentContract = Number(row.recent_contract || 0);
    const baselineContract = Number(row.baseline_contract || 0);
    if (recentContract >= 1 && baselineContract < 1) {
      await pool.query(`INSERT INTO market_signals (signal_key, scope, employer_id, signal_type, dimension, period_start, period_end, baseline_value, observed_value, change_ratio, sample_size, explanation, data_quality)
        VALUES ($1,'company',$2,'contract_hiring_start','employment_type',$3::date,$4::date,$5,$6,NULL,$7,$8,$9)
        ON CONFLICT (signal_key) DO UPDATE SET baseline_value=EXCLUDED.baseline_value, observed_value=EXCLUDED.observed_value, sample_size=EXCLUDED.sample_size, explanation=EXCLUDED.explanation, data_quality=EXCLUDED.data_quality, last_seen_at=now(), status='active'`,
      [`company:${row.employer_id}:contract_hiring_start`, row.employer_id, new Date(new Date(snapshotDate).getTime() - 6 * 86400000).toISOString().slice(0, 10), snapshotDate, baselineContract, recentContract, Number(row.baseline_days), `${row.employer_name} now has observable contract listings after a baseline with none.`, 'Requires at least 21 successful baseline observation days.']);
    }
    if (baselineEngineering >= 5 && recentEngineering <= baselineEngineering * 0.5) {
      await pool.query(`INSERT INTO market_signals (signal_key, scope, employer_id, signal_type, dimension, period_start, period_end, baseline_value, observed_value, change_ratio, sample_size, explanation, data_quality)
        VALUES ($1,'company',$2,'hiring_contraction','engineering',$3::date,$4::date,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (signal_key) DO UPDATE SET baseline_value=EXCLUDED.baseline_value, observed_value=EXCLUDED.observed_value, change_ratio=EXCLUDED.change_ratio, sample_size=EXCLUDED.sample_size, explanation=EXCLUDED.explanation, data_quality=EXCLUDED.data_quality, last_seen_at=now(), status='active'`,
      [`company:${row.employer_id}:hiring_contraction`, row.employer_id, new Date(new Date(snapshotDate).getTime() - 6 * 86400000).toISOString().slice(0, 10), snapshotDate, baselineEngineering, recentEngineering, baselineEngineering ? recentEngineering / baselineEngineering : null, Number(row.baseline_days), `${row.employer_name} has ${recentEngineering.toFixed(1)} average active engineering openings versus ${baselineEngineering.toFixed(1)} in the preceding monitored period.`, 'Requires at least 21 successful baseline observation days.']);
    }
  }

  const compositionShifts = await pool.query(`WITH latest AS (
      SELECT DISTINCT ON (employer_id) employer_id, snapshot_date, active_engineering, successful_boards, specialty_counts
      FROM company_daily_metrics WHERE snapshot_date <= $1::date ORDER BY employer_id, snapshot_date DESC
    ), baseline AS (
      SELECT DISTINCT ON (employer_id) employer_id, snapshot_date, active_engineering, successful_boards, specialty_counts
      FROM company_daily_metrics WHERE snapshot_date <= ($1::date - interval '21 days') ORDER BY employer_id, snapshot_date DESC
    ), composition_values AS (
      SELECT latest.employer_id, specialties.value AS specialty,
        COALESCE((latest.specialty_counts->>specialties.value)::numeric,0) / NULLIF(latest.active_engineering,0) AS recent_share,
        COALESCE((baseline.specialty_counts->>specialties.value)::numeric,0) / NULLIF(baseline.active_engineering,0) AS baseline_share,
        latest.active_engineering, latest.successful_boards AS recent_successful_boards, baseline.successful_boards AS baseline_successful_boards,
        latest.snapshot_date AS recent_date, baseline.snapshot_date AS baseline_date
      FROM latest JOIN baseline USING (employer_id)
      CROSS JOIN LATERAL jsonb_object_keys(latest.specialty_counts || baseline.specialty_counts) AS specialties(value)
    )
    SELECT composition_values.*, e.name AS employer_name FROM composition_values JOIN employers e ON e.id=composition_values.employer_id
    WHERE recent_successful_boards > 0 AND baseline_successful_boards > 0 AND active_engineering >= 3
      AND abs(COALESCE(recent_share,0) - COALESCE(baseline_share,0)) >= 0.25`, [snapshotDate]);
  for (const row of compositionShifts.rows) {
    const evidence = await pool.query(`SELECT l.id FROM job_listings l JOIN job_boards b ON b.id=l.board_id WHERE l.is_active AND b.employer_id=$1 AND l.engineering_specialties ? $2 ORDER BY l.first_observed_at DESC LIMIT 25`, [row.employer_id, row.specialty]);
    const direction = Number(row.recent_share || 0) >= Number(row.baseline_share || 0) ? 'increased' : 'decreased';
    await pool.query(`INSERT INTO market_signals (signal_key, scope, employer_id, signal_type, dimension, period_start, period_end, baseline_value, observed_value, change_ratio, sample_size, explanation, data_quality, supporting_listing_ids)
      VALUES ($1,'company',$2,'composition_shift',$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (signal_key) DO UPDATE SET period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, baseline_value=EXCLUDED.baseline_value, observed_value=EXCLUDED.observed_value, change_ratio=EXCLUDED.change_ratio, sample_size=EXCLUDED.sample_size, explanation=EXCLUDED.explanation, data_quality=EXCLUDED.data_quality, supporting_listing_ids=EXCLUDED.supporting_listing_ids, last_seen_at=now(), status='active'`,
    [`company:${row.employer_id}:composition_shift:${row.specialty}`, row.employer_id, row.specialty, row.baseline_date, row.recent_date, Number(row.baseline_share || 0) * 100, Number(row.recent_share || 0) * 100, Number(row.baseline_share || 0) > 0 ? Number(row.recent_share || 0) / Number(row.baseline_share) : null, 2, `${row.employer_name}'s ${row.specialty} share ${direction} from ${(Number(row.baseline_share || 0) * 100).toFixed(1)}% to ${(Number(row.recent_share || 0) * 100).toFixed(1)}% of engineering openings.`, 'Requires two successful snapshots at least 21 days apart and at least 3 active engineering openings.', JSON.stringify(evidence.rows.map((item) => item.id))]);
  }

  const newSpecialties = await pool.query(`SELECT b.employer_id, specialties.value AS specialty, count(*)::int AS recent_listings,
      jsonb_agg(l.id) AS supporting_listing_ids
    FROM job_listings l JOIN job_boards b ON b.id=l.board_id
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(l.engineering_specialties,'[]'::jsonb)) AS specialties(value)
    WHERE l.is_active AND l.first_observed_at >= ($1::date - interval '6 days') AND l.first_observed_at <= ($1::date + interval '1 day')
      AND l.first_observed_at > COALESCE(b.initialized_at, '-infinity'::timestamptz)
      AND NOT EXISTS (
        SELECT 1 FROM job_listings prior JOIN job_boards prior_board ON prior_board.id=prior.board_id
        WHERE prior_board.employer_id=b.employer_id AND prior.is_active AND prior.first_observed_at < ($1::date - interval '6 days')
          AND prior.engineering_specialties ? specialties.value
      )
    GROUP BY b.employer_id, specialties.value HAVING count(*) >= 2`, [snapshotDate]);
  for (const row of newSpecialties.rows) {
    await pool.query(`INSERT INTO market_signals (signal_key, scope, employer_id, signal_type, dimension, period_start, period_end, baseline_value, observed_value, change_ratio, sample_size, explanation, data_quality, supporting_listing_ids)
      VALUES ($1,'company',$2,'new_specialization','specialty',$3::date,$4::date,0,$5,NULL,$6,$7,$8,$9)
      ON CONFLICT (signal_key) DO UPDATE SET period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, observed_value=EXCLUDED.observed_value, sample_size=EXCLUDED.sample_size, explanation=EXCLUDED.explanation, data_quality=EXCLUDED.data_quality, supporting_listing_ids=EXCLUDED.supporting_listing_ids, last_seen_at=now(), status='active'`,
    [`company:${row.employer_id}:new_specialization:${row.specialty}`, row.employer_id, new Date(new Date(snapshotDate).getTime() - 6 * 86400000).toISOString().slice(0, 10), snapshotDate, Number(row.recent_listings), Number(row.recent_listings), `New ${row.specialty} demand appeared in ${row.recent_listings} recently observed openings for this employer.`, 'Requires at least two recent openings and no older active opening with this specialty.', JSON.stringify(row.supporting_listing_ids)]);
  }

  const persistentVacancies = await pool.query(`SELECT b.employer_id, count(*)::int AS persistent_listings,
      (array_agg(l.id ORDER BY l.first_observed_at ASC))[1:25] AS supporting_listing_ids
    FROM job_listings l JOIN job_boards b ON b.id=l.board_id
    WHERE l.is_active AND l.first_observed_at < ($1::date - interval '60 days')
      AND l.first_observed_at > COALESCE(b.initialized_at, '-infinity'::timestamptz)
    GROUP BY b.employer_id HAVING count(*) >= 3`, [snapshotDate]);
  for (const row of persistentVacancies.rows) {
    await pool.query(`INSERT INTO market_signals (signal_key, scope, employer_id, signal_type, dimension, period_start, period_end, baseline_value, observed_value, change_ratio, sample_size, explanation, data_quality, supporting_listing_ids)
      VALUES ($1,'company',$2,'persistent_vacancies','listing_age',$3::date,$4::date,60,$5,NULL,$5,$6,$7,$8)
      ON CONFLICT (signal_key) DO UPDATE SET period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, observed_value=EXCLUDED.observed_value, sample_size=EXCLUDED.sample_size, explanation=EXCLUDED.explanation, data_quality=EXCLUDED.data_quality, supporting_listing_ids=EXCLUDED.supporting_listing_ids, last_seen_at=now(), status='active'`,
    [`company:${row.employer_id}:persistent_vacancies`, row.employer_id, new Date(new Date(snapshotDate).getTime() - 60 * 86400000).toISOString().slice(0, 10), snapshotDate, Number(row.persistent_listings), `At least ${row.persistent_listings} active openings have remained observed for more than 60 days.`, 'Excludes openings present in the board baseline.', JSON.stringify(row.supporting_listing_ids)]);
  }

  const marketCandidates = await pool.query(`WITH stats AS (
      SELECT dimension, dimension_value,
        sum(new_listings) FILTER (WHERE snapshot_date >= ($1::date - interval '6 days'))::int AS recent_new,
        sum(new_listings) FILTER (WHERE snapshot_date >= ($1::date - interval '55 days') AND snapshot_date < ($1::date - interval '6 days'))::int AS baseline_new,
        count(*) FILTER (WHERE snapshot_date >= ($1::date - interval '55 days') AND snapshot_date < ($1::date - interval '6 days'))::int AS baseline_days,
        count(DISTINCT snapshot_date) FILTER (WHERE snapshot_date >= ($1::date - interval '6 days'))::int AS recent_days
      FROM market_daily_metrics
      WHERE cohort='stable_28d' AND snapshot_date >= ($1::date - interval '55 days') AND snapshot_date <= $1::date
        AND dimension IN ('category','specialty','technology','region','country')
      GROUP BY dimension, dimension_value
    )
    SELECT * FROM stats
    WHERE recent_new >= 5 AND baseline_days >= 28 AND recent_days >= 5
      AND recent_new >= GREATEST(5, ((baseline_new::numeric / 7) * 3))`, [snapshotDate]);
  const dimensionPredicate: Record<string, string> = {
    category: `l.job_category=$1`,
    specialty: `l.engineering_specialties ? $1`,
    technology: `l.technologies ? $1`,
    region: `l.location_signals->'regions' ? $1`,
    country: `(l.location_signals->'countries' ? $1 OR l.location_signals->'locations' ? $1)`
  };
  for (const row of marketCandidates.rows) {
    const predicate = dimensionPredicate[row.dimension];
    if (!predicate) continue;
    const evidence = await pool.query(`SELECT l.id FROM job_listings l JOIN job_boards b ON b.id=l.board_id
      WHERE l.is_active AND ${predicate} ORDER BY l.first_observed_at DESC LIMIT 25`, [row.dimension_value]);
    const baselineWeekly = Number(row.baseline_new || 0) / 7;
    const signalKey = `market:${row.dimension}:${row.dimension_value}:hiring_surge`;
    await pool.query(`INSERT INTO market_signals (signal_key, scope, signal_type, dimension, period_start, period_end, baseline_value, observed_value, change_ratio, sample_size, explanation, data_quality, supporting_listing_ids)
      VALUES ($1,'market','hiring_surge',$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (signal_key) DO UPDATE SET period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, baseline_value=EXCLUDED.baseline_value, observed_value=EXCLUDED.observed_value, change_ratio=EXCLUDED.change_ratio, sample_size=EXCLUDED.sample_size, explanation=EXCLUDED.explanation, data_quality=EXCLUDED.data_quality, supporting_listing_ids=EXCLUDED.supporting_listing_ids, last_seen_at=now(), status='active'`,
    [`${signalKey}`, row.dimension, new Date(new Date(snapshotDate).getTime() - 6 * 86400000).toISOString().slice(0, 10), snapshotDate, baselineWeekly, row.recent_new, baselineWeekly ? Number(row.recent_new) / baselineWeekly : null, Number(row.baseline_days), `${row.dimension_value} observed ${row.recent_new} new openings in the last 7 days versus a baseline of ${baselineWeekly.toFixed(1)} per week.`, 'Stable 28-day cohort; requires at least 28 baseline observation days.', JSON.stringify(evidence.rows.map((item) => item.id))]);
  }
  const shareShifts = await pool.query(`WITH daily AS (
      SELECT snapshot_date, dimension, dimension_value, active_listings, employers,
        sum(active_listings) OVER (PARTITION BY snapshot_date, dimension) AS dimension_total
      FROM market_daily_metrics
      WHERE cohort='stable_28d' AND snapshot_date >= ($1::date - interval '55 days') AND snapshot_date <= $1::date
        AND dimension IN ('category','specialty','technology','region','country')
    ), stats AS (
      SELECT dimension, dimension_value,
        avg(active_listings::numeric / NULLIF(dimension_total,0)) FILTER (WHERE snapshot_date >= ($1::date - interval '6 days')) AS recent_share,
        avg(active_listings::numeric / NULLIF(dimension_total,0)) FILTER (WHERE snapshot_date >= ($1::date - interval '55 days') AND snapshot_date < ($1::date - interval '6 days')) AS baseline_share,
        avg(active_listings) FILTER (WHERE snapshot_date >= ($1::date - interval '6 days')) AS recent_listings,
        count(DISTINCT snapshot_date) FILTER (WHERE snapshot_date >= ($1::date - interval '6 days'))::int AS recent_days,
        count(DISTINCT snapshot_date) FILTER (WHERE snapshot_date >= ($1::date - interval '55 days') AND snapshot_date < ($1::date - interval '6 days'))::int AS baseline_days
      FROM daily GROUP BY dimension, dimension_value
    )
    SELECT * FROM stats WHERE recent_days >= 5 AND baseline_days >= 21 AND recent_listings >= 10
      AND abs(recent_share - baseline_share) >= 0.10`, [snapshotDate]);
  for (const row of shareShifts.rows) {
    const predicate = dimensionPredicate[row.dimension];
    if (!predicate) continue;
    const evidence = await pool.query(`SELECT l.id FROM job_listings l JOIN job_boards b ON b.id=l.board_id WHERE l.is_active AND ${predicate} ORDER BY l.first_observed_at DESC LIMIT 25`, [row.dimension_value]);
    const changeRatio = Number(row.baseline_share) > 0 ? Number(row.recent_share) / Number(row.baseline_share) : null;
    const direction = Number(row.recent_share) >= Number(row.baseline_share) ? 'increased' : 'decreased';
    await pool.query(`INSERT INTO market_signals (signal_key, scope, signal_type, dimension, period_start, period_end, baseline_value, observed_value, change_ratio, sample_size, explanation, data_quality, supporting_listing_ids)
      VALUES ($1,'market','share_shift',$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (signal_key) DO UPDATE SET period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, baseline_value=EXCLUDED.baseline_value, observed_value=EXCLUDED.observed_value, change_ratio=EXCLUDED.change_ratio, sample_size=EXCLUDED.sample_size, explanation=EXCLUDED.explanation, data_quality=EXCLUDED.data_quality, supporting_listing_ids=EXCLUDED.supporting_listing_ids, last_seen_at=now(), status='active'`,
    [`market:${row.dimension}:${row.dimension_value}:share_shift`, row.dimension, new Date(new Date(snapshotDate).getTime() - 6 * 86400000).toISOString().slice(0, 10), snapshotDate, Number(row.baseline_share) * 100, Number(row.recent_share) * 100, changeRatio, Number(row.baseline_days), `${row.dimension_value} share ${direction} from ${(Number(row.baseline_share) * 100).toFixed(1)}% to ${(Number(row.recent_share) * 100).toFixed(1)}% among stable monitored openings.`, 'Stable 28-day cohort; at least 10 current listings and 21 baseline observation days.', JSON.stringify(evidence.rows.map((item) => item.id))]);
  }
  console.info(`Market signals evaluated: ${candidates.rows.length} company surge, ${specialtySurges.rows.length} specialty surge, ${compositionShifts.rows.length} composition shifts, ${companyBehavior.rows.length} company behavior, ${newSpecialties.rows.length} new specialties, ${persistentVacancies.rows.length} persistent vacancy candidates, ${marketCandidates.rows.length} market candidates, ${shareShifts.rows.length} share shifts`);
}
