
import { createClient } from 'npm:@supabase/supabase-js@2';
import { fetchWithDenoFallback } from '../_shared/fetchWithDenoFallback.ts';
import { getIsLegacyPlan, llmMultiplier } from '../_shared/tokenCosts.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TTVSegment {
  text: string;
  start: number;
  video_duration: number;
}

interface SetupRequest {
  user_id: string;
  group_id: string;
  file_path: string;
  story_title: string;
  description: string;
  style: string;
  video_model: string;
  video_duration: number;
  totalAudioDuration: number;
  useCharacterDescriptions: boolean;
  customCharactersEnabled?: boolean;
  customCharacters?: Array<{ name: string; description: string }>;
  customCharactersAIEnhance?: boolean;
  model?: string;
  language?: string;
  tab?: number;
  variant?: number;
  masterPromptData?: any;
  environmentOnlyMode?: boolean;
  userTokenBalance: number;
  audio_clip?: boolean;  high_res?: boolean;
  videoProcess?: boolean;     // when true (called from video pipeline), skip token balance check
}

interface JobRequest {
  jobId: string;
  user_id: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BATCH_SIZE = 2;         // 2 segments per batch (TTV)
const MAX_RETRIES = 3;
const BATCH_DELAY_MS = 500;
const TOKEN_PER_WORD = 1.33;
const MAX_TEXT_PART_CHARS = 56000; // ~8000 words
const MIN_TEXT_PART_LENGTH = 50;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SECRET_KEY") || ""
);

const deepseekApiKey = Deno.env.get("DEEPSEEK_API_KEY") || "";

// ─── Model configs ────────────────────────────────────────────────────────────

const MODEL_CONFIGS: Record<string, { tokenMultiplier: number }> = {
  deepseek: { tokenMultiplier: 1.0 },
  sonnet:   { tokenMultiplier: 11.0 },
  opus:     { tokenMultiplier: 19.0 },
};

function getTokenMultiplier(model: string): number {
  return MODEL_CONFIGS[model]?.tokenMultiplier ?? 1.0;
}

// ─── TTV video model configs (per-clip duration limits) ───────────────────
// Mirrors src/components/VideoModelSelector.tsx.

const TTV_VIDEO_MODEL_CONFIGS: Record<string, { name: string; defaultDuration: number; durationOptions?: number[]; durationMin?: number; durationMax?: number }> = {
  seedance_pro_fast: { name: 'Seedance 1.0 Pro Fast',   defaultDuration: 6,    durationMin: 2, durationMax: 12 },
  ltx23_fast:        { name: 'LTX 2.3 Fast',            defaultDuration: 6,    durationOptions: [6, 10, 16] },
  grok:              { name: 'Grok Video',              defaultDuration: 5,    durationMin: 2, durationMax: 15 },
  seedance15_pro:    { name: 'Seedance 1.5 Pro',        defaultDuration: 6,    durationMin: 4, durationMax: 12 },
  veo31fast:         { name: 'Veo 3.1 Fast',            defaultDuration: 4,    durationOptions: [4, 6, 8] },
  ltx23_pro:         { name: 'LTX 2.3 Pro',             defaultDuration: 6,    durationOptions: [6, 8, 10] },
  veo31:             { name: 'Veo 3.1',                 defaultDuration: 4,    durationOptions: [4, 6, 8] },
  sora2pro:          { name: 'Sora 2 Pro',              defaultDuration: 4,    durationOptions: [4, 8, 12] },
  sora2pro_highres:  { name: 'Sora 2 Pro HighRes',      defaultDuration: 4,    durationOptions: [4, 8, 12] },
};

/**
 * Clamp a requested per-clip duration to the legal range/options for the given model.
 * Defends against upstream callers (e.g. plan-video LLM) sending nonsense values
 * such as the total runtime instead of a per-clip length.
 */
function clampVideoDurationForModel(model: string, requested: number): { duration: number; clamped: boolean } {
  const cfg = TTV_VIDEO_MODEL_CONFIGS[model];
  if (!cfg) {
    if (requested > 0 && requested <= 16) return { duration: requested, clamped: false };
    return { duration: Math.min(Math.max(requested, 1), 16), clamped: true };
  }
  if (cfg.durationOptions && cfg.durationOptions.length > 0) {
    if (cfg.durationOptions.includes(requested)) return { duration: requested, clamped: false };
    const eligible = cfg.durationOptions.filter(o => o <= requested);
    const snapped = eligible.length > 0 ? Math.max(...eligible) : Math.min(...cfg.durationOptions);
    return { duration: snapped, clamped: true };
  }
  if (typeof cfg.durationMin === 'number' && typeof cfg.durationMax === 'number') {
    if (requested < cfg.durationMin) return { duration: cfg.durationMin, clamped: true };
    if (requested > cfg.durationMax) return { duration: cfg.durationMax, clamped: true };
    return { duration: requested, clamped: false };
  }
  if (Math.abs(requested - cfg.defaultDuration) < 0.01) return { duration: cfg.defaultDuration, clamped: false };
  return { duration: cfg.defaultDuration, clamped: true };
}

// ─── Token estimation ─────────────────────────────────────────────────────────

/**
 * Estimates total (input + output) raw tokens for TTV generation,
 * then multiplies by the model's token multiplier (deepseek=1×, sonnet=10×, opus=48×).
 * Mirrors the Python estimate_total_tokens_video() function.
 */
function estimateTTVTokens(
  wordCount: number,
  totalVideos: number,
  hasCharacters: boolean,
  model: string,
  isLegacy: boolean,
): { inputTokens: number; outputTokens: number } {
  const numBatches = Math.max(1, Math.ceil((wordCount + 300 * totalVideos) / 900));

  let rawInput: number;
  let rawOutput: number;

  if (hasCharacters) {
    rawInput  = (wordCount + 150) * TOKEN_PER_WORD        // character extraction
              + numBatches * (wordCount + 1600) * TOKEN_PER_WORD  // prompt generation
              + 665;                                               // batch overhead
    rawOutput = 200 * 5                                    // character descriptions
              + totalVideos * 1200 * TOKEN_PER_WORD;       // TTV prompts
  } else {
    rawInput  = numBatches * (wordCount + 1100) * TOKEN_PER_WORD  // prompt generation
              + 665;
    rawOutput = totalVideos * 1200 * TOKEN_PER_WORD;
  }

  const multiplier = llmMultiplier(isLegacy, model);
  return {
    inputTokens:  Math.round(rawInput  * 1.25 * multiplier), // 1.25 safety margin
    outputTokens: Math.round(rawOutput * multiplier),
  };
}

// ─── Text utilities ───────────────────────────────────────────────────────────

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

function cleanTextForTTV(text: string): string {
  const lines = text.split('\n');
  const chapterPattern = /^\*\*Chapter \d+.*\*\*$/;
  const cleanedLines: string[] = [];
  let skipFirst = true;

  for (const line of lines) {
    if (chapterPattern.test(line.trim())) continue;
    if (skipFirst && line.trim() && !line.trim().startsWith('**')) {
      skipFirst = false;
      continue;
    }
    skipFirst = false;
    cleanedLines.push(line);
  }

  return normalizeText(cleanedLines.join('\n').trim());
}

function splitTextIfLarge(text: string): string[] {
  if (text.length <= MAX_TEXT_PART_CHARS) {
    if (text.length < MIN_TEXT_PART_LENGTH) return [];
    return [text];
  }

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
    const part = text.slice(pos, end).trim();
    if (part.length >= MIN_TEXT_PART_LENGTH) parts.push(part);
    else if (part.length > 0 && parts.length > 0) parts[parts.length - 1] += '\n\n' + part;
    pos = end;
  }
  return parts.filter(p => p.trim().length >= MIN_TEXT_PART_LENGTH);
}

// ─── Core segmentation — force_exact_segments TS port ────────────────────────

/**
 * Finds the best position to split text near targetPos.
 * Priority: sentence boundary → paragraph boundary → word boundary (backward walk).
 * Search radii are scaled to idealSize so short segments aren't over-searched.
 * Always returns a position that is NOT mid-word.
 */
function findTTVSplitPoint(text: string, targetPos: number, minPos: number = 0, idealSize?: number): number {
  if (targetPos >= text.length) return text.length;
  if (targetPos <= minPos) return minPos;

  // Scale search windows proportionally to segment size (caps at legacy values for long segments)
  const sentenceRadius = idealSize && idealSize > 0
    ? Math.max(10, Math.min(Math.floor(idealSize * 0.20), 100))
    : 100;
  const paraRadius = idealSize && idealSize > 0
    ? Math.max(15, Math.min(Math.floor(idealSize * 0.35), 200))
    : 200;

  // 1. Sentence boundaries within sentenceRadius chars
  const sentenceEnds = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
  for (let offset = 0; offset < sentenceRadius; offset++) {
    const fwd = targetPos + offset;
    if (fwd < text.length && sentenceEnds.includes(text.slice(fwd - 1, fwd + 1))) return fwd;
    const bwd = targetPos - offset;
    if (bwd > minPos && sentenceEnds.includes(text.slice(bwd - 1, bwd + 1))) return bwd;
  }

  // 2. Paragraph boundaries within paraRadius chars
  for (let offset = 0; offset < paraRadius; offset++) {
    const fwd = targetPos + offset;
    if (fwd < text.length && text.slice(fwd - 1, fwd + 1) === '\n\n') return fwd;
    const bwd = targetPos - offset;
    if (bwd > minPos && text.slice(bwd - 1, bwd + 1) === '\n\n') return bwd;
  }

  // 3. Word boundary — walk backward until we're not mid-word, but not below minPos
  let pos = targetPos;
  while (pos > minPos && /[a-zA-Z0-9]/.test(text[pos - 1]) && /[a-zA-Z0-9]/.test(text[pos])) {
    pos--;
  }
  return pos > minPos ? pos : targetPos;
}

function forceExactSegments(text: string, n: number, videoDuration: number): TTVSegment[] {
  if (n <= 0) return [];
  const trimmed = text.trim();
  if (!trimmed) {
    return Array.from({ length: n }, () => ({ text: '', start: 0, video_duration: videoDuration }));
  }
  if (n === 1) return [{ text: trimmed, start: 0, video_duration: videoDuration }];

  const segments: TTVSegment[] = [];
  const textLength = trimmed.length;
  // Precompute ideal segment size so the split-point search radius stays proportional
  const idealSize = textLength / n;
  let currentPos = 0;

  for (let i = 0; i < n; i++) {
    // Skip leading whitespace so segments always start at real content,
    // preventing the backward scan from re-finding the previous sentence boundary.
    while (currentPos < textLength && /\s/.test(trimmed[currentPos])) {
      currentPos++;
    }

    if (i === n - 1 || currentPos >= textLength) {
      // Last segment (or text exhausted): take everything remaining
      const segText = trimmed.slice(currentPos).trim();
      segments.push({ text: segText || 'Content segment', start: currentPos, video_duration: videoDuration });
      break;
    } else {
      // Proportional target based on remaining text and remaining segments
      const remaining = textLength - currentPos;
      const remainingSegs = n - i;
      const targetEnd = currentPos + Math.round(remaining / remainingSegs);
      const actualEnd = Math.max(currentPos + 1, Math.min(findTTVSplitPoint(trimmed, targetEnd, currentPos, idealSize), textLength - (remainingSegs - 1)));

      const segText = trimmed.slice(currentPos, actualEnd).trim();
      segments.push({ text: segText || 'Content segment', start: currentPos, video_duration: videoDuration });
      currentPos = actualEnd;
    }
  }

  // Guarantee exactly n segments (safety pad)
  while (segments.length < n) {
    const last = segments[segments.length - 1];
    segments.push({ text: last?.text ?? 'Content segment', start: last?.start ?? 0, video_duration: videoDuration });
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

// ─── Task insertion helper ────────────────────────────────────────────────────

async function insertTTVTasks(tasks: any[], startTime: number, maxRuntime: number) {
  const total = tasks.length;
  console.log(`Inserting ${total} TTV tasks`);

  for (let i = 0; i < total; i += BATCH_SIZE * 10) {
    if (Date.now() - startTime > maxRuntime * 0.9) throw new Error(`Approaching runtime limit at task ${i}`);

    const batch = tasks.slice(i, i + BATCH_SIZE * 10);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const { error } = await supabase.from('TTV_prompt_tasks').insert(batch);
        if (error) throw new Error(`Failed to insert TTV tasks at ${i}: ${error.message}`);
        console.log(`Inserted TTV task batch starting at ${i}`);
        break;
      } catch (err: any) {
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
          continue;
        }
        throw err;
      }
    }

    if (i + BATCH_SIZE * 10 < total) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
  }
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
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': corsOrigin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", 'Access-Control-Allow-Origin': corsOrigin },
    });
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get('Authorization');
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!authToken) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
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
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
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
      style,
      video_model,
      video_duration,
      totalAudioDuration,
      useCharacterDescriptions,
      customCharactersEnabled = false,
      customCharacters = [],
      customCharactersAIEnhance = false,
      model,
      language,
      tab = 1,
      variant = 1,
      masterPromptData,
      environmentOnlyMode = false,
      userTokenBalance,
      audio_clip = false,
      high_res = false,
    } = requestData;
    const videoProcess = requestData.videoProcess === true;

    // ── Validation ──────────────────────────────────────────────────────────

    // Defensively coerce numeric fields — Supabase returns `numeric` columns as strings
    const parsedVideoDuration = Number(video_duration);
    const parsedTotalAudioDuration = Number(totalAudioDuration);

    // Default style to 'Cinematic realistic' if empty/missing (can happen via plan-video pipeline)
    const validatedStyle = (style && typeof style === 'string' && style.trim()) ? style.trim() : 'Cinematic realistic';

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!user_id || !uuidRegex.test(user_id)) throw new Error('Missing or invalid user_id');
    if (!group_id || !uuidRegex.test(group_id)) throw new Error('Missing or invalid group_id');
    if (!file_path || typeof file_path !== 'string') throw new Error('Missing or invalid file_path');
    if (!story_title || typeof story_title !== 'string') throw new Error('Missing or invalid story_title');
    if (!description || typeof description !== 'string') throw new Error('Missing or invalid description');
    if (!video_model || typeof video_model !== 'string') throw new Error('Missing or invalid video_model');
    if (isNaN(parsedVideoDuration) || parsedVideoDuration <= 0) throw new Error('Invalid video_duration');
    if (isNaN(parsedTotalAudioDuration) || parsedTotalAudioDuration <= 0) throw new Error('Invalid totalAudioDuration');

    // Defensive clamp: upstream (plan-video / LLM) has occasionally sent the
    // total runtime as `video_duration` instead of a per-clip length. Snap
    // to the model's allowed per-clip durations so we never end up creating
    // 1–2 absurdly long "clips" from a multi-minute story.
    const { duration: clampedVideoDuration, clamped: videoDurationClamped } =
      clampVideoDurationForModel(video_model, parsedVideoDuration);
    if (videoDurationClamped) {
      console.warn(`[setup-ttv-prompts] video_duration ${parsedVideoDuration}s out of range for model "${video_model}" — clamped to ${clampedVideoDuration}s`);
    }
    const effectiveVideoDuration = clampedVideoDuration;
    if (typeof useCharacterDescriptions !== 'boolean') throw new Error('Missing or invalid useCharacterDescriptions');
    if (typeof variant !== 'number') throw new Error('Missing or invalid variant');
    if (typeof userTokenBalance !== 'number') throw new Error('Missing or invalid userTokenBalance');

    const validatedLanguage = ['english', 'german', 'spanish', 'french'].includes(language || '') ? language! : 'english';
    const validatedModel = ['deepseek', 'sonnet', 'opus'].includes(model || '') ? model! : 'sonnet';

    // ── Prevent duplicate variants ───────────────────────────────────────────
    // Check both TTV_prompt_tasks (prompt generation) and TTV_tasks (video generation)
    // to ensure the variant doesn't collide with any existing process for this group/tab.

    const [promptTasksRes, videoTasksRes] = await Promise.all([
      supabase
        .from('TTV_prompt_tasks')
        .select('variant')
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .eq('tab', tab),
      supabase
        .from('TTV_tasks')
        .select('variant')
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .eq('tab', tab),
    ]);

    if (promptTasksRes.error) {
      console.warn(`Warning: Could not check TTV_prompt_tasks variants: ${promptTasksRes.error.message}`);
    }
    if (videoTasksRes.error) {
      console.warn(`Warning: Could not check TTV_tasks variants: ${videoTasksRes.error.message}`);
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

    // ── Download story text ───────────────────────────────────────────────────

    const { data: fileData, error: fileError } = await supabase.storage.from('stories').download(file_path);
    if (fileError || !fileData) throw new Error(`Failed to download story: ${fileError?.message ?? 'No data'}`);
    const rawContent = await fileData.text();
    if (!rawContent || rawContent.length === 0) throw new Error('Story content is empty');
    if (rawContent.length > 900000) throw new Error('Input text too large for processing');

    // ── Calculate total videos ────────────────────────────────────────────────

    const total_videos = Math.floor(parsedTotalAudioDuration / effectiveVideoDuration);
    if (total_videos < 1) throw new Error(`totalAudioDuration (${parsedTotalAudioDuration}s) / video_duration (${effectiveVideoDuration}s) = ${total_videos} — too few videos`);
    console.log(`TTV setup: ${total_videos} videos (${parsedTotalAudioDuration}s / ${effectiveVideoDuration}s)`);

    // ── Store context ─────────────────────────────────────────────────────────

    const cleanedText = cleanTextForTTV(rawContent);
    const wordCount = calculateWordCount(cleanedText);
    const characterCount = cleanedText.length;
    const textParts = splitTextIfLarge(cleanedText);
    if (textParts.length === 0) throw new Error('Story text is too short to process');
    console.log(`Split into ${textParts.length} parts: ${textParts.map(p => calculateWordCount(p)).join(', ')} words`);

    for (let partIdx = 0; partIdx < textParts.length; partIdx++) {
      const partText = textParts[partIdx];
      const { error: ctxError } = await supabase
        .from('TTV_prompt_context')
        .upsert({
          group_id,
          part_number: partIdx + 1,
          user_id,
          tab,
          full_story_text: partText,
          word_count: calculateWordCount(partText),
          character_count: partText.length,
          master_prompt_data: masterPromptData ?? null,
          environment_only_mode: environmentOnlyMode,
          style_description: validatedStyle,
          character_descriptions: null,   // filled after extraction
          video_model,
          video_duration: effectiveVideoDuration,
          total_videos,
          audio_clip,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'group_id,tab,part_number' });

      if (ctxError) throw new Error(`Failed to store TTV context part ${partIdx + 1}: ${ctxError.message}`);
    }

    // ── Character extraction ──────────────────────────────────────────────────

    let characters: Record<string, string> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    if (useCharacterDescriptions) {
      if (customCharactersEnabled && customCharacters.length > 0) {
        // Custom characters path: user provided their own character descriptions
        const validCustomChars = customCharacters.filter((c: any) => c.name && c.name.trim());
        
        if (validCustomChars.length > 0) {
          if (customCharactersAIEnhance) {
            // AI Enhancement: expand basic descriptions into detailed visual descriptions
            console.log(`Enhancing ${validCustomChars.length} custom characters with AI...`);
            const { enhanced, inputTokens, outputTokens } = await enhanceCustomCharacterDescriptions(
              validCustomChars,
              story_title,
              validatedStyle
            );
            characters = enhanced;
            totalInputTokens += inputTokens;
            totalOutputTokens += outputTokens;
            console.log(`AI-enhanced ${Object.keys(characters).length} custom characters`);
          } else {
            // No AI enhancement: convert array to Record<string, string> directly
            console.log(`Using ${validCustomChars.length} custom characters without AI enhancement`);
            for (const char of validCustomChars) {
              characters[char.name.trim()] = char.description || 'A character in the story.';
            }
          }
        } else {
          console.log('Custom characters enabled but none have names, falling back to extraction');
          const { characters: extracted, inputTokens, outputTokens } = await extractCharacterDescriptions(rawContent);
          characters = extracted;
          totalInputTokens += inputTokens;
          totalOutputTokens += outputTokens;
        }
      } else {
        // Default path: auto-extract from story text
        const { characters: extracted, inputTokens, outputTokens } = await extractCharacterDescriptions(rawContent);
        characters = extracted;
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
      }

      // Check if custom character names appear in the story text
      // Only true when custom characters are enabled AND their names are found in the story
      let customCharsInStory = false;
      if (customCharactersEnabled && Object.keys(characters).length > 0) {
        const storyLower = rawContent.toLowerCase();
        const matchedNames = Object.keys(characters).filter(name => storyLower.includes(name.toLowerCase().trim()));
        if (matchedNames.length === 0) {
          customCharsInStory = false;
          console.log(`⚠️ None of the custom character names were found in the story text. All characters will be appended to every prompt as fallback.`);
        } else {
          console.log(`✓ Found ${matchedNames.length} of ${Object.keys(characters).length} character name(s) in story: ${matchedNames.join(', ')}`);
        }
      }

      for (let partIdx = 0; partIdx < textParts.length; partIdx++) {
        await supabase
          .from('TTV_prompt_context')
          .update({
            character_descriptions: characters,
            custom_chars_in_story: customCharsInStory,
            updated_at: new Date().toISOString(),
          })
          .eq('group_id', group_id)
          .eq('part_number', partIdx + 1)
          .eq('tab', tab);
      }
    }

    // ── Estimate token cost ───────────────────────────────────────────────────

    const charExtractionTokens = Math.round(totalInputTokens * 0.25 + totalOutputTokens);
    const isLegacyPlan = await getIsLegacyPlan(user_id);
    const genEstimate = estimateTTVTokens(wordCount, total_videos, useCharacterDescriptions, validatedModel, isLegacyPlan);
    const estimatedTokens = charExtractionTokens + genEstimate.inputTokens + genEstimate.outputTokens;

    console.log(
      `Token estimate: char_extraction=${charExtractionTokens}, ` +
      `gen_input=${genEstimate.inputTokens}, gen_output=${genEstimate.outputTokens}, ` +
      `total=${estimatedTokens} (model=${validatedModel}, ` +
      `multiplier=${llmMultiplier(isLegacyPlan, validatedModel)}×)`
    );

    // ── Write job_data ────────────────────────────────────────────────────────

    const jobId = crypto.randomUUID();
    const textPartNumbers = textParts.map((_, i) => String(i + 1));

    const { error: jobError } = await supabase.from('job_data').insert({
      id: jobId,
      user_id,
      data: {
        textParts: textPartNumbers,
        user_id,
        group_id,
        file_path,
        story_title,
        description,
        style: validatedStyle,
        video_model,
        video_duration: effectiveVideoDuration,
        total_videos,
        useCharacterDescriptions,
        variant: finalVariant,
        characters,
        totalInputTokens,
        totalOutputTokens,
        is_corrected: false,
        userTokenBalance,
        language: validatedLanguage,
        model: validatedModel,
        tab,
        masterPromptData: masterPromptData ?? null,
        environmentOnlyMode,
        audio_clip,
        high_res,
        videoProcess,
      },
    });
    if (jobError) throw new Error(`Failed to insert TTV job data: ${jobError.message}`);
    console.log(`Inserted TTV job data jobId=${jobId}, tab=${tab}, variant=${finalVariant}`);

    // ── Trigger process-TTV-task ──────────────────────────────────────────────

    try {
      const resp = await fetchWithDenoFallback('process-ttv-task', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': Deno.env.get("SECRET_KEY"),
        },
        body: JSON.stringify({ jobId, user_id }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errText}`);
      }
      console.log(`Triggered process-TTV-task for jobId=${jobId}`);
    } catch (triggerErr: any) {
      await supabase.from('job_data').delete().eq('id', jobId);
      throw new Error(`Failed to trigger process-TTV-task: ${triggerErr.message}`);
    }

    return new Response(JSON.stringify({
      job_id: jobId,
      total_videos,
      text_parts: textParts.length,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      language: validatedLanguage,
      model: validatedModel,
      variant: finalVariant,
      tab,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", 'Access-Control-Allow-Origin': corsOrigin },
    });

  } catch (error: any) {
    console.error(`Error in setup-TTV-prompts: ${error.message}`);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", 'Access-Control-Allow-Origin': corsOrigin },
    });
  }
});



