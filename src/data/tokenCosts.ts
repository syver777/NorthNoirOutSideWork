// src/data/tokenCosts.ts
// ─────────────────────────────────────────────────────────────────────────────
// Frontend mirror of supabase/functions/_shared/tokenCosts.ts.
//
// Every user_plans row has an `is_legacy_plan` boolean:
//   • TRUE  → use the LEGACY_* maps (current production rates,
//             grandfathered for early adopters).
//   • FALSE → use the NEW_* maps (calibrated for ≥40% margin at the
//             new $2/M revenue tier — see margin plan.txt).
//
// Default to TRUE on any missing/unknown lookup (don't surprise legacy users).
// Frontend estimators / display labels MUST resolve via these helpers so the
// number a user sees on screen matches what the backend will actually charge.
// ─────────────────────────────────────────────────────────────────────────────

// ── TTV (text-to-video) ─────────────────────────────────────────────────────

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

// ── ITV (image-to-video) ────────────────────────────────────────────────────

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

// ── Image generation ────────────────────────────────────────────────────────

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
  'flux-2-dev':          12000,
  'seedream-4.5':        35000,
  'nano-banana-pro':    109000,
  'grok-imagine-image':  19000,
};

// ── LLM multipliers ─────────────────────────────────────────────────────────

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
// Helper resolvers (single line at the call site).
// ─────────────────────────────────────────────────────────────────────────────

export function ttvTokensPerSecond(
  isLegacy: boolean,
  videoModel: string,
  audioClip: boolean,
): number {
  const baseMap  = isLegacy ? LEGACY_TTV_TOKENS_PER_SECOND       : NEW_TTV_TOKENS_PER_SECOND;
  const audioMap = isLegacy ? LEGACY_TTV_TOKENS_PER_SECOND_AUDIO : NEW_TTV_TOKENS_PER_SECOND_AUDIO;
  if (audioClip && audioMap[videoModel]) return audioMap[videoModel];
  return baseMap[videoModel] ?? 6000;
}

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

export function imageTokens(isLegacy: boolean, imageModel: string): number {
  const map = isLegacy ? LEGACY_IMAGE_TOKENS_PER_IMAGE : NEW_IMAGE_TOKENS_PER_IMAGE;
  return map[imageModel] ?? 30000;
}

export function llmMultiplier(isLegacy: boolean, model: string): number {
  const map = isLegacy ? LEGACY_LLM_MULTIPLIERS : NEW_LLM_MULTIPLIERS;
  return map[model] ?? 1.0;
}

// Convenience: the LLM-model dropdown shape used across the UI.
export interface LLMModelConfig {
  value: 'deepseek' | 'sonnet' | 'opus' | string;
  label: string;
  tokenMultiplier: number;
  description: string;
}

export function getLLMModelConfigs(isLegacy: boolean): LLMModelConfig[] {
  const m = isLegacy ? LEGACY_LLM_MULTIPLIERS : NEW_LLM_MULTIPLIERS;
  return [
    { value: 'deepseek', label: 'Core Model',        tokenMultiplier: m.deepseek, description: `${m.deepseek}x tokens` },
    { value: 'sonnet',   label: 'Claude Sonnet 4.6', tokenMultiplier: m.sonnet,   description: `${m.sonnet}x tokens` },
    { value: 'opus',     label: 'Claude Opus 4.6',   tokenMultiplier: m.opus,     description: `${m.opus}x tokens` },
  ];
}
