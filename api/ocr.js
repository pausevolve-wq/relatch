const { verifyToken } = require('@clerk/backend');
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
  try {
    await verifyToken(authHeader.slice(7), { secretKey: process.env.CLERK_SECRET_KEY });
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
  const ocrSpaceKey = process.env.OCRCLD_API_KEY;

  const dataUri = base64.startsWith('data:') ? base64 : `data:${fileMime};base64,${base64}`;

  if (mistralKey) {
    try {
      console.log(`[ocr] trying Mistral OCR for: ${fileName}`);
      
      const mistralResponse = await fetch("https://api.mistral.ai/v1/ocr", {
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
          }
        })
      });

      if (mistralResponse.ok) {
        const data = await mistralResponse.json();
        const text = data.pages.map(p => p.markdown).join("\n\n").trim();
        
        if (text.length > 50) {
          console.log(`[ocr] Mistral success: ${text.length} chars from ${fileName}`);
          return res.status(200).json({ text, source: 'mistral' });
        }
      } else {
        console.log(`[ocr] Mistral HTTP ${mistralResponse.status}`);
      }
    } catch (err) {
      console.log(`[ocr] Mistral threw: ${err.message || 'unknown'}`);
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
