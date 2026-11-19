// POST /api/claim  { claimId, method?, action? }  with a Clerk Bearer token.
// The other half of the anonymous preview (lib/anon-claim.js, hybrid plan 2026-11-15): a visitor who signed up
// or logged in through V3's unlock sheet gets the full skill their free trial made, and the conversion is
// recorded in Upstash (Manas: "redis and upstash will also record these new users"):
//   anonconv:user:<clerkUserId>  hash, 90 days: claimedAt, mode, method, action, agent, claimId, skills
//   anonconv:day:<YYYY-MM-DD>    counters, 400 days: claims, mode:<signup|login>, method:<...>
// No email or document content is stored there (Clerk holds the email; the skill text expires with the claim).
// 2026-11-19 (Manas): a claim COUNTS against the daily/weekly allowance - one run credit, charged once per claim
// (a reload is free). Was: "A claim does not count against the daily/weekly allowance: the skill was already made."
// At 3 of 3 the claim answers 429 QUOTA_REACHED (same body /api/enrich sends) and the skill stays held to unlock later.
const { verifyToken, createClerkClient } = require('@clerk/backend');
const { Redis } = require('@upstash/redis');
const { Axiom } = require('@axiomhq/js');
const { claim } = require('../lib/anon-claim');
const { quotaReachedBody } = require('../lib/usage-limits');

const axiomClient = process.env.AXIOM_TOKEN
  ? new Axiom({ token: process.env.AXIOM_TOKEN, edge: 'us-east-1.aws.edge.axiom.co' })
  : null;
async function logToAxiom(event) {
  if (!axiomClient) return;
  try {
    axiomClient.ingest('relatch-security', [{ ...event, _time: new Date().toISOString() }]);
    await axiomClient.flush();
  } catch (err) {
    console.log('[axiom] log failed:', err?.message || 'unknown');
  }
}

const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;
/** An account created this recently is a sign-up through the sheet; older is a log-in */
const NEW_ACCOUNT_MS = 15 * 60 * 1000;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.relatch.online');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for'] || null;
  let userId = null;
  const fail = async (status, error, reason) => {
    await logToAxiom({ endpoint: 'claim', status, reason: reason || error, userId, ip });
    return res.status(status).json({ error });
  };
  if (req.method !== 'POST') return fail(405, 'Method not allowed', 'method');

  // Signed in only: the whole point is that the full skill goes to an account
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return fail(401, 'SIGN_IN_REQUIRED');
  try {
    const payload = await verifyToken(authHeader.slice(7), { secretKey: process.env.CLERK_SECRET_KEY });
    userId = payload.sub;
  } catch {
    return fail(401, 'Invalid session', 'invalid_session');
  }
  if (!redis) return fail(503, 'CLAIM_UNAVAILABLE', 'redis_unconfigured');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return fail(400, 'INVALID_JSON'); }
  }
  body = body && typeof body === 'object' ? body : {};

  // Sign-up or log-in, decided here from the account's age (a client label is only the fallback)
  let mode = body.mode;
  try {
    const user = await createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY }).users.getUser(userId);
    if (user?.createdAt) mode = Date.now() - Number(user.createdAt) < NEW_ACCOUNT_MS ? 'signup' : 'login';
  } catch (err) {
    console.error('[claim] Clerk user lookup failed:', err?.message || err);
  }

  try {
    const r = await claim(redis, { claimId: body.claimId, userId, mode, method: body.method, action: body.action });
    await logToAxiom({ endpoint: 'claim', status: r.status, reason: r.status === 200 ? 'claimed' : r.body.error, userId, ip, mode });
    return res.status(r.status).json(r.quota ? quotaReachedBody(r.quota) : r.body);
  } catch (err) {
    console.error('[claim] failed:', err?.message || err);
    return fail(503, 'CLAIM_UNAVAILABLE', 'redis_error');
  }
};
