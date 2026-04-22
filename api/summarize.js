// VideoLens — Vercel Serverless Function
// Handles: POST /api/summarize, POST /api/ask, GET /api/health

const FREE_MODELS = {
  primary: 'google/gemini-2.0-flash-exp:free',
  fallback: 'meta-llama/llama-3.1-70b-instruct:free',
  qna: 'google/gemini-2.0-flash-exp:free',
};

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { action } = req.query;

  try {
    // GET /api/summarize?action=health
    if (req.method === 'GET' && action === 'health') {
      return res.status(200).json({
        status: 'ok',
        service: 'VideoLens API',
        version: '2.0.0',
        hasKey: !!process.env.OPENROUTER_API_KEY,
      });
    }

    // POST /api/summarize
    if (req.method === 'POST' && !action) {
      return await handleSummarize(req, res);
    }

    // POST /api/summarize?action=ask
    if (req.method === 'POST' && action === 'ask') {
      return await handleAsk(req, res);
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('[VideoLens] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Summarize handler ──
async function handleSummarize(req, res) {
  const { videoId, videoUrl, title, options = {} } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured. Add OPENROUTER_API_KEY in Vercel settings.' });

  const {
    includeKeywords = true,
    includeStoryline = true,
    includeTimestamps = true,
    language = 'en'
  } = options;

  // Fetch transcript
  let transcript = await fetchYouTubeTranscript(videoId);
  let source = 'captions';

  if (!transcript || !transcript.segments?.length) {
    return res.status(404).json({
      error: 'Could not extract transcript. Video may not have captions.',
      hint: 'Try a video with English captions, or check the URL.'
    });
  }

  const fullText = transcript.segments.map(s => s.text).join(' ');

  // Generate summary via LLM
  const summaryResult = await generateSummary(fullText, apiKey, {
    title: title || 'YouTube Video',
    includeKeywords,
    includeStoryline,
    includeTimestamps,
    language,
    segments: transcript.segments
  });

  return res.status(200).json({
    videoId,
    videoUrl,
    title,
    source,
    ...summaryResult
  });
}

// ── Ask handler ──
async function handleAsk(req, res) {
  const { videoId, question } = req.body;
  if (!videoId || !question) {
    return res.status(400).json({ error: 'videoId and question required' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  let transcript = await fetchYouTubeTranscript(videoId);
  if (!transcript?.segments?.length) {
    return res.status(404).json({ error: 'Could not get transcript' });
  }

  const fullText = transcript.segments.map(s => `[${formatTime(s.start)}] ${s.text}`).join('\n');
  const answer = await answerQuestion(fullText, question, apiKey);
  return res.status(200).json(answer);
}

// ── Fetch YouTube transcript ──
async function fetchYouTubeTranscript(videoId) {
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const html = await response.text();
    const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!captionMatch) return null;

    const captions = JSON.parse(captionMatch[1]);
    if (!captions || !captions.length) return null;

    const track = captions.find(c => c.languageCode === 'en') || captions[0];
    const captionResponse = await fetch(track.baseUrl);
    const captionXml = await captionResponse.text();
    const segments = parseCaptionXml(captionXml);

    return { source: 'captions', language: track.languageCode, segments };
  } catch (err) {
    console.log(`[VideoLens] Transcript failed for ${videoId}:`, err.message);
    return null;
  }
}

function parseCaptionXml(xml) {
  const segments = [];
  const textRegex = /<text\s+start="([\d.]+)"\s+duration="([\d.]+)"[^>]*>(.*?)<\/text>/g;
  let match;
  while ((match = textRegex.exec(xml)) !== null) {
    const start = parseFloat(match[1]);
    const duration = parseFloat(match[2]);
    let text = match[3]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n/g, ' ');
    segments.push({ start, duration, end: start + duration, text: text.trim() });
  }
  return segments;
}

// ── LLM calls ──
async function callOpenRouter(messages, apiKey, options = {}) {
  const {
    model = FREE_MODELS.primary,
    fallbackModel = FREE_MODELS.fallback,
    temperature = 0.3,
    maxTokens = 4000,
    jsonResponse = true
  } = options;

  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (jsonResponse) body.response_format = { type: 'json_object' };

  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://videolens1.vercel.app',
      'X-Title': 'VideoLens'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  // Fallback on rate limit
  if (data.error?.message?.includes('rate') || data.error?.code === 429) {
    body.model = fallbackModel;
    const retry = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://videolens1.vercel.app',
        'X-Title': 'VideoLens'
      },
      body: JSON.stringify(body)
    });
    return await retry.json();
  }

  return data;
}

// ── Generate summary ──
async function generateSummary(text, apiKey, options) {
  const { title, includeKeywords, includeStoryline, includeTimestamps, language } = options;
  const maxChars = 80000;
  const truncatedText = text.length > maxChars ? text.substring(0, maxChars) + '...' : text;

  const systemPrompt = `You are VideoLens, an expert video content analyzer. Respond in valid JSON only.

Required JSON structure:
{
  "summary": "A comprehensive 2-3 paragraph summary capturing the essence, main arguments, and key takeaways. Write as a narrative, not bullet points.",
  "keywords": ["keyword1", "keyword2"],
  "storyline": [
    { "time": "0:00 - 2:30", "title": "Chapter title", "description": "What happens" }
  ],
  "timestamps": [
    { "time": "2:34", "seconds": 154, "text": "Key point" }
  ]
}`;

  let userPrompt = `Analyze this video transcript:\n`;
  if (includeKeywords) userPrompt += `- Extract 8-15 keywords/topics\n`;
  if (includeStoryline) userPrompt += `- Break into 4-8 storyline chapters\n`;
  if (includeTimestamps) userPrompt += `- Identify 5-10 key moments\n`;
  userPrompt += `- Write deep, insightful summary\n- Language: ${language}\n\n`;
  userPrompt += `Title: "${title}"\n\nTranscript:\n${truncatedText}`;

  try {
    const data = await callOpenRouter([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], apiKey, { temperature: 0.3, maxTokens: 4000, jsonResponse: true });

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('No LLM response');
    return JSON.parse(content);
  } catch (err) {
    console.error('[VideoLens] Summary error:', err.message);
    return { summary: 'Summary generation failed. Please try again.', keywords: [], storyline: [], timestamps: [] };
  }
}

// ── Answer question ──
async function answerQuestion(transcriptText, question, apiKey) {
  const systemPrompt = `You are VideoLens Q&A. Answer based on the transcript. If not in transcript, say so.

Respond in JSON:
{
  "answer": "Detailed answer",
  "timestamp": "2:34",
  "timestampSeconds": 154,
  "confidence": "high|medium|low"
}`;

  try {
    const data = await callOpenRouter([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Transcript (with timestamps):\n${transcriptText}\n\nQuestion: ${question}` }
    ], apiKey, { model: FREE_MODELS.qna, temperature: 0.2, maxTokens: 1000, jsonResponse: true });

    const content = data.choices?.[0]?.message?.content;
    return JSON.parse(content);
  } catch (err) {
    return { answer: 'Failed to find an answer. Try rephrasing.', confidence: 'low' };
  }
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
