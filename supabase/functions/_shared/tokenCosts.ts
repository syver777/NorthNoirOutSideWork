// _shared/tokenCosts.ts
// ─────────────────────────────────────────────────────────────────────────────
// Plan-restructure dual token-cost map.
//
// Every user_plans row has an `is_legacy_plan` boolean:
//   • TRUE  → use the LEGACY_* maps below (current production rates,
//             grandfathered for early adopters).
//   • FALSE → use the NEW_* maps below (calibrated for ≥40% margin at
//             the new $2/M revenue tier — see margin plan.txt).
//
// ALL token-billing edge functions must look the user up via
// `getIsLegacyPlan(userId)` before computing tokens. Helper functions
// below pick the right map per resource (TTV, ITV, image).
//
// Audio variants (TTV/ITV with audio_clip=true):
//   - LEGACY values match the historical 2× / 1.5× / 2× ratios that
//     have been in production.
//   - NEW values are derived from the audio-on provider cost
//     (cost_per_s × 833,334 for 40% margin at $2/M):
//       • TTV/ITV seedance15(_pro) audio:  $0.117/s → 100,000 t/s
//       • TTV/ITV veo31fast       audio:  $0.150/s → 125,000 t/s
//       • TTV/ITV veo31           audio:  $0.400/s → 334,000 t/s
//
// The shape of LEGACY and NEW is identical (same keys) so call sites
// can resolve once and stay branchless after that.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from 'npm:@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SECRET_KEY') || Deno.env.get('SECRET_KEY') || '';

// Lazily constructed service-role client used only for plan lookups.
// Each consumer already has its own client; this one exists so call
// sites that don't want to pass a client can still resolve the flag.
let _planClient: ReturnType<typeof createClient> | null = null;
function planClient() {
  if (!_planClient) _planClient = createClient(supabaseUrl, serviceRoleKey);
  return _planClient;
}

// ── TTV (text-to-video) — process-TTV / single-TTV / redo-TTV ───────────────

export const LEGACY_TTV_TOKENS_PER_SECOND: Record<string, number> = {
  seedance_pro_fast: 13200,
  ltx23_fast:        24000,
  grok:              30000,
  grok_highres:      42000,
  seedance15_pro:    34800,
  veo31fast:         60000,
  ltx23_pro:         72000,
  veo31:            120000,
  sora2pro:         180000,
  sora2pro_highres: 300000,
};

export const LEGACY_TTV_TOKENS_PER_SECOND_AUDIO: Record<string, number> = {
  seedance15_pro:  69600,
  veo31fast:       90000,
  veo31:          240000,
};

export const NEW_TTV_TOKENS_PER_SECOND: Record<string, number> = {
  seedance_pro_fast:  18000,
  ltx23_fast:         34000,
  grok:               42000,
  grok_highres:       59000,
  seedance15_pro:     49000,
  veo31fast:          84000,
  ltx23_pro:         134000,
  veo31:             167000,
  sora2pro:          250000,
  sora2pro_highres:  417000,
};

export const NEW_TTV_TOKENS_PER_SECOND_AUDIO: Record<string, number> = {
  seedance15_pro: 100000,
  veo31fast:      125000,
  veo31:          334000,
};

// ── ITV (image-to-video) — process-ITV / single-ITV / redo-ITV / single-image

export const LEGACY_ITV_TOKENS_PER_SECOND: Record<string, number> = {
  wan22:          6000,
  seedance1fast: 12960,
  hailuo23fast:  19200,
  seedance15:    34800,
  ltx23fast:     48000,
  veo31fast:     60000,
  ltx23pro:      72000,
  veo31:        120000,
  ltx23pro4k:   144000,
};

export const LEGACY_ITV_TOKENS_PER_SECOND_AUDIO: Record<string, number> = {
  seedance15: 70200,
  veo31fast:  90000,
  veo31:     240000,
};

export const NEW_ITV_TOKENS_PER_SECOND: Record<string, number> = {
  wan22:          9000,
  seedance1fast: 18000,
  hailuo23fast:  27000,
  seedance15:    49000,
  ltx23fast:    100000,
  veo31fast:     84000,
  ltx23pro:     100000,
  veo31:        167000,
  ltx23pro4k:   200000,
};

export const NEW_ITV_TOKENS_PER_SECOND_AUDIO: Record<string, number> = {
  seedance15: 100000,
  veo31fast:  125000,
  veo31:      334000,
};

// ── Image generation — generate-image ────────────────────────────────────────

export const LEGACY_IMAGE_TOKENS_PER_IMAGE: Record<string, number> = {
  'imagen-4-fast':       14000,
  'gpt-image-1-mini':    30000,
  'imagen-4-ultra':      42000,
  'flux-2-dev':           7000,
  'seedream-4.5':        35000,
  'nano-banana-pro':    100000,
  'grok-imagine-image':  16000,
};

export const NEW_IMAGE_TOKENS_PER_IMAGE: Record<string, number> = {
  'imagen-4-fast':       17000,
  'gpt-image-1-mini':    44000,
  'imagen-4-ultra':      50000,
  'flux-2-dev':          12000,  // North Noir Margin §9.8
  'seedream-4.5':        35000,  // already at 43% — leave unchanged
  'nano-banana-pro':    109000,
  'grok-imagine-image':  19000,
};

// ── LLM model multipliers (used by plan-video / video-analyze / etc.) ───────

export const LEGACY_LLM_MULTIPLIERS: Record<string, number> = {
  deepseek:  1.0,
  sonnet:   11.0,
  opus:     19.0,
};

export const NEW_LLM_MULTIPLIERS: Record<string, number> = {
  deepseek:  1.0,
  sonnet:   13.0,
  opus:     21.0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Plan-flag lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns TRUE when the user's active plan row is grandfathered onto the
 * legacy token cost map. Returns TRUE on lookup failure as the safe default
 * (we'd rather under-charge a new user than over-charge a legacy user).
 */
export async function getIsLegacyPlan(userId: string): Promise<boolean> {
  if (!userId) return true;
  try {
    const { data, error } = await planClient()
      .from('user_plans')
      .select('is_legacy_plan')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    if (error) {
      console.warn(`[tokenCosts] is_legacy_plan lookup failed for ${userId}:`, error.message);
      return true;
    }
    if (!data) return true;
    return data.is_legacy_plan === true;
  } catch (e: any) {
    console.warn(`[tokenCosts] is_legacy_plan exception for ${userId}: ${e.message}`);
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper resolvers — single line at the call site.
// ─────────────────────────────────────────────────────────────────────────────

/** TTV tokens-per-second for a video model + audio flag. */
export function ttvTokensPerSecond(
  isLegacy: boolean,
  videoModel: string,
  audioClip: boolean,
): number {
  const baseMap   = isLegacy ? LEGACY_TTV_TOKENS_PER_SECOND       : NEW_TTV_TOKENS_PER_SECOND;
  const audioMap  = isLegacy ? LEGACY_TTV_TOKENS_PER_SECOND_AUDIO : NEW_TTV_TOKENS_PER_SECOND_AUDIO;
  if (audioClip && audioMap[videoModel]) return audioMap[videoModel];
  return baseMap[videoModel] ?? 6000;
}

/** ITV tokens-per-second for a video model + audio flag. */
export function itvTokensPerSecond(
  isLegacy: boolean,
  videoModel: string,
  audioClip: boolean,
): number {
  const baseMap  = isLegacy ? LEGACY_ITV_TOKENS_PER_SECOND       : NEW_ITV_TOKENS_PER_SECOND;
  const audioMap = isLegacy ? LEGACY_ITV_TOKENS_PER_SECOND_AUDIO : NEW_ITV_TOKENS_PER_SECOND_AUDIO;
  if (audioClip && audioMap[videoModel]) return audioMap[videoModel];
  return baseMap[videoModel] ?? 6000;
}

/** Tokens charged per generated image for a given model. */
export function imageTokens(isLegacy: boolean, imageModel: string): number {
  const map = isLegacy ? LEGACY_IMAGE_TOKENS_PER_IMAGE : NEW_IMAGE_TOKENS_PER_IMAGE;
  return map[imageModel] ?? 30000;
}

/** LLM multiplier (sonnet / opus / deepseek). */
export function llmMultiplier(isLegacy: boolean, model: string): number {
  const map = isLegacy ? LEGACY_LLM_MULTIPLIERS : NEW_LLM_MULTIPLIERS;
  return map[model] ?? 1.0;
}
