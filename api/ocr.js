// /api/ocr.js — OCR pipeline for Relatch
// Called by frontend when pdfjs extracts < 50 chars (scanned/image-based PDFs)
// Strategy: OCR.space (primary, fast, base64 direct) → Filestack (secondary, upload+OCR)
// Both fit within Vercel Hobby 10s limit

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { base64, mimeType, fileName } = req.body;

  if (!base64 || !fileName) {
    return res.status(400).json({ error: 'Missing required fields: base64, fileName' });
  }

  // Reject if payload is too large (Vercel body limit is 4.5MB)
  const estimatedBytes = base64.length * 0.75;
  if (estimatedBytes > 4000000) {
    return res.status(413).json({ error: 'File too large for OCR. Maximum size is ~4MB.' });
  }

  const fileMime = mimeType || 'application/pdf';
  const ocrKey = process.env.OCRCLD_API_KEY;
  const filestackKey = process.env.FILESTACK_API_KEY;

  // ── PRIMARY: OCR.space ─────────────────────────────────────────────
  // Accepts base64 directly, fast, no upload step needed
  if (ocrKey) {
    try {
      console.log(`[ocr] trying OCR.space for: ${fileName}`);

      const formData = new URLSearchParams();
      formData.append('base64Image', `data:${fileMime};base64,${base64}`);
      formData.append('language', 'eng');
      formData.append('isOverlayRequired', 'false');
      formData.append('detectOrientation', 'true');
      formData.append('scale', 'true');
      formData.append('OCREngine', '2'); // Engine 2 is better for printed text + PDFs

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      const response = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: {
          'apikey': ocrKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.ok) {
        const data = await response.json();

        if (data.IsErroredOnProcessing) {
          console.log(`[ocr] OCR.space error: ${data.ErrorMessage?.[0]}`);
        } else {
          const text = data.ParsedResults
            ?.map(r => r.ParsedText || '')
            .join('\n')
            .trim() || '';

          if (text.length > 50) {
            console.log(`[ocr] OCR.space success: ${text.length} chars from ${fileName}`);
            return res.status(200).json({ text, source: 'ocr.space' });
          } else {
            console.log(`[ocr] OCR.space returned too little text (${text.length} chars)`);
          }
        }
      } else {
        console.log(`[ocr] OCR.space HTTP ${response.status}`);
      }
    } catch (err) {
      console.log(`[ocr] OCR.space threw: ${err?.message || 'unknown'}`);
    }
  } else {
    console.log('[ocr] OCRCLD_API_KEY not set, skipping OCR.space');
  }

  // ── SECONDARY: Filestack ───────────────────────────────────────────
  // Two-step: upload base64 → get handle → call OCR on handle
  if (filestackKey) {
    try {
      console.log(`[ocr] trying Filestack for: ${fileName}`);

      // Step 1: Upload the base64 file to Filestack
      const uploadController = new AbortController();
      const uploadTimer = setTimeout(() => uploadController.abort(), 5000);

      const uploadResponse = await fetch(
        `https://www.filestackapi.com/api/store/S3?key=${filestackKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': fileMime },
          body: Buffer.from(base64, 'base64'),
          signal: uploadController.signal,
        }
      );

      clearTimeout(uploadTimer);

      if (!uploadResponse.ok) {
        console.log(`[ocr] Filestack upload failed: HTTP ${uploadResponse.status}`);
      } else {
        const uploadData = await uploadResponse.json();
        const handle = uploadData.handle;

        if (!handle) {
          console.log('[ocr] Filestack upload returned no handle');
        } else {
          // Step 2: Run OCR on the uploaded handle
          const ocrController = new AbortController();
          const ocrTimer = setTimeout(() => ocrController.abort(), 4000);

          const ocrResponse = await fetch(
            `https://cdn.filestackcontent.com/OCR/${handle}`,
            {
              headers: { 'Filestack-api-key': filestackKey },
              signal: ocrController.signal,
            }
          );

          clearTimeout(ocrTimer);

          if (ocrResponse.ok) {
            const ocrData = await ocrResponse.json();
            // Filestack returns text_areas with lines
            const text = ocrData?.document?.text_areas
              ?.flatMap(area => area.lines?.map(l => l.text) || [])
              .join('\n')
              .trim() || '';

            if (text.length > 50) {
              console.log(`[ocr] Filestack success: ${text.length} chars from ${fileName}`);
              return res.status(200).json({ text, source: 'filestack' });
            } else {
              console.log(`[ocr] Filestack returned too little text (${text.length} chars)`);
            }
          } else {
            console.log(`[ocr] Filestack OCR failed: HTTP ${ocrResponse.status}`);
          }
        }
      }
    } catch (err) {
      console.log(`[ocr] Filestack threw: ${err?.message || 'unknown'}`);
    }
  } else {
    console.log('[ocr] FILESTACK_API_KEY not set, skipping Filestack');
  }

  // Both failed
  console.log(`[ocr] all OCR methods failed for: ${fileName}`);
  return res.status(422).json({
    error: 'OCR_FAILED',
    message: 'Could not extract text from this document. It may be image-based, encrypted, or corrupted.',
  });
};
