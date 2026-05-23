import { createClient } from '@supabase/supabase-js';
import { estimateTotalVideoDuration, estimateVideoBatchCount } from './videoTokenCalculations';
import {
  estimateRemainingSeconds,
  estimateVideoPipelineSeconds,
  type PipelinePhase,
} from './timeEstimates';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

// Export the calculateRemainingTime function for external use
export { calculateRemainingTime, calculateITVConcurrentTime };

// Updated timing constants to match backend logic exactly
const TIMING = {
  STORY_BATCH: 90, // 90 seconds per 500-word batch
  IMAGE_PROMPT_BATCH: 90, // 90 seconds per batch
  IMAGE_GENERATION: 30, // 30 seconds per image (default - use getTimePerImageInSeconds for model-specific timing)
  AUDIO_BATCH_STANDARD: 20, // 20 seconds per 250-word batch (v6)
  AUDIO_BATCH_PREMIUM: 10, // 10 seconds per 200-word batch (v7)
  AUDIO_BATCH_CORE: 10, // 10 seconds per 200-word batch (lemonfox model)
  AUDIO_BATCH_CLONE: 10, // 10 seconds per 40-word batch
  VIDEO_BATCH: 30 * 60, // 30 minutes per 4-image batch
  TRANSITION_BATCH: 30 * 60, // 30 minutes per transition batch (10 images)
  // TTV/ITV timing
  TTV_PROMPT_BATCH: 90, // 90 seconds per TTV prompt batch
  TTV_GENERATION: 90,  // default seconds per TTV clip (use getTTVSecsPerClip for model-specific)
  ITV_PROMPT_BATCH: 90, // 90 seconds per ITV prompt batch
  ITV_GENERATION: 180, // default seconds per ITV clip (use getITVSecsPerClip for model-specific)
  // TTV/ITV video assembly (create-final-video rows + transition batches)
  TTV_ITV_VIDEO_ROW_TIME: 20 * 60,      // 20 minutes per create-final-video row
  TTV_ITV_CLIPS_PER_ROW: 20,            // ~20 clips per video-creation row
  TTV_ITV_TRANSITION_TIME: 10 * 60,     // 10 minutes per transition batch
  TTV_ITV_CLIPS_PER_TRANSITION: 12,     // ~12 clips per transition batch
  TTV_ITV_ASSEMBLY_BUFFER: 30 * 60,     // 30 minute buffer for final assembly/upload
};

// Wall-clock seconds to generate one TTV clip (matches edge function + VisualConfiguration.tsx)
const TTV_SECS_PER_CLIP_GEN: Record<string, number> = {
  'wan22': 360, 'seedance_pro_fast': 90, 'ltx23_fast': 90, 'grok': 120,
  'seedance15_pro': 120, 'grok_highres': 120, 'ltx23_pro': 120,
  'veo31fast': 180, 'veo31': 360, 'sora2pro': 300, 'sora2pro_highres': 480,
};
const TTV_DEFAULT_SECS_PER_CLIP_GEN = 90;
const getTTVSecsPerClip = (model?: string): number =>
  (model && TTV_SECS_PER_CLIP_GEN[model]) || TTV_DEFAULT_SECS_PER_CLIP_GEN;

// Wall-clock seconds to generate one ITV clip (matches edge function + VisualConfiguration.tsx)
const ITV_SECS_PER_CLIP_GEN: Record<string, number> = {
  'wan22': 90, 'seedance1fast': 90, 'hailuo23fast': 150, 'seedance15': 180,
  'ltx23fast': 90, 'veo31fast': 180, 'ltx23pro': 120, 'veo31': 360, 'ltx23pro4k': 180,
};
const ITV_DEFAULT_SECS_PER_CLIP_GEN = 180;
const getITVSecsPerClip = (model?: string): number =>
  (model && ITV_SECS_PER_CLIP_GEN[model]) || ITV_DEFAULT_SECS_PER_CLIP_GEN;

// Helper function to get time per image based on model
const getTimePerImageInSeconds = (model?: string): number => {
  // All models including flux-2-dev take ~30 seconds per image
  return 30;
};

// Voice type detection
const PREMIUM_VOICES = [
  'Alex', 'Ashley', 'Craig', 'Deborah', 'Dennis', 'Edward', 'Elizabeth', 'Hades',
  'Julia', 'Pixie', 'Mark', 'Olivia', 'Priya', 'Ronald', 'Sarah', 'Shaun',
  'Theodore', 'Timothy', 'Wendy', 'Dominus', 'Yichen', 'Xiaoyin', 'Xinyi',
  'Jing', 'Erik', 'Katrien', 'Lennart', 'Lore', 'Alain', 'Helene', 'Mathieu',
  'Etienne', 'Johanna', 'Josef', 'Gianni', 'Orietta', 'Asuka', 'Satoshi',
  'Hyunwoo', 'Minji', 'Seojun', 'Yoona', 'Szymon', 'Wojciech', 'Heitor',
  'Maite', 'Diego', 'Lupita', 'Miguel', 'Rafael'
];

const CLONE_VOICES = [
  'Angelo', 'Arthur', 'Chicot', 'Ranger', 'Hubert', 'Vincent', 'custom'
];

// Core Voices (Lemonfox model)
const CORE_VOICES = [
  'heart', 'bella', 'michael', 'alloy', 'aoede', 'kore', 'jessica', 'nicole',
  'nova', 'river', 'sarah', 'sky', 'echo', 'eric', 'fenrir', 'liam', 'onyx',
  'puck', 'adam', 'santa', 'alice', 'emma', 'isabella', 'lily', 'daniel',
  'fable', 'george', 'lewis'
];

// Add interface for transition batch progress
interface TransitionBatchProgress {
  total_batches: number;
  completed_batches: number;
  batch_outputs: string[];
  total_videos: number;
}

// Updated utility functions to match backend logic exactly
function getVoiceType(voice: string, modelVersion?: string): 'premium' | 'core' | 'clone' | 'standard' {
  if (PREMIUM_VOICES.includes(voice)) return 'premium';
  if (CORE_VOICES.includes(voice) || modelVersion === 'lemonfox') return 'core';
  if (CLONE_VOICES.includes(voice) || modelVersion === 'clone') return 'clone';
  return 'standard';
}

function calculateAudioBatchInfo(wordCount: number, voice: string, modelVersion?: string) {
  let wordsPerBatch: number;
  let secondsPerBatch: number;
  
  // UPDATED: Prioritize model_version to match TextToSpeech logic
  // TextToSpeech uses: v7=10s, lemonfox=30s, speechify=5s, v6=60s, default=30s
  if (modelVersion === 'v7') {
    wordsPerBatch = 200;
    secondsPerBatch = 10; // v7 takes 10 seconds per batch
  } else if (modelVersion === 'lemonfox') {
    wordsPerBatch = 200;
    secondsPerBatch = 30; // lemonfox takes 30 seconds per batch
  } else if (modelVersion === 'speechify') {
    wordsPerBatch = 250;
    secondsPerBatch = 5; // speechify takes 5 seconds per batch
  } else {
    // Fallback to voice type if model_version is not specified or unknown
    const voiceType = getVoiceType(voice, modelVersion);
    
    switch (voiceType) {
      case 'premium':
        wordsPerBatch = 200;
        secondsPerBatch = TIMING.AUDIO_BATCH_PREMIUM; // 10s
        break;
      case 'core':
        wordsPerBatch = 200;
        secondsPerBatch = TIMING.AUDIO_BATCH_CORE; // 10s
        break;
      case 'clone':
        wordsPerBatch = 40;
        secondsPerBatch = TIMING.AUDIO_BATCH_CLONE; // 10s
        break;
      default:
        wordsPerBatch = 250;
        secondsPerBatch = TIMING.AUDIO_BATCH_STANDARD; // 20s
    }
  }
  
  const totalBatches = Math.ceil(wordCount / wordsPerBatch);
  return { totalBatches, secondsPerBatch };
}

function calculateImagePromptBatchInfo(numImages: number, restFrequency: number) {
  // Match backend logic exactly
  const totalBatches = restFrequency > 120 
    ? numImages  // Same as images in amount
    : Math.ceil(numImages / 2); // Images / 2 for batches
  return { totalBatches, secondsPerBatch: TIMING.IMAGE_PROMPT_BATCH };
}

/**
 * Context object for the shared per-stage video time estimator.
 * Callers pass what they know from `mainTask`; missing fields fall back to safe defaults.
 */
export interface VideoBatchTimeContext {
  totalAudioDuration?: number;        // S_audio (seconds)
  numImages?: number;                 // total clips/images in pipeline
  hasTransitions?: boolean;
  hasOverlay?: boolean;               // animation_type or effects_type set (legacy)
  hasSubtitles?: boolean;
  useExistingAudio?: boolean;
  durations?: number[] | null;
  /**
   * Explicit overlay configuration. When provided, drives the per-clip
   * image-to-video-processor cost via the calibrated ANIM_MULT \xD7 EFFECT_MULT
   * tables \u2014 much more accurate than the legacy `hasOverlay` boolean for
   * heavy combos like ken_burns + fire_flare (~9\xD7 perVideoSec).
   */
  animationType?: string | null;
  effectsType?: string | null;
  /**
   * Sum (in seconds) of `video_durations[i]` for image numbers covered by
   * doc_id batches that have completed. When provided, replaces the
   * approximate `S_audio * (completedBatches / totalBatches)` calculation \u2014
   * accounts for non-uniform clip durations.
   */
  completedRowSeconds?: number;
}

/**
 * Calculate remaining video time using the shared per-stage estimator.
 * Replaces the old 30-min-per-row math. Always adds a 30 min wall-clock buffer
 * so the display never reaches 0 until the task is truly `completed_final`.
 *
 * Per-stage accuracy:
 *  - Image pipeline: scales remaining `imageToVideo` cost by the actual sum of
 *    completed clip durations (`context.completedRowSeconds`) when supplied;
 *    otherwise falls back to a uniform `completedBatches / totalBatches` split.
 *  - Transitions: scales the `tFinalRender` transition pass by
 *    `completedTransitions / totalTransitions` so the estimate shrinks as
 *    transition batches finish.
 *  - TTV/ITV: clip generation happens in earlier phases (ttvGeneration /
 *    itvGeneration); the video phase here is final-render only.
 */
export function calculateVideoBatchTime(
  completedBatches: number,
  totalBatches: number,
  completedTransitions: number = 0,
  totalTransitions: number = 0,
  visualType: 'image' | 'ttv' | 'itv' | 'mg' = 'image',
  context: VideoBatchTimeContext = {}
): number {
  // Resolve S_audio. The main video_tasks row sometimes has `total_audio_duration`
  // null (e.g. when the row was upserted before compile-audio finished writing it).
  // In that case we still usually have `video_durations` populated, so fall back
  // to the sum of those entries — without this fallback, S_audio=0 collapses
  // tImageToVideo/tFinalRender to constants and the displayed estimate drops to
  // ~30 min (just the wall-clock buffer), making "from nothing" runs misleadingly
  // appear shorter than "existing components" runs.
  let S_audio = context.totalAudioDuration && context.totalAudioDuration > 0
    ? context.totalAudioDuration
    : 0;
  if (S_audio <= 0 && context.durations && context.durations.length > 0) {
    S_audio = context.durations.reduce((a, b) => a + (Number(b) || 0), 0);
  }
  const N_images = context.numImages ?? totalBatches;
  // Prefer the actual sum of completed durations when caller computed it from
  // video_durations + per-batch ranges; otherwise fall back to even-split estimate.
  const completedRowSeconds = (context.completedRowSeconds != null && context.completedRowSeconds >= 0)
    ? context.completedRowSeconds
    : (totalBatches > 0
        ? S_audio * Math.min(1, completedBatches / totalBatches)
        : 0);

  // Phase logic: stay in `imageToVideo` while ANY batch is still pending — only
  // switch to `finalRender` once all ITV batches are done. This prevents the
  // estimator from skipping the remaining ~70% of ITV work the moment the first
  // batch completes (which previously caused the displayed estimate to drop by
  // ~6 minutes after every batch finished). `tImageToVideo` already scales
  // remaining work via `(1 - fractionComplete)` using `completedRowSeconds`.
  const allBatchesDone = totalBatches > 0 && completedBatches >= totalBatches;
  const phase: PipelinePhase = allBatchesDone ? 'finalRender' : 'imageToVideo';
  const remaining = estimateRemainingSeconds({
    phase,
    N_images,
    S_audio,
    durations: context.durations ?? null,
    visualType,
    hasTransitions: context.hasTransitions ?? (totalTransitions > 0),
    hasOverlay: context.hasOverlay ?? false,
    hasSubtitles: context.hasSubtitles ?? false,
    useExistingAudio: context.useExistingAudio ?? false,
    animationType: context.animationType ?? null,
    effectsType: context.effectsType ?? null,
    completedRowSeconds,
    completedTransitions,
    totalTransitions,
  });
  // +30 min wall-clock buffer so the display never hits 0 until completed_final.
  const totalSeconds = remaining + 30 * 60;
  console.log(`[calculateVideoBatchTime] V/T: ${completedBatches}/${totalBatches} (${Math.round(completedRowSeconds)}s of ${Math.round(S_audio)}s), transitions: ${completedTransitions}/${totalTransitions}, visualType: ${visualType}, remaining=${Math.round(remaining)}s + 30min buffer = ${Math.round(totalSeconds / 60)} min`);
  return totalSeconds;
}

// UPDATED: Enhanced function to properly calculate ALL remaining time across all phases with processing flags
function calculateRemainingTime(
  currentProcess: 'story' | 'imagePrompt' | 'imageGeneration' | 'audio' | 'video' | 'ttvPrompt' | 'ttvGeneration' | 'itvPrompt' | 'itvImageGeneration' | 'itvGeneration' | 'mgPrompt' | 'mgGeneration',
  currentProgress: number,
  currentTotalBatches: number,
  options: {
    wordCount: number;
    numImages: number;
    voice: string;
    modelVersion?: string;
    imageModel?: string; // Image quality model for dynamic timing
    restFrequency: number;
    needsStoryGeneration: boolean;
    needsImageGeneration: boolean;
    needsAudioGeneration: boolean;
    useExistingImages: boolean;
    videoCreationStatus?: 'pending' | 'running';
    transitionType?: string | null; // Added for transition type
    hasVideoLoop?: boolean; // NEW PARAMETER
    totalAudioDuration?: number; // NEW: For duration-based batch calculation
    // NEW: Transition batch progress tracking
    isTransitionProcessing?: boolean;
    transitionBatchProgress?: TransitionBatchProgress | null;
    // NEW: Processing control flags
    video?: boolean;
    processStory?: boolean;
    processImages?: boolean;
    processAudio?: boolean;
    // Visual pipeline type
    visualType?: 'image' | 'ttv' | 'itv' | 'mg';
    videoModel?: string;  // TTV video model (for clip generation timing)
    itvModel?: string;    // ITV video model (for clip generation timing)
  }
): number {
  let totalRemainingSeconds = 0;
  
  const {
    wordCount,
    numImages,
    voice,
    modelVersion,
    imageModel,
    restFrequency,
    needsStoryGeneration,
    needsImageGeneration,
    needsAudioGeneration,
    useExistingImages,
    videoCreationStatus,
    transitionType,
    hasVideoLoop,
    totalAudioDuration,
    isTransitionProcessing,
    transitionBatchProgress,
    // NEW: Processing control flags with defaults
    video = true,
    processStory = true,
    processImages = true,
    processAudio = true
  } = options;
  const videoModel = (options as any).videoModel as string | undefined;
  const itvModel = (options as any).itvModel as string | undefined;

  console.log('=== calculateRemainingTime DEBUG ===');
  console.log('currentProcess:', currentProcess);
  console.log('currentProgress:', currentProgress);
  console.log('currentTotalBatches:', currentTotalBatches);
  console.log('imageModel:', imageModel);
  console.log('videoModel:', videoModel);
  console.log('itvModel:', itvModel);
  console.log('visualType:', options.visualType);
  console.log('numImages:', numImages);
  console.log('wordCount:', wordCount);
  console.log('videoCreationStatus:', videoCreationStatus);
  console.log('transitionType:', transitionType);
  console.log('hasVideoLoop:', hasVideoLoop);
  console.log('isTransitionProcessing:', isTransitionProcessing);
  console.log('transitionBatchProgress:', transitionBatchProgress);
  console.log('needsStoryGeneration:', needsStoryGeneration);
  console.log('needsImageGeneration:', needsImageGeneration);
  console.log('needsAudioGeneration:', needsAudioGeneration);
  console.log('useExistingImages:', useExistingImages);
  // NEW: Log processing control flags
  console.log('video:', video);
  console.log('processStory:', processStory);
  console.log('processImages:', processImages);
  console.log('processAudio:', processAudio);

  // Handle transition processing — use shared per-stage estimator + 30 min wall-clock buffer.
  if (currentProcess === 'video' && isTransitionProcessing && transitionBatchProgress) {
    const totalDurationTr = totalAudioDuration || (wordCount / 125) * 60;
    const remainingTr = estimateRemainingSeconds({
      phase: 'finalRender',
      N_images: numImages,
      S_audio: totalDurationTr,
      durations: null,
      visualType: options.visualType || 'image',
      hasTransitions: true,
      hasOverlay: false,
      hasSubtitles: false,
      useExistingAudio: false,
      // For final-render phase, image-to-video is already done; pass full
      // S_audio so any leftover imageToVideo math is zeroed out.
      completedRowSeconds: totalDurationTr,
      completedTransitions: transitionBatchProgress.completed_batches,
      totalTransitions: transitionBatchProgress.total_batches,
    });
    totalRemainingSeconds = remainingTr + 30 * 60;
    console.log(`Transition time (shared estimator): ${transitionBatchProgress.completed_batches}/${transitionBatchProgress.total_batches} done, remaining=${Math.round(remainingTr)}s + 30min buffer = ${Math.round(totalRemainingSeconds / 60)} min`);
    return Math.ceil(totalRemainingSeconds / 60);
  }

  // Calculate remaining time for current process
  const currentCompletedBatches = Math.floor((currentProgress / 100) * currentTotalBatches);
  const currentRemainingBatches = Math.max(0, currentTotalBatches - currentCompletedBatches);
  
  switch (currentProcess) {
    case 'story':
      totalRemainingSeconds += currentRemainingBatches * TIMING.STORY_BATCH;
      console.log('Story calculation:', currentRemainingBatches, '×', TIMING.STORY_BATCH, 's =', currentRemainingBatches * TIMING.STORY_BATCH, 's');
      break;
    case 'imagePrompt':
      totalRemainingSeconds += currentRemainingBatches * TIMING.IMAGE_PROMPT_BATCH;
      console.log('Image prompt calculation:', currentRemainingBatches, '×', TIMING.IMAGE_PROMPT_BATCH, 's =', currentRemainingBatches * TIMING.IMAGE_PROMPT_BATCH, 's');
      break;
    case 'imageGeneration':
      const timePerImage = getTimePerImageInSeconds(imageModel);
      totalRemainingSeconds += currentRemainingBatches * timePerImage;
      console.log('Image generation calculation:', currentRemainingBatches, '×', timePerImage, 's (model:', imageModel || 'default', ') =', currentRemainingBatches * timePerImage, 's');
      break;
    case 'audio':
      const { secondsPerBatch } = calculateAudioBatchInfo(wordCount, voice, modelVersion);
      totalRemainingSeconds += currentRemainingBatches * secondsPerBatch;
      console.log('Audio calculation:', currentRemainingBatches, '×', secondsPerBatch, 's =', currentRemainingBatches * secondsPerBatch, 's');
      break;
    case 'ttvPrompt':
      totalRemainingSeconds += currentRemainingBatches * TIMING.TTV_PROMPT_BATCH;
      console.log('TTV prompt calculation:', currentRemainingBatches, '×', TIMING.TTV_PROMPT_BATCH, 's =', currentRemainingBatches * TIMING.TTV_PROMPT_BATCH, 's');
      break;
    case 'ttvGeneration': {
      const ttvSecsPerClip = getTTVSecsPerClip(videoModel);
      totalRemainingSeconds += currentRemainingBatches * ttvSecsPerClip;
      console.log('TTV generation calculation:', currentRemainingBatches, '×', ttvSecsPerClip, 's (', videoModel, ') =', currentRemainingBatches * ttvSecsPerClip, 's');
      break;
    }
    case 'itvPrompt':
      totalRemainingSeconds += currentRemainingBatches * TIMING.ITV_PROMPT_BATCH;
      console.log('ITV prompt calculation:', currentRemainingBatches, '×', TIMING.ITV_PROMPT_BATCH, 's =', currentRemainingBatches * TIMING.ITV_PROMPT_BATCH, 's');
      break;
    case 'itvImageGeneration': {
      const itvTimePerImage = getTimePerImageInSeconds(imageModel);
      totalRemainingSeconds += currentRemainingBatches * itvTimePerImage;
      console.log('ITV image generation calculation:', currentRemainingBatches, '×', itvTimePerImage, 's =', currentRemainingBatches * itvTimePerImage, 's');
      break;
    }
    case 'itvGeneration': {
      const itvSecsPerClip = getITVSecsPerClip(itvModel);
      totalRemainingSeconds += currentRemainingBatches * itvSecsPerClip;
      console.log('ITV video generation calculation:', currentRemainingBatches, '×', itvSecsPerClip, 's (', itvModel, ') =', currentRemainingBatches * itvSecsPerClip, 's');
      break;
    }
    case 'mgPrompt':
      totalRemainingSeconds += currentRemainingBatches * TIMING.TTV_PROMPT_BATCH;
      console.log('MG prompt calculation:', currentRemainingBatches, '×', TIMING.TTV_PROMPT_BATCH, 's =', currentRemainingBatches * TIMING.TTV_PROMPT_BATCH, 's');
      break;
    case 'mgGeneration': {
      const mgSecsPerClip = 180;
      totalRemainingSeconds += currentRemainingBatches * mgSecsPerClip;
      console.log('MG render calculation:', currentRemainingBatches, '×', mgSecsPerClip, 's =', currentRemainingBatches * mgSecsPerClip, 's');
      break;
    }
    case 'video':
      // Video calculation now uses the shared per-stage estimator (matches GCF runtime).
      if (hasVideoLoop) {
        if (videoCreationStatus === 'pending') {
          totalRemainingSeconds += 30 * 60;
          console.log('Video loop calculation (pending): 30 min fixed');
        } else {
          totalRemainingSeconds += 15 * 60;
          console.log('Video loop calculation (running): 15 min fixed');
        }
      } else {
        const visualType = options.visualType || 'image';
        const totalDuration = totalAudioDuration || (wordCount / 125) * 60;
        const N_for_video = visualType === 'ttv' ? numImages : numImages;
        // Per-row progress maps to completedRowSeconds (sum of clip durations completed).
        const fractionDone = currentTotalBatches > 0
          ? Math.min(1, currentCompletedBatches / currentTotalBatches)
          : 0;
        const completedRowSeconds = totalDuration * fractionDone;
        // Phase: stay in `imageToVideo` until ALL batches finish — switching
        // to `finalRender` mid-pipeline drops the remaining ITV cost from the
        // estimate. `tImageToVideo` already scales by `(1 - fractionComplete)`.
        const allBatchesDone = currentTotalBatches > 0 && currentCompletedBatches >= currentTotalBatches;
        const phase: PipelinePhase = videoCreationStatus === 'pending'
          ? 'audioDuration'
          : (allBatchesDone ? 'finalRender' : 'imageToVideo');
        const videoSeconds = estimateRemainingSeconds({
          phase,
          N_images: N_for_video,
          S_audio: totalDuration,
          durations: null,
          visualType,
          hasTransitions: transitionType === 'dissolve',
          hasOverlay: false,
          hasSubtitles: false,
          useExistingAudio: false,
          completedRowSeconds,
        });
        totalRemainingSeconds += videoSeconds;
        console.log('Video remaining (shared estimator):', {
          phase, visualType,
          N: N_for_video,
          S_audio: Math.round(totalDuration),
          completedRowSeconds: Math.round(completedRowSeconds),
          remainingSec: Math.round(videoSeconds),
        });
      }
      break;
  }

  // UPDATED: Add time for ALL future processes regardless of current process, but respect processing flags
  
  // Story generation time (if not current process and enabled and still needed)
  if (currentProcess !== 'story' && processStory && needsStoryGeneration) {
    const storyBatches = Math.ceil(wordCount / 500); // 500 words per batch
    const storyTime = storyBatches * TIMING.STORY_BATCH;
    totalRemainingSeconds += storyTime;
    console.log('Future story time:', storyBatches, '×', TIMING.STORY_BATCH, 's =', storyTime, 's');
  }
  
  // Visual pipeline future time - depends on visualType
  const visualType = options.visualType || 'image';

  if (visualType === 'ttv') {
    // TTV Pipeline: TTV Prompts → TTV Generation
    if (currentProcess !== 'ttvPrompt' && processImages && needsImageGeneration && !useExistingImages) {
      const ttvPromptBatches = Math.ceil(numImages / 2);
      const ttvPromptTime = ttvPromptBatches * TIMING.TTV_PROMPT_BATCH;
      totalRemainingSeconds += ttvPromptTime;
      console.log('Future TTV prompt time:', ttvPromptBatches, '×', TIMING.TTV_PROMPT_BATCH, 's =', ttvPromptTime, 's');
    }
    if (currentProcess !== 'ttvGeneration' && processImages && needsImageGeneration && !useExistingImages) {
      const ttvSecsPerClipFuture = getTTVSecsPerClip(videoModel);
      const ttvGenTime = numImages * ttvSecsPerClipFuture;
      totalRemainingSeconds += ttvGenTime;
      console.log('Future TTV generation time:', numImages, '×', ttvSecsPerClipFuture, 's (', videoModel, ') =', ttvGenTime, 's');
    }
  } else if (visualType === 'itv') {
    // ITV Pipeline: ITV Image Prompts (P1) → [ITV Image Generation (P2) ‖ ITV Video Prompts (P3)] → ITV Video Generation (P4)
    // IMPORTANT: P2 (itvImageGeneration) and P3 (itvPrompt) run CONCURRENTLY.
    // When one is the currentProcess, skip the other — their wall-clock overlap
    // means only max(P2, P3) matters. The caller (VideoGenerator) handles the
    // Math.max() logic with actual progress from both phases.
    if (currentProcess !== 'itvPrompt' && currentProcess !== 'itvImageGeneration' && processImages && needsImageGeneration && !useExistingImages) {
      // Only add itvPrompt future time when neither concurrent phase is the current process
      const itvPromptBatches = Math.ceil(numImages / 2);
      const itvPromptTime = itvPromptBatches * TIMING.ITV_PROMPT_BATCH;
      totalRemainingSeconds += itvPromptTime;
      console.log('Future ITV prompt time:', itvPromptBatches, '×', TIMING.ITV_PROMPT_BATCH, 's =', itvPromptTime, 's');
    }
    if (currentProcess !== 'itvImageGeneration' && currentProcess !== 'itvPrompt' && processImages && needsImageGeneration && !useExistingImages) {
      // Only add itvImageGeneration future time when neither concurrent phase is the current process
      const itvImgTimePerImage = getTimePerImageInSeconds(imageModel);
      const itvImageGenTime = numImages * itvImgTimePerImage;
      totalRemainingSeconds += itvImageGenTime;
      console.log('Future ITV image generation time:', numImages, '×', itvImgTimePerImage, 's =', itvImageGenTime, 's');
    }
    if (currentProcess !== 'itvGeneration' && processImages && needsImageGeneration && !useExistingImages) {
      const itvSecsPerClipFuture = getITVSecsPerClip(itvModel);
      const itvVidGenTime = numImages * itvSecsPerClipFuture;
      totalRemainingSeconds += itvVidGenTime;
      console.log('Future ITV video generation time:', numImages, '×', itvSecsPerClipFuture, 's (', itvModel, ') =', itvVidGenTime, 's');
    }
  } else if (visualType === 'mg') {
    // MG Pipeline: MG Prompts → MG Render (code-gen + remotion render per clip)
    if (currentProcess !== 'mgPrompt' && processImages && needsImageGeneration && !useExistingImages) {
      const mgPromptBatches = Math.ceil(numImages / 2);
      const mgPromptTime = mgPromptBatches * TIMING.TTV_PROMPT_BATCH;
      totalRemainingSeconds += mgPromptTime;
      console.log('Future MG prompt time:', mgPromptBatches, '×', TIMING.TTV_PROMPT_BATCH, 's =', mgPromptTime, 's');
    }
    if (currentProcess !== 'mgGeneration' && processImages && needsImageGeneration && !useExistingImages) {
      const mgSecsPerClipFuture = 180;
      const mgGenTime = numImages * mgSecsPerClipFuture;
      totalRemainingSeconds += mgGenTime;
      console.log('Future MG render time:', numImages, '×', mgSecsPerClipFuture, 's =', mgGenTime, 's');
    }
  } else {
    // Standard Image Pipeline: Image Prompts → Image Generation
    if (currentProcess !== 'imagePrompt' && processImages && needsImageGeneration && !useExistingImages) {
      let promptBatches: number;
      if (restFrequency > 120) {
        promptBatches = numImages; // Same as images in amount
      } else {
        promptBatches = Math.ceil(numImages / 2); // Images / 2 for batches
      }
      const imagePromptTime = promptBatches * TIMING.IMAGE_PROMPT_BATCH;
      totalRemainingSeconds += imagePromptTime;
      console.log('Future image prompt time:', promptBatches, '×', TIMING.IMAGE_PROMPT_BATCH, 's =', imagePromptTime, 's');
    }
    if (currentProcess !== 'imageGeneration' && processImages && needsImageGeneration && !useExistingImages) {
      const timePerImage = getTimePerImageInSeconds(imageModel);
      const imageGenTime = numImages * timePerImage;
      totalRemainingSeconds += imageGenTime;
      console.log('Future image generation time:', numImages, '×', timePerImage, 's (model:', imageModel || 'default', ') =', imageGenTime, 's');
    }
  }
  
  // Audio generation time (if not current process and enabled and still needed)
  if (currentProcess !== 'audio' && processAudio && needsAudioGeneration) {
    const { totalBatches, secondsPerBatch } = calculateAudioBatchInfo(wordCount, voice, modelVersion);
    const audioTime = totalBatches * secondsPerBatch;
    totalRemainingSeconds += audioTime;
    console.log('Future audio time:', totalBatches, '×', secondsPerBatch, 's =', audioTime, 's');
  }
  
  // Video processing time (if not current process and video creation is enabled)
  if (currentProcess !== 'video' && video) {
    if (hasVideoLoop) {
      if (videoCreationStatus === 'pending') {
        totalRemainingSeconds += 30 * 60;
        console.log('Future video loop time (pending): 30 min fixed');
      } else {
        totalRemainingSeconds += 15 * 60;
        console.log('Future video loop time (running): 15 min fixed');
      }
    } else {
      const totalDuration = totalAudioDuration || (wordCount / 125) * 60;
      const breakdown = estimateVideoPipelineSeconds({
        N_images: numImages,
        S_audio: totalDuration,
        durations: null,
        visualType,
        hasTransitions: transitionType === 'dissolve',
        hasOverlay: false,
        hasSubtitles: false,
        useExistingAudio: false,
      });
      totalRemainingSeconds += breakdown.totalWithPad;
      console.log('Future video time (shared estimator):', {
        visualType,
        N: numImages,
        S_audio: Math.round(totalDuration),
        useHighMemory: breakdown.useHighMemory,
        totalWithPad: Math.round(breakdown.totalWithPad),
      });
    }
  } else if (!video) {
    console.log('Video creation disabled - skipping video time calculation');
  }

  // +30 min wall-clock polling buffer so the displayed time never hits 0
  // until the task is truly `completed_final` (matches the cap-at-90% UI rule).
  totalRemainingSeconds += 30 * 60;

  // Convert to minutes and round
  const totalTimeMinutes = Math.ceil(totalRemainingSeconds / 60);
  console.log('Total remaining seconds (incl 30min polling buffer):', totalRemainingSeconds);
  console.log('Final totalTimeMinutes:', totalTimeMinutes);
  console.log('=== END DEBUG ===');

  return totalTimeMinutes;
}

/**
 * Calculate remaining time for the ITV pipeline, correctly handling the
 * concurrency between Phase 2 (keyframe image generation) and Phase 3
 * (video/motion prompts).  The ImageToVideoGenerator page uses its own
 * inline version of this logic; this exported helper lets VideoGenerator
 * (and future callers) reuse the same algorithm.
 *
 * Pipeline:
 *   P1 (sequential) → P2 ‖ P3 (concurrent) → P4 (sequential) → assembly
 *
 * @returns Estimated remaining time in **minutes**
 */
function calculateITVConcurrentTime(
  phaseProgress: {
    p1: number; // ITV image prompts progress (0-100)
    p2: number; // Keyframe image generation progress (0-100)
    p3: number; // ITV video prompts progress (0-100)
    p4: number; // ITV video generation progress (0-100)
  },
  numImages: number,
  options: {
    imageModel?: string;
    itvModel?: string;
    includeVideoAssembly?: boolean;
    transitionType?: string | null;
  } = {}
): number {
  const { imageModel, itvModel, includeVideoAssembly = true, transitionType } = options;

  // P1: ITV image prompts (sequential, runs first)
  const p1FullBatches = Math.ceil(numImages / 2);
  const p1Remaining = phaseProgress.p1 < 100
    ? ((100 - phaseProgress.p1) / 100) * p1FullBatches * TIMING.ITV_PROMPT_BATCH
    : 0;

  // P2: Keyframe image generation
  const imgSecs = getTimePerImageInSeconds(imageModel);
  const p2Remaining = phaseProgress.p2 < 100
    ? ((100 - phaseProgress.p2) / 100) * numImages * imgSecs
    : 0;

  // P3: ITV video/motion prompts (concurrent with P2)
  const p3FullBatches = Math.ceil(numImages / 2);
  const p3Remaining = phaseProgress.p3 < 100
    ? ((100 - phaseProgress.p3) / 100) * p3FullBatches * TIMING.ITV_PROMPT_BATCH
    : 0;

  // P4: ITV video generation (waits for both P2 and P3)
  const secsPerClip = getITVSecsPerClip(itvModel);
  const p4Remaining = phaseProgress.p4 < 100
    ? ((100 - phaseProgress.p4) / 100) * numImages * secsPerClip
    : 0;

  // P2 and P3 run concurrently — use the slower one
  let totalSeconds = p1Remaining + Math.max(p2Remaining, p3Remaining) + p4Remaining;

  // Video assembly time: rows of ~20 clips at 20min each + transitions of ~12 clips at 10min each + 30min buffer
  if (includeVideoAssembly) {
    const assemblyRows = Math.ceil(numImages / TIMING.TTV_ITV_CLIPS_PER_ROW);
    totalSeconds += assemblyRows * TIMING.TTV_ITV_VIDEO_ROW_TIME;
    if (transitionType === 'dissolve') {
      totalSeconds += Math.ceil(numImages / TIMING.TTV_ITV_CLIPS_PER_TRANSITION) * TIMING.TTV_ITV_TRANSITION_TIME;
    }
    totalSeconds += TIMING.TTV_ITV_ASSEMBLY_BUFFER;
  }

  console.log('[calculateITVConcurrentTime]',
    `P1=${phaseProgress.p1}% (${Math.round(p1Remaining)}s)`,
    `P2=${phaseProgress.p2}% (${Math.round(p2Remaining)}s)`,
    `P3=${phaseProgress.p3}% (${Math.round(p3Remaining)}s)`,
    `P4=${phaseProgress.p4}% (${Math.round(p4Remaining)}s)`,
    `max(P2,P3)=${Math.round(Math.max(p2Remaining, p3Remaining))}s`,
    `total=${Math.round(totalSeconds)}s (${Math.ceil(totalSeconds / 60)}min)`);

  return Math.ceil(totalSeconds / 60);
}

// Helper function to count images in storage folder
async function countImagesInPath(folderPath: string): Promise<number> {
  try {
    const { data: files, error } = await supabase.storage
      .from('stories')
      .list(folderPath);
    
    if (error) {
      console.warn(`Could not list files in folder ${folderPath}:`, error);
      return 1; // Default fallback
    }
    
    // Filter for .png files only
    const imageFiles = files?.filter(file => 
      file.name.toLowerCase().endsWith('.png')
    ) || [];
    
    return imageFiles.length || 1; // Default to 1 if no images found
  } catch (error) {
    console.warn(`Error counting images in folder ${folderPath}:`, error);
    return 1; // Default fallback
  }
}

