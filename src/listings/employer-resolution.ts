import type { PoolClient } from 'pg';
import type { AtsProvider } from '../types.js';
import { isAtsDomain, normalizeCompanyDomain, normalizeCompanyName, type CompanyIdentity } from './identity.js';

export type EmployerRow = { id: string; name: string; website: string; verified_domain: string; identity_domain: string; identity_name_source: string; identity_domain_source: string };

type BoardIdentityInput = {
  boardId?: string;
  currentEmployerId?: string | null;
  provider: Extract<AtsProvider, 'greenhouse' | 'ashby' | 'lever'>;
  boardIdentifier: string;
  identity: CompanyIdentity;
  provisionalName?: string;
};

function domainForEmployer(row: EmployerRow): string {
  return normalizeCompanyDomain(row.identity_domain) || normalizeCompanyDomain(row.verified_domain) || normalizeCompanyDomain(row.website);
}

function isUsableName(value: string): boolean {
  const normalized = normalizeCompanyName(value);
  return normalized.length >= 3 && !/^(greenhouse|ashby|lever|jobs|careers|jobboard)$/.test(normalized);
}

async function employers(client: PoolClient): Promise<EmployerRow[]> {
  const result = await client.query(`SELECT id, name, website, verified_domain, identity_domain, identity_name_source, identity_domain_source FROM employers`);
  return result.rows as EmployerRow[];
}

function hasStrongBoardIdentity(identity: CompanyIdentity): boolean {
  return Boolean(identity.domain && normalizeCompanyDomain(identity.domain));
}

function hasUsableCurrentIdentity(row: EmployerRow): boolean {
  return Boolean(domainForEmployer(row)) && !isAtsDomain(row.website);
}

export function matchEmployer(rows: EmployerRow[], identity: CompanyIdentity, currentEmployerId?: string | null): EmployerRow | undefined {
  const current = rows.find((row) => row.id === currentEmployerId);
  // A manually attached board is an explicit user decision. Keep it attached
  // even if the public page suggests another identity.
  if (current && (current.identity_name_source === 'manual' || current.identity_domain_source === 'manual')) return current;
  const domain = identity.domain ? normalizeCompanyDomain(identity.domain) : '';
  if (domain) {
    const matches = rows.filter((row) => domainForEmployer(row) === domain);
    if (matches.length === 1) return matches[0];
  }
  // A redirect-backed name is useful for legitimate domain changes (for
  // example, an old ATS board now redirecting to the company's new domain).
  // Do not apply this to title-only names, which are often just page copy.
  const name = identity.name && isUsableName(identity.name) ? normalizeCompanyName(identity.name) : '';
  if (name && (identity.sources.includes('ats_redirect') || identity.sources.includes('ats_board_title'))) {
    const matches = rows.filter((row) => normalizeCompanyName(row.name) === name);
    if (matches.length === 1) return matches[0];
  }
  // Names from page titles and social metadata are not unique enough to move
  // a board between employers. If a strong identity disagrees with the
  // current employer, let the caller create a new entity instead.
  if (hasStrongBoardIdentity(identity)) return undefined;
  // A title such as "Jobs at Example" is strong enough to repair a board
  // that is currently attached to an entity whose only identity is an ATS
  // host. This does not permit title-only reassignment from a real company.
  if (current && identity.sources.includes('ats_board_title') && name && !hasUsableCurrentIdentity(current)
    && normalizeCompanyName(current.name) !== name) return undefined;
  return current;
}

function shouldPreserve(source: string): boolean {
  return source === 'manual';
}

async function updateIdentity(client: PoolClient, employer: EmployerRow, identity: CompanyIdentity, provisionalName?: string) {
  const name = identity.name || provisionalName || '';
  const domain = identity.domain ? normalizeCompanyDomain(identity.domain) : '';
  const nameSource = identity.sources.find((source) => source === 'ats_board_page' || source === 'ats_board_title' || source === 'ats_payload' || source === 'ats_redirect') || (name ? 'ats_slug' : 'legacy');
  const domainSource = domain
    ? (identity.sources.includes('domain_candidate') ? 'domain_candidate' : identity.sources.includes('ats_redirect') ? 'ats_redirect' : identity.sources.includes('ats_board_page') ? 'ats_board_page' : 'ats_payload')
    : '';
  const assignments: string[] = ['identity_last_observed_at=now()', 'identity_evidence=$1', 'identity_confidence=$2'];
  const values: unknown[] = [JSON.stringify(identity.evidence), identity.confidence];
  if (name && !shouldPreserve(employer.identity_name_source) && (employer.identity_name_source === 'legacy' || employer.identity_name_source === 'ats_slug' || !employer.name)) {
    values.push(name); assignments.push(`name=$${values.length}`);
    values.push(nameSource); assignments.push(`identity_name_source=$${values.length}`);
  }
  if (domain && !shouldPreserve(employer.identity_domain_source)) {
    values.push(domain); assignments.push(`identity_domain=$${values.length}`);
    values.push(domainSource); assignments.push(`identity_domain_source=$${values.length}`);
    if (!employer.website || isAtsDomain(employer.website) || normalizeCompanyDomain(employer.website) === '') {
      values.push(`https://${domain}`); assignments.push(`website=$${values.length}`);
    }
  }
  values.push(employer.id);
  await client.query(`UPDATE employers SET ${assignments.join(', ')}, updated_at=now() WHERE id=$${values.length}`, values);
}

export async function ensureEmployerForBoard(client: PoolClient, input: BoardIdentityInput): Promise<string> {
  const rows = await employers(client);
  const matched = matchEmployer(rows, input.identity, input.currentEmployerId);
  if (matched) {
    await updateIdentity(client, matched, input.identity, input.provisionalName);
    if (input.boardId && matched.id !== input.currentEmployerId) await client.query('UPDATE job_boards SET employer_id=$1, updated_at=now() WHERE id=$2', [matched.id, input.boardId]);
    return matched.id;
  }
  const name = input.identity.name || input.provisionalName || input.boardIdentifier;
  const domain = input.identity.domain ? normalizeCompanyDomain(input.identity.domain) : '';
  const inserted = await client.query(`INSERT INTO employers (name, website, identity_domain, identity_name_source, identity_domain_source, identity_confidence, identity_evidence, identity_last_observed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,now()) RETURNING id`, [name, domain ? `https://${domain}` : '', domain, input.identity.sources.find((source) => source === 'ats_board_page' || source === 'ats_board_title' || source === 'ats_payload' || source === 'ats_redirect' || source === 'domain_candidate') ?? (name ? 'ats_slug' : 'legacy'), domain ? (input.identity.sources.includes('domain_candidate') ? 'domain_candidate' : input.identity.sources.includes('ats_redirect') ? 'ats_redirect' : input.identity.sources.includes('ats_board_page') ? 'ats_board_page' : 'ats_payload') : 'legacy', input.identity.confidence, JSON.stringify(input.identity.evidence)]);
  const employerId = inserted.rows[0].id as string;
  if (input.boardId) await client.query('UPDATE job_boards SET employer_id=$1, updated_at=now() WHERE id=$2', [employerId, input.boardId]);
  return employerId;
}

export async function resolveExistingBoardEmployer(client: PoolClient, input: BoardIdentityInput): Promise<string> {
  return ensureEmployerForBoard(client, input);
}
