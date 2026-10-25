// 2026-10-24: skill history for signed-in users, stored in Neon (Postgres 18, aws-us-east-1).
// Runbook: vault "Relatch Infra System Design & Runbook (2026-10-21)", Flows C + D, Sections
// 11.4-11.6 and 12. Routes (vercel.json rewrites /api/skills/:id to ?id=):
//   GET    /api/skills       newest 30, no skill text (fast sidebar)
//   GET    /api/skills/:id   one skill with its files
//   PUT    /api/skills/:id   save or rename (idempotent: same id = same row), trims to newest 30
//   DELETE /api/skills/:id   delete one
//   DELETE /api/skills       clear history
//
// Hard rules:
// - Off unless HISTORY_MODE=on (any other value answers 404): the reverse switch.
// - user_id ALWAYS comes from the verified Clerk JWT, never from the body or URL, and every
//   statement filters on it. The primary key is (user_id, id), so a guessed id can never reach
//   another person's row.
// - The database role (relatch_app) can only read and write rows: no DDL.
// - Never logs skill text. Axiom gets { endpoint, status, reason, userId, ip } on every non-2xx.
// - The source document, its text and its file name are never sent here and never stored.
const { verifyToken } = require('@clerk/backend');
const { neon } = require('@neondatabase/serverless');
const { Redis } = require('@upstash/redis');
const { Axiom } = require('@axiomhq/js');
const { reserveSkillSave, reserveSkillRequest } = require('../lib/usage-limits');

// HTTP mode: one fetch per query, no connection pool to exhaust on serverless. Tagged templates
// send every value as a bind parameter, so SQL injection is structurally impossible.
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;
const axiomClient = process.env.AXIOM_TOKEN
  ? new Axiom({ token: process.env.AXIOM_TOKEN, edge: 'us-east-1.aws.edge.axiom.co' })
  : null;

async function logToAxiom(event) {
  if (!axiomClient) return;
  try {
    axiomClient.ingest('relatch-security', [{ ...event, _time: new Date().toISOString() }]);
    await Promise.race([
      axiomClient.flush(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('axiom flush timeout')), 2000)),
    ]);
  } catch (err) {
    console.log('[axiom] log failed:', err?.message || 'unknown');
  }
}

const HISTORY_CAP = 30;
const MAX_FILES_BYTES = 262144; // 256 KB, same bound as the size_bytes CHECK in the table
const SKILL_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Code points, not UTF-16 units: matches Postgres char_length() in the table's CHECKs.
const chars = s => [...s].length;

// Section 11.4. Returns { value } or { error, status }.
function validateSkill(body) {
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return { status: 400, error: 'INVALID_JSON' }; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'INVALID_BODY' };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (chars(name) < 1 || chars(name) > 120) return { status: 400, error: 'INVALID_NAME' };
  if (body.target !== 'claude' && body.target !== 'codex') return { status: 400, error: 'INVALID_TARGET' };
  if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > 3) return { status: 400, error: 'INVALID_FILES' };
  const files = [];
  for (const f of body.files) {
    const fileName = f && typeof f.name === 'string' ? f.name.trim() : '';
    if (chars(fileName) < 1 || chars(fileName) > 120 || typeof f.content !== 'string') return { status: 400, error: 'INVALID_FILES' };
    files.push({ name: fileName, content: f.content, degraded: f.degraded === true }); // only these keys are stored
  }
  const filesJson = JSON.stringify(files);
  const sizeBytes = Buffer.byteLength(filesJson);
  if (sizeBytes > MAX_FILES_BYTES) return { status: 413, error: 'SKILL_TOO_LARGE' };
  const seconds = typeof body.seconds === 'number' && Number.isFinite(body.seconds) && body.seconds >= 0 && body.seconds < 100000
    ? body.seconds : null;
  return { value: { name, target: body.target, filesJson, sizeBytes, seconds, degraded: body.degraded === true } };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.relatch.online');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for'] || null;
  let userId = null;
  const fail = async (status, error, reason) => {
    await logToAxiom({ endpoint: 'skills', status, reason: reason || error, userId, ip });
    return res.status(status).json({ error });
  };

  // The reverse switch: with history off, the endpoint does not exist.
  if (process.env.HISTORY_MODE !== 'on') return fail(404, 'NOT_FOUND', 'history_mode_off');

  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return fail(401, 'Unauthorized', 'missing_bearer');
  try {
    const payload = await verifyToken(authHeader.slice(7), { secretKey: process.env.CLERK_SECRET_KEY });
    userId = payload.sub;
    if (!userId) throw new Error('No userId in token');
  } catch {
    return fail(401, 'Invalid session', 'invalid_session');
  }

  if (!sql) return fail(503, 'HISTORY_UNAVAILABLE', 'db_unconfigured');

  const id = req.query?.id;
  if (id !== undefined && (typeof id !== 'string' || !SKILL_ID.test(id))) return fail(400, 'INVALID_ID');

  // One daily budget per user for everything below, because every request can wake Neon (see
  // reserveSkillRequest for why it is daily). Over it, V3 keeps its local copy until tomorrow.
  // Fails OPEN like the save limiter: a Redis outage must not take history down with it.
  try {
    if (!(await reserveSkillRequest(redis, userId))) return fail(429, 'TOO_MANY_REQUESTS', 'skills_daily_budget');
  } catch (err) {
    console.log('[skills] request budget unavailable, allowing:', err?.message || 'unknown');
  }

  try {
    if (req.method === 'GET' && id === undefined) {
      const rows = await sql`SELECT id, name, target, created_at FROM skills
                             WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${HISTORY_CAP}`;
      return res.status(200).json(rows.map(r => ({ id: r.id, name: r.name, target: r.target, createdAt: r.created_at })));
    }

    if (req.method === 'GET') {
      const rows = await sql`SELECT id, name, target, created_at, seconds, degraded, files FROM skills
                             WHERE user_id = ${userId} AND id = ${id}`;
      if (!rows.length) return fail(404, 'NOT_FOUND', 'skill_not_found');
      const r = rows[0];
      return res.status(200).json({ id: r.id, name: r.name, target: r.target, createdAt: r.created_at, seconds: r.seconds, degraded: r.degraded, files: r.files });
    }

    if (req.method === 'PUT') {
      if (id === undefined) return fail(400, 'INVALID_ID', 'missing_id');
      const checked = validateSkill(req.body);
      if (checked.error) return fail(checked.status, checked.error);
      // 60 saves per user per hour. Fails OPEN (Section 12): losing the limiter for a few
      // minutes only lets a signed-in person fill their own, trimmed, history.
      try {
        if (!(await reserveSkillSave(redis, userId))) return fail(429, 'TOO_MANY_SAVES', 'save_rate_limit');
      } catch (err) {
        console.log('[skills] rate limiter unavailable, allowing:', err?.message || 'unknown');
      }
      const s = checked.value;
      // Upsert + trim to the newest 30 in ONE transaction (HTTP, non-interactive). created_at
      // is kept on update, so renaming a skill does not move it to the top.
      const [saved] = await sql.transaction([
        sql`INSERT INTO skills (user_id, id, name, target, seconds, degraded, files, size_bytes)
            VALUES (${userId}, ${id}, ${s.name}, ${s.target}, ${s.seconds}, ${s.degraded}, ${s.filesJson}::jsonb, ${s.sizeBytes})
            ON CONFLICT (user_id, id) DO UPDATE
              SET name = EXCLUDED.name, target = EXCLUDED.target, files = EXCLUDED.files, degraded = EXCLUDED.degraded,
                  seconds = EXCLUDED.seconds, size_bytes = EXCLUDED.size_bytes, updated_at = now()
            RETURNING updated_at`,
        sql`DELETE FROM skills
            WHERE user_id = ${userId}
              AND id NOT IN (SELECT id FROM skills WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${HISTORY_CAP})`,
      ]);
      return res.status(200).json({ id, savedAt: saved[0].updated_at });
    }

    if (req.method === 'DELETE') {
      if (id === undefined) await sql`DELETE FROM skills WHERE user_id = ${userId}`;
      else await sql`DELETE FROM skills WHERE user_id = ${userId} AND id = ${id}`;
      return res.status(204).end();
    }

    return fail(405, 'Method not allowed', 'method_not_allowed');
  } catch (err) {
    // Neon down, asleep past the timeout, or over the free compute cap. The browser keeps its
    // local copy and syncs later (Section 12). Never log the skill text, only the error class.
    console.error('[skills] database error:', err?.code || err?.name || 'unknown', err?.message?.slice(0, 200));
    return fail(503, 'HISTORY_UNAVAILABLE', 'db_error');
  }
};

module.exports.validateSkill = validateSkill;
