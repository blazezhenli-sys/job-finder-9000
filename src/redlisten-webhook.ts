import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { NormalizedPost } from './types.js';

type RedlistenAuthor = { name?: unknown; id?: unknown };
type RedlistenCommunity = { name?: unknown } | string | null;

export type RedlistenWebhookPayload = {
  id?: unknown;
  kind?: unknown;
  created_at?: unknown;
  first_seen_at?: unknown;
  title?: unknown;
  body?: unknown;
  permalink?: unknown;
  url?: unknown;
  author?: RedlistenAuthor | null;
  community?: RedlistenCommunity;
  status?: unknown;
  cursor?: unknown;
  stream_id?: unknown;
  [key: string]: unknown;
};

export type NormalizedRedlistenWebhook = {
  post: NormalizedPost;
  cursor?: string;
};

export function verifyRedlistenSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const providedBuffer = Buffer.from(signature.trim(), 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function isoDate(value: unknown): Date | undefined {
  const date = new Date(text(value));
  return text(value) && !Number.isNaN(date.getTime()) ? date : undefined;
}
export function normalizeRedlistenWebhook(payload: unknown): NormalizedRedlistenWebhook | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const value = payload as RedlistenWebhookPayload;
  const sourceId = text(value.id);
  const publishedAt = isoDate(value.created_at) ?? isoDate(value.first_seen_at);
  if (!sourceId || !publishedAt) return undefined;

  const title = text(value.title);
  const body = text(value.body);
  const postText = [title, body].filter(Boolean).join('\n');
  if (!postText) return undefined;

  const authorName = text(value.author?.name) || '[deleted]';
  const authorId = text(value.author?.id) || authorName;
  const authorHandle = `u/${authorName}`;
  const permalink = text(value.permalink) || text(value.url) || `https://www.reddit.com/comments/${sourceId.replace(/^(t[13]_)/, '')}`;
  const streamId = text(value.stream_id);
  const cursor = text(value.cursor);

  return {
    post: {
      source: 'reddit',
      sourceId,
      authorId,
      authorName,
      authorHandle,
      authorUrl: authorName === '[deleted]' ? 'https://www.reddit.com' : `https://www.reddit.com/user/${encodeURIComponent(authorName)}`,
      sourceUrl: permalink,
      text: postText,
      publishedAt,
      raw: payload
    },
    cursor: cursor ? (streamId ? `${streamId}:${cursor}` : cursor) : undefined
  };
}
