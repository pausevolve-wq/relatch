// 2026-10-24: evidence-based OCR routing for api/ocr.js - LlamaParse first, Datalab second.
//
// Mistral was removed the same day: its Free plan lost OCR access ("Upgrade to activate your API
// keys"), which is why every production call returned 429. With no free tier left, a blind
// "try A, then B" chain has two costs: every user waits out a dead provider's timeout, and a
// provider that "succeeds" with junk is never second-guessed. Three small pieces fix that:
//
// - estimatePages: rough page count of the upload, so text volume can be judged per page.
// - assessText: is a result usable, or suspiciously thin / mostly junk (worth a second opinion)?
//   It sees volume and noise, not meaning - a wrong digit in a clean-looking table passes.
// - circuit breaker: a provider that is down (bad key or billing, outage, rate limit) is moved
//   behind the other one for a few minutes for EVERY request, instead of each request waiting
//   out its timeout. A failure caused by the document itself never counts against the provider.
//
// Redis keys (self-expiring). The breaker fails OPEN: any Redis error means "assume healthy and
// try", because it only reorders providers - it never grants access or spends money.
//   ocr:v1:breaker:<provider>   present = provider is moved last until it expires
//   ocr:v1:fails:<provider>     consecutive outage-type failures          (TTL FAIL_WINDOW)

const { withTimeout, toCount } = require('./usage-limits');

const AUTH_BREAK_SECONDS = 900;   // key or billing rejected: will not fix itself in seconds
const OUTAGE_BREAK_SECONDS = 300; // FAIL_THRESHOLD outage failures in a row
const FAIL_WINDOW = 300;
const FAIL_THRESHOLD = 3;

// HTTP status -> failure kind. 401/402/403: our key, plan or billing. 408/429/5xx: the provider
// is struggling. Any other 4xx: the provider rejected this particular file.
function httpFailureKind(status) {
  if (status === 401 || status === 402 || status === 403) return 'auth';
  if (status === 408 || status === 429 || status >= 500) return 'outage';
  return 'document';
}

// PDFs: count page objects ("/Type /Page", not "/Pages"); if they sit inside compressed object
// streams, fall back to the largest /Count in the page tree; else 1. Images are one page.
function estimatePages(buffer, mime) {
  if (!/pdf/i.test(mime || '')) return 1;
  const s = buffer.toString('latin1');
  const pageObjects = (s.match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
  if (pageObjects) return pageObjects;
  const counts = [...s.matchAll(/\/Count\s+(\d+)/g)].map(m => Number(m[1])).filter(n => n > 0 && n < 100000);
  return counts.length ? Math.max(...counts) : 1;
}

const MIN_ALNUM_PER_PAGE = 40; // a scanned page with real content has hundreds
const MIN_CLEAN_RATIO = 0.5;   // letters+digits share of visible characters; prose is ~0.85

// Markdown syntax (table pipes, separator rows, #, *, `) is stripped first so a table-heavy
// result is not mistaken for junk. score = clean characters, used to compare two results.
function assessText(text, pages = 1) {
  const visible = String(text || '')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')
    .replace(/[|#*`>_]/g, '')
    .replace(/\s+/g, '');
  const alnum = (visible.match(/[\p{L}\p{N}]/gu) || []).length;
  const ratio = visible.length ? alnum / visible.length : 0;
  const garbled = (visible.match(/�/g) || []).length > visible.length * 0.01;
  const perPage = alnum / Math.max(1, pages);
  const reason = perPage < MIN_ALNUM_PER_PAGE ? 'sparse' : (ratio < MIN_CLEAN_RATIO || garbled) ? 'junk' : null;
  return { weak: reason !== null, reason, score: Math.round(alnum * ratio), perPage: Math.round(perPage), ratio: Math.round(ratio * 100) / 100 };
}

async function isProviderDown(redis, provider) {
  if (!redis) return false;
  try {
    return (await withTimeout(redis.get(`ocr:v1:breaker:${provider}`))) !== null;
  } catch {
    return false;
  }
}

// kind: 'ok' | 'auth' | 'outage' | 'document'. Returns 'auth' / 'outage' when this call opened
// the breaker (for logging), else null. Never throws.
async function recordProviderResult(redis, provider, kind) {
  if (!redis || kind === 'document') return null;
  const breakerKey = `ocr:v1:breaker:${provider}`;
  const failsKey = `ocr:v1:fails:${provider}`;
  try {
    if (kind === 'ok') {
      await withTimeout(redis.del(failsKey));
      return null;
    }
    if (kind === 'auth') {
      await withTimeout(redis.set(breakerKey, 'auth', { ex: AUTH_BREAK_SECONDS }));
      return 'auth';
    }
    const fails = toCount(await withTimeout(redis.incr(failsKey)));
    if (fails === 1) await withTimeout(redis.expire(failsKey, FAIL_WINDOW));
    if (fails !== null && fails >= FAIL_THRESHOLD) {
      await withTimeout(redis.set(breakerKey, 'outage', { ex: OUTAGE_BREAK_SECONDS }));
      await withTimeout(redis.del(failsKey));
      return 'outage';
    }
  } catch (err) {
    console.log(`[ocr] breaker update failed for ${provider}:`, err?.message || 'unknown');
  }
  return null;
}

module.exports = { httpFailureKind, estimatePages, assessText, isProviderDown, recordProviderResult };
