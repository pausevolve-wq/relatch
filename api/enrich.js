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

  const skillName = fileName
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  const prompt = `Extract behavioral patterns from this content and write a Claude skill file.
Focus on: ${focus}

RULES:
- Extract PATTERNS and WHY behind decisions.
- NEVER copy-paste raw lines.
- You MUST start your response exactly with the YAML block below — no code fences, no backticks, no preamble.
- You MUST enclose all YAML values in double quotes.
- The "name" field MUST be exactly: "${skillName}"

FORMAT:
---
name: "${skillName}"
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

  function sanitize(raw, skillName) {
    let text = raw;
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF\u200B-\u200D\u2060]/g, '');
    text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
    const yamlStart = text.indexOf('---');
    if (yamlStart > 0) text = text.slice(yamlStart);
    if (!text.startsWith('---')) text = '---\n' + text;
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
      fm = fm.replace(/^(name|domain|content_type):\s*(?!")(.+)$/gm, (_, key, val) => `${key}: "${val.trim()}"`);
      text = `---\n${fm.trim()}\n---` + text.slice(fmMatch[0].length);
    }
    const requiredSections = [
      '## Identity & Role', '## Core Principles', '## How to Think',
      '## How to Create', '## What to Always Do', '## What to Never Do',
      '## Voice & Language', '## Quality Bar',
    ];
    for (const section of requiredSections) {
      if (!text.includes(section)) text += `\n\n${section}\n[Not extracted — review source content]`;
    }
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 900,
            temperature: 0.3
          }
        })
      }
    );

    if (!response.ok) {
      throw new Error(`API Error ${response.status}`);
    }

    const data = await response.json();
    const rawResult = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (rawResult.length < 150 || !rawResult.includes('## Identity')) {
      throw new Error('Incomplete model response');
    }

    return res.status(200).json({
      enriched: sanitize(rawResult, skillName),
      model: "gemini-1.5-flash"
    });

  } catch (err) {
    return res.status(503).json({ 
      error: 'FAILED', 
      message: 'Service temporarily unavailable. Please try again.' 
    });
  }
};
