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
// Cloudflare Turnstile on the mint (hybrid plan, 2026-11-15): stops scripts, which are the real cost risk now
// that an anonymous run only returns a preview. Off until TURNSTILE_SECRET_KEY is set: the current production
// frontend sends no Turnstile token, so set the key together with the V3 flip (V3 sends `turnstile` in the body).
// If Cloudflare cannot be reached, the trial is not blocked: that network gets 1 token a day instead.
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TIMEOUT_MS = 3000;
const FALLBACK_DAILY_MAX = 1;

/** 'ok' | 'failed' | 'unreachable' - Cloudflare's verdict on the widget token */
async function checkTurnstile(token, ip) {
  try {
    const form = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token });
    if (ip && ip !== 'unknown') form.set('remoteip', ip);
    const r = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS) });
    if (!r.ok) return 'unreachable';
    const data = await r.json();
    if (data.success) return 'ok';
    // Cloudflare's own trouble is not the visitor's fault
    return (data['error-codes'] || []).includes('internal-error') ? 'unreachable' : 'failed';
  } catch {
    return 'unreachable';
  }
}

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
    // NX: only sets a TTL if the key doesn't already have one. Self-healing if a
    // previous request's expire call failed after its incr succeeded (which would
    // otherwise leave this key permanently un-expiring and lock the IP out forever);
    // a no-op once the window's TTL is already set, so this stays a fixed window.
    await redis.expire(ipKey, ANON_TOKEN_RATE_LIMIT_WINDOW, 'NX');

    if (ipCount > ANON_TOKEN_RATE_LIMIT_MAX) {
      await logToAxiom({ endpoint: 'anon-token', status: 429, reason: 'ip_rate_limit_exceeded', ip });
      return res.status(429).json({ error: 'ANON_TOKEN_RATE_LIMITED' });
    }
  } catch (err) {
    console.error('[anon-token] IP rate limit check failed:', err?.message || err);
    // Fail closed - if we can't check rate limit, don't issue token
    return res.status(503).json({ error: 'ANON_TRIAL_UNAVAILABLE' });
  }

  if (process.env.TURNSTILE_SECRET_KEY) {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    const widget = body && typeof body === 'object' && typeof body.turnstile === 'string' ? body.turnstile.slice(0, 4096) : '';
    if (!widget) {
      await logToAxiom({ endpoint: 'anon-token', status: 403, reason: 'turnstile_missing', ip });
      return res.status(403).json({ error: 'TURNSTILE_REQUIRED' });
    }
    const verdict = await checkTurnstile(widget, ip);
    if (verdict === 'failed') {
      await logToAxiom({ endpoint: 'anon-token', status: 403, reason: 'turnstile_failed', ip });
      return res.status(403).json({ error: 'TURNSTILE_FAILED' });
    }
    if (verdict === 'unreachable') {
      try {
        const fbKey = `ip:${ip}:anon-token:fallback:${new Date().toISOString().slice(0, 10)}`;
        const n = await redis.incr(fbKey);
        if (n === 1) await redis.expire(fbKey, 2 * 86400);
        await logToAxiom({ endpoint: 'anon-token', status: n > FALLBACK_DAILY_MAX ? 429 : 200, reason: 'turnstile_unreachable_fallback', ip });
        if (n > FALLBACK_DAILY_MAX) return res.status(429).json({ error: 'ANON_TOKEN_RATE_LIMITED' });
      } catch {
        return res.status(503).json({ error: 'ANON_TRIAL_UNAVAILABLE' });
      }
    }
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
