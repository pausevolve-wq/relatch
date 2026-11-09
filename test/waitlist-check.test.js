// Tests for api/waitlist-check.js: the duplicate check must only read the WAITLIST's own SplitForms form.
// The read token is account-wide, so before 2026-11-09 a Contact message (or any other form's submission)
// made its sender count as "already on the waitlist".
//   node --test test/waitlist-check.test.js
// SplitForms and Clerk are stubbed: this proves the request this endpoint sends and what it does with the
// answer. SplitForms' own `form` filter (accepts the form's public access_key; 400 for a key not on the
// account) is taken from its API reference, as no read token exists to call the real one in a test.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const WAITLIST = 'f277a53be64748cc802c0de0c130951f';
const CONTACT = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const HANDLER = path.join(__dirname, '..', 'api', 'waitlist-check.js');

// Clerk: any bearer token is a valid session
require.cache[require.resolve('@clerk/backend')] = {
  id: require.resolve('@clerk/backend'), filename: require.resolve('@clerk/backend'), loaded: true,
  exports: { verifyToken: async () => ({ sub: 'user_test' }) },
};

/** A fake SplitForms read API over a fixed set of submissions, honouring form / limit / before */
let rows = [];
let calls = [];
global.fetch = async (input, init) => {
  const url = new URL(String(input));
  calls.push({ url, auth: init?.headers?.Authorization });
  const form = url.searchParams.get('form');
  if (form && form !== WAITLIST && form !== CONTACT) return { ok: false, status: 400, json: async () => ({ error: 'form not found' }) };
  if (url.searchParams.get('fail')) return { ok: false, status: 500, json: async () => ({}) };
  const limit = Number(url.searchParams.get('limit') || 25);
  const before = url.searchParams.get('before');
  const list = rows
    .filter((r) => !form || r.form === form)
    .filter((r) => !before || r.created_at < before)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const page = list.slice(0, limit).map((r) => ({ id: r.id, form_id: `id-${r.form}`, created_at: r.created_at, data: r.data, is_spam: !!r.spam }));
  return { ok: true, status: 200, json: async () => ({ submissions: page, has_more: list.length > limit }) };
};

function row(form, email, minutesAgo, extra = {}) {
  return { id: `${form}-${email}-${minutesAgo}`, form, created_at: new Date(Date.UTC(2026, 10, 9, 12, 0) - minutesAgo * 60000).toISOString(), data: { email }, ...extra };
}
function load({ formEnv } = {}) {
  delete require.cache[HANDLER];
  if (formEnv === undefined) delete process.env.SPLITFORMS_WAITLIST_FORM; else process.env.SPLITFORMS_WAITLIST_FORM = formEnv;
  return require(HANDLER);
}
async function call(handler, { email = 'someone@example.com', auth = 'Bearer test' } = {}) {
  const res = { code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  await handler({ method: 'POST', headers: auth ? { authorization: auth } : {}, body: { email } }, res);
  return res;
}

beforeEach(() => {
  rows = [];
  calls = [];
  process.env.SPLITFORMS_READ_TOKEN = 'read-token';
});

test('a Contact message does not make its sender "already on the waitlist"', async () => {
  rows = [row(CONTACT, 'maya@example.com', 5), row(WAITLIST, 'other@example.com', 10)];
  const res = await call(load(), { email: 'maya@example.com' });
  assert.deepEqual(res.body, { alreadyJoined: false, checked: true });
});

test('a real waitlist sign-up is found (case and spaces ignored)', async () => {
  rows = [row(WAITLIST, 'Maya@Example.com ', 5)];
  const res = await call(load(), { email: '  maya@EXAMPLE.com' });
  assert.deepEqual(res.body, { alreadyJoined: true, checked: true });
});

test('every read is scoped to the waitlist form, with the read token', async () => {
  rows = [row(WAITLIST, 'a@example.com', 1)];
  await call(load(), { email: 'nobody@example.com' });
  assert.ok(calls.length >= 1);
  for (const c of calls) {
    assert.equal(c.url.searchParams.get('form'), WAITLIST);
    assert.equal(c.auth, 'Bearer read-token');
  }
});

test('paging keeps the form scope and finds a sign-up on page 2', async () => {
  rows = Array.from({ length: 150 }, (_, i) => row(WAITLIST, `user${i}@example.com`, i + 1));
  rows.push(row(CONTACT, 'early@example.com', 0)); // newest overall, but another form
  const res = await call(load(), { email: 'user140@example.com' });
  assert.deepEqual(res.body, { alreadyJoined: true, checked: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.searchParams.get('form'), WAITLIST);
  assert.ok(calls[1].url.searchParams.get('before'));
});

test('a spam-flagged sign-up does not count', async () => {
  rows = [row(WAITLIST, 'maya@example.com', 5, { spam: true })];
  const res = await call(load(), { email: 'maya@example.com' });
  assert.deepEqual(res.body, { alreadyJoined: false, checked: true });
});

test('SplitForms refusing the read (e.g. a wrong form key -> 400) fails open and says it did not check', async () => {
  rows = [row(WAITLIST, 'maya@example.com', 5)];
  const res = await call(load({ formEnv: 'not-a-form-on-this-account' }), { email: 'maya@example.com' });
  assert.deepEqual(res.body, { alreadyJoined: false, checked: false });
});

test('SPLITFORMS_WAITLIST_FORM moves the check to another form', async () => {
  rows = [row(CONTACT, 'maya@example.com', 5)];
  const res = await call(load({ formEnv: CONTACT }), { email: 'maya@example.com' });
  assert.deepEqual(res.body, { alreadyJoined: true, checked: true });
  assert.equal(calls[0].url.searchParams.get('form'), CONTACT);
});

test('no read token: unchanged fail-open, nothing fetched', async () => {
  delete process.env.SPLITFORMS_READ_TOKEN;
  const res = await call(load(), { email: 'maya@example.com' });
  assert.deepEqual(res.body, { alreadyJoined: false, checked: false });
  assert.equal(calls.length, 0);
});

test('unchanged: no bearer token is refused before anything is read', async () => {
  const res = await call(load(), { auth: null });
  assert.equal(res.code, 401);
  assert.equal(calls.length, 0);
});
