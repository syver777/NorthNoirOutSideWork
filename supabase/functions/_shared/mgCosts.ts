// =============================================================================
// Motion Graphics cost constants — edge-function copy.
// MUST stay in sync with src/utils/mgCostConstants.ts (single source of truth on
// the frontend). The supabase/functions/_shared pattern is duplication, so any
// edit here needs the same edit on the frontend file.
// =============================================================================

export const MG_OPUS_INPUT_TOKENS_PER_CLIP_AVG = 8_000;
export const MG_OPUS_OUTPUT_TOKENS_PER_CLIP_AVG = 6_000;

export const MG_OPUS_INPUT_USD_PER_MTOK = 15;
export const MG_OPUS_OUTPUT_USD_PER_MTOK = 75;

export const MG_LAMBDA_TOKENS_PER_SECOND = 180;
export const MG_DEFAULT_CLIP_SECONDS = 16;

export function mgClipCount(runtimeSeconds: number, clipSeconds = MG_DEFAULT_CLIP_SECONDS): number {
  if (runtimeSeconds <= 0) return 0;
  return Math.ceil(runtimeSeconds / Math.max(1, clipSeconds));
}

export function estimateMgTokenCost(runtimeSeconds: number, clipSeconds = MG_DEFAULT_CLIP_SECONDS): number {
  const clips = mgClipCount(runtimeSeconds, clipSeconds);
  const codegenInputUsd =
    (clips * MG_OPUS_INPUT_TOKENS_PER_CLIP_AVG / 1_000_000) * MG_OPUS_INPUT_USD_PER_MTOK;
  const codegenOutputUsd =
    (clips * MG_OPUS_OUTPUT_TOKENS_PER_CLIP_AVG / 1_000_000) * MG_OPUS_OUTPUT_USD_PER_MTOK;
  const codegenTokens = Math.ceil((codegenInputUsd + codegenOutputUsd) * 100_000);

  const renderTokens = clips * clipSeconds * MG_LAMBDA_TOKENS_PER_SECOND;

  return codegenTokens + renderTokens;
}
