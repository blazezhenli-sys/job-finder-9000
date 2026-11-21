export type EmailCategory = 'recruiting' | 'careers' | 'hiring' | 'applications' | 'contact' | 'support' | 'sales' | 'press' | 'legal' | 'privacy' | 'personal' | 'other';
export type EmailSourceType = 'company_page' | 'job_listing';

export type EmailObservation = {
  email: string;
  category: EmailCategory;
  sourceType: EmailSourceType;
  sourceUrl: string;
  evidence: string;
};

const emailPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
const categoryPatterns: Array<[EmailCategory, RegExp]> = [
  ['privacy', /\b(privacy|gdpr|data-protection)\b/i],
  ['legal', /\b(legal|compliance|counsel)\b/i],
  ['press', /\b(press|media|newsroom|communications)\b/i],
  ['sales', /\b(sales|business-development|partnerships|partners)\b/i],
  ['support', /\b(support|help|customer-service|customerservice|technical)\b/i],
  ['recruiting', /\b(recruit|recruiting|recruiter|talent|people|hr)\b/i],
  ['careers', /\b(career|careers|jobs|job)\b/i],
  ['hiring', /\b(hiring|hire|employment)\b/i],
  ['applications', /\b(apply|application|applicants?)\b/i],
  ['contact', /\b(contact|hello|hi|info|office|general|inquiries|enquiries)\b/i]
];

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x2f;|&#47;/gi, '/')
    .replace(/&#x40;|&#64;/gi, '@')
    .replace(/&#x2e;|&#46;/gi, '.')
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
      const number = Number.parseInt(code, 16);
      return Number.isFinite(number) ? String.fromCodePoint(number) : _;
    })
    .replace(/&#(\d+);/g, (_, code: string) => {
      const number = Number(code);
      return Number.isFinite(number) ? String.fromCodePoint(number) : _;
    });
}

function text(value: string): string {
  return decodeHtml(value).replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

function htmlToText(value: string): string {
  return text(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
}

function normalizeObfuscation(value: string): string {
  return text(value)
    .replace(/\s*(?:\[|\(|\{|\b)\s*at\s*(?:\]|\)|\}|\b)\s*/gi, '@')
    .replace(/\s*(?:\[|\(|\{|\b)\s*dot\s*(?:\]|\)|\}|\b)\s*/gi, '.');
}

function cleanCandidate(value: string): string {
  return value
    .replace(/^mailto:/i, '')
    .split(/[?#]/, 1)[0]
    .replace(/^[<(\[{'"\s]+|[)>\],;:'".!?}\s]+$/g, '')
    .toLowerCase();
}

function validEmail(value: string): boolean {
  if (value.length > 254 || value.includes('..')) return false;
  const [local, domain] = value.split('@');
  return Boolean(local && domain && local.length <= 64 && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.'));
}

function categoryFor(email: string, context: string): EmailCategory {
  const local = email.split('@', 1)[0];
  for (const [category, pattern] of categoryPatterns) if (pattern.test(local)) return category;
  if (/^[a-z]+[._-][a-z]+(?:[._-][a-z]+)?$/i.test(local)) return 'personal';
  for (const [category, pattern] of categoryPatterns) if (pattern.test(context)) return category;
  return 'other';
}

function candidateContext(value: string, start: number, end: number): string {
  return value.slice(Math.max(0, start - 140), Math.min(value.length, end + 140));
}

export function extractEmails(value: string, sourceUrl: string, sourceType: EmailSourceType): EmailObservation[] {
  const html = decodeHtml(value);
  const visible = htmlToText(html);
  const candidates: Array<{ email: string; context: string }> = [];
  const addMatches = (input: string) => {
    for (const match of normalizeObfuscation(input).matchAll(emailPattern)) {
      const email = cleanCandidate(match[0]);
      if (validEmail(email)) candidates.push({ email, context: candidateContext(input, match.index ?? 0, (match.index ?? 0) + match[0].length) });
    }
  };
  for (const match of html.matchAll(/\bmailto:([^"'\s>]+)/gi)) {
    const email = cleanCandidate(match[1]);
    if (validEmail(email)) candidates.push({ email, context: candidateContext(html, match.index ?? 0, (match.index ?? 0) + match[0].length) });
  }
  addMatches(visible);
  addMatches(html);
  const found = new Map<string, EmailObservation>();
  for (const candidate of candidates) {
    const existing = found.get(candidate.email);
    const observation = { email: candidate.email, category: categoryFor(candidate.email, candidate.context), sourceType, sourceUrl, evidence: candidate.context };
    if (!existing || (existing.category === 'other' && observation.category !== 'other')) found.set(candidate.email, observation);
  }
  return [...found.values()].sort((a, b) => a.email.localeCompare(b.email));
}

export function emailSourceKey(prefix: string, email: string, sourceUrl: string): string {
  return `${prefix}:${email}:${sourceUrl}`;
}
