module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rawText, category, fileName } = req.body;
  if (!rawText || !category || !fileName) return res.status(400).json({ error: 'Missing required fields' });

  const input = rawText.slice(0, 4000);

  const prompt = `Convert this raw content into a Claude Skill File.

Return ONLY this markdown format, nothing else:

---
domain: <detected>
content_type: <detected>
use_cases: [<list>]
---

## Instructions
<key rules and directives>

## When to Use
<when to activate this skill>

## Knowledge
<key facts and information>

## Key Concepts
<important terms and ideas>

## How to Respond
<tone and approach>

## Output Style
<formatting preferences>

## Extended Content
<additional context>

RAW INPUT:
${input}`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://relatch-fe.vercel.app',
        'X-Title': 'Relatch',
      },
      body: JSON.stringify({
        model: 'mistralai/mistral-7b-instruct:free',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: 'AI API error', detail: err });
    }

    const data = await response.json();
    const enriched = data.choices?.[0]?.message?.content || '';
    if (!enriched) return res.status(502).json({ error: 'Empty response from AI' });
    return res.status(200).json({ enriched });

  } catch (err) {
    return res.status(500).json({ error: 'Proxy error', detail: err.message });
  }
};
