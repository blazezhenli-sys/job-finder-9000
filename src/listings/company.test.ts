import { describe, expect, it } from 'vitest';
import { calculateProspectScore, classifyEngineeringSpecialties, extractListingTechnologies, isEngineeringListing } from './company.js';

describe('company engineering classification', () => {
  it('supports overlapping specialties from one listing', () => {
    const specialties = classifyEngineeringSpecialties({ title: 'Senior Full-stack Engineer', description: 'Build React interfaces and Node.js APIs.', department: '', team: '' });
    expect(specialties).toEqual(expect.arrayContaining(['full_stack', 'frontend', 'backend_api']));
    expect(isEngineeringListing(specialties)).toBe(true);
  });

  it('does not classify unrelated business roles as engineering openings', () => {
    const specialties = classifyEngineeringSpecialties({ title: 'Senior Product Manager', description: 'Lead roadmap and customer discovery.', department: 'Product', team: '' });
    expect(specialties).toEqual([]);
    expect(isEngineeringListing(specialties)).toBe(false);
  });

  it('extracts technologies separately from engineering specialty', () => {
    expect(extractListingTechnologies({ title: 'Backend Engineer', description: 'TypeScript, PostgreSQL, AWS, and Docker.', department: '', team: '' })).toEqual(expect.arrayContaining(['typescript', 'postgresql', 'aws', 'docker']));
  });

  it('keeps prospect scoring transparent and bounded', () => {
    const result = calculateProspectScore({ activeEngineering: 4, newEngineering7d: 2, contractListings: 1, remoteListings: 3, hasRecentActivity: true });
    expect(result.score).toBe(57);
    expect(result.factors.map((factor) => factor.label)).toContain('Contract hiring');
  });
});
