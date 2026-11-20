import { describe, expect, it } from 'vitest';
import { defaultPreferences } from './db.js';
import { coalesceCompanySocialPosts, filterCompanySocialPosts, type CompanySocialPostInput } from './company-signals.js';
import type { DetectionRule } from './types.js';

const rules: DetectionRule[] = [
  { id: 'hiring', name: 'Hiring', pattern: 'hiring', match_type: 'phrase', category: 'hiring', weight: 8, negative: false, enabled: true },
  { id: 'we-hire', name: 'We are hiring', pattern: "we're hiring|we are hiring", match_type: 'regex', category: 'hiring', weight: 20, negative: false, enabled: true },
  { id: 'closed', name: 'Hiring closed', pattern: 'hiring (is )?(closed|over)', match_type: 'regex', category: 'negative', weight: 0, negative: true, enabled: true }
];

const post = (overrides: Partial<CompanySocialPostInput> = {}): CompanySocialPostInput => ({
  id: 'post-1', employer_id: 'company-1', employer_name: 'Example Corp', employer_website: 'https://example.com', platform: 'bluesky', source_url: 'https://bsky.app/post/1', text: "We're hiring a backend engineer. Apply now.", published_at: '2026-11-20T10:00:00.000Z', ...overrides
});
describe('company social hiring signals', () => {
  it('coalesces qualifying posts from multiple platforms into one company signal', () => {
    const signals = coalesceCompanySocialPosts([
      post(),
      post({ id: 'post-2', platform: 'linkedin', source_url: 'https://linkedin.com/posts/2', text: 'Our team is hiring a senior engineer.', published_at: '2026-11-20T12:00:00.000Z' }),
      post({ id: 'post-3', employer_id: 'company-2', employer_name: 'Other Corp', text: "We're hiring a designer.", published_at: '2026-11-20T11:00:00.000Z' })
    ], rules, defaultPreferences);

    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({ company: { id: 'company-1', name: 'Example Corp' }, matchingPostCount: 2, lastPostAt: '2026-11-20T12:00:00.000Z' });
    expect(signals[0].posts.map((item) => item.platform)).toEqual(['linkedin', 'bluesky']);
    expect(signals[0].primaryCategory).toBe('direct_hiring');
  });

  it('ignores unrelated posts and negative hiring announcements', () => {
    const signals = coalesceCompanySocialPosts([
      post({ id: 'unrelated', text: 'We shipped a new dashboard today.' }),
      post({ id: 'closed', text: "We're hiring is closed now." })
    ], rules, defaultPreferences);
    expect(signals).toEqual([]);
  });

  it('keeps a qualifying templated post from a known company account', () => {
    const signals = coalesceCompanySocialPosts([post({ text: "We're hiring. Position: Backend Engineer. Location: Remote. Apply now: https://nearskill.in/jobs/123" })], rules, defaultPreferences);
    expect(signals[0]).toMatchObject({ primaryCategory: 'direct_hiring', matchingPostCount: 1 });
  });

  it('filters posts outside the retained social activity window', () => {
    const rows = filterCompanySocialPosts([
      post({ id: 'recent', published_at: '2026-11-06T00:00:00.000Z' }),
      post({ id: 'old', published_at: '2026-11-05T23:59:59.000Z' })
    ], new Date('2026-11-20T00:00:00.000Z'), 14);
    expect(rows.map((row) => row.id)).toEqual(['recent']);
  });
});
