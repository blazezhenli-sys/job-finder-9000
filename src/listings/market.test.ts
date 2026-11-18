import { describe, expect, it } from 'vitest';
import { marketWhere } from './market.js';

describe('market filters', () => {
  it('builds parameterized filters for the explorer', () => {
    const values: unknown[] = [];
    const where = marketWhere({ category: 'software_engineering', specialty: 'backend_api', technology: 'typescript', region: 'Asia', remoteEligibility: 'regional', workMode: 'remote', employer: 'Example', minSalary: '100000' }, values);
    expect(where).toContain("l.is_active = true");
    expect(where).toContain("l.engineering_specialties ? $2");
    expect(where).toContain("l.technologies ? $3");
    expect(values).toEqual(['software_engineering', 'backend_api', 'typescript', '%Example%', 'Asia', 'regional', 'remote', 100000]);
  });

  it('defaults to active listings and allows an explicit all-listings view', () => {
    expect(marketWhere({}, [])).toBe('l.is_active = true');
    expect(marketWhere({ active: 'all' }, [])).toBe('TRUE');
  });
});
