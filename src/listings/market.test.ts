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

  it('uses indexed full-text search for listing exploration', () => {
    const values: unknown[] = [];
    const where = marketWhere({ q: 'platform engineer' }, values);
    expect(where).toContain("to_tsvector('simple'");
    expect(where).toContain('plainto_tsquery');
    expect(values).toEqual(['platform engineer']);
  });

  it('supports country and bounded compensation/publication filters', () => {
    const values: unknown[] = [];
    const where = marketWhere({ country: 'Taiwan', minSalary: '50000', maxSalary: '150000', publishedAfter: '2026-01-01', publishedBefore: '2026-02-01' }, values);
    expect(where).toContain("location_signals->'countries'");
    expect(where).toContain('published_at >=');
    expect(where).toContain('published_at <');
    expect(values).toEqual(['Taiwan', 50000, 150000, '2026-01-01', '2026-02-01']);
  });
});
