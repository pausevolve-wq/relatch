module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rawText, category, fileName } = req.body;
  if (!rawText || !category || !fileName) return res.status(400).json({ error: 'Missing required fields' });
  if (rawText.length > 12000) return res.status(400).json({ error: 'Content too large' });

  // ── INPUT QUALITY CHECK ───────────────────────────────────────────
  const hasEnoughLength = rawText.trim().length > 150;
  const hasRealWords = /[a-zA-Z]{3,}/.test(rawText);
  const isRepetitiveNoise = (() => {
    const words = rawText.trim().split(/\s+/).slice(0, 50);
    const unique = new Set(words.map(w => w.toLowerCase()));
    return words.length > 10 && unique.size < words.length * 0.3;
  })();

  if (!hasEnoughLength || !hasRealWords || isRepetitiveNoise) {
    console.log(`[enrich] INSUFFICIENT_SIGNAL for ${fileName}: len=${rawText.trim().length} words=${hasRealWords} noise=${isRepetitiveNoise}`);
    return res.status(422).json({
      error: 'INSUFFICIENT_SIGNAL',
      message: 'Not enough content to generate a skill file. The document may be image-based, too short, or corrupted.',
    });
  }

  // ── SIGNAL EXTRACTION ────────────────────────────────────────────
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
  const textToSend = filteredText.slice(0, signalLines.length >= 5 ? 5000 : 7000);
  console.log(`[enrich] signal: ${allLines.length} lines → ${signalLines.length} signal → ${textToSend.length} chars`);

  const categoryContext = {
    personality: 'communication style, tone, voice patterns, how they phrase things, what they emphasize, their relationship with their audience',
    instructions: 'rules, constraints, decision criteria, what to always do, what to never do, how to handle edge cases',
    knowledge: 'domain expertise, mental models, frameworks they use, how they think about problems in this field',
    examples: 'the patterns in these examples — structure, style, what makes them work, the formula behind them',
    context: 'the situation, constraints, goals, audience, and environment that shapes all decisions here',
    preferences: 'specific choices, standards, non-negotiables, defaults, and pet peeves that define their work',
  };

  const focus = categoryContext[category] || categoryContext.knowledge;

  const prompt = `You are an expert at extracting working style, mental models, and behavioral DNA from raw content.

Your job: Read the content below like an anthropologist studying how this person thinks and works. Then write a Claude skill file that lets Claude BECOME this person's thinking partner — not just reference their content, but actually reason, create, and decide the way they do.

The skill file must be immediately useful WITHOUT the original document. Claude should be able to use this skill file alone and produce work in this person's exact style and thinking pattern.

Focus specifically on: ${focus}

EXTRACTION RULES:
- Find the PATTERNS, not just the content
- Extract the WHY behind decisions, not just the WHAT
- Identify what this person would NEVER do (boundaries reveal character)
- Find repeating structures, formulas, and frameworks they use
- Extract specific language, phrases, and vocabulary they favor
- Turn observations into ACTIONABLE INSTRUCTIONS for Claude
- Do NOT summarize the content — extract the behavior

OUTPUT FORMAT — return exactly this markdown, no preamble, no explanation, no code fences:

---
domain: [detected domain]
content_type: [detected type]
use_cases: [2-4 specific use cases this skill enables]
---

## Identity & Role
[Who Claude becomes when using this skill. 2-3 sentences. Specific, not generic.]

## Core Principles
[4-6 fundamental beliefs or values extracted from the content that drive ALL decisions. Not rules — beliefs. What this person would defend in an argument.]

## How to Think
[The mental process. How to approach problems. What to consider first, second, third. The reasoning pattern extracted from the content.]

## How to Create
[Specific craft instructions. Structure, format, style, length, vocabulary. Concrete enough that two people following this produce similar outputs.]

## What to Always Do
[5-8 specific, non-negotiable behaviors extracted from patterns in the content. Start each with a verb.]

## What to Never Do
[4-6 things this person clearly avoids, finds wrong, or would reject. Start each with "Never".]

## Voice & Language
[Specific words, phrases, sentence patterns they use. How they open, transition, close. Their signature moves.]

## Quality Bar
[How to know when the output is good enough. What "done right" looks like in this domain.]

RAW CONTENT TO ANALYZE:
${textToSend}`;

  // IMPORTANT: Vercel Hobby plan hard caps serverless functions at 10 seconds.
  // Previous timeouts (18-28s) caused every request to hit the Vercel limit
  // and return a 504/404 before any model could respond.
  // Each model now gets a fast 7s window. Total cascade stays under 9s.
  const cascade = [
    { model: 'meta-llama/llama-3.3-70b-instruct:free', timeout: 7000 },
    { model: 'qwen/qwen3-next-80b-a3b-instruct:free', timeout: 7000 },
    { model: 'arcee-ai/trinity-large-preview:free', timeout: 7000 },
    { model: 'mistralai/mistral-small-3.1-24b-instruct:free', timeout: 6000 },
    { model: 'openrouter/free', timeout: 6000 },
  ];

  for (const { model, timeout } of cascade) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      console.log(`[enrich] trying: ${model}`);

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://relatch-fe.vercel.app',
          'X-Title': 'Relatch',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1200,
          temperature: 0.4,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.status === 429 || response.status === 503) {
        console.log(`[enrich] ${model} rate limited (${response.status})`);
        continue;
      }
      if (!response.ok) {
        console.log(`[enrich] ${model} failed status ${response.status}`);
        continue;
      }

      const data = await response.json();
      const enriched = data.choices?.[0]?.message?.content?.trim() || '';

      if (enriched.length < 150) {
        console.log(`[enrich] ${model} too short (${enriched.length} chars)`);
        continue;
      }

      // Low-confidence detection: reject if missing core sections
      const hasCoreStructure = enriched.includes('## Identity') || enriched.includes('## Core Principles');
      if (!hasCoreStructure) {
        console.log(`[enrich] ${model} missing core sections, trying next`);
        continue;
      }

      // Reject if model returned INSUFFICIENT_SIGNAL instead of a skill file
      if (enriched.trim().startsWith('INSUFFICIENT_SIGNAL') || enriched.trim() === 'INSUFFICIENT_SIGNAL') {
        console.log(`[enrich] ${model} signalled insufficient input`);
        continue;
      }

      console.log(`[enrich] success: ${model} (${enriched.length} chars)`);
      return res.status(200).json({ enriched, model });

    } catch (err) {
      console.log(`[enrich] ${model} threw: ${err?.message || 'unknown'}`);
      continue;
    }
  }

  console.log('[enrich] all models failed — returning AI_FAILED');
  return res.status(503).json({
    error: 'AI_FAILED',
    message: 'Could not generate skill from this content. All AI models are unavailable or the content signal is too weak.',
  });
};
