import { describe, expect, it } from 'vitest';
import { instanceBase, stripHtml } from './sources/mastodon.js';
import { redditPostUrl } from './sources/reddit.js';
import { blueskyActor, parseBlueskyFeed, parseMastodonStatuses } from './company-social.js';

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
});
