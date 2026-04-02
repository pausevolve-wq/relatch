module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rawText, category, fileName } = req.body;
  if (!rawText || !category || !fileName) return res.status(400).json({ error: 'Missing required fields' });
  if (rawText.length > 12000) return res.status(400).json({ error: 'Content too large' });

  const hasEnoughLength = rawText.trim().length > 150;
  const hasRealWords = /[a-zA-Z]{3,}/.test(rawText);
  const isRepetitiveNoise = (() => {
    const words = rawText.trim().split(/\s+/).slice(0, 50);
    const unique = new Set(words.map(w => w.toLowerCase()));
    return words.length > 10 && unique.size < words.length * 0.3;
  })();

  if (!hasEnoughLength || !hasRealWords || isRepetitiveNoise) {
    return res.status(422).json({
      error: 'INSUFFICIENT_SIGNAL',
      message: 'Not enough content to generate a skill file.',
    });
  }

  const allLines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const signalLines = allLines.filter(line =>
    line.length > 20 && (
      /\d/.test(line) ||
      /\b(always|never|use|create|build|write|make|avoid|ensure|must|should|start|end|keep|focus|lead|design|follow|apply|open|close|prefer|every|each)\b/i.test(line) ||
      line.includes(':') ||
      /^[-•*#>]/.test(line) ||
      /^(\d+[.)]\s|#{1,3}\s)/.test(line) ||
      line.endsWith('.') || line.endsWith('!') || line.endsWith('?')
    )
  );

  const filteredText = signalLines.length >= 5 ? signalLines.join('\n') : rawText;
  const textToSend = filteredText.slice(0, signalLines.length >= 5 ? 2500 : 3500);

  const categoryContext = {
    personality: 'communication style, tone, voice patterns',
    instructions: 'rules, constraints, decision criteria',
    knowledge: 'domain expertise, mental models, frameworks',
    examples: 'structure, style, what makes them work',
    context: 'the situation, constraints, goals, audience',
    preferences: 'specific choices, standards, non-negotiables',
  };

  const focus = categoryContext[category] || categoryContext.knowledge;

  const prompt = `Extract highly specific behavioral patterns from this content and write a Claude skill file. Focus on: ${focus}.

STRICT PROTOCOL:
1. NO YAPPING. Start immediately with "---"
2. Extract EXACT tactics, phrases, and specific rules from the content. Do not use generic summaries.
3. Keep sections deeply informative but limit to 2 or 3 sentences or bullets per section.

FORMAT:
---
domain: "detected domain"
content_type: "behavioral skill"
use_cases: ["case 1", "case 2"]
---

## Identity & Role
[2 specific sentences defining the exact role and persona.]

## Core Principles
[3 detailed bullet points extracting specific core beliefs from the text.]

## How to Think
[2 sentences on the exact mental models used in the text.]

## How to Create
[Specific instructions on structure, length, and format based on the text.]

## What to Always Do
[3 to 4 specific action items extracted directly from the text. Start with verbs.]

## What to Never Do
[3 to 4 specific things to avoid based on the text. Start with "Never".]

## Voice & Language
[Specify the exact tone, pacing, and vocabulary used in the text.]

## Quality Bar
[2 specific standards for how to judge the final output.]

CONTENT TO ANALYZE:
${textToSend}`;
  
  try {
    const models = [
      'google/gemma-3-4b:free',
      'openrouter/free'
    ];

    const controllers = models.map(() => new AbortController());
    
    const masterTimer = setTimeout(() => {
      controllers.forEach(c => c.abort());
    }, 8500);

    const requests = models.map(async (model, index) => {
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://relatch-fe.vercel.app',
            'X-Title': 'Relatch',
          },
          body: JSON.stringify({
            model: model, 
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 900,
            temperature: 0.3,
          }),
          signal: controllers[index].signal,
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const enriched = data.choices?.[0]?.message?.content?.trim() || '';
        
        if (enriched.length < 100 || !enriched.includes('## Identity') || !enriched.includes('---')) {
          throw new Error('Bad formatting hallucination');
        }

        controllers.forEach((c, i) => {
          if (i !== index) c.abort();
        });

        return { enriched, model: data.model || model };
      } catch (err) {
        throw err; 
      }
    });

    const winner = await Promise.any(requests);
    clearTimeout(masterTimer);

    return res.status(200).json(winner);

  } catch (err) {
    return res.status(503).json({ error: 'TIMEOUT_OR_FAILED', message: 'Trigger frontend fallback' });
  }
};
