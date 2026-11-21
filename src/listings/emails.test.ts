import { describe, expect, it } from 'vitest';
import { parseAdzunaJobs, parseAshbyJobs, parseGreenhouseJobs, parseLeverJobs, parseRemotiveJobs } from './ats.js';
import { extractEmails } from './emails.js';

describe('public email extraction', () => {
  it('extracts mailto, visible, HTML-encoded, and obfuscated addresses without duplicates', () => {
    const result = extractEmails(`<a href="mailto:Hiring@Example.com?subject=Role">Hiring us</a>
      <p>Contact recruiting [at] example [dot] com or &#x63;&#x6f;&#x6e;&#x74;&#x61;&#x63;&#x74;&#64;example.com.</p>
      <p>Hiring@Example.com</p>`, 'https://example.com/contact', 'company_page');
    expect(result.map((item) => item.email)).toEqual(['contact@example.com', 'hiring@example.com', 'recruiting@example.com']);
    expect(result.find((item) => item.email === 'hiring@example.com')?.category).toBe('hiring');
    expect(result.find((item) => item.email === 'contact@example.com')?.category).toBe('contact');
    expect(result.every((item) => item.sourceType === 'company_page')).toBe(true);
  });

  it('classifies recruiting, support, and personal-looking addresses while retaining all of them', () => {
    const result = extractEmails('Recruiting: talent@example.com · Support: help@example.com · Jane Doe: jane.doe@example.com', 'https://example.com/about', 'company_page');
    expect(Object.fromEntries(result.map((item) => [item.email, item.category]))).toEqual({
      'help@example.com': 'support',
      'jane.doe@example.com': 'personal',
      'talent@example.com': 'recruiting'
    });
  });

  it('rejects malformed addresses and keeps listing provenance', () => {
    const result = extractEmails('bad@example, @example.com, good@example.com.', 'https://jobs.example/role/1', 'job_listing');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ email: 'good@example.com', sourceType: 'job_listing', sourceUrl: 'https://jobs.example/role/1' });
  });

  it('extracts emails from every supported provider description shape', () => {
    const cases = [
      parseGreenhouseJobs({ jobs: [{ id: 1, title: 'Engineer', content: '<p>Apply: jobs@greenhouse.example</p>', absolute_url: 'https://boards.greenhouse.io/example/jobs/1' }] }),
      parseAshbyJobs({ jobs: [{ id: 'a', title: 'Engineer', descriptionHtml: '<p>hello@ashby.example</p>', jobUrl: 'https://jobs.ashbyhq.com/example/a', applyUrl: 'https://jobs.ashbyhq.com/example/a/apply' }] }),
      parseLeverJobs([{ id: 'l', text: 'Engineer', description: '<p>recruiting@lever.example</p>', hostedUrl: 'https://jobs.lever.co/example/l', applyUrl: 'https://jobs.lever.co/example/l/apply' }]),
      parseRemotiveJobs({ jobs: [{ id: 1, title: 'Engineer', description: '<p>contact@remotive.example</p>', url: 'https://remotive.example/jobs/1' }] }),
      parseAdzunaJobs({ results: [{ id: 'z', title: 'Engineer', description: '<p>hiring@adzuna.example</p>', redirect_url: 'https://adzuna.example/jobs/z', company: { display_name: 'Example' } }] })
    ];
    expect(cases.map((listings) => extractEmails(listings[0].descriptionHtml ?? listings[0].description, listings[0].originalUrl, 'job_listing')[0]?.email)).toEqual([
      'jobs@greenhouse.example', 'hello@ashby.example', 'recruiting@lever.example', 'contact@remotive.example', 'hiring@adzuna.example'
    ]);
  });
});
