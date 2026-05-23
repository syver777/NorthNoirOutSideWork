import React, { useState, useEffect, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { Video, AlertCircle, CheckCircle2, Download, RefreshCw, X, Play, Lock, Eye, BookOpen, ChevronDown, Info, AlertTriangle, Trash2 } from 'lucide-react';
import { Listbox, Transition } from '@headlessui/react';
import DashboardLayout from '../components/DashboardLayout';
import VideoConfiguration from '../components/VideoConfiguration';
import ConfigurationSteps from '../components/ConfigurationSteps';
import type { SelectedElevenLabsVoice } from '../components/ElevenLabsVoiceBrowser';
import { DEFAULT_ELEVENLABS_MODEL_ID } from '../data/elevenlabsModels';
import SubtitleConfiguration, { DEFAULT_SUBTITLE_CONFIG, type SubtitleConfig } from '../components/SubtitleConfiguration';
import ComponentsCompletionScreen from '../components/ComponentsCompletionScreen';
import TabManager from '../components/TabManager';
import LargeVideoDownloadModal from '../components/LargeVideoDownloadModal';
import { createClient } from '@supabase/supabase-js';
import { Link, useNavigate } from 'react-router-dom';
import { calculateRemainingTime, calculateVideoBatchTime, calculateITVConcurrentTime } from '../utils/storyTaskPolling';
import { estimateVideoPipelineSeconds, type PipelinePhase } from '../utils/timeEstimates';
import { MG_DEFAULT_STYLE_SLUG, MG_DEFAULT_CLIP_SECONDS, resolveStyleGuidance } from '../data/mgStyles';
import { estimateMgTokenCost } from '../utils/mgCostConstants';

/**
 * Compute a baseline "time remaining" estimate (minutes) from a video_tasks main row.
 * Used on initial page load / fallback so the user never sees "0m" while a generation is
 * still running. Always adds the standard +30 min wall-clock buffer.
 *
 * Reads available DB columns: total_audio_duration, total_individual_videos / image_amount,
 * video_durations (dict like {"1": 49.08, ...} OR array), visual_type, transition_type,
 * animation_type, effects_type, subtitles, use_existing_audio, *_status fields.
 */
function computeInitialTimeRemainingMinutes(mainTaskRow: any): number | null {
  if (!mainTaskRow) return null;

  const visualType = (mainTaskRow.visual_type || 'image') as 'image' | 'ttv' | 'itv' | 'mg';
  const settings = mainTaskRow.settings || {};
  const wordCount = Number(mainTaskRow.word_count || settings.word_count || 0);

  // video_durations may be stored as either an array or a dict { "1": 49.08, ... }
  let durations: number[] | null = null;
  const vd = mainTaskRow.video_durations;
  if (Array.isArray(vd)) {
    durations = vd.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  } else if (vd && typeof vd === 'object') {
    durations = Object.values(vd).map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  }
  if (durations && durations.length === 0) durations = null;

  // Resolve S_audio with fallbacks: column → sum(video_durations) → wpm estimate.
  // The middle fallback matters when total_audio_duration was never written to
  // the main row (e.g. compile-audio raced with row upsert) but per-clip
  // durations were captured anyway — without it, S_audio=0 collapses the
  // image-to-video / final-render estimates and the user sees only the +30 min
  // wall-clock buffer (≈ 31m) instead of the real remaining time.
  const durationsSum = durations ? durations.reduce((a, b) => a + b, 0) : 0;
  const S_audio = Number(mainTaskRow.total_audio_duration) > 0
    ? Number(mainTaskRow.total_audio_duration)
    : (durationsSum > 0
      ? durationsSum
      : (wordCount > 0 ? (wordCount / 125) * 60 : 0)); // ~125 wpm fallback

  const N_images = Number(
    mainTaskRow.total_individual_videos
    ?? mainTaskRow.image_amount
    ?? settings.estimated_image_count
    ?? 1
  ) || 1;

  // Determine current phase from status columns so the estimator only counts
  // remaining stages (rather than the full pipeline) when we're mid-generation.
  let phase: PipelinePhase = 'pre';
  if (mainTaskRow.overall_status === 'completed_final') {
    phase = 'done';
  } else if (mainTaskRow.video_creation_status === 'running' || mainTaskRow.video_creation_status === 'completed') {
    phase = 'imageToVideo';
  } else if (mainTaskRow.audio_status === 'running' || mainTaskRow.audio_status === 'completed') {
    phase = 'audioDuration';
  }

  const breakdown = estimateVideoPipelineSeconds({
    visualType,
    N_images,
    S_audio,
    durations,
    hasTransitions: !!mainTaskRow.transition_type,
    hasOverlay: !!(mainTaskRow.animation_type || mainTaskRow.effects_type),
    hasSubtitles: !!mainTaskRow.subtitles,
    useExistingAudio: !!mainTaskRow.use_existing_audio,
    animationType: (mainTaskRow.animation_type as string | null) ?? null,
    effectsType: (mainTaskRow.effects_type as string | null) ?? null,
  });

  // Phase-aware remaining (rough — only used as a baseline before periodic refresh runs).
  // For simplicity, scale total by the share of stages still ahead.
  let remainingSeconds = breakdown.totalWithPad;
  if (phase === 'imageToVideo') {
    remainingSeconds = breakdown.imageToVideo + breakdown.finalRender + breakdown.subtitles;
  } else if (phase === 'audioDuration') {
    remainingSeconds = breakdown.audioDuration + breakdown.audioBoost + breakdown.calcDurations
      + breakdown.imageToVideo + breakdown.finalRender + breakdown.subtitles;
  }
  // Always add the 30 min wall-clock buffer (matches estimator usage elsewhere).
  remainingSeconds += 30 * 60;

  return Math.max(1, Math.ceil(remainingSeconds / 60));
}

/**
 * Sum the durations (seconds) of all clips covered by completed video batches.
 *
 * `video_durations` is a dict keyed by 1-indexed image number (e.g.
 * {"1": 49.08, "2": 55.13, ...}). Each batch row covers a contiguous range
 * `processing_batch_start..processing_batch_end`. For every batch that has
 * `video_creation_status === 'completed'` (or `overall_status === 'completed'`),
 * we sum the durations of all images in its range. Returns null if we don't
 * have enough information to compute it (so callers can fall back).
 */
function sumCompletedClipSeconds(
  videoBatches: Array<any>,
  videoDurations: Record<string, number> | number[] | null | undefined,
): number | null {
  if (!videoBatches || videoBatches.length === 0) return null;
  if (!videoDurations) return null;

  // Normalise to a 1-indexed lookup (string keys) regardless of source shape.
  const lookup: Record<string, number> = {};
  if (Array.isArray(videoDurations)) {
    videoDurations.forEach((v, i) => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) lookup[String(i + 1)] = n;
    });
  } else if (typeof videoDurations === 'object') {
    for (const [k, v] of Object.entries(videoDurations)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) lookup[String(k)] = n;
    }
  }
  if (Object.keys(lookup).length === 0) return null;

  let total = 0;
  for (const b of videoBatches) {
    const isDone = b.video_creation_status === 'completed' || b.overall_status === 'completed';
    if (!isDone) continue;
    const start = Number(b.processing_batch_start);
    const end = Number(b.processing_batch_end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    for (let i = start; i <= end; i++) {
      const d = lookup[String(i)];
      if (Number.isFinite(d)) total += d;
    }
  }
  return total;
}

/**
 * Compute the time-remaining (minutes) for a video task by querying its batch
 * rows and applying the same per-batch estimator the periodic refresh uses.
 *
 * Used by all three init paths (initializeFromDatabase, checkExistingTasks,
 * periodic refresh) so the displayed value is identical from the first paint
 * onwards. Returns null if batches can't be fetched (caller should fall back
 * to `computeInitialTimeRemainingMinutes`).
 */
async function computeBatchAwareTimeMinutes(
  userId: string,
  groupId: string,
): Promise<number | null> {
  try {
    const { data: rows } = await supabase
      .from('video_tasks')
      .select('doc_id, transition_type, transition_batch_progress, video_creation_status, overall_status, audio_status, total_audio_duration, total_individual_videos, image_amount, word_count, settings, animation_type, effects_type, subtitles, use_existing_audio, video_durations, visual_type, processing_batch_start, processing_batch_end')
      .eq('user_id', userId)
      .eq('group_id', groupId);

    if (!rows || rows.length === 0) return null;

    const mainCandidates = rows.filter((t: any) => t.is_main || !t.doc_id);
    const mainRow = mainCandidates.find((t: any) => t.video_creation_status === 'running')
      || mainCandidates.find((t: any) => t.is_main)
      || mainCandidates[mainCandidates.length - 1];
    const batches = rows.filter((t: any) => t.doc_id);

    // Pre-batch fallback: while no per-batch sub-rows exist (story/audio/image
    // phase, or just before calculate-video-durations runs), the batch-aware
    // estimator collapses to a flat ~30 min buffer. Use the phase-aware initial
    // estimator on the main row instead so the displayed value decreases as
    // each upstream phase (story → audio → image) completes.
    if (batches.length === 0) {
      return computeInitialTimeRemainingMinutes(mainRow);
    }

    let tbp: any = mainRow?.transition_batch_progress;
    if (typeof tbp === 'string') { try { tbp = JSON.parse(tbp); } catch { tbp = null; } }
    if (tbp && typeof tbp === 'object' && Object.keys(tbp).length === 0) tbp = null;

    const completedVideo = batches.filter((b: any) =>
      b.video_creation_status === 'completed' || b.overall_status === 'completed'
    ).length;
    const completedTransitions = (tbp && tbp.completed_batches) || 0;
    const totalTransitions = (tbp && tbp.total_batches) || 0;
    const completedRowSeconds = sumCompletedClipSeconds(batches, (mainRow as any)?.video_durations);
    const visualType = ((mainRow as any)?.visual_type || 'image') as 'image' | 'ttv' | 'itv' | 'mg';

    const seconds = calculateVideoBatchTime(
      completedVideo,
      batches.length,
      completedTransitions,
      totalTransitions,
      visualType,
      {
        totalAudioDuration: Number((mainRow as any)?.total_audio_duration) || 0,
        numImages: (mainRow as any)?.total_individual_videos ?? batches.length,
        hasTransitions: !!(mainRow as any)?.transition_type,
        hasOverlay: !!((mainRow as any)?.animation_type || (mainRow as any)?.effects_type),
        hasSubtitles: !!(mainRow as any)?.subtitles,
        useExistingAudio: !!(mainRow as any)?.use_existing_audio,
        animationType: ((mainRow as any)?.animation_type as string | null) ?? null,
        effectsType: ((mainRow as any)?.effects_type as string | null) ?? null,
        completedRowSeconds: completedRowSeconds ?? undefined,
        durations: (() => {
          const vd = (mainRow as any)?.video_durations;
          if (Array.isArray(vd)) return vd.map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
          if (vd && typeof vd === 'object') return Object.values(vd).map((v: any) => Number(v)).filter((n: number) => Number.isFinite(n) && n > 0);
          return null;
        })(),
      }
    );
    const minutes = Math.ceil(seconds / 60);
    return minutes > 0 ? minutes : null;
  } catch (err) {
    console.warn('[computeBatchAwareTimeMinutes] failed:', err);
    return null;
  }
}

import { uploadWithTus } from '../utils/tusUpload';
import { 
  saveVideoTabFormInputs, 
  getVideoTabFormInputs
} from '../utils/tabManager';
import { useVideoGenerationState } from '../hooks/useVideoGenerationState';
import { useDatabaseSync } from '../hooks/useDatabaseSync';
import { useTabSessionStorage } from '../hooks/useTabSessionStorage';
import { getStorageLimitGB } from '../utils/storageHelpers';
import { 
  isCoreVoice, 
  isPremiumVoice, 
  isApexVoice, 
  isCloneVoice,
  isElevenLabsVoice,
  predefinedCloneVoices,
  coreVoiceSamples,
  premiumVoiceSamples,
  apexVoiceSamples
} from '../utils/voiceHelpers';
import { 
  getVideoMetadata, 
  withTimeout, 
  withRetry, 
  VideoMetadata
} from '../utils/videoHelpers';
import { 
  estimateImageCount,
  calculateWordCount,
  formatStorageSize
} from '../utils/videoTokenCalculations';
import { estimateStoryTokensForVideo } from '../utils/videoStoryTokens';
import { useIsLegacyPlan } from '../hooks/useIsLegacyPlan';
import { getPlanMaxTokens } from '../data/planMaxTokens';
import { LEGACY_LLM_MULTIPLIERS, NEW_LLM_MULTIPLIERS } from '../data/tokenCosts';
import { 
  formatNumber,
  formatDate,
  sanitizeFileName,
  convertTimeToSeconds,
  deleteUserAudioFolder,
  cleanupSessionCloneVoice
} from '../utils/videoGeneratorUtils';
import { calculateVideoProgress } from '../utils/videoProgressCalculator';
import { isValidNumericInput } from '../utils/shared';
import { fetchWithFallback } from '../utils/fetchWithFallback';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

const MAX_FILE_SIZE_MB = 1;
const MAX_WORD_COUNT = 160000;
const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024 * 1024; // 2GB — show info modal before downloading

// YouTube URL validation
const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[\w-]{11}/;
const validateYoutubeUrl = (url: string): string | null => {
  if (!url.trim()) return null;
  if (!YOUTUBE_URL_REGEX.test(url.trim())) return 'Not a valid YouTube URL';
  return null;
};
const extractYoutubeVideoId = (url: string): string | null => {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
  ];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  return null;
};

// Timeout constants
const OPERATION_TIMEOUT = 30000; // 30 seconds

// Language options
const languageOptions = [
  { value: 'english', label: 'English' },
  { value: 'german', label: 'German' },
  { value: 'spanish', label: 'Spanish' },
  { value: 'french', label: 'French' },
];

// Visual type options for Quick Generate
const visualTypeOptions = [
  { value: 'default', label: 'Default' },
  { value: 'image', label: 'Image Generation' },
  { value: 'ttv', label: 'Text-to-Video' },
  { value: 'itv', label: 'Image-to-Video' },
  // { value: 'mg', label: 'Motion Graphics' }, // Hidden in UI (backend still supports MG)
];

// Minimum token costs for TTV/ITV (cheapest tier plan-video will actually use)
// plan-video requires grok-video tier for TTV, seedance-1.5-pro for ITV.
// Values use the NEW token map (margin plan.txt) — higher than the legacy map, so
// the Quick Generate lower bound stays safe for new-plan users. Legacy users get
// a slightly conservative estimate, which is fine (their real cost is lower).
const MIN_TTV_TOKENS_PER_SEC = 42000; // grok-video new rate (was 30000 legacy)
const MIN_TTV_CLIP_DURATION = 5;
const MIN_ITV_TOKENS_PER_SEC = 49000; // seedance-1.5-pro new rate (was 34800 legacy)
const MIN_ITV_CLIP_DURATION = 5;
const MIN_ITV_IMAGE_TOKENS = 17000; // imagen-4-fast / Lite new rate (was 14000 legacy)
// Cheapest image model + frequency the planner will fall back to for default/image runs.
// rest_frequency = one image every 10 s after max downgrade.
const MIN_DEFAULT_IMAGE_TOKENS = 17000; // imagen-4-fast / Lite (new map)
const MIN_DEFAULT_IMAGE_INTERVAL_SEC = 10;
const QUICK_CHARS_PER_WORD = 5;
const QUICK_AUDIO_TOKENS_PER_CHAR = 4;
const QUICK_SPEECH_SPEED = 0.86;
const QUICK_WORDS_PER_SECOND = 2.08;
const QUICK_TOKEN_PER_WORD = 1.33;
const QUICK_PIPELINE_OVERHEAD = 200000; // duration_calc + final_video_base

/**
 * Estimate the minimum token cost for a visual type at a given runtime.
 * Uses the cheapest models plan-video will accept after all downgrades, on the
 * NEW token map (margin plan.txt). Supports default/image (image-based) and
 * ttv/itv (clip-based). Result is the floor cost — actual jobs may be higher.
 */
function estimateMinTokensForVisualType(
  visualType: 'default' | 'image' | 'ttv' | 'itv' | 'mg',
  runtimeMinutes: number,
): number {
  const runtimeSeconds = runtimeMinutes * 60;
  const effectiveSeconds = runtimeSeconds / QUICK_SPEECH_SPEED;
  const wordCount = Math.round(effectiveSeconds * QUICK_WORDS_PER_SECOND);
  const totalChars = wordCount * QUICK_CHARS_PER_WORD;

  // Fixed costs: story (deepseek) + audio + pipeline
  const storyCost = Math.ceil(wordCount * QUICK_TOKEN_PER_WORD * 1.0 * 1.25);
  const audioCost = totalChars * QUICK_AUDIO_TOKENS_PER_CHAR;

  let visualCost = 0;
  if (visualType === 'ttv') {
    const clipCount = Math.ceil(runtimeSeconds / MIN_TTV_CLIP_DURATION);
    visualCost = clipCount * MIN_TTV_CLIP_DURATION * MIN_TTV_TOKENS_PER_SEC;
    visualCost += Math.ceil(clipCount * 200 * 1.0); // prompt generation (deepseek)
  } else if (visualType === 'itv') {
    const clipCount = Math.ceil(runtimeSeconds / MIN_ITV_CLIP_DURATION);
    visualCost = clipCount * MIN_ITV_CLIP_DURATION * MIN_ITV_TOKENS_PER_SEC;
    visualCost += clipCount * MIN_ITV_IMAGE_TOKENS; // keyframe images
    visualCost += Math.ceil(clipCount * 200 * 1.0);
  } else if (visualType === 'mg') {
    visualCost = estimateMgTokenCost(runtimeSeconds, MG_DEFAULT_CLIP_SECONDS);
  } else {
    // default / image: one Lite image per ~10 s + image-prompt deepseek calls
    const imageCount = Math.ceil(runtimeSeconds / MIN_DEFAULT_IMAGE_INTERVAL_SEC);
    visualCost = imageCount * MIN_DEFAULT_IMAGE_TOKENS;
    visualCost += Math.ceil(imageCount * 150 * 1.0); // image-prompt generation (deepseek)
  }

  return storyCost + audioCost + QUICK_PIPELINE_OVERHEAD + visualCost;
}

/**
 * Calculate the max affordable runtime (in minutes) for a visual type at a given budget.
 * Uses binary search for precision.
 */
function maxAffordableRuntime(
  visualType: 'default' | 'image' | 'ttv' | 'itv' | 'mg',
  tokenBudget: number,
): number {
  let lo = 0, hi = 1200;
  while (hi - lo > 0.05) {
    const mid = (lo + hi) / 2;
    if (estimateMinTokensForVisualType(visualType, mid) <= tokenBudget) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Math.floor(lo * 10) / 10;
}

/**
 * Absolute floor for the Quick Generate budget input. plan-video has a fixed
 * pipeline + story + audio overhead even for very short videos, and any
 * non-trivial visual run needs at least a few hundred K tokens of images.
 * This is the smallest budget we'll ever accept regardless of runtime.
 */
const QUICK_BUDGET_FLOOR_TOKENS = 800_000;

/**
 * Compute the minimum budget required for a given runtime + visual type using
 * the actual cheapest-tier estimator (NEW token map). A 5% safety buffer is
 * added because plan-video itself runs the same math server-side and refuses
 * jobs whose estimated cost is over budget — without the buffer borderline
 * inputs flap between "accepted" and "over budget".
 */
function minBudgetForQuickGenerate(
  visualType: 'default' | 'image' | 'ttv' | 'itv' | 'mg',
  runtimeMinutes: number,
): number {
  const estimate = estimateMinTokensForVisualType(visualType, runtimeMinutes);
  const withBuffer = Math.ceil(estimate * 1.05);
  // Round up to nearest 10K so the displayed minimum looks clean.
  const rounded = Math.ceil(withBuffer / 10_000) * 10_000;
  return Math.max(QUICK_BUDGET_FLOOR_TOKENS, rounded);
}

// Per-model LLM multipliers come from the active plan map. Word/batch caps
// are plan-independent so they live alongside the multiplier in one builder.
function buildModelOptions(isLegacy: boolean) {
  const m = isLegacy ? LEGACY_LLM_MULTIPLIERS : NEW_LLM_MULTIPLIERS;
  return [
    { value: 'deepseek', label: 'Core Model',        tokenMultiplier: m.deepseek, maxWords: 50000,  maxWordsPerBatch: 1100, description: `${m.deepseek}x tokens` },
    { value: 'sonnet',   label: 'Claude Sonnet 4.6', tokenMultiplier: m.sonnet,   maxWords: 150000, maxWordsPerBatch: 3000, description: `${m.sonnet}x tokens` },
    { value: 'opus',     label: 'Claude Opus 4.6',   tokenMultiplier: m.opus,     maxWords: 150000, maxWordsPerBatch: 3000, description: `${m.opus}x tokens` },
  ];
}
const modelOptions = buildModelOptions(true);

interface StoryDocument {
  id: string;
  title: string;
  description?: string;
  is_corrected: boolean;
  version?: number;
  group_id?: string;
  created_at: string;
  file_path: string;
  word_count?: number;
  file_size?: number | null;
  image_model?: string | null;
}

// Map frontend display values to backend values for image_model
// Handles stale session storage that may contain old frontend identifiers
const IMAGE_MODEL_FRONTEND_TO_BACKEND: Record<string, string> = {
  'spark': 'flux-2-dev',
  'grok': 'grok-imagine-image',
  'standard': 'imagen-4-fast',
  'plus': 'gpt-image-1-mini',
  'prime': 'seedream-4.5',
  'premium': 'imagen-4-ultra',
  'genesis': 'nano-banana-pro',
};
const resolveImageModelBackend = (model: string): string =>
  IMAGE_MODEL_FRONTEND_TO_BACKEND[model] || model;

interface VideoSettings {
  storySource: 'new' | 'existing' | 'upload';
  storyTitle: string;
  storyDescription: string;
  wordCount: string;
  language: string;
  model: string; // Story generation model
  imageModel: 'flux-2-dev' | 'grok-imagine-image' | 'imagen-4-fast' | 'gpt-image-1-mini' | 'seedream-4.5' | 'imagen-4-ultra' | 'nano-banana-pro'; // Image quality model
  imagePromptModel: string; // AI model for generating image prompts (deepseek/sonnet/opus)
  selectedStoryDoc: string;
  imageSource: 'generate' | 'folder' | 'upload';
  imagePromptDoc: string;
  imageStyle: string;
  useCharacterDescriptions: boolean;
  firstPageFrequency: string;
  restFrequency: string;
  selectedImageFolder: string;
  uploadedVideoFile: File | null;
  audioSource: 'generate' | 'existing' | 'upload';
  selectedAudioFile: string;
  selectedAudioFolder: string;
  selectedVoice: string;
  audioSpeed: number;
  audioVolume: number;
  existingAudioVolume: number; // NEW: For existing/uploaded audio
  backgroundMusicVolume: number; // NEW: For background music
  removeTitleChapters: boolean;
  outputVideoName: string;
  backgroundMusicUrl?: string;
  videoLoopUrl?: string;
  videoLoopMetadata?: VideoMetadata; // NEW: Video metadata
  loopTimeHours: number;
  loopTimeMinutes: number;
  sameAsAudioLength: boolean;
  // NEW: Output type and component selection
  outputType: 'video' | 'components';
  processStory: boolean;
  processImages: boolean;
  processAudio: boolean;
  // NEW: Visual pipeline type
  visualType: 'image' | 'ttv' | 'itv' | 'mg';
  // NEW: TTV folder selections
  selectedTTVFolder: string;
  ttvPromptDoc: string;
  // NEW: ITV folder selections
  selectedITVVideoFolder: string;
  itvVideoPromptDoc: string;
  selectedITVImageFolder: string;
  itvImagePromptDoc: string;
  // NEW: MG (Motion Graphics) settings
  mgStyleSlug?: string;
  mgStyleGuidance?: string;
  mgClipDuration?: number;
}

interface ValidationErrors {
  firstPageFrequency?: string;
  restFrequency?: string;
}

interface AnalysisResult {
  estimatedTokens: number;
  estimatedStorageMB: number;
  estimatedVideoTimeMinutes: number;
  estimatedGenerationTimeMinutes?: number;
  breakdown?: {
    storyTokens: number;
    imagePromptTokens: number;
    imageGenerationTokens: number;
    audioTokens: number;
    videoProcessingTokens: number;
  };
  settings?: {
    numImages: number;
    wordCount: number;
    imageModel: string;
    modelVersion: string;
    audioModel: string;
    voice: string;
    isNewStory: boolean;
    hasContent: boolean;
    needsStoryGeneration: boolean;
    needsImageGeneration: boolean;
    needsAudioGeneration: boolean;
    usingAllExistingAssets: boolean;
  };
}

interface VideoTask {
  id: string;
  user_id: string;
  group_id: string;
  story_title: string;
  overall_progress: number;
  // NOTE: Removed stale progress fields (story_progress, image_prompt_progress, etc.)
  // These are no longer read - progress is calculated from individual task tables
  story_status: string;
  image_prompt_status: string;
  image_generation_status: string;
  audio_status: string;
  video_creation_status: string;
  overall_status: string;
  error_message?: string;
  final_video_url?: string;
  updated_at: string;
  completed_at?: string;
  doc_id?: string;
  is_main?: boolean;
  total_individual_videos?: number;
  completed_individual_videos?: number;
  individual_video_progress?: number;
  settings?: any; // JSONB column containing all the generation settings
  ttv_status?: string;
  ttv_prompt_status?: string;
  visual_type?: string;
  variant?: number;
}




export interface VideoGeneratorRef {
  cleanup: () => Promise<void>;
}

interface VideoGeneratorProps {
  currentTab: number;
  isEnterpriseUser: boolean;
  onTabChange: (tab: number, groupId: string) => void;
  onTabCreate: (tab: number, groupId: string) => void;
  onTabClose: (tab: number, groupId: string) => void;
  userId: string;
  initialTabs?: import('../utils/tabManager').TabInfo[];
}

const VideoGenerator = forwardRef<VideoGeneratorRef, VideoGeneratorProps>(({ currentTab, isEnterpriseUser, onTabChange, onTabCreate, onTabClose, userId, initialTabs }, ref) => {
  const navigate = useNavigate();
  // Plan-aware LLM model options. Shadowing the module-scope binding keeps
  // every existing in-component reference aligned with the active plan.
  const { isLegacy } = useIsLegacyPlan();
  const modelOptions = React.useMemo(() => buildModelOptions(isLegacy), [isLegacy]);
  
  // Initialize custom hooks FIRST before using their values
  const generationStateHook = useVideoGenerationState();

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(null);
  const [userTokenBalance, setUserTokenBalance] = useState<number>(400000);
  const [userPlan, setUserPlan] = useState<string>('free');
  const [storageUsed, setStorageUsed] = useState<number | null>(null);
  
  // Calculate max storage based on user plan
  const maxStorageGB = getStorageLimitGB(userPlan);
  
  const [documents, setDocuments] = useState<StoryDocument[]>([]);
  const [imageFolders, setImageFolders] = useState<StoryDocument[]>([]);
  const [audioFolders, setAudioFolders] = useState<StoryDocument[]>([]);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadedDocId, setUploadedDocId] = useState<string | null>(null);
  const [uploadLanguage, setUploadLanguage] = useState<string>('');
  const [uploadedAudioFile, setUploadedAudioFile] = useState<File | null>(null);
  const [uploadedAudioDocId, setUploadedAudioDocId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Use generation state from hook, but keep local getters/setters for compatibility
  const generationState = generationStateHook.generationState;
  const setGenerationState = generationStateHook.setGenerationState;
  const progress = generationStateHook.progress;
  const setProgress = generationStateHook.setProgress;
  const statusMessage = generationStateHook.statusMessage;
  const setStatusMessage = generationStateHook.setStatusMessage;
  const timeRemaining = generationStateHook.timeRemaining;
  const setTimeRemaining = generationStateHook.setTimeRemaining;
  const batchStatuses = generationStateHook.batchStatuses;
  const setBatchStatuses = generationStateHook.setBatchStatuses;
  
  const [generationLoading, setGenerationLoading] = useState(false);
  const [showMoreStyles, setShowMoreStyles] = useState<boolean>(false);
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [showMorePremiumVoices, setShowMorePremiumVoices] = useState(false);
  const [showMoreCoreVoices, setShowMoreCoreVoices] = useState(false);
  const [showMoreApexVoices, setShowMoreApexVoices] = useState(false);
  const [speedInput, setSpeedInput] = useState<string>('1.0');
  const [speedError, setSpeedError] = useState<string>('');
  const [volumeInput, setVolumeInput] = useState<string>('1.0');
  const [volumeError, setVolumeError] = useState<string>('');
  // NEW: Audio volume controls for existing/uploaded audio
  const [existingAudioVolumeInput, setExistingAudioVolumeInput] = useState<string>('1.0');
  const [existingAudioVolumeError, setExistingAudioVolumeError] = useState<string>('');

  // Expose cleanup method to parent via ref
  useImperativeHandle(ref, () => ({
    cleanup: async () => {
      console.log(`[VideoGenerator] Cleanup called for tab ${currentTab}, status: ${generationState}`);
      
      if (generationState === 'generating') {
        console.log(`[VideoGenerator] Tab ${currentTab} is generating, stopping generation...`);
        await handleStopGeneration();
      } else if (generationState === 'complete') {
        console.log(`[VideoGenerator] Tab ${currentTab} is complete, cleaning up...`);
        await handleDone();
      }
      
      console.log(`[VideoGenerator] Cleanup complete for tab ${currentTab}`);
    }
  }), [generationState, currentTab]);

  // NEW: Background music volume controls
  const [backgroundMusicVolumeInput, setBackgroundMusicVolumeInput] = useState<string>('1.0');
  const [backgroundMusicVolumeError, setBackgroundMusicVolumeError] = useState<string>('');
  
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [backgroundMusicUrl, setBackgroundMusicUrl] = useState<string>('');
  // ADD VIDEO LOOP URL STATE
  const [videoLoopUrl, setVideoLoopUrl] = useState<string>('');
  // NEW: Video metadata state
  const [uploadedVideoMetadata, setUploadedVideoMetadata] = useState<VideoMetadata | null>(null);

  // Multi-tab warning state
  const [multiTabWarning, setMultiTabWarning] = useState<{
    currentTabEstimate: number;
    otherTabEstimates: Array<{ tab: number; estimate_tokens: number; title: string }>;
    totalEstimate: number;
    userBalance: number;
  } | null>(null);

  // Quick Generate vs Detailed Settings mode
  const [videoGenMode, setVideoGenMode] = useTabSessionStorage<'quick' | 'detailed'>('videoGenMode', 'quick', currentTab);
  const [quickPrompt, setQuickPrompt] = useTabSessionStorage('quickPrompt', '', currentTab);
  const [quickRuntimeMinutes, setQuickRuntimeMinutes] = useTabSessionStorage('quickRuntimeMinutes', '10', currentTab);
  const [quickTokenBudget, setQuickTokenBudget] = useTabSessionStorage('quickTokenBudget', '', currentTab);
  const [quickLanguage, setQuickLanguage] = useTabSessionStorage('quickLanguage', 'english', currentTab);
  const [quickIsRuntimeMode, setQuickIsRuntimeMode] = useTabSessionStorage('quickIsRuntimeMode', true, currentTab);
  const [quickWordCount, setQuickWordCount] = useTabSessionStorage('quickWordCount', '', currentTab);
  const [quickVisualType, setQuickVisualType] = useTabSessionStorage<'default' | 'image' | 'ttv' | 'itv' | 'mg'>('quickVisualType', 'default', currentTab);
  // Per-input format errors (NaN / out-of-range only). The cross-field budget vs
  // runtime vs visual-type vs balance check lives in `quickValidation` below.
  const [quickBudgetWarning, setQuickBudgetWarning] = useState<string | null>(null);
  const [quickDurationWarning, setQuickDurationWarning] = useState<string | null>(null);
  const [quickGenerating, setQuickGenerating] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [quickResult, setQuickResult] = useState<{
    group_id: string;
    estimated_tokens: number;
    planned_settings: Record<string, unknown>;
  } | null>(null);

  // YouTube Inspiration (shared between Quick & Detailed)
  const [youtubeInspirationEnabled, setYoutubeInspirationEnabled] = useTabSessionStorage('videoYoutubeEnabled', false, currentTab);
  const [youtubeLinks, setYoutubeLinks] = useTabSessionStorage<string[]>('videoYoutubeLinks', [''], currentTab);
  const [youtubeLinkErrors, setYoutubeLinkErrors] = useState<Record<number, string>>({});

  // Runtime vs Word Count toggle (using tab-isolated session storage)
  const [isRuntimeMode, setIsRuntimeMode] = useTabSessionStorage('isRuntimeMode', true, currentTab);
  const [runtimeMinutes, setRuntimeMinutes] = useTabSessionStorage('runtimeMinutes', '10', currentTab);

  // Master Prompt state
  const [masterPromptEnabled, setMasterPromptEnabled] = useTabSessionStorage('masterPromptEnabled', false, currentTab);
  const [masterPromptEnhanceAI, setMasterPromptEnhanceAI] = useTabSessionStorage('masterPromptEnhanceAI', false, currentTab);
  const [masterPromptData, setMasterPromptData] = useTabSessionStorage<{
    visualStyle: string;
    setting: string;
    atmosphere: string;
    environmentOnly: boolean;
    characters: Array<{ name: string; description: string }>;
  } | null>('masterPromptData', null, currentTab);

  // Pause TTS state
  const [pauseTTS, setPauseTTS] = useTabSessionStorage('pauseTTS', false, currentTab);

  // Settings locked state
  const [settingsLocked, setSettingsLocked] = useState<boolean>(false);

  // Settings collapse state (like Story Generator)
  const [settingsCollapsed, setSettingsCollapsed] = useState(() => {
    // Auto-collapse if returning to an active generation
    try { return generationState === 'generating'; } catch { return false; }
  });
  const [prevGenState, setPrevGenState] = useState(generationState);

  // Auto-collapse settings when generation starts (not analyzed — user needs Step 5 visible)
  if (generationState !== prevGenState) {
    setPrevGenState(generationState);
    if (generationState === 'generating') {
      setSettingsCollapsed(true);
    } else if (generationState === 'idle') {
      setSettingsCollapsed(false);
    }
  }

  // Polling state
  const [videoTasks, setVideoTasks] = useState<VideoTask[]>([]);
  // batchStatuses now comes from generationStateHook
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Add these new state variables with your existing ones
  const [videoUploadProgress, setVideoUploadProgress] = useState<number>(0);
  const [audioUploadProgress, setAudioUploadProgress] = useState<number>(0);
  const [videoUploadStartTime, setVideoUploadStartTime] = useState<number>(0);
  const [audioUploadStartTime, setAudioUploadStartTime] = useState<number>(0);

  const [stopLoading, setStopLoading] = useState(false);
  const [notifyOnComplete, setNotifyOnComplete] = useState(false);
  const [notifyLoading, setNotifyLoading] = useState(false);

  // Final video URL for download
  const [finalVideoUrl, setFinalVideoUrl] = useState<string | null>(null);
  const [downloadLoading, setDownloadLoading] = useState<boolean>(false);
  // NEW: Download progress state
  const [downloadProgress, setDownloadProgress] = useState<{ [docId: string]: number }>({});
  // Large file download modal state
  const [largeVideoDownloadModal, setLargeVideoDownloadModal] = useState<{
    fileName: string;
    fileSizeBytes: number;
    signedUrl: string;
  } | null>(null);

  // Video preview state
  const [showVideoPreview, setShowVideoPreview] = useState<boolean>(false);
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [loadingVideoUrl, setLoadingVideoUrl] = useState<boolean>(false);

  // Collapsible steps state - Only Steps 1, 2, 3 can be collapsed
  // Default: Step 1 open, Steps 2 & 3 collapsed to reduce initial overwhelm
  const [collapsedSteps, setCollapsedSteps] = useState<Record<number, boolean>>({
    1: false,
    2: true,
    3: true
  });

  // Video loop state
  const [uploadedVideoLoopFile, setUploadedVideoLoopFile] = useState<File | null>(null);
  const [uploadingVideoLoop, setUploadingVideoLoop] = useState(false);

  // Transition state
  const [selectedTransition, setSelectedTransition] = useState<string>('none');

  // UPDATED: Animation and effects state with new default
  const [selectedAnimation, setSelectedAnimation] = useState<string>('horizontal_drift');
  const [selectedEffect, setSelectedEffect] = useState<string>('film_grain');

  // Subtitles (burn-in) state — null payload = no subtitles, preserves prior pipeline behavior
  const [subtitlesEnabled, setSubtitlesEnabled] = useState<boolean>(false);
  const [subtitleConfig, setSubtitleConfig] = useState<SubtitleConfig>(DEFAULT_SUBTITLE_CONFIG);

  // Language filters for Apex voices
  const [selectedApexLanguage, setSelectedApexLanguage] = useState<string>('all');

  // Replace forceUpdate with proper state management
  const [lastUpdateTimestamp, setLastUpdateTimestamp] = useState(Date.now());

  const forceProgressUpdate = useCallback(() => {
    console.log('Force updating UI state');
    setLastUpdateTimestamp(Date.now());
  }, []);

  // NEW: Add periodic completion check interval ref
  const completionCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const planningPollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // New session clone voice tracking
  const [sessionCloneVoiceId, setSessionCloneVoiceId] = useState<string | null>(null);
  const [sessionCloneVoiceFilePath, setSessionCloneVoiceFilePath] = useState<string | null>(null);

  // Add ref for VoiceSelector
  const voiceSelectorRef = useRef<{ clearUploadSection: () => void } | null>(null);

  // ElevenLabs voice tracking (optional — only set when user picks an ElevenLabs voice)
  const [elevenLabsVoice, setElevenLabsVoice] = useState<SelectedElevenLabsVoice | null>(null);
  const [elevenLabsModelId, setElevenLabsModelId] = useState<string>(DEFAULT_ELEVENLABS_MODEL_ID);

  // Filter out network errors from display
  const displayError = error && !error.includes('Failed to fetch') && !error.includes('TypeError: Failed to fetch') && !error.includes('NetworkError') ? error : null;
  
  const [settings, setSettings] = useState<VideoSettings>({
    storySource: 'new',
    storyTitle: '',
    storyDescription: '',
    wordCount: '1250', // Default: minutesToWordCount(10) = 10min * 125 WPM
    language: 'english',
    model: 'sonnet', // Story generation model
    imageModel: 'seedream-4.5', // Image quality model - default to Prime
    imagePromptModel: 'sonnet', // AI model for generating image prompts (deepseek/sonnet/opus)
    selectedStoryDoc: '',
    imageSource: 'generate',
    imagePromptDoc: '',
    imageStyle: '', // Will be set by ConfigurationSteps
    useCharacterDescriptions: true,
    firstPageFrequency: '10',
    restFrequency: '30',
    selectedImageFolder: '',
    uploadedVideoFile: null,
    audioSource: 'generate',
    selectedAudioFile: '',
    selectedAudioFolder: '',
    selectedVoice: 'core:lewis', // Will be set by ConfigurationSteps
    audioSpeed: 1.0,
    audioVolume: 1.0,
    existingAudioVolume: 1.0, // NEW: For existing/uploaded audio
    backgroundMusicVolume: 1.0, // NEW: For background music
    removeTitleChapters: true,
    outputVideoName: 'final_video.mp4',
    loopTimeHours: 0,
    loopTimeMinutes: 30,
    sameAsAudioLength: true,
    // NEW: Output type and component selection
    outputType: 'video',
    processStory: true,
    processImages: true,
    processAudio: true,
    // NEW: Visual pipeline defaults
    visualType: 'image',
    selectedTTVFolder: '',
    ttvPromptDoc: '',
    selectedITVVideoFolder: '',
    itvVideoPromptDoc: '',
    selectedITVImageFolder: '',
    itvImagePromptDoc: '',
    // NEW: MG defaults
    mgStyleSlug: MG_DEFAULT_STYLE_SLUG,
    mgStyleGuidance: resolveStyleGuidance(MG_DEFAULT_STYLE_SLUG),
    mgClipDuration: MG_DEFAULT_CLIP_SECONDS,
    mgCodegenModel: 'opus',
    mgCustomStyle: '',
    mgPromptDoc: '',
    selectedMGFolder: '',
  });

  const [wordCountError, setWordCountError] = useState<string | null>(null);

  // NEW: Frequency configuration state (for Image Generator-style image timing)
  const [frequencyMode, setFrequencyMode] = useTabSessionStorage<'wordcount' | 'audio'>('frequencyMode', 'wordcount', currentTab);
  const [frequencyType, setFrequencyType] = useTabSessionStorage<'consistent' | 'variable'>('frequencyType', 'variable', currentTab);
  const [consistentFrequency, setConsistentFrequency] = useTabSessionStorage('consistentFrequency', '60', currentTab);
  const [audioDistributionType, setAudioDistributionType] = useTabSessionStorage<'consistent' | 'variable'>('audioDistributionType', 'consistent', currentTab);
  const [firstPageImageAmount, setFirstPageImageAmount] = useTabSessionStorage('firstPageImageAmount', '3', currentTab);
  const [restImageAmount, setRestImageAmount] = useTabSessionStorage('restImageAmount', '2', currentTab);
  const [totalAudioDuration, setTotalAudioDuration] = useTabSessionStorage('totalAudioDuration', '0', currentTab);
  const [imageAmount, setImageAmount] = useTabSessionStorage('imageAmount', '10', currentTab);
  const [uploadedAudioFiles, setUploadedAudioFiles] = useTabSessionStorage<Array<{ name: string; url: string; duration?: number }>>('uploadedAudioFiles', [], currentTab);
  
  // NEW: TTV/ITV model state
  // ttvModel default: 'seedance_pro_fast' (was 'wan22'; wan22 retired from new TTV selection)
  const [ttvModel, setTTVModel] = useTabSessionStorage('ttvModel', 'seedance_pro_fast', currentTab);
  const [ttvStyle, setTTVStyle] = useTabSessionStorage('ttvStyle', 'Illustrated', currentTab);
  const [ttvDuration, setTTVDuration] = useTabSessionStorage('ttvDuration', 4.91, currentTab);
  const [ttvAudioClip, setTTVAudioClip] = useTabSessionStorage('ttvAudioClip', false, currentTab);
  const [itvModel, setITVModel] = useTabSessionStorage('itvModel', 'wan22', currentTab);
  const [itvDuration, setITVDuration] = useTabSessionStorage('itvDuration', 5.06, currentTab);
  const [itvAudioClip, setITVAudioClip] = useTabSessionStorage('itvAudioClip', false, currentTab);

  // NEW: Custom Characters state (default off, same as TTV/ITV pages)
  const [customCharactersEnabled, setCustomCharactersEnabled] = useTabSessionStorage<boolean>('video_customCharsEnabled', false, currentTab);
  const [customCharacters, setCustomCharacters] = useTabSessionStorage<Array<{ name: string; description: string }>>('video_customChars', [{ name: '', description: '' }], currentTab);
  const [customCharactersAIEnhance, setCustomCharactersAIEnhance] = useTabSessionStorage<boolean>('video_customCharsAIEnhance', false, currentTab);

  // NEW: TTV/ITV document state arrays
  const [ttvFolders, setTTVFolders] = useState<StoryDocument[]>([]);
  const [ttvPromptDocs, setTTVPromptDocs] = useState<StoryDocument[]>([]);
  const [itvVideoFolders, setITVVideoFolders] = useState<StoryDocument[]>([]);
  const [itvVideoPromptDocs, setITVVideoPromptDocs] = useState<StoryDocument[]>([]);
  const [itvImageFolders, setITVImageFolders] = useState<StoryDocument[]>([]);
  const [itvImagePromptDocs, setITVImagePromptDocs] = useState<StoryDocument[]>([]);
  const [mgPromptDocs, setMGPromptDocs] = useState<StoryDocument[]>([]);
  const [mgVideoFolders, setMGVideoFolders] = useState<StoryDocument[]>([]);

  // NEW: Audio duration calculation state
  const [calculatedAudioDuration, setCalculatedAudioDuration] = useTabSessionStorage('calculatedAudioDuration', 0, currentTab);
  const [audioDurationLoading, setAudioDurationLoading] = useState<boolean>(false);
  const [audioDurationError, setAudioDurationError] = useState<string | null>(null);
  const [isCalculatingDuration, setIsCalculatingDuration] = useState<boolean>(false);
  
  // NEW: Story selection state for audio mode (when story already exists)
  const [selectedStoryGroupId, setSelectedStoryGroupId] = useTabSessionStorage('selectedStoryGroupId', '', currentTab);
  const [selectedStoryTitle, setSelectedStoryTitle] = useTabSessionStorage('selectedStoryTitle', '', currentTab);
  const [storySource, setStorySource] = useTabSessionStorage<'new' | 'existing' | 'upload'>('storySource', 'new', currentTab);

  // Runtime ↔ Word Count conversion (125 WPM for audio narration)
  const WORDS_PER_MINUTE_AUDIO = 125;

  const minutesToWordCount = (minutes: number): number => {
    return Math.round(minutes * WORDS_PER_MINUTE_AUDIO);
  };

  const wordCountToMinutes = (wordCount: number): number => {
    return Math.round(wordCount / WORDS_PER_MINUTE_AUDIO);
  };

  // ── Unified Quick Generate validation ─────────────────────────────────────
  // Considers visual type + runtime + budget + balance together so the user
  // sees a single, accurate warning for any combination — including DEFAULT
  // and IMAGE (the previous code only validated TTV/ITV against the budget,
  // which is why an under-funded 8-min DEFAULT video showed only the
  // generic "Min 800K tokens" hint instead of "needs 1.1M+").
  const quickVisualLabel = (vt: typeof quickVisualType) =>
    vt === 'ttv' ? 'TTV' : vt === 'itv' ? 'ITV' : vt === 'mg' ? 'MG' : vt === 'image' ? 'IMAGE' : 'DEFAULT';
  const quickValidation = useMemo<{ message: string | null; severity: 'warning' | 'error' }>(() => {
    const budgetK = parseFloat(quickTokenBudget);
    const budget = budgetK > 0 ? Math.round(budgetK * 1000) : 0;

    let runtime = 0;
    let wordCount = 0;
    if (quickIsRuntimeMode) {
      runtime = parseFloat(quickRuntimeMinutes) || 0;
      wordCount = runtime > 0 ? minutesToWordCount(runtime) : 0;
    } else {
      wordCount = parseInt(quickWordCount) || 0;
      runtime = wordCount > 0 ? Math.round((wordCount / WORDS_PER_MINUTE_AUDIO) * 10) / 10 : 0;
    }

    // Need both a budget and a duration before any cross-field check is meaningful.
    if (budget <= 0 || runtime <= 0) return { message: null, severity: 'warning' };
    // Defer to the per-input range warnings for these.
    if (wordCount < 200 || wordCount > 150000) return { message: null, severity: 'warning' };

    if (budget > userTokenBalance) {
      const maxRtBalance = maxAffordableRuntime(quickVisualType, userTokenBalance);
      const maxWordsBalance = minutesToWordCount(maxRtBalance);
      return {
        message: `Budget ${formatNumber(budget)} exceeds your balance of ${formatNumber(userTokenBalance)}. Your balance affords up to ${maxRtBalance} min (~${maxWordsBalance.toLocaleString()} words) ${quickVisualLabel(quickVisualType)}.`,
        severity: 'error',
      };
    }

    const minBudget = minBudgetForQuickGenerate(quickVisualType, runtime);
    if (budget < minBudget) {
      const maxRt = maxAffordableRuntime(quickVisualType, budget);
      const maxWords = minutesToWordCount(maxRt);
      return {
        message: `A ${runtime}-min ${quickVisualLabel(quickVisualType)} video needs at least ${formatNumber(minBudget)} tokens (${(minBudget / 1000).toLocaleString()}K). Your ${formatNumber(budget)} budget covers up to ${maxRt} min (~${maxWords.toLocaleString()} words).`,
        severity: 'warning',
      };
    }

    return { message: null, severity: 'warning' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickVisualType, quickRuntimeMinutes, quickWordCount, quickIsRuntimeMode, quickTokenBudget, userTokenBalance]);

  // Model-specific minute limits
  const getMinuteLimitsForModel = (model: string): { min: number; max: number } => {
    const modelConfig = modelOptions.find(m => m.value === model);
    const maxWords = modelConfig?.maxWords || 50000;
    return {
      min: 5,
      max: Math.floor(maxWords / WORDS_PER_MINUTE_AUDIO)
    };
  };

  const isPremiumPlan = ['premium', 'pro', 'elite', 'ultimate', 'enterprise'].includes(userPlan);
  const isStandardPlan = ['standard', 'plus'].includes(userPlan);

  // Initialize database sync hook
  const databaseSync = useDatabaseSync({
    userId,
    currentTab,
    page: 'video',
    generationState: generationStateHook.generationState,
    currentGroupId: generationStateHook.currentGroupId,
    progress: generationStateHook.progress,
    statusMessage: generationStateHook.statusMessage,
    onStateRestored: (restoredData: any) => {
      // Skip if AI planning poll is active — planning display is managed separately
      if (planningPollIntervalRef.current) {
        console.log('[VideoGenerator] Skipping onStateRestored — planning poll is active');
        return;
      }
      console.log(`[VideoGenerator Tab ${currentTab}] Restoring state from database:`, restoredData);
      
      // If we have video_task data, restore it
      // NOTE: useDatabaseSync passes 'videoTaskData' (not 'videoTask') — use the correct key.
      if (restoredData.videoTaskData) {
        const task = restoredData.videoTaskData;
        setCurrentGroupId(task.group_id);
        setVideoTasks([task]);
        
        // Restore visualType, processing flags, and key estimation fields into settings
        const taskSettings = task.settings || {};
        setSettings(prev => ({
          ...prev,
          visualType: task.visual_type || taskSettings.visual_type || 'image',
          outputType: task.video === false ? 'components' : 'video',
          processStory: task.process_story !== false,
          processImages: task.process_images !== false,
          processAudio: task.process_audio !== false,
          // Also restore key estimation fields so periodic refresh has correct values
          ...(taskSettings.word_count ? { wordCount: String(taskSettings.word_count) } : {}),
          ...(taskSettings.rest_frequency ? { restFrequency: String(taskSettings.rest_frequency) } : {}),
          ...(taskSettings.first_page_frequency ? { firstPageFrequency: String(taskSettings.first_page_frequency) } : {}),
          ...(taskSettings.voice ? { selectedVoice: taskSettings.voice } : {}),
          ...(taskSettings.image_model ? { imageModel: taskSettings.image_model } : {}),
          ...(taskSettings.use_existing_story !== undefined ? { storySource: taskSettings.use_existing_story ? 'existing' : 'new' } : {}),
          ...(taskSettings.use_existing_images !== undefined ? { imageSource: taskSettings.use_existing_images ? 'folder' : 'generate' } : {}),
          ...(taskSettings.use_existing_audio !== undefined ? { audioSource: taskSettings.use_existing_audio ? 'existing' : 'generate' } : {}),
          ...(task.mg_style_slug || taskSettings.mg_style_slug ? { mgStyleSlug: task.mg_style_slug || taskSettings.mg_style_slug } : {}),
          ...(task.mg_style_guidance || taskSettings.mg_style_guidance ? { mgStyleGuidance: task.mg_style_guidance || taskSettings.mg_style_guidance } : {}),
          ...(task.mg_clip_duration || taskSettings.mg_clip_duration ? { mgClipDuration: Number(task.mg_clip_duration || taskSettings.mg_clip_duration) } : {}),
          ...(task.mg_codegen_model || taskSettings.mg_codegen_model ? { mgCodegenModel: ((task.mg_codegen_model || taskSettings.mg_codegen_model) === 'claude-sonnet-4-6' ? 'sonnet' : 'opus') } : {}),
        }));
        
        // Update generation state based on task status
        if (task.overall_status === 'completed_final') {
          generationStateHook.setGenerationState('complete');
          generationStateHook.setStatusMessage('Generation complete');
          if (task.final_video_url) {
            setFinalVideoUrl(task.final_video_url);
          }
        } else if (task.overall_status === 'burning_subtitles') {
          generationStateHook.setGenerationState('generating');
          const burnState = (task as { subtitle_burn_state?: { total?: number; completed?: number } } | undefined)?.subtitle_burn_state;
          if (burnState && typeof burnState.total === 'number' && burnState.total > 1) {
            const completed = Math.max(0, Math.min(burnState.total, Number(burnState.completed) || 0));
            generationStateHook.setStatusMessage(`Burning subtitles… chunk ${Math.min(completed + 1, burnState.total)} of ${burnState.total}`);
          } else {
            generationStateHook.setStatusMessage('Burning subtitles into final video…');
          }
          // Intentionally do NOT setFinalVideoUrl — keep hidden until burn completes.
        } else if (task.overall_status === 'running' || task.overall_status === 'pending') {
          generationStateHook.setGenerationState('generating');
        }
      }
      // Do NOT fall back to restoring 'complete' from tabData.status alone — that is now
      // handled exclusively by initializeFromDatabase using video_tasks as source of truth.
    }
  });

  // Helper function to clear VoiceSelector upload section
  const clearVoiceSelectorUploadSection = () => {
    if (voiceSelectorRef.current?.clearUploadSection) {
      voiceSelectorRef.current.clearUploadSection();
    }
  };

  // Update settings locked state based on generation state
  useEffect(() => {
    const shouldLockSettings = ['analyzed', 'generating', 'complete'].includes(generationState);
    setSettingsLocked(shouldLockSettings);
  }, [generationState]);

  // DATABASE INITIALIZATION: Load state from database on mount or tab change
  useEffect(() => {
    const initializeFromDatabase = async () => {
      if (!userId) {
        console.log('[VideoGenerator] No userId, skipping database initialization');
        return;
      }

      // Skip if AI planning poll is active — planning display is managed separately
      if (planningPollIntervalRef.current) {
        console.log('[VideoGenerator] Skipping database initialization — planning poll is active');
        return;
      }

      console.log(`[VideoGenerator Tab ${currentTab}] Initializing from database...`);
      
      try {
        // 1. Query tabs table for this tab's data
        const { data: tabData, error: tabError } = await supabase
          .from('tabs')
          .select('status, group_id, title')
          .eq('user_id', userId)
          .eq('page', 'video')
          .eq('tab_number', currentTab)
          .maybeSingle();

        if (tabError) {
          console.error('[VideoGenerator] Error fetching tab data:', tabError);
        }

        // 2. Check for existing video_tasks
        const { data: tasks, error: tasksError } = await supabase
          .from('video_tasks')
          .select('*')
          .eq('user_id', userId)
          .eq('tab', currentTab)
          .in('overall_status', ['pending', 'running', 'completed', 'completed_final'])
          .order('created_at', { ascending: true });

        if (tasksError) {
          console.error('[VideoGenerator] Error fetching tasks:', tasksError);
        }

        // 3. Restore state based on what we found
        if (tasks && tasks.length > 0) {
          // Pick the active main task. Prefer is_main = true; tolerate legacy doc_id IS NULL rows.
          // Within candidates, prefer running status so stale rows from previous attempts do not shadow the current generation.
          const mainTaskCandidates = tasks.filter(t => t.is_main || !t.doc_id);
          const task = mainTaskCandidates.find(t => t.video_creation_status === 'running')
            || mainTaskCandidates.find(t => t.overall_status === 'running')
            || mainTaskCandidates.find(t => t.is_main)
            || mainTaskCandidates[mainTaskCandidates.length - 1]
            || tasks[tasks.length - 1];
          
          console.log(`[VideoGenerator Tab ${currentTab}] Restoring from video_task:`, task);
          
          // SET BASIC STATE
          setCurrentGroupId(task.group_id);
          setVideoTasks(tasks);
          
          // RESTORE SETTINGS FROM TASK (especially visualType for correct progress labels)
          const taskSettings = task.settings || {};
          setSettings(prev => ({
            ...prev,
            visualType: task.visual_type || taskSettings.visual_type || 'image',
            outputType: task.video === false ? 'components' : 'video',
            processStory: task.process_story !== false,
            processImages: task.process_images !== false,
            processAudio: task.process_audio !== false,
            // Also restore key estimation fields so periodic refresh has correct values
            ...(taskSettings.word_count ? { wordCount: String(taskSettings.word_count) } : {}),
            ...(taskSettings.rest_frequency ? { restFrequency: String(taskSettings.rest_frequency) } : {}),
            ...(taskSettings.first_page_frequency ? { firstPageFrequency: String(taskSettings.first_page_frequency) } : {}),
            ...(taskSettings.voice ? { selectedVoice: taskSettings.voice } : {}),
            ...(taskSettings.image_model ? { imageModel: taskSettings.image_model } : {}),
            ...(taskSettings.use_existing_story !== undefined ? { storySource: taskSettings.use_existing_story ? 'existing' : 'new' } : {}),
            ...(taskSettings.use_existing_images !== undefined ? { imageSource: taskSettings.use_existing_images ? 'folder' : 'generate' } : {}),
            ...(taskSettings.use_existing_audio !== undefined ? { audioSource: taskSettings.use_existing_audio ? 'existing' : 'generate' } : {}),
            ...(task.mg_style_slug || taskSettings.mg_style_slug ? { mgStyleSlug: task.mg_style_slug || taskSettings.mg_style_slug } : {}),
            ...(task.mg_style_guidance || taskSettings.mg_style_guidance ? { mgStyleGuidance: task.mg_style_guidance || taskSettings.mg_style_guidance } : {}),
            ...(task.mg_clip_duration || taskSettings.mg_clip_duration ? { mgClipDuration: Number(task.mg_clip_duration || taskSettings.mg_clip_duration) } : {}),
            ...(task.mg_codegen_model || taskSettings.mg_codegen_model ? { mgCodegenModel: ((task.mg_codegen_model || taskSettings.mg_codegen_model) === 'claude-sonnet-4-6' ? 'sonnet' : 'opus') } : {}),
          }));
          
          // DETERMINE IF COMPONENTS-ONLY MODE (video=false)
          const isComponentsOnly = task.video === false;
          
          // CALCULATE ACCURATE BATCH STATUSES from task tables directly
          // This ensures we show real-time progress, not stale aggregated values
          const calculatedBatchStatuses = await calculateVideoProgress(
            userId,
            task.group_id,
            currentTab,
            {
              processStory: task.process_story !== false,
              processImages: task.process_images !== false,
              processAudio: task.process_audio !== false,
              video: task.video !== false,
              useExistingStory: task.use_existing_story === true,
              useExistingImages: task.use_existing_images === true,
              useExistingAudio: task.use_existing_audio === true,
              visualType: task.visual_type || 'image'
            }
          );
          
          // Initialize batch statuses using calculated values
          generationStateHook.initializeBatchStatuses(calculatedBatchStatuses as any);
          
          // SET OVERALL PROGRESS AND STATUS
          setProgress(task.overall_progress || 0);
          
          // DETERMINE GENERATION STATE
          if (task.overall_status === 'completed_final') {
            setGenerationState('complete');
            setStatusMessage('Generation complete');
            if (task.final_video_url) {
              setFinalVideoUrl(task.final_video_url);
            }
          } else if (task.overall_status === 'burning_subtitles') {
            setGenerationState('generating');
            const burnState = (task as { subtitle_burn_state?: { total?: number; completed?: number } } | undefined)?.subtitle_burn_state;
            if (burnState && typeof burnState.total === 'number' && burnState.total > 1) {
              const completed = Math.max(0, Math.min(burnState.total, Number(burnState.completed) || 0));
              setStatusMessage(`Burning subtitles… chunk ${Math.min(completed + 1, burnState.total)} of ${burnState.total}`);
            } else {
              setStatusMessage('Burning subtitles into final video…');
            }
            // Keep finalVideoUrl unset until burn completes.
          } else if (task.overall_status === 'running' || task.overall_status === 'pending' || task.overall_status === 'completed') {
            setGenerationState('generating');
            
            // SET STATUS MESSAGE BASED ON CURRENT PHASE
            if (task.story_status === 'running') {
              setStatusMessage('Generating story...');
            } else if (task.image_prompt_status === 'running') {
              setStatusMessage('Generating image prompts...');
            } else if (task.image_generation_status === 'running') {
              setStatusMessage('Generating images...');
            } else if (task.audio_status === 'running') {
              setStatusMessage('Generating audio...');
            } else if (task.video_creation_status === 'running') {
              setStatusMessage('Creating video...');
            } else {
              setStatusMessage('Processing...');
            }

            // INITIAL TIME-REMAINING ESTIMATE
            // Strategy:
            //  - For the VIDEO phase, do NOT set an initial value here. The
            //    periodic-refresh effect fires immediately once
            //    `generationState='generating'` and `currentGroupId` are set
            //    (right after this function), and runs the exact same
            //    per-batch estimator with the latest batch progress. Setting
            //    a value here would briefly flash a less-accurate number
            //    (e.g. 46m baseline) before the refresh overwrites it with
            //    the progress-aware value (e.g. 43m). Leaving timeRemaining
            //    as null hides the row entirely until the refresh paints
            //    the correct value (typically <1s).
            //  - For non-video phases, fall back to the DB-column baseline
            //    so the user sees something immediately.
            const inVideoPhase =
              task.video_creation_status === 'running' || task.video_creation_status === 'completed';
            if (!inVideoPhase) {
              const initialMins = computeInitialTimeRemainingMinutes(task);
              if (initialMins != null && initialMins > 0) {
                setTimeRemaining(initialMins);
                console.log(`[VideoGenerator] Initial time remaining from DB columns: ${initialMins} min`);
              }
            } else {
              console.log('[VideoGenerator] In video phase — deferring initial timeRemaining to periodic refresh');
            }
          }
          
        } else {
          // No active video_tasks exist for this tab. Any non-idle/outline tab status is stale
          // and must be cleared. This covers:
          //   'generating' — component unmounted mid-generation (e.g. tab switch without Done)
          //   'complete'   — Tab 2's completion bled into Tab 1 via shared group_id, or any
          //                  other scenario where tabs.status is set without backing video_tasks
          // A legitimate 'complete' state ALWAYS has video_tasks present because handleDone
          // deletes video_tasks AND calls resetTabToDefaults (→ 'idle') atomically. So if
          // tasks.length === 0 here, 'complete' is always a stale/leaked status.
          if (tabData?.status && !['idle', 'outline'].includes(tabData.status)) {
            console.log(`[VideoGenerator Tab ${currentTab}] Resetting stale '${tabData.status}' tab status to 'idle' (no active video_tasks found)`);
            await supabase
              .from('tabs')
              .update({ status: 'idle', updated_at: new Date().toISOString() })
              .eq('user_id', userId)
              .eq('page', 'video')
              .eq('tab_number', currentTab);
          } else {
            console.log(`[VideoGenerator Tab ${currentTab}] No active generation, starting fresh (idle state)`);
          }
        }

      } catch (error) {
        console.error('[VideoGenerator] Error during database initialization:', error);
      }
    };

    initializeFromDatabase();
  }, [userId, currentTab]); // Only run on mount or when tab/user changes

  // Periodic refresh: Update progress every 60 seconds during active generation
  useEffect(() => {
    if (generationState !== 'generating' || !currentUserId || !currentGroupId) {
      return; // Only refresh during active generation
    }
    
    const refreshProgress = async () => {
      // Skip refresh while AI planning poll is active — planning display is managed separately
      if (planningPollIntervalRef.current) {
        console.log('[VideoGenerator] Periodic refresh: Skipping — planning poll is active');
        return;
      }
      
      try {
        console.log('[VideoGenerator] Periodic refresh: Recalculating progress');
        
        // FIRST: Check if video tasks are completed
        const { data: videoTasks, error: tasksError } = await supabase
          .from('video_tasks')
          .select('*')
          .eq('user_id', currentUserId)
          .eq('group_id', currentGroupId)
          .in('overall_status', ['pending', 'running', 'completed', 'completed_final']);

        if (!tasksError && videoTasks && videoTasks.length > 0) {
          // Check if ALL tasks have overall_status = 'completed_final'
          const allCompleted = videoTasks.every(task => task.overall_status === 'completed_final');
          
          if (allCompleted) {
            console.log('[VideoGenerator] Periodic refresh detected completion - transitioning to complete state');
            const mainTaskPool = videoTasks.filter(task => task.is_main || !task.doc_id);
            const mainTask = mainTaskPool.find(t => t.is_main) || mainTaskPool[mainTaskPool.length - 1] || videoTasks[0];
            
            if (mainTask?.final_video_url) {
              setFinalVideoUrl(mainTask.final_video_url);
            }
            
            setGenerationState('complete');
            setProgress(100);
            setStatusMessage('Generation complete!');
            setTimeRemaining(0);
            setVideoTasks(videoTasks);
            return; // Exit early - don't need to calculate progress
          }
        }
        
        // Extract backend settings from the active main task (is_main, running status preferred).
        // Avoids stale React state closure issues AND avoids picking stale rows from previous attempts.
        const mainVideoTaskCandidates = videoTasks?.filter((t: any) => t.is_main || !t.doc_id) || [];
        const mainVideoTask = mainVideoTaskCandidates.find((t: any) => t.video_creation_status === 'running')
          || mainVideoTaskCandidates.find((t: any) => t.overall_status === 'running')
          || mainVideoTaskCandidates.find((t: any) => t.is_main)
          || mainVideoTaskCandidates[mainVideoTaskCandidates.length - 1]
          || videoTasks?.[0];
        const backendSettings = mainVideoTask?.settings || {};
        const resolvedVisualType = (mainVideoTask?.visual_type || backendSettings.visual_type || settings.visualType || 'image') as 'image' | 'ttv' | 'itv' | 'mg';
        
        // Calculate fresh progress from database — use backend settings for accuracy
        const processFlags = {
          processStory: backendSettings.process_story !== undefined ? backendSettings.process_story !== false : settings.processStory !== false,
          processImages: backendSettings.process_images !== undefined ? backendSettings.process_images !== false : settings.processImages !== false,
          processAudio: backendSettings.process_audio !== undefined ? backendSettings.process_audio !== false : settings.processAudio !== false,
          video: backendSettings.video !== undefined ? backendSettings.video !== false : settings.outputType === 'video',
          useExistingStory: backendSettings.use_existing_story === true,
          useExistingImages: backendSettings.use_existing_images === true,
          useExistingAudio: backendSettings.use_existing_audio === true,
          visualType: resolvedVisualType,
        };
        
        const freshBatchStatuses = await calculateVideoProgress(
          currentUserId,
          currentGroupId,
          currentTab,
          processFlags
        );
        
        // Update batch statuses in state
        if (freshBatchStatuses.length > 0) {
          generationStateHook.initializeBatchStatuses(freshBatchStatuses as any);
          
          // Calculate overall progress
          const totalProgress = freshBatchStatuses.reduce((sum, batch) => sum + batch.progress, 0);
          const avgProgress = Math.round(totalProgress / freshBatchStatuses.length);
          setProgress(avgProgress);
          
          console.log('[VideoGenerator] Progress updated:', avgProgress);
          
          // CALCULATE AND UPDATE TIME REMAINING
          // Find the currently active (processing) phase for time calculation
          const processingPhase = freshBatchStatuses.find(batch => batch.status === 'processing');
          
          if (processingPhase) {
            // Resolve numImages and wordCount from backend settings AND direct columns
            // NOTE: visual_type, video_model, video_duration, total_audio_duration are DIRECT COLUMNS
            // on video_tasks, NOT inside the settings JSON. Read them from mainVideoTask.
            const resolvedWordCount = backendSettings.word_count || backendSettings.wordCount || mainVideoTask?.word_count || parseInt(String(settings.wordCount)) || 5000;
            const resolvedVideoModel = mainVideoTask?.video_model || backendSettings.video_model || undefined;
            const resolvedItvModel = mainVideoTask?.itv_model || backendSettings.itv_model || undefined;
            const resolvedVideoDuration = Number(mainVideoTask?.video_duration) || Number(backendSettings.video_duration) || 5;
            const resolvedTotalAudioDuration = Number(mainVideoTask?.total_audio_duration) || Number(backendSettings.total_audio_duration) || 0;
            
            // Calculate numImages — for TTV/ITV, use audio_duration / clip_duration
            let resolvedNumImages = 15;
            if (resolvedVisualType === 'ttv' || resolvedVisualType === 'itv') {
              // TTV/ITV: clip count = ceil(total_audio_duration / clip_duration)
              if (resolvedTotalAudioDuration > 0 && resolvedVideoDuration > 0) {
                resolvedNumImages = Math.ceil(resolvedTotalAudioDuration / resolvedVideoDuration);
              } else {
                // Fallback: try to get from estimated_image_count in settings or image_amount column
                resolvedNumImages = backendSettings.estimated_image_count || mainVideoTask?.image_amount || 15;
              }
            } else {
              // Standard image pipeline: calculate from frequency settings.
              // Prefer image_amount from the DB column when it has been populated
              // (setup-video-tasks writes it for existing-image folders; storyscriptai-setup-prompt
              // writes the exact count after prompts are created). This mirrors TTV/ITV behaviour
              // and avoids inaccurate word-count–based estimates for uploaded documents.
              const frequencyMode = mainVideoTask?.frequency_mode || backendSettings.frequency_mode || 'wordcount';
              if (backendSettings.use_existing_images && backendSettings.images_folder_path) {
                resolvedNumImages = backendSettings.num_images || mainVideoTask?.image_amount || 15;
              } else if (!backendSettings.use_existing_images) {
                if (frequencyMode === 'audio') {
                  resolvedNumImages = mainVideoTask?.image_amount || backendSettings.image_amount || 10;
                } else if (mainVideoTask?.image_amount) {
                  // image_amount has been set by storyscriptai-setup-prompt with the exact prompt count —
                  // use it directly instead of re-estimating from word count + frequency.
                  resolvedNumImages = mainVideoTask.image_amount;
                } else if ((mainVideoTask?.frequency_type || backendSettings.frequency_type) === 'consistent') {
                  const consistentFreq = mainVideoTask?.consistent_frequency || backendSettings.consistent_frequency || 30;
                  if (resolvedWordCount > 0 && consistentFreq > 0) {
                    resolvedNumImages = Math.ceil(resolvedWordCount / consistentFreq);
                  }
                } else {
                  // Variable frequency
                  const bFirstFreq = mainVideoTask?.first_page_frequency ?? backendSettings.first_page_frequency ?? 10;
                  const bRestFreq = mainVideoTask?.rest_frequency ?? backendSettings.rest_frequency ?? 30;
                  if (resolvedWordCount > 0) {
                    const firstPageImages = Math.ceil(Math.min(resolvedWordCount, 250) / bFirstFreq);
                    const restImages = resolvedWordCount > 250 ? Math.ceil((resolvedWordCount - 250) / bRestFreq) : 0;
                    resolvedNumImages = Math.max(1, firstPageImages + restImages);
                  }
                }
              }
            }
            resolvedNumImages = Math.max(1, resolvedNumImages);
            
            const resolvedRestFreq = mainVideoTask?.rest_frequency ?? backendSettings.rest_frequency ?? parseInt(String(settings.restFrequency ?? 30));
            const resolvedVoice = backendSettings.voice || mainVideoTask?.voice || settings.selectedVoice || 'alloy';
            const resolvedModelVersion = backendSettings.model_version || mainVideoTask?.model_version || 'lemonfox';
            const resolvedImageModel = backendSettings.image_model || mainVideoTask?.image_model || settings.imageModel || 'seedream-4.5';
            
            console.log(`[VideoGenerator] Resolved from backend: visualType=${resolvedVisualType}, numImages=${resolvedNumImages}, wordCount=${resolvedWordCount}, videoModel=${resolvedVideoModel}, totalAudioDuration=${resolvedTotalAudioDuration}, videoDuration=${resolvedVideoDuration}`);
            
            if (processingPhase.id === 'video') {
              // Video phase: use batch-counting logic
              const { data: videoTaskRows } = await supabase
                .from('video_tasks')
                .select('*')
                .eq('user_id', currentUserId)
                .eq('group_id', currentGroupId);
              
              if (videoTaskRows && videoTaskRows.length > 0) {
                // All doc_id rows are video creation batches. Transition progress
                // comes from transition_batch_progress JSON on the main task.
                const mainTaskRowCandidates = videoTaskRows.filter(t => t.is_main || !t.doc_id);
                const mainTaskRow = mainTaskRowCandidates.find(t => t.video_creation_status === 'running')
                  || mainTaskRowCandidates.find(t => t.is_main)
                  || mainTaskRowCandidates[mainTaskRowCandidates.length - 1];
                const videoBatches = videoTaskRows.filter(t => t.doc_id);
                
                // Parse transition_batch_progress from main task
                let tbp = mainTaskRow?.transition_batch_progress;
                if (typeof tbp === 'string') {
                  try { tbp = JSON.parse(tbp); } catch(e) { tbp = null; }
                }
                if (tbp && typeof tbp === 'object' && Object.keys(tbp).length === 0) tbp = null;
                
                const completedVideo = videoBatches.filter(b => 
                  b.video_creation_status === 'completed' || b.overall_status === 'completed'
                ).length;
                
                const completedTransitions = (tbp && tbp.completed_batches) || 0;
                const totalTransitions = (tbp && tbp.total_batches) || 0;

                // Sum actual durations of clips in completed batch ranges (when available)
                // so non-uniform clip lengths are accounted for accurately.
                const completedRowSeconds = sumCompletedClipSeconds(
                  videoBatches,
                  mainTaskRow?.video_durations,
                );
                
                const timeRemainingSeconds = calculateVideoBatchTime(
                  completedVideo,
                  videoBatches.length,
                  completedTransitions,
                  totalTransitions,
                  resolvedVisualType,
                  {
                    totalAudioDuration: mainTaskRow?.total_audio_duration ?? resolvedTotalAudioDuration ?? 0,
                    numImages: mainTaskRow?.total_individual_videos ?? resolvedNumImages,
                    hasTransitions: !!mainTaskRow?.transition_type,
                    hasOverlay: !!(mainTaskRow?.animation_type || mainTaskRow?.effects_type),
                    hasSubtitles: !!mainTaskRow?.subtitles,
                    useExistingAudio: !!mainTaskRow?.use_existing_audio,
                    animationType: (mainTaskRow?.animation_type as string | null) ?? null,
                    effectsType: (mainTaskRow?.effects_type as string | null) ?? null,
                    completedRowSeconds: completedRowSeconds ?? undefined,
                    durations: (() => {
                      const vd = mainTaskRow?.video_durations;
                      if (Array.isArray(vd)) return vd.map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
                      if (vd && typeof vd === 'object') return Object.values(vd).map((v: any) => Number(v)).filter((n: number) => Number.isFinite(n) && n > 0);
                      return null;
                    })(),
                  }
                );
                
                const timeRemainingMinutes = Math.ceil(timeRemainingSeconds / 60);
                setTimeRemaining(timeRemainingMinutes);
                
                console.log(`[VideoGenerator] Time updated: ${timeRemainingMinutes} minutes (${completedVideo}/${videoBatches.length} video, ${completedTransitions}/${totalTransitions} transitions, visualType: ${resolvedVisualType})`);
              }
            } else {
              // Non-video phases: use calculateRemainingTime for all visual types
              const phaseProcessMap: Record<string, string> = {
                'story': 'story',
                'image_prompts': 'imagePrompt',
                'image_generation': 'imageGeneration',
                'audio': 'audio',
                'ttv_prompts': 'ttvPrompt',
                'ttv_generation': 'ttvGeneration',
                'itv_image_prompts': 'itvImagePrompt',
                'itv_prompts': 'itvPrompt',
                'itv_image_generation': 'itvImageGeneration',
                'itv_generation': 'itvGeneration',
              };
              
              const currentProcessName = phaseProcessMap[processingPhase.id];
              if (currentProcessName) {
                // ITV pipeline: use calculateITVConcurrentTime which properly handles
                // P2 (image gen) and P3 (video prompts) running concurrently.
                if (resolvedVisualType === 'itv' && ['itvImagePrompt', 'itvPrompt', 'itvImageGeneration', 'itvGeneration'].includes(currentProcessName)) {
                  const p1Status = freshBatchStatuses.find(b => b.id === 'itv_image_prompts');
                  const p2Status = freshBatchStatuses.find(b => b.id === 'itv_image_generation');
                  const p3Status = freshBatchStatuses.find(b => b.id === 'itv_prompts');
                  const p4Status = freshBatchStatuses.find(b => b.id === 'itv_generation');

                  const timeRemainingMinutes = calculateITVConcurrentTime(
                    {
                      p1: p1Status?.progress ?? 0,
                      p2: p2Status?.progress ?? 0,
                      p3: p3Status?.progress ?? 0,
                      p4: p4Status?.progress ?? 0,
                    },
                    resolvedNumImages,
                    {
                      imageModel: resolvedImageModel,
                      itvModel: resolvedItvModel || itvModel,
                      includeVideoAssembly: processFlags.video,
                      transitionType: backendSettings.transition_type || null,
                    }
                  );

                  setTimeRemaining(timeRemainingMinutes);
                  console.log(`[VideoGenerator] ITV concurrent time updated: ${timeRemainingMinutes} minutes`);
                } else {
                  // Standard / TTV pipelines: use calculateRemainingTime
                  const estimatedBatches = 
                    currentProcessName === 'story' ? Math.ceil(resolvedWordCount / 1100) :
                    currentProcessName === 'imagePrompt' ? Math.ceil(resolvedNumImages / 2) :
                    currentProcessName === 'imageGeneration' ? resolvedNumImages :
                    currentProcessName === 'audio' ? Math.ceil(resolvedWordCount / 1000) :
                    currentProcessName === 'ttvPrompt' ? Math.ceil(resolvedNumImages / 2) :
                    currentProcessName === 'ttvGeneration' ? resolvedNumImages :
                    currentProcessName === 'itvPrompt' ? Math.ceil(resolvedNumImages / 2) :
                    currentProcessName === 'itvImageGeneration' ? resolvedNumImages :
                    currentProcessName === 'itvGeneration' ? resolvedNumImages : 1;

                  const timeRemainingMinutes = calculateRemainingTime(
                    currentProcessName as any,
                    processingPhase.progress,
                    estimatedBatches,
                    {
                      wordCount: resolvedWordCount,
                      numImages: resolvedNumImages,
                      voice: resolvedVoice,
                      modelVersion: resolvedModelVersion,
                      imageModel: resolvedImageModel,
                      restFrequency: resolvedRestFreq,
                      needsStoryGeneration: !backendSettings.use_existing_story,
                      needsImageGeneration: !backendSettings.use_existing_images,
                      needsAudioGeneration: !backendSettings.use_existing_audio,
                      useExistingImages: backendSettings.use_existing_images || false,
                      video: processFlags.video,
                      processStory: processFlags.processStory,
                      processImages: processFlags.processImages,
                      processAudio: processFlags.processAudio,
                      visualType: resolvedVisualType,
                      videoModel: resolvedVideoModel,
                      itvModel: resolvedItvModel,
                    }
                  );
                  
                  setTimeRemaining(timeRemainingMinutes);
                  console.log(`[VideoGenerator] Time updated for ${currentProcessName}: ${timeRemainingMinutes} minutes (numImages=${resolvedNumImages}, visualType=${resolvedVisualType}, videoModel=${resolvedVideoModel})`);
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('[VideoGenerator] Error during periodic refresh:', error);
      }
    };
    
    // Refresh immediately on mount
    refreshProgress();
    
    // Then refresh every 60 seconds
    const interval = setInterval(refreshProgress, 60000);
    
    return () => clearInterval(interval);
  }, [generationState, currentUserId, currentGroupId, settings.processStory, settings.imageSource, settings.processAudio, settings.visualType]);

  // Database persistence is now handled by useDatabaseSync hook

  // Get video URL from fresh database query
  const getVideoUrl = async (): Promise<string | null> => {
    if (!currentUserId || !currentGroupId) return null;
    
    try {
      const { data: recentDocs } = await supabase
        .from('story_documents')
        .select('file_path')
        .eq('user_id', currentUserId)
        .eq('group_id', currentGroupId)
        .eq('description', 'Final Video')
        .order('created_at', { ascending: false })
        .limit(1);
  
      if (recentDocs && recentDocs.length > 0) {
        // Use signed URL instead of public URL for better compatibility
        const { data: signedUrlData, error } = await supabase.storage
          .from('videos')
          .createSignedUrl(recentDocs[0].file_path, 3600); // 1 hour expiry
          
        if (error) {
          console.error('Error creating signed URL:', error);
          return null;
        }
        
        return signedUrlData.signedUrl;
      }
    } catch (error) {
      console.error('Error fetching video URL:', error);
    }
    
    return null;
  };

  // Load video URL from database
  const loadVideoUrl = async () => {
    setLoadingVideoUrl(true);
    const url = await getVideoUrl();
    setVideoUrl(url);
    setLoadingVideoUrl(false);
  };

  // Effect: When reaching complete state without finalVideoUrl, auto-fetch it from story_documents
  // This handles cases where video_tasks.final_video_url is null but the video exists in storage
  useEffect(() => {
    if (generationState === 'complete' && !finalVideoUrl && currentUserId && currentGroupId) {
      console.log('[VideoGenerator] Complete state detected without finalVideoUrl - fetching from story_documents');
      getVideoUrl().then(url => {
        if (url) {
          console.log('[VideoGenerator] Auto-populated finalVideoUrl from story_documents');
          setFinalVideoUrl(url);
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationState, currentUserId, currentGroupId]);

  // Handle video load error
  const handleVideoLoadError = (error: any) => {
    console.error('Video load error:', error);
    setVideoLoadError('Failed to load video preview. The video file may be corrupted or inaccessible.');
  };

  // Handle load preview button
  const handleLoadPreview = async () => {
    await loadVideoUrl();
    setShowVideoPreview(true);
    setVideoLoadError(null);
  };

  // Helper function to get image count from folder
  const getImageCountFromFolder = async (folderPath: string): Promise<number> => {
    try {
      const { data: files, error } = await supabase
        .storage
        .from('stories')
        .list(folderPath);
      
      if (error) {
        console.warn(`Could not list files in folder ${folderPath}:`, error);
        return 0;
      }
      
      // Filter for image files
      const imageFiles = files?.filter(file => 
        file.name.toLowerCase().match(/\.(jpg|jpeg|png|webp)$/i)
      ) || [];
      
      return imageFiles.length;
    } catch (error) {
      console.warn(`Error getting image count from folder ${folderPath}:`, error);
      return 0;
    }
  };

  const getTTVClipCountFromFolder = async (folderPath: string): Promise<number> => {
    try {
      const { data: files, error } = await supabase
        .storage
        .from('stories')
        .list(folderPath);
      
      if (error) {
        console.warn(`Could not list files in TTV folder ${folderPath}:`, error);
        return 0;
      }
      
      // Filter for MP4 video clips
      const clipFiles = files?.filter(file => 
        file.name.toLowerCase().endsWith('.mp4')
      ) || [];
      
      return clipFiles.length;
    } catch (error) {
      console.warn(`Error getting clip count from TTV folder ${folderPath}:`, error);
      return 0;
    }
  };

  // Calculate audio duration from existing or uploaded audio files
  const handleCalculateAudioDuration = async (audioDocId?: string, audioSource?: 'generate' | 'existing' | 'upload', wordCount?: number) => {
    // Case 1: Generate Audio - estimate from word count
    if (audioSource === 'generate' && wordCount && wordCount > 0) {
      console.log(`[VideoGenerator] Estimating audio duration from word count: ${wordCount}`);
      setIsCalculatingDuration(false);
      setAudioDurationLoading(false);
      setAudioDurationError(null);
      
      // Estimate duration: 125 words per minute
      const estimatedDurationSeconds = Math.round((wordCount / WORDS_PER_MINUTE_AUDIO) * 60);
      setCalculatedAudioDuration(estimatedDurationSeconds);
      console.log(`[VideoGenerator] Estimated audio duration: ${estimatedDurationSeconds}s (${wordCount} words)`);
      
      return estimatedDurationSeconds;
    }
    
    // Case 2 & 3: Existing or Upload Audio - calculate from actual file
    if (!audioDocId || !currentUserId) {
      console.warn('Cannot calculate audio duration: missing audioDocId or userId');
      return;
    }

    console.log(`[VideoGenerator] Calculating audio duration for document: ${audioDocId}`);
    setIsCalculatingDuration(true);
    setAudioDurationLoading(true);
    setAudioDurationError(null);

    try {
      // First, check if the audio_duration is already in the story_documents table
      const { data: audioDoc, error: fetchError } = await supabase
        .from('story_documents')
        .select('audio_duration, file_path, title')
        .eq('id', audioDocId)
        .single();

      if (fetchError) {
        console.error('Error fetching audio document:', fetchError);
        throw new Error(`Failed to fetch audio document: ${fetchError.message}`);
      }

      if (!audioDoc) {
        throw new Error('Audio document not found');
      }

      // If audio_duration exists and is valid, use it
      if (audioDoc.audio_duration && audioDoc.audio_duration > 0) {
        console.log(`[VideoGenerator] Using cached audio duration: ${audioDoc.audio_duration}s`);
        setCalculatedAudioDuration(audioDoc.audio_duration);
        setAudioDurationLoading(false);
        setIsCalculatingDuration(false);
        return audioDoc.audio_duration;
      }

      // If no cached duration, call the edge function to calculate it
      console.log(`[VideoGenerator] No cached duration found, calling calculate-audio-duration edge function`);
      
      // Get session access token for secure API call
      const { data: { session: _authSession } } = await supabase.auth.getSession();
      const _accessToken = _authSession?.access_token;
      if (!_accessToken) throw new Error('Session expired. Please sign in again.');

      // Send the file path directly as a files array (like Image Generator does)
      // This works for both files and folders
      const response = await fetchWithFallback(
        'https://calculate-audio-duration.storyscriptai.deno.net',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_accessToken}`,
          },
          body: JSON.stringify({
            files: [{ path: audioDoc.file_path }]
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Edge function error:', errorText);
        throw new Error(`Failed to calculate audio duration: ${response.statusText}`);
      }

      const result = await response.json();
      console.log(`[VideoGenerator] Calculate audio duration result:`, result);

      if (!result.totalDuration || result.totalDuration <= 0) {
        throw new Error('Invalid audio duration calculated');
      }

      // Update the story_documents table with the calculated duration
      const { error: updateError } = await supabase
        .from('story_documents')
        .update({ audio_duration: result.totalDuration })
        .eq('id', audioDocId);

      if (updateError) {
        console.error('Error updating audio_duration:', updateError);
        // Don't throw - we can still use the calculated duration even if update fails
      }

      setCalculatedAudioDuration(result.totalDuration);
      console.log(`[VideoGenerator] Audio duration calculated and cached: ${result.totalDuration}s`);
      
      return result.totalDuration;
    } catch (err: any) {
      console.error('Error calculating audio duration:', err);
      setAudioDurationError(err.message || 'Failed to calculate audio duration');
      setError(err.message || 'Failed to calculate audio duration');
    } finally {
      setAudioDurationLoading(false);
      setIsCalculatingDuration(false);
    }
  };

  // Helper function to update video task story progress
  // REMOVED: updateVideoTaskStoryProgress, updateVideoTaskImagePromptProgress,
  // updateVideoTaskImageGenerationProgress, updateVideoTaskAudioProgress
  // These functions updated stale video_tasks progress fields that we no longer read.
  // Progress is now calculated directly from individual task tables via calculateVideoProgress().

  // Toggle step collapse (only for Steps 1, 2, 3)
  const toggleStepCollapse = (stepNumber: number) => {
    if (stepNumber <= 3) {
      setCollapsedSteps(prev => ({
        ...prev,
        [stepNumber]: !prev[stepNumber]
      }));
    }
  };

  // Check if step can be collapsed (has some configuration)
  const canCollapseStep = (stepNumber: number): boolean => {
    switch (stepNumber) {
      case 1:
        return settings.storySource === 'new' 
          ? !!(settings.storyTitle && settings.storyDescription && settings.wordCount)
          : settings.storySource === 'existing' 
            ? !!settings.selectedStoryDoc
            : !!uploadedFile;
      case 2:
        if (settings.audioSource === 'generate') {
          return !!settings.selectedVoice;
        } else if (settings.audioSource === 'existing') {
          return !!settings.selectedAudioFile;
        } else if (settings.audioSource === 'upload') {
          return !!settings.selectedAudioFile || !!uploadedAudioFile;
        }
        return false;
      case 3:
        if (settings.imageSource === 'generate') {
          return true; // Image generation always has defaults
        } else if (settings.imageSource === 'folder') {
          return !!(settings.selectedImageFolder && settings.imagePromptDoc);
        } else if (settings.imageSource === 'upload') {
          return !!settings.uploadedVideoFile || !!uploadedVideoLoopFile;
        }
        return false;
      default:
        return false;
    }
  };

  // NEW: Validate existing audio volume input
  const validateExistingAudioVolume = (value: string): boolean => {
    const num = parseFloat(value);
    if (isNaN(num)) {
      setExistingAudioVolumeError('Volume must be a number');
      return false;
    }
    if (num < 1.0 || num > 8.0) {
      setExistingAudioVolumeError('Volume must be between 1.0 and 8.0');
      return false;
    }
    const decimalPlaces = (value.split('.')[1] || '').length;
    if (decimalPlaces > 1) {
      setExistingAudioVolumeError('Volume can have maximum 1 decimal place');
      return false;
    }
    setExistingAudioVolumeError('');
    return true;
  };

  // NEW: Validate background music volume input
  const validateBackgroundMusicVolume = (value: string): boolean => {
    if (!isValidNumericInput(value)) {
      setBackgroundMusicVolumeError('Volume must be a number');
      return false;
    }
    const num = parseFloat(value);
    if (num < 0.1 || num > 2.0) {
      setBackgroundMusicVolumeError('Volume must be between 0.1 and 2.0');
      return false;
    }
    const decimalPlaces = (value.split('.')[1] || '').length;
    if (decimalPlaces > 1) {
      setBackgroundMusicVolumeError('Volume can have maximum 1 decimal place');
      return false;
    }
    setBackgroundMusicVolumeError('');
    return true;
  };

  // Validate speed input
  const validateSpeed = (value: string): boolean => {
    if (!isValidNumericInput(value)) {
      setSpeedError('Speed must be a number');
      return false;
    }
    const num = parseFloat(value);
    const maxSpeed = 2.0; // Default max speed, will be handled in ConfigurationSteps
    if (num < 0.5 || num > maxSpeed) {
      setSpeedError(`Speed must be between 0.5 and ${maxSpeed}`);
      return false;
    }
    const decimalPlaces = (value.split('.')[1] || '').length;
    if (decimalPlaces > 2) {
      setSpeedError('Speed can have maximum 2 decimal places');
      return false;
    }
    setSpeedError('');
    return true;
  };

  // Validate volume input
  const validateVolume = (value: string): boolean => {
    if (!isValidNumericInput(value)) {
      setVolumeError('Volume must be a number');
      return false;
    }
    const num = parseFloat(value);
    if (num < 1.0 || num > 8.0) {
      setVolumeError('Volume must be between 1.0 and 8.0');
      return false;
    }
    const decimalPlaces = (value.split('.')[1] || '').length;
    if (decimalPlaces > 1) {
      setVolumeError('Volume can have maximum 1 decimal place');
      return false;
    }
    setVolumeError('');
    return true;
  };

  // Handle speed input change
  const handleSpeedInputChange = (value: string) => {
    setSpeedInput(value);
    if (validateSpeed(value)) {
      setSettings(prev => ({ ...prev, audioSpeed: parseFloat(value) }));
    }
  };

  // Handle volume input change
  const handleVolumeInputChange = (value: string) => {
    setVolumeInput(value);
    if (validateVolume(value)) {
      setSettings(prev => ({ ...prev, audioVolume: parseFloat(value) }));
    }
  };

  // NEW: Handle existing audio volume input change
  const handleExistingAudioVolumeInputChange = (value: string) => {
    setExistingAudioVolumeInput(value);
    if (validateExistingAudioVolume(value)) {
      setSettings(prev => ({ 
        ...prev, 
        existingAudioVolume: parseFloat(value),
        // Also update the main audioVolume field for consistency
        audioVolume: parseFloat(value)
      }));
    }
  };

  // NEW: Handle background music volume input change
  const handleBackgroundMusicVolumeInputChange = (value: string) => {
    setBackgroundMusicVolumeInput(value);
    if (validateBackgroundMusicVolume(value)) {
      setSettings(prev => ({ ...prev, backgroundMusicVolume: parseFloat(value) }));
    }
  };

  // Initialize speed and volume input
  useEffect(() => {
    setSpeedInput(settings.audioSpeed.toString());
    setVolumeInput(settings.audioVolume?.toString() || '1.0');
    // NEW: Initialize existing audio volume and background music volume
    setExistingAudioVolumeInput(settings.existingAudioVolume?.toString() || '1.0');
    setBackgroundMusicVolumeInput(settings.backgroundMusicVolume?.toString() || '1.0');
  }, [settings.audioSpeed, settings.audioVolume, settings.existingAudioVolume, settings.backgroundMusicVolume]);

  // Update output video name when story title changes - FIXED VERSION
  useEffect(() => {
    if (settings.storyTitle && settings.storyTitle.trim().length > 0) {
      setSettings(prev => ({ ...prev, outputVideoName: `${settings.storyTitle}.mp4` }));
    }
  }, [settings.storyTitle]); // Remove setSettings from dependencies

  // Validate frequency settings
  const validateSettings = (): boolean => {
    const errors: ValidationErrors = {};
    const firstPage = parseFloat(settings.firstPageFrequency);
    const rest = parseFloat(settings.restFrequency);

    if (isNaN(firstPage) || firstPage < 5 || firstPage > 300) {
      errors.firstPageFrequency = 'First page frequency must be between 5 and 300 seconds';
    }

    if (isNaN(rest) || rest < 5 || rest > 600) {
      errors.restFrequency = 'Rest frequency must be between 5 and 600 seconds';
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Validate settings whenever frequency changes
  useEffect(() => {
    validateSettings();
  }, [settings.firstPageFrequency, settings.restFrequency]);

  // Validate word count based on selected model
  const validateWordCount = (input: string, model: string): string | null => {
    if (!isValidNumericInput(input)) {
      return 'Word count must be a number.';
    }
    const num = parseInt(input, 10);
    if (num < 200) {
      return 'Word count must be at least 200.';
    }
    
    const selectedModelConfig = modelOptions.find(m => m.value === model);
    const maxWords = selectedModelConfig?.maxWords || 50000;
    
    if (num > maxWords) {
      return `Word count cannot exceed ${maxWords.toLocaleString()} for ${selectedModelConfig?.label}.`;
    }
    return null;
  };

  // Sync wordCount from runtimeMinutes whenever runtime mode is active
  // Must also depend on settings.wordCount so it re-triggers after DB load overwrites it
  useEffect(() => {
    if (!isRuntimeMode) return;
    const minutes = parseInt(runtimeMinutes) || 10;
    const derivedWordCount = minutesToWordCount(minutes).toString();
    if (settings.wordCount !== derivedWordCount) {
      setSettings(prev => {
        if (prev.wordCount === derivedWordCount) return prev; // guard against no-op
        return { ...prev, wordCount: derivedWordCount };
      });
    }
  }, [isRuntimeMode, runtimeMinutes, settings.wordCount]);

  // Update word count validation whenever it changes
  useEffect(() => {
    setWordCountError(validateWordCount(settings.wordCount, settings.model));
  }, [settings.wordCount, settings.model]);

  // Auto-recalculate estimated audio duration when word count changes in 'generate' audio mode
  useEffect(() => {
    if (settings.audioSource !== 'generate') return;

    let wordCount = 0;
    if (settings.storySource === 'new' || settings.storySource === 'upload') {
      wordCount = parseInt(settings.wordCount) || 0;
    } else if (settings.storySource === 'existing' && settings.selectedStoryDoc) {
      const doc = documents.find((d: any) => d.id === settings.selectedStoryDoc);
      wordCount = doc?.word_count || 0;
    }

    if (wordCount > 0) {
      const estimatedDurationSeconds = Math.round((wordCount / WORDS_PER_MINUTE_AUDIO) * 60);
      setCalculatedAudioDuration(estimatedDurationSeconds);
    } else {
      setCalculatedAudioDuration(0);
    }
  }, [settings.audioSource, settings.wordCount, settings.storySource, settings.selectedStoryDoc, documents]);

  // Get selected model configuration
  const selectedModel = modelOptions.find(m => m.value === settings.model) || modelOptions[0];

  // Handle video loop file upload with TUS and metadata extraction
  const handleVideoLoopFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
  
    // Validate file type
    if (!file.type.includes('video/mp4') && !file.name.match(/\.mp4$/i)) {
      setError('Please upload a valid MP4 video file');
      return;
    }
  
    // Validate file size (3GB limit)
    const maxFileSize = 3 * 1024 * 1024 * 1024; // 3GB
    if (file.size > maxFileSize) {
      setError('Video file must be under 3GB');
      return;
    }
  
    if (!currentUserId) {
      setError('Authentication error');
      return;
    }
  
    setUploadingVideoLoop(true);
    setVideoUploadProgress(0);
    setVideoUploadStartTime(Date.now());
    setError(null);
  
    try {
      // Extract video metadata first
      console.log('Extracting video metadata...');
      const metadata = await getVideoMetadata(file);
      console.log('Video metadata extracted:', {
        duration: metadata.duration,
        size: metadata.size,
        width: metadata.width,
        height: metadata.height,
        bitrate: metadata.bitrate
      });
  
      // Generate timestamp once and use it consistently
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const originalName = file.name;
      const sanitizedName = sanitizeFileName(originalName);
      const fileName = `video_loop_${timestamp}_${sanitizedName}`;
      const filePath = `${currentUserId}/video_loops/${fileName}`;
  
      // Optional: Show notification if filename was changed
      if (originalName !== sanitizedName) {
        console.log(`Filename sanitized: "${originalName}" → "${sanitizedName}"`);
      }
  
      // Upload using TUS
      const result = await uploadWithTus({
        file,
        bucket: 'audio',
        path: filePath,
        contentType: 'video/mp4',
        onProgress: (bytesUploaded, bytesTotal) => {
          const progress = Math.round((bytesUploaded / bytesTotal) * 100);
          setVideoUploadProgress(progress);
        },
        onError: (error) => {
          console.error('Video upload error:', error);
          setError(error.message || 'Failed to upload video loop');
        },
        onSuccess: (publicUrl) => {
          console.log('Video loop uploaded successfully:', {
            fileName,
            filePath,
            publicUrl,
            metadata
          });
        }
      });
  
      if (!result.success) {
        throw new Error(result.error || 'Failed to upload video loop');
      }
  
      // Store metadata in state
      setUploadedVideoMetadata(metadata);
      setUploadedVideoLoopFile(file);
      
      // Update settings with both URL and metadata
      setSettings(prev => ({ 
        ...prev, 
        videoLoopUrl: result.publicUrl,
        videoLoopMetadata: metadata
      }));
      
      // Update parent state
      setVideoLoopUrl(result.publicUrl!);
      setError(null);
    } catch (err: any) {
      console.error('Video loop upload error:', err);
      setError(err.message || 'Failed to upload video loop');
      setUploadedVideoMetadata(null);
    } finally {
      setUploadingVideoLoop(false);
      setVideoUploadProgress(0);
    }
  };

  // Updated handleVideoFileUpload function
  const handleVideoFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
  
    // Validate file type
    if (!file.type.includes('video/mp4') && !file.name.match(/\.mp4$/i)) {
      setError('Please upload a valid MP4 video file');
      return;
    }
  
    // Validate file size (3GB limit)
    const maxFileSize = 3 * 1024 * 1024 * 1024; // 3GB
    if (file.size > maxFileSize) {
      setError('Video file must be under 3GB');
      return;
    }
  
    if (!currentUserId) {
      setError('Authentication error');
      return;
    }
  
    setUploadingVideoLoop(true);
    setVideoUploadProgress(0);
    setVideoUploadStartTime(Date.now());
    setError(null);
  
    try {
      // Extract video metadata first
      console.log('Extracting video metadata...');
      const metadata = await getVideoMetadata(file);
      console.log('Video metadata extracted:', {
        duration: metadata.duration,
        size: metadata.size,
        width: metadata.width,
        height: metadata.height,
        bitrate: metadata.bitrate
      });
  
      // Generate timestamp once and use it consistently
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const originalName = file.name;
      const sanitizedName = sanitizeFileName(originalName);
      const fileName = `video_loop_${timestamp}_${sanitizedName}`;
      const filePath = `${currentUserId}/video_loops/${fileName}`;
  
      // Optional: Show notification if filename was changed
      if (originalName !== sanitizedName) {
        console.log(`Filename sanitized: "${originalName}" → "${sanitizedName}"`);
      }
  
      // Upload using TUS
      const result = await uploadWithTus({
        file,
        bucket: 'audio',
        path: filePath,
        contentType: 'video/mp4',
        onProgress: (bytesUploaded, bytesTotal) => {
          const progress = Math.round((bytesUploaded / bytesTotal) * 100);
          setVideoUploadProgress(progress);
        },
        onError: (error) => {
          console.error('Video upload error:', error);
          setError(error.message || 'Failed to upload video loop');
        },
        onSuccess: (publicUrl) => {
          console.log('Video loop uploaded successfully:', {
            fileName,
            filePath,
            publicUrl,
            metadata
          });
        }
      });
  
      if (!result.success) {
        throw new Error(result.error || 'Failed to upload video loop');
      }
  
      // Store metadata in state
      setUploadedVideoMetadata(metadata);
      setUploadedVideoLoopFile(file);
      
      // Update settings with both URL and metadata
      setSettings(prev => ({ 
        ...prev, 
        videoLoopUrl: result.publicUrl,
        videoLoopMetadata: metadata
      }));
      
      // Update parent state
      setVideoLoopUrl(result.publicUrl!);
      setError(null);
    } catch (err: any) {
      console.error('Video loop upload error:', err);
      setError(err.message || 'Failed to upload video loop');
      setUploadedVideoMetadata(null);
    } finally {
      setUploadingVideoLoop(false);
      setVideoUploadProgress(0);
    }
  };

  // Handle audio file upload - UPDATED TO USE TUS
  const handleAudioFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
  
    // Validate file type
    if (!file.type.includes('audio/') && !file.name.match(/\.(mp3|wav)$/i)) {
      setError('Please upload a valid MP3 or WAV audio file');
      return;
    }
  
    // Validate file size (3GB limit)
    const maxFileSize = 3 * 1024 * 1024 * 1024; // 3GB
    if (file.size > maxFileSize) {
      setError('Audio file must be under 3GB');
      return;
    }
  
    if (!currentUserId) {
      setError('Authentication error');
      return;
    }
  
    setAudioUploadProgress(0);
    setAudioUploadStartTime(Date.now());
  
    try {
      // Determine group_id based on story source
      let groupId: string;
      
      if (settings.storySource === 'existing' && settings.selectedStoryDoc) {
        const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
        if (selectedDoc?.group_id) {
          groupId = selectedDoc.group_id;
        } else {
          throw new Error('Selected story document does not have a group_id');
        }
      } else if (settings.storySource === 'upload' && uploadedDocId) {
        const uploadedDoc = documents.find(doc => doc.id === uploadedDocId);
        if (uploadedDoc?.group_id) {
          groupId = uploadedDoc.group_id;
        } else {
          throw new Error('Uploaded document does not have a group_id');
        }
      } else {
        groupId = crypto.randomUUID();
      }
  
      // Upload to stories bucket using TUS
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileExtension = file.name.split('.').pop()?.toLowerCase() || 'mp3';
      const originalName = file.name;
      const sanitizedName = sanitizeFileName(originalName);
      const fileName = `audio_${timestamp}_${sanitizedName}`;
      const filePath = `documents/${currentUserId}/${groupId}/${fileName}`;
  
      // Optional: Show notification if filename was changed
      if (originalName !== sanitizedName) {
        console.log(`Filename sanitized: "${originalName}" → "${sanitizedName}"`);
      }
  
      // Upload using TUS
      const result = await uploadWithTus({
        file,
        bucket: 'stories',
        path: filePath,
        contentType: file.type,
        onProgress: (bytesUploaded, bytesTotal) => {
          const progress = Math.round((bytesUploaded / bytesTotal) * 100);
          setAudioUploadProgress(progress);
        },
        onError: (error) => {
          console.error('Audio upload error:', error);
          setError(error.message || 'Failed to upload audio file');
        },
        onSuccess: (publicUrl) => {
          console.log('Audio file uploaded successfully:', {
            fileName,
            filePath,
            publicUrl
          });
        }
      });
  
      if (!result.success) {
        throw new Error(result.error || 'Failed to upload audio file');
      }
  
      // Insert document metadata into story_documents with version 7 (audio file)
      const { data, error: insertError } = await supabase
        .from('story_documents')
        .insert({
          id: crypto.randomUUID(),
          user_id: currentUserId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          file_path: filePath,
          title: sanitizedName.replace(/\.(mp3|wav)$/i, ''),
          description: 'Uploaded audio file for video generation',
          word_count: 0,
          version: 7, // Audio file version
          is_corrected: false,
          is_prompted: false,
          group_id: groupId,
          variant: 1,
          file_size: file.size,
        })
        .select()
        .single();
  
      if (insertError) {
        throw new Error(`Failed to save audio metadata: ${insertError.message}`);
      }
  
      // Update states
      setUploadedAudioFile(file);
      setUploadedAudioDocId(data.id);
      setSettings(prev => ({ ...prev, selectedAudioFile: data.id }));
  
      // Calculate audio duration for the uploaded file
      console.log('[VideoGenerator] Calculating audio duration for uploaded file:', data.id);
      await handleCalculateAudioDuration(data.id);

      // Refresh audio files list
      const { data: updatedAudioFiles, error: fetchError } = await supabase
        .from('story_documents')
        .select('*')
        .eq('user_id', currentUserId)
        .in('version', [7, 8, 9, 10])
        .order('created_at', { ascending: false });
  
      if (fetchError) throw fetchError;
      
      setAudioFolders(updatedAudioFiles || []);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to upload audio file');
    } finally {
      setAudioUploadProgress(0);
    }
  };

  // UPDATED: Handle file upload with language selection
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
  
    // Validate file type
    if (file.type !== 'text/plain' && !file.name.endsWith('.txt')) {
      setError('Please upload a valid .txt file');
      return;
    }
  
    // NEW: Validate language selection
    if (!uploadLanguage) {
      setError('Please select a language before uploading the file');
      return;
    }
  
    // Validate file size (1MB limit)
    const maxFileSizeBytes = MAX_FILE_SIZE_MB * 1024 * 1024;
    if (file.size > maxFileSizeBytes) {
      setError(`File size exceeds limit. Maximum allowed: ${Math.round(maxFileSizeBytes / 1024)} KB`);
      return;
    }
  
    if (!currentUserId) {
      setError('Authentication error');
      return;
    }
  
    // Sanitize filename
    const originalName = file.name;
    const sanitizedName = sanitizeFileName(originalName);
  
    // Optional: Show notification if filename was changed
    if (originalName !== sanitizedName) {
      console.log(`Filename sanitized: "${originalName}" → "${sanitizedName}"`);
    }
  
    // Read file content for word count validation
    let fileContent: string;
    try {
      fileContent = await file.text();
    } catch (err: any) {
      setError('Failed to read file content');
      return;
    }
  
    const wordCount = calculateWordCount(fileContent);
  
    // Check word count limit
    if (wordCount > MAX_WORD_COUNT) {
      setError(`File exceeds the maximum word count limit of ${MAX_WORD_COUNT.toLocaleString()} words. Your file has ${wordCount.toLocaleString()} words.`);
      return;
    }
  
    // Use existing group_id if available, otherwise generate new one
    let uniqueGroupId: string;
    
    if (settings.storySource === 'existing' && settings.selectedStoryDoc) {
      // If we're working with an existing story, try to use its group_id
      const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
      uniqueGroupId = selectedDoc?.group_id || crypto.randomUUID();
    } else {
      // For new uploads, generate a new group_id
      uniqueGroupId = crypto.randomUUID();
    }
  
    // Generate file path with unique group_id
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${sanitizedName.replace(/\s+/g, '-')}_${timestamp}.txt`;
    const filePath = `documents/${currentUserId}/${uniqueGroupId}/${fileName}`;
  
    try {
      // Upload file to Supabase storage
      const { error: uploadError } = await supabase.storage
        .from('stories')
        .upload(filePath, file, {
          contentType: 'text/plain',
          upsert: true,
        });
  
      if (uploadError) {
        throw new Error(`Failed to upload file: ${uploadError.message}`);
      }
  
      // NEW: Insert document metadata into story_documents with text_language
      const { data, error: insertError } = await supabase
        .from('story_documents')
        .insert({
          id: crypto.randomUUID(),
          user_id: currentUserId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          file_path: filePath,
          title: sanitizedName.replace(/\.txt$/, ''),
          description: 'Uploaded document for video generation',
          word_count: wordCount,
          version: 1,
          is_corrected: false,
          is_prompted: false,
          group_id: uniqueGroupId,
          variant: 1,
          file_size: file.size,
          language: uploadLanguage, // NEW: Store the selected language
        })
        .select()
        .single();
  
      if (insertError) {
        // Cleanup: remove uploaded file if metadata insertion fails
        await supabase.storage.from('stories').remove([filePath]);
        throw new Error(`Failed to save document metadata: ${insertError.message}`);
      }
  
      // Update state
      setUploadedFile(file);
      setUploadedDocId(data.id);
      setSettings(prev => ({
        ...prev,
        selectedStoryDoc: data.id, // ADD THIS LINE - Set the document ID in settings
        storySource: 'upload',
        storyTitle: data.title // Also update the title
      }));
  
      // Refresh documents list
      const { data: updatedDocs, error: fetchError } = await supabase
        .from('story_documents')
        .select('*')
        .eq('user_id', currentUserId)
        .order('created_at', { ascending: false });
  
      if (fetchError) throw fetchError;
      
      // Filter story documents (version 1, 2, 3, or 4) - include image prompt docs
      const storyDocs = (updatedDocs || []).filter(doc => [1, 2, 3, 4].includes(doc.version));
      setDocuments(storyDocs);
  
      // Update storage usage
      const totalSize = (updatedDocs || []).reduce((sum, doc) => sum + (doc.file_size || (doc.word_count ? doc.word_count * 1.5 : 0)), 0);
      const totalSizeMB = totalSize / (1024 * 1024);
      const formattedSize = totalSizeMB > 0 && totalSizeMB < 0.05 ? 0.1 : Number(totalSizeMB.toFixed(totalSizeMB < 1 ? 1 : 2));
      setStorageUsed(formattedSize);
    } catch (err: any) {
      setError(err.message || 'Failed to upload file');
    }
  };

  // Combined voice samples passed as prop to ConfigurationSteps (not used for playback here)
  const voiceSamples = {
    ...coreVoiceSamples,
    ...premiumVoiceSamples,
    ...apexVoiceSamples
  };

  // Handle voice sample playback
  // VoiceSelector owns all audio playback internally; this callback only syncs visual state
  const handlePlayVoiceSample = (voice: string) => {
    if (playingVoice === voice) {
      setPlayingVoice(null);
      return;
    }
    setPlayingVoice(voice);
  };

  // Helper function to check if all required fields are configured
  const isStepConfigured = (stepNumber: number): boolean => {
    switch (stepNumber) {
      case 1: // Story Configuration
        if (settings.storySource === 'new') {
          return !!(settings.storyTitle && settings.storyDescription && settings.wordCount && !wordCountError);
        } else if (settings.storySource === 'existing') {
          return !!settings.selectedStoryDoc;
        } else if (settings.storySource === 'upload') {
          return !!uploadedFile;
        }
        return false;
        
      case 2: // Audio Configuration
        if (settings.audioSource === 'generate') {
          // For generate, we need a story to be configured (to know word count)
          if (!isStepConfigured(1)) return false;
          if (!settings.selectedVoice) return false;
          return true;
        } else if (settings.audioSource === 'existing') {
          // For existing audio, we can proceed without Step 1 configured
          return !!settings.selectedAudioFile;
        } else if (settings.audioSource === 'upload') {
          // For uploaded audio, we can proceed without Step 1 configured
          return !!settings.selectedAudioFile || !!uploadedAudioFile || !!uploadedAudioDocId;
        }
        return settings.audioSource === 'generate';
        
      case 3: // Image Configuration
        if (settings.imageSource === 'generate') {
          return Object.keys(validationErrors).length === 0;
        } else if (settings.imageSource === 'folder' && settings.storySource !== 'new') {
          const vt = settings.visualType || 'image';
          if (vt === 'ttv') {
            return !!(settings.selectedTTVFolder && settings.ttvPromptDoc);
          } else if (vt === 'itv') {
            return !!(settings.selectedITVVideoFolder && settings.itvVideoPromptDoc &&
                      settings.selectedITVImageFolder && settings.itvImagePromptDoc);
          }
          // Default: image
          return !!(settings.selectedImageFolder && settings.imagePromptDoc);
        } else if (settings.imageSource === 'upload') {
          return !!settings.uploadedVideoFile || !!uploadedVideoLoopFile;
        }
        return settings.imageSource === 'generate';
        
      default:
        return false;
    }
  };

  // UPDATED: Handle analyze video - now includes output type flags
  const handleAnalyzeVideo = async () => {
    if (!currentUserId) {
      setError('Authentication error');
      return;
    }
  
    if (validateWordCount(settings.wordCount, settings.model) !== null && settings.storySource === 'new') {
      setError('Please fix the word count error before analyzing');
      return;
    }
  
    if (!validateSettings()) {
      setError('Please fix the frequency validation errors before analyzing');
      return;
    }

    // Check token estimate for story generation if using new story with master prompt
    if (settings.storySource === 'new' && masterPromptEnabled && settings.processStory) {
      const wordCount = parseInt(settings.wordCount);
      const estimatedStoryTokens = estimateStoryTokensForVideo(
        wordCount,
        settings.model,
        masterPromptEnabled,
        masterPromptEnhanceAI,
        isLegacy
      );
      
      if (estimatedStoryTokens > userTokenBalance) {
        setError(
          `Insufficient tokens for story generation. Required: ${formatNumber(estimatedStoryTokens)}, Available: ${formatNumber(userTokenBalance)}. ` +
          (masterPromptEnhanceAI ? 'Try disabling AI Enhancement in the master prompt to reduce token usage.' : '')
        );
        return;
      }
    }
  
    setAnalyzing(true);
    setError(null);
    setMultiTabWarning(null); // Clear any multi-tab warning when re-analyzing
    console.log('=== Starting Video Analysis ===');
  
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('Authentication required');
      }

      // FIXED: Determine voice model version based on selected voice
      let modelVersion: 'v7' | 'lemonfox' | 'speechify' | 'clone' | 'elevenlabs';
      if (settings.selectedVoice.includes(':')) {
        const [type] = settings.selectedVoice.split(':');
        if (type === 'core') {
          modelVersion = 'lemonfox';
        } else if (type === 'premium') {
          modelVersion = 'v7';
        } else if (type === 'apex') {
          modelVersion = 'speechify';
        } else if (type === 'clone') {
          modelVersion = 'clone';
        } else if (type === 'elevenlabs') {
          modelVersion = 'elevenlabs';
        } else {
          modelVersion = 'lemonfox';
        }
      } else {
        modelVersion = 'lemonfox';
      }

      // NEW: Map frontend animation values to backend values
      const mapAnimationForBackend = (animation: string) => {
        if (animation === 'horizontal_drift' || animation === 'drift') return 'drift';
        if (animation === 'vertical') return 'vertical';
        if (animation === 'ken_burns') return 'ken_burns';
        if (animation === 'none') return 'none';
        return animation;
      };
  
      // Build base request data
      let requestData: any = {
        user_id: currentUserId,
        story_title: settings.storyTitle,
        description: settings.storyDescription,
        language: settings.language,
        model: settings.imagePromptModel, // AI model for generating image prompts (deepseek/sonnet/opus)
        image_model: resolveImageModelBackend(settings.imageModel), // Image quality model
        imagePromptModel: settings.imagePromptModel, // AI image prompts (deepseek/sonnet/opus)
        story_model: settings.model, // Story generation model
        image_prompt_model: settings.imagePromptModel, // ADDED: AI model for image prompts
        voice: settings.selectedVoice.includes(':') ? settings.selectedVoice.split(':')[1] : settings.selectedVoice,
        model_version: modelVersion, // FIXED: Add the correct model version
        elevenlabs_model_id: modelVersion === 'elevenlabs' ? elevenLabsModelId : undefined,
        audio_speed: settings.audioSpeed,
        volume: settings.audioVolume || 1.0,
        existing_audio_volume: settings.existingAudioVolume || 1.0, // NEW: Add existing audio volume
        background_music_volume: settings.backgroundMusicVolume || 1.0, // NEW: Add background music volume
        remove_title_chapters: settings.removeTitleChapters,
        
        // Master prompt fields for token estimation
        master_prompt: masterPromptEnabled ? masterPromptData : null,
        master_prompt_enhance_ai: masterPromptEnabled && masterPromptEnhanceAI,
        pauses: pauseTTS,
  
        bg_music: backgroundMusicUrl,
        
        // ADD TRANSITION TYPE
        transition_type: selectedTransition === 'none' ? null : selectedTransition,
        
        // ADD ANIMATION AND EFFECTS WITH MAPPING
        animation_type: mapAnimationForBackend(selectedAnimation),
        effects_type: selectedEffect === 'none' ? null : selectedEffect,
        
        // Optional burn-in subtitles. NULL = no subtitles (existing behavior preserved)
        subtitles: subtitlesEnabled ? subtitleConfig : null,
        
        // Usage flags
        use_existing_story: settings.storySource === 'existing',
        use_existing_images: settings.imageSource === 'folder' || settings.imageSource === 'upload',
        use_existing_audio: settings.audioSource === 'existing' || settings.audioSource === 'upload',
        
        // Background music and video loop
        background_music_url: settings.backgroundMusicUrl || null,
        video_loop: videoLoopUrl || null, // USE PARENT STATE
        loop_time: settings.sameAsAudioLength ? null : convertTimeToSeconds(settings.loopTimeHours, settings.loopTimeMinutes),
        
        // NEW: Output type and component selection flags
        video: settings.outputType === 'video',
        process_story: settings.processStory,
        process_images: settings.processImages,
        process_audio: settings.processAudio,

        // Visual pipeline type
        visual_type: settings.visualType || 'image',
        // TTV fields (only relevant when visual_type is 'ttv')
        video_model: settings.visualType === 'ttv' ? ttvModel : undefined,
        video_duration: settings.visualType === 'ttv' ? ttvDuration : undefined,
        audio_clip: settings.visualType === 'ttv' ? ttvAudioClip : settings.visualType === 'itv' ? itvAudioClip : false,
        process_ttv: settings.visualType === 'ttv',
        // ITV fields (only relevant when visual_type is 'itv')
        itv_model: settings.visualType === 'itv' ? itvModel : undefined,
        itv_duration: settings.visualType === 'itv' ? itvDuration : undefined,
        process_itv: settings.visualType === 'itv',
        // MG fields (only relevant when visual_type is 'mg')
        mg_style_slug: settings.visualType === 'mg' ? ((settings.mgCustomStyle && settings.mgCustomStyle.trim()) ? 'custom' : (settings.mgStyleSlug || MG_DEFAULT_STYLE_SLUG)) : undefined,
        mg_style_guidance: settings.visualType === 'mg' ? ((settings.mgCustomStyle && settings.mgCustomStyle.trim()) || settings.mgStyleGuidance || resolveStyleGuidance(settings.mgStyleSlug || MG_DEFAULT_STYLE_SLUG)) : undefined,
        mg_clip_duration: settings.visualType === 'mg' ? (settings.mgClipDuration || MG_DEFAULT_CLIP_SECONDS) : undefined,
        mg_codegen_model: settings.visualType === 'mg' ? (settings.mgCodegenModel === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-6') : undefined,
        process_mg: settings.visualType === 'mg',

        // Subtitles flag — drives create-final-video subtitle burn cost in
        // the backend token estimator (instead of patching it on client-side).
        subtitles_enabled: subtitlesEnabled,
      };
  
      // NEW: Add video loop metadata if available
      if (uploadedVideoMetadata || settings.videoLoopMetadata) {
        const metadata = uploadedVideoMetadata || settings.videoLoopMetadata;
        requestData.video_loop_metadata = {
          duration: metadata!.duration,
          size: metadata!.size,
          bitrate: metadata!.bitrate
        };
        console.log('Including video loop metadata in analysis:', requestData.video_loop_metadata);
      }
  
      // Add story-specific data
      if (settings.storySource === 'new') {
        console.log('Processing new story with word count:', settings.wordCount);
        requestData.word_count = parseInt(settings.wordCount);
        // ALWAYS add frequencies for new stories that will generate images
        if (settings.imageSource === 'generate' && settings.processImages) {
          // NEW: Add frequency configuration based on mode
          if (frequencyMode === 'audio') {
            // Audio mode: use image amount and audio duration
            requestData.frequency_mode = 'audio';
            requestData.image_amount = parseInt(imageAmount);
            requestData.total_audio_duration = parseFloat(totalAudioDuration);
            requestData.audio_distribution_type = audioDistributionType;
            if (audioDistributionType === 'variable') {
              requestData.first_page_image_amount = parseInt(firstPageImageAmount);
              requestData.rest_image_amount = parseInt(restImageAmount);
            }
            console.log('Added audio mode frequency config:', {
              frequency_mode: 'audio',
              image_amount: requestData.image_amount,
              total_audio_duration: requestData.total_audio_duration,
              audio_distribution_type: requestData.audio_distribution_type
            });
          } else {
            // Wordcount mode: use time-based frequencies
            requestData.frequency_mode = 'wordcount';
            requestData.frequency_type = frequencyType;
            if (frequencyType === 'consistent') {
              requestData.consistent_frequency = parseInt(consistentFrequency);
            } else {
              requestData.first_page_frequency = parseFloat(settings.firstPageFrequency);
              requestData.rest_frequency = parseFloat(settings.restFrequency);
            }
            console.log('Added wordcount mode frequency config:', {
              frequency_mode: 'wordcount',
              frequency_type: frequencyType,
              ...(frequencyType === 'consistent' 
                ? { consistent_frequency: requestData.consistent_frequency }
                : { first_page_frequency: requestData.first_page_frequency, rest_frequency: requestData.rest_frequency }
              )
            });
          }
        }
      } else if (settings.storySource === 'existing') {
        console.log('Processing existing story:', settings.selectedStoryDoc);
        const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
        if (!selectedDoc) {
          throw new Error('Selected story document not found');
        }
        requestData.file_path = selectedDoc.file_path;
        requestData.doc_id = selectedDoc.id;
        requestData.story_title = selectedDoc.title;
        requestData.description = selectedDoc.description || '';
        // Add word_count as fallback in case file cannot be accessed
        if (selectedDoc.word_count) {
          requestData.word_count = selectedDoc.word_count;
        }
        
        // Add frequencies for existing stories too if generating images
        if (settings.imageSource === 'generate' && settings.processImages) {
          // NEW: Add frequency configuration based on mode
          if (frequencyMode === 'audio') {
            requestData.frequency_mode = 'audio';
            requestData.image_amount = parseInt(imageAmount);
            requestData.total_audio_duration = parseFloat(totalAudioDuration);
            requestData.audio_distribution_type = audioDistributionType;
            if (audioDistributionType === 'variable') {
              requestData.first_page_image_amount = parseInt(firstPageImageAmount);
              requestData.rest_image_amount = parseInt(restImageAmount);
            }
          } else {
            requestData.frequency_mode = 'wordcount';
            requestData.frequency_type = frequencyType;
            if (frequencyType === 'consistent') {
              requestData.consistent_frequency = parseInt(consistentFrequency);
            } else {
              requestData.first_page_frequency = parseFloat(settings.firstPageFrequency);
              requestData.rest_frequency = parseFloat(settings.restFrequency);
            }
          }
          console.log('Added frequencies for existing story:', requestData);
        }
      } else if (settings.storySource === 'upload') {
        console.log('Processing uploaded file:', uploadedFile?.name);
        if (!uploadedDocId) {
          throw new Error('Uploaded document ID not found');
        }
        const uploadedDoc = documents.find(doc => doc.id === uploadedDocId);
        if (uploadedDoc) {
          requestData.use_existing_story = true;
          requestData.file_path = uploadedDoc.file_path;
          requestData.doc_id = uploadedDoc.id;
          requestData.story_title = uploadedDoc.title;
          requestData.description = uploadedDoc.description || '';
          // Add word_count as fallback in case file cannot be accessed
          if (uploadedDoc.word_count) {
            requestData.word_count = uploadedDoc.word_count;
          }
          // NEW: Include text_language from uploaded document
          requestData.language = uploadedDoc.language || uploadLanguage;
        } else {
          throw new Error('Uploaded document not found in documents array');
        }
        
        // Add frequencies for uploaded files too if generating images
        if (settings.imageSource === 'generate' && settings.processImages) {
          // NEW: Add frequency configuration based on mode
          if (frequencyMode === 'audio') {
            requestData.frequency_mode = 'audio';
            requestData.image_amount = parseInt(imageAmount);
            requestData.total_audio_duration = parseFloat(totalAudioDuration);
            requestData.audio_distribution_type = audioDistributionType;
            if (audioDistributionType === 'variable') {
              requestData.first_page_image_amount = parseInt(firstPageImageAmount);
              requestData.rest_image_amount = parseInt(restImageAmount);
            }
          } else {
            requestData.frequency_mode = 'wordcount';
            requestData.frequency_type = frequencyType;
            if (frequencyType === 'consistent') {
              requestData.consistent_frequency = parseInt(consistentFrequency);
            } else {
              requestData.first_page_frequency = parseFloat(settings.firstPageFrequency);
              requestData.rest_frequency = parseFloat(settings.restFrequency);
            }
          }
          console.log('Added frequencies for uploaded file:', requestData);
        }
      }
  
      // Add image generation parameters
      if (settings.imageSource === 'generate' && settings.processImages) {
        requestData.image_style = settings.imageStyle;
        requestData.use_character_descriptions = settings.useCharacterDescriptions;
        // Custom characters
        requestData.customCharactersEnabled = customCharactersEnabled;
        requestData.customCharacters = customCharactersEnabled ? customCharacters.filter(c => c.name.trim()) : [];
        requestData.customCharactersAIEnhance = customCharactersAIEnhance;
        console.log('Added image generation parameters');
      } else if (settings.imageSource === 'folder' && settings.selectedImageFolder) {
        const selectedImageFolder = imageFolders.find(folder => folder.id === settings.selectedImageFolder);
        if (selectedImageFolder) {
          requestData.images_folder_path = selectedImageFolder.file_path;
          const imageCount = await getImageCountFromFolder(selectedImageFolder.file_path);
          if (imageCount > 0) {
            requestData.num_images = imageCount;
          }
          console.log('Added image folder path:', selectedImageFolder.file_path, 'with', imageCount, 'images');
        }
      }
  
      // TTV folder: count existing MP4 clips for accurate estimation
      if (settings.visualType === 'ttv' && settings.selectedTTVFolder) {
        const selectedTTVFolderDoc = ttvFolders.find(f => f.id === settings.selectedTTVFolder);
        if (selectedTTVFolderDoc?.file_path) {
          requestData.ttv_folder_path = selectedTTVFolderDoc.file_path;
          const clipCount = await getTTVClipCountFromFolder(selectedTTVFolderDoc.file_path);
          if (clipCount > 0) {
            requestData.num_images = clipCount;
            console.log(`TTV folder "${selectedTTVFolderDoc.file_path}": counted ${clipCount} MP4 clips, passing as num_images`);
          }
        }
        if (settings.ttvPromptDoc) {
          const selectedTTVPromptDoc = ttvPromptDocs.find(d => d.id === settings.ttvPromptDoc);
          if (selectedTTVPromptDoc?.file_path) {
            requestData.ttv_prompt_path = selectedTTVPromptDoc.file_path;
          }
        }
      }

      // ITV folder: count existing MP4 clips for accurate estimation
      if (settings.visualType === 'itv' && settings.selectedITVVideoFolder) {
        const selectedITVVideoFolderDoc = itvVideoFolders.find(f => f.id === settings.selectedITVVideoFolder);
        if (selectedITVVideoFolderDoc?.file_path) {
          requestData.itv_video_folder_path = selectedITVVideoFolderDoc.file_path;
          const clipCount = await getTTVClipCountFromFolder(selectedITVVideoFolderDoc.file_path);
          if (clipCount > 0) {
            requestData.num_images = clipCount;
            console.log(`ITV video folder "${selectedITVVideoFolderDoc.file_path}": counted ${clipCount} MP4 clips, passing as num_images`);
          }
        }
        if (settings.itvVideoPromptDoc) {
          const selectedITVVideoPrompt = itvVideoPromptDocs.find(d => d.id === settings.itvVideoPromptDoc);
          if (selectedITVVideoPrompt?.file_path) {
            requestData.itv_video_prompt_path = selectedITVVideoPrompt.file_path;
          }
        }
      }

      // Add audio settings
      if (settings.audioSource === 'generate' && settings.processAudio) {
        // Voice type detection will be handled in ConfigurationSteps
        requestData.model_version = modelVersion; // Use the determined model version
        if (modelVersion === 'elevenlabs') {
          requestData.elevenlabs_model_id = elevenLabsModelId;
        }
        console.log('Added audio generation parameters with model version:', requestData.model_version);
      } else if ((settings.audioSource === 'existing' || settings.audioSource === 'upload') && settings.selectedAudioFile) {
        const selectedAudioFile = audioFolders.find(file => file.id === settings.selectedAudioFile);
        if (selectedAudioFile) {
          if ([9, 10].includes(selectedAudioFile.version || 0)) {
            requestData.audio_folder_path = selectedAudioFile.file_path;
          } else {
            requestData.audio_file_path = selectedAudioFile.file_path;
          }
          console.log('Added audio file/folder path:', selectedAudioFile.file_path);
        }
      }

      // For ITV generate mode, send the actual known audio duration so the backend
      // can calculate clip count the same way the in-page estimate does.
      if (settings.visualType === 'itv' && settings.imageSource === 'generate' && calculatedAudioDuration && calculatedAudioDuration > 0) {
        requestData.total_audio_duration = calculatedAudioDuration;
        console.log(`ITV: passing calculatedAudioDuration=${calculatedAudioDuration}s as total_audio_duration`);
      }
  
      console.log('Final request data being sent to video-analyze:', JSON.stringify(requestData, null, 2));
  
      const response = await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/video-analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(requestData),
      });
  
      console.log('Response status:', response.status);
  
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Analysis error response:', errorData);
        throw new Error(errorData.error || `HTTP ${response.status}: Analysis failed`);
      }
  
      const result = await response.json();
      console.log('Analysis result received:', JSON.stringify(result, null, 2));

      // Subtitles cost is now included in result.estimatedTokens /
      // estimatedGenerationTimeMinutes by video-analyze (driven by the
      // subtitles_enabled flag we passed in requestData), so no client-side
      // patching is needed. Frontend just trusts the backend numbers.
      const baseTokens = result.estimatedTokens || 0;
      const baseMinutes = result.estimatedGenerationTimeMinutes || 0;
      const baseVideoMinutes = result.estimatedVideoTimeMinutes || 0;

      setAnalysisResult({
        estimatedTokens: baseTokens,
        estimatedStorageMB: result.estimatedStorageMB,
        estimatedVideoTimeMinutes: baseVideoMinutes,
        estimatedGenerationTimeMinutes: baseMinutes,
        breakdown: result.breakdown,
        settings: result.settings,
      });

      console.log('Analysis complete - estimated generation time:',
        baseMinutes,
        'minutes (subtitles:', subtitlesEnabled, ', tokens:', baseTokens, ')');
      setGenerationState('analyzed');
    } catch (err: any) {
      console.error('Error in video analysis:', err);
      setError(err.message || 'Failed to analyze video settings');
    } finally {
      setAnalyzing(false);
      console.log('=== Video Analysis Complete ===');
    }
  };

  // Quick Generate: calls plan-video edge function which plans + starts generation
  const handleQuickGenerate = async () => {
    if (!currentUserId) {
      setQuickError('Please sign in to generate videos');
      return;
    }

    const prompt = quickPrompt.trim();
    if (!prompt) {
      setQuickError('Please enter a video description');
      return;
    }

    // Calculate runtime from either mode
    let runtime: number;
    if (quickIsRuntimeMode) {
      runtime = parseFloat(quickRuntimeMinutes);
      if (!runtime || isNaN(runtime)) {
        setQuickError('Please enter a valid runtime');
        return;
      }
      const words = minutesToWordCount(runtime);
      if (words < 200) {
        setQuickError('Runtime too short — word count must be at least 200');
        return;
      }
      if (words > 150000) {
        setQuickError('Runtime too long — word count cannot exceed 150,000');
        return;
      }
    } else {
      const wc = parseInt(quickWordCount);
      if (!wc || wc < 200) {
        setQuickError('Word count must be at least 200');
        return;
      }
      if (wc > 150000) {
        setQuickError('Word count cannot exceed 150,000');
        return;
      }
      runtime = Math.round(wc / WORDS_PER_MINUTE_AUDIO * 10) / 10;
    }

    // Parse budget (entered in thousands of tokens)
    const budgetThousands = parseFloat(quickTokenBudget);
    if (!budgetThousands) {
      setQuickError('Please enter a token budget');
      return;
    }
    const budget = Math.round(budgetThousands * 1000);

    // Absolute floor (cheapest-possible plan-video pipeline still costs ~800K).
    if (budget < QUICK_BUDGET_FLOOR_TOKENS) {
      setQuickError(`Token budget must be at least ${(QUICK_BUDGET_FLOOR_TOKENS / 1000).toLocaleString()}K tokens`);
      return;
    }

    // Runtime + visual-type aware minimum, derived from the same NEW-map
    // estimator plan-video uses server-side (with a small safety buffer).
    const minBudgetForDuration = minBudgetForQuickGenerate(quickVisualType, runtime);
    if (budget < minBudgetForDuration) {
      setQuickError(`A ${runtime}-minute ${quickVisualType.toUpperCase()} video needs at least ${formatNumber(minBudgetForDuration)} tokens (${(minBudgetForDuration / 1000).toLocaleString()}K)`);
      return;
    }

    if (budget > userTokenBalance) {
      setQuickError(`Token budget (${formatNumber(budget)}) exceeds your balance (${formatNumber(userTokenBalance)})`);
      return;
    }

    setQuickGenerating(true);
    setQuickError(null);
    setQuickResult(null);

    // Set planning poll sentinel BEFORE changing generationState to 'generating'.
    // This prevents the periodic-refresh, initializeFromDatabase, checkExistingTasks,
    // and onStateRestored effects from overwriting the AI Planning display.
    if (planningPollIntervalRef.current) clearInterval(planningPollIntervalRef.current);
    planningPollIntervalRef.current = -1 as any; // sentinel – truthy so all guards skip

    // ── Immediately transition to generating state ──
    // Show the generating UI right away while plan-video runs in the background
    setGenerationState('generating');
    setProgress(0);
    setStatusMessage('AI is planning your video settings...');
    setError(null);
    setSettings(prev => ({
      ...prev,
      storyTitle: 'Quick Generate Video',
      outputType: 'video',
      processStory: true,
      processImages: true,
      processAudio: true,
    }));
    setAnalysisResult({
      estimatedTokens: budget,
      estimatedStorageMB: 0,
      estimatedVideoTimeMinutes: runtime,
    });

    // Initialize with a planning step shown as active
    generationStateHook.initializeBatchStatuses([
      { id: 'planning', label: 'AI Planning', progress: 50, status: 'running' },
      { id: 'story', label: 'Story Generation', progress: 0, status: 'pending' },
      { id: 'audio', label: 'Audio Generation', progress: 0, status: 'pending' },
      { id: 'image_prompts', label: 'Image Prompts', progress: 0, status: 'pending' },
      { id: 'image_generation', label: 'Image Generation', progress: 0, status: 'pending' },
      { id: 'video', label: 'Video Creation', progress: 0, status: 'pending' },
    ] as any);

    // Generate a group ID for this quick generate (backend will use it)
    const placeholderGroupId = crypto.randomUUID();
    setCurrentGroupId(placeholderGroupId);

    // Update tab status to generating immediately
    if (currentUserId) {
      const { updateTabStatus } = await import('../utils/tabManager');
      await updateTabStatus(currentUserId, 'video', currentTab, 'generating', placeholderGroupId);
    }

    try {
      // Get session access token for secure API call
      const { data: { session: _authSession } } = await supabase.auth.getSession();
      const _accessToken = _authSession?.access_token;
      if (!_accessToken) throw new Error('Session expired. Please sign in again.');

      const response = await fetchWithFallback('https://plan-video.storyscriptai.deno.net', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${_accessToken}`,
        },
        body: JSON.stringify({
          user_id: currentUserId,
          prompt,
          token_budget: budget,
          runtime_minutes: runtime,
          language: quickLanguage,
          tab: currentTab,
          visual_type: quickVisualType !== 'default' ? quickVisualType : undefined,
          youtube_links: youtubeInspirationEnabled ? youtubeLinks.filter(l => l.trim() && !validateYoutubeUrl(l)) : undefined,
          group_id: placeholderGroupId,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || `HTTP ${response.status}: Planning failed`);
      }

      console.log('[QuickGenerate] Success:', result);
      setQuickResult(result);

      setCurrentGroupId(result.group_id);

      // Now update with real planned settings
      const plannedType = result.planned_settings?.visual_type || 'image';
      const realBatchStatuses: Array<{ id: string; label: string; progress: number; status: string }> = [];
      
      realBatchStatuses.push({ id: 'story', label: 'Story Generation', progress: 0, status: 'pending' });
      realBatchStatuses.push({ id: 'audio', label: 'Audio Generation', progress: 0, status: 'pending' });

      if (plannedType === 'ttv') {
        realBatchStatuses.push({ id: 'ttv_prompts', label: 'TTV Prompts', progress: 0, status: 'pending' });
        realBatchStatuses.push({ id: 'ttv_generation', label: 'TTV Generation', progress: 0, status: 'pending' });
      } else if (plannedType === 'itv') {
        realBatchStatuses.push({ id: 'itv_image_prompts', label: 'ITV Image Prompts', progress: 0, status: 'pending' });
        realBatchStatuses.push({ id: 'itv_image_generation', label: 'ITV Image Generation', progress: 0, status: 'pending' });
        realBatchStatuses.push({ id: 'itv_prompts', label: 'ITV Prompts', progress: 0, status: 'pending' });
        realBatchStatuses.push({ id: 'itv_generation', label: 'ITV Generation', progress: 0, status: 'pending' });
      } else if (plannedType === 'mg') {
        realBatchStatuses.push({ id: 'mg_prompts', label: 'MG Prompts', progress: 0, status: 'pending' });
        realBatchStatuses.push({ id: 'mg_render', label: 'MG Render', progress: 0, status: 'pending' });
      } else {
        realBatchStatuses.push({ id: 'image_prompts', label: 'Image Prompts', progress: 0, status: 'pending' });
        realBatchStatuses.push({ id: 'image_generation', label: 'Image Generation', progress: 0, status: 'pending' });
      }

      realBatchStatuses.push({ id: 'video', label: 'Video Creation', progress: 0, status: 'pending' });

      // Keep planning display while we wait for story generation to start
      // Update settings with planned visual type so polling works correctly
      setSettings(prev => ({
        ...prev,
        storyTitle: result.planned_settings?.story_title || 'Quick Generate Video',
        visualType: plannedType as any,
      }));

      // Update analysis result with actual estimate
      setAnalysisResult({
        estimatedTokens: result.estimated_tokens,
        estimatedStorageMB: 0,
        estimatedVideoTimeMinutes: runtime,
      });

      // Update tab with group_id now that we have it
      if (currentUserId) {
        const { updateTabStatus } = await import('../utils/tabManager');
        await updateTabStatus(currentUserId, 'video', currentTab, 'generating', result.group_id);
      }

      setStatusMessage('AI planned settings & started video generation...');

      // Poll story_tasks for actual progress — only swap to real batch statuses
      // once story generation progress is > 0% (not just story_status = 'running').
      // The sentinel was set above; now replace it with the real interval.
      planningPollIntervalRef.current = setInterval(async () => {
        try {
          const { data: storyTasks } = await supabase
            .from('story_tasks')
            .select('status, progress')
            .eq('user_id', currentUserId!)
            .eq('group_id', result.group_id)
            .eq('video_process', true)
            .limit(5);

          // Need 2+ rows — the first row is a placeholder, real processing starts with batch rows
          const hasRealProgress = storyTasks && storyTasks.length >= 2;

          if (hasRealProgress) {
            if (planningPollIntervalRef.current) {
              clearInterval(planningPollIntervalRef.current);
              planningPollIntervalRef.current = null;
            }
            console.log('Story generation has real progress — switching to real batch statuses');
            generationStateHook.initializeBatchStatuses(realBatchStatuses as any);
          }
        } catch (err) {
          console.error('[QuickGenerate] Planning poll error:', err);
        }
      }, 5000);

    } catch (err: any) {
      console.error('[QuickGenerate] Error:', err);
      setQuickError(err.message || 'Failed to plan and start video generation');
      
      // Clear planning sentinel on error
      if (planningPollIntervalRef.current) {
        clearInterval(planningPollIntervalRef.current);
        planningPollIntervalRef.current = null;
      }
      
      // Revert to idle on error
      setGenerationState('idle');
      setStatusMessage('');
      setProgress(0);
      
      if (currentUserId) {
        const { updateTabStatus } = await import('../utils/tabManager');
        await updateTabStatus(currentUserId, 'video', currentTab, 'error');
      }
    } finally {
      setQuickGenerating(false);
    }
  };
  
  // UPDATED: Handle generate video - now includes output type flags and proper voice type detection
  const handleGenerateVideo = async () => {
    if (!analysisResult || !currentUserId) {
      setError('Please analyze the video first');
      return;
    }

    // MULTI-TAB VALIDATION: For tabs other than Tab 1, check total estimates across all tabs
    if (isEnterpriseUser && currentTab !== 1) {
      try {
        const { getTotalEstimateTokensForPage } = await import('../utils/tabManager');
        const { total: existingTotal, tabEstimates } = await getTotalEstimateTokensForPage(currentUserId, 'video');
        
        // Calculate total including current tab's estimate
        const totalEstimate = existingTotal + analysisResult.estimatedTokens;
        
        // Check if total exceeds user balance AND if other tabs have estimates
        if (totalEstimate > userTokenBalance && tabEstimates.length > 0) {
          // Set multi-tab warning state (will be handled by VideoConfiguration UI)
          setMultiTabWarning({
            currentTabEstimate: analysisResult.estimatedTokens,
            otherTabEstimates: tabEstimates,
            totalEstimate,
            userBalance: userTokenBalance
          });
          setError(`Insufficient tokens for multi-tab generation. See warning above for details.`);
          return;
        }
      } catch (err) {
        console.error('Error checking multi-tab estimates:', err);
        // Continue with generation if check fails
      }
    }

    if (analysisResult.estimatedTokens > userTokenBalance) {
      setError(`Insufficient tokens. Required: ${formatNumber(analysisResult.estimatedTokens)}, Available: ${formatNumber(userTokenBalance)}`);
      return;
    }

    // Check storage limit
    const availableStorageGB = maxStorageGB - (storageUsed || 0) / 1024;
    if (analysisResult.estimatedStorageMB / 1024 > availableStorageGB) {
      setError(`Insufficient storage. Required: ${formatStorageSize(analysisResult.estimatedStorageMB)}, Available: ${formatStorageSize(availableStorageGB * 1024)}`);
      return;
    }

    // Validate image folder selection if using folder source - ONLY for standard image pipeline
    // TTV/ITV visual types use their own folder selections (TTV folders, ITV video folders)
    if (settings.processImages && settings.imageSource === 'folder' && settings.visualType !== 'ttv' && settings.visualType !== 'itv' && settings.visualType !== 'mg') {
      if (!settings.selectedImageFolder) {
        setError('Please select an image folder');
        return;
      }
      
      const selectedImageFolder = imageFolders.find(folder => folder.id === settings.selectedImageFolder);
      if (!selectedImageFolder) {
        setError('Selected image folder not found. Please select a valid folder.');
        return;
      }
      
      if (!selectedImageFolder.file_path) {
        setError('Selected image folder has no valid path. Please select a different folder.');
        return;
      }

      // Also validate image prompt document
      if (!settings.imagePromptDoc) {
        setError('Please select an image prompt document when using existing image folder');
        return;
      }

      const selectedPromptDoc = documents.find(doc => doc.id === settings.imagePromptDoc);
      if (!selectedPromptDoc) {
        setError('Selected image prompt document not found. Please select a valid document.');
        return;
      }
    }

    // Validate video loop URL if using upload image source - ONLY if processing images
    if (settings.processImages && settings.imageSource === 'upload') {
      console.log('Checking video loop URL:', videoLoopUrl); // USE PARENT STATE
      console.log('Uploaded video loop file:', uploadedVideoLoopFile);
      
      // Check if we have either a URL or an uploaded file
      const hasVideoLoop = videoLoopUrl || uploadedVideoLoopFile; // USE PARENT STATE
      
      if (!hasVideoLoop) {
        setError('Please upload a video file for looping');
        return;
      }
    }

    // Enhanced audio validation with fallback for uploaded files - ONLY if processing audio
    if (settings.processAudio && (settings.audioSource === 'existing' || settings.audioSource === 'upload')) {
      if (!settings.selectedAudioFile) {
        // Check if we have an uploaded audio file as fallback
        if (!uploadedAudioFile && !uploadedAudioDocId) {
          setError('Please select or upload an audio file');
          return;
        }
      } else {
        // Validate that the selected audio file exists in the audioFolders array or check fallbacks
        const selectedAudioFile = audioFolders.find(file => file.id === settings.selectedAudioFile);
        if (!selectedAudioFile) {
          // Check if we have uploaded audio as fallback
          if (!uploadedAudioFile && !uploadedAudioDocId) {
            setError('Selected audio file not found or has no valid path');
            return;
          }
        } else if (!selectedAudioFile.file_path) {
          setError('Selected audio file has no valid path. Please select a different file.');
          return;
        }
      }
    }

    // NEW: Set generation loading state
    setGenerationLoading(true);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('Authentication required');
      }

      // Determine group_id based on story source
      let groupId: string;
      
      if (settings.storySource === 'existing' && settings.selectedStoryDoc) {
        // Use the existing story's group_id
        const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
        if (selectedDoc?.group_id) {
          groupId = selectedDoc.group_id;
        } else {
          throw new Error('Selected story document does not have a group_id');
        }
      } else if (settings.storySource === 'upload' && uploadedDocId) {
        // Find the uploaded document's group_id using the stored ID
        const uploadedDoc = documents.find(doc => doc.id === uploadedDocId);
        if (uploadedDoc?.group_id) {
          groupId = uploadedDoc.group_id;
        } else {
          throw new Error('Uploaded document does not have a group_id');
        }
      } else {
        // For new stories, generate a new group_id
        groupId = crypto.randomUUID();
      }

      setCurrentGroupId(groupId);

      // Determine model version and voice ID - use type-aware voice checking
      let modelVersion: 'v7' | 'clone' | 'lemonfox' | 'speechify' | 'elevenlabs';
      let language: string;
      let voiceName: string;
      let cloneVoiceName: string | undefined;
      let cloneVoiceUrl: string | undefined;
      let cloneLanguage: string | undefined;

      if (isCoreVoice(settings.selectedVoice)) {
        modelVersion = 'lemonfox';
        language = 'en-us';
        voiceName = settings.selectedVoice.includes(':') ? settings.selectedVoice.split(':')[1] : settings.selectedVoice;
      } else if (isPremiumVoice(settings.selectedVoice)) {
        modelVersion = 'v7';
        language = 'american english'; // Default fallback
        voiceName = settings.selectedVoice.includes(':') ? settings.selectedVoice.split(':')[1] : settings.selectedVoice;
      } else if (isApexVoice(settings.selectedVoice)) {
        modelVersion = 'speechify';
        language = 'american english'; // Default fallback
        voiceName = settings.selectedVoice.includes(':') ? settings.selectedVoice.split(':')[1] : settings.selectedVoice;
      } else if (isElevenLabsVoice(settings.selectedVoice)) {
        modelVersion = 'elevenlabs';
        language = 'english';
        voiceName = settings.selectedVoice.includes(':') ? settings.selectedVoice.split(':')[1] : settings.selectedVoice;
      } else if (isCloneVoice(settings.selectedVoice)) {
        modelVersion = 'clone';
        language = 'english'; // Default for clone voices
        voiceName = settings.selectedVoice.includes(':') ? settings.selectedVoice.split(':')[1] : settings.selectedVoice;
        cloneVoiceName = voiceName;
        
        // Check if it's a predefined clone voice
        const predefinedVoice = predefinedCloneVoices.find(v => v.name === voiceName);
        if (predefinedVoice) {
          cloneVoiceUrl = predefinedVoice.voice_id;
        } else {
          // Custom voice - use the workspace format
          cloneVoiceUrl = `default-ujsa1wysgyitfqg3ixpqka__${voiceName}`;
          
          // Track this as a session clone voice for cleanup
          if (sessionCloneVoiceId && sessionCloneVoiceId.endsWith(`__${voiceName}`)) {
            // This is the session clone voice we created
            console.log(`Using session clone voice: ${voiceName} -> ${sessionCloneVoiceId}`);
          }
        }
        cloneLanguage = language;
      } else {
        modelVersion = 'lemonfox';
        language = 'en-us';
        voiceName = settings.selectedVoice.includes(':') ? settings.selectedVoice.split(':')[1] : settings.selectedVoice;
      }

      // NEW: Map frontend animation values to backend values
      const mapAnimationForBackend = (animation: string) => {
        if (animation === 'horizontal_drift' || animation === 'drift') return 'drift';
        if (animation === 'vertical') return 'vertical';
        if (animation === 'ken_burns') return 'ken_burns';
        if (animation === 'none') return 'none';
        return animation;
      };

      // Prepare request data for setup-video-tasks
      let requestData: any = {
        user_id: currentUserId,
        group_id: groupId,
        tab: currentTab, // ADD TAB PARAMETER
        story_title: settings.storyTitle,
        description: settings.storyDescription,
        language: settings.language,
        model: settings.imagePromptModel, // AI model for generating image prompts (deepseek/sonnet/opus)
        image_model: resolveImageModelBackend(settings.imageModel), // Image quality model
        imagePromptModel: settings.imagePromptModel, // AI model for generating image prompts (deepseek/sonnet/opus)
        story_model: settings.model,
        output_video_name: `${settings.storyTitle}.mp4`,
        variant: 1,
        
        // NEW: Visual pipeline type
        visual_type: settings.visualType || 'image',
        // TTV fields (only relevant when visual_type is 'ttv')
        video_model: settings.visualType === 'ttv' ? ttvModel : undefined,
        video_style: settings.visualType === 'ttv' ? ttvStyle : undefined,
        video_duration: settings.visualType === 'ttv' ? ttvDuration : undefined,
        audio_clip: settings.visualType === 'ttv' ? ttvAudioClip : settings.visualType === 'itv' ? itvAudioClip : false,
        process_ttv: settings.visualType === 'ttv',
        // ITV fields (only relevant when visual_type is 'itv')
        itv_model: settings.visualType === 'itv' ? itvModel : undefined,
        itv_duration: settings.visualType === 'itv' ? itvDuration : undefined,
        process_itv: settings.visualType === 'itv',
        // MG fields (only relevant when visual_type is 'mg')
        mg_style_slug: settings.visualType === 'mg' ? ((settings.mgCustomStyle && settings.mgCustomStyle.trim()) ? 'custom' : (settings.mgStyleSlug || MG_DEFAULT_STYLE_SLUG)) : undefined,
        mg_style_guidance: settings.visualType === 'mg' ? ((settings.mgCustomStyle && settings.mgCustomStyle.trim()) || settings.mgStyleGuidance || resolveStyleGuidance(settings.mgStyleSlug || MG_DEFAULT_STYLE_SLUG)) : undefined,
        mg_clip_duration: settings.visualType === 'mg' ? (settings.mgClipDuration || MG_DEFAULT_CLIP_SECONDS) : undefined,
        mg_codegen_model: settings.visualType === 'mg' ? (settings.mgCodegenModel === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-6') : undefined,
        process_mg: settings.visualType === 'mg',
        
        // Runtime mode and master prompt
        is_runtime_mode: isRuntimeMode,
        runtime_minutes: isRuntimeMode ? parseFloat(runtimeMinutes) : null,
        master_prompt: masterPromptEnabled ? masterPromptData : null,
        master_prompt_enhance_ai: masterPromptEnabled && masterPromptEnhanceAI,
        youtube_links: youtubeInspirationEnabled ? youtubeLinks.filter(l => l.trim() && !validateYoutubeUrl(l)) : undefined,
        pauses: pauseTTS,
        
        // ADD BACKGROUND MUSIC URL:
        bg_music: backgroundMusicUrl || null,
        bg_music_volume: settings.backgroundMusicVolume || 1.0, // NEW: Background music volume
        
        // ADD VIDEO LOOP URL AND TIME - USE PARENT STATE:
        video_loop: videoLoopUrl || null, // USE PARENT STATE
        loop_time: settings.sameAsAudioLength ? null : convertTimeToSeconds(settings.loopTimeHours, settings.loopTimeMinutes),
        
        // ADD TRANSITION, ANIMATION, AND EFFECTS WITH MAPPING:
        transition_type: selectedTransition === 'none' ? null : selectedTransition,
        animation_type: mapAnimationForBackend(selectedAnimation),
        effects_type: selectedEffect === 'none' ? null : selectedEffect,
        
        // Optional burn-in subtitles. NULL = no subtitles (existing behavior preserved)
        subtitles: subtitlesEnabled ? subtitleConfig : null,
        
        // NEW: Output type and component selection flags
        video: settings.outputType === 'video',
        process_story: settings.processStory,
        process_images: settings.processImages,
        process_audio: settings.processAudio,
        
        // NEW: Frequency configuration for image timing
        frequency_mode: frequencyMode,
        frequency_type: frequencyType,
        consistent_frequency: frequencyType === 'consistent' ? parseInt(consistentFrequency) : null,
        audio_distribution_type: audioDistributionType,
        first_page_image_amount: frequencyType === 'variable' || audioDistributionType === 'variable' ? parseInt(firstPageImageAmount) : null,
        rest_image_amount: frequencyType === 'variable' || audioDistributionType === 'variable' ? parseInt(restImageAmount) : null,
        total_audio_duration: frequencyMode === 'audio' ? parseFloat(totalAudioDuration) : null,
        // For audio-frequency mode the image count comes from the user's input.
        // For word-count frequency mode with existing images, use the actual count that
        // video-analyze returned (analysisResult.settings.numImages) so setup-video-tasks
        // can store it in image_amount and the polling UI has an accurate estimate
        // from the very first second — mirroring how TTV/ITV already work.
        image_amount: frequencyMode === 'audio'
          ? parseInt(imageAmount)
          : (settings.imageSource === 'folder' && analysisResult?.settings?.numImages)
            ? analysisResult.settings.numImages
            : null,
        audio_files: uploadedAudioFiles.length > 0 ? uploadedAudioFiles : null,
      };

      // For ITV generate mode, always send the calculatedAudioDuration so the backend
      // can pass it to setup-itv-prompts for clip count calculation.
      if (settings.visualType === 'itv' && settings.imageSource === 'generate' && calculatedAudioDuration && calculatedAudioDuration > 0) {
        requestData.total_audio_duration = calculatedAudioDuration;
        console.log(`ITV Start Generation: passing calculatedAudioDuration=${calculatedAudioDuration}s as total_audio_duration`);
      }

      // NEW: Add video loop metadata if available
      if (uploadedVideoMetadata || settings.videoLoopMetadata) {
        const metadata = uploadedVideoMetadata || settings.videoLoopMetadata;
        requestData.video_loop_metadata = {
          duration: metadata!.duration,
          size: metadata!.size,
          bitrate: metadata!.bitrate
        };
        console.log('Including video loop metadata in generation:', requestData.video_loop_metadata);
      }

      // Configure based on story source
      if (settings.storySource === 'new') {
        requestData.use_existing_story = false;
        requestData.word_count = parseInt(settings.wordCount);
        // For new stories, the setup-video-tasks will handle story generation
      } else if (settings.storySource === 'existing') {
        const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
        if (!selectedDoc) {
          throw new Error('Selected story document not found');
        }
        requestData.use_existing_story = true;
        requestData.story_file_path = selectedDoc.file_path;
        requestData.story_title = selectedDoc.title;
        requestData.description = selectedDoc.description || '';
      } else if (settings.storySource === 'upload') {
        // For uploaded files, use the stored document ID
        if (uploadedDocId) {
          const uploadedDoc = documents.find(doc => doc.id === uploadedDocId);
          if (uploadedDoc) {
            requestData.use_existing_story = true;
            requestData.story_file_path = uploadedDoc.file_path;
            requestData.story_title = uploadedDoc.title;
            requestData.description = uploadedDoc.description || '';
            // NEW: Include text_language from uploaded document
            requestData.text_language = uploadedDoc.text_language || uploadLanguage;
          } else {
            throw new Error('Uploaded document not found in documents');
          }
        } else {
          throw new Error('Uploaded document ID not found');
        }
      }

      // Configure image settings
      if (settings.imageSource === 'generate' && settings.processImages) {
        requestData.use_existing_images = false;
        // Add image generation parameters
        requestData.image_style = settings.imageStyle;
        requestData.use_character_descriptions = settings.useCharacterDescriptions;
        // Custom characters
        requestData.customCharactersEnabled = customCharactersEnabled;
        requestData.customCharacters = customCharactersEnabled ? customCharacters.filter(c => c.name.trim()) : [];
        requestData.customCharactersAIEnhance = customCharactersAIEnhance;
        
        // Handle consistent vs variable frequency modes
        if (frequencyType === 'consistent') {
          requestData.first_page_frequency = null;
          requestData.rest_frequency = parseInt(consistentFrequency);
        } else {
          requestData.first_page_frequency = parseFloat(settings.firstPageFrequency);
          requestData.rest_frequency = parseFloat(settings.restFrequency);
        }
      } else if (settings.imageSource === 'folder' && settings.visualType !== 'ttv' && settings.visualType !== 'itv') {
        // Standard image folder path - TTV/ITV folder paths are configured separately below
        requestData.use_existing_images = true;
        
        // Find and validate the selected image folder
        const selectedImageFolder = imageFolders.find(folder => folder.id === settings.selectedImageFolder);
        if (!selectedImageFolder || !selectedImageFolder.file_path) {
          throw new Error('Selected image folder not found or has no valid path');
        }
        
        requestData.images_folder_path = selectedImageFolder.file_path;
        
        // Add image prompt document path
        if (settings.imagePromptDoc) {
          const selectedPromptDoc = documents.find(doc => doc.id === settings.imagePromptDoc);
          if (!selectedPromptDoc || !selectedPromptDoc.file_path) {
            throw new Error('Selected image prompt document not found or has no valid path');
          }
          requestData.image_prompt_path = selectedPromptDoc.file_path;
          // Use image_model stored in the prompt document; fall back to settings only if it's a valid new-style value
          const validImageModels = ['flux-2-dev', 'grok-imagine-image', 'imagen-4-fast', 'gpt-image-1-mini', 'seedream-4.5', 'imagen-4-ultra', 'nano-banana-pro'];
          if (selectedPromptDoc.image_model && validImageModels.includes(selectedPromptDoc.image_model)) {
            requestData.image_model = selectedPromptDoc.image_model;
          } else if (!validImageModels.includes(requestData.image_model)) {
            // settings.imageModel is stale/invalid — clear it so the backend won't reject it
            requestData.image_model = null;
          }
        } else {
          throw new Error('Image prompt document is required when using existing image folder');
        }
      } else if (settings.imageSource === 'upload') {
        // FIXED: For video loops, set use_existing_images to true since we're using the video loop instead of generating images
        requestData.use_existing_images = true;
        // video_loop is already set at the base level above
      }

      // NEW: Configure TTV folder paths when using existing TTV folder
      if (settings.visualType === 'ttv' && settings.imageSource === 'folder') {
        // TTV folder (video clips)
        const selectedTTVFolder = ttvFolders.find(f => f.id === settings.selectedTTVFolder);
        if (selectedTTVFolder?.file_path) {
          requestData.ttv_folder_path = selectedTTVFolder.file_path;
          // Backend requires images_folder_path for use_existing_images — set to TTV folder
          requestData.images_folder_path = selectedTTVFolder.file_path;
        }
        // TTV prompt doc
        const selectedTTVPrompt = ttvPromptDocs.find(d => d.id === settings.ttvPromptDoc);
        if (selectedTTVPrompt?.file_path) {
          requestData.ttv_prompt_path = selectedTTVPrompt.file_path;
          // Backend also uses image_prompt_path — set to TTV prompt
          requestData.image_prompt_path = selectedTTVPrompt.file_path;
        }
        requestData.use_existing_images = true;
      }

      // NEW: Configure ITV folder paths when using existing ITV folder
      if (settings.visualType === 'itv' && settings.imageSource === 'folder') {
        // ITV video folder (video clips)
        const selectedITVVideoFolder = itvVideoFolders.find(f => f.id === settings.selectedITVVideoFolder);
        if (selectedITVVideoFolder?.file_path) {
          requestData.itv_video_folder_path = selectedITVVideoFolder.file_path;
          // Backend requires images_folder_path for use_existing_images — set to ITV video folder
          requestData.images_folder_path = selectedITVVideoFolder.file_path;
        }
        // ITV video prompt doc
        const selectedITVVideoPrompt = itvVideoPromptDocs.find(d => d.id === settings.itvVideoPromptDoc);
        if (selectedITVVideoPrompt?.file_path) {
          requestData.itv_video_prompt_path = selectedITVVideoPrompt.file_path;
        }
        // ITV image folder (keyframe images)
        const selectedITVImageFolder = itvImageFolders.find(f => f.id === settings.selectedITVImageFolder);
        if (selectedITVImageFolder?.file_path) {
          requestData.itv_image_folder_path = selectedITVImageFolder.file_path;
        }
        // ITV image prompt doc
        const selectedITVImagePrompt = itvImagePromptDocs.find(d => d.id === settings.itvImagePromptDoc);
        if (selectedITVImagePrompt?.file_path) {
          requestData.itv_image_prompt_path = selectedITVImagePrompt.file_path;
        }
        requestData.use_existing_images = true;
      }

      // Configure audio settings - ONLY if processing audio
      if (settings.processAudio) {
        if (settings.audioSource === 'generate') {
          requestData.use_existing_audio = false;
          requestData.voice = settings.selectedVoice.includes(':') ? settings.selectedVoice.split(':')[1] : settings.selectedVoice;
          requestData.speed = settings.audioSpeed;
          requestData.volume = settings.audioVolume || 1.0;
          requestData.language = settings.language; 
          requestData.preference = 'separate';
          requestData.remove_title_chapters = settings.removeTitleChapters;
          requestData.model_version = modelVersion;
        } else {
          requestData.use_existing_audio = true;
          requestData.existing_audio_volume = settings.existingAudioVolume || 1.0; // NEW: Add existing audio volume
          // Map existing audio volume to main volume field
          requestData.volume = settings.existingAudioVolume || 1.0;
          
          // Enhanced audio file selection with fallback logic
          let selectedAudioFile = null;
          
          if (settings.selectedAudioFile) {
            selectedAudioFile = audioFolders.find(file => file.id === settings.selectedAudioFile);
          }
          
          // If no selected audio file found, check for uploaded audio fallbacks
          if (!selectedAudioFile) {
            if (uploadedAudioDocId) {
              selectedAudioFile = audioFolders.find(file => file.id === uploadedAudioDocId);
            }
          }
          
          if (!selectedAudioFile || !selectedAudioFile.file_path) {
            throw new Error('Selected audio file not found or has no valid path');
          }
          
          // Check if it's a folder (version 9 or 10) or single file (version 7 or 8)
          if ([9, 10].includes(selectedAudioFile.version || 0)) {
            requestData.audio_folder_path = selectedAudioFile.file_path;
          } else {
            requestData.audio_file_path = selectedAudioFile.file_path;
          }
        }
      }

      // Add clone voice fields if model_version is 'clone'
      if (modelVersion === 'clone') {
        requestData.clone_voice_name = cloneVoiceName;
        requestData.clone_voice_url = cloneVoiceUrl;
        requestData.clone_language = cloneLanguage;
      }

      // NEW: Add frequency configuration for image timing
      requestData.frequency_mode = frequencyMode;
      requestData.frequency_type = frequencyType;
      requestData.consistent_frequency = frequencyType === 'consistent' ? parseInt(consistentFrequency) : null;
      requestData.audio_distribution_type = audioDistributionType;
      requestData.first_page_image_amount = audioDistributionType === 'variable' ? parseInt(firstPageImageAmount) : null;
      requestData.rest_image_amount = audioDistributionType === 'variable' ? parseInt(restImageAmount) : null;
      requestData.image_amount = frequencyMode === 'audio' && audioDistributionType === 'consistent' ? parseInt(imageAmount) : null;
      
      // Include uploaded audio files array if in audio mode with uploaded files
      if (frequencyMode === 'audio' && uploadedAudioFiles.length > 0) {
        requestData.audio_files = uploadedAudioFiles.map(file => ({
          name: file.name,
          url: file.url,
          duration: file.duration
        }));
        
        // Calculate and set total audio duration from uploaded files
        const totalDuration = uploadedAudioFiles.reduce((sum, file) => sum + (file.duration || 0), 0);
        requestData.total_audio_duration = totalDuration;
      }

      console.log('Request data being sent:', requestData);

      // Update tab status to 'generating' immediately (before calling backend)
      if (currentUserId) {
        const { updateTabStatus } = await import('../utils/tabManager');
        await updateTabStatus(currentUserId, 'video', currentTab, 'generating', groupId);
      }

      const { data: { session: _vgSession } } = await supabase.auth.getSession();
      const response = await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/setup-video-tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${_vgSession?.access_token || ''}`,
          'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify(requestData),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: Failed to start video generation`);
      }

      const result = await response.json();
      console.log('Video generation started:', result);

      // Save estimate_tokens to current tab in database
      if (isEnterpriseUser && currentUserId && analysisResult?.estimatedTokens) {
        const { saveTabEstimateTokens } = await import('../utils/tabManager');
        await saveTabEstimateTokens(currentUserId, 'video', currentTab, analysisResult.estimatedTokens);
        console.log(`Saved estimate_tokens ${analysisResult.estimatedTokens} for tab ${currentTab}`);
      }

      // Update tab status to 'generating' (for ALL users, not just enterprise)
      if (currentUserId) {
        const { updateTabStatus } = await import('../utils/tabManager');
        await updateTabStatus(currentUserId, 'video', currentTab, 'generating', groupId);
      }

      setGenerationState('generating');
      setProgress(0);
      setStatusMessage('Starting video generation process...');
      setError(null);

      // Initialize batch statuses based on what will be processed
      // Mark existing content as complete, new content as pending
      const initialBatchStatuses = [];
      
      // Story: Check if using existing story
      if (settings.processStory !== false) {
        const useExistingStory = settings.storySource === 'existing' || settings.storySource === 'upload';
        initialBatchStatuses.push({ 
          id: 'story',
          label: 'Story Generation', 
          progress: useExistingStory ? 100 : 0, 
          status: useExistingStory ? 'complete' : 'pending'
        });
      }
      
      // Audio: Check if using existing audio (moved to position 2)
      if (settings.processAudio !== false) {
        const useExistingAudio = settings.audioSource === 'existing' || settings.audioSource === 'upload';
        initialBatchStatuses.push({ 
          id: 'audio',
          label: 'Audio Generation', 
          progress: useExistingAudio ? 100 : 0, 
          status: useExistingAudio ? 'complete' : 'pending'
        });
      }
      
      // Images/TTV/ITV: Check if using existing images/folder (moved to position 3-4)
      if (settings.processImages !== false) {
        const useExistingImages = settings.imageSource === 'folder' || settings.imageSource === 'upload';
        
        if (settings.visualType === 'ttv') {
          // TTV pipeline phases
          initialBatchStatuses.push({ 
            id: 'ttv_prompts',
            label: 'TTV Prompts', 
            progress: useExistingImages ? 100 : 0, 
            status: useExistingImages ? 'complete' : 'pending'
          });
          initialBatchStatuses.push({ 
            id: 'ttv_generation',
            label: 'TTV Generation', 
            progress: useExistingImages ? 100 : 0, 
            status: useExistingImages ? 'complete' : 'pending'
          });
        } else if (settings.visualType === 'itv') {
          // ITV pipeline: Image Prompts → Image Generation → ITV Prompts → ITV Generation
          initialBatchStatuses.push({ 
            id: 'itv_image_prompts',
            label: 'ITV Image Prompts', 
            progress: useExistingImages ? 100 : 0, 
            status: useExistingImages ? 'complete' : 'pending'
          });
          initialBatchStatuses.push({ 
            id: 'itv_image_generation',
            label: 'ITV Image Generation', 
            progress: useExistingImages ? 100 : 0, 
            status: useExistingImages ? 'complete' : 'pending'
          });
          initialBatchStatuses.push({ 
            id: 'itv_prompts',
            label: 'ITV Prompts', 
            progress: useExistingImages ? 100 : 0, 
            status: useExistingImages ? 'complete' : 'pending'
          });
          initialBatchStatuses.push({ 
            id: 'itv_generation',
            label: 'ITV Generation', 
            progress: useExistingImages ? 100 : 0, 
            status: useExistingImages ? 'complete' : 'pending'
          });
        } else {
          // Standard image pipeline phases
          initialBatchStatuses.push({ 
            id: 'image_prompts',
            label: 'Image Prompts', 
            progress: useExistingImages ? 100 : 0, 
            status: useExistingImages ? 'complete' : 'pending'
          });
          initialBatchStatuses.push({ 
            id: 'image_generation',
            label: 'Image Generation', 
            progress: useExistingImages ? 100 : 0, 
            status: useExistingImages ? 'complete' : 'pending'
          });
        }
      }
      
      // Video: Always needs to be created (never existing)
      if (settings.video !== false) {
        initialBatchStatuses.push({ 
          id: 'video',
          label: 'Video Creation', 
          progress: 0, 
          status: 'pending'
        });
      }
      
      // Initialize batch statuses using the hook - call initializeBatchStatuses instead of updateBatchStatus
      generationStateHook.initializeBatchStatuses(initialBatchStatuses as any);

      // Set initial time estimate from analysis result
      if (analysisResult?.estimatedGenerationTimeMinutes) {
        setTimeRemaining(analysisResult.estimatedGenerationTimeMinutes);
      }

    } catch (err: any) {
      console.error('Video generation error:', err);
      setError(err.message || 'Failed to start video generation');
      
      // Update tab status to 'error' (for ALL users)
      if (currentUserId) {
        const { updateTabStatus } = await import('../utils/tabManager');
        await updateTabStatus(currentUserId, 'video', currentTab, 'error');
      }
    } finally {
      // NEW: Clear generation loading state
      setGenerationLoading(false);
    }
  };

  // Stop video processing function
  const stopVideoProcessing = async () => {
    if (!currentUserId || !currentGroupId) {
      console.warn('Missing user ID or group ID for video processing stop');
      return;
    }
  
    try {
      console.log('Stopping video processing...');
  
      // Get the current video task to stop
      const { data: videoTasks } = await supabase
        .from('video_tasks')
        .select('id')
        .eq('user_id', currentUserId)
        .eq('group_id', currentGroupId)
        .eq('tab', currentTab)
        .eq('is_main', true)
        .limit(1);
  
      if (videoTasks && videoTasks.length > 0) {
        const mainTaskId = videoTasks[0].id;
  
        // Call the stop-video-processing edge function
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (session) {
            await withTimeout(
              supabase.functions.invoke('stop-video-processing', {
                body: {
                  video_task_id: mainTaskId,
                  user_id: currentUserId,
                  group_id: currentGroupId
                }
              }),
              OPERATION_TIMEOUT,
              'stopVideoProcessing'
            );
            console.log('Video processing stop request sent');
          }
        } catch (error) {
          console.warn('Failed to send stop request to video processor:', error);
          // Continue with local cleanup even if the stop request fails
        }
      }
    } catch (error) {
      console.error('Error stopping video processing:', error);
    }
  };
  
  // Holds a notify value that couldn't be written yet because videoTasks was empty
  const pendingNotifyRef = useRef<boolean | null>(null);
  // Tracks whether we have already read the DB notify value for the current session
  const notifyInitializedRef = useRef(false);

  // When videoTasks first populates: (1) sync notify toggle from DB, (2) flush any pending write
  useEffect(() => {
    if (videoTasks.length === 0) return;
    const mainTask = videoTasks.find((t: any) => t.is_main) ?? videoTasks.find((t: any) => !t.doc_id) ?? videoTasks[0];
    if (!mainTask?.id) return;

    // Sync DB value into UI on first load (DB is source of truth).
    // Treat notify as TRUE if ANY row has it set, since we update them all together.
    if (!notifyInitializedRef.current) {
      notifyInitializedRef.current = true;
      const anyNotify = videoTasks.some((t: any) => t.notify === true);
      setNotifyOnComplete(anyNotify);
    }

    // Flush any toggle that was clicked before the rows existed
    if (pendingNotifyRef.current !== null && currentUserId) {
      const value = pendingNotifyRef.current;
      pendingNotifyRef.current = null;
      supabase.from('video_tasks').update({ notify: value } as any)
        .eq('user_id', currentUserId)
        .eq('tab', currentTab)
        .in('overall_status', ['pending', 'running', 'completed', 'completed_final'])
        .then(({ error }) => { if (error) console.error('[VideoGenerator] Pending notify flush failed:', error); });
    }
  }, [videoTasks, currentUserId, currentTab]);

  // Handle notify-on-complete toggle
  // Updates ALL active rows for this user/tab so the value stays consistent
  // across main task and any per-doc rows.
  const handleNotifyToggle = async (value: boolean) => {
    setNotifyOnComplete(value); // optimistic; slow toggle animation doubles as the loading indicator
    setNotifyLoading(true);
    try {
      if (!currentUserId) return;
      const { error: updateError, count } = await supabase
        .from('video_tasks')
        .update({ notify: value } as any, { count: 'exact' })
        .eq('user_id', currentUserId)
        .eq('tab', currentTab)
        .in('overall_status', ['pending', 'running', 'completed', 'completed_final']);

      if (updateError) {
        console.error('[VideoGenerator] Failed to update notify:', updateError);
        setNotifyOnComplete(!value);
        return;
      }
      if (!count || count === 0) {
        // No active rows yet — queue and apply once they appear
        pendingNotifyRef.current = value;
      }
    } catch (err) {
      console.error('[VideoGenerator] handleNotifyToggle error:', err);
      setNotifyOnComplete(!value);
    } finally {
      setNotifyLoading(false);
    }
  };

  // Handle stop video generation
  const handleStopGeneration = async () => {
    if (!currentUserId) return;
  
    if (!confirm('Are you sure you want to stop generation? All progress will be lost.')) {
      return;
    }
  
    setStopLoading(true);
    
    try {
      // STEP 1: Stop video processing if we're in the video creation phase
      if (generationState === 'generating' && currentGroupId) {
        await stopVideoProcessing();
      }
  
      // STEP 2: Wait 2 seconds to ensure all database operations are complete
      console.log('Waiting 2 seconds for database operations to complete...');
      await new Promise(resolve => setTimeout(resolve, 2000));
  
      // STEP 3: Get the current video task statuses BEFORE any deletion - CHECK ALL PHASES
      let videoTaskStatuses = null;
      if (currentGroupId) {
        try {
          console.log('Checking video task statuses...');
          
          // Use the current video tasks state if available, otherwise query database
          if (videoTasks && videoTasks.length > 0) {
            // Get the main task (the one without a specific doc_id variant, or the first one)
            const mainVideoTask = videoTasks.find(task => task.variant === 1) || videoTasks[0];
            videoTaskStatuses = {
              story_status: mainVideoTask.story_status,
              image_prompt_status: mainVideoTask.image_prompt_status,
              image_generation_status: mainVideoTask.image_generation_status,
              audio_status: mainVideoTask.audio_status,
              video_creation_status: mainVideoTask.video_creation_status,
              ttv_status: mainVideoTask.ttv_status,
              ttv_prompt_status: mainVideoTask.ttv_prompt_status,
            };
            console.log('Video task statuses from current state:', videoTaskStatuses);
          } else {
            // Fallback to database query with improved error handling
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const { data: { session } } = await supabase.auth.getSession();
                if (!session) {
                  console.warn('No active session for video task status check');
                  break;
                }
  
                // First, get all tasks for this user_id, group_id, and tab
                const { data: allTasks, error: queryError } = await supabase
                  .from('video_tasks')
                  .select('story_status, image_prompt_status, image_generation_status, audio_status, video_creation_status, ttv_status, ttv_prompt_status, doc_id')
                  .eq('user_id', currentUserId)
                  .eq('group_id', currentGroupId)
                  .eq('tab', currentTab);

                if (queryError) {
                  console.error(`Status check attempt ${attempt}/3 failed:`, queryError);
                  if (attempt === 3) throw queryError;
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  continue;
                }

                let videoTasksData = null;
                if (allTasks && allTasks.length === 1) {
                  // Only one row - use it
                  videoTasksData = allTasks[0];
                  console.log('Found single video task, using it');
                } else if (allTasks && allTasks.length > 1) {
                  // Multiple rows - prefer is_main = true; fall back to legacy doc_id IS NULL.
                  videoTasksData = allTasks.find(task => task.is_main) || allTasks.find(task => task.doc_id === null);
                  console.log('Found multiple video tasks, using main task (is_main = true)');
                } else {
                  console.log(`No video tasks found on attempt ${attempt}/3`);
                  if (attempt < 3) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                  }
                }
  
                if (videoTasksData) {
                  videoTaskStatuses = videoTasksData;
                  console.log('Video task statuses retrieved from database:', videoTaskStatuses);
                  break;
                }
              } catch (error) {
                console.error(`Status check attempt ${attempt}/3 error:`, error);
                if (attempt === 3) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            }
          }
        } catch (error) {
          console.error('Failed to get video task statuses after all attempts:', error);
          videoTaskStatuses = null;
        }
      }
  
      console.log('Final video task statuses:', videoTaskStatuses);
  
      // STEP 5: Determine cleanup decisions based on completion status for ALL phases
      const storyCompleted = videoTaskStatuses?.story_status === 'completed' || videoTaskStatuses?.story_status === 'completed_final';
      const imagePromptsCompleted = videoTaskStatuses?.image_prompt_status === 'completed' || videoTaskStatuses?.image_prompt_status === 'completed_final';
      const imageGenerationCompleted = videoTaskStatuses?.image_generation_status === 'completed' || videoTaskStatuses?.image_generation_status === 'completed_final';
      const audioCompleted = videoTaskStatuses?.audio_status === 'completed' || videoTaskStatuses?.audio_status === 'completed_final';
      const videoCreationCompleted = videoTaskStatuses?.video_creation_status === 'completed' || videoTaskStatuses?.video_creation_status === 'completed_final';
  
      console.log('Cleanup decisions:', {
        storyCompleted,
        imagePromptsCompleted,
        imageGenerationCompleted,
        audioCompleted,
        videoCreationCompleted,
        willPreserveStory: storyCompleted,
        willPreserveImagePrompts: imagePromptsCompleted,
        willPreserveImages: imageGenerationCompleted,
        willPreserveAudio: audioCompleted,
        willPreserveVideos: videoCreationCompleted
      });
  
      // STEP 5.5: Clean up story files only if NOT completed
      if (!storyCompleted && currentGroupId) {
        console.log('Story generation not completed - cleaning up story files...');
        try {
          const storyPath = `documents/${currentUserId}/${currentGroupId}`;
          const { data: files } = await withRetry(
            async () => await withTimeout(
              supabase.storage.from('stories').list(storyPath, { limit: 1000, recursive: true }),
              OPERATION_TIMEOUT,
              'listStoryFilesForDeletion'
            ),
            'listStoryFilesForDeletion'
          );

          if (files && files.length > 0) {
            // Only delete .txt files (story content), preserve images/audio
            const storyFilePaths = files
              .filter(file => file.name.endsWith('.txt'))
              .map(file => `${storyPath}/${file.name}`);
            
            if (storyFilePaths.length > 0) {
              await withRetry(
                async () => await withTimeout(
                  supabase.storage.from('stories').remove(storyFilePaths),
                  OPERATION_TIMEOUT,
                  'deleteStoryFiles'
                ),
                'deleteStoryFiles'
              );
              console.log(`Deleted ${storyFilePaths.length} incomplete story files`);
            }
          }
        } catch (error) {
          console.warn('Failed to delete incomplete story files:', error);
        }
      } else {
        console.log('Story generation completed - preserving story files');
      }
  
      // STEP 6: Clean up image files only if NOT completed
      if (!imageGenerationCompleted && currentGroupId) {
        console.log('Image generation not completed - cleaning up image files...');
        try {
          // Get image tasks to clean up their files using story_title + folder_timestamp
          const { data: imageTasks } = await withRetry(
            async () => await withTimeout(
              (async () => {
                const result = await supabase
                  .from('image_tasks')
                  .select('story_title, folder_timestamp')
                  .eq('user_id', currentUserId)
                  .eq('group_id', currentGroupId)
                  .eq('tab', currentTab)
                  .eq('video_process', true)
                  .limit(1);
                return result;
              })(),
              OPERATION_TIMEOUT,
              'fetchImageTasksForCleanup'
            ),
            'fetchImageTasksForCleanup'
          );
  
          if (imageTasks && imageTasks.length > 0 && imageTasks[0].story_title && imageTasks[0].folder_timestamp) {
            // Construct folder path using title + folder_timestamp (matches edge function)
            const sanitizedTitle = sanitizeTitle(imageTasks[0].story_title);
            const folderPath = `documents/${currentUserId}/${currentGroupId}/${sanitizedTitle}_${imageTasks[0].folder_timestamp}`;
            
            console.log('Deleting incomplete image files from:', folderPath);
              
            const { data: files } = await withRetry(
              async () => await withTimeout(
                supabase.storage.from('stories').list(folderPath, { recursive: true }),
                OPERATION_TIMEOUT,
                'listImageFolderForDeletion'
              ),
              'listImageFolderForDeletion'
            );

            if (files && files.length > 0) {
              // Only delete image files (not audio or other files that may be in the same folder)
              const imageFilePaths = files
                .filter(file => 
                  file.name.endsWith('.png') || 
                  file.name.endsWith('.jpg') || 
                  file.name.endsWith('.jpeg') || 
                  file.name.endsWith('.webp')
                )
                .map(file => `${folderPath}/${file.name}`);
              
              if (imageFilePaths.length > 0) {
                await withRetry(
                  async () => await withTimeout(
                    supabase.storage.from('stories').remove(imageFilePaths),
                    OPERATION_TIMEOUT,
                    'deleteImageFiles'
                  ),
                  'deleteImageFiles'
                );
                console.log(`Deleted ${imageFilePaths.length} incomplete image files`);
              }
            }
          }
        } catch (error) {
          console.warn('Failed to delete incomplete image files:', error);
        }
      } else {
        console.log('Image generation completed - preserving image files');
      }
  
      // STEP 7: Clean up audio files only if NOT completed
      if (!audioCompleted && currentGroupId) {
        console.log('Audio generation not completed - cleaning up audio files...');
        try {
          // Get audio tasks to clean up their files using story_title + folder_timestamp
          const { data: audioTasks } = await withRetry(
            async () => await withTimeout(
              (async () => {
                const result = await supabase
                  .from('audio_tasks')
                  .select('story_title, folder_timestamp')
                  .eq('user_id', currentUserId)
                  .eq('group_id', currentGroupId)
                  .eq('tab', currentTab)
                  .eq('video_process', true)
                  .limit(1);
                return result;
              })(),
              OPERATION_TIMEOUT,
              'fetchAudioTasksForCleanup'
            ),
            'fetchAudioTasksForCleanup'
          );
  
          if (audioTasks && audioTasks.length > 0 && audioTasks[0].story_title && audioTasks[0].folder_timestamp) {
            // Construct folder path using title + folder_timestamp (matches edge function)
            const sanitizedTitle = sanitizeTitle(audioTasks[0].story_title);
            const folderPath = `documents/${currentUserId}/${currentGroupId}/${sanitizedTitle}_${audioTasks[0].folder_timestamp}`;
            
            console.log('Deleting incomplete audio files from:', folderPath);
              
            const { data: files } = await withRetry(
              () => withTimeout(
                supabase.storage.from('stories').list(folderPath, { recursive: true }),
                OPERATION_TIMEOUT,
                'listAudioFolderForDeletion'
              ),
              'listAudioFolderForDeletion'
            );

            if (files && files.length > 0) {
              const filePaths = files
                .filter(file => file.name.endsWith('.wav') || file.name.endsWith('.mp3'))
                .map(file => `${folderPath}/${file.name}`);
              
              if (filePaths.length > 0) {
                await withRetry(
                  () => withTimeout(
                    supabase.storage.from('stories').remove(filePaths),
                    OPERATION_TIMEOUT,
                    'deleteAudioFiles'
                  ),
                  'deleteAudioFiles'
                );
                console.log(`Deleted ${filePaths.length} incomplete audio files`);
              }
            }
          }
        } catch (error) {
          console.warn('Failed to delete incomplete audio files:', error);
        }
      } else {
        console.log('Audio generation completed - preserving audio files');
      }

      // STEP 7.5: Delete individual_videos and transition_batches folders only if video creation NOT completed
      if (!videoCreationCompleted && currentGroupId) {
        console.log('Video creation not completed - deleting individual videos and transition batches...');
        try {
          // Delete individual_videos folder
          const individualVideosPath = `videos/${currentUserId}/${currentGroupId}/individual_videos`;
          const { data: individualFiles } = await supabase.storage.from('videos').list(individualVideosPath, { recursive: true });
          if (individualFiles && individualFiles.length > 0) {
            const individualFilePaths = individualFiles.map(file => `${individualVideosPath}/${file.name}`);
            await supabase.storage.from('videos').remove(individualFilePaths);
            console.log(`Deleted ${individualFilePaths.length} incomplete individual video files`);
          }

          // Delete transition_batches folder
          const transitionBatchesPath = `videos/${currentUserId}/${currentGroupId}/transition_batches`;
          const { data: transitionFiles } = await supabase.storage.from('videos').list(transitionBatchesPath, { recursive: true });
          if (transitionFiles && transitionFiles.length > 0) {
            const transitionFilePaths = transitionFiles.map(file => `${transitionBatchesPath}/${file.name}`);
            await supabase.storage.from('videos').remove(transitionFilePaths);
            console.log(`Deleted ${transitionFilePaths.length} incomplete transition batch files`);
          }
        } catch (error) {
          console.warn('Failed to delete incomplete video folders:', error);
        }
      } else {
        console.log('Video creation completed - preserving individual videos and transition batches');
      }
  
      // STEP 8: Delete database records (always delete these regardless of completion status)
      console.log('Cleaning up database records...');
  
      // Delete all video tasks for this user, group_id, and tab
      if (currentGroupId) {
        try {
          await withRetry(
            () => withTimeout(
              supabase
                .from('video_tasks')
                .delete()
                .eq('user_id', currentUserId)
                .eq('group_id', currentGroupId)
                .eq('tab', currentTab),
              OPERATION_TIMEOUT,
              'deleteVideoTasks'
            ),
            'deleteVideoTasks'
          );
          console.log('Successfully deleted video tasks');
        } catch (error) {
          console.warn('Failed to delete video tasks:', error);
        }
      }
  
      // Delete story tasks where video_process = TRUE
      if (currentGroupId) {
        try {
          await withRetry(
            () => withTimeout(
              supabase
                .from('story_tasks')
                .delete()
                .eq('user_id', currentUserId)
                .eq('group_id', currentGroupId)
                .eq('tab', currentTab)
                .eq('video_process', true),
              OPERATION_TIMEOUT,
              'deleteStoryTasks'
            ),
            'deleteStoryTasks'
          );
          console.log('Successfully deleted story tasks');
        } catch (error) {
          console.warn('Failed to delete story tasks:', error);
        }
      }
  
      // Delete image prompt tasks where video_process = TRUE
      if (currentGroupId) {
        try {
          await withRetry(
            () => withTimeout(
              supabase
                .from('image_prompt_tasks')
                .delete()
                .eq('user_id', currentUserId)
                .eq('group_id', currentGroupId)
                .eq('tab', currentTab)
                .eq('video_process', true),
              OPERATION_TIMEOUT,
              'deleteImagePromptTasks'
            ),
            'deleteImagePromptTasks'
          );
          console.log('Successfully deleted image prompt tasks');

          // Delete image_prompt_context for the same group
          await withRetry(
            () => withTimeout(
              supabase
                .from('image_prompt_context')
                .delete()
                .eq('group_id', currentGroupId),
              OPERATION_TIMEOUT,
              'deleteImagePromptContext'
            ),
            'deleteImagePromptContext'
          );
          console.log('Successfully deleted image prompt context');
        } catch (error) {
          console.warn('Failed to delete image prompt tasks/context:', error);
        }
      }
  
      // Delete image tasks (always delete the database records)
      if (currentGroupId) {
        try {
          await withRetry(
            () => withTimeout(
              supabase
                .from('image_tasks')
                .delete()
                .eq('user_id', currentUserId)
                .eq('group_id', currentGroupId)
                .eq('tab', currentTab)
                .eq('video_process', true),
              OPERATION_TIMEOUT,
              'deleteImageTasks'
            ),
            'deleteImageTasks'
          );
          console.log('Successfully deleted image task records');
        } catch (error) {
          console.warn('Failed to delete image task records:', error);
        }
      }
  
      // Delete audio tasks (always delete the database records)
      if (currentGroupId) {
        try {
          await withRetry(
            () => withTimeout(
              supabase
                .from('audio_tasks')
                .delete()
                .eq('user_id', currentUserId)
                .eq('group_id', currentGroupId)
                .eq('tab', currentTab)
                .eq('video_process', true),
              OPERATION_TIMEOUT,
              'deleteAudioTasks'
            ),
            'deleteAudioTasks'
          );
          console.log('Successfully deleted audio task records');
        } catch (error) {
          console.warn('Failed to delete audio task records:', error);
        }
      }

      // Delete ITV-specific tables if visual type is ITV
      if (currentGroupId && settings.visualType === 'itv') {
        try {
          // Signal ITV tasks to stop
          await supabase.from('ITV_prompt_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('video_process', true);
          await supabase.from('ITV_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('video_process', true);
          await supabase.from('image_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('itv', true);

          // Delete ITV table rows
          await supabase.from('ITV_tasks').delete().eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('video_process', true);
          await supabase.from('ITV_prompt_tasks').delete().eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('video_process', true);
          await supabase.from('ITV_prompt_context').delete().eq('group_id', currentGroupId).eq('tab', currentTab);
          await supabase.from('image_tasks').delete().eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('itv', true);
          console.log('Successfully deleted ITV task records');
        } catch (error) {
          console.warn('Failed to delete ITV task records:', error);
        }
      }

      // Delete TTV-specific tables if visual type is TTV
      if (currentGroupId && settings.visualType === 'ttv') {
        try {
          // Signal TTV tasks to stop
          await supabase.from('TTV_prompt_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('video_process', true);
          await supabase.from('TTV_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('video_process', true);

          // Check if TTV tasks completed_final before deleting video files
          const ttvCompleted = videoTaskStatuses?.ttv_status === 'completed' || videoTaskStatuses?.ttv_status === 'completed_final';

          if (!ttvCompleted) {
            // Delete generated TTV video files from storage (mirror TTV page logic)
            const { data: ttvTasksForCleanup } = await supabase
              .from('TTV_tasks')
              .select('folder_timestamp, story_title, video_url')
              .eq('user_id', currentUserId)
              .eq('group_id', currentGroupId)
              .eq('tab', currentTab)
              .eq('video_process', true);

            const folderTask = ttvTasksForCleanup?.find((t: any) => t.folder_timestamp);
            if (folderTask?.folder_timestamp && folderTask?.story_title) {
              const ttvSanitizedTitle = folderTask.story_title
                .replace(/^TTV Prompt[s]?:\s*/i, '')
                .replace(/[^a-zA-Z0-9\s-]/g, '.')
                .toLowerCase()
                .trim()
                .replace(/\s+/g, '-');
              const ttvFolderPath = `documents/${currentUserId}/${currentGroupId}/TTV-${ttvSanitizedTitle}_${folderTask.folder_timestamp}`;
              console.log(`[VideoGenerator TTV Stop] Deleting video folder: ${ttvFolderPath}`);
              const { data: ttvFiles } = await supabase.storage.from('stories').list(ttvFolderPath);
              if (ttvFiles && ttvFiles.length > 0) {
                await supabase.storage.from('stories').remove(ttvFiles.map((f: any) => `${ttvFolderPath}/${f.name}`));
                console.log(`[VideoGenerator TTV Stop] Deleted ${ttvFiles.length} video file(s)`);
              }
            }
          } else {
            console.log('[VideoGenerator TTV Stop] TTV generation completed — skipping video file deletion');
          }

          // Delete TTV table rows
          await supabase.from('TTV_tasks').delete().eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('video_process', true);
          await supabase.from('TTV_prompt_tasks').delete().eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('video_process', true);
          await supabase.from('TTV_prompt_context').delete().eq('group_id', currentGroupId).eq('tab', currentTab);

          // Reset TTV status fields on the video_tasks row
          await supabase.from('video_tasks').update({
            ttv_status: 'pending',
            ttv_progress: 0,
            ttv_prompt_status: 'pending',
            ttv_prompt_progress: 0,
          }).eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab);

          console.log('Successfully deleted TTV task records and reset TTV statuses');
        } catch (error) {
          console.warn('Failed to delete TTV task records:', error);
        }
      }
  
      // Clean up session clone voice if exists
      await cleanupSessionCloneVoice(sessionCloneVoiceId, sessionCloneVoiceFilePath, currentUserId);

      // Clear VoiceSelector upload section
      clearVoiceSelectorUploadSection();
  
      // STEP 10: Clear UI states for uploaded audio assets
      setBackgroundMusicUrl('');
      setVideoLoopUrl('');
      setUploadedVideoLoopFile(null);
      setUploadedFile(null);
      setUploadedDocId(null);
      setUploadedAudioFile(null);
      setUploadedAudioDocId(null);
      // NEW: Clear video metadata
      setUploadedVideoMetadata(null);
      // NEW: Clear upload language
      setUploadLanguage('');
      // Clear session clone voice tracking
      setSessionCloneVoiceId(null);
      setSessionCloneVoiceFilePath(null);
      
      // Clear settings for audio-related uploads
      setSettings(prev => {
        const newSettings = { ...prev };
        delete newSettings.backgroundMusicUrl;
        delete newSettings.videoLoopUrl;
        delete newSettings.videoLoopMetadata; // NEW: Clear metadata
        return newSettings;
      });
  
      // STEP 11: Reset UI state
      setGenerationState('idle');
      setCurrentGroupId(null);
      setProgress(0);
      setStatusMessage('');
      generationStateHook.setBatchStatuses([]);
      setVideoTasks([]);
      setAnalysisResult(null);
      setNotifyOnComplete(false);
      notifyInitializedRef.current = false;

      // Reset tab to defaults (clears estimate_tokens and form inputs)
      if (isEnterpriseUser && currentUserId) {
        const { resetTabToDefaults } = await import('../utils/tabManager');
        await resetTabToDefaults(currentUserId, 'video', currentTab);
      }

      // Clear multi-tab warning if present
      setMultiTabWarning(null);

      console.log('Stop generation completed successfully');
      
    } catch (err: any) {
      console.error('Error stopping video generation:', err);
      setError('Failed to stop video generation');
    } finally {
      setStopLoading(false);
    }
  };

  // UPDATED: Enhanced download video handler with streaming support for large files
  const handleDownloadVideo = async () => {
    if (!currentUserId || !currentGroupId) {
      setError('No video available for download');
      return;
    }

    setDownloadLoading(true);
    
    try {
      // Find the final video document in story_documents
      const { data: finalVideoDoc, error: fetchError } = await withRetry(
        () => supabase
          .from('story_documents')
          .select('file_path, title, file_size')
          .eq('user_id', currentUserId)
          .eq('group_id', currentGroupId)
          .eq('description', 'Final Video')
          .order('created_at', { ascending: false })
          .limit(1)
          .single(),
        'fetch final video document'
      );

      if (fetchError || !finalVideoDoc) {
        console.error('Could not find the final video file:', fetchError);
        setError('Could not find the final video file');
        return;
      }

      const fileName = `${sanitizeFileName(settings.storyTitle || 'video')}.mp4`;
      const isLargeFile = finalVideoDoc.file_size && finalVideoDoc.file_size >= LARGE_FILE_THRESHOLD;

      // Generate signed URL — 1hr expiry for large files so the modal link stays valid
      const { data: signedUrlData, error: signedUrlError } = await withRetry(
        () => supabase
          .storage
          .from('videos')
          .createSignedUrl(finalVideoDoc.file_path, isLargeFile ? 3600 : 300, { download: fileName }),
        'generate signed URL for download'
      );

      if (signedUrlError || !signedUrlData) {
        console.error('Failed to generate signed URL:', signedUrlError);
        setError('Failed to generate download link');
        return;
      }

      if (isLargeFile) {
        // Large file — show info modal; download triggered via native anchor inside modal
        setLargeVideoDownloadModal({
          fileName,
          fileSizeBytes: finalVideoDoc.file_size,
          signedUrl: signedUrlData.signedUrl,
        });
      } else {
        // Small file — native anchor download directly, zero JS memory
        const a = document.createElement('a');
        a.href = signedUrlData.signedUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
      
    } catch (err: any) {
      console.error('Error downloading video:', err);
      setError(`Failed to download video: ${err.message}`);
      setDownloadProgress(prev => ({ ...prev, [currentGroupId!]: 0 }));
    } finally {
      setDownloadLoading(false);
    }
  };

  // NEW: Check for overall completion function
  const checkForOverallCompletion = async () => {
    if (!currentUserId || !currentGroupId) return;

    try {
      const { data: allTasks, error } = await supabase
        .from('video_tasks')
        .select('*')
        .eq('user_id', currentUserId)
        .eq('group_id', currentGroupId)
        .eq('tab', currentTab)
        .order('created_at', { ascending: true });

      if (error) throw error;

      if (!allTasks || allTasks.length === 0) {
        return;
      }

      // Check if ALL tasks have overall_status = 'completed_final'
      const allCompleted = allTasks.every(task => task.overall_status === 'completed_final');
      
      if (allCompleted) {
        console.log('All video tasks completed, transitioning to complete state');
        
        const mainTask = allTasks.find(task => task.is_main) || allTasks.find(task => !task.doc_id) || allTasks[0];
        
        if (mainTask) {
          // Set final video URL from the main task
          setFinalVideoUrl(mainTask.final_video_url || null);
          
          // Update story title from the task
          if (mainTask.story_title) {
            setSettings(prev => ({ ...prev, storyTitle: mainTask.story_title }));
          }
        }
        
        // Clear periodic completion check
        if (completionCheckIntervalRef.current) {
          clearInterval(completionCheckIntervalRef.current);
          completionCheckIntervalRef.current = null;
        }
        
        // Update tab status to 'complete' (for ALL users)
        if (currentUserId) {
          const { updateTabStatus } = await import('../utils/tabManager');
          await updateTabStatus(currentUserId, 'video', currentTab, 'complete', currentGroupId || undefined);
        }

        // Transition to complete state
        setGenerationState('complete');
        setProgress(100);
        setTimeRemaining(0);
        setStatusMessage('Generation complete!');
        generationStateHook.setBatchStatuses([]);
        setVideoTasks(allTasks);
        
        console.log('Successfully transitioned to complete state');
        return;
      }
    } catch (err: any) {
      console.error('Error checking for overall completion:', err);
    }
  };

  // Handle done - reset everything and delete video tasks
  const handleDone = async () => {
    try {
      // Clear periodic completion check
      if (completionCheckIntervalRef.current) {
        clearInterval(completionCheckIntervalRef.current);
        completionCheckIntervalRef.current = null;
      }
  
// Delete all related database records - NO file deletion (files are preserved)
      if (currentUserId && currentGroupId) {
        console.log('Cleaning up all task records (preserving all files)...');

        // Delete video_tasks
        try {
          await withRetry(
            async () => await withTimeout(
              supabase.from('video_tasks').delete()
                .eq('user_id', currentUserId)
                .eq('group_id', currentGroupId)
                .eq('tab', currentTab),
              OPERATION_TIMEOUT,
              'deleteVideoTasks'
            ),
            'deleteVideoTasks'
          );
          console.log('Successfully deleted video tasks');
        } catch (error) {
          console.warn('Failed to delete video tasks:', error);
        }

        // Delete story_tasks where video_process = true
        try {
          await withRetry(
            async () => await withTimeout(
              supabase.from('story_tasks').delete()
                .eq('user_id', currentUserId)
                .eq('group_id', currentGroupId)
                .eq('tab', currentTab)
                .eq('video_process', true),
              OPERATION_TIMEOUT,
              'deleteStoryTasks'
            ),
            'deleteStoryTasks'
          );
          console.log('Successfully deleted story tasks');
        } catch (error) {
          console.warn('Failed to delete story tasks:', error);
        }

        // Delete image_prompt_tasks where video_process = true
        try {
          await withRetry(
            async () => await withTimeout(
              supabase.from('image_prompt_tasks').delete()
                .eq('user_id', currentUserId)
                .eq('group_id', currentGroupId)
                .eq('tab', currentTab)
                .eq('video_process', true),
              OPERATION_TIMEOUT,
              'deleteImagePromptTasks'
            ),
            'deleteImagePromptTasks'
          );
          // Delete image_prompt_context for the same group
          await withRetry(
            async () => await withTimeout(
              supabase.from('image_prompt_context').delete()
                .eq('group_id', currentGroupId),
              OPERATION_TIMEOUT,
              'deleteImagePromptContext'
            ),
            'deleteImagePromptContext'
          );
          console.log('Successfully deleted image prompt tasks/context');
        } catch (error) {
          console.warn('Failed to delete image prompt tasks/context:', error);
        }

        // Delete image_tasks where video_process = true
        try {
          await withRetry(
            async () => await withTimeout(
              supabase.from('image_tasks').delete()
                .eq('user_id', currentUserId)
                .eq('group_id', currentGroupId)
                .eq('tab', currentTab)
                .eq('video_process', true),
              OPERATION_TIMEOUT,
              'deleteImageTasks'
            ),
            'deleteImageTasks'
          );
          console.log('Successfully deleted image tasks');
        } catch (error) {
          console.warn('Failed to delete image tasks:', error);
        }

        // Delete audio_tasks where video_process = true
        try {
          await withRetry(
            async () => await withTimeout(
              supabase.from('audio_tasks').delete()
                .eq('user_id', currentUserId)
                .eq('group_id', currentGroupId)
                .eq('tab', currentTab)
                .eq('video_process', true),
              OPERATION_TIMEOUT,
              'deleteAudioTasks'
            ),
            'deleteAudioTasks'
          );
          console.log('Successfully deleted audio tasks');
        } catch (error) {
          console.warn('Failed to delete audio tasks:', error);
        }

        // Delete ITV-specific tables if visual type is ITV
        if (settings.visualType === 'itv') {
          try {
            await supabase.from('ITV_tasks').delete().eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('video_process', true);
            await supabase.from('ITV_prompt_tasks').delete().eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('video_process', true);
            await supabase.from('ITV_prompt_context').delete().eq('group_id', currentGroupId).eq('tab', currentTab);
            await supabase.from('image_tasks').delete().eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('itv', true);
            console.log('Successfully deleted ITV task records');
          } catch (error) {
            console.warn('Failed to delete ITV task records:', error);
          }
        }

        // Delete TTV-specific tables if visual type is TTV
        if (settings.visualType === 'ttv') {
          try {
            await supabase.from('TTV_tasks').delete().eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('video_process', true);
            await supabase.from('TTV_prompt_tasks').delete().eq('user_id', currentUserId).eq('group_id', currentGroupId).eq('tab', currentTab).eq('video_process', true);
            await supabase.from('TTV_prompt_context').delete().eq('group_id', currentGroupId).eq('tab', currentTab);
            console.log('Successfully deleted TTV task records');
          } catch (error) {
            console.warn('Failed to delete TTV task records:', error);
          }
        }
      }

      // Clean up session clone voice if exists
      await cleanupSessionCloneVoice(sessionCloneVoiceId, sessionCloneVoiceFilePath, currentUserId);

      // Reset tab to defaults (clears estimate_tokens and form inputs)
      if (isEnterpriseUser && currentUserId) {
        const { resetTabToDefaults } = await import('../utils/tabManager');
        await resetTabToDefaults(currentUserId, 'video', currentTab);
      }

      // Clear VoiceSelector upload section
      clearVoiceSelectorUploadSection();
      
      // Clear multi-tab warning if present
      setMultiTabWarning(null);
      
      // Reset all states to initial values
      setGenerationState('idle');
      setCurrentGroupId(null);
      setProgress(0);
      setStatusMessage('');
      generationStateHook.setBatchStatuses([]);
      setVideoTasks([]);
      setAnalysisResult(null);
      setFinalVideoUrl(null);
      setError(null);
      setTimeRemaining(null);
      setUploadedVideoLoopFile(null);
      setUploadedFile(null);
      setUploadedDocId(null);
      setUploadedAudioFile(null);
      setUploadedAudioDocId(null);
      // NEW: Clear video metadata
      setUploadedVideoMetadata(null);
      // NEW: Clear upload language
      setUploadLanguage('');
      // Clear download progress
      setDownloadProgress({});
      // Clear session clone voice tracking
      setSessionCloneVoiceId(null);
      setSessionCloneVoiceFilePath(null);
      // CLEAR PARENT STATES
      setVideoLoopUrl('');
      setBackgroundMusicUrl('');
      
      // Reset settings to defaults
      setSettings({
        storySource: 'new',
        storyTitle: '',
        storyDescription: '',
        wordCount: '',
        language: 'english',
        model: 'sonnet', // Story generation model
        imageModel: 'seedream-4.5', // Image quality model - default to Prime
        imagePromptModel: 'sonnet', // AI model for generating image prompts (deepseek/sonnet/opus)
        selectedStoryDoc: '',
        imageSource: 'generate',
        imagePromptDoc: '',
        imageStyle: '', // Will be set by ConfigurationSteps
        useCharacterDescriptions: true,
        firstPageFrequency: '10',
        restFrequency: '30',
        selectedImageFolder: '',
        uploadedVideoFile: null,
        audioSource: 'generate',
        selectedAudioFile: '',
        selectedAudioFolder: '',
        selectedVoice: 'core:lewis', // Will be set by ConfigurationSteps
        audioSpeed: 1.0,
        audioVolume: 1.0,
        existingAudioVolume: 1.0, // NEW: Reset existing audio volume
        backgroundMusicVolume: 1.0, // NEW: Reset background music volume
        removeTitleChapters: true,
        outputVideoName: 'final_video.mp4',
        loopTimeHours: 0,
        loopTimeMinutes: 30,
        sameAsAudioLength: true,
        // NEW: Reset output type and component selection
        outputType: 'video',
        processStory: true,
        processImages: true,
        processAudio: true,
        // Visual pipeline defaults
        visualType: 'image',
        selectedTTVFolder: '',
        ttvPromptDoc: '',
        selectedITVVideoFolder: '',
        itvVideoPromptDoc: '',
        selectedITVImageFolder: '',
        itvImagePromptDoc: '',
        mgStyleSlug: MG_DEFAULT_STYLE_SLUG,
        mgStyleGuidance: resolveStyleGuidance(MG_DEFAULT_STYLE_SLUG),
        mgClipDuration: MG_DEFAULT_CLIP_SECONDS,
        mgCodegenModel: 'opus',
        mgCustomStyle: '',
        mgPromptDoc: '',
        selectedMGFolder: '',
      });
    } catch (err: any) {
      console.error('Error during cleanup:', err);
      // Still reset the UI even if cleanup fails
      setGenerationState('idle');
      setCurrentGroupId(null);
      setProgress(0);
      setStatusMessage('');
      generationStateHook.setBatchStatuses([]);
      setVideoTasks([]);
      setAnalysisResult(null);
      setFinalVideoUrl(null);
      setError(null);
      setTimeRemaining(null);
      setUploadedVideoLoopFile(null);
      setUploadedFile(null);
      setUploadedDocId(null);
      setUploadedAudioFile(null);
      setUploadedAudioDocId(null);
      // NEW: Clear video metadata
      setUploadedVideoMetadata(null);
      // NEW: Clear upload language
      setUploadLanguage('');
      // Clear download progress
      setDownloadProgress({});
      // Clear session clone voice tracking
      setSessionCloneVoiceId(null);
      setSessionCloneVoiceFilePath(null);
      // CLEAR PARENT STATES
      setVideoLoopUrl('');
      setBackgroundMusicUrl('');
      
      // Reset settings to defaults
      setSettings({
        storySource: 'new',
        storyTitle: '',
        storyDescription: '',
        wordCount: '',
        language: 'english',
        model: 'sonnet', // Story generation model
        imageModel: 'seedream-4.5', // Image quality model - default to Prime
        imagePromptModel: 'sonnet', // AI model for generating image prompts (deepseek/sonnet/opus)
        selectedStoryDoc: '',
        imageSource: 'generate',
        imagePromptDoc: '',
        imageStyle: '', // Will be set by ConfigurationSteps
        useCharacterDescriptions: true,
        firstPageFrequency: '10',
        restFrequency: '30',
        selectedImageFolder: '',
        uploadedVideoFile: null,
        audioSource: 'generate',
        selectedAudioFile: '',
        selectedAudioFolder: '',
        selectedVoice: 'core:lewis', // Will be set by ConfigurationSteps
        audioSpeed: 1.0,
        audioVolume: 1.0,
        existingAudioVolume: 1.0, // NEW: Reset existing audio volume
        backgroundMusicVolume: 1.0, // NEW: Reset background music volume
        removeTitleChapters: true,
        outputVideoName: 'final_video.mp4',
        loopTimeHours: 0,
        loopTimeMinutes: 30,
        sameAsAudioLength: true,
        // NEW: Reset output type and component selection
        outputType: 'video',
        processStory: true,
        processImages: true,
        processAudio: true,
        // Visual pipeline defaults
        visualType: 'image',
        selectedTTVFolder: '',
        ttvPromptDoc: '',
        selectedITVVideoFolder: '',
        itvVideoPromptDoc: '',
        selectedITVImageFolder: '',
        itvImagePromptDoc: '',
        mgStyleSlug: MG_DEFAULT_STYLE_SLUG,
        mgStyleGuidance: resolveStyleGuidance(MG_DEFAULT_STYLE_SLUG),
        mgClipDuration: MG_DEFAULT_CLIP_SECONDS,
        mgCodegenModel: 'opus',
        mgCustomStyle: '',
        mgPromptDoc: '',
        selectedMGFolder: '',
      });
    }
  };

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      // Clean up periodic completion check
      if (completionCheckIntervalRef.current) {
        clearInterval(completionCheckIntervalRef.current);
      }
      // Clean up planning poll
      if (planningPollIntervalRef.current) {
        clearInterval(planningPollIntervalRef.current);
      }
    };
  }, [completionCheckIntervalRef]);

  // Reset analysis state on page load to prevent stuck states
  useEffect(() => {
    const checkAndResetStuckState = async () => {
      if (generationState === 'analyzed' || generationState === 'analyzing') {
        console.log('Resetting stuck analysis state on page load:', generationState);
        setGenerationState('idle');
        setAnalysisResult(null);
        setAnalyzing(false);
        setError(null);
        setGenerationLoading(false);
      } else if (generationState === 'generating' && currentUserId && currentGroupId) {
        // Check if there are actually any active tasks for this tab
        console.log(`Checking for stuck generating state on tab ${currentTab}...`);
        try {
          const { data: videoTasks } = await supabase
            .from('video_tasks')
            .select('id')
            .eq('user_id', currentUserId)
            .eq('group_id', currentGroupId)
            .eq('tab', currentTab)
            .limit(1);
          
          if (!videoTasks || videoTasks.length === 0) {
            console.log(`No video tasks found for tab ${currentTab}, resetting stuck generating state`);
            setGenerationState('idle');
            setGenerationLoading(false);
            setCurrentGroupId(null);
          }
        } catch (error) {
          console.error('Error checking for stuck state:', error);
        }
      }
    };
    
    checkAndResetStuckState();
  }, []);

  // Force re-render when batch statuses change at 0%
  useEffect(() => {
    if (generationState === 'generating') {
      const hasZeroProgress = batchStatuses.some(batch => batch.progress === 0);
      if (hasZeroProgress) {
        console.log('Detected 0% progress, forcing update');
        setLastUpdateTimestamp(Date.now());
      }
    }
  }, [batchStatuses, generationState]);

  useEffect(() => {
    const fetchUserData = async () => {
      try {
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
          setError('Authentication error');
          setLoading(false);
          return;
        }

        setCurrentUserId(user.id);

        // Fetch user plan
        const { data: planData, error: planError } = await supabase
          .from('user_plans')
          .select('plan_type, tokens_used, rollover_tokens')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .single();

        if (planError) throw planError;

        if (planData) {
          const planType = planData.plan_type || 'free';
          setUserPlan(planType);
          setUserTokenBalance(getPlanMaxTokens(planType, isLegacy) - (planData.tokens_used || 0) + (planData.rollover_tokens || 0));
        }

        // Fetch storage usage
        const { data: storageData, error: storageError } = await supabase
          .from('story_documents')
          .select('file_size')
          .eq('user_id', user.id);

        if (!storageError && storageData) {
          const totalSize = storageData.reduce((sum, doc) => sum + (doc.file_size || 0), 0);
          const totalSizeMB = totalSize / (1024 * 1024);
          setStorageUsed(totalSizeMB);
        }

        // Fetch documents
        const { data: docs, error: docsError } = await supabase
          .from('story_documents')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        if (!docsError && docs) {
          // Filter story documents (version 1, 2, 3, or 4) - include image prompt docs
          const storyDocs = docs.filter(doc => [1, 2, 3, 4].includes(doc.version));
          setDocuments(storyDocs);

          // Filter image folders (version 5 or 6)
          const imgFolders = docs.filter(doc => doc.version === 5 || doc.version === 6);
          setImageFolders(imgFolders);

          // Filter audio documents (version 7, 8, 9, or 10)
          const audioDocs = docs.filter(doc => [7, 8, 9, 10].includes(doc.version));
          setAudioFolders(audioDocs);

          // NEW: Filter TTV documents
          // TTV prompt docs: version 12 (standard) or 13 (corrected)
          const ttvPrompts = docs.filter(doc => [12, 13].includes(doc.version));
          setTTVPromptDocs(ttvPrompts);
          // TTV clip folders: version 14 (standard) or 15 (corrected)
          const ttvClips = docs.filter(doc => [14, 15].includes(doc.version));
          setTTVFolders(ttvClips);

          // NEW: Filter ITV documents
          // ITV image prompt docs: version 16 (standard) or 17 (corrected)
          const itvImgPrompts = docs.filter(doc => [16, 17].includes(doc.version));
          setITVImagePromptDocs(itvImgPrompts);
          // ITV keyframe image folders: version 18 (standard) or 19 (corrected)
          const itvImgFolders = docs.filter(doc => [18, 19].includes(doc.version));
          setITVImageFolders(itvImgFolders);
          // ITV video prompt docs: version 20 (standard) or 21 (corrected)
          const itvVidPrompts = docs.filter(doc => [20, 21].includes(doc.version));
          setITVVideoPromptDocs(itvVidPrompts);
          // ITV video clip folders: version 22 (standard) or 23 (corrected)
          const itvVidFolders = docs.filter(doc => [22, 23].includes(doc.version));
          setITVVideoFolders(itvVidFolders);

          // MG prompt docs: version 24 (standard) or 25 (corrected)
          const mgPrompts = docs.filter(doc => [24, 25].includes(doc.version));
          setMGPromptDocs(mgPrompts);
          // MG output video folders: version 26 (standard) or 27 (corrected)
          const mgFolders = docs.filter(doc => [26, 27].includes(doc.version));
          setMGVideoFolders(mgFolders);
        }

        setLoading(false);
      } catch (err: any) {
        setError(err.message);
        setLoading(false);
      }
    };

    fetchUserData();
  }, []);

  // UPDATED: Check for existing tasks on mount and set up periodic completion check
  useEffect(() => {
    const checkExistingTasks = async () => {
      if (!currentUserId) return;

      // Skip if AI planning poll is active — planning display is managed separately
      if (planningPollIntervalRef.current) {
        console.log('[checkExistingTasks] Skipping — planning poll is active');
        return;
      }

      try {
        // FIRST: Check tab status in database to see if we should even look for tasks
        const { data: tabData, error: tabError } = await supabase
          .from('tabs')
          .select('status, group_id')
          .eq('user_id', currentUserId)
          .eq('page', 'video')
          .eq('tab_number', currentTab)
          .maybeSingle();

        if (tabError) {
          console.error('Error checking tab status:', tabError);
          return;
        }

        // If tab is idle or doesn't exist, don't check for tasks - treat as fresh page
        if (!tabData || tabData.status === 'idle') {
          console.log('Tab is idle or new - starting fresh (no task check)');
          return;
        }

        // ONLY if tab status is 'generating', 'complete', or 'error', check for tasks
        console.log(`Tab status is '${tabData.status}' - checking for existing tasks`);

        // Check if there are any existing tasks for this user and tab
        const { data: allTasks, error } = await supabase
          .from('video_tasks')
          .select('*')
          .eq('user_id', currentUserId)
          .eq('tab', currentTab)
          .order('created_at', { ascending: true });

        if (error) throw error;

        if (!allTasks || allTasks.length === 0) {
          console.log('No tasks found despite tab status - resetting to idle');
          // Reset tab to idle if no tasks found (for ALL users)
          const { updateTabStatus } = await import('../utils/tabManager');
          await updateTabStatus(currentUserId, 'video', currentTab, 'idle');
          return;
        }

        // Check if ALL tasks have overall_status = 'completed_final'
        const allCompleted = allTasks.every(task => task.overall_status === 'completed_final');
        
        if (allCompleted) {
          // All tasks are completed - show finish screen
          console.log('All video tasks completed, showing finish screen');
          
          const mainTaskPool = allTasks.filter(task => task.is_main || !task.doc_id);
          const mainTask = mainTaskPool.find(t => t.is_main) || mainTaskPool[mainTaskPool.length - 1] || allTasks[allTasks.length - 1];

          if (mainTask) {
            setCurrentGroupId(mainTask.group_id);
            setFinalVideoUrl(mainTask.final_video_url || null);
            setSettings(prev => ({ ...prev, storyTitle: mainTask.story_title }));
          }
          
          // Update tab status to 'complete' (for ALL users)
          if (currentUserId) {
            const { updateTabStatus } = await import('../utils/tabManager');
            await updateTabStatus(currentUserId, 'video', currentTab, 'complete', mainTask.group_id);
          }

          setGenerationState('complete');
          setProgress(100);
          setTimeRemaining(0);
          setStatusMessage('Video generation complete!');
          generationStateHook.setBatchStatuses([]);
          setVideoTasks(allTasks);
          return;
        }

        // Check if there are any tasks in 'planning' state (placeholder rows waiting for backend)
        const planningTasks = allTasks.filter(task => task.overall_status === 'planning');
        if (planningTasks.length > 0 && allTasks.every(task => task.overall_status === 'planning')) {
          // Only planning tasks exist — backend hasn't finished yet
          console.log('Found planning tasks - showing AI Planning UI');
          const planningTask = planningTasks[planningTasks.length - 1];
          
          setCurrentGroupId(planningTask.group_id);
          setGenerationState('generating');
          setProgress(0);
          setStatusMessage('AI is planning your video settings...');
          setSettings(prev => ({
            ...prev,
            storyTitle: planningTask.story_title || 'Planning...',
            visualType: planningTask.visual_type || 'image',
          }));

          // Show AI Planning batch status
          generationStateHook.initializeBatchStatuses([
            { id: 'planning', label: 'AI Planning', progress: 50, status: 'running' },
            { id: 'story', label: 'Story Generation', progress: 0, status: 'pending' },
            { id: 'audio', label: 'Audio Generation', progress: 0, status: 'pending' },
            { id: 'image_prompts', label: 'Image Prompts', progress: 0, status: 'pending' },
            { id: 'image_generation', label: 'Image Generation', progress: 0, status: 'pending' },
            { id: 'video', label: 'Video Creation', progress: 0, status: 'pending' },
          ] as any);

          // Start a poll to wait for story generation to have real progress (> 0%)
          if (planningPollIntervalRef.current) clearInterval(planningPollIntervalRef.current);
          planningPollIntervalRef.current = setInterval(async () => {
            try {
              const { data: storyTasks } = await supabase
                .from('story_tasks')
                .select('status, progress')
                .eq('user_id', currentUserId)
                .eq('group_id', planningTask.group_id)
                .eq('video_process', true)
                .limit(5);

              // Need 2+ rows — the first row is a placeholder, real processing starts with batch rows
              const hasRealProgress = storyTasks && storyTasks.length >= 2;

              if (hasRealProgress) {
                if (planningPollIntervalRef.current) {
                  clearInterval(planningPollIntervalRef.current);
                  planningPollIntervalRef.current = null;
                }
                console.log('Story generation has real progress — reloading task state');
                checkExistingTasks();
              }
            } catch (err) {
              console.error('[checkExistingTasks] Planning poll error:', err);
            }
          }, 5000);

          setVideoTasks(allTasks);
          return;
        }

        // Check if there are any running/pending tasks
        const activeTasks = allTasks.filter(task => 
          ['pending', 'queued', 'running'].includes(task.overall_status)
        );

        if (activeTasks.length > 0) {
          // There are active tasks - start the appropriate task pollers
          console.log('Found active video tasks, starting task pollers');
          
          const mainTaskPool = activeTasks.filter(task => task.is_main || !task.doc_id);
          const mainTask = mainTaskPool.find(task => task.video_creation_status === 'running')
            || mainTaskPool.find(task => task.overall_status === 'running')
            || mainTaskPool.find(task => task.is_main)
            || mainTaskPool[mainTaskPool.length - 1]
            || activeTasks[activeTasks.length - 1];
          
          if (mainTask && !currentGroupId) {
            setCurrentGroupId(mainTask.group_id);
          }
          
          if (generationState === 'idle') {
            setGenerationState('generating');
          }
          
          setVideoTasks(allTasks);

          // NEW: Start more frequent completion check during video processing (every 30 seconds instead of 60)
          if (!completionCheckIntervalRef.current) {
            completionCheckIntervalRef.current = setInterval(() => {
              console.log('Periodic completion check...');
              checkForOverallCompletion();
            }, 30000); // Check every 30 seconds
          }

          // Start appropriate task pollers based on the task statuses
          if (mainTask && mainTask.settings) {
            const backendSettings = mainTask.settings;
            
            // UPDATED: Update settings state with backend values BEFORE setting batch statuses
            setSettings(prev => ({
              ...prev,
              visualType: mainTask.visual_type || backendSettings.visual_type || 'image',
              outputType: backendSettings.video === false ? 'components' : 'video',
              processStory: backendSettings.process_story !== false,
              processImages: backendSettings.process_images !== false,
              processAudio: backendSettings.process_audio !== false,
              // Also restore key estimation fields so periodic refresh has correct values
              ...(backendSettings.word_count ? { wordCount: String(backendSettings.word_count) } : {}),
              ...(backendSettings.rest_frequency ? { restFrequency: String(backendSettings.rest_frequency) } : {}),
              ...(backendSettings.first_page_frequency ? { firstPageFrequency: String(backendSettings.first_page_frequency) } : {}),
              ...(backendSettings.voice ? { selectedVoice: backendSettings.voice } : {}),
              ...(backendSettings.image_model ? { imageModel: backendSettings.image_model } : {}),
              ...(backendSettings.use_existing_story !== undefined ? { storySource: backendSettings.use_existing_story ? 'existing' : 'new' } : {}),
              ...(backendSettings.use_existing_images !== undefined ? { imageSource: backendSettings.use_existing_images ? 'folder' : 'generate' } : {}),
              ...(backendSettings.use_existing_audio !== undefined ? { audioSource: backendSettings.use_existing_audio ? 'existing' : 'generate' } : {}),
            }));
            
            // Calculate task settings from backend data
            // NOTE: visual_type, video_model, video_duration, total_audio_duration are DIRECT COLUMNS
            // on video_tasks, NOT inside the settings JSON. Read them from mainTask.
            const actualWordCount = backendSettings.word_count || backendSettings.wordCount || mainTask.word_count || 5000;
            const resolvedVideoModel = mainTask.video_model || backendSettings.video_model || undefined;
            const resolvedItvModel = mainTask.itv_model || backendSettings.itv_model || undefined;
            const resolvedVideoDuration = Number(mainTask.video_duration) || Number(backendSettings.video_duration) || 5;
            const resolvedTotalAudioDuration = Number(mainTask.total_audio_duration) || Number(backendSettings.total_audio_duration) || 0;
            const resolvedVisualTypeForTask = (mainTask.visual_type || backendSettings.visual_type || 'image') as 'image' | 'ttv' | 'itv' | 'mg';
            
            // Calculate numImages — for TTV/ITV, use audio_duration / clip_duration
            let numImages = 15;
            if (resolvedVisualTypeForTask === 'ttv' || resolvedVisualTypeForTask === 'itv') {
              // TTV/ITV: clip count = ceil(total_audio_duration / clip_duration)
              if (resolvedTotalAudioDuration > 0 && resolvedVideoDuration > 0) {
                numImages = Math.ceil(resolvedTotalAudioDuration / resolvedVideoDuration);
              } else {
                // Fallback: try estimated_image_count from settings, then image_amount column
                numImages = backendSettings.estimated_image_count || mainTask.image_amount || 15;
              }
            } else {
              // Standard image pipeline
              if (backendSettings.use_existing_images && backendSettings.images_folder_path) {
                numImages = await getImageCountFromFolder(backendSettings.images_folder_path);
                if (numImages === 0) numImages = 15;
              } else if (!backendSettings.use_existing_images) {
                // Calculate numImages based on frequency mode
                const frequencyMode = mainTask.frequency_mode || backendSettings.frequency_mode || 'wordcount';
                
                if (frequencyMode === 'audio') {
                  // Audio mode: use the specified image amount directly
                  numImages = mainTask.image_amount || backendSettings.image_amount || 10;
                } else if ((mainTask.frequency_type || backendSettings.frequency_type) === 'consistent') {
                  // Wordcount consistent mode: calculate from word count and consistent frequency
                  const consistentFreq = mainTask.consistent_frequency || backendSettings.consistent_frequency || 30;
                  if (actualWordCount > 0 && consistentFreq > 0) {
                    numImages = Math.ceil(actualWordCount / consistentFreq);
                  }
                } else {
                  // Wordcount variable mode: use first page and rest page frequencies
                  const backendFirstPageFreq = mainTask.first_page_frequency ?? backendSettings.first_page_frequency ?? 10;
                  const backendRestFreq = mainTask.rest_frequency ?? backendSettings.rest_frequency ?? 30;
                  if (actualWordCount > 0) {
                    numImages = estimateImageCount(actualWordCount, backendFirstPageFreq, backendRestFreq);
                  }
                }
              }
            }
            
            const backendVoice = backendSettings.voice || 'henry';
            const backendModelVersion = backendSettings.model_version || 'lemonfox';
            
            const taskSettings = {
              wordCount: actualWordCount,
              numImages: numImages,
              voice: backendVoice,
              modelVersion: backendModelVersion,
              imageModel: backendSettings.image_model || backendSettings.imageModel || 'seedream-4.5', // Image quality model
              restFrequency: backendSettings.rest_frequency ?? 30,
              firstPageFrequency: backendSettings.first_page_frequency ?? 10,
              needsStoryGeneration: !backendSettings.use_existing_story,
              needsImageGeneration: !backendSettings.use_existing_images,
              needsAudioGeneration: !backendSettings.use_existing_audio,
              useExistingImages: backendSettings.use_existing_images || false,
              transitionType: backendSettings.transition_type || null,
              hasVideoLoop: backendSettings.video_loop !== null && backendSettings.video_loop !== undefined,
              // ADD THESE LINES: Processing control flags from backend settings
              video: backendSettings.video !== false,
              processStory: backendSettings.process_story !== false,
              processImages: backendSettings.process_images !== false,
              processAudio: backendSettings.process_audio !== false,
            };

            // CALCULATE ACCURATE BATCH STATUSES from task tables directly
            // This ensures we show real-time progress, not stale aggregated values from video_tasks
            const calculatedBatchStatuses = await calculateVideoProgress(
              currentUserId,
              mainTask.group_id,
              currentTab,
              {
                processStory: backendSettings.process_story !== false,
                processImages: backendSettings.process_images !== false,
                processAudio: backendSettings.process_audio !== false,
                video: backendSettings.video !== false,
                useExistingStory: backendSettings.use_existing_story === true,
                useExistingImages: backendSettings.use_existing_images === true,
                useExistingAudio: backendSettings.use_existing_audio === true,
                visualType: resolvedVisualTypeForTask
              }
            );
            
            // Initialize batch statuses with accurate progress
            generationStateHook.initializeBatchStatuses(calculatedBatchStatuses as any);
            setLastUpdateTimestamp(Date.now());

            // Calculate and set initial time remaining based on current progress
            // NOTE: We get current progress from calculatedBatchStatuses now, not from stale video_tasks fields
            const currentRunningPhase: string | null = 
              mainTask.story_status === 'running' ? 'story' :
              // TTV phases
              (resolvedVisualTypeForTask === 'ttv' && mainTask.ttv_prompt_status === 'running') ? 'ttvPrompt' :
              (resolvedVisualTypeForTask === 'ttv' && mainTask.ttv_status === 'running') ? 'ttvGeneration' :
              // ITV phases — check P1 (image_prompt_status) then P2/P3 (concurrent), then P4
              (resolvedVisualTypeForTask === 'itv' && mainTask.image_prompt_status === 'running') ? 'itvImagePrompt' :
              (resolvedVisualTypeForTask === 'itv' && (mainTask.itv_prompt_status === 'running' || mainTask.image_generation_status === 'running')) ? 'itvImageGeneration' :
              (resolvedVisualTypeForTask === 'itv' && mainTask.itv_status === 'running') ? 'itvGeneration' :
              // Standard image phases (only for image visual type)
              (resolvedVisualTypeForTask === 'image' && mainTask.image_prompt_status === 'running') ? 'imagePrompt' :
              (resolvedVisualTypeForTask === 'image' && mainTask.image_generation_status === 'running') ? 'imageGeneration' :
              mainTask.audio_status === 'running' ? 'audio' :
              mainTask.video_creation_status === 'running' ? 'video' : null;

            if (currentRunningPhase) {
              // Find the current progress from our calculated batch statuses
              const phaseIdMap: Record<string, string> = {
                'story': 'story',
                'imagePrompt': 'image_prompts',
                'imageGeneration': 'image_generation',
                'audio': 'audio',
                'video': 'video',
                'ttvPrompt': 'ttv_prompts',
                'ttvGeneration': 'ttv_generation',
                'itvImagePrompt': 'itv_image_prompts',
                'itvPrompt': 'itv_prompts',
                'itvImageGeneration': 'itv_image_generation',
                'itvGeneration': 'itv_generation'
              };
              
              const currentBatchStatus = calculatedBatchStatuses.find(
                b => b.id === phaseIdMap[currentRunningPhase]
              );
              const currentProgress = currentBatchStatus?.progress || 0;

              // Calculate initial time remaining based on phase.
              // Strategy:
              //  - VIDEO phase: do NOT set an initial value here. The
              //    periodic-refresh effect fires immediately once
              //    `generationState='generating'` and `currentGroupId` are
              //    set, and uses the exact same per-batch estimator with the
              //    latest batch progress. Setting a baseline here briefly
              //    flashes a less-accurate number (e.g. 46m) before the
              //    refresh overwrites it with the progress-aware value
              //    (e.g. 43m). Leaving timeRemaining null hides the row
              //    entirely until the refresh paints the correct value.
              //  - Other phases: set the per-phase estimate immediately.
              let initialTimeRemaining = 0;
              let shouldSetTimeRemaining = true;

              if (currentRunningPhase === 'video') {
                shouldSetTimeRemaining = false;
                console.log('Deferring initial timeRemaining to periodic refresh (video phase)');
              } else {
                // For non-video phases, use the calculation

                // ITV pipeline: use calculateITVConcurrentTime which properly handles
                // P2 (image gen) and P3 (video prompts) running concurrently.
                if (resolvedVisualTypeForTask === 'itv' && ['itvImagePrompt', 'itvPrompt', 'itvImageGeneration', 'itvGeneration'].includes(currentRunningPhase)) {
                  const p1Status = calculatedBatchStatuses.find(b => b.id === 'itv_image_prompts');
                  const p2Status = calculatedBatchStatuses.find(b => b.id === 'itv_image_generation');
                  const p3Status = calculatedBatchStatuses.find(b => b.id === 'itv_prompts');
                  const p4Status = calculatedBatchStatuses.find(b => b.id === 'itv_generation');

                  initialTimeRemaining = calculateITVConcurrentTime(
                    {
                      p1: p1Status?.progress ?? 0,
                      p2: p2Status?.progress ?? 0,
                      p3: p3Status?.progress ?? 0,
                      p4: p4Status?.progress ?? 0,
                    },
                    numImages,
                    {
                      imageModel: backendSettings.image_model || backendSettings.imageModel || 'seedream-4.5',
                      itvModel: resolvedItvModel,
                      includeVideoAssembly: backendSettings.video !== false,
                      transitionType: backendSettings.transition_type || null,
                    }
                  );

                  console.log(`Setting initial time remaining (ITV concurrent): ${initialTimeRemaining} minutes`);
                } else {
                  // Standard / TTV pipelines: use calculateRemainingTime
                  const batchCountForPhase = 
                    currentRunningPhase === 'story' ? Math.ceil(actualWordCount / (backendSettings.model === 'opus' || backendSettings.model === 'sonnet' ? 3000 : 1100)) :
                    currentRunningPhase === 'imagePrompt' ? Math.ceil(numImages / 2) :
                    currentRunningPhase === 'imageGeneration' ? numImages :
                    currentRunningPhase === 'audio' ? Math.ceil(actualWordCount / (backendSettings.model_version === 'premium' ? 800 : 1000)) :
                    // TTV/ITV batch counts
                    currentRunningPhase === 'ttvPrompt' ? Math.ceil(numImages / 2) :
                    currentRunningPhase === 'ttvGeneration' ? numImages :
                    currentRunningPhase === 'itvPrompt' ? Math.ceil(numImages / 2) :
                    currentRunningPhase === 'itvImageGeneration' ? numImages :
                    currentRunningPhase === 'itvGeneration' ? numImages : 1;

                  initialTimeRemaining = calculateRemainingTime(
                    currentRunningPhase as any,
                    currentProgress || 0,
                    batchCountForPhase,
                    {
                      wordCount: actualWordCount,
                      numImages: numImages,
                      voice: backendVoice,
                      modelVersion: backendModelVersion,
                      imageModel: backendSettings.image_model || backendSettings.imageModel || 'seedream-4.5',
                      restFrequency: backendSettings.rest_frequency ?? 30,
                      needsStoryGeneration: !backendSettings.use_existing_story,
                      needsImageGeneration: !backendSettings.use_existing_images,
                      needsAudioGeneration: !backendSettings.use_existing_audio,
                      useExistingImages: backendSettings.use_existing_images || false,
                      videoCreationStatus: mainTask.video_creation_status as 'pending' | 'running',
                      transitionType: backendSettings.transition_type || null,
                      hasVideoLoop: backendSettings.video_loop !== null && backendSettings.video_loop !== undefined,
                      video: backendSettings.video !== false,
                      processStory: backendSettings.process_story !== false,
                      processImages: backendSettings.process_images !== false,
                      processAudio: backendSettings.process_audio !== false,
                      visualType: resolvedVisualTypeForTask,
                      videoModel: resolvedVideoModel,
                      itvModel: resolvedItvModel,
                    }
                  );
                  
                  console.log(`Setting initial time remaining (${currentRunningPhase} phase): ${initialTimeRemaining} minutes (numImages=${numImages}, visualType=${resolvedVisualTypeForTask}, videoModel=${resolvedVideoModel}, totalAudioDuration=${resolvedTotalAudioDuration}, videoDuration=${resolvedVideoDuration})`);
                }
              }
              
              if (shouldSetTimeRemaining) {
                setTimeRemaining(initialTimeRemaining);
              }
            }

            // Start task pollers based on current status with completion handlers
            // REMOVED: Polling system completely removed in favor of 60-second periodic refresh.
            // Progress is calculated from individual task tables via calculateVideoProgress().
          }
        } else {
          // No active tasks but tab isn't complete - reset to idle
          console.log('No active tasks found - resetting tab to idle');
          const { updateTabStatus } = await import('../utils/tabManager');
          await updateTabStatus(currentUserId, 'video', currentTab, 'idle');
        }
      } catch (err: any) {
        console.error('Error checking existing video tasks:', err);
      }
    };

    checkExistingTasks();
  }, [currentUserId, currentTab]); // Changed from generationState to currentTab

  // Get image folders for the selected story's group
  const getImageFoldersForSelectedStory = () => {
    if (!settings.selectedStoryDoc) return [];
    const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
    if (!selectedDoc?.group_id) return [];
    return imageFolders.filter(folder => folder.group_id === selectedDoc.group_id);
  };

  // Get image prompt documents for the selected story's group
  const getImagePromptDocsForSelectedStory = () => {
    if (!settings.selectedStoryDoc) return [];
    const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
    if (!selectedDoc?.group_id) return [];
    
    // Find the image folder for this group to determine the correct prompt version
    const imageFolder = imageFolders.find(folder => folder.group_id === selectedDoc.group_id);
    if (!imageFolder) return [];
    
    // If image folder is version 5, show version 3 prompts
    // If image folder is version 6, show version 4 prompts
    const targetVersion = imageFolder.version === 5 ? 3 : 4;
    
    // Filter documents for the correct version in the same group
    return documents.filter(doc => 
      doc.group_id === selectedDoc.group_id && 
      doc.version === targetVersion
    );
  };

  // Get audio files for the selected story's group
  const getAudioFilesForSelectedStory = () => {
    if (!settings.selectedStoryDoc) return audioFolders;
    const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
    if (!selectedDoc?.group_id) return audioFolders;
    return audioFolders.filter(file => file.group_id === selectedDoc.group_id);
  };

  // NEW: Get TTV clip folders for the selected story's group (version 14/15)
  const getTTVFoldersForSelectedStory = () => {
    if (!settings.selectedStoryDoc) return [];
    const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
    if (!selectedDoc?.group_id) return [];
    return ttvFolders.filter(folder => folder.group_id === selectedDoc.group_id);
  };

  // NEW: Get TTV prompt docs for the selected story's group (version 12/13)
  const getTTVPromptDocsForSelectedStory = () => {
    if (!settings.selectedStoryDoc) return [];
    const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
    if (!selectedDoc?.group_id) return [];
    return ttvPromptDocs.filter(doc => doc.group_id === selectedDoc.group_id);
  };

  // NEW: Get ITV video clip folders for the selected story's group (version 22/23)
  const getITVVideoFoldersForSelectedStory = () => {
    if (!settings.selectedStoryDoc) return [];
    const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
    if (!selectedDoc?.group_id) return [];
    return itvVideoFolders.filter(folder => folder.group_id === selectedDoc.group_id);
  };

  // NEW: Get ITV video prompt docs for the selected story's group (version 20/21)
  const getITVVideoPromptDocsForSelectedStory = () => {
    if (!settings.selectedStoryDoc) return [];
    const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
    if (!selectedDoc?.group_id) return [];
    return itvVideoPromptDocs.filter(doc => doc.group_id === selectedDoc.group_id);
  };

  // NEW: Get ITV keyframe image folders for the selected story's group (version 18/19)
  const getITVImageFoldersForSelectedStory = () => {
    if (!settings.selectedStoryDoc) return [];
    const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
    if (!selectedDoc?.group_id) return [];
    return itvImageFolders.filter(folder => folder.group_id === selectedDoc.group_id);
  };

  // NEW: Get ITV image prompt docs for the selected story's group (version 16/17)
  const getITVImagePromptDocsForSelectedStory = () => {
    if (!settings.selectedStoryDoc) return [];
    const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
    if (!selectedDoc?.group_id) return [];
    return itvImagePromptDocs.filter(doc => doc.group_id === selectedDoc.group_id);
  };

  // MG prompt docs for the selected story's group (version 24/25)
  const getMGPromptDocsForSelectedStory = () => {
    if (!settings.selectedStoryDoc) return [];
    const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
    if (!selectedDoc?.group_id) return [];
    return mgPromptDocs.filter(doc => doc.group_id === selectedDoc.group_id);
  };

  // MG output video folders for the selected story's group (version 26/27)
  const getMGVideoFoldersForSelectedStory = () => {
    if (!settings.selectedStoryDoc) return [];
    const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
    if (!selectedDoc?.group_id) return [];
    return mgVideoFolders.filter(folder => folder.group_id === selectedDoc.group_id);
  };

  // Update image folders when selected story document changes
  useEffect(() => {
    if (settings.selectedStoryDoc && currentUserId) {
      const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
      if (selectedDoc?.group_id) {
        const folders = imageFolders.filter(folder => folder.group_id === selectedDoc.group_id);
        // If current selection is not valid for this group, clear it
        if (settings.selectedImageFolder && !folders.find(f => f.id === settings.selectedImageFolder)) {
          setSettings(prev => ({ ...prev, selectedImageFolder: '', imagePromptDoc: '' }));
        }
      }
    }
  }, [settings.selectedStoryDoc, documents, imageFolders, currentUserId, setSettings]);

  // Update audio files when selected story document changes
  useEffect(() => {
    if (settings.selectedStoryDoc && currentUserId) {
      const selectedDoc = documents.find(doc => doc.id === settings.selectedStoryDoc);
      if (selectedDoc?.group_id) {
        const relatedAudioFiles = audioFolders.filter(file => file.group_id === selectedDoc.group_id);
        // If current selection is not valid for this group, clear it
        if (settings.selectedAudioFile && !relatedAudioFiles.find(f => f.id === settings.selectedAudioFile)) {
          setSettings(prev => ({ ...prev, selectedAudioFile: '' }));
        }
      }
    }
  }, [settings.selectedStoryDoc, documents, audioFolders, currentUserId, setSettings]);

  // Load saved tab form inputs on mount or tab change
  useEffect(() => {
    if (!userId || currentTab <= 0) return;

    const loadTabFormInputs = async () => {
      const savedInputs = await getVideoTabFormInputs(userId, currentTab);
      if (savedInputs) {
        setSettings(prev => ({
          ...prev,
          storyTitle: savedInputs.title || prev.storyTitle,
          storyDescription: savedInputs.storyDescription || prev.storyDescription,
          wordCount: (savedInputs.is_runtime_mode !== false && savedInputs.runtime_minutes)
            ? minutesToWordCount(savedInputs.runtime_minutes).toString()
            : (savedInputs.wordCount?.toString() || prev.wordCount),
          language: savedInputs.language || prev.language,
          model: savedInputs.storyModel || prev.model,
          imagePromptModel: savedInputs.model || prev.imagePromptModel,
          imageModel: savedInputs.imageModel || prev.imageModel,
          imageStyle: savedInputs.style || prev.imageStyle,
          useCharacterDescriptions: savedInputs.useCharacterDescriptions ?? prev.useCharacterDescriptions,
          firstPageFrequency: savedInputs.firstPageFrequency?.toString() || prev.firstPageFrequency,
          restFrequency: savedInputs.restFrequency?.toString() || prev.restFrequency,
          selectedVoice: savedInputs.selectedVoice || prev.selectedVoice,
          audioSpeed: savedInputs.speed || prev.audioSpeed,
          audioVolume: savedInputs.volume || prev.audioVolume,
          preference: savedInputs.preference || prev.preference,
          removeTitleChapters: savedInputs.removeTitleChapters ?? prev.removeTitleChapters,
          outputType: savedInputs.video ? 'video' : prev.outputType,
          processStory: savedInputs.processStory ?? prev.processStory,
          processImages: savedInputs.processImages ?? prev.processImages,
          processAudio: savedInputs.processAudio ?? prev.processAudio,
          storySource: savedInputs.useExistingStory ? 'existing' : prev.storySource,
          imageSource: savedInputs.useExistingImages ? 'folder' : prev.imageSource,
          audioSource: savedInputs.useExistingAudio ? 'existing' : prev.audioSource,
        }));

        // Restore video-specific settings
        if (savedInputs.bgMusicUrl) setBackgroundMusicUrl(savedInputs.bgMusicUrl);
        if (savedInputs.bgMusicVolume) setBackgroundMusicVolumeInput(savedInputs.bgMusicVolume.toString());
        if (savedInputs.videoLoopUrl) setVideoLoopUrl(savedInputs.videoLoopUrl);
        if (savedInputs.transitionType) setSelectedTransition(savedInputs.transitionType);
        if (savedInputs.animationType) setSelectedAnimation(savedInputs.animationType);
        if (savedInputs.effectsType) setSelectedEffect(savedInputs.effectsType);
        
        // Restore runtime mode settings
        if (savedInputs.is_runtime_mode !== undefined) {
          setIsRuntimeMode(savedInputs.is_runtime_mode);
        }
        if (savedInputs.runtime_minutes) {
          setRuntimeMinutes(savedInputs.runtime_minutes.toString());
        }
        
        // Restore master prompt settings
        if (savedInputs.master_prompt) {
          setMasterPromptEnabled(true);
          setMasterPromptData(savedInputs.master_prompt);
        }
        if (savedInputs.master_prompt_enhance_ai !== undefined) {
          setMasterPromptEnhanceAI(savedInputs.master_prompt_enhance_ai);
        }
      }
    };

    loadTabFormInputs();
  }, [userId, currentTab]);

  // Save tab form inputs when settings change
  useEffect(() => {
    if (!userId || currentTab <= 0 || generationState === 'generating') return;

    const saveInputs = async () => {
      await saveVideoTabFormInputs(userId, currentTab, {
        title: settings.storyTitle,
        storyDescription: settings.storyDescription,
        wordCount: parseInt(settings.wordCount) || minutesToWordCount(parseInt(runtimeMinutes) || 10),
        language: settings.language,
        model: settings.imagePromptModel,
        storyModel: settings.model,
        imageModel: settings.imageModel,
        style: settings.imageStyle,
        useCharacterDescriptions: settings.useCharacterDescriptions,
        firstPageFrequency: parseFloat(settings.firstPageFrequency),
        restFrequency: parseFloat(settings.restFrequency),
        selectedVoice: settings.selectedVoice,
        speed: settings.audioSpeed,
        volume: settings.audioVolume,
        preference: settings.preference,
        removeTitleChapters: settings.removeTitleChapters,
        outputVideoName: `${settings.storyTitle}.mp4`,
        transitionType: selectedTransition,
        animationType: selectedAnimation,
        effectsType: selectedEffect,
        bgMusicUrl: backgroundMusicUrl,
        bgMusicVolume: parseFloat(backgroundMusicVolumeInput) || 1.0,
        videoLoopUrl: videoLoopUrl,
        loopTime: settings.sameAsAudioLength ? null : convertTimeToSeconds(settings.loopTimeHours, settings.loopTimeMinutes),
        video: settings.outputType === 'video',
        processStory: settings.processStory,
        processImages: settings.processImages,
        processAudio: settings.processAudio,
        useExistingStory: settings.storySource === 'existing' || settings.storySource === 'upload',
        storyFilePath: settings.storySource === 'existing' ? documents.find(d => d.id === settings.selectedStoryDoc)?.file_path : undefined,
        useExistingImages: settings.imageSource === 'folder' || settings.imageSource === 'upload',
        imagesFolderPath: settings.imageSource === 'folder' ? imageFolders.find(f => f.id === settings.selectedImageFolder)?.file_path : undefined,
        imagePromptPath: settings.imagePromptDoc ? documents.find(d => d.id === settings.imagePromptDoc)?.file_path : undefined,
        useExistingAudio: settings.audioSource === 'existing',
        audioFilePath: settings.audioSource === 'existing' && settings.selectedAudioFile ? audioFolders.find(a => a.id === settings.selectedAudioFile)?.file_path : undefined,
        // Runtime mode settings
        isRuntimeMode,
        runtimeMinutes: isRuntimeMode ? parseInt(runtimeMinutes) : null,
        // Master prompt settings
        masterPromptEnabled: masterPromptEnabled && masterPromptData ? true : false,
        masterPromptEnhanceAI,
        masterPromptData: masterPromptEnabled ? masterPromptData : null,
      });
    };

    const timeoutId = setTimeout(saveInputs, 1000); // Debounce saves
    return () => clearTimeout(timeoutId);
  }, [userId, currentTab, settings, backgroundMusicUrl, backgroundMusicVolumeInput, videoLoopUrl, selectedTransition, selectedAnimation, selectedEffect, generationState, documents, imageFolders, audioFolders]);

  if (loading) {
    return (
      <DashboardLayout>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent-text"></div>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8" style={{ zoom: 1.1 }}>
        {/* Atmospheric gradient background */}
        <div className="pointer-events-none absolute inset-0 -top-20 overflow-hidden" aria-hidden="true">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120%] h-[500px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(220,38,38,0.14)_0%,transparent_70%)]" />
          <div className="absolute top-40 left-0 w-[40%] h-[300px] bg-[radial-gradient(ellipse_80%_80%_at_20%_50%,rgba(59,130,246,0.07)_0%,transparent_60%)]" />
          <div className="absolute top-60 right-0 w-[35%] h-[250px] bg-[radial-gradient(ellipse_80%_80%_at_80%_50%,rgba(34,197,94,0.06)_0%,transparent_60%)]" />
        </div>

        <div className={userPlan === 'free' ? 'relative' : ''}>
          {userPlan === 'free' && (
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-12 z-50">
              <div className="rounded-2xl bg-surface-card border border-border-card p-8 max-w-md w-full shadow-[0_0_40px_rgba(220,38,38,0.08)]">
                <div className="flex items-center gap-3 mb-3">
                  <div className="pipeline-icon-circle inline-flex items-center justify-center w-10 h-10 rounded-full bg-accent/5">
                    <Lock className="h-5 w-5 text-accent-text" />
                  </div>
                  <h2 className="text-lg sm:text-xl font-display font-semibold text-white">Paid Feature</h2>
                </div>
                <p className="text-sm text-text-muted mb-6 leading-relaxed">Video Generator requires a paid plan. Upgrade to unlock video creation, all generators, and more.</p>
                <button
                  onClick={() => navigate('../Pricing')}
                  className="w-full flex justify-center items-center gap-2 px-6 py-3 bg-accent text-white rounded-xl hover:bg-accent-hover transition-all duration-200 text-sm font-medium hover:scale-[1.01] active:scale-[0.99]"
                >
                  View Plans
                </button>
              </div>
            </div>
          )}
          
          <div className={userPlan === 'free' ? 'opacity-50 pointer-events-none' : ''}>
            <div className="relative mb-8 dash-animate-in">
              <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Video Generator</h1>
              <div className="mt-2">
                <p className="text-text-secondary">Create complete videos by combining story, images, and audio</p>
                <p className="text-text-muted text-sm mt-1">{formatNumber(userTokenBalance)} tokens remaining</p>
                <p className="text-text-muted text-sm mt-0.5">
                  Storage: {storageUsed !== null ? `${formatStorageSize(storageUsed)} / ${maxStorageGB} GB` : 'Calculating...'}
                </p>
              </div>

              <div className="mt-5 p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card dash-animate-in">
                <h3 className="text-xl font-semibold mb-2 text-accent">What to Expect</h3>
                <p className="text-[15px] text-white/80 leading-relaxed">
                  The Video Generator will produce complete videos by combining your script, images, and audio with professional effects. 
                  This all-in-one solution handles story generation, image creation, audio synthesis, and video compilation automatically. 
                  Perfect for creating YouTube videos up to 20 hours long with images or a looped video. 
                </p>
                <Link to="/learn#video-generator">
                  <button
                    className="group relative inline-flex items-center gap-1.5 px-5 py-2.5 mt-3 rounded-xl text-sm font-medium text-white bg-accent transition-all duration-300 hover:bg-accent-hover hover:scale-[1.02] active:scale-[0.98]"
                    style={{
                      boxShadow: '0 0 20px rgba(220,38,38,0.2), 0 0 40px rgba(220,38,38,0.06)',
                    }}
                  >
                    <BookOpen className="h-3.5 w-3.5" />
                    Watch tutorial
                  </button>
                </Link>
              </div>

              {/* Tab Manager */}
              {isEnterpriseUser && (
                <TabManager
                  userId={userId}
                  isEnterpriseUser={isEnterpriseUser}
                  initialTabs={initialTabs}
                  currentTab={currentTab}
                  page="video"
                  activeTabStatus={generationState !== 'idle' && generationState !== 'complete' && generationState !== 'error' ? 'generating' : undefined}
                  onTabChange={onTabChange}
                  onTabCreate={onTabCreate}
                  onTabClose={onTabClose}
                />
              )}

              {/* Mode Toggle: Quick Generate vs Detailed Settings */}
              <div
                className="dash-collapse-grid"
                data-collapsed={generationState !== 'idle' ? 'true' : 'false'}
              >
                <div>
                <div className="mt-6 mb-2 dash-animate-in">
                  <h2 className="text-xl font-semibold text-white mb-4">Mode</h2>
                  <div className="grid grid-cols-2 gap-4">
                    <button
                      onClick={() => setVideoGenMode('quick')}
                      className={`p-4 rounded-xl border-2 transition-all text-left ${
                        videoGenMode === 'quick'
                          ? 'border-red-800/70 bg-red-900/30'
                          : 'border-border-card bg-surface-card hover:border-white/20'
                      }`}
                    >
                      <div className="font-medium text-white text-sm sm:text-base">Quick Generate</div>
                      <div className="text-xs sm:text-sm text-text-muted mt-1">
                        Describe your video and AI plans everything
                      </div>
                    </button>
                    <button
                      onClick={() => setVideoGenMode('detailed')}
                      className={`p-4 rounded-xl border-2 transition-all text-left ${
                        videoGenMode === 'detailed'
                          ? 'border-red-800/70 bg-red-900/30'
                          : 'border-border-card bg-surface-card hover:border-white/20'
                      }`}
                    >
                      <div className="font-medium text-white text-sm sm:text-base">Detailed Settings</div>
                      <div className="text-xs sm:text-sm text-text-muted mt-1">
                        Full control over every video setting
                      </div>
                    </button>
                  </div>
                </div>
              </div>
              </div>
            </div>

            {displayError && (
              <div className="bg-status-error text-status-error p-4 rounded-xl mb-6">
                <div className="flex items-center space-x-2 text-status-error mb-2">
                  <AlertCircle className="h-5 w-5" />
                  <h3 className="text-base sm:text-lg font-medium">Error</h3>
                </div>
                <p className="text-sm sm:text-base">{displayError}</p>
                <button
                  onClick={() => setError(null)}
                  className="mt-2 px-3 py-1 bg-accent text-white rounded-xl hover:bg-accent-hover text-sm sm:text-base"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Blue info box when generating */}
            {generationState === 'generating' && (
              <div className="mt-8 p-5 rounded-2xl bg-[--color-status-info-bg] border border-[--color-status-info-border] mb-6 dash-animate-info-reveal">
                <div className="flex items-center space-x-3">
                  <div className="flex-shrink-0 h-10 w-10 rounded-full bg-[--color-status-info-bg] flex items-center justify-center">
                    <RefreshCw className="h-5 w-5 text-status-info animate-spin" />
                  </div>
                  <div>
                    <h3 className="text-lg font-display font-semibold text-status-info">
                      {(() => {
                        const title = (videoTasks.find(t => t.is_main) || videoTasks.find(t => !t.doc_id) || videoTasks[0])?.story_title || settings.storyTitle;
                        return title || 'Your video';
                      })()}
                    </h3>
                    <p className="text-sm mt-0.5" style={{ color: 'rgba(96, 165, 250, 0.7)' }}>
                      {analysisResult?.estimatedVideoTimeMinutes
                        ? `${formatTime(analysisResult.estimatedVideoTimeMinutes)} estimated`
                        : 'Generating...'
                      }
                      {analysisResult?.settings?.numImages
                        ? ` · ${analysisResult.settings.numImages} ${settings.visualType === 'image' ? 'images' : 'clips'}`
                        : ''
                      }
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Settings Locked - only show in analyzed state (user needs to see Step 5) */}
            {generationState === 'analyzed' && (
              <div className="bg-status-info text-status-info p-4 rounded-xl mb-6">
                <div className="flex items-center space-x-2 text-status-info mb-2">
                  <Lock className="h-4 w-4" />
                  <h3 className="text-base sm:text-lg font-medium">Settings Locked</h3>
                </div>
                <p className="text-sm sm:text-base">Settings are locked during analysis. Review results in Analysis & Output below, then click Generate or Done to unlock.</p>
              </div>
            )}

            {/* Show configuration steps only if not complete */}
            {generationState !== 'complete' && (
              <div className="space-y-6 dash-stagger">

                {/* ── Quick Generate Mode ── */}
                {videoGenMode === 'quick' && (
                  <div
                    className="dash-collapse-grid"
                    data-collapsed={generationState !== 'idle' ? 'true' : 'false'}
                  >
                  <div>
                  <div className="mt-4 dash-animate-in">
                    {/* Prompt Area — prominent with animated border */}
                    <div className="mb-16">
                      <label className="text-xs font-mono tracking-[0.15em] text-text-label uppercase mb-1.5 block">
                        Video Prompt
                      </label>
                      <p className="text-xs text-text-dim mb-3 leading-relaxed">
                        Describe the video you want to create in a single prompt — topic, style, tone, anything. AI will handle the rest and deliver a complete video.
                      </p>
                      <div className="quick-prompt-border rounded-2xl">
                        <textarea
                          value={quickPrompt}
                          onChange={(e) => {
                            if (e.target.value.length <= 5000) setQuickPrompt(e.target.value);
                          }}
                          placeholder="e.g. A dark horror story about a haunted lighthouse in 1920s New England, narrated like a true crime documentary..."
                          rows={10}
                          className="w-full px-5 py-4 bg-surface-input border-0 rounded-2xl text-white/95 placeholder-white/50 focus:outline-none resize-none text-sm leading-relaxed"
                        />
                      </div>
                      {quickPrompt.length >= 5000 && (
                        <p className="text-xs text-status-warning mt-2">Character limit reached (5,000 / 5,000)</p>
                      )}
                    </div>

                    {/* Settings Row — smaller, secondary to prompt */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                      {/* Duration */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase">
                            {quickIsRuntimeMode ? 'Runtime (min)' : 'Words'}
                          </label>
                          <div className="flex items-center gap-1.5">
                            <span className={`text-[10px] ${!quickIsRuntimeMode ? 'text-accent-text font-medium' : 'text-text-dim'}`}>
                              W
                            </span>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={quickIsRuntimeMode}
                              aria-label="Toggle between runtime and word count mode"
                              onClick={() => {
                                const newMode = !quickIsRuntimeMode;
                                setQuickIsRuntimeMode(newMode);
                                if (newMode) {
                                  const wc = parseInt(quickWordCount) || 1250;
                                  setQuickRuntimeMinutes(wordCountToMinutes(wc).toString());
                                } else {
                                  const mins = parseFloat(quickRuntimeMinutes) || 10;
                                  setQuickWordCount(minutesToWordCount(mins).toString());
                                }
                              }}
                              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                                quickIsRuntimeMode ? 'bg-accent' : 'bg-border'
                              }`}
                            >
                              <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                                quickIsRuntimeMode ? 'translate-x-[14px]' : 'translate-x-[2px]'
                              }`} />
                            </button>
                            <span className={`text-[10px] ${quickIsRuntimeMode ? 'text-accent-text font-medium' : 'text-text-dim'}`}>
                              Min
                            </span>
                          </div>
                        </div>
                        {quickIsRuntimeMode ? (
                          <>
                            <input
                              type="text"
                              value={quickRuntimeMinutes}
                              onChange={(e) => {
                                setQuickRuntimeMinutes(e.target.value);
                                setQuickDurationWarning(null);
                                const val = parseFloat(e.target.value);
                                if (e.target.value.trim() && !isValidNumericInput(e.target.value)) {
                                  setQuickDurationWarning('Please enter a valid number');
                                } else if (val) {
                                  const words = minutesToWordCount(val);
                                  if (words < 200) {
                                    setQuickDurationWarning('Word count must be at least 200.');
                                  } else if (words > 150000) {
                                    setQuickDurationWarning('Word count cannot exceed 150,000.');
                                  }
                                }
                              }}
                              placeholder="10"
                              className={`w-full px-3 py-2.5 bg-surface-input border rounded-xl text-white/95 placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 text-sm ${
                                quickDurationWarning || quickValidation.message ? 'border-[var(--color-status-warning-muted)]' : 'border-white/[0.13]'
                              }`}
                            />
                            <p className="text-[10px] text-text-dim mt-1">
                              200–150,000 words (~{minutesToWordCount(parseFloat(quickRuntimeMinutes) || 0).toLocaleString()} words)
                            </p>
                          </>
                        ) : (
                          <>
                            <input
                              type="text"
                              value={quickWordCount}
                              onChange={(e) => {
                                setQuickWordCount(e.target.value);
                                setQuickDurationWarning(null);
                                const val = parseInt(e.target.value);
                                if (e.target.value.trim() && !isValidNumericInput(e.target.value)) {
                                  setQuickDurationWarning('Please enter a valid number');
                                } else if (val) {
                                  const rtMins = Math.round(val / WORDS_PER_MINUTE_AUDIO * 10) / 10;
                                  setQuickRuntimeMinutes(rtMins.toString());
                                  if (val < 200) setQuickDurationWarning('Word count must be at least 200.');
                                  if (val > 150000) setQuickDurationWarning('Word count cannot exceed 150,000.');
                                }
                              }}
                              placeholder="1250"
                              className={`w-full px-3 py-2.5 bg-surface-input border rounded-xl text-white/95 placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 text-sm ${
                                quickDurationWarning || quickValidation.message ? 'border-[var(--color-status-warning-muted)]' : 'border-white/[0.13]'
                              }`}
                            />
                            <p className="text-[10px] text-text-dim mt-1">
                              200–150,000 words (~{wordCountToMinutes(parseInt(quickWordCount) || 0)} min)
                            </p>
                          </>
                        )}
                        {quickDurationWarning && (
                          <div className="bg-status-warning text-status-warning-text p-2.5 rounded-xl mt-2 text-[10px] flex items-start gap-1.5">
                            <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0 text-status-warning" />
                            <span>{quickDurationWarning}</span>
                          </div>
                        )}
                      </div>

                      {/* Language */}
                      <div>
                        <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                          Language
                        </label>
                        <Listbox
                          value={quickLanguage}
                          onChange={(value) => setQuickLanguage(value)}
                        >
                          {({ open }) => (
                            <div className="relative">
                              <Listbox.Button className="relative w-full rounded-xl bg-surface-input border border-white/[0.13] px-3 py-2.5 text-left text-white/95 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 text-sm cursor-pointer">
                                <span className="block truncate">
                                  {languageOptions.find(opt => opt.value === quickLanguage)?.label || 'English'}
                                </span>
                                <span className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                                  <ChevronDown className={`h-3.5 w-3.5 text-text-dim transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                                </span>
                              </Listbox.Button>
                              <Transition
                                show={open}
                                enter="transition ease-out duration-100"
                                enterFrom="transform opacity-0 scale-95"
                                enterTo="transform opacity-100 scale-100"
                                leave="transition ease-in duration-75"
                                leaveFrom="transform opacity-100 scale-100"
                                leaveTo="transform opacity-0 scale-95"
                              >
                                <Listbox.Options className="absolute z-50 mt-1 w-full bg-surface-dropdown border border-white/[0.08] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                                  {languageOptions.map((opt) => (
                                    <Listbox.Option
                                      key={opt.value}
                                      value={opt.value}
                                      className={({ active, selected }) =>
                                        `cursor-pointer select-none py-2.5 px-3 text-sm ${active ? 'bg-white/[0.08] text-white' : 'text-text-muted'} ${selected ? 'font-medium' : 'font-normal'}`
                                      }
                                    >
                                      {({ selected }) => (
                                        <div className="flex justify-between items-center">
                                          <span className={selected ? 'font-medium' : 'font-normal'}>{opt.label}</span>
                                          {selected && <CheckCircle2 className="h-3.5 w-3.5 text-accent-text" />}
                                        </div>
                                      )}
                                    </Listbox.Option>
                                  ))}
                                </Listbox.Options>
                              </Transition>
                            </div>
                          )}
                        </Listbox>
                      </div>

                      {/* Budget */}
                      <div>
                        <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                          Budget (K tokens)
                        </label>
                        <input
                          type="text"
                          value={quickTokenBudget}
                          onChange={(e) => {
                            setQuickTokenBudget(e.target.value);
                            setQuickBudgetWarning(null);
                            if (e.target.value.trim() && !isValidNumericInput(e.target.value)) {
                              setQuickBudgetWarning('Please enter a valid number');
                            }
                          }}
                          placeholder={(userTokenBalance / 1000).toFixed(0)}
                          className={`w-full px-3 py-2.5 bg-surface-input border rounded-xl text-white/95 placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 text-sm ${
                            quickBudgetWarning || quickValidation.message ? 'border-[var(--color-status-warning-muted)]' : 'border-white/[0.13]'
                          }`}
                        />
                        <p className="text-[10px] text-text-dim mt-1">{formatNumber(userTokenBalance)} available</p>
                        {/* Budget preset buttons */}
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {[
                            { label: '2M', value: 2000 },
                            { label: '10M', value: 10000 },
                            { label: '50M', value: 50000 },
                            { label: '80M', value: 80000 },
                          ].map((preset) => (
                            <button
                              key={preset.label}
                              onClick={() => {
                                setQuickTokenBudget(preset.value.toString());
                                setQuickBudgetWarning(null);
                              }}
                              className={`px-2 py-0.5 rounded-lg text-[10px] font-medium transition-all ${
                                quickTokenBudget === preset.value.toString()
                                  ? 'bg-red-900/40 text-accent-text border border-red-800/50'
                                  : 'bg-surface-elevated text-text-dim border border-white/[0.08] hover:border-white/20 hover:text-white/80'
                              }`}
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                        {quickBudgetWarning && (
                          <div className="bg-status-warning text-status-warning-text p-2.5 rounded-xl mt-2 text-[10px] flex items-start gap-1.5">
                            <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0 text-status-warning" />
                            <span>{quickBudgetWarning}</span>
                          </div>
                        )}
                      </div>

                      {/* Visual Type */}
                      <div>
                        <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                          Visual Type
                        </label>
                        <Listbox
                          value={quickVisualType}
                          onChange={(value: 'default' | 'image' | 'ttv' | 'itv' | 'mg') => {
                            setQuickVisualType(value);
                          }}
                        >
                          {({ open }) => (
                            <div className="relative">
                              <Listbox.Button className="relative w-full rounded-xl bg-surface-input border border-white/[0.13] px-3 py-2.5 text-left text-white/95 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 text-sm cursor-pointer">
                                <span className="block truncate">
                                  {visualTypeOptions.find(opt => opt.value === quickVisualType)?.label || 'Default'}
                                </span>
                                <span className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                                  <ChevronDown className={`h-3.5 w-3.5 text-text-dim transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                                </span>
                              </Listbox.Button>
                              <Transition
                                show={open}
                                enter="transition ease-out duration-100"
                                enterFrom="transform opacity-0 scale-95"
                                enterTo="transform opacity-100 scale-100"
                                leave="transition ease-in duration-75"
                                leaveFrom="transform opacity-100 scale-100"
                                leaveTo="transform opacity-0 scale-95"
                              >
                                <Listbox.Options className="absolute z-50 mt-1 w-full bg-surface-dropdown border border-white/[0.08] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                                  {visualTypeOptions.map((opt) => (
                                    <Listbox.Option
                                      key={opt.value}
                                      value={opt.value}
                                      className={({ active, selected }) =>
                                        `cursor-pointer select-none py-2.5 px-3 text-sm ${active ? 'bg-white/[0.08] text-white' : 'text-text-muted'} ${selected ? 'font-medium' : 'font-normal'}`
                                      }
                                    >
                                      {({ selected }) => (
                                        <div className="flex justify-between items-center">
                                          <span className={selected ? 'font-medium' : 'font-normal'}>{opt.label}</span>
                                          {selected && <CheckCircle2 className="h-3.5 w-3.5 text-accent-text" />}
                                        </div>
                                      )}
                                    </Listbox.Option>
                                  ))}
                                </Listbox.Options>
                              </Transition>
                            </div>
                          )}
                        </Listbox>
                        <p className="text-[10px] text-text-dim mt-1">
                          {quickVisualType === 'default'
                            ? 'AI picks best type for your budget'
                            : quickVisualType === 'ttv'
                            ? 'AI video clips from text'
                            : quickVisualType === 'itv'
                            ? 'AI images animated to video'
                            : 'Images with pan/zoom effects'}
                        </p>
                      </div>
                    </div>

                    {/* Unified validation warning (visual type + runtime + budget + balance) */}
                    {quickValidation.message && (
                      <div
                        className={`p-3 rounded-xl mb-4 text-xs flex items-start gap-2 ${
                          quickValidation.severity === 'error'
                            ? 'bg-status-error text-status-error'
                            : 'bg-status-warning text-status-warning-text'
                        }`}
                      >
                        <AlertCircle
                          className={`h-3.5 w-3.5 mt-0.5 flex-shrink-0 ${
                            quickValidation.severity === 'error' ? 'text-status-error' : 'text-status-warning'
                          }`}
                        />
                        <span>{quickValidation.message}</span>
                      </div>
                    )}

                    {/* YouTube Inspiration Section */}
                    <div className="mb-5 p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                          <h3 className="text-white font-medium text-sm">YouTube Inspiration</h3>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={youtubeInspirationEnabled}
                          aria-label="Toggle YouTube inspiration"
                          onClick={() => {
                            const newValue = !youtubeInspirationEnabled;
                            setYoutubeInspirationEnabled(newValue);
                            if (!newValue) {
                              setYoutubeLinks(['']);
                              setYoutubeLinkErrors({});
                            }
                          }}
                          disabled={generationState !== 'idle'}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                            youtubeInspirationEnabled ? 'bg-accent' : 'bg-border'
                          } ${generationState !== 'idle' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                              youtubeInspirationEnabled ? 'translate-x-6' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      </div>
                      <p className="text-text-muted text-xs mt-2">
                        Add a YouTube video link as creative inspiration. The transcript will be extracted and used to shape the story's tone, themes, and narrative style.
                      </p>
                      <div
                        className="grid transition-[grid-template-rows] duration-300 ease-out"
                        style={{ gridTemplateRows: youtubeInspirationEnabled ? '1fr' : '0fr' }}
                      >
                        <div className="overflow-hidden -mx-1 px-1">
                          <div className="pt-4 pb-1 space-y-3">
                            <div className="dash-info-box p-2.5 flex gap-2">
                              <Info className="w-4 h-4 dash-box-icon flex-shrink-0 mt-0.5" />
                              <p className="text-xs dash-box-text">Only the first 20 minutes of a video are used as context.</p>
                            </div>
                            {youtubeLinks.map((link, index) => {
                              const videoId = link.trim() ? extractYoutubeVideoId(link.trim()) : null;
                              const hasError = !!youtubeLinkErrors[index];
                              const showThumbnail = videoId && !hasError;
                              return (
                              <div key={index}>
                                <div className="flex items-center gap-2 min-w-0">
                                  <div className="min-w-0 flex-1">
                                    <input
                                      type="url"
                                      value={link}
                                      onChange={(e) => {
                                        const newLinks = [...youtubeLinks];
                                        newLinks[index] = e.target.value;
                                        setYoutubeLinks(newLinks);
                                        const error = validateYoutubeUrl(e.target.value);
                                        setYoutubeLinkErrors(prev => {
                                          const next = { ...prev };
                                          if (error) next[index] = error;
                                          else delete next[index];
                                          return next;
                                        });
                                      }}
                                      placeholder={`YouTube video URL${youtubeLinks.length > 1 ? ` #${index + 1}` : ''}`}
                                      disabled={generationState !== 'idle'}
                                      className={`w-full rounded-xl bg-surface-input border ${
                                        hasError ? 'border-status-warning' : 'border-white/[0.13]'
                                      } px-4 py-3 text-white/95 text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 ${
                                        generationState !== 'idle' ? 'opacity-50 cursor-not-allowed' : ''
                                      }`}
                                    />
                                  </div>
                                  {youtubeLinks.length > 1 && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const newLinks = youtubeLinks.filter((_, i) => i !== index);
                                        setYoutubeLinks(newLinks);
                                        setYoutubeLinkErrors(prev => {
                                          const next: Record<number, string> = {};
                                          Object.entries(prev).forEach(([k, v]) => {
                                            const ki = parseInt(k);
                                            if (ki < index) next[ki] = v;
                                            else if (ki > index) next[ki - 1] = v;
                                          });
                                          return next;
                                        });
                                      }}
                                      disabled={generationState !== 'idle'}
                                      className="p-2 rounded-lg text-text-muted hover:text-red-400 hover:bg-white/[0.05] transition-colors duration-200 flex-shrink-0"
                                      aria-label={`Remove video ${index + 1}`}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </button>
                                  )}
                                </div>
                                {hasError && (
                                  <div className="flex items-center gap-1.5 mt-1.5 ml-1">
                                    <AlertTriangle className="h-3.5 w-3.5 text-status-warning flex-shrink-0" />
                                    <p className="text-status-warning text-xs">{youtubeLinkErrors[index]}</p>
                                  </div>
                                )}
                                {showThumbnail && (
                                  <div className="mt-2 rounded-lg overflow-hidden border border-white/[0.08] w-fit">
                                    <img
                                      src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
                                      alt="Video thumbnail"
                                      className="block w-48 h-auto rounded-lg"
                                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                    />
                                  </div>
                                )}
                              </div>
                              );
                            })}

                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Info Box — contextual based on visual type */}
                    <div className="mb-5 p-3.5 rounded-xl bg-surface-elevated border border-white/[0.08]">
                      <div className="flex items-start gap-2.5">
                        <Info className="h-4 w-4 text-text-dim mt-0.5 flex-shrink-0" />
                        <div className="text-xs text-text-dim leading-relaxed">
                          {quickVisualType === 'default' ? (
                            <>
                              <p className="mb-1.5"><span className="text-white/80 font-medium">Higher budget</span> — AI uses text-to-video models for cinematic, high-quality clips.</p>
                              <p><span className="text-white/80 font-medium">Lower budget</span> — AI uses image generation with pan/zoom effects for faster, cost-effective results.</p>
                            </>
                          ) : quickVisualType === 'ttv' ? (
                            <>
                              <p className="mb-1.5"><span className="text-white/80 font-medium">Text-to-Video</span> — Generates full video clips from text descriptions. Highest quality but most expensive.</p>
                              <p>AI will select the best model it can afford within your budget, prioritizing quality.</p>
                            </>
                          ) : quickVisualType === 'itv' ? (
                            <>
                              <p className="mb-1.5"><span className="text-white/80 font-medium">Image-to-Video</span> — First generates keyframe images, then animates them into video clips.</p>
                              <p>Mid-range option between full video generation and static images.</p>
                            </>
                          ) : (
                            <>
                              <p><span className="text-white/80 font-medium">Image Generation</span> — AI-generated images with pan/zoom effects. Most cost-effective option.</p>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Quick Error */}
                    {quickError && (
                      <div className="bg-status-error text-status-error p-3 rounded-xl mb-4 text-sm flex items-start gap-2">
                        <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <span>{quickError}</span>
                      </div>
                    )}

                    {/* Generate Button */}
                    <button
                      onClick={handleQuickGenerate}
                      disabled={quickGenerating || !quickPrompt.trim() || !quickRuntimeMinutes || !quickTokenBudget || !!quickValidation.message || !!quickDurationWarning || !!quickBudgetWarning}
                      className="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-accent text-white rounded-xl hover:bg-accent-hover transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
                      style={{
                        boxShadow: '0 0 20px rgba(220,38,38,0.25), 0 0 40px rgba(220,38,38,0.08)',
                      }}
                    >
                      {quickGenerating ? (
                        <>
                          <RefreshCw className="animate-spin h-4 w-4" />
                          AI is planning your video...
                        </>
                      ) : (
                        <>
                          <Video className="h-4 w-4" />
                          Generate Video
                        </>
                      )}
                    </button>
                  </div>
                  </div>
                  </div>
                )}

                {/* ── Detailed Settings Mode ── */}
                {(videoGenMode === 'detailed' || generationState !== 'idle') && (
                <>
                {/* Steps 1-3: Collapse when generating */}
                <div
                  className="dash-collapse-grid relative z-20"
                  data-collapsed={settingsCollapsed ? 'true' : 'false'}
                >
                  <div>
                {/* Configuration Steps Component */}
                <ConfigurationSteps
                  settings={settings}
                  setSettings={setSettings}
                  settingsLocked={settingsLocked}
                  collapsedSteps={collapsedSteps}
                  setCollapsedSteps={setCollapsedSteps}
                  documents={documents}
                  imageFolders={imageFolders}
                  audioFiles={audioFolders}
                  validationErrors={validationErrors}
                  wordCountError={wordCountError}
                  speedError={speedError}
                  volumeError={volumeError}
                  speedInput={speedInput}
                  setSpeedInput={setSpeedInput}
                  volumeInput={volumeInput}
                  setVolumeInput={setVolumeInput}
                  showMoreStyles={showMoreStyles}
                  setShowMoreStyles={setShowMoreStyles}
                  showMorePremiumVoices={showMorePremiumVoices}
                  setShowMorePremiumVoices={setShowMorePremiumVoices}
                  showMoreCoreVoices={showMoreCoreVoices}
                  setShowMoreCoreVoices={setShowMoreCoreVoices}
                  showMoreApexVoices={showMoreApexVoices}
                  setShowMoreApexVoices={setShowMoreApexVoices}
                  uploadingVideoLoop={uploadingVideoLoop}
                  playingVoice={playingVoice}
                  userPlan={userPlan}
                  currentStyles={[]} // Will be provided by ConfigurationSteps
                  premiumVoices={[]} // Will be provided by ConfigurationSteps
                  coreVoices={[]} // Will be provided by ConfigurationSteps
                  apexVoices={[]} // Will be provided by ConfigurationSteps
                  handleFileUpload={handleFileUpload}
                  handleVideoFileUpload={handleVideoFileUpload}
                  handleAudioFileUpload={handleAudioFileUpload}
                  handlePlayVoiceSample={handlePlayVoiceSample}
                  handleSpeedInputChange={handleSpeedInputChange}
                  handleVolumeInputChange={handleVolumeInputChange}
                  // NEW: Add existing audio volume handlers
                  existingAudioVolumeInput={existingAudioVolumeInput}
                  setExistingAudioVolumeInput={setExistingAudioVolumeInput}
                  existingAudioVolumeError={existingAudioVolumeError}
                  handleExistingAudioVolumeInputChange={handleExistingAudioVolumeInputChange}
                  validateExistingAudioVolume={validateExistingAudioVolume}
                  // NEW: Add background music volume handlers
                  backgroundMusicVolumeInput={backgroundMusicVolumeInput}
                  setBackgroundMusicVolumeInput={setBackgroundMusicVolumeInput}
                  backgroundMusicVolumeError={backgroundMusicVolumeError}
                  handleBackgroundMusicVolumeInputChange={handleBackgroundMusicVolumeInputChange}
                  validateBackgroundMusicVolume={validateBackgroundMusicVolume}
                  validateSpeed={validateSpeed}
                  validateVolume={validateVolume}
                  isCustomStyle={() => false} // Will be handled in ConfigurationSteps
                  formatDate={formatDate}
                  getImageFoldersForSelectedStory={getImageFoldersForSelectedStory}
                  getImagePromptDocsForSelectedStory={getImagePromptDocsForSelectedStory}
                  getAudioFilesForSelectedStory={getAudioFilesForSelectedStory}
                  isStepConfigured={isStepConfigured}
                  canCollapseStep={canCollapseStep}
                  toggleStepCollapse={toggleStepCollapse}
                  uploadedVideoLoopFile={uploadedVideoLoopFile}
                  setUploadedVideoLoopFile={setUploadedVideoLoopFile}
                  uploadedFile={uploadedFile}
                  setUploadedFile={setUploadedFile}
                  uploadedDocId={uploadedDocId}
                  uploadedAudioFile={uploadedAudioFile}
                  setUploadedAudioFile={setUploadedAudioFile}
                  uploadedAudioDocId={uploadedAudioDocId}
                  selectedApexLanguage={selectedApexLanguage}
                  setSelectedApexLanguage={setSelectedApexLanguage}
                  apexLanguages={[]} // Will be provided by ConfigurationSteps
                  getFilteredApexVoices={() => []} // Will be provided by ConfigurationSteps
                  isApexVoice={() => false} // Will be provided by ConfigurationSteps
                  // PASS VIDEO LOOP URL SETTER
                  setVideoLoopUrl={setVideoLoopUrl}
                  selectedCloneLanguage={''}
                  setSelectedCloneLanguage={() => {}}
                  languageOptions={languageOptions}
                  videoUploadProgress={videoUploadProgress}
                  audioUploadProgress={audioUploadProgress}
                  videoUploadStartTime={videoUploadStartTime}
                  audioUploadStartTime={audioUploadStartTime}
                  // ADD MODEL OPTIONS AND SELECTED MODEL
                  modelOptions={modelOptions}
                  selectedModel={selectedModel}
                  // NEW: Pass upload language props
                  uploadLanguage={uploadLanguage}
                  setUploadLanguage={setUploadLanguage}
                  // NEW: Voice samples and selector props
                  voiceSamples={voiceSamples}
                  voiceSelectorRef={voiceSelectorRef}
                  onCloneVoiceCreated={(voiceId: string, filePath: string) => {
                    setSessionCloneVoiceId(voiceId);
                    setSessionCloneVoiceFilePath(filePath);
                  }}
                  onVoiceSelect={(voice: string) => {
                    setSettings(prev => ({ ...prev, selectedVoice: voice }));
                  }}
                  elevenLabsSelectedLabel={elevenLabsVoice?.name ?? null}
                  elevenLabsCurrentVoiceId={elevenLabsVoice?.voice_id}
                  elevenLabsModelId={elevenLabsModelId}
                  onSelectElevenLabsVoice={(voice) => {
                    setElevenLabsVoice(voice);
                    if (voice.model_id) setElevenLabsModelId(voice.model_id);
                    setSettings(prev => ({ ...prev, selectedVoice: `elevenlabs:${voice.voice_id}` }));
                  }}
                  onElevenLabsModelChange={(id) => setElevenLabsModelId(id)}
                  currentUserId={currentUserId}
                  // NEW: Runtime mode and master prompt props
                  isRuntimeMode={isRuntimeMode}
                  setIsRuntimeMode={setIsRuntimeMode}
                  runtimeMinutes={runtimeMinutes}
                  setRuntimeMinutes={setRuntimeMinutes}
                  minutesToWordCount={minutesToWordCount}
                  wordCountToMinutes={wordCountToMinutes}
                  getMinuteLimitsForModel={getMinuteLimitsForModel}
                  masterPromptEnabled={masterPromptEnabled}
                  setMasterPromptEnabled={setMasterPromptEnabled}
                  masterPromptEnhanceAI={masterPromptEnhanceAI}
                  setMasterPromptEnhanceAI={setMasterPromptEnhanceAI}
                  masterPromptData={masterPromptData}
                  setMasterPromptData={setMasterPromptData}
                  pauseTTS={pauseTTS}
                  setPauseTTS={setPauseTTS}
                  // NEW: Audio duration calculation props
                  calculatedAudioDuration={calculatedAudioDuration}
                  setCalculatedAudioDuration={setCalculatedAudioDuration}
                  audioDurationLoading={audioDurationLoading}
                  audioDurationError={audioDurationError}
                  isCalculatingDuration={isCalculatingDuration}
                  handleCalculateAudioDuration={handleCalculateAudioDuration}
                  // NEW: Frequency configuration props
                  frequencyMode={frequencyMode}
                  setFrequencyMode={setFrequencyMode}
                  frequencyType={frequencyType}
                  setFrequencyType={setFrequencyType}
                  consistentFrequency={consistentFrequency}
                  setConsistentFrequency={setConsistentFrequency}
                  audioDistributionType={audioDistributionType}
                  setAudioDistributionType={setAudioDistributionType}
                  firstPageImageAmount={firstPageImageAmount}
                  setFirstPageImageAmount={setFirstPageImageAmount}
                  restImageAmount={restImageAmount}
                  setRestImageAmount={setRestImageAmount}
                  totalAudioDuration={totalAudioDuration}
                  setTotalAudioDuration={setTotalAudioDuration}
                  imageAmount={imageAmount}
                  setImageAmount={setImageAmount}
                  uploadedAudioFiles={uploadedAudioFiles}
                  setUploadedAudioFiles={setUploadedAudioFiles}
                  selectedStoryGroupId={selectedStoryGroupId}
                  setSelectedStoryGroupId={setSelectedStoryGroupId}
                  selectedStoryTitle={selectedStoryTitle}
                  setSelectedStoryTitle={setSelectedStoryTitle}
                  storySource={storySource}
                  setStorySource={setStorySource}
                  // NEW: Custom Characters props
                  customCharactersEnabled={customCharactersEnabled}
                  setCustomCharactersEnabled={setCustomCharactersEnabled}
                  customCharacters={customCharacters}
                  setCustomCharacters={setCustomCharacters}
                  customCharactersAIEnhance={customCharactersAIEnhance}
                  setCustomCharactersAIEnhance={setCustomCharactersAIEnhance}
                  // YouTube Inspiration props
                  youtubeInspirationEnabled={youtubeInspirationEnabled}
                  setYoutubeInspirationEnabled={setYoutubeInspirationEnabled}
                  youtubeLinks={youtubeLinks}
                  setYoutubeLinks={setYoutubeLinks}
                  youtubeLinkErrors={youtubeLinkErrors}
                  setYoutubeLinkErrors={setYoutubeLinkErrors}
                  validateYoutubeUrl={validateYoutubeUrl}
                  extractYoutubeVideoId={extractYoutubeVideoId}
                  // NEW: Visual Configuration props
                  visualType={settings.visualType}
                  onVisualTypeChange={(type: string) => setSettings(prev => ({ ...prev, visualType: type as any }))}
                  ttvModel={ttvModel}
                  ttvStyle={ttvStyle}
                  ttvDuration={ttvDuration}
                  ttvAudioClip={ttvAudioClip}
                  onTTVModelChange={setTTVModel}
                  onTTVStyleChange={setTTVStyle}
                  onTTVDurationChange={setTTVDuration}
                  onTTVAudioClipChange={setTTVAudioClip}
                  itvModel={itvModel}
                  itvDuration={itvDuration}
                  itvAudioClip={itvAudioClip}
                  onITVModelChange={setITVModel}
                  onITVDurationChange={setITVDuration}
                  onITVAudioClipChange={setITVAudioClip}
                  getTTVFoldersForSelectedStory={getTTVFoldersForSelectedStory}
                  getTTVPromptDocsForSelectedStory={getTTVPromptDocsForSelectedStory}
                  getITVVideoFoldersForSelectedStory={getITVVideoFoldersForSelectedStory}
                  getITVVideoPromptDocsForSelectedStory={getITVVideoPromptDocsForSelectedStory}
                  getITVImageFoldersForSelectedStory={getITVImageFoldersForSelectedStory}
                  getITVImagePromptDocsForSelectedStory={getITVImagePromptDocsForSelectedStory}
                  getMGPromptDocsForSelectedStory={getMGPromptDocsForSelectedStory}
                  getMGVideoFoldersForSelectedStory={getMGVideoFoldersForSelectedStory}
                  userTokenBalance={userTokenBalance}
                  storageUsed={storageUsed}
                  maxStorageGB={maxStorageGB}
                />
                  </div>
                </div>

                {/* Video Configuration Component - Steps 4 & 5 */}
                <VideoConfiguration
                  settings={settings}
                  setSettings={setSettings}
                  settingsLocked={settingsLocked}
                  settingsCollapsed={settingsCollapsed}
                  analysisResult={analysisResult}
                  setAnalysisResult={setAnalysisResult}
                  analyzing={analyzing}
                  setAnalyzing={setAnalyzing}
                  uploadedFile={uploadedFile}
                  generationState={generationState}
                  setGenerationState={setGenerationState}
                  generationLoading={generationLoading} // NEW: Pass generation loading state
                  setGenerationLoading={setGenerationLoading} // NEW: Pass setter
                  // Cap displayed progress at 90% during generation; only show 100% on the
                  // completed page so the bar never lies that work is done early.
                  progress={generationState === 'complete' ? 100 : Math.min(progress, 90)}
                  setProgress={setProgress}
                  statusMessage={statusMessage}
                  backgroundMusicUrl={backgroundMusicUrl}
                  setBackgroundMusicUrl={setBackgroundMusicUrl}
                  setStatusMessage={setStatusMessage}
                  timeRemaining={timeRemaining}
                  setTimeRemaining={setTimeRemaining}
                  batchStatuses={batchStatuses}
                  setBatchStatuses={setBatchStatuses}
                  currentUserId={currentUserId}
                  currentGroupId={currentGroupId}
                  setCurrentGroupId={setCurrentGroupId}
                  userTokenBalance={userTokenBalance}
                  userPlan={userPlan}
                  storageUsed={storageUsed}
                  documents={documents}
                  imageFolders={imageFolders}
                  audioFiles={audioFolders}
                  error={error}
                  setError={setError}
                  finalVideoUrl={finalVideoUrl}
                  setFinalVideoUrl={setFinalVideoUrl}
                  downloadLoading={downloadLoading}
                  setDownloadLoading={setDownloadLoading}
                  downloadProgress={downloadProgress}
                  setDownloadProgress={setDownloadProgress}
                  wordCountError={wordCountError}
                  validationErrors={validationErrors}
                  speedError={speedError}
                  volumeError={volumeError}
                  cloneFileUrl={''}
                  selectedCloneLanguage={''}
                  selectedTransition={selectedTransition}
                  setSelectedTransition={setSelectedTransition}
                  selectedAnimation={selectedAnimation}
                  setSelectedAnimation={setSelectedAnimation}
                  selectedEffect={selectedEffect}
                  setSelectedEffect={setSelectedEffect}
                  subtitlesEnabled={subtitlesEnabled}
                  setSubtitlesEnabled={setSubtitlesEnabled}
                  subtitleConfig={subtitleConfig}
                  setSubtitleConfig={setSubtitleConfig}
                  handleAnalyzeVideo={handleAnalyzeVideo}
                  handleGenerateVideo={handleGenerateVideo}
                  handleStopGeneration={handleStopGeneration}
                  handleDownloadVideo={handleDownloadVideo}
                  uploadedVideoLoopFile={uploadedVideoLoopFile}
                  handleDone={handleDone}
                  stopLoading={stopLoading}
                  videoTasks={videoTasks}
                  uploadedAudioFile={uploadedAudioFile}
                  uploadedAudioDocId={uploadedAudioDocId}
                  multiTabWarning={multiTabWarning}
                  currentTab={currentTab}
                  isEnterpriseUser={isEnterpriseUser}
                  notifyOnComplete={notifyOnComplete}
                  notifyLoading={notifyLoading}
                  onNotifyToggle={handleNotifyToggle}
                  // NEW: Voice selector props
                  voiceSelectorRef={voiceSelectorRef}
                  onCloneVoiceCreated={(voiceId, filePath) => {
                    setSessionCloneVoiceId(voiceId);
                    setSessionCloneVoiceFilePath(filePath);
                  }}
                  onVoiceSelect={(voice) => {
                    setSettings(prev => ({ ...prev, selectedVoice: voice }));
                    // Track session clone voice when selected
                    if (voice.includes('clone:') && voice !== settings.selectedVoice) {
                      const voiceName = voice.split(':')[1];
                      const predefinedVoice = predefinedCloneVoices.find(v => v.name === voiceName);
                      if (!predefinedVoice && sessionCloneVoiceId && sessionCloneVoiceId.endsWith(`__${voiceName}`)) {
                        console.log(`Selected session clone voice: ${voiceName}`);
                      }
                    }
                  }}
                />

                </>
                )}
              </div>
            )}

            {/* UPDATED: Completion Screen - now handles both video and non-video completion */}
            {generationState === 'complete' && (
              <div className="space-y-6">
                {/* Check video flag from database and render appropriate completion screen */}
                {videoTasks.length > 0 && videoTasks[0].settings?.video === false ? (
                  <ComponentsCompletionScreen
                    videoTasks={videoTasks}
                    settings={settings}
                    currentUserId={currentUserId}
                    currentGroupId={currentGroupId}
                    handleDone={handleDone}
                  />
                ) : (
                  <>
                    <div className="bg-status-success text-status-success p-4 rounded-xl">
                      <div className="flex items-center space-x-2 text-status-success mb-2">
                        <CheckCircle2 className="h-5 w-5" />
                        <h3 className="text-base sm:text-lg font-medium">Video Generation Complete!</h3>
                      </div>
                      <p className="text-sm sm:text-base">
                        Your video has been successfully generated and is ready for download.
                      </p>
                    </div>

                    <div className="bg-surface-card rounded-xl p-6">
                      <div className="flex items-center justify-between bg-surface-elevated rounded-xl p-4 mb-6">
                        <div className="flex items-center space-x-3">
                          <Video className="h-8 w-8 text-status-success" />
                          <div>
                            <h3 className="text-base sm:text-lg font-medium text-white">
                              {settings.storyTitle || 'Your Content'}
                            </h3>
                            <p className="text-xs sm:text-sm text-text-dim">
                              Final video ready for download
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* NEW: Video metadata display in completion screen - only show for video output */}
                      {uploadedVideoMetadata && (
                        <div className="bg-status-info text-status-info p-4 rounded-xl mb-6">
                          <h4 className="text-sm sm:text-base font-medium mb-2">Video Loop Details:</h4>
                          <div className="text-xs sm:text-sm space-y-1">
                            <div className="flex justify-between">
                              <span className="hidden sm:inline">Original Duration:</span>
                              <span className="sm:hidden">Duration:</span>
                              <span>{Math.round(uploadedVideoMetadata.duration)}s ({Math.floor(uploadedVideoMetadata.duration / 60)}m {Math.round(uploadedVideoMetadata.duration % 60)}s)</span>
                            </div>
                            <div className="flex justify-between">
                              <span>File Size:</span>
                              <span>{(uploadedVideoMetadata.size / (1024 * 1024)).toFixed(1)} MB</span>
                            </div>
                            <div className="flex justify-between">
                              <span>Resolution:</span>
                              <span>{uploadedVideoMetadata.width}x{uploadedVideoMetadata.height}</span>
                            </div>
                            {uploadedVideoMetadata.bitrate && (
                              <div className="flex justify-between">
                                <span>Bitrate:</span>
                                <span>{Math.round(uploadedVideoMetadata.bitrate / 1000)} kbps</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Video Preview Section */}
                      {(currentUserId && currentGroupId) && (
                        <div className="bg-surface-elevated rounded-xl p-4 mb-6">
                          {!showVideoPreview ? (
                            <div className="text-center">
                              <div className="flex items-center justify-center w-16 h-16 bg-surface-elevated rounded-full mx-auto mb-4">
                                <Play className="h-8 w-8 text-white" />
                              </div>
                              <h4 className="text-base sm:text-lg font-medium text-white mb-2">Video Preview</h4>
                              <p className="text-xs sm:text-sm text-text-dim mb-4">
                                Load a preview of your generated video. This will use bandwidth to stream the video.
                              </p>
                              <button
                                onClick={handleLoadPreview}
                                disabled={loadingVideoUrl}
                                className="flex items-center px-4 py-2 bg-action-info text-white rounded-xl hover:bg-action-info-hover transition-colors mx-auto disabled:opacity-50 text-sm sm:text-base"
                              >
                                {loadingVideoUrl ? (
                                  <>
                                    <RefreshCw className="animate-spin h-5 w-5 mr-2" />
                                    Loading...
                                  </>
                                ) : (
                                  <>
                                    <Eye className="h-5 w-5 mr-2" />
                                    <span className="hidden sm:inline">Load Preview</span>
                                    <span className="sm:hidden">Preview</span>
                                  </>
                                )}
                              </button>
                            </div>
                          ) : (
                            <div>
                              <div className="flex items-center justify-between mb-3">
                                <h4 className="text-base sm:text-lg font-medium text-white">Video Preview</h4>
                                <button
                                  onClick={() => setShowVideoPreview(false)}
                                  className="p-1 text-text-dim hover:text-white transition-colors"
                                >
                                  <X className="h-5 w-5" />
                                </button>
                              </div>
                              {videoLoadError ? (
                                <div className="bg-status-error text-status-error p-3 rounded-xl">
                                  <div className="flex items-center gap-2">
                                    <AlertCircle className="h-5 w-5 text-status-error" />
                                    <p className="text-xs sm:text-sm">{videoLoadError}</p>
                                  </div>
                                </div>
                              ) : videoUrl ? (
                                <video 
                                  controls 
                                  preload="metadata"
                                  src={videoUrl} 
                                  className="w-full rounded-xl aspect-video max-w-4xl mx-auto"
                                  onError={handleVideoLoadError}
                                >
                                  Your browser does not support video playback.
                                </video>
                              ) : (
                                <div className="bg-surface-elevated rounded-xl p-4 text-center">
                                  <p className="text-xs sm:text-sm text-text-dim">No video available for preview</p>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="flex space-x-4">
                        <button
                          onClick={handleDownloadVideo}
                          disabled={downloadLoading || !currentGroupId || !currentUserId}
                          className="flex items-center px-6 py-3 bg-action-success text-white rounded-xl hover:bg-action-success-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm sm:text-base"
                        >
                          {downloadLoading ? (
                            <>
                              {/* NEW: Show progress bar for large videos (2GB+) */}
                              {currentGroupId && downloadProgress[currentGroupId] > 0 ? (
                                <div className="flex items-center">
                                  <div className="w-24 bg-surface-elevated rounded-full h-2 mr-2">
                                    <div 
                                      className="bg-status-info-muted h-2 rounded-full transition-all duration-300" 
                                      style={{width: `${downloadProgress[currentGroupId] || 0}%`}}
                                    ></div>
                                  </div>
                                  <span className="text-xs">{downloadProgress[currentGroupId] || 0}%</span>
                                </div>
                              ) : (
                                <>
                                  <RefreshCw className="animate-spin h-5 w-5 mr-2" />
                                  <span className="hidden sm:inline">Downloading...</span>
                                  <span className="sm:hidden">Loading...</span>
                                </>
                              )}
                            </>
                          ) : (
                            <>
                              <Download className="h-5 w-5 mr-2" />
                              <span className="hidden sm:inline">Download Video</span>
                              <span className="sm:hidden">Download</span>
                            </>
                          )}
                        </button>
                        
                        <button
                          onClick={handleDone}
                          className="flex items-center px-6 py-3 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors text-sm sm:text-base"
                        >
                          <CheckCircle2 className="h-5 w-5 mr-2" />
                          Done
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        .slider::-webkit-slider-thumb {
          appearance: none;
          height: 20px;
          width: 20px;
          border-radius: 50%;
          background: var(--color-accent);
          cursor: pointer;
          border: 2px solid #ffffff;
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.1);
        }
     
        .slider::-moz-range-thumb {
          height: 20px;
          width: 20px;
          border-radius: 50%;
          background: var(--color-accent);
          cursor: pointer;
          border: 2px solid #ffffff;
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.1);
        }
     
        .slider::-webkit-slider-track {
          height: 8px;
          background: linear-gradient(to right, var(--color-accent) 0%, var(--color-accent) var(--value, 0%), var(--color-border) var(--value, 0%), var(--color-border) 100%);
          border-radius: 4px;
        }
     
        .slider::-moz-range-track {
          height: 8px;
          background: var(--color-border);
          border-radius: 4px;
        }
     
        .slider::-moz-range-progress {
          height: 8px;
          background: var(--color-accent);
          border-radius: 4px;
        }
      `}</style>

      {/* Large file download info modal */}
      {largeVideoDownloadModal && (
        <LargeVideoDownloadModal
          fileName={largeVideoDownloadModal.fileName}
          fileSizeBytes={largeVideoDownloadModal.fileSizeBytes}
          signedUrl={largeVideoDownloadModal.signedUrl}
          onClose={() => setLargeVideoDownloadModal(null)}
        />
      )}
    </DashboardLayout>
  );
});

VideoGenerator.displayName = 'VideoGenerator';

export default VideoGenerator;

const formatTime = (minutes: number): string => {
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
};

// Helper function to sanitize title (matches edge function pattern)
const sanitizeTitle = (title: string) => {
  return title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
};



