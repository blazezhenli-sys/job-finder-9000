import { describe, expect, it } from 'vitest';
import { extractAtsBoardFromUrl, extractAtsBoardsFromText } from './discovery.js';

describe('ATS board discovery URL parsing', () => {
  it('extracts board identifiers from public job URLs', () => {
    expect(extractAtsBoardFromUrl('https://boards.greenhouse.io/anthropic/jobs/123')).toMatchObject({ provider: 'greenhouse', identifier: 'anthropic' });
    expect(extractAtsBoardFromUrl('https://jobs.ashbyhq.com/linear/abc-def')).toMatchObject({ provider: 'ashby', identifier: 'linear' });
    expect(extractAtsBoardFromUrl('https://jobs.lever.co/palantir/123')).toMatchObject({ provider: 'lever', identifier: 'palantir' });
    expect(extractAtsBoardFromUrl('https://jobs.ashbyhq.com/root.123')).toBeNull();
  });

  it('deduplicates ATS links found in a post while preserving provider coverage', () => {
    const found = extractAtsBoardsFromText('Greenhouse https://boards.greenhouse.io/acme/jobs/1 and again https://boards.greenhouse.io/acme/jobs/2; Ashby https://jobs.ashbyhq.com/startup/abc; unrelated https://example.com/job');
    expect(found.map((candidate) => `${candidate.provider}:${candidate.identifier}`)).toEqual(['greenhouse:acme', 'ashby:startup']);
    expect(found[0].sourceUrl).toContain('/jobs/1');
  });
});
