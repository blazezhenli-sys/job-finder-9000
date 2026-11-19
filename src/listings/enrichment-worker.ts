import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { events } from '../pipeline-service.js';
import { fetchCompanyEnrichment } from './enrichment.js';
import { normalizeCompanyDomain } from './identity.js';

let running = false;
const enrichmentBatchSize = 500;
const enrichmentScanBatchSize = 1_000;

type EnrichmentResult = { status: 'completed' | 'failed'; linksFound: number; careerUrl?: string; error?: string };

type EmployerEnrichmentCandidate = { website?: string; verified_domain?: string; identity_domain?: string };

function enrichmentWebsite(employer: EmployerEnrichmentCandidate): string {
  const website = String(employer.website ?? '').trim();
  if (normalizeCompanyDomain(website)) return website;
  for (const value of [employer.verified_domain, employer.identity_domain]) {
    const domain = normalizeCompanyDomain(String(value ?? ''));
    if (domain) return `https://${domain}`;
  }
  return '';
}

async function finishTask(taskId: string, employerId: string, result: EnrichmentResult) {
  await pool.query(`UPDATE company_enrichment_tasks SET status=$2, completed_at=now(), links_found=$3, career_url=$4, error=$5 WHERE id=$1`, [taskId, result.status, result.linksFound, result.careerUrl ?? '', result.error ?? null]);
  if (result.status === 'completed') {
    await pool.query(`UPDATE employers SET social_enrichment_last_attempted_at=now(), social_enrichment_last_success_at=now(), social_enrichment_next_at=now() + interval '30 days', social_enrichment_error=NULL, career_url=COALESCE(NULLIF($2,''), career_url), career_url_source=CASE WHEN $2='' THEN career_url_source ELSE 'company_homepage' END, updated_at=now() WHERE id=$1`, [employerId, result.careerUrl ?? '']);
  } else {
    await pool.query(`UPDATE employers SET social_enrichment_last_attempted_at=now(), social_enrichment_next_at=now() + interval '1 day', social_enrichment_error=$2, updated_at=now() WHERE id=$1`, [employerId, result.error ?? 'Enrichment failed']);
  }
  events.emit('company-enrichment-task', { taskId, employerId, ...result });
}

async function queueDueTasks(): Promise<Array<{ employerId: string; taskId: string }>> {
  const queued: Array<{ employerId: string; taskId: string }> = [];
  let offset = 0;
  while (queued.length < enrichmentBatchSize) {
    const employers = await pool.query(`SELECT id, website, verified_domain, identity_domain FROM employers
      WHERE (website <> '' OR verified_domain <> '' OR identity_domain <> '')
        AND (social_enrichment_next_at IS NULL OR social_enrichment_next_at <= now())
      ORDER BY social_enrichment_next_at NULLS FIRST, created_at, id
      LIMIT $1 OFFSET $2`, [enrichmentScanBatchSize, offset]);
    if (!employers.rows.length) break;
    for (const employer of employers.rows) {
      if (queued.length >= enrichmentBatchSize) break;
      if (!enrichmentWebsite(employer)) continue;
      const task = await pool.query(`INSERT INTO company_enrichment_tasks (employer_id, status) VALUES ($1,'queued') ON CONFLICT DO NOTHING RETURNING id`, [employer.id]);
      if (task.rows[0]) queued.push({ employerId: employer.id, taskId: task.rows[0].id });
    }
    if (employers.rows.length < enrichmentScanBatchSize) break;
    offset += employers.rows.length;
  }
  return queued;
}

async function processTask(task: { employerId: string; taskId: string }) {
  await pool.query(`UPDATE company_enrichment_tasks SET status='running', started_at=now() WHERE id=$1`, [task.taskId]);
  events.emit('company-enrichment-task', { taskId: task.taskId, employerId: task.employerId, status: 'running' });
  try {
    const employer = await pool.query('SELECT website, verified_domain, identity_domain FROM employers WHERE id=$1', [task.employerId]);
    const website = enrichmentWebsite(employer.rows[0] ?? {});
    if (!website) throw new Error('Company has no resolved public website');
    const enrichment = await fetchCompanyEnrichment(website);
    const links = enrichment.socialLinks;
    await withTransaction(async (client) => {
      for (const link of links) await client.query(`INSERT INTO company_social_links (employer_id, platform, profile_url, source_url) VALUES ($1,$2,$3,$4)
        ON CONFLICT (employer_id, platform, profile_url) DO UPDATE SET last_seen_at=now(), is_active=true, source_url=EXCLUDED.source_url, updated_at=now()`, [task.employerId, link.platform, link.profileUrl, link.sourceUrl]);
      await client.query(`UPDATE company_social_links SET is_active=false, updated_at=now() WHERE employer_id=$1 AND last_seen_at < now() - interval '1 second'`, [task.employerId]);
    });
    await finishTask(task.taskId, task.employerId, { status: 'completed', linksFound: links.length, careerUrl: enrichment.careerUrl });
  } catch (error) {
    await finishTask(task.taskId, task.employerId, { status: 'failed', linksFound: 0, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function enrichCompanies() {
  if (running) return;
  running = true;
  try {
    await pool.query(`UPDATE company_enrichment_tasks SET status='failed', completed_at=now(), error=COALESCE(error,'Worker stopped before task completed') WHERE status IN ('queued','running')`);
    let totalProcessed = 0;
    let batchNumber = 0;
    while (true) {
      const queued = await queueDueTasks();
      if (!queued.length) break;
      batchNumber += 1;
      console.info(`Company enrichment batch ${batchNumber}: queued ${queued.length} task(s)`);
      await runWithConcurrency(queued, config.companyEnrichmentConcurrency, processTask);
      totalProcessed += queued.length;
    }
    if (totalProcessed) console.info(`Company enrichment cycle complete: processed ${totalProcessed} task(s)`);
  } finally { running = false; }
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }));
}

export function startCompanyEnrichment(intervalMs: number) {
  void enrichCompanies().catch((error) => console.error('company enrichment failed', error));
  return setInterval(() => void enrichCompanies().catch((error) => console.error('company enrichment failed', error)), intervalMs);
}
