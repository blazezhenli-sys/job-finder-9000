import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeRedlistenWebhook, verifyRedlistenSignature } from './redlisten-webhook.js';

describe('Redlisten webhooks', () => {
  const secret = 'redlisten-test-secret';
  const body = Buffer.from('{"id":"t3_example","title":"We are hiring","body":"Backend engineer"}');

  it('verifies the documented HMAC signature over the raw body', () => {
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(verifyRedlistenSignature(body, signature, secret)).toBe(true);
    expect(verifyRedlistenSignature(Buffer.from(`${body.toString()} `), signature, secret)).toBe(false);
    expect(verifyRedlistenSignature(body, 'sha256=invalid', secret)).toBe(false);
  });

  it('normalizes Reddit posts into the existing ingestion shape', () => {
    const normalized = normalizeRedlistenWebhook({
      id: 't3_example',
      kind: 'community_post',
      created_at: '2026-11-20T10:00:00Z',
      title: 'We are hiring',
      body: 'Backend engineer',
      permalink: 'https://www.reddit.com/r/forhire/comments/example/hiring/',
      author: { id: 't2_author', name: 'founder' },
      community: { name: 'forhire' },
      stream_id: 'st_example',
      cursor: '123'
    });
    expect(normalized).toMatchObject({ cursor: 'st_example:123', post: { source: 'reddit', sourceId: 't3_example', authorId: 't2_author', authorHandle: 'u/founder', text: 'We are hiring\nBackend engineer', sourceUrl: 'https://www.reddit.com/r/forhire/comments/example/hiring/' } });
  });

  it('normalizes comments and rejects content without an id or text', () => {
    const normalized = normalizeRedlistenWebhook({ id: 't1_comment', created_at: '2026-11-20T10:00:00Z', body: 'I can help', permalink: 'https://www.reddit.com/r/forhire/comments/example/_/comment/', author: { name: 'builder' }, community: 'forhire' });
    expect(normalized?.post.text).toBe('I can help');
    expect(normalizeRedlistenWebhook({ created_at: '2026-11-20T10:00:00Z', body: 'missing id' })).toBeUndefined();
    expect(normalizeRedlistenWebhook({ id: 't3_empty', created_at: '2026-11-20T10:00:00Z' })).toBeUndefined();
  });
});
