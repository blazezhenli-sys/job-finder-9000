import { describe, expect, it } from 'vitest';
import { instanceBase, stripHtml } from './sources/mastodon.js';
import { redditPostUrl } from './sources/reddit.js';

describe('social source adapters', () => {
  it('normalizes Mastodon instances and strips status HTML', () => {
    expect(instanceBase('mastodon.social')).toBe('https://mastodon.social');
    expect(stripHtml('<p>We&rsquo;re hiring<br>an engineer &amp; contractor.</p>')).toBe("We're hiring\nan engineer & contractor.");
  });

  it('builds stable public Reddit links', () => {
    expect(redditPostUrl('/r/forhire/comments/abc/title/')).toBe('https://www.reddit.com/r/forhire/comments/abc/title/');
    expect(redditPostUrl(undefined)).toBe('https://www.reddit.com');
  });
});
