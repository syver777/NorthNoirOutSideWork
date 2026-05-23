// =============================================================================
// Motion Graphics cost / billing constants (single source of truth, frontend).
// Mirrored verbatim in supabase/functions/_shared/mgCosts.ts so edge functions
// stay in sync.
// =============================================================================

/** Average tokens Claude Opus 4 consumes per MG clip when generating TSX. */
export const MG_OPUS_INPUT_TOKENS_PER_CLIP_AVG = 8_000;
export const MG_OPUS_OUTPUT_TOKENS_PER_CLIP_AVG = 6_000;

/** Anthropic Claude Opus 4 published list pricing (USD per 1M tokens). */
export const MG_OPUS_INPUT_USD_PER_MTOK = 15;
export const MG_OPUS_OUTPUT_USD_PER_MTOK = 75;

/**
 * Internal token-credit cost of one second of Remotion-Lambda render time.
 * Mirrors MG_LAMBDA_TOKENS_PER_SECOND in denodeploy/process-mg-task.ts.
 */
export const MG_LAMBDA_TOKENS_PER_SECOND = 180;

/** Default MG clip duration for the unified VideoGenerator (seconds). */
export const MG_DEFAULT_CLIP_SECONDS = 16;
/** Bounds for the user-facing Clip Duration slider. */
export const MG_MIN_CLIP_SECONDS = 5;
export const MG_MAX_CLIP_SECONDS = 30;
/** Rough wall-clock estimate per Lambda-rendered MG clip — used for time-remaining displays. */
export const MG_SECONDS_PER_CLIP_RENDER = 90;
/** Rough output size per MG clip (MB). */
export const MG_MB_PER_CLIP = 5;

// ─── Codegen model catalog ──────────────────────────────────────────────────
export type MGCodegenModel = 'opus' | 'sonnet';

export const MG_CODEGEN_MODEL_OPTIONS: Array<{
  value: MGCodegenModel;
  label: string;
  description: string;
}> = [
  { value: 'opus',   label: 'Claude Opus 4.6',   description: 'Best quality (default)' },
  { value: 'sonnet', label: 'Claude Sonnet 4.6', description: '~1.7× cheaper, faster' },
];

/** Anthropic list pricing (USD per 1M tokens) for the codegen models. */
const MG_CODEGEN_PRICING: Record<MGCodegenModel, { in: number; out: number }> = {
  opus:   { in: 5.0, out: 25.0 },
  sonnet: { in: 3.0, out: 15.0 },
};
const MG_CODEGEN_AVG_IN_TOKENS  = 1000;
const MG_CODEGEN_AVG_OUT_TOKENS = 6000;
const MG_CODEGEN_REPAIR_BUFFER  = 1.15;
const MG_CODEGEN_MARGIN         = 0.4; // user charge = api_cost / (1 - margin)

/** USD charged to the user per generated clip for the chosen codegen model. */
export function mgCodegenUserChargePerClip(model: MGCodegenModel): number {
  const p = MG_CODEGEN_PRICING[model];
  const apiCost =
    ((MG_CODEGEN_AVG_IN_TOKENS * p.in) + (MG_CODEGEN_AVG_OUT_TOKENS * p.out)) /
    1_000_000 *
    MG_CODEGEN_REPAIR_BUFFER;
  return apiCost / (1 - MG_CODEGEN_MARGIN);
}

/** Internal platform tokens per clip (1 token ≈ $2/1M ⇒ tokens = USD × 500_000). */
export function mgCodegenTokensPerClip(model: MGCodegenModel): number {
  return Math.ceil(mgCodegenUserChargePerClip(model) * 500_000);
}

// ─── Language catalog (used by the MG codegen worker) ───────────────────────
export const MG_LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'english', label: 'English' },
  { value: 'german',  label: 'German' },
  { value: 'spanish', label: 'Spanish' },
  { value: 'french',  label: 'French' },
];

/**
 * Convert a target runtime in seconds to the expected number of MG clips.
 */
export function mgClipCount(runtimeSeconds: number, clipSeconds = MG_DEFAULT_CLIP_SECONDS): number {
  if (runtimeSeconds <= 0) return 0;
  return Math.ceil(runtimeSeconds / Math.max(1, clipSeconds));
}

/**
 * Estimate the in-app token cost of producing an MG video of the given runtime.
 * Combines Claude Opus codegen cost (converted to tokens via Anthropic pricing)
 * with Lambda render seconds. Returned value is *internal app tokens*, not
 * Anthropic tokens, so it can be compared against the user's wallet.
 */
export function estimateMgTokenCost(runtimeSeconds: number, clipSeconds = MG_DEFAULT_CLIP_SECONDS): number {
  const clips = mgClipCount(runtimeSeconds, clipSeconds);
  // Codegen: convert USD → internal tokens via your platform's exchange rate.
  // We follow the same convention as tokenCosts.ts (1 token ≈ 1e-5 USD effective
  // — adjust here if your platform ratio differs). Replaced by passthrough to
  // tokenCosts where available; this is the planner-side rough estimate.
  const codegenInputUsd =
    (clips * MG_OPUS_INPUT_TOKENS_PER_CLIP_AVG / 1_000_000) * MG_OPUS_INPUT_USD_PER_MTOK;
  const codegenOutputUsd =
    (clips * MG_OPUS_OUTPUT_TOKENS_PER_CLIP_AVG / 1_000_000) * MG_OPUS_OUTPUT_USD_PER_MTOK;
  const codegenTokens = Math.ceil((codegenInputUsd + codegenOutputUsd) * 100_000);

  const renderTokens = clips * clipSeconds * MG_LAMBDA_TOKENS_PER_SECOND;

  return codegenTokens + renderTokens;
}
