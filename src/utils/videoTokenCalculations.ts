// Token calculation utilities for VideoGenerator

import {
  LEGACY_IMAGE_TOKENS_PER_IMAGE,
  NEW_IMAGE_TOKENS_PER_IMAGE,
} from '../data/tokenCosts';

// Tier-name aliases used by some legacy callers map to the canonical backend
// model id; the actual per-image token costs come from src/data/tokenCosts.ts.
const TIER_TO_MODEL: Record<string, string> = {
  spark:    'flux-2-dev',
  standard: 'imagen-4-fast',
  grok:     'grok-imagine-image',
  plus:     'gpt-image-1-mini',
  prime:    'seedream-4.5',
  premium:  'imagen-4-ultra',
  genesis:  'nano-banana-pro',
};

function tokensPerImageFor(model: string, isLegacy: boolean): number {
  const map = isLegacy ? LEGACY_IMAGE_TOKENS_PER_IMAGE : NEW_IMAGE_TOKENS_PER_IMAGE;
  const canonical = TIER_TO_MODEL[model] ?? model;
  return map[canonical] ?? map['imagen-4-fast'] ?? 14000;
}

/**
 * Legacy export retained for any callers that read individual entries.
 * Prefer `tokensPerImageFor(model, isLegacy)` going forward.
 */
export const IMAGE_MODEL_TOKENS: Record<string, number> = {
  spark: LEGACY_IMAGE_TOKENS_PER_IMAGE['flux-2-dev'],
  'flux-2-dev': LEGACY_IMAGE_TOKENS_PER_IMAGE['flux-2-dev'],
  standard: LEGACY_IMAGE_TOKENS_PER_IMAGE['imagen-4-fast'],
  'imagen-4-fast': LEGACY_IMAGE_TOKENS_PER_IMAGE['imagen-4-fast'],
  grok: LEGACY_IMAGE_TOKENS_PER_IMAGE['grok-imagine-image'],
  'grok-imagine-image': LEGACY_IMAGE_TOKENS_PER_IMAGE['grok-imagine-image'],
  plus: LEGACY_IMAGE_TOKENS_PER_IMAGE['gpt-image-1-mini'],
  'gpt-image-1-mini': LEGACY_IMAGE_TOKENS_PER_IMAGE['gpt-image-1-mini'],
  prime: LEGACY_IMAGE_TOKENS_PER_IMAGE['seedream-4.5'],
  'seedream-4.5': LEGACY_IMAGE_TOKENS_PER_IMAGE['seedream-4.5'],
  premium: LEGACY_IMAGE_TOKENS_PER_IMAGE['imagen-4-ultra'],
  'imagen-4-ultra': LEGACY_IMAGE_TOKENS_PER_IMAGE['imagen-4-ultra'],
  genesis: LEGACY_IMAGE_TOKENS_PER_IMAGE['nano-banana-pro'],
  'nano-banana-pro': LEGACY_IMAGE_TOKENS_PER_IMAGE['nano-banana-pro'],
};

// Video pipeline token costs (GCloud function charges)
export const VIDEO_PIPELINE_TOKENS = {
  DURATION_CALC_BASE: 50000,        // calculate-video-durations base charge
  STT_PER_CHUNK: 3000,              // per 9-min audio chunk (Whisper STT)
  IMAGE_BATCH: 70000,               // image-to-video-processor per batch
  FINAL_VIDEO_BASE: 150000,         // create-final-video base (no transitions)
  TRANSITION_BATCH: 85000,          // image visual: per additional transition batch (batch_size=6)
  TRANSITION_BATCH_VIDEO: 40000,    // ITV/TTV: per additional transition batch (batch_size=12)
  VIDEO_LOOP: 150000,               // create-final-video video loop
} as const;

// Estimate video pipeline tokens (excluding STT which is audio-duration dependent)
export const estimateVideoPipelineTokens = (
  imageCount: number,
  totalDuration: number,
  hasTransitions: boolean = false,
  isVideoLoop: boolean = false,
  visualType: string = 'image'
): number => {
  if (isVideoLoop) return VIDEO_PIPELINE_TOKENS.VIDEO_LOOP;

  const durationCalcTokens = VIDEO_PIPELINE_TOKENS.DURATION_CALC_BASE;
  const batchCount = estimateVideoBatchCount(imageCount, totalDuration);
  const batchTokens = batchCount * VIDEO_PIPELINE_TOKENS.IMAGE_BATCH;
  const finalVideoTokens = VIDEO_PIPELINE_TOKENS.FINAL_VIDEO_BASE;

  const isVideoMode = visualType === 'ttv' || visualType === 'itv';
  const transitionBatchSize = isVideoMode ? 12 : 6;
  const transitionCostPerBatch = isVideoMode
    ? VIDEO_PIPELINE_TOKENS.TRANSITION_BATCH_VIDEO
    : VIDEO_PIPELINE_TOKENS.TRANSITION_BATCH;

  let transitionTokens = 0;
  if (hasTransitions && imageCount > transitionBatchSize) {
    const additionalBatches = Math.ceil(imageCount / transitionBatchSize) - 1;
    transitionTokens = additionalBatches * transitionCostPerBatch;
  }

  return durationCalcTokens + batchTokens + finalVideoTokens + transitionTokens;
};

// Plan max tokens - LEGACY values only. Prefer getPlanMaxTokens(plan, isLegacy) from data/planMaxTokens.
export const planMaxTokens: Record<string, number> = {
  free: 400000,
  standard: 4000000,
  plus: 6000000,
  premium: 10000000,
  pro: 25000000,
  elite: 50000000,
  ultimate: 75000000,
  enterprise: 250000000,
};

// Calculate estimated token cost for images
export const calculateEstimatedImageTokens = (
  imageCount: number,
  imageModel: string,
  isLegacy: boolean = true,
): number => {
  if (imageCount <= 0) return 0;
  return imageCount * tokensPerImageFor(imageModel, isLegacy);
};

// Estimate image count based on word count and frequency - matches backend exactly
export const estimateImageCount = (wordCount: number, firstPageFreq: number, restFreq: number): number => {
  if (!wordCount || wordCount <= 0) return 0;
  
  const totalChars = wordCount * 5; // Match backend's 5 chars per word
  
  // First page calculation — freq 0 means skip first-page images
  let firstPageSegments = 0;
  if (firstPageFreq > 0) {
    const firstPageCharsPerSegment = Math.max(100, Math.min(3000, Math.round(firstPageFreq * 13.67))); // Use 13.67 CHARS_PER_SECOND
    firstPageSegments = Math.ceil(3000 / firstPageCharsPerSegment);
  }
  
  // Rest calculation — freq 0 means skip rest images
  let restSegments = 0;
  if (restFreq > 0) {
    const remainingChars = Math.max(0, totalChars - 3000);
    const restCharsPerSegment = Math.max(100, Math.round(restFreq * 13.67)); // Use 13.67 CHARS_PER_SECOND
    restSegments = remainingChars > 0 ? Math.ceil(remainingChars / restCharsPerSegment) : 0;
  }
  
  const totalPrompts = firstPageSegments + restSegments;
  if (totalPrompts === 0) return 0;
  
  // Apply 18% increase like backend
  const finalCount = Math.round(totalPrompts * 1.18);
  
  console.log(`Image count calculation (backend logic): wordCount=${wordCount}, firstPageFreq=${firstPageFreq}s, restFreq=${restFreq}s, totalChars=${totalChars}, firstPageSegments=${firstPageSegments}, restSegments=${restSegments}, beforeIncrease=${totalPrompts}, final=${finalCount}`);
  
  return finalCount;
};

// Calculate word count from text
export const calculateWordCount = (text: string): number => {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
};

// Estimate total video duration based on word count or audio duration
export const estimateTotalVideoDuration = (
  wordCount: number,
  totalAudioDuration?: number
): number => {
  // If audio duration provided, use it directly
  if (totalAudioDuration && totalAudioDuration > 0) {
    return totalAudioDuration;
  }
  
  // Otherwise estimate from word count (125 words per minute)
  if (wordCount > 0) {
    return (wordCount / 125) * 60; // Convert to seconds
  }
  
  return 0;
};

// Calculate estimated batch count based on duration-based logic
// If avg duration < 35s per image: use 8 images/batch
// Otherwise: use totalDuration / 300 (max 300s per batch)
export const estimateVideoBatchCount = (
  imageCount: number,
  totalDuration: number
): number => {
  if (imageCount <= 0 || totalDuration <= 0) return 0;
  
  const avgDurationPerImage = totalDuration / imageCount;
  
  // If average duration per image is less than 35 seconds, use 8 images per batch
  if (avgDurationPerImage < 35) {
    return Math.ceil(imageCount / 8);
  }
  
  // Otherwise, allocate based on 300-second max per batch
  return Math.ceil(totalDuration / 300);
};

// Format storage size in MB to readable format
export const formatStorageSize = (sizeInMB: number): string => {
  const gb = sizeInMB / 1024;
  
  if (gb >= 1) {
    return `${gb.toFixed(1)} GB`;
  } else {
    return sizeInMB > 0 && sizeInMB < 0.05 ? '0.1 MB' : `${sizeInMB.toFixed(sizeInMB < 1 ? 1 : 2)} MB`;
  }
};
