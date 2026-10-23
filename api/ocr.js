const { verifyToken, createClerkClient } = require('@clerk/backend');
const { reserveRun, reserveDatalab, reserveAnonOcr, reserveAnonLlamaParse, reserveAnonDatalab, quotaReachedBody } = require('../lib/usage-limits');
const { httpFailureKind, estimatePages, assessText, isProviderDown, recordProviderResult } = require('../lib/ocr-routing');
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
const { Redis } = require('@upstash/redis');
const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;
const { Axiom } = require('@axiomhq/js');
const axiomClient = process.env.AXIOM_TOKEN
  ? new Axiom({ token: process.env.AXIOM_TOKEN, edge: 'us-east-1.aws.edge.axiom.co' })
  : null;

async function logToAxiom(event) {
  if (!axiomClient) return;
  try {
    axiomClient.ingest('relatch-security', [{ ...event, _time: new Date().toISOString() }]);
    // Bounded so a slow/hung Axiom endpoint can never stall the OCR fallback chain behind it —
    // this call now sits between the Mistral/Datalab tiers and whatever tier runs next, and an
    // unbounded hang here would eat into the time budget those tiers were sized against.
    await Promise.race([
      axiomClient.flush(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('axiom flush timeout')), 2000)),
    ]);
  } catch (err) {
    console.log('[axiom] log failed:', err?.message || 'unknown');
  }
}

// (2026-10-23: getDatalabDailyCount, the Clerk privateMetadata.relatchOcrUsage read shared by
// the Datalab quota check and its post-success increment, was replaced by reserveDatalab in
// lib/usage-limits.js - one atomic Redis counter, taken before the paid submit.)

// fetch() wrapped with an AbortController timeout — every outbound call in this file uses this
// instead of a bare fetch, so a hung third-party endpoint can never stall the fallback chain
// behind it indefinitely. Vercel's own 60s function ceiling is the last-resort backstop, but
// reaching it means the frontend gets a raw infra timeout instead of our friendly 422 JSON.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 2026-10-23: LlamaParse v2 (tier cost_effective) is the first OCR tier. Chosen on a scored
// benchmark (2-page scanned PDF with tables, a flowchart, a bar chart and handwriting, clean and
// phone-photo-degraded): every table row intact and every value right on both, where OCR.space
// (removed below) lost all table structure and, on the degraded scan, silently dropped decimal
// points (412.50 -> 41250, 13.7% -> 137%). API: upload+parse in one multipart call, then poll.
// Tables are requested as markdown pipe tables: HTML tables broke enrich.js's line-based signal
// filter and char-cap slice (see the Mistral table_format note below), and llamaParseMarkdown()
// converts any <table> that still comes back.
const LLAMAPARSE_BASE = 'https://api.cloud.llamaindex.ai/api/v2/parse';

// Fallback for HTML tables in LlamaParse output (output_tables_as_markdown can still return HTML
// for merged-cell tables): one pipe row per <tr>, header separator after the first row.
function htmlTablesToMarkdown(text) {
  const cellText = c => c.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  return text.replace(/<table[\s\S]*?<\/table>/gi, table => {
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map(r => [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(c => cellText(c[1])))
      .filter(r => r.length);
    if (!rows.length) return cellText(table);
    const lines = rows.map(r => `| ${r.join(' | ')} |`);
    lines.splice(1, 0, `|${rows[0].map(() => ' --- ').join('|')}|`);
    return `\n${lines.join('\n')}\n`;
  });
}

// markdown_full arrives as a string; accept the object shapes the API has used for markdown too,
// so a response-shape change degrades to "no text" (next tier) instead of a crash.
function llamaParseMarkdown(body) {
  const m = body?.markdown_full ?? body?.markdown;
  const raw = typeof m === 'string' ? m
    : typeof m?.markdown === 'string' ? m.markdown
    : Array.isArray(m?.pages) ? m.pages.map(p => p.markdown || '').join('\n\n')
    : '';
  return htmlTablesToMarkdown(raw).trim();
}

// 2026-10-24: each provider is one function that never throws and returns
// { text, kind, reason, durationMs, ... } - kind 'ok' with text, or the failure kind the circuit
// breaker needs (lib/ocr-routing.js): 'auth' (our key/billing), 'outage' (provider struggling,
// incl. timeouts) or 'document' (this file was the problem; never counts against the provider).
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// LlamaParse (see the note at the top of this file). disable_cache: LlamaParse would otherwise
// reuse (and keep) a cached copy of an identical upload. A 2-page scan took 9-17s in the benchmark.
async function runLlamaParse({ key, fileBuffer, fileMime, fileName, maxPages, deadlineMs }) {
  const startMs = Date.now();
  const done = (kind, reason, extra = {}) => ({ text: '', kind, reason, durationMs: Date.now() - startMs, ...extra });
  const headers = { 'Authorization': `Bearer ${key}` };
  try {
    const form = new FormData();
    form.append('file', new Blob([fileBuffer], { type: fileMime }), fileName);
    form.append('configuration', JSON.stringify({
      tier: 'cost_effective',
      version: 'latest',
      disable_cache: true,
      page_ranges: { max_pages: maxPages },
      output_options: { markdown: { tables: { output_tables_as_markdown: true, compact_markdown_tables: true } } },
    }));
    const submitResponse = await fetchWithTimeout(`${LLAMAPARSE_BASE}/upload`, { method: 'POST', headers, body: form },
      Math.max(1000, Math.min(10000, deadlineMs - Date.now())));
    if (!submitResponse.ok) return done(httpFailureKind(submitResponse.status), 'llamaparse_http_error', { httpStatus: submitResponse.status });
    const submitData = await submitResponse.json();
    const jobId = submitData?.id || submitData?.job?.id;
    if (!jobId) return done('outage', 'llamaparse_no_job');
    let status = null, body = null;
    while (Date.now() < deadlineMs) {
      const pollResponse = await fetchWithTimeout(`${LLAMAPARSE_BASE}/${encodeURIComponent(jobId)}?expand=markdown_full`,
        { headers }, Math.max(1000, Math.min(5000, deadlineMs - Date.now())));
      if (!pollResponse.ok) {
        const kind = httpFailureKind(pollResponse.status) === 'auth' ? 'auth' : 'outage';
        return done(kind, 'llamaparse_poll_error', { httpStatus: pollResponse.status });
      }
      body = await pollResponse.json();
      status = body?.job?.status || body?.status || null;
      if (status === 'COMPLETED') break;
      if (status === 'FAILED' || status === 'CANCELLED') return done('document', 'llamaparse_failed', { jobStatus: status });
      await sleep(1500);
    }
    if (status !== 'COMPLETED') return done('outage', 'llamaparse_timeout', { jobStatus: status });
    const text = llamaParseMarkdown(body);
    if (text.length <= 50) return done('document', 'llamaparse_empty_text', { jobStatus: status });
    return { ...done('ok', 'llamaparse_success', { jobStatus: status }), text };
  } catch (err) {
    return done('outage', err.name === 'AbortError' ? 'llamaparse_timeout' : 'llamaparse_threw', { error: err.message || 'unknown' });
  }
}

// Datalab (paid, $4/1000 pages). Billed per page once a job reaches 'complete', whether or not
// the text clears our length gate - which is why its credit is reserved before the submit.
async function runDatalab({ key, fileBuffer, fileMime, fileName, maxPages, deadlineMs }) {
  const startMs = Date.now();
  const done = (kind, reason, extra = {}) => ({ text: '', kind, reason, durationMs: Date.now() - startMs, ...extra });
  try {
    const form = new FormData();
    form.append('file', new Blob([fileBuffer], { type: fileMime }), fileName);
    form.append('output_format', 'markdown');
    form.append('mode', 'balanced'); // same $4/1000-page rate as 'fast', better quality — no reason to use 'fast'
    // 25 (not 40): sized to finish well inside the poll window at Datalab's own stated worst case
    // of ~3 pages/sec (25/3≈8.3s + margin). Anonymous calls are capped at 10 like LlamaParse.
    form.append('max_pages', String(maxPages));

    // submit only enqueues the job and returns a request_id — should be near-instant per Datalab's
    // own docs, not the actual OCR processing time
    const submitResponse = await fetchWithTimeout('https://www.datalab.to/api/v1/convert', {
      method: 'POST',
      headers: { 'X-Api-Key': key },
      body: form,
    }, Math.max(1000, Math.min(5000, deadlineMs - Date.now())));
    if (!submitResponse.ok) return done(httpFailureKind(submitResponse.status), 'datalab_http_error', { httpStatus: submitResponse.status });
    const checkUrl = (await submitResponse.json())?.request_check_url;
    if (!checkUrl) return done('outage', 'datalab_no_job');

    // Checks immediately first (no wasted delay for jobs that finish fast), then backs off 2s.
    // Each poll has its own timeout too: the loop can't re-check the clock while a call hangs.
    let firstCheck = true;
    while (Date.now() < deadlineMs) {
      if (!firstCheck) await sleep(2000);
      firstCheck = false;
      const pollResponse = await fetchWithTimeout(checkUrl, { headers: { 'X-Api-Key': key } }, Math.max(1000, Math.min(5000, deadlineMs - Date.now())));
      if (!pollResponse.ok) {
        const kind = httpFailureKind(pollResponse.status) === 'auth' ? 'auth' : 'outage';
        return done(kind, 'datalab_poll_error', { httpStatus: pollResponse.status });
      }
      const result = await pollResponse.json();
      if (result.status === 'failed') return done('document', 'datalab_failed');
      if (result.status !== 'complete') continue;
      const billed = { pageCount: result.page_count ?? null, cost: result.cost_breakdown ?? null };
      if (!result.success) return done('document', 'datalab_processing_failed', billed);
      const text = (result.markdown || '').trim();
      if (text.length <= 50) return done('document', 'datalab_empty_text', billed);
      return { ...done('ok', 'datalab_success', billed), text };
    }
    return done('outage', 'datalab_timeout');
  } catch (err) {
    return done('outage', err.name === 'AbortError' ? 'datalab_timeout' : 'datalab_threw', { error: err.message || 'unknown' });
  }
}

// Order, time budget and minimum time to start, per provider. LlamaParse leads: it won the
// 2026-10-23 benchmark on table structure and degraded scans. maxMs bounds one attempt; minMs is
// the least time left at which a job is still worth starting (a started paid job can bill).
const OCR_PROVIDERS = [
  { name: 'llamaparse', run: runLlamaParse, keyEnv: 'LLAMAINDEX_OCR_API_KEY', maxMs: 30000, minMs: 10000 },
  { name: 'datalab', run: runDatalab, keyEnv: 'DATALAB_API_KEY', maxMs: 35000, minMs: 15000 },
];
// Within this margin LlamaParse's result is kept over Datalab's (better table structure).
const LLAMAPARSE_TIE_MARGIN = 1.15;

module.exports = async function handler(req, res) {
  // OCR tiers run one after another inside Vercel's 60s function ceiling; each tier's timeout is
  // clipped to what is left of this deadline so a slow tier can't push the chain past 60s.
  const handlerDeadlineMs = Date.now() + 55000;
  const remainingMs = () => handlerDeadlineMs - Date.now();
  res.setHeader('Access-Control-Allow-Origin', 'https://app.relatch.online');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Anon-Token');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: a Bearer header ALWAYS takes precedence over X-Anon-Token, same fix and same
  // reason as enrich.js — checked there first (a signed-in user must never be able to
  // bypass their own Clerk quota by also sending a self-minted anon token). X-Anon-Token
  // is only considered when there is no Bearer header at all. Not single-use: this only
  // peeks (GET) to verify the token is live within its TTL — a run can call /api/ocr for
  // some files and not others, ahead of /api/enrich; a strict single-consume token would
  // die here before the run's real work even starts. See enrich.js and anon-token.js for
  // the full model (enrich.js is also where the per-token call-count cap lives — OCR
  // preprocessing calls are deliberately not counted against it).
  // 2026-10-23: OCR calls now have their own cap per trial token (reserveAnonOcr, 5 calls), and
  // signed-in OCR shares the batch's credit with generation (reserveRun) - see below the size check.
  const authHeader = req.headers['authorization'];
  const anonToken = req.headers['x-anon-token'];
  let userId = null;
  let isAnonymousRequest = false;

  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = await verifyToken(authHeader.slice(7), { secretKey: process.env.CLERK_SECRET_KEY });
      userId = payload.sub;
      if (!userId) throw new Error('No userId in token');
    } catch {
      await logToAxiom({ endpoint: 'ocr', status: 401, reason: 'invalid_session', ip: req.headers['x-forwarded-for'] || null });
      return res.status(401).json({ error: 'Invalid session' });
    }
  } else if (anonToken) {
    if (!redis) {
      await logToAxiom({ endpoint: 'ocr', status: 401, reason: 'anon_redis_unconfigured', ip: req.headers['x-forwarded-for'] || null });
      return res.status(401).json({ error: 'ANON_TOKEN_INVALID' });
    }
    try {
      const validToken = await redis.get(`anon:${anonToken}`);
      if (validToken === null) {
        await logToAxiom({ endpoint: 'ocr', status: 401, reason: 'anon_token_invalid', ip: req.headers['x-forwarded-for'] || null });
        return res.status(401).json({ error: 'ANON_TOKEN_INVALID' });
      }
    } catch (redisErr) {
      console.error('[anon] Redis check failed:', redisErr?.message || redisErr);
      await logToAxiom({ endpoint: 'ocr', status: 401, reason: 'anon_redis_error', ip: req.headers['x-forwarded-for'] || null });
      return res.status(401).json({ error: 'ANON_TOKEN_INVALID' });
    }
    isAnonymousRequest = true;
  } else {
    await logToAxiom({ endpoint: 'ocr', status: 401, reason: 'missing_bearer', ip: req.headers['x-forwarded-for'] || null });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // sessionId: the upload batch id App.tsx also sends to /api/enrich (older app builds omit it).
  const { base64, mimeType, fileName, sessionId } = req.body;

  if (!base64 || !fileName) {
    await logToAxiom({ endpoint: 'ocr', status: 400, reason: 'missing_fields', ip: req.headers['x-forwarded-for'] || null });
    return res.status(400).json({ error: 'Missing required fields: base64, fileName' });
  }

  // Vercel serverless functions hard-cap the request body at 4.5MB platform-wide
  // (not configurable via vercel.json, not a Mistral/OCR.space limit — see
  // https://vercel.com/docs/functions/limitations). Base64 inflates the original
  // file by ~1/0.75, so a decoded-size check needs real margin under that ceiling:
  // 3MB decoded ≈ 4MB of base64 + JSON overhead ≈ ~4.0-4.1MB actual body, leaving
  // ~400-500KB headroom under 4.5MB. The previous 4MB decoded threshold allowed a
  // ~5.3MB body — files between ~3.375MB-4MB decoded passed this check but were
  // then silently killed by Vercel's platform-level 413 before ever reaching the
  // friendly error below, since Vercel's own limit sits in front of this code.
  const estimatedBytes = base64.length * 0.75;
  if (estimatedBytes > 3000000) {
    await logToAxiom({ endpoint: 'ocr', status: 413, reason: 'file_too_large', ip: req.headers['x-forwarded-for'] || null });
    return res.status(413).json({ error: 'File too large for OCR. Maximum size is ~3MB.' });
  }

  // Usage limit, reserved atomically BEFORE any provider call (2026-10-23). Until now signed-in
  // OCR through Mistral/OCR.space had no limit at all, and anonymous OCR was unlimited for the
  // token's 10 minutes. Signed-in: the call joins the upload batch's run, so a batch's OCR and
  // generation calls together cost one credit of the 5/day + 35/week allowance. Anonymous: at
  // most 5 OCR calls per trial token. Fail CLOSED on any usage-store error.
  try {
    if (isAnonymousRequest) {
      if (!(await reserveAnonOcr(redis, anonToken))) {
        await logToAxiom({ endpoint: 'ocr', status: 429, reason: 'anon_ocr_cap', ip: req.headers['x-forwarded-for'] || null });
        return res.status(429).json({ error: 'ANON_OCR_LIMIT' });
      }
    } else {
      const quota = await reserveRun(redis, { userId, sessionId, kind: 'ocr' });
      if (!quota.allowed) {
        await logToAxiom({ endpoint: 'ocr', status: 429, reason: 'quota_reached', limitType: quota.limitType, userId, ip: req.headers['x-forwarded-for'] || null });
        return res.status(429).json(quotaReachedBody(quota));
      }
    }
  } catch (quotaErr) {
    console.error('[quota] usage store failed:', quotaErr?.message || quotaErr);
    await logToAxiom({ endpoint: 'ocr', status: 503, reason: 'quota_unavailable', userId, ip: req.headers['x-forwarded-for'] || null });
    return res.status(503).json({ error: 'QUOTA_UNAVAILABLE' });
  }

  const fileMime = mimeType || 'application/pdf';
  const ip = req.headers['x-forwarded-for'] || null;
  const rawBase64 = base64.startsWith('data:') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const fileBuffer = Buffer.from(rawBase64, 'base64');
  // 2026-10-24: providers get a neutral upload name that keeps only the extension (they use it to
  // detect the file type); the person's own file name is never sent to them or logged (privacy
  // policy 2.5/2.6). It is still required in the request body for older app builds.
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(String(fileName)) || [])[1];
  const uploadName = ext ? `document.${ext.toLowerCase()}` : 'document';
  const maxPages = isAnonymousRequest ? 10 : 25;
  // Pages a provider will actually read, for judging text volume per page.
  const pages = Math.min(maxPages, estimatePages(fileBuffer, fileMime));

  // 2026-10-24: routing on evidence instead of a blind chain (see lib/ocr-routing.js):
  // 1. A provider whose circuit breaker is open (key/billing rejected, or 3 outage failures in a
  //    row) goes LAST instead of first, and is tried only if nothing usable came back yet - the
  //    breaker may be stale, and a request with no other option loses nothing by probing it.
  // 2. A result that is thin or mostly junk for its page count gets a second opinion from the
  //    next provider (time and budget permitting); the better-scoring text is served.
  // 3. Failures caused by the document itself never count against a provider's health.
  // 4. A provider only starts if enough of the 55s deadline is left for it to finish, and the
  //    first one leaves room for the next.
  // Jev (lib/planner.js) is deliberately not involved: before OCR a scan has no text to plan from,
  // and Jev already sees the OCR text in /api/enrich, where it plans the skill.
  const configured = OCR_PROVIDERS.filter(p => process.env[p.keyEnv]);
  const down = Object.fromEntries(await Promise.all(configured.map(async p => [p.name, await isProviderDown(redis, p.name)])));
  const order = [...configured.filter(p => !down[p.name]), ...configured.filter(p => down[p.name])];

  // Paid-budget gate, taken right before each call because it counts the attempt. Signed-in
  // LlamaParse use is already bounded by the run credit above; Datalab keeps its 3/day per user.
  // Anonymous calls draw on site-wide daily budgets. A usage-store error skips the provider
  // (fail closed - same posture as enrich.js's quota gate).
  async function reserveProvider(name) {
    try {
      const ok = name === 'llamaparse'
        ? (!isAnonymousRequest || await reserveAnonLlamaParse(redis))
        : isAnonymousRequest ? await reserveAnonDatalab(redis) : await reserveDatalab(redis, userId);
      if (!ok) await logToAxiom({ endpoint: 'ocr', status: 200, reason: `${name}_budget_skipped`, userId, ip });
      return ok;
    } catch (err) {
      console.log(`[ocr] ${name} budget check failed, skipping:`, err?.message || 'unknown');
      return false;
    }
  }

  const tried = [];
  let best = null;
  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    if (best && down[provider.name]) continue; // already have text: don't wait on a provider marked down
    if (remainingMs() < provider.minMs) continue;
    if (!(await reserveProvider(provider.name))) continue;
    const next = order.slice(i + 1).find(p => !down[p.name]);
    const deadlineMs = Math.min(Date.now() + provider.maxMs, handlerDeadlineMs - (next ? next.minMs + 2000 : 2000));
    console.log(`[ocr] trying ${provider.name}`);
    const result = await provider.run({ key: process.env[provider.keyEnv], fileBuffer, fileMime, fileName: uploadName, maxPages, deadlineMs });
    const breakerOpened = await recordProviderResult(redis, provider.name, result.kind);
    const quality = result.text ? assessText(result.text, pages) : null;
    tried.push(`${provider.name}:${quality?.weak ? quality.reason : result.kind}`);
    console.log(`[ocr] ${provider.name}: ${result.reason} in ${result.durationMs}ms${quality ? ` (score ${quality.score}${quality.weak ? `, weak: ${quality.reason}` : ''})` : ''}`);
    await logToAxiom({ endpoint: 'ocr', status: 200, reason: result.reason, userId, chars: result.text.length || null, pages, quality, breakerOpened, httpStatus: result.httpStatus ?? null, jobStatus: result.jobStatus ?? null, pageCount: result.pageCount ?? null, cost: result.cost ?? null, durationMs: result.durationMs, ip });
    if (!result.text) continue;
    const rank = quality.score * (quality.weak ? 0.5 : 1) * (provider.name === 'llamaparse' ? LLAMAPARSE_TIE_MARGIN : 1);
    if (!best || rank > best.rank) best = { text: result.text, source: provider.name, rank };
    if (!quality.weak) break;
  }

  if (best) {
    console.log(`[ocr] served ${best.source}: ${best.text.length} chars (${tried.join(', ')})`);
    await logToAxiom({ endpoint: 'ocr', status: 200, reason: 'ocr_served', source: best.source, tried, userId, chars: best.text.length, ip });
    return res.status(200).json({ text: best.text, source: best.source });
  }

  // 2026-10-24: the Mistral tier (mistral-ocr-latest, 30s, include_blocks) was removed: Mistral's
  // Free plan lost OCR access ("Your organization is on the Free plan. Upgrade to activate your API
  // keys"), so every call returned 429. MISTRALOCR_API_KEY is unused. Lesson kept from it: HTML
  // table markup (table_format "html", reverted 2026-08-08) broke enrich.js's line-based signal
  // filter, which assumes one markdown table row per line, and its effectiveCharCap slice (HTML is
  // ~2-3x more verbose than pipe tables) - a scanned central-bank statement's two dense tables
  // vanished from the skill file. That is why LlamaParse output is converted to pipe tables.
  // The `blocks` field (Mistral bounding boxes) is no longer returned; App.tsx treats it as optional.

  // NOTE (history): Datalab's per-user daily cap was a non-atomic Clerk metadata read-modify-write,
  // so parallel files from one batch could all pass it. 2026-10-23: FIXED - the check-and-count is
  // one atomic Redis INCR (reserveDatalab) taken before the submit. The $8 hard cap Manas set on the
  // Datalab API key in their dashboard stays as the backstop against runaway spend.

  // 2026-10-23: the OCR.space tier (last free fallback, OCREngine 2, 8s timeout) was removed at
  // Manas's request after the LlamaParse benchmark: on a phone-photo scan it dropped decimal points
  // (412.50 -> 41250) and row labels, and it never kept table structure. OCRCLD_API_KEY is unused.

  console.log(`[ocr] all OCR methods failed (${tried.join(', ') || 'none tried'})`);
  await logToAxiom({ endpoint: 'ocr', status: 422, reason: 'ocr_failed', tried, ip });
  return res.status(422).json({
    error: 'OCR_FAILED',
    message: 'Could not extract text from this document. It may be image-based, encrypted, or corrupted.',
  });
};
