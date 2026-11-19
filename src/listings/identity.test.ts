import { describe, expect, it, vi } from 'vitest';
import { candidateCompanyDomains, identityFromAtsHtml, identityFromListings, normalizeCompanyDomain, normalizeCompanyName, resolveAtsBoardIdentity } from './identity.js';

describe('company identity resolution', () => {
  it('normalizes company names and keeps ATS hosts out of company domains', () => {
    expect(normalizeCompanyName('Example, Inc.')).toBe('example');
    expect(normalizeCompanyDomain('https://www.example.com/careers')).toBe('example.com');
    expect(normalizeCompanyDomain('https://jobs.ashbyhq.com/example')).toBe('');
    expect(normalizeCompanyDomain('https://www.greenhouse.com')).toBe('');
    expect(normalizeCompanyDomain('https://s8-recruiting.cdn.greenhouse.io/logo.png')).toBe('');
  });

  it('generates a bounded set of company-name domain candidates', () => {
    expect(candidateCompanyDomains('Fashion Nova', 'fashionnova')).toEqual([
      'fashionnova.com', 'fashionnova.ai', 'fashionnova.co', 'fashionnova.io', 'fashionnova.org'
    ]);
    expect(candidateCompanyDomains('', 'jobs')).toEqual([]);
  });

  it('extracts a company name and domain from organization JSON-LD', () => {
    const identity = identityFromAtsHtml(`<html><head><title>Jobs at Example</title></head><body>
      <script type="application/ld+json">{"@type":"Organization","name":"Example, Inc.","url":"https://www.example.com"}</script>
    </body></html>`, 'ashby');
    expect(identity).toMatchObject({ name: 'Example, Inc.', domain: 'example.com', website: 'https://example.com', confidence: 'high' });
    expect(identity.sources).toContain('ats_board_page');
  });

  it('extracts Ashby organization data embedded in the board bootstrap state', () => {
    const identity = identityFromAtsHtml(`<script>window.__appData = {"organization":{"name":"Linear","publicWebsite":"https://linear.app/","customJobsPageUrl":"https://linear.app/careers"},"posting":null};</script>`, 'ashby');
    expect(identity).toMatchObject({ name: 'Linear', domain: 'linear.app', website: 'https://linear.app' });
  });

  it('uses a listing payload company name without treating the ATS URL as a domain', () => {
    const identity = identityFromListings([{
      providerJobId: '1', title: 'Engineer', companyName: 'Example Co', description: '',
      applicationUrl: 'https://boards.greenhouse.io/example/jobs/1', originalUrl: 'https://boards.greenhouse.io/example/jobs/1',
      raw: { company_name: 'Example Co', company: { website: 'https://example.com' } }
    }]);
    expect(identity).toMatchObject({ name: 'Example Co', domain: 'example.com' });
  });

  it('extracts a company domain from an encoded Greenhouse listing-content link', () => {
    const identity = identityFromListings([{
      providerJobId: '2', title: 'Engineer', description: '',
      applicationUrl: 'https://job-boards.greenhouse.io/example/jobs/2', originalUrl: 'https://job-boards.greenhouse.io/example/jobs/2',
      raw: {
        company_name: 'Example Co',
        content: '&lt;p&gt;Learn more at &lt;a class=&quot;c-link&quot; href=&quot;https://example.com/careers&quot;&gt;example.com/careers&lt;/a&gt;&lt;/p&gt;'
      }
    }]);
    expect(identity).toMatchObject({ name: 'Example Co', domain: 'example.com', website: 'https://example.com' });
    expect(JSON.stringify(identity.evidence)).toContain('"listingContentDomain":"example.com"');
  });

  it('extracts a company domain from a careers URL in listing text', () => {
    const identity = identityFromListings([{
      providerJobId: '3', title: 'Engineer', description: '',
      applicationUrl: 'https://job-boards.greenhouse.io/example/jobs/3', originalUrl: 'https://job-boards.greenhouse.io/example/jobs/3',
      raw: { company_name: 'Example Co', content: 'Learn more about our company at https://example.com/careers.' }
    }]);
    expect(identity).toMatchObject({ name: 'Example Co', domain: 'example.com' });
  });

  it('does not treat an unrelated editorial link as the employer domain', () => {
    const identity = identityFromListings([{
      providerJobId: '4', title: 'Engineer', description: '',
      applicationUrl: 'https://job-boards.greenhouse.io/akido/jobs/4', originalUrl: 'https://job-boards.greenhouse.io/akido/jobs/4',
      raw: { company_name: 'Akido', content: '&lt;a href=&quot;https://www.fastcompany.com/999999/example&quot;&gt;Fast Company&lt;/a&gt;' }
    }]);
    expect(identity.domain).toBeUndefined();
  });

  it('does not treat relative career links as company domains', () => {
    const identity = identityFromAtsHtml('<a href="/about-us">About us</a><a href="/open-roles">Open roles</a>', 'greenhouse');
    expect(normalizeCompanyDomain('about-us')).toBe('');
    expect(identity.domain).toBeUndefined();
  });

  it('keeps the company portion of a descriptive careers title', () => {
    const identity = identityFromAtsHtml('<title>Careers at Securly | Remote-First K-12 EdTech Jobs</title>', 'greenhouse');
    expect(identity.name).toBe('Securly');
  });

  it('marks a Greenhouse company title as title-backed identity evidence', () => {
    const identity = identityFromAtsHtml('<title>Jobs at PRRI</title>', 'greenhouse');
    expect(identity).toMatchObject({ name: 'PRRI' });
    expect(identity.sources).toContain('ats_board_title');
  });

  it('validates a candidate domain against the returned company page', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, url: 'https://job-boards.greenhouse.io/fashionnova', text: async () => '<title>Jobs at Fashion Nova</title>' })
      .mockResolvedValueOnce({ ok: true, url: 'https://fashionnova.com/', headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<title>Fashion Nova | Careers</title>' });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const identity = await resolveAtsBoardIdentity('greenhouse', 'fashionnova', [{
        providerJobId: '5', title: 'Engineer', description: '', companyName: 'Fashion Nova',
        applicationUrl: 'https://job-boards.greenhouse.io/fashionnova/jobs/5', originalUrl: 'https://job-boards.greenhouse.io/fashionnova/jobs/5',
        raw: { company_name: 'Fashion Nova' }
      }]);
      expect(identity).toMatchObject({ domain: 'fashionnova.com', website: 'https://fashionnova.com', confidence: 'high' });
      expect(identity.sources).toContain('domain_candidate');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('can validate a non-generic board slug when the listing has no company name', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, url: 'https://job-boards.greenhouse.io/fixify', text: async () => '<title>Open Roles</title>' })
      .mockResolvedValueOnce({ ok: true, url: 'https://fixify.com/', headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<title>Fixify | Careers</title>' });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const identity = await resolveAtsBoardIdentity('greenhouse', 'fixify', [{
        providerJobId: '6', title: 'Engineer', description: '',
        applicationUrl: 'https://job-boards.greenhouse.io/fixify/jobs/6', originalUrl: 'https://job-boards.greenhouse.io/fixify/jobs/6',
        raw: {}
      }]);
      expect(identity).toMatchObject({ name: 'Fixify', domain: 'fixify.com' });
      expect(identity.sources).toContain('domain_candidate');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
