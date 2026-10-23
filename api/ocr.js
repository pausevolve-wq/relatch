const { verifyToken, createClerkClient } = require('@clerk/backend');
const { reserveRun, reserveDatalab, reserveAnonOcr, reserveAnonLlamaParse, quotaReachedBody } = require('../lib/usage-limits');
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
    await logToAxiom({ endpoint: 'ocr', status: 413, reason: 'file_too_large', fileName, ip: req.headers['x-forwarded-for'] || null });
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
  const llamaKey = process.env.LLAMAINDEX_OCR_API_KEY;
  const mistralKey = process.env.MISTRALOCR_API_KEY;
  const datalabKey = process.env.DATALAB_API_KEY;

  const dataUri = base64.startsWith('data:') ? base64 : `data:${fileMime};base64,${base64}`;

  // Tier 1: LlamaParse (see the note at the top of this file). Anonymous calls also need the
  // site-wide daily budget (reserveAnonLlamaParse) and parse at most 10 pages; signed-in 25,
  // same as Datalab. 30s budget: a 2-page scan took 9-17s in the benchmark; a slower job is
  // abandoned and the chain moves on. disable_cache: LlamaParse would otherwise reuse (and keep)
  // a cached copy of an identical upload.
  let llamaAllowed = Boolean(llamaKey);
  if (llamaAllowed && isAnonymousRequest) {
    try {
      llamaAllowed = await reserveAnonLlamaParse(redis);
      if (!llamaAllowed) await logToAxiom({ endpoint: 'ocr', status: 200, reason: 'llamaparse_anon_budget_skipped', fileName, ip: req.headers['x-forwarded-for'] || null });
    } catch {
      llamaAllowed = false; // budget unverifiable: skip the paid tier, same posture as Datalab
    }
  }
  if (llamaAllowed) {
    const llamaStartMs = Date.now();
    const llamaDeadlineMs = Math.min(llamaStartMs + 30000, handlerDeadlineMs - 5000);
    const llamaHeaders = { 'Authorization': `Bearer ${llamaKey}` };
    try {
      console.log(`[ocr] trying LlamaParse for: ${fileName}`);
      const rawBase64 = dataUri.includes(',') ? dataUri.slice(dataUri.indexOf(',') + 1) : dataUri;
      const form = new FormData();
      form.append('file', new Blob([Buffer.from(rawBase64, 'base64')], { type: fileMime }), fileName);
      form.append('configuration', JSON.stringify({
        tier: 'cost_effective',
        version: 'latest',
        disable_cache: true,
        page_ranges: { max_pages: isAnonymousRequest ? 10 : 25 },
        output_options: { markdown: { tables: { output_tables_as_markdown: true, compact_markdown_tables: true } } },
      }));
      const submitResponse = await fetchWithTimeout(`${LLAMAPARSE_BASE}/upload`, { method: 'POST', headers: llamaHeaders, body: form },
        Math.max(1000, Math.min(10000, llamaDeadlineMs - Date.now())));
      const submitData = submitResponse.ok ? await submitResponse.json() : null;
      const jobId = submitData?.id || submitData?.job?.id;
      let status = null, body = null;
      if (jobId) {
        while (Date.now() < llamaDeadlineMs) {
          const pollResponse = await fetchWithTimeout(`${LLAMAPARSE_BASE}/${encodeURIComponent(jobId)}?expand=markdown_full`,
            { headers: llamaHeaders }, Math.max(1000, Math.min(5000, llamaDeadlineMs - Date.now())));
          if (!pollResponse.ok) { status = `HTTP_${pollResponse.status}`; break; }
          body = await pollResponse.json();
          status = body?.job?.status || body?.status || null;
          if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') break;
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }
      const durationMs = Date.now() - llamaStartMs;
      const text = status === 'COMPLETED' ? llamaParseMarkdown(body) : '';
      if (text.length > 50) {
        console.log(`[ocr] LlamaParse success: ${text.length} chars from ${fileName} in ${durationMs}ms`);
        await logToAxiom({ endpoint: 'ocr', status: 200, reason: 'llamaparse_success', fileName, userId, chars: text.length, durationMs, ip: req.headers['x-forwarded-for'] || null });
        return res.status(200).json({ text, source: 'llamaparse' });
      }
      const reason = !submitResponse.ok ? 'llamaparse_http_error' : !jobId ? 'llamaparse_no_job'
        : status === 'COMPLETED' ? 'llamaparse_empty_text' : status === 'FAILED' || status === 'CANCELLED' ? 'llamaparse_failed'
        : String(status).startsWith('HTTP_') ? 'llamaparse_poll_error' : 'llamaparse_timeout';
      console.log(`[ocr] LlamaParse ${reason} (${status || submitResponse.status})`);
      await logToAxiom({ endpoint: 'ocr', status: 200, reason, fileName, userId, httpStatus: submitResponse.ok ? null : submitResponse.status, jobStatus: status, durationMs, ip: req.headers['x-forwarded-for'] || null });
    } catch (err) {
      const timedOut = err.name === 'AbortError';
      console.log(`[ocr] LlamaParse ${timedOut ? 'timed out' : 'threw'}: ${err.message || 'unknown'}`);
      await logToAxiom({ endpoint: 'ocr', status: 200, reason: timedOut ? 'llamaparse_timeout' : 'llamaparse_threw', fileName, userId, durationMs: Date.now() - llamaStartMs, ip: req.headers['x-forwarded-for'] || null });
    }
  }

  // Tier 2: Mistral. 2026-10-23: it returned HTTP 429 on every production call seen this month
  // (provider quota/billing, not code) - kept as a fallback in case that clears.
  if (mistralKey && remainingMs() > 3000) {
    // Mistral only being down is exactly the condition that sends traffic to Datalab below,
    // so a hang here (not just a fast error) would eat the time budget the fallback tiers need.
    // 30s (not a shorter number): Mistral's OCR endpoint is synchronous with no documented
    // server-side timeout, and no independently-observed per-page latency figure exists publicly
    // (their "2000 pages/min" figure is a GPU-cluster throughput claim, not measured single-request
    // latency for markdown+bbox generation). A too-short timeout here would misclassify a slow-but-
    // working Mistral call as "down" and route it to the paid Datalab tier unnecessarily — the
    // opposite of the "only when Mistral is actually down" intent. Duration is logged to Axiom below
    // on every outcome so this number can be tuned from real production data instead of guesswork.
    const mistralStartMs = Date.now();
    try {
      console.log(`[ocr] trying Mistral OCR for: ${fileName}`);

      const mistralResponse = await fetchWithTimeout("https://api.mistral.ai/v1/ocr", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${mistralKey}`
        },
        body: JSON.stringify({
          model: "mistral-ocr-latest",
          document: {
            type: "document_url",
            document_url: dataUri
          },
          include_blocks: true
          // table_format deliberately left at Mistral's default (markdown), NOT "html" —
          // reverted after a live test (2026-08-08) showed HTML table markup breaking two
          // parts of the downstream pipeline in enrich.js: the line-based signal filter
          // (built assuming one markdown table row per line) and the effectiveCharCap slice
          // (HTML tags are ~2-3x more verbose than markdown pipe-tables for the same data,
          // so dense tables blew the 2500-5000 char budget where markdown wouldn't have).
          // Real symptom: a scanned central-bank financial-statement PDF's two dense
          // tables vanished entirely from the generated skill file. include_blocks is safe
          // to keep — bounding boxes live in a separate response field, never touching the
          // markdown text that gets filtered/sliced.
        })
        // 2026-10-23: still up to 30s, but clipped so a signed-in request keeps ~19s for Datalab
        // after it (LlamaParse now runs first and may have used part of the 60s).
      }, Math.max(3000, Math.min(30000, remainingMs() - (datalabKey && !isAnonymousRequest ? 19000 : 1000))));

      if (mistralResponse.ok) {
        const data = await mistralResponse.json();
        const text = data.pages.map(p => p.markdown).join("\n\n").trim();
        const mistralDurationMs = Date.now() - mistralStartMs;

        if (text.length > 50) {
          // Block extraction requires OCR 4+ (mistral-ocr-latest resolves there as of 2026-07-26);
          // older models silently accept include_blocks but return an empty array per page.
          const blocks = data.pages.map(p => ({ page: p.index, blocks: p.blocks || [] }));
          console.log(`[ocr] Mistral success: ${text.length} chars from ${fileName} in ${mistralDurationMs}ms`);
          // Real per-request latency, not published anywhere by Mistral — logged so the 30s
          // timeout above can eventually be tuned from actual production numbers, not a guess.
          await logToAxiom({ endpoint: 'ocr', status: 200, reason: 'mistral_success', fileName, userId, pageCount: data.pages.length, durationMs: mistralDurationMs, ip: req.headers['x-forwarded-for'] || null });
          return res.status(200).json({ text, source: 'mistral', blocks });
        }
        await logToAxiom({ endpoint: 'ocr', status: 200, reason: 'mistral_empty_text', fileName, userId, pageCount: data.pages.length, durationMs: mistralDurationMs, ip: req.headers['x-forwarded-for'] || null });
      } else {
        console.log(`[ocr] Mistral HTTP ${mistralResponse.status}`);
        await logToAxiom({ endpoint: 'ocr', status: 200, reason: 'mistral_http_error', fileName, userId, httpStatus: mistralResponse.status, durationMs: Date.now() - mistralStartMs, ip: req.headers['x-forwarded-for'] || null });
      }
    } catch (err) {
      const timedOut = err.name === 'AbortError';
      console.log(`[ocr] Mistral ${timedOut ? 'timed out' : 'threw'}: ${err.message || 'unknown'}`);
      await logToAxiom({ endpoint: 'ocr', status: 200, reason: timedOut ? 'mistral_timeout' : 'mistral_threw', fileName, userId, durationMs: Date.now() - mistralStartMs, ip: req.headers['x-forwarded-for'] || null });
    }
  }

  const DATALAB_DAILY_LIMIT = 3;
  let datalabAllowed = true;

  // Anonymous requests skip the paid Datalab tier entirely — it's gated by a per-Clerk-user
  // daily quota, and there's no userId to track for an anonymous request. Anonymous OCR
  // still gets Mistral (above) and OCR.space (below), neither of which are user-quota-gated.
  // (2026-10-23: OCR.space is removed; anonymous OCR gets LlamaParse and Mistral above.)
  if (isAnonymousRequest) datalabAllowed = false;
  // 2026-10-23: Datalab needs ~19s (5s submit + 12s poll + logging); with less left before the
  // 55s deadline it is skipped rather than started and cut off mid-job (a submitted job can bill).
  if (remainingMs() < 19000) datalabAllowed = false;

  if (datalabKey && datalabAllowed) {
    try {
      // Counts the attempt now, before the paid submit (2026-10-23, atomic Redis counter).
      if (!(await reserveDatalab(redis, userId))) {
        datalabAllowed = false;
        console.log(`[ocr] Datalab daily cap reached for user ${userId} (${DATALAB_DAILY_LIMIT}/day)`);
        await logToAxiom({ endpoint: 'ocr', status: 200, reason: 'datalab_quota_skipped', fileName, userId, ip: req.headers['x-forwarded-for'] || null });
      }
    } catch (err) {
      // Fail closed on the quota read itself — skip the paid tier rather than risk an
      // uncapped call, same posture as enrich.js's Clerk-read fail-closed quota gate.
      datalabAllowed = false;
      console.log('[ocr] Datalab quota check failed, skipping paid tier:', err?.message || 'unknown');
    }
  }

  // NOTE (known, accepted, not fixed here): this quota check and the increment after a successful
  // call below are a non-atomic read-modify-write against Clerk metadata — concurrent requests from
  // the same user (e.g. a multi-file batch upload, which the frontend fires as Promise.allSettled
  // over all files at once) can all read the same stale dailyCount and all pass the cap. This is the
  // same class of race enrich.js's Gemini quota gate already has and has already deferred to Upstash
  // Redis (see relatch-quota-security-fixes memory) — not re-solved here to avoid introducing new,
  // unverified concurrency-control code the night before launch. The real backstop against runaway
  // spend is the $8 hard cap Manas set directly on the Datalab API key in their dashboard, which holds
  // regardless of whether this counter under-counts.
  // 2026-10-23: FIXED - the check-and-count is now one atomic Redis INCR (reserveDatalab) taken
  // before the submit, so parallel files cannot all pass. The $8 key cap stays as the backstop.
  if (datalabKey && datalabAllowed) {
    try {
      console.log(`[ocr] trying Datalab OCR fallback for: ${fileName}`);

      const rawBase64 = dataUri.includes(',') ? dataUri.slice(dataUri.indexOf(',') + 1) : dataUri;
      const fileBuffer = Buffer.from(rawBase64, 'base64');
      const form = new FormData();
      form.append('file', new Blob([fileBuffer], { type: fileMime }), fileName);
      form.append('output_format', 'markdown');
      form.append('mode', 'balanced'); // same $4/1000-page rate as 'fast', better quality — no reason to use 'fast'
      // 25 (not 40): sized to comfortably finish inside the 12s poll budget below at Datalab's own
      // stated worst-case ~3 pages/sec (25/3≈8.3s + margin), rather than the two numbers being picked
      // independently and only fitting together in the best case. Kept tight because this budget
      // stacks behind Mistral's own 30s above — see the overall worst-case accounting below.
      form.append('max_pages', '25');

      const submitResponse = await fetchWithTimeout('https://www.datalab.to/api/v1/convert', {
        method: 'POST',
        headers: { 'X-Api-Key': datalabKey },
        body: form,
      }, 5000); // submit only enqueues the job and returns a request_id — should be near-instant per Datalab's own docs, not the actual OCR processing time

      if (submitResponse.ok) {
        const submitData = await submitResponse.json();
        const checkUrl = submitData.request_check_url;

        let result = null;
        if (checkUrl) {
          // 12s overall budget, sized against the 25-page cap above. Checks immediately first (no
          // guaranteed wasted delay for jobs that finish fast), then backs off 2s between checks.
          // Each individual poll request also has its own 5s timeout — the outer deadline alone
          // doesn't help if a single poll call hangs, since the loop can't re-check the clock while
          // it's still awaiting that call. Overall worst-case accounting (Mistral 30s + its Axiom
          // log 2s + Datalab submit 5s + this 12s poll + its Axiom log 2s = 51s) leaves ~9s for
          // OCR.space + response before Vercel's 60s function ceiling — real margin, not razor-thin.
          const deadline = Date.now() + 12000;
          let firstCheck = true;
          while (Date.now() < deadline) {
            if (!firstCheck) await new Promise((resolve) => setTimeout(resolve, 2000));
            firstCheck = false;
            const pollResponse = await fetchWithTimeout(checkUrl, { headers: { 'X-Api-Key': datalabKey } }, 5000);
            if (!pollResponse.ok) break;
            const pollData = await pollResponse.json();
            if (pollData.status === 'complete') { result = pollData; break; }
            if (pollData.status === 'failed') break;
          }
        }

        if (result) {
          // Datalab bills per page once a job reaches 'complete', independent of whether the
          // extracted text clears our own length gate below. (2026-10-23: the spend used to be
          // recorded here, after the fact, in Clerk metadata; reserveDatalab now counts it
          // before the submit.)
          await logToAxiom({
            endpoint: 'ocr',
            status: 200,
            reason: result.success ? 'datalab_success' : 'datalab_processing_failed',
            fileName,
            userId,
            pageCount: result.page_count ?? null,
            cost: result.cost_breakdown ?? null,
            ip: req.headers['x-forwarded-for'] || null,
          });

          if (result.success && result.markdown) {
            const text = result.markdown.trim();
            if (text.length > 50) {
              console.log(`[ocr] Datalab success: ${text.length} chars from ${fileName}`);
              return res.status(200).json({ text, source: 'datalab' });
            }
          }
        } else {
          console.log(`[ocr] Datalab did not complete within the poll window for: ${fileName}`);
        }
      } else {
        console.log(`[ocr] Datalab HTTP ${submitResponse.status}`);
      }
    } catch (err) {
      console.log(`[ocr] Datalab threw: ${err.message || 'unknown'}`);
    }
  }

  // 2026-10-23: the OCR.space tier (last free fallback, OCREngine 2, 8s timeout) was removed at
  // Manas's request after the LlamaParse benchmark: on a phone-photo scan it dropped decimal points
  // (412.50 -> 41250) and row labels, and it never kept table structure. OCRCLD_API_KEY is unused.

  console.log(`[ocr] all OCR methods failed for: ${fileName}`);
  await logToAxiom({ endpoint: 'ocr', status: 422, reason: 'ocr_failed', fileName, ip: req.headers['x-forwarded-for'] || null });
  return res.status(422).json({
    error: 'OCR_FAILED',
    message: 'Could not extract text from this document. It may be image-based, encrypted, or corrupted.',
  });
};
