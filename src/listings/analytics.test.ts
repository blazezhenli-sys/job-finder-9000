import { describe, expect, it } from 'vitest';
import { marketDashboardDeltaSeries, marketDashboardPeriods, marketDashboardRankings } from './analytics.js';

describe('market dashboard calculations', () => {
  it('creates an equal-length prior comparison period', () => {
    expect(marketDashboardPeriods('2026-11-01', '2026-11-30')).toEqual({
      previousFrom: '2026-10-02',
      previousTo: '2026-10-31'
    });
  });

  it('calculates ranking deltas against the prior period', () => {
    const current = [
      { snapshot_date: '2026-11-30', dimension_value: 'software_engineering', active_listings: 120, employers: 12, new_listings: 20, removed_listings: 4, active_share: 0.6, new_share: 0.5 },
      { snapshot_date: '2026-11-30', dimension_value: 'product', active_listings: 80, employers: 8, new_listings: 20, removed_listings: 3, active_share: 0.4, new_share: 0.5 }
    ];
    const previous = [
      { snapshot_date: '2026-10-31', dimension_value: 'software_engineering', active_listings: 100, active_share: 0.5 },
      { snapshot_date: '2026-10-31', dimension_value: 'product', active_listings: 100, active_share: 0.5 }
    ];
    expect(marketDashboardRankings(current, previous)).toMatchObject([
      { dimension_value: 'software_engineering', active_delta: 20, share_delta: 0.1, prior_active_listings: 100 },
      { dimension_value: 'product', active_delta: -20, share_delta: -0.1, prior_active_listings: 100 }
    ]);
  });

  it('handles an empty prior period without NaN values', () => {
    const [ranking] = marketDashboardRankings([{ snapshot_date: '2026-11-30', dimension_value: 'unknown', active_listings: 4, active_share: 1 }], []);
    expect(ranking).toMatchObject({ active_delta: 4, share_delta: 1, prior_active_listings: 0 });
    expect(Number.isNaN(ranking.active_delta)).toBe(false);
  });

  it('calculates period-over-period volume and share deltas with a lookback bucket', () => {
    const current = [
      { snapshot_date: '2026-11-02', dimension_value: 'engineering', active_listings: 120, active_share: 0.6 },
      { snapshot_date: '2026-11-02', dimension_value: 'product', active_listings: 80, active_share: 0.4 },
      { snapshot_date: '2026-11-03', dimension_value: 'engineering', active_listings: 135, active_share: 0.675 }
    ];
    const comparison = [
      { snapshot_date: '2026-11-01', dimension_value: 'engineering', active_listings: 100, active_share: 0.5 },
      { snapshot_date: '2026-11-01', dimension_value: 'product', active_listings: 100, active_share: 0.5 },
      ...current
    ];
    expect(marketDashboardDeltaSeries(current, comparison)).toEqual([
      expect.objectContaining({ snapshot_date: '2026-11-02', dimension_value: 'engineering', active_delta: 20, share_delta: 0.1 }),
      expect.objectContaining({ snapshot_date: '2026-11-02', dimension_value: 'product', active_delta: -20, share_delta: -0.1 }),
      expect.objectContaining({ snapshot_date: '2026-11-03', dimension_value: 'engineering', active_delta: 15, share_delta: 0.075 }),
      expect.objectContaining({ snapshot_date: '2026-11-03', dimension_value: 'product', active_delta: -80, share_delta: -0.4 })
    ]);
  });

  it('includes every value from the latest period instead of using the last frequency row', () => {
    const rankings = marketDashboardRankings([
      { snapshot_date: '2026-11-30', dimension_value: 'software_engineering', active_listings: 120, active_share: 0.8 },
      { snapshot_date: '2026-11-30', dimension_value: 'product', active_listings: 30, active_share: 0.2 },
      { snapshot_date: '2026-11-29', dimension_value: 'software_engineering', active_listings: 100, active_share: 1 }
    ], []);
    expect(rankings.map((row) => row.dimension_value)).toEqual(['software_engineering', 'product']);
  });
});
