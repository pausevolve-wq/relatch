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
    personality: 'communication style, tone, voice patterns, how they phrase things, what they emphasize',
    instructions: 'rules, constraints, decision criteria, what to always do, what to never do',
    knowledge: 'domain expertise, mental models, frameworks they use, how they think about problems',
    examples: 'the patterns in these examples — structure, style, what makes them work',
    context: 'the situation, constraints, goals, audience, and environment that shapes decisions',
    preferences: 'specific choices, standards, non-negotiables, defaults, and pet peeves',
  };

  const focus = categoryContext[category] || categoryContext.knowledge;

  const prompt = `Extract behavioral patterns from this content and write a Claude skill file.
Focus on: ${focus}

RULES:
- Extract PATTERNS and WHY behind decisions.
- NEVER copy-paste raw lines.
- You MUST start your response exactly with the YAML block below.
- You MUST enclose all YAML values in double quotes.

FORMAT:
---
domain: "detected domain"
content_type: "behavioral skill"
use_cases: ["case 1", "case 2"]
---

## Identity & Role
[2 sentences. Who Claude becomes. Specific.]

## Core Principles
[4-5 fundamental beliefs extracted from content. Not rules but beliefs.]

## How to Think
[The mental process and reasoning pattern extracted from content.]

## How to Create
[Specific craft instructions. Structure, format, style, vocabulary.]

## What to Always Do
[5 specific behaviors. Start each with a verb.]

## What to Never Do
[4 things clearly avoided. Start each with "Never".]

## Voice & Language
[Specific words, phrases, sentence patterns. Signature moves.]

## Quality Bar
[How to know when output is done right.]

CONTENT:
${textToSend}`;

  try {
    // We fire 5 separate requests at the exact same time
    const models = [
      'arcee-ai/trinity-mini:free',
      'meta-llama/llama-3.2-3b-instruct:free',
      'google/gemma-3-4b:free',
      'google/gemma-3-12b-it:free',
      'openrouter/free' // Nuclear fallback
    ];

    // Create a kill switch for each individual request
    const controllers = models.map(() => new AbortController());
    
    // Give the entire race 8.5 seconds before Vercel kills the function
    const masterTimer = setTimeout(() => {
      controllers.forEach(c => c.abort());
    }, 8500);

    // Map over our models and create 5 simultaneous fetch requests
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
            model: model, // Requesting ONE specific model per connection
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 900,
            temperature: 0.4,
          }),
          signal: controllers[index].signal,
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const enriched = data.choices?.[0]?.message?.content?.trim() || '';
        
        if (enriched.length < 150 || !enriched.includes('## Identity')) {
          throw new Error('Bad formatting');
        }

        // WE HAVE A WINNER! Kill all other ongoing requests to save resources.
        controllers.forEach((c, i) => {
          if (i !== index) c.abort();
        });

        return { enriched, model: data.model || model };
      } catch (err) {
        // If this specific model fails or gets a 503, ignore it and let the others keep racing
        throw err; 
      }
    });

    // Promise.any waits for the FIRST successful request and ignores the failures
    const winner = await Promise.any(requests);
    clearTimeout(masterTimer);

    return res.status(200).json(winner);

  } catch (err) {
    // If ALL 5 models fail or timeout, then we finally return a 503
    return res.status(503).json({ error: 'TIMEOUT_OR_FAILED', message: 'All models failed or timed out' });
  }
};
