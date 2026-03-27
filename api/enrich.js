export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://claudly-mvp.netlify.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rawText, category, fileName } = req.body;
  if (!rawText || !category || !fileName) return res.status(400).json({ error: 'Missing required fields' });
  if (rawText.length > 12000) return res.status(400).json({ error: 'Content too large' });

  const categoryPrompts = {
    instructions: 'Extract all rules, guidelines, and behavioral instructions. Format as clear bullet points. Remove noise and artifacts.',
    personality: 'Extract tone, voice, style traits, and communication preferences. Format as structured descriptors Claude can adopt.',
    knowledge: 'Summarize the key knowledge, facts, and domain information. Structure with headings and bullet points. Remove artifacts.',
    examples: 'Extract and clean up examples, templates, and sample outputs. Preserve structure and format them clearly.',
    context: 'Extract background context, domain information, and situational details. Format as clear structured paragraphs.',
    preferences: 'Extract user preferences, settings, and configuration choices. Format as a clean structured list.',
  };

  const prompt = `You are building a Claude skill file section from raw extracted document content.
Category: ${category}
File: ${fileName}
Task: ${categoryPrompts[category] || categoryPrompts.knowledge}
Rules:
- Remove all PDF artifacts, symbols, encoding noise
- Keep only content useful for Claude to act on
- Output clean markdown only, no preamble, no explanation
- Max 800 words

Raw content:
${rawText.slice(0, 8000)}`;

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
    return res.status(200).json({ enriched });
  } catch (err) {
    return res.status(500).json({ error: 'Proxy error', detail: err.message });
  }
}
