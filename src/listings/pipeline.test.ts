import { describe, expect, it } from 'vitest';
import { defaultPreferences } from '../db.js';
import { analyzeListing } from './pipeline.js';

const listing = {
  providerJobId: '1', title: 'Senior Backend Engineer', description: 'Build TypeScript and Node.js services with a distributed team. Work from anywhere worldwide.',
  location: 'Worldwide', remoteMode: 'remote' as const, applicationUrl: 'https://example.com/apply', originalUrl: 'https://example.com/job', raw: {}
};

describe('listing scoring', () => {
  it('scores role, technology, remote, and worldwide evidence independently', () => {
    const result = analyzeListing(listing, defaultPreferences);
    expect(result.personalRelevance).toBeGreaterThanOrEqual(45);
    expect(result.locationFit).toBe('excellent');
    expect(result.locationFitScore).toBeGreaterThanOrEqual(80);
    expect(result.relevanceBreakdown.map((item) => item.label)).toEqual(expect.arrayContaining(['Relevant role', 'Technology match', 'Remote preference', 'International signal']));
  });

  it('marks an explicitly restricted location as poor fit', () => {
    const result = analyzeListing({ ...listing, description: 'Remote in the United States only. Must already have work authorization.', location: 'United States only' }, defaultPreferences);
    expect(result.locationFit).toBe('poor');
    expect(result.locationFitScore).toBeLessThan(40);
  });
});
