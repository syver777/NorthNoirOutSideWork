
import { createClient } from 'npm:@supabase/supabase-js@2';
import { fetchWithDenoFallback } from '../_shared/fetchWithDenoFallback.ts';
import { getIsLegacyPlan, llmMultiplier } from '../_shared/tokenCosts.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

const DEFAULT_IMAGE_STYLE = 'A black-and-white old comic book-style illustration in wide format. Features dramatic contrast, rich textures, and expressive, rough linework resembling vintage war comics. High cinematic shadows with intense lighting, giving a moody, atmospheric tone. Characters are drawn with raw, emotional detail, and each scene feels like a hand-drawn storyboard frame. Backgrounds are layered with depth, and the overall composition balances realism with a surreal, haunted quality. The style evokes mid-20th-century graphic novels with a gritty, psychological edge. Make the image bright. Each image is a keyframe for an image-to-video clip, so compose each scene to suggest natural motion potential and cinematic depth.';

interface ITVSegment {
  text: string;
  index: number;
}

interface SetupRequest {
  user_id: string;
  group_id: string;
  file_path: string;
  story_title: string;
  description: string;
  video_model: string;        // ITV video model (wan22, seedance1fast, etc.)
  clip_duration?: number;     // seconds per ITV clip (omit to use model default from ITV_VIDEO_MODEL_CONFIGS)
  totalAudioDuration: number; // total audio duration → drives totalImages count
  image_model?: string;       // image generation model for Phase 1 output
  model?: string;             // AI prompt model (deepseek|sonnet|opus)
  language?: string;
  tab?: number;
  variant?: number;
  audio_clip?: boolean;
  userTokenBalance: number;
  useCharacterDescriptions?: boolean;
  customCharactersEnabled?: boolean;
  customCharacters?: Array<{ name: string; description: string }>;
  customCharactersAIEnhance?: boolean;
  style?: string;             // visual style description (defaults to DEFAULT_IMAGE_STYLE)
  videoProcess?: boolean;     // when true (called from video pipeline), skip token balance check
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BATCH_SIZE = 2;         // 2 segments per batch
const MAX_RETRIES = 3;
const BATCH_DELAY_MS = 500;
const TOKEN_PER_WORD = 1.33;
const MAX_TEXT_PART_CHARS = 56000;
const MIN_TEXT_PART_LENGTH = 50;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SECRET_KEY") || ""
);

const deepseekApiKey = Deno.env.get('DEEPSEEK_API_KEY') ?? '';

// ─── Model configs ────────────────────────────────────────────────────────────

const MODEL_CONFIGS: Record<string, { tokenMultiplier: number }> = {
  deepseek: { tokenMultiplier: 1.0 },
  sonnet:   { tokenMultiplier: 11.0 },
  opus:     { tokenMultiplier: 19.0 },
};

function getTokenMultiplier(model: string): number {
  return MODEL_CONFIGS[model]?.tokenMultiplier ?? 1.0;
}

// ─── ITV video model configs ──────────────────────────────────────────────────

const ITV_VIDEO_MODEL_CONFIGS: Record<string, { name: string; defaultDuration: number; durationOptions?: number[]; durationMin?: number; durationMax?: number; supportsAudio?: boolean }> = {
  wan22:         { name: 'Wan 2.2 ITV',               defaultDuration: 5.06 },
  seedance1fast: { name: 'Seedance 1.0 Pro Fast ITV',  defaultDuration: 5,    durationOptions: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], durationMin: 2, durationMax: 12 },
  hailuo23fast:  { name: 'Hailuo 2.3 Fast ITV',        defaultDuration: 6,    durationOptions: [6, 10] },
  seedance15:    { name: 'Seedance 1.5 Pro ITV',       defaultDuration: 5,    durationOptions: [4, 5, 6, 7, 8, 9, 10, 11, 12], durationMin: 4, durationMax: 12, supportsAudio: true },
  ltx23fast:     { name: 'LTX 2.3 Fast ITV',           defaultDuration: 6,    durationOptions: [6, 8, 10], supportsAudio: true },
  veo31fast:     { name: 'Veo 3.1 Fast ITV',           defaultDuration: 4,    durationOptions: [4, 6, 8],  supportsAudio: true },
  ltx23pro:      { name: 'LTX 2.3 Pro ITV',            defaultDuration: 6,    durationOptions: [6, 8, 10], supportsAudio: true },
  veo31:         { name: 'Veo 3.1 ITV',                defaultDuration: 4,    durationOptions: [4, 6, 8],  supportsAudio: true },
  ltx23pro4k:    { name: 'LTX 2.3 Pro 4K ITV',         defaultDuration: 6,    durationOptions: [6, 8, 10], supportsAudio: true },
};

/**
 * Clamp a requested per-clip duration to the legal range/options for the given model.
 * Defends against upstream callers (e.g. plan-video LLM) sending nonsense values
 * such as the total runtime instead of a per-clip length.
 */
function clampClipDurationForModel(model: string, requested: number): { duration: number; clamped: boolean } {
  const cfg = ITV_VIDEO_MODEL_CONFIGS[model];
  if (!cfg) {
    if (requested > 0 && requested <= 16) return { duration: requested, clamped: false };
    return { duration: Math.min(Math.max(requested, 1), 16), clamped: true };
  }
  if (cfg.durationOptions && cfg.durationOptions.length > 0) {
    if (cfg.durationOptions.includes(requested)) return { duration: requested, clamped: false };
    if (typeof cfg.durationMin === 'number' && typeof cfg.durationMax === 'number') {
      if (requested < cfg.durationMin) return { duration: cfg.durationMin, clamped: true };
      if (requested > cfg.durationMax) return { duration: cfg.durationMax, clamped: true };
      return { duration: requested, clamped: false };
    }
    const eligible = cfg.durationOptions.filter(o => o <= requested);
    const snapped = eligible.length > 0 ? Math.max(...eligible) : Math.min(...cfg.durationOptions);
    return { duration: snapped, clamped: true };
  }
  if (Math.abs(requested - cfg.defaultDuration) < 0.01) return { duration: cfg.defaultDuration, clamped: false };
  return { duration: cfg.defaultDuration, clamped: true };
}

// ─── Token estimation ─────────────────────────────────────────────────────────

/**
 * Estimates total tokens for ITV Phase 1 (image prompts) + Phase 2 (motion prompts).
 * Phase 1: similar to TTV (generates one image description per segment, 200-300 words each).
 * Phase 2: shorter motion prompts (100-200 words each).
 */
function estimateITVTokens(
  wordCount: number,
  totalImages: number,
  model: string,
  isLegacy: boolean,
): { inputTokens: number; outputTokens: number } {
  const numBatches = Math.max(1, Math.ceil(totalImages / BATCH_SIZE));

  // Phase 1: image prompt generation
  const phase1Input  = numBatches * (wordCount + 1100) * TOKEN_PER_WORD + 665;
  const phase1Output = totalImages * 350 * TOKEN_PER_WORD; // ~300 words per image prompt

  // Phase 2: motion/animation prompt generation (shorter prompts)
  const phase2Input  = numBatches * (totalImages * 350 + 800) * TOKEN_PER_WORD + 400;
  const phase2Output = totalImages * 200 * TOKEN_PER_WORD; // ~150 words per motion prompt

  const multiplier = llmMultiplier(isLegacy, model);
  return {
    inputTokens:  Math.round((phase1Input  + phase2Input)  * 1.25 * multiplier),
    outputTokens: Math.round((phase1Output + phase2Output) * multiplier),
  };
}

// ─── Text utilities ───────────────────────────────────────────────────────────
function splitTextIfLarge(text: string): string[] {
  if (text.length <= MAX_TEXT_PART_CHARS) return [text];

  const findSafePartEnd = (start: number, maxEnd: number): number => {
    const minEnd = Math.min(start + MIN_TEXT_PART_LENGTH, text.length);
    let end = maxEnd;

    // Prefer paragraph/sentence boundaries first.
    while (end > minEnd && !/\n\n|[.!?]\s/.test(text.slice(end - 1, end + 1))) end--;

    // If no sentence boundary found, back up to a word boundary.
    if (end <= minEnd) {
      end = maxEnd;
      while (end > minEnd && end < text.length && /[a-zA-Z0-9]/.test(text[end - 1]) && /[a-zA-Z0-9]/.test(text[end])) {
        end--;
      }
    }

    // Final fallback: hard cap (can still happen on very long unbroken tokens).
    if (end <= start) end = maxEnd;
    return end;
  };

  const parts: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const maxEnd = Math.min(pos + MAX_TEXT_PART_CHARS, text.length);
    const end = findSafePartEnd(pos, maxEnd);
    parts.push(text.slice(pos, end).trim());
    pos = end;
  }
  return parts.filter(p => p.length >= MIN_TEXT_PART_LENGTH);
}
function calculateWordCount(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function normalizeText(text: string): string {
  if (!text) return text;
  // Strip SSML break tags (well-formed, malformed, and incomplete)
  text = text.replace(/<break\b[^>]*?\/?>/gi, '');
  text = text.replace(/<break\b[^>]*$/gm, '');
  text = text.replace(/^\s*["'\u2018\u2019\u201C\u201D]?\d+ms["'\u2018\u2019\u201C\u201D]?\s*\/?>/gm, '');
  let n = text
    .replace(/\uFFFD/g, "'").replace(/â€™/g, "'").replace(/â€œ/g, '"')
    .replace(/â€\u009D/g, '"').replace(/â€"/g, '—').replace(/â€"/g, '–')
    .replace(/â€¦/g, '…').replace(/Ã¢â‚¬â„¢/g, "'").replace(/Ã¢â‚¬Å"/g, '"')
    .replace(/Ã¢â‚¬Â/g, '"').replace(/Ã¢â‚¬â€œ/g, '—')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u2039\u203A]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/'/g, "'").replace(/'/g, "'").replace(/"/g, '"').replace(/"/g, '"')
    .replace(/[\u2010\u2011\u2012]/g, '-').replace(/\u2015/g, '—')
    .replace(/\u2026/g, '...').replace(/\u00A0/g, ' ');
  n = n.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(l => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return n;
}

// Sanitise segment text so that when the AI echoes it back inside its JSON response,
// stray backslashes and double-quote chars do not produce invalid JSON.
function sanitizeSegmentText(text: string): string {
  // Strip any SSML break tag remnants (well-formed, malformed, or orphaned fragments)
  text = text.replace(/<break\b[^>]*?\/?>/gi, '');
  text = text.replace(/<break\b[^>]*$/gm, '');
  text = text.replace(/^\s*["'\u2018\u2019\u201C\u201D]?\d+ms["'\u2018\u2019\u201C\u201D]?\s*\/?>/gm, '');
  return text
    .replace(/\\/g, '')      // remove lone backslashes
    .replace(/"/g, "'");    // replace double quotes with single quotes
}

function cleanTextForITV(text: string): string {
  const lines = text.split('\n');
  const chapterPattern = /^\*\*Chapter \d+.*\*\*$/;
  const cleanedLines: string[] = [];
  for (const line of lines) {
    if (chapterPattern.test(line.trim())) continue;
    cleanedLines.push(line);
  }
  return normalizeText(cleanedLines.join('\n').trim());
}

// ─── Segmentation ─────────────────────────────────────────────────────────────

function findSplitPoint(text: string, targetPos: number, minPos: number = 0, idealSize?: number): number {
  if (targetPos >= text.length) return text.length;
  if (targetPos <= minPos) return minPos;

  // Scale search windows proportionally to segment size (caps at legacy values for long segments)
  const sentenceRadius = idealSize && idealSize > 0
    ? Math.max(10, Math.min(Math.floor(idealSize * 0.20), 100))
    : 100;
  const paraRadius = idealSize && idealSize > 0
    ? Math.max(15, Math.min(Math.floor(idealSize * 0.35), 200))
    : 200;

  const sentenceEnds = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
  for (let offset = 0; offset < sentenceRadius; offset++) {
    const fwd = targetPos + offset;
    if (fwd < text.length && sentenceEnds.includes(text.slice(fwd - 1, fwd + 1))) return fwd;
    const bwd = targetPos - offset;
    if (bwd > minPos && sentenceEnds.includes(text.slice(bwd - 1, bwd + 1))) return bwd;
  }
  for (let offset = 0; offset < paraRadius; offset++) {
    const fwd = targetPos + offset;
    if (fwd < text.length && text.slice(fwd - 1, fwd + 1) === '\n\n') return fwd;
    const bwd = targetPos - offset;
    if (bwd > minPos && text.slice(bwd - 1, bwd + 1) === '\n\n') return bwd;
  }
  let pos = targetPos;
  while (pos > minPos && /[a-zA-Z0-9]/.test(text[pos - 1]) && /[a-zA-Z0-9]/.test(text[pos])) pos--;
  return pos > minPos ? pos : targetPos;
}

// Mirrors TTV's forceExactSegments: use a running currentPos so each segment starts
// exactly where the previous one ended — no overlap, no mid-word starts.
function forceExactSegments(text: string, n: number): ITVSegment[] {
  if (n <= 0) return [];
  const trimmed = text.trim();
  if (!trimmed) return Array.from({ length: n }, (_, i) => ({ text: '', index: i + 1 }));
  if (n === 1) return [{ text: trimmed, index: 1 }];

  const segments: ITVSegment[] = [];
  const textLength = trimmed.length;
  // Precompute ideal segment size so the split-point search radius stays proportional
  const idealSize = textLength / n;
  let currentPos = 0;

  for (let i = 0; i < n; i++) {
    // Skip leading whitespace so segments always start at real content,
    // preventing the backward scan from re-finding the previous boundary.
    while (currentPos < textLength && /\s/.test(trimmed[currentPos])) {
      currentPos++;
    }

    if (i === n - 1 || currentPos >= textLength) {
      // Last segment (or text exhausted): take everything remaining
      segments.push({ text: trimmed.slice(currentPos).trim() || 'Content segment', index: i + 1 });
      break;
    } else {
      // Proportional target based on remaining text and remaining segments (mirrors TTV)
      const remaining = textLength - currentPos;
      const remainingSegs = n - i;
      const targetEnd = currentPos + Math.round(remaining / remainingSegs);
      const splitAt = Math.max(currentPos + 1, Math.min(findSplitPoint(trimmed, targetEnd, currentPos, idealSize), textLength - (remainingSegs - 1)));
      segments.push({ text: trimmed.slice(currentPos, splitAt).trim() || 'Content segment', index: i + 1 });
      currentPos = splitAt;
    }
  }

  // Guarantee exact count
  while (segments.length < n) {
    const last = segments[segments.length - 1];
    segments.push({ text: last?.text ?? 'Content segment', index: segments.length + 1 });
  }
  return segments.slice(0, n);
}

// ─── Character extraction ─────────────────────────────────────────────────────

async function extractCharacterDescriptions(content: string): Promise<{
  characters: Record<string, string>;
  inputTokens: number;
  outputTokens: number;
}> {
  if (!deepseekApiKey) throw new Error('DEEPSEEK_API_KEY not set for character extraction');

  const wordCount = calculateWordCount(content);
  const systemPrompt = `You are an expert story analyst specializing in character identification and visual description for video generation. Your task is to identify the 3-5 most important characters from the provided story and create detailed visual descriptions suitable for AI video generation.

CRITICAL RULES:
1. Focus ONLY on characters with significant story roles
2. Descriptions must be purely visual - physical appearance only
3. Each description should be 3-4 sentences
4. NO personality traits, emotions, or story roles
5. You MUST include ALL of the following for each character:
   - Approximate age range and gender
   - Physical build (height, body type)
   - Face: skin tone, eye color, any facial hair or distinctive facial features
   - Hair: specific color, length, texture, and style (e.g. "short curly black hair", "long straight blonde hair in a ponytail")
   - Clothing: full outfit description including tops, bottoms, layers (e.g. "wearing a brown tweed jacket over a white button-up shirt and dark trousers")
   - Footwear: specific shoe/boot type or barefoot (e.g. "brown leather boots", "white sneakers", "barefoot")
   - Accessories: glasses/sunglasses, jewelry, hats, bags, watches, scarves, or "no accessories"
6. If the story does not explicitly describe any required attribute (hair, eyes, skin tone, build, age, facial features, clothing, footwear, or accessories), you MUST commit to one specific, plausible value inferred from the character's age, role, setting, time period, and overall story tone — this is required so the character stays visually consistent across scenes. NEVER write hedge phrases like "not specified", "not mentioned", "unknown", "indeterminate", "unspecified", or "no [X] mentioned", and never leave any attribute blank. Keep inferred details simple and natural; do not over-elaborate or invent dramatic features the story does not support.
7. For animal characters: describe species, breed/type, fur/feather color and pattern, size, and any distinguishing markings. Do NOT add clothing unless the story explicitly describes the animal wearing clothes
8. Output as JSON object only: {"Character Name": "visual description", ...}
9. If no clear characters exist, output: {}`;

  const userMsg = wordCount > 8000
    ? `Extract key character descriptions from this story. Focus on main characters.\n\nSTORY EXCERPT:\n${content.slice(0, 50000)}...`
    : `Extract key character descriptions from this story.\n\nSTORY:\n${content}`;

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${deepseekApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
      max_tokens: 3000,
      temperature: 0.3,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek character extraction failed: HTTP ${response.status} - ${errorText.slice(0, 200)}`);
  }

  const result = await response.json();
  const rawContent = result.choices?.[0]?.message?.content?.trim() ?? '{}';
  const inputTokens = result.usage?.prompt_tokens ?? 0;
  const outputTokens = result.usage?.completion_tokens ?? 0;

  let cleaned = rawContent;
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === 'object' && parsed !== null) {
      const chars: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') chars[k] = v;
      }
      console.log(`Extracted ${Object.keys(chars).length} characters`);
      return { characters: chars, inputTokens, outputTokens };
    }
  } catch (_) {
    console.warn('Failed to parse character extraction response, using empty characters');
  }

  return { characters: {}, inputTokens, outputTokens };
}

// ─── Custom character AI enhancement ──────────────────────────────────────────

async function enhanceCustomCharacterDescriptions(
  characters: Array<{ name: string; description: string }>,
  storyTitle: string,
  style: string
): Promise<{
  enhanced: Record<string, string>;
  inputTokens: number;
  outputTokens: number;
}> {
  const characterList = characters
    .filter(c => c.name.trim())
    .map(c => `- ${c.name}: ${c.description || 'No description provided'}`)
    .join('\n');

  const systemPrompt = `You are an expert visual character designer. Given a list of characters with basic descriptions, expand each into a detailed visual description optimized for video generation. You MUST include ALL of these attributes for each human character: physical build and age range, face (skin tone, eye color, facial hair), hair (specific color, length, texture, style e.g. "short curly black hair"), clothing (full outfit: tops, bottoms, layers with colors), footwear (specific type or barefoot), and accessories (glasses, jewelry, hats, etc. or "no accessories"). For any required attribute the user did not specify, infer one specific, plausible value from the character's role, setting, time period, and overall story tone — NEVER use hedge phrases like "not specified", "not mentioned", "unknown", "indeterminate", "unspecified", or "no [X] mentioned", and never leave any attribute blank. Keep inferred details simple and natural; do not over-elaborate. For animal characters: describe species, breed/type, fur/feather color and pattern, size, and distinguishing markings—do NOT add clothing unless explicitly described. Keep each description 3-4 sentences. The story title is "${storyTitle}" and the visual style is: ${style.substring(0, 200)}. Output a JSON object where each key is the character's name (exactly as given) and the value is the enhanced visual description string. Return only the JSON object.`;
  const userPrompt = `Enhance these character descriptions for video generation:\n${characterList}`;

  const retries = 3;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${deepseekApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 3000,
          temperature: 0.7,
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`DeepSeek API error: ${await response.text()}`);
      }

      let jsonOutput = (await response.json()).choices[0].message.content.trim();
      const inputTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4);
      const outputTokens = Math.ceil(jsonOutput.length / 4);

      if (jsonOutput.startsWith('```json')) jsonOutput = jsonOutput.slice(7);
      if (jsonOutput.startsWith('```')) jsonOutput = jsonOutput.slice(3);
      if (jsonOutput.endsWith('```')) jsonOutput = jsonOutput.slice(0, -3);

      const enhanced = JSON.parse(jsonOutput.trim());
      console.log(`Successfully enhanced ${Object.keys(enhanced).length} custom characters`);
      return { enhanced, inputTokens, outputTokens };
    } catch (error: any) {
      if (attempt < retries - 1) {
        const waitTime = 3 * Math.pow(2, attempt);
        console.log(`Enhancement attempt ${attempt + 1} failed: ${error.message}. Retrying in ${waitTime}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
        continue;
      }
      console.error(`Failed to enhance characters after ${retries} attempts, using raw descriptions`);
      const fallback: Record<string, string> = {};
      for (const char of characters) {
        if (char.name.trim()) {
          fallback[char.name.trim()] = char.description || 'A character in the story.';
        }
      }
      return { enhanced: fallback, inputTokens: 0, outputTokens: 0 };
    }
  }
  const fallback: Record<string, string> = {};
  for (const char of characters) {
    if (char.name.trim()) {
      fallback[char.name.trim()] = char.description || 'A character in the story.';
    }
  }
  return { enhanced: fallback, inputTokens: 0, outputTokens: 0 };
}

// ─── serve ────────────────────────────────────────────────────────────────────

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

Deno.serve(async (req) => {
  const corsOrigin = getCorsOrigin(req);
  const corsHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get('Authorization');
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!authToken) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }    // authToken resolved above (Bearer or apikey)
    const _srvKey = Deno.env.get('SECRET_KEY') || '';
    const _secretKey = Deno.env.get('SECRET_KEY') || '';
    let _authenticatedUserId: string | null = null;

    if (authToken === _srvKey || authToken === _secretKey) {
      // Server-to-server call (legacy or new secret key)
    } else {
      const { data: { user: _authUser }, error: _authErr } = await supabase.auth.getUser(authToken);
      if (_authErr || !_authUser) {
        return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      _authenticatedUserId = _authUser.id;
    }

    const startTime = Date.now();
    const maxRuntime = 300000;

    const requestData: SetupRequest = await req.json();

    // When JWT auth is used, override body user_id with authenticated user
    if (_authenticatedUserId && requestData.user_id) {
      requestData.user_id = _authenticatedUserId;
    }

    const {
      user_id,
      group_id,
      file_path,
      story_title,
      description,
      video_model,
      clip_duration,
      totalAudioDuration,
      image_model = 'imagen-4-fast',
      model,
      language,
      tab = 1,
      variant = 1,
      audio_clip = false,
      userTokenBalance,
      useCharacterDescriptions = true,
    } = requestData;
    const videoProcess = requestData.videoProcess === true;
    const customCharactersEnabled = requestData.customCharactersEnabled ?? false;
    const customCharacters = requestData.customCharacters ?? [];
    const customCharactersAIEnhance = requestData.customCharactersAIEnhance ?? false;
    const style = (typeof requestData.style === 'string' && requestData.style.trim().length > 0)
      ? requestData.style.trim()
      : DEFAULT_IMAGE_STYLE;

    // ── Validation ──────────────────────────────────────────────────────────

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!user_id || !uuidRegex.test(user_id)) throw new Error('Missing or invalid user_id');
    if (!group_id || !uuidRegex.test(group_id)) throw new Error('Missing or invalid group_id');
    if (!file_path || typeof file_path !== 'string') throw new Error('Missing or invalid file_path');
    if (!story_title || typeof story_title !== 'string') throw new Error('Missing or invalid story_title');
    if (!description || typeof description !== 'string') throw new Error('Missing or invalid description');
    if (!video_model || typeof video_model !== 'string') throw new Error('Missing or invalid video_model');
    if (typeof totalAudioDuration !== 'number' || totalAudioDuration <= 0) throw new Error('Invalid totalAudioDuration');

    // Resolve clip_duration: use provided value, else fall back to model default
    const requestedClipDuration: number = (typeof requestData.clip_duration === 'number' && requestData.clip_duration > 0)
      ? requestData.clip_duration
      : (ITV_VIDEO_MODEL_CONFIGS[video_model]?.defaultDuration ?? 0);
    if (requestedClipDuration <= 0) throw new Error(`clip_duration not provided and no default known for model: ${video_model}`);

    // Defensive clamp against the model's allowed per-clip durations.
    // Upstream (plan-video LLM) has occasionally sent total runtime instead of per-clip length.
    const { duration: resolvedClipDuration, clamped: clipDurationClamped } =
      clampClipDurationForModel(video_model, requestedClipDuration);
    if (clipDurationClamped) {
      console.warn(`[setup-itv-prompts] clip_duration ${requestedClipDuration}s out of range for model "${video_model}" — clamped to ${resolvedClipDuration}s`);
    }

    if (typeof userTokenBalance !== 'number') throw new Error('Missing or invalid userTokenBalance');

    const validatedLanguage = ['english', 'german', 'spanish', 'french'].includes(language || '') ? language! : 'english';
    const validatedModel = ['deepseek', 'sonnet', 'opus'].includes(model || '') ? model! : 'sonnet';

    // ── Compute totalImages ─────────────────────────────────────────────────

    const totalImages = Math.floor(totalAudioDuration / resolvedClipDuration);
    if (totalImages < 1) {
      throw new Error(`totalAudioDuration (${totalAudioDuration}s) / clip_duration (${resolvedClipDuration}s) = ${totalImages} — too few images`);
    }
    console.log(`ITV setup: ${totalImages} images (${totalAudioDuration}s / ${resolvedClipDuration}s), model=${video_model}`);

    // ── Prevent duplicate variants ───────────────────────────────────────────
    // Check both ITV_prompt_tasks (prompt generation) and ITV_tasks (video generation)
    // to ensure the variant doesn't collide with any existing process for this group/tab.

    const [promptTasksRes, videoTasksRes] = await Promise.all([
      supabase
        .from('ITV_prompt_tasks')
        .select('variant')
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .eq('tab', tab),
      supabase
        .from('ITV_tasks')
        .select('variant')
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .eq('tab', tab),
    ]);

    if (promptTasksRes.error) {
      console.warn(`Warning: Could not check ITV_prompt_tasks variants: ${promptTasksRes.error.message}`);
    }
    if (videoTasksRes.error) {
      console.warn(`Warning: Could not check ITV_tasks variants: ${videoTasksRes.error.message}`);
    }

    const existingVariants = new Set<number>();
    for (const t of (promptTasksRes.data ?? [])) {
      if (t.variant !== null && t.variant !== undefined) existingVariants.add(t.variant);
    }
    for (const t of (videoTasksRes.data ?? [])) {
      if (t.variant !== null && t.variant !== undefined) existingVariants.add(t.variant);
    }

    let finalVariant = variant;
    if (existingVariants.has(variant)) {
      const highestVariant = Math.max(...Array.from(existingVariants));
      finalVariant = highestVariant + 1;
    }
    console.log(`Variant check: requested=${variant}, existing=[${Array.from(existingVariants).sort((a, b) => a - b).join(', ')}], using=${finalVariant}`);

    // ── Download story text ─────────────────────────────────────────────────

    const { data: fileData, error: fileError } = await supabase.storage.from('stories').download(file_path);
    if (fileError || !fileData) throw new Error(`Failed to download story: ${fileError?.message ?? 'No data'}`);
    const rawContent = await fileData.text();
    if (!rawContent || rawContent.length === 0) throw new Error('Story content is empty');

    // ── Segment text (multi-part if > MAX_TEXT_PART_CHARS) ─────────────────

    const cleanedText = cleanTextForITV(rawContent);
    const wordCount = calculateWordCount(cleanedText);
    const textParts = splitTextIfLarge(cleanedText);
    if (textParts.length === 0) throw new Error('Story text is too short to produce ITV segments');
    console.log(`Split into ${textParts.length} text part(s): ${textParts.map(p => calculateWordCount(p)).join(', ')} words`);

    // Distribute totalImages proportionally across parts (by character length)
    const totalChars = cleanedText.length;
    const partImageCounts: number[] = textParts.map((p, i) => {
      if (i === textParts.length - 1) return 0; // placeholder; filled below
      return Math.max(1, Math.round(totalImages * p.length / totalChars));
    });
    // Last part gets the remainder so total stays exact
    const assignedSoFar = partImageCounts.slice(0, -1).reduce((a, b) => a + b, 0);
    partImageCounts[textParts.length - 1] = Math.max(1, totalImages - assignedSoFar);

    // Build per-part segment arrays
    const segmentsByPart: Record<string, Array<{ text: string; index: number }>> = {};
    let globalIndex = 1;
    for (let pIdx = 0; pIdx < textParts.length; pIdx++) {
      const partNumber = pIdx + 1;
      const partSegs = forceExactSegments(textParts[pIdx], partImageCounts[pIdx]);
      // Sanitize segment text to prevent AI JSON echo issues
      segmentsByPart[String(partNumber)] = partSegs.map(s => ({ text: sanitizeSegmentText(s.text), index: globalIndex++ }));
    }
    const totalSegments = Object.values(segmentsByPart).reduce((a, arr) => a + arr.length, 0);
    console.log(`Segmented into ${totalSegments} ITV clips across ${textParts.length} part(s)`);

    // ── Character extraction ────────────────────────────────────────────────

    let characters: Record<string, string> = {};
    if (useCharacterDescriptions !== false) {
      if (customCharactersEnabled && customCharacters.length > 0) {
        // Custom characters path: user provided their own character descriptions
        const validCustomChars = customCharacters.filter((c: any) => c.name && c.name.trim());
        
        if (validCustomChars.length > 0) {
          if (customCharactersAIEnhance) {
            // AI Enhancement: expand basic descriptions into detailed visual descriptions
            console.log(`Enhancing ${validCustomChars.length} custom characters with AI...`);
            try {
              const { enhanced } = await enhanceCustomCharacterDescriptions(
                validCustomChars,
                story_title,
                style
              );
              characters = enhanced;
              console.log(`AI-enhanced ${Object.keys(characters).length} custom characters`);
            } catch (err: any) {
              console.warn(`ITV custom character enhancement failed (non-fatal): ${err.message}`);
              for (const char of validCustomChars) {
                characters[char.name.trim()] = char.description || 'A character in the story.';
              }
            }
          } else {
            // No AI enhancement: convert array to Record<string, string> directly
            console.log(`Using ${validCustomChars.length} custom characters without AI enhancement`);
            for (const char of validCustomChars) {
              characters[char.name.trim()] = char.description || 'A character in the story.';
            }
          }
        } else {
          console.log('Custom characters enabled but none have names, falling back to extraction');
          try {
            const { characters: extracted } = await extractCharacterDescriptions(cleanedText);
            characters = extracted;
            console.log(`ITV character extraction: ${Object.keys(characters).length} characters found`);
          } catch (charErr: any) {
            console.warn(`ITV character extraction failed (non-fatal): ${charErr.message}`);
            characters = {};
          }
        }
      } else {
        // Default path: auto-extract from story text
        try {
          const { characters: extracted } = await extractCharacterDescriptions(cleanedText);
          characters = extracted;
          console.log(`ITV character extraction: ${Object.keys(characters).length} characters found`);
        } catch (charErr: any) {
          console.warn(`ITV character extraction failed (non-fatal): ${charErr.message}`);
          characters = {};
        }
      }

      // Check if custom character names appear in the story text
      // Only true when custom characters are enabled AND their names are found in the story
      let customCharsInStory = false;
      if (customCharactersEnabled && Object.keys(characters).length > 0) {
        const storyLower = cleanedText.toLowerCase();
        const matchedNames = Object.keys(characters).filter(name => storyLower.includes(name.toLowerCase().trim()));
        if (matchedNames.length === 0) {
          customCharsInStory = false;
          console.log(`⚠️ None of the custom character names were found in the story text. All characters will be appended to every prompt as fallback.`);
        } else {
          console.log(`✓ Found ${matchedNames.length} of ${Object.keys(characters).length} character name(s) in story: ${matchedNames.join(', ')}`);
        }
      }

      // Update all context parts with character descriptions and custom_chars_in_story
      for (let pIdx = 0; pIdx < textParts.length; pIdx++) {
        await supabase
          .from('ITV_prompt_context')
          .update({
            character_descriptions: Object.keys(characters).length > 0 ? characters : null,
            custom_chars_in_story: customCharsInStory,
            updated_at: new Date().toISOString(),
          })
          .eq('group_id', group_id)
          .eq('part_number', pIdx + 1)
          .eq('tab', tab);
      }
    }

    // ── Token estimation ────────────────────────────────────────────────────

    const isLegacyPlan = await getIsLegacyPlan(user_id);
    const estimate = estimateITVTokens(wordCount, totalImages, validatedModel, isLegacyPlan);
    const estimatedTokens = estimate.inputTokens + estimate.outputTokens;
    console.log(`Token estimate: input=${estimate.inputTokens}, output=${estimate.outputTokens}, total=${estimatedTokens} (${validatedModel})`);

    // ── Store Phase 1 context (one row per part) ────────────────────────────

    for (let pIdx = 0; pIdx < textParts.length; pIdx++) {
      const partNumber = pIdx + 1;
      const { error: ctxError } = await supabase
        .from('ITV_prompt_context')
        .upsert({
          group_id,
          user_id,
          tab,
          part_number: partNumber,
          itv: false,
          full_story_text: textParts[pIdx],
          word_count: calculateWordCount(textParts[pIdx]),
          character_count: textParts[pIdx].length,
          video_model,
          video_duration: resolvedClipDuration,
          total_videos: totalImages,
          audio_duration: totalAudioDuration,
          audio_clip,
          image_model,
          style_description: style,
          character_descriptions: Object.keys(characters).length > 0 ? characters : null,
          use_character_descriptions: useCharacterDescriptions !== false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'group_id,tab,part_number,itv' });

      if (ctxError) throw new Error(`Failed to store ITV context part ${partNumber}: ${ctxError.message}`);
    }

    // ── Write job_data ──────────────────────────────────────────────────────

    const jobId = crypto.randomUUID();

    const { error: jobError } = await supabase.from('job_data').insert({
      id: jobId,
      user_id,
      data: {
        user_id,
        group_id,
        file_path,
        story_title,
        description,
        video_model,
        clip_duration: resolvedClipDuration,
        total_images: totalImages,
        image_model,
        variant: finalVariant,
        is_corrected: false,
        userTokenBalance,
        language: validatedLanguage,
        model: validatedModel,
        tab,
        audio_clip,
        style,
        textParts: textParts.map((_, i) => String(i + 1)),  // ["1","2",...]
        segmentsByPart,                                       // {"1":[...], "2":[...]}
        characters,
        useCharacterDescriptions: useCharacterDescriptions !== false,
        videoProcess,
      },
    });

    if (jobError) throw new Error(`Failed to insert ITV job data: ${jobError.message}`);
    console.log(`Inserted ITV job data jobId=${jobId} (${textParts.length} part(s))`);

    // ── Trigger process-itv-task ────────────────────────────────────────────

    try {
      const resp = await fetchWithDenoFallback('process-itv-task', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': Deno.env.get('SECRET_KEY'),
        },
        body: JSON.stringify({ jobId, user_id }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errText}`);
      }
      console.log(`Triggered process-itv-task for jobId=${jobId}`);
    } catch (triggerErr: any) {
      await supabase.from('job_data').delete().eq('id', jobId);
      throw new Error(`Failed to trigger process-itv-task: ${triggerErr.message}`);
    }

    return new Response(JSON.stringify({
      job_id: jobId,
      total_images: totalImages,
      text_parts: textParts.length,
      language: validatedLanguage,
      model: validatedModel,
      variant: finalVariant,
      tab,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });

  } catch (error: any) {
    console.error(`Error in setup-itv-prompts: ${error.message}`);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
    });
  }
});




