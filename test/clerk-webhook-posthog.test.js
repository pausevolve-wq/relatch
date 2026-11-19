// Tests for api/clerk-webhook.js's PostHog events (2026-11-19): account_created on user.created,
// account_deleted after a user.deleted removed the history, and that PostHog never breaks the webhook.
//   node --test test/clerk-webhook-posthog.test.js
// Svix is the real library (real signatures); Neon and PostHog (fetch) are stubbed.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');

const SECRET = 'whsec_' + Buffer.from('relatch-test-secret-0123456789ab').toString('base64');
process.env.CLERK_WEBHOOK_SIGNING_SECRET = SECRET;
process.env.DATABASE_URL = 'postgres://stub';

// Neon: DELETE ... RETURNING id answers two rows
require.cache[require.resolve('@neondatabase/serverless')] = {
  id: require.resolve('@neondatabase/serverless'), filename: require.resolve('@neondatabase/serverless'), loaded: true,
  exports: { neon: () => async () => [{ id: 'a' }, { id: 'b' }] },
};

let posted = [];
let posthogMode = 'ok';
global.fetch = async (url, init) => {
  if (posthogMode === 'down') throw new Error('ECONNREFUSED');
  if (posthogMode === 'hang') return new Promise(() => {});
  posted.push({ url: String(url), body: JSON.parse(init.body) });
  return { ok: true, status: 200 };
};

const { Webhook } = require('svix');
const handler = require(path.join(__dirname, '..', 'api', 'clerk-webhook.js'));

function call(payload, { badSignature = false } = {}) {
  const raw = JSON.stringify(payload);
  const id = 'msg_' + Math.random().toString(36).slice(2);
  const at = new Date();
  const signature = new Webhook(SECRET).sign(id, at, raw);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = { 'svix-id': id, 'svix-timestamp': String(Math.floor(at.getTime() / 1000)), 'svix-signature': badSignature ? 'v1,AAAA' : signature };
  return new Promise((resolve) => {
    const res = { code: 0, status(c) { this.code = c; return this; }, json(b) { resolve({ status: this.code, body: b }); return this; } };
    handler(req, res);
  });
}

beforeEach(() => { posted = []; posthogMode = 'ok'; });

test('user.created sends account_created for the Clerk user id, with the sign-up method', async () => {
  const r = await call({ type: 'user.created', timestamp: 1763500000000, data: { id: 'user_new', created_at: 1763500000000, external_accounts: [{ provider: 'oauth_google' }] } });
  assert.equal(r.status, 200);
  assert.equal(posted.length, 1);
  const e = posted[0].body;
  assert.equal(posted[0].url, 'https://us.i.posthog.com/i/v0/e/');
  assert.equal(e.event, 'account_created');
  assert.equal(e.distinct_id, 'user_new');
  assert.equal(e.properties.method, 'google');
  assert.equal(e.properties.$geoip_disable, true, 'Vercel\'s location must not become the person\'s');
  assert.equal(e.timestamp, new Date(1763500000000).toISOString());
  assert.match(e.api_key, /^phc_/);
});

test('an account with no external account signed up by email', async () => {
  await call({ type: 'user.created', data: { id: 'user_mail', created_at: 1763500000000, external_accounts: [] } });
  assert.equal(posted[0].body.properties.method, 'email');
});

test('user.deleted still removes history, then sends account_deleted', async () => {
  const r = await call({ type: 'user.deleted', timestamp: 1763500000000, data: { id: 'user_gone', deleted: true } });
  assert.deepEqual(r, { status: 200, body: { deleted: 2 } });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.event, 'account_deleted');
  assert.equal(posted[0].body.distinct_id, 'user_gone');
  assert.equal(posted[0].body.properties.skills_removed, 2);
});

test('PostHog down or hanging never fails the webhook', async () => {
  posthogMode = 'down';
  assert.equal((await call({ type: 'user.created', data: { id: 'user_x', created_at: 1 } })).status, 200);
  assert.equal((await call({ type: 'user.deleted', data: { id: 'user_y' } })).status, 200);
  posthogMode = 'hang';
  const t = Date.now();
  assert.equal((await call({ type: 'user.created', data: { id: 'user_z', created_at: 1 } })).status, 200);
  assert.ok(Date.now() - t < 3000, 'gives up on PostHog after about 2 s');
});

test('a bad signature sends nothing', async () => {
  const r = await call({ type: 'user.created', data: { id: 'user_forged' } }, { badSignature: true });
  assert.equal(r.status, 400);
  assert.equal(posted.length, 0);
});

test('other event types are ignored and send nothing', async () => {
  const r = await call({ type: 'session.created', data: { id: 'sess_1' } });
  assert.deepEqual(r, { status: 200, body: { ignored: 'session.created' } });
  assert.equal(posted.length, 0);
});

test('user.created without an id sends nothing', async () => {
  const r = await call({ type: 'user.created', data: {} });
  assert.equal(r.status, 200);
  assert.equal(posted.length, 0);
});
