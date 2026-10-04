const { verifyToken, createClerkClient } = require('@clerk/backend');
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
const { Redis } = require('@upstash/redis');
const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;
const { Axiom } = require('@axiomhq/js');
const axiomClient = process.env.AXIOM_TOKEN
  ? new Axiom({ token: process.env.AXIOM_TOKEN, edge: 'us-east-1.aws.edge.axiom.co' })
  : null;
// Jev planning layer (2026-09-26): fail-open typed decisions about the document before
// template routing. See lib/planner.js - every export is a no-op on a null plan.
const { planDocument, routeTemplate, routeCodexShape, buildPlanDirectives, buildFacetModules, summarizePlan, mapContent, spreadSelect, SPREAD_NOTE, summarizeContent } = require('../lib/planner');
// Parachute Gating (2026-09-28): deterministic quality gate, SHADOW mode only for now (see the
// PARACHUTE block before the model loop). Pure functions; lib/parachute.js has no I/O.
// 2026-10-03: P3 (PARACHUTE_MODE=enforce) and P4 (=escalate) let it act on what is served.
const parachute = require('../lib/parachute');
// Shadow events go through their OWN Axiom client: the SDK serializes flushes per client, so
// a slow gate flush on the shared client would hold up the security logs queued behind it
// (code review 2026-09-28, measured with a 3s Axiom: a 503 reply went from 3s to 6s).
const gateAxiom = process.env.AXIOM_TOKEN
  ? new Axiom({ token: process.env.AXIOM_TOKEN, edge: 'us-east-1.aws.edge.axiom.co' })
  : null;
// Vercel's waitUntil keeps the function alive after the reply until the promise settles. This is
// the same lookup @vercel/functions makes (get-context.js), inlined to avoid its 25-package
// dependency tree. Outside Vercel, or if the symbol ever changed, it is a no-op and the promise
// simply runs.
const waitUntil = (promise) => globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil?.(promise);
// Once per cold start, so a mis-set PARACHUTE_MODE shows in the logs instead of silently doing nothing.
if (process.env.PARACHUTE_MODE) console.log('[gate] PARACHUTE_MODE', JSON.stringify(process.env.PARACHUTE_MODE), gateAxiom ? 'axiom on' : 'no AXIOM_TOKEN: shadow disabled, enforce/escalate act without events');

async function logToAxiom(event) {
  if (!axiomClient) return;
  try {
    axiomClient.ingest('relatch-security', [{ ...event, _time: new Date().toISOString() }]);
    await axiomClient.flush();
  } catch (err) {
    console.log('[axiom] log failed:', err?.message || 'unknown');
  }
}

// 2026-10-04 (input-cap review): every client-sent string is clipped once, at handler entry, so
// no downstream path (generation prompts, Jev calls, regexes, Redis keys) ever sees
// attacker-sized input. Each limit sits well above what App.tsx can send: rawText is at most
// a 40,000-char medium document (large documents arrive as an 8k sample, Codex text is
// distilled to its cap), and its 120,000 limit also stays above GATE_MAX_SOURCE so the gate's
// own large-source skip keeps working as tested; the longest domainRole/domainFrame there is
// 239 chars; fileName is the user's own file name; sessionId is `session_<ms>_<6 chars>`. A real
// request is never changed. Prompts are bounded separately by SERVER_CHAR_CAP below.
const BODY_LIMITS = {
  rawText: 120000, fileName: 255, category: 40, domainLabel: 100, domainRole: 400, domainFrame: 400,
  template: 20, sizeClass: 20, target: 20, codexShape: 40, sessionId: 128,
};
// The server's ceiling on how much source text one generation prompt may carry, per size class.
// Equal to what App.tsx sends as charCap today; the input-cap study may raise them. The legacy
// sizeClass reconstruction in the handler keeps its own 5000/8000 literals on purpose: those
// map the values old clients SENT, not these ceilings, so raising a ceiling must not move them.
// 2026-10-04 (later): a ceiling is the MOST a client may ask for, not what it gets. App.tsx
// still asks for 3500/5000/8000, so real requests are unchanged; medium and large are 4x that
// so the input-cap study can bake 2x/4x inputs through the real pipeline (#26 merged before the
// study ran). Still bounded: 32,000 chars is ~8k tokens, not the ~1M that #26 closed. The
// study's result sets the values App.tsx asks for, and these may come down to match.
// 2026-10-04 (study result): 2x read more of the source with no cut-offs, no invented numbers
// and no added latency; 4x added nothing over 2x. App.tsx now asks for 2x on the Claude target
// (10000 medium, a 16000-char sample for large; Codex and small unchanged), so the ceilings come
// down to exactly 2x: nothing beyond what the app uses is accepted.
const SERVER_CHAR_CAP = { small: 3500, medium: 10000, large: 16000 };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.relatch.online');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Anon-Token');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Clip client strings in place before anything reads req.body (see BODY_LIMITS above).
  if (req.body && typeof req.body === 'object') {
    for (const [k, n] of Object.entries(BODY_LIMITS)) {
      if (typeof req.body[k] === 'string' && req.body[k].length > n) req.body[k] = req.body[k].slice(0, n);
    }
  }

  // Auth: a Bearer header ALWAYS takes precedence and is verified through the unchanged
  // Clerk path, full stop — this is deliberate, not an oversight. An earlier version of
  // this branch checked X-Anon-Token first regardless of Authorization, which meant any
  // signed-in user (or anyone who noticed the header) could bypass their own Clerk
  // daily/weekly quota just by also sending a freshly self-minted X-Anon-Token. Caught in
  // review before shipping. X-Anon-Token is now only even considered when there is no
  // Bearer header at all — never as a way to override or supplement one that is present,
  // valid or not. See relatch-main/api/anon-token.js for issuance.
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
      await logToAxiom({ endpoint: 'enrich', status: 401, reason: 'invalid_session', ip: req.headers['x-forwarded-for'] || null });
      return res.status(401).json({ error: 'Invalid session' });
    }
  } else if (anonToken) {
    if (!redis) {
      await logToAxiom({ endpoint: 'enrich', status: 401, reason: 'anon_redis_unconfigured', ip: req.headers['x-forwarded-for'] || null });
      return res.status(401).json({ error: 'ANON_TOKEN_INVALID' });
    }
    // NOT single-use (GETDEL) — a real "run" is not one HTTP call: a multi-file batch
    // sends one /api/enrich per file (App.tsx's Promise.allSettled over allFiles, same
    // pattern the authenticated sessionId dedup below already exists to bundle), and any
    // file needing OCR calls /api/ocr first. A strict single-consume token dies on the
    // second file or the post-OCR call, breaking the anonymous trial for exactly those
    // cases. Instead this mirrors the free-session generosity already granted to signed-in
    // users just below (SESSION_TTL_MS / MAX_FREE_REQUESTS_PER_SESSION) — see the call-count
    // cap right after this block for the compensating bound that generosity needs.
    //
    // 2026-08-30 fix: the above (allowing repeated use within the token's TTL, bounded only
    // by a call count) was itself too permissive — live-tested by Manas: refreshing the page
    // and starting a completely separate second run still succeeded with the same stored
    // token, producing two free generations instead of one. Real "one trial" is bound to a
    // specific run, not a time window. `sessionId` (already generated once per upload batch
    // in App.tsx's handleFiles, and already the exact mechanism the signed-in quota gate
    // below uses for its own "same batch" dedup) is the right unit: the token's FIRST real
    // use claims it for that sessionId; every subsequent call with that SAME sessionId still
    // works (same run, multiple files); a call with a DIFFERENT sessionId means a genuinely
    // new/second run and is rejected — that's the actual one-time boundary.
    // Deliberately a literal, not a reference to MAX_FREE_REQUESTS_PER_SESSION below — that
    // const is declared later in this function (inside the quota-gate section) and referencing
    // it here would throw a TDZ ReferenceError on every anonymous request. Keep this value in
    // sync with MAX_FREE_REQUESTS_PER_SESSION by hand if that one ever changes.
    const ANON_MAX_ENRICH_CALLS = 5;
    const requestSessionId = req.body?.sessionId;
    if (!requestSessionId) {
      // No sessionId means this call can't be bound/tracked as belonging to a specific run —
      // reject rather than risk granting an untracked anonymous generation. Every real upload
      // batch always sends one (App.tsx handleFiles generates it unconditionally).
      await logToAxiom({ endpoint: 'enrich', status: 401, reason: 'anon_missing_session_id', ip: req.headers['x-forwarded-for'] || null });
      return res.status(401).json({ error: 'ANON_TOKEN_INVALID' });
    }
    try {
      const validToken = await redis.get(`anon:${anonToken}`);
      if (validToken === null) {
        await logToAxiom({ endpoint: 'enrich', status: 401, reason: 'anon_token_invalid', ip: req.headers['x-forwarded-for'] || null });
        return res.status(401).json({ error: 'ANON_TOKEN_INVALID' });
      }
      // Claim atomically via SET NX (same primitive anon-token.js already uses to issue the
      // token itself) rather than GET-then-conditional-SET — a plain read-then-write here
      // would race: two concurrent requests carrying the same token but different sessionIds
      // could both read "unclaimed" before either write lands, and both slip through as
      // "first use." SET NX makes the claim itself atomic; only the loser needs a follow-up
      // read to find out who won.
      const claimedSessionKey = `anon:${anonToken}:session`;
      const claimResult = await redis.set(claimedSessionKey, requestSessionId, { nx: true, ex: 600 });
      if (claimResult === null) {
        // Key already existed — this token was already claimed (by this same request race,
        // a genuine earlier call, or a concurrent one). Read back and compare as strings:
        // Upstash's REST client auto-JSON-parses GET results, so a purely-numeric sessionId
        // would come back as a JS number and silently fail a strict !== against the current
        // request's string — coercing both sides avoids that entirely, not just today's
        // sessionId format (always non-numeric-prefixed, but not guaranteed to stay that way).
        const claimedSessionId = await redis.get(claimedSessionKey);
        if (String(claimedSessionId) !== String(requestSessionId)) {
          // Claimed by a genuinely different run — this IS the one-trial-ever boundary.
          await logToAxiom({ endpoint: 'enrich', status: 401, reason: 'anon_session_mismatch', ip: req.headers['x-forwarded-for'] || null });
          return res.status(401).json({ error: 'ANON_TOKEN_INVALID' });
        }
        // else: claimed by OUR OWN sessionId — a legitimate second file in the same batch.
      }
      // Bounds spend within one legitimate run (a multi-file batch calls this per file).
      const callCount = await redis.incr(`anon:${anonToken}:calls`);
      if (callCount === 1) await redis.expire(`anon:${anonToken}:calls`, 600);
      if (callCount > ANON_MAX_ENRICH_CALLS) {
        await logToAxiom({ endpoint: 'enrich', status: 401, reason: 'anon_call_cap_reached', ip: req.headers['x-forwarded-for'] || null });
        return res.status(401).json({ error: 'ANON_TOKEN_INVALID' });
      }
    } catch (redisErr) {
      // Fail closed, matching every other external-call posture in this file.
      console.error('[anon] Redis check failed:', redisErr?.message || redisErr);
      await logToAxiom({ endpoint: 'enrich', status: 401, reason: 'anon_redis_error', ip: req.headers['x-forwarded-for'] || null });
      return res.status(401).json({ error: 'ANON_TOKEN_INVALID' });
    }
    isAnonymousRequest = true;
  } else {
    await logToAxiom({ endpoint: 'enrich', status: 401, reason: 'missing_bearer', ip: req.headers['x-forwarded-for'] || null });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // V2: destructure new fields from frontend (template, richFormats, charCap)
  // Old fields remain exactly the same — backward compatible if frontend hasn't updated yet
  // richFormats: consumed by Claude prompt templates only. Codex path uses codexSourceHint
  // pre-scan (v2.2.1) for dynamic structure detection — intentionally unused on Codex path.
  const { rawText, category, fileName, domainLabel, domainRole, domainFrame, template, richFormats, charCap, sizeClass, target = 'claude', codexShape = 'execute', sessionId } = req.body;
  if (!rawText || !category || !fileName) {
    await logToAxiom({ endpoint: 'enrich', status: 400, reason: 'missing_fields', userId, ip: req.headers['x-forwarded-for'] || null });
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // 2026-09-26 (Jev planning layer): timeouts widened for the 300s function window.
  // The old 60s wall was self-imposed by vercel.json, not a Vercel limit - Hobby with
  // Fluid Compute allows 300s (verified live via the Vercel API 2026-09-24). Was model1
  // 25/25/35s and model2 20/20/18s; the 60s-era sizing notes further down are history.
  const CODEX_POLICY = {
    timeouts: {
      // 2026-09-26 truncation fix: model1 45/60/75s -> 60/75/90s so the raised token caps
      // (tokenBudgets below, up to 2600 x 1.5 = 3900 on a dense large doc) still finish at
      // Gemini's ~55 tok/s degraded floor (~71s). Worst case 4 + 90 + 40 + ~5 = ~139s < 280s.
      model1: { small: 60000, medium: 75000, large: 90000 },
      model2: { small: 40000, medium: 40000, large: 40000 },
    },
    tokenBudgets: {
      small:  { lite: 1000, flash: 1000 },
      medium: { lite: 1400, flash: 1200 },
      large:  { lite: 1800, flash: 1400 },
    },
    qualityThresholds: { lite: 6, flash: 4 },
    model2ReserveMs: 8000,
  };
  const requestStartMs = Date.now();
  // Internal budget inside vercel.json's maxDuration (300s), leaving 20s for sanitize,
  // the Clerk quota write and response serialization. Replaces the old hardcoded 58000.
  const FUNCTION_BUDGET_MS = 280000;

  // ─── QUOTA GATE ──────────────────────────────────────────────────────────────
  const DAILY_LIMIT  = 5;
  const WEEKLY_LIMIT = 35;
  // Session dedup window. A multi-file batch shares one client-supplied sessionId so it
  // counts once; but sessionId is client-controlled, so an unbounded bypass is possible
  // by replaying a fixed sessionId forever. Honour the dedup only while the session is
  // fresh — legitimate batches finish in seconds, replay attacks do not.
  const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
  // The frontend caps a single upload batch at 3 files (App.tsx FileUploadZone), so a
  // legitimate session never needs more than 3 free (uncounted) requests. 5 gives headroom
  // for a stray retry. Without this cap, a client that keeps replaying the same sessionId
  // forever gets literally unlimited free Gemini calls inside every 10-minute window — this
  // bounds the exploit to (DAILY_LIMIT/WEEKLY_LIMIT) x MAX_FREE_REQUESTS_PER_SESSION instead,
  // since renewing the free window still costs one real counted generation each time.
  const MAX_FREE_REQUESTS_PER_SESSION = 5;

  function getDateKey(now) {
    return now.toISOString().slice(0, 10);
  }

  function getIsoWeekKey(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }

  let quotaUsage = null;
  let quotaUser  = null;

  // Anonymous requests never touch Clerk-backed quota — there is no userId to look up,
  // and the one-time anon token already bounds usage to exactly one run by construction.
  // quotaUsage/quotaUser stay null, which the post-generation write below (`if (quotaUsage
  // && quotaUser)`) already treats as "nothing to record."
  if (!isAnonymousRequest) {
  try {
    quotaUser = await clerkClient.users.getUser(userId);
    const now = new Date();
    const currentDayKey  = getDateKey(now);
    const currentWeekKey = getIsoWeekKey(now);

    const stored = quotaUser.privateMetadata?.relatchUsage ?? {};
    quotaUsage = {
      dailyCount:    stored.dailyCount    ?? 0,
      weeklyCount:   stored.weeklyCount   ?? 0,
      lastDayKey:    stored.lastDayKey    ?? currentDayKey,
      lastWeekKey:   stored.lastWeekKey   ?? currentWeekKey,
      lastSessionId: stored.lastSessionId ?? null,
      lastSessionStartedAt: stored.lastSessionStartedAt ?? 0,
      sessionRequestCount: stored.sessionRequestCount ?? 0,
    };

    if (quotaUsage.lastDayKey !== currentDayKey) {
      quotaUsage.dailyCount = 0;
      quotaUsage.lastDayKey = currentDayKey;
    }

    if (quotaUsage.lastWeekKey !== currentWeekKey) {
      quotaUsage.weeklyCount = 0;
      quotaUsage.lastWeekKey = currentWeekKey;
    }

    const isSameSession = sessionId
      && quotaUsage.lastSessionId === sessionId
      && (now.getTime() - quotaUsage.lastSessionStartedAt) < SESSION_TTL_MS
      && quotaUsage.sessionRequestCount < MAX_FREE_REQUESTS_PER_SESSION;

    if (!isSameSession) {
      if (quotaUsage.dailyCount >= DAILY_LIMIT || quotaUsage.weeklyCount >= WEEKLY_LIMIT) {
        const limitType  = quotaUsage.dailyCount >= DAILY_LIMIT ? 'daily' : 'weekly';
        const limitValue = limitType === 'daily' ? DAILY_LIMIT : WEEKLY_LIMIT;
        await logToAxiom({ endpoint: 'enrich', status: 429, reason: 'quota_reached', limitType, userId, ip: req.headers['x-forwarded-for'] || null });
        return res.status(429).json({
          error: 'QUOTA_REACHED',
          limitType,
          limitValue,
          weeklyCount: quotaUsage.weeklyCount,
          weeklyLimit: WEEKLY_LIMIT,
          message: `You have used all ${limitValue} free generations for this ${limitType === 'daily' ? 'day' : 'week'}. Your quota resets automatically ${limitType === 'daily' ? 'tomorrow' : 'next week'}.`,
        });
      }
    }
  } catch (quotaErr) {
    console.error('[quota] Clerk read failed:', quotaErr?.message || quotaErr);
    // Fail CLOSED: if we cannot verify the quota, we do not generate. Proceeding here
    // would call Gemini with zero quota checking and zero recording (free generations
    // during any Clerk outage/rate-limit). The frontend treats this 503 as a generic
    // failure and serves its local deterministic fallback, so the user is not dead-ended.
    await logToAxiom({ endpoint: 'enrich', status: 503, reason: 'quota_unavailable', userId, ip: req.headers['x-forwarded-for'] || null });
    return res.status(503).json({
      error: 'QUOTA_UNAVAILABLE',
      message: 'Unable to verify your usage quota right now. Please try again in a moment.',
    });
  }
  }
  // ─── END QUOTA GATE ──────────────────────────────────────────────────────────

  // Note (2026-10-04): processedText is not read anywhere below; BODY_LIMITS (top of file) is
  // what bounds rawText.
  const processedText = rawText.length > 15000 ? rawText.slice(0, 15000) : rawText;

  // UNCHANGED — exact same validation logic as before
  const hasEnoughLength = rawText.trim().length > 150;
  const hasRealWords = /[a-zA-Z]{3,}/.test(rawText);
  const isRepetitiveNoise = (() => {
    const words = rawText.trim().split(/\s+/).slice(0, 50);
    const unique = new Set(words.map(w => w.toLowerCase()));
    return words.length > 10 && unique.size < words.length * 0.3;
  })();

  if (!hasEnoughLength || !hasRealWords || isRepetitiveNoise) {
    await logToAxiom({ endpoint: 'enrich', status: 422, reason: 'insufficient_signal', userId, ip: req.headers['x-forwarded-for'] || null });
    return res.status(422).json({
      error: 'INSUFFICIENT_SIGNAL',
      message: 'Not enough content to generate a skill file.',
    });
  }

  // ── JEV LAYER (2026-09-26 content fidelity) ──────────────────────────────────
  // The plan and the content map run as ONE parallel step here, before the signal filter, so
  // page furniture (menus, sign-in prompts, footers, TOC, repeated headers) is removed before
  // anything is filtered or truncated. Placed after auth, the quota gate and the 422 validation
  // so no Jev call is spent on rejected requests. Both are fail-open: with no key or on any
  // failure they return null and every step below is exactly the pre-Jev path.
  // effectiveSizeClass moved up here from the ADAPTIVE OUTPUT BUDGET block (unchanged; it only
  // reads sizeClass and charCap) because the planner needs it before the filter.
  // Derive sizeClass from frontend signal. If frontend is old and didn't send
  // sizeClass, reconstruct from charCap with same thresholds as App.tsx profiler.
  const effectiveSizeClass =
    sizeClass === 'large' || sizeClass === 'medium' || sizeClass === 'small'
      ? sizeClass
      : charCap >= 8000
        ? 'large'
        : charCap >= 5000
          ? 'medium'
          : 'small';
  const [plan, contentMap] = await Promise.all([
    planDocument({ text: rawText, fileName, category, sizeClass: effectiveSizeClass, target: target === 'codex' ? 'codex' : 'claude' }),
    mapContent({ text: rawText, fileName, template }),
  ]);
  // Furniture removed (whole original lines, original order); rawText when no map.
  const sourceText = contentMap ? contentMap.text : rawText;
  // ─────────────────────────────────────────────────────────────────────────────

  // Signal-line filter. Claude path uses the original behavioral-keyword criteria
  // exactly as before. v2.2.1 adds a Codex-only branch that preserves code-shaped
  // lines (declarations, control flow, syntax-marker chars, comments) — these have
  // no digits / no action verbs / no colons and would otherwise be dropped, hurting
  // EXECUTE-shape output on code-heavy sources. v2.3 (Template B) adds an identical
  // clause for the Claude path when template === 'B' so structural code lines survive
  // the filter and reach the Codebase Intelligence prompt. Uses `template` (from
  // req.body, line 25) rather than `activeTemplate` which is not yet in scope here.
  // 2026-09-26: reads sourceText (rawText with page furniture removed by the content map, or
  // rawText itself when there is no map) - see the JEV LAYER block above.
  const allLines = sourceText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const signalLines = allLines.filter(line =>
    line.length > 20 && (
      /\d/.test(line) ||
      /\b(always|never|use|create|build|write|make|avoid|ensure|must|should|start|end|keep|focus|lead|design|follow|apply|open|close|prefer|every|each)\b/i.test(line) ||
      line.includes(':') ||
      /^[-•*#>]/.test(line) ||
      /^(\d+[.)]\s|#{1,3}\s)/.test(line) ||
      line.endsWith('.') || line.endsWith('!') || line.endsWith('?') ||
      // ─── v2.4 (Template A): Persona-signal clause ────────────────────────────
      // Captures structural habit descriptors and voice marker lines that carry
      // none of the standard filter signals (no digits, action verbs, colons, or
      // terminal punctuation). These are the primary evidence for ## Signature
      // Patterns extraction. Gate: A + claude path only.
      // Uses `template` from req.body (line 29), NOT `activeTemplate` (temporal dead zone).
      (template === 'A' && target !== 'codex' && (
        /\b(tone|voice|style|pattern|habit|rhythm|vocabulary|phrasing|phrase|structure|framework|principle|belief|value|tendency|emphasis|contrast|inversion|compression|aphorism|metaphor|narrative|persona|trait|characteristic|approach|method|technique|rhetoric|argument|logic|reasoning|analysis|observation|insight|analogy|cadence)\b/i.test(line)
      )) ||
      // ─────────────────────────────────────────────────────────────────────────
      (template === 'B' && target !== 'codex' && (
        /^\s*(const|let|var|function|class|interface|type|import|export|async|await|return|def|fn|fun|impl|use|struct|enum|trait|public|private|protected)\b/.test(line) ||
        /[{};]|=>|::/.test(line) ||
        /^\s*(\/\/|\/\*|\*\s)/.test(line)
      )) ||
      (target === 'codex' && (
        /^\s*(const|let|var|function|class|interface|type|import|export|async|await|return|def|fn|fun|impl|use|struct|enum|trait|public|private|protected|namespace|module|require|template|throw|throws|try|catch|finally|new|this|super|extends|implements|abstract|static|virtual)\b/.test(line) ||
        /[{};]|=>|::|->/.test(line) ||
        /^\s*(\/\/|\/\*|\*\s|#\s)/.test(line)
      ))
    )
  );

  const filteredText = signalLines.length >= 5 ? signalLines.join('\n') : sourceText;

  // V2: use charCap from profiler if provided, otherwise fall back to original logic
  // 2026-10-04: the server owns the ceiling (SERVER_CHAR_CAP, top of file). charCap comes from
  // the client and was used as sent, so one crafted request could put ~1M tokens of source text
  // into a single generation prompt: the shared free-tier Gemini quota, or a paid DeepSeek call
  // in the hard lane. Real requests are unchanged (App.tsx asks for no more than the ceilings) and a
  // missing or zero charCap falls back exactly as before. A value under 1000 chars (negative,
  // fractional, true, non-numeric) now falls back too: it used to slice oddly (-5 kept all but
  // 5 chars, unbounded; 0.5 or 'abc' sent an empty text). Accepted, bounded (code review
  // 2026-10-04): the client still names its own sizeClass, so a forged 'large' gets the large
  // ceiling and budgets and may reach the hard lane, but only within its own request quota and
  // only if Jev finds >= 5 rich facets in the real text. The size class cannot be re-derived
  // from rawText here: Codex text arrives distilled to the cap and large documents as a sample.
  const clientCharCap = Math.floor(Number(charCap));
  const effectiveCharCap = Math.min(
    Number.isFinite(clientCharCap) && clientCharCap >= 1000 ? clientCharCap : (signalLines.length >= 5 ? 2500 : 3500),
    SERVER_CHAR_CAP[effectiveSizeClass]);
  // `let`, not `const`, since 2026-09-26: when Jev routes a non-B request INTO Template B,
  // this is replaced with the unfiltered source further down (see activeTemplate).
  // Content fidelity (2026-09-26): with a content map, an over-cap text is no longer cut to its
  // head - whole-line chunks are picked evenly from start to end (spreadSelect). No map = the
  // original head slice, byte for byte.
  const selection = contentMap ? spreadSelect(filteredText, effectiveCharCap) : { text: filteredText.slice(0, effectiveCharCap), spread: false };
  let textToSend = selection.text;

  // ── ADAPTIVE OUTPUT BUDGET ────────────────────────────────────────────────
  // (effectiveSizeClass is derived in the JEV LAYER block above since 2026-09-26.)

  // Token budgets per model, per sizeClass.
  // Derived from Vercel 60s gateway + 45s internal timeout + Gemini throughput rates.
  // Flash Lite: 55 tok/s degraded floor × 35s window = 1925 ceiling → 1800 safe.
  // 2.5 Flash: fallback only, shorter effective window → capped lower.
  // 2026-09-26 truncation fix: the lines above describe the old 60s window. With 300s
  // (Hobby + Fluid, vercel.json maxDuration) the caps were raised because the 1000-token
  // small cap was cutting complete skill files off mid-sentence: 3/3 small Template A files
  // in the 2026-09-25 bake-off ended mid-sentence (a complete small A file is ~1000-1200
  // tokens), and scoreOutput still scored them 9/9. These are ceilings, not targets - the
  // model stops when the file is done, so raising them adds no length and no cost by itself.
  // The Jev depth boost (x1.5) still applies on top. flash keeps its +700 OpenRouter pad below.
  const tokenBudgets = {
    small:  { lite: 1600, flash: 1600 },
    medium: { lite: 2000, flash: 1800 },
    large:  { lite: 2600, flash: 2200 },
  };
  const budgetForSize = tokenBudgets[effectiveSizeClass] || tokenBudgets.small;
  // ─────────────────────────────────────────────────────────────────────────

  // ── DOCUMENT CONTEXT HEADER ───────────────────────────────────────────────
  // Prepended to every template prompt. Orients the model on source complexity
  // without changing template structure, domain, role, or section format.
  // Small: no header — current behavior exactly preserved.
  // Medium: depth instruction only.
  // Large: depth instruction + sampling disclosure.
  // Rules: no ## markers (would corrupt scoreOutput section detection),
  //        no role/persona language (would conflict with domain frame),
  //        no minimum length instruction (invites padding on Flash Lite).
  const documentContext =
    effectiveSizeClass === 'large'
      ? `SOURCE CONTEXT: You have received sampled excerpts from a large document — beginning, middle, and end sections. Synthesize patterns that appear consistently across all excerpts as primary signals. Where sections differ, preserve the variation rather than collapsing it into one point. Expand each section to the depth the source material warrants. Go deeper only where source density justifies it. Do not repeat. Do not pad. Do not elaborate beyond what is grounded in the source.\n\n`
      : effectiveSizeClass === 'medium'
        ? `SOURCE CONTEXT: This document contains multiple frameworks, rules, or patterns. Expand each section to the depth the source warrants. Go deeper only where source density justifies it. Do not repeat. Do not pad.\n\n`
        : '';
  // ─────────────────────────────────────────────────────────────────────────

  // UNCHANGED — exact same category context as before
  const categoryContext = {
    personality: 'communication style, tone, voice patterns, how they phrase things, what they emphasize',
    instructions: 'rules, constraints, decision criteria, what to always do, what to never do',
    knowledge: 'domain expertise, mental models, frameworks they use, how they think about problems',
    examples: 'the patterns in these examples, structure, style, what makes them work',
    context: 'the situation, constraints, goals, audience, and environment that shapes decisions',
    preferences: 'specific choices, standards, non-negotiables, defaults, and pet peeves',
  };

  // v2.3: Codex-specific category focus strings — operational framing vs Claude's persona framing.
  // Claude uses persona-flavored descriptions ("communication style, tone, voice patterns").
  // Codex needs operational-flavored descriptions ("verifiable execution rules, command sequences").
  // Only used when target === 'codex'. categoryContext is byte-identical — no Claude impact.
  const codexCategoryContext = {
    personality: 'behavioral enforcement rules, voice compliance criteria, and style constraint definitions that can be applied as operational checks',
    instructions: 'verifiable execution rules, command sequences, checkable artifact states, hard constraints, and explicit refusal criteria',
    knowledge: 'operational frameworks, domain-specific decision criteria, constraint sets, and reference patterns that Codex can apply procedurally',
    examples: 'concrete reference implementations, before/after anti-pattern pairs, and approved pattern libraries with named artifacts',
    context: 'operational boundaries, environmental prerequisites, scope limitations, escalation triggers, and refusal conditions',
    preferences: 'non-negotiable defaults, enforced output standards, rejection criteria, and configuration invariants',
  };

  const focus = target === 'codex'
    ? (codexCategoryContext[category] || codexCategoryContext.knowledge)
    : (categoryContext[category] || categoryContext.knowledge);

  // UNCHANGED — exact same skillName derivation as before
  const skillName = fileName
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  const safeDomainLabel = domainLabel || 'General';
  const safeDomainRole = domainRole || 'an expert';
  const safeDomainFrame = domainFrame || 'communicate effectively';

  // v2.1: Codex export target — kebab-case slug for OpenAI Codex skill name
  const codexSlug = skillName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'my-skill';
  const activeTarget = target === 'codex' ? 'codex' : 'claude';

  // Jev planning layer (2026-09-26): one fan-out call, <=4s, fail-open. Placed after auth,
  // the quota gate and the 422 validation so no Jev call is spent on rejected requests.
  // Receives rawText (not the signal-filtered text) so it judges the whole document.
  // (Content fidelity, 2026-09-26: `plan` is now computed in the JEV LAYER block above, in
  // parallel with the content map and before the signal filter - same inputs as before.)

  // V2: determine active template — default to 'A' if not provided (backward compatible)
  // Jev may override A/C/D on a confident doc-type answer; B and E are never touched.
  // 2026-09-26: B now joins routing behind a double lock (Jev >= 0.9 AND code-like lines
  // counted in code) - see routeTemplate in lib/planner.js. E is still never touched.
  const activeTemplate = routeTemplate(template || 'A', plan, activeTarget);
  // Routed INTO B: the signal-line filter above ran with the client's template (it must read
  // `template`, not `activeTemplate` - TDZ rule) and drops most code-shaped lines on A/C/D.
  // Give B the unfiltered source instead, capped the same way. The filter itself is untouched.
  // (2026-09-26: from sourceText, so removed page furniture stays removed.)
  if (activeTemplate === 'B' && template !== 'B') textToSend = sourceText.slice(0, effectiveCharCap);
  // v2.1: when targeting Codex, override template selection to the CODEX prompt + scoring path
  const effectiveTemplate = activeTarget === 'codex' ? 'CODEX' : activeTemplate;

  // v2.2: Codex generation shape — three sub-templates with different cognitive profiles.
  // EXECUTE  = direct execution playbook (refactor guides, runbooks, migrations) — code-heavy
  // EXPERTISE = human-in-loop creative judgment (brand voice, design critique, copy) — prose + examples
  // SPECIALIST = constrained domain role (compliance, legal, ops) — flowcharts + decision matrices
  // Backward-compatible: defaults to 'execute' when not provided (the 70% bet).
  const allowedShapes = ['execute', 'expertise', 'specialist'];
  const clientCodexShape = allowedShapes.includes(codexShape) ? codexShape : 'execute';
  // Jev may override the regex-derived shape on a confident answer (Codex target only).
  const activeCodexShape = routeCodexShape(clientCodexShape, plan, activeTarget);
  // Depth boost: x1.5 output tokens only when Jev is confident the source is dense.
  // Claude only - Codex prompts keep a deliberate word budget. No plan = exactly today's budgets.
  // 2026-09-26: both targets now. The token cap is only a ceiling - Codex's prompt word budget
  // still governs its length - and Codex needs the headroom once modules are appended.
  const planTokenMultiplier = plan && plan.depth && plan.depth.dense ? 1.5 : 1;

  // v2.2.1: Source-structure pre-scan — detect which rich components the source
  // actually supports, so Codex prompts can tell Gemini what to render vs skip.
  // Without this, Gemini guesses — and on sources lacking branching/code/tables,
  // it either hallucinates fake components or bails to placeholder text (which
  // costs score points). Computed only when targeting Codex. No Claude impact.
  let codexSourceHint = '';
  if (activeTarget === 'codex') {
    const codeFenceCount = (textToSend.match(/```/g) || []).length;
    const codeKeywordHits = (textToSend.match(/^\s*(const|let|var|function|class|def|fn|import|export|return|async|interface|type|struct|enum|impl)\b/gm) || []).length;
    const syntaxMarkerLines = (textToSend.match(/^[^\n]*[{};]\s*$/gm) || []).length;
    const hasCode = codeFenceCount >= 2 || codeKeywordHits >= 3 || syntaxMarkerLines >= 3;

    const branchingHits = (textToSend.match(/\b(if|when|unless|otherwise|either|depend(?:s|ing)?|whereas|provided|except|condition|case)\b/gi) || []).length;
    const hasBranching = branchingHits >= 3;

    const colonPairCount = (textToSend.match(/^[^:\n]{2,50}:\s+\S/gm) || []).length;
    const hasTableLike = colonPairCount >= 5;

    const numberedStepCount = (textToSend.match(/^\s*\d+[.)]\s/gm) || []).length;
    const hasNumberedSteps = numberedStepCount >= 3;

    const available = [];
    if (hasCode) available.push(`code patterns (${codeKeywordHits} declarations, ${codeFenceCount} fences, ${syntaxMarkerLines} syntax-marker lines)`);
    if (hasBranching) available.push(`branching language (${branchingHits} if/when/unless/depending references)`);
    if (hasTableLike) available.push(`${colonPairCount} key-value lines suitable for table rows`);
    if (hasNumberedSteps) available.push(`${numberedStepCount} explicit numbered steps`);

    codexSourceHint = available.length > 0
      ? `\nSOURCE STRUCTURE DETECTED: The provided content contains ${available.join('; ')}. Use these signals to decide which optional sections to populate vs skip. Render rich components (code blocks, decision tables, ASCII flowcharts, templates) ONLY where the source supports them — do not fabricate components the source does not contain. Fall back to prose bullets where the spec allows.\n`
      : `\nSOURCE STRUCTURE: The provided content has no detectable code, branching language, table-shaped key-value pairs, or numbered step sequences. Render with prose-heavy sections. SKIP optional sections (Code Patterns, ASCII flowcharts, Decision Matrix, Templates) that would require fabricated content — use the prose-bullet fallback where the spec allows.\n`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // V2: QUALITY SCORING FUNCTION
  // Replaces the old: candidateText.length > 150 && candidateText.includes('## Identity')
  // Now template-aware. Returns a score 0-9.
  // Flash Lite accepted at >= 6. Gemini 2.5 Flash accepted at >= 5.
  // ─────────────────────────────────────────────────────────────────────────────
  function scoreOutput(text, tmpl, docSizeClass) {
    // v2.1: Codex scoring path — closes over activeCodexShape (declared in handler scope).
    // v2.2: three shape-aware branches with different required anchors and component bonuses.
    // All return 0-9 to match the Claude scoring scale used by the qualityThreshold gate.

    // 2026-10-03 (Parachute P3 code review): an empty or whitespace-only reply is never a skill
    // file. The Claude branches' no-penalty points used to add up to 4 for it, exactly GPT-OSS's
    // threshold, so it was served as a placeholder file and charged quota. Rejecting it here
    // fixes that in every PARACHUTE_MODE, off included. (The Codex branch already scored it low.)
    if (!text || !text.trim()) return 0;

    // Template E: Structured financial data scoring
    if (tmpl === 'E') {
      let score = 0;
      // +2: required anchors present
      if (text.includes('## Data Scope') && text.includes('## Key Metrics')) score += 2;
      // +2: YAML frontmatter intact
      if (text.includes('name:') && text.includes('domain:')) score += 2;
      // +1: Core Entities present
      if (text.includes('## Core Entities')) score += 1;
      // +1: table structure (explicitly requested for E)
      if (text.includes('|')) score += 1;
      // +1: Decision Rules or Quality Bar present
      if (text.includes('## Decision Rules') || text.includes('## Quality Bar')) score += 1;
      // +1: length floor (scales with sizeClass)
      const eFloor = docSizeClass === 'large' ? 900 : docSizeClass === 'medium' ? 600 : 400;
      if (text.length >= eFloor) score += 1;
      // +1: not all conditional sections are "Not present in source" (capped at 4 allowed)
      if ((text.split('Not present in source').length - 1) <= 4) score += 1;
      return Math.min(score, 9);
    }

    if (tmpl === 'CODEX') {
      let score = 0;

      // Shared baseline (5 points possible across all shapes):
      // +2 frontmatter has name + description
      if (text.includes('name:') && text.includes('description:')) score += 2;
      // +2 no placeholder bail-outs
      if (!text.includes('[Not extracted') && !text.includes('[review source') && !text.includes('to be added')) score += 2;
      // +1 trigger sub-sections present (universal across all three shapes)
      if (text.includes('### Must Use') && text.includes('### Recommended') && text.includes('### Skip')) score += 1;

      if (activeCodexShape === 'execute') {
        // EXECUTE rewards: workflow anchor + code blocks + anti-patterns + final checks.
        if (text.includes('## When to Activate') && text.includes('## Implementation Workflow') && text.includes('## Key Principles')) score += 2;
        const codeBlockCount = (text.match(/```[a-z]*\n/gi) || []).length;
        if (codeBlockCount >= 2) score += 1;
        if (text.includes('## Common Mistakes to Avoid')) score += 1;
        if (text.includes('## Final Checks')) score += 1;
      } else if (activeCodexShape === 'expertise') {
        // EXPERTISE rewards: review workflow + judgment anchor + quality criteria + human-pause.
        if (text.includes('## When to Activate') && text.includes('## Judgment Framework') && text.includes('## When to Pause for Human')) score += 2;
        if (text.includes('## Quality Bar') && text.includes('## Example Pairs')) score += 1;
        if (text.includes('## Review Workflow')) score += 1;
        if (text.includes('## Key Principles')) score += 1;
      } else {
        // SPECIALIST scoring: independent credit per section so partial compliance is visible
        // to retry pressure. Scoring the +2 conjunction (Activate+Scope+Workflow) collapsed
        // all 2 points when any one was missing — even for non-[REQUIRED] sections on linear
        // sources. Now each section earns its own +1.
        // Activation + Scope always injected by sanitize(); +1 confirms structural integrity.
        if (text.includes('## When to Activate') && text.includes('## Scope Boundaries')) score += 1;
        // Workflow scored alone so omitting it on linear/conceptual sources doesn't cancel
        // adjacent section credit.
        if (text.includes('## Workflow')) score += 1;
        if (text.includes('## Decision Matrix') && text.includes('|')) score += 1;
        if (text.includes('## Operating Mode')) score += 1;
        // Enforcement sections scored independently — one missing no longer hides the other.
        if (text.includes('## Escalation Rules')) score += 1;
        if (text.includes('## Common Mistakes to Avoid')) score += 1;
        // Key Principles: required in SPECIALIST prompt but previously unscored; adding here
        // creates retry pressure to populate it.
        if (text.includes('## Key Principles')) score += 1;
      }

      return Math.min(score, 9);
    }

    let score = 0;

    // +2: Length floor (hard requirement, scales with document sizeClass)
    // Small floors are identical to legacy values — no regression on small documents.
    // Medium ~1.5× small; large ~2.3× small — matches the per-sizeClass token budgets.
    const lengthFloors = {
      // v2.4: Template A floors raised to account for two new sections
      // (## Decision Frameworks, ## Signature Patterns) and the Evidence
      // format in Core Principles. B/C/D floors unchanged.
      small:  { A: 700,  B: 500,  C: 500,  D: 700  },
      medium: { A: 1100, B: 800,  C: 800,  D: 1000 },
      large:  { A: 1600, B: 1200, C: 1200, D: 1600 },
    };
    const floorMap = lengthFloors[docSizeClass] || lengthFloors.small;
    if (text.length >= (floorMap[tmpl] || 600)) score += 2;

    // +2: Required sections present (hard requirement)
    const requiredSections = {
      // v2.4: Template A raised from 2 to 4 required anchors.
      // ## Signature Patterns forces uniqueness extraction — hardest to fake generically.
      // ## What to Always Do forces source-grounded behavioral specificity.
      // ## Voice & Language table is now required (not just present as prose).
      // ## Identity & Role retained — it is also the sanitize() anchor, must be first.
      A: ['## Identity & Role', '## Signature Patterns', '## Voice & Language', '## What to Always Do'],
      B: ['## Role & Capability', '## Example Patterns', '## What to Always Write'],  // unchanged
      C: ['## Domain Role', '## Decision Process'],  // unchanged
      D: ['## Domain Role', '## Decision Framework'],  // unchanged
    };
    const required = requiredSections[tmpl] || requiredSections.A;
    if (required.every(s => text.includes(s))) score += 2;

    // +2: No placeholder text (hard requirement)
    const hasPlaceholder =
      text.includes('[Not extracted') ||
      text.includes('[review source') ||
      text.includes('to be added');
    if (!hasPlaceholder) score += 2;

    // +1: Section depth — every ## section has at least 2 non-empty lines
    const sections = text.split(/^## /m).filter(s => s.trim().length > 0);
    const thinSections = sections.filter(s => {
      const lines = s.split('\n').filter(l => l.trim().length > 10);
      return lines.length < 2;
    });
    if (thinSections.length <= 2) score += 1;

    // +1: Low generic phrase count
    const genericPhrases = [
      'write clean code', 'be professional', 'consider all options',
      'make informed decisions', 'think carefully', 'best practices',
      'high quality output', 'communicate effectively',
    ];
    const genericCount = genericPhrases.filter(p => text.toLowerCase().includes(p)).length;
    if (genericCount <= 3) score += 1;

    // +1: Rich format present (soft check, template-aware)
    if (tmpl === 'D' || tmpl === 'C') {
      if (text.includes('|')) score += 1;
    } else if (tmpl === 'B') {
      if (text.includes('```')) score += 1;
    } else {
      // Template A V2: require Voice & Language table or at least one Example block.
      // The V2 prompt instructs a TABLE for ## Voice & Language — this soft check rewards
      // compliance. > **Example:** block also earns the point for sparse sources.
      // Still a SOFT check — failing drops score by 1 but does not block passing.
      if (text.includes('| Element |') || text.includes('| Tone |') || text.includes('| Sentence') || text.includes('> **Example:')) {
        score += 1;
      }
    }

    return score;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // V2: FOUR PROMPT TEMPLATES
  // Template A — Persona & Voice (original prompt + enhanced format rules)
  // Template B — Code & Technical
  // Template C — Process & Workflow
  // Template D — Professional Domain
  // ─────────────────────────────────────────────────────────────────────────────

  let prompt;

  if (activeTarget === 'codex') {
    // ── CODEX TARGET: OpenAI Codex CLI Skill ──────────────────────────────────
    // v2.2: three shape-aware sub-prompts selected by activeCodexShape.
    // Codex is an EXECUTING agent (not a personality clone like Claude skills) —
    // each shape matches a different cognitive profile of work Codex performs.
    //
    // EXECUTE  (~70%): direct procedural playbooks — refactors, migrations, deploys, runbooks
    // EXPERTISE       : human-in-loop creative/judgment — brand voice, design critique, copy
    // SPECIALIST      : constrained domain role — compliance, legal, security audit, ops
    //
    // Frontmatter spec is shape-invariant: ONLY `name` (kebab-case == codexSlug) and
    // `description` (1-3 sentences with source-extracted trigger phrases). All other
    // YAML fields are forbidden per the official OpenAI Codex skill spec.
    //
    // Trigger-phrase rule (shared across all shapes): description must contain at least
    // 3 phrases that appear literally in the source — Codex's loader uses description-
    // to-user-intent matching to decide when to activate. Vague descriptions never trigger.

    if (activeCodexShape === 'expertise') {
      // ── CODEX-EXPERTISE: human-in-loop creative judgment ──────────────────────
      prompt = `${documentContext}You are a Skill Architect for OpenAI Codex CLI generating an EXPERTISE skill. Codex is an autonomous coding agent — when this skill activates, Codex performs review, editing, or creative work and PAUSES for human approval at key decision points. Convert the source into instructions Codex can follow while reviewing, rewriting, or producing work. Prefer minimal-edit review guidance before full rewrites. Prefer concrete checks over abstract advice.
Focus on: ${focus}
Domain: ${safeDomainLabel}
Role: ${safeDomainRole}

CRITICAL FRONTMATTER RULES:
- Frontmatter MUST contain ONLY two fields: name and description. No other YAML fields whatsoever.
- The "name" field MUST be exactly: "${codexSlug}"
- Description: 2-3 sentences. Sentence 1: what Codex should do when this skill is relevant. Sentence 2: trigger contexts — include 1-2 phrases that appear literally in the source AND 2-4 real user-intent phrases a Codex user would naturally type (e.g. "review landing page copy", "tighten this headline", "improve the CTA"). Sentence 3 (optional): explicit exclusions.
- Do NOT wrap in code fences. Start your response with --- on line 1.
- Do NOT add domain, origin, content_type, use_cases, or any other YAML field.

CONTENT BUDGET: Target 500-900 words. If approaching the upper range, prioritize completing all REQUIRED sections over depth in any single section.
${codexSourceHint}
REQUIRED SECTIONS (in this order):

## When to Activate
### Must Use
- 3-5 specific trigger contexts (mix of source phrases and real user-intent phrasing)
### Recommended
- 2-3 broader use cases
### Skip
- 2-3 explicit exclusions

## Review Workflow
4-7 numbered steps for how Codex should approach reviewing or rewriting work in this domain. Example order: clarify intent → identify weak claims → check proof/support → check CTA or conclusion → verify tone → suggest minimal diff first before full rewrite. Lift the actual review logic from the source.

## Judgment Framework
Explain the explicit tradeoffs in this domain — clarity vs. cleverness, brevity vs. proof, emotion vs. specificity. State which side wins under which conditions. Synthesize the author's decision-making approach; do not generalize.

## Quality Bar
4-6 concrete, testable criteria for "good" output specific to this domain. No generic phrases like "be professional" or "high quality."

## Example Pairs
2-3 before/after pairs showing concrete text-level edits (5-20 word snippets from real landing pages, ad headlines, email subjects, CTA buttons, or value propositions). Each pair MUST show the actual words, not a description of the problem. Use the source's domain and vocabulary:
> **Weak:** "[exact weak phrasing]"
> **Strong:** "[specific improved version]" — [1-sentence explanation anchored to the Judgment Framework above]
Show the minimal diff first. Only escalate to a full rewrite if the weak version cannot be salvaged with small edits.

## When to Pause for Human   [REQUIRED]
3-5 specific moments where Codex must STOP and surface options — only pause on ambiguity that blocks good output, not on ordinary rewrite work. Each trigger is concrete (e.g. "if the audience segment is unclear, ask before rewriting the hook").

## Key Principles
4-6 non-negotiable judgment rules lifted directly from the source.

FORBIDDEN: ASCII flowcharts, decision tables, code anti-pattern pairs, heavy numbered procedures — those belong to EXECUTE and SPECIALIST shapes. Avoid generic educational exposition.

CONTENT:
${textToSend}`;

    } else if (activeCodexShape === 'specialist') {
      // ── CODEX-SPECIALIST: constrained domain role ─────────────────────────────
      prompt = `${documentContext}You are a Skill Architect for OpenAI Codex CLI generating a SPECIALIST skill. Codex is an autonomous coding agent — when this skill activates, Codex operates as a constrained domain role and MUST REFUSE out-of-scope work. Convert the source into an operator playbook: what Codex is allowed to do autonomously, what it must escalate, and what it refuses. If the source is conceptual, translate it into an action sequence Codex can run.
Focus on: ${focus}
Domain: ${safeDomainLabel}
Role: ${safeDomainRole}

CRITICAL FRONTMATTER RULES:
- Frontmatter MUST contain ONLY two fields: name and description. No other YAML fields whatsoever.
- The "name" field MUST be exactly: "${codexSlug}"
- Description: 2-3 sentences. Sentence 1: what role this skill assumes. Sentence 2: trigger contexts — include 1-2 phrases that appear literally in the source AND 2-4 real user-intent phrases a Codex user would naturally type. Sentence 3 (optional): what this role does NOT cover.
- Do NOT wrap in code fences. Start your response with --- on line 1.
- Do NOT add domain, origin, content_type, use_cases, or any other YAML field.

CONTENT BUDGET: Target 700-1100 words. Every section must be load-bearing. If approaching the upper range, prioritize completing all REQUIRED sections over depth in any single section.
${codexSourceHint}
REQUIRED SECTIONS (in this order):

## When to Activate
### Must Use
- 3-5 specific trigger contexts (mix of source phrases and real user-intent phrasing)
### Recommended
- 2-3 broader use cases
### Skip
- 2-3 explicit exclusions

## Scope Boundaries
Two explicit sub-lists. The "does NOT" list defines when Codex refuses.
**This role DOES:**
- 4-6 specific in-scope responsibilities (concrete, not abstract)
**This role does NOT:**
- 4-6 explicit out-of-scope items — work that must be refused or escalated

## Operating Mode   [REQUIRED]
Three short sub-sections defining Codex's behavioral envelope in this role:
**Autonomous:** tasks Codex can complete and deliver without checking in
**Escalate:** situations requiring human sign-off before proceeding
**Refuse:** requests explicitly out of scope — state them clearly

## Workflow   [REQUIRED]
ALWAYS include 3-7 numbered steps with checkable outcomes — required even when no flowchart is rendered. If the source has branching multi-step logic, ALSO render an ASCII flowchart inside a triple-backtick code fence using ONLY → ↓ ├── └── characters, placed before the numbered steps. If the workflow is purely linear or the source is conceptual, skip the ASCII chart and use numbered steps only. Translate conceptual policies into actionable procedural steps — do not leave this section empty.

## Decision Matrix
Markdown table with concrete conditions:
| Condition | Action | Escalate? |
ANTI-HALLUCINATION RULE: every row must map to a condition explicitly present in the source. If the source yields fewer than 4 distinguishable conditions, provide fewer rows rather than fabricating. Use "Yes" / "No" / "If unclear" in the Escalate column — no other values. Each action must be role-specific and concrete (a named procedure, contact, escalation path, or explicit refusal) — not a vague directive. Do not use file paths or shell commands for non-code domains such as compliance, legal, or ops.
SKIP ENTIRELY if the source contains no detectable conditions, branching logic, or distinguishable trigger states (follow codexSourceHint guidance). When skipping, omit this section header entirely — do not write a placeholder.

## Templates
SKIP ENTIRELY unless you can identify at least one reusable, fill-in-the-blank structure directly in the source. If it exists, render it with \`[PLACEHOLDER]\` markers. Do NOT synthesize templates from general domain knowledge — only extract them from what the source actually provides.

## Escalation Rules   [REQUIRED]
3-5 specific cases when Codex must surface to a human before proceeding. Each rule names a concrete trigger and what specifically requires human judgment — not a vague category.

## Common Mistakes to Avoid   [REQUIRED]
4-6 domain-specific anti-patterns as prose bullets. Each anti-pattern is role-specific to this constrained domain — not generic professional advice.

## Key Principles   [REQUIRED]
4-6 non-negotiable role rules extracted directly from the source. Each must be specific to this domain role — not generic professional advice. State what Codex will and will not do within this constrained role.

FORBIDDEN: Long judgment-prose paragraphs (use the decision matrix instead), code anti-pattern pairs unless the source itself is code, generic professional advice.

CONTENT:
${textToSend}`;

    } else {
      // ── CODEX-EXECUTE: direct execution playbook (default shape) ──────────────
      prompt = `${documentContext}You are a Skill Architect for OpenAI Codex CLI generating an EXECUTION skill. Codex is an autonomous coding agent — when this skill activates, Codex reads it and STARTS WORKING immediately. Convert the source into a direct execution playbook Codex can follow: concrete steps, checks, and artifacts grounded in the source. NEVER invent tool names, CLI commands, or file paths not present in the source — if the source is conceptual, derive verifiable checklist actions from its actual domain content rather than fabricating specifics. Prefer concrete source-grounded checks over abstract advice.
Focus on: ${focus}
Domain: ${safeDomainLabel}
Role: ${safeDomainRole}

CRITICAL FRONTMATTER RULES:
- Frontmatter MUST contain ONLY two fields: name and description. No other YAML fields whatsoever.
- The "name" field MUST be exactly: "${codexSlug}"
- Description: 2-3 sentences. Sentence 1: what this skill executes (name the actual domain and action type from the source). Sentence 2: trigger contexts — include 1-2 phrases that appear LITERALLY in the source text AND 2-4 user-intent phrases a Codex user would type to invoke this exact skill — every phrase MUST be grounded in the actual source content, never generic placeholders. Sentence 3 (optional): explicit exclusions.
- Do NOT wrap in code fences. Start your response with --- on line 1.
- Do NOT add domain, origin, content_type, use_cases, or any other YAML field.

CONTENT BUDGET: Target 600-1100 words. SKILL.md is loaded into Codex's context on every trigger — keep it tight and load-bearing. If approaching the upper range, prioritize completing all REQUIRED sections over depth in any single section.
${codexSourceHint}
REQUIRED SECTIONS (in this order):

## When to Activate
### Must Use
- 3-5 specific trigger contexts (mix of source phrases and real user-intent phrasing)
### Recommended
- 2-3 broader use cases
### Skip
- 2-3 explicit exclusions

## Implementation Workflow
5-10 numbered steps. Each step MUST reference concrete actions grounded in the source — actual files, paths, commands, flags, or tools ONLY if they appear in the source; for non-code sources use domain-appropriate verifiable actions with descriptive placeholders like [config-file], [runbook-section], [ticket-id] — NEVER invent CLI tool names or file paths. Embed fenced \`\`\`lang code blocks where the source shows code patterns. Use language tags (\`\`\`typescript, \`\`\`bash, \`\`\`python, etc.). Do NOT use ASCII flowcharts here — use numbered steps.

## Code Patterns
Fenced code blocks showing preferred patterns lifted from or grounded in the source. Include the language tag. Skip this section entirely if the source contains no code patterns — do not invent code.

## Common Mistakes to Avoid   [REQUIRED]
3-5 anti-pattern entries. When the source contains code, each entry is two fenced code blocks (// ✗ don't → // ✓ do this instead). When non-code, use "**Don't:** ... **Do:** ..." prose pairs. Each entry MUST include a one-line WHY — not just what is wrong but what breaks when you do it wrong. Make all entries source-specific, not generic advice.

## Final Checks   [REQUIRED]
3-5 verification steps Codex should run before considering the task done. Format at least one as a runnable shell command (e.g. \`$ npm test\`, \`$ python -m pytest\`, \`$ grep -r "pattern" ./src\`) when the source is code-related. Always include at least one boundary check — a file, directory, interface, or architecture constraint to verify before shipping. Each check must be independently runnable and concrete, not a vague "ensure everything works."

## Key Principles
4-6 non-negotiable executable rules lifted directly from the source — domain-specific and verifiable. Not abstract values, not generic coding conventions.

FORBIDDEN: ASCII flowcharts, judgment/taste prose, "human review" or pause sections, decision tables (this is an execution playbook — no branching deliberation).

CONTENT:
${textToSend}`;
    }

  } else if (activeTemplate === 'B') {
    // ── TEMPLATE B: Codebase Intelligence ──────────────────────────────────────
    prompt = `${documentContext}You are a Codebase Intelligence Engine. Analyze the provided source code and extract the architectural patterns, conventions, and structural decisions into a Claude Skill File. Do not summarize — extract the behavioral and structural DNA of how this codebase is built.
Focus on: ${focus}
Domain: Software Engineering
Role: ${safeDomainRole}

RULES:
- Extract ACTUAL patterns visible in the source — never invent patterns not present.
- Identify naming conventions, async style, error handling, typing discipline, import structure, and component/module boundaries.
- Extract architectural decisions: what the code does and does not do, and what that implies.
- NEVER copy-paste raw code lines — identify the PATTERN they represent, then show one canonical example.
- You MUST start your response exactly with the YAML block below, no code fences, no backticks, no preamble.
- You MUST enclose all YAML values in double quotes.
- The "name" field MUST be exactly: "${skillName}"
- Use "software engineering" for the "domain" field unless the source clearly belongs to a different technical domain.

FORMAT:
---
name: "${skillName}"
domain: "software engineering"
content_type: "behavioral skill"
use_cases: ["code generation", "code review", "refactoring", "architecture alignment"]
---

## Role & Capability
[2 sentences. What kind of developer Claude becomes when using this skill. Name the language, framework, or domain visible in the source. Be specific — not "a skilled developer" but "a React/TypeScript engineer who uses hook-based state and async/await throughout."]

## Codebase Conventions
[Use a markdown TABLE with columns Pattern | This Codebase's Approach when 3 or more patterns exist with consistent attributes. Otherwise use structured bullets.
Cover as many of these as the source supports: naming conventions, async style, error handling, typing approach, import organization, component/function structure, state management style.
Extract only what is visible — skip any row where the source provides no signal.]

## Architecture & Structure
[Describe what architectural decisions are visible in the source. What does the code clearly commit to? What does it deliberately avoid?
Use an ASCII flowchart inside a triple-backtick code fence ONLY if the source shows real branching logic or data flow between modules. Use prose if the source describes architectural philosophy or module boundaries without branching.
Format for flowchart: plain ASCII with → ↓ ├── └── characters only. No boxes or decorative borders.]

## What to Always Write
[5 to 7 specific coding behaviors extracted directly from the source. Start each with an action verb. Every item must be grounded in something visible in the source — not generic software advice.]

## What to Never Write
[4 to 5 anti-patterns that are visibly absent from or actively avoided by the source. Start each with "Never". Every item must be specific to this codebase's choices — not generic best practices.]

## Example Patterns
[ALWAYS include at least one triple-backtick code block showing a canonical pattern extracted from the source.
Use the actual language from the source. Add the language tag after the opening backticks (e.g. \`\`\`typescript).
If the source shows multiple distinct patterns worth preserving, show up to 3 blocks.
Each block must represent a reusable pattern, not a one-off snippet. Add a one-line comment above the block explaining what pattern it demonstrates.
Base every block on actual code from the source — do not fabricate.]

## Dependency Intelligence
[If the source reveals which libraries, frameworks, or external tools are in use, list them here as a TABLE with columns Library | Role in This Codebase.
If fewer than 3 are identifiable from the source, use a brief bullet list instead.
Skip this section entirely if the source gives no signal about dependencies — write exactly "Not present in source." and nothing else.]

## Quality Bar
[3 to 4 concrete, codebase-specific checks for knowing output matches this developer's exact style. Do not use generic phrases. Reference the actual conventions extracted above.]

CONTENT:
${textToSend}`;

  } else if (activeTemplate === 'C') {
    // ── TEMPLATE C: Process & Workflow ────────────────────────────────────────
    prompt = `${documentContext}You are a Process Architecture Engine. Analyze the provided document and extract the workflow logic, decision criteria, and operational rules into a Claude Skill File. Do not summarize — extract the actual process DNA.
Focus on: ${focus}
Domain: ${safeDomainLabel}
Role: ${safeDomainRole}

RULES:
- Extract the ACTUAL process — do not generalize into generic advice.
- Identify decision points, branching conditions, escalation paths, and constraints.
- NEVER copy-paste raw sentences — extract the structural logic behind them.
- You MUST start your response exactly with the YAML block below, no code fences, no backticks, no preamble.
- You MUST enclose all YAML values in double quotes.
- The "name" field MUST be exactly: "${skillName}"
- Use "${safeDomainLabel}" for the "domain" field by default, but if the content clearly belongs to a different domain, replace it with the most accurate domain instead.

FORMAT:
---
name: "${skillName}"
domain: "${safeDomainLabel}"
content_type: "behavioral skill"
use_cases: ["process execution", "decision support", "workflow guidance"]
---

## Domain Role
[2 sentences. What operational role Claude takes on. Be specific to this process domain.]

## Core Framework
[Use a markdown TABLE with clear column headers if the framework has 3 or more components
with consistent attributes (stages, phases, categories with properties).
Otherwise use structured prose. Do NOT force a table if content is not comparative.]

## Decision Process
[Use an ASCII flowchart inside a triple-backtick codeblock if there are real branching
decisions in the source (if/then, yes/no, condition-based paths).
Format: plain ASCII only — → ↓ ├── └── characters.
Use a numbered list if steps are purely linear with no branching.
Do NOT use a flowchart just because this is a process document.]

## Rules & Constraints
[Use a TABLE with columns Situation | Rule | Exception if rules have clear conditions
and outcomes. Otherwise use bullet points. 4 to 6 rules maximum.]

## Edge Cases
[Bullet list. What to do when the normal process cannot be followed. Based on source only.]

## Quality Bar
[How to know the process was followed correctly and output meets the standard.]

CONTENT:
${textToSend}`;

  } else if (activeTemplate === 'D') {
    // ── TEMPLATE D: Professional Domain ───────────────────────────────────────
    prompt = `${documentContext}You are a Professional Domain Skill Architect. Analyze the provided document and extract the domain expertise, decision frameworks, and professional standards into a Claude Skill File. Do not summarize — extract the actual professional DNA.
Focus on: ${focus}
Domain: ${safeDomainLabel}
Role: ${safeDomainRole}

RULES:
- Extract domain-specific frameworks and decision criteria — not generic professional advice.
- Identify the professional standards, constraints, and terminology of this exact domain.
- NEVER copy-paste raw sentences — synthesize the expertise patterns behind them.
- You MUST start your response exactly with the YAML block below, no code fences, no backticks, no preamble.
- You MUST enclose all YAML values in double quotes.
- The "name" field MUST be exactly: "${skillName}"
- Use "${safeDomainLabel}" for the "domain" field by default, but if the content clearly belongs to a different domain, replace it with the most accurate domain instead.

FORMAT:
---
name: "${skillName}"
domain: "${safeDomainLabel}"
content_type: "behavioral skill"
use_cases: ["case 1", "case 2", "case 3"]
---

## Domain Role
[2 sentences. What professional role Claude takes on. Be highly specific to this domain.]

## Core Principles
[4 to 5 fundamental beliefs of this domain extracted from source. Bullet list.
Write as if the domain expert is speaking. No generic advice.]

## Decision Framework
[THIS IS THE MOST IMPORTANT SECTION.
Use a markdown TABLE with clear column headers if content compares 3 or more items
across 2 or more consistent attributes (metrics, thresholds, criteria, categories).
Use an ASCII flowchart inside a triple-backtick codeblock if content has real branching
decision logic — format: plain ASCII → ↓ ├── └── only.
Use BOTH if content has both comparative data AND branching decisions.
Use prose ONLY if content has neither.
Base this entirely on what is in the source document — do not invent frameworks.]

## Rules & Constraints
[Use a TABLE with columns Situation | Rule | Exception if rules have clear conditions.
Otherwise use bullets. Domain-specific rules only — no generic professional advice.]

## What to Always Do
[5 specific behaviors. Start each with an action verb. Domain-specific and extracted from source.]

## What to Never Do
[4 prohibitions. Start each with "Never". Domain-specific and extracted from source.]

## Quality Bar
[How to know output meets the professional standard of this exact domain.]

CONTENT:
${textToSend}`;

  } else if (activeTemplate === 'E') {
    // ── TEMPLATE E: Structured Financial Data ────────────────────────────────────
    // Purpose-built for CSVs, spreadsheet exports, and numeric-dense financial tables.
    // Extracts schema, metrics, and analytical logic — NOT generic finance advice.
    // Conditional sections must be skipped when source does not contain them.
    prompt = `${documentContext}You are a Financial Data Intelligence Engine. Analyze the provided structured financial data (CSV exports, spreadsheet rows, financial tables, budget models, KPI dashboards) and extract the schema, metrics, assumptions, and analytical logic into a Claude Skill File.

DO NOT produce generic financial advice. Extract ONLY what is actually present in the source data.
DO NOT invent metrics, assumptions, scenarios, or rules that are not grounded in the source.
Focus on: ${focus}
Domain: ${safeDomainLabel}

RULES:
- Prefer TABLES and matrices over prose whenever the source has column/row structure.
- Use bullet lists for assumptions, controls, and exceptions.
- Use flowcharts ONLY when the source has real conditional branching paths.
- For every CONDITIONAL section below: if the source has no clear signal for it, write exactly "Not present in source." and nothing else for that section body.
- You MUST start your response exactly with the YAML block below, no code fences, no backticks, no preamble.
- You MUST enclose all YAML values in double quotes.
- The "name" field MUST be exactly: "${skillName}"

FORMAT:
---
name: "${skillName}"
domain: "${safeDomainLabel}"
content_type: "behavioral skill"
use_cases: ["financial analysis", "data interpretation", "reporting"]
---

## Data Scope
[What the dataset covers: time period, entities, geography, source system. What it can and cannot support analytically. 2-4 sentences grounded in the actual data.]

## Core Entities
[The main objects: accounts, line items, categories, periods, segments, columns, metrics. Use a TABLE with columns Entity | Type | Description if 3 or more entities exist with consistent attributes. Use bullets otherwise.]

## Key Metrics
[The financial measures and KPIs present. Use a TABLE with columns Metric | Unit | What It Represents if 3+ metrics exist. Include: percentages, ratios, totals, deltas, and any calculated fields visible in the source.]

## Assumption Register
[CONDITIONAL — implied definitions, formula dependencies, period conventions, sign conventions, or model assumptions embedded in the data. Use bullets. If none are detectable, write "Not present in source."]

## Scenario Analysis
[CONDITIONAL — base / actual / budget / forecast / upside / downside comparisons. Use a TABLE or matrix if multiple scenario columns exist. If no scenarios are present, write "Not present in source."]

## Variance / Sensitivity Table
[CONDITIONAL — what changes and what it affects. Use a TABLE if the source shows variance, delta, or change columns. If no variance data is present, write "Not present in source."]

## Decision Rules
[CONDITIONAL — numeric or condition-based rules that can be inferred from the data (thresholds, flags, tier criteria, approval limits). Use bullets or a TABLE with Condition | Action format. If no rules are detectable, write "Not present in source."]

## Risk Controls
[CONDITIONAL — validation points, reconciliation checks, sign conventions, data quality controls, or audit flags visible in the source. Use bullets. If not present, write "Not present in source."]

## Exceptions
[CONDITIONAL — outliers, missing values, unusual rows, ambiguous categories, or broken patterns in the data. Use bullets. If no anomalies are detectable, write "Not present in source."]

## Quality Bar
[3-4 concrete, dataset-specific checks: how to verify this extracted skill accurately represents the source data. Reference actual column names, metric names, or row counts from the source.]

CONTENT:
${textToSend}`;

  } else {
    // ── TEMPLATE A V2: Persona Intelligence (default) ─────────────────────────
    // v2.4: Full rewrite. Philosophy shift: from persona simulation to persona
    // intelligence. Adds: Decision Frameworks section, Signature Patterns section,
    // evidence requirement in Core Principles, anti-abstraction rule throughout,
    // Voice & Language upgraded to structured table format.
    // Backward compatible: YAML schema (name, domain, content_type, use_cases) unchanged.
    // sanitize() anchor (## Identity & Role) unchanged.
    prompt = `${documentContext}You are a Persona Intelligence Engine. Do not summarize this person. Reverse-engineer their operating system.

Analyze the provided content and extract the author's decision-making frameworks, signature behavioral patterns, voice mechanics, and thinking architecture into a Claude Skill File. The goal is not to describe the person — it is to build an operational model of how they think, decide, communicate, and create.
Focus on: ${focus}
Suggested Domain: ${safeDomainLabel}
Suggested Role: ${safeDomainRole}

RULES:
- Identify the actual domain of the text. If the text is clearly not about the Suggested Domain, you MUST ignore the suggestion and define the most accurate domain yourself.
- Extract OBSERVABLE, SPECIFIC patterns only. Every principle must be grounded in evidence visible in the source.
- NEVER write generic content. "Focus on users", "Think long term", "Communicate clearly" are rejectable output — they could apply to any professional.
- NEVER copy-paste raw lines. Synthesize the behavioral architecture behind them.
- You MUST start your response exactly with the YAML block below, no code fences, no backticks, no preamble.
- You MUST enclose all YAML values in double quotes.
- The "name" field MUST be exactly: "${skillName}"
- Use "${safeDomainLabel}" for the "domain" field by default. Per the rule above, if the text is clearly not about the Suggested Domain, replace it with the most accurate domain instead.
- NEVER skip ## Identity & Role under any circumstance. For instructional, pedagogical, or reference documents where no personal author voice is present, define the professional role Claude takes on: name the domain, the output type, and the primary behavioral constraint this skill enforces.
- Generate ALL sections in the EXACT ORDER listed in the FORMAT block below. Do not reorder, skip, or omit any section.

ANTI-ABSTRACTION RULE: Before writing any bullet or principle, ask: "Could this apply to most other authors in this domain?" If yes — discard it and go deeper into the source until you find what is unique.

FORMAT:
---
name: "${skillName}"
domain: "${safeDomainLabel}"
content_type: "behavioral skill"
use_cases: ["case 1", "case 2", "case 3"]
---

## Identity & Role
[2 sentences. Who Claude becomes when using this skill. Use the specific vocabulary and tone of this author — not a description of them, but a precise definition of the role they occupy. Name the actual domain, the actual output type, and the most distinctive behavioral constraint. Not "an expert communicator" — name the specific thing this person does and the specific way they do it.]

## Core Principles
[4 to 5 fundamental beliefs extracted from the text. Write as if the author is speaking.
REQUIRED FORMAT for each principle — use this exact structure:
**[Principle statement — specific, not generic]**
Evidence: [1 line showing the source signal that grounds this principle — a phrase they use, a structural habit they demonstrate, or a repeated behavior visible in the text]
ANTI-GENERIC CHECK: Reject any principle that could appear in a generic motivational document. Each must be specific enough to identify this author.]

## Decision Frameworks
[How does this person make decisions? Extract the actual decision-making logic from the source — the rules they apply when choosing between options.
Use a markdown TABLE with columns Situation | Decision Rule when 3 or more distinct decision patterns exist with consistent attributes.
Use a numbered list if decision logic is purely sequential.
Skip this section with "Not detectable in source." ONLY if the source contains zero decision language. Do not skip if the source contains any preference, prioritization, or conditional logic.]

## Signature Patterns
[Extract this section with maximum depth and specificity — this is what makes the skill file non-generic and uniquely useful. These are the recurring behaviors that make this author distinct — observable, specific, verifiable.
Extract patterns across these categories wherever the source provides signal:
- Structural: How they open, develop, and close arguments or outputs.
- Linguistic: Specific phrases, punctuation habits, sentence length tendencies, words they repeat or avoid.
- Reasoning: Inversion, contrast, first-principles compression, analogy before abstraction.
- Emphasis: What they bold, capitalize, repeat, or return to.
4 to 6 patterns minimum. Each must be specific enough that it cannot apply to most other authors.
ANTI-GENERIC: "Writes clearly" is not a signature pattern. "Opens with a single observation, then expands into implication before arriving at the principle" is.
ANTI-HALLUCINATION: Extract only what is visible in the source. Do not invent patterns the source does not contain.]

## How to Think
[The specific mental process and reasoning constraints extracted from the source.
Be specific: What does the author consider FIRST when approaching a problem? What do they explicitly reject as a starting point? What mental moves are visible in the way they develop an argument or creative piece?]

## How to Create
[Specific craft instructions grounded entirely in the source.
Structure: What always comes first, second, last in their outputs?
Length: What typical length or density signals are present?
Vocabulary: Which specific domain terms, phrases, or words are used? Which are avoided?
Format: Bullets vs prose, headers or not, numbered lists or flowing text — what does the source show?]

## What to Always Do
[5 specific behaviors. Start each with an action verb. Domain-specific — not generic professional advice. Every item must be recognizable as specific to this author, not transferable to any professional in this domain.]

## What to Never Do
[4 prohibitions. Start each with "Never". These must be specific to what THIS source visibly avoids. Not generic — "Never be vague" is rejectable. "Never open with the conclusion before the observation that earns it" is specific.]

## Voice & Language
[Use a markdown TABLE with columns Element | Observed Pattern.
REQUIRED rows: Tone | Vocabulary | Sentence Structure | Emphasis Style | What They Avoid.
Add additional rows if the source provides clear signal for them (e.g. Paragraph Length, Punctuation Habits, Storytelling Approach, Use of Data).
Keep every entry in the Observed Pattern column specific and verifiable — an observed behavior, not an aspiration.
ANTI-GENERIC: "Direct and clear" is not an observed pattern. "Short declarative sentences (3–10 words) followed by a longer unpacking sentence" is.]

## Quality Bar
[3 to 4 concrete, source-specific checks. How to verify that output actually matches this author's operational model — not just sounds similar.
Reference actual patterns from ## Signature Patterns above.
Not "sounds natural" — specific verifiable checks like "opens with observation before principle" or "uses contrast in at least one argument per output."]

ENHANCED FORMAT RULES (use judgment — do not force):
Within any section above, you MAY use these additional formats ONLY when content genuinely requires it:

1. EXAMPLE BLOCK — only if source contains a template, before/after pair, or signature phrase worth preserving exactly.
   Format: > **Example:** on one line, then the example on the next line.
   DO NOT use for general principles or rules.

2. ASCII FLOWCHART IN CODEBLOCK — only if source describes a process with real branching decisions (if/then, yes/no outcomes that change the path).
   Format: triple backtick block, plain ASCII: → ↓ ├── └──
   DO NOT use for linear steps — use a numbered list instead.

DEFAULT: When in doubt use prose. A brand voice guide does NOT need an ASCII flowchart. A personal essay does NOT need a decision table. Never force a format onto content that does not naturally support it.

CONTENT:
${textToSend}`;
  }

  // Jev planning layer (2026-09-26): both edits are no-ops when plan is null, so the
  // prompt stays byte-identical to the pre-Jev path.
  // 1. Facet modules (Claude A/C/D only) go right before the template's CONTENT marker,
  //    telling the model to append them AFTER ## Quality Bar - existing section order is
  //    untouched. Replacer FUNCTION, not a string: a replacement string would treat any
  //    `$` in it as a special pattern.
  //    2026-09-26: per-surface module map - Claude A/B/C/D (E none), and Codex shapes as
  //    bullet lists appended AFTER ## Key Principles. See MODULES in lib/planner.js.
  const facetModules = buildFacetModules(plan, activeTemplate, activeTarget, activeCodexShape);
  if (facetModules) prompt = prompt.replace('\nCONTENT:\n', () => `\n${facetModules}\nCONTENT:\n`);
  // 2. The plan block leads the prompt, ahead of documentContext.
  const planDirectives = buildPlanDirectives(plan, activeTarget, activeTemplate);
  // 3. Content fidelity (2026-09-26): say so when the source is a spread excerpt. Only when
  //    spreadSelect actually applied, i.e. only with a content map.
  if (selection.spread && textToSend === selection.text) prompt = SPREAD_NOTE + prompt;
  if (planDirectives) prompt = planDirectives + prompt;
  const planSummary = plan
    ? summarizePlan(plan, { clientTemplate: template || 'A', template: activeTemplate, clientShape: clientCodexShape, codexShape: activeCodexShape, target: activeTarget })
    : null;
  if (planSummary) console.log('[plan]', planSummary);
  const contentSummary = contentMap ? summarizeContent(contentMap, selection.spread && textToSend === selection.text) : null;
  if (contentSummary) console.log('[content]', contentSummary);

  // ─────────────────────────────────────────────────────────────────────────────
  // SANITIZE FUNCTION
  // UNCHANGED: all YAML repair logic preserved exactly
  // CHANGED: removed hardcoded 8-section enforcement, replaced with template-aware minimum
  // ─────────────────────────────────────────────────────────────────────────────
  function sanitize(raw, skillName, tmpl) {
    let text = raw;

    // UNCHANGED — exact same UTF-8 cleaning as before
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF\u200B-\u200D\u2060]/g, '');
    text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();

    // v2.1: Codex sanitize path — strict spec, frontmatter has ONLY name + description.
    // When called for Codex, `skillName` param holds the kebab-case codexSlug (see call site).
    if (tmpl === 'CODEX') {
      // Fix (2026-08-09/10): indexOf('---') matched the FIRST occurrence of that
      // substring anywhere in the text — including inside a markdown table separator
      // row (e.g. "--- | :--- |"), which silently truncated everything before it,
      // eating the real frontmatter. A genuine YAML delimiter is always alone on its
      // own line; anchoring to that shape excludes table syntax, which always has
      // additional characters (pipes, colons) on the same line.
      const yamlStartCodex = text.search(/^---\s*$/m);
      if (yamlStartCodex > 0) text = text.slice(yamlStartCodex);
      if (!text.startsWith('---')) text = '---\n' + text;

      // Gemini often writes an opening --- block without the closing ---.
      // The fmMatchCodex regex below requires a closing --- to match at all.
      // If the opening is present but the closing is absent, insert it
      // immediately before the first ## section heading so the regex fires.
      if (text.startsWith('---\n') && !/^---\n[\s\S]*?\n---/.test(text)) {
        const headingIdx = text.indexOf('\n## ');
        if (headingIdx > 4) {
          text = text.slice(0, headingIdx) + '\n---' + text.slice(headingIdx);
        }
      }

      const fmMatchCodex = text.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatchCodex) {
        let fm = fmMatchCodex[1];
        if (/^name:/m.test(fm)) {
          fm = fm.replace(/^name:.*$/m, `name: ${skillName}`);
        } else {
          fm = `name: ${skillName}\n` + fm;
        }
        // Strip every non-spec YAML field — Codex frontmatter accepts ONLY name + description.
        // Block-aware pass: preserves multi-line description continuation lines that the
        // old line-by-line filter was silently dropping (causing the generic fallback to fire).
        const fmLines = fm.split('\n');
        const kept = [];
        let inDescription = false;
        for (const line of fmLines) {
          const trimmed = line.trim();
          if (/^name:/.test(trimmed)) {
            inDescription = false;
            kept.push(line);
          } else if (/^description:/.test(trimmed)) {
            inDescription = true;
            kept.push(line);
          } else if (inDescription && (line.startsWith('  ') || line.startsWith('\t'))) {
            kept.push(line);
          } else {
            inDescription = false;
          }
        }
        fm = kept.join('\n');
        if (!/^description:/m.test(fm)) {
          // Gemini omitted the description field. Instead of a generic placeholder,
          // extract the trigger phrases Gemini already wrote in ## When to Activate
          // / ### Must Use and construct a real 2-sentence description from them.
          let resolvedDesc = null;
          try {
            const bodyText = text.slice(fmMatchCodex[0].length);
            const mustUseBlock = bodyText.match(/###\s*Must Use\s*\n([\s\S]*?)(?=\n###|\n##|$)/i);
            if (mustUseBlock) {
              const triggers = mustUseBlock[1]
                .split('\n')
                .filter(l => /^\s*-\s*/.test(l))
                .map(l => l.replace(/^\s*-\s*/, '').replace(/^["']|["']$/g, '').trim())
                .filter(l => l.length > 5 && l.length < 90)
                .slice(0, 3);
              if (triggers.length >= 2) {
                const verbMap = { execute: 'Executes', expertise: 'Reviews', specialist: 'Applies' };
                const verb = verbMap[activeCodexShape] || 'Applies';
                const domain = safeDomainLabel || skillName.replace(/-/g, ' ');
                const trigStr = triggers.slice(0, 2).map(t => t.toLowerCase()).join('; ');
                resolvedDesc = `${verb} ${domain} tasks from source material. Activates when: ${trigStr}. Does not apply to out-of-scope requests.`;
              }
            }
          } catch (_) {}
          fm += `\ndescription: "${(resolvedDesc || `${skillName.replace(/-/g, ' ')} skill.`).replace(/"/g, '\\"')}"`;
        }
        // Normalize description to a single-line quoted string so downstream regex
        // parsers (both frontend and Codex loader) never see indented continuations.
        const descIdx = fm.search(/^description:/m);
        if (descIdx !== -1) {
          const beforeDesc = fm.slice(0, descIdx).replace(/\n+$/, '');
          const descValue = fm.slice(descIdx)
            .replace(/^description:\s*/m, '')
            .replace(/^["']|["']$/g, '')
            .replace(/\n\s*/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          fm = (beforeDesc ? beforeDesc + '\n' : '') + `description: "${descValue.replace(/"/g, '\\"')}"`;
        }
        console.log('[Codex:desc]', fm.match(/^description:\s*(.+)$/m)?.[1]?.slice(0, 100) || '(none)');
        text = `---\n${fm.trim()}\n---` + text.slice(fmMatchCodex[0].length);
      }

      // Safety net: if fmMatchCodex was still null after preprocessing (heading too close
      // to opener, or no ## heading at all), inject a complete frontmatter directly.
      // Extracts triggers from ### Must Use so the description is real, not a placeholder.
      if (!fmMatchCodex) {
        console.log('[Codex:desc]', '(fmMatch null after preprocessing — direct injection)');
        let emergencyDesc = `${skillName.replace(/-/g, ' ')} skill.`;
        try {
          const mb = text.match(/###\s*Must Use\s*\n([\s\S]*?)(?=\n###|\n##|$)/i);
          if (mb) {
            const trig = mb[1].split('\n')
              .filter(l => /^\s*-\s*/.test(l))
              .map(l => l.replace(/^\s*-\s*/, '').replace(/^["']|["']$/g, '').trim())
              .filter(l => l.length > 5 && l.length < 90)
              .slice(0, 2);
            if (trig.length >= 2) {
              const v = ({ execute: 'Executes', expertise: 'Reviews', specialist: 'Applies' })[activeCodexShape] || 'Applies';
              emergencyDesc = `${v} ${safeDomainLabel || skillName.replace(/-/g, ' ')} tasks. Activates when: ${trig.map(t => t.toLowerCase()).join('; ')}. Does not apply to out-of-scope requests.`;
            }
          }
        } catch (_) {}
        const bodyOnly = text.replace(/^---\n/, '').trim();
        text = `---\nname: ${skillName}\ndescription: "${emergencyDesc.replace(/"/g, '\\"')}"\n---\n\n${bodyOnly}`;
      }

      if (!text.includes('## When to Activate')) {
        text += '\n\n## When to Activate\n[Review source document and define activation contexts.]';
      }

      // v2.2: Shape-aware required-section fallback. Closes over activeCodexShape from
      // handler scope. Appends a placeholder section only if the model omitted the
      // shape-critical anchor — preserves model output otherwise. scoreOutput will
      // penalize placeholder text, so the model is incentivized to fill it on retry.
      if (activeCodexShape === 'execute') {
        if (!text.includes('## Common Mistakes to Avoid')) {
          text += '\n\n## Common Mistakes to Avoid\n[Review source document and extract domain-specific anti-patterns.]';
        }
        if (!text.includes('## Final Checks')) {
          text += '\n\n## Final Checks\n[Review source document and define verification steps before task completion.]';
        }
      } else if (activeCodexShape === 'expertise') {
        if (!text.includes('## When to Pause for Human')) {
          text += '\n\n## When to Pause for Human\n[Review source document and define explicit human-review triggers.]';
        }
        if (!text.includes('## Review Workflow')) {
          text += '\n\n## Review Workflow\n[Review source document and define the step-by-step review sequence Codex should follow.]';
        }
      } else if (activeCodexShape === 'specialist') {
        if (!text.includes('## Scope Boundaries')) {
          text += '\n\n## Scope Boundaries\n**This role DOES:**\n- [Review source document and define in-scope responsibilities]\n\n**This role does NOT:**\n- [Review source document and define out-of-scope items]';
        }
        if (!text.includes('## Operating Mode')) {
          text += '\n\n## Operating Mode\n**Autonomous:** [tasks Codex can complete without checking in]\n**Escalate:** [situations requiring human sign-off]\n**Refuse:** [requests explicitly out of scope]';
        }
        // These two sections are [REQUIRED] in the SPECIALIST prompt but had no fallback
        // injection (unlike EXECUTE which injects both its [REQUIRED] sections). Without
        // injections, they could be silently absent from the final output with no repair.
        if (!text.includes('## Escalation Rules')) {
          text += '\n\n## Escalation Rules\n[Review source document and define 3-5 specific triggers that require human review before proceeding.]';
        }
        if (!text.includes('## Common Mistakes to Avoid')) {
          text += '\n\n## Common Mistakes to Avoid\n[Review source document and extract 4-6 domain-specific anti-patterns for this constrained role.]';
        }
      }

      text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');
      return text.trim();
    }

    // Fix (2026-08-09/10): see the identical fix + explanation above in the CODEX
    // branch of this same function — indexOf('---') was matching markdown table
    // separator rows and silently eating the real frontmatter before them. Confirmed
    // live in production: 1 of 4 real Gemini calls in a same-day test came back as a
    // 200 "success" with no name:/domain: fields at all because of this exact bug.
    const yamlStart = text.search(/^---\s*$/m);
    if (yamlStart > 0) text = text.slice(yamlStart);
    if (!text.startsWith('---')) text = '---\n' + text;

    // 2026-09-26: close an unclosed frontmatter block. Gemini omits the closing --- in about
    // half of all Claude outputs (every saved bake-off result back to the pre-Jev baseline),
    // and then fmMatch below never matches, so none of the YAML repairs run and the API output
    // keeps an unterminated frontmatter. Same repair the CODEX branch above applies, except
    // "closed" is judged only up to the first ## heading, so a --- horizontal rule later in
    // the body is never mistaken for the closing delimiter.
    const firstHeadingIdx = text.indexOf('\n## ');
    if (firstHeadingIdx > 3 && !text.slice(0, firstHeadingIdx).split('\n').slice(1).some((l) => l.trim() === '---')) {
      text = text.slice(0, firstHeadingIdx) + '\n---\n' + text.slice(firstHeadingIdx);
    }

    // UNCHANGED — exact same YAML field repair as before
    const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      let fm = fmMatch[1];
      if (/^name:/m.test(fm)) {
        fm = fm.replace(/^name:.*$/m, `name: "${skillName}"`);
      } else {
        fm = `name: "${skillName}"\n` + fm;
      }
      if (!/^domain:/m.test(fm))       fm += `\ndomain: "General"`;
      if (!/^content_type:/m.test(fm)) fm += `\ncontent_type: "behavioral skill"`;
      if (!/^use_cases:/m.test(fm))    fm += `\nuse_cases: ["general use"]`;
      // 2026-09-26: `(?![\s"])`, was `(?!")`. With `(?!")`, `\s*` backtracked to zero width so
      // the lookahead saw the space instead of the quote, and every already-quoted value was
      // quoted again (`name: ""X""`, invalid YAML). The frontend's multi-file SKILL.md then
      // read an empty domain from it (App.tsx `^domain:` regex).
      fm = fm.replace(/^(name|domain|content_type):\s*(?![\s"])(.+)$/gm, (_, key, val) => `${key}: "${val.trim()}"`);
      text = `---\n${fm.trim()}\n---` + text.slice(fmMatch[0].length);
    }

    // V2 CHANGE: template-aware minimum section check
    // Replaces the old hardcoded 8-section enforcement that punished Gemini for creativity
    // Now only checks for the ONE anchor section per template — just enough to confirm
    // the right template was used. Does not force back missing sections.
    const templateAnchors = {
      A: '## Identity & Role',
      B: '## Role & Capability',
      C: '## Domain Role',
      D: '## Domain Role',
      E: '## Data Scope',
    };
    const anchor = templateAnchors[tmpl] || templateAnchors.A;
    if (!text.includes(anchor)) {
      text += `\n\n${anchor}\n[Content could not be extracted from source. Review document and retry.]`;
    }

    // v2.4: Template A secondary safety net.
    // If ## Signature Patterns is missing, inject a placeholder so the skill file
    // is not structurally broken. scoreOutput() will penalize placeholder text (-2),
    // incentivizing the primary model to populate it correctly on the first pass.
    // Scope: Template A Claude path only. All other templates untouched.
    if (tmpl === 'A' && !text.includes('## Signature Patterns')) {
      text += '\n\n## Signature Patterns\n[Review source document and extract 4 to 6 recurring behavioral patterns specific to this author.]';
    }

    // UNCHANGED — exact same line ending and whitespace cleanup as before
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

  // Fallback tier (index 1) moved off Gemini to OpenRouter's openai/gpt-oss-120b, pinned
  // to Groq (2026-08-09/10) — cross-provider redundancy, so a full Gemini outage no
  // longer takes out both tiers at once (same single-provider fragility pattern already
  // fixed elsewhere in this org's infra). Live-tested via a real Vercel preview
  // deployment across 8 real generations (both targets, 2 different source documents):
  // 4.5-6.8s latency, comparable output quality/format compliance to Gemini on identical
  // inputs. Primary model (index 0) is unchanged (by that 2026-08 move; see 2026-09-27 below).
  // 2026-09-27: primary moved gemini-3.1-flash-lite-preview -> gemini-3.5-flash-lite (Manas
  // approved). The preview id was already a Google alias for gemini-3.1-flash-lite (its
  // modelVersion said so) and is past its documented shutdown date. 3.5 Flash-Lite at its
  // default thinking level was run through this code path at production token budgets:
  // 15/15 STOP, 0 MAX_TOKENS, 0 thinking tokens, and it outscored the 3.1 arms under blind
  // judging. The explicit 'minimal' pin below was checked separately (HTTP 200 on 3.5).
  // A 400/404 on this id falls through to GPT-OSS below. Vault: Relatch Model Provider
  // Routing - Plan (2026-09-27).
  const NORMAL_CHAIN = [
    { provider: 'gemini', id: 'gemini-3.5-flash-lite' },
    { provider: 'openrouter', id: 'openai/gpt-oss-120b' },
  ];

  // ROUTING Phase B (2026-10-03, same vault plan, section 3): the hard lane for complex
  // documents, both targets. ROUTING_MODE=off (unset or any other value) serves NORMAL_CHAIN,
  // byte-identical to before. shadow computes the lane and logs it (enrich-route event) but
  // still serves NORMAL_CHAIN. on serves complex documents with COMPLEX_CHAIN.
  // - Models (2026-09-27 arena, blind judges from 3 families): DeepSeek V4.1 Flash first (best
  //   overall, best on finance), GLM-5.3 as its failover. Gemini last is an EMERGENCY NET only
  //   (Manas, 2026-10-03): both hard-lane models share one OpenRouter account and key with the
  //   GPT-OSS fallback, so an OpenRouter outage would otherwise send every complex document to
  //   the protocol fallbacks; Gemini is the one model on another provider and key.
  // - Both go through OPENROUTER_API_KEY (Manas, 2026-10-03: no separate hard-lane key) and
  //   only to hosts OpenRouter lists as zero data retention. Disclosed in relatchlp#26, which
  //   must be live before ROUTING_MODE=on.
  // - DeepSeek with thinking OFF ({effort:'low'} is ignored and truncated 8/15 in the arena).
  //   GLM thinks by default (260 reasoning tokens on a tiny prompt, live 2026-10-02), so it
  //   gets the +3000 headroom the arena ran it with; DeepSeek no-think peaked ~2.8k tokens.
  // - The rule (HARD_LANE_RULES) was calibrated 2026-10-02 on 52 documents exactly as the
  //   frontend sends them (jev-harness/routing-calib.js): 17% of the corpus, 26% of medium and
  //   large documents, never small ones, and 0/35 decisions flipped on a repeat Jev run. The
  //   draft rule (2 of 5 signals) flagged 94% of medium+large: depth_p_dense is ~1.0 on almost
  //   everything and content-map segments only track length. doc_type_confidence sits at 0.5
  //   and flipped between runs, so it is not used.
  const HARD_LANE_RULES = {
    sizeClasses: ['medium', 'large'], // small documents never route
    minRichFacets: 5,                 // plan.rich: facets with evidence >= 2.5 (lib/planner)
    maxLowSignal: 0.7,                // boilerplate gains nothing from a stronger model
    csvMinRows: 20,                   // Template E (Claude): numeric tables, DeepSeek was best
  };
  // Per chain entry (code review 2026-10-03): each hard-lane model carries its own size-scaled
  // timeouts and token headroom. Worst case, large: Jev ~10 + 75 + 75 + Gemini net 90 = 250s
  // < FUNCTION_BUDGET_MS 280s. DeepSeek's 5400-token ceiling (2600 x 1.5 + 1500) needs more
  // than a flat 45s on a slow host.
  const HARD_TIMEOUTS = { small: 45000, medium: 60000, large: 75000 };
  const HARD_DEEPSEEK = { provider: 'openrouter-hard', id: 'deepseek/deepseek-v4.1-flash', reasoningOff: true, extraTokens: 1500, timeouts: HARD_TIMEOUTS };
  const HARD_GLM = { provider: 'openrouter-hard', id: 'z-ai/glm-5.3', extraTokens: 3000, timeouts: HARD_TIMEOUTS };
  // net: true = the emergency net. It runs exactly like a primary Gemini call (model-1 timeout,
  // lite budget) so it is never weaker than today's Gemini on the same document, and Parachute
  // never escalates INTO it (code review 2026-10-03): it is for outages, not a quality retry.
  const COMPLEX_CHAIN = [HARD_DEEPSEEK, HARD_GLM, { provider: 'gemini', id: 'gemini-3.5-flash-lite', net: true }];
  const routingMode = (process.env.ROUTING_MODE || '').trim();
  const routeOn = routingMode === 'on';
  // Decided only when routing is shadow or on. why: a token for the log, never text.
  const routeDecision = (routeOn || routingMode === 'shadow') ? (() => {
    if (!planSummary) return { lane: 'normal', why: 'no_plan' };
    const rich = (planSummary.rich || []).length, lowSignal = planSummary.low_signal;
    const base = { rich, lowSignal, csvRows: null };
    if (lowSignal >= HARD_LANE_RULES.maxLowSignal) return { ...base, lane: 'normal', why: 'low_signal' };
    // Template E: only text that really parses as a numeric CSV table counts (code review: the
    // client sets `template`, so 20 lines of prose sent as 'E' must not force the paid lane).
    // Anything else falls through to the general rule below.
    const csv = effectiveTemplate === 'E' ? parachute._internal.parseCsv(rawText) : null;
    if (csv) {
      const csvRows = csv.rows.length;
      return { ...base, csvRows, lane: csvRows >= HARD_LANE_RULES.csvMinRows ? 'complex' : 'normal', why: 'csv_rows' };
    }
    if (!HARD_LANE_RULES.sizeClasses.includes(effectiveSizeClass)) return { ...base, lane: 'normal', why: 'small' };
    return { ...base, lane: rich >= HARD_LANE_RULES.minRichFacets ? 'complex' : 'normal', why: 'rich_facets' };
  })() : null;
  if (routeDecision) console.log('[route]', routingMode, routeDecision);
  // A copy, so a Parachute escalation can insert the hard lane into this request's chain only.
  const modelList = (routeOn && routeDecision.lane === 'complex' ? COMPLEX_CHAIN : NORMAL_CHAIN).slice();

  // PARACHUTE (2026-09-28, vault "Relatch Parachute Gating - Plan (2026-09-27)", phase P2):
  // PARACHUTE_MODE=shadow records every candidate below and, at each exit, schedules the gate
  // to run AFTER the reply (shadowGate). Nothing served changes, not even its timing. Unset or
  // any other value = off: no candidate is recorded, no gate runs, byte-identical to before
  // (regress.js asserts it). Shadow also needs AXIOM_TOKEN, since without it nothing is recorded.
  //
  // 2026-10-03, phases P3 + P4 (Manas: complete Parachute before wiring up more models):
  // PARACHUTE_MODE=enforce (P3) gates every candidate INSIDE the loop and acts on it:
  //   - REPAIR: the served file's two ends are fixed by parachute.repair() (an open code fence,
  //     an unclosed frontmatter, and a cut tail only when the stop reason proves truncation).
  //   - An accepted candidate is never discarded (code review: an UNUSABLE verdict means under
  //     200 chars, which can be a terse but real file). The empty/whitespace reply that used to
  //     be accepted is now rejected by scoreOutput() itself, in every mode.
  //   - ACCEPT_BEST: when no candidate is accepted, the best usable one (parachute.pickBest)
  //     is served instead of the protocol fallback, which now runs only when nothing is usable.
  // PARACHUTE_MODE=escalate (P4) adds: an accepted candidate with a HARD finding (cut off, 2+
  //   required sections missing, a wrong computed claim, invented commands) goes ONCE to the
  //   next model, whose prompt carries the findings (parachute.retryNote); the better of the
  //   two is served. Only under the plan's time rule (the next model's timeout + 10s left).
  //   Self-disarm: with Upstash Redis, once escalations pass 25% of the gated requests in the
  //   current clock hour (10+ requests), escalation stops for the rest of that hour (a sticky
  //   parachute:off:<hour> key). Each escalation is counted atomically BEFORE it happens, so a
  //   concurrent burst sees its own escalations. Only escalation disarms, since it is the one
  //   action that re-routes traffic; REPAIR and ACCEPT_BEST cannot. Redis not configured (e.g.
  //   Preview): the configured mode. Redis failing or slower than 400ms: no escalation (safe).
  // Both modes log one enrich-gate event per request after the reply, as shadow does, but
  // `would` is what was DONE. Sources over GATE_MAX_SOURCE chars skip the gate (served as off).
  const gateMode = (process.env.PARACHUTE_MODE || '').trim();
  const gateShadow = gateMode === 'shadow' && Boolean(gateAxiom);
  const gateEscalate = gateMode === 'escalate';
  const gateEnforce = gateMode === 'enforce' || gateEscalate;
  const gateCandidates = gateShadow || gateEnforce ? [] : null;
  const gateId = gateCandidates ? require('crypto').randomUUID() : null;
  const GATE_MAX_SOURCE = 100000;
  let gateActs = gateEnforce && rawText.length <= GATE_MAX_SOURCE; // let: a gate exception turns it off
  let gateEscalated = false;
  let gateRetryNote = '';     // P4: appended to the escalated model's prompt only
  let gateVerdict = null;     // decide() on the accepted candidate: PASS | REPAIR | KEEP
  let gateDisarmedNow = null; // P4: true when the self-disarm stopped an escalation
  let gateInlineMs = 0;       // time the gate added INSIDE the request (enforce/escalate)
  let gateServedText = null;  // enforce/escalate: the exact text served (sanitized + repaired)
  let gateDecided = null;     // enforce/escalate: { would, pick, repaired } for the event

  // Inspected exactly as calibrated: sanitize()d text against the full source (rawText).
  let gateCtxCache = null;
  const gateCtx = () => gateCtxCache || (gateCtxCache = {
    template: effectiveTemplate, shape: activeCodexShape, source: rawText,
    // the prompt minus the document it carries (the source is already `source`)
    vocab: [textToSend ? prompt.split(textToSend).join(' ') : prompt, fileName, domainLabel, domainRole, domainFrame].filter(Boolean).join('\n'),
  });
  const gateSkillArg = activeTarget === 'codex' ? codexSlug : skillName;
  // The plan's time rule: a next model must exist AND its timeout + 10s must remain (Codex
  // also keeps its model-2 reserve).
  // 2026-10-03 (Routing B): with ROUTING_MODE=on, a normal-lane escalation goes to the hard
  // lane's first model (escalationTarget) instead of the next normal model, and the time rule
  // uses that model's own timeout.
  const escalationTarget = (modelId) => {
    if (routeOn && routeDecision.lane === 'normal' && !modelList.includes(HARD_DEEPSEEK)) return HARD_DEEPSEEK;
    const next = modelList[modelList.findIndex((m) => m.id === modelId) + 1] || null;
    return next && next.net ? null : next; // never escalate into the emergency net
  };
  const gateCanEscalate = (modelId, atMs) => {
    const nextModel = escalationTarget(modelId);
    const remainingMs = FUNCTION_BUDGET_MS - atMs;
    const nextTimeoutMs = nextModel && nextModel.timeouts
      ? nextModel.timeouts[effectiveSizeClass] ?? HARD_TIMEOUTS.small
      : (CODEX_POLICY.timeouts.model2[effectiveSizeClass] ?? 20000);
    return Boolean(nextModel)
      && remainingMs >= nextTimeoutMs + 10000
      && (activeTarget !== 'codex' || remainingMs >= CODEX_POLICY.model2ReserveMs);
  };
  // P4 self-disarm. Per clock hour (UTC); the counters are written after the reply (gateLog).
  const GATE_DISARM = { share: 0.25, minRequests: 10 };
  const gateHour = new Date().toISOString().slice(0, 13);
  const gateKeys = { req: `parachute:req:${gateHour}`, esc: `parachute:esc:${gateHour}`, off: `parachute:off:${gateHour}` };
  const gateTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('timeout')), ms); if (t.unref) t.unref(); })]);
  // Called only when an escalation is about to happen. true = do not escalate.
  async function gateDisarmed() {
    if (!redis) return false; // Redis not configured (e.g. Preview): the configured mode
    try {
      return await gateTimeout((async () => {
        const [req, off] = await redis.mget(gateKeys.req, gateKeys.off);
        if (off) return true; // already tripped this hour: sticky
        const esc = Number(await redis.incr(gateKeys.esc)) || 0; // counts this escalation, atomically
        const r = Number(req) || 0;
        if (r >= GATE_DISARM.minRequests && esc / r > GATE_DISARM.share) {
          await redis.set(gateKeys.off, 1, { ex: 7200 });
          console.log('[gate] self-disarm: escalation off for the rest of this hour', { requests: r, escalations: esc });
          return true;
        }
        return false;
      })(), 400);
    } catch (err) {
      console.log('[gate] self-disarm check failed, not escalating:', err?.message || 'unknown');
      return true;
    }
  }

  let finalRawText = null;
  let successfulModel = null;
  let lastGoogleError = "No models responded";

  // V2: track model index for quality threshold (Lite >= 6, Flash >= 5)
  let modelIndex = 0;

  // Note: a Parachute escalation may splice the hard lane into modelList while this loop runs.
  // That is deliberate and well-defined (an array iterator reads the live length), and regress
  // section 15's escalation drills fail if the inserted model is ever skipped.
  for (const { provider, id: modelId, reasoningOff, extraTokens, timeouts, net } of modelList) {
    const controller = new AbortController();

    // Timeouts are sizeClass-aware so large-doc generation (1800 token output budget)
    // is not killed mid-stream. At Gemini's degraded throughput floor (~55 tok/s),
    // 1800 tokens takes ~33s + ~5s overhead = ~38s. Model 1 on large gets 35s (covers
    // the vast majority of degraded cases). Model 2 always stays short — by the time
    // model 2 runs, the budget is lower (1400 tokens) and remaining Vercel time is used.
    // Total ceiling: large = 35+18 = 53s, small/medium = 25+20 = 45s. Both < 60s limit.
    // Groq (behind OpenRouter, model 2's new provider) responded in 4.5-6.8s across
    // every live test — well inside this budget already, no widening needed here.
    // Routing B: a hard-lane model uses its own size-scaled timeouts wherever it sits; the
    // Gemini emergency net (net) runs like a primary Gemini call (model-1 timeout, lite budget).
    const primaryLike = modelIndex === 0 || Boolean(net);
    const perModelTimeoutMs = timeouts ? (timeouts[effectiveSizeClass] ?? timeouts.small) : primaryLike
      ? (CODEX_POLICY.timeouts.model1[effectiveSizeClass] ?? 25000)
      : (CODEX_POLICY.timeouts.model2[effectiveSizeClass] ?? 20000);
    const timeoutId = setTimeout(() => controller.abort(), perModelTimeoutMs);

    // V2 ADAPTIVE: per-model output token budget driven by sizeClass.
    // modelIndex 0 = Flash Lite (full window), modelIndex 1 = fallback (capped lower).
    // Always resolves to a number because budgetForSize falls back to tokenBudgets.small.
    // OpenRouter/GPT-OSS needs real extra headroom vs Gemini at the same nominal budget —
    // live testing showed truncated output at budgetForSize.lite (1400) on a Codex-shape
    // generation even with reasoning effort set to low; +700 fixed it in testing. Applied
    // only to this provider — Gemini's own budget is unchanged.
    // planTokenMultiplier is 1 unless Jev judged the source dense (Claude target only).
    const baseTokenBudget = Math.round((primaryLike ? budgetForSize.lite : budgetForSize.flash) * planTokenMultiplier);
    // Routing B: hard-lane models add their own headroom (extraTokens, see HARD_DEEPSEEK/HARD_GLM).
    const outputTokenBudget = provider === 'openrouter' ? baseTokenBudget + 700
      : extraTokens ? baseTokenBudget + extraTokens
      : baseTokenBudget;

    // Codex-only: skip model 2 if insufficient time remains for a useful response.
    // Prevents spending the last few seconds on a weak attempt likely to timeout.
    if (activeTarget === 'codex' && modelIndex > 0) {
      const remainingMs = FUNCTION_BUDGET_MS - (Date.now() - requestStartMs);
      if (remainingMs < CODEX_POLICY.model2ReserveMs) {
        clearTimeout(timeoutId);
        lastGoogleError = `timeout_model_2 (skipped: only ${Math.round(remainingMs / 1000)}s remaining)`;
        if (gateCandidates) gateCandidates.push({ model: modelId, outcome: 'skipped_no_time' });
        break;
      }
    }

    try {
      const response = provider === 'gemini'
        ? await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                // gateRetryNote is '' except on a Parachute P4 escalation (see above).
                contents: [{ parts: [{ text: prompt + gateRetryNote }] }],
                // V2 ADAPTIVE: ceiling per (sizeClass, model) — temperature unchanged.
                // 2026-09-27: thinking pinned to 'minimal', which Google documents as 3.5
                // Flash-Lite's default. Thinking tokens count against maxOutputTokens, so if
                // Google ever changes the default, unpinned thinking would eat the budget and
                // cut files off.
                generationConfig: { maxOutputTokens: outputTokenBudget, temperature: 0.7, thinkingConfig: { thinkingLevel: 'minimal' } }
              }),
              signal: controller.signal
            }
          )
        : provider === 'openrouter-hard'
        // Routing B hard lane (DeepSeek / GLM): the same OpenRouter key as GPT-OSS, but none of
        // GPT-OSS's Groq pin or reasoning effort. zdr + data_collection 'deny' restrict OpenRouter
        // to hosts that neither retain nor train on prompts (verified live 2026-10-02: CoreWeave
        // for DeepSeek, SiliconFlow for GLM). DeepSeek's thinking is disabled outright.
        ? await fetch(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://app.relatch.online',
                'X-Title': 'Relatch',
              },
              body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'user', content: prompt + gateRetryNote }],
                max_tokens: outputTokenBudget,
                temperature: 0.7,
                // require_parameters (DeepSeek, code review 2026-10-03): only hosts that honour
                // every parameter sent, so none can silently ignore reasoning:{enabled:false}
                // and let hidden thinking eat the token budget. If no such ZDR host is up, the
                // call errors and the chain falls through to GLM.
                // sort 'throughput' (2026-10-04): try the fastest ZDR host first instead of
                // OpenRouter's price-weighted load balancing, which can pick a slow host. In the
                // prod `on` bake 5 DeepSeek calls took 5-13s but one took ~60s for ~3.3k tokens,
                // and the landing page promises results in under a minute. A host error still falls
                // back to the next host (OpenRouter provider-routing doc); price differences
                // between hosts are a fraction of a cent per skill.
                provider: { zdr: true, data_collection: 'deny', sort: 'throughput', ...(reasoningOff ? { require_parameters: true } : {}) },
                ...(reasoningOff ? { reasoning: { enabled: false } } : {}),
              }),
              signal: controller.signal
            }
          )
        : await fetch(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://app.relatch.online',
                'X-Title': 'Relatch',
              },
              body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'user', content: prompt + gateRetryNote }],
                max_tokens: outputTokenBudget,
                temperature: 0.7,
                // Low reasoning effort — this model burns its output budget on hidden
                // reasoning tokens by default; low effort plus the +700 pad above keeps
                // real content from being truncated or crowded out entirely.
                reasoning: { effort: 'low' },
                // Pinned to Groq specifically for its throughput; allow_fallbacks:false
                // so a slower backend never silently substitutes.
                provider: { order: ['groq'], allow_fallbacks: false },
              }),
              signal: controller.signal
            }
          );

      // 2026-10-04: the timeout now stays armed until the BODY is read, not just the headers.
      // OpenRouter sends 200 + headers as soon as a provider accepts the request, before the
      // first token (its errors doc), so clearing it here left generation itself unbounded for
      // every OpenRouter model (the hard lane and the GPT-OSS fallback): in the prod `on` bake
      // one DeepSeek call (pg-ds, medium, 60s timeout) took the request to 68.4s, and a host
      // that never finished would have run into Vercel's limit with no fallback. An abort during
      // the body read rejects response.json() with AbortError, which the catch below already
      // turns into a timeout and the next model.

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        clearTimeout(timeoutId);
        // Routing B (code review 2026-10-03): lastGoogleError reaches the client in the 503
        // message and the Codex fallbackReason, so a hard-lane error stays generic there (no
        // provider text such as "No endpoints found matching your data policy"); the detail
        // goes to the server log only.
        if (provider === 'openrouter-hard') {
          console.log('[route] hard-lane error', { model: modelId, status: response.status, message: String(errorData.error?.message || 'Unknown').slice(0, 200) });
          lastGoogleError = `HTTP ${response.status}`;
        } else {
          lastGoogleError = `HTTP ${response.status}: ${errorData.error?.message || 'Unknown'}`;
        }
        if (gateCandidates) gateCandidates.push({ model: modelId, outcome: `http_${response.status}` });

        // Retry on transient failures, plus 404 — with a real second provider now in
        // the chain, a 404 on the primary model (e.g. a retired model id) should fall
        // through to it rather than aborting the whole request outright, which is the
        // exact case cross-provider redundancy exists for. 400/401/403 still break —
        // narrower change, scoped to what this session's testing actually covered.
        // 2026-09-27: 400 now falls through too. The Gemini request carries a thinkingConfig,
        // and Google answers an unsupported value (and an invalid API key) with 400, which
        // would otherwise end the chain as a full outage instead of reaching GPT-OSS on its
        // own key. 401/403 still break.
        // Routing B (code review 2026-10-03): ANY error from a hard-lane model falls through.
        // Its 401/402 (OpenRouter out of credit)/403 says nothing about the next model, and
        // the Gemini net exists for exactly that OpenRouter failure.
        if (provider === 'openrouter-hard' || response.status === 400 || response.status === 429 || response.status === 404 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504) {
          modelIndex++;
          continue;
        }
        break;
      }

      const data = await response.json();
      clearTimeout(timeoutId); // the body is in: only now has the call finished (see above)
      const candidateText = provider === 'gemini'
        ? (data.candidates?.[0]?.content?.parts?.[0]?.text || '')
        : (data.choices?.[0]?.message?.content || '');

      // 2026-09-26 truncation telemetry: the provider's own stop reason is the only reliable
      // truncation signal (scoreOutput can't see it - it scored cut-off files 9/9). Log only;
      // acceptance and fallback behaviour are unchanged.
      const stopReason = provider === 'gemini' ? data.candidates?.[0]?.finishReason : data.choices?.[0]?.finish_reason;
      if (stopReason === 'MAX_TOKENS' || stopReason === 'length') {
        console.log('[enrich] hit output cap', { model: modelId, template: effectiveTemplate, sizeClass: effectiveSizeClass, cap: outputTokenBudget, chars: candidateText.length });
      }

      // V2: replaced old 2-condition check with template-aware quality scoring
      // Flash Lite (index 0) must score >= 6
      // Fallback tier (index 1, GPT-OSS-120B via OpenRouter) must score >= 4
      const qualityThreshold = modelIndex === 0 ? CODEX_POLICY.qualityThresholds.lite : CODEX_POLICY.qualityThresholds.flash;

      const score = scoreOutput(candidateText, effectiveTemplate, effectiveSizeClass);

      // PARACHUTE enforce/escalate (P3/P4): gate this candidate here. scoreOutput() still decides
      // acceptance exactly as before; the gate only decides what happens to an ACCEPTED one:
      // serve it (PASS/REPAIR), escalate it once, or KEEP it for the end-of-chain pickBest().
      // An accepted candidate is never discarded, so the fallbacks never fire more often than
      // before Parachute; one judged UNUSABLE (a terse but real file) is handled like HARD.
      // An exception in the gate turns it off for the rest of the request (fail open: served as
      // off) instead of being reported as a provider error.
      let gate = null;
      if (gateActs) {
        try {
          const g0 = Date.now();
          const text = sanitize(candidateText, gateSkillArg, effectiveTemplate);
          const report = parachute.inspect({ text, stopReason }, gateCtx());
          const atMs = Date.now() - requestStartMs;
          let verdict = null;
          if (score >= qualityThreshold) {
            const canEscalate = gateEscalate && !gateEscalated && gateCanEscalate(modelId, atMs);
            verdict = parachute.decide(report.tier === 'UNUSABLE' ? { ...report, tier: 'HARD' } : report, { canEscalate });
            if (verdict === 'ESCALATE') {
              gateDisarmedNow = await gateDisarmed();
              if (gateDisarmedNow) verdict = 'KEEP';
            }
          }
          gate = { entry: { model: modelId, stop: stopReason, text, report, atMs }, verdict };
          gateInlineMs += Date.now() - g0;
        } catch (err) {
          gateActs = false;
          console.log('[gate] error, gate off for this request:', err?.message || 'unknown');
        }
      }

      if (score >= qualityThreshold) {
        if (gate && gate.verdict === 'ESCALATE') {
          // lastGoogleError is left alone: gate wording must never reach a response body.
          gateCandidates.push({ ...gate.entry, outcome: 'escalated' });
          gateEscalated = true;
          gateRetryNote = parachute.retryNote(gate.entry.report);
          // Routing B: put the escalation target next in this request's chain (a normal-lane
          // escalation goes to DeepSeek when routing is on; otherwise it is already next).
          const target = escalationTarget(modelId);
          if (target && !modelList.includes(target)) modelList.splice(modelList.findIndex((m) => m.id === modelId) + 1, 0, target);
          console.log('[gate] escalate', { from: modelId, codes: [...new Set(gate.entry.report.findings.filter((f) => f.tier === 'HARD' || f.tier === 'UNUSABLE').map((f) => f.code))] });
          modelIndex++;
          continue;
        }
        finalRawText = candidateText;
        successfulModel = modelId;
        if (gate) gateVerdict = gate.verdict;
        if (gateCandidates) gateCandidates.push(gate ? { ...gate.entry, outcome: 'accepted' } : { model: modelId, outcome: 'accepted', stop: stopReason, text: candidateText, atMs: Date.now() - requestStartMs });
        break;
      } else {
        // Output did not pass quality check — try next model
        lastGoogleError = `Quality check failed (score: ${score}/${qualityThreshold} required) for model: ${modelId}`;
        if (gateCandidates) gateCandidates.push(gate ? { ...gate.entry, outcome: 'score_rejected' } : { model: modelId, outcome: 'score_rejected', stop: stopReason, text: candidateText });
        modelIndex++;
        continue;
      }

    } catch (err) {
      clearTimeout(timeoutId);
      // UNCHANGED — exact same error message logic as before
      lastGoogleError = err.name === 'AbortError' ? `Timeout: Model took too long (${perModelTimeoutMs / 1000}s)` : `Fetch Error: ${err.message}`;
      if (gateCandidates) gateCandidates.push({ model: modelId, outcome: err.name === 'AbortError' ? 'timeout' : 'error' });
      modelIndex++;
      continue;
    }
  }

  // PARACHUTE enforce/escalate: choose what is served. An accepted PASS/REPAIR candidate is
  // served; otherwise the best usable candidate (KEEP after a HARD verdict, or ACCEPT_BEST when
  // nothing was accepted). Whatever is served goes through repair(), which changes nothing on a
  // clean file. Nothing usable: finalRawText stays null and the protocol fallbacks run as before.
  if (gateActs) {
    const g0 = Date.now();
    const accepted = gateCandidates.find((c) => c.outcome === 'accepted');
    let pickEntry = null, would = 'fallback', repaired = false;
    // Candidates scoreOutput() accepted (the accepted one and an escalated one). When any exist,
    // only they compete: a draft scoreOutput rejected never replaces one it accepted (code
    // review). pickBest() skips UNUSABLE-tier entries, so if it finds none of them usable, the
    // first one scoreOutput accepted is served, which is what was served before Parachute.
    const passed = gateCandidates.filter((c) => c.outcome === 'accepted' || c.outcome === 'escalated');
    if (accepted && gateVerdict !== 'KEEP') {
      pickEntry = accepted;
      would = gateVerdict === 'REPAIR' ? 'repair' : 'pass';
    } else if (passed.length) {
      pickEntry = parachute.pickBest(passed) || passed[0];
      would = 'keep';
    } else {
      pickEntry = parachute.pickBest(gateCandidates.filter((c) => c.report));
      if (pickEntry) would = 'accept_best';
    }
    if (pickEntry) {
      const fixed = parachute.repair(pickEntry.text, gateCtx(), { stopReason: pickEntry.stop });
      gateServedText = fixed.text;
      repaired = fixed.applied.length > 0;
      // the model branch below serves gateServedText; finalRawText only has to be set
      finalRawText = finalRawText || pickEntry.text;
      successfulModel = pickEntry.model;
    }
    gateInlineMs += Date.now() - g0;
    gateDecided = { would, pick: pickEntry ? gateCandidates.indexOf(pickEntry) : null, repaired };
    if (would !== 'pass') console.log('[gate]', gateMode, { would, repaired, served: successfulModel });
  }

  // PARACHUTE shadow gate: runs AFTER the reply (waitUntil) on its own Axiom client, so it can
  // never delay or change what is served. One event per request into relatch-security,
  // endpoint 'enrich-gate' (Watchtower counts only status >= 400 there). The event carries
  // finding CODES, tiers, counts, stop reasons, model ids and a random gateId only, never
  // document or output text.
  // - Inspected exactly as calibrated: on sanitize()d text, against the full source (rawText).
  //   Sources over GATE_MAX_SOURCE chars are skipped (skipped: 'large_source') to bound CPU.
  // - `would` is what enforce mode would have done, from lib/parachute's own decide() and
  //   pickBest(): 'pass' | 'repair' (P3) | 'escalate' | 'keep' (P4; keep = no model or no time
  //   left, by the plan's "next timeout + 10s" rule) | 'unusable' (served file has no real
  //   content) | 'accept_best' (a usable candidate existed where the protocol fallback or 503
  //   fired, P3; `pick` is its index) | 'fallback' (nothing usable either way).
  // 2026-10-03: renamed gateLog; it also logs enforce/escalate requests (mode = PARACHUTE_MODE).
  //   There `would` is what was DONE: 'pass' | 'repair' | 'keep' | 'accept_best' | 'fallback';
  //   `pick` is the served candidate's index; servedTier is the tier of the text actually
  //   served (after repair()); the extra keys are repaired, disarmed and inlineMs (the time the
  //   gate added inside the request). It also writes the P4 self-disarm counters (Redis).
  //   GATE_MAX_SOURCE moved up to the PARACHUTE block.
  function gateLog(servedText, served) {
    const run = async () => {
      await new Promise((resolve) => setImmediate(resolve)); // let the reply go out first
      // P4 self-disarm counters: every gated request in this clock hour. Escalations were
      // already counted, atomically, when they happened (gateDisarmed).
      if (gateEscalate && gateActs && redis) {
        try {
          await gateTimeout((async () => {
            await redis.incr(gateKeys.req);
            await redis.expire(gateKeys.req, 7200);
            if (gateDisarmedNow !== null) await redis.expire(gateKeys.esc, 7200);
          })(), 2000);
        } catch (err) {
          console.log('[gate] self-disarm counters failed:', err?.message || 'unknown');
        }
      }
      if (!gateAxiom) return; // enforce/escalate act without AXIOM_TOKEN, they just log no event
      const t0 = Date.now();
      let skipped = null, would = 'fallback', pick = null, servedReport = null, candidates;
      if (rawText.length > GATE_MAX_SOURCE) {
        skipped = 'large_source';
        candidates = gateCandidates.map((c) => ({ model: c.model, outcome: c.outcome, stop: c.stop || null }));
      } else {
        const ctx = gateCtx(); // the same context as before, now built once in the PARACHUTE block
        const reports = gateCandidates.map((c) => {
          if (c.report) return { text: c.text, report: c.report }; // enforce/escalate: inspected in the loop
          if (typeof c.text !== 'string') return null;
          // the accepted candidate IS the served file: reuse it instead of sanitizing twice
          const text = c.outcome === 'accepted' && typeof servedText === 'string' ? servedText : sanitize(c.text, gateSkillArg, effectiveTemplate);
          return { text, report: parachute.inspect({ text, stopReason: c.stop }, ctx) };
        });
        candidates = gateCandidates.map((c, i) => {
          const r = reports[i] && reports[i].report;
          return { model: c.model, outcome: c.outcome, stop: c.stop || null, ...(r ? { tier: r.tier, codes: [...new Set(r.findings.map((f) => f.code))], hard: r.findings.filter((f) => f.tier === 'HARD').length, anchors: `${r.anchors.present}/${r.anchors.required}`, chars: r.chars } : {}) };
        });
        const acceptedIdx = gateCandidates.findIndex((c) => c.outcome === 'accepted');
        if (gateDecided) {
          ({ would, pick } = gateDecided);
          // the in-loop report when nothing was repaired; re-inspect only the repaired text
          if (pick !== null) servedReport = gateDecided.repaired && typeof servedText === 'string' ? parachute.inspect({ text: servedText, stopReason: gateCandidates[pick].stop }, ctx) : gateCandidates[pick].report;
        } else if (served === 'model' && acceptedIdx !== -1 && reports[acceptedIdx]) {
          const accepted = gateCandidates[acceptedIdx];
          servedReport = reports[acceptedIdx].report;
          // the plan's time rule, now shared with enforce/escalate (gateCanEscalate)
          const canEscalate = gateCanEscalate(accepted.model, accepted.atMs);
          would = ({ PASS: 'pass', REPAIR: 'repair', ESCALATE: 'escalate', KEEP: 'keep', DISCARD: 'unusable' })[parachute.decide(servedReport, { canEscalate })];
        } else {
          const usable = reports.filter(Boolean);
          const best = parachute.pickBest(usable);
          if (best) { would = 'accept_best'; pick = reports.indexOf(best); }
        }
      }
      const event = {
        endpoint: 'enrich-gate', mode: gateShadow ? 'shadow' : gateMode, gateId, target: activeTarget, template: effectiveTemplate,
        shape: activeTarget === 'codex' ? activeCodexShape : null, sizeClass: effectiveSizeClass,
        served, servedTier: servedReport ? servedReport.tier : null,
        servedCodes: servedReport ? [...new Set(servedReport.findings.map((f) => f.code))] : [],
        would: skipped ? null : would, pick, skipped, candidates, gateMs: Date.now() - t0,
        ...(gateEnforce ? { repaired: gateDecided ? gateDecided.repaired : null, disarmed: gateDisarmedNow, inlineMs: gateInlineMs } : {}),
      };
      gateAxiom.ingest('relatch-security', [{ ...event, _time: new Date().toISOString() }]);
      // Capped so a hanging Axiom cannot keep the function alive (and billed) under waitUntil
      // for the whole maxDuration. This is after the reply, so the cap costs no latency.
      await Promise.race([gateAxiom.flush(), new Promise((resolve) => { const t = setTimeout(resolve, 10000); if (t.unref) t.unref(); })]);
    };
    const promise = run().catch((err) => console.log(`[gate] ${gateShadow ? 'shadow' : gateMode} failed:`, err?.message || 'unknown'));
    waitUntil(promise);
  }

  // ROUTING Phase B telemetry: one enrich-route event per request when ROUTING_MODE is shadow
  // or on, after the reply, on the gate's own Axiom client (never delays a reply or the
  // security logs). Tokens and numbers only: the lane, why, the rule inputs, the chain of model
  // ids, what served. Watchtower counts only status >= 400 there, so this never pages.
  function routeLog(served) {
    if (!routeDecision || !gateAxiom) return;
    const event = {
      endpoint: 'enrich-route', mode: routingMode, lane: routeDecision.lane, why: routeDecision.why,
      rich: routeDecision.rich ?? null, lowSignal: routeDecision.lowSignal ?? null, csvRows: routeDecision.csvRows ?? null,
      target: activeTarget, template: effectiveTemplate, sizeClass: effectiveSizeClass,
      chain: modelList.map((m) => m.id), served, model: served === 'model' ? successfulModel : null,
      gateId, ms: Date.now() - requestStartMs,
    };
    const run = async () => {
      await new Promise((resolve) => setImmediate(resolve)); // let the reply go out first
      gateAxiom.ingest('relatch-security', [{ ...event, _time: new Date().toISOString() }]);
      await Promise.race([gateAxiom.flush(), new Promise((resolve) => { const t = setTimeout(resolve, 10000); if (t.unref) t.unref(); })]);
    };
    waitUntil(run().catch((err) => console.log('[route] log failed:', err?.message || 'unknown')));
  }

  // v2.4: Codex deterministic fallback assembler.
  // Declared inside handler so it closes over already-computed local vars:
  //   signalLines, activeCodexShape, codexSlug, safeDomainLabel, safeDomainRole, focus
  // Called only when activeTarget === 'codex' AND all Gemini models failed.
  // No LLM calls. No new dependencies. Zero impact on Claude path.
  function buildCodexFallback() {
    // Step A — re-bucket signalLines by operational semantics (priority order, first match wins)
    const buckets = {
      workflow:     [],
      refuse:       [],
      escalate:     [],
      antiPatterns: [],
      constraints:  [],
      other:        [],
    };

    for (const line of signalLines) {
      const clean = line.replace(/^[-•*\d.)]+\s*/, '').trim();
      if (!clean) continue;

      if (/^\s*(\d+[.)]\s|step\s*\d|\bfirst\b|\bthen\b|\bfinally\b|\bnext\b|\bafter\b|\bbefore\b)/i.test(line)) {
        buckets.workflow.push(clean);
      } else if (/\b(refuse|reject|out.?of.?scope|not (in|within) scope|decline|cannot|will not|outside)\b/i.test(line)) {
        buckets.refuse.push(clean);
      } else if (/\b(escalate|human|review|approve|sign.?off|pause|ask|clarify|ambig|unclear|exception|edge case)\b/i.test(line)) {
        buckets.escalate.push(clean);
      } else if (/\b(never|avoid|don't|do not|incorrect|wrong|bad|anti-pattern|mistake|error|fail)\b/i.test(line)) {
        buckets.antiPatterns.push(clean);
      } else if (/^\s*[-•*]?\s*\b(always|must|never|avoid|ensure|require|enforce|refuse|reject|do not|don't|stop|halt|block|verify|confirm|check|validate|run|execute|apply|set|reset|clear|deploy|migrate|refactor|test|lint|build|install|import|export)\b/i.test(line)) {
        buckets.constraints.push(clean);
      } else {
        buckets.other.push(clean);
      }
    }

    // Step B — fill() helper: take n items from bucket, drain buckets.other if short, emit placeholder if empty
    function fill(bucket, n, placeholder) {
      const items = bucket.slice(0, n);
      if (items.length < n) {
        const needed = n - items.length;
        items.push(...buckets.other.splice(0, needed));
      }
      if (items.length === 0) items.push(placeholder);
      return items;
    }

    // Step C — shared sections (all shapes)
    const triggerCandidates = signalLines
      .filter(l => /\b(when|if you|run|apply|execute|review|refactor|deploy|create|generate|fix|build|validate|check)\b/i.test(l))
      .slice(0, 4)
      .map(l => l.replace(/^[-•*\d.)]+\s*/, '').trim().split(/[.!?]/)[0].trim())
      .filter(l => l.length > 10 && l.length < 90);
    const verbMap = { execute: 'Executes', expertise: 'Reviews', specialist: 'Applies' };
    const actionVerb = verbMap[activeCodexShape] || 'Applies';
    const triggerStr = triggerCandidates.length >= 2
      ? triggerCandidates.slice(0, 2).join('; ').toLowerCase()
      : `${safeDomainLabel} ${activeCodexShape} operations`;
    const safeDesc = `${actionVerb} ${safeDomainLabel} procedures from source material. Activates when: ${triggerStr}. Does not apply to out-of-scope or ambiguous requests.`;

    const activationSection = [
      '## When to Activate',
      '### Must Use',
      ...fill([...buckets.constraints], 3, `${safeDomainLabel} ${activeCodexShape} task`).map(i => `- ${i}`),
      '### Recommended',
      ...fill([...buckets.other], 2, `General ${safeDomainLabel} work`).map(i => `- ${i}`),
      '### Skip',
      ...fill(buckets.refuse.length > 0 ? [...buckets.refuse] : [...buckets.antiPatterns], 2, 'Out-of-scope requests').map(i => `- ${i}`),
    ].join('\n');

    const principlesSection = [
      '## Key Principles',
      ...fill([...buckets.constraints, ...buckets.other], 4, `Follow ${safeDomainLabel} operational standards`).map(i => `- ${i}`),
    ].join('\n');

    // Step D — shape-specific body sections, emitting exactly the anchors scoreOutput() rewards
    let shapeBody = '';

    if (activeCodexShape === 'execute') {
      const workflowItems = buckets.workflow.length >= 3
        ? buckets.workflow.slice(0, 8)
        : fill([...buckets.workflow, ...buckets.constraints], 5, `Complete ${safeDomainLabel} task step`);
      const antiPatternItems = fill([...buckets.antiPatterns], 4, 'Avoid shortcuts that skip validation');
      const finalCheckItems = fill([...buckets.constraints.slice(3), ...buckets.other], 3, `Verify output meets ${safeDomainLabel} standard`);

      shapeBody = [
        '## Implementation Workflow',
        ...workflowItems.map((s, i) => `${i + 1}. ${s}`),
        '',
        '## Common Mistakes to Avoid',
        ...antiPatternItems.map(i => `- **Don't:** ${i}`),
        '',
        '## Final Checks',
        ...finalCheckItems.map((s, i) => `${i + 1}. ${s}`),
      ].join('\n');

    } else if (activeCodexShape === 'expertise') {
      const reviewItems = buckets.workflow.length >= 3
        ? buckets.workflow.slice(0, 6)
        : fill([...buckets.workflow, ...buckets.constraints], 4, `Evaluate ${safeDomainLabel} output`);
      const judgmentItems = fill([...buckets.constraints, ...buckets.other], 3, `Apply ${safeDomainLabel} quality criteria`);
      const pauseItems = buckets.escalate.length > 0
        ? buckets.escalate.slice(0, 4)
        : fill([...buckets.other], 3, 'Pause when intent or scope is ambiguous');

      shapeBody = [
        '## Review Workflow',
        ...reviewItems.map((s, i) => `${i + 1}. ${s}`),
        '',
        '## Judgment Framework',
        ...judgmentItems.map(i => `- ${i}`),
        '',
        '## When to Pause for Human',
        ...pauseItems.map(i => `- ${i}`),
      ].join('\n');

    } else {
      // specialist
      const doesItems     = fill([...buckets.constraints, ...buckets.other], 4, `Perform ${safeDomainLabel} analysis`);
      const doesNotItems  = fill([...buckets.refuse, ...buckets.antiPatterns], 3, `Out-of-scope ${safeDomainLabel} requests`);
      const autonomousItems = fill(buckets.constraints.slice(0, 3), 2, `Standard ${safeDomainLabel} operations with clear scope`);
      const escalateItems = fill([...buckets.escalate], 2, 'Decisions with legal, financial, or compliance impact');
      const refuseItems   = fill([...buckets.refuse], 2, `Requests outside defined ${safeDomainLabel} boundaries`);
      const workflowItems = buckets.workflow.length >= 2
        ? buckets.workflow.slice(0, 6)
        : fill([...buckets.workflow, ...buckets.constraints], 4, `Execute ${safeDomainLabel} procedure`);

      // Decision Matrix: extract condition/action pairs from escalate + refuse buckets.
      // Uses .slice() not fill() so it doesn't drain buckets.other before escalation/mistakes.
      // Rows are grounded in source signals — anti-hallucination preserved in fallback.
      const dmEscalateRaw = buckets.escalate.slice(0, 2)
        .map(l => l.split(/[.!?]/)[0].slice(0, 60).trim()).filter(Boolean);
      const dmRefuseRaw   = buckets.refuse.slice(0, 2)
        .map(l => l.split(/[.!?]/)[0].slice(0, 60).trim()).filter(Boolean);
      const dmRows = [
        ...dmEscalateRaw.map(c => `| ${c} | Escalate to human reviewer | Yes |`),
        ...dmRefuseRaw.map(c => `| ${c} | Refuse and redirect out of scope | No |`),
      ];
      if (dmRows.length < 2) {
        dmRows.push(`| Out-of-scope ${safeDomainLabel} request | Refuse and redirect | No |`);
        dmRows.push(`| Ambiguous scope or authority | Pause and surface to human | Yes |`);
      }

      const escalationRulesItems = fill(
        [...buckets.escalate, ...buckets.other.filter(l => /\b(human|review|approve|unclear|ambig)\b/i.test(l))],
        3, 'Surface to human when scope or authority is unclear'
      );
      const commonMistakesItems = fill(
        [...buckets.antiPatterns, ...buckets.constraints.slice(-2)],
        4, `Avoid exceeding defined ${safeDomainLabel} scope boundaries`
      );

      shapeBody = [
        '## Scope Boundaries',
        '**This role DOES:**',
        ...doesItems.map(i => `- ${i}`),
        '**This role does NOT:**',
        ...doesNotItems.map(i => `- ${i}`),
        '',
        '## Operating Mode',
        `**Autonomous:** ${autonomousItems.join('; ')}`,
        `**Escalate:** ${escalateItems.join('; ')}`,
        `**Refuse:** ${refuseItems.join('; ')}`,
        '',
        '## Workflow',
        ...workflowItems.map((s, i) => `${i + 1}. ${s}`),
        '',
        '## Decision Matrix',
        '| Condition | Action | Escalate? |',
        '| --- | --- | --- |',
        ...dmRows,
        '',
        '## Escalation Rules',
        ...escalationRulesItems.map(i => `- ${i}`),
        '',
        '## Common Mistakes to Avoid',
        ...commonMistakesItems.map(i => `- ${i}`),
      ].join('\n');
    }

    // Step E — final assembly (format identical to what sanitize('CODEX') expects)
    return [
      '---',
      `name: ${codexSlug}`,
      `description: "${safeDesc}"`,
      '---',
      '',
      activationSection,
      '',
      shapeBody,
      '',
      principlesSection,
    ].join('\n');
  }

  if (activeTarget === 'codex') {
    console.log('[Codex]', { sizeClass: effectiveSizeClass, shape: activeCodexShape, outcome: finalRawText ? `model:${successfulModel}` : 'fallback', elapsed: Date.now() - requestStartMs });
  }

  // Primary path — Gemini model succeeded; count the generation and respond.
  if (finalRawText) {
    // PARACHUTE enforce/escalate: gateServedText is the chosen candidate, already sanitized and
    // repaired. Off, shadow, or a skipped gate: null, so this is exactly the line it was.
    const enrichedOutput = gateServedText !== null ? gateServedText : sanitize(finalRawText, activeTarget === 'codex' ? codexSlug : skillName, effectiveTemplate);
    // PARACHUTE shadow: scheduled here, runs after the reply. (enforce/escalate log here too.)
    if (gateCandidates) gateLog(enrichedOutput, 'model');
    routeLog('model');

    if (quotaUsage && quotaUser) {
      try {
        const isSameSession = sessionId
          && quotaUsage.lastSessionId === sessionId
          && (Date.now() - quotaUsage.lastSessionStartedAt) < SESSION_TTL_MS
          && quotaUsage.sessionRequestCount < MAX_FREE_REQUESTS_PER_SESSION;
        if (!isSameSession) {
          quotaUsage.dailyCount  += 1;
          quotaUsage.weeklyCount += 1;
          if (sessionId) {
            quotaUsage.lastSessionId = sessionId;
            quotaUsage.lastSessionStartedAt = Date.now();
            quotaUsage.sessionRequestCount = 1;
          }
        } else {
          quotaUsage.sessionRequestCount += 1;
        }
        await clerkClient.users.updateUserMetadata(userId, {
          privateMetadata: { relatchUsage: quotaUsage },
        });
      } catch (writeErr) {
        console.error('[quota] Clerk write failed:', writeErr?.message || writeErr);
      }
    }

    // `plan` only appears when Jev answered - the frontend ignores unknown fields.
    return res.status(200).json({ enriched: enrichedOutput, model: successfulModel, sessionId, ...(planSummary ? { plan: planSummary } : {}), ...(contentSummary ? { content: contentSummary } : {}) });
  }

  // v2.4: Codex deterministic fallback — fires only when target === 'codex' AND all Gemini
  // models failed. Passes through sanitize('CODEX') so shape-section injection and frontmatter
  // enforcement fire identically to the primary path. Returns HTTP 200 with diagnostic signal.
  // Claude target falls through to the 503 below — no safe local approximation exists for it.
  if (activeTarget === 'codex') {
    if (gateCandidates) gateLog(null, 'protocol_fallback');
    routeLog('protocol_fallback');
    const fallbackRaw = buildCodexFallback();
    return res.status(200).json({
      enriched: sanitize(fallbackRaw, codexSlug, 'CODEX'),
      model: 'deterministic-fallback',
      fallbackReason: lastGoogleError,
      sessionId,
      ...(planSummary ? { plan: planSummary } : {}),
      ...(contentSummary ? { content: contentSummary } : {}),
    });
  }

  // Claude target or unknown — 503 unchanged
  if (gateCandidates) gateLog(null, 'error_503');
  routeLog('error_503');
  await logToAxiom({ endpoint: 'enrich', status: 503, reason: 'google_api_error', userId, ip: req.headers['x-forwarded-for'] || null, ...(gateId ? { gateId } : {}) });
  return res.status(503).json({
    error: 'GOOGLE_API_ERROR',
    message: `Enrichment failed. Details: ${lastGoogleError}`
  });
};
