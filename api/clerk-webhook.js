// 2026-10-24: Clerk -> Svix webhook. When a Relatch account is deleted, delete that person's
// skill history (runbook Flow G; the privacy policy promises it). Safe to repeat: Svix retries
// any non-2xx, and DELETE is idempotent.
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

  if (event?.type !== 'user.deleted') return res.status(200).json({ ignored: event?.type || null });
  const userId = event.data?.id;
  if (typeof userId !== 'string' || !userId) return fail(400, 'missing_user_id');

  if (!sql) return fail(503, 'db_unconfigured'); // non-2xx: Svix retries later
  try {
    const deleted = await sql`DELETE FROM skills WHERE user_id = ${userId} RETURNING id`;
    await logToAxiom({ endpoint: 'clerk-webhook', status: 200, reason: 'user_deleted_history_removed', userId, rows: deleted.length, ip });
    return res.status(200).json({ deleted: deleted.length });
  } catch (err) {
    console.error('[clerk-webhook] database error:', err?.code || err?.name || 'unknown');
    return fail(503, 'db_error');
  }
};
