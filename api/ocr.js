const { verifyToken, createClerkClient } = require('@clerk/backend');
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.relatch.online');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    await logToAxiom({ endpoint: 'ocr', status: 401, reason: 'missing_bearer', ip: req.headers['x-forwarded-for'] || null });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  let userId;
  try {
    const payload = await verifyToken(authHeader.slice(7), { secretKey: process.env.CLERK_SECRET_KEY });
    userId = payload.sub;
    if (!userId) throw new Error('No userId in token');
  } catch {
    await logToAxiom({ endpoint: 'ocr', status: 401, reason: 'invalid_session', ip: req.headers['x-forwarded-for'] || null });
    return res.status(401).json({ error: 'Invalid session' });
  }

  const { base64, mimeType, fileName } = req.body;

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

  const fileMime = mimeType || 'application/pdf';
  const mistralKey = process.env.MISTRALOCR_API_KEY;
  const datalabKey = process.env.DATALAB_API_KEY;
  const ocrSpaceKey = process.env.OCRCLD_API_KEY;

  const dataUri = base64.startsWith('data:') ? base64 : `data:${fileMime};base64,${base64}`;

  if (mistralKey) {
    // Mistral only being down is exactly the condition that sends traffic to Datalab below,
    // so a hang here (not just a fast error) would eat the time budget Datalab's poll loop
    // needs. Bound it explicitly instead of relying solely on Vercel's 60s function ceiling.
    // 35s (not a shorter number): Mistral's OCR endpoint is synchronous with no documented
    // server-side timeout, and no independently-observed per-page latency figure exists publicly
    // (their "2000 pages/min" figure is a GPU-cluster throughput claim, not measured single-request
    // latency for markdown+bbox generation). A too-short timeout here would misclassify a slow-but-
    // working Mistral call as "down" and route it to the paid Datalab tier unnecessarily — the
    // opposite of the "only when Mistral is actually down" intent. Duration is logged to Axiom below
    // on every outcome so this number can be tuned from real production data instead of guesswork.
    const mistralController = new AbortController();
    const mistralTimeout = setTimeout(() => mistralController.abort(), 35000);
    const mistralStartMs = Date.now();
    try {
      console.log(`[ocr] trying Mistral OCR for: ${fileName}`);

      const mistralResponse = await fetch("https://api.mistral.ai/v1/ocr", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${mistralKey}`
        },
        signal: mistralController.signal,
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
      });

      if (mistralResponse.ok) {
        const data = await mistralResponse.json();
        const text = data.pages.map(p => p.markdown).join("\n\n").trim();
        const mistralDurationMs = Date.now() - mistralStartMs;

        if (text.length > 50) {
          // Block extraction requires OCR 4+ (mistral-ocr-latest resolves there as of 2026-07-26);
          // older models silently accept include_blocks but return an empty array per page.
          const blocks = data.pages.map(p => ({ page: p.index, blocks: p.blocks || [] }));
          console.log(`[ocr] Mistral success: ${text.length} chars from ${fileName} in ${mistralDurationMs}ms`);
          // Real per-request latency, not published anywhere by Mistral — logged so the 35s
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
    } finally {
      clearTimeout(mistralTimeout);
    }
  }

  const DATALAB_DAILY_LIMIT = 3;
  let datalabAllowed = true;

  if (datalabKey) {
    try {
      const quotaUser = await clerkClient.users.getUser(userId);
      const todayKey = new Date().toISOString().slice(0, 10);
      const stored = quotaUser.privateMetadata?.relatchOcrUsage ?? {};
      const dailyCount = stored.lastDayKey === todayKey ? (stored.dailyCount ?? 0) : 0;

      if (dailyCount >= DATALAB_DAILY_LIMIT) {
        datalabAllowed = false;
        console.log(`[ocr] Datalab daily cap reached for user ${userId} (${dailyCount}/${DATALAB_DAILY_LIMIT})`);
        await logToAxiom({ endpoint: 'ocr', status: 200, reason: 'datalab_quota_skipped', fileName, userId, ip: req.headers['x-forwarded-for'] || null });
      }
    } catch (err) {
      // Fail closed on the quota read itself — skip the paid tier rather than risk an
      // uncapped call, same posture as enrich.js's Clerk-read fail-closed quota gate.
      datalabAllowed = false;
      console.log('[ocr] Datalab quota check failed, skipping paid tier:', err?.message || 'unknown');
    }
  }

  if (datalabKey && datalabAllowed) {
    try {
      console.log(`[ocr] trying Datalab OCR fallback for: ${fileName}`);

      const rawBase64 = dataUri.includes(',') ? dataUri.slice(dataUri.indexOf(',') + 1) : dataUri;
      const fileBuffer = Buffer.from(rawBase64, 'base64');
      const form = new FormData();
      form.append('file', new Blob([fileBuffer], { type: fileMime }), fileName);
      form.append('output_format', 'markdown');
      form.append('mode', 'balanced'); // same $4/1000-page rate as 'fast', better quality — no reason to use 'fast'
      form.append('max_pages', '40'); // bounds worst-case single-request cost regardless of the inbound 3MB size cap above

      const submitResponse = await fetch('https://www.datalab.to/api/v1/convert', {
        method: 'POST',
        headers: { 'X-Api-Key': datalabKey },
        body: form,
      });

      if (submitResponse.ok) {
        const submitData = await submitResponse.json();
        const checkUrl = submitData.request_check_url;

        let result = null;
        if (checkUrl) {
          // Expected processing time for a 40-page doc at Datalab's stated ~3-4 pages/sec is
          // ~10-13s, so 20s leaves real margin. Kept shorter than Mistral's 35s above (rather
          // than symmetric) because the two stack: worst case is Mistral times out AND Datalab
          // times out, and OCR.space still needs a real window afterward, all inside Vercel's
          // 60s function ceiling (35 + 20 = 55s, leaving ~5s for OCR.space + response).
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const pollResponse = await fetch(checkUrl, { headers: { 'X-Api-Key': datalabKey } });
            if (!pollResponse.ok) break;
            const pollData = await pollResponse.json();
            if (pollData.status === 'complete') { result = pollData; break; }
            if (pollData.status === 'failed') break;
          }
        }

        if (result) {
          // Datalab bills per page once a job reaches 'complete', independent of whether the
          // extracted text clears our own length gate below — record the spend here, not
          // after the quality check, so the daily counter reflects what was actually billed.
          try {
            const quotaUser = await clerkClient.users.getUser(userId);
            const todayKey = new Date().toISOString().slice(0, 10);
            const stored = quotaUser.privateMetadata?.relatchOcrUsage ?? {};
            const dailyCount = stored.lastDayKey === todayKey ? (stored.dailyCount ?? 0) : 0;
            await clerkClient.users.updateUserMetadata(userId, {
              privateMetadata: { relatchOcrUsage: { dailyCount: dailyCount + 1, lastDayKey: todayKey } },
            });
          } catch (err) {
            console.log('[ocr] Datalab quota write failed:', err?.message || 'unknown');
          }

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

  if (ocrSpaceKey) {
    try {
      console.log(`[ocr] trying OCR.space fallback for: ${fileName}`);

      const formData = new URLSearchParams();
      formData.append('base64Image', dataUri);
      formData.append('language', 'eng');
      formData.append('isOverlayRequired', 'false');
      formData.append('detectOrientation', 'true');
      formData.append('scale', 'true');
      formData.append('OCREngine', '2'); 
      formData.append('isCreateSearchablePdf', 'true');
      formData.append('isSearchablePdfHideTextLayer', 'true'); 

      const response = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: {
          'apikey': ocrSpaceKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString()
      });

      if (response.ok) {
        const data = await response.json();
        if (!data.IsErroredOnProcessing) {
          const text = data.ParsedResults?.map(r => r.ParsedText || '').join('\n').trim() || '';
          const searchablePdfUrl = data.SearchablePDFURL || null;
          
          if (text.length > 50) {
            console.log(`[ocr] OCR.space success: ${text.length} chars from ${fileName}`);
            return res.status(200).json({ 
              text, 
              source: 'ocr.space',
              searchablePdfUrl
            });
          }
        }
      } else {
        console.log(`[ocr] OCR.space HTTP ${response.status}`);
      }
    } catch (err) {
      console.log(`[ocr] OCR.space threw: ${err.message || 'unknown'}`);
    }
  }

  console.log(`[ocr] all OCR methods failed for: ${fileName}`);
  await logToAxiom({ endpoint: 'ocr', status: 422, reason: 'ocr_failed', fileName, ip: req.headers['x-forwarded-for'] || null });
  return res.status(422).json({
    error: 'OCR_FAILED',
    message: 'Could not extract text from this document. It may be image-based, encrypted, or corrupted.',
  });
};
