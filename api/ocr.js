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

  const estimatedBytes = base64.length * 0.75;
  if (estimatedBytes > 4000000) {
    return res.status(413).json({ error: 'File too large for OCR. Maximum size is ~4MB.' });
  }

  const fileMime = mimeType || 'application/pdf';
  const mistralKey = process.env.MISTRALOCR_API_KEY;
  const ocrSpaceKey = process.env.OCRCLD_API_KEY;

  const dataUri = base64.startsWith('data:') ? base64 : `data:${fileMime};base64,${base64}`;

  if (false && mistralKey) {
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
  return res.status(422).json({
    error: 'OCR_FAILED',
    message: 'Could not extract text from this document. It may be image-based, encrypted, or corrupted.',
  });
};
