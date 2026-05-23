import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { getIsLegacyPlan, llmMultiplier } from '../_shared/tokenCosts.ts';
import {
  estimateVideoPipelineSeconds,
  TOKEN_RATES_PER_MIN,
} from '../_shared/timeEstimates.ts';
import { elevenLabsTokensPerChar } from '../_shared/elevenlabs.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    const { error: dbError } = await supabase
      .from('error_logs')
      .insert({
        message,
        details: error.message || JSON.stringify(error),
        created_at: new Date().toISOString(),
      });
    if (dbError) console.error('Failed to log error to database:', dbError);
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

interface AnalyzeRequest {
  user_id: string;
  file_path?: string;
  doc_id?: string;
  content?: string;
  story_title?: string;
  description?: string;
  word_count?: number;
  image_style?: string;
  use_character_descriptions?: boolean;
  first_page_frequency?: number;
  rest_frequency?: number;
  // Frequency mode and type
  frequency_mode?: 'wordcount' | 'audio';
  frequency_type?: 'consistent' | 'variable';
  consistent_frequency?: number;
  // Audio-based frequency mode fields
  image_amount?: number;
  audio_distribution_type?: 'consistent' | 'variable';
  first_page_image_amount?: number;
  rest_image_amount?: number;
  voice?: string;
  model_version?: 'v7' | 'clone' | 'lemonfox' | 'speechify' | 'elevenlabs';
  elevenlabs_model_id?: string;
  audio_speed?: number;
  volume?: number; // NEW: Volume setting
  remove_title_chapters?: boolean;
  clone_voice_url?: string;
  clone_language?: string;
  // Asset usage flags
  use_existing_story?: boolean;
  use_existing_images?: boolean;
  use_existing_audio?: boolean;
  // Image source paths
  images_folder_path?: string;
  image_folder_path?: string; // Alternative naming
  num_images?: number; // For when image folder is selected
  // Audio source paths
  audio_file_path?: string;
  audio_folder_path?: string;
  // Video loop configuration
  video_loop?: string; // URL to video loop file
  loop_time?: number; // Duration in seconds (null means same as audio length)
  // NEW: Video loop metadata
  video_loop_metadata?: {
    duration: number; // actual duration in seconds
    size: number; // actual file size in bytes
    bitrate?: number;
    width?: number;
    height?: number;
  };
  // Background music
  background_music_url?: string;
  bg_music?: string; // Alternative naming
  // NEW: AI Models
  story_model?: string; // deepseek/sonnet/opus
  image_prompt_model?: string; // deepseek/sonnet/opus
  image_model?: 'flux-2-dev' | 'grok-imagine-image' | 'imagen-4-fast' | 'gpt-image-1-mini' | 'seedream-4.5' | 'imagen-4-ultra' | 'nano-banana-pro';
  // NEW: Transition type
  transition_type?: string | null;
  // NEW: subtitles flag (so token estimator includes subtitle burn cost)
  subtitles_enabled?: boolean;
  // NEW: Processing control flags
  video?: boolean; // Default TRUE - whether to create final video
  process_story?: boolean; // Default TRUE - whether to process story
  process_images?: boolean; // Default TRUE - whether to process images
  process_audio?: boolean; // Default TRUE - whether to process audio
  // Master prompt fields
  master_prompt?: any; // Master prompt data object
  master_prompt_enhance_ai?: boolean; // Whether to use AI enhancement for master prompt
  // Audio duration (optional)
  total_audio_duration?: number;
  // Visual pipeline type
  visual_type?: 'image' | 'ttv' | 'itv';
  video_model?: string; // TTV video model (grok, ltx, seedance, etc.)
  video_duration?: number; // TTV clip duration in seconds
  process_ttv?: boolean; // Whether TTV prompt + clip generation is needed
  ttv_folder_path?: string; // Path to existing TTV clip folder (for using pre-generated clips)
  itv_model?: string; // ITV video model
  itv_duration?: number; // ITV clip duration in seconds
  process_itv?: boolean; // Whether ITV prompt + image + clip generation is needed
  itv_video_folder_path?: string; // Path to existing ITV video clip folder
}

// NEW: Model multipliers for token calculation
const modelMultipliers: Record<string, number> = {
  deepseek: 1,
  sonnet: 10,
  opus: 48
};

const premiumVoices = [
  'Alex', 'Ashley', 'Craig', 'Deborah', 'Dennis', 'Edward', 'Elizabeth', 'Hades',
  'Julia', 'Pixie', 'Mark', 'Olivia', 'Priya', 'Ronald', 'Sarah', 'Shaun',
  'Theodore', 'Timothy', 'Wendy', 'Dominus', 'Yichen', 'Xiaoyin', 'Xinyi',
  'Jing', 'Erik', 'Katrien', 'Lennart', 'Lore', 'Alain', 'Helene', 'Mathieu',
  'Etienne', 'Johanna', 'Josef', 'Gianni', 'Orietta', 'Asuka', 'Satoshi',
  'Hyunwoo', 'Minji', 'Seojun', 'Yoona', 'Szymon', 'Wojciech', 'Heitor',
  'Maite', 'Diego', 'Lupita', 'Miguel', 'Rafael'
];

const cloneVoices = [
  'Angelo', 'Arthur', 'Chicot', 'Ranger', 'Hubert', 'Vincent', 'custom'
];

// Core Voices (Lemonfox model)
const coreVoices = [
  'heart', 'bella', 'michael', 'alloy', 'aoede', 'kore', 'jessica', 'nicole',
  'nova', 'river', 'sarah', 'sky', 'echo', 'eric', 'fenrir', 'liam', 'onyx',
  'puck', 'adam', 'santa', 'alice', 'emma', 'isabella', 'lily', 'daniel',
  'fable', 'george', 'lewis'
];

function calculateWordCount(content: string): number {
  return content.trim().split(/\s+/).filter(word => word.length > 0).length;
}

function calculateCharacterCount(content: string): number {
  return content.length;
}

function removeTitleAndChapters(content: string): string {
  // Remove title at the beginning (first line if it looks like a title)
  let lines = content.split('\n');
  
  // Remove first line if it's likely a title (short line, no periods, capitalized)
  if (lines.length > 0) {
    const firstLine = lines[0].trim();
    if (firstLine.length > 0 && firstLine.length < 100 && !firstLine.includes('.') && firstLine === firstLine.toUpperCase()) {
      lines = lines.slice(1);
    }
  }
  
  // Remove chapter headings (lines that start with "Chapter" or are all caps and short)
  lines = lines.filter(line => {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) return true; // Keep empty lines
    if (trimmedLine.length > 100) return true; // Keep long lines (likely not headings)
    
    // Remove lines that start with "Chapter"
    if (/^Chapter\s+/i.test(trimmedLine)) return false;
    
    // Remove lines that are all caps and relatively short (likely headings)
    if (trimmedLine === trimmedLine.toUpperCase() && trimmedLine.length < 50 && !/[.!?]/.test(trimmedLine)) {
      return false;
    }
    
    return true;
  });
  
  return lines.join('\n');
}

// UPDATED: Estimate image count using ImagePrompts.tsx logic
function estimateImageCount(wordCount: number, firstPageFreq: number, restFreq: number): number {
  if (!wordCount || wordCount <= 0) return 0;
  
  const totalChars = wordCount * 5; // Use 5 chars per word
  
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
  
  // Apply 18% increase as per ImagePrompts logic
  const finalCount = Math.round(totalPrompts * 1.18);
  
  console.log(`Image count calculation (ImagePrompts logic): wordCount=${wordCount}, firstPageFreq=${firstPageFreq}s, restFreq=${restFreq}s, totalChars=${totalChars}, firstPageSegments=${firstPageSegments}, restSegments=${restSegments}, beforeIncrease=${totalPrompts}, final=${finalCount}`);
  
  return finalCount;
}

// UPDATED: Story token estimation with AI model multiplier and master prompt overhead
function estimateStoryTokens(wordCount: number, model: string = 'sonnet', hasMasterPrompt: boolean = false, masterPromptEnhanceAI: boolean = false, isLegacy: boolean = true): number {
  // Story generation tokens (similar to Generator.tsx logic)
  const STORY_GENERATION_TOKENS_PER_WORD = 1.33;
  const MAX_WORDS_PER_BATCH = 600;
  const batchCount = Math.ceil(wordCount / MAX_WORDS_PER_BATCH);
  
  const systemPromptTokens = 300; // System prompt tokens per batch
  let inputTokens = 0;
  const avgWordsPerBatch = wordCount / batchCount;
  
  // For each batch, estimate input tokens
  for (let i = 0; i < batchCount; i++) {
    const previousContentWords = i * avgWordsPerBatch;
    const previousContentTokens = previousContentWords * STORY_GENERATION_TOKENS_PER_WORD;
    const batchInputTokens = systemPromptTokens + 200 + previousContentTokens; // System prompt + chapter outline + previous content
    inputTokens += batchInputTokens;
  }
  
  const outputTokens = wordCount * STORY_GENERATION_TOKENS_PER_WORD;
  let baseTokens = Math.round(inputTokens * 0.25 + outputTokens); // Unified token formula
  
  // Add master prompt overhead if AI enhancement is enabled
  if (hasMasterPrompt && masterPromptEnhanceAI) {
    baseTokens += 500; // Master prompt AI enhancement overhead
  }
  
  // Apply model multiplier (legacy vs new plan)
  const multiplier = llmMultiplier(isLegacy, model);
  const finalTokens = baseTokens * multiplier;
  
  console.log(`Story tokens: base=${baseTokens}, model=${model}, multiplier=${multiplier}x, hasMasterPrompt=${hasMasterPrompt}, masterPromptEnhanceAI=${masterPromptEnhanceAI}, final=${finalTokens}`);
  return finalTokens;
}

// UPDATED: Image prompt token estimation using ImagePrompts.tsx logic
function estimateImagePromptTokens(wordCount: number, useCharacterDescriptions: boolean, model: string = 'sonnet', firstPageFreq: number = 10, restFreq: number = 30, isLegacy: boolean = true): number {
  const totalChars = wordCount * 5; // Use 5 chars per word
  
  // First page calculation — freq 0 means skip first-page prompts
  let firstPageSegments = 0;
  if (firstPageFreq > 0) {
    const firstPageCharsPerSegment = Math.max(100, Math.min(3000, Math.round(firstPageFreq * 13.67))); // Use 13.67 CHARS_PER_SECOND
    firstPageSegments = Math.ceil(3000 / firstPageCharsPerSegment);
  }
  
  // Rest calculation — freq 0 means skip rest prompts
  let restSegments = 0;
  if (restFreq > 0) {
    const remainingChars = Math.max(0, totalChars - 3000);
    const restCharsPerSegment = Math.max(100, Math.round(restFreq * 13.67)); // Use 13.67 CHARS_PER_SECOND
    restSegments = remainingChars > 0 ? Math.ceil(remainingChars / restCharsPerSegment) : 0;
  }
  
  const numPrompts = Math.round((firstPageSegments + restSegments) * 1.18);
  if (numPrompts === 0) return 0;
  
  // Calculate batches and tokens like ImagePrompts.tsx
  const segmentsPerBatch = restFreq > 120 ? 1 : 2;
  const numBatches = Math.max(1, Math.ceil(numPrompts / segmentsPerBatch));
  
  const TOKEN_PER_WORD = 1.33;
  const inputSafetyMultiplier = 1.25;
  const outputSafetyMultiplier = 1;
  
  let totalInputTokens, totalOutputTokens;
  
  // Calculate input tokens
  totalInputTokens = wordCount * TOKEN_PER_WORD;
  totalInputTokens += numBatches * 500; // fixed input per batch
  
  // Calculate output tokens
  totalOutputTokens = numPrompts * 600 * TOKEN_PER_WORD; // 600 words per prompt
  
  if (useCharacterDescriptions) {
    // Character extraction
    const userChars = Math.min(10000, totalChars);
    const userWords = Math.round(userChars / 5.5);
    totalInputTokens += (128 + userWords) * TOKEN_PER_WORD;
    totalOutputTokens += 400;
  }
  
  // Apply safety multipliers
  totalInputTokens = Math.round(totalInputTokens * inputSafetyMultiplier);
  totalOutputTokens = Math.round(totalOutputTokens * outputSafetyMultiplier);
  
  // Calculate combined tokens using the formula: (input_tokens * 0.25 + output_tokens)
  const baseTokens = Math.round(totalInputTokens * 0.25 + totalOutputTokens);
  
  // Apply model multiplier (legacy vs new plan)
  const multiplier = llmMultiplier(isLegacy, model);
  const finalTokens = baseTokens * multiplier;
  
  console.log(`Image prompt tokens (ImagePrompts logic): base=${baseTokens}, model=${model}, multiplier=${multiplier}x, final=${finalTokens}, prompts=${numPrompts}, batches=${numBatches}, wordCount=${wordCount}, useCharacters=${useCharacterDescriptions}`);
  return finalTokens;
}

const IMAGE_MODEL_TOKENS: Record<string, number> = {
  'flux-2-dev': 7000,
  'grok-imagine-image': 16000,
  'imagen-4-fast': 14000,
  'gpt-image-1-mini': 30000,
  'seedream-4.5': 35000,
  'imagen-4-ultra': 42000,
  'nano-banana-pro': 100000,
};

// TTV video model token costs (tokens per second of generated video)
const TTV_MODEL_TOKENS: Record<string, number> = {
  'seedance_pro_fast': 13200,
  'ltx23_fast': 24000,
  'grok': 30000,
  'grok_highres': 42000,
  'seedance15_pro': 34800,
  'veo31fast': 60000,
  'ltx23_pro': 72000,
  'veo31': 120000,
  'sora2pro': 180000,
  'sora2pro_highres': 300000,
};
const TTV_DEFAULT_TOKENS_PER_SECOND = 30000; // grok default

const TTV_MODEL_DEFAULT_DURATIONS: Record<string, number> = {
  'seedance_pro_fast': 6, 'ltx23_fast': 6, 'grok': 5,
  'grok_highres': 5, 'seedance15_pro': 6, 'ltx23_pro': 6,
  'veo31fast': 4, 'veo31': 4, 'sora2pro': 4, 'sora2pro_highres': 4,
};

// ITV video model token costs (tokens per second of generated video)
const ITV_MODEL_TOKENS: Record<string, number> = {
  'wan22': 6000,
  'seedance1fast': 12960,
  'hailuo23fast': 19200,
  'seedance15': 34800,
  'ltx23fast': 48000,
  'veo31fast': 60000,
  'ltx23pro': 72000,
  'veo31': 120000,
  'ltx23pro4k': 144000,
};
const ITV_DEFAULT_TOKENS_PER_SECOND = 6000; // wan22 default

const ITV_MODEL_DEFAULT_DURATIONS: Record<string, number> = {
  'wan22': 5.06, 'seedance1fast': 5, 'hailuo23fast': 6, 'seedance15': 5,
  'ltx23fast': 6, 'veo31fast': 4, 'ltx23pro': 6, 'veo31': 4, 'ltx23pro4k': 6,
};

// Wall-clock seconds to GENERATE one TTV clip (model-specific, matches VisualConfiguration.tsx)
const TTV_SECONDS_PER_CLIP_GEN: Record<string, number> = {
  'seedance_pro_fast': 90, 'ltx23_fast': 90, 'grok': 90,
  'grok_highres': 120, 'seedance15_pro': 120, 'ltx23_pro': 120,
  'veo31fast': 180, 'veo31': 360, 'sora2pro': 300, 'sora2pro_highres': 480,
};
const TTV_DEFAULT_SECONDS_PER_CLIP_GEN = 90;

// Wall-clock seconds to GENERATE one ITV clip (model-specific, matches VisualConfiguration.tsx)
const ITV_SECONDS_PER_CLIP_GEN: Record<string, number> = {
  'wan22': 90, 'seedance1fast': 90, 'hailuo23fast': 150, 'seedance15': 180,
  'ltx23fast': 90, 'veo31fast': 180, 'ltx23pro': 120, 'veo31': 360, 'ltx23pro4k': 180,
};
const ITV_DEFAULT_SECONDS_PER_CLIP_GEN = 180;

function estimateImageGenerationTokens(numImages: number, imageModel: string): number {
  // Token cost per image based on model
  const tokensPerImage = IMAGE_MODEL_TOKENS[imageModel] || IMAGE_MODEL_TOKENS['imagen-4-fast'];
  
  return numImages * tokensPerImage;
}

// TTV prompt token estimation (based on SSAITTVPrompt.py estimate_total_tokens_video)
function estimateTTVPromptTokens(wordCount: number, numClips: number, useCharacterDescriptions: boolean, model: string = 'sonnet', isLegacy: boolean = true): number {
  const TOKEN_PER_WORD = 1.33;
  // total_words_with_prompts = word_count + 300 * num_clips (TTV uses 300)
  const totalWordsWithPrompts = wordCount + 300 * numClips;
  const numBatches = Math.max(1, Math.ceil(totalWordsWithPrompts / 900));
  const inputSafetyMultiplier = 1.25;
  let totalInputTokens: number;
  let totalOutputTokens: number;
  if (useCharacterDescriptions) {
    const charInputTokens = (wordCount + 150) * TOKEN_PER_WORD;
    const charOutputTokens = 200 * 5;
    const promptInputTokens = numBatches * (wordCount + 1600) * TOKEN_PER_WORD;
    const promptOutputTokens = numClips * 1200 * TOKEN_PER_WORD; // 1200 words per TTV prompt
    totalInputTokens = charInputTokens + promptInputTokens + 665;
    totalOutputTokens = charOutputTokens + promptOutputTokens;
  } else {
    const promptInputTokens = numBatches * (wordCount + 1100) * TOKEN_PER_WORD;
    const promptOutputTokens = numClips * 1200 * TOKEN_PER_WORD; // 1200 words per TTV prompt
    totalInputTokens = promptInputTokens + 665;
    totalOutputTokens = promptOutputTokens;
  }
  totalInputTokens = Math.round(totalInputTokens * inputSafetyMultiplier);
  const multiplier = llmMultiplier(isLegacy, model);
  const baseTokens = Math.round(totalInputTokens * 0.25 + totalOutputTokens);
  const finalTokens = baseTokens * multiplier;
  console.log(`TTV prompt tokens: clips=${numClips}, batches=${numBatches}, model=${model}, multiplier=${multiplier}x, final=${finalTokens}`);
  return finalTokens;
}

// TTV clip generation token estimation (tokensPerSecond × duration × numClips)
function estimateTTVGenerationTokens(numClips: number, videoModel: string, videoDuration: number): number {
  const tokensPerSecond = TTV_MODEL_TOKENS[videoModel] || TTV_DEFAULT_TOKENS_PER_SECOND;
  const totalTokens = Math.round(numClips * tokensPerSecond * videoDuration);
  console.log(`TTV generation tokens: ${numClips} clips × ${tokensPerSecond} tok/s × ${videoDuration}s = ${totalTokens}`);
  return totalTokens;
}

// ITV prompt token estimation (based on SSAIITVPrompts.py — 800 words per prompt output)
function estimateITVPromptTokens(wordCount: number, numImages: number, useCharacterDescriptions: boolean, model: string = 'sonnet', firstPageFreq: number = 10, restFreq: number = 30, isLegacy: boolean = true): number {
  const TOKEN_PER_WORD = 1.33;
  const CHARS_PER_SECOND = 13.67;
  const totalChars = wordCount * 5;
  // freq 0 = skip that section's prompts
  let firstPageSegments = 0;
  if (firstPageFreq > 0) {
    const firstPageCharsPerSegment = Math.max(100, Math.min(3000, Math.round(firstPageFreq * CHARS_PER_SECOND)));
    firstPageSegments = Math.ceil(3000 / firstPageCharsPerSegment);
  }
  let restSegments = 0;
  if (restFreq > 0) {
    const remainingChars = Math.max(0, totalChars - 3000);
    const restCharsPerSegment = Math.max(100, Math.round(restFreq * CHARS_PER_SECOND));
    restSegments = remainingChars > 0 ? Math.ceil(remainingChars / restCharsPerSegment) : 0;
  }
  const numPrompts = Math.round((firstPageSegments + restSegments) * 1.18);
  if (numPrompts === 0) return 0;
  // total_words_with_prompts = word_count + 200 * num_prompts (ITV uses 200)
  const totalWordsWithPrompts = wordCount + 200 * numPrompts;
  const numBatches = Math.max(1, Math.ceil(totalWordsWithPrompts / 900));
  const inputSafetyMultiplier = 1.25;
  let totalInputTokens: number;
  let totalOutputTokens: number;
  if (useCharacterDescriptions) {
    const charInputTokens = (wordCount + 100) * TOKEN_PER_WORD;
    const charOutputTokens = 133 * 5;
    const promptInputTokens = numBatches * (wordCount + 1600) * TOKEN_PER_WORD;
    const promptOutputTokens = numPrompts * 800 * TOKEN_PER_WORD; // 800 words per ITV prompt
    totalInputTokens = charInputTokens + promptInputTokens + 665;
    totalOutputTokens = charOutputTokens + promptOutputTokens;
  } else {
    const promptInputTokens = numBatches * (wordCount + 1100) * TOKEN_PER_WORD;
    const promptOutputTokens = numPrompts * 800 * TOKEN_PER_WORD; // 800 words per ITV prompt
    totalInputTokens = promptInputTokens + 665;
    totalOutputTokens = promptOutputTokens;
  }
  totalInputTokens = Math.round(totalInputTokens * inputSafetyMultiplier);
  const multiplier = llmMultiplier(isLegacy, model);
  const baseTokens = Math.round(totalInputTokens * 0.25 + totalOutputTokens);
  const finalTokens = baseTokens * multiplier;
  console.log(`ITV prompt tokens: prompts=${numPrompts}, batches=${numBatches}, model=${model}, multiplier=${multiplier}x, final=${finalTokens}`);
  return finalTokens;
}

// ITV video generation token estimation (tokensPerSecond × duration × numClips)
function estimateITVVideoGenerationTokens(numClips: number, itvModel: string, itvDuration: number): number {
  const tokensPerSecond = ITV_MODEL_TOKENS[itvModel] || ITV_DEFAULT_TOKENS_PER_SECOND;
  const totalTokens = Math.round(numClips * tokensPerSecond * itvDuration);
  console.log(`ITV video generation tokens: ${numClips} clips × ${tokensPerSecond} tok/s × ${itvDuration}s = ${totalTokens}`);
  return totalTokens;
}

function estimateAudioTokens(content: string, voice: string, modelVersion: string, removeTitleChapters: boolean, volume: number = 1.0, elevenLabsModelId?: string): number {
  let processedContent = content;
  
  if (removeTitleChapters) {
    processedContent = removeTitleAndChapters(content);
  }
  
  const totalCharacters = calculateCharacterCount(processedContent);
  const wordCount = calculateWordCount(processedContent);
  
  // UPDATED: Determine voice type and cost based on model_version instead of parsing voice string
  let costPerChar: number;
  if (modelVersion === 'v7') {
    costPerChar = 4; // Premium voices (v7)
  } else if (modelVersion === 'lemonfox') {
    costPerChar = 2; // Core voices (lemonfox)
  } else if (modelVersion === 'clone') {
    costPerChar = 2; // Clone voices
  } else if (modelVersion === 'speechify') {
    costPerChar = 8; // Apex voices (speechify)
  } else if (modelVersion === 'elevenlabs') {
    costPerChar = elevenLabsTokensPerChar(elevenLabsModelId); // 100 or 200 depending on model
  } else {
    costPerChar = 2; // Core voices (default)
  }
  
  const baseTokens = totalCharacters * costPerChar;
  
  // Add volume boost tokens if volume > 1.0
  const volumeBoostTokens = (volume && volume > 1.0) ? wordCount : 0;
  const totalTokens = baseTokens + volumeBoostTokens;
  
  console.log(`Audio token calculation: ${totalCharacters} chars × ${costPerChar} tokens/char + ${volumeBoostTokens} volume boost = ${totalTokens} tokens (voice: ${voice}, model: ${modelVersion}, volume: ${volume})`);
  
  return totalTokens;
}

// FIXED: Video processing tokens — uses runtime-based per-minute pricing via
// the shared timeEstimates module (matches GCF @billed decorators).
function estimateVideoProcessingTokens(
  numImages: number, 
  wordCount: number,
  totalAudioDuration?: number,
  hasTransitions: boolean = false,
  visualType: string = 'image',
  animationType?: string | null,
  effectsType?: string | null,
  hasSubtitles: boolean = false,
): number {
  const S_audio = totalAudioDuration && totalAudioDuration > 0
    ? totalAudioDuration
    : (wordCount / 125) * 60;
  const breakdown = estimateVideoPipelineSeconds({
    N_images: numImages,
    S_audio,
    durations: null,
    visualType: (visualType as 'image' | 'ttv' | 'itv') || 'image',
    hasTransitions,
    hasOverlay: !!(animationType || effectsType),
    hasSubtitles,
    useExistingAudio: false,
    animationType: animationType ?? null,
    effectsType: effectsType ?? null,
  });
  const renderRate = breakdown.useHighMemory
    ? TOKEN_RATES_PER_MIN['create-final-video-high-memory']
    : TOKEN_RATES_PER_MIN['create-final-video'];
  const audioDurTokens   = (breakdown.audioDuration / 60) * TOKEN_RATES_PER_MIN['calculate-audio-duration'];
  const audioBoostTokens = (breakdown.audioBoost    / 60) * TOKEN_RATES_PER_MIN['boost-audio-volume'];
  const calcDurTokens    = (breakdown.calcDurations / 60) * TOKEN_RATES_PER_MIN['calculate-video-durations'];
  const itvProcTokens    = (breakdown.imageToVideo  / 60) * TOKEN_RATES_PER_MIN['image-to-video-processor'];
  const renderTokens     = (breakdown.finalRender   / 60) * renderRate;
  const subtitleTokens   = (breakdown.subtitles     / 60) * renderRate;
  // Token safety pad: estimator hits the per-stage mean; real tasks vary
  // ±15–20% (cold-start variance, Cloud Run autoscaling). Apply a 1.15×
  // pad so we tend to slightly over-quote rather than under-charge users.
  const TOKEN_SAFETY_PAD = 1.15;
  const total = Math.ceil(
    (audioDurTokens + audioBoostTokens + calcDurTokens
     + itvProcTokens + renderTokens + subtitleTokens) * TOKEN_SAFETY_PAD
  );
  console.log('Runtime-based video tokens:', {
    S_audio, N_images: numImages, hasTransitions, visualType,
    useHighMemory: breakdown.useHighMemory,
    seconds: {
      audioDuration: Math.round(breakdown.audioDuration),
      audioBoost: Math.round(breakdown.audioBoost),
      calcDurations: Math.round(breakdown.calcDurations),
      imageToVideo: Math.round(breakdown.imageToVideo),
      finalRender: Math.round(breakdown.finalRender),
      subtitles: Math.round(breakdown.subtitles),
      totalWithPad: Math.round(breakdown.totalWithPad),
    },
    tokens: {
      audioDur: Math.round(audioDurTokens),
      audioBoost: Math.round(audioBoostTokens),
      calcDur: Math.round(calcDurTokens),
      itv: Math.round(itvProcTokens),
      render: Math.round(renderTokens),
      subtitles: Math.round(subtitleTokens),
      total,
    },
  });
  return total;
}

function estimateVideoLoopProcessingTokens(): number {
  // For video loop: 150,000 fixed tokens
  return 150000;
}

function estimateVideoSize(
  wordCount: number, 
  numImages: number, 
  audioModel: string, 
  hasVideoLoop: boolean = false, 
  hasBackgroundMusic: boolean = false, 
  videoLoopMetadata?: { duration: number; size: number; bitrate?: number },
  customLoopTime?: number // ADDED: Custom loop time parameter
): number {
  /**
   * Estimates the file size of the final video in MB based on word count, number of images, audio model,
   * and additional features like video loops and background music.
   */
  
  if (wordCount <= 0) {
    throw new Error("Word count must be a positive integer.");
  }
  
  // UPDATED: Calculate required video duration - prioritize custom loop time over word count
  let requiredDurationSeconds: number;
  if (customLoopTime && customLoopTime > 0) {
    requiredDurationSeconds = customLoopTime;
    console.log(`Using custom loop time: ${customLoopTime}s (${(customLoopTime/3600).toFixed(2)}h)`);
  } else {
    // Fall back to word count calculation
    const durationHours = wordCount / 7500.0;
    requiredDurationSeconds = durationHours * 3600;
    console.log(`Using word count duration: ${requiredDurationSeconds}s (${durationHours.toFixed(2)}h)`);
  }
  
  // Audio bitrate based on model
  let audioBitrateKbps: number;
  if (audioModel.toLowerCase() === 'premium') {
    audioBitrateKbps = 128;
  } else if (audioModel.toLowerCase() === 'clone' || audioModel.toLowerCase() === 'core') {
    audioBitrateKbps = 1536; // Same as clone for Core voices
  } else if (audioModel.toLowerCase() === 'apex') {
    audioBitrateKbps = 256; // Apex voices bitrate
  } else { // default to 'standard'
    audioBitrateKbps = 256;
  }
  
  let videoSizeMb: number;
  
  if (hasVideoLoop && videoLoopMetadata) {
    // FIXED: Use actual bitrate with compression factor instead of capping at 5 Mbps
    console.log(`Using actual video metadata: ${videoLoopMetadata.duration}s, ${videoLoopMetadata.size} bytes`);
    
    const originalDurationSeconds = videoLoopMetadata.duration;
    const originalSizeMB = videoLoopMetadata.size / (1024 * 1024);
    
    // Calculate target bitrate from original video
    const targetBitrateMbps = (originalSizeMB * 8) / originalDurationSeconds; // Extract original bitrate
    
    // Use actual bitrate with a slight compression factor for re-encoding efficiency
    const compressionFactor = 0.9; // Account for re-encoding efficiency
    const estimatedBitrateMbps = targetBitrateMbps * compressionFactor;
    
    // Calculate final size based on target duration and estimated bitrate
    videoSizeMb = (estimatedBitrateMbps * requiredDurationSeconds) / 8;
    
    console.log(`Accurate video loop size calculation: original=${originalSizeMB.toFixed(2)}MB (${targetBitrateMbps.toFixed(2)} Mbps) -> estimated=${estimatedBitrateMbps.toFixed(2)} Mbps for ${requiredDurationSeconds}s = ${videoSizeMb.toFixed(2)}MB`);
    
  } else if (hasVideoLoop) {
    // Fallback to original heuristic-based calculation if metadata not available
    console.log(`Video loop fallback calculation (no metadata provided)`);
    
    // Assume higher bitrate due to motion in video loops
    const videoBitrateKbps = 3000; // Higher bitrate for video loops
    videoSizeMb = (videoBitrateKbps * requiredDurationSeconds) / 8192;
  } else {
    // Original calculation for generated images
    const durationHours = requiredDurationSeconds / 3600;
    const imageDensity = durationHours > 0 ? numImages / durationHours : 0;
    const videoBitrateKbps = 1500 + Math.min(20000, imageDensity * 10); // Cap at reasonable max for high density
    videoSizeMb = (videoBitrateKbps * requiredDurationSeconds) / 8192;
  }
  
  // Calculate audio size
  const audioSizeMb = (audioBitrateKbps * requiredDurationSeconds) / 8192;
  
  // Add background music track if present (typically 128 kbps)
  let backgroundMusicSizeMb = 0;
  if (hasBackgroundMusic) {
    backgroundMusicSizeMb = (128 * requiredDurationSeconds) / 8192;
  }
  
  // Total with small overhead
  const totalSizeMb = videoSizeMb + audioSizeMb + backgroundMusicSizeMb + 5;
  
  console.log(`Final size calculation: video=${videoSizeMb.toFixed(2)}MB + audio=${audioSizeMb.toFixed(2)}MB + bg=${backgroundMusicSizeMb.toFixed(2)}MB + overhead=5MB = ${totalSizeMb.toFixed(2)}MB`);
  
  return Math.ceil(totalSizeMb);
}

function estimateVideoTime(wordCount: number): number {
  // Estimate video time in minutes
  // 7500 words = 1 hour (60 minutes)
  return Math.round((wordCount / 7500) * 60);
}

// Helper function to get time per image based on model
function getTimePerImageInSeconds(imageModel?: string): number {
  // All models including flux-2-dev take ~30 seconds per image
  return 30;
}

// UPDATED: Fixed generation time estimation to match frontend logic with processing flags
function estimateGenerationTime(
  wordCount: number,
  numImages: number,
  voice: string,
  modelVersion: string,
  imageModel: string | undefined,
  restFrequency: number,
  needsStoryGeneration: boolean,
  needsImageGeneration: boolean,
  needsAudioGeneration: boolean,
  use_existing_images: boolean,
  finalImageFolderPath?: string,
  hasVideoLoop: boolean = false,
  transitionType?: string | null,
  // NEW: Processing control flags
  video: boolean = true,
  processStory: boolean = true,
  processImages: boolean = true,
  processAudio: boolean = true,
  // NEW: Visual pipeline type
  visualType: 'image' | 'ttv' | 'itv' = 'image',
  numTTVClips: number = 0,
  videoModelName: string = 'grok',
  itvModelName: string = 'wan22',
  // When the actual audio duration is known (e.g. use_existing_audio=true), use it instead
  // of the word-count estimate so the video batch calculation is accurate.
  totalAudioDuration: number = 0,
  // NEW: per-clip overlay configuration (animation_type / effects_type from
  // VideoConfiguration). Drives image-to-video-processor cost via the
  // calibrated ANIM_MULT × EFFECT_MULT tables.
  animationType: string | null = null,
  effectsType: string | null = null,
  hasSubtitles: boolean = false
): number {
  let totalTimeSeconds = 0;

  console.log('Estimating generation time with parameters:', {
    wordCount,
    numImages,
    voice,
    modelVersion,
    restFrequency,
    needsStoryGeneration,
    needsImageGeneration,
    needsAudioGeneration,
    use_existing_images,
    finalImageFolderPath: !!finalImageFolderPath,
    hasVideoLoop,
    transitionType,
    video,
    processStory,
    processImages,
    processAudio,
    visualType,
    numTTVClips
  });

  // Story generation time (only if processing story and needed)
  if (processStory && needsStoryGeneration && wordCount > 0) {
    const storyBatches = Math.ceil(wordCount / 500); // 500 words per batch
    const storyTime = storyBatches * 90; // 90 seconds per batch
    totalTimeSeconds += storyTime;
    console.log(`Story generation time: ${storyBatches} batches × 90s = ${storyTime}s`);
  }

  // Visual generation time — branches based on pipeline type
  if (processImages && needsImageGeneration && !use_existing_images && !finalImageFolderPath) {
    if (visualType === 'ttv') {
      // TTV pipeline: TTV prompts → TTV video clip generation
      const ttvPromptBatches = Math.ceil(numTTVClips / 2);
      const ttvPromptTime = ttvPromptBatches * 90;
      totalTimeSeconds += ttvPromptTime;
      console.log(`TTV prompt generation time: ${ttvPromptBatches} batches × 90s = ${ttvPromptTime}s`);
      const ttvSecsPerClip = TTV_SECONDS_PER_CLIP_GEN[videoModelName] || TTV_DEFAULT_SECONDS_PER_CLIP_GEN;
      const ttvGenTime = numTTVClips * ttvSecsPerClip;
      totalTimeSeconds += ttvGenTime;
      console.log(`TTV video generation time: ${numTTVClips} clips × ${ttvSecsPerClip}s (${videoModelName}) = ${ttvGenTime}s`);
    } else if (visualType === 'itv') {
      // ITV pipeline: ITV prompts → keyframe image generation → ITV video clip generation
      const itvPromptBatches = Math.ceil(numImages / 2);
      const itvPromptTime = itvPromptBatches * 90;
      totalTimeSeconds += itvPromptTime;
      console.log(`ITV prompt generation time: ${itvPromptBatches} batches × 90s = ${itvPromptTime}s`);
      const timePerImage = getTimePerImageInSeconds(imageModel);
      const itvImageGenTime = numImages * timePerImage;
      totalTimeSeconds += itvImageGenTime;
      console.log(`ITV keyframe image generation time: ${numImages} images × ${timePerImage}s = ${itvImageGenTime}s`);
      const itvSecsPerClip = ITV_SECONDS_PER_CLIP_GEN[itvModelName] || ITV_DEFAULT_SECONDS_PER_CLIP_GEN;
      const itvVidGenTime = numImages * itvSecsPerClip;
      totalTimeSeconds += itvVidGenTime;
      console.log(`ITV video generation time: ${numImages} clips × ${itvSecsPerClip}s (${itvModelName}) = ${itvVidGenTime}s`);
    } else {
      // Standard image pipeline: image prompts → image generation
      let promptBatches: number;
      if (restFrequency > 120) {
        promptBatches = numImages;
      } else {
        promptBatches = Math.ceil(numImages / 2);
      }
      const imagePromptTime = promptBatches * 90;
      totalTimeSeconds += imagePromptTime;
      console.log(`Image prompt generation time: ${promptBatches} batches × 90s = ${imagePromptTime}s`);
      const timePerImage = getTimePerImageInSeconds(imageModel);
      const imageGenTime = numImages * timePerImage;
      totalTimeSeconds += imageGenTime;
      console.log(`Image generation time: ${numImages} images × ${timePerImage}s (model: ${imageModel || 'default'}) = ${imageGenTime}s`);
    }
  }

  // Audio generation time (only if processing audio and needed)
  if (processAudio && needsAudioGeneration) {
    const imagesAvailable = !needsImageGeneration || use_existing_images || !!finalImageFolderPath;
    
    if (wordCount > 0) {
      // UPDATED: Determine voice type and batch size based on model_version instead of parsing voice string
      let wordsPerBatch: number;
      let secondsPerBatch: number;
      
      if (modelVersion === 'v7') {
        wordsPerBatch = 200; // Premium v7 voice
        secondsPerBatch = 10;
      } else if (modelVersion === 'lemonfox') {
        wordsPerBatch = 200; // Core voices (lemonfox) - same batch size as premium
        secondsPerBatch = 10;
      } else if (modelVersion === 'clone') {
        wordsPerBatch = 40; // Clone voice
        secondsPerBatch = 10;
      } else if (modelVersion === 'speechify') {
        wordsPerBatch = 100; // Apex voices (speechify)
        secondsPerBatch = 10;
      } else if (modelVersion === 'elevenlabs') {
        wordsPerBatch = 150; // ElevenLabs voices
        secondsPerBatch = 10;
      } else {
        wordsPerBatch = 200; // Core voice (default)
        secondsPerBatch = 10;
      }
      
      const audioBatches = Math.ceil(wordCount / wordsPerBatch);
      const audioTime = audioBatches * secondsPerBatch;
      totalTimeSeconds += audioTime;
      console.log(`Audio generation time: ${audioBatches} batches × ${secondsPerBatch}s = ${audioTime}s (voice: ${voice}, model: ${modelVersion})`);
    } else {
      console.log('Audio generation skipped - images not available yet');
    }
  }

  // UPDATED: Video processing time uses the shared per-stage estimator (matches GCF runtime).
  if (video) {
    if (hasVideoLoop) {
      // For video loops: use fixed time calculation (30 minutes)
      const videoTime = 30 * 60; // 30 minutes in seconds
      totalTimeSeconds += videoTime;
      console.log(`Video loop processing time: 30 minutes = ${videoTime}s`);
    } else {
      const totalDurationSeconds = totalAudioDuration > 0
        ? totalAudioDuration
        : (wordCount / 125) * 60;
      const N_for_video = visualType === 'ttv' ? (numTTVClips || numImages) : numImages;
      const breakdown = estimateVideoPipelineSeconds({
        N_images: N_for_video,
        S_audio: totalDurationSeconds,
        durations: null,
        visualType,
        hasTransitions: transitionType === 'dissolve',
        hasOverlay: !!(animationType || effectsType),
        hasSubtitles,
        useExistingAudio: false,
        animationType: animationType ?? null,
        effectsType: effectsType ?? null,
      });
      totalTimeSeconds += breakdown.totalWithPad;
      console.log('Video pipeline time (shared estimator):', {
        visualType,
        N: N_for_video,
        S_audio: Math.round(totalDurationSeconds),
        useHighMemory: breakdown.useHighMemory,
        seconds: {
          audioDuration: Math.round(breakdown.audioDuration),
          audioBoost: Math.round(breakdown.audioBoost),
          calcDurations: Math.round(breakdown.calcDurations),
          imageToVideo: Math.round(breakdown.imageToVideo),
          finalRender: Math.round(breakdown.finalRender),
          subtitles: Math.round(breakdown.subtitles),
          totalWithPad: Math.round(breakdown.totalWithPad),
        },
      });
    }
    // +30 min wall-clock buffer so the analyze-view estimate matches what
    // users see during live polling (calculateVideoBatchTime adds the same
    // buffer in src/utils/storyTaskPolling.ts). Only added when `video=true`.
    totalTimeSeconds += 30 * 60;
    console.log('Added +30 min video pipeline buffer to match live polling display');
  } else {
    console.log('Video creation disabled - skipping video processing time');
  }

  // Convert to minutes and round
  const totalTimeMinutes = Math.ceil(totalTimeSeconds / 60);
  console.log(`Total estimated generation time: ${totalTimeSeconds}s = ${totalTimeMinutes} minutes`);
  
  return totalTimeMinutes;
}

async function getImageCountFromFolder(folderPath: string): Promise<number> {
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
}

async function getTTVClipCountFromFolder(folderPath: string): Promise<number> {
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
    
    console.log(`Found ${clipFiles.length} MP4 clips in TTV folder: ${folderPath}`);
    return clipFiles.length;
  } catch (error) {
    console.warn(`Error getting clip count from TTV folder ${folderPath}:`, error);
    return 0;
  }
}

async function getWordCountFromStoryFile(filePath: string): Promise<number> {
  try {
    const { data: fileData, error: fileError } = await supabase
      .storage
      .from('stories')
      .download(filePath);
    
    if (fileError) {
      console.warn(`Could not download story file ${filePath}:`, fileError);
      return 0;
    }
    
    const content = await fileData.text();
    return calculateWordCount(content);
  } catch (error) {
    console.warn(`Error getting word count from story file ${filePath}:`, error);
    return 0;
  }
}

async function getContentFromStoryFile(filePath: string): Promise<string> {
  try {
    const { data: fileData, error: fileError } = await supabase
      .storage
      .from('stories')
      .download(filePath);
    
    if (fileError) {
      console.warn(`Could not download story file ${filePath}:`, fileError);
      return '';
    }
    
    return await fileData.text();
  } catch (error) {
    console.warn(`Error getting content from story file ${filePath}:`, error);
    return '';
  }
}

async function getVideoLoopSize(videoLoopUrl: string): Promise<number> {
  try {
    // Extract the file path from the URL
    const urlParts = videoLoopUrl.split('/');
    const fileName = urlParts[urlParts.length - 1];
    const pathParts = videoLoopUrl.replace(`${supabaseUrl}/storage/v1/object/public/audio/`, '').split('/');
    const filePath = pathParts.join('/');
    
    console.log(`Getting video loop size for: ${filePath}`);
    
    // Get file info from audio bucket
    const { data: fileList, error: listError } = await supabase
      .storage
      .from('audio')
      .list(pathParts.slice(0, -1).join('/'));
    
    if (listError) {
      console.warn(`Could not list files in video loop folder:`, listError);
      return 0;
    }
    
    // Find the specific file
    const videoFile = fileList?.find(file => file.name === fileName);
    if (!videoFile || !videoFile.metadata?.size) {
      console.warn(`Video loop file not found or no size info: ${fileName}`);
      return 0;
    }
    
    const sizeMB = videoFile.metadata.size / (1024 * 1024);
    console.log(`Video loop size: ${sizeMB.toFixed(2)} MB`);
    return sizeMB;
  } catch (error) {
    console.warn(`Error getting video loop size from ${videoLoopUrl}:`, error);
    return 0;
  }
}

async function getAudioDurationFromFolder(folderPath: string): Promise<number> {
  try {
    const { data: files, error } = await supabase
      .storage
      .from('stories')
      .list(folderPath);
    
    if (error) {
      console.warn(`Could not list files in folder ${folderPath}:`, error);
      return 0;
    }
    
    // Filter for audio files and sum their sizes as a rough duration estimate
    const audioFiles = files?.filter(file => 
      file.name.toLowerCase().match(/\.(mp3|wav|m4a|aac)$/i)
    ) || [];
    
    // Rough estimate: assume each MB is about 1 minute of audio
    const totalSizeBytes = audioFiles.reduce((sum, file) => sum + (file.metadata?.size || 0), 0);
    const totalSizeMB = totalSizeBytes / (1024 * 1024);
    
    return Math.round(totalSizeMB); // Return as minutes estimate
  } catch (error) {
    console.warn(`Error getting audio duration from folder ${folderPath}:`, error);
    return 0;
  }
}

async function getAudioDurationFromFile(filePath: string): Promise<number> {
  try {
    // Try to get file info from stories bucket first
    const { data: fileInfo, error } = await supabase
      .storage
      .from('stories')
      .info(filePath);
    
    if (error) {
      // If not in stories bucket, try audio bucket
      const { data: audioFileInfo, error: audioError } = await supabase
        .storage
        .from('audio')
        .info(filePath);
      
      if (audioError) {
        console.warn(`Could not get file info for ${filePath}:`, audioError);
        return 0;
      }
      
      // Rough estimate: assume each MB is about 1 minute of audio
      const sizeMB = (audioFileInfo?.size || 0) / (1024 * 1024);
      return Math.round(sizeMB);
    }
    
    // Rough estimate: assume each MB is about 1 minute of audio
    const sizeMB = (fileInfo?.size || 0) / (1024 * 1024);
    return Math.round(sizeMB);
  } catch (error) {
    console.warn(`Error getting audio duration from file ${filePath}:`, error);
    return 0;
  }
}

async function validateVideoLoopFile(videoLoopUrl: string): Promise<boolean> {
  try {
    // For now, just check if the URL is accessible
    // In a real implementation, you might want to validate the video format and duration
    const response = await fetch(videoLoopUrl, { method: 'HEAD' });
    return response.ok;
  } catch (error) {
    console.warn(`Error validating video loop file ${videoLoopUrl}:`, error);
    return false;
  }
}

async function validateBackgroundMusicFile(backgroundMusicUrl: string): Promise<boolean> {
  try {
    // For now, just check if the URL is accessible
    // In a real implementation, you might want to validate the audio format
    const response = await fetch(backgroundMusicUrl, { method: 'HEAD' });
    return response.ok;
  } catch (error) {
    console.warn(`Error validating background music file ${backgroundMusicUrl}:`, error);
    return false;
  }
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 300000; // 5 minutes

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const requestData: AnalyzeRequest = await req.json();
    if (!auth.isServiceRole && auth.userId) {
      requestData.user_id = auth.userId;
    }
    const { 
      user_id, 
      file_path, 
      doc_id, 
      content: providedContent, 
      story_title, 
      description, 
      word_count,
      image_style,
      use_character_descriptions,
      first_page_frequency,
      rest_frequency,
      // Frequency mode and type
      frequency_mode,
      frequency_type,
      consistent_frequency,
      image_amount,
      audio_distribution_type,
      first_page_image_amount,
      rest_image_amount,
      image_model,
      voice,
      model_version,
      elevenlabs_model_id,
      audio_speed,
      volume = 1.0, // NEW: Volume setting with default
      remove_title_chapters,
      clone_voice_url,
      clone_language,
      use_existing_story,
      use_existing_images,
      use_existing_audio,
      images_folder_path,
      image_folder_path,
      audio_file_path,
      audio_folder_path,
      num_images,
      video_loop,
      loop_time,
      video_loop_metadata, // NEW: Video loop metadata
      background_music_url,
      bg_music,
      story_model = 'sonnet', // NEW: Story generation model with default
      image_prompt_model = 'sonnet', // NEW: Image prompt model with default
      transition_type, // NEW: Transition type
      // NEW: Per-clip overlay configuration (drives image-to-video-processor cost).
      // When provided, the estimator uses calibrated ANIM_MULT \xD7 EFFECT_MULT
      // tables instead of the legacy hasOverlay boolean (e.g. ken_burns +
      // fire_flare \u2248 9\xD7 perVideoSec vs hasOverlay's flat 1.4\xD7).
      animation_type,
      effects_type,
      // NEW: Processing control flags with defaults
      video = true,
      process_story = true,
      process_images = true,
      process_audio = true,
      // Master prompt fields
      master_prompt,
      master_prompt_enhance_ai = false,
      // Audio duration (optional - used for video batch estimation)
      total_audio_duration,
      // NEW: Visual pipeline type
      visual_type,
      video_model,
      video_duration,
      process_ttv = false,
      ttv_folder_path,
      itv_model,
      itv_duration,
      process_itv = false,
      itv_video_folder_path,
      // NEW: subtitles flag (drives create-final-video subtitle burn cost)
      subtitles_enabled = false,
    } = requestData;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!user_id || !uuidRegex.test(user_id)) throw new Error('Missing or invalid user_id');

    // NEW: Log processing control flags
    console.log('Processing control flags:', { video, process_story, process_images, process_audio });

    // Normalize parameters
    const finalImageFolderPath = images_folder_path || image_folder_path;
    const finalBackgroundMusicUrl = background_music_url || bg_music;

    // UPDATED: Determine if we need to process content based on flags
    const needsStoryGeneration = process_story && !use_existing_story;
    const needsImageGeneration = process_images && !use_existing_images;
    const needsAudioGeneration = process_audio && !use_existing_audio;
    
    // Special case: video loop upload means we're using existing "images" (the video loop)
    const isVideoLoopUpload = !!video_loop;
    const isVideoLoopSameAsAudio = isVideoLoopUpload && (loop_time === null || loop_time === undefined);

    // For existing assets scenario, we need fewer required fields
    const usingAllExistingAssets = use_existing_story && (use_existing_images || isVideoLoopUpload) && use_existing_audio;
    
    // UPDATED: Validate required fields based on what we're generating and processing flags
    if ((process_story && needsStoryGeneration) || (process_images && needsImageGeneration && !isVideoLoopUpload) || (process_audio && needsAudioGeneration)) {
      if (!story_title || typeof story_title !== 'string') throw new Error('Missing or invalid story_title');
    }
    
    if (process_audio && needsAudioGeneration) {
      if (!voice || typeof voice !== 'string') throw new Error('Missing or invalid voice');
    }
    
    const validImageModels = ['flux-2-dev', 'grok-imagine-image', 'imagen-4-fast', 'gpt-image-1-mini', 'seedream-4.5', 'imagen-4-ultra', 'nano-banana-pro'];

    if (process_images && needsImageGeneration && !isVideoLoopUpload && visual_type !== 'ttv') {
      if (!image_model || !validImageModels.includes(image_model)) {
        // Log a warning and fall back to a default rather than throwing — this handles
        // backward-compatible values ('standard'/'plus'/'premium') and missing values.
        // The estimation functions all have their own fallback, so this is safe.
        console.warn(`image_model '${image_model}' is missing or invalid for visual_type='${visual_type}'; defaulting to 'imagen-4-fast' for estimation.`);
      }
    }

    let content: string = '';
    let actualWordCount: number = 0;
    let numImagesForVideo: number = 0;
    let finalVoice: string = voice || 'henry'; // Default voice for existing audio
    // Use the supplied image_model only if it is a recognised new-style value;
    // otherwise fall back to 'imagen-4-fast' so old saved values don't break estimation.
    let finalImageModel: string = (image_model && validImageModels.includes(image_model)) ? image_model : 'imagen-4-fast';

    console.log('Processing story content...');

    // Handle story content based on source and processing flags
    if (use_existing_story && file_path) {
      // OPTIMIZATION: If word_count is already provided by the client, use it directly.
      // Downloading the file just to re-count words adds 2-5s of latency with no benefit
      // for estimation purposes. The fallback content 'X'.repeat(n*5) matches the char
      // count used elsewhere in estimation (audio tokens, etc.).
      if (word_count) {
        console.log(`Using provided word_count (${word_count}) for existing story — skipping file download`);
        actualWordCount = word_count;
        content = 'X'.repeat(actualWordCount * 5);
      } else {
        console.log(`Downloading existing story file to determine word count: ${file_path}`);
        try {
          content = await getContentFromStoryFile(file_path);
          if (content) {
            actualWordCount = calculateWordCount(content);
            console.log(`Downloaded story content: ${actualWordCount} words`);
          } else {
            throw new Error('Downloaded story file is empty');
          }
        } catch (error) {
          console.warn(`Could not download story file ${file_path}:`, error);
          throw new Error('Could not access existing story file and no word_count provided');
        }
      }
    } else if (providedContent) {
      console.log('Using provided content (uploaded file)');
      // Content provided directly (uploaded file)
      content = providedContent;
      actualWordCount = calculateWordCount(content);
      console.log(`Provided content: ${actualWordCount} words`);
    } else if (process_story && needsStoryGeneration && word_count) {
      console.log(`Generating new story with ${word_count} words`);
      // New story generation - use provided word count
      actualWordCount = word_count;
      content = 'X'.repeat(actualWordCount * 5); // Rough estimate for character count
    } else if (file_path && doc_id) {
      console.log(`Using document from database: ${doc_id}`);
      // Download from storage with doc metadata
      if (!uuidRegex.test(doc_id)) throw new Error('Missing or invalid doc_id');

      const { data: docData, error: docError } = await supabase
        .from('story_documents')
        .select('version, description, word_count')
        .eq('id', doc_id)
        .single();
      if (docError) throw new Error(`Failed to fetch document metadata: ${docError.message}`);
      if (![1, 2].includes(docData.version)) throw new Error('Document version must be 1 or 2');

      const { data: fileData, error: fileError } = await supabase
        .storage
        .from('stories')
        .download(file_path);
      if (fileError) throw new Error(`Failed to download document: ${fileError.message}`);

      content = await fileData.text();
      actualWordCount = calculateWordCount(content);
      console.log(`Document content: ${actualWordCount} words`);
    } else if (!usingAllExistingAssets && process_story) {
      throw new Error('Missing content source - need either existing story file path, provided content, or word count for new story');
    } else if (!process_story) {
      // If story processing is disabled, use minimal defaults
      console.log('Story processing disabled - using defaults');
      actualWordCount = word_count || 5000; // Use provided or default
      content = 'X'.repeat(actualWordCount * 5);
    }

    console.log('Processing image/video configuration...');

    // Handle image count and video loop based on source and processing flags
    if (isVideoLoopUpload) {
      console.log(`Using video loop: ${video_loop}`);
      
      // Log video loop metadata if provided
      if (video_loop_metadata) {
        console.log(`Video loop metadata: duration=${video_loop_metadata.duration}s, size=${(video_loop_metadata.size / (1024 * 1024)).toFixed(2)}MB`);
      }
      
      // For video loop, we treat it as 1 "image" for token calculation
      numImagesForVideo = 1;
      console.log('Video loop treated as 1 image for token calculation');
      
    } else if (use_existing_images && finalImageFolderPath) {
      console.log(`Using existing image folder: ${finalImageFolderPath}`);
      // OPTIMIZATION: If the client already counted the images and sent num_images,
      // use it directly to avoid a duplicate storage list call (~1-2s).
      if (num_images && num_images > 0) {
        numImagesForVideo = num_images;
        console.log(`Using provided image count: ${numImagesForVideo} (skipping storage list)`);
      } else {
        // Fallback: count from storage if not provided
        numImagesForVideo = await getImageCountFromFolder(finalImageFolderPath);
        console.log(`Counted ${numImagesForVideo} images in folder`);
        if (numImagesForVideo === 0) {
          throw new Error('No images found in the specified folder and no fallback count provided');
        }
      }
    } else if ((visual_type as string) === 'ttv' && use_existing_images && ttv_folder_path) {
      // TTV with existing folder: count MP4 clips directly
      console.log(`Using existing TTV folder: ${ttv_folder_path}`);
      if (num_images && num_images > 0) {
        numImagesForVideo = num_images;
        console.log(`Using provided TTV clip count: ${numImagesForVideo}`);
      } else {
        numImagesForVideo = await getTTVClipCountFromFolder(ttv_folder_path);
        console.log(`Counted ${numImagesForVideo} MP4 clips in TTV folder`);
      }
    } else if ((visual_type as string) === 'itv' && use_existing_images && (itv_video_folder_path || finalImageFolderPath)) {
      // ITV with existing folder: count MP4 clips directly
      const itvFolderPath = itv_video_folder_path || finalImageFolderPath!;
      console.log(`Using existing ITV video folder: ${itvFolderPath}`);
      if (num_images && num_images > 0) {
        numImagesForVideo = num_images;
        console.log(`Using provided ITV clip count: ${numImagesForVideo}`);
      } else {
        numImagesForVideo = await getTTVClipCountFromFolder(itvFolderPath);
        console.log(`Counted ${numImagesForVideo} MP4 clips in ITV video folder`);
      }
    } else if (use_existing_images && num_images) {
      console.log(`Using provided image count: ${num_images}`);
      // Use provided number of images from existing folder
      numImagesForVideo = num_images;
    } else if (process_images && needsImageGeneration && actualWordCount > 0) {
      const visualTypeTmp = (visual_type as string) || 'image';
      if (visualTypeTmp === 'ttv') {
        // TTV: clip count = audio duration / clip duration
        const estAudioSec = actualWordCount / 125 * 60;
        const estClipDur = (video_duration as number) || TTV_MODEL_DEFAULT_DURATIONS[(video_model as string) || 'grok'] || 5;
        numImagesForVideo = Math.ceil(estAudioSec / estClipDur);
        console.log(`TTV: estimated ${numImagesForVideo} clips (${estAudioSec.toFixed(1)}s audio ÷ ${estClipDur}s/clip)`);
      } else if (visualTypeTmp === 'itv') {
        // ITV: clip count = audio duration / ITV clip duration (mirrors TTV logic; NOT frequency-based)
        // Prefer total_audio_duration (actual file duration sent by the frontend) over the
        // less-accurate word-count estimate so the result matches the in-page preview.
        const estAudioSec = total_audio_duration || (actualWordCount / 125 * 60);
        const estClipDur = (itv_duration as number) || ITV_MODEL_DEFAULT_DURATIONS[(itv_model as string) || 'wan22'] || 5;
        // Use Math.floor to match the frontend display formula: Math.floor(duration / clipDuration)
        numImagesForVideo = Math.max(1, Math.floor(estAudioSec / estClipDur));
        console.log(`ITV: estimated ${numImagesForVideo} clips (${estAudioSec.toFixed(1)}s audio ÷ ${estClipDur}s/clip, total_audio_duration=${total_audio_duration})`);
      } else {
        // Standard image pipeline: frequency-based image count
        console.log('Estimating image count for generation, frequency_mode:', frequency_mode, 'frequency_type:', frequency_type);
        
        if (frequency_mode === 'audio') {
          // Audio mode: use specified image amounts directly
          if (audio_distribution_type === 'consistent') {
            numImagesForVideo = image_amount || 10;
          } else {
            numImagesForVideo = (first_page_image_amount || 0) + (rest_image_amount || 0);
          }
          console.log(`Audio mode: ${numImagesForVideo} images (distribution: ${audio_distribution_type})`);
        } else if (frequency_type === 'consistent' && consistent_frequency !== undefined && consistent_frequency !== null) {
          // Consistent frequency: single frequency for entire text
          const freq = consistent_frequency;
          if (freq <= 0) {
            numImagesForVideo = 0;
          } else {
            const totalChars = actualWordCount * 5;
            const charsPerSegment = Math.max(100, Math.round(freq * 13.67));
            numImagesForVideo = Math.round(Math.ceil(totalChars / charsPerSegment) * 1.18);
          }
          console.log(`Consistent frequency: ${freq}s -> ${numImagesForVideo} images`);
        } else {
          // Variable frequency (first page + rest pages)
          const freq1 = first_page_frequency ?? 10;
          const freq2 = rest_frequency ?? 30;
          numImagesForVideo = estimateImageCount(actualWordCount, freq1, freq2);
          console.log(`Variable frequency: freq1=${freq1}s, freq2=${freq2}s -> ${numImagesForVideo} images`);
        }
      }
    } else if (!process_images) {
      console.log('Image processing disabled - using minimal default');
      numImagesForVideo = 1; // Minimal default for calculations
    } else {
      console.log('Setting default image count');
      // Default fallback
      numImagesForVideo = 1;
    }

    // Resolve final visual pipeline values
    const finalVisualType = ((visual_type as string) || 'image') as 'image' | 'ttv' | 'itv';
    const finalVideoDuration = (video_duration as number) || TTV_MODEL_DEFAULT_DURATIONS[(video_model as string) || 'grok'] || 5;
    const finalITVDuration = (itv_duration as number) || ITV_MODEL_DEFAULT_DURATIONS[(itv_model as string) || 'wan22'] || 5;
    // For TTV: numTTVClips = numImagesForVideo (already set from audio-based estimation or folder count)
    const numTTVClips = finalVisualType === 'ttv' ? numImagesForVideo : 0;
    console.log(`Visual pipeline resolved: type=${finalVisualType}, numTTVClips=${numTTVClips}, videoDur=${finalVideoDuration}s, itvDur=${finalITVDuration}s`);

    console.log('Processing audio configuration...');

    // Handle audio configuration based on processing flags
    if (use_existing_audio && (audio_file_path || audio_folder_path)) {
      console.log(`Using existing audio: ${audio_file_path || audio_folder_path}`);
      // For existing audio, we don't need to generate it
      // The voice parameter might not be relevant, but we'll keep a default
      if (!finalVoice) {
        finalVoice = 'henry'; // Default voice for estimation purposes
      }
    } else if (process_audio && needsAudioGeneration) {
      console.log(`Generating audio with voice: ${finalVoice}, volume: ${volume}`);
      // Audio will be generated, voice is required and already validated
    } else if (!process_audio) {
      console.log('Audio processing disabled - using defaults');
      finalVoice = 'henry'; // Default for calculations
    }

    // Validate content and image count based on processing flags
    if (actualWordCount === 0 && process_story && needsStoryGeneration) {
      throw new Error('Could not determine story word count for new story generation');
    }

    if (numImagesForVideo === 0 && process_images && needsImageGeneration && !isVideoLoopUpload) {
      throw new Error('Could not determine number of images for image generation');
    }

    console.log('Determining model versions...');

    // Determine model version if not provided
    let finalModelVersion = model_version || 'lemonfox';
    if (!model_version && finalVoice) {
      // Extract voice type and name from the voice parameter
      const voiceType = finalVoice.includes(':') ? finalVoice.split(':')[0] : 'core';
      const voiceName = finalVoice.includes(':') ? finalVoice.split(':')[1] : finalVoice;
      
      if (voiceType === 'premium') {
        finalModelVersion = 'v7';
      } else if (voiceType === 'core') {
        finalModelVersion = 'lemonfox';
      } else if (voiceType === 'elevenlabs') {
        finalModelVersion = 'elevenlabs';
      } else if (voiceType === 'clone' || clone_voice_url) {
        finalModelVersion = 'clone';
      } else if (voiceType === 'apex') {
        finalModelVersion = 'speechify';
      }
    }

    // Determine audio model for video size estimation
    let audioModelForSize = 'core';
    const voiceType = finalVoice.includes(':') ? finalVoice.split(':')[0] : 'core';
    if (voiceType === 'premium') {
      audioModelForSize = 'premium';
    } else if (voiceType === 'core') {
      audioModelForSize = 'core'; // New audio model type for Core voices
    } else if (voiceType === 'clone' || finalModelVersion === 'clone') {
      audioModelForSize = 'clone';
    } else if (voiceType === 'apex') {
      audioModelForSize = 'apex'; // New audio model type for Apex voices
    } else if (voiceType === 'elevenlabs' || finalModelVersion === 'elevenlabs') {
      audioModelForSize = 'elevenlabs';
    }

    console.log('Validating additional assets...');

    // OPTIMIZATION: Validate video loop and background music in parallel instead of
    // sequentially — each HEAD request can take 1-3s so this saves real time.
    const [hasValidVideoLoop, hasValidBackgroundMusic] = await Promise.all([
      video_loop
        ? validateVideoLoopFile(video_loop).then(valid => {
            if (!valid) console.warn(`Video loop file validation failed: ${video_loop}`);
            return valid;
          })
        : Promise.resolve(false),
      finalBackgroundMusicUrl
        ? validateBackgroundMusicFile(finalBackgroundMusicUrl).then(valid => {
            if (!valid) console.warn(`Background music validation failed: ${finalBackgroundMusicUrl}`);
            return valid;
          })
        : Promise.resolve(false),
    ]);

    console.log('Calculating token estimates...');

    // Resolve plan type once for token-cost branching (legacy vs new pricing)
    const isLegacyPlan = await getIsLegacyPlan(user_id);

    // UPDATED: Calculate token estimates for each component with AI model multipliers and processing flags
    const hasMasterPrompt = !!master_prompt;
    const storyTokens = (process_story && needsStoryGeneration && actualWordCount > 0) ? estimateStoryTokens(actualWordCount, story_model, hasMasterPrompt, master_prompt_enhance_ai || false, isLegacyPlan) : 0;
    
    // Visual token estimation — routes by finalVisualType
    const needsVisualGeneration = process_images && needsImageGeneration && !isVideoLoopUpload;

    // TTV: prompt tokens + clip generation tokens
    const ttvPromptTokens = (finalVisualType === 'ttv' && needsVisualGeneration) ?
      estimateTTVPromptTokens(actualWordCount || 5000, numTTVClips, use_character_descriptions || false, image_prompt_model, isLegacyPlan) : 0;
    const ttvGenerationTokens = (finalVisualType === 'ttv' && needsVisualGeneration) ?
      estimateTTVGenerationTokens(numTTVClips, (video_model as string) || 'grok', finalVideoDuration) : 0;

    // Resolve effective frequencies for prompt token estimation
    const effectiveFreq1 = (frequency_type === 'consistent' && consistent_frequency !== undefined) ? consistent_frequency : (first_page_frequency ?? 10);
    const effectiveFreq2 = (frequency_type === 'consistent' && consistent_frequency !== undefined) ? consistent_frequency : (rest_frequency ?? 30);

    // ITV: prompt tokens + keyframe image tokens + ITV video generation tokens
    const itvPromptTokens = (finalVisualType === 'itv' && needsVisualGeneration) ?
      estimateITVPromptTokens(actualWordCount || 5000, numImagesForVideo, use_character_descriptions || false, image_prompt_model, effectiveFreq1, effectiveFreq2, isLegacyPlan) : 0;
    const itvImageTokens = (finalVisualType === 'itv' && needsVisualGeneration) ?
      estimateImageGenerationTokens(numImagesForVideo, finalImageModel) : 0;
    const itvVideoGenerationTokens = (finalVisualType === 'itv' && needsVisualGeneration) ?
      estimateITVVideoGenerationTokens(numImagesForVideo, (itv_model as string) || 'wan22', finalITVDuration) : 0;

    // Standard image pipeline tokens (only for image visual type)
    const imagePromptTokens = (finalVisualType === 'image' && needsVisualGeneration) ?
      estimateImagePromptTokens(
        actualWordCount || 5000,
        use_character_descriptions || false,
        image_prompt_model,
        effectiveFreq1,
        effectiveFreq2,
        isLegacyPlan
      ) : 0;
    const imageTokens = (finalVisualType === 'image' && needsVisualGeneration) ?
      estimateImageGenerationTokens(numImagesForVideo, finalImageModel) : 0;

    const audioTokens = (process_audio && needsAudioGeneration) ? estimateAudioTokens(content || 'X'.repeat((actualWordCount || 5000) * 5), finalVoice, finalModelVersion, remove_title_chapters || false, volume, elevenlabs_model_id) : 0;

    // FIXED: Video processing tokens with transition support
    let videoTokens = 0;
    if (video) {
      if (isVideoLoopUpload) {
        videoTokens = estimateVideoLoopProcessingTokens();
      } else {
        const hasTransitions = transition_type === 'dissolve';
        videoTokens = estimateVideoProcessingTokens(numImagesForVideo, actualWordCount || 5000, total_audio_duration, hasTransitions, visual_type || 'image', animation_type, effects_type, !!subtitles_enabled);
      }
    }

    const totalEstimatedTokens = storyTokens
      + imagePromptTokens + ttvPromptTokens + itvPromptTokens
      + imageTokens + ttvGenerationTokens + itvImageTokens + itvVideoGenerationTokens
      + audioTokens + videoTokens;

    console.log('Token breakdown:', {
      story: storyTokens,
      storyModel: story_model,
      visualType: finalVisualType,
      imagePrompts: imagePromptTokens, imagePromptModel: image_prompt_model,
      images: imageTokens,
      ttvPrompts: ttvPromptTokens, ttvGeneration: ttvGenerationTokens,
      itvPrompts: itvPromptTokens, itvImages: itvImageTokens, itvVideoGeneration: itvVideoGenerationTokens,
      audio: audioTokens,
      video: videoTokens,
      videoLoopMode: isVideoLoopUpload,
      hasTransitions: transition_type === 'dissolve',
      transitionType: transition_type,
      volume: volume,
      total: totalEstimatedTokens,
      processStory: process_story, processImages: process_images,
      processAudio: process_audio, videoCreation: video
    });

    // UPDATED: Calculate video file size with additional features and custom loop time (only if video creation is enabled)
    let estimatedVideoSizeMB = 0;
    if (video) {
      if (finalVisualType === 'ttv') {
        // TTV: each generated clip is ~4 MB (matches standalone TTV page estimate)
        estimatedVideoSizeMB = numTTVClips * 4;
        console.log(`TTV storage estimate: ${numTTVClips} clips × 4 MB = ${estimatedVideoSizeMB} MB`);
      } else if (finalVisualType === 'itv') {
        // ITV: each clip ~6 MB (video) + each keyframe image ~1 MB = 7 MB per clip
        estimatedVideoSizeMB = numImagesForVideo * 7;
        console.log(`ITV storage estimate: ${numImagesForVideo} clips × 7 MB = ${estimatedVideoSizeMB} MB`);
      } else {
        estimatedVideoSizeMB = estimateVideoSize(
          actualWordCount || 5000,
          numImagesForVideo,
          audioModelForSize,
          hasValidVideoLoop || !!video_loop,
          hasValidBackgroundMusic || !!finalBackgroundMusicUrl,
          video_loop_metadata,
          loop_time // ADDED: Pass custom loop time
        );
      }
    } else {
      // For non-video generation, estimate storage for individual components
      // This is a rough estimate for story + images + audio files
      const storySize = (actualWordCount || 5000) * 0.001; // ~1KB per 1000 words
      const imageSize = process_images ? numImagesForVideo * 2 : 0; // ~2MB per image
      const audioSize = process_audio ? Math.max(1, Math.ceil((actualWordCount || 5000) / 1000)) : 0; // ~1MB per 1000 words of audio
      estimatedVideoSizeMB = storySize + imageSize + audioSize;
    }

    // Calculate estimated video time (only relevant if video creation is enabled)
    let estimatedVideoTimeMinutes = 0;
    if (video) {
      if (finalVisualType === 'ttv') {
        // TTV video length = number of clips × clip duration
        estimatedVideoTimeMinutes = Math.round(numTTVClips * finalVideoDuration / 60);
      } else if (finalVisualType === 'itv') {
        // ITV video length = number of clips × clip duration
        estimatedVideoTimeMinutes = Math.round(numImagesForVideo * finalITVDuration / 60);
      } else {
        estimatedVideoTimeMinutes = estimateVideoTime(actualWordCount || 5000);
      }
    }

    // UPDATED: Calculate estimated generation time using the FIXED logic that matches frontend with processing flags
    const estimatedGenerationTimeMinutes = estimateGenerationTime(
      actualWordCount || 5000,
      numImagesForVideo,
      finalVoice,
      finalModelVersion,
      image_model,
      effectiveFreq2,
      needsStoryGeneration,
      needsImageGeneration,
      needsAudioGeneration,
      use_existing_images || false,
      finalImageFolderPath,
      isVideoLoopUpload,
      transition_type,
      video,
      process_story,
      process_images,
      process_audio,
      finalVisualType,
      numTTVClips,
      (video_model as string) || 'grok',
      (itv_model as string) || 'wan22',
      // Pass actual audio duration so the image-pipeline video batch estimate uses the
      // real content length rather than re-deriving it from word count.
      typeof total_audio_duration === 'number' ? total_audio_duration : 0,
      animation_type ?? null,
      effects_type ?? null,
      !!subtitles_enabled
    );

    console.log('Size and time estimates:', {
      sizeMB: estimatedVideoSizeMB,
      timeMinutes: estimatedVideoTimeMinutes,
      generationTimeMinutes: estimatedGenerationTimeMinutes,
      videoLoopMetadata: video_loop_metadata,
      isVideoLoopSameAsAudio: isVideoLoopSameAsAudio,
      customLoopTime: loop_time,
      volume: volume,
      transitionType: transition_type,
      // NEW: Processing flags
      video: video,
      processStory: process_story,
      processImages: process_images,
      processAudio: process_audio
    });

    if (Date.now() - startTime > maxRuntime) throw new Error('Function timed out');

    const analysisResponse = {
      estimatedTokens: totalEstimatedTokens,
      estimatedStorageMB: estimatedVideoSizeMB,
      estimatedVideoTimeMinutes: estimatedVideoTimeMinutes,
      estimatedGenerationTimeMinutes: estimatedGenerationTimeMinutes,
      breakdown: {
        storyTokens,
        // Combined visual prompt tokens (image / TTV / ITV)
        imagePromptTokens: imagePromptTokens + ttvPromptTokens + itvPromptTokens,
        // Combined visual generation tokens
        imageGenerationTokens: imageTokens + ttvGenerationTokens + itvImageTokens + itvVideoGenerationTokens,
        audioTokens,
        videoProcessingTokens: videoTokens,
        // Detailed visual breakdown
        ttvPromptTokens,
        ttvGenerationTokens,
        itvPromptTokens,
        itvImageTokens,
        itvVideoGenerationTokens,
      },
      settings: {
        wordCount: actualWordCount || word_count || 5000,
        numImages: numImagesForVideo,
        imageModel: finalImageModel,
        modelVersion: finalModelVersion,
        audioModel: audioModelForSize,
        voice: finalVoice,
        volume: volume,
        storyModel: story_model,
        imagePromptModel: image_prompt_model,
        isNewStory: needsStoryGeneration,
        hasContent: !!content,
        needsStoryGeneration,
        needsImageGeneration: needsImageGeneration && !isVideoLoopUpload,
        needsAudioGeneration,
        usingAllExistingAssets,
        hasVideoLoop: hasValidVideoLoop || !!video_loop,
        hasBackgroundMusic: hasValidBackgroundMusic || !!finalBackgroundMusicUrl,
        videoLoopUrl: video_loop || null,
        backgroundMusicUrl: finalBackgroundMusicUrl || null,
        loopTime: loop_time || null,
        isVideoLoopUpload: isVideoLoopUpload,
        isVideoLoopSameAsAudio: isVideoLoopSameAsAudio,
        videoLoopMetadata: video_loop_metadata || null,
        transitionType: transition_type || null,
        video: video,
        processStory: process_story,
        processImages: process_images,
        processAudio: process_audio,
        // NEW: Visual pipeline type fields
        visualType: finalVisualType,
        numClips: finalVisualType === 'ttv' ? numTTVClips : (finalVisualType === 'itv' ? numImagesForVideo : undefined),
        videoModel: finalVisualType === 'ttv' ? ((video_model as string) || null) : null,
        videoDuration: finalVisualType === 'ttv' ? finalVideoDuration : null,
        itvModel: finalVisualType === 'itv' ? ((itv_model as string) || null) : null,
        itvDuration: finalVisualType === 'itv' ? finalITVDuration : null,
        processTTV: process_ttv || false,
        processITV: process_itv || false,
      }
    };

    console.log('Analysis complete:', analysisResponse);

    return new Response(
      JSON.stringify(analysisResponse),
      { status: 200, headers: responseHeaders }
    );
  } catch (error: any) {
    console.error('Error in video-analyze:', error);
    await logError('Error in video-analyze', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});



