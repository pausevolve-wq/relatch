const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const { Axiom } = require('@axiomhq/js');
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

const ANON_TOKEN_TTL_SECONDS = 600; // 10 minutes — matches the plan; long enough for one real run, short enough to bound abandoned tokens
const ANON_TOKEN_RATE_LIMIT_WINDOW = 3600; // 1 hour window for rate limiting
const ANON_TOKEN_RATE_LIMIT_MAX = 5; // Max 5 tokens per IP per hour

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.relatch.online');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit by IP to prevent abuse of the anonymous token endpoint
  if (!redis) {
    return res.status(503).json({ error: 'ANON_TRIAL_UNAVAILABLE' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ipKey = `ip:${ip}:anon-token`;
  
  try {
    const ipCount = await redis.incr(ipKey);
    if (ipCount === 1) {
      await redis.expire(ipKey, ANON_TOKEN_RATE_LIMIT_WINDOW);
    }
    
    if (ipCount > ANON_TOKEN_RATE_LIMIT_MAX) {
      await logToAxiom({ endpoint: 'anon-token', status: 429, reason: 'ip_rate_limit_exceeded', ip });
      return res.status(429).json({ error: 'ANON_TOKEN_RATE_LIMITED' });
    }
  } catch (err) {
    console.error('[anon-token] IP rate limit check failed:', err?.message || err);
    // Fail closed - if we can't check rate limit, don't issue token
    return res.status(503).json({ error: 'ANON_TRIAL_UNAVAILABLE' });
  }

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
