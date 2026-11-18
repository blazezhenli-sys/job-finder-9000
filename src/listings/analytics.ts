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
        (SELECT count(DISTINCT employer_id)::int FROM stable_boards) AS stable_employers`, [snapshotDate]);
    await client.query(`INSERT INTO market_snapshot_runs (snapshot_date, generated_at, monitored_boards, stable_boards, monitored_employers, stable_employers, coverage_note)
      VALUES ($1, now(), $2, $3, $4, $5, 'stable_28d requires at least 25 successful observation days in the preceding 28-day window')
      ON CONFLICT (snapshot_date) DO UPDATE SET generated_at=EXCLUDED.generated_at, monitored_boards=EXCLUDED.monitored_boards, stable_boards=EXCLUDED.stable_boards, monitored_employers=EXCLUDED.monitored_employers, stable_employers=EXCLUDED.stable_employers, coverage_note=EXCLUDED.coverage_note`, [snapshotDate, coverage.rows[0].monitored_boards, coverage.rows[0].stable_boards, coverage.rows[0].monitored_employers, coverage.rows[0].stable_employers]);

    await client.query(`WITH listing_counts AS (
        SELECT b.employer_id,
          count(*) FILTER (WHERE l.is_active)::int AS active_listings,
          count(*) FILTER (WHERE l.is_active AND l.job_category='software_engineering')::int AS active_engineering,
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
      )
      INSERT INTO company_daily_metrics (snapshot_date, employer_id, active_listings, active_engineering, new_listings, removed_listings, remote_listings, contract_listings, monitored_boards, successful_boards)
      SELECT $1, e.id, COALESCE(lc.active_listings,0), COALESCE(lc.active_engineering,0), COALESCE(lc.new_listings,0), COALESCE(ec.removed_listings,0), COALESCE(lc.remote_listings,0), COALESCE(lc.contract_listings,0), COALESCE(bc.monitored_boards,0), COALESCE(bc.successful_boards,0)
      FROM employers e LEFT JOIN listing_counts lc ON lc.employer_id=e.id LEFT JOIN event_counts ec ON ec.employer_id=e.id LEFT JOIN board_counts bc ON bc.employer_id=e.id
      ON CONFLICT (snapshot_date, employer_id) DO UPDATE SET active_listings=EXCLUDED.active_listings, active_engineering=EXCLUDED.active_engineering, new_listings=EXCLUDED.new_listings, removed_listings=EXCLUDED.removed_listings, remote_listings=EXCLUDED.remote_listings, contract_listings=EXCLUDED.contract_listings, monitored_boards=EXCLUDED.monitored_boards, successful_boards=EXCLUDED.successful_boards`, [snapshotDate]);

    for (const cohort of ['all', 'stable_28d']) {
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
          SELECT 'category' AS dimension, COALESCE(NULLIF(job_category,''),'unknown') AS dimension_value, employer_id, is_new FROM base
          UNION ALL SELECT 'work_mode', remote_mode, employer_id, is_new FROM base
          UNION ALL SELECT 'employment_type', COALESCE(NULLIF(employment_type,''),'unknown'), employer_id, is_new FROM base
          UNION ALL SELECT 'specialty', values.value, employer_id, is_new FROM base CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(engineering_specialties,'[]'::jsonb)) AS values(value)
          UNION ALL SELECT 'technology', values.value, employer_id, is_new FROM base CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(technologies,'[]'::jsonb)) AS values(value)
          UNION ALL SELECT 'region', values.value, employer_id, is_new FROM base CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(location_signals->'regions','[]'::jsonb)) AS values(value)
        )
        INSERT INTO market_daily_metrics (snapshot_date, cohort, dimension, dimension_value, active_listings, employers, new_listings)
        SELECT $1, $2, dimension, dimension_value, count(*)::int, count(DISTINCT employer_id)::int, count(*) FILTER (WHERE is_new)::int
        FROM dimensions GROUP BY dimension, dimension_value
        ON CONFLICT (snapshot_date, cohort, dimension, dimension_value) DO UPDATE SET active_listings=EXCLUDED.active_listings, employers=EXCLUDED.employers, new_listings=EXCLUDED.new_listings`, [snapshotDate, cohort]);
    }
  });
  console.info(`Market snapshot complete: ${snapshotDate}`);
}

export async function getMarketTrends(from: string, to: string, cohort = 'all', dimension = 'category') {
  const safeCohort = ['all', 'stable_28d'].includes(cohort) ? cohort : 'all';
  const safeDimension = ['category', 'specialty', 'technology', 'region', 'work_mode', 'employment_type'].includes(dimension) ? dimension : 'category';
  const [metrics, runs] = await Promise.all([
    pool.query(`SELECT snapshot_date, dimension_value, active_listings, employers, new_listings FROM market_daily_metrics WHERE snapshot_date BETWEEN $1::date AND $2::date AND cohort=$3 AND dimension=$4 ORDER BY snapshot_date, active_listings DESC`, [from, to, safeCohort, safeDimension]),
    pool.query(`SELECT * FROM market_snapshot_runs WHERE snapshot_date BETWEEN $1::date AND $2::date ORDER BY snapshot_date`, [from, to])
  ]);
  return { from, to, cohort: safeCohort, dimension: safeDimension, metrics: metrics.rows, coverage: runs.rows };
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
      COALESCE((SELECT jsonb_agg(l.id) FROM job_listings l JOIN job_boards b ON b.id=l.board_id WHERE b.employer_id=stats.employer_id AND l.is_active AND l.first_observed_at >= ($1::date - interval '6 days') AND l.first_observed_at <= ($1::date + interval '1 day') AND l.job_category='software_engineering'), '[]'::jsonb) AS supporting_listing_ids
    FROM stats JOIN employers e ON e.id=stats.employer_id
    WHERE recent_new >= 3 AND baseline_days >= 28 AND recent_days >= 5
      AND recent_new >= GREATEST(3, ((baseline_new::numeric / 7) * 3))`, [snapshotDate]);
  for (const row of candidates.rows) {
    const baselineWeekly = Number(row.baseline_new) / 7;
    const signalKey = `company:${row.employer_id}:hiring_surge`;
    await pool.query(`INSERT INTO market_signals (signal_key, scope, employer_id, signal_type, dimension, period_start, period_end, baseline_value, observed_value, change_ratio, sample_size, explanation, data_quality, supporting_listing_ids)
      VALUES ($1,'company',$2,'hiring_surge','engineering',$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (signal_key) DO UPDATE SET period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, baseline_value=EXCLUDED.baseline_value, observed_value=EXCLUDED.observed_value, change_ratio=EXCLUDED.change_ratio, sample_size=EXCLUDED.sample_size, explanation=EXCLUDED.explanation, data_quality=EXCLUDED.data_quality, supporting_listing_ids=EXCLUDED.supporting_listing_ids, last_seen_at=now(), status='active'`, [signalKey, row.employer_id, new Date(new Date(snapshotDate).getTime() - 6 * 86400000).toISOString().slice(0, 10), snapshotDate, baselineWeekly, row.recent_new, baselineWeekly ? Number(row.recent_new) / baselineWeekly : null, Number(row.baseline_days), `${row.employer_name} observed ${row.recent_new} new engineering openings in the last 7 days versus a baseline of ${baselineWeekly.toFixed(1)} per week.`, 'Requires at least 28 successful baseline observation days.', row.supporting_listing_ids]);
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
        AND dimension IN ('category','specialty','technology','region')
      GROUP BY dimension, dimension_value
    )
    SELECT * FROM stats
    WHERE recent_new >= 5 AND baseline_days >= 28 AND recent_days >= 5
      AND recent_new >= GREATEST(5, ((baseline_new::numeric / 7) * 3))`, [snapshotDate]);
  const dimensionPredicate: Record<string, string> = {
    category: `l.job_category=$1`,
    specialty: `l.engineering_specialties ? $1`,
    technology: `l.technologies ? $1`,
    region: `l.location_signals->'regions' ? $1`
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
  console.info(`Market signals evaluated: ${candidates.rows.length} company surge, ${companyBehavior.rows.length} company behavior, ${newSpecialties.rows.length} new specialties, ${persistentVacancies.rows.length} persistent vacancy candidates, ${marketCandidates.rows.length} market candidates`);
}
