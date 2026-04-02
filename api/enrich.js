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

  const prompt = `Extract specific tactics from this content for a Claude skill file. Focus on: ${focus}.

CRITICAL RULES:
1. Start exactly with "---"
2. NO complete sentences. Use fragments and exact keywords only.
3. Maximum 10 words per section. Be hyper-dense to save generation time.

FORMAT:
---
domain: "detected domain"
content_type: "behavioral skill"
use_cases: ["case 1", "case 2"]
---

## Identity & Role
[Specific persona, max 10 words]

## Core Principles
[3 exact concept keywords]

## How to Think
[Core mental model, max 10 words]

## How to Create
[Exact formatting rules, max 10 words]

## What to Always Do
[3 specific action verbs]

## What to Never Do
[3 specific avoided actions]

## Voice & Language
[Exact tone words]

## Quality Bar
[Strict success metric, max 10 words]

CONTENT:
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
