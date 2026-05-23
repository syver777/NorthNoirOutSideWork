import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import OpenAI from 'https://deno.land/x/openai@v4.20.1/mod.ts';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_PUBLIC_KEY = Deno.env.get("SUPABASE_PUBLIC_KEY");
const SUPABASE_SECRET_KEY = Deno.env.get("SUPABASE_SECRET_KEY");
const DEEPSEEK_API_KEY = Deno.env.get("DEEPSEEK_API_KEY");
const SETUP_VIDEO_TASKS_URL = Deno.env.get("SETUP_VIDEO_TASKS_URL") || `${SUPABASE_URL}/functions/v1/setup-video-tasks`;
const TRANSCRIPT_GCF_URL = Deno.env.get("TRANSCRIPT_GCF_URL") || '';

if (!SUPABASE_URL || !SUPABASE_PUBLIC_KEY || !SUPABASE_SECRET_KEY) {
  throw new Error("Missing SUPABASE_URL, SUPABASE_PUBLIC_KEY, or SUPABASE_SECRET_KEY");
}
if (!DEEPSEEK_API_KEY) {
  throw new Error("Missing DEEPSEEK_API_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

const deepseek = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com/v1",
});

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

// ─── Constants ───────────────────────────────────────────────────────────────

const CHARS_PER_SECOND = 13.67;
const WORDS_PER_SECOND = 2.08;
const TOKEN_PER_WORD = 1.33;
const SPEECH_SPEED = 0.86;

// Audio: premium/clone = 4 tokens per character
const AUDIO_TOKENS_PER_CHAR = 4;

// ─── Model Cost Tables ────────────────────────────────────────────────────────
// Two pricing tiers exist:
//   • LEGACY (is_legacy_plan === true or null) — grandfathered customers.
//   • NEW    (is_legacy_plan === false)        — post-cutover pricing aligned
//     with provider costs at ≥50% margin (see billing memo §9.8).
// Schema (defaultDuration, name, tier) is identical across tiers; only token
// prices differ. Pick the right table via pickImageCosts/pickTtvCosts/pickItvCosts.

// Image model costs — LEGACY (tokens per image)
const IMAGE_MODEL_COSTS: Record<string, { tokens: number; name: string; tier: string }> = {
  'flux-2-dev':         { tokens: 7000,   name: 'Spark',    tier: 'spark' },
  'imagen-4-fast':      { tokens: 14000,  name: 'Lite',     tier: 'standard' },
  'grok-imagine-image': { tokens: 16000,  name: 'Grok',     tier: 'grok' },
  'gpt-image-1-mini': { tokens: 30000,  name: 'Plus',     tier: 'plus' },
  'seedream-4.5':     { tokens: 35000,  name: 'Prime',    tier: 'prime' },
  'imagen-4-ultra':   { tokens: 42000,  name: 'Premium',  tier: 'premium' },
  'nano-banana-pro':  { tokens: 100000, name: 'Genesis',  tier: 'genesis' },
};
// Image model costs — NEW pricing (≥50% margin per billing §9.8).
const NEW_IMAGE_MODEL_COSTS: Record<string, { tokens: number; name: string; tier: string }> = {
  'flux-2-dev':         { tokens: 12000,  name: 'Spark',    tier: 'spark' },
  'imagen-4-fast':      { tokens: 20000,  name: 'Lite',     tier: 'standard' },
  'grok-imagine-image': { tokens: 20000,  name: 'Grok',     tier: 'grok' },
  'gpt-image-1-mini':   { tokens: 40000,  name: 'Plus',     tier: 'plus' },
  'seedream-4.5':       { tokens: 40000,  name: 'Prime',    tier: 'prime' },
  'imagen-4-ultra':     { tokens: 60000,  name: 'Premium',  tier: 'premium' },
  'nano-banana-pro':    { tokens: 130000, name: 'Genesis',  tier: 'genesis' },
};

// TTV model costs — LEGACY (tokens per second of video)
// 'wan-2.2' has been retired from TTV — seedance-1.0-pro-fast is now the cheapest TTV tier.
// (wan-2.2 is still supported for ITV.)
const TTV_MODEL_COSTS: Record<string, { tokensPerSec: number; defaultDuration: number; name: string }> = {
  'seedance-1.0-pro-fast': { tokensPerSec: 13200,  defaultDuration: 5,    name: 'Seedance 1.0 Pro Fast' },
  'ltx-2.3-fast':          { tokensPerSec: 24000,  defaultDuration: 6,    name: 'LTX 2.3 Fast' },
  'grok-video':            { tokensPerSec: 30000,  defaultDuration: 5,    name: 'Grok Video' },
  'seedance-1.5-pro':      { tokensPerSec: 34800,  defaultDuration: 5,    name: 'Seedance 1.5 Pro' },
  'veo-3.1-fast':          { tokensPerSec: 60000,  defaultDuration: 6,    name: 'Veo 3.1 Fast' },
  'ltx-2.3-pro':           { tokensPerSec: 72000,  defaultDuration: 6,    name: 'LTX 2.3 Pro' },
  'veo-3.1':               { tokensPerSec: 120000, defaultDuration: 6,    name: 'Veo 3.1' },
  'sora-2-pro':            { tokensPerSec: 180000, defaultDuration: 4.5,  name: 'Sora 2 Pro' },
  'sora-2-pro-highres':    { tokensPerSec: 300000, defaultDuration: 4.5,  name: 'Sora 2 Pro HighRes' },
};
// TTV model costs — NEW pricing (≥50% margin per billing §9.8).
// seedance-1.5-pro stays at 34,800 (already at 62% margin per §9.2).
const NEW_TTV_MODEL_COSTS: Record<string, { tokensPerSec: number; defaultDuration: number; name: string }> = {
  'seedance-1.0-pro-fast': { tokensPerSec: 49000,  defaultDuration: 5,    name: 'Seedance 1.0 Pro Fast' },
  'ltx-2.3-fast':          { tokensPerSec: 40000,  defaultDuration: 6,    name: 'LTX 2.3 Fast' },
  'grok-video':            { tokensPerSec: 50000,  defaultDuration: 5,    name: 'Grok Video' },
  'seedance-1.5-pro':      { tokensPerSec: 34800,  defaultDuration: 5,    name: 'Seedance 1.5 Pro' },
  'veo-3.1-fast':          { tokensPerSec: 100000, defaultDuration: 6,    name: 'Veo 3.1 Fast' },
  'ltx-2.3-pro':           { tokensPerSec: 80000,  defaultDuration: 6,    name: 'LTX 2.3 Pro' },
  'veo-3.1':               { tokensPerSec: 200000, defaultDuration: 6,    name: 'Veo 3.1' },
  'sora-2-pro':            { tokensPerSec: 300000, defaultDuration: 4.5,  name: 'Sora 2 Pro' },
  'sora-2-pro-highres':    { tokensPerSec: 500000, defaultDuration: 4.5,  name: 'Sora 2 Pro HighRes' },
};

// ITV model costs — LEGACY (tokens per second of video)
const ITV_MODEL_COSTS: Record<string, { tokensPerSec: number; defaultDuration: number; name: string }> = {
  'wan-2.2':             { tokensPerSec: 6000,   defaultDuration: 5,  name: 'Wan 2.2' },
  'seedance-1.0-fast':   { tokensPerSec: 12960,  defaultDuration: 5,  name: 'Seedance 1.0 Fast' },
  'hailuo-2.3-fast':     { tokensPerSec: 19200,  defaultDuration: 6,  name: 'Hailuo 2.3 Fast' },
  'seedance-1.5-pro':    { tokensPerSec: 34800,  defaultDuration: 5,  name: 'Seedance 1.5 Pro' },
  'ltx-2.3-fast':        { tokensPerSec: 48000,  defaultDuration: 6,  name: 'LTX 2.3 Fast' },
  'veo-3.1-fast':        { tokensPerSec: 60000,  defaultDuration: 6,  name: 'Veo 3.1 Fast' },
  'ltx-2.3-pro':         { tokensPerSec: 72000,  defaultDuration: 6,  name: 'LTX 2.3 Pro' },
  'veo-3.1':             { tokensPerSec: 120000, defaultDuration: 6,  name: 'Veo 3.1' },
  'ltx-2.3-pro-4k':     { tokensPerSec: 144000, defaultDuration: 6,  name: 'LTX 2.3 Pro 4K' },
};
// ITV model costs — NEW pricing (≥50% margin per billing §9.8).
// hailuo-2.3-fast (19.2k @ 56%), ltx-2.3-fast (48k @ 58%), and ltx-2.3-pro (72k @ 58%)
// already meet margin and stay unchanged.
const NEW_ITV_MODEL_COSTS: Record<string, { tokensPerSec: number; defaultDuration: number; name: string }> = {
  'wan-2.2':             { tokensPerSec: 40000,  defaultDuration: 5,  name: 'Wan 2.2' },
  'seedance-1.0-fast':   { tokensPerSec: 49000,  defaultDuration: 5,  name: 'Seedance 1.0 Fast' },
  'hailuo-2.3-fast':     { tokensPerSec: 19200,  defaultDuration: 6,  name: 'Hailuo 2.3 Fast' },
  'seedance-1.5-pro':    { tokensPerSec: 52000,  defaultDuration: 5,  name: 'Seedance 1.5 Pro' },
  'ltx-2.3-fast':        { tokensPerSec: 48000,  defaultDuration: 6,  name: 'LTX 2.3 Fast' },
  'veo-3.1-fast':        { tokensPerSec: 100000, defaultDuration: 6,  name: 'Veo 3.1 Fast' },
  'ltx-2.3-pro':         { tokensPerSec: 72000,  defaultDuration: 6,  name: 'LTX 2.3 Pro' },
  'veo-3.1':             { tokensPerSec: 200000, defaultDuration: 6,  name: 'Veo 3.1' },
  'ltx-2.3-pro-4k':      { tokensPerSec: 240000, defaultDuration: 6,  name: 'LTX 2.3 Pro 4K' },
};

function pickImageCosts(isLegacy: boolean): typeof IMAGE_MODEL_COSTS {
  return isLegacy ? IMAGE_MODEL_COSTS : NEW_IMAGE_MODEL_COSTS;
}
function pickTtvCosts(isLegacy: boolean): typeof TTV_MODEL_COSTS {
  return isLegacy ? TTV_MODEL_COSTS : NEW_TTV_MODEL_COSTS;
}
function pickItvCosts(isLegacy: boolean): typeof ITV_MODEL_COSTS {
  return isLegacy ? ITV_MODEL_COSTS : NEW_ITV_MODEL_COSTS;
}

// Per-clip duration limits per model. Mirrors the frontend (VideoModelSelector / ITVVideoModelSelector).
// `type === 'fixed'`  → must equal `default`
// `type === 'options'` → must be one of `options` (snapped to closest <= requested)
// `type === 'slider'` → clamped to [min, max]
type DurationLimit =
  | { type: 'fixed'; default: number }
  | { type: 'options'; options: number[]; default: number }
  | { type: 'slider'; min: number; max: number; default: number };

const TTV_MODEL_DURATION_LIMITS: Record<string, DurationLimit> = {
  'seedance-1.0-pro-fast': { type: 'slider',  min: 2,  max: 12, default: 6 },
  'ltx-2.3-fast':          { type: 'options', options: [6, 10, 16], default: 6 },
  'grok-video':            { type: 'slider',  min: 2,  max: 15, default: 5 },
  'seedance-1.5-pro':      { type: 'slider',  min: 4,  max: 12, default: 6 },
  'veo-3.1-fast':          { type: 'options', options: [4, 6, 8],  default: 4 },
  'ltx-2.3-pro':           { type: 'options', options: [6, 8, 10], default: 6 },
  'veo-3.1':               { type: 'options', options: [4, 6, 8],  default: 4 },
  'sora-2-pro':            { type: 'options', options: [4, 8, 12], default: 4 },
  'sora-2-pro-highres':    { type: 'options', options: [4, 8, 12], default: 4 },
};

const ITV_MODEL_DURATION_LIMITS: Record<string, DurationLimit> = {
  'wan-2.2':           { type: 'fixed',   default: 5.06 },
  'seedance-1.0-fast': { type: 'slider',  min: 2,  max: 12, default: 5 },
  'hailuo-2.3-fast':   { type: 'options', options: [6, 10],    default: 6 },
  'seedance-1.5-pro':  { type: 'slider',  min: 4,  max: 12, default: 5 },
  'ltx-2.3-fast':      { type: 'options', options: [6, 8, 10], default: 6 },
  'veo-3.1-fast':      { type: 'options', options: [4, 6, 8],  default: 4 },
  'ltx-2.3-pro':       { type: 'options', options: [6, 8, 10], default: 6 },
  'veo-3.1':           { type: 'options', options: [4, 6, 8],  default: 4 },
  'ltx-2.3-pro-4k':    { type: 'options', options: [6, 8, 10], default: 6 },
};

/**
 * Clamp a planner-supplied per-clip duration to the closest legal value for
 * the chosen model. The planner LLM has historically confused per-clip length
 * with total runtime (e.g. picking 360 for a 6-minute video), so this guard
 * is required.
 */
function clampClipDuration(
  modelId: string | undefined | null,
  requested: number | null | undefined,
  type: 'ttv' | 'itv',
): number | undefined {
  if (!modelId) return undefined;
  const limit = (type === 'ttv' ? TTV_MODEL_DURATION_LIMITS : ITV_MODEL_DURATION_LIMITS)[modelId];
  if (!limit) {
    // Unknown model — fall back to the rough cost-table default and an absolute 16s cap.
    const fallbackDefault = (type === 'ttv'
      ? TTV_MODEL_COSTS[modelId]?.defaultDuration
      : ITV_MODEL_COSTS[modelId]?.defaultDuration) ?? 6;
    if (typeof requested === 'number' && requested > 0 && requested <= 16) return requested;
    return fallbackDefault;
  }
  const req = (typeof requested === 'number' && requested > 0) ? requested : limit.default;
  if (limit.type === 'fixed') return limit.default;
  if (limit.type === 'slider') {
    if (req < limit.min) return limit.min;
    if (req > limit.max) return limit.max;
    return req;
  }
  // options
  const eligible = limit.options.filter(o => o <= req);
  if (eligible.length > 0) return Math.max(...eligible);
  return Math.min(...limit.options);
}

// Video pipeline overhead costs
const PIPELINE_COSTS = {
  DURATION_CALC: 50000,
  STT_PER_CHUNK: 3000,
  IMAGE_BATCH: 70000,
  FINAL_VIDEO_BASE: 150000,
  TRANSITION_BATCH_IMAGE: 85000,
  TRANSITION_BATCH_VIDEO: 40000,
  VIDEO_LOOP: 150000,
};

// ── Inline time-estimate constants (mirrors supabase/functions/_shared/timeEstimates.ts) ──
// Keep this block in sync with the shared module byte-for-byte (constants only).
// Used by estimatePipelineTokens() to model runtime-based GCF costs.
const TOKEN_RATES_PER_MIN: Record<string, number> = {
  'calculate-audio-duration':        2900,
  'calculate-video-durations':       3400,
  'boost-audio-volume':              3400,
  'image-to-video-processor':        5800,
  'create-final-video':              6800,
  'create-final-video-high-memory': 13600,
};
const TIME_EST = {
  T_AUDIO_CONST: 5,        T_AUDIO_PER_SEC: 0.03,
  T_BOOST_CONST: 4,        T_BOOST_PER_SEC: 0.04,
  T_CALC_DUR_CONST: 8,
  T_RENDER_CONST: 5,       T_RENDER_HM_SPEEDUP: 0.65,
  T_RENDER_TRANSITIONS_MULT: 1.35,  T_RENDER_TRANSITIONS_PASS_MULT: 0.20,
  SAFETY_PAD: 1.10,
  HM_S_AUDIO_THRESHOLD: 600,
  HM_TRANSITIONS_S_AUDIO_THRESHOLD: 300,
} as const;
type VTypeInline = 'image' | 'ttv' | 'itv';
const VT_CALC_DUR_INLINE: Record<VTypeInline, { perImage: number; perAudioSec: number }> = {
  image: { perImage: 4.0, perAudioSec: 0.05 },
  itv:   { perImage: 0.4, perAudioSec: 0.07 },
  ttv:   { perImage: 4.0, perAudioSec: 0.05 },
};
const VT_ITV_STAGE_INLINE: Record<VTypeInline, { perImageConst: number; perVideoSec: number }> = {
  image: { perImageConst: 25, perVideoSec: 1.15 },
  itv:   { perImageConst: 2,  perVideoSec: 0.95 },
  ttv:   { perImageConst: 2,  perVideoSec: 0.85 },
};
const VT_RENDER_INLINE: Record<VTypeInline, { perAudioSec: number }> = {
  image: { perAudioSec: 0.10 },
  itv:   { perAudioSec: 0.55 },
  ttv:   { perAudioSec: 1.20 },
};
const ANIM_MULT_INLINE: Record<string, number> = {
  none: 1.0, drift: 1.0, vertical: 1.0, pan: 1.3, ken_burns: 1.8, horizontal_drift: 1.0,
};
const EFFECT_MULT_INLINE: Record<string, number> = {
  none: 1.0, film_grain: 3.9, light_sparkle: 3.1, snow: 3.2, fire_flare: 5.0, rain: 3.2,
};
const ITV_TRANSITIONS_MULT_INLINE = 1.10;

// ── Motion Graphics cost constants — inlined mirror of _shared/mgCosts.ts.
// Keep in sync byte-for-byte with src/utils/mgCostConstants.ts and
// supabase/functions/_shared/mgCosts.ts.
const MG_OPUS_INPUT_TOKENS_PER_CLIP_AVG = 8_000;
const MG_OPUS_OUTPUT_TOKENS_PER_CLIP_AVG = 6_000;
const MG_OPUS_INPUT_USD_PER_MTOK = 15;
const MG_OPUS_OUTPUT_USD_PER_MTOK = 75;
const MG_LAMBDA_TOKENS_PER_SECOND = 180;
const MG_DEFAULT_CLIP_SECONDS = 10;
function mgClipCount(runtimeSeconds: number, clipSeconds = MG_DEFAULT_CLIP_SECONDS): number {
  if (runtimeSeconds <= 0) return 0;
  return Math.ceil(runtimeSeconds / Math.max(1, clipSeconds));
}
function estimateMgTokenCost(runtimeSeconds: number, clipSeconds = MG_DEFAULT_CLIP_SECONDS): number {
  const clips = mgClipCount(runtimeSeconds, clipSeconds);
  const codegenInputUsd = (clips * MG_OPUS_INPUT_TOKENS_PER_CLIP_AVG / 1_000_000) * MG_OPUS_INPUT_USD_PER_MTOK;
  const codegenOutputUsd = (clips * MG_OPUS_OUTPUT_TOKENS_PER_CLIP_AVG / 1_000_000) * MG_OPUS_OUTPUT_USD_PER_MTOK;
  const codegenTokens = Math.ceil((codegenInputUsd + codegenOutputUsd) * 100_000);
  const renderTokens = clips * clipSeconds * MG_LAMBDA_TOKENS_PER_SECOND;
  return codegenTokens + renderTokens;
}

// Mapping from plan-video model IDs to setup-video-tasks backend IDs
// 'wan-2.2' has been retired from TTV and is no longer mapped here. (Still mapped on the ITV side.)
const TTV_MODEL_ID_MAP: Record<string, string> = {
  'seedance-1.0-pro-fast': 'seedance_pro_fast',
  'ltx-2.3-fast':          'ltx23_fast',
  'grok-video':            'grok',
  'seedance-1.5-pro':      'seedance15_pro',
  'veo-3.1-fast':          'veo31fast',
  'ltx-2.3-pro':           'ltx23_pro',
  'veo-3.1':               'veo31',
  'sora-2-pro':            'sora2pro',
  'sora-2-pro-highres':    'sora2pro_highres',
};

const ITV_MODEL_ID_MAP: Record<string, string> = {
  'wan-2.2':             'wan22',
  'seedance-1.0-fast':   'seedance1fast',
  'hailuo-2.3-fast':     'hailuo23fast',
  'seedance-1.5-pro':    'seedance15',
  'ltx-2.3-fast':        'ltx23fast',
  'veo-3.1-fast':        'veo31fast',
  'ltx-2.3-pro':         'ltx23pro',
  'veo-3.1':             'veo31',
  'ltx-2.3-pro-4k':      'ltx23pro4k',
};

// Story generation model multipliers — legacy plan pricing (existing customers).
const STORY_MODEL_MULTIPLIERS: Record<string, number> = {
  deepseek: 1.0,
  sonnet: 11.0,
};
// New plan pricing (is_legacy_plan = false on user_plans).
const NEW_STORY_MODEL_MULTIPLIERS: Record<string, number> = {
  deepseek: 1.0,
  sonnet: 13.0,
};
function pickStoryMultipliers(isLegacy: boolean): Record<string, number> {
  return isLegacy ? STORY_MODEL_MULTIPLIERS : NEW_STORY_MODEL_MULTIPLIERS;
}

// Visual styles available for image generation — with full descriptions for AI context
const VISUAL_STYLES: Record<string, { description: string; style: string }> = {
  'Old Comic Book': {
    description: 'black-and-white old comic book-style',
    style: 'A black-and-white old comic book-style illustration in wide format. Features dramatic contrast, rich textures, and expressive, rough linework resembling vintage war comics. High cinematic shadows with intense lighting, giving a moody, atmospheric tone. Characters are drawn with raw, emotional detail, and each scene feels like a hand-drawn storyboard frame. Backgrounds are layered with depth, and the overall composition balances realism with a surreal, haunted quality. The style evokes mid-20th-century graphic novels with a gritty, psychological edge. Make the image bright.',
  },
  'Medieval Oil Painting': {
    description: 'late medieval or early Renaissance style',
    style: 'A richly colored oil painting in the style of late medieval or early Renaissance European art or Viking paintings. Features clear composition, vibrant tones, painterly textures, realistic proportions, expressive facial detail, and soft, atmospheric backgrounds. Lighting is natural with soft shadows, evoking the emotional depth and storytelling found in historical panel paintings and illuminated manuscripts. Vivid bright Colors.',
  },
  'Enchanted Anime': {
    description: 'painterly hand-drawn animation',
    style: 'A painterly, hand-drawn animation style in the tradition of classic Japanese feature animation. Wide format with gentle, organic linework and subtle textures that mimic traditional cel animation. The palette is lush and nature-inspired—rich greens, soft pastels, golden sunlight, and warm earth tones. Characters are expressive with large, emotive eyes. Backgrounds are intricately detailed yet softly rendered. The overall aesthetic is warm, soulful, and immersive.',
  },
  'Pixel Art': {
    description: 'retro 8-bit/16-bit pixel art',
    style: 'A retro pixel art aesthetic in wide format. Rendered with blocky, low-resolution graphics and a limited color palette inspired by 8-bit and 16-bit era video games. Characters are made up of clearly visible pixels. Bold and saturated colors. Nostalgic, playful, and full of charm.',
  },
  'Realistic Animation': {
    description: 'hyper-realistic animated style',
    style: 'A hyper-realistic animated style in wide format. Features high-resolution textures, lifelike surface details, and dynamic environmental lighting. Pixar-like animation. Rich, saturated colors and sharp shadows. Immersive, cinematic punch.',
  },
  'Classical Oil Painting': {
    description: 'Baroque-inspired oil painting',
    style: 'A classical oil painting style inspired by the Baroque masters, particularly Caravaggio and Rembrandt, emphasizing emotional realism, dramatic chiaroscuro lighting, and a subdued, earthy palette. Figures and objects rendered with painterly precision and soft, blended brushwork. The lighting is intimate and directional. The overall effect is timeless, reverent, and psychologically rich. Wide format.',
  },
  'Anime Modern Shonen': {
    description: 'dynamic high-contrast anime',
    style: 'A high-contrast, digitally inked anime style in wide format. Sharp, dynamic linework with bold character outlines, intense facial expressions, and exaggerated action poses. Colors are vibrant and saturated—neon blues, deep reds, and glowing yellows. Modern action anime, cinematic in scope.',
  },
  'Dreamy Painting': {
    description: 'fantasy art with serene celestial themes',
    style: 'A dreamy digital painting in wide format. Cool, calming tones—deep navy blues, moonlit silvers, and soft cloud whites. Backgrounds include drifting clouds, distant stars, and vast night sky. The brushwork is smooth and blended, lending a dreamy, high-fantasy aesthetic.',
  },
  'Ink & Wash': {
    description: 'East Asian ink-and-wash painting',
    style: 'A traditional East Asian ink-and-wash painting style in wide format. Expressive brush-based linework. Monochrome or limited muted palettes—grays, blacks, and sepia tones—layered with subtle watercolor washes. Negative space used intentionally. Quiet power, simplicity, and spiritual depth.',
  },
  'Dark Medieval Fantasy': {
    description: 'dark medieval animation',
    style: 'A dark medieval fantasy illustration in wide format. Bold, heavy linework with rough, painterly textures and a muted, earthy color palette of deep reds, browns, and shadows. Stark and dramatic lighting. Gothic stained glass, stone walls, and banners. Atmosphere of ritual, judgment, and foreboding power.',
  },
  'Bright Illustration': {
    description: 'clean vector-based illustration',
    style: 'A brightly colored digital illustration in wide format. Clean, smooth linework with uniform outlines. Warm and slightly muted color palette. Characters with rounded, cartoon-like features. Modern vector-based animation style.',
  },
  'Modern Infographic': {
    description: 'flat vector-based illustration',
    style: 'A flat, vector-based illustration style in wide format. Clean geometric shapes, crisp lines, and minimal gradients. High-contrast, matte colors chosen for clarity. Simplified and schematic. Modern, accessible, and efficient.',
  },
  'Pencil Sketch': {
    description: 'monochromatic pencil sketch',
    style: 'A monochromatic pencil sketch style in wide format. Soft graphite textures, smudging, and fine crosshatching. Grayscale palette. Intimate, thoughtful, and process-oriented.',
  },
  'Low-Poly 3D Render': {
    description: 'minimalist low-polygon 3D',
    style: 'A minimalist 3D illustration style using low-polygon modeling in wide format. Simplified geometric shapes and faceted surfaces. Flat pastel or matte colors. Clean, stylized aesthetic.',
  },
  'Art Nouveau Illustration': {
    description: 'decorative Art Nouveau style',
    style: 'A decorative Art Nouveau style in wide format, inspired by Alphonse Mucha. Flowing, elegant linework with intricate patterns, floral motifs. Soft pastels, warm sepia tones, and muted golds. Romantic, timeless, and lush.',
  },
  'Charcoal and Chalk': {
    description: 'dramatic charcoal and chalk drawing',
    style: 'A dramatic charcoal and chalk drawing style in wide format. Rich black strokes, powdery smudges, and stark white highlights. Bold, raw, and sketchy linework. Moody, timeless atmosphere, ideal for drama, introspection, or historical gravitas.',
  },
};

// Background music options
const BACKGROUND_MUSIC: Record<string, string> = {
  'A Baroque Letter': 'Classical letter-writing music for 1100-1800 European period pieces',
  'Wander Into': 'Calm peaceful background music for wholesome stories',
  'Rain On Rooftop': 'Rain ambient noise background',
  'Daytime Forrest Bonfire': 'Bonfire crackling ambient background',
  'A Minor Waltz': 'Late 1800s-early 1900s classical fine dining music',
  'Anton': 'Slow calm music with a hint of sadness',
  'Bourree': 'Fast-paced medieval European music',
  'Castle Ball': 'Fast-paced snobby aristocratic music',
  'E Minor Prelude': 'Sad slow solemn music for religious or sad stories',
  'Funeral March': 'Fast-paced sad music',
  'Jesus': 'Holy fast-paced music for short religious stories',
  'Moonlight Sonata': 'Serious fast-paced sad music',
  'Remembering Her': 'Serious modern memory/nostalgia music',
  'The First Noel': 'Holiday Christmas music',
  'Waltz of the Flowers': 'Happy instrumental music',
  'Dreaming in 432Hz': 'Calming 432Hz sleep frequency, soothing tones for peaceful slumber and bedtime stories',
  'Delta Waves': 'Meditative constant hum, deep delta wave frequency for meditation, focus, and tranquil reflection',
  'Colony': 'Relaxing ambient frequency, gentle atmospheric tones for calm and contemplative stories',
};

// Voice options for AI to choose from
// Priority: premium (Inworld) > clone > apex
const VOICE_OPTIONS = {
  // ── Premium voices (Inworld TTS) — highest quality, rich descriptions ──
  premium: [
    // English (EN_US) — 95 voices
    { name: 'Loretta', gender: 'female', language: 'english', description: 'Inviting, folksy Southern female voice, perfect for cooking shows, heartwarming family tales, and cozy radio ads.' },
    { name: 'Darlene', gender: 'female', language: 'english', description: 'Soothing, comforting Southern female voice, ideal for bedtime stories, family-centered commercials, and nostalgic narrations.' },
    { name: 'Marlene', gender: 'female', language: 'english', description: 'Friendly, relaxed Southern female voice, ideal for home-style cooking tutorials, community event promotions, and downhome commercials.' },
    { name: 'Hank', gender: 'male', language: 'english', description: 'Warm, laid-back Southern male voice, ideal for travel documentaries, heritage storytelling, and down-to-earth podcast ads.' },
    { name: 'Evelyn', gender: 'female', language: 'english', description: 'A gentle and intimate female voice, ideal for personal ASMR content, affirmations, and close, calming conversations.' },
    { name: 'Celeste', gender: 'female', language: 'english', description: 'Soft, whispery female voice, ideal for ASMR videos, soothing lullabies, and gentle mindfulness sessions.' },
    { name: 'Pippa', gender: 'female', language: 'english', description: 'Friendly and casual Australian female voice, ideal for relaxed instructional content.' },
    { name: 'Tessa', gender: 'female', language: 'english', description: 'Upbeat, conversational Australian female voice, perfect for lifestyle vlogs, playful advertisements, and engaging social media content.' },
    { name: 'Liam', gender: 'male', language: 'english', description: 'Upbeat, motivating Australian male voice, perfect for energizing workout sessions, lively event promotions, and informal lifestyle content.' },
    { name: 'Callum', gender: 'male', language: 'english', description: 'Casual and friendly Australian male voice, ideal for informal instructional content.' },
    { name: 'Hamish', gender: 'male', language: 'english', description: 'Friendly and casual Australian male voice, ideal for character-driven roles and upbeat fitness.' },
    { name: 'Abby', gender: 'female', language: 'english', description: 'Bright, eager American female child voice, ideal for animated characters, upbeat educational content, and lively kids commercials.' },
    { name: 'Graham', gender: 'male', language: 'english', description: 'Profound, authoritative British male voice, perfect for historical documentaries, luxury brand advertisements, and educational content.' },
    { name: 'Rupert', gender: 'male', language: 'english', description: 'Resonant, commanding British male voice, ideal for motivational speeches, epic film trailers, and dynamic corporate presentations.' },
    { name: 'Mortimer', gender: 'male', language: 'english', description: 'Gravelly, aggressive male character voice, ideal for fantasy villains and high-intensity game dialogue.' },
    { name: 'Snik', gender: 'male', language: 'english', description: 'Hoarse, cunning male voice, perfect for devious goblin roles, fantasy heist scenarios, and trickster-themed animations.' },
    { name: 'Anjali', gender: 'female', language: 'english', description: 'A confident and articulate Indian female voice, ideal for professional training materials.' },
    { name: 'Saanvi', gender: 'female', language: 'english', description: 'Crisp, articulate Indian female voice, ideal for dynamic e-learning modules, articulate documentary narrations, and vibrant travel vlogs.' },
    { name: 'Arjun', gender: 'male', language: 'english', description: 'Clear, composed Indian male voice, well-suited for instructional webinars and technology explainers.' },
    { name: 'Claire', gender: 'female', language: 'english', description: 'Warm, gentle Eastern European female voice, ideal for bedtime stories, relaxation podcasts.' },
    { name: 'Oliver', gender: 'male', language: 'english', description: 'Neutral and clear male voice, ideal for public announcements and educational information.' },
    { name: 'Simon', gender: 'male', language: 'english', description: 'Articulate, insightful male voice, perfect for corporate presentations, technical tutorials, and steady news reporting.' },
    { name: 'Elliot', gender: 'male', language: 'english', description: 'A calm, steady male voice, suitable for nature documentaries, general informational content, and relaxed narrations.' },
    { name: 'James', gender: 'male', language: 'english', description: 'Vibrant, expressive male voice, perfect for animated video content, lively event hosting, and captivating children stories.' },
    { name: 'Serena', gender: 'female', language: 'english', description: 'Soft, nurturing female voice, perfect for mindfulness sessions, nature-inspired visualizations, and gentle wellness podcasts.' },
    { name: 'Gareth', gender: 'male', language: 'english', description: 'Soothing, gentle male voice, ideal for guided meditations, mindfulness exercises, and relaxation-focused wellness content.' },
    { name: 'Vinny', gender: 'male', language: 'english', description: 'Gritty, assertive New York male voice, perfect for crime dramas, urban documentaries, and no-nonsense character roles.' },
    { name: 'Lauren', gender: 'female', language: 'english', description: 'Confident, friendly American female voice, ideal for corporate presentations, upbeat commercials, and engaging podcasts.' },
    { name: 'Jessica', gender: 'female', language: 'english', description: 'Encouraging, articulate American female voice, perfect for self-help audiobooks, warm customer service messages, and clear e-learning modules.' },
    { name: 'Ethan', gender: 'male', language: 'english', description: 'Assured, precise male voice, perfect for tech tutorials, detailed gadget overviews, and captivating product demonstrations.' },
    { name: 'Tyler', gender: 'male', language: 'english', description: 'Authoritative, insightful male voice, ideal for tech explainer videos, in-depth software reviews, and dynamic coding guides.' },
    { name: 'Jason', gender: 'male', language: 'english', description: 'Lucid, engrossing male voice, ideal for tech tips, creative productivity hacks, and supportive user interface tutorials.' },
    { name: 'Chloe', gender: 'female', language: 'english', description: 'Thoughtful, introspective youthful female voice, perfect for coming-of-age narratives, personal growth stories, and emotional teen dramas.' },
    { name: 'Veronica', gender: 'female', language: 'english', description: 'Intimidating, commanding female voice, perfect for ruthless antagonists, high-stakes negotiations, and chilling monologues.' },
    { name: 'Victoria', gender: 'female', language: 'english', description: 'Silky, cunning British female voice, ideal for narrating intricate plots.' },
    { name: 'Miranda', gender: 'female', language: 'english', description: 'Menacing, cold-hearted female voice, perfect for strategic villains, mysterious narratives.' },
    { name: 'Sebastian', gender: 'male', language: 'english', description: 'Intimidating, steely male voice, perfect for ruthless antagonists, strategic power struggles, and chilling monologues.' },
    { name: 'Victor', gender: 'male', language: 'english', description: 'Ominous, sinister male voice, ideal for dark conspiracies, eerie suspense scenes, and enigmatic villain roles.' },
    { name: 'Malcolm', gender: 'male', language: 'english', description: 'Authoritative, manipulative male voice, perfect for cunning leaders, intense negotiation scenes, and persuasive villain speeches.' },
    { name: 'Nate', gender: 'male', language: 'english', description: 'Conversational, sociable male voice, great for customer support and friendly guidance.' },
    { name: 'Brian', gender: 'male', language: 'english', description: 'Friendly, encouraging American male voice, ideal for educational tutorials, motivational content, and instructional videos.' },
    { name: 'Amina', gender: 'female', language: 'english', description: 'Warm, inviting West African female voice, ideal for community outreach, cultural storytelling, and educational workshops.' },
    { name: 'Kelsey', gender: 'female', language: 'english', description: 'Warm, empathetic, reassuring female voice, ideal for phone support, appointment confirmations, and customer success calls.' },
    { name: 'Derek', gender: 'male', language: 'english', description: 'Steady, professional, composed American male voice, ideal for banking support, account inquiries, and service escalation calls.' },
    { name: 'Evan', gender: 'male', language: 'english', description: 'Friendly, approachable, easygoing male voice, ideal for onboarding calls, retail assistance, and customer check-ins.' },
    { name: 'Kayla', gender: 'female', language: 'english', description: 'Enthusiastic, youthful female voice, ideal for reaction videos, trendy product reviews, and energetic lifestyle vlogs.' },
    { name: 'Jake', gender: 'male', language: 'english', description: 'Amiable, introspective male voice, ideal for motivational talks, personal growth content, and charming interviews.' },
    { name: 'Grant', gender: 'male', language: 'english', description: 'Calm, attentive, helpful male voice, ideal for insurance claims, troubleshooting walkthroughs, and helpdesk interactions.' },
    { name: 'Tristan', gender: 'male', language: 'english', description: 'Deliberate, controlled male voice, ideal for documentary narration, polished voiceover campaigns, and clear long-form storytelling.' },
    { name: 'Nadia', gender: 'female', language: 'english', description: 'Personable, lively female voice, perfect for tutorial walkthroughs, friendly support messaging, and engaging narration.' },
    { name: 'Selene', gender: 'female', language: 'english', description: 'Soft, flirtatious female voice, ideal for companion-style interactions, charming game dialogue, and emotionally playful character-driven scenes.' },
    { name: 'Marcus', gender: 'male', language: 'english', description: 'Authoritative, empathetic male voice, great for civic campaigns, community outreach explainers, and trustworthy commercial reads.' },
    { name: 'Riley', gender: 'female', language: 'english', description: 'Playful, youthful female voice, perfect for animated storytelling, upbeat game characters, and high-energy kid-focused content.' },
    { name: 'Damon', gender: 'male', language: 'english', description: 'Calm, raspy male voice, suited for moody narration, atmospheric roleplay characters, and grounded meditative reads with subtle tension.' },
    { name: 'Cedric', gender: 'male', language: 'english', description: 'Crisp, measured male voice, ideal for formal announcements, premium trailer narration, and command-forward presentation scripts.' },
    { name: 'Mia', gender: 'female', language: 'english', description: 'Youthful, expressive female voice, ideal for adolescent characters, school-age animation dialogue, and bright coming-of-age narratives.' },
    { name: 'Naomi', gender: 'female', language: 'english', description: 'Warm, grounded female voice, perfect for narrative podcasting, people-first customer guidance, and emotionally real brand storytelling.' },
    { name: 'Jonah', gender: 'male', language: 'english', description: 'Soothing, calm male voice, great for tutorial guidance, reassuring support flows, and gentle instructional narration.' },
    { name: 'Levi', gender: 'male', language: 'english', description: 'Measured, ominous male voice, ideal for suspense narration, dark fantasy storytelling, and composed dramatic monologues.' },
    { name: 'Avery', gender: 'male', language: 'english', description: 'Youthful, performative male voice, suited for gameshow-style hosting, energetic presenter reads, and expressive young character parts.' },
    { name: 'Brandon', gender: 'male', language: 'english', description: 'Bold, strident male voice, ideal for structured announcements, news-style reads, and direct promotional messaging.' },
    { name: 'Conrad', gender: 'male', language: 'english', description: 'Gruff, weathered male voice, perfect for detective archetypes, hard-edged audiobook roles, and serious investigative narration.' },
    { name: 'Bianca', gender: 'female', language: 'english', description: 'Deep, controlled female voice, ideal for serious corporate reads, composed documentary segments, and measured authority-led explainers.' },
    { name: 'Lucian', gender: 'male', language: 'english', description: 'Brooding, foreboding male voice, suited for villainous character arcs, gothic drama scenes, and dark narrative worldbuilding.' },
    { name: 'Trevor', gender: 'male', language: 'english', description: 'Punchy, expressive male voice, perfect for energetic promos, announcer-driven reveals, and fast-moving scripted event intros.' },
    { name: 'Alex', gender: 'male', language: 'english', description: 'Energetic and expressive mid-range male voice, with a mildly nasal quality.' },
    { name: 'Ashley', gender: 'female', language: 'english', description: 'A warm, natural female voice.' },
    { name: 'Craig', gender: 'male', language: 'english', description: 'Older British male with a refined and articulate voice.' },
    { name: 'Deborah', gender: 'female', language: 'english', description: 'Warm, peaceful female voice with a calm tone.' },
    { name: 'Dennis', gender: 'male', language: 'english', description: 'Middle-aged man with a smooth, calm and friendly voice.' },
    { name: 'Edward', gender: 'male', language: 'english', description: 'American male with an emphatic, confident and streetwise tone.' },
    { name: 'Elizabeth', gender: 'female', language: 'english', description: 'Professional middle-aged woman, perfect for narrations and voiceovers.' },
    { name: 'Hades', gender: 'male', language: 'english', description: 'Commanding and gruff male voice, think an omniscient narrator or castle guard.' },
    { name: 'Julia', gender: 'female', language: 'english', description: 'Quirky, high-pitched female voice that delivers lines with playful energy.' },
    { name: 'Pixie', gender: 'female', language: 'english', description: 'High-pitched, childlike female voice with a squeaky quality — great for a cartoon character.' },
    { name: 'Mark', gender: 'male', language: 'english', description: 'Energetic, expressive man with a rapid-fire delivery.' },
    { name: 'Olivia', gender: 'female', language: 'english', description: 'Young, British female with a friendly and helpful tone, conveying confidence and efficiency.' },
    { name: 'Priya', gender: 'female', language: 'english', description: 'Even-toned female voice with an Indian accent.' },
    { name: 'Ronald', gender: 'male', language: 'english', description: 'Confident, British man with a deep, gravelly voice.' },
    { name: 'Sarah', gender: 'female', language: 'english', description: 'Fast-talking young adult woman, with a questioning and curious tone.' },
    { name: 'Shaun', gender: 'male', language: 'english', description: 'Friendly, dynamic male voice great for conversations.' },
    { name: 'Theodore', gender: 'male', language: 'english', description: 'Gravelly male voice, with a time-worn quality.' },
    { name: 'Timothy', gender: 'male', language: 'english', description: 'Lively, upbeat American male voice.' },
    { name: 'Wendy', gender: 'female', language: 'english', description: 'Posh, middle-aged British female voice.' },
    { name: 'Dominus', gender: 'male', language: 'english', description: 'Robotic, deep male voice with a menacing quality. Perfect for villains.' },
    { name: 'Hana', gender: 'female', language: 'english', description: 'Bright, expressive young female voice, perfect for storytelling, gaming, and playful content.' },
    { name: 'Clive', gender: 'male', language: 'english', description: 'British-accented English-language male voice with a calm, cordial quality.' },
    { name: 'Carter', gender: 'male', language: 'english', description: 'Energetic, mature radio announcer-style male voice, great for storytelling, pep talks, and voiceovers.' },
    { name: 'Blake', gender: 'male', language: 'english', description: 'Rich, intimate male voice, perfect for audiobooks, romantic content, and reassuring narration.' },
    { name: 'Luna', gender: 'female', language: 'english', description: 'Calm, relaxing female voice, perfect for meditations, sleep stories, and mindfulness exercises.' },
    { name: 'Reed', gender: 'male', language: 'english', description: 'Clear, professional American male voice, well-suited for support and training.' },
    { name: 'Duncan', gender: 'male', language: 'english', description: 'Warm, articulate British male voice for customer support and education.' },
    { name: 'Felix', gender: 'male', language: 'english', description: 'Calm, friendly British male voice, ideal for help and tutorials.' },
    { name: 'Eleanor', gender: 'female', language: 'english', description: 'Polished, approachable British female voice for support and learning.' },
    { name: 'Sophie', gender: 'female', language: 'english', description: 'Friendly British female voice, great for assistance and knowledge sharing.' },
    // Arabic (AR_SA) — 2 voices
    { name: 'Nour', gender: 'female', language: 'arabic', description: 'Polished female Arabic voice with a friendly tone, great for voice over or support.' },
    { name: 'Omar', gender: 'male', language: 'arabic', description: 'Bright, confident Arabic male voice, great for announcements, broadcasts, and voice overs.' },
    // Chinese (ZH_CN) — 4 voices
    { name: 'Yichen', gender: 'male', language: 'chinese', description: 'A calm, flat young adult male Chinese voice.' },
    { name: 'Xiaoyin', gender: 'female', language: 'chinese', description: 'A youthful Chinese female voice with a gentle, sweet voice.' },
    { name: 'Xinyi', gender: 'female', language: 'chinese', description: 'A Chinese woman with a neutral tone, perfect for narrations.' },
    { name: 'Jing', gender: 'female', language: 'chinese', description: 'An energetic, fast-paced young Chinese female.' },
    // Dutch (NL_NL) — 4 voices
    { name: 'Erik', gender: 'male', language: 'dutch', description: 'Older Dutch male voice with a weathered edge.' },
    { name: 'Katrien', gender: 'female', language: 'dutch', description: 'Dutch woman with an expressive voice.' },
    { name: 'Lennart', gender: 'male', language: 'dutch', description: 'A confident Dutch male voice. Calm and relaxed.' },
    { name: 'Lore', gender: 'female', language: 'dutch', description: 'Clear, calm Dutch female voice, great for narrations and professional use cases.' },
    // French (FR_FR) — 4 voices
    { name: 'Alain', gender: 'male', language: 'french', description: 'Deep, smooth middle-aged male French voice. Composed and calm.' },
    { name: 'Hélène', gender: 'female', language: 'french', description: 'Middle-aged French woman, with a smooth, musical, and graceful voice.' },
    { name: 'Mathieu', gender: 'male', language: 'french', description: 'A French male voice carrying a nasal quality.' },
    { name: 'Étienne', gender: 'male', language: 'french', description: 'Calm young adult French male.' },
    // German (DE_DE) — 2 voices
    { name: 'Johanna', gender: 'female', language: 'german', description: 'A calm older German female with a low, smoky voice.' },
    { name: 'Josef', gender: 'male', language: 'german', description: 'An articulate German male voice with an announcer-like quality.' },
    // Hebrew (HE_IL) — 2 voices
    { name: 'Yael', gender: 'female', language: 'hebrew', description: 'Mid-range female Hebrew voice, suitable for narrations, storytelling, and more.' },
    { name: 'Oren', gender: 'male', language: 'hebrew', description: 'Steady male Hebrew voice, great for podcasts, voice overs, or announcers.' },
    // Hindi (HI_IN) — 2 voices
    { name: 'Riya', gender: 'female', language: 'hindi', description: 'Professional and clean female voice, with a clear and articulate tone, moderate pace, and a polished, approachable quality.' },
    { name: 'Manoj', gender: 'male', language: 'hindi', description: 'Clear, professional Hindi male voice. Great for narrations, news anchors, and customer service.' },
    // Italian (IT_IT) — 2 voices
    { name: 'Gianni', gender: 'male', language: 'italian', description: 'Deep, smooth Italian male voice that speaks rapidly.' },
    { name: 'Orietta', gender: 'female', language: 'italian', description: 'Calm adult female Italian voice, with a soothing cadence.' },
    // Japanese (JA_JP) — 2 voices
    { name: 'Asuka', gender: 'female', language: 'japanese', description: 'Friendly, young adult Japanese female voice.' },
    { name: 'Satoshi', gender: 'male', language: 'japanese', description: 'Dramatic, expressive male Japanese voice filled with energy.' },
    // Korean (KO_KR) — 4 voices
    { name: 'Hyunwoo', gender: 'male', language: 'korean', description: 'Young adult Korean male voice.' },
    { name: 'Minji', gender: 'female', language: 'korean', description: 'Energetic, friendly young Korean female voice.' },
    { name: 'Seojun', gender: 'male', language: 'korean', description: 'Clear, deep mature Korean male voice.' },
    { name: 'Yoona', gender: 'female', language: 'korean', description: 'Korean woman with a gentle, soothing voice.' },
    // Polish (PL_PL) — 2 voices
    { name: 'Szymon', gender: 'male', language: 'polish', description: 'Polish adult male voice with a warm, friendly quality.' },
    { name: 'Wojciech', gender: 'male', language: 'polish', description: 'A middle-aged Polish male voice.' },
    // Portuguese (PT_BR) — 2 voices
    { name: 'Heitor', gender: 'male', language: 'portuguese', description: 'Composed Portuguese-speaking male voice with a neutral tone.' },
    { name: 'Maitê', gender: 'female', language: 'portuguese', description: 'Middle-aged Portuguese-speaking female voice.' },
    // Russian (RU_RU) — 4 voices
    { name: 'Svetlana', gender: 'female', language: 'russian', description: 'Soft, high-pitched female voice, with a moderate pace and slightly breathy quality.' },
    { name: 'Elena', gender: 'female', language: 'russian', description: 'Clear, mid-range female voice, with a smooth texture and a neutral, informational tone.' },
    { name: 'Dmitry', gender: 'male', language: 'russian', description: 'Deep, gravelly male voice, delivered at a moderate pace with a commanding and narrative tone.' },
    { name: 'Nikolai', gender: 'male', language: 'russian', description: 'Deep, resonant male voice, delivered at a measured pace with a clear, theatrical, and narrative quality.' },
    // Spanish (ES_ES) — 4 voices
    { name: 'Diego', gender: 'male', language: 'spanish', description: 'Spanish-speaking male voice with a soothing, gentle quality.' },
    { name: 'Lupita', gender: 'female', language: 'spanish', description: 'Vibrant, energetic young Spanish-speaking female voice.' },
    { name: 'Miguel', gender: 'male', language: 'spanish', description: 'A calm adult Spanish-speaking male voice, perfect for storytelling.' },
    { name: 'Rafael', gender: 'male', language: 'spanish', description: 'Middle-aged Spanish-speaking male with a deep, composed voice. Great for narrations.' },
  ],
  // ── Clone voices (Inworld cloned) — unique character voices, English-native but multilingual capable ──
  clone: [
    { name: 'Declan', id: 'default-ujsa1wysgyitfqg3ixpqka__declan', description: 'Dark and slow narrator — horror, mystery, true crime, gothic' },
    { name: 'Adrian', id: 'default-ujsa1wysgyitfqg3ixpqka__adrian', description: 'Relaxed chill young guy — casual stories, vlogs, modern narratives' },
    { name: 'Alfred', id: 'default-ujsa1wysgyitfqg3ixpqka__alfred', description: 'Very relaxed and slow narration — documentary, nature, calm stories' },
    { name: 'Conrad', id: 'default-ujsa1wysgyitfqg3ixpqka__conrad', description: 'Lively evil character voice — villains, dramatic fiction, dark fantasy' },
    { name: 'Hugo', id: 'default-ujsa1wysgyitfqg3ixpqka__hugo', description: 'Old funny man voice — comedy, light-hearted, humorous stories' },
    { name: 'Ryder', id: 'default-ujsa1wysgyitfqg3ixpqka__ryder', description: 'Serious commercial voice — factual, news-style, professional narration' },
    { name: 'Victor', id: 'default-ujsa1wysgyitfqg3ixpqka__victor', description: 'Older Italian-American voice — crime, mafia, noir stories' },
  ],
  // ── Apex voices (Speechify) — fallback, less descriptive ──
  apex: [
    // Male voices
    { name: 'oliver', gender: 'male', language: 'american english', description: 'Clear professional male narrator' },
    { name: 'rob', gender: 'male', language: 'american english', description: 'Warm conversational male voice' },
    { name: 'jesse', gender: 'male', language: 'american english', description: 'Young energetic male voice' },
    { name: 'ken', gender: 'male', language: 'american english', description: 'Mature authoritative male voice' },
    { name: 'james', gender: 'male', language: 'american english', description: 'Deep refined male narrator' },
    { name: 'douglas', gender: 'male', language: 'american english', description: 'Distinguished older male voice' },
    // Female voices
    { name: 'erin', gender: 'female', language: 'american english', description: 'Warm natural female narrator' },
    { name: 'lindsey', gender: 'female', language: 'american english', description: 'Bright friendly female voice' },
    { name: 'monica', gender: 'female', language: 'american english', description: 'Smooth professional female voice' },
    { name: 'stacy', gender: 'female', language: 'american english', description: 'Energetic youthful female voice' },
    { name: 'christina', gender: 'female', language: 'american english', description: 'Calm soothing female narrator' },
    { name: 'patricia', gender: 'female', language: 'american english', description: 'Mature elegant female voice' },
  ],
};

// Effects options
const EFFECTS_OPTIONS = ['none', 'film_grain', 'fire_flare', 'light_sparkle', 'snow'];

// Plan token limits — legacy pricing (is_legacy_plan = true or null).
const PLAN_MAX_TOKENS: Record<string, number> = {
  free: 400000,
  standard: 4000000,
  plus: 6000000,
  premium: 10000000,
  pro: 25000000,
  elite: 50000000,
  ultimate: 75000000,
  enterprise: 250000000,
};
// New plan allotments (is_legacy_plan = false).
const NEW_PLAN_MAX_TOKENS: Record<string, number> = {
  free: 400000,
  standard: 9000000,
  plus: 6000000,
  premium: 18500000,
  pro: 38500000,
  elite: 78500000,
  ultimate: 198000000,
  enterprise: 498000000,
};

// ─── Token Estimation ────────────────────────────────────────────────────────

interface PlannedSettings {
  // Story
  story_title: string;
  description: string;
  word_count: number;
  language: string;
  // Visual
  visual_type: 'image' | 'ttv' | 'itv' | 'mg';
  image_model?: string;
  image_style?: string;
  video_model?: string;
  video_duration?: number;
  itv_model?: string;
  itv_duration?: number;
  // Motion Graphics (visual_type === 'mg')
  mg_style_slug?: string;
  mg_style_guidance?: string | null;
  mg_clip_duration?: number;
  mg_codegen_model?: 'claude-opus-4-6' | 'claude-sonnet-4-6';
  // Audio
  voice_type: 'premium' | 'clone' | 'apex';
  voice_name: string;
  voice_id?: string;
  // Frequency
  first_page_frequency: number;
  rest_frequency: number;
  // Master prompt
  master_prompt: {
    visualStyle: string;
    setting: string;
    atmosphere: string;
    environmentOnly: boolean;
    characters: Array<{ name: string; description: string }>;
    contentType: string;
  };
  // Video settings
  transition_type: string | null;
  animation_type: string;
  effects_type: string | null;
  bg_music: string | null;
  bg_music_key?: string;
  // Story model
  story_model: 'sonnet' | 'deepseek';
  // Prompt model (for image/video prompt generation)
  prompt_model: 'sonnet' | 'deepseek';
}

function estimateTokenCost(
  settings: PlannedSettings,
  runtimeMinutes: number,
  multipliers: Record<string, number> = STORY_MODEL_MULTIPLIERS,
  imageCosts: typeof IMAGE_MODEL_COSTS = IMAGE_MODEL_COSTS,
  ttvCosts: typeof TTV_MODEL_COSTS = TTV_MODEL_COSTS,
  itvCosts: typeof ITV_MODEL_COSTS = ITV_MODEL_COSTS,
): number {
  const runtimeSeconds = runtimeMinutes * 60;
  // Adjusted for speech speed
  const effectiveSecondsForWords = runtimeSeconds / SPEECH_SPEED;
  const wordCount = Math.round(effectiveSecondsForWords * WORDS_PER_SECOND);
  const totalChars = wordCount * 5; // ~5 chars per word
  const audioSeconds = totalChars / CHARS_PER_SECOND;

  let totalTokens = 0;

  // 1. Story generation (multiplier depends on chosen story model)
  const storyMultiplier = multipliers[settings.story_model] ?? multipliers.sonnet ?? 11.0;
  const storyInputTokens = Math.ceil(wordCount * TOKEN_PER_WORD);
  const storyTokens = Math.ceil(storyInputTokens * storyMultiplier * 1.25); // 25% safety margin
  totalTokens += storyTokens;

  // 2. Audio (premium/clone = 4 tokens/char)
  totalTokens += totalChars * AUDIO_TOKENS_PER_CHAR;

  // Use master prompt's character flag for prompt-batch overhead modeling
  // (matches video-analyze so plan-video stops under-quoting sonnet).
  const useChars = !!settings.master_prompt && settings.master_prompt.environmentOnly !== true;
  const promptMultiplier = multipliers[settings.prompt_model] ?? multipliers.sonnet ?? 11.0;

  // 3. Visual content
  if (settings.visual_type === 'image' && settings.image_model) {
    const imageModelCost = imageCosts[settings.image_model];
    if (imageModelCost) {
      const firstPageChars = settings.first_page_frequency * CHARS_PER_SECOND;
      const restChars = settings.rest_frequency * CHARS_PER_SECOND;
      const firstImages = Math.ceil(3000 / firstPageChars);
      const remainingChars = Math.max(0, totalChars - 3000);
      const restImages = Math.ceil(remainingChars / restChars);
      const imageCount = Math.round((firstImages + restImages) * 1.18);

      // Image-prompt generation — calibrated formula from video-analyze
      totalTokens += estimateImagePromptTokens(wordCount, imageCount, useChars, promptMultiplier);
      // Image generation
      totalTokens += imageCount * imageModelCost.tokens;
      // Pipeline overhead — runtime-based
      totalTokens += estimatePipelineTokens({
        numClips: imageCount,
        audioSeconds,
        visualType: 'image',
        hasTransitions: !!settings.transition_type && settings.transition_type !== 'none',
        animationType: settings.animation_type || 'horizontal_drift',
        effectsType: settings.effects_type ?? null,
      });
    }
  } else if (settings.visual_type === 'ttv' && settings.video_model) {
    const model = ttvCosts[settings.video_model];
    if (model) {
      const clipDuration = settings.video_duration || model.defaultDuration;
      const clipCount = Math.ceil(runtimeSeconds / clipDuration);
      totalTokens += estimateImagePromptTokens(wordCount, clipCount, useChars, promptMultiplier);
      totalTokens += clipCount * clipDuration * model.tokensPerSec;
      totalTokens += estimatePipelineTokens({
        numClips: clipCount,
        audioSeconds,
        visualType: 'ttv',
        hasTransitions: !!settings.transition_type && settings.transition_type !== 'none',
        animationType: null,
        effectsType: settings.effects_type ?? null,
      });
    }
  } else if (settings.visual_type === 'itv' && settings.itv_model) {
    const model = itvCosts[settings.itv_model];
    if (model) {
      const clipDuration = settings.itv_duration || model.defaultDuration;
      const clipCount = Math.ceil(runtimeSeconds / clipDuration);
      totalTokens += estimateImagePromptTokens(wordCount, clipCount, useChars, promptMultiplier);
      const imgModel = settings.image_model || 'imagen-4-fast';
      const imgCost = imageCosts[imgModel]?.tokens || 14000;
      totalTokens += clipCount * imgCost;
      totalTokens += clipCount * clipDuration * model.tokensPerSec;
      totalTokens += estimatePipelineTokens({
        numClips: clipCount,
        audioSeconds,
        visualType: 'itv',
        hasTransitions: !!settings.transition_type && settings.transition_type !== 'none',
        animationType: null,
        effectsType: settings.effects_type ?? null,
      });
    }
  } else if (settings.visual_type === 'mg') {
    // Motion Graphics — Claude Opus codegen + Remotion-Lambda render per clip.
    const clipDuration = settings.mg_clip_duration || MG_DEFAULT_CLIP_SECONDS;
    const clipCount = mgClipCount(runtimeSeconds, clipDuration);
    totalTokens += estimateImagePromptTokens(wordCount, clipCount, useChars, promptMultiplier);
    totalTokens += estimateMgTokenCost(runtimeSeconds, clipDuration);
    totalTokens += estimatePipelineTokens({
      numClips: clipCount,
      audioSeconds,
      visualType: 'ttv',
      hasTransitions: !!settings.transition_type && settings.transition_type !== 'none',
      animationType: null,
      effectsType: settings.effects_type ?? null,
    });
  }
  }

  return totalTokens;
}

// Image-prompt token estimator — ported verbatim from video-analyze so plan-video
// and the page-level estimator agree on cost.
function estimateImagePromptTokens(
  wordCount: number,
  numPrompts: number,
  useCharacterDescriptions: boolean,
  promptMultiplier: number,
): number {
  if (numPrompts <= 0 || wordCount <= 0) return 0;
  const totalWordsWithPrompts = wordCount + 200 * numPrompts;
  const numBatches = Math.max(1, Math.ceil(totalWordsWithPrompts / 900));
  const inputSafetyMultiplier = 1.25;
  let totalInputTokens: number;
  let totalOutputTokens: number;
  if (useCharacterDescriptions) {
    const charInputTokens = (wordCount + 100) * TOKEN_PER_WORD;
    const charOutputTokens = 133 * 5;
    const promptInputTokens = numBatches * (wordCount + 1600) * TOKEN_PER_WORD;
    const promptOutputTokens = numPrompts * 800 * TOKEN_PER_WORD;
    totalInputTokens = charInputTokens + promptInputTokens + 665;
    totalOutputTokens = charOutputTokens + promptOutputTokens;
  } else {
    const promptInputTokens = numBatches * (wordCount + 1100) * TOKEN_PER_WORD;
    const promptOutputTokens = numPrompts * 800 * TOKEN_PER_WORD;
    totalInputTokens = promptInputTokens + 665;
    totalOutputTokens = promptOutputTokens;
  }
  totalInputTokens = Math.round(totalInputTokens * inputSafetyMultiplier);
  const baseTokens = Math.round(totalInputTokens * 0.25 + totalOutputTokens);
  return baseTokens * promptMultiplier;
}

// Runtime-based pipeline cost — mirrors video-analyze.estimateVideoProcessingTokens.
// Uses the inline TIME_EST / TOKEN_RATES_PER_MIN constants near the top of this file.
function estimatePipelineTokens(args: {
  numClips: number;
  audioSeconds: number;
  visualType: 'image' | 'ttv' | 'itv';
  hasTransitions: boolean;
  animationType: string | null;
  effectsType: string | null;
}): number {
  const { numClips, audioSeconds, visualType, hasTransitions, animationType, effectsType } = args;
  const useHighMemory =
    audioSeconds > TIME_EST.HM_S_AUDIO_THRESHOLD ||
    (hasTransitions && audioSeconds > TIME_EST.HM_TRANSITIONS_S_AUDIO_THRESHOLD);
  const animMult = ANIM_MULT_INLINE[animationType ?? 'none'] ?? 1.2;
  const effMult  = EFFECT_MULT_INLINE[effectsType ?? 'none'] ?? 3.0;
  let overlayProduct = animMult * effMult;
  if (hasTransitions) overlayProduct *= ITV_TRANSITIONS_MULT_INLINE;
  // Stage seconds
  const audioDuration = TIME_EST.T_AUDIO_CONST + TIME_EST.T_AUDIO_PER_SEC * audioSeconds;
  const audioBoost    = TIME_EST.T_BOOST_CONST + TIME_EST.T_BOOST_PER_SEC * audioSeconds;
  const calcCfg       = VT_CALC_DUR_INLINE[visualType];
  const calcDurations = TIME_EST.T_CALC_DUR_CONST + calcCfg.perImage * numClips + calcCfg.perAudioSec * audioSeconds;
  const itvCfg        = VT_ITV_STAGE_INLINE[visualType];
  const evenSec       = numClips > 0 ? audioSeconds / numClips : 0;
  const imageToVideo  = numClips * (itvCfg.perImageConst + itvCfg.perVideoSec * evenSec * overlayProduct);
  const renderPerSec  = VT_RENDER_INLINE[visualType].perAudioSec
    * (useHighMemory ? TIME_EST.T_RENDER_HM_SPEEDUP : 1)
    * (hasTransitions ? TIME_EST.T_RENDER_TRANSITIONS_MULT : 1);
  const finalRender   = TIME_EST.T_RENDER_CONST + renderPerSec * audioSeconds
    + (hasTransitions ? renderPerSec * audioSeconds * TIME_EST.T_RENDER_TRANSITIONS_PASS_MULT : 0);
  // Tokens per stage
  const renderRate = useHighMemory
    ? TOKEN_RATES_PER_MIN['create-final-video-high-memory']
    : TOKEN_RATES_PER_MIN['create-final-video'];
  const audioDurTokens   = (audioDuration / 60) * TOKEN_RATES_PER_MIN['calculate-audio-duration'];
  const audioBoostTokens = (audioBoost    / 60) * TOKEN_RATES_PER_MIN['boost-audio-volume'];
  const calcDurTokens    = (calcDurations / 60) * TOKEN_RATES_PER_MIN['calculate-video-durations'];
  const itvProcTokens    = (imageToVideo  / 60) * TOKEN_RATES_PER_MIN['image-to-video-processor'];
  const renderTokens     = (finalRender   / 60) * renderRate;
  const TOKEN_SAFETY_PAD = 1.15;
  return Math.ceil(
    (audioDurTokens + audioBoostTokens + calcDurTokens + itvProcTokens + renderTokens) * TOKEN_SAFETY_PAD
  );
}

// ─── YouTube Transcript Fetching ─────────────────────────────────────────────

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

interface TranscriptResult {
  videoId: string;
  transcript: string | null;
  error?: string;
  method?: string;
}

async function fetchYouTubeTranscripts(urls: string[]): Promise<{ results: TranscriptResult[]; combinedText: string }> {
  const videoIds = urls.map(u => extractVideoId(u)).filter((id): id is string => !!id);
  if (videoIds.length === 0) {
    return { results: [], combinedText: '' };
  }

  if (!TRANSCRIPT_GCF_URL) {
    console.log('[plan-video] No TRANSCRIPT_GCF_URL configured, skipping transcript fetch');
    return {
      results: videoIds.map(id => ({ videoId: id, transcript: null, error: 'GCF URL not configured' })),
      combinedText: '',
    };
  }

  console.log(`[plan-video] Fetching transcripts for ${videoIds.length} video(s): [${videoIds.join(', ')}]`);
  try {
    const response = await fetch(TRANSCRIPT_GCF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_ids: videoIds }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[plan-video] GCF HTTP ${response.status}: ${errorText.substring(0, 200)}`);
      return {
        results: videoIds.map(id => ({ videoId: id, transcript: null, error: `GCF HTTP ${response.status}` })),
        combinedText: '',
      };
    }

    const data = await response.json();
    const results: TranscriptResult[] = (data.results || []).map((r: any) => ({
      videoId: r.videoId,
      transcript: r.transcript || null,
      method: r.method,
      error: r.error,
    }));

    const successCount = results.filter(r => r.transcript).length;
    console.log(`[plan-video] Transcript fetch: ${successCount}/${videoIds.length} successful`);

    // Combine all successful transcripts into one text block
    const combinedText = results
      .filter(r => r.transcript)
      .map(r => r.transcript!)
      .join('\n\n---\n\n');

    return { results, combinedText };
  } catch (error: any) {
    console.error(`[plan-video] Transcript fetch error: ${error.message}`);
    return {
      results: videoIds.map(id => ({ videoId: id, transcript: null, error: error.message })),
      combinedText: '',
    };
  }
}

// ─── Build System Prompt for DeepSeek ────────────────────────────────────────

function buildPlanningPrompt(
  userPrompt: string,
  tokenBudget: number,
  runtimeMinutes: number,
  language: string,
  userTokenBalance: number,
  requestedVisualType?: string,
  transcriptContext?: string,
  multipliers: Record<string, number> = STORY_MODEL_MULTIPLIERS,
  imageCosts: typeof IMAGE_MODEL_COSTS = IMAGE_MODEL_COSTS,
  ttvCosts: typeof TTV_MODEL_COSTS = TTV_MODEL_COSTS,
  itvCosts: typeof ITV_MODEL_COSTS = ITV_MODEL_COSTS,
): string {
  const runtimeSeconds = runtimeMinutes * 60;
  const effectiveSeconds = runtimeSeconds / SPEECH_SPEED;
  const estimatedWordCount = Math.round(effectiveSeconds * WORDS_PER_SECOND);
  const estimatedChars = estimatedWordCount * 5;

  // Calculate audio cost (fixed, always premium/clone)
  const audioCost = estimatedChars * AUDIO_TOKENS_PER_CHAR;
  // Story generation cost range (depends on model choice)
  const sonnetMult = multipliers.sonnet ?? 11.0;
  const deepseekMult = multipliers.deepseek ?? 1.0;
  const storyCostSonnet = Math.ceil(estimatedWordCount * TOKEN_PER_WORD * sonnetMult * 1.25);
  const storyCostDeepseek = Math.ceil(estimatedWordCount * TOKEN_PER_WORD * deepseekMult * 1.25);
  const fixedCostsSonnet = audioCost + storyCostSonnet + PIPELINE_COSTS.DURATION_CALC + PIPELINE_COSTS.FINAL_VIDEO_BASE;
  const fixedCostsDeepseek = audioCost + storyCostDeepseek + PIPELINE_COSTS.DURATION_CALC + PIPELINE_COSTS.FINAL_VIDEO_BASE;
  const remainingBudgetSonnet = tokenBudget - fixedCostsSonnet;
  const remainingBudgetDeepseek = tokenBudget - fixedCostsDeepseek;

  // Build model cost tables for the AI (uses the user's plan-specific pricing)
  let imageModelTable = 'IMAGE MODELS (tokens per image):\n';
  for (const [id, info] of Object.entries(imageCosts)) {
    imageModelTable += `  ${id} (${info.name}): ${info.tokens.toLocaleString()} tokens/image\n`;
  }

  let ttvModelTable = 'TTV MODELS (tokens per second):\n';
  for (const [id, info] of Object.entries(ttvCosts)) {
    ttvModelTable += `  ${id} (${info.name}): ${info.tokensPerSec.toLocaleString()} tok/sec, default ${info.defaultDuration}s clips\n`;
  }

  let itvModelTable = 'ITV MODELS (tokens per second):\n';
  for (const [id, info] of Object.entries(itvCosts)) {
    itvModelTable += `  ${id} (${info.name}): ${info.tokensPerSec.toLocaleString()} tok/sec, default ${info.defaultDuration}s clips\n`;
  }

  let voiceTable = 'VOICE TIERS (priority: premium > clone > apex):\n\n';

  // Premium voices — filter by language for prompt clarity
  const premiumLanguages = new Set(VOICE_OPTIONS.premium.map(v => v.language));
  voiceTable += 'PREMIUM VOICES (Inworld TTS — highest quality, use these first):\n';
  for (const lang of premiumLanguages) {
    const langVoices = VOICE_OPTIONS.premium.filter(v => v.language === lang);
    voiceTable += `  [${lang.toUpperCase()}]:\n`;
    for (const v of langVoices) {
      voiceTable += `    ${v.name} (${v.gender}): ${v.description}\n`;
    }
  }

  voiceTable += '\nCLONE VOICES (custom character voices — English-native, but can narrate in any language):\n';
  for (const v of VOICE_OPTIONS.clone) {
    voiceTable += `  ${v.name}: ${v.description}\n`;
  }

  voiceTable += '\nAPEX VOICES (Speechify — fallback only, use when premium/clone are not a good fit):\n';
  for (const v of VOICE_OPTIONS.apex) {
    voiceTable += `  ${v.name} (${v.gender}): ${v.description}\n`;
  }

  let bgMusicTable = 'BACKGROUND MUSIC OPTIONS (use null if none fit):\n';
  for (const [name, desc] of Object.entries(BACKGROUND_MUSIC)) {
    bgMusicTable += `  "${name}": ${desc}\n`;
  }

  return `You are a video production planner for a YouTube video generation platform. Given a user's video idea, plan all the technical settings to produce the video within the token budget.

USER PROMPT: "${userPrompt}"
LANGUAGE: ${language}
RUNTIME: ${runtimeMinutes} minutes (${runtimeSeconds} seconds)
ESTIMATED WORD COUNT: ~${estimatedWordCount} words
TOKEN BUDGET: ${tokenBudget.toLocaleString()} tokens
USER TOKEN BALANCE: ${userTokenBalance.toLocaleString()} tokens
FIXED COSTS (audio + pipeline, excl. story): ~${(audioCost + PIPELINE_COSTS.DURATION_CALC + PIPELINE_COSTS.FINAL_VIDEO_BASE).toLocaleString()} tokens
STORY MODEL OPTIONS (for writing the story):
  sonnet (Claude Sonnet 4.6): ${sonnetMult}x token multiplier — higher quality writing, costs ~${storyCostSonnet.toLocaleString()} tokens
  deepseek (DeepSeek Chat): ${deepseekMult}x token multiplier — lower quality but much cheaper, costs ~${storyCostDeepseek.toLocaleString()} tokens
  Prefer sonnet when budget allows. Use deepseek only when the budget is too tight for sonnet.

PROMPT MODEL OPTIONS (for generating image/video prompts — separate from story model):
  sonnet: ${sonnetMult}x multiplier — higher quality visual prompts, better scene descriptions
  deepseek: ${deepseekMult}x multiplier — cheaper but lower quality prompts
  Prefer sonnet when budget allows. Downgrade prompt model BEFORE story model when budget is tight.

REMAINING BUDGET FOR VISUALS (with sonnet): ~${remainingBudgetSonnet.toLocaleString()} tokens
REMAINING BUDGET FOR VISUALS (with deepseek): ~${remainingBudgetDeepseek.toLocaleString()} tokens

${imageModelTable}
${ttvModelTable}
${itvModelTable}
${voiceTable}
${bgMusicTable}

VISUAL STYLE — YOU MUST ALWAYS AUTHOR A FRESH, STORY-SPECIFIC CUSTOM STYLE.
Do NOT pick one of the named presets below. The presets exist ONLY as worked examples that show the FORMAT, LENGTH, and LEVEL OF DETAIL a good style description should have. Always set image_style to "custom" and write the actual style text in master_prompt.visualStyle, fitted to this specific story's era, setting, mood, characters, and emotional tone.

A good custom style description (~3–6 sentences, ~60–120 words) MUST cover:
  • Format (always include "wide format" / cinematic aspect)
  • Medium / technique (oil painting, charcoal, cel animation, pixel art, photoreal render, ink wash, etc.)
  • Linework / brushwork / texture (rough vs. smooth, blended vs. crosshatched, etc.)
  • Color palette (specific colors and saturation level — name them, e.g. "deep navy, moonlit silver, soft cloud whites")
  • Lighting (directional, chiaroscuro, ambient, golden-hour, neon, etc.)
  • Mood / overall feeling (intimate, epic, haunted, playful, reverent, etc.)
  • Genre or era reference if applicable (e.g. "mid-20th-century horror comics", "late-Renaissance panel painting", "Studio Ghibli-era cel animation")

INSPIRATION EXAMPLES (do NOT pick these — write your own in the same shape):
${Object.entries(VISUAL_STYLES).map(([name, info]) => `  • [${name}] ${info.style}`).join('\n')}

CUSTOM STYLE GUIDANCE BY TONE (write the style yourself; these are starting points only):
  - Medieval / pre-Renaissance: lean into oil-painting medium, earthy palette, soft directional lighting, panel-painting composition.
  - Renaissance / Baroque: chiaroscuro, painterly precision, jewel-tones, candle-lit interiors.
  - East Asian themes: ink-and-wash brushwork, negative space, washed pigments, calligraphic linework.
  - Horror / dark fantasy: high-contrast, desaturated palette with one accent color, heavy shadow, raw textures.
  - Sci-fi / futuristic: neon palette, volumetric lighting, sharp digital linework, atmospheric haze.
  - Documentary / informational: clean editorial illustration, muted palette, flat lighting, infographic clarity.
  - Fairy tales / whimsical: storybook painting, soft pastels, glowing rim-light, painterly brushwork.
  - Modern realistic: photoreal render, naturalistic lighting, cinematic color grading, shallow depth of field.
  Whatever tone the story has, write a style description that is uniquely tailored to it — never copy a preset verbatim.

EFFECTS OPTIONS: ${EFFECTS_OPTIONS.join(', ')}
TRANSITION OPTIONS: none, dissolve

RULES YOU MUST FOLLOW:
1. The total estimated token cost MUST be within the token budget and the user's token balance. Your plan should use as much of the budget as possible while staying at least 10,000 tokens UNDER the budget. Aim for the sweet spot: (budget - 10,000) as your target.
2. Visual type priority: TTV > ITV > Image Generation. However, ONLY select TTV or ITV if the budget can afford a model at the grok-video tier (30,000+ tokens/sec for TTV) or equivalent ITV tier (seedance-1.5-pro at 34,800+ tokens/sec for ITV) or higher. If the budget can only afford cheaper models like seedance-1.0-pro-fast or seedance-1.0-fast, use Image Generation instead. Do NOT select low-tier video models.${requestedVisualType ? `
   USER REQUESTED VISUAL TYPE: "${requestedVisualType}". You MUST use this visual type regardless of budget. Select the most expensive ${requestedVisualType.toUpperCase()} model that fits within the budget. If even the cheapest ${requestedVisualType.toUpperCase()} model doesn't fit, still select it — the system will handle downgrading. The quality-tier restriction above does NOT apply when the user explicitly requested a visual type.` : ''}
3. For the chosen visual type, select the MOST EXPENSIVE model the budget can afford. Maximize quality within the budget. For TTV, try the highest-tier model first and work down. For ITV, same approach. For image generation, use the highest-quality image model affordable.
4. For image generation: always use variable frequency with first_page_frequency <= 10 seconds.
4. rest_frequency baseline: slow contemplative = 25-40s, fast-paced = 12-20s, average = 18-25s. HOWEVER you may stretch rest_frequency UP TO 120 seconds when the budget is tight, in order to keep a higher-quality image model (especially grok-imagine-image, which we treat as the preferred floor option). Spacing images further apart is preferable to downgrading the image model below grok. Use higher rest_frequency (60-120s) for documentaries, informational content, and long-form narration where fewer images are acceptable. Use the lower end (12-25s) only when the budget can clearly afford it.
4b. IMAGE MODEL FLOOR: when the visual_type is 'image', prefer grok-imagine-image as the lowest acceptable model. Try in this order: (a) the most expensive model the budget affords at the planned rest_frequency, (b) grok-imagine-image at a higher rest_frequency (up to 120s) if a more expensive model doesn't fit, (c) only fall through to imagen-4-fast / flux-2-dev if grok at rest_frequency=120 still doesn't fit. The goal is: keep grok or better whenever possible, even if it means fewer images per minute.
5. Animation for image generation is ALWAYS "horizontal_drift". For TTV/ITV it is ALWAYS "none".
6. Transitions: use "dissolve" if budget allows the extra cost, otherwise "none".
7. Voice selection: consider BOTH premium and clone voices equally — pick whichever voice's description best matches the story's tone, genre, and mood. Clone voices often have unique character qualities (dark narrator, relaxed documentary style, etc.) that can be a better fit than premium voices. For non-English content, you MUST use a premium voice matching the story language (clone voices are English-native only). Use apex voices only as a last resort. Read each voice description carefully and pick the one whose tone and style best match the story content and genre. Clone voices are all male. Use traditional gender standards for narrator matching (male narrator for male-perspective stories, female for female-perspective, etc.).
8. Background music: only select one if it genuinely fits the story. Use null if nothing fits well.
9. Effects: pick one that fits the story (film_grain for vintage/noir, snow for winter, fire_flare for dramatic, light_sparkle for magical, none if nothing fits).
10. Environment-only mode: set to true for documentaries, nature content, historical overviews, or anything without a first-person perspective narrative. Set to false for character-driven stories.
11. Content type: classify the content as one of: "story" (creative fiction, narratives), "documentary" (factual accounts of real events/people/history), "informational" (educational content, explainers, tutorials), or "commentary" (opinion pieces, reviews, analysis). This determines how the writing AI generates the script — non-story types use a single third-person narrator voice for TTS. When content_type is "documentary", "informational", or "commentary", environment_only MUST be true.
12. Master prompt: create a detailed visual style description, setting, atmosphere, and characters (if environment_only is false).
12. story_title: create a compelling title based on the user's prompt.
13. description: write a 1-2 sentence narrative synopsis of the story or documentary. Describe what happens or what is explored — do NOT mention structure, chapters, formatting, or technical details.
14. Characters: if not environment_only, create character descriptions with name and appearance/personality description.
15. story_model: choose "sonnet" for higher quality writing when the budget allows, or "deepseek" when the budget is tight. Prefer sonnet.
17. prompt_model: choose "sonnet" for higher quality image/video prompts when the budget allows, or "deepseek" when tight. When the total cost is over budget, downgrade prompt_model FIRST (before story_model). Prefer sonnet.
16. The user's prompt describes a story concept or documentary topic — NOT a script structure. Interpret it as a creative idea about WHAT the story is about, not HOW it should be structured. The AI handles all structure decisions.

BUDGET CALCULATION GUIDE:
- For image gen: (num_images × image_model_cost) + overhead
  - num_images ≈ ceil(3000 / (first_freq × 13.67)) + ceil((total_chars - 3000) / (rest_freq × 13.67)) × 1.18
- For TTV: ceil(runtime_seconds / clip_duration) × clip_duration × tokens_per_sec
- For ITV: same as TTV but also add image generation for keyframes

Respond with ONLY a JSON object, no other text:
{
  "story_title": "string",
  "description": "string",
  "visual_type": "image" | "ttv" | "itv",
  "image_model": "model_id or null",
  "image_style": "custom",  // REQUIRED to be "custom" for visual_type=image; the actual style text goes in master_prompt.visualStyle
  "video_model": "model_id or null (for TTV)",
  "video_duration": "PER-CLIP seconds for TTV — must match the chosen model's allowed durations. seedance-1.0-pro-fast: 2-12 (any); ltx-2.3-fast: 6|10|16; grok-video: 2-15 (any); seedance-1.5-pro: 4-12 (any); veo-3.1-fast: 4|6|8; ltx-2.3-pro: 6|8|10; veo-3.1: 4|6|8; sora-2-pro / sora-2-pro-highres: 4|8|12. NEVER set this to total runtime.",
  "itv_model": "model_id or null (for ITV)",
  "itv_duration": "PER-CLIP seconds for ITV — must match the chosen model's allowed durations. wan-2.2: 5.06 (fixed); seedance-1.0-fast: 2-12 (any); hailuo-2.3-fast: 6|10; seedance-1.5-pro: 4-12 (any); ltx-2.3-fast: 6|8|10; veo-3.1-fast: 4|6|8; ltx-2.3-pro: 6|8|10; veo-3.1: 4|6|8; ltx-2.3-pro-4k: 6|8|10. NEVER set this to total runtime.",
  "voice_type": "premium" | "clone" | "apex",
  "voice_name": "voice name",
  "first_page_frequency": "number (seconds, for image gen)",
  "rest_frequency": "number (seconds, for image gen)",
  "transition_type": "dissolve" | null,
  "animation_type": "horizontal_drift" | "ken_burns" | "none",
  "effects_type": "effect_name" | null,
  "story_model": "sonnet" | "deepseek",
  "prompt_model": "sonnet" | "deepseek",
  "bg_music": "music name" | null,
  "environment_only": true | false,
  "content_type": "story" | "documentary" | "informational" | "commentary",
  "master_prompt": {
    "visualStyle": "detailed visual style description for the story",
    "setting": "detailed setting and time period",
    "atmosphere": "mood and atmosphere description",
    "characters": [{"name": "string", "description": "string"}]
  }
}${transcriptContext ? `

--- YOUTUBE INSPIRATION TRANSCRIPTS ---
The user provided YouTube videos as creative inspiration. Use these transcripts to understand the tone, subject matter, and style they want. Your story_title, description, master_prompt, voice selection, bg_music, effects, and image_style should all reflect the themes and mood of these source videos.

${transcriptContext}
--- END TRANSCRIPTS ---` : ''}`;
}

// ─── Background Music URL Mapping ────────────────────────────────────────────

const BG_MUSIC_URLS: Record<string, string> = {
  'A Baroque Letter': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/A%20Baroque%20Letter.mp3',
  'Wander Into': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Wander%20Into.mp3',
  'Rain On Rooftop': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Rain%20On%20Rooftop.mp3',
  'Daytime Forrest Bonfire': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Daytime%20Forrest%20Bonfire.mp3',
  'A Minor Waltz': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/A%20Minor%20Waltz.mp3',
  'Anton': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Anton.mp3',
  'Bourree': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Bourree.mp3',
  'Castle Ball': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Castle%20Ball.mp3',
  'E Minor Prelude': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/E%20Minor%20Prelude.mp3',
  'Funeral March': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Funeral%20March.mp3',
  'Jesus': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Jesus.mp3',
  'Moonlight Sonata': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Moonlight%20Sonata.mp3',
  'Remembering Her': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Remembering%20Her.mp3',
  'The First Noel': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/The%20First%20Noel.mp3',
  'Waltz of the Flowers': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Waltz%20of%20the%20Flowers.mp3',
  'Dreaming in 432Hz': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Dreaming%20in%20432Hz.mp3',
  'Delta Waves': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Delta%20Waves.mp3',
  'Colony': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Colony.mp3',
};

// ─── Main Handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed. Use POST.' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get('Authorization');
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!authToken) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
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
        return new Response(
          JSON.stringify({ error: 'Invalid or expired token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      _authenticatedUserId = _authUser.id;
    }

    const _reqBody = await req.json();

    // When JWT auth is used, override body user_id with authenticated user
    if (_authenticatedUserId && _reqBody.user_id) {
      _reqBody.user_id = _authenticatedUserId;
    }

    const {
      user_id,
      prompt,
      token_budget,
      runtime_minutes,
      language = 'english',
      tab = 1,
      visual_type: requestedVisualType,
      youtube_links,
      group_id: frontendGroupId,
      video_task_id,
      subtitles,
    } = _reqBody;

    // Validate required fields
    if (!user_id || !prompt || !token_budget || !runtime_minutes) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: user_id, prompt, token_budget, runtime_minutes' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (runtime_minutes < 0.5 || runtime_minutes > 1200) {
      return new Response(
        JSON.stringify({ error: 'Runtime must be between 0.5 and 1200 minutes' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get user's token balance from user_plans
    const { data: planData, error: planError } = await supabase
      .from('user_plans')
      .select('tokens_used, plan_type, rollover_tokens, is_legacy_plan')
      .eq('user_id', user_id)
      .maybeSingle();

    if (planError || !planData) {
      console.error('[plan-video] Token balance error:', planError?.message || 'No user_plans row found', 'user_id:', user_id);
      return new Response(
        JSON.stringify({ error: 'Could not fetch user token balance' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const planType = planData.plan_type ?? 'free';
    // Default to TRUE (legacy pricing) when the column is missing/null — protects existing customers.
    const isLegacyPlan = (planData as { is_legacy_plan?: boolean }).is_legacy_plan !== false;
    const planMaxMap = isLegacyPlan ? PLAN_MAX_TOKENS : NEW_PLAN_MAX_TOKENS;
    const planMax = planMaxMap[planType] ?? 400000;
    const rolloverTokens = planData.rollover_tokens ?? 0;
    const userTokenBalance = Math.max(0, planMax + rolloverTokens - (planData.tokens_used ?? 0));
    const effectiveBudget = Math.min(token_budget, userTokenBalance);
    const planMultipliers = pickStoryMultipliers(isLegacyPlan);
    // Plan-specific cost tables for image / TTV / ITV models. Schema is
    // identical across legacy and new — only token prices differ.
    const imageCosts = pickImageCosts(isLegacyPlan);
    const ttvCosts = pickTtvCosts(isLegacyPlan);
    const itvCosts = pickItvCosts(isLegacyPlan);
    // Convenience closure so every estimateTokenCost call below uses the
    // user's pricing tier without having to thread params through 14+ sites.
    const estimate = (s: PlannedSettings) =>
      estimateTokenCost(s, runtime_minutes, planMultipliers, imageCosts, ttvCosts, itvCosts);

    if (effectiveBudget < 50000) {
      const errorMsg = userTokenBalance < 50000
        ? `Your token balance is too low (${userTokenBalance.toLocaleString()} tokens remaining). Minimum ~50,000 tokens required to start a video.`
        : 'Token budget is too low. Minimum ~50,000 tokens required.';
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[plan-video] User ${user_id}, prompt: "${prompt.slice(0, 100)}...", budget: ${effectiveBudget}, runtime: ${runtime_minutes}min`);

    // ── Fetch YouTube transcripts early (before AI planning) ───────────────

    let transcriptText = '';
    if (youtube_links?.length) {
      const { combinedText } = await fetchYouTubeTranscripts(youtube_links);
      transcriptText = combinedText;
      if (transcriptText) {
        console.log(`[plan-video] Transcript context: ${transcriptText.length} chars from ${youtube_links.length} video(s)`);
      } else {
        console.log('[plan-video] No transcript text retrieved, proceeding without');
      }
    }

    // ── Insert placeholder video_tasks row immediately so polling picks it up ──

    const groupId = frontendGroupId || crypto.randomUUID();
    const placeholderVideoTaskId = video_task_id || crypto.randomUUID();

    try {
      const { error: insertError } = await supabase.from('video_tasks').insert({
        id: placeholderVideoTaskId,
        user_id,
        group_id: groupId,
        tab,
        story_title: 'Quick Generate Video',
        description: prompt,  // Use user prompt as placeholder description
        overall_status: 'planning',
        overall_progress: 0,
        story_status: 'pending',
        image_prompt_status: 'pending',
        image_generation_status: 'pending',
        audio_status: 'pending',
        video_creation_status: 'pending',
        individual_video_status: 'pending',
        ttv_prompt_status: 'pending',
        ttv_status: 'pending',
        itv_prompt_status: 'pending',
        itv_status: 'pending',
        generation_mode: 'quick',
        user_prompt: prompt,
        token_budget,
        visual_type: requestedVisualType || 'image',
        settings: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (insertError) {
        console.error(`[plan-video] Failed to insert placeholder row: ${insertError.message}`, insertError);
      } else {
        console.log(`[plan-video] Inserted placeholder video_tasks row: ${placeholderVideoTaskId}`);
      }
    } catch (err: any) {
      console.warn(`[plan-video] Exception inserting placeholder row: ${err.message}`);
    }

    // ── Call DeepSeek to plan settings ──────────────────────────────────────

    const systemPrompt = buildPlanningPrompt(prompt, effectiveBudget, runtime_minutes, language, userTokenBalance, requestedVisualType, transcriptText || undefined, planMultipliers, imageCosts, ttvCosts, itvCosts);

    const response = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Plan the video settings for: ${prompt}` },
      ],
      temperature: 0.5,
      max_tokens: 3000,
    });

    const responseText = response.choices[0]?.message?.content || '';
    console.log('[plan-video] DeepSeek response received');

    // Parse JSON
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to extract JSON from DeepSeek response');
    }

    const planned = JSON.parse(jsonMatch[0]);

    // ── Validate and sanitize planned settings ─────────────────────────────

    // Ensure visual_type is valid
    if (!['image', 'ttv', 'itv', 'mg'].includes(planned.visual_type)) {
      planned.visual_type = 'image';
    }

    // Override with user-requested visual type if provided
    if (requestedVisualType && ['image', 'ttv', 'itv', 'mg'].includes(requestedVisualType)) {
      planned.visual_type = requestedVisualType;
    }

    // Validate image model
    if (planned.visual_type === 'image' && !imageCosts[planned.image_model]) {
      planned.image_model = 'imagen-4-fast';
    }

    // Validate TTV model
    if (planned.visual_type === 'ttv' && !ttvCosts[planned.video_model]) {
      planned.video_model = 'ltx-2.3-fast';
    }

    // Validate ITV model
    if (planned.visual_type === 'itv' && !itvCosts[planned.itv_model]) {
      planned.itv_model = 'seedance-1.0-fast';
    }

    // Enforce defaults
    if (planned.visual_type === 'image') {
      planned.animation_type = 'horizontal_drift';
    } else {
      planned.animation_type = 'none';
    }

    // Clamp first_page_frequency to <= 10s (intro pacing rule)
    if (!planned.first_page_frequency || planned.first_page_frequency > 10) {
      planned.first_page_frequency = 8;
    }
    // Clamp rest_frequency to [10, 120]. Higher rest_freq is the lever the
    // planner uses to fit cheaper image models (especially grok) into tight
    // budgets without forcing a downgrade to a worse model.
    if (!planned.rest_frequency || planned.rest_frequency < 10) {
      planned.rest_frequency = 20;
    }
    if (planned.rest_frequency > 120) {
      planned.rest_frequency = 120;
    }

    // Validate voice
    let voiceType: 'premium' | 'clone' | 'apex' = 'premium';
    let voiceName = planned.voice_name;
    let voiceId: string | undefined;

    if (planned.voice_type === 'clone') {
      voiceType = 'clone';
      const cloneVoice = VOICE_OPTIONS.clone.find(v => v.name.toLowerCase() === voiceName?.toLowerCase());
      if (cloneVoice) {
        voiceName = cloneVoice.name;
        voiceId = cloneVoice.id;
      } else {
        voiceName = 'Declan';
        voiceId = VOICE_OPTIONS.clone[0].id;
      }
    } else if (planned.voice_type === 'apex') {
      voiceType = 'apex';
      const apexVoice = VOICE_OPTIONS.apex.find(v => v.name.toLowerCase() === voiceName?.toLowerCase());
      if (apexVoice) {
        voiceName = apexVoice.name;
      } else {
        voiceName = 'oliver';
      }
    } else {
      // Premium (default / preferred)
      voiceType = 'premium';
      const premiumVoice = VOICE_OPTIONS.premium.find(v => v.name.toLowerCase() === voiceName?.toLowerCase());
      if (premiumVoice) {
        voiceName = premiumVoice.name;
      } else {
        // Fallback: pick a suitable English premium voice
        voiceName = 'Graham';
      }
    }

    // Validate effects
    if (planned.effects_type && !EFFECTS_OPTIONS.includes(planned.effects_type)) {
      planned.effects_type = null;
    }

    // Validate story model
    const storyModel: 'sonnet' | 'deepseek' = (planned.story_model === 'deepseek') ? 'deepseek' : 'sonnet';
    // Validate prompt model (defaults to same as story model)
    const promptModel: 'sonnet' | 'deepseek' = (planned.prompt_model === 'deepseek') ? 'deepseek' : 'sonnet';

    // Resolve image_style — we now ALWAYS author a custom story-specific style.
    // If the LLM ignored the instruction and picked a named preset, fall back to
    // that preset's text so the run still works, but log a warning so we can
    // catch prompt regressions. The preferred path is image_style === 'custom'
    // with master_prompt.visualStyle authored fresh by the LLM.
    function resolveImageStyle(styleName: string | undefined | null, masterPromptVisualStyle?: string): string | undefined {
      // Preferred path: custom + LLM-authored visualStyle
      if (masterPromptVisualStyle && masterPromptVisualStyle.trim().length > 30) {
        return masterPromptVisualStyle.trim();
      }
      // Fallback path: LLM disobeyed and picked a preset; resolve it.
      if (styleName && styleName !== 'custom') {
        const predefined = VISUAL_STYLES[styleName];
        if (predefined) {
          console.warn('[plan-video] LLM picked preset style instead of custom:', styleName);
          return predefined.style;
        }
        if (styleName.length > 50) return styleName; // already-expanded text
      }
      // Last-ditch fallback
      console.warn('[plan-video] No usable visualStyle from LLM; falling back to Realistic Animation preset');
      return VISUAL_STYLES['Realistic Animation']?.style || 'Cinematic realistic, wide format';
    }

    // Force image_style to 'custom' for downstream consumers regardless of what
    // the LLM emitted — the actual style text always lives in resolveImageStyle's
    // return value (and gets persisted as master_prompt.visualStyle below).
    if (planned.visual_type === 'image') {
      planned.image_style = 'custom';
    }

    // Compute the resolved visual style ONCE so both image_style (full text)
    // and master_prompt.visualStyle stay in lock-step.
    const resolvedVisualStyle = planned.visual_type === 'image'
      ? resolveImageStyle(planned.image_style, planned.master_prompt?.visualStyle)
      : undefined;

    // Build the final planned settings
    const finalSettings: PlannedSettings = {
      story_title: planned.story_title || 'Untitled Video',
      description: planned.description || '',
      word_count: Math.round((runtime_minutes * 60 / SPEECH_SPEED) * WORDS_PER_SECOND),
      language,
      visual_type: planned.visual_type,
      image_model: planned.visual_type === 'image' ? planned.image_model : (planned.visual_type === 'itv' ? (planned.image_model || 'imagen-4-fast') : undefined),
      image_style: resolvedVisualStyle,
      video_model: planned.visual_type === 'ttv' ? planned.video_model : undefined,
      video_duration: planned.visual_type === 'ttv'
        ? clampClipDuration(planned.video_model, planned.video_duration, 'ttv')
        : undefined,
      itv_model: planned.visual_type === 'itv' ? planned.itv_model : undefined,
      itv_duration: planned.visual_type === 'itv'
        ? clampClipDuration(planned.itv_model, planned.itv_duration, 'itv')
        : undefined,
      mg_style_slug: planned.visual_type === 'mg' ? (planned.mg_style_slug || 'cinematic_dark') : undefined,
      mg_style_guidance: planned.visual_type === 'mg' ? (planned.mg_style_guidance ?? null) : undefined,
      mg_clip_duration: planned.visual_type === 'mg' ? (planned.mg_clip_duration || MG_DEFAULT_CLIP_SECONDS) : undefined,
      mg_codegen_model: planned.visual_type === 'mg'
        ? (planned.mg_codegen_model === 'claude-sonnet-4-6' ? 'claude-sonnet-4-6' : 'claude-opus-4-6')
        : undefined,
      voice_type: voiceType,
      voice_name: voiceName,
      voice_id: voiceId,
      first_page_frequency: planned.first_page_frequency,
      rest_frequency: planned.rest_frequency,
      master_prompt: {
        visualStyle: resolvedVisualStyle || planned.master_prompt?.visualStyle || 'Cinematic realistic',
        setting: planned.master_prompt?.setting || '',
        atmosphere: planned.master_prompt?.atmosphere || '',
        environmentOnly: planned.environment_only ?? false,
        characters: (!planned.environment_only && planned.master_prompt?.characters) || [],
        contentType: planned.content_type || (planned.environment_only ? 'documentary' : 'story'),
      },
      transition_type: planned.transition_type || null,
      animation_type: planned.animation_type,
      effects_type: planned.effects_type || null,
      bg_music: planned.bg_music || null,
      bg_music_key: planned.bg_music || undefined,
      story_model: storyModel,
      prompt_model: promptModel,
    };

    // Force sonnet for story model if word count exceeds DeepSeek's 50K word limit
    const DEEPSEEK_MAX_WORDS = 50000;
    if (finalSettings.word_count > DEEPSEEK_MAX_WORDS && finalSettings.story_model === 'deepseek') {
      finalSettings.story_model = 'sonnet';
      console.log(`[plan-video] Word count ${finalSettings.word_count} exceeds DeepSeek limit (${DEEPSEEK_MAX_WORDS}), forced story_model to sonnet`);
    }

    // ── Estimate tokens ────────────────────────────────────────────────────

    const estimatedTokens = estimate(finalSettings);

    // Check if within budget — iterative downgrade loop
    if (estimatedTokens > effectiveBudget) {
      console.log(`[plan-video] Over budget: ${estimatedTokens} > ${effectiveBudget}, attempting downgrades`);

      // Downgrade steps in priority order (cheapest impact first):
      // 1. Prompt model: sonnet → deepseek (reduces prompt generation cost)
      // 2. Story model: sonnet → deepseek (reduces story generation cost)
      // 3. Remove transitions
      // 4. Downgrade visual type (ttv/itv → image)
      // 5. Downgrade image model to cheapest
      // 6. Increase rest_frequency (fewer images)
      const downgradeSteps: Array<{ name: string; apply: () => boolean }> = [
        {
          name: 'prompt model to deepseek',
          apply: () => {
            if (finalSettings.prompt_model === 'sonnet') {
              finalSettings.prompt_model = 'deepseek';
              return true;
            }
            return false;
          },
        },
        {
          name: 'story model to deepseek',
          apply: () => {
            if (finalSettings.story_model === 'sonnet' && finalSettings.word_count <= DEEPSEEK_MAX_WORDS) {
              finalSettings.story_model = 'deepseek';
              return true;
            }
            return false;
          },
        },
        {
          name: 'remove transitions',
          apply: () => {
            if (finalSettings.transition_type) {
              finalSettings.transition_type = null;
              return true;
            }
            return false;
          },
        },
        {
          name: 'downgrade TTV/ITV model',
          apply: () => {
            if (finalSettings.visual_type === 'ttv' && finalSettings.video_model) {
              const ttvTiers = Object.keys(ttvCosts).sort(
                (a, b) => ttvCosts[b].tokensPerSec - ttvCosts[a].tokensPerSec
              );
              const currentIdx = ttvTiers.indexOf(finalSettings.video_model);
              if (currentIdx < ttvTiers.length - 1) {
                finalSettings.video_model = ttvTiers[currentIdx + 1];
                return true;
              }
            }
            if (finalSettings.visual_type === 'itv' && finalSettings.itv_model) {
              const itvTiers = Object.keys(itvCosts).sort(
                (a, b) => itvCosts[b].tokensPerSec - itvCosts[a].tokensPerSec
              );
              const currentIdx = itvTiers.indexOf(finalSettings.itv_model);
              if (currentIdx < itvTiers.length - 1) {
                finalSettings.itv_model = itvTiers[currentIdx + 1];
                return true;
              }
            }
            return false;
          },
        },
        {
          name: 'downgrade to image generation',
          apply: () => {
            if (finalSettings.visual_type === 'ttv' || finalSettings.visual_type === 'itv') {
              finalSettings.visual_type = 'image';
              finalSettings.video_model = undefined;
              finalSettings.video_duration = undefined;
              finalSettings.itv_model = undefined;
              finalSettings.itv_duration = undefined;
              finalSettings.image_model = 'imagen-4-fast';
              finalSettings.image_style = resolveImageStyle(
                planned.image_style || (planned.master_prompt?.visualStyle ? 'custom' : 'Realistic Animation'),
                planned.master_prompt?.visualStyle
              );
              finalSettings.animation_type = 'horizontal_drift';
              return true;
            }
            return false;
          },
        },
        {
          name: 'downgrade image model to cheapest',
          apply: () => {
            if (finalSettings.visual_type === 'image' && finalSettings.image_model !== 'imagen-4-fast') {
              finalSettings.image_model = 'imagen-4-fast';
              return true;
            }
            return false;
          },
        },
        {
          name: 'increase rest_frequency',
          apply: () => {
            if (finalSettings.rest_frequency < 60) {
              finalSettings.rest_frequency = Math.min(60, finalSettings.rest_frequency + 10);
              return true;
            }
            return false;
          },
        },
      ];

      for (const step of downgradeSteps) {
        if (estimate(finalSettings) <= effectiveBudget) break;
        // For TTV/ITV model downgrade, keep applying until cheapest model reached
        if (step.name === 'downgrade TTV/ITV model') {
          let applied = false;
          while (estimate(finalSettings) > effectiveBudget) {
            if (step.apply()) {
              console.log(`[plan-video] Downgraded: ${step.name} to ${finalSettings.video_model || finalSettings.itv_model}`);
              applied = true;
            } else {
              break;
            }
          }
          if (applied) continue;
        } else {
          if (step.apply()) {
            console.log(`[plan-video] Downgraded: ${step.name}`);
          }
        }
      }

      const revisedTokens = estimate(finalSettings);
      if (revisedTokens > effectiveBudget) {
        return new Response(
          JSON.stringify({
            error: `Estimated cost (${revisedTokens.toLocaleString()} tokens) exceeds your budget (${effectiveBudget.toLocaleString()} tokens). Try a shorter runtime or higher budget.`,
            estimated_tokens: revisedTokens,
            budget: effectiveBudget,
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ── Upgrade loop: try to use as much budget as possible (target: budget - 10k) ──
    const TARGET_HEADROOM = 10_000;
    const targetMax = effectiveBudget - TARGET_HEADROOM;
    let finalEstimate = estimate(finalSettings);
    const budgetGap = targetMax - finalEstimate;

    if (budgetGap > 20_000) {
      console.log(`[plan-video] Budget gap: ${budgetGap.toLocaleString()}, attempting upgrades`);

      // Upgrade priority order:
      // 1. Prompt model: deepseek -> sonnet
      if (finalSettings.prompt_model === 'deepseek') {
        const testSettings = { ...finalSettings, prompt_model: 'sonnet' as const };
        const testCost = estimate(testSettings);
        if (testCost <= targetMax) {
          finalSettings.prompt_model = 'sonnet';
          finalEstimate = testCost;
          console.log('[plan-video] Upgraded prompt model to sonnet');
        }
      }

      // 2. Story model: deepseek -> sonnet
      if (finalSettings.story_model === 'deepseek') {
        const testSettings = { ...finalSettings, story_model: 'sonnet' as const };
        const testCost = estimate(testSettings);
        if (testCost <= targetMax) {
          finalSettings.story_model = 'sonnet';
          finalEstimate = testCost;
          console.log('[plan-video] Upgraded story model to sonnet');
        }
      }

      // 3. Add transitions if none
      if (!finalSettings.transition_type) {
        const testSettings = { ...finalSettings, transition_type: 'dissolve' };
        const testCost = estimate(testSettings);
        if (testCost <= targetMax) {
          finalSettings.transition_type = 'dissolve';
          finalEstimate = testCost;
          console.log('[plan-video] Added dissolve transitions');
        }
      }

      // 4. If user requested TTV/ITV but we downgraded to image, try upgrading back
      if (requestedVisualType && requestedVisualType !== 'image' && finalSettings.visual_type === 'image') {
        if (requestedVisualType === 'ttv') {
          const ttvTiers = Object.keys(ttvCosts).sort(
            (a, b) => ttvCosts[a].tokensPerSec - ttvCosts[b].tokensPerSec
          );
          // Try cheapest TTV model first, then work up
          for (const model of ttvTiers) {
            const testSettings: PlannedSettings = {
              ...finalSettings,
              visual_type: 'ttv',
              video_model: model,
              video_duration: ttvCosts[model].defaultDuration,
              image_model: undefined,
              image_style: undefined,
              itv_model: undefined,
              itv_duration: undefined,
              animation_type: 'none',
            };
            const testCost = estimate(testSettings);
            if (testCost <= targetMax) {
              finalSettings.visual_type = 'ttv';
              finalSettings.video_model = model;
              finalSettings.video_duration = ttvCosts[model].defaultDuration;
              finalSettings.image_model = undefined;
              finalSettings.image_style = undefined;
              finalSettings.itv_model = undefined;
              finalSettings.itv_duration = undefined;
              finalSettings.animation_type = 'none';
              finalEstimate = testCost;
              console.log(`[plan-video] Upgraded back to TTV with model ${model}`);
              // Don't break — keep trying more expensive models
            } else {
              break;
            }
          }
        } else if (requestedVisualType === 'itv') {
          const itvTiers = Object.keys(itvCosts).sort(
            (a, b) => itvCosts[a].tokensPerSec - itvCosts[b].tokensPerSec
          );
          for (const model of itvTiers) {
            const testSettings: PlannedSettings = {
              ...finalSettings,
              visual_type: 'itv',
              itv_model: model,
              itv_duration: itvCosts[model].defaultDuration,
              image_model: planned.image_model || 'imagen-4-fast',
              video_model: undefined,
              video_duration: undefined,
              animation_type: 'none',
            };
            const testCost = estimate(testSettings);
            if (testCost <= targetMax) {
              finalSettings.visual_type = 'itv';
              finalSettings.itv_model = model;
              finalSettings.itv_duration = itvCosts[model].defaultDuration;
              finalSettings.image_model = planned.image_model || 'imagen-4-fast';
              finalSettings.video_model = undefined;
              finalSettings.video_duration = undefined;
              finalSettings.animation_type = 'none';
              finalEstimate = testCost;
              console.log(`[plan-video] Upgraded back to ITV with model ${model}`);
            } else {
              break;
            }
          }
        }
      }

      // 5. Upgrade image model (if image type) through tiers
      if (finalSettings.visual_type === 'image' && finalSettings.image_model) {
        const imageModelTiers = ['imagen-4-fast', 'grok-imagine-image', 'gpt-image-1-mini', 'seedream-4.5', 'imagen-4-ultra'];
        const currentIdx = imageModelTiers.indexOf(finalSettings.image_model);
        for (let i = currentIdx + 1; i < imageModelTiers.length; i++) {
          const testSettings = { ...finalSettings, image_model: imageModelTiers[i] };
          const testCost = estimate(testSettings);
          if (testCost <= targetMax) {
            finalSettings.image_model = imageModelTiers[i];
            finalEstimate = testCost;
            console.log(`[plan-video] Upgraded image model to ${imageModelTiers[i]}`);
          } else {
            break;
          }
        }
      }

      // 6. Upgrade TTV model through tiers (most expensive affordable)
      if (finalSettings.visual_type === 'ttv' && finalSettings.video_model) {
        const ttvModelTiers = Object.keys(ttvCosts).sort(
          (a, b) => ttvCosts[a].tokensPerSec - ttvCosts[b].tokensPerSec
        );
        const currentIdx = ttvModelTiers.indexOf(finalSettings.video_model);
        for (let i = currentIdx + 1; i < ttvModelTiers.length; i++) {
          const testSettings = { ...finalSettings, video_model: ttvModelTiers[i] };
          const testCost = estimate(testSettings);
          if (testCost <= targetMax) {
            finalSettings.video_model = ttvModelTiers[i];
            finalEstimate = testCost;
            console.log(`[plan-video] Upgraded TTV model to ${ttvModelTiers[i]}`);
          } else {
            break;
          }
        }
      }

      // 7. Upgrade ITV model through tiers (most expensive affordable)
      if (finalSettings.visual_type === 'itv' && finalSettings.itv_model) {
        const itvModelTiers = Object.keys(itvCosts).sort(
          (a, b) => itvCosts[a].tokensPerSec - itvCosts[b].tokensPerSec
        );
        const currentIdx = itvModelTiers.indexOf(finalSettings.itv_model);
        for (let i = currentIdx + 1; i < itvModelTiers.length; i++) {
          const testSettings = { ...finalSettings, itv_model: itvModelTiers[i] };
          const testCost = estimate(testSettings);
          if (testCost <= targetMax) {
            finalSettings.itv_model = itvModelTiers[i];
            finalEstimate = testCost;
            console.log(`[plan-video] Upgraded ITV model to ${itvModelTiers[i]}`);
          } else {
            break;
          }
        }
      }

      // 8. Decrease rest_frequency (more images) if image type and still room
      if (finalSettings.visual_type === 'image' && (targetMax - finalEstimate) > 20_000) {
        const minFreq = 12;
        while (finalSettings.rest_frequency > minFreq) {
          const newFreq = finalSettings.rest_frequency - 2;
          const testSettings = { ...finalSettings, rest_frequency: newFreq };
          const testCost = estimate(testSettings);
          if (testCost <= targetMax) {
            finalSettings.rest_frequency = newFreq;
            finalEstimate = testCost;
          } else {
            break;
          }
        }
      }

      console.log(`[plan-video] After upgrades: ${finalEstimate.toLocaleString()} tokens (target: ${targetMax.toLocaleString()})`);
    }

    // ── Build setup-video-tasks payload ─────────────────────────────────────

    // Resolve voice for backend
    let modelVersion: string;
    let backendVoice: string;
    let cloneVoiceName: string | undefined;
    let cloneVoiceUrl: string | undefined;
    let cloneLanguage: string | undefined;

    if (finalSettings.voice_type === 'clone') {
      modelVersion = 'clone';
      backendVoice = finalSettings.voice_name;
      cloneVoiceName = finalSettings.voice_name;
      cloneVoiceUrl = finalSettings.voice_id;
      cloneLanguage = 'english';
    } else if (finalSettings.voice_type === 'premium') {
      modelVersion = 'v7';
      backendVoice = finalSettings.voice_name;
    } else {
      modelVersion = 'speechify';
      backendVoice = finalSettings.voice_name;
    }

    // Resolve background music URL
    let bgMusicUrl: string | null = null;
    if (finalSettings.bg_music && BG_MUSIC_URLS[finalSettings.bg_music]) {
      bgMusicUrl = BG_MUSIC_URLS[finalSettings.bg_music];
    }

    // Map animation for backend
    const mapAnimation = (a: string) => {
      if (a === 'horizontal_drift' || a === 'drift') return 'drift';
      if (a === 'vertical') return 'vertical';
      if (a === 'ken_burns') return 'ken_burns';
      return 'none';
    };

    const setupPayload: Record<string, unknown> = {
      user_id,
      group_id: groupId,
      tab,
      video_task_id: placeholderVideoTaskId, // Forward the placeholder row ID so setup-video-tasks upserts it
      story_title: finalSettings.story_title,
      description: finalSettings.description,
      language: finalSettings.language,
      model: finalSettings.prompt_model, // image prompt model
      story_model: finalSettings.story_model,
      imagePromptModel: finalSettings.prompt_model,
      output_video_name: `${finalSettings.story_title}.mp4`,
      variant: 1,

      // Story
      use_existing_story: false,
      word_count: finalSettings.word_count,
      process_story: true,
      process_images: true,
      process_audio: true,
      video: true,

      // Visual type
      visual_type: finalSettings.visual_type,

      // Image gen settings
      image_model: finalSettings.image_model || null,
      image_style: finalSettings.image_style || null,
      use_character_descriptions: !finalSettings.master_prompt.environmentOnly,

      // TTV settings
      video_model: finalSettings.video_model ? (TTV_MODEL_ID_MAP[finalSettings.video_model] || finalSettings.video_model) : undefined,
      video_duration: finalSettings.video_duration || undefined,
      // audio_clip is a model-capability proxy (not pricing): which TTV models
      // ship with native audio. Pinned to LEGACY cost table so the >=30k
      // tokensPerSec threshold catches the same set of models on every plan.
      audio_clip: finalSettings.visual_type === 'ttv' && finalSettings.video_model ? (TTV_MODEL_COSTS[finalSettings.video_model]?.tokensPerSec ?? 0) >= 30000 : false,
      process_ttv: finalSettings.visual_type === 'ttv',

      // ITV settings
      itv_model: finalSettings.itv_model ? (ITV_MODEL_ID_MAP[finalSettings.itv_model] || finalSettings.itv_model) : undefined,
      itv_duration: finalSettings.itv_duration || undefined,
      process_itv: finalSettings.visual_type === 'itv',

      // Runtime mode
      is_runtime_mode: true,
      runtime_minutes,

      // Master prompt (always enhanced for quick mode)
      master_prompt: finalSettings.master_prompt,
      master_prompt_enhance_ai: false, // Already AI-generated in planning

      // Audio
      voice: backendVoice,
      model_version: modelVersion,
      speed: SPEECH_SPEED,
      volume: 1.0,
      preference: 'separate',
      remove_title_chapters: true,
      pauses: true,
      use_existing_audio: false,

      // Clone fields
      ...(modelVersion === 'clone' ? {
        clone_voice_name: cloneVoiceName,
        clone_voice_url: cloneVoiceUrl,
        clone_language: cloneLanguage,
      } : {}),

      // Background music
      bg_music: bgMusicUrl,
      bg_music_volume: 0.8,

      // Video loop (none for quick mode)
      video_loop: null,
      loop_time: null,

      // Transitions, animation, effects
      transition_type: finalSettings.transition_type,
      animation_type: mapAnimation(finalSettings.animation_type),
      effects_type: finalSettings.effects_type,

      // Frequency
      frequency_mode: 'wordcount',
      frequency_type: 'variable',
      consistent_frequency: null,
      first_page_frequency: finalSettings.first_page_frequency,
      rest_frequency: finalSettings.rest_frequency,
      audio_distribution_type: 'consistent',
      first_page_image_amount: null,
      rest_image_amount: null,
      image_amount: null,
      audio_files: null,

      // Quick generate metadata
      generation_mode: 'quick',
      user_prompt: prompt,
      token_budget,

      // YouTube inspiration links and pre-fetched transcript text
      ...(youtube_links?.length ? { youtube_links } : {}),
      ...(transcriptText ? { youtube_transcript_text: transcriptText } : {}),

      // Optional subtitle burn-in config (null/undefined = no subtitles)
      ...(subtitles ? { subtitles } : {}),
    };

    console.log(`[plan-video] Calling setup-video-tasks with group_id=${groupId}, estimated=${finalEstimate}`);

    // ── Call setup-video-tasks ──────────────────────────────────────────────

    const setupResponse = await fetch(SETUP_VIDEO_TASKS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SECRET_KEY,
      },
      body: JSON.stringify(setupPayload),
    });

    if (!setupResponse.ok) {
      const errorData = await setupResponse.json().catch(() => ({}));
      console.error(`[plan-video] setup-video-tasks failed:`, errorData);
      throw new Error(errorData.error || `setup-video-tasks failed with HTTP ${setupResponse.status}`);
    }

    const setupResult = await setupResponse.json();
    console.log(`[plan-video] setup-video-tasks success:`, setupResult);

    // ── Update video_tasks row with quick generate metadata ────────────────

    await supabase
      .from('video_tasks')
      .update({
        generation_mode: 'quick',
        ai_planning_status: 'completed',
        ai_planned_settings: finalSettings,
        user_prompt: prompt,
        token_budget,
      })
      .eq('group_id', groupId);

    // ── Return success ─────────────────────────────────────────────────────

    return new Response(
      JSON.stringify({
        success: true,
        group_id: groupId,
        estimated_tokens: finalEstimate,
        budget: effectiveBudget,
        planned_settings: {
          story_title: finalSettings.story_title,
          description: finalSettings.description,
          visual_type: finalSettings.visual_type,
          image_model: finalSettings.image_model,
          image_style: finalSettings.image_style,
          video_model: finalSettings.video_model,
          itv_model: finalSettings.itv_model,
          voice_type: finalSettings.voice_type,
          voice_name: finalSettings.voice_name,
          transition_type: finalSettings.transition_type,
          effects_type: finalSettings.effects_type,
          bg_music: finalSettings.bg_music,
          environment_only: finalSettings.master_prompt.environmentOnly,
          first_page_frequency: finalSettings.first_page_frequency,
          rest_frequency: finalSettings.rest_frequency,
          story_model: finalSettings.story_model,
          prompt_model: finalSettings.prompt_model,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[plan-video] Error:', message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
