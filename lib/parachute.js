// Parachute Gating (2026-09-27) - see vault note "Relatch Parachute Gating - Plan (2026-09-27)".
//
// A deterministic quality gate for ONE model candidate, run AFTER sanitize() (sanitize is L0 and
// is never changed by this module). The gate may only do three things to a candidate: PASS it,
// REPAIR its tail, or mark it for ONE escalation. When the model chain ends without a pass, the
// caller serves the best usable candidate (pickBest). The protocol fallbacks (Codex
// deterministic-fallback, Claude 503 -> frontend fallback) fire only when NO candidate is usable
// at all: the same condition as before Parachute, never more often.
//
// BACKEND-ONLY (Manas, 2026-09-27): verdicts go to server logs / Axiom, never into a production
// response body or the UI. Pure functions: no I/O, no dependencies, nothing leaves this module.
//
//   L1 STRUCTURE  body too short / required sections missing (a sanitize()-injected placeholder
//                 section counts as missing) / truncation (provider stop reason, else the tail
//                 detector) / open code fence
//   L2 FIDELITY   quantities found nowhere in the input / program identifiers in code found
//                 nowhere in the input / max-min-total claims checked against a parsed CSV (E)
//
// Severity, worst first:
//   UNUSABLE  discard. Only when EVERY candidate is unusable does the protocol fallback run.
//   HARD      escalate once; otherwise keep as a candidate for pickBest().
//   SOFT      repair() the tail deterministically, then pass.
//   WARN      pass + log. Calibration signal only; never acts alone.
//   OK
//
// Thresholds live in DEFAULTS (one object, swept by jev-harness/parachute-calibrate.js).

const TIERS = ['OK', 'WARN', 'SOFT', 'HARD', 'UNUSABLE'];
const worse = (a, b) => (TIERS.indexOf(a) >= TIERS.indexOf(b) ? a : b);

// Required sections per Claude template / Codex shape: scoreOutput()'s required anchors plus
// the prompts' [REQUIRED] sections (api/enrich.js). jev-harness/parachute-test.js asserts these
// stay in sync with enrich.js. Codex specialist "## Workflow" is [REQUIRED] in the prompt but
// legitimately skipped on linear sources (see scoreOutput), so it is not listed.
const REQUIRED = {
  A: ['## Identity & Role', '## Signature Patterns', '## Voice & Language', '## What to Always Do'],
  B: ['## Role & Capability', '## Example Patterns', '## What to Always Write'],
  C: ['## Domain Role', '## Decision Process'],
  D: ['## Domain Role', '## Decision Framework'],
  E: ['## Data Scope', '## Key Metrics'],
  execute: ['## When to Activate', '## Implementation Workflow', '## Key Principles', '## Common Mistakes to Avoid', '## Final Checks'],
  expertise: ['## When to Activate', '## Judgment Framework', '## When to Pause for Human', '## Review Workflow'],
  specialist: ['## When to Activate', '## Scope Boundaries', '## Operating Mode', '## Escalation Rules', '## Common Mistakes to Avoid', '## Key Principles'],
};

// Calibrated 2026-09-27 on 365 saved outputs (jev-harness/parachute-calibrate.js; sweep table in
// the vault plan note). hardInventedIds 3 is the loosest value that still catches both invented-
// identifier classes (2 costs ~5 points of good-file pass rate; 4 misses the B misroute).
const DEFAULTS = {
  minChars: 200,              // body shorter than this (frontmatter and injected placeholders excluded) -> UNUSABLE
  hardMissingAnchors: 2,      // this many required sections missing or placeholder-only -> HARD
  unusableAnchorShare: 0.5,   // truncated AND fewer than this share of required sections present -> UNUSABLE
  hardInventedIds: 3,         // distinct program identifiers in code that appear nowhere in the input -> HARD
  hardInventedNums: Infinity, // quantities that appear nowhere in the input -> HARD (Infinity = WARN only)
  detectorHard: true,         // ragged tail with NO provider stop reason -> HARD truncation (false: SOFT)
  claimCheck: true,           // Template E: verify max/min/total claims against the parsed CSV
  minRetention: 0.5,          // C/D/E/Codex-execute: share of source quantities kept, below -> WARN
};

const TRUNC_STOPS = new Set(['MAX_TOKENS', 'length', 'max_tokens']);
const NATURAL_STOPS = new Set(['STOP', 'stop', 'end_turn']);

// -- text structure ---------------------------------------------------------------

// state: 'closed' | 'unclosed' (opened, no closing --- before the first ## heading: what
// sanitize() repairs since PR #17; older outputs and the frontend's own repair both still meet
// it) | 'none' (no opening ---; sanitize() always adds one, so this means sanitize did not run).
// Delimiter lines may carry trailing spaces ("--- " is still a valid YAML marker).
function splitFrontmatter(text) {
  const m = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  const firstHeading = text.indexOf('\n## ');
  if (m && (firstHeading === -1 || m[0].length <= firstHeading + 1)) return { fm: m[1], body: text.slice(m[0].length), state: 'closed' };
  if (/^---[ \t]*\n/.test(text) && firstHeading > 3) return { fm: text.slice(text.indexOf('\n') + 1, firstHeading), body: text.slice(firstHeading + 1), state: 'unclosed' };
  return { fm: null, body: text, state: 'none' };
}

// ## sections of a body; headings inside ``` fences are code, not sections.
function sections(body) {
  const out = [];
  let cur = { heading: null, lines: [] };
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && /^## /.test(line)) { out.push(cur); cur = { heading: line.trim(), lines: [] }; continue; }
    cur.lines.push(line);
  }
  out.push(cur);
  return out;
}

// What sanitize() injects for a missing section: bracketed placeholder lines, optionally under
// bold labels ("**This role DOES:**" / "- [Review source document ...]"). A model that wrote
// "[Not extracted ...]" instead of content produces the same shape. Markdown links "[x](y)" and
// checkboxes "- [ ] x" do not match: the line must END at the closing bracket.
const PLACEHOLDER_LINE = /^\s*(?:[-*]\s+)?(?:\*\*[^*\n]+\*\*:?\s*)?\[[^\]\n]*\]\s*$/;
const LABEL_LINE = /^\s*\*\*[^*\n]+\*\*:?\s*$/;
function isPlaceholder(lines) {
  const real = lines.filter((l) => l.trim());
  return real.length > 0 && real.some((l) => PLACEHOLDER_LINE.test(l)) && real.every((l) => PLACEHOLDER_LINE.test(l) || LABEL_LINE.test(l));
}
const filled = (lines) => lines.some((l) => l.trim() && !PLACEHOLDER_LINE.test(l) && !LABEL_LINE.test(l));

// sanitize() APPENDS its placeholder sections at the end, so a cut-off file can end in a tidy
// injected section. Peel those off before judging the tail.
function peelInjectedTail(secs) {
  const content = secs.slice();
  const tail = [];
  while (content.length > 1 && content[content.length - 1].heading && isPlaceholder(content[content.length - 1].lines)) tail.unshift(content.pop());
  return { content, tail };
}
const join = (secs) => secs.map((s) => (s.heading ? [s.heading, ...s.lines] : s.lines).join('\n')).join('\n');

// Tail detector (from jev-harness/fidelity.js truncated(), which caught 4/4 known truncations
// with 0 false positives on the 2026-09-27 corpus). Returns the problem kind or null.
// fidelity.js's list plus connectives that never end a complete line ("...before starting, then").
// Words that CAN end one ("if any", "or both", "whether or not", "I think so") stay out.
const FUNCTION_WORD = /\b(the|a|an|is|are|was|of|to|in|on|and|or|with|for|it|its|their|that|this|by|as|at|from|be|if|user's|then|but|because|which|whose|than|into|onto|via|your|our|while|until|unless)$/i;
const ENDS_CLEAN = /[.!?:;)`"'*\]]$/;
function tailProblem(content) {
  if ((content.match(/```/g) || []).length % 2) return 'open_fence';
  const lines = content.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.pop() || '';
  if (!last) return 'empty';
  if (/^#/.test(last)) return 'empty_heading';
  if (/^\|/.test(last)) return !/\|$/.test(last) || (last.match(/\|/g) || []).length < 3 ? 'half_row' : null;
  if (ENDS_CLEAN.test(last)) return null;
  if (FUNCTION_WORD.test(last)) return 'mid_sentence';
  // Otherwise judge by the document's own habit: most of its prose/list lines end in punctuation?
  const peers = lines.filter((l) => !/^(#|\||```)/.test(l) && l.length > 20);
  return peers.length >= 5 && peers.filter((l) => ENDS_CLEAN.test(l)).length / peers.length >= 0.6 ? 'mid_sentence' : null;
}

// -- fidelity helpers (numbers from jev-harness/fidelity.js) ---------------------------

// fold no-break spaces and unicode dashes first ("10-minute" with a no-break hyphen once read as
// a different number). Characters are built from char codes so this file stays pure ASCII.
const cc = (...codes) => String.fromCharCode(...codes);
const SPACES = new RegExp(`[${cc(0xa0, 0x2007, 0x202f, 0x2009)}]`, 'g');
const DASHES = new RegExp(`[${cc(0x2010)}-${cc(0x2015)}${cc(0x2212)}]`, 'g');
const fold = (t) => t.replace(SPACES, ' ').replace(DASHES, '-');

// A 0-9 integer counts only as a quantity (unit after it, or a comparator before it); otherwise
// it is list/count noise ("3 principles"). 10+ and decimals always count.
const UNIT = /^\s?-?\s?(%|percent|ms\b|s\b|secs?\b|seconds?\b|mins?\b|minutes?\b|h\b|hrs?\b|hours?\b|days?\b|business days\b|weeks?\b|months?\b|x\b|[kmg]b\b|k\b|rps\b|retries\b|attempts\b|times\b)/i;
const COMPARATOR = new RegExp(`(?:[<>${cc(0x2264, 0x2265)}]=?|above|below|under|over|within|at least|at most|every|after|than) *$`, 'i');
function nums(text) {
  const out = new Set();
  for (const line of fold(text).replace(/\*\*/g, '').split('\n')) {
    const l = line.replace(/^\s*(?:[-*]\s+)?\d+[.)]\s/, ''); // list ordinals
    for (const m of l.matchAll(/(?<![\w.])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)) {
      const v = parseFloat(m[0].replace(/,/g, ''));
      const quantity = UNIT.test(l.slice(m.index + m[0].length)) || COMPARATOR.test(l.slice(0, m.index));
      if (!Number.isInteger(v) || v >= 10 || quantity) out.add(String(v));
    }
  }
  return out;
}

// Spelled-out numbers in the SOURCE ground digits in the output ("eleven times" -> 11).
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function wordNums(text) {
  const out = new Set();
  const lc = text.toLowerCase();
  for (const m of lc.matchAll(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](one|two|three|four|five|six|seven|eight|nine))?\b/g)) out.add(String(TENS[m[1]] + (m[2] ? ONES.indexOf(m[2]) : 0)));
  for (const m of lc.matchAll(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/g)) out.add(String(ONES.indexOf(m[1])));
  for (const m of lc.matchAll(/\bone hundred\b|\ba hundred\b/g)) out.add('100');
  return out;
}

// Program identifiers inside code (fenced blocks and inline spans): snake_case or camelCase names
// only. Plain words, flags and dotted library calls (console.log, os.path.join) are not counted,
// and each dotted part is judged on its own. Placeholders ([x], <x>, {{x}}) are stripped first.
function codeIdentifiers(body) {
  const ids = new Set();
  const collect = (code) => {
    for (const tok of code.replace(/\[[^\]\n]*\]|<[^>\n]*>|\{\{[^}\n]*\}\}/g, ' ').match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g) || []) {
      for (const part of tok.split('.')) {
        if (part.length >= 4 && (/[A-Za-z0-9]_[A-Za-z0-9]/.test(part) || /[a-z][A-Z]/.test(part))) ids.add(part);
      }
    }
  };
  for (const m of body.matchAll(/```[^\n]*\n([\s\S]*?)(?:```|$)/g)) collect(m[1]);
  for (const m of body.replace(/```[\s\S]*?(?:```|$)/g, ' ').matchAll(/`([^`\n]{2,120})`/g)) collect(m[1]);
  return ids;
}

// -- Template E: computed-claim check against a parsed CSV ------------------------------
// Verify, don't guess: only a plain CSV (no quotes, rectangular, 3+ data rows), only claims whose
// direction is unambiguous, only when exactly one column is clearly named, and only against a
// number that actually appears in that column. Anything else is skipped, never flagged.

const toNum = (s) => {
  const t = String(s).trim().replace(/[$,\s]/g, '').replace(/%$/, '');
  return /^[-+]?\d+(?:\.\d+)?$/.test(t) ? parseFloat(t) : null;
};

function parseCsv(src) {
  const lines = src.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 4 || lines.some((l) => l.includes('"'))) return null;
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  if (header.length < 3) return null;
  const rows = lines.slice(1).map((l) => l.split(',').map((c) => c.trim()));
  if (rows.some((r) => r.length !== header.length)) return null;
  const numeric = {};
  header.forEach((h, i) => {
    const vals = rows.map((r) => toNum(r[i]));
    if (vals.every((v) => v !== null)) numeric[i] = vals;
  });
  return Object.keys(numeric).length ? { header, rows, numeric } : null;
}

// Words a claim may use for a column: the header's own tokens plus a few finance aliases.
const ALIAS = { pct: ['percentage', 'percent', '%'], usd: ['absolute', 'dollar', 'dollars', '$'], headcount: ['heads', 'staff', 'fte'] };
function columnWords(h) {
  const toks = h.split(/[_\s]+/).filter(Boolean);
  const words = new Set(toks.filter((t) => t.length >= 3));
  for (const t of toks) for (const a of ALIAS[t] || []) words.add(a);
  return words;
}

const SUPER_MAX = /\b(largest|highest|biggest|greatest|maximum|max)\b/i;
// "at least" is a hedge, not a claim ("for at least Engineering Q3" once read as a min claim).
const SUPER_MIN = /\b(smallest|lowest|minimum|min)\b|(?<!\bat )\bleast\b/i;
const TOTAL = /\b(total|sum|combined|aggregate)\b/i;
// A direction word makes "largest" ambiguous (largest favorable? largest under-spend?) - skip.
const QUALIFIER = /\b(favou?rable|unfavou?rable|negative|positive|over[- ]?spend\w*|under[- ]?spend\w*|over[- ]?budget|under[- ]?budget|over[- ]?run|under[- ]?run|savings?|surplus|deficit|shortfall|growth|increase|decrease|change|drop|rise|spike|jump|gain|loss)\b/i;

// Numbers in a clause with their positions; "k"/"m" suffixes scale ("1.1M").
function claimNumbers(clause) {
  const out = [];
  for (const m of clause.matchAll(/[-+]?\$?\d[\d,]*(?:\.\d+)?\s?([kKmM])?(?![\w])/g)) {
    let v = toNum(m[0].replace(/[kKmM]$/, '').trim());
    if (v === null) continue;
    if (m[1]) v *= /k/i.test(m[1]) ? 1e3 : 1e6;
    out.push({ v, at: m.index });
  }
  return out;
}

function checkClaims(body, csv) {
  const wrong = [];
  const cols = Object.keys(csv.numeric).map(Number);
  for (const rawLine of body.split('\n')) {
    if (/^\s*\|/.test(rawLine) || /^\s*#/.test(rawLine)) continue; // tables/headings restate data, not claims
    for (const clause of fold(rawLine).replace(/\*\*/g, '').split(new RegExp(`[;${cc(0x2014)}]|[.] `))) {
      const isMax = SUPER_MAX.test(clause), isMin = SUPER_MIN.test(clause), isTotal = TOTAL.test(clause);
      if ((isMax ? 1 : 0) + (isMin ? 1 : 0) + (isTotal ? 1 : 0) !== 1 || QUALIFIER.test(clause)) continue;
      const kw = (isMax ? SUPER_MAX : isMin ? SUPER_MIN : TOTAL).exec(clause);
      // The column is named in the few WORDS right after the superlative ("largest absolute
      // variance"); a % or $ that belongs to a number is not a column name.
      const kwEnd = kw.index + kw[0].length;
      const after = clause.slice(kwEnd).toLowerCase().split(/[^a-z&]+/).filter(Boolean).slice(0, 4);
      const scored = cols.map((c) => [c, [...columnWords(csv.header[c])].filter((w) => after.includes(w)).length]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
      if (!scored.length || (scored.length > 1 && scored[0][1] === scored[1][1])) continue; // unnamed or tie: don't guess
      const col = scored[0][0], vals = csv.numeric[col];
      const numbers = claimNumbers(clause);
      if (isTotal) {
        // A total must equal the column sum over all rows, or over the rows of one category the
        // clause names ("Q3 total budget"). Checked only for a number larger than any single cell.
        const lc = clause.toLowerCase();
        const sums = [vals.reduce((a, b) => a + b, 0)];
        csv.header.forEach((h, i) => {
          if (csv.numeric[i]) return;
          for (const cat of new Set(csv.rows.map((r) => r[i].toLowerCase()))) {
            if (cat.length >= 2 && new RegExp(`(^|[^a-z0-9])${cat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(lc)) sums.push(csv.rows.reduce((a, r, k) => a + (r[i].toLowerCase() === cat ? vals[k] : 0), 0));
          }
        });
        const maxCell = Math.max(...vals.map(Math.abs));
        const claimed = numbers.map((n) => n.v).filter((n) => Math.abs(n) > maxCell);
        if (claimed.length && !claimed.some((n) => sums.some((s) => Math.abs(n - s) <= Math.max(1, Math.abs(s) * 0.02)))) {
          wrong.push(`total ${csv.header[col]}: ${claimed[0]} matches no row sum`);
        }
        continue;
      }
      // The claimed value is the column value NEAREST the superlative, after it first
      // ("from a Q2 over-spend (3.5%) to the largest ..." must not read 3.5 as the claim).
      const inCol = numbers.filter((n) => vals.includes(n.v)).sort((a, b) => ((a.at < kwEnd) - (b.at < kwEnd)) || (Math.abs(a.at - kwEnd) - Math.abs(b.at - kwEnd)));
      if (!inCol.length) continue;
      const claimed = inCol[0].v;
      const signed = isMax ? Math.max(...vals) : Math.min(...vals);
      const absExt = isMax ? Math.max(...vals.map(Math.abs)) : Math.min(...vals.map(Math.abs));
      if (claimed !== signed && Math.abs(claimed) !== absExt) wrong.push(`${isMax ? 'max' : 'min'} ${csv.header[col]}: claims ${claimed}, data says ${signed === absExt ? signed : `${signed} (|${absExt}|)`}`);
    }
  }
  return wrong;
}

const GENERIC = ['write clean code', 'be professional', 'consider all options', 'make informed decisions', 'think carefully', 'best practices', 'high quality output', 'communicate effectively'];

// -- the gate ------------------------------------------------------------------------

/**
 * inspect(candidate, ctx) -> report
 *   candidate: { text: sanitize()d output, stopReason?: provider finish reason }
 *   ctx: { template: 'A'..'E' | 'CODEX', shape?: 'execute'|'expertise'|'specialist',
 *          source: the document text the prompt carried, vocab?: other input text the output may
 *          legitimately echo (the prompt, file name, domain fields), opts?: DEFAULTS overrides }
 *   report: { tier, findings: [{ code, tier, detail }], anchors: { required, present, missing },
 *             chars, tail, ms }
 * Never throws: a malformed candidate is UNUSABLE.
 */
function inspect(candidate, ctx = {}) {
  const t0 = Date.now();
  const o = { ...DEFAULTS, ...(ctx.opts || {}) };
  const findings = [];
  const add = (code, tier, detail) => findings.push({ code, tier, detail });
  const text = typeof candidate?.text === 'string' ? candidate.text.replace(/\r\n?/g, '\n') : '';
  const stop = candidate?.stopReason;
  const key = ctx.template === 'CODEX' ? (REQUIRED[ctx.shape] ? ctx.shape : 'execute') : (REQUIRED[ctx.template] ? ctx.template : 'A');
  const required = REQUIRED[key];

  const { fm, body, state: fmState } = splitFrontmatter(text.trim());
  const secs = sections(body);
  const { content, tail } = peelInjectedTail(secs);
  const contentText = join(content);
  const chars = contentText.trim().length;

  const missing = required.filter((a) => !secs.some((s) => s.heading && s.heading.startsWith(a) && filled(s.lines)));
  const present = required.length - missing.length;

  // Frontmatter problems never make a file UNUSABLE: the body is the product, and the frontend's
  // fixAiYamlFrontmatter() runs on every result anyway. Discarding a good body over its YAML shape
  // would push traffic into the protocol fallbacks, which is exactly what Parachute must not do.
  if (fmState === 'none') add('NO_FRONTMATTER', 'HARD', 'no opening --- (sanitize did not run?)');
  else if (fmState === 'unclosed') add('FRONTMATTER_UNCLOSED', 'SOFT', 'no closing --- before the first ## heading');
  if (fmState !== 'none' && !/^name:/m.test(fm)) add('NO_NAME', 'WARN', 'frontmatter has no name:');
  if (chars < o.minChars) add('EMPTY', 'UNUSABLE', `${chars} chars of content`);

  // truncation: the provider's stop reason is proof; without one, the tail detector decides
  const problem = chars ? tailProblem(contentText) : 'empty';
  let truncated = false;
  if (TRUNC_STOPS.has(stop)) { truncated = true; add('TRUNCATED', 'HARD', `stop reason ${stop}${problem ? `, tail ${problem}` : ''}`); }
  else if (problem && problem !== 'empty') {
    if (NATURAL_STOPS.has(stop) || !o.detectorHard) add(`TAIL_${problem.toUpperCase()}`, 'SOFT', 'ragged tail on a natural stop');
    else { truncated = true; add('TRUNCATED', 'HARD', `tail ${problem}, no stop reason`); }
  }
  if (truncated && present / required.length < o.unusableAnchorShare) add('TRUNCATED_EARLY', 'UNUSABLE', `${present}/${required.length} required sections`);

  // All required sections missing is HARD for every template (C and D have only two).
  if (missing.length >= o.hardMissingAnchors || (missing.length && missing.length === required.length)) add('MISSING_SECTIONS', 'HARD', missing.join(', '));
  else if (missing.length) add('MISSING_SECTION', 'WARN', missing.join(', '));

  // L2: fidelity against everything the model was given
  const src = fold(String(ctx.source || ''));
  if (src && chars) {
    const srcLc = src.toLowerCase();
    const vocabLc = fold(String(ctx.vocab || '')).toLowerCase();
    const bodyF = fold(contentText);

    const srcQuantities = nums(src);
    const srcNums = new Set([...srcQuantities, ...wordNums(src)]);
    const inventedNums = [...nums(bodyF)].filter((n) => !srcNums.has(n) && !srcLc.includes(n) && !vocabLc.includes(n));
    if (inventedNums.length >= o.hardInventedNums) add('INVENTED_NUMBERS', 'HARD', inventedNums.slice(0, 5).join(', '));
    else if (inventedNums.length) add('INVENTED_NUMBER', 'WARN', inventedNums.slice(0, 5).join(', '));

    const inventedIds = [...codeIdentifiers(bodyF)].filter((id) => {
      const lc = id.toLowerCase();
      return !srcLc.includes(lc) && !srcLc.includes(lc.replace(/_/g, '-')) && !vocabLc.includes(lc);
    });
    if (inventedIds.length >= o.hardInventedIds) add('INVENTED_IDENTIFIERS', 'HARD', inventedIds.slice(0, 6).join(', '));
    else if (inventedIds.length) add('INVENTED_IDENTIFIER', 'WARN', inventedIds.join(', '));

    if (o.claimCheck && key === 'E') {
      const csv = parseCsv(src);
      if (csv) for (const w of checkClaims(bodyF, csv)) add('WRONG_CLAIM', 'HARD', w);
    }

    if (['C', 'D', 'E', 'execute'].includes(key) && srcQuantities.size >= 3) {
      const outNums = nums(bodyF);
      const kept = [...srcQuantities].filter((n) => outNums.has(n)).length / srcQuantities.size;
      if (kept < o.minRetention) add('LOW_RETENTION', 'WARN', `${Math.round(kept * 100)}% of source quantities kept`);
    }
  }
  const generic = GENERIC.filter((p) => contentText.toLowerCase().includes(p)).length;
  if (generic > 3) add('GENERIC', 'WARN', `${generic} generic phrases`);

  const tier = findings.reduce((acc, f) => worse(f.tier, acc), 'OK');
  return { tier, findings, anchors: { required: required.length, present, missing }, chars, tail: problem, ms: Date.now() - t0 };
}

/** decide(report, { canEscalate }) -> 'PASS' | 'REPAIR' | 'ESCALATE' | 'KEEP' | 'DISCARD' */
function decide(report, { canEscalate = true } = {}) {
  if (report.tier === 'UNUSABLE') return 'DISCARD';
  if (report.tier === 'HARD') return canEscalate ? 'ESCALATE' : 'KEEP';
  if (report.tier === 'SOFT') return 'REPAIR';
  return 'PASS';
}

/**
 * repair(text, ctx) -> { text, applied: [] }
 * Deterministic repairs at the two ends of the file only, never mid-file:
 *   head  close an opened-but-unclosed frontmatter before the first ## heading (the same repair
 *         sanitize() has made since PR #17)
 *   tail  close an open fence, drop a half table row or an empty trailing heading, cut a
 *         dangling half sentence back to its last sentence end (sanitize()-injected placeholder
 *         sections are peeled off first and re-appended untouched)
 * Returns the input unchanged when the repair would not strictly improve it.
 */
function repair(text, ctx = {}, candidate = {}) {
  const before = inspect({ ...candidate, text }, ctx);
  let src = String(text).replace(/\r\n?/g, '\n').trim();
  const applied = [];
  if (splitFrontmatter(src).state === 'unclosed') {
    const i = src.indexOf('\n## ');
    src = src.slice(0, i) + '\n---\n' + src.slice(i);
    applied.push('closed frontmatter');
  }
  const { body: afterFm } = splitFrontmatter(src);
  const head = src.slice(0, src.length - afterFm.length);
  const { content, tail } = peelInjectedTail(sections(afterFm));
  const original = join(content).replace(/\s+$/, '');
  let body = original;
  const kind = tailProblem(body);
  let fix = null;
  if (kind === 'open_fence') { body += '\n```'; fix = 'closed code fence'; }
  else if (kind === 'half_row' || kind === 'empty_heading') {
    const lines = body.split('\n');
    lines.pop();
    body = lines.join('\n').replace(/\s+$/, '');
    fix = kind === 'half_row' ? 'dropped half table row' : 'dropped empty trailing heading';
  } else if (kind === 'mid_sentence') {
    const lines = body.split('\n');
    const last = lines[lines.length - 1];
    const cut = Math.max(last.lastIndexOf('. '), last.lastIndexOf('! '), last.lastIndexOf('? '));
    if (cut > 0) { lines[lines.length - 1] = last.slice(0, cut + 1); fix = 'cut half sentence'; }
    else if (/^\s*(?:[-*]|\d+[.)])\s/.test(last) && lines.length > 1) { lines.pop(); fix = 'dropped half list item'; }
    body = lines.join('\n').replace(/\s+$/, '');
  }
  if (fix && tailProblem(body) !== kind) applied.push(fix);
  else body = original; // the tail fix did not fix the tail: leave it exactly as it was
  if (!applied.length) return { text, applied: [] };
  const out = (head + body + (tail.length ? '\n\n' + join(tail) : '')).trim();
  const after = inspect({ ...candidate, text: out }, ctx);
  const rank = (r) => TIERS.indexOf(r.tier);
  // keep the repair only if it fixed the tail and made nothing worse
  if (rank(after) > rank(before) || after.anchors.present < before.anchors.present) return { text, applied: [] };
  return { text: out, applied };
}

/**
 * pickBest([{ text, report }]) -> the candidate to serve, or null when none is usable (only then
 * do the protocol fallbacks run). Order: not UNUSABLE, not HARD, fewer HARD findings, more
 * required sections present, longer content.
 */
function pickBest(candidates) {
  const usable = (candidates || []).filter((c) => c && c.report && c.report.tier !== 'UNUSABLE');
  if (!usable.length) return null;
  const key = (c) => [c.report.tier === 'HARD' ? 0 : 1, -c.report.findings.filter((f) => f.tier === 'HARD').length, c.report.anchors.present / Math.max(1, c.report.anchors.required), c.report.chars];
  return usable.slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  })[0];
}

module.exports = { inspect, decide, repair, pickBest, DEFAULTS, REQUIRED, TIERS, _internal: { tailProblem, codeIdentifiers, parseCsv, checkClaims, nums, wordNums, isPlaceholder, peelInjectedTail, sections } };
