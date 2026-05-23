import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.105.4';

import OpenAI from 'https://deno.land/x/openai@v4.20.1/mod.ts';
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.32.1';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_PUBLIC_KEY = Deno.env.get("SUPABASE_PUBLIC_KEY");
const SUPABASE_SECRET_KEY = Deno.env.get("SUPABASE_SECRET_KEY") || '';
const OUTLINE_FUNCTION_URL = Deno.env.get("OUTLINE_FUNCTION_URL") || "https://storyscriptai-outline.storyscriptai.deno.net";
const TRANSCRIPT_GCF_URL = Deno.env.get("TRANSCRIPT_GCF_URL") || '';

if (!SUPABASE_URL || !SUPABASE_PUBLIC_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_PUBLIC_KEY");
}

// Public client for user-context operations (auth.getUser, public-readable selects).
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY);

// Admin client for service_role-bypass writes (pre-insert into story_tasks etc).
// supabase-js >= 2.50 understands the new sb_secret_/sb_publishable_ key format and
// will NOT place non-JWT keys in the Authorization header (which would otherwise
// trigger PostgREST JWSError "Expected 3 parts; got 1"). When SECRET_KEY is missing
// it falls back to the public client; the affected paths handle that gracefully.
const supabaseAdmin = SUPABASE_SECRET_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : supabase;

// CORS headers
const ALLOWED_ORIGINS = [
  'https://storyscriptai.com',
  'https://www.storyscriptai.com',
  'https://northnoir.com',
  'https://www.northnoir.com',
  'http://localhost:5173',
];

function getCorsOrigin(req: Request): string {
  const origin = req.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}
function getCorsHeaders(req: Request): Record<string, string> {
  const corsOrigin = getCorsOrigin(req);
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

// Model configurations
const MODEL_CONFIGS = {
  deepseek: {
    apiKey: Deno.env.get("DEEPSEEK_API_KEY"),
    baseURL: "https://api.deepseek.com/v1",
    tokenMultiplier: 1.0,
  },
  sonnet: {
    apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    baseURL: "https://api.anthropic.com",
    tokenMultiplier: 11.0,
  },
  opus: {
    apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    baseURL: "https://api.anthropic.com",
    tokenMultiplier: 19.0,
  }
};

interface Character {
  name: string;
  description: string;
}

interface MasterPromptData {
  visualStyle?: string;
  setting?: string;
  atmosphere?: string;
  environmentOnly?: boolean;
  characters?: Character[];
}

interface EnhancedMasterPrompt {
  visualStyle: string;
  setting: string;
  atmosphere: string;
  environmentOnly: boolean;
  characters: Array<{
    name: string;
    description: string;
    personality?: string;
    appearance?: string;
    role?: string;
  }>;
  consistencyNotes: string;
  narrativeStructure?: string;
  tonalGuidelines?: string;
  contentType?: string;
}

// Heuristic: escape stray `"` characters that appear *inside* a JSON string value.
// We walk the text character-by-character. When we are inside a string and encounter
// a `"`, we look ahead past whitespace: if the next significant character is one of
// the legal post-string delimiters (`,`, `}`, `]`, `:`) or end-of-input, we treat
// the quote as the real string terminator. Otherwise we assume the AI emitted an
// unescaped quote inside the string and escape it.
function escapeStrayQuotes(text: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    // inStr === true
    if (ch !== '"') { out += ch; continue; }
    // Look ahead past whitespace for the next non-space char.
    let j = i + 1;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j++;
    const next = j < text.length ? text[j] : '';
    if (next === '' || next === ',' || next === '}' || next === ']' || next === ':') {
      out += '"';
      inStr = false;
    } else {
      // Stray quote inside string — escape it.
      out += '\\"';
    }
  }
  return out;
}

// Resilient JSON extractor for AI responses. AI models occasionally produce slightly
// invalid JSON: smart quotes, trailing commas, unescaped newlines/quotes inside string
// values, or wrapping in ```json ... ``` fences. This tries the strict parse first, then
// progressively cleaner variants before giving up.
function parseAiJsonResponse(raw: string): any | null {
  if (!raw) return null;

  // 1. Strip markdown code fences if present.
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Helper: brace-match starting at first `{` of the given source.
  const sliceOutermostObject = (src: string): string => {
    const start = src.indexOf('{');
    if (start < 0) return src;
    let depth = 0;
    let end = -1;
    let inString = false;
    let escape = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    return end > start ? src.slice(start, end + 1) : src.slice(start);
  };

  // 2. Locate the outermost JSON object via brace matching (more robust than greedy regex
  //    which can be thrown off by braces inside string values).
  const candidate = sliceOutermostObject(text);

  // 3. Strict parse.
  try { return JSON.parse(candidate); } catch (_) { /* fall through */ }

  // 4. Light sanitization: smart quotes, trailing commas before ] or }.
  const sanitized = candidate
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(sanitized); } catch (_) { /* fall through */ }

  // 5. Escape stray newlines/tabs that appear *inside* string literals.
  let escaped = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < sanitized.length; i++) {
    const ch = sanitized[i];
    if (esc) { escaped += ch; esc = false; continue; }
    if (ch === '\\') { escaped += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; escaped += ch; continue; }
    if (inStr && ch === '\n') { escaped += '\\n'; continue; }
    if (inStr && ch === '\r') { escaped += '\\r'; continue; }
    if (inStr && ch === '\t') { escaped += '\\t'; continue; }
    escaped += ch;
  }
  try { return JSON.parse(escaped); } catch (_) { /* fall through */ }

  // 6. Heuristically escape stray `"` characters inside string values, then re-run
  //    brace matching (since the previous matcher may have closed the object early
  //    due to the bad quote) and re-apply the earlier sanitizations.
  try {
    const requoted = escapeStrayQuotes(
      // Apply smart-quote replacement to the *full* text, not just `candidate`,
      // because the bad quote may have caused us to slice too early.
      text
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
    );
    const reSliced = sliceOutermostObject(requoted)
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(reSliced);
  } catch (_) { /* fall through to truncation repair */ }

  // 7. Truncation repair. If the AI hit max_tokens mid-string the response
  //    looks like `{ "a": "...partial`. Walk the text tracking string state
  //    and brace/bracket depth, then close any open string with `"` and emit
  //    the matching closers for any unclosed `{`/`[`. This preserves every
  //    fully-completed field up to the truncation point instead of throwing
  //    the whole response away.
  try {
    const sourceForRepair = text
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    const startIdx = sourceForRepair.indexOf('{');
    if (startIdx >= 0) {
      const stack: string[] = [];
      let inStr = false;
      let esc = false;
      for (let i = startIdx; i < sourceForRepair.length; i++) {
        const ch = sourceForRepair[i];
        if (esc) { esc = false; continue; }
        if (inStr) {
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') { inStr = false; }
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') stack.pop();
      }
      let repaired = sourceForRepair.slice(startIdx);
      // If we ended inside a string literal, close it.
      if (inStr) repaired += '"';
      // Drop a dangling trailing comma so the auto-closer produces valid JSON.
      repaired = repaired.replace(/,\s*$/, '');
      // Pop the stack to emit the missing closing brackets / braces.
      while (stack.length) repaired += stack.pop();
      // Final pass: also strip trailing-comma-before-closer that the truncation
      // and our auto-closing may have left in interior objects/arrays.
      repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
      const parsed = JSON.parse(repaired);
      console.warn('[parseAiJsonResponse] recovered via truncation-repair strategy');
      return parsed;
    }
  } catch (e) {
    console.warn('[parseAiJsonResponse] All parse strategies failed:', (e as Error).message);
    return null;
  }

  return null;
}

// Rough estimated token calculation for pre-insert (mirrors storyscriptai-outline)
// Branched on user_plans.is_legacy_plan: legacy keeps current 11/19; new plan uses 13/21.
const LEGACY_LLM_MULTIPLIERS: Record<string, number> = { deepseek: 1.0, sonnet: 11.0, opus: 19.0 };
const NEW_LLM_MULTIPLIERS: Record<string, number> = { deepseek: 1.0, sonnet: 13.0, opus: 21.0 };
async function getIsLegacyPlan(userId: string): Promise<boolean> {
  if (!userId) return true;
  try {
    const { data, error } = await supabase
      .from('user_plans')
      .select('is_legacy_plan')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    if (error || !data) return true;
    return (data as { is_legacy_plan?: boolean }).is_legacy_plan === true;
  } catch (_) {
    return true;
  }
}
function llmMultiplier(isLegacy: boolean, model: string): number {
  const map = isLegacy ? LEGACY_LLM_MULTIPLIERS : NEW_LLM_MULTIPLIERS;
  return map[model] ?? 1.0;
}
function estimateTokensForPreInsert(wordCount: number, model: string, isLegacy: boolean): number {
  const multiplier = llmMultiplier(isLegacy, model);
  const outlineTokens = 1500 * multiplier;
  const storyTokens = Math.ceil(wordCount * 1.33 * multiplier);
  return Math.round(outlineTokens + storyTokens);
}

// Create client based on model
function createModelClient(model: string) {
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  if (!config) {
    throw new Error(`Unsupported model: ${model}`);
  }
  
  if (!config.apiKey) {
    throw new Error(`Missing API key for model: ${model}`);
  }

  if (model === 'deepseek') {
    return new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  } else {
    return new Anthropic({
      apiKey: config.apiKey,
    });
  }
}

// ---- YouTube Transcript Fetching ----
// Primary: youtube-transcript-plus (uses Innertube API)
// Fallback: custom page scraping

import { fetchTranscript as ytFetchTranscript, toPlainText } from 'npm:youtube-transcript-plus@2.0.0';

const MAX_TRANSCRIPT_CHARS = 8000; // ~2000 words per video

interface TranscriptResult {
  videoId: string;
  transcript: string | null;
  error?: string;
  method?: string; // which method succeeded
}

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function truncateAtSentenceBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('!'),
    truncated.lastIndexOf('?')
  );
  if (lastSentenceEnd > maxChars * 0.5) {
    return truncated.slice(0, lastSentenceEnd + 1);
  }
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) + '...' : truncated + '...';
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/\n/g, ' ');
}

// --- Method 0: Google Cloud Function (Python youtube-transcript-api, Google IP) ---
async function fetchWithGCF(videoIds: string[]): Promise<TranscriptResult[]> {
  if (!TRANSCRIPT_GCF_URL) {
    console.log('[gcf] No TRANSCRIPT_GCF_URL configured, skipping GCF method');
    return videoIds.map(id => ({ videoId: id, transcript: null, error: 'GCF URL not configured' }));
  }

  console.log(`[gcf] Calling GCF for ${videoIds.length} video(s): [${videoIds.join(', ')}]`);
  try {
    const response = await fetch(TRANSCRIPT_GCF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_ids: videoIds }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[gcf] HTTP ${response.status}: ${errorText.substring(0, 200)}`);
      return videoIds.map(id => ({ videoId: id, transcript: null, error: `GCF HTTP ${response.status}` }));
    }

    const data = await response.json();
    console.log(`[gcf] Response: ${data.summary || 'no summary'}`);

    if (!data.results || !Array.isArray(data.results)) {
      console.error('[gcf] Invalid response format — no results array');
      return videoIds.map(id => ({ videoId: id, transcript: null, error: 'GCF returned invalid format' }));
    }

    return data.results.map((r: any) => {
      if (r.transcript) {
        console.log(`[gcf] Success for ${r.videoId}: ${r.transcript.length} chars, method=${r.method || 'gcf'}`);
      } else {
        console.warn(`[gcf] Failed for ${r.videoId}: ${r.error}`);
      }
      return {
        videoId: r.videoId,
        transcript: r.transcript || null,
        method: r.method || 'gcf',
        error: r.error || undefined,
      } as TranscriptResult;
    });
  } catch (error: any) {
    const msg = error.message || 'Unknown error';
    console.error(`[gcf] Exception: ${msg}`);
    return videoIds.map(id => ({ videoId: id, transcript: null, error: `GCF error: ${msg}` }));
  }
}

// Common headers to bypass YouTube consent/cookie walls
const YT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+987; SOCS=CAESEwgDEgk3NDk0NjAyNDQaAmVuIAEaBgiA_LyaBg',
};

// --- Method 1: Innertube API (direct JSON, no HTML scraping, no consent walls) ---
async function fetchWithInnertube(videoId: string): Promise<TranscriptResult> {
  console.log(`[innertube] Attempting fetch for ${videoId}...`);
  try {
    // Step 1: Call Innertube player endpoint to get caption track URLs
    const playerResponse = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...YT_HEADERS,
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': '2.20250401.00.00',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20250401.00.00',
            hl: 'en',
            gl: 'US',
          },
        },
        videoId: videoId,
      }),
    });

    if (!playerResponse.ok) {
      console.error(`[innertube] Player endpoint HTTP ${playerResponse.status}`);
      return { videoId, transcript: null, error: `Innertube player HTTP ${playerResponse.status}` };
    }

    const playerData = await playerResponse.json();

    // Check playability
    const playabilityStatus = playerData.playabilityStatus?.status;
    console.log(`[innertube] Playability: ${playabilityStatus}`);
    if (playabilityStatus !== 'OK') {
      const reason = playerData.playabilityStatus?.reason || 'Unknown';
      return { videoId, transcript: null, error: `Video not playable: ${playabilityStatus} — ${reason}` };
    }

    // Extract caption tracks
    const captionTracks = playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks || captionTracks.length === 0) {
      // Log if captions object exists at all
      const hasCaptions = !!playerData.captions;
      console.log(`[innertube] No caption tracks found. captions object present: ${hasCaptions}`);
      return { videoId, transcript: null, error: 'No caption tracks in Innertube response' };
    }

    const trackLangs = captionTracks.map((t: any) => `${t.languageCode}${t.kind === 'asr' ? '(auto)' : ''}`);
    console.log(`[innertube] Found ${captionTracks.length} caption tracks: [${trackLangs.join(', ')}]`);

    // Find best track: prefer English manual, then English auto, then any
    let track = captionTracks.find((t: any) => t.languageCode === 'en' && t.kind !== 'asr');
    if (!track) track = captionTracks.find((t: any) => t.languageCode === 'en');
    if (!track) track = captionTracks.find((t: any) => t.languageCode?.startsWith('en'));
    if (!track) track = captionTracks[0];

    const captionUrl = track.baseUrl;
    const trackName = track.name?.simpleText || track.kind || 'unknown';
    console.log(`[innertube] Using track: lang=${track.languageCode}, name="${trackName}"`);

    // Step 2: Fetch caption XML
    const captionResponse = await fetch(captionUrl, { headers: YT_HEADERS });
    if (!captionResponse.ok) {
      console.error(`[innertube] Caption XML HTTP ${captionResponse.status}`);
      return { videoId, transcript: null, error: `Caption XML HTTP ${captionResponse.status}` };
    }

    const captionXml = await captionResponse.text();
    console.log(`[innertube] Caption XML: ${captionXml.length} chars`);

    // Step 3: Parse XML
    const textSegments: string[] = [];
    const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let match;
    while ((match = textRegex.exec(captionXml)) !== null) {
      const decoded = decodeHtmlEntities(match[1].trim());
      if (decoded) textSegments.push(decoded);
    }

    if (textSegments.length === 0) {
      console.error(`[innertube] No <text> segments. First 300 chars: ${captionXml.substring(0, 300)}`);
      return { videoId, transcript: null, error: 'Caption XML contained no text segments' };
    }

    const fullText = textSegments.join(' ').replace(/\s+/g, ' ').trim();
    console.log(`[innertube] Success for ${videoId}: ${fullText.length} chars, ${textSegments.length} segments`);
    const truncated = truncateAtSentenceBoundary(fullText, MAX_TRANSCRIPT_CHARS);
    return { videoId, transcript: truncated, method: 'innertube-api' };

  } catch (error: any) {
    const msg = error.message || 'Unknown error';
    console.error(`[innertube] Exception for ${videoId}: ${msg}`);
    return { videoId, transcript: null, error: `Innertube error: ${msg}` };
  }
}

// --- Method 1: youtube-transcript-plus (Innertube API) ---
async function fetchWithLibrary(videoId: string): Promise<TranscriptResult> {
  console.log(`[youtube-transcript-plus] Attempting fetch for ${videoId}...`);
  try {
    // Custom fetch functions that include consent bypass cookies
    const customFetch = async ({ url, lang, userAgent, method, body, headers: extraHeaders }: any) => {
      return fetch(url, {
        method: method || 'GET',
        headers: {
          ...YT_HEADERS,
          ...(lang && { 'Accept-Language': lang }),
          ...(extraHeaders || {}),
        },
        ...(body && { body }),
      });
    };

    const segments = await ytFetchTranscript(videoId, {
      lang: 'en',
      retries: 2,
      retryDelay: 1000,
      videoFetch: customFetch,
      playerFetch: customFetch,
      transcriptFetch: customFetch,
    });

    if (!segments || segments.length === 0) {
      console.log(`[youtube-transcript-plus] No segments returned for ${videoId}`);
      return { videoId, transcript: null, error: 'Library returned no segments' };
    }

    const plainText = toPlainText(segments, ' ').replace(/\s+/g, ' ').trim();
    console.log(`[youtube-transcript-plus] Success for ${videoId}: ${plainText.length} chars, ${segments.length} segments, lang=${segments[0]?.lang || 'unknown'}`);
    const truncated = truncateAtSentenceBoundary(plainText, MAX_TRANSCRIPT_CHARS);
    return { videoId, transcript: truncated, method: 'youtube-transcript-plus' };
  } catch (error: any) {
    const errName = error.constructor?.name || 'Error';
    const errMsg = error.message || 'Unknown error';
    console.error(`[youtube-transcript-plus] Failed for ${videoId}: [${errName}] ${errMsg}`);
    return { videoId, transcript: null, error: `[${errName}] ${errMsg}` };
  }
}

// --- Method 2: Custom page scraping (fallback) ---
async function fetchWithScraping(videoId: string): Promise<TranscriptResult> {
  console.log(`[scraper-fallback] Attempting fetch for ${videoId}...`);
  try {
    const videoPageUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US`;
    const pageResponse = await fetch(videoPageUrl, {
      headers: YT_HEADERS,
    });

    if (!pageResponse.ok) {
      console.error(`[scraper-fallback] Video page HTTP ${pageResponse.status} for ${videoId}`);
      return { videoId, transcript: null, error: `Video page HTTP ${pageResponse.status}` };
    }

    const pageHtml = await pageResponse.text();
    console.log(`[scraper-fallback] Page fetched for ${videoId}: ${pageHtml.length} chars`);

    // Check if ytInitialPlayerResponse exists FIRST — if it does, we have a real page
    // regardless of whether consent.youtube.com strings appear in the JS
    const hasPlayerResponse = pageHtml.includes('ytInitialPlayerResponse');
    console.log(`[scraper-fallback] ytInitialPlayerResponse present: ${hasPlayerResponse}`);

    if (!hasPlayerResponse) {
      // Only NOW check if it's a consent/bot page (since we don't have player data)
      const isConsentPage = pageHtml.includes('consent.youtube.com') || pageHtml.includes('accounts.google.com/ServiceLogin');
      const titleMatch = pageHtml.match(/<title>(.*?)<\/title>/);
      console.error(`[scraper-fallback] No player response. Page title: "${titleMatch?.[1] || 'unknown'}", consent page: ${isConsentPage}`);
      return { videoId, transcript: null, error: isConsentPage ? 'YouTube returned consent/login page (bot detection)' : 'No ytInitialPlayerResponse in page HTML' };
    }

    // Check if captions section exists
    const hasCaptions = pageHtml.includes('"captions"');
    const hasCaptionTracks = pageHtml.includes('"captionTracks"');
    console.log(`[scraper-fallback] "captions" in page: ${hasCaptions}, "captionTracks" in page: ${hasCaptionTracks}`);

    if (!hasCaptionTracks) {
      // Try to extract playability status to understand why
      const playabilityMatch = pageHtml.match(/"playabilityStatus":\s*\{[^}]*"status":"(\w+)"[^}]*(?:"reason":"([^"]*)")?/);
      if (playabilityMatch) {
        console.log(`[scraper-fallback] Playability status: ${playabilityMatch[1]}, reason: ${playabilityMatch[2] || 'none'}`);
      }
      return { videoId, transcript: null, error: 'No captionTracks found in player response' };
    }

    // Extract caption tracks
    const captionTrackPattern = /"captionTracks":\s*\[(.+?)\]/s;
    const captionTrackMatch = pageHtml.match(captionTrackPattern);
    let captionUrl: string | null = null;

    if (captionTrackMatch) {
      const tracksJson = captionTrackMatch[1];
      // Log available languages
      const langMatches = [...tracksJson.matchAll(/"languageCode":"([^"]+)"/g)];
      const availableLangs = langMatches.map(m => m[1]);
      console.log(`[scraper-fallback] Available caption languages: [${availableLangs.join(', ')}]`);

      const urlPatterns = [
        /"baseUrl":"(https?:[^"]+?lang=en[^"]*)"/,
        /"baseUrl":"(https?:[^"]+?lang=en-[^"]*)"/,
        /"baseUrl":"(https?:[^"]+?)"/,
      ];

      for (const pattern of urlPatterns) {
        const match = tracksJson.match(pattern);
        if (match) {
          captionUrl = match[1].replace(/\\u0026/g, '&');
          console.log(`[scraper-fallback] Selected caption URL (pattern ${urlPatterns.indexOf(pattern) + 1}): ${captionUrl.substring(0, 100)}...`);
          break;
        }
      }
    }

    if (!captionUrl) {
      const timedTextMatch = pageHtml.match(/"(https?:\/\/www\.youtube\.com\/api\/timedtext[^"]+)"/);
      if (timedTextMatch) {
        captionUrl = timedTextMatch[1].replace(/\\u0026/g, '&');
        console.log(`[scraper-fallback] Using timedtext fallback URL: ${captionUrl.substring(0, 100)}...`);
      }
    }

    if (!captionUrl) {
      return { videoId, transcript: null, error: 'Could not extract any caption URL' };
    }

    // Fetch captions XML
    const captionResponse = await fetch(captionUrl, {
      headers: YT_HEADERS,
    });

    if (!captionResponse.ok) {
      console.error(`[scraper-fallback] Caption XML HTTP ${captionResponse.status} for ${videoId}`);
      return { videoId, transcript: null, error: `Caption XML HTTP ${captionResponse.status}` };
    }

    const captionXml = await captionResponse.text();
    console.log(`[scraper-fallback] Caption XML fetched: ${captionXml.length} chars`);

    // Parse XML
    const textSegments: string[] = [];
    const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let match;
    while ((match = textRegex.exec(captionXml)) !== null) {
      const decoded = decodeHtmlEntities(match[1].trim());
      if (decoded) textSegments.push(decoded);
    }

    if (textSegments.length === 0) {
      console.error(`[scraper-fallback] No <text> segments parsed from XML. First 200 chars of XML: ${captionXml.substring(0, 200)}`);
      return { videoId, transcript: null, error: 'Caption XML contained no text segments' };
    }

    const fullText = textSegments.join(' ').replace(/\s+/g, ' ').trim();
    console.log(`[scraper-fallback] Success for ${videoId}: ${fullText.length} chars, ${textSegments.length} segments`);
    const truncated = truncateAtSentenceBoundary(fullText, MAX_TRANSCRIPT_CHARS);
    return { videoId, transcript: truncated, method: 'scraper-fallback' };

  } catch (error: any) {
    const msg = error.message || 'Unknown error';
    console.error(`[scraper-fallback] Exception for ${videoId}: ${msg}`);
    return { videoId, transcript: null, error: `Scraper error: ${msg}` };
  }
}

// --- Deno-local fallback: try Innertube, then library, then scraper ---
async function fetchSingleTranscriptLocal(videoId: string): Promise<TranscriptResult> {
  console.log(`[local-fallback] Trying Deno-local methods for ${videoId}...`);

  // Method A: Innertube API
  const innertubeResult = await fetchWithInnertube(videoId);
  if (innertubeResult.transcript) {
    console.log(`[transcript] Video ${videoId} succeeded via innertube-api (${innertubeResult.transcript.length} chars)`);
    return innertubeResult;
  }

  // Method B: youtube-transcript-plus
  const libraryResult = await fetchWithLibrary(videoId);
  if (libraryResult.transcript) {
    console.log(`[transcript] Video ${videoId} succeeded via youtube-transcript-plus (${libraryResult.transcript.length} chars)`);
    return libraryResult;
  }

  // Method C: Custom scraping
  const scraperResult = await fetchWithScraping(videoId);
  if (scraperResult.transcript) {
    console.log(`[transcript] Video ${videoId} succeeded via scraper fallback (${scraperResult.transcript.length} chars)`);
    return scraperResult;
  }

  return {
    videoId,
    transcript: null,
    error: `Local fallbacks failed. Innertube: ${innertubeResult.error} | Library: ${libraryResult.error} | Scraper: ${scraperResult.error}`,
  };
}

async function fetchYouTubeTranscripts(urls: string[]): Promise<TranscriptResult[]> {
  // Extract video IDs
  const videoEntries = urls.map(url => ({ url, videoId: extractVideoId(url) }));
  const invalidEntries = videoEntries.filter(e => !e.videoId);
  const validEntries = videoEntries.filter(e => e.videoId) as { url: string; videoId: string }[];

  const results: TranscriptResult[] = invalidEntries.map(e => {
    console.error(`[transcript] Invalid YouTube URL: ${e.url}`);
    return { videoId: e.url, transcript: null, error: 'Invalid YouTube URL' };
  });

  if (validEntries.length === 0) return results;

  const videoIds = validEntries.map(e => e.videoId);

  // Step 1: Try GCF (Python on Google's network — most reliable)
  console.log(`\n========== Fetching transcripts for ${videoIds.length} video(s) ==========`);
  const gcfResults = await fetchWithGCF(videoIds);

  // Check which videos GCF succeeded/failed on
  const gcfSucceeded: TranscriptResult[] = [];
  const gcfFailed: { videoId: string; gcfError: string }[] = [];

  for (const r of gcfResults) {
    if (r.transcript) {
      gcfSucceeded.push(r);
    } else {
      gcfFailed.push({ videoId: r.videoId, gcfError: r.error || 'Unknown' });
    }
  }

  results.push(...gcfSucceeded);

  // Step 2: For any GCF failures, try Deno-local fallback methods
  if (gcfFailed.length > 0) {
    console.log(`[transcript] GCF failed for ${gcfFailed.length} video(s), trying local fallbacks...`);
    for (const { videoId } of gcfFailed) {
      const localResult = await fetchSingleTranscriptLocal(videoId);
      results.push(localResult);
    }
  }

  return results;
}

// Detect content type using a quick AI classification call
async function detectContentType(
  title: string,
  description: string,
  masterPromptData: any,
  transcriptText?: string
): Promise<string> {
  const VALID_TYPES = ['story', 'documentary', 'informational', 'commentary'];
  
  try {
    const apiKey = MODEL_CONFIGS.sonnet.apiKey;
    if (!apiKey) {
      console.warn('No Anthropic API key for content_type detection, defaulting to story');
      return 'story';
    }

    let contextParts = [`Title: ${title}`, `Description: ${description}`];
    if (masterPromptData) {
      const mp = typeof masterPromptData === 'string' ? masterPromptData : JSON.stringify(masterPromptData);
      contextParts.push(`Additional context: ${mp.slice(0, 500)}`);
    }
    if (transcriptText) {
      contextParts.push(`Source transcript excerpt: ${transcriptText.slice(0, 500)}`);
    }

    const classificationPrompt = `Classify the following content request into exactly ONE category:
- story: Creative fiction, narratives, tales, character-driven fictional plots, what-if scenarios
- documentary: Factual accounts of real events, real people, history, true crime, biographies, science, nature
- informational: Educational content, explainers, how-to guides, tutorials, concept breakdowns, analysis of systems or processes
- commentary: Opinion pieces, reviews, argumentative essays, cultural/political analysis, commentary on current events

${contextParts.join('\n')}

Respond with ONLY the category name (one word). No explanation.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 10,
        temperature: 0,
        messages: [{ role: 'user', content: classificationPrompt }]
      }),
    });

    if (!response.ok) {
      console.warn(`Content type detection failed (HTTP ${response.status}), defaulting to story`);
      return 'story';
    }

    const result = await response.json();
    const detected = (result.content?.[0]?.text || '').trim().toLowerCase();
    
    if (VALID_TYPES.includes(detected)) {
      console.log(`[master-prompt] Detected content_type: ${detected}`);
      return detected;
    }
    
    console.log(`[master-prompt] Content type detection returned '${detected}', defaulting to story`);
    return 'story';
  } catch (error: any) {
    console.warn(`[master-prompt] Content type detection error: ${error.message}, defaulting to story`);
    return 'story';
  }
}


// Enhance master prompt with AI (similar to Python's enhance_master_prompt_with_ai)
async function enhanceMasterPromptWithAI(
  client: any,
  model: string,
  basicPrompt: MasterPromptData,
  title: string,
  description: string,
  transcripts?: TranscriptResult[],
  contentType: string = 'story'
): Promise<EnhancedMasterPrompt> {
  console.log(`Enhancing master prompt with AI (content_type: ${contentType})...`);
  
  // Collect successful transcripts
  const validTranscripts = transcripts?.filter(t => t.transcript) || [];
  const hasTranscripts = validTranscripts.length > 0;

  // Build content-type-specific guidance
  const contentTypeGuidance = contentType !== 'story' ? `\nCONTENT TYPE: ${contentType.toUpperCase()}
This is ${contentType === 'documentary' ? 'a DOCUMENTARY — factual content about real events, people, or phenomena' : contentType === 'informational' ? 'INFORMATIONAL/EDUCATIONAL content — focused on explaining concepts, processes, or topics' : 'COMMENTARY/ANALYSIS — focused on presenting analysis, opinions, or critical perspectives'}.
IMPORTANT: The final script will be read by a SINGLE third-person narrator for text-to-speech. Do NOT plan for dialogue, character conversations, or screenplay format. All content must work as continuous narration.
${contentType !== 'story' ? 'Environment-only mode should be true — focus on setting, atmosphere, and visual world-building rather than character descriptions.\n' : ''}` : '';
  
  // Build the enhancement prompt
  let promptText = `You are an expert creative writing assistant. Given a ${contentType === 'story' ? 'story concept' : contentType + ' concept'} and basic visual/thematic guidelines, enhance them into detailed, consistent master guidelines for ${contentType === 'story' ? 'story' : 'script'} generation.
${contentTypeGuidance}
Story Title: ${title}
Story Description: ${description}

Basic Guidelines Provided:
${basicPrompt.visualStyle ? `Visual Style: ${basicPrompt.visualStyle}` : ''}}
${basicPrompt.setting ? `Setting: ${basicPrompt.setting}` : ''}
${basicPrompt.atmosphere ? `Atmosphere: ${basicPrompt.atmosphere}` : ''}
${basicPrompt.environmentOnly ? 'Note: Focus ONLY on environment and atmosphere, DO NOT include character descriptions in the output.' : ''}

`;

  if (basicPrompt.characters && basicPrompt.characters.length > 0 && !basicPrompt.environmentOnly) {
    promptText += `\nCharacters Mentioned:\n`;
    basicPrompt.characters.forEach((char, idx) => {
      promptText += `${idx + 1}. ${char.name}${char.description ? `: ${char.description}` : ''}\n`;
    });
  }

  // Inject YouTube transcript context if available
  if (hasTranscripts) {
    promptText += `\n\n--- YOUTUBE INSPIRATION TRANSCRIPTS ---\nThe user has provided YouTube videos as creative inspiration. Analyze these transcripts carefully and extract:\n- The NARRATIVE STRUCTURE: How is the story organized? What is the arc shape? Are there repetitive patterns (e.g., try-fail cycles, cumulative sequences)? What are the key plot beats and turning points? How does it begin and end?\n- The TONAL STYLE: What is the prose register (simple/literary/conversational)? What age group is the writing aimed at? What sentence length and complexity is used? Is there a narrator voice? What emotional register does it use?\n- CHARACTER ARCHETYPES: What roles do characters play? What drives them? How do they relate to each other?\n- THEMATIC ELEMENTS: What are the core themes and how are they expressed through the story events?\n- PACING & RHYTHM: How does the story control its pacing? Are scenes long or short? Is there repetition for effect?\n\nThe generated story must be INSPIRED BY these sources — faithfully capture their narrative structure, pacing patterns, tonal register, and thematic essence — but must be an entirely original work. Do NOT copy dialogue, specific plot points, or character names from the transcripts.\n\n`;
    validTranscripts.forEach((t, idx) => {
      promptText += `[Video ${idx + 1} — ${t.videoId}]:\n${t.transcript}\n\n`;
    });
    promptText += `--- END TRANSCRIPTS ---\n`;
  }

  promptText += `\n\nYour task is to enhance these guidelines into a comprehensive master prompt that includes:

1. **Enhanced Visual Style**: Expand the visual style into specific, detailed visual guidance (art direction, color palettes, visual motifs, cinematography style if applicable)

2. **Detailed Setting**: Elaborate on the setting with rich, immersive details about the world, locations, time period, cultural elements, and physical environment

3. **Atmosphere & Tone**: Develop the atmosphere into nuanced emotional guidance including mood, pacing notes, tonal consistency requirements, and sensory details

${!basicPrompt.environmentOnly ? `4. **Character Descriptions**: For each character mentioned, create detailed profiles including:
   - Full personality traits and character arc potential
   - Physical appearance with distinctive visual features
   - Role in the story and relationship dynamics
   - Speaking style and mannerisms
   - Internal motivations and conflicts` : '4. **Environment Focus**: Since environment-only mode is enabled, focus exclusively on world-building, setting details, and atmospheric elements. DO NOT include character descriptions.'}

5. **Consistency Notes**: Provide specific guidelines to ensure visual, thematic, and narrative consistency throughout the story

${hasTranscripts ? `6. **Narrative Structure** (CRITICAL when YouTube transcripts are provided): Analyze the source material's story architecture and describe:
   - The overall arc shape (e.g., circular, linear, episodic)
   - Structural patterns (e.g., repetitive try-fail cycles, cumulative sequences, parallel journeys)
   - Key plot beats the generated story should mirror in spirit (not copy literally)
   - How the story opens and closes, and the relationship between beginning and ending
   - Scene/chapter rhythm and transitions
   Be extremely specific — this is the structural blueprint the story writer will follow.

7. **Tonal Guidelines** (CRITICAL when YouTube transcripts are provided): Define the exact prose style:
   - Target reading level and age group (e.g., "ages 3-6 bedtime story", "young adult literary fiction")
   - Sentence structure (short and simple vs. complex and layered)
   - Narration voice (warm/direct, omniscient/intimate, humorous/serious)
   - Vocabulary register (everyday words vs. literary language)
   - Specific stylistic devices used in the source (repetition, onomatopoeia, direct address, etc.)
   - Emotional temperature (gentle, intense, whimsical, dark, etc.)
   Be very precise — the writer needs to match this tonal register exactly.` : ''}

Format your response as a JSON object with the following structure:
{
  "visualStyle": "enhanced visual style description",
  "setting": "detailed setting description",
  "atmosphere": "nuanced atmosphere and tone guidance",
  "characters": [
    {
      "name": "character name",
      "description": "original description",
      "personality": "detailed personality traits",
      "appearance": "physical description",
      "role": "role in story"
    }
  ],
  "consistencyNotes": "specific consistency guidelines"${hasTranscripts ? `,
  "narrativeStructure": "detailed narrative structure blueprint extracted from the source material",
  "tonalGuidelines": "precise prose style and tonal register guidelines extracted from the source material"` : ''}
}

${basicPrompt.environmentOnly ? '\nIMPORTANT: Since environment-only mode is enabled, return an empty array for "characters": []' : ''}

Provide ONLY the JSON object, no additional text.`;

  try {
    let responseText = '';
    // Bumped from 6000 → 12000 for the transcript branch because the original
    // limit was truncating responses mid-string (the prompt asks for two large
    // free-text fields — narrativeStructure and tonalGuidelines — in addition
    // to the base schema). A truncated response yields `Unterminated string in
    // JSON at position X` which then falls through to the basic-prompt
    // fallback and silently drops the enhanced narrative guidance.
    const maxTokens = hasTranscripts ? 12000 : 3000;

    // Wall-clock guard so a stalled upstream connection cannot hang the Deno Deploy
    // isolate forever (which previously caused subsequent invocations to BOOT_FAILED 502).
    // 120s is well above the typical 30-60s Sonnet/Opus completion time but short enough
    // that the caller's fallback path can still recover within its own timeout budget.
    const AI_CALL_TIMEOUT_MS = 120_000;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), AI_CALL_TIMEOUT_MS);

    try {
      if (model === 'deepseek') {
        const response = await client.chat.completions.create(
          {
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: promptText }],
            temperature: 0.7,
            max_tokens: maxTokens,
          },
          { signal: abortController.signal }
        );
        responseText = response.choices[0]?.message?.content || '';
      } else {
        // Claude models
        const modelName = model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6';
        const response = await client.messages.create(
          {
            model: modelName,
            max_tokens: maxTokens,
            temperature: 0.7,
            messages: [{ role: 'user', content: promptText }],
          },
          { signal: abortController.signal }
        );
        responseText = response.content[0]?.text || '';
      }
    } finally {
      clearTimeout(timeoutId);
    }

    console.log('AI enhancement response received');
    
    // Parse JSON response (resilient to common AI formatting quirks)
    const enhanced = parseAiJsonResponse(responseText);
    if (!enhanced) {
      throw new Error('Failed to extract JSON from AI response');
    }
    
    // Validate and structure the response
    const result: EnhancedMasterPrompt = {
      visualStyle: enhanced.visualStyle || basicPrompt.visualStyle || '',
      setting: enhanced.setting || basicPrompt.setting || '',
      atmosphere: enhanced.atmosphere || basicPrompt.atmosphere || '',
      environmentOnly: contentType !== 'story' ? true : (basicPrompt.environmentOnly || false),
      characters: [],
      consistencyNotes: enhanced.consistencyNotes || '',
      narrativeStructure: enhanced.narrativeStructure || '',
      tonalGuidelines: enhanced.tonalGuidelines || '',
      contentType: contentType,
    };

    // Add enhanced character descriptions if not environment-only mode
    if (!basicPrompt.environmentOnly && enhanced.characters && Array.isArray(enhanced.characters)) {
      result.characters = enhanced.characters.map((char: any) => ({
        name: char.name || '',
        description: char.description || '',
        personality: char.personality || '',
        appearance: char.appearance || '',
        role: char.role || '',
      }));
    }

    console.log('Master prompt enhanced successfully');
    return result;
    
  } catch (error: any) {
    console.error('Failed to enhance master prompt:', error);
    // Return basic prompt as fallback
    return {
      visualStyle: basicPrompt.visualStyle || '',
      setting: basicPrompt.setting || '',
      atmosphere: basicPrompt.atmosphere || '',
      environmentOnly: contentType !== 'story' ? true : (basicPrompt.environmentOnly || false),
      characters: (basicPrompt.characters || []).map(char => ({
        name: char.name,
        description: char.description,
        personality: '',
        appearance: '',
        role: '',
      })),
      consistencyNotes: '',
      contentType: contentType,
    };
  }
}

// Fire-and-forget function to trigger outline generation
async function triggerOutlineGenerationAsync(
  userId: string,
  groupId: string,
  title: string,
  description: string,
  wordCount: number,
  language: string,
  model: string,
  tab: number,
  variant: number,
  enhancedMasterPrompt: EnhancedMasterPrompt,
  videoProcess: boolean = true,
  pauses: boolean = false,
  youtubeTranscript?: string,
  outlineTaskId?: string
) {
  try {
    console.log(`Triggering outline generation for group ${groupId}, tab ${tab}`);
    
    const response = await fetch(OUTLINE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SECRET_KEY,
      },
      body: JSON.stringify({
        userId: userId,
        groupId: groupId,
        title,
        description,
        wordCount: wordCount,
        language,
        model,
        tab,
        variant,
        master_prompt: enhancedMasterPrompt,
        videoProcess: videoProcess,
        pauses,
        ...(youtubeTranscript ? { youtube_transcript: youtubeTranscript } : {}),
        ...(outlineTaskId ? { outline_task_id: outlineTaskId } : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to trigger outline generation: ${response.status} ${errorText}`);
    } else {
      console.log('Outline generation triggered successfully');
    }
  } catch (error: any) {
    console.error('Error triggering outline generation:', error.message);
  }
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get('Authorization');
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!authToken) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }    // authToken resolved above (Bearer or apikey)
    const _secretKey = Deno.env.get('SUPABASE_SECRET_KEY') || '';
    const _publicKey = Deno.env.get('SUPABASE_PUBLIC_KEY') || '';
    const _allowedKeys = [_secretKey, _publicKey].filter(Boolean);
    let _authenticatedUserId: string | null = null;

    if (_allowedKeys.includes(authToken)) {
      // Service or frontend call (legacy or new keys)
    } else {
      const { data: { user: _authUser }, error: _authErr } = await supabase.auth.getUser(authToken);
      if (_authErr || !_authUser) {
        return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      _authenticatedUserId = _authUser.id;
    }

    const payload = await req.json();
    console.log('Master prompt enhancement request received');

    // When JWT auth is used, override body user_id with authenticated user
    if (_authenticatedUserId && payload.user_id) {
      payload.user_id = _authenticatedUserId;
    }

    // Validate inputs
    const {
      user_id,
      group_id,
      title,
      description,
      word_count,
      language = 'english',
      model = 'sonnet',
      tab = 1,
      variant = 1,
      master_prompt_data,
      video_process = false,
      pauses = false,
      youtube_links,
      youtube_transcript_text,
    } = payload;

    if (!user_id || !group_id || !title || !description || !word_count) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Detect content type early so we can store it on the pre-inserted row
    const contentType = await detectContentType(title, description, master_prompt_data, youtube_transcript_text);
    console.log(`[master-prompt] Using content_type: ${contentType}`);

    // Pre-insert a processing row immediately so the frontend can track outline generation
    // This mirrors what storyscriptai-outline does, but happens before the AI enhancement delay.
    // If a row already exists for (group_id, user_id, batch, version) — which can happen when a
    // previous invocation hung / fell back to Supabase and this is a retry — reuse that row's id
    // and update it in place so we don't break any downstream FK references and don't 409.
    let outlineTaskId = crypto.randomUUID();
    const isLegacyPlanForEstimate = await getIsLegacyPlan(user_id);
    const preInsertBody = {
      id: outlineTaskId,
      user_id,
      group_id,
      batch: [],
      previous_content: null,
      total_word_count: word_count,
      batch_number: 0,
      progress: 0,
      status: 'processing',
      story_title: title,
      description: description,
      outline: null,
      total_batches: null,
      is_corrected: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      input_tokens: 0,
      output_tokens: 0,
      variant: variant,
      stop_requested: false,
      video_process: video_process,
      language: language,
      model: model,
      tab: tab,
      pauses: pauses || false,
      content_type: contentType,
      estimated_tokens: estimateTokensForPreInsert(word_count, model, isLegacyPlanForEstimate),
    };
    try {
      // Use supabase-js admin client (handles new sb_secret_ key format correctly,
      // unlike raw fetch which would put the key in Authorization Bearer and trigger
      // PostgREST JWSError).
      const { error: insertErr } = await supabaseAdmin
        .from('story_tasks')
        .insert(preInsertBody);
      if (!insertErr) {
        console.log(`Pre-inserted processing task ${outlineTaskId} for group ${group_id}, tab ${tab}`);
      } else {
        const isUniqueViolation = insertErr.code === '23505' || (insertErr.message || '').includes('23505');
        if (isUniqueViolation) {
          // Look up the existing row's id and refresh its working state so the rest of the flow
          // (and the frontend's status polling) sees a clean "processing" task.
          // The pre-insert row is uniquely identified by (group_id, user_id, tab, batch_number=0).
          const { data: existingRows, error: lookupErr } = await supabaseAdmin
            .from('story_tasks')
            .select('id')
            .eq('group_id', group_id)
            .eq('user_id', user_id)
            .eq('tab', tab)
            .eq('batch_number', 0)
            .order('created_at', { ascending: false })
            .limit(1);
          if (!lookupErr) {
            const existingId = Array.isArray(existingRows) && existingRows.length > 0 ? (existingRows[0] as { id: string }).id : null;
            if (existingId) {
              outlineTaskId = existingId;
              // Update the existing row in place — preserves the id (and any FK refs to it).
              const { id: _omitId, created_at: _omitCreated, ...updateBody } = preInsertBody;
              const { error: updateErr } = await supabaseAdmin
                .from('story_tasks')
                .update(updateBody)
                .eq('id', existingId);
              if (!updateErr) {
                console.log(`Reused existing processing task ${existingId} for group ${group_id}, tab ${tab} (replaced previous run)`);
              } else {
                console.warn(`Failed to refresh existing processing task ${existingId}: ${updateErr.message}`);
              }
            } else {
              console.warn(`Pre-insert hit unique violation but could not locate existing row for group ${group_id}`);
            }
          } else {
            console.warn(`Pre-insert hit unique violation; lookup failed: ${lookupErr.message}`);
          }
        } else {
          console.warn(`Failed to pre-insert processing task: ${insertErr.code || ''} ${insertErr.message}`);
        }
      }
    } catch (preInsertErr: any) {
      console.warn(`Pre-insert error (non-fatal): ${preInsertErr.message}`);
    }

    // Fetch YouTube transcripts if provided (skip if pre-fetched text is available from plan-video)
    let transcriptResults: TranscriptResult[] | undefined;
    if (youtube_transcript_text && typeof youtube_transcript_text === 'string' && youtube_transcript_text.length > 0) {
      // Pre-fetched by plan-video — create synthetic transcript results to avoid re-fetching
      console.log(`Using pre-fetched transcript text (${youtube_transcript_text.length} chars), skipping GCF fetch`);
      transcriptResults = [{
        videoId: 'pre-fetched',
        transcript: youtube_transcript_text,
        method: 'plan-video-prefetch',
      }];
    } else if (youtube_links && Array.isArray(youtube_links) && youtube_links.length > 0) {
      console.log(`Fetching transcripts for ${youtube_links.length} YouTube video(s)...`);
      transcriptResults = await fetchYouTubeTranscripts(youtube_links);
      const successCount = transcriptResults.filter(t => t.transcript).length;
      console.log(`Transcript fetch complete: ${successCount}/${youtube_links.length} successful`);
      transcriptResults.forEach(t => {
        if (t.error) console.warn(`  Video ${t.videoId}: ${t.error}`);
      });
    }

    // Create model client
    const client = createModelClient(model);

    // Enhance master prompt with AI (and transcripts if available)
    const enhancedPrompt = await enhanceMasterPromptWithAI(
      client,
      model,
      master_prompt_data || {},
      title,
      description,
      transcriptResults,
      contentType
    );

    // Build raw transcript text for factual context in batch writing
    const rawTranscriptText = transcriptResults
      ?.filter(t => t.transcript)
      .map(t => t.transcript!)
      .join('\n\n---\n\n')
      .slice(0, 10000) || undefined;

    // Save enhanced master prompt to tabs table
    const { error: updateError } = await supabase
      .from('tabs')
      .update({
        master_prompt: enhancedPrompt,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', user_id)
      .eq('page', 'story')
      .eq('tab_number', tab);

    if (updateError) {
      console.error('Failed to save enhanced master prompt:', updateError);
      // Don't fail the request, continue with outline generation
    } else {
      console.log(`Enhanced master prompt saved to tabs for user ${user_id}, tab ${tab}`);
    }

    // Trigger outline generation (fire-and-forget for both story and video paths).
    // The outline function runs on its own Deno Deploy isolate and processes
    // independently once it receives the request.  Both the story-generator
    // frontend and the video-generator frontend poll the DB for progress, so
    // there is no need to await this call.
    triggerOutlineGenerationAsync(
      user_id,
      group_id,
      title,
      description,
      word_count,
      language,
      model,
      tab,
      variant,
      enhancedPrompt,
      video_process,
      pauses,
      rawTranscriptText,
      outlineTaskId
    ).catch(error => {
      console.error('Error in fire-and-forget outline trigger:', error);
    });

    // Return enhanced prompt to caller immediately
    const responseBody: any = {
      success: true,
      enhanced_master_prompt: enhancedPrompt,
      message: 'Master prompt enhanced and outline generation started',
    };
    if (transcriptResults) {
      responseBody.youtube_results = transcriptResults.map(t => ({
        videoId: t.videoId,
        success: !!t.transcript,
        method: t.method || undefined,
        error: t.error || undefined,
      }));
    }
    return new Response(
      JSON.stringify(responseBody),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error in master-prompt function:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});



