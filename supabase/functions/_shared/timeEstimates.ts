// Shared time-estimate + token-rate constants.
// SOURCE OF TRUTH for both the Deno edge function (video-analyze) and the
// browser polling code (src/utils/storyTaskPolling.ts via src/utils/timeEstimates.ts).
// Mirror this file byte-for-byte (constants block) when changing values.
//
// All time values are SECONDS unless suffixed _MINUTES. All token rates are
// per ONE MINUTE of GCF wall-clock at the listed vCPU/memory configuration.
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

// ── Per-minute token rates (charge model) ───────────────────────────────
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

// ── Stage time-estimate constants (seconds unless noted) ────────────────
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
type VType = 'image' | 'ttv' | 'itv';

// calculate-video-durations: per-image cost differs because TTV runs
// faster-whisper speech detection on every existing clip; ITV reads
// duration metadata only.
const VT_CALC_DUR: Record<VType, { perImage: number; perAudioSec: number }> = {
  image: { perImage: 4.0, perAudioSec: 0.05 },
  itv:   { perImage: 0.4, perAudioSec: 0.07 },
  ttv:   { perImage: 4.0, perAudioSec: 0.05 },
};

// image-to-video-processor: runs for ALL visual types. Calibrated against
// gcf_runtime_log:
//   runtime ≈ perImageConst * N + S_video * perVideoSec * animMult * effectMult
// perImageConst absorbs cold-start + overlay-comp setup per clip.
const VT_ITV_STAGE: Record<VType, {
  perImageConst: number;
  perVideoSec: number;
}> = {
  // image: re-calibrated May 2026 against gcf_runtime_log. Slideshow runs
  // serially with sizable per-image setup (PIL composite + overlay frames),
  // so per-image const dominates the small-clip case. perVideoSec bumped
  // from 0.85 → 1.15 because measured ratios for image+ken_burns/snow and
  // image+vertical/light_sparkle landed 30–50% above the prior estimate
  // (12-img/620s ken_burns: predicted 3155s vs actual 4595s = 1.46×;
  //  89-img/6241s vertical+light_sparkle: 17335 vs 22969 = 1.32×).
  image: { perImageConst: 25, perVideoSec: 1.15 },
  itv:   { perImageConst: 2,  perVideoSec: 0.95 },
  ttv:   { perImageConst: 2,  perVideoSec: 0.85 },
};

// Animation overhead. Multiplies perVideoSec inside image-to-video-processor.
// Calibrated from gcf_runtime_log (see /memories/session/estimator-vs-actual-investigation.md).
//   drift / vertical / none: baseline (1.0)
//   ken_burns: ~1.8× (15+ samples confirm 7.64 ratio with fire_flare vs 4.41 for drift)
//   pan: estimated 1.3 (sparse data)
const ANIM_MULT: Record<string, number> = {
  none: 1.0,
  drift: 1.0,
  vertical: 1.0,
  pan: 1.3,
  ken_burns: 1.8,
};
const ANIM_MULT_DEFAULT = 1.2;

// Effects overhead. Multiplies perVideoSec inside image-to-video-processor.
// Empirical ratios (drift baseline 0.85):
//   none: 1.0    (drift+none ratio 0.87)
//   film_grain: 3.9 (ratio 3.37)
//   light_sparkle: 3.1 (ratio 2.65)
//   snow: 3.2 (ratio 2.74)
//   fire_flare: 5.0 (ratio 4.41)
const EFFECT_MULT: Record<string, number> = {
  none: 1.0,
  film_grain: 3.9,
  light_sparkle: 3.1,
  snow: 3.2,
  fire_flare: 5.0,
  rain: 3.2,
};
const EFFECT_MULT_DEFAULT = 3.0;

// Transitions add an extra ~10% per-clip pass (ken_burns+film_grain+trans:
// 8.73 vs no-trans 6.97 → 1.25×; drift+light_sparkle+trans 2.62 ≈ no-trans).
// Use 1.10 average so we don't double-count the finalRender transition pass.
const ITV_TRANSITIONS_MULT = 1.10;

function animMult(animationType?: string | null): number {
  if (!animationType || animationType === 'none') return 1.0;
  return ANIM_MULT[animationType] ?? ANIM_MULT_DEFAULT;
}
function effectMult(effectsType?: string | null): number {
  if (!effectsType || effectsType === 'none') return 1.0;
  return EFFECT_MULT[effectsType] ?? EFFECT_MULT_DEFAULT;
}

// create-final-video render pass: image is fast (just concat slideshow),
// itv concats real video clips, ttv has heaviest re-encoding cost.
const VT_RENDER: Record<VType, { perAudioSec: number }> = {
  image: { perAudioSec: 0.10 },
  itv:   { perAudioSec: 0.55 },
  ttv:   { perAudioSec: 1.20 },
};

// Subtitle burn: cheap on image slideshows, expensive on real video.
// Subtitles burn-in cost (delta over no-subs render). Calibrated:
//   image+subs runs ~150s longer for ~250s audio \u2192 0.6\u20130.8 perAudioSec.
//   itv/ttv subtitles add minor overhead (clips already encoded).
const VT_SUBTITLE: Record<VType, { perAudioSec: number }> = {
  image: { perAudioSec: 0.70 },
  itv:   { perAudioSec: 0.50 },
  ttv:   { perAudioSec: 0.50 },
};

// ── Inputs ──────────────────────────────────────────────────────────────
export interface VideoEstimateInputs {
  N_images: number;            // total images / clips
  S_audio: number;             // total audio seconds
  durations?: number[] | null; // per-image seconds (post calculate-video-durations)
  visualType: 'image' | 'ttv' | 'itv';
  hasTransitions: boolean;
  hasOverlay: boolean;         // animation_type or effects_type non-null (legacy fallback)
  hasSubtitles: boolean;
  useExistingAudio: boolean;   // skip boost-audio-volume time
  // NEW: explicit overlay configuration. When provided, drives the per-clip
  // image-to-video-processor cost via ANIM_MULT × EFFECT_MULT instead of the
  // legacy hasOverlay boolean. Pass undefined/null when not yet known.
  animationType?: string | null;
  effectsType?: string | null;
  // Pre-computed per-clip generator times for ITV / TTV pipelines (their
  // external generators sit OUTSIDE create-final-video). Caller supplies.
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

// ── Helpers ────────────────────────────────────────────────────────────
export function shouldUseHighMemory(S_audio: number, hasTransitions: boolean): boolean {
  if (S_audio > TIME_EST.HM_S_AUDIO_THRESHOLD) return true;
  if (hasTransitions && S_audio > TIME_EST.HM_TRANSITIONS_S_AUDIO_THRESHOLD) return true;
  return false;
}

function sumDurations(durations: number[] | null | undefined, fallbackTotal: number): number[] {
  if (durations && durations.length > 0) return durations;
  // Pre-flight: even split across N_images if no durations are known yet.
  return [];
}

// ── Per-stage time estimates (seconds) ──────────────────────────────────
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
  visualType: 'image' | 'ttv' | 'itv',
  N_images: number,
  S_audio: number,
  durations: number[] | null | undefined,
  hasOverlay: boolean,
  animationType?: string | null,
  effectsType?: string | null,
  hasTransitions: boolean = false,
): number {
  // ALL three visual pipelines invoke image-to-video-processor in production
  // (image renders slides, itv/ttv post-processes the pre-generated clips).
  if (N_images <= 0) return 0;
  const cfg = VT_ITV_STAGE[visualType];
  // Resolve overlay multiplier:
  //  - If caller passed explicit animation/effect strings → use the calibrated
  //    ANIM_MULT × EFFECT_MULT product (much more accurate, e.g. ken_burns +
  //    fire_flare = 1.8 × 5.0 = 9× perVideoSec).
  //  - Else fall back to the legacy hasOverlay boolean with a conservative
  //    multiplier so old callers don't massively underestimate.
  let overlayProduct: number;
  if (animationType !== undefined || effectsType !== undefined) {
    overlayProduct = animMult(animationType) * effectMult(effectsType);
  } else {
    overlayProduct = hasOverlay ? 3.0 : 1.0; // legacy fallback (better than 1.4)
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

// ── Top-level: full pre-flight estimate ─────────────────────────────────
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

// ── Polling-friendly: remaining seconds given current phase + completed work ──
export type PipelinePhase =
  | 'pre'                 // before audio analysis
  | 'audioDuration'
  | 'audioBoost'
  | 'calcDurations'
  | 'imageToVideo'
  | 'finalRender'
  | 'subtitles'
  | 'done';

export interface RemainingInputs extends VideoEstimateInputs {
  phase: PipelinePhase;
  completedRowSeconds?: number;  // sum of durations[i] for completed video rows
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
    // for non-uniform clip lengths.
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
