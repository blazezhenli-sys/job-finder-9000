import { describe, expect, it } from 'vitest';
import { extractCareerUrl, extractRelevantPageUrls, extractSocialLinks, fetchCompanyEnrichment } from './enrichment.js';

describe('company social enrichment', () => {
  it('selects bounded relevant same-site pages and excludes external links', () => {
    const urls = extractRelevantPageUrls(`<a href="/contact">Contact</a>
      <a href="https://www.example.com/about-us">About us</a>
      <a href="/careers">Careers</a>
      <a href="https://external.example/contact">External</a>
      <a href="/blog">Blog</a>`, 'https://example.com');
    expect(urls).toEqual(['https://example.com/careers', 'https://example.com/contact', 'https://www.example.com/about-us']);
  });

  it('extracts homepage and successful linked-page emails while preserving failed-page history boundaries', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/about')) return new Response('unavailable', { status: 503, headers: { 'content-type': 'text/html' } });
      if (url.endsWith('/contact')) return new Response('<p>contact@example.com</p>', { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response('<a href="/contact">Contact</a><a href="/about">About</a><p>hello@example.com</p>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    try {
      const enrichment = await fetchCompanyEnrichment('https://example.com');
      expect(enrichment.emails.map((email) => email.email)).toEqual(['contact@example.com', 'hello@example.com']);
      expect(enrichment.pagesFetched).toBe(2);
      expect(enrichment.scannedEmailPageUrls).toEqual(['https://example.com/', 'https://example.com/contact']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('extracts explicit social profiles from JSON-LD and HTML links', () => {
    const links = extractSocialLinks(`<script type="application/ld+json">{"@type":"Organization","sameAs":["https://www.linkedin.com/company/example/?trk=footer","https://github.com/example"]}</script>
      <footer><a href="https://x.com/example?utm_source=footer">X</a><a href="https://example.com/about">About</a></footer>`, 'https://example.com');
    expect(links).toEqual([
      { platform: 'github', profileUrl: 'https://github.com/example', sourceUrl: 'https://example.com' },
      { platform: 'linkedin', profileUrl: 'https://linkedin.com/company/example', sourceUrl: 'https://example.com' },
      { platform: 'x', profileUrl: 'https://x.com/example', sourceUrl: 'https://example.com' }
    ]);
  });

  it('accepts rel=me profiles and ignores non-social links', () => {
    const links = extractSocialLinks('<link rel="me" href="https://bsky.app/profile/example.com"><a href="https://example.com/contact">Contact</a>', 'https://example.com');
    expect(links).toEqual([{ platform: 'bluesky', profileUrl: 'https://bsky.app/profile/example.com', sourceUrl: 'https://example.com' }]);
  });

  it('ignores Instagram posts and other content routes', () => {
    const links = extractSocialLinks(`<a href="https://instagram.com/example_company">Profile</a>
      <a href="https://instagram.com/p/ABC123/">Post</a>
      <a href="https://www.instagram.com/reel/XYZ789/">Reel</a>
      <a href="https://instagram.com/stories/example_company/123456/">Story</a>
      <a href="https://instagram.com/explore/tags/hiring/">Explore</a>`, 'https://example.com');
    expect(links).toEqual([{ platform: 'instagram', profileUrl: 'https://instagram.com/example_company', sourceUrl: 'https://example.com' }]);
  });

  it('finds an explicit company careers link, including an ATS destination', () => {
    expect(extractCareerUrl('<a href="/about">About</a><a href="https://jobs.ashbyhq.com/example">View open roles</a>', 'https://example.com')).toBe('https://jobs.ashbyhq.com/example');
  });

  it('preserves Facebook page IDs in profile.php links', () => {
    expect(extractSocialLinks('<a href="https://facebook.com/profile.php?id=12345">Facebook</a>', 'https://example.com'))
      .toEqual([{ platform: 'facebook', profileUrl: 'https://facebook.com/profile.php?id=12345', sourceUrl: 'https://example.com' }]);
  });

  it('canonicalizes social content URLs to profile URLs', () => {
    const links = extractSocialLinks(`<a href="https://linkedin.com/company/example/posts">LinkedIn posts</a>
      <a href="https://www.linkedin.com/company/example/about">LinkedIn about</a>
      <a href="https://twitter.com/example/status/123">X post</a>
      <a href="https://x.com/example">X profile</a>`, 'https://example.com');
    expect(links).toEqual([
      { platform: 'linkedin', profileUrl: 'https://linkedin.com/company/example', sourceUrl: 'https://example.com' },
      { platform: 'x', profileUrl: 'https://x.com/example', sourceUrl: 'https://example.com' }
    ]);
  });

  it('canonicalizes YouTube channel URLs and ignores video routes', () => {
    const links = extractSocialLinks(`<a href="https://youtube.com/@example/videos">Videos</a>
      <a href="https://youtube.com/channel/UC123">Channel</a>
      <a href="https://youtube.com/watch?v=video123">Video</a>`, 'https://example.com');
    expect(links).toEqual([
      { platform: 'youtube', profileUrl: 'https://youtube.com/@example', sourceUrl: 'https://example.com' },
      { platform: 'youtube', profileUrl: 'https://youtube.com/channel/UC123', sourceUrl: 'https://example.com' }
    ]);
  });
});
