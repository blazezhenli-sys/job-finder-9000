import { describe, expect, it } from 'vitest';
import { extractCareerUrl, extractSocialLinks } from './enrichment.js';

describe('company social enrichment', () => {
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
});
