import { describe, expect, it } from 'vitest';
import { defaultPreferences } from './db.js';
import { analyzePost, detectionLatencyMs, extractLocationSignals, normalizeText, notificationEligible, stableOpportunityKey } from './pipeline.js';
import type { DetectionRule, NormalizedPost } from './types.js';

const post: NormalizedPost = {
  source: 'bluesky', sourceId: 'at://did/post/1', authorName: 'A', authorHandle: 'a', authorUrl: '', sourceUrl: '',
  text: "We're hiring a remote backend engineer and TypeScript contractor. DM me if interested.", publishedAt: new Date('2026-11-16T10:00:00Z')
};
const rules: DetectionRule[] = [
  { id: '1', name: 'Hiring', pattern: "we're hiring", match_type: 'phrase', category: 'hiring', weight: 20, negative: false, enabled: true },
  { id: '2', name: 'Contract', pattern: 'contractor', match_type: 'phrase', category: 'contract', weight: 10, negative: false, enabled: true },
  { id: '3', name: 'Closed', pattern: 'hiring is closed', match_type: 'phrase', category: 'negative', weight: 0, negative: true, enabled: true }
];

describe('hiring signal pipeline', () => {
  it('normalizes punctuation and whitespace', () => expect(normalizeText('  We\u2019re   hiring\nnow  ')).toBe("We're hiring now"));
  it('matches configured phrases case-insensitively and scores explicit evidence', () => {
    const result = analyzePost(post, rules, defaultPreferences);
    expect(result.blocked).toBe(false);
    expect(result.matchedRules.map((rule) => rule.name)).toEqual(['Hiring', 'Contract']);
    expect(result.technologies).toContain('typescript');
    expect(result.employmentTypes).toContain('contract/freelance');
    expect(result.score).toBeGreaterThan(55);
    expect(result.breakdown.map((item) => item.label)).toContain('Remote preference');
    expect(result.category).toBe('direct_hiring');
    expect(result.signalQuality).toBeGreaterThan(70);
    expect(result.contactMethods.some((method) => method.type === 'dm')).toBe(true);
  });
  it('blocks obvious closed or historical matches', () => {
    const result = analyzePost({ ...post, text: 'We are hiring is closed now.' }, rules, defaultPreferences);
    expect(result.blocked).toBe(true);
    expect(result.score).toBe(0);
  });
  it('uses stable source IDs for deduplication and preserves non-negative latency', () => {
    expect(stableOpportunityKey('hacker_news', '123')).toBe('hacker_news:123');
    expect(stableOpportunityKey('hacker_news', '123')).toBe(stableOpportunityKey('hacker_news', '123'));
    expect(detectionLatencyMs(new Date('2026-11-16T10:01:00Z'), new Date('2026-11-16T10:00:00Z'))).toBe(0);
    expect(detectionLatencyMs(new Date('2026-11-16T09:59:00Z'), new Date('2026-11-16T10:00:00Z'))).toBe(60_000);
  });
  it('does not notify recovered old posts unless enabled', () => {
    const firstSeen = new Date('2026-11-16T10:00:00Z');
    const published = new Date('2026-11-16T08:00:00Z');
    const analysis = analyzePost(post, rules, defaultPreferences);
    expect(notificationEligible(analysis, true, { ...defaultPreferences, notifyRecovered: false })).toBe(false);
    expect(notificationEligible(analysis, true, { ...defaultPreferences, notifyRecovered: true })).toBe(true);
    expect(notificationEligible({ ...analysis, personalRelevance: 20, score: 20 }, false, { ...defaultPreferences, notifyRecovered: true })).toBe(false);
  });
  it('suppresses templated job-board advertisements while retaining them for review', () => {
    const result = analyzePost({ ...post, text: '🚀 New Remote Job Alert! Position: Software Engineer Company: Example Corp Location: USA Apply now: https://jobs.example.com/1 #RemoteJobs #Hiring' }, rules, defaultPreferences);
    expect(result.category).toBe('aggregated_listing');
    expect(result.suppressed).toBe(true);
    expect(result.signalQuality).toBeLessThan(20);
  });
  it('recognizes concrete software development demand', () => {
    const result = analyzePost({ ...post, text: 'Does anyone know a reliable freelance programmer to build an internal dashboard and integrate Stripe? DM me.' }, rules, defaultPreferences);
    expect(result.category).toBe('software_request');
    expect(result.contactMethods.some((method) => method.type === 'dm')).toBe(true);
  });
  it('uses exact registry evidence to suppress syndicated listings without matching a company name', () => {
    const result = analyzePost({ ...post, text: "We're hiring a remote backend engineer. Apply here: https://nearskill.in/jobs/123" }, rules, defaultPreferences, {}, [{ match_type: 'domain', pattern: 'nearskill.in', label: 'NearSkill' }]);
    expect(result.category).toBe('aggregated_listing');
    expect(result.suppressed).toBe(true);
    expect(result.classificationReasons.join(' ')).toContain('NearSkill');
  });
  it('extracts explicit work mode, location constraints, and timezone evidence', () => {
    const worldwide = analyzePost({ ...post, text: "We're hiring remotely worldwide; Taiwan and UTC+8 overlap are welcome." }, rules, defaultPreferences);
    expect(worldwide.locationSignals.workMode).toBe('remote');
    expect(worldwide.locationSignals.locations).toContain('Taiwan');
    expect(worldwide.locationSignals.constraint).toBe('allowed');
    expect(worldwide.locationSignals.timezoneRequirements).toContain('UTC+8');
    expect(worldwide.locationFit).toBe('excellent');

    const restricted = analyzePost({ ...post, text: "We're hiring a backend engineer, remote in the United States only. No visa sponsorship." }, rules, defaultPreferences);
    expect(restricted.locationSignals.workMode).toBe('remote');
    expect(restricted.locationSignals.locations).toContain('United States');
    expect(restricted.locationSignals.constraint).toBe('restricted');
    expect(restricted.locationFit).toBe('poor');

    const apac = analyzePost({ ...post, text: "We're hiring a remote engineer. APAC hours preferred." }, rules, defaultPreferences);
    expect(apac.locationFit).toBe('excellent');

    const arbitraryCountry = analyzePost({ ...post, text: "We're hiring remote - Jordan. Applicants must already have work authorization." }, rules, defaultPreferences);
    expect(arbitraryCountry.locationSignals.locations).toContain('Jordan');
    expect(arbitraryCountry.locationSignals.constraint).toBe('restricted');
    expect(analyzePost({ ...post, text: 'We are hiring and grateful to all of us.' }, rules, defaultPreferences).locationSignals.locations).not.toContain('United States');
  });
  it('derives broad regions from normalized countries and exposes worldwide coverage', () => {
    expect(extractLocationSignals('Taipei, Taiwan').regions).toEqual(expect.arrayContaining(['Asia', 'APAC']));
    expect(extractLocationSignals('Remote worldwide').regions).toContain('Worldwide');
  });
});
