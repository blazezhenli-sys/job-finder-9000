import { describe, expect, it } from 'vitest';
import { instanceBase, stripHtml } from './sources/mastodon.js';
import { redditPostUrl } from './sources/reddit.js';
import { blueskyActor, parseBlueskyFeed, parseMastodonStatuses, parseRsshubFeed, rsshubFeedUrl } from './company-social.js';

describe('social source adapters', () => {
  it('normalizes Mastodon instances and strips status HTML', () => {
    expect(instanceBase('mastodon.social')).toBe('https://mastodon.social');
    expect(stripHtml('<p>We&rsquo;re hiring<br>an engineer &amp; contractor.</p>')).toBe("We're hiring\nan engineer & contractor.");
  });

  it('builds stable public Reddit links', () => {
    expect(redditPostUrl('/r/forhire/comments/abc/title/')).toBe('https://www.reddit.com/r/forhire/comments/abc/title/');
    expect(redditPostUrl(undefined)).toBe('https://www.reddit.com');
  });

  it('normalizes Bluesky company feeds and excludes replies and reposts', () => {
    expect(blueskyActor('https://bsky.app/profile/example.com')).toBe('example.com');
    const cutoff = new Date('2026-01-01T00:00:00Z');
    const posts = parseBlueskyFeed({ feed: [
      { post: { uri: 'at://did:plc:one/app.bsky.feed.post/one', url: 'https://bsky.app/profile/example.com/post/one', author: { did: 'did:plc:one', handle: 'example.com' }, record: { text: 'Company update', createdAt: '2026-01-02T00:00:00Z' } } },
      { post: { uri: 'at://did:plc:one/app.bsky.feed.post/two', author: { did: 'did:plc:one', handle: 'example.com' }, record: { text: 'Reply', createdAt: '2026-01-02T00:00:00Z', reply: { parent: {} } } } },
      { reason: { $type: 'app.bsky.feed.defs#reasonRepost' }, post: { uri: 'at://did:plc:one/app.bsky.feed.post/three', author: { did: 'did:plc:one', handle: 'example.com' }, record: { text: 'Repost', createdAt: '2026-01-02T00:00:00Z' } } }
    ] }, cutoff);
    expect(posts).toHaveLength(1);
    expect(posts[0].sourceUrl).toBe('https://bsky.app/profile/example.com/post/one');
  });

  it('normalizes public Mastodon statuses and excludes replies and boosts', () => {
    const cutoff = new Date('2026-01-01T00:00:00Z');
    const posts = parseMastodonStatuses([
      { id: '1', visibility: 'public', created_at: '2026-01-02T00:00:00Z', content: '<p>We&rsquo;re shipping.</p>', url: 'https://mastodon.social/@example/1', account: { id: 'acct', acct: 'example', display_name: 'Example' } },
      { id: '2', visibility: 'public', in_reply_to_id: 'parent', created_at: '2026-01-02T00:00:00Z', content: 'reply', account: { id: 'acct', acct: 'example' } },
      { id: '3', visibility: 'public', reblog: { id: 'other' }, created_at: '2026-01-02T00:00:00Z', content: 'boost', account: { id: 'acct', acct: 'example' } }
    ], cutoff);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toBe("We're shipping.");
  });

  it('builds RSSHub routes for LinkedIn and Facebook company profiles', () => {
    expect(rsshubFeedUrl('linkedin', 'https://www.linkedin.com/company/example/')).toBe('http://rsshub:1200/linkedin/company/example/posts');
    expect(rsshubFeedUrl('linkedin', 'https://linkedin.com/company/vitallyaus/posts')).toBe('http://rsshub:1200/linkedin/company/vitallyaus/posts');
    expect(rsshubFeedUrl('facebook', 'https://www.facebook.com/example')).toBe('http://rsshub:1200/facebook/page/example');
    expect(rsshubFeedUrl('facebook', 'https://www.facebook.com/pages/Example/12345')).toBe('http://rsshub:1200/facebook/page/12345');
    expect(rsshubFeedUrl('facebook', 'https://www.facebook.com/people/Example/12345')).toBe('http://rsshub:1200/facebook/page/12345');
    expect(rsshubFeedUrl('facebook', 'https://www.facebook.com/profile.php?id=12345')).toBe('http://rsshub:1200/facebook/page/12345');
    expect(rsshubFeedUrl('facebook', 'https://www.facebook.com/v.vital.ly/reviews')).toBe('http://rsshub:1200/facebook/page/v.vital.ly');
    expect(() => rsshubFeedUrl('linkedin', 'https://www.linkedin.com/in/example')).toThrow();
    expect(() => rsshubFeedUrl('facebook', 'https://www.facebook.com/profile.php')).toThrow();
  });

  it('parses RSS and Atom items, strips markup, filters old/reshared items, and deduplicates IDs', () => {
    const cutoff = new Date('2026-01-01T00:00:00Z');
    const feed = `<rss><channel>
      <item><guid>post-1</guid><link>https://www.linkedin.com/posts/example-1</link><title>Launch</title><description><![CDATA[<p>We&rsquo;re hiring &amp; growing.</p>]]></description><pubDate>Fri, 02 Jan 2026 12:00:00 GMT</pubDate></item>
      <item><guid>post-1</guid><link>https://www.linkedin.com/posts/example-1</link><title>Duplicate</title><pubDate>Fri, 02 Jan 2026 12:00:00 GMT</pubDate></item>
      <item><guid>old</guid><link>https://example.com/old</link><title>Old</title><pubDate>Fri, 01 Dec 2025 12:00:00 GMT</pubDate></item>
      <item><guid>share</guid><link>https://example.com/share</link><title>Shared a post</title><pubDate>Fri, 02 Jan 2026 12:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const atom = `<feed><entry><id>atom-1</id><link href="https://www.facebook.com/example/posts/1"/><title><![CDATA[Update]]></title><content><![CDATA[<p>New office.</p>]]></content><updated>2026-01-03T12:00:00Z</updated></entry></feed>`;
    const posts = parseRsshubFeed(feed, cutoff);
    const atomPosts = parseRsshubFeed(atom, cutoff);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ sourceId: 'post-1', sourceUrl: 'https://www.linkedin.com/posts/example-1', text: "We're hiring & growing." });
    expect(atomPosts).toHaveLength(1);
    expect(atomPosts[0]).toMatchObject({ sourceId: 'atom-1', sourceUrl: 'https://www.facebook.com/example/posts/1', text: 'New office.' });
  });
});
