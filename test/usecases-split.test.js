// The Codex description fallback in api/enrich.js reads the header's use_cases list. It must split on commas
// OUTSIDE quotes only: a plain split(',') turned "a refund of $1,820" into "a refund of $1" + "820" (found in the
// 2026-11-19 launch test). The expression is read from enrich.js itself, so this tests the shipped line.
//   node --test test/usecases-split.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'enrich.js'), 'utf8').replace(/\r/g, '');
const m = /const useCases = ([\s\S]*?\.slice\(0, 4\));/.exec(src);
const pick = m && new Function('fm', `return ${m[1]};`);

test('the use_cases expression is still where this test expects it', () => assert.ok(pick));

const cases = [
  ['a comma inside a quoted item stays in it', 'use_cases: ["A customer returns apparel", "A refund totals $1,820 and needs approval", "case 1"]', ['A customer returns apparel', 'A refund totals $1,820 and needs approval']],
  ['unquoted items still split', 'use_cases: [code generation, code review, refactoring]', ['code generation', 'code review', 'refactoring']],
  ['an apostrophe in plain text is a letter; single quotes group', "use_cases: [a customer's late return, 'refunds, exchanges']", ["a customer's late return", 'refunds, exchanges']],
  ['escaped quotes inside a quoted item', 'use_cases: ["the \\"FS\\" flag, final sale", "gift cards"]', ['the "FS" flag, final sale', 'gift cards']],
  ['placeholders dropped', 'use_cases: ["general use"]', []],
  ['empty list', 'use_cases: []', []],
  ['no list at all', 'name: x', []],
];
for (const [label, fm, want] of cases) test(label, () => assert.deepEqual(pick(fm), want));
