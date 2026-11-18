import { describe, expect, it } from 'vitest';
import { extractCompensationFromText, normalizeCompensation, parseAdzunaJobs, parseAshbyJobs, parseGreenhouseJobs, parseLeverJobs, parseRemotiveJobs, stripListingHtml } from './ats.js';

describe('ATS adapters', () => {
  it('normalizes structured and free-text compensation', () => {
    expect(normalizeCompensation({ min: 100000, max: 140000, currency: 'USD', interval: 'year' })).toMatchObject({ min: 100000, max: 140000, currency: 'USD', period: 'year' });
    expect(normalizeCompensation('$120k - $150k USD per year')).toMatchObject({ min: 120000, max: 150000, currency: 'USD', period: 'year' });
    expect(normalizeCompensation('€80k–€110k per annum')).toMatchObject({ min: 80000, max: 110000, currency: 'EUR', period: 'annum' });
    expect(extractCompensationFromText('Databricks is the Data and AI company. More than 20,000 organizations worldwide. Salary range: $120,000–$150,000 per year.')).toMatchObject({ min: 120000, max: 150000, currency: 'USD', period: 'year' });
  });

  it('normalizes Greenhouse postings and preserves the apply link', () => {
    const [job] = parseGreenhouseJobs({ jobs: [{ id: 42, title: 'Backend Engineer', content: '<p>Remote worldwide</p>', location: { name: 'Remote' }, absolute_url: 'https://boards.greenhouse.io/example/jobs/42', departments: [{ name: 'Engineering' }], updated_at: '2026-11-17T00:00:00Z' }] });
    expect(job.title).toBe('Backend Engineer');
    expect(job.description).toBe('Remote worldwide');
    expect(job.remoteMode).toBe('remote');
    expect(job.applicationUrl).toContain('/42');
    expect(job.department).toBe('Engineering');
  });

  it('extracts salary disclosures from Greenhouse content', () => {
    const [job] = parseGreenhouseJobs({ jobs: [{ id: 43, title: 'Data Engineer', content: '<p>More than 20,000 organizations worldwide.</p><p>Base salary: $120,000 - $150,000 per year.</p>', absolute_url: 'https://boards.greenhouse.io/example/jobs/43' }] });
    expect(job.compensation).toMatchObject({ min: 120000, max: 150000, currency: 'USD', period: 'year' });
  });

  it('normalizes Ashby remote metadata and compensation', () => {
    const [job] = parseAshbyJobs({ jobs: [{ id: 'ashby-1', title: 'Platform Engineer', descriptionHtml: '<p>Distributed team</p>', location: 'Anywhere', isRemote: true, department: 'Platform', jobUrl: 'https://jobs.ashbyhq.com/example/ashby-1', applyUrl: 'https://jobs.ashbyhq.com/example/ashby-1/application', compensation: { min: 100000 } }] });
    expect(job.providerJobId).toBe('ashby-1');
    expect(job.remoteMode).toBe('remote');
    expect(job.compensation).toMatchObject({ min: 100000 });
    expect(job.applicationUrl).toContain('/application');
  });

  it('normalizes Ashby nested compensation summaries', () => {
    const [job] = parseAshbyJobs({ jobs: [{ id: 'ashby-2', title: 'Platform Engineer', descriptionPlain: 'Distributed team', jobUrl: 'https://jobs.ashbyhq.com/example/ashby-2', compensation: { compensationTierSummary: '$81K – $87K • 0.5% – 1.75% • Offers Bonus', scrapeableCompensationSalarySummary: '$81K - $87K', summaryComponents: [{ summary: '$81K - $87K', minValue: 81000, maxValue: 87000, currencyCode: 'USD', interval: '1 YEAR' }] } }] });
    expect(job.compensation).toMatchObject({ min: 81000, max: 87000, currency: 'USD' });
  });

  it('normalizes Lever categories and plain text', () => {
    const [job] = parseLeverJobs([{ id: 'lever-1', text: 'Senior Developer', description: '<p>Work from anywhere</p>', categories: { location: 'APAC', commitment: 'Full-time', level: 'Senior' }, hostedUrl: 'https://jobs.lever.co/example/lever-1', applyUrl: 'https://jobs.lever.co/example/lever-1/apply' }]);
    expect(job.location).toBe('APAC');
    expect(job.employmentType).toBe('Full-time');
    expect(job.seniority).toBe('Senior');
    expect(job.remoteMode).toBe('remote');
    expect(stripListingHtml('&lt;p&gt;One&nbsp;two&lt;/p&gt;')).toBe('One two');
  });

  it('extracts salary from Lever fields and descriptions', () => {
    const [fieldJob] = parseLeverJobs([{ id: 'lever-2', text: 'Staff Developer', description: '<p>Remote role</p>', salaryDescription: '$160k - $190k USD annually', hostedUrl: 'https://jobs.lever.co/example/lever-2' }]);
    expect(fieldJob.compensation).toMatchObject({ min: 160000, max: 190000, currency: 'USD', period: 'annually' });
    const [descriptionJob] = parseLeverJobs([{ id: 'lever-3', text: 'Developer', description: '<p>Compensation: $100,000–$130,000 per year.</p>', hostedUrl: 'https://jobs.lever.co/example/lever-3' }]);
    expect(descriptionJob.compensation).toMatchObject({ min: 100000, max: 130000, currency: 'USD', period: 'year' });
    const [htmlJob] = parseLeverJobs([{ id: 'lever-4', text: 'Developer', description: '<p>Remote role</p>', salaryDescriptionHtml: '<p>$140,000 - $170,000 USD annually</p>', hostedUrl: 'https://jobs.lever.co/example/lever-4' }]);
    expect(htmlJob.compensation).toMatchObject({ min: 140000, max: 170000, currency: 'USD', period: 'annually' });
  });

  it('normalizes aggregator postings with employer and geographic restriction data', () => {
    const [remotive] = parseRemotiveJobs({ jobs: [{ id: 7, title: 'Remote TypeScript Engineer', company_name: 'Example Co', description: '<p>Work anywhere in Europe</p>', url: 'https://remotive.com/jobs/7', candidate_required_location: 'Europe', job_type: 'full_time', publication_date: '2026-11-17T00:00:00Z' }] });
    expect(remotive.companyName).toBe('Example Co');
    expect(remotive.remoteMode).toBe('remote');
    expect(remotive.geographicRestrictions).toEqual(['Europe']);

    const [adzuna] = parseAdzunaJobs({ results: [{ id: 'a-1', title: 'Backend Developer', description: 'Remote role', redirect_url: 'https://jobs.example/1', company: { display_name: 'Adzuna Co' }, location: { display_name: 'Singapore' }, contract_time: 'full_time' }] });
    expect(adzuna.companyName).toBe('Adzuna Co');
    expect(adzuna.location).toBe('Singapore');
    expect(adzuna.applicationUrl).toContain('/1');
  });
});
