import nodemailer from 'nodemailer';
import { config } from './config.js';
import { getPreferences, pool } from './db.js';

const backoff = (attempts: number) => Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** Math.min(attempts, 8)));

async function deliverPostNotifications() {
  if (!config.enablePosts) return;
  if (!config.smtp.host || !config.smtp.recipient || !config.smtp.from) return;
  const preferences = await getPreferences();
  if (!preferences.notificationsEnabled) return;
  const pending = await pool.query(`SELECT n.*, o.text, o.score, o.matched_rules, o.score_breakdown, o.source, o.author_name, o.author_handle,
    o.source_url, o.published_at, o.first_seen_at, o.signal_category, o.signal_quality, o.personal_relevance,
    o.classification_reasons, o.contact_methods FROM notifications n JOIN opportunities o ON o.id = n.opportunity_id
    WHERE n.status IN ('pending', 'failed') AND n.next_attempt_at <= now() ORDER BY n.created_at LIMIT 10`);
  if (!pending.rows.length) return;
  const transport = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined });
  for (const notification of pending.rows) {
    try {
      const matched = (notification.matched_rules as { name: string }[]).map((rule) => rule.name).join(', ');
      const breakdown = (notification.score_breakdown as { label: string; points: number; evidence: string[] }[]).map((item) => `${item.label} +${item.points} (${item.evidence.join(', ')})`).join('\n');
      const reasons = (notification.classification_reasons as string[] || []).join('; ');
      const contacts = (notification.contact_methods as { type: string; value: string }[] || []).map((item) => `${item.type}: ${item.value}`).join('\n') || 'No direct contact method detected';
      await transport.sendMail({
        from: config.smtp.from,
        to: config.smtp.recipient,
        subject: `[Hiring signal Q${notification.signal_quality}/R${notification.personal_relevance}] ${String(notification.text).slice(0, 64)}`,
        text: `Hiring signal detected\n\nCategory: ${notification.signal_category}\nSignal quality: ${notification.signal_quality}/100\nPersonal relevance: ${notification.personal_relevance}/100\nSource: ${notification.source}\nAuthor: ${notification.author_name} (${notification.author_handle})\nLink: ${notification.source_url}\nPublished: ${notification.published_at}\nDiscovered: ${notification.first_seen_at}\n\nWhy it was classified:\n${reasons || 'No additional classification notes'}\n\nContact methods:\n${contacts}\n\nMatched rules:\n${matched}\n\nPersonal relevance explanation:\n${breakdown}\n\n${notification.text}`
      });
      await pool.query(`UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [notification.id]);
      await pool.query(`UPDATE opportunities SET notified_at = now() WHERE id = $1`, [notification.opportunity_id]);
    } catch (error) {
      const attempts = Number(notification.attempts) + 1;
      await pool.query(`UPDATE notifications SET status = 'failed', attempts = $2, next_attempt_at = now() + ($3::text || ' milliseconds')::interval, last_error = $4 WHERE id = $1`, [notification.id, attempts, backoff(attempts), error instanceof Error ? error.message : String(error)]);
    }
  }
}

async function deliverListingNotifications() {
  if (!config.smtp.host || !config.smtp.recipient || !config.smtp.from) return;
  const preferences = await getPreferences();
  if (!preferences.listingsNotificationsEnabled) return;
  const pending = await pool.query(`SELECT n.*, l.title, l.description, l.personal_relevance, l.relevance_breakdown, l.location, l.remote_mode,
    l.application_url, l.original_url, l.source_updated_at,
    b.provider, b.board_identifier, e.name AS employer_name FROM listing_notifications n
    JOIN job_listings l ON l.id=n.listing_id JOIN job_boards b ON b.id=l.board_id JOIN employers e ON e.id=b.employer_id
    WHERE n.status IN ('pending','failed') AND n.next_attempt_at <= now() AND l.is_active=true
    ORDER BY n.created_at LIMIT 10`);
  if (!pending.rows.length) return;
  const transport = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined });
  for (const notification of pending.rows) {
    try {
      const breakdown = (notification.relevance_breakdown as { label: string; points: number; evidence: string[] }[] || []).map((item) => `${item.label} +${item.points} (${item.evidence.join(', ')})`).join('\n');
      const link = notification.application_url || notification.original_url;
      await transport.sendMail({
        from: config.smtp.from,
        to: config.smtp.recipient,
        subject: `[Listing R${notification.personal_relevance}] ${notification.title} · ${notification.employer_name}`,
        text: `Job listing detected\n\n${notification.title}\nEmployer: ${notification.employer_name}\nProvider: ${notification.provider}\nLocation: ${notification.location || 'Not specified'}\nWork mode: ${notification.remote_mode}\nPersonal relevance: ${notification.personal_relevance}/100\nSource: ${link}\nUpdated: ${notification.source_updated_at || 'unknown'}\n\nRelevance breakdown:\n${breakdown || 'No additional scoring details'}\n\n${notification.description}`
      });
      await pool.query(`UPDATE listing_notifications SET status='sent', sent_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1`, [notification.id]);
    } catch (error) {
      const attempts = Number(notification.attempts) + 1;
      await pool.query(`UPDATE listing_notifications SET status='failed', attempts=$2, next_attempt_at=now() + ($3::text || ' milliseconds')::interval, last_error=$4 WHERE id=$1`, [notification.id, attempts, backoff(attempts), error instanceof Error ? error.message : String(error)]);
    }
  }
}

export async function deliverNotifications() {
  await deliverPostNotifications();
  await deliverListingNotifications();
}

export async function sendTestEmail() {
  if (!config.smtp.host || !config.smtp.recipient || !config.smtp.from) throw new Error('SMTP_HOST, SMTP_FROM, and NOTIFICATION_EMAIL must be configured');
  const transport = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined });
  await transport.sendMail({ from: config.smtp.from, to: config.smtp.recipient, subject: 'Hiring Signal Discovery test email', text: 'SMTP notifications are configured correctly.' });
}
