// denodeploy/setup-mg-prompts.ts
// Long-running Deno Deploy worker that:
//   1. Receives a request from the supabase/functions/setup-mg-prompts wrapper
//      with { user_id, group_id, story_title, story_text, style_slug,
//              video_duration, tab?, language?, model?, doc_id, variant }.
//   2. Splits the full story into N clip-sized segments based on
//      video_duration (e.g. 10s clips → ~75 words per clip @ 150wpm narration).
//   3. Inserts an MG_prompt_context row.
//   4. Inserts MG_prompt_tasks rows (one per batch of N segments) with
//      status='queued' for the first row and 'pending' for the rest.
//   5. Fires PROCESS_MG_PROMPT_URL for the first prompt batch.
//
// This mirrors denodeploy/setup-ttv-prompts.ts but with MG-specific schema and
// without character extraction (MG style controls visuals; characters are
// optional and inferred per-clip by the LLM in generate-MG-prompt).
//
// Env required:
//   SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_PUBLIC_KEY,
//   PROCESS_MG_PROMPT_URL  (default: <SUPABASE_URL>/functions/v1/process-MG-prompt)

import { createClient } from 'jsr:@supabase/supabase-js@^2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SECRET_KEY = Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
const PROCESS_MG_PROMPT_URL = Deno.env.get('PROCESS_MG_PROMPT_URL') ||
  `${SUPABASE_URL}/functions/v1/process-MG-prompt`;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('SUPABASE_URL or SUPABASE_SECRET_KEY missing');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

const ALLOWED_ORIGINS = [
  'https://storyscriptai.com',
  'https://www.storyscriptai.com',
  'https://northnoir.com',
  'https://www.northnoir.com',
  'http://localhost:5173',
];

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

// Inline MG style catalog — mirrors src/data/mgStyles.ts.
// Under the codegen-only pipeline, composition_id is always 'Clip'. The
// long-form `style_guidance` text is what gets handed to the codegen LLM and
// is what the user sees as the "style text" for each preset.
const MG_STYLE_BY_SLUG: Record<string, { description: string; style_guidance: string }> = {
  cinematic_dark: {
    description: 'Moody, cinematic, dark color grade with dramatic lighting and slow camera moves.',
    style_guidance: "Cinematic, film-noir mood on a near-black background (#0A0A12) with a single warm tungsten or deep teal accent. Heavy serif or condensed sans typography with generous letter-spacing; subjects emerge from a soft vignette via slow scale-and-fade reveals and subtle motion-blur trails. Pacing is reverent and slow — prestige documentary energy, never abrupt cuts.",
  },
  realistic_map: {
    description: 'Photoreal map flyovers with terrain, labels, and animated routes.',
    style_guidance: "Topographic atlas aesthetic: aged-parchment or muted-terrain background with fine contour lines, routes drawn as glowing polylines with stroke-dasharray growth and a leading pulse dot. Tiny all-caps sans-serif labels mark coordinates; compass rose and scale bar suggest cartography. Cool blue and warm amber accents, slow atlas pan.",
  },
  voxel_pixel_people: {
    description: 'Stylized voxel/pixel people in 3D scenes — playful and game-like.',
    style_guidance: "Isometric voxel / Minecraft-style scene with chunky figures built from stacked colored rects, viewed at a 30° angle. Bright saturated palette (4–5 colors max), stepped pixel-perfect motion — never smooth interpolation. Chunky blocky monospaced typography; figures stagger in with tiny scale-bounces. Playful, game-like, no anti-aliased edges.",
  },
  hyperreal_3d_figures: {
    description: 'Hyperreal CGI figures in cinematic environments.',
    style_guidance: "Hyperreal faux-3D feel: human silhouettes or large shapes built from layered radial gradients and ellipses to imply volume, rim-lighting from upper-left, soft inner shadows. Deep misty gradient background (#1A1F2E → #4A5568) with cinematic letterbox bars. Heavy confident sans (Inter Black). Elements drift forward with parallax and weighty ease.",
  },
  bright_infographic: {
    description: 'Bright, high-contrast infographic with clear typography and icons.',
    style_guidance: "Bright daytime-TV infographic on a clean WHITE or warm-cream background (#FFFFFF or #FFF8E7) — never dark. Bold flat color blocks (coral, mint, sunshine yellow, sky blue) bounce in with spring physics. Big rounded sans-serif headlines (weight 800), count-up numbers, bar charts growing from zero, cute icon-style shapes. Energetic, optimistic, friendly — no shadows or gradients.",
  },
  dark_terminal_stocks: {
    description: 'Dark Bloomberg-style terminal with tickers, charts, and data feeds.',
    style_guidance: "Bloomberg / financial-terminal aesthetic: pure black background (#000000), monospaced type throughout, amber (#FFB000) and green (#00FF41) text. Multi-panel dense layout with scrolling tickers, ASCII-style line charts via SVG polyline, data tables, and CRT scanline overlay. Every number flickers or updates live. Square corners, no decoration — pure information density.",
  },
  watercolor_historical: {
    description: 'Watercolor textures with historical illustrations and aged paper.',
    style_guidance: "Painterly watercolor on aged ivory paper (#F5EDD8) with soft blotches of muted historical pigments — ochre, sage, dusty blue, sepia. Edges look bleeding and feathered via low-opacity layered fills and blur. Hand-lettered serif title in sepia ink with slight rotation; decorative filigree corners. Slow, contemplative reveals via opacity + ink-bleed scale.",
  },
  sketch_pen_paper: {
    description: 'Hand-drawn ink sketches on paper with subtle motion.',
    style_guidance: "Pen-on-paper documentary sketch on cream paper with faint horizontal rule lines. Everything in thin wobbly black strokes (#1A1A1A) — irregular SVG paths that draw on with stroke-dasharray. Hatching for shadows, no fills. Handwriting-style font (Caveat). Scribbled marginal notes, occasional ink-blots. Motion is delicate pen-speed, never bouncy.",
  },
  atmospheric_fog: {
    description: 'Volumetric fog and atmospheric particles with cinematic mood.',
    style_guidance: "Volumetric mist and fog: desaturated gradient background (#2C3E50 → #95A5A6) with soft cloud layers built from large low-opacity radial gradients drifting horizontally at parallax speeds. Faint silhouettes emerge through the fog with blur-to-focus transitions. Light-weight widely-spaced typography. Ethereal, haunting, dreamlike — nothing hurried, everything floats.",
  },
  glassmorphism: {
    description: 'Frosted glass cards, blur, and translucent layers in motion.',
    style_guidance: "Frosted-glass UI: floating translucent cards (rgba(255,255,255,0.15), backdrop-filter blur, 1px white inner border, large border-radius) over a vibrant gradient mesh background (#667EEA → #764BA2 → #F093FB). Cards stagger-in with slight tilt and rise. Soft white inner glow, Inter-style sans, numbers count up. Modern, premium, Apple-keynote feel.",
  },
  kinetic_typography: {
    description: 'Bold typographic motion with rhythmic timing and color blocks.',
    style_guidance: "Dominated by motion typography: background flips between bold solid colors per beat (black, saturated red, electric yellow). Massive words enter, then scale, rotate, and swap colors to emphasize meaning. Two contrasting fonts — one heavy display (Anton/Bebas), one geometric accent. Color blocks slide in behind words via clip-path. Pacing is percussive, rhythmic, every beat punches.",
  },
  brutalist_newspaper: {
    description: 'Black-and-white brutalist newspaper layout with heavy serif and grids.',
    style_guidance: "Vintage front-page newspaper: off-white paper background (#F4F1E8) with subtle noise, massive black slab-serif headlines (font-weight 900) stretched wide, multi-column narrow serif body text divided by thin black rules. Halftone-dot circular 'photo' built from radial gradients. One red ink-stamp badge rotated 12°. Animations are abrupt snap-into-place, never smooth fades.",
  },
  flat_explainer: {
    description: 'Flat illustration explainer style with friendly characters and color shapes.',
    style_guidance: "Friendly flat-illustration explainer on a soft pastel background (#FFF6E5 cream or #E8F4F8 pale blue). Simple geometric shapes — circles, rounded rectangles — in a warm palette (sunny yellow, turquoise, coral, indigo). Characters and abstract figures animate with bouncy spring physics. Rounded geometric sans typography (Quicksand/Nunito); slight tilts and soft drop shadows keep things organic, never sterile.",
  },
  swiss_minimal: {
    description: 'Swiss-style minimal grid: Helvetica, large numerals, generous whitespace.',
    style_guidance: "International Typographic Style: pure white background (#FFFFFF), massive Helvetica-style numerals filling 60% of the viewport height in pure black. One thin red horizontal rule animates across, asymmetric grid layout, generous negative space (40%+ empty). Tiny tracked-out uppercase captions. Motion is restrained ease-out slides only — confident gallery-poster quality.",
  },
  corporate_data: {
    description: 'Polished corporate dashboards with KPIs, charts, and brand-safe colors.',
    style_guidance: "Polished corporate-dashboard look on an off-white background (#F8FAFC) with a calm brand-safe palette (navy primary, emerald positive, red warning, slate text). KPI cards with large numbers counting up, smooth bar/line charts growing, subtle status badges. Professional geometric sans typography (Inter/SF Pro), 1px borders and soft card shadows, 8px border-radius. Animations are smooth and measured — confidence over flash.",
  },
  holographic_glitch: {
    description: 'Holographic, neon, RGB-glitch aesthetic with scanlines and chromatic aberration.',
    style_guidance: "Cyberpunk holographic HUD: pure black background, cyan (#00F5FF) wireframe rectangles and brackets framing the screen with corner ticks. Monospace cyan text with RGB-split chromatic aberration (three offset copies in red/green/blue), random horizontal glitch bars flashing for a few frames, scanline overlay. Rotating wireframe globes and data readouts. Sci-fi tactical energy.",
  },
};

// Tunables (mirror TTV settings)
const NARRATION_WPM = 150;       // assumed narration words-per-minute
const BATCH_SIZE = 2;            // segments per LLM call
const MAX_TEXT_PART_CHARS = 56_000;
const MIN_TEXT_PART_LENGTH = 50;

function countWords(s: string): number {
  return s.split(/\s+/).filter(w => w.length > 0).length;
}

// Mirrors supabase/functions/storyscriptai-setup-prompt/index.ts → cleanTextForPrompts.
// Strips ElevenLabs/TTS SSML "silent commands", drops the story title block up to
// and including the first **Chapter N: ...** heading, normalizes curly quotes,
// and removes inline markdown bold/italic markers that frequently survive in
// uploaded scripts and trip up downstream JSON-emitting LLMs.
function cleanStoryText(text: string): string {
  if (!text) return '';
  let t = text;
  // SSML break tags (well-formed, malformed, and incomplete remnants).
  t = t.replace(/<break\b[^>]*?\/?>/gi, '');
  t = t.replace(/<break\b[^>]*$/gm, '');
  t = t.replace(/^\s*["'\u2018\u2019\u201C\u201D]?\d+ms["'\u2018\u2019\u201C\u201D]?\s*\/?>/gm, '');
  // Drop story title block: everything up to and including the first **Chapter N: ...** line.
  const lines = t.split('\n');
  const chapterPattern = /^\*\*Chapter\s+\d+.*\*\*$/i;
  let firstChapterIdx: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (chapterPattern.test(lines[i].trim())) { firstChapterIdx = i; break; }
  }
  if (firstChapterIdx !== null) {
    t = lines.slice(firstChapterIdx + 1).join('\n');
  }
  // Strip any remaining **Chapter N**-style headings further down the body.
  t = t.replace(/^\*\*Chapter\s+\d+[^\n]*\*\*\s*$/gim, '');
  // Strip inline markdown emphasis markers (**bold**, __bold__, *italic*, _italic_)
  // — keeping the inner text. These are what cause the LLM to emit literal
  // backslashes into its JSON output strings.
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');
  t = t.replace(/__(.+?)__/g, '$1');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
  t = t.replace(/(^|[^_])_([^_\n]+)_/g, '$1$2');
  // Normalize curly quotes/dashes to ASCII equivalents.
  t = t
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ');
  // Collapse 3+ blank lines to 2.
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    await supabase.from('error_logs').insert({
      message,
      details: error.message || JSON.stringify(error),
      created_at: new Date().toISOString(),
    });
  } catch (_) { /* silent */ }
}

// Forces text into exactly `n` segments, each approximately `wordsPerSegment` long.
function forceExactSegments(text: string, n: number, wordsPerSegment: number): string[] {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0 || n <= 0) return [];
  if (n === 1) return [words.join(' ')];
  const target = Math.max(1, Math.floor(words.length / n));
  const segments: string[] = [];
  for (let i = 0; i < n; i++) {
    const start = i * target;
    const end = i === n - 1 ? words.length : (i + 1) * target;
    segments.push(words.slice(start, end).join(' '));
  }
  return segments;
}

interface SetupRequest {
  user_id: string;
  group_id: string;
  doc_id?: string;
  file_path?: string;
  story_title: string;
  story_text?: string;
  description?: string;
  style_slug: string;
  composition_id?: string;
  style_description?: string | null;
  video_duration?: number;
  totalAudioDuration?: number;
  custom_chars_in_story?: boolean;
  character_descriptions?: Record<string, string>;
  customCharactersAIEnhance?: boolean;
  audio_enabled?: boolean;
  tab?: number;
  variant?: number;
  language?: string;
  model?: string;
  /** Lambda codegen model for clip TSX. 'opus' (default) or 'sonnet'. */
  codegen_model?: 'opus' | 'sonnet' | 'claude-opus-4-6' | 'claude-sonnet-4-6';
  /** Optional parent video_tasks row id (set when launched from the unified VideoGenerator). */
  video_task_id?: string | null;
}

async function handleSetup(body: SetupRequest): Promise<{ status: string; total_clips: number; total_batches: number; job_id: string }> {
  const {
    user_id, group_id, doc_id, file_path, story_title, story_text, style_slug,
    style_description: bodyStyleDescription,
    custom_chars_in_story = false,
    character_descriptions = {},
    audio_enabled = false,
    video_task_id = null,
  } = body;
  const video_duration = body.video_duration ?? 10;
  const totalAudioDuration = Number(body.totalAudioDuration ?? 0);
  const tab = body.tab ?? 1;
  const variant = body.variant ?? 1;
  const language = body.language || 'english';
  const model = body.model || 'deepseek';
  const codegenModel =
    body.codegen_model === 'sonnet' || body.codegen_model === 'claude-sonnet-4-6'
      ? 'claude-sonnet-4-6'
      : 'claude-opus-4-6';

  if (!user_id || !group_id || !story_title || !style_slug) {
    throw new Error('Missing required fields: user_id, group_id, story_title, style_slug');
  }
  if (!story_text && !file_path) {
    throw new Error('Missing story_text or file_path');
  }
  const styleEntry = MG_STYLE_BY_SLUG[style_slug];
  if (!styleEntry) throw new Error(`Unknown style_slug: ${style_slug}`);

  // ── Resolve story text: prefer inline story_text, else download file_path ──
  let rawText = (story_text ?? '').trim();
  if (!rawText && file_path) {
    const { data: fileData, error: fileError } = await supabase.storage.from('stories').download(file_path);
    if (fileError || !fileData) throw new Error(`Failed to download story: ${fileError?.message ?? 'No data'}`);
    rawText = (await fileData.text()).trim();
  }
  const cleanedText = cleanStoryText(rawText);
  if (cleanedText.length < MIN_TEXT_PART_LENGTH) {
    throw new Error(`Story text too short (${cleanedText.length} < ${MIN_TEXT_PART_LENGTH} chars)`);
  }
  if (cleanedText.length > MAX_TEXT_PART_CHARS) {
    throw new Error(`Story text too long (${cleanedText.length} > ${MAX_TEXT_PART_CHARS} chars)`);
  }

  // Compute clip count: prefer totalAudioDuration / video_duration (matches UI estimate),
  // fall back to a word-based estimate when no audio duration is provided.
  const totalWords = countWords(cleanedText);
  let totalClips: number;
  if (totalAudioDuration > 0) {
    totalClips = Math.max(1, Math.floor(totalAudioDuration / video_duration));
  } else {
    const wordsPerClip = Math.max(10, Math.round((video_duration * NARRATION_WPM) / 60));
    totalClips = Math.max(1, Math.ceil(totalWords / wordsPerClip));
  }
  const wordsPerClip = Math.max(1, Math.round(totalWords / totalClips));
  const segments = forceExactSegments(cleanedText, totalClips, wordsPerClip);

  console.log(`MG setup: ${totalWords} words → ${totalClips} clips of ~${wordsPerClip} words @ ${video_duration}s each (audioDuration=${totalAudioDuration}s)`);

  // Insert MG_prompt_context row.
  const { error: ctxErr } = await supabase.from('MG_prompt_context').insert({
    group_id,
    user_id,
    full_story_text: cleanedText,
    word_count: totalWords,
    character_count: cleanedText.length,
    style_slug,
    total_clips: totalClips,
    video_duration,
    tab,
    part_number: 1,
    // style_description carries the long-form style_guidance text that the
    // codegen LLM reads. User-provided override (free-text from the UI) wins;
    // otherwise we use the preset's style_guidance (and fall back to the
    // short description for safety).
    style_description:
      (bodyStyleDescription && bodyStyleDescription.trim()) ||
      styleEntry.style_guidance ||
      styleEntry.description,
    custom_chars_in_story,
    character_descriptions,
    audio_enabled,
    codegen_model: codegenModel,
    video_task_id,
  });
  if (ctxErr) throw new Error(`Failed to insert MG_prompt_context: ${ctxErr.message}`);

  // Build batches of BATCH_SIZE segments.
  const batches: Array<Array<{ text: string; index: number; start: number; video_duration: number }>> = [];
  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    const batch = segments.slice(i, i + BATCH_SIZE).map((text, j) => ({
      text,
      index: i + j + 1,
      start: (i + j) * video_duration,
      video_duration,
    }));
    batches.push(batch);
  }

  const totalBatches = batches.length;

  // Insert MG_prompt_tasks rows.
  const taskRows = batches.map((batch, i) => ({
    id: crypto.randomUUID(),
    user_id,
    group_id,
    doc_id: doc_id ?? null,
    story_title,
    batch,
    batch_output: '',
    total_batches: totalBatches,
    batch_number: i + 1,
    total_prompts: segments.length,
    progress: 0,
    status: i === 0 ? 'queued' : 'pending',
    settings: { video_duration, style_slug },
    variant,
    version: 1,
    model,
    language,
    tab,
    style_slug,
    // Codegen pipeline: composition_id is no longer meaningful but the column
    // is NOT NULL on MG_prompt_tasks. Always write 'Clip'.
    composition_id: 'Clip',
    video_duration,
    codegen_model: codegenModel,
    video_task_id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

  // Chunked insert.
  const CHUNK = 20;
  for (let i = 0; i < taskRows.length; i += CHUNK) {
    const slice = taskRows.slice(i, i + CHUNK);
    const { error } = await supabase.from('MG_prompt_tasks').insert(slice);
    if (error) throw new Error(`Failed to insert MG_prompt_tasks chunk: ${error.message}`);
    if (i + CHUNK < taskRows.length) await new Promise(r => setTimeout(r, 100));
  }

  // Note: MG does not use the job_data table (process-MG-prompt is invoked with
  // group_id/batch_number directly, not a jobId). A synthetic id is returned so
  // callers that previously stored job_id continue to work.
  const jobId = crypto.randomUUID();

  // Fire process-MG-prompt for batch 1.
  fetch(PROCESS_MG_PROMPT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SECRET_KEY,
    },
    body: JSON.stringify({
      group_id, user_id,
      batch_number: 1,
      total_batches: totalBatches,
      tab, variant,
    }),
  }).catch(err => logError('Failed to fire process-MG-prompt for batch 1', err));

  return { status: 'queued', total_clips: totalClips, total_batches: totalBatches, job_id: jobId };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });
  }

  // Auth: accept SUPABASE_SECRET_KEY, SUPABASE_PUBLIC_KEY, or a valid user JWT
  // (mirrors denodeploy/setup-ttv-prompts.ts and denodeploy/setup-itv-prompts.ts).
  const authHeader = req.headers.get('Authorization');
  const authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers.get('apikey') || '');
  if (!authToken) {
    return new Response(JSON.stringify({ error: 'Missing authorization' }), { status: 401, headers: responseHeaders });
  }
  const _publicKey = Deno.env.get('SUPABASE_PUBLIC_KEY') || '';
  const _allowedKeys = [SUPABASE_SECRET_KEY, _publicKey].filter(Boolean);
  if (!_allowedKeys.includes(authToken)) {
    const { data: { user: _authUser }, error: _authErr } = await supabase.auth.getUser(authToken);
    if (_authErr || !_authUser) {
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), { status: 401, headers: responseHeaders });
    }
  }

  try {
    const body: SetupRequest = await req.json();
    const result = await handleSetup(body);
    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });
  } catch (error: any) {
    await logError('Error in denodeploy/setup-mg-prompts', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), { status: 500, headers: responseHeaders });
  }
});
