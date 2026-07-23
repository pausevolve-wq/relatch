const { verifyToken } = require('@clerk/backend');

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
  try {
    await verifyToken(authHeader.slice(7), { secretKey: process.env.CLERK_SECRET_KEY });
  } catch {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Missing required field: email' });
  }
  const normalizedEmail = email.trim().toLowerCase();

  const readToken = process.env.SPLITFORMS_READ_TOKEN;
  if (!readToken) {
    // Dedup check not configured yet (SPLITFORMS_READ_TOKEN unset) -- fail open so signups
    // keep working exactly as before this endpoint existed, rather than blocking on setup.
    return res.status(200).json({ alreadyJoined: false, checked: false });
  }

  // SplitForms' read API has no server-side filter by field value (confirmed against their
  // docs), so this pages through submissions and scans data.email itself. Capped at 5 pages
  // (500 rows) per check -- fine at current waitlist volume; would need a real index if this
  // ever grows into the thousands.
  try {
    let before;
    for (let page = 0; page < 5; page++) {
      const url = new URL('https://splitforms.com/api/submissions');
      url.searchParams.set('limit', '100');
      if (before) url.searchParams.set('before', before);
      const listResp = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${readToken}` },
      });
      if (!listResp.ok) break; // fail open on a transient read error -- never block a real signup over this
      const listData = await listResp.json();
      const submissions = listData.submissions || [];
      const match = submissions.find(
        (s) => !s.is_spam && typeof s.data?.email === 'string' && s.data.email.trim().toLowerCase() === normalizedEmail
      );
      if (match) return res.status(200).json({ alreadyJoined: true, checked: true });
      if (!listData.has_more || submissions.length === 0) break;
      before = submissions[submissions.length - 1].created_at;
    }
    return res.status(200).json({ alreadyJoined: false, checked: true });
  } catch {
    return res.status(200).json({ alreadyJoined: false, checked: false }); // fail open
  }
};
