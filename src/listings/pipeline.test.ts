import { describe, expect, it } from 'vitest';
import { defaultPreferences } from '../db.js';
import { analyzeListing } from './pipeline.js';
import { listingNotificationEligibleForTest } from './service.js';

const listing = {
  providerJobId: '1', title: 'Senior Backend Engineer', description: 'Build TypeScript and Node.js services with a distributed team. Work from anywhere worldwide.',
  location: 'Worldwide', remoteMode: 'remote' as const, applicationUrl: 'https://example.com/apply', originalUrl: 'https://example.com/job', raw: {}
};
const taiwanPreferences = { ...defaultPreferences, locationProfile: { baseLocation: 'Taiwan', timeZone: 'Asia/Taipei', utcOffset: 8, preferredRegions: ['Taiwan', 'APAC', 'Asia', 'Worldwide'] } };

describe('listing scoring', () => {
  it('calculates ATS relevance using the same preference dimensions as posts', () => {
    const result = analyzeListing(listing, taiwanPreferences);
    expect(result.personalRelevance).toBeGreaterThan(55);
    expect(result.relevanceBreakdown.map((item) => item.label)).toContain('Relevant role');
    expect(result.locationFit).toBe('excellent');
    expect(result.locationFitScore).toBeGreaterThanOrEqual(80);
    expect(listingNotificationEligibleForTest(result, { ...taiwanPreferences, minimumListingRelevance: 55 })).toBe(true);
    expect(listingNotificationEligibleForTest(result, { ...taiwanPreferences, minimumListingRelevance: 70 })).toBe(false);
  });

  it('marks an explicitly restricted location as poor fit', () => {
    const result = analyzeListing({ ...listing, description: 'Remote in the United States only. Must already have work authorization.', location: 'United States only' }, taiwanPreferences);
    expect(result.locationFit).toBe('poor');
    expect(result.locationFitScore).toBeLessThan(40);
  });

  it('uses the normalized ATS location instead of incidental description mentions', () => {
    const result = analyzeListing({
      ...listing,
      location: 'New York, United States',
      remoteMode: 'onsite',
      description: 'Join our worldwide team serving customers across Asia and Taiwan.'
    }, taiwanPreferences);
    expect(result.locationFit).toBe('poor');
    expect(result.locationFitScore).toBeLessThan(40);
    expect(result.locationFitReasons).toContain('On-site outside Taiwan');
  });

  it('keeps normalized country values separate from city and region values', () => {
    const result = analyzeListing({ ...listing, location: 'Taipei, Taiwan', remoteMode: 'remote' }, taiwanPreferences);
    expect(result.locationSignals.countries).toEqual(['Taiwan']);
    expect(result.locationSignals.locations).toEqual(expect.arrayContaining(['Taiwan', 'Taipei']));
  });

  it('does not treat an employer statistic as worldwide candidate eligibility', () => {
    const result = analyzeListing({
      ...listing,
      location: 'London, United Kingdom',
      remoteMode: 'unknown',
      description: 'More than 20,000 organizations worldwide rely on the company platform.'
    }, taiwanPreferences);
    expect(result.locationSignals.workEligibility).toBe('country_specific');
    expect(result.locationFit).toBe('unknown');
    expect(result.locationFitScore).toBe(25);
  });

  it('requires portable work for preferred-region and worldwide matches', () => {
    const onsite = analyzeListing({ ...listing, location: 'Singapore', remoteMode: 'onsite', description: 'Work with our APAC and worldwide customers.' }, taiwanPreferences);
    expect(onsite.locationFit).toBe('poor');

    const remote = analyzeListing({ ...listing, location: 'APAC', remoteMode: 'remote', description: 'Remote engineering role.' }, taiwanPreferences);
    expect(remote.locationFit).toBe('excellent');
    expect(remote.locationFitScore).toBeGreaterThanOrEqual(85);

    const incidental = analyzeListing({ ...listing, location: '', remoteMode: 'remote', description: 'Remote role serving customers across APAC and Taiwan.' }, taiwanPreferences);
    expect(incidental.locationFit).toBe('good');
    expect(incidental.locationFitScore).toBe(70);
  });
});
