import type { SignalCategory, SourceName } from './types.js';

const blueskyDefaultCategories: SignalCategory[] = ['direct_hiring', 'firsthand_announcement'];

export function blueskyDisplayCategories(includeAggregators = false): SignalCategory[] {
  return includeAggregators ? [...blueskyDefaultCategories, 'aggregated_listing'] : [...blueskyDefaultCategories];
}

export function isPostDiscoveryCategoryVisible(source: SourceName, category: SignalCategory, includeBlueskyAggregators = false): boolean {
  return source !== 'bluesky' || blueskyDisplayCategories(includeBlueskyAggregators).includes(category);
}
