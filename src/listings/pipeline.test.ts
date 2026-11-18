import { describe, expect, it } from 'vitest';
import { defaultPreferences } from '../db.js';
import { analyzeListing } from './pipeline.js';
import { listingNotificationEligibleForTest } from './service.js';

const listing = {
  providerJobId: '1', title: 'Senior Backend Engineer', description: 'Build TypeScript and Node.js services with a distributed team. Work from anywhere worldwide.',
  location: 'Worldwide', remoteMode: 'remote' as const, applicationUrl: 'https://example.com/apply', originalUrl: 'https://example.com/job', raw: {}
};
const relevancePreferences = { ...defaultPreferences, technologyTerms: ['typescript', 'node.js'], roleTerms: ['backend engineer'], remoteTerms: ['remote'], internationalTerms: ['worldwide'] };

describe('listing scoring', () => {
  it('calculates ATS relevance using the same preference dimensions as posts', () => {
    const result = analyzeListing(listing, relevancePreferences);
    expect(result.personalRelevance).toBeGreaterThan(40);
    expect(result.relevanceBreakdown.map((item) => item.label)).toContain('Relevant role');
    expect(result.locationFit).toBe('unknown');
    expect(result.locationFitScore).toBe(0);
    expect(result.locationSignals.workMode).toBe('remote');
    expect(listingNotificationEligibleForTest(result, { ...relevancePreferences, minimumListingRelevance: 40 })).toBe(true);
    expect(listingNotificationEligibleForTest(result, { ...relevancePreferences, minimumListingRelevance: 50 })).toBe(false);
  });

  it('keeps explicit location restrictions as factual source evidence', () => {
    const result = analyzeListing({ ...listing, description: 'Remote in the United States only. Must already have work authorization.', location: 'United States only' }, relevancePreferences);
    expect(result.locationSignals.locations).toContain('United States');
    expect(result.locationSignals.constraint).toBe('restricted');
    expect(result.locationFit).toBe('unknown');
  });

  it('uses the normalized ATS location instead of incidental description mentions', () => {
    const result = analyzeListing({
      ...listing,
      location: 'New York, United States',
      remoteMode: 'onsite',
      description: 'Join our worldwide team serving customers across Asia and Taiwan.'
    }, relevancePreferences);
    expect(result.locationSignals.locations).toEqual(expect.arrayContaining(['United States', 'New York']));
    expect(result.locationFit).toBe('unknown');
    expect(result.locationFitReasons).toEqual([]);
  });

  it('keeps normalized country values separate from city and region values', () => {
    const result = analyzeListing({ ...listing, location: 'Taipei, Taiwan', remoteMode: 'remote' }, relevancePreferences);
    expect(result.locationSignals.countries).toEqual(['Taiwan']);
    expect(result.locationSignals.locations).toEqual(expect.arrayContaining(['Taiwan', 'Taipei']));
  });

  it('does not treat an employer statistic as worldwide candidate eligibility', () => {
    const result = analyzeListing({
      ...listing,
      location: 'London, United Kingdom',
      remoteMode: 'unknown',
      description: 'More than 20,000 organizations worldwide rely on the company platform.'
    }, relevancePreferences);
    expect(result.locationSignals.workEligibility).toBe('country_specific');
    expect(result.locationFit).toBe('unknown');
    expect(result.locationFitScore).toBe(0);
  });
});
