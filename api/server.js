/* ============================================
   VideoLens — API Server
   Express + OpenRouter (Free Models) + Transcript
   ============================================ */

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors());
app.use(express.json());

// ── Rate limiting ──
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Slow down.' }
});
app.use(limiter);

// ── Config ──
const PORT = process.env.PORT || 3000;

// Support both OpenAI and OpenRouter
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'openrouter'; // 'openai' or 'openrouter'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Free models on OpenRouter (as of 2026)
const FREE_MODELS = {
  // Best free models for summarization
  primary: 'google/gemini-2.0-flash-exp:free',        // Fast, good quality, free
  fallback: 'meta-llama/llama-3.1-70b-instruct:free', // Good backup
  qna: 'google/gemini-2.0-flash-exp:free',            // Q&A tasks
  // Paid fallback if free limits hit
  paid: 'openai/gpt-4o-mini',                          // Cheap, high quality
};

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// ── In-memory transcript cache ──
const transcriptCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

// ============================================
// ROUTES
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'VideoLens API',
    version: '1.1.0',
    provider: LLM_PROVIDER,
    freeModels: Object.keys(FREE_MODELS)
  });
});

// ── Get transcript ──
app.get('/transcript', async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'videoId required' });

    const cached = transcriptCache.get(videoId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return res.json(cached.data);
    }

    let transcript = await fetchYouTubeTranscript(videoId);

    if (!transcript || !transcript.segments?.length) {
      console.log(`[VideoLens] No captions for ${videoId}, would use Whisper fallback`);
      transcript = await whisperFallback(videoId);
    }

    if (!transcript) {
      return res.status(404).json({ error: 'Could not extract transcript' });
    }

    transcriptCache.set(videoId, { data: transcript, timestamp: Date.now() });
    res.json(transcript);
  } catch (err) {
    console.error('[VideoLens] Transcript error:', err.message);
    res.status(500).json({ error: 'Failed to get transcript' });
  }
});

// ── Summarize video ──
app.post('/summarize', async (req, res) => {
  try {
    const { videoId, videoUrl, title, transcript: clientTranscript, options = {} } = req.body;
    if (!videoId) return res.status(400).json({ error: 'videoId required' });

    const {
      includeKeywords = true,
      includeStoryline = true,
      includeTimestamps = true,
      language = 'en'
    } = options;

    // Use transcript from extension if provided, otherwise try server-side
    let transcript = null;
    let source = 'unknown';

    if (clientTranscript && clientTranscript.segments?.length) {
      transcript = clientTranscript;
      source = 'extension';
    } else {
      transcript = await fetchYouTubeTranscript(videoId);
      source = 'server-captions';
    }

    if (!transcript?.segments?.length) {
      transcript = await whisperFallback(videoId);
      source = 'whisper';
    }

    if (!transcript) {
      return res.status(404).json({ error: 'Could not extract transcript' });
    }

    const fullText = transcript.segments.map(s => s.text).join(' ');

    const summaryResult = await generateSummary(fullText, {
      title: title || 'YouTube Video',
      includeKeywords,
      includeStoryline,
      includeTimestamps,
      language,
      segments: transcript.segments
    });

    res.json({
      videoId,
      videoUrl,
      title,
      source,
      ...summaryResult
    });

  } catch (err) {
    console.error('[VideoLens] Summarize error:', err.message);
    res.status(500).json({ error: 'Failed to summarize video' });
  }
});

// ── Ask question ──
app.post('/ask', async (req, res) => {
  try {
    const { videoId, question } = req.body;
    if (!videoId || !question) {
      return res.status(400).json({ error: 'videoId and question required' });
    }

    let transcript = await fetchYouTubeTranscript(videoId);
    if (!transcript?.segments?.length) {
      transcript = await whisperFallback(videoId);
    }

    if (!transcript) {
      return res.status(404).json({ error: 'Could not get transcript' });
    }

    const fullText = transcript.segments.map(s => `[${formatTime(s.start)}] ${s.text}`).join('\n');
    const answer = await answerQuestion(fullText, question);
    res.json(answer);
  } catch (err) {
    console.error('[VideoLens] Ask error:', err.message);
    res.status(500).json({ error: 'Failed to answer question' });
  }
});


// ============================================
// LLM CALLS (OpenRouter or OpenAI)
// ============================================

async function callLLM(messages, options = {}) {
  const {
    model = FREE_MODELS.primary,
    fallbackModel = FREE_MODELS.fallback,
    temperature = 0.3,
    maxTokens = 4000,
    jsonResponse = true
  } = options;

  if (LLM_PROVIDER === 'openrouter') {
    return callOpenRouter(messages, { model, fallbackModel, temperature, maxTokens, jsonResponse });
  } else {
    return callOpenAI(messages, { model, temperature, maxTokens, jsonResponse });
  }
}

async function callOpenRouter(messages, options) {
  const { model, fallbackModel, temperature, maxTokens, jsonResponse } = options;
  const apiKey = OPENROUTER_API_KEY;

  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  if (jsonResponse) {
    body.response_format = { type: 'json_object' };
  }

  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://videolens.ai',
        'X-Title': 'VideoLens'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    // If free model rate limited, try fallback
    if (data.error?.message?.includes('rate') || data.error?.code === 429) {
      console.log(`[VideoLens] Rate limited on ${model}, trying ${fallbackModel}`);
      body.model = fallbackModel;
      const retry = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://videolens.ai',
          'X-Title': 'VideoLens'
        },
        body: JSON.stringify(body)
      });
      return await retry.json();
    }

    return data;
  } catch (err) {
    console.error('[VideoLens] OpenRouter error:', err.message);
    throw err;
  }
}

async function callOpenAI(messages, options) {
  const { model, temperature, maxTokens, jsonResponse } = options;
  const apiKey = OPENAI_API_KEY;

  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const body = {
    model: model || 'gpt-4o-mini',
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  if (jsonResponse) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  return response.json();
}


// ============================================
// CORE FUNCTIONS
// ============================================

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
    console.log(`[VideoLens] YouTube transcript failed for ${videoId}:`, err.message);
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

async function whisperFallback(videoId) {
  console.log(`[VideoLens] Whisper fallback triggered for ${videoId}`);
  // TODO: Download audio → Whisper API
  return null;
}

async function generateSummary(text, options) {
  const { title, includeKeywords, includeStoryline, includeTimestamps, language } = options;
  const maxChars = 80000;
  const truncatedText = text.length > maxChars ? text.substring(0, maxChars) + '...' : text;

  const systemPrompt = `You are VideoLens, an expert video content analyzer. Respond in valid JSON only.

Required JSON structure:
{
  "summary": "A comprehensive 2-3 paragraph summary capturing the essence, main arguments, and key takeaways. Write as a narrative, not bullet points.",
  "keywords": ["keyword1", "keyword2"] (8-15 relevant keywords/topics/entities),
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
    const data = await callLLM([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { temperature: 0.3, maxTokens: 4000, jsonResponse: true });

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('No LLM response');
    return JSON.parse(content);
  } catch (err) {
    console.error('[VideoLens] Summary generation error:', err.message);
    return { summary: 'Summary generation failed. Please try again.', keywords: [], storyline: [], timestamps: [] };
  }
}

async function answerQuestion(transcriptText, question) {
  const systemPrompt = `You are VideoLens Q&A. Answer based on the transcript. If not in transcript, say so.

Respond in JSON:
{
  "answer": "Detailed answer",
  "timestamp": "2:34",
  "timestampSeconds": 154,
  "confidence": "high|medium|low"
}`;

  try {
    const data = await callLLM([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Transcript (with timestamps):\n${transcriptText}\n\nQuestion: ${question}` }
    ], { model: FREE_MODELS.qna, temperature: 0.2, maxTokens: 1000, jsonResponse: true });

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

// ============================================
// START
// ============================================
app.listen(PORT, () => {
  console.log(`\n🎯 VideoLens API running on port ${PORT}`);
  console.log(`   Provider: ${LLM_PROVIDER}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);

  if (LLM_PROVIDER === 'openrouter' && !OPENROUTER_API_KEY) {
    console.warn('⚠️  OPENROUTER_API_KEY not set!');
  }
  if (LLM_PROVIDER === 'openai' && !OPENAI_API_KEY) {
    console.warn('⚠️  OPENAI_API_KEY not set!');
  }
});
