import { describe, expect, it } from 'vitest';
import { identityFromAtsHtml, identityFromListings, normalizeCompanyDomain, normalizeCompanyName } from './identity.js';

describe('company identity resolution', () => {
  it('normalizes company names and keeps ATS hosts out of company domains', () => {
    expect(normalizeCompanyName('Example, Inc.')).toBe('example');
    expect(normalizeCompanyDomain('https://www.example.com/careers')).toBe('example.com');
    expect(normalizeCompanyDomain('https://jobs.ashbyhq.com/example')).toBe('');
  });

  it('extracts a company name and domain from organization JSON-LD', () => {
    const identity = identityFromAtsHtml(`<html><head><title>Jobs at Example</title></head><body>
      <script type="application/ld+json">{"@type":"Organization","name":"Example, Inc.","url":"https://www.example.com"}</script>
    </body></html>`, 'ashby');
    expect(identity).toMatchObject({ name: 'Example, Inc.', domain: 'example.com', website: 'https://example.com', confidence: 'high' });
    expect(identity.sources).toContain('ats_board_page');
  });

  it('uses a listing payload company name without treating the ATS URL as a domain', () => {
    const identity = identityFromListings([{
      providerJobId: '1', title: 'Engineer', companyName: 'Example Co', description: '',
      applicationUrl: 'https://boards.greenhouse.io/example/jobs/1', originalUrl: 'https://boards.greenhouse.io/example/jobs/1',
      raw: { company_name: 'Example Co', company: { website: 'https://example.com' } }
    }]);
    expect(identity).toMatchObject({ name: 'Example Co', domain: 'example.com' });
  });
});
