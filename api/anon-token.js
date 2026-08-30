const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

const ANON_TOKEN_TTL_SECONDS = 600; // 10 minutes — matches the plan; long enough for one real run, short enough to bound abandoned tokens

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.relatch.online');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // No auth required — this is the one deliberate new trust boundary. Nothing sensitive
  // happens here; it just mints a ticket. enrich.js/ocr.js validate it with a plain GET
  // (not single-use — see enrich.js for why: a real run is multiple HTTP calls, not one),
  // so the TTL below is the only thing bounding how long/how much a token is good for.
  // Fail closed if Redis isn't configured — never issue a token that couldn't be tracked.
  if (!redis) {
    return res.status(503).json({ error: 'ANON_TRIAL_UNAVAILABLE' });
  }

  const token = crypto.randomUUID();
  try {
    await redis.set(`anon:${token}`, '1', { nx: true, ex: ANON_TOKEN_TTL_SECONDS });
  } catch (err) {
    console.error('[anon-token] Redis set failed:', err?.message || err);
    return res.status(503).json({ error: 'ANON_TRIAL_UNAVAILABLE' });
  }

  return res.status(200).json({ token });
};
