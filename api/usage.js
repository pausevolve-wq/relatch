// 2026-10-25: GET /api/usage - skills a signed-in person has used today, for V3's
// Settings > Plan (src/v3/usePlan.ts). Runbook Flow E, corrected: since relatch#32 the counts
// live in Redis (lib/usage-limits.js), not in Clerk privateMetadata.
//   200 { used, limit }   the current UTC day
//   401                   no or invalid Clerk token
//   503                   the store cannot be read (the panel then shows no number, never a wrong one)
// Read-only: it never reserves, so asking costs nothing.
const { verifyToken } = require('@clerk/backend');
const { Redis } = require('@upstash/redis');
const { Axiom } = require('@axiomhq/js');
const { readUsage } = require('../lib/usage-limits');

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.relatch.online');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for'] || null;
  let userId = null;
  const fail = async (status, error, reason) => {
    await logToAxiom({ endpoint: 'usage', status, reason: reason || error, userId, ip });
    return res.status(status).json({ error });
  };

  if (req.method !== 'GET') return fail(405, 'Method not allowed', 'method');

  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return fail(401, 'Unauthorized', 'missing_bearer');
  try {
    const payload = await verifyToken(authHeader.slice(7), { secretKey: process.env.CLERK_SECRET_KEY });
    userId = payload.sub;
    if (!userId) throw new Error('No userId in token');
  } catch {
    return fail(401, 'Invalid session', 'invalid_session');
  }

  try {
    return res.status(200).json(await readUsage(redis, userId));
  } catch (err) {
    console.error('[usage] store read failed:', err?.message || err);
    return fail(503, 'USAGE_UNAVAILABLE', 'usage_unavailable');
  }
};
