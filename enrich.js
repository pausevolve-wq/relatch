export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rawText, category, fileName } = req.body;
  if (!rawText || !category || !fileName) return res.status(400).json({ error: 'Missing required fields' });
  if (rawText.length > 12000) return res.status(400).json({ error: 'Content too large' });
  const prompt = `
You are an expert system that converts raw content into a fully structured Claude Skill File.

CRITICAL RULES:
- Output ONLY markdown
- Do NOT include explanations
- Do NOT wrap in code blocks
- ALWAYS follow exact format below

FORMAT:

---
domain: <auto-detected>
content_type: <auto-detected>
use_cases: [<list>]
---

## Instructions

## When to Use

## Knowledge

## Key Concepts

## How to Respond

## Output Style

## Extended Content

---

INPUT:
${rawText.slice(0, 8000)}
`;
try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'meta/llama-3.1-70b-instruct',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: 'Upstream API error', detail: err });
    }

    const data = await response.json();
    const enriched = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({ content: enriched });
  } catch (err) {
    return res.status(500).json({ error: 'Proxy error', detail: err.message });
  }
}
