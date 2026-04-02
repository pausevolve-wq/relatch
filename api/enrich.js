module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rawText, category, fileName } = req.body;
  if (!rawText || !category || !fileName) return res.status(400).json({ error: 'Missing required fields' });
  if (rawText.length > 12000) return res.status(400).json({ error: 'Content too large' });

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
  const textToSend = filteredText.slice(0, 2200);

  const categoryContext = {
    personality: 'communication style, tone, voice patterns',
    instructions: 'rules, constraints, decision criteria',
    knowledge: 'domain expertise, mental models, frameworks',
    examples: 'structure, style, what makes them work',
    context: 'the situation, constraints, goals, audience',
    preferences: 'specific choices, standards, non-negotiables',
  };

  const focus = categoryContext[category] || categoryContext.knowledge;

  const prompt = `Extract behavioral patterns and write a Claude skill file. Focus on: ${focus}.
STRICT PROTOCOL: Start with "---". No yapping. Max 2 short sentences per section.

FORMAT:
---
domain: "detected domain"
content_type: "behavioral skill"
use_cases: ["case 1", "case 2"]
---

## Identity & Role
[Specific role, max 2 sentences]

## Core Principles
[3 exact principles from text]

## How to Think
[Core mental model, max 2 sentences]

## How to Create
[Exact rules for formatting, max 2 sentences]

## What to Always Do
[3 action verbs]

## What to Never Do
[3 avoided actions]

## Voice & Language
[Tone and style descriptors]

## Quality Bar
[Strict metric for success]

CONTENT:
${textToSend}`;

  // Total worst-case budget: 4s + 4.5s = 8.5s — safely under Vercel's 10s limit
  // PRIMARY:  gemma-3-4b       — fast model, 4s is generous, bail early if hanging
  // FALLBACK: step-3.5-flash   — confirmed active in OR logs, gets remaining 4.5s
  const MODELS = [
    { id: 'google/gemma-3-4b:free',      timeoutMs: 4000 },
    { id: 'stepfun/step-3.5-flash:free', timeoutMs: 4500 },
  ];

  function withTimeout(promise, ms, label) {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms)
    );
    return Promise.race([promise, timeout]);
  }

  async function callModel(id) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://relatch-fe.vercel.app',
        'X-Title': 'Relatch',
      },
      body: JSON.stringify({
        model: id,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 900,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errBody.slice(0, 120)}`);
    }

    const data = await response.json();
    const enriched = data.choices?.[0]?.message?.content?.trim() || '';

    if (enriched.length < 100 || !enriched.includes('## Identity') || !enriched.includes('---')) {
      throw new Error(`format-invalid(len=${enriched.length})`);
    }

    return { enriched, model: data.model || id };
  }

  const errors = [];
  for (const { id, timeoutMs } of MODELS) {
    try {
      const result = await withTimeout(callModel(id), timeoutMs, id);
      return res.status(200).json(result);
    } catch (err) {
      console.error(`[enrich] ${id} failed: ${err.message}`);
      errors.push(`${id}: ${err.message}`);
    }
  }

  console.error('[enrich] all models failed', errors);
  return res.status(503).json({
    error: 'FAILED',
    message: 'All models failed or timed out',
    debug: errors, // remove before going public
  });
};
