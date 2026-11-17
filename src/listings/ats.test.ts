import { describe, expect, it } from 'vitest';
import { parseAshbyJobs, parseGreenhouseJobs, parseLeverJobs, stripListingHtml } from './ats.js';

describe('ATS adapters', () => {
  it('normalizes Greenhouse postings and preserves the apply link', () => {
    const [job] = parseGreenhouseJobs({ jobs: [{ id: 42, title: 'Backend Engineer', content: '<p>Remote worldwide</p>', location: { name: 'Remote' }, absolute_url: 'https://boards.greenhouse.io/example/jobs/42', departments: [{ name: 'Engineering' }], updated_at: '2026-11-17T00:00:00Z' }] });
    expect(job.title).toBe('Backend Engineer');
    expect(job.description).toBe('Remote worldwide');
    expect(job.remoteMode).toBe('remote');
    expect(job.applicationUrl).toContain('/42');
    expect(job.department).toBe('Engineering');
  });

  it('normalizes Ashby remote metadata and compensation', () => {
    const [job] = parseAshbyJobs({ jobs: [{ id: 'ashby-1', title: 'Platform Engineer', descriptionHtml: '<p>Distributed team</p>', location: 'Anywhere', isRemote: true, department: 'Platform', jobUrl: 'https://jobs.ashbyhq.com/example/ashby-1', applyUrl: 'https://jobs.ashbyhq.com/example/ashby-1/application', compensation: { min: 100000 } }] });
    expect(job.providerJobId).toBe('ashby-1');
    expect(job.remoteMode).toBe('remote');
    expect(job.compensation).toEqual({ min: 100000 });
    expect(job.applicationUrl).toContain('/application');
  });

  it('normalizes Lever categories and plain text', () => {
    const [job] = parseLeverJobs([{ id: 'lever-1', text: 'Senior Developer', description: '<p>Work from anywhere</p>', categories: { location: 'APAC', commitment: 'Full-time', level: 'Senior' }, hostedUrl: 'https://jobs.lever.co/example/lever-1', applyUrl: 'https://jobs.lever.co/example/lever-1/apply' }]);
    expect(job.location).toBe('APAC');
    expect(job.employmentType).toBe('Full-time');
    expect(job.seniority).toBe('Senior');
    expect(job.remoteMode).toBe('remote');
    expect(stripListingHtml('&lt;p&gt;One&nbsp;two&lt;/p&gt;')).toBe('One two');
  });
});
