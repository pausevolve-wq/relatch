const { verifyToken, createClerkClient } = require('@clerk/backend');
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.relatch.online');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  let userId;
  try {
    const payload = await verifyToken(authHeader.slice(7), { secretKey: process.env.CLERK_SECRET_KEY });
    userId = payload.sub;
    if (!userId) throw new Error('No userId in token');
  } catch {
    return res.status(401).json({ error: 'Invalid session' });
  }

  // V2: destructure new fields from frontend (template, richFormats, charCap)
  // Old fields remain exactly the same — backward compatible if frontend hasn't updated yet
  // richFormats: consumed by Claude prompt templates only. Codex path uses codexSourceHint
  // pre-scan (v2.2.1) for dynamic structure detection — intentionally unused on Codex path.
  const { rawText, category, fileName, domainLabel, domainRole, domainFrame, template, richFormats, charCap, sizeClass, target = 'claude', codexShape = 'execute', sessionId } = req.body;
  if (!rawText || !category || !fileName) return res.status(400).json({ error: 'Missing required fields' });

  const CODEX_POLICY = {
    timeouts: {
      model1: { small: 25000, medium: 25000, large: 35000 },
      model2: { small: 20000, medium: 20000, large: 18000 },
    },
    tokenBudgets: {
      small:  { lite: 1000, flash: 1000 },
      medium: { lite: 1400, flash: 1200 },
      large:  { lite: 1800, flash: 1400 },
    },
    qualityThresholds: { lite: 6, flash: 4 },
    model2ReserveMs: 8000,
  };
  const requestStartMs = Date.now();

  // ─── QUOTA GATE ──────────────────────────────────────────────────────────────
  const DAILY_LIMIT  = 5;
  const WEEKLY_LIMIT = 35;

  function getDateKey(now) {
    return now.toISOString().slice(0, 10);
  }

  function getIsoWeekKey(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }

  let quotaUsage = null;
  let quotaUser  = null;

  try {
    quotaUser = await clerkClient.users.getUser(userId);
    const now = new Date();
    const currentDayKey  = getDateKey(now);
    const currentWeekKey = getIsoWeekKey(now);

    const stored = quotaUser.privateMetadata?.relatchUsage ?? {};
    quotaUsage = {
      dailyCount:    stored.dailyCount    ?? 0,
      weeklyCount:   stored.weeklyCount   ?? 0,
      lastDayKey:    stored.lastDayKey    ?? currentDayKey,
      lastWeekKey:   stored.lastWeekKey   ?? currentWeekKey,
      lastSessionId: stored.lastSessionId ?? null,
    };

    if (quotaUsage.lastDayKey !== currentDayKey) {
      quotaUsage.dailyCount = 0;
      quotaUsage.lastDayKey = currentDayKey;
    }

    if (quotaUsage.lastWeekKey !== currentWeekKey) {
      quotaUsage.weeklyCount = 0;
      quotaUsage.lastWeekKey = currentWeekKey;
    }

    const isSameSession = sessionId && quotaUsage.lastSessionId === sessionId;

    if (!isSameSession) {
      if (quotaUsage.dailyCount >= DAILY_LIMIT || quotaUsage.weeklyCount >= WEEKLY_LIMIT) {
        const limitType  = quotaUsage.dailyCount >= DAILY_LIMIT ? 'daily' : 'weekly';
        const limitValue = limitType === 'daily' ? DAILY_LIMIT : WEEKLY_LIMIT;
        return res.status(429).json({
          error: 'QUOTA_REACHED',
          limitType,
          limitValue,
          weeklyCount: quotaUsage.weeklyCount,
          weeklyLimit: WEEKLY_LIMIT,
          message: `You have used all ${limitValue} free generations for this ${limitType === 'daily' ? 'day' : 'week'}. Your quota resets automatically ${limitType === 'daily' ? 'tomorrow' : 'next week'}.`,
        });
      }
    }
  } catch (quotaErr) {
    console.error('[quota] Clerk read failed:', quotaErr?.message || quotaErr);
    quotaUsage = null;
    quotaUser  = null;
  }
  // ─── END QUOTA GATE ──────────────────────────────────────────────────────────

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

  // Signal-line filter. Claude path uses the original behavioral-keyword criteria
  // exactly as before. v2.2.1 adds a Codex-only branch that preserves code-shaped
  // lines (declarations, control flow, syntax-marker chars, comments) — these have
  // no digits / no action verbs / no colons and would otherwise be dropped, hurting
  // EXECUTE-shape output on code-heavy sources. v2.3 (Template B) adds an identical
  // clause for the Claude path when template === 'B' so structural code lines survive
  // the filter and reach the Codebase Intelligence prompt. Uses `template` (from
  // req.body, line 25) rather than `activeTemplate` which is not yet in scope here.
  const allLines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const signalLines = allLines.filter(line =>
    line.length > 20 && (
      /\d/.test(line) ||
      /\b(always|never|use|create|build|write|make|avoid|ensure|must|should|start|end|keep|focus|lead|design|follow|apply|open|close|prefer|every|each)\b/i.test(line) ||
      line.includes(':') ||
      /^[-•*#>]/.test(line) ||
      /^(\d+[.)]\s|#{1,3}\s)/.test(line) ||
      line.endsWith('.') || line.endsWith('!') || line.endsWith('?') ||
      (template === 'B' && target !== 'codex' && (
        /^\s*(const|let|var|function|class|interface|type|import|export|async|await|return|def|fn|fun|impl|use|struct|enum|trait|public|private|protected)\b/.test(line) ||
        /[{};]|=>|::/.test(line) ||
        /^\s*(\/\/|\/\*|\*\s)/.test(line)
      )) ||
      (target === 'codex' && (
        /^\s*(const|let|var|function|class|interface|type|import|export|async|await|return|def|fn|fun|impl|use|struct|enum|trait|public|private|protected|namespace|module|require|template|throw|throws|try|catch|finally|new|this|super|extends|implements|abstract|static|virtual)\b/.test(line) ||
        /[{};]|=>|::|->/.test(line) ||
        /^\s*(\/\/|\/\*|\*\s|#\s)/.test(line)
      ))
    )
  );

  const filteredText = signalLines.length >= 5 ? signalLines.join('\n') : rawText;

  // V2: use charCap from profiler if provided, otherwise fall back to original logic
  const effectiveCharCap = charCap || (signalLines.length >= 5 ? 2500 : 3500);
  const textToSend = filteredText.slice(0, effectiveCharCap);

  // ── ADAPTIVE OUTPUT BUDGET ────────────────────────────────────────────────
  // Derive sizeClass from frontend signal. If frontend is old and didn't send
  // sizeClass, reconstruct from charCap with same thresholds as App.tsx profiler.
  const effectiveSizeClass =
    sizeClass === 'large' || sizeClass === 'medium' || sizeClass === 'small'
      ? sizeClass
      : charCap >= 8000
        ? 'large'
        : charCap >= 5000
          ? 'medium'
          : 'small';

  // Token budgets per model, per sizeClass.
  // Derived from Vercel 60s gateway + 45s internal timeout + Gemini throughput rates.
  // Flash Lite: 55 tok/s degraded floor × 35s window = 1925 ceiling → 1800 safe.
  // 2.5 Flash: fallback only, shorter effective window → capped lower.
  const tokenBudgets = {
    small:  { lite: 1000, flash: 1000 },
    medium: { lite: 1400, flash: 1200 },
    large:  { lite: 1800, flash: 1400 },
  };
  const budgetForSize = tokenBudgets[effectiveSizeClass] || tokenBudgets.small;
  // ─────────────────────────────────────────────────────────────────────────

  // ── DOCUMENT CONTEXT HEADER ───────────────────────────────────────────────
  // Prepended to every template prompt. Orients the model on source complexity
  // without changing template structure, domain, role, or section format.
  // Small: no header — current behavior exactly preserved.
  // Medium: depth instruction only.
  // Large: depth instruction + sampling disclosure.
  // Rules: no ## markers (would corrupt scoreOutput section detection),
  //        no role/persona language (would conflict with domain frame),
  //        no minimum length instruction (invites padding on Flash Lite).
  const documentContext =
    effectiveSizeClass === 'large'
      ? `SOURCE CONTEXT: You have received sampled excerpts from a large document — beginning, middle, and end sections. Synthesize patterns that appear consistently across all excerpts as primary signals. Where sections differ, preserve the variation rather than collapsing it into one point. Expand each section to the depth the source material warrants. Go deeper only where source density justifies it. Do not repeat. Do not pad. Do not elaborate beyond what is grounded in the source.\n\n`
      : effectiveSizeClass === 'medium'
        ? `SOURCE CONTEXT: This document contains multiple frameworks, rules, or patterns. Expand each section to the depth the source warrants. Go deeper only where source density justifies it. Do not repeat. Do not pad.\n\n`
        : '';
  // ─────────────────────────────────────────────────────────────────────────

  // UNCHANGED — exact same category context as before
  const categoryContext = {
    personality: 'communication style, tone, voice patterns, how they phrase things, what they emphasize',
    instructions: 'rules, constraints, decision criteria, what to always do, what to never do',
    knowledge: 'domain expertise, mental models, frameworks they use, how they think about problems',
    examples: 'the patterns in these examples, structure, style, what makes them work',
    context: 'the situation, constraints, goals, audience, and environment that shapes decisions',
    preferences: 'specific choices, standards, non-negotiables, defaults, and pet peeves',
  };

  // v2.3: Codex-specific category focus strings — operational framing vs Claude's persona framing.
  // Claude uses persona-flavored descriptions ("communication style, tone, voice patterns").
  // Codex needs operational-flavored descriptions ("verifiable execution rules, command sequences").
  // Only used when target === 'codex'. categoryContext is byte-identical — no Claude impact.
  const codexCategoryContext = {
    personality: 'behavioral enforcement rules, voice compliance criteria, and style constraint definitions that can be applied as operational checks',
    instructions: 'verifiable execution rules, command sequences, checkable artifact states, hard constraints, and explicit refusal criteria',
    knowledge: 'operational frameworks, domain-specific decision criteria, constraint sets, and reference patterns that Codex can apply procedurally',
    examples: 'concrete reference implementations, before/after anti-pattern pairs, and approved pattern libraries with named artifacts',
    context: 'operational boundaries, environmental prerequisites, scope limitations, escalation triggers, and refusal conditions',
    preferences: 'non-negotiable defaults, enforced output standards, rejection criteria, and configuration invariants',
  };

  const focus = target === 'codex'
    ? (codexCategoryContext[category] || codexCategoryContext.knowledge)
    : (categoryContext[category] || categoryContext.knowledge);

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

  // v2.1: Codex export target — kebab-case slug for OpenAI Codex skill name
  const codexSlug = skillName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'my-skill';
  const activeTarget = target === 'codex' ? 'codex' : 'claude';

  // V2: determine active template — default to 'A' if not provided (backward compatible)
  const activeTemplate = template || 'A';
  // v2.1: when targeting Codex, override template selection to the CODEX prompt + scoring path
  const effectiveTemplate = activeTarget === 'codex' ? 'CODEX' : activeTemplate;

  // v2.2: Codex generation shape — three sub-templates with different cognitive profiles.
  // EXECUTE  = direct execution playbook (refactor guides, runbooks, migrations) — code-heavy
  // EXPERTISE = human-in-loop creative judgment (brand voice, design critique, copy) — prose + examples
  // SPECIALIST = constrained domain role (compliance, legal, ops) — flowcharts + decision matrices
  // Backward-compatible: defaults to 'execute' when not provided (the 70% bet).
  const allowedShapes = ['execute', 'expertise', 'specialist'];
  const activeCodexShape = allowedShapes.includes(codexShape) ? codexShape : 'execute';

  // v2.2.1: Source-structure pre-scan — detect which rich components the source
  // actually supports, so Codex prompts can tell Gemini what to render vs skip.
  // Without this, Gemini guesses — and on sources lacking branching/code/tables,
  // it either hallucinates fake components or bails to placeholder text (which
  // costs score points). Computed only when targeting Codex. No Claude impact.
  let codexSourceHint = '';
  if (activeTarget === 'codex') {
    const codeFenceCount = (textToSend.match(/```/g) || []).length;
    const codeKeywordHits = (textToSend.match(/^\s*(const|let|var|function|class|def|fn|import|export|return|async|interface|type|struct|enum|impl)\b/gm) || []).length;
    const syntaxMarkerLines = (textToSend.match(/^[^\n]*[{};]\s*$/gm) || []).length;
    const hasCode = codeFenceCount >= 2 || codeKeywordHits >= 3 || syntaxMarkerLines >= 3;

    const branchingHits = (textToSend.match(/\b(if|when|unless|otherwise|either|depend(?:s|ing)?|whereas|provided|except|condition|case)\b/gi) || []).length;
    const hasBranching = branchingHits >= 3;

    const colonPairCount = (textToSend.match(/^[^:\n]{2,50}:\s+\S/gm) || []).length;
    const hasTableLike = colonPairCount >= 5;

    const numberedStepCount = (textToSend.match(/^\s*\d+[.)]\s/gm) || []).length;
    const hasNumberedSteps = numberedStepCount >= 3;

    const available = [];
    if (hasCode) available.push(`code patterns (${codeKeywordHits} declarations, ${codeFenceCount} fences, ${syntaxMarkerLines} syntax-marker lines)`);
    if (hasBranching) available.push(`branching language (${branchingHits} if/when/unless/depending references)`);
    if (hasTableLike) available.push(`${colonPairCount} key-value lines suitable for table rows`);
    if (hasNumberedSteps) available.push(`${numberedStepCount} explicit numbered steps`);

    codexSourceHint = available.length > 0
      ? `\nSOURCE STRUCTURE DETECTED: The provided content contains ${available.join('; ')}. Use these signals to decide which optional sections to populate vs skip. Render rich components (code blocks, decision tables, ASCII flowcharts, templates) ONLY where the source supports them — do not fabricate components the source does not contain. Fall back to prose bullets where the spec allows.\n`
      : `\nSOURCE STRUCTURE: The provided content has no detectable code, branching language, table-shaped key-value pairs, or numbered step sequences. Render with prose-heavy sections. SKIP optional sections (Code Patterns, ASCII flowcharts, Decision Matrix, Templates) that would require fabricated content — use the prose-bullet fallback where the spec allows.\n`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // V2: QUALITY SCORING FUNCTION
  // Replaces the old: candidateText.length > 150 && candidateText.includes('## Identity')
  // Now template-aware. Returns a score 0-9.
  // Flash Lite accepted at >= 6. Gemini 2.5 Flash accepted at >= 5.
  // ─────────────────────────────────────────────────────────────────────────────
  function scoreOutput(text, tmpl, docSizeClass) {
    // v2.1: Codex scoring path — closes over activeCodexShape (declared in handler scope).
    // v2.2: three shape-aware branches with different required anchors and component bonuses.
    // All return 0-9 to match the Claude scoring scale used by the qualityThreshold gate.

    // Template E: Structured financial data scoring
    if (tmpl === 'E') {
      let score = 0;
      // +2: required anchors present
      if (text.includes('## Data Scope') && text.includes('## Key Metrics')) score += 2;
      // +2: YAML frontmatter intact
      if (text.includes('name:') && text.includes('domain:')) score += 2;
      // +1: Core Entities present
      if (text.includes('## Core Entities')) score += 1;
      // +1: table structure (explicitly requested for E)
      if (text.includes('|')) score += 1;
      // +1: Decision Rules or Quality Bar present
      if (text.includes('## Decision Rules') || text.includes('## Quality Bar')) score += 1;
      // +1: length floor (scales with sizeClass)
      const eFloor = docSizeClass === 'large' ? 900 : docSizeClass === 'medium' ? 600 : 400;
      if (text.length >= eFloor) score += 1;
      // +1: not all conditional sections are "Not present in source" (capped at 4 allowed)
      if ((text.split('Not present in source').length - 1) <= 4) score += 1;
      return Math.min(score, 9);
    }

    if (tmpl === 'CODEX') {
      let score = 0;

      // Shared baseline (5 points possible across all shapes):
      // +2 frontmatter has name + description
      if (text.includes('name:') && text.includes('description:')) score += 2;
      // +2 no placeholder bail-outs
      if (!text.includes('[Not extracted') && !text.includes('[review source') && !text.includes('to be added')) score += 2;
      // +1 trigger sub-sections present (universal across all three shapes)
      if (text.includes('### Must Use') && text.includes('### Recommended') && text.includes('### Skip')) score += 1;

      if (activeCodexShape === 'execute') {
        // EXECUTE rewards: workflow anchor + code blocks + anti-patterns + final checks.
        if (text.includes('## When to Activate') && text.includes('## Implementation Workflow') && text.includes('## Key Principles')) score += 2;
        const codeBlockCount = (text.match(/```[a-z]*\n/gi) || []).length;
        if (codeBlockCount >= 2) score += 1;
        if (text.includes('## Common Mistakes to Avoid')) score += 1;
        if (text.includes('## Final Checks')) score += 1;
      } else if (activeCodexShape === 'expertise') {
        // EXPERTISE rewards: review workflow + judgment anchor + quality criteria + human-pause.
        if (text.includes('## When to Activate') && text.includes('## Judgment Framework') && text.includes('## When to Pause for Human')) score += 2;
        if (text.includes('## Quality Bar') && text.includes('## Example Pairs')) score += 1;
        if (text.includes('## Review Workflow')) score += 1;
        if (text.includes('## Key Principles')) score += 1;
      } else {
        // SPECIALIST rewards: scope + operating mode + workflow/decision structure + escalation.
        if (text.includes('## When to Activate') && text.includes('## Scope Boundaries') && text.includes('## Workflow')) score += 2;
        if (text.includes('## Decision Matrix') && text.includes('|')) score += 1;
        if (text.includes('## Operating Mode')) score += 1;
        if (text.includes('## Escalation Rules') && text.includes('## Common Mistakes to Avoid')) score += 1;
      }

      return score;
    }

    let score = 0;

    // +2: Length floor (hard requirement, scales with document sizeClass)
    // Small floors are identical to legacy values — no regression on small documents.
    // Medium ~1.5× small; large ~2.3× small — matches the per-sizeClass token budgets.
    const lengthFloors = {
      small:  { A: 600,  B: 500,  C: 500,  D: 700  },
      medium: { A: 900,  B: 800,  C: 800,  D: 1000 },
      large:  { A: 1400, B: 1200, C: 1200, D: 1600 },
    };
    const floorMap = lengthFloors[docSizeClass] || lengthFloors.small;
    if (text.length >= (floorMap[tmpl] || 600)) score += 2;

    // +2: Required sections present (hard requirement)
    const requiredSections = {
      A: ['## Identity & Role', '## Voice & Language'],
      B: ['## Role & Capability', '## Example Patterns', '## What to Always Write'],
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

  if (activeTarget === 'codex') {
    // ── CODEX TARGET: OpenAI Codex CLI Skill ──────────────────────────────────
    // v2.2: three shape-aware sub-prompts selected by activeCodexShape.
    // Codex is an EXECUTING agent (not a personality clone like Claude skills) —
    // each shape matches a different cognitive profile of work Codex performs.
    //
    // EXECUTE  (~70%): direct procedural playbooks — refactors, migrations, deploys, runbooks
    // EXPERTISE       : human-in-loop creative/judgment — brand voice, design critique, copy
    // SPECIALIST      : constrained domain role — compliance, legal, security audit, ops
    //
    // Frontmatter spec is shape-invariant: ONLY `name` (kebab-case == codexSlug) and
    // `description` (1-3 sentences with source-extracted trigger phrases). All other
    // YAML fields are forbidden per the official OpenAI Codex skill spec.
    //
    // Trigger-phrase rule (shared across all shapes): description must contain at least
    // 3 phrases that appear literally in the source — Codex's loader uses description-
    // to-user-intent matching to decide when to activate. Vague descriptions never trigger.

    if (activeCodexShape === 'expertise') {
      // ── CODEX-EXPERTISE: human-in-loop creative judgment ──────────────────────
      prompt = `${documentContext}You are a Skill Architect for OpenAI Codex CLI generating an EXPERTISE skill. Codex is an autonomous coding agent — when this skill activates, Codex performs review, editing, or creative work and PAUSES for human approval at key decision points. Convert the source into instructions Codex can follow while reviewing, rewriting, or producing work. Prefer minimal-edit review guidance before full rewrites. Prefer concrete checks over abstract advice.
Focus on: ${focus}
Domain: ${safeDomainLabel}
Role: ${safeDomainRole}

CRITICAL FRONTMATTER RULES:
- Frontmatter MUST contain ONLY two fields: name and description. No other YAML fields whatsoever.
- The "name" field MUST be exactly: "${codexSlug}"
- Description: 2-3 sentences. Sentence 1: what Codex should do when this skill is relevant. Sentence 2: trigger contexts — include 1-2 phrases that appear literally in the source AND 2-4 real user-intent phrases a Codex user would naturally type (e.g. "review landing page copy", "tighten this headline", "improve the CTA"). Sentence 3 (optional): explicit exclusions.
- Do NOT wrap in code fences. Start your response with --- on line 1.
- Do NOT add domain, origin, content_type, use_cases, or any other YAML field.

CONTENT BUDGET: Target 500-900 words. If approaching the upper range, prioritize completing all REQUIRED sections over depth in any single section.
${codexSourceHint}
REQUIRED SECTIONS (in this order):

## When to Activate
### Must Use
- 3-5 specific trigger contexts (mix of source phrases and real user-intent phrasing)
### Recommended
- 2-3 broader use cases
### Skip
- 2-3 explicit exclusions

## Review Workflow
4-7 numbered steps for how Codex should approach reviewing or rewriting work in this domain. Example order: clarify intent → identify weak claims → check proof/support → check CTA or conclusion → verify tone → suggest minimal diff first before full rewrite. Lift the actual review logic from the source.

## Judgment Framework
Explain the explicit tradeoffs in this domain — clarity vs. cleverness, brevity vs. proof, emotion vs. specificity. State which side wins under which conditions. Synthesize the author's decision-making approach; do not generalize.

## Quality Bar
4-6 concrete, testable criteria for "good" output specific to this domain. No generic phrases like "be professional" or "high quality."

## Example Pairs
2-3 before/after pairs showing concrete text-level edits (5-20 word snippets from real landing pages, ad headlines, email subjects, CTA buttons, or value propositions). Each pair MUST show the actual words, not a description of the problem. Use the source's domain and vocabulary:
> **Weak:** "[exact weak phrasing]"
> **Strong:** "[specific improved version]" — [1-sentence explanation anchored to the Judgment Framework above]
Show the minimal diff first. Only escalate to a full rewrite if the weak version cannot be salvaged with small edits.

## When to Pause for Human   [REQUIRED]
3-5 specific moments where Codex must STOP and surface options — only pause on ambiguity that blocks good output, not on ordinary rewrite work. Each trigger is concrete (e.g. "if the audience segment is unclear, ask before rewriting the hook").

## Key Principles
4-6 non-negotiable judgment rules lifted directly from the source.

FORBIDDEN: ASCII flowcharts, decision tables, code anti-pattern pairs, heavy numbered procedures — those belong to EXECUTE and SPECIALIST shapes. Avoid generic educational exposition.

CONTENT:
${textToSend}`;

    } else if (activeCodexShape === 'specialist') {
      // ── CODEX-SPECIALIST: constrained domain role ─────────────────────────────
      prompt = `${documentContext}You are a Skill Architect for OpenAI Codex CLI generating a SPECIALIST skill. Codex is an autonomous coding agent — when this skill activates, Codex operates as a constrained domain role and MUST REFUSE out-of-scope work. Convert the source into an operator playbook: what Codex is allowed to do autonomously, what it must escalate, and what it refuses. If the source is conceptual, translate it into an action sequence Codex can run.
Focus on: ${focus}
Domain: ${safeDomainLabel}
Role: ${safeDomainRole}

CRITICAL FRONTMATTER RULES:
- Frontmatter MUST contain ONLY two fields: name and description. No other YAML fields whatsoever.
- The "name" field MUST be exactly: "${codexSlug}"
- Description: 2-3 sentences. Sentence 1: what role this skill assumes. Sentence 2: trigger contexts — include 1-2 phrases that appear literally in the source AND 2-4 real user-intent phrases a Codex user would naturally type. Sentence 3 (optional): what this role does NOT cover.
- Do NOT wrap in code fences. Start your response with --- on line 1.
- Do NOT add domain, origin, content_type, use_cases, or any other YAML field.

CONTENT BUDGET: Target 700-1100 words. Every section must be load-bearing. If approaching the upper range, prioritize completing all REQUIRED sections over depth in any single section.
${codexSourceHint}
REQUIRED SECTIONS (in this order):

## When to Activate
### Must Use
- 3-5 specific trigger contexts (mix of source phrases and real user-intent phrasing)
### Recommended
- 2-3 broader use cases
### Skip
- 2-3 explicit exclusions

## Scope Boundaries
Two explicit sub-lists. The "does NOT" list defines when Codex refuses.
**This role DOES:**
- 4-6 specific in-scope responsibilities (concrete, not abstract)
**This role does NOT:**
- 4-6 explicit out-of-scope items — work that must be refused or escalated

## Operating Mode   [REQUIRED]
Three short sub-sections defining Codex's behavioral envelope in this role:
**Autonomous:** tasks Codex can complete and deliver without checking in
**Escalate:** situations requiring human sign-off before proceeding
**Refuse:** requests explicitly out of scope — state them clearly

## Workflow
If the source has branching multi-step logic, render it as an ASCII flowchart inside a triple-backtick code fence using ONLY → ↓ ├── └── characters. Then list numbered steps with checkable outcomes. If the workflow is purely linear, skip the ASCII chart and use numbered steps only.

## Decision Matrix
Markdown table with concrete conditions:
| Condition | Action | Escalate? |
ANTI-HALLUCINATION RULE: every row must map to a condition explicitly present in the source. If the source yields fewer than 4 distinguishable conditions, provide fewer rows rather than fabricating. Use "Yes" / "No" / "If unclear" in the Escalate column. Each action must be concrete (name a file, command, or output), not a vague directive.

## Templates
SKIP ENTIRELY unless you can identify at least one reusable, fill-in-the-blank structure directly in the source. If it exists, render it with \`[PLACEHOLDER]\` markers. Do NOT synthesize templates from general domain knowledge — only extract them from what the source actually provides.

## Escalation Rules
3-5 specific cases when Codex must surface to a human. Each rule names a concrete trigger, not a vague category.

## Common Mistakes to Avoid   [REQUIRED]
4-6 domain-specific anti-patterns as prose bullets. Each anti-pattern is role-specific, not generic professional advice.

## Key Principles
4-6 non-negotiable role rules that define the constraint.

FORBIDDEN: Long judgment-prose paragraphs (use the decision matrix instead), code anti-pattern pairs unless the source itself is code, generic professional advice.

CONTENT:
${textToSend}`;

    } else {
      // ── CODEX-EXECUTE: direct execution playbook (default shape) ──────────────
      prompt = `${documentContext}You are a Skill Architect for OpenAI Codex CLI generating an EXECUTION skill. Codex is an autonomous coding agent — when this skill activates, Codex reads it and STARTS WORKING immediately. Convert the source into a direct execution playbook Codex can follow: concrete files, commands, checks, and artifacts. If the source is conceptual, translate it into an action sequence Codex can run. Prefer concrete checks over abstract advice.
Focus on: ${focus}
Domain: ${safeDomainLabel}
Role: ${safeDomainRole}

CRITICAL FRONTMATTER RULES:
- Frontmatter MUST contain ONLY two fields: name and description. No other YAML fields whatsoever.
- The "name" field MUST be exactly: "${codexSlug}"
- Description: 2-3 sentences. Sentence 1: what this skill executes. Sentence 2: trigger contexts — include 1-2 phrases that appear literally in the source AND 2-4 real user-intent phrases a Codex user would naturally type (e.g. "refactor this component", "run the migration", "set up the test suite"). Sentence 3 (optional): explicit exclusions.
- Do NOT wrap in code fences. Start your response with --- on line 1.
- Do NOT add domain, origin, content_type, use_cases, or any other YAML field.

CONTENT BUDGET: Target 600-1100 words. SKILL.md is loaded into Codex's context on every trigger — keep it tight and load-bearing. If approaching the upper range, prioritize completing all REQUIRED sections over depth in any single section.
${codexSourceHint}
REQUIRED SECTIONS (in this order):

## When to Activate
### Must Use
- 3-5 specific trigger contexts (mix of source phrases and real user-intent phrasing)
### Recommended
- 2-3 broader use cases
### Skip
- 2-3 explicit exclusions

## Implementation Workflow
5-10 numbered steps. Each step MUST reference actual files, paths, commands, flags, tools, or checkable artifacts — no abstract steps. Embed fenced \`\`\`lang code blocks where the source shows code patterns. Use language tags (\`\`\`typescript, \`\`\`bash, \`\`\`python, etc.). Do NOT use ASCII flowcharts here — use numbered steps.

## Code Patterns
Fenced code blocks showing preferred patterns lifted from or grounded in the source. Include the language tag. Skip this section entirely if the source contains no code patterns — do not invent code.

## Common Mistakes to Avoid   [REQUIRED]
3-5 anti-pattern entries. When the source contains code, each entry is two fenced code blocks (// ✗ don't → // ✓ do this instead). When non-code, use "**Don't:** ... **Do:** ..." prose pairs. Each entry MUST include a one-line WHY — not just what is wrong but what breaks when you do it wrong. Make all entries source-specific, not generic advice.

## Final Checks   [REQUIRED]
3-5 verification steps Codex should run before considering the task done. Format at least one as a runnable shell command (e.g. \`$ npm test\`, \`$ python -m pytest\`, \`$ grep -r "pattern" ./src\`) when the source is code-related. Always include at least one boundary check — a file, directory, interface, or architecture constraint to verify before shipping. Each check must be independently runnable and concrete, not a vague "ensure everything works."

## Key Principles
4-6 non-negotiable executable rules (e.g. "always run pnpm install before pnpm test"). Not abstract values — verifiable actions. Lift these directly from the source.

FORBIDDEN: ASCII flowcharts, judgment/taste prose, "human review" or pause sections, decision tables (this is an execution playbook — no branching deliberation).

CONTENT:
${textToSend}`;
    }

  } else if (activeTemplate === 'B') {
    // ── TEMPLATE B: Codebase Intelligence ──────────────────────────────────────
    prompt = `${documentContext}You are a Codebase Intelligence Engine. Analyze the provided source code and extract the architectural patterns, conventions, and structural decisions into a Claude Skill File. Do not summarize — extract the behavioral and structural DNA of how this codebase is built.
Focus on: ${focus}
Domain: Software Engineering
Role: ${safeDomainRole}

RULES:
- Extract ACTUAL patterns visible in the source — never invent patterns not present.
- Identify naming conventions, async style, error handling, typing discipline, import structure, and component/module boundaries.
- Extract architectural decisions: what the code does and does not do, and what that implies.
- NEVER copy-paste raw code lines — identify the PATTERN they represent, then show one canonical example.
- You MUST start your response exactly with the YAML block below, no code fences, no backticks, no preamble.
- You MUST enclose all YAML values in double quotes.
- The "name" field MUST be exactly: "${skillName}"
- Use "software engineering" for the "domain" field unless the source clearly belongs to a different technical domain.

FORMAT:
---
name: "${skillName}"
domain: "software engineering"
content_type: "behavioral skill"
use_cases: ["code generation", "code review", "refactoring", "architecture alignment"]
---

## Role & Capability
[2 sentences. What kind of developer Claude becomes when using this skill. Name the language, framework, or domain visible in the source. Be specific — not "a skilled developer" but "a React/TypeScript engineer who uses hook-based state and async/await throughout."]

## Codebase Conventions
[Use a markdown TABLE with columns Pattern | This Codebase's Approach when 3 or more patterns exist with consistent attributes. Otherwise use structured bullets.
Cover as many of these as the source supports: naming conventions, async style, error handling, typing approach, import organization, component/function structure, state management style.
Extract only what is visible — skip any row where the source provides no signal.]

## Architecture & Structure
[Describe what architectural decisions are visible in the source. What does the code clearly commit to? What does it deliberately avoid?
Use an ASCII flowchart inside a triple-backtick code fence ONLY if the source shows real branching logic or data flow between modules. Use prose if the source describes architectural philosophy or module boundaries without branching.
Format for flowchart: plain ASCII with → ↓ ├── └── characters only. No boxes or decorative borders.]

## What to Always Write
[5 to 7 specific coding behaviors extracted directly from the source. Start each with an action verb. Every item must be grounded in something visible in the source — not generic software advice.]

## What to Never Write
[4 to 5 anti-patterns that are visibly absent from or actively avoided by the source. Start each with "Never". Every item must be specific to this codebase's choices — not generic best practices.]

## Example Patterns
[ALWAYS include at least one triple-backtick code block showing a canonical pattern extracted from the source.
Use the actual language from the source. Add the language tag after the opening backticks (e.g. \`\`\`typescript).
If the source shows multiple distinct patterns worth preserving, show up to 3 blocks.
Each block must represent a reusable pattern, not a one-off snippet. Add a one-line comment above the block explaining what pattern it demonstrates.
Base every block on actual code from the source — do not fabricate.]

## Dependency Intelligence
[If the source reveals which libraries, frameworks, or external tools are in use, list them here as a TABLE with columns Library | Role in This Codebase.
If fewer than 3 are identifiable from the source, use a brief bullet list instead.
Skip this section entirely if the source gives no signal about dependencies — write exactly "Not present in source." and nothing else.]

## Quality Bar
[3 to 4 concrete, codebase-specific checks for knowing output matches this developer's exact style. Do not use generic phrases. Reference the actual conventions extracted above.]

CONTENT:
${textToSend}`;

  } else if (activeTemplate === 'C') {
    // ── TEMPLATE C: Process & Workflow ────────────────────────────────────────
    prompt = `${documentContext}You are a Process Architecture Engine. Analyze the provided document and extract the workflow logic, decision criteria, and operational rules into a Claude Skill File. Do not summarize — extract the actual process DNA.
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
- Use "${safeDomainLabel}" for the "domain" field by default, but if the content clearly belongs to a different domain, replace it with the most accurate domain instead.

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
    prompt = `${documentContext}You are a Professional Domain Skill Architect. Analyze the provided document and extract the domain expertise, decision frameworks, and professional standards into a Claude Skill File. Do not summarize — extract the actual professional DNA.
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
- Use "${safeDomainLabel}" for the "domain" field by default, but if the content clearly belongs to a different domain, replace it with the most accurate domain instead.

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

  } else if (activeTemplate === 'E') {
    // ── TEMPLATE E: Structured Financial Data ────────────────────────────────────
    // Purpose-built for CSVs, spreadsheet exports, and numeric-dense financial tables.
    // Extracts schema, metrics, and analytical logic — NOT generic finance advice.
    // Conditional sections must be skipped when source does not contain them.
    prompt = `${documentContext}You are a Financial Data Intelligence Engine. Analyze the provided structured financial data (CSV exports, spreadsheet rows, financial tables, budget models, KPI dashboards) and extract the schema, metrics, assumptions, and analytical logic into a Claude Skill File.

DO NOT produce generic financial advice. Extract ONLY what is actually present in the source data.
DO NOT invent metrics, assumptions, scenarios, or rules that are not grounded in the source.
Focus on: ${focus}
Domain: ${safeDomainLabel}

RULES:
- Prefer TABLES and matrices over prose whenever the source has column/row structure.
- Use bullet lists for assumptions, controls, and exceptions.
- Use flowcharts ONLY when the source has real conditional branching paths.
- For every CONDITIONAL section below: if the source has no clear signal for it, write exactly "Not present in source." and nothing else for that section body.
- You MUST start your response exactly with the YAML block below, no code fences, no backticks, no preamble.
- You MUST enclose all YAML values in double quotes.
- The "name" field MUST be exactly: "${skillName}"

FORMAT:
---
name: "${skillName}"
domain: "${safeDomainLabel}"
content_type: "behavioral skill"
use_cases: ["financial analysis", "data interpretation", "reporting"]
---

## Data Scope
[What the dataset covers: time period, entities, geography, source system. What it can and cannot support analytically. 2-4 sentences grounded in the actual data.]

## Core Entities
[The main objects: accounts, line items, categories, periods, segments, columns, metrics. Use a TABLE with columns Entity | Type | Description if 3 or more entities exist with consistent attributes. Use bullets otherwise.]

## Key Metrics
[The financial measures and KPIs present. Use a TABLE with columns Metric | Unit | What It Represents if 3+ metrics exist. Include: percentages, ratios, totals, deltas, and any calculated fields visible in the source.]

## Assumption Register
[CONDITIONAL — implied definitions, formula dependencies, period conventions, sign conventions, or model assumptions embedded in the data. Use bullets. If none are detectable, write "Not present in source."]

## Scenario Analysis
[CONDITIONAL — base / actual / budget / forecast / upside / downside comparisons. Use a TABLE or matrix if multiple scenario columns exist. If no scenarios are present, write "Not present in source."]

## Variance / Sensitivity Table
[CONDITIONAL — what changes and what it affects. Use a TABLE if the source shows variance, delta, or change columns. If no variance data is present, write "Not present in source."]

## Decision Rules
[CONDITIONAL — numeric or condition-based rules that can be inferred from the data (thresholds, flags, tier criteria, approval limits). Use bullets or a TABLE with Condition | Action format. If no rules are detectable, write "Not present in source."]

## Risk Controls
[CONDITIONAL — validation points, reconciliation checks, sign conventions, data quality controls, or audit flags visible in the source. Use bullets. If not present, write "Not present in source."]

## Exceptions
[CONDITIONAL — outliers, missing values, unusual rows, ambiguous categories, or broken patterns in the data. Use bullets. If no anomalies are detectable, write "Not present in source."]

## Quality Bar
[3-4 concrete, dataset-specific checks: how to verify this extracted skill accurately represents the source data. Reference actual column names, metric names, or row counts from the source.]

CONTENT:
${textToSend}`;

  } else {
    // ── TEMPLATE A: Persona & Voice (default) ─────────────────────────────────
    // Original prompt preserved exactly, with enhanced format rules added before CONTENT
    prompt = `${documentContext}You are a Persona Simulation Engine. Do not act like an AI summarizing a text. Instead, analyze the Tonal DNA of the provided content and generate a Claude Skill File that perfectly mimics the author's voice, constraints, and structural habits.
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
- Use "${safeDomainLabel}" for the "domain" field by default. Per the rule above, if the text is clearly not about the Suggested Domain, replace it with the most accurate domain instead.

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

    // v2.1: Codex sanitize path — strict spec, frontmatter has ONLY name + description.
    // When called for Codex, `skillName` param holds the kebab-case codexSlug (see call site).
    if (tmpl === 'CODEX') {
      const yamlStartCodex = text.indexOf('---');
      if (yamlStartCodex > 0) text = text.slice(yamlStartCodex);
      if (!text.startsWith('---')) text = '---\n' + text;

      // Gemini often writes an opening --- block without the closing ---.
      // The fmMatchCodex regex below requires a closing --- to match at all.
      // If the opening is present but the closing is absent, insert it
      // immediately before the first ## section heading so the regex fires.
      if (text.startsWith('---\n') && !/^---\n[\s\S]*?\n---/.test(text)) {
        const headingIdx = text.indexOf('\n## ');
        if (headingIdx > 4) {
          text = text.slice(0, headingIdx) + '\n---' + text.slice(headingIdx);
        }
      }

      const fmMatchCodex = text.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatchCodex) {
        let fm = fmMatchCodex[1];
        if (/^name:/m.test(fm)) {
          fm = fm.replace(/^name:.*$/m, `name: ${skillName}`);
        } else {
          fm = `name: ${skillName}\n` + fm;
        }
        // Strip every non-spec YAML field — Codex frontmatter accepts ONLY name + description.
        // Block-aware pass: preserves multi-line description continuation lines that the
        // old line-by-line filter was silently dropping (causing the generic fallback to fire).
        const fmLines = fm.split('\n');
        const kept = [];
        let inDescription = false;
        for (const line of fmLines) {
          const trimmed = line.trim();
          if (/^name:/.test(trimmed)) {
            inDescription = false;
            kept.push(line);
          } else if (/^description:/.test(trimmed)) {
            inDescription = true;
            kept.push(line);
          } else if (inDescription && (line.startsWith('  ') || line.startsWith('\t'))) {
            kept.push(line);
          } else {
            inDescription = false;
          }
        }
        fm = kept.join('\n');
        if (!/^description:/m.test(fm)) {
          // Gemini omitted the description field. Instead of a generic placeholder,
          // extract the trigger phrases Gemini already wrote in ## When to Activate
          // / ### Must Use and construct a real 2-sentence description from them.
          let resolvedDesc = null;
          try {
            const bodyText = text.slice(fmMatchCodex[0].length);
            const mustUseBlock = bodyText.match(/###\s*Must Use\s*\n([\s\S]*?)(?=\n###|\n##|$)/i);
            if (mustUseBlock) {
              const triggers = mustUseBlock[1]
                .split('\n')
                .filter(l => /^\s*-\s*/.test(l))
                .map(l => l.replace(/^\s*-\s*/, '').replace(/^["']|["']$/g, '').trim())
                .filter(l => l.length > 5 && l.length < 90)
                .slice(0, 3);
              if (triggers.length >= 2) {
                const verbMap = { execute: 'Executes', expertise: 'Reviews', specialist: 'Applies' };
                const verb = verbMap[activeCodexShape] || 'Applies';
                const domain = safeDomainLabel || skillName.replace(/-/g, ' ');
                const trigStr = triggers.slice(0, 2).map(t => t.toLowerCase()).join('; ');
                resolvedDesc = `${verb} ${domain} tasks from source material. Activates when: ${trigStr}. Does not apply to out-of-scope requests.`;
              }
            }
          } catch (_) {}
          fm += `\ndescription: "${(resolvedDesc || `${skillName.replace(/-/g, ' ')} skill.`).replace(/"/g, '\\"')}"`;
        }
        // Normalize description to a single-line quoted string so downstream regex
        // parsers (both frontend and Codex loader) never see indented continuations.
        const descIdx = fm.search(/^description:/m);
        if (descIdx !== -1) {
          const beforeDesc = fm.slice(0, descIdx).replace(/\n+$/, '');
          const descValue = fm.slice(descIdx)
            .replace(/^description:\s*/m, '')
            .replace(/^["']|["']$/g, '')
            .replace(/\n\s*/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          fm = (beforeDesc ? beforeDesc + '\n' : '') + `description: "${descValue.replace(/"/g, '\\"')}"`;
        }
        console.log('[Codex:desc]', fm.match(/^description:\s*(.+)$/m)?.[1]?.slice(0, 100) || '(none)');
        text = `---\n${fm.trim()}\n---` + text.slice(fmMatchCodex[0].length);
      }

      // Safety net: if fmMatchCodex was still null after preprocessing (heading too close
      // to opener, or no ## heading at all), inject a complete frontmatter directly.
      // Extracts triggers from ### Must Use so the description is real, not a placeholder.
      if (!fmMatchCodex) {
        console.log('[Codex:desc]', '(fmMatch null after preprocessing — direct injection)');
        let emergencyDesc = `${skillName.replace(/-/g, ' ')} skill.`;
        try {
          const mb = text.match(/###\s*Must Use\s*\n([\s\S]*?)(?=\n###|\n##|$)/i);
          if (mb) {
            const trig = mb[1].split('\n')
              .filter(l => /^\s*-\s*/.test(l))
              .map(l => l.replace(/^\s*-\s*/, '').replace(/^["']|["']$/g, '').trim())
              .filter(l => l.length > 5 && l.length < 90)
              .slice(0, 2);
            if (trig.length >= 2) {
              const v = ({ execute: 'Executes', expertise: 'Reviews', specialist: 'Applies' })[activeCodexShape] || 'Applies';
              emergencyDesc = `${v} ${safeDomainLabel || skillName.replace(/-/g, ' ')} tasks. Activates when: ${trig.map(t => t.toLowerCase()).join('; ')}. Does not apply to out-of-scope requests.`;
            }
          }
        } catch (_) {}
        const bodyOnly = text.replace(/^---\n/, '').trim();
        text = `---\nname: ${skillName}\ndescription: "${emergencyDesc.replace(/"/g, '\\"')}"\n---\n\n${bodyOnly}`;
      }

      if (!text.includes('## When to Activate')) {
        text += '\n\n## When to Activate\n[Review source document and define activation contexts.]';
      }

      // v2.2: Shape-aware required-section fallback. Closes over activeCodexShape from
      // handler scope. Appends a placeholder section only if the model omitted the
      // shape-critical anchor — preserves model output otherwise. scoreOutput will
      // penalize placeholder text, so the model is incentivized to fill it on retry.
      if (activeCodexShape === 'execute') {
        if (!text.includes('## Common Mistakes to Avoid')) {
          text += '\n\n## Common Mistakes to Avoid\n[Review source document and extract domain-specific anti-patterns.]';
        }
        if (!text.includes('## Final Checks')) {
          text += '\n\n## Final Checks\n[Review source document and define verification steps before task completion.]';
        }
      } else if (activeCodexShape === 'expertise') {
        if (!text.includes('## When to Pause for Human')) {
          text += '\n\n## When to Pause for Human\n[Review source document and define explicit human-review triggers.]';
        }
        if (!text.includes('## Review Workflow')) {
          text += '\n\n## Review Workflow\n[Review source document and define the step-by-step review sequence Codex should follow.]';
        }
      } else if (activeCodexShape === 'specialist') {
        if (!text.includes('## Scope Boundaries')) {
          text += '\n\n## Scope Boundaries\n**This role DOES:**\n- [Review source document and define in-scope responsibilities]\n\n**This role does NOT:**\n- [Review source document and define out-of-scope items]';
        }
        if (!text.includes('## Operating Mode')) {
          text += '\n\n## Operating Mode\n**Autonomous:** [tasks Codex can complete without checking in]\n**Escalate:** [situations requiring human sign-off]\n**Refuse:** [requests explicitly out of scope]';
        }
      }

      text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');
      return text.trim();
    }

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
      E: '## Data Scope',
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

    // Timeouts are sizeClass-aware so large-doc generation (1800 token output budget)
    // is not killed mid-stream. At Gemini's degraded throughput floor (~55 tok/s),
    // 1800 tokens takes ~33s + ~5s overhead = ~38s. Model 1 on large gets 35s (covers
    // the vast majority of degraded cases). Model 2 always stays short — by the time
    // model 2 runs, the budget is lower (1400 tokens) and remaining Vercel time is used.
    // Total ceiling: large = 35+18 = 53s, small/medium = 25+20 = 45s. Both < 60s limit.
    const perModelTimeoutMs = modelIndex === 0
      ? (CODEX_POLICY.timeouts.model1[effectiveSizeClass] ?? 25000)
      : (CODEX_POLICY.timeouts.model2[effectiveSizeClass] ?? 20000);
    const timeoutId = setTimeout(() => controller.abort(), perModelTimeoutMs);

    // V2 ADAPTIVE: per-model output token budget driven by sizeClass.
    // modelIndex 0 = Flash Lite (full window), modelIndex 1 = 2.5 Flash (fallback, capped lower).
    // Always resolves to a number because budgetForSize falls back to tokenBudgets.small.
    const outputTokenBudget = modelIndex === 0
      ? budgetForSize.lite
      : budgetForSize.flash;

    // Codex-only: skip model 2 if insufficient time remains for a useful response.
    // Prevents spending the last few seconds on a weak attempt likely to timeout.
    if (activeTarget === 'codex' && modelIndex > 0) {
      const remainingMs = 58000 - (Date.now() - requestStartMs);
      if (remainingMs < CODEX_POLICY.model2ReserveMs) {
        clearTimeout(timeoutId);
        lastGoogleError = `timeout_model_2 (skipped: only ${Math.round(remainingMs / 1000)}s remaining)`;
        break;
      }
    }

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            // V2 ADAPTIVE: ceiling per (sizeClass, model) — temperature unchanged.
            generationConfig: { maxOutputTokens: outputTokenBudget, temperature: 0.7 }
          }),
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        lastGoogleError = `HTTP ${response.status}: ${errorData.error?.message || 'Unknown'}`;

        // Retry on transient failures only. 400/401/403/404 are configuration or
        // request errors that won't be fixed by switching models.
        if (response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504) {
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
      const qualityThreshold = modelIndex === 0 ? CODEX_POLICY.qualityThresholds.lite : CODEX_POLICY.qualityThresholds.flash;
      if (scoreOutput(candidateText, effectiveTemplate, effectiveSizeClass) >= qualityThreshold) {
        finalRawText = candidateText;
        successfulModel = modelId;
        break;
      } else {
        // Output did not pass quality check — try next model
        lastGoogleError = `Quality check failed (score: ${scoreOutput(candidateText, effectiveTemplate, effectiveSizeClass)}/${qualityThreshold} required) for model: ${modelId}`;
        modelIndex++;
        continue;
      }

    } catch (err) {
      clearTimeout(timeoutId);
      // UNCHANGED — exact same error message logic as before
      lastGoogleError = err.name === 'AbortError' ? `Timeout: Model took too long (${perModelTimeoutMs / 1000}s)` : `Fetch Error: ${err.message}`;
      modelIndex++;
      continue;
    }
  }

  // v2.4: Codex deterministic fallback assembler.
  // Declared inside handler so it closes over already-computed local vars:
  //   signalLines, activeCodexShape, codexSlug, safeDomainLabel, safeDomainRole, focus
  // Called only when activeTarget === 'codex' AND all Gemini models failed.
  // No LLM calls. No new dependencies. Zero impact on Claude path.
  function buildCodexFallback() {
    // Step A — re-bucket signalLines by operational semantics (priority order, first match wins)
    const buckets = {
      workflow:     [],
      refuse:       [],
      escalate:     [],
      antiPatterns: [],
      constraints:  [],
      other:        [],
    };

    for (const line of signalLines) {
      const clean = line.replace(/^[-•*\d.)]+\s*/, '').trim();
      if (!clean) continue;

      if (/^\s*(\d+[.)]\s|step\s*\d|\bfirst\b|\bthen\b|\bfinally\b|\bnext\b|\bafter\b|\bbefore\b)/i.test(line)) {
        buckets.workflow.push(clean);
      } else if (/\b(refuse|reject|out.?of.?scope|not (in|within) scope|decline|cannot|will not|outside)\b/i.test(line)) {
        buckets.refuse.push(clean);
      } else if (/\b(escalate|human|review|approve|sign.?off|pause|ask|clarify|ambig|unclear|exception|edge case)\b/i.test(line)) {
        buckets.escalate.push(clean);
      } else if (/\b(never|avoid|don't|do not|incorrect|wrong|bad|anti-pattern|mistake|error|fail)\b/i.test(line)) {
        buckets.antiPatterns.push(clean);
      } else if (/^\s*[-•*]?\s*\b(always|must|never|avoid|ensure|require|enforce|refuse|reject|do not|don't|stop|halt|block|verify|confirm|check|validate|run|execute|apply|set|reset|clear|deploy|migrate|refactor|test|lint|build|install|import|export)\b/i.test(line)) {
        buckets.constraints.push(clean);
      } else {
        buckets.other.push(clean);
      }
    }

    // Step B — fill() helper: take n items from bucket, drain buckets.other if short, emit placeholder if empty
    function fill(bucket, n, placeholder) {
      const items = bucket.slice(0, n);
      if (items.length < n) {
        const needed = n - items.length;
        items.push(...buckets.other.splice(0, needed));
      }
      if (items.length === 0) items.push(placeholder);
      return items;
    }

    // Step C — shared sections (all shapes)
    const triggerCandidates = signalLines
      .filter(l => /\b(when|if you|run|apply|execute|review|refactor|deploy|create|generate|fix|build|validate|check)\b/i.test(l))
      .slice(0, 4)
      .map(l => l.replace(/^[-•*\d.)]+\s*/, '').trim().split(/[.!?]/)[0].trim())
      .filter(l => l.length > 10 && l.length < 90);
    const verbMap = { execute: 'Executes', expertise: 'Reviews', specialist: 'Applies' };
    const actionVerb = verbMap[activeCodexShape] || 'Applies';
    const triggerStr = triggerCandidates.length >= 2
      ? triggerCandidates.slice(0, 2).join('; ').toLowerCase()
      : `${safeDomainLabel} ${activeCodexShape} operations`;
    const safeDesc = `${actionVerb} ${safeDomainLabel} procedures from source material. Activates when: ${triggerStr}. Does not apply to out-of-scope or ambiguous requests.`;

    const activationSection = [
      '## When to Activate',
      '### Must Use',
      ...fill([...buckets.constraints], 3, `${safeDomainLabel} ${activeCodexShape} task`).map(i => `- ${i}`),
      '### Recommended',
      ...fill([...buckets.other], 2, `General ${safeDomainLabel} work`).map(i => `- ${i}`),
      '### Skip',
      ...fill(buckets.refuse.length > 0 ? [...buckets.refuse] : [...buckets.antiPatterns], 2, 'Out-of-scope requests').map(i => `- ${i}`),
    ].join('\n');

    const principlesSection = [
      '## Key Principles',
      ...fill([...buckets.constraints, ...buckets.other], 4, `Follow ${safeDomainLabel} operational standards`).map(i => `- ${i}`),
    ].join('\n');

    // Step D — shape-specific body sections, emitting exactly the anchors scoreOutput() rewards
    let shapeBody = '';

    if (activeCodexShape === 'execute') {
      const workflowItems = buckets.workflow.length >= 3
        ? buckets.workflow.slice(0, 8)
        : fill([...buckets.workflow, ...buckets.constraints], 5, `Complete ${safeDomainLabel} task step`);
      const antiPatternItems = fill([...buckets.antiPatterns], 4, 'Avoid shortcuts that skip validation');
      const finalCheckItems = fill([...buckets.constraints.slice(3), ...buckets.other], 3, `Verify output meets ${safeDomainLabel} standard`);

      shapeBody = [
        '## Implementation Workflow',
        ...workflowItems.map((s, i) => `${i + 1}. ${s}`),
        '',
        '## Common Mistakes to Avoid',
        ...antiPatternItems.map(i => `- **Don't:** ${i}`),
        '',
        '## Final Checks',
        ...finalCheckItems.map((s, i) => `${i + 1}. ${s}`),
      ].join('\n');

    } else if (activeCodexShape === 'expertise') {
      const reviewItems = buckets.workflow.length >= 3
        ? buckets.workflow.slice(0, 6)
        : fill([...buckets.workflow, ...buckets.constraints], 4, `Evaluate ${safeDomainLabel} output`);
      const judgmentItems = fill([...buckets.constraints, ...buckets.other], 3, `Apply ${safeDomainLabel} quality criteria`);
      const pauseItems = buckets.escalate.length > 0
        ? buckets.escalate.slice(0, 4)
        : fill([...buckets.other], 3, 'Pause when intent or scope is ambiguous');

      shapeBody = [
        '## Review Workflow',
        ...reviewItems.map((s, i) => `${i + 1}. ${s}`),
        '',
        '## Judgment Framework',
        ...judgmentItems.map(i => `- ${i}`),
        '',
        '## When to Pause for Human',
        ...pauseItems.map(i => `- ${i}`),
      ].join('\n');

    } else {
      // specialist
      const doesItems     = fill([...buckets.constraints, ...buckets.other], 4, `Perform ${safeDomainLabel} analysis`);
      const doesNotItems  = fill([...buckets.refuse, ...buckets.antiPatterns], 3, `Out-of-scope ${safeDomainLabel} requests`);
      const autonomousItems = fill(buckets.constraints.slice(0, 3), 2, `Standard ${safeDomainLabel} operations with clear scope`);
      const escalateItems = fill([...buckets.escalate], 2, 'Decisions with legal, financial, or compliance impact');
      const refuseItems   = fill([...buckets.refuse], 2, `Requests outside defined ${safeDomainLabel} boundaries`);
      const workflowItems = buckets.workflow.length >= 2
        ? buckets.workflow.slice(0, 6)
        : fill([...buckets.workflow, ...buckets.constraints], 4, `Execute ${safeDomainLabel} procedure`);

      shapeBody = [
        '## Scope Boundaries',
        '**This role DOES:**',
        ...doesItems.map(i => `- ${i}`),
        '**This role does NOT:**',
        ...doesNotItems.map(i => `- ${i}`),
        '',
        '## Operating Mode',
        `**Autonomous:** ${autonomousItems.join('; ')}`,
        `**Escalate:** ${escalateItems.join('; ')}`,
        `**Refuse:** ${refuseItems.join('; ')}`,
        '',
        '## Workflow',
        ...workflowItems.map((s, i) => `${i + 1}. ${s}`),
      ].join('\n');
    }

    // Step E — final assembly (format identical to what sanitize('CODEX') expects)
    return [
      '---',
      `name: ${codexSlug}`,
      `description: "${safeDesc}"`,
      '---',
      '',
      activationSection,
      '',
      shapeBody,
      '',
      principlesSection,
    ].join('\n');
  }

  if (activeTarget === 'codex') {
    console.log('[Codex]', { sizeClass: effectiveSizeClass, shape: activeCodexShape, outcome: finalRawText ? `model:${successfulModel}` : 'fallback', elapsed: Date.now() - requestStartMs });
  }

  // Primary path — Gemini model succeeded; count the generation and respond.
  if (finalRawText) {
    const enrichedOutput = sanitize(finalRawText, activeTarget === 'codex' ? codexSlug : skillName, effectiveTemplate);

    if (quotaUsage && quotaUser) {
      try {
        const isSameSession = sessionId && quotaUsage.lastSessionId === sessionId;
        if (!isSameSession) {
          quotaUsage.dailyCount  += 1;
          quotaUsage.weeklyCount += 1;
          if (sessionId) quotaUsage.lastSessionId = sessionId;
        }
        await clerkClient.users.updateUserMetadata(userId, {
          privateMetadata: { relatchUsage: quotaUsage },
        });
      } catch (writeErr) {
        console.error('[quota] Clerk write failed:', writeErr?.message || writeErr);
      }
    }

    return res.status(200).json({ enriched: enrichedOutput, model: successfulModel });
  }

  // v2.4: Codex deterministic fallback — fires only when target === 'codex' AND all Gemini
  // models failed. Passes through sanitize('CODEX') so shape-section injection and frontmatter
  // enforcement fire identically to the primary path. Returns HTTP 200 with diagnostic signal.
  // Claude target falls through to the 503 below — no safe local approximation exists for it.
  if (activeTarget === 'codex') {
    const fallbackRaw = buildCodexFallback();
    return res.status(200).json({
      enriched: sanitize(fallbackRaw, codexSlug, 'CODEX'),
      model: 'deterministic-fallback',
      fallbackReason: lastGoogleError,
    });
  }

  // Claude target or unknown — 503 unchanged
  return res.status(503).json({
    error: 'GOOGLE_API_ERROR',
    message: `Enrichment failed. Details: ${lastGoogleError}`
  });
};
