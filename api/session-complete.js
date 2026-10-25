// 2026-10-25: POST /api/session-complete { sessionId } - the skill made in this session was
// downloaded, so the session is shut and /api/enrich answers 409 SESSION_COMPLETE for it (a
// second tab or a stale page cannot add documents to a finished skill). Called by V3
// (src/v3/useSkillJob.ts complete()). Runbook Flow F, corrected: the marker lives in Redis next
// to the run it shuts (lib/usage-limits.js), for signed-in and anonymous sessions alike.
//   204   marked
//   400   missing or malformed sessionId
//   401   no valid Clerk token and no live trial token
//   503   the store cannot be written (V3 calls this best-effort; its page lock holds anyway)
// Auth follows /api/enrich exactly: a Bearer header always wins; X-Anon-Token is only
// considered when there is no Bearer header. A marker can only ever shut the caller's own
// session, so it grants nothing.
const { verifyToken } = require('@clerk/backend');
const { Redis } = require('@upstash/redis');
const { Axiom } = require('@axiomhq/js');
const { markSessionComplete, withTimeout } = require('../lib/usage-limits');

const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;
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

// Same shape and bound as the sessionId /api/enrich accepts (BODY_LIMITS: 128).
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.relatch.online');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Anon-Token');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for'] || null;
  let userId = null;
  const fail = async (status, error, reason) => {
    await logToAxiom({ endpoint: 'session-complete', status, reason: reason || error, userId, ip });
    return res.status(status).json({ error });
  };

  if (req.method !== 'POST') return fail(405, 'Method not allowed', 'method');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return fail(400, 'INVALID_JSON'); }
  }
  const sessionId = body && typeof body === 'object' ? body.sessionId : undefined;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return fail(400, 'INVALID_SESSION_ID');

  const authHeader = req.headers['authorization'];
  const anonToken = req.headers['x-anon-token'];
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = await verifyToken(authHeader.slice(7), { secretKey: process.env.CLERK_SECRET_KEY });
      userId = payload.sub;
      if (!userId) throw new Error('No userId in token');
    } catch {
      return fail(401, 'Invalid session', 'invalid_session');
    }
  } else if (!anonToken) {
    return fail(401, 'Unauthorized', 'missing_bearer');
  }

  try {
    if (!userId) {
      // Only a live trial token can shut its session; a dead or invented one is refused.
      if (!redis) throw new Error('usage store not configured');
      if ((await withTimeout(redis.get(`anon:${anonToken}`))) === null) return fail(401, 'ANON_TOKEN_INVALID', 'anon_token_invalid');
    }
    await markSessionComplete(redis, userId ? { userId, sessionId } : { anonToken });
    return res.status(204).end();
  } catch (err) {
    console.error('[session-complete] store write failed:', err?.message || err);
    return fail(503, 'SESSION_STORE_UNAVAILABLE', 'store_unavailable');
  }
};
