// Browser mirror of supabase/functions/_shared/timeEstimates.ts.
// Keep these two files in sync. Re-exports identical API for the
// frontend polling code (storyTaskPolling.ts).
//
// We intentionally duplicate (not import via path alias) because the
// edge-function file lives under supabase/ and uses Deno-style imports;
// duplicating costs ~150 lines but keeps build chains independent.

// Calibrated for 40% gross margin at $2 / 1M token sell price
// (i.e. GCP cost <= $1.20 per 1M tokens) → 40% / 52% / 60% margin at
// $2 / $2.50 / $3 per 1M. Tier 1 region pricing (us-central1,
// europe-west1, etc.). If you redeploy with different memory / vCPU,
// recompute as: tokens_per_min = $/min / $1.20 * 1_000_000.
//   create-final-video             16 GiB / 4 vCPU  $0.00816/min
//   create-final-video-high-memory 32 GiB / 8 vCPU  $0.01632/min
//   image-to-video-processor       8 GiB  / 4 vCPU  $0.00696/min
//   calculate-video-durations      8 GiB  / 2 vCPU  $0.00408/min
//   boost-audio-volume             8 GiB  / 2 vCPU  $0.00408/min
//   calculate-audio-duration       4 GiB  / 2 vCPU  $0.00348/min
//   fetch-youtube-transcript       0.5 GiB/ 1 vCPU  $0.001515/min
//   video-concat-function          8 GiB  / 2 vCPU  $0.00408/min
export const TOKEN_RATES_PER_MIN: Record<string, number> = {
  'calculate-audio-duration':        2900,
  'calculate-video-durations':       3400,
  'boost-audio-volume':              3400,
  'image-to-video-processor':        5800,
  'create-final-video':              6800,
  'create-final-video-high-memory': 13600,
  'fetch-youtube-transcript':        1265,
  'video-concat-function':           3400,
};

// Calibrated from real gcf_runtime_log data (Apr 2026). Per-visual-type
// constants live in VT_* maps below; scalar fallbacks live in TIME_EST.
export const TIME_EST = {
  // image-to-video-processor batches actually run serially in production
  // (one batch starts after the previous finishes), confirmed by
  // gcf_runtime_log timestamps. Set to 1 to reflect reality.
  PARALLEL_ITV: 1,
  T_AUDIO_CONST: 5,
  T_AUDIO_PER_SEC: 0.03,
  T_BOOST_CONST: 4,
  T_BOOST_PER_SEC: 0.04,
  T_CALC_DUR_CONST: 8,
  T_RENDER_CONST: 5,
  T_RENDER_HM_SPEEDUP: 0.65,
  T_RENDER_TRANSITIONS_MULT: 1.35,
  T_RENDER_TRANSITIONS_PASS_MULT: 0.20,
  T_SUBTITLE_CONST: 5,
  SAFETY_PAD: 1.10,
  HM_S_AUDIO_THRESHOLD: 600,
  HM_TRANSITIONS_S_AUDIO_THRESHOLD: 300,
} as const;

// Per-visual-type calibrated constants. Source: gcf_runtime_log analysis
// (May 2026, n>400 i2v rows). Per-effect / per-animation multipliers
// replace the old single-boolean overlayMult — empirical ratio of
// runtime_seconds / batch_video_seconds varies 0.85× (drift+none) up to
// 8.7× (ken_burns + film_grain + transitions).
type VType = 'image' | 'ttv' | 'itv' | 'mg';

const VT_CALC_DUR: Record<VType, { perImage: number; perAudioSec: number }> = {
  image: { perImage: 4.0, perAudioSec: 0.05 },
  itv:   { perImage: 0.4, perAudioSec: 0.07 },
  ttv:   { perImage: 4.0, perAudioSec: 0.05 },
  mg:    { perImage: 0.0, perAudioSec: 0.05 },
};

// image-to-video-processor: runs for ALL visual types. See _shared/timeEstimates.ts
// for the full calibration commentary; keep these in sync byte-for-byte.
const VT_ITV_STAGE: Record<VType, {
  perImageConst: number;
  perVideoSec: number;
}> = {
  // Re-calibrated May 2026; see _shared/timeEstimates.ts for evidence.
  image: { perImageConst: 25, perVideoSec: 1.15 },
  itv:   { perImageConst: 2,  perVideoSec: 0.95 },
  ttv:   { perImageConst: 2,  perVideoSec: 0.85 },
  mg:    { perImageConst: 0,  perVideoSec: 0.0 },
};

const ANIM_MULT: Record<string, number> = {
  none: 1.0,
  drift: 1.0,
  vertical: 1.0,
  pan: 1.3,
  ken_burns: 1.8,
};
const ANIM_MULT_DEFAULT = 1.2;

const EFFECT_MULT: Record<string, number> = {
  none: 1.0,
  film_grain: 3.9,
  light_sparkle: 3.1,
  snow: 3.2,
  fire_flare: 5.0,
  rain: 3.2,
};
const EFFECT_MULT_DEFAULT = 3.0;

const ITV_TRANSITIONS_MULT = 1.10;

function animMult(animationType?: string | null): number {
  if (!animationType || animationType === 'none') return 1.0;
  return ANIM_MULT[animationType] ?? ANIM_MULT_DEFAULT;
}
function effectMult(effectsType?: string | null): number {
  if (!effectsType || effectsType === 'none') return 1.0;
  return EFFECT_MULT[effectsType] ?? EFFECT_MULT_DEFAULT;
}

const VT_RENDER: Record<VType, { perAudioSec: number }> = {
  image: { perAudioSec: 0.10 },
  itv:   { perAudioSec: 0.55 },
  ttv:   { perAudioSec: 1.20 },
  mg:    { perAudioSec: 0.30 },
};

const VT_SUBTITLE: Record<VType, { perAudioSec: number }> = {
  image: { perAudioSec: 0.70 },
  itv:   { perAudioSec: 0.50 },
  ttv:   { perAudioSec: 0.50 },
  mg:    { perAudioSec: 0.50 },
};

export interface VideoEstimateInputs {
  N_images: number;
  S_audio: number;
  durations?: number[] | null;
  visualType: 'image' | 'ttv' | 'itv' | 'mg';
  hasTransitions: boolean;
  hasOverlay: boolean;
  hasSubtitles: boolean;
  useExistingAudio: boolean;
  // NEW: explicit overlay configuration. When provided, drives the per-clip
  // image-to-video-processor cost via ANIM_MULT × EFFECT_MULT.
  animationType?: string | null;
  effectsType?: string | null;
  ttvSecondsPerClip?: number;
  itvSecondsPerClip?: number;
}

export interface StageBreakdown {
  audioDuration: number;
  audioBoost: number;
  calcDurations: number;
  imageToVideo: number;
  finalRender: number;
  subtitles: number;
  total: number;
  totalWithPad: number;
  useHighMemory: boolean;
}

export function shouldUseHighMemory(S_audio: number, hasTransitions: boolean): boolean {
  if (S_audio > TIME_EST.HM_S_AUDIO_THRESHOLD) return true;
  if (hasTransitions && S_audio > TIME_EST.HM_TRANSITIONS_S_AUDIO_THRESHOLD) return true;
  return false;
}

export function tAudioDuration(S_audio: number): number {
  return TIME_EST.T_AUDIO_CONST + TIME_EST.T_AUDIO_PER_SEC * S_audio;
}

export function tAudioBoost(S_audio: number, useExistingAudio: boolean): number {
  if (useExistingAudio) return 0;
  return TIME_EST.T_BOOST_CONST + TIME_EST.T_BOOST_PER_SEC * S_audio;
}

export function tCalculateDurations(
  N_images: number,
  S_audio: number,
  visualType: VType = 'image',
): number {
  const c = VT_CALC_DUR[visualType];
  return TIME_EST.T_CALC_DUR_CONST
    + c.perImage * N_images
    + c.perAudioSec * S_audio;
}

export function tImageToVideo(
  visualType: 'image' | 'ttv' | 'itv' | 'mg',
  N_images: number,
  S_audio: number,
  durations: number[] | null | undefined,
  hasOverlay: boolean,
  animationType?: string | null,
  effectsType?: string | null,
  hasTransitions: boolean = false,
): number {
  if (N_images <= 0) return 0;
  const cfg = VT_ITV_STAGE[visualType];
  let overlayProduct: number;
  if (animationType !== undefined || effectsType !== undefined) {
    overlayProduct = animMult(animationType) * effectMult(effectsType);
  } else {
    overlayProduct = hasOverlay ? 3.0 : 1.0;
  }
  if (hasTransitions) overlayProduct *= ITV_TRANSITIONS_MULT;
  const evenSec = N_images > 0 ? S_audio / N_images : 0;
  const list = (durations && durations.length === N_images)
    ? durations
    : new Array(N_images).fill(evenSec);
  let serial = 0;
  for (const sec of list) {
    const perImage = cfg.perImageConst + cfg.perVideoSec * sec * overlayProduct;
    serial += perImage;
  }
  return serial / TIME_EST.PARALLEL_ITV;
}

export function tFinalRender(
  S_audio: number,
  hasTransitions: boolean,
  useHighMemory: boolean,
  completedTransitionFraction: number = 0,
  visualType: VType = 'image',
): number {
  let perSec = VT_RENDER[visualType].perAudioSec;
  if (useHighMemory) perSec *= TIME_EST.T_RENDER_HM_SPEEDUP;
  const renderPerSec = hasTransitions ? perSec * TIME_EST.T_RENDER_TRANSITIONS_MULT : perSec;
  const render = TIME_EST.T_RENDER_CONST + renderPerSec * S_audio;
  // Transition pass cost scales down as transition batches finish.
  const transFracRemaining = Math.max(0, Math.min(1, 1 - completedTransitionFraction));
  const transPass = hasTransitions
    ? renderPerSec * S_audio * TIME_EST.T_RENDER_TRANSITIONS_PASS_MULT * transFracRemaining
    : 0;
  return render + transPass;
}

export function tSubtitles(
  S_audio: number,
  hasSubtitles: boolean,
  useHighMemory: boolean,
  visualType: VType = 'image',
): number {
  if (!hasSubtitles) return 0;
  const base = VT_SUBTITLE[visualType].perAudioSec;
  const perSec = base * (useHighMemory ? TIME_EST.T_RENDER_HM_SPEEDUP : 1);
  return TIME_EST.T_SUBTITLE_CONST + perSec * S_audio;
}

export function estimateVideoPipelineSeconds(inp: VideoEstimateInputs): StageBreakdown {
  const useHighMemory = shouldUseHighMemory(inp.S_audio, inp.hasTransitions);
  const audioDuration = tAudioDuration(inp.S_audio);
  const audioBoost    = tAudioBoost(inp.S_audio, inp.useExistingAudio);
  const calcDurations = tCalculateDurations(inp.N_images, inp.S_audio, inp.visualType);
  const imageToVideo  = tImageToVideo(
    inp.visualType, inp.N_images, inp.S_audio, inp.durations, inp.hasOverlay,
    inp.animationType, inp.effectsType, inp.hasTransitions,
  );
  const finalRender   = tFinalRender(inp.S_audio, inp.hasTransitions, useHighMemory, 0, inp.visualType);
  const subtitles     = tSubtitles(inp.S_audio, inp.hasSubtitles, useHighMemory, inp.visualType);
  const total = audioDuration + audioBoost + calcDurations + imageToVideo + finalRender + subtitles;
  const totalWithPad = total * TIME_EST.SAFETY_PAD;
  return {
    audioDuration, audioBoost, calcDurations,
    imageToVideo, finalRender, subtitles,
    total, totalWithPad, useHighMemory,
  };
}

export type PipelinePhase =
  | 'pre'
  | 'audioDuration'
  | 'audioBoost'
  | 'calcDurations'
  | 'imageToVideo'
  | 'finalRender'
  | 'subtitles'
  | 'done';

export interface RemainingInputs extends VideoEstimateInputs {
  phase: PipelinePhase;
  completedRowSeconds?: number;
  completedTransitions?: number;
  totalTransitions?: number;
}

export function estimateRemainingSeconds(inp: RemainingInputs): number {
  if (inp.phase === 'done') return 0;
  const useHighMemory = shouldUseHighMemory(inp.S_audio, inp.hasTransitions);
  const orderRank: Record<PipelinePhase, number> = {
    pre: 0, audioDuration: 1, audioBoost: 2, calcDurations: 3,
    imageToVideo: 4, finalRender: 5, subtitles: 6, done: 7,
  };
  const cur = orderRank[inp.phase];
  let remaining = 0;
  if (cur <= orderRank.audioDuration) remaining += tAudioDuration(inp.S_audio);
  if (cur <= orderRank.audioBoost)    remaining += tAudioBoost(inp.S_audio, inp.useExistingAudio);
  if (cur <= orderRank.calcDurations) remaining += tCalculateDurations(inp.N_images, inp.S_audio, inp.visualType);
  if (cur <= orderRank.imageToVideo) {
    // image-to-video-processor stage runs for ALL visual types in production
    // (image renders slides; itv/ttv post-processes pre-generated clips).
    const totalItv = tImageToVideo(
      inp.visualType, inp.N_images, inp.S_audio, inp.durations, inp.hasOverlay,
      inp.animationType, inp.effectsType, inp.hasTransitions,
    );
    // Use actual sum of completed clip durations when available — accounts
    // for non-uniform clip lengths (long clip done != avg clip done).
    const fractionComplete = inp.S_audio > 0 && (inp.completedRowSeconds ?? 0) > 0
      ? Math.min(1, (inp.completedRowSeconds ?? 0) / inp.S_audio)
      : 0;
    remaining += totalItv * (1 - fractionComplete);
  }
  if (cur <= orderRank.finalRender) {
    const transFrac = (inp.totalTransitions ?? 0) > 0
      ? Math.min(1, (inp.completedTransitions ?? 0) / (inp.totalTransitions as number))
      : 0;
    remaining += tFinalRender(inp.S_audio, inp.hasTransitions, useHighMemory, transFrac, inp.visualType);
  }
  if (cur <= orderRank.subtitles)     remaining += tSubtitles(inp.S_audio, inp.hasSubtitles, useHighMemory, inp.visualType);
  return remaining * TIME_EST.SAFETY_PAD;
}
