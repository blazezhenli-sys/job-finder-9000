import { describe, expect, it } from 'vitest';
import { blueskyDisplayCategories, isPostDiscoveryCategoryVisible } from './post-discovery-policy.js';

describe('post discovery source policy', () => {
  it('limits Bluesky to direct and firsthand hiring by default', () => {
    expect(blueskyDisplayCategories()).toEqual(['direct_hiring', 'firsthand_announcement']);
    expect(isPostDiscoveryCategoryVisible('bluesky', 'direct_hiring')).toBe(true);
    expect(isPostDiscoveryCategoryVisible('bluesky', 'firsthand_announcement')).toBe(true);
    expect(isPostDiscoveryCategoryVisible('bluesky', 'service_request')).toBe(false);
    expect(isPostDiscoveryCategoryVisible('bluesky', 'employee_referral')).toBe(false);
    expect(isPostDiscoveryCategoryVisible('bluesky', 'aggregated_listing')).toBe(false);
  });

  it('allows Bluesky aggregators only when explicitly enabled and leaves other sources unchanged', () => {
    expect(isPostDiscoveryCategoryVisible('bluesky', 'aggregated_listing', true)).toBe(true);
    expect(isPostDiscoveryCategoryVisible('hacker_news', 'service_request')).toBe(true);
    expect(isPostDiscoveryCategoryVisible('hacker_news', 'aggregated_listing')).toBe(true);
  });
});
