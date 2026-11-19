// 2026-10-24: Clerk -> Svix webhook. When a Relatch account is deleted, delete that person's
// skill history (runbook Flow G; the privacy policy promises it). Safe to repeat: Svix retries
// any non-2xx, and DELETE is idempotent.
// 2026-11-19: also counts accounts in PostHog: account_created (user.created) and account_deleted (see
// captureToPostHog below). test/clerk-webhook-posthog.test.js.
//
// Signature check: svix (the library Clerk's own verifyWebhook wraps) over the RAW request
// bytes with CLERK_WEBHOOK_SIGNING_SECRET. The raw body matters: re-serialising a parsed JSON
// body changes the bytes and every signature would fail. It also rejects stale timestamps
// (replays older than 5 minutes).
//
// Deliberately NOT behind HISTORY_MODE: an account deletion must always remove history, even
// while the history endpoints are switched off.
const { Webhook } = require('svix');
const { neon } = require('@neondatabase/serverless');
const { Axiom } = require('@axiomhq/js');

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const axiomClient = process.env.AXIOM_TOKEN
  ? new Axiom({ token: process.env.AXIOM_TOKEN, edge: 'us-east-1.aws.edge.axiom.co' })
  : null;

async function logToAxiom(event) {
  if (!axiomClient) return;
  try {
    axiomClient.ingest('relatch-security', [{ ...event, _time: new Date().toISOString() }]);
    await Promise.race([
      axiomClient.flush(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('axiom flush timeout')), 2000)),
    ]);
  } catch (err) {
    console.log('[axiom] log failed:', err?.message || 'unknown');
  }
}

// 2026-11-19 (PostHog rebuild): account_created / account_deleted, sent from here so the count of sign-ups does
// not depend on the browser (ad blockers stop the app's own PostHog calls for a good share of developers).
// distinct_id = the Clerk user id, the same id the app's identify() uses, so these land on the same person.
// The key is PostHog's public project key (the same one the app and landing page ship); it can only send
// events. $geoip_disable: the request comes from Vercel, and its location must not overwrite the person's.
// Never fails the webhook: PostHog being slow or down only loses the event.
const POSTHOG_KEY = 'phc_nszMZqivMkCWhZRC5bq3XexX5iapQMXzj6u5YPr94B3k';
const POSTHOG_CAPTURE_URL = 'https://us.i.posthog.com/i/v0/e/';

async function captureToPostHog(event, distinctId, properties, timestamp) {
  try {
    await Promise.race([
      fetch(POSTHOG_CAPTURE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: POSTHOG_KEY, event, distinct_id: distinctId, timestamp, properties: { ...properties, $geoip_disable: true, $lib: 'relatch-backend' } }),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('posthog timeout')), 2000)),
    ]);
  } catch (err) {
    console.log('[posthog] capture failed:', err?.message || 'unknown');
  }
}

// Clerk sends 'oauth_google' / 'google'; no external account = email and password or an email code
const methodOf = (user) => String(user?.external_accounts?.[0]?.provider || 'email').replace(/^oauth_/, '');
const isoOf = (ms) => new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();

const MAX_BODY_BYTES = 1024 * 1024; // Clerk user events are a few KB

// Read the unparsed body from the request stream. Vercel's Node helpers parse req.body lazily,
// so the stream is still readable as long as req.body has not been touched before this.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  const ip = req.headers['x-forwarded-for'] || null;
  const fail = async (status, reason) => {
    await logToAxiom({ endpoint: 'clerk-webhook', status, reason, ip });
    return res.status(status).json({ error: reason });
  };
  if (req.method !== 'POST') return fail(405, 'method_not_allowed');

  const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!secret) return fail(503, 'webhook_unconfigured');

  let event;
  try {
    const raw = await readRawBody(req);
    event = new Webhook(secret).verify(raw, {
      'svix-id': req.headers['svix-id'],
      'svix-timestamp': req.headers['svix-timestamp'],
      'svix-signature': req.headers['svix-signature'],
    });
  } catch (err) {
    return fail(400, 'bad_signature');
  }

  // 2026-11-19: a new account. Only counted (PostHog); nothing else to do, so always 200 (no Svix retries).
  // Needs "user.created" ticked on this endpoint in the Clerk dashboard (Webhooks), as user.deleted is.
  if (event?.type === 'user.created') {
    const u = event.data;
    if (typeof u?.id === 'string' && u.id) {
      await captureToPostHog('account_created', u.id, { method: methodOf(u), $set_once: { account_created_at: isoOf(u.created_at) } }, isoOf(u.created_at));
    }
    return res.status(200).json({ counted: 'user.created' });
  }

  if (event?.type !== 'user.deleted') return res.status(200).json({ ignored: event?.type || null });
  const userId = event.data?.id;
  if (typeof userId !== 'string' || !userId) return fail(400, 'missing_user_id');

  if (!sql) return fail(503, 'db_unconfigured'); // non-2xx: Svix retries later
  try {
    const deleted = await sql`DELETE FROM skills WHERE user_id = ${userId} RETURNING id`;
    await logToAxiom({ endpoint: 'clerk-webhook', status: 200, reason: 'user_deleted_history_removed', userId, rows: deleted.length, ip });
    await captureToPostHog('account_deleted', userId, { skills_removed: deleted.length }, isoOf(event.timestamp));
    return res.status(200).json({ deleted: deleted.length });
  } catch (err) {
    console.error('[clerk-webhook] database error:', err?.code || err?.name || 'unknown');
    return fail(503, 'db_error');
  }
};
