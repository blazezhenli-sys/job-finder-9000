import { describe, expect, it } from 'vitest';
import { defaultXSearchQuery, parseXSearchFeed, xSearchFeedUrl } from './x.js';

describe('X post search source', () => {
  it('builds the RSSHub keyword route with the full search query', () => {
    const url = xSearchFeedUrl(defaultXSearchQuery);
    expect(url).toContain('/twitter/keyword/');
    expect(decodeURIComponent(url.split('/twitter/keyword/')[1])).toBe(defaultXSearchQuery);
  });

  it('normalizes RSSHub search results into global X posts and filters old/reshared items', () => {
    const feed = `<rss><channel>
      <item><guid>x-1</guid><link>https://x.com/acme/status/1</link><pubDate>2026-11-23T10:00:00Z</pubDate><dc:creator>Acme</dc:creator><description><![CDATA[We're hiring engineers.]]></description></item>
      <item><guid>x-old</guid><link>https://x.com/acme/status/old</link><pubDate>2026-11-01T10:00:00Z</pubDate><description>Now hiring</description></item>
      <item><guid>x-repost</guid><link>https://x.com/acme/status/repost</link><pubDate>2026-11-23T10:00:00Z</pubDate><title>Repost someone</title><description>Hiring</description></item>
    </channel></rss>`;
    const posts = parseXSearchFeed(feed, new Date('2026-11-20T00:00:00Z'));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ source: 'x', sourceId: 'x-1', authorName: 'Acme', sourceUrl: 'https://x.com/acme/status/1' });
  });
});
