module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // V2: destructure new fields from frontend (template, richFormats, charCap)
  // Old fields remain exactly the same — backward compatible if frontend hasn't updated yet
  const { rawText, category, fileName, domainLabel, domainRole, domainFrame, template, richFormats, charCap } = req.body;
  if (!rawText || !category || !fileName) return res.status(400).json({ error: 'Missing required fields' });

  const processedText = rawText.length > 15000 ? rawText.slice(0, 15000) : rawText;

  // UNCHANGED — exact same validation logic as before
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

  // UNCHANGED — exact same signal filter logic as before
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

  // V2: use charCap from profiler if provided, otherwise fall back to original logic
  const effectiveCharCap = charCap || (signalLines.length >= 5 ? 2500 : 3500);
  const textToSend = filteredText.slice(0, effectiveCharCap);

  // UNCHANGED — exact same category context as before
  const categoryContext = {
    personality: 'communication style, tone, voice patterns, how they phrase things, what they emphasize',
    instructions: 'rules, constraints, decision criteria, what to always do, what to never do',
    knowledge: 'domain expertise, mental models, frameworks they use, how they think about problems',
    examples: 'the patterns in these examples, structure, style, what makes them work',
    context: 'the situation, constraints, goals, audience, and environment that shapes decisions',
    preferences: 'specific choices, standards, non-negotiables, defaults, and pet peeves',
  };

  const focus = categoryContext[category] || categoryContext.knowledge;

  // UNCHANGED — exact same skillName derivation as before
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

  // V2: determine active template — default to 'A' if not provided (backward compatible)
  const activeTemplate = template || 'A';

  // ─────────────────────────────────────────────────────────────────────────────
  // V2: QUALITY SCORING FUNCTION
  // Replaces the old: candidateText.length > 150 && candidateText.includes('## Identity')
  // Now template-aware. Returns a score 0-9.
  // Flash Lite accepted at >= 6. Gemini 2.5 Flash accepted at >= 5.
  // ─────────────────────────────────────────────────────────────────────────────
  function scoreOutput(text, tmpl) {
    let score = 0;

    // +2: Length floor (hard requirement)
    const lengthFloor = { A: 600, B: 500, C: 500, D: 700 };
    if (text.length >= (lengthFloor[tmpl] || 600)) score += 2;

    // +2: Required sections present (hard requirement)
    const requiredSections = {
      A: ['## Identity & Role', '## Voice & Language'],
      B: ['## Role & Capability', '## Example Patterns'],
      C: ['## Domain Role', '## Decision Process'],
      D: ['## Domain Role', '## Decision Framework'],
    };
    const required = requiredSections[tmpl] || requiredSections.A;
    if (required.every(s => text.includes(s))) score += 2;

    // +2: No placeholder text (hard requirement)
    const hasPlaceholder =
      text.includes('[Not extracted') ||
      text.includes('[review source') ||
      text.includes('to be added');
    if (!hasPlaceholder) score += 2;

    // +1: Section depth — every ## section has at least 2 non-empty lines
    const sections = text.split(/^## /m).filter(s => s.trim().length > 0);
    const thinSections = sections.filter(s => {
      const lines = s.split('\n').filter(l => l.trim().length > 10);
      return lines.length < 2;
    });
    if (thinSections.length <= 2) score += 1;

    // +1: Low generic phrase count
    const genericPhrases = [
      'write clean code', 'be professional', 'consider all options',
      'make informed decisions', 'think carefully', 'best practices',
      'high quality output', 'communicate effectively',
    ];
    const genericCount = genericPhrases.filter(p => text.toLowerCase().includes(p)).length;
    if (genericCount <= 3) score += 1;

    // +1: Rich format present (soft check, template-aware)
    if (tmpl === 'D' || tmpl === 'C') {
      if (text.includes('|')) score += 1;
    } else if (tmpl === 'B') {
      if (text.includes('```')) score += 1;
    } else {
      // Template A — no rich format requirement, award the point freely
      score += 1;
    }

    return score;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // V2: FOUR PROMPT TEMPLATES
  // Template A — Persona & Voice (original prompt + enhanced format rules)
  // Template B — Code & Technical
  // Template C — Process & Workflow
  // Template D — Professional Domain
  // ─────────────────────────────────────────────────────────────────────────────

  let prompt;

  if (activeTemplate === 'B') {
    // ── TEMPLATE B: Code & Technical ──────────────────────────────────────────
    prompt = `You are a Code Pattern Extraction Engine. Analyze the provided code or technical content and extract the developer's patterns, conventions, and architectural decisions into a Claude Skill File. Do not summarize — extract the actual behavioral DNA of how this developer writes code.
Focus on: ${focus}
Domain: Software Engineering
Role: ${safeDomainRole}

RULES:
- Extract ACTUAL patterns visible in the code — never invent patterns not present in source.
- Identify naming conventions, async style, error handling approach, file structure habits.
- NEVER copy-paste raw code lines — identify the PATTERN they represent.
- You MUST start your response exactly with the YAML block below, no code fences, no backticks, no preamble.
- You MUST enclose all YAML values in double quotes.
- The "name" field MUST be exactly: "${skillName}"
- The "domain" field MUST be exactly: "software engineering"

FORMAT:
---
name: "${skillName}"
domain: "software engineering"
content_type: "behavioral skill"
use_cases: ["code generation", "code review", "technical writing"]
---

## Role & Capability
[2 sentences. What kind of developer Claude becomes. Be specific to this codebase's patterns.]

## Code Patterns & Conventions
[Use a markdown TABLE with columns Pattern | This Codebase's Approach if 3 or more patterns
exist with consistent attributes. Otherwise use structured bullets.
Cover: naming conventions, async style, error handling, typing, imports.]

## Architecture Decisions
[Use an ASCII flowchart inside a triple-backtick codeblock ONLY if the source shows
branching logic or decision trees. Use prose if source describes architectural philosophy.
Format for flowchart: plain ASCII with → ↓ ├── └── characters only.]

## What to Always Write
[5 specific coding behaviors extracted from source. Start each with an action verb.]

## What to Never Write
[4 antipatterns visible in or clearly avoided by the source. Start each with "Never".]

## Example Patterns
[ALWAYS include at least one triple-backtick code block here showing a preferred pattern.
Use the actual language from the source. Add the language name after the opening backticks.
Example: \`\`\`typescript
// preferred pattern here
\`\`\`
Base this on actual code from the source — do not fabricate.]

## Quality Bar
[How to know the code output matches this developer's exact style and conventions.]

CONTENT:
${textToSend}`;

  } else if (activeTemplate === 'C') {
    // ── TEMPLATE C: Process & Workflow ────────────────────────────────────────
    prompt = `You are a Process Architecture Engine. Analyze the provided document and extract the workflow logic, decision criteria, and operational rules into a Claude Skill File. Do not summarize — extract the actual process DNA.
Focus on: ${focus}
Domain: ${safeDomainLabel}
Role: ${safeDomainRole}

RULES:
- Extract the ACTUAL process — do not generalize into generic advice.
- Identify decision points, branching conditions, escalation paths, and constraints.
- NEVER copy-paste raw sentences — extract the structural logic behind them.
- You MUST start your response exactly with the YAML block below, no code fences, no backticks, no preamble.
- You MUST enclose all YAML values in double quotes.
- The "name" field MUST be exactly: "${skillName}"
- The "domain" field MUST be exactly: "${safeDomainLabel}"

FORMAT:
---
name: "${skillName}"
domain: "${safeDomainLabel}"
content_type: "behavioral skill"
use_cases: ["process execution", "decision support", "workflow guidance"]
---

## Domain Role
[2 sentences. What operational role Claude takes on. Be specific to this process domain.]

## Core Framework
[Use a markdown TABLE with clear column headers if the framework has 3 or more components
with consistent attributes (stages, phases, categories with properties).
Otherwise use structured prose. Do NOT force a table if content is not comparative.]

## Decision Process
[Use an ASCII flowchart inside a triple-backtick codeblock if there are real branching
decisions in the source (if/then, yes/no, condition-based paths).
Format: plain ASCII only — → ↓ ├── └── characters.
Use a numbered list if steps are purely linear with no branching.
Do NOT use a flowchart just because this is a process document.]

## Rules & Constraints
[Use a TABLE with columns Situation | Rule | Exception if rules have clear conditions
and outcomes. Otherwise use bullet points. 4 to 6 rules maximum.]

## Edge Cases
[Bullet list. What to do when the normal process cannot be followed. Based on source only.]

## Quality Bar
[How to know the process was followed correctly and output meets the standard.]

CONTENT:
${textToSend}`;

  } else if (activeTemplate === 'D') {
    // ── TEMPLATE D: Professional Domain ───────────────────────────────────────
    prompt = `You are a Professional Domain Skill Architect. Analyze the provided document and extract the domain expertise, decision frameworks, and professional standards into a Claude Skill File. Do not summarize — extract the actual professional DNA.
Focus on: ${focus}
Domain: ${safeDomainLabel}
Role: ${safeDomainRole}

RULES:
- Extract domain-specific frameworks and decision criteria — not generic professional advice.
- Identify the professional standards, constraints, and terminology of this exact domain.
- NEVER copy-paste raw sentences — synthesize the expertise patterns behind them.
- You MUST start your response exactly with the YAML block below, no code fences, no backticks, no preamble.
- You MUST enclose all YAML values in double quotes.
- The "name" field MUST be exactly: "${skillName}"
- The "domain" field MUST be exactly: "${safeDomainLabel}"

FORMAT:
---
name: "${skillName}"
domain: "${safeDomainLabel}"
content_type: "behavioral skill"
use_cases: ["case 1", "case 2", "case 3"]
---

## Domain Role
[2 sentences. What professional role Claude takes on. Be highly specific to this domain.]

## Core Principles
[4 to 5 fundamental beliefs of this domain extracted from source. Bullet list.
Write as if the domain expert is speaking. No generic advice.]

## Decision Framework
[THIS IS THE MOST IMPORTANT SECTION.
Use a markdown TABLE with clear column headers if content compares 3 or more items
across 2 or more consistent attributes (metrics, thresholds, criteria, categories).
Use an ASCII flowchart inside a triple-backtick codeblock if content has real branching
decision logic — format: plain ASCII → ↓ ├── └── only.
Use BOTH if content has both comparative data AND branching decisions.
Use prose ONLY if content has neither.
Base this entirely on what is in the source document — do not invent frameworks.]

## Rules & Constraints
[Use a TABLE with columns Situation | Rule | Exception if rules have clear conditions.
Otherwise use bullets. Domain-specific rules only — no generic professional advice.]

## What to Always Do
[5 specific behaviors. Start each with an action verb. Domain-specific and extracted from source.]

## What to Never Do
[4 prohibitions. Start each with "Never". Domain-specific and extracted from source.]

## Quality Bar
[How to know output meets the professional standard of this exact domain.]

CONTENT:
${textToSend}`;

  } else {
    // ── TEMPLATE A: Persona & Voice (default) ─────────────────────────────────
    // Original prompt preserved exactly, with enhanced format rules added before CONTENT
    prompt = `You are a Persona Simulation Engine. Do not act like an AI summarizing a text. Instead, analyze the Tonal DNA of the provided content and generate a Claude Skill File that perfectly mimics the author's voice, constraints, and structural habits.
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

ENHANCED FORMAT RULES (use judgment — do not force):
Within any section above, you MAY use one of these formats ONLY when content genuinely requires it:

1. EXAMPLE BLOCK — only if source contains a template, before/after pattern, or signature
   phrase worth preserving exactly.
   Format: > **Example:** on one line, then the example on the next line.
   DO NOT use for general principles or rules.

2. ASCII FLOWCHART IN CODEBLOCK — only if source describes a process with real branching
   decisions (if/then, yes/no outcomes that change the path).
   Format: triple backtick block, plain ASCII: → ↓ ├── └──
   DO NOT use for linear steps — use a numbered list instead.

DEFAULT: When in doubt use prose. A plain text file about writing rules does NOT need
special formatting. Never force a format onto content that does not naturally have it.

CONTENT:
${textToSend}`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SANITIZE FUNCTION
  // UNCHANGED: all YAML repair logic preserved exactly
  // CHANGED: removed hardcoded 8-section enforcement, replaced with template-aware minimum
  // ─────────────────────────────────────────────────────────────────────────────
  function sanitize(raw, skillName, tmpl) {
    let text = raw;

    // UNCHANGED — exact same UTF-8 cleaning as before
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF\u200B-\u200D\u2060]/g, '');
    text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();

    // UNCHANGED — exact same YAML positioning as before
    const yamlStart = text.indexOf('---');
    if (yamlStart > 0) text = text.slice(yamlStart);
    if (!text.startsWith('---')) text = '---\n' + text;

    // UNCHANGED — exact same YAML field repair as before
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

    // V2 CHANGE: template-aware minimum section check
    // Replaces the old hardcoded 8-section enforcement that punished Gemini for creativity
    // Now only checks for the ONE anchor section per template — just enough to confirm
    // the right template was used. Does not force back missing sections.
    const templateAnchors = {
      A: '## Identity & Role',
      B: '## Role & Capability',
      C: '## Domain Role',
      D: '## Domain Role',
    };
    const anchor = templateAnchors[tmpl] || templateAnchors.A;
    if (!text.includes(anchor)) {
      text += `\n\n${anchor}\n[Content could not be extracted from source. Review document and retry.]`;
    }

    // UNCHANGED — exact same line ending and whitespace cleanup as before
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

  // UNCHANGED — exact same model list and order as before
  const modelList = [
    "gemini-3.1-flash-lite-preview",
    "gemini-2.5-flash"
  ];

  let finalRawText = null;
  let successfulModel = null;
  let lastGoogleError = "No models responded";

  // V2: track model index for quality threshold (Lite >= 6, Flash >= 5)
  let modelIndex = 0;

  for (const modelId of modelList) {
    const controller = new AbortController();

    // UNCHANGED — exact same 45s timeout as before
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            // V2: raised from 900 to 1400 — needed for tables, flowcharts, rich output
            generationConfig: { maxOutputTokens: 1400, temperature: 0.7 }
          }),
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);

      // UNCHANGED — exact same HTTP error handling as before
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        lastGoogleError = `HTTP ${response.status}: ${errorData.error?.message || 'Unknown'}`;

        if (response.status === 429 || response.status === 503 || response.status === 504) {
          modelIndex++;
          continue;
        }
        break;
      }

      const data = await response.json();
      const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // V2: replaced old 2-condition check with template-aware quality scoring
      // Flash Lite (index 0) must score >= 6
      // Gemini 2.5 Flash (index 1) must score >= 4
      const yamlBlock = candidateText.match(/^---\n[\s\S]*?\n---\n/);
      const requiredSections = {
        A: ['## Identity & Role', '## Voice & Language'],
        B: ['## Role & Capability', '## Example Patterns'],
        C: ['## Domain Role', '## Decision Process'],
        D: ['## Domain Role', '## Decision Framework']
      };
      const sectionsToCheck = requiredSections[activeTemplate] || requiredSections.A;
      const hasAllSections = sectionsToCheck.every(s => candidateText.includes(s));
      const isStructurallyValid = !!yamlBlock && hasAllSections;

      if (!isStructurallyValid) {
        lastGoogleError = `Structural validation failed for model: ${modelId}`;
        modelIndex++;
        continue;
      }

      const qualityThreshold = modelIndex === 0 ? 6 : 4;
      if (scoreOutput(candidateText, activeTemplate) >= qualityThreshold) {
        finalRawText = candidateText;
        successfulModel = modelId;
        break;
      } else {
        lastGoogleError = `Quality check failed (score: ${scoreOutput(candidateText, activeTemplate)}/${qualityThreshold} required) for model: ${modelId}`;
        modelIndex++;
        continue;
      }

    } catch (err) {
      clearTimeout(timeoutId);
      // UNCHANGED — exact same error message logic as before
      lastGoogleError = err.name === 'AbortError' ? 'Timeout: Model took too long (45s)' : `Fetch Error: ${err.message}`;
      modelIndex++;
      continue;
    }
  }

  // UNCHANGED — exact same response format as before
  if (finalRawText) {
    return res.status(200).json({
      enriched: sanitize(finalRawText, skillName, activeTemplate),
      model: successfulModel
    });
  } else {
    return res.status(503).json({
      error: 'GOOGLE_API_ERROR',
      message: `Enrichment failed. Details: ${lastGoogleError}`
    });
  }
};
