module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
  return res.status(200).end();
}

if (req.method !== 'POST') {
  return res.status(405).json({ error: 'Method Not Allowed' });
}

  let body = {};

try {
  body = typeof req.body === 'string'
    ? JSON.parse(req.body || '{}')
    : (req.body || {});
} catch (e) {
  body = {};
}

const rawText = typeof body.rawText === 'string' ? body.rawText : '';
const category = body.category || '';
const fileName = body.fileName || '';
const domainLabel = body.domainLabel || '';
const domainRole = body.domainRole || '';
const domainFrame = body.domainFrame || '';
  if (!rawText || !category || !fileName) return res.status(400).json({ error: 'Missing required fields' });

  const processedText = rawText.length > 15000 ? rawText.slice(0, 15000) : rawText;

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
    examples: 'the patterns in these examples, structure, style, what makes them work',
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

  const safeDomainLabel = domainLabel || 'General';
  const safeDomainRole = domainRole || 'an expert';
  const safeDomainFrame = domainFrame || 'communicate effectively';

  const prompt = `You are a Persona Simulation Engine. Do not act like an AI summarizing a text. Instead, analyze the Tonal DNA of the provided content and generate a Claude Skill File that perfectly mimics the author's voice, constraints, and structural habits.
Focus on: ${focus}
Suggested Domain: ${safeDomainLabel}
Suggested Role: ${safeDomainRole}

RULES:
- Identify the actual domain of the text. If the text is clearly not about the Suggested Domain, you MUST ignore the suggestion and define the most accurate domain yourself.
- Extract Signature Moves (recurring phrases, punctuation habits, structural patterns).
- NEVER copy-paste raw lines. Synthesize the core behavioral patterns.
- You MUST start your response exactly with the YAML block below, no code fences, no backticks, no preamble.
- You MUST enclose all YAML values in double quotes.
- The "name" field MUST be exactly: "${skillName}"
- The "domain" field MUST be exactly: "${safeDomainLabel}"

FORMAT:
---
name: "${skillName}"
domain: "${safeDomainLabel}"
content_type: "behavioral skill"
use_cases: ["case 1", "case 2"]
---

## Identity & Role
[2 sentences. Who Claude becomes. Use the tone of the original author. Be highly specific.]

## Core Principles
[4 to 5 fundamental beliefs extracted from the text. Write these as if the author is speaking.]

## How to Think
[The specific mental process, reasoning pattern, and constraints extracted from the text.]

## How to Create
[Specific craft instructions. Detail the structure, format, length constraints, and vocabulary.]

## What to Always Do
[5 specific behaviors. Start each with an action verb.]

## What to Never Do
[4 things clearly avoided in the text. Start each with "Never".]

## Voice & Language
[Detail the exact signature moves. Include specific words, phrases, tone, and formatting quirks like avoiding certain punctuation.]

## Quality Bar
[How to know when output is done right and matches the author's DNA.]

CONTENT:
${processedText}`;

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
      if (!text.includes(section)) text += `\n\n${section}\n[Not extracted - review source content]`;
    }
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

function detectComplexity(text) {
  const length = text.length;
  const tokens = Math.ceil(length / 4);

  if (tokens > 4000 || length > 15000) return 'heavy';
  if (tokens > 1500 || length > 6000) return 'medium';
  return 'light';
}

const complexity = detectComplexity(textToSend);

const primaryModel =
  complexity === 'heavy'
    ? "gemini-2.5-flash"
    : "gemini-3.1-flash-lite-preview";

const fallbackModel =
  complexity === 'heavy'
    ? "gemini-3.1-flash-lite-preview"
    : "gemini-2.5-flash";
function isValidSkillOutput(text) {
  if (!text || text.length < 120) return false;

  const cleaned = String(text).trim();
  const hasYamlStart = cleaned.indexOf('---') >= 0 && cleaned.indexOf('---') < 40;
  const hasYamlBoundary = hasYamlStart && cleaned.indexOf('\n---', 3) !== -1;

  const requiredSections = [
    '## Identity & Role',
    '## Core Principles',
    '## How to Think',
    '## How to Create',
    '## What to Always Do',
    '## What to Never Do',
    '## Voice & Language',
    '## Quality Bar'
  ];

  const sectionCount = requiredSections.reduce((count, section) => (
    cleaned.includes(section) ? count + 1 : count
  ), 0);

  const requiredKeyPatterns = [
    /^\s*name\s*:/m,
    /^\s*domain\s*:/m,
    /^\s*content_type\s*:/m,
    /^\s*use_cases\s*:/m
  ];
  const requiredKeyCount = requiredKeyPatterns.reduce((count, pattern) => (
    pattern.test(cleaned) ? count + 1 : count
  ), 0);
  const hasMeaningfulContent = cleaned.length > 300;

  return hasYamlBoundary && requiredKeyCount >= 4 && sectionCount >= 4 && hasMeaningfulContent;
}
async function callModel(modelId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 900, temperature: 0.7 }
        }),
        signal: controller.signal
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

   if (text && isValidSkillOutput(sanitize(text, skillName))) {
  return { text, model: modelId };
}

return null;

  } catch (err) {
    clearTimeout(timeoutId);
    return null;
  }
}

let result = await callModel(primaryModel);

if (!result) {
  result = await callModel(fallbackModel);
}

if (result) {
  return res.status(200).json({
    enriched: sanitize(result.text, skillName),
    model: result.model
  });
} else {
  return res.status(503).json({
    error: 'GOOGLE_API_ERROR',
    message: 'Both primary and fallback models failed.'
  });
}
