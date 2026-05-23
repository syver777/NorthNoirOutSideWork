// setup-video-tasks/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { fetchWithDenoFallback } from '../_shared/fetchWithDenoFallback.ts';
import { DEFAULT_ELEVENLABS_MODEL_ID } from '../_shared/elevenlabs.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);



// Predefined clone voices list (matching backend)
const predefinedCloneVoices = [
  { name: "Declan", voice_id: "default-ujsa1wysgyitfqg3ixpqka__declan" },
  { name: "Adrian", voice_id: "default-ujsa1wysgyitfqg3ixpqka__adrian" },
  { name: "Alfred", voice_id: "default-ujsa1wysgyitfqg3ixpqka__alfred" },
  { name: "Conrad", voice_id: "default-ujsa1wysgyitfqg3ixpqka__conrad" },
  { name: "Hugo", voice_id: "default-ujsa1wysgyitfqg3ixpqka__hugo" },
  { name: "Ryder", voice_id: "default-ujsa1wysgyitfqg3ixpqka__ryder" },
  { name: "Victor", voice_id: "default-ujsa1wysgyitfqg3ixpqka__victor" }
];

// Voice type detection functions
const isCoreVoice = (voice: string) => {
  if (voice.includes(':')) {
    const [type, name] = voice.split(':');
    return type === 'core';
  }
  return false;
};

const isPremiumVoice = (voice: string) => {
  if (voice.includes(':')) {
    const [type, name] = voice.split(':');
    return type === 'premium';
  }
  return false;
};

const isApexVoice = (voice: string) => {
  if (voice.includes(':')) {
    const [type, name] = voice.split(':');
    return type === 'apex';
  }
  return false;
};

const isCloneVoice = (voice: string) => {
  if (voice.includes(':')) {
    const [type, name] = voice.split(':');
    return type === 'clone';
  }
  return false;
};

const isElevenLabsVoice = (voice: string) => {
  if (voice.includes(':')) {
    const [type] = voice.split(':');
    return type === 'elevenlabs';
  }
  return false;
};

interface SetupVideoRequest {
  user_id: string;
  group_id: string;
  story_title: string;
  description: string;
  word_count?: number;
  language?: string;
  model?: string; // NEW: Model selection
  story_model?: string; // NEW: Story model selection
  image_model?: string; // NEW: Image model selection for image prompts
  // Image settings
  image_style?: string;
  use_character_descriptions?: boolean;
  first_page_frequency?: number;
  rest_frequency?: number;
  // Audio settings
  voice?: string;
  model_version?: 'v7' | 'clone' | 'lemonfox' | 'speechify' | 'elevenlabs';
  elevenlabs_model_id?: string;
  speed?: number;
  volume?: number; // Volume setting (for both generated and existing audio)
  existing_audio_volume?: number; // NEW: For existing/uploaded audio
  preference?: 'merged' | 'separate';
  remove_title_chapters?: boolean;
  // Clone voice fields (optional)
  clone_voice_name?: string;
  clone_voice_url?: string;
  clone_language?: string;
  // Video settings
  output_video_name?: string;
  bg_music?: string; // NEW: Background music URL
  bg_music_volume?: number; // NEW: Background music volume
  video_loop?: string; // NEW: Video loop URL
  loop_time?: number; // NEW: Loop duration in seconds
  transition_type?: string; // NEW: Transition type (dissolve, fade, etc.)
  animation_type?: string; // NEW: Animation type (drift, vertical, ken_burns, none, etc.)
  effects_type?: string; // NEW: Effects type (film_grain, fire_flare, light_sparkle, snow, none, etc.)
  // Optional subtitle burn-in config. NULL/undefined = no subtitles burned (preserves prior behavior).
  subtitles?: {
    font_idx: number;   // 1..10
    color_idx: number;  // 1..10
    size_idx: number;   // 1..10
    mode: 'phrase' | 'karaoke' | 'single_word';
    position: 'bottom' | 'center' | 'top';
  } | null;
  // Processing options
  variant?: number;
  // New options for existing content
  use_existing_story?: boolean;
  story_file_path?: string;
  use_existing_images?: boolean;
  images_folder_path?: string;
  image_prompt_path?: string;
  use_existing_audio?: boolean;
  audio_file_path?: string;
  audio_folder_path?: string;
  // NEW: Processing control flags
  video?: boolean; // Default TRUE - whether to create final video
  process_story?: boolean; // Default TRUE - whether to process story
  process_images?: boolean; // Default TRUE - whether to process images
  process_audio?: boolean; // Default TRUE - whether to process audio
  tab?: number; // Default 1 - tab number for enterprise users (1-10)
  // Runtime mode fields
  is_runtime_mode?: boolean; // Whether user specified runtime vs word count
  runtime_minutes?: number | null; // Target runtime in minutes
  // Master prompt fields
  master_prompt?: {
    visualStyle: string;
    setting: string;
    atmosphere: string;
    environmentOnly: boolean;
    characters: Array<{ name: string; description: string }>;
  } | null;
  master_prompt_enhance_ai?: boolean; // Whether to use AI enhancement
  // TTV/ITV/MG visual pipeline fields
  visual_type?: 'image' | 'ttv' | 'itv' | 'mg'; // Which visual pipeline to use
  video_model?: string; // TTV video model
  video_style?: string; // TTV visual style (e.g., 'Illustrated', 'Cinematic')
  video_duration?: number; // TTV clip duration in seconds
  audio_clip?: boolean; // Whether TTV/ITV clips contain audio
  itv_model?: string; // ITV video model
  itv_duration?: number; // ITV clip duration in seconds
  process_ttv?: boolean; // Whether to process TTV pipeline
  process_itv?: boolean; // Whether to process ITV pipeline
  // MG (Motion Graphics) visual pipeline fields
  mg_style_slug?: string;        // preset slug from src/data/mgStyles.ts
  mg_style_guidance?: string;    // optional freeform override
  mg_clip_duration?: number;     // seconds per clip (default 10)
  mg_codegen_model?: string;     // 'claude-opus-4-6' (default) | 'claude-sonnet-4-6'
  process_mg?: boolean;          // parity with process_ttv / process_itv
  // TTV/ITV folder/prompt path fields (sent by frontend when reusing existing content)
  ttv_folder_path?: string;
  ttv_prompt_path?: string;
  itv_video_folder_path?: string;
  itv_video_prompt_path?: string;
  itv_image_folder_path?: string;
  itv_image_prompt_path?: string;
  // NEW: Frequency configuration fields for image prompts
  frequency_mode?: 'wordcount' | 'audio';
  frequency_type?: 'consistent' | 'variable';
  consistent_frequency?: number;
  audio_distribution_type?: 'consistent' | 'variable';
  first_page_image_amount?: number;
  rest_image_amount?: number;
  total_audio_duration?: number;
  image_amount?: number;
  audio_files?: Array<{path: string; name: string; duration: number; url?: string}>;
  // Custom characters fields
  customCharactersEnabled?: boolean;
  customCharacters?: Array<{ name: string; description: string }>;
  customCharactersAIEnhance?: boolean;
  pauses?: boolean;
  youtube_links?: string[];
  youtube_transcript_text?: string;
  video_task_id?: string; // Optional: pre-created placeholder row ID from frontend
}

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

function validateInputs(data: SetupVideoRequest): string | null {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!data.user_id || !uuidRegex.test(data.user_id)) return 'Missing or invalid user_id';
  if (!data.group_id || !uuidRegex.test(data.group_id)) return 'Missing or invalid group_id';
  if (!data.story_title || typeof data.story_title !== 'string') return 'Missing or invalid story_title';
  if (!data.description || typeof data.description !== 'string') return 'Missing or invalid description';

  // Language validation
  if (data.language && !['english', 'german', 'spanish', 'french'].includes(data.language)) {
    return 'Invalid language - must be english, german, spanish, or french';
  }

  // Model validation
  if (data.model && !['deepseek', 'sonnet', 'opus'].includes(data.model)) {
    return 'Invalid model - must be deepseek, sonnet, or opus';
  }

  // Story model validation
  if (data.story_model && !['deepseek', 'sonnet', 'opus'].includes(data.story_model)) {
    return 'Invalid story_model - must be deepseek, sonnet, or opus';
  }

  // Processing flags validation
  const processStory = data.process_story !== false; // Default TRUE
  const processImages = data.process_images !== false; // Default TRUE
  const processAudio = data.process_audio !== false; // Default TRUE

  // Image model validation (skip when using existing images — no new images will be generated)
  if (data.image_model && !data.use_existing_images && !['flux-2-dev', 'grok-imagine-image', 'imagen-4-fast', 'gpt-image-1-mini', 'seedream-4.5', 'imagen-4-ultra', 'nano-banana-pro'].includes(data.image_model)) {
    return 'Invalid image_model - must be flux-2-dev, grok-imagine-image, imagen-4-fast, gpt-image-1-mini, seedream-4.5, imagen-4-ultra, or nano-banana-pro';
  }

  // Word count is only required if processing story and not using existing story
  if (processStory && !data.use_existing_story && (typeof data.word_count !== 'number' || data.word_count < 200)) {
    return 'Missing or invalid word_count (required when processing story and not using existing story)';
  }

  // Video loop validation
  if (data.video_loop && typeof data.video_loop !== 'string') {
    return 'Invalid video_loop - must be a valid URL string';
  }

  if (data.loop_time && (typeof data.loop_time !== 'number' || data.loop_time < 1)) {
    return 'Invalid loop_time - must be a positive integer';
  }

  // Transition type validation (optional)
  if (data.transition_type && typeof data.transition_type !== 'string') {
    return 'Invalid transition_type - must be a string';
  }

  // Animation type validation (optional) - UPDATED to include ken_burns
  if (data.animation_type && !['drift', 'vertical', 'ken_burns', 'none'].includes(data.animation_type)) {
    return 'Invalid animation_type - must be drift, vertical, ken_burns, or none';
  }

  // Effects type validation (optional) - UPDATED to include snow
  if (data.effects_type && !['film_grain', 'fire_flare', 'light_sparkle', 'snow', 'none'].includes(data.effects_type)) {
    return 'Invalid effects_type - must be film_grain, fire_flare, light_sparkle, snow, or none';
  }

  // Image settings validation (only required if processing images and not using existing images and not using video loop)
  // Skip for TTV/ITV/MG visual types — they don't use traditional image generation
  if (processImages && !data.use_existing_images && !data.video_loop && data.visual_type !== 'ttv' && data.visual_type !== 'itv' && data.visual_type !== 'mg') {
    if (!data.image_style || typeof data.image_style !== 'string') return 'Missing or invalid image_style (required when processing images and not using existing images or video loop)';
    if (typeof data.use_character_descriptions !== 'boolean') return 'Missing or invalid use_character_descriptions (required when processing images and not using existing images or video loop)';
    
    // Validate frequency based on frequency_type
    if (data.frequency_type === 'consistent') {
      // Consistent mode: first_page_frequency should be null, only validate rest_frequency
      if (data.first_page_frequency !== null) return 'Invalid first_page_frequency - must be null in consistent mode';
      if (typeof data.rest_frequency !== 'number' || data.rest_frequency < 5 || data.rest_frequency > 300) return 'Invalid rest_frequency (must be 5-300)';
    } else {
      // Variable mode: validate both frequencies
      if (typeof data.first_page_frequency !== 'number' || data.first_page_frequency < 5 || data.first_page_frequency > 120) return 'Invalid first_page_frequency (must be 5-120)';
      if (typeof data.rest_frequency !== 'number' || data.rest_frequency < 5 || data.rest_frequency > 300) return 'Invalid rest_frequency (must be 5-300)';
    }
    
    if (data.image_model && !['flux-2-dev', 'grok-imagine-image', 'imagen-4-fast', 'gpt-image-1-mini', 'seedream-4.5', 'imagen-4-ultra', 'nano-banana-pro'].includes(data.image_model)) return 'Invalid image_model - must be flux-2-dev, grok-imagine-image, imagen-4-fast, gpt-image-1-mini, seedream-4.5, imagen-4-ultra, or nano-banana-pro';
  }

  // Audio settings validation (only required if processing audio and not using existing audio)
  if (processAudio && !data.use_existing_audio) {
    // Validation for generated audio
    if (!data.voice || typeof data.voice !== 'string') return 'Missing or invalid voice (required when processing audio and not using existing audio)';
    if (!['v7', 'clone', 'lemonfox', 'speechify', 'elevenlabs'].includes(data.model_version || '')) return 'Invalid model_version';
    if (typeof data.speed !== 'number' || data.speed < 0.5 || data.speed > 2.0) return 'Invalid speed';
    if (data.volume !== undefined && (typeof data.volume !== 'number' || data.volume < 1.0 || data.volume > 8.0)) return 'Invalid volume - must be between 1.0 and 8.0';
    if (!['merged', 'separate'].includes(data.preference || '')) return 'Invalid preference';
    if (typeof data.remove_title_chapters !== 'boolean') return 'Missing or invalid remove_title_chapters';
   
    // Clone voice validation
    if (data.model_version === 'clone') {
      if (!data.clone_voice_name) return 'Missing clone_voice_name for clone model';
      if (!data.clone_voice_url) return 'Missing clone_voice_url for clone model';
      if (!data.clone_language) return 'Missing clone_language for clone model';
    }
  } else if (processAudio && data.use_existing_audio) {
    // Validation for existing audio
    if (data.existing_audio_volume !== undefined && (typeof data.existing_audio_volume !== 'number' || data.existing_audio_volume < 1.0 || data.existing_audio_volume > 8.0)) return 'Invalid existing_audio_volume - must be between 1.0 and 8.0';
    
    // Map existing audio volume to main volume field if not provided
    if (data.existing_audio_volume !== undefined && data.volume === undefined) {
      data.volume = data.existing_audio_volume;
    }
  }

  // Background music validation (optional)
  if (data.bg_music && typeof data.bg_music !== 'string') {
    return 'Invalid bg_music - must be a valid URL string';
  }

  // Background music volume validation (optional)
  if (data.bg_music_volume !== undefined && (typeof data.bg_music_volume !== 'number' || data.bg_music_volume < 0.1 || data.bg_music_volume > 2.0)) {
    return 'Invalid bg_music_volume - must be between 0.1 and 2.0';
  }

  // Subtitles config validation (optional). NULL = no subtitles, no checks needed.
  if (data.subtitles !== undefined && data.subtitles !== null) {
    const s = data.subtitles as any;
    if (typeof s !== 'object') return 'Invalid subtitles - must be an object or null';
    const checkIdx = (n: any, name: string) => {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 10) {
        return `Invalid subtitles.${name} - must be an integer between 1 and 10`;
      }
      return null;
    };
    const e1 = checkIdx(s.font_idx, 'font_idx'); if (e1) return e1;
    const e2 = checkIdx(s.color_idx, 'color_idx'); if (e2) return e2;
    const e3 = checkIdx(s.size_idx, 'size_idx'); if (e3) return e3;
    if (!['phrase', 'karaoke', 'single_word'].includes(s.mode)) {
      return "Invalid subtitles.mode - must be 'phrase', 'karaoke' or 'single_word'";
    }
    if (!['bottom', 'center', 'top'].includes(s.position)) {
      return "Invalid subtitles.position - must be 'bottom', 'center' or 'top'";
    }
  }

  // Visual type validation
  if (data.visual_type && !['image', 'ttv', 'itv', 'mg'].includes(data.visual_type)) {
    return 'Invalid visual_type - must be image, ttv, itv, or mg';
  }
  if (data.visual_type === 'mg') {
    if (!data.mg_style_slug || typeof data.mg_style_slug !== 'string') {
      return 'mg_style_slug is required when visual_type is "mg"';
    }
    if (data.mg_clip_duration != null &&
        (typeof data.mg_clip_duration !== 'number' || data.mg_clip_duration <= 0)) {
      return 'mg_clip_duration must be a positive number';
    }
  }

  // TTV video model validation
  const SUPPORTED_TTV_MODELS = ['seedance_pro_fast', 'ltx23_fast', 'seedance15_pro', 'ltx23_pro', 'grok', 'grok_highres', 'veo31fast', 'veo31', 'sora2pro', 'sora2pro_highres'];
  if (data.visual_type === 'ttv' && data.video_model && !SUPPORTED_TTV_MODELS.includes(data.video_model)) {
    return `Invalid video_model for TTV - must be one of: ${SUPPORTED_TTV_MODELS.join(', ')}`;
  }

  // ITV video model validation (ITV has its own distinct model set)
  const SUPPORTED_ITV_MODELS = ['wan22', 'seedance1fast', 'hailuo23fast', 'seedance15', 'ltx23fast', 'veo31fast', 'ltx23pro', 'veo31', 'ltx23pro4k'];
  if (data.visual_type === 'itv' && data.itv_model && !SUPPORTED_ITV_MODELS.includes(data.itv_model)) {
    return `Invalid itv_model for ITV - must be one of: ${SUPPORTED_ITV_MODELS.join(', ')}`;
  }

  // Validate existing file paths if specified
  if (processStory && data.use_existing_story && !data.story_file_path) return 'Missing story_file_path when using existing story';
  if (processImages && data.use_existing_images && !data.images_folder_path && !data.video_loop) return 'Missing images_folder_path when using existing images';
  if (processAudio && data.use_existing_audio && !data.audio_file_path && !data.audio_folder_path) return 'Missing audio_file_path or audio_folder_path when using existing audio';

  return null;
}

async function countImagesInFolder(folderPath: string): Promise<number> {
  try {
    console.log(`Attempting to list files in folder: ${folderPath}`);
    
    let allFiles: any[] = [];
    let offset = 0;
    const limit = 100; // Supabase's default limit
    
    // Paginate through all files
    while (true) {
      const { data: files, error } = await supabase.storage
        .from('stories')
        .list(folderPath, {
          limit: limit,
          offset: offset
        });

      if (error) {
        console.error(`Error listing files in folder ${folderPath}:`, error);
        throw new Error(`Failed to list files: ${error.message}`);
      }

      if (!files || files.length === 0) {
        break; // No more files
      }

      allFiles.push(...files);
      
      // If we got fewer files than the limit, we've reached the end
      if (files.length < limit) {
        break;
      }
      
      offset += limit;
    }

    console.log(`Found ${allFiles.length} total files in folder`);
    console.log('Files:', allFiles.map(f => f.name));

    // Filter for numbered PNG images (1.png, 2.png, etc.)
    const imageFiles = allFiles.filter(f => {
      const isImage = f.name.endsWith('.png');
      const nameWithoutExt = f.name.replace('.png', '');
      const isNumbered = /^\d+$/.test(nameWithoutExt);
     
      console.log(`File: ${f.name}, isImage: ${isImage}, isNumbered: ${isNumbered}`);
      return isImage && isNumbered;
    });

    console.log(`Found ${imageFiles.length} numbered image files:`, imageFiles.map(f => f.name));
   
    return imageFiles.length;
  } catch (error: any) {
    console.error(`Error counting images in folder ${folderPath}:`, error);
    throw error;
  }
}

// Count .mp4 clip files in a TTV/ITV folder (stories bucket)
async function countVideoClipsInFolder(folderPath: string): Promise<number> {
  try {
    console.log(`Attempting to list video clips in folder: ${folderPath}`);

    let allFiles: any[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const { data: files, error } = await supabase.storage
        .from('stories')
        .list(folderPath, { limit, offset });

      if (error) {
        console.error(`Error listing files in folder ${folderPath}:`, error);
        throw new Error(`Failed to list files: ${error.message}`);
      }

      if (!files || files.length === 0) break;

      allFiles.push(...files);
      if (files.length < limit) break;
      offset += limit;
    }

    const clipFiles = allFiles.filter(f => f.name.endsWith('.mp4'));
    console.log(`Found ${clipFiles.length} .mp4 clip files in folder ${folderPath}`);
    return clipFiles.length;
  } catch (error: any) {
    console.error(`Error counting video clips in folder ${folderPath}:`, error);
    throw error;
  }
}

function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9\s-_]/g, '') // Remove special characters except spaces, hyphens, underscores
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .toLowerCase();
}

// NEW: Helper function to calculate transition batch progress
function calculateTransitionBatchProgress(numImages: number, transitionType: string | null, visualType: string = 'image'): any {
  // TTV/ITV use 12 videos per batch, images use 6
  const batchSize = (visualType === 'ttv' || visualType === 'itv') ? 12 : 6;
  if (!transitionType || numImages <= batchSize) {
    return null;
  }

  const totalTransitionBatches = Math.ceil(numImages / batchSize);
  return {
    total_batches: totalTransitionBatches,
    completed_batches: 0,
    batch_outputs: [],
    total_videos: numImages
  };
}

// Assign a gc_version (1-5) for load-balancing GCloud function instances.
// Each version is capped at 20 concurrent unique processes (unique user+group+tab combos).
async function assignGcVersion(): Promise<number> {
  const MAX_PROCESSES_PER_VERSION = 20;
  const MAX_VERSIONS = 5;

  for (let version = 1; version <= MAX_VERSIONS; version++) {
    try {
      // Count unique (user_id, group_id, tab) combos that are actively using this version
      const { data, error } = await supabase
        .from('video_tasks')
        .select('user_id, group_id, tab')
        .eq('gc_version', version)
        .in('overall_status', ['pending', 'running'])
        .eq('is_main', true); // Main tasks only, not batch sub-tasks

      if (error) {
        console.error(`Error querying gc_version ${version} count:`, error);
        // On error, default to this version to avoid blocking
        return version;
      }

      if (!data || data.length === 0) {
        console.log(`gc_version ${version} has 0 active processes - assigning`);
        return version;
      }

      // Count unique combinations
      const uniqueProcesses = new Set(
        data.map((row: any) => `${row.user_id}:${row.group_id}:${row.tab}`)
      ).size;

      console.log(`gc_version ${version} has ${uniqueProcesses} unique active processes`);

      if (uniqueProcesses < MAX_PROCESSES_PER_VERSION) {
        return version;
      }
    } catch (err: any) {
      console.error(`Error assigning gc_version ${version}:`, err.message);
      return version; // Fallback to current version
    }
  }

  // All versions full - cycle back to version 1
  console.warn('All gc_versions at capacity - defaulting to version 1');
  return 1;
}

// Fire-and-forget function to trigger duration calculation (which creates batch rows)
async function triggerDurationCalculationAsync(
  videoTaskId: string,
  userId: string,
  groupId: string,
  tab: number = 1
) {
  try {
    console.log('Triggering duration calculation asynchronously...');

    // Call the new calculate-video-durations GCloud function
    fetch('https://us-central1-story-script-ai.cloudfunctions.net/calculate-video-durations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        video_task_id: videoTaskId,
        user_id: userId,
        group_id: groupId,
        tab
      }),
    }).then(response => {
      if (response.ok) {
        console.log('Successfully triggered duration calculation');
      } else {
        console.error(`Failed to trigger duration calculation: ${response.status}`);
        // Update task with error
        supabase.from('video_tasks').update({
          overall_status: 'error',
          error_message: `Duration calculation failed: ${response.statusText}`
        }).eq('id', videoTaskId);
      }
    }).catch(error => {
      console.error(`Error triggering duration calculation: ${error.message}`);
      // Update task with error
      supabase.from('video_tasks').update({
        overall_status: 'error',
        error_message: `Duration calculation error: ${error.message}`
      }).eq('id', videoTaskId);
    });

  } catch (error: any) {
    console.error(`Error in triggerDurationCalculationAsync: ${error.message}`)

;
  }
}

function estimateTokens(wordCount: number): number {
  // Rough estimation based on the Python script logic
  const storyTokens = Math.ceil(wordCount * 1.33 * 2); // Story generation
  const imagePromptTokens = Math.ceil(wordCount * 0.5); // Image prompts
  const imageGenerationTokens = Math.ceil(wordCount / 100) * 15000; // ~1 image per 100 words, 15k tokens each
  return storyTokens + imagePromptTokens + imageGenerationTokens;
}

// Fire-and-forget function to trigger the next step
async function triggerProcessingAsync(mainVideoTaskId: string, userId: string, groupId: string, tab: number = 1) {
  try {
    console.log('Triggering batch processing asynchronously...');
   
    // Use fetch with no await - fire and forget
    fetch(`${supabaseUrl}/functions/v1/trigger-next-video`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        video_task_id: mainVideoTaskId,
        user_id: userId,
        group_id: groupId,
        next_step: 'process_images',
        tab
      }),
    }).then(response => {
      if (response.ok) {
        console.log('Successfully triggered batch processing');
      } else {
        console.error(`Failed to trigger batch processing: ${response.status}`);
      }
    }).catch(error => {
      console.error(`Error triggering batch processing: ${error.message}`);
    });
   
  } catch (error: any) {
    console.error(`Error in triggerProcessingAsync: ${error.message}`);
  }
}

// Mark the in-flight video_tasks row(s) as errored so the user isn't left
// staring at a "running" task forever when the upstream story chain fails.
async function markStoryGenerationErrored(
  userId: string,
  groupId: string,
  reason: string
) {
  try {
    const { error } = await supabase
      .from('video_tasks')
      .update({
        story_status: 'error',
        overall_status: 'error',
        error_message: reason.slice(0, 1000),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('story_status', 'running');

    if (error) {
      console.error(`[markStoryGenerationErrored] Failed to update video_tasks: ${error.message}`);
    } else {
      console.error(`[markStoryGenerationErrored] Marked story_status=error for group ${groupId}: ${reason}`);
    }
  } catch (e: any) {
    console.error(`[markStoryGenerationErrored] Unexpected error: ${e.message}`);
  }
}

// Fire-and-forget function to trigger story generation
async function triggerStoryGenerationAsync(
  userId: string,
  groupId: string,
  title: string,
  description: string,
  wordCount: number,
  language: string = 'english',
  model: string = 'sonnet',
  storyModel: string = 'sonnet',
  tab: number = 1,
  masterPrompt: any = null,
  masterPromptEnhanceAI: boolean = false,
  isRuntimeMode: boolean = false,
  runtimeMinutes: number | null = null,
  videoProcess: boolean = true,
  pauses: boolean = false,
  youtubeLinks: string[] = [],
  youtubeTranscriptText: string = ''
) {
  try {
    console.log('Triggering story generation asynchronously...');
    
    // Determine story generation path based on master prompt settings
    let masterPromptForStory: string | null = null;

    const hasYoutubeLinks = youtubeLinks.length > 0;

    if (masterPrompt && (masterPromptEnhanceAI || hasYoutubeLinks)) {
      // Path 1: AI Enhancement OR YouTube links present - call master-prompt edge function
      // master-prompt enhances the prompt with AI and then fires off outline
      // generation asynchronously (fire-and-forget).  This returns quickly.
      console.log(`Calling master-prompt edge function (enhanceAI=${masterPromptEnhanceAI}, youtubeLinks=${youtubeLinks.length}, hasTranscript=${!!youtubeTranscriptText})...`);
      
      try {
        const mpResponse = await fetchWithDenoFallback('master-prompt', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseServiceRoleKey,
          },
          body: JSON.stringify({
            user_id: userId,
            group_id: groupId,
            title,
            description,
            word_count: wordCount,
            language,
            model: storyModel,
            tab,
            variant: 1,
            master_prompt_data: masterPrompt,
            enhance_ai: masterPromptEnhanceAI,
            is_runtime_mode: isRuntimeMode,
            runtime_minutes: runtimeMinutes,
            video_process: videoProcess,
            pauses,
            ...(hasYoutubeLinks ? { youtube_links: youtubeLinks } : {}),
            ...(youtubeTranscriptText ? { youtube_transcript_text: youtubeTranscriptText } : {}),
          }),
        });
        if (mpResponse.ok) {
          console.log('Master prompt enhancement completed, outline generation triggered asynchronously');
        } else {
          const body = await mpResponse.text().catch(() => '');
          console.error(`Master prompt enhancement failed: ${mpResponse.status} ${body.slice(0, 300)}`);
          await markStoryGenerationErrored(userId, groupId, `Master prompt enhancement failed: HTTP ${mpResponse.status}`);
        }
      } catch (error: any) {
        console.error(`Error in master-prompt chain: ${error.message}`);
        await markStoryGenerationErrored(userId, groupId, `Master prompt chain error: ${error.message}`);
      }
      
      return; // Exit - master-prompt handled enhancement + outline trigger
    } else if (masterPrompt && !masterPromptEnhanceAI && !hasYoutubeLinks) {
      // Path 2: No AI Enhancement and no YouTube links - pass raw data as JSON string
      masterPromptForStory = JSON.stringify(masterPrompt);
      console.log('Master prompt without AI enhancement, passing raw data to outline generation');
    } else if (!masterPrompt && hasYoutubeLinks) {
      // Path 2b: No master prompt but YouTube links - route through master-prompt for transcript fetching
      console.log(`No master prompt but ${youtubeLinks.length} YouTube links, routing through master-prompt for transcript fetching (hasTranscript=${!!youtubeTranscriptText})...`);
      
      try {
        const mpResponse = await fetchWithDenoFallback('master-prompt', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseServiceRoleKey,
          },
          body: JSON.stringify({
            user_id: userId,
            group_id: groupId,
            title,
            description,
            word_count: wordCount,
            language,
            model: storyModel,
            tab,
            variant: 1,
            is_runtime_mode: isRuntimeMode,
            runtime_minutes: runtimeMinutes,
            video_process: videoProcess,
            pauses,
            youtube_links: youtubeLinks,
            ...(youtubeTranscriptText ? { youtube_transcript_text: youtubeTranscriptText } : {}),
          }),
        });
        if (mpResponse.ok) {
          console.log('Master prompt with YouTube transcripts completed, outline generation triggered asynchronously');
        } else {
          const body = await mpResponse.text().catch(() => '');
          console.error(`Master prompt with YouTube links failed: ${mpResponse.status} ${body.slice(0, 300)}`);
          await markStoryGenerationErrored(userId, groupId, `Master prompt (YouTube) failed: HTTP ${mpResponse.status}`);
        }
      } catch (error: any) {
        console.error(`Error in master-prompt YouTube chain: ${error.message}`);
        await markStoryGenerationErrored(userId, groupId, `Master prompt (YouTube) error: ${error.message}`);
      }
      
      return; // Exit - master-prompt + outline chain completed
    }

    // Path 3: No master prompt OR fallback from failed enhancement
    // Call storyscriptai-outline directly (await to keep connection alive)
    try {
      const outlineResponse = await fetchWithDenoFallback('storyscriptai-outline', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify({
          title,
          description,
          wordCount,
          groupId,
          userId,
          language,
          model: storyModel,
          videoProcess: true,
          tab,
          master_prompt: masterPromptForStory,
          is_runtime_mode: isRuntimeMode,
          runtime_minutes: runtimeMinutes,
          pauses,
        }),
      });
      if (outlineResponse.ok) {
        console.log('Successfully completed story outline generation');
      } else {
        const body = await outlineResponse.text().catch(() => '');
        console.error(`Story outline generation failed: ${outlineResponse.status} ${body.slice(0, 300)}`);
        await markStoryGenerationErrored(userId, groupId, `Story outline failed: HTTP ${outlineResponse.status}`);
      }
    } catch (error: any) {
      console.error(`Error in story outline generation: ${error.message}`);
      await markStoryGenerationErrored(userId, groupId, `Story outline error: ${error.message}`);
    }
   
  } catch (error: any) {
    console.error(`Error in triggerStoryGenerationAsync: ${error.message}`);
    await markStoryGenerationErrored(userId, groupId, `Story generation trigger error: ${error.message}`);
  }
}

// Map new image model names to old names for external service compatibility
function mapImageModelToLegacy(imageModel: string): string {
  const modelMap: Record<string, string> = {
    'flux-2-dev': 'spark',
    'grok-imagine-image': 'grok',
    'imagen-4-fast': 'standard',
    'gpt-image-1-mini': 'plus',
    'seedream-4.5': 'prime',
    'imagen-4-ultra': 'premium',
    'nano-banana-pro': 'genesis'
  };
  
  return modelMap[imageModel] || 'plus'; // Default to 'plus' if not found
}

// Detect next variant for image prompts based on existing prompted documents
async function detectImagePromptVariant(groupId: string, requestedVariant: number = 1): Promise<number> {
  try {
    const { data: existingDocs, error: fetchVariantError } = await supabase
      .from('story_documents')
      .select('variant')
      .eq('group_id', groupId)
      .eq('is_prompted', true)
      .order('variant', { ascending: false });

    if (fetchVariantError) {
      console.error('Error fetching image prompt variants:', fetchVariantError);
      return requestedVariant; // Default to requested variant on error
    }

    if (existingDocs && existingDocs.length > 0) {
      const existingVariants = new Set(existingDocs.map(doc => doc.variant || 0).filter(v => v > 0));
      if (existingVariants.has(requestedVariant)) {
        // Requested variant exists, find highest and increment
        const highestVariant = Math.max(...Array.from(existingVariants));
        return highestVariant + 1;
      }
      return requestedVariant; // Use requested variant if available
    }

    return requestedVariant; // No existing variants, use requested
  } catch (error: any) {
    console.error('Exception in detectImagePromptVariant:', error);
    return requestedVariant; // Default to requested variant on exception
  }
}

// Detect next variant for audio based on existing audio documents (versions 7-10)
async function detectAudioVariant(groupId: string, userId: string, requestedVariant: number = 1): Promise<number> {
  try {
    const { data: existingDocs, error: fetchVariantError } = await supabase
      .from('story_documents')
      .select('variant')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .in('version', [7, 8, 9, 10]) // Audio output versions
      .order('variant', { ascending: false });

    if (fetchVariantError) {
      console.error('Error fetching audio variants:', fetchVariantError);
      return requestedVariant; // Default to requested variant on error
    }

    if (existingDocs && existingDocs.length > 0) {
      const existingVariants = new Set(existingDocs.map(doc => doc.variant || 0).filter(v => v > 0));
      if (existingVariants.has(requestedVariant)) {
        // Requested variant exists, find highest and increment
        const highestVariant = Math.max(...Array.from(existingVariants));
        return highestVariant + 1;
      }
      return requestedVariant; // Use requested variant if available
    }

    return requestedVariant; // No existing variants, use requested
  } catch (error: any) {
    console.error('Exception in detectAudioVariant:', error);
    return requestedVariant; // Default to requested variant on exception
  }
}

// Detect next variant for final video based on existing video documents (version 11)
async function detectVideoVariant(groupId: string, userId: string, requestedVariant: number = 1): Promise<number> {
  try {
    const { data: existingDocs, error: fetchVariantError } = await supabase
      .from('story_documents')
      .select('variant')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('version', 11) // Final Video version
      .order('variant', { ascending: false });

    if (fetchVariantError) {
      console.error('Error fetching video variants:', fetchVariantError);
      return requestedVariant; // Default to requested variant on error
    }

    if (existingDocs && existingDocs.length > 0) {
      const existingVariants = new Set(existingDocs.map(doc => doc.variant || 0).filter(v => v > 0));
      if (existingVariants.has(requestedVariant)) {
        // Requested variant exists, find highest and increment
        const highestVariant = Math.max(...Array.from(existingVariants));
        return highestVariant + 1;
      }
      return requestedVariant; // Use requested variant if available
    }

    return requestedVariant; // No existing variants, use requested
  } catch (error: any) {
    console.error('Exception in detectVideoVariant:', error);
    return requestedVariant; // Default to requested variant on exception
  }
}

// Fire-and-forget function to trigger image prompts and audio generation
async function triggerImagePromptsAndAudioAsync(userId: string, groupId: string, settings: any, storyFilePath: string, videoTaskId: string, tab: number = 1) {
  try {
    console.log('Triggering image prompts and audio generation asynchronously...');
   
    // First, get the story document to find the doc_id
    const { data: storyDoc, error: storyDocError } = await supabase
      .from('story_documents')
      .select('*')
      .eq('file_path', storyFilePath)
      .single();

    if (storyDocError || !storyDoc) {
      console.error(`Failed to find story document with file_path ${storyFilePath}:`, storyDocError);
      throw new Error(`Story document not found for file path: ${storyFilePath}`);
    }

    console.log(`Found story document with id: ${storyDoc.id} for file path: ${storyFilePath}`);

    // Detect variants for image prompts and audio independently
    let imageVariant = settings.variant || 1; // Default to video variant
    let audioVariant = settings.variant || 1; // Default to video variant

    // Only detect new variant if we're creating NEW content (not using existing)
    if (settings.process_images !== false && !settings.use_existing_images) {
      imageVariant = await detectImagePromptVariant(groupId, settings.variant || 1);
      console.log(`Detected image prompt variant: ${imageVariant} for group_id: ${groupId}`);
    }

    if (settings.process_audio !== false && !settings.use_existing_audio) {
      audioVariant = await detectAudioVariant(groupId, userId, settings.variant || 1);
      console.log(`Detected audio variant: ${audioVariant} for group_id: ${groupId}`);
    }

    // Update video task with story document ID
    await supabase
      .from('video_tasks')
      .update({
        story_document_id: storyDoc.id, // Save to story_document_id column (doc_id intentionally left null to preserve batch task identification)
        updated_at: new Date().toISOString()
      })
      .eq('id', videoTaskId);

    console.log(`Updated video_tasks with story_document_id: ${storyDoc.id}`);

    // Check if video loop is used - if so, skip image generation
    if (settings.video_loop) {
      console.log('Video loop detected, skipping image generation and going directly to audio');
      
      // Only trigger audio generation if processing audio and not using existing audio
      if (settings.process_audio !== false && !settings.use_existing_audio) {
        // Determine model version and clone voice parameters based on voice prefix
        let finalModelVersion = settings.model_version || 'lemonfox';
        let cloneVoiceName: string | undefined;
        let cloneVoiceUrl: string | undefined;
        let cloneLanguage: string | undefined;
        
        if (!settings.model_version && settings.voice) {
          if (isCoreVoice(settings.voice)) {
            finalModelVersion = 'lemonfox';
          } else if (isPremiumVoice(settings.voice)) {
            finalModelVersion = 'v7';
          } else if (isApexVoice(settings.voice)) {
            finalModelVersion = 'speechify';
          } else if (isElevenLabsVoice(settings.voice)) {
            finalModelVersion = 'elevenlabs';
          } else if (isCloneVoice(settings.voice)) {
            finalModelVersion = 'clone';
            cloneVoiceName = settings.voice.split(':')[1];
            cloneLanguage = 'english';
            
            // Check if it's a predefined clone voice
            const predefinedVoice = predefinedCloneVoices.find(v => v.name === cloneVoiceName);
            if (predefinedVoice) {
              cloneVoiceUrl = predefinedVoice.voice_id;
            } else {
              // Custom voice - use the workspace format
              cloneVoiceUrl = `default-ujsa1wysgyitfqg3ixpqka__${cloneVoiceName}`;
            }
          }
        }

        // Handle explicit clone voice parameters from settings
        if (finalModelVersion === 'clone') {
          cloneVoiceName = cloneVoiceName || settings.clone_voice_name;
          cloneVoiceUrl = cloneVoiceUrl || settings.clone_voice_url;
          cloneLanguage = cloneLanguage || settings.clone_language;
        }

        // Extract voice name from the voice parameter
        const voiceName = settings.voice && settings.voice.includes(':') ? settings.voice.split(':')[1] : settings.voice;
        
        try {
          const audioResponse = await fetch(`${supabaseUrl}/functions/v1/setup-audio-tasks`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseServiceRoleKey,
            },
            body: JSON.stringify({
              user_id: userId,
              group_id: groupId,
              file_path: storyFilePath,
              story_title: settings.story_title,
              description: settings.description,
              doc_id: storyDoc.id,
              variant: audioVariant, // Use detected audio variant
              voice: voiceName,
              language: settings.language,
              model_version: finalModelVersion,
              elevenlabs_model_id: finalModelVersion === 'elevenlabs' ? (settings.elevenlabs_model_id || DEFAULT_ELEVENLABS_MODEL_ID) : undefined,
              speed: settings.speed,
              volume: settings.volume || settings.existing_audio_volume || 1.0, // Use volume or existing_audio_volume
              preference: settings.preference,
              remove_title_chapters: settings.remove_title_chapters,
              clone_voice_name: cloneVoiceName,
              clone_voice_url: cloneVoiceUrl,
              clone_language: cloneLanguage,
              videoProcess: true,
              tab,
              pauses: settings.pauses || false
            }),
          });

          if (audioResponse.ok) {
            console.log('Successfully triggered audio generation for video loop');
          } else {
            console.error(`Failed to trigger audio generation: ${audioResponse.status}`);
            const errorText = await audioResponse.text();
            console.error('Audio error response:', errorText);
          }
        } catch (error: any) {
          console.error(`Error triggering audio generation: ${error.message}`);
        }
      } else {
        console.log('Using existing audio with video loop or audio processing disabled, skipping audio generation');
      }
      return;
    }

    // Prepare promises array for concurrent execution
    const promises: Promise<void>[] = [];

    // Handle image generation (only if processing images and not using existing images)
    // For ITV/TTV: if audio also needs generation, skip prompt setup here — compile-audio
    // will trigger setup-itv-prompts / setup-ttv-prompts after it knows the actual totalAudioDuration.
    const isITV = settings.visual_type === 'itv';
    const isTTV = settings.visual_type === 'ttv';
    const isMG  = settings.visual_type === 'mg';
    const audioNeedsGeneration = settings.process_audio !== false && !settings.use_existing_audio;
    const skipITVForAudio = isITV && audioNeedsGeneration;
    const skipTTVForAudio = isTTV && audioNeedsGeneration;
    const skipMGForAudio  = isMG  && audioNeedsGeneration;

    if (settings.process_images !== false && !settings.use_existing_images && !skipITVForAudio && !skipTTVForAudio && !skipMGForAudio) {
      const imagePromptPromise = (async () => {
        try {
          let imagePromptResponse: Response;

          if (isITV) {
            // ── ITV pipeline: call setup-itv-prompts (handles Phase 1 image prompts + Phase 2 motion prompts) ──
            // Only reached when audio already exists (use_existing_audio), so totalAudioDuration is known
            console.log('ITV visual_type detected — calling setup-itv-prompts edge function');

            // Append ITV keyframe hint to style if not already present
            const itvStyle = (settings.image_style || '').includes('keyframe')
              ? settings.image_style
              : `${settings.image_style || ''} Each image is a keyframe for an image-to-video clip, so compose each scene to suggest natural motion potential and cinematic depth.`;

            imagePromptResponse = await fetchWithDenoFallback('setup-itv-prompts', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseServiceRoleKey,
              },
              body: JSON.stringify({
                user_id: userId,
                group_id: groupId,
                file_path: storyFilePath,
                story_title: settings.story_title,
                description: settings.description,
                video_model: settings.itv_model || 'seedance15',
                clip_duration: settings.itv_duration || undefined,
                totalAudioDuration: settings.total_audio_duration,
                image_model: settings.image_model || 'seedream-4.5',
                model: settings.model || 'sonnet',
                language: settings.text_language || 'english',
                tab,
                variant: settings.variant || 1, // ITV uses its own collision check against ITV tables
                audio_clip: settings.audio_clip || false,
                useCharacterDescriptions: settings.use_character_descriptions,
                customCharactersEnabled: settings.customCharactersEnabled || false,
                customCharacters: settings.customCharacters || [],
                customCharactersAIEnhance: settings.customCharactersAIEnhance || false,
                userTokenBalance: 1000000, // High number for video process
                style: itvStyle,
                videoProcess: true,
              }),
            });
          } else if (isTTV) {
            // ── TTV pipeline: call setup-ttv-prompts (only reached when audio already exists, so totalAudioDuration is known) ──
            console.log('TTV visual_type detected — calling setup-ttv-prompts edge function');
            imagePromptResponse = await fetchWithDenoFallback('setup-ttv-prompts', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseServiceRoleKey,
              },
              body: JSON.stringify({
                user_id: userId,
                group_id: groupId,
                file_path: storyFilePath,
                story_title: settings.story_title,
                description: settings.description,
                style: settings.image_style,
                // wan22 retired from TTV; default new TTV plans to seedance_pro_fast.
                video_model: settings.video_model || 'seedance_pro_fast',
                video_duration: Number(settings.video_duration) || 4.91,
                totalAudioDuration: Number(settings.total_audio_duration) || 0,
                useCharacterDescriptions: settings.use_character_descriptions || false,
                model: settings.model || 'sonnet',
                language: settings.text_language || 'english',
                tab,
                variant: settings.variant || 1,
                userTokenBalance: 1000000,
                audio_clip: settings.audio_clip || false,
                videoProcess: true, // skip token balance check when called from pipeline
                // Custom characters
                customCharactersEnabled: settings.customCharactersEnabled || false,
                customCharacters: settings.customCharacters || [],
                customCharactersAIEnhance: settings.customCharactersAIEnhance || false,
              }),
            });
          } else if (isMG) {
            // ── MG (Motion Graphics) pipeline: call setup-mg-prompts (only reached when audio already exists, so totalAudioDuration is known) ──
            console.log('MG visual_type detected — calling setup-mg-prompts edge function');
            imagePromptResponse = await fetchWithDenoFallback('setup-mg-prompts', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseServiceRoleKey,
              },
              body: JSON.stringify({
                user_id: userId,
                group_id: groupId,
                file_path: storyFilePath,
                story_title: settings.story_title,
                description: settings.description,
                style_slug: settings.mg_style_slug,
                style_guidance: settings.mg_style_guidance || null,
                clip_duration: Number(settings.mg_clip_duration) || 10,
                totalAudioDuration: Number(settings.total_audio_duration) || 0,
                codegen_model: settings.mg_codegen_model || 'claude-opus-4-6',
                model: settings.model || 'sonnet',
                language: settings.text_language || 'english',
                tab,
                variant: settings.variant || 1,
                userTokenBalance: 1000000,
                audio_enabled: true,
                videoProcess: true,
                video_task_id: videoTaskId,
              }),
            });
          } else {
            // ── Standard image pipeline: call storyscriptai-setup-prompt ──
            imagePromptResponse = await fetchWithDenoFallback('storyscriptai-setup-prompt', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseServiceRoleKey,
              },
              body: JSON.stringify({
                user_id: userId,
                group_id: groupId,
                file_path: storyFilePath,
                story_title: settings.story_title,
                description: settings.description,
                style: settings.image_style,
                useCharacterDescriptions: settings.use_character_descriptions,
                // Handle consistent vs variable frequency modes
                firstPageFrequency: (settings.frequency_type === 'consistent') 
                  ? null 
                  : settings.first_page_frequency,
                restFrequency: (settings.frequency_type === 'consistent' && settings.consistent_frequency)
                  ? settings.consistent_frequency
                  : settings.rest_frequency,
                variant: imageVariant, // Use detected image variant
                doc_id: storyDoc.id, // Include the doc_id
                userTokenBalance: 1000000, // High number for video process
                imageModel: mapImageModelToLegacy(settings.image_model || 'gpt-image-1-mini'),
                language: settings.text_language || 'english',
                model: settings.model || 'sonnet', // NEW: Pass image prompt model
                videoProcess: true,
                tab,
                // NEW: Frequency configuration fields
                frequencyMode: settings.frequency_mode || 'wordcount',
                frequencyType: settings.frequency_type || 'variable',
                consistentFrequency: settings.consistent_frequency,
                audioDistributionType: settings.audio_distribution_type || 'consistent',
                audioFirstPageImageCount: settings.first_page_image_amount,
                audioRestImageCount: settings.rest_image_amount,
                totalAudioDuration: settings.total_audio_duration,
                imageAmount: settings.image_amount,
                audioFiles: settings.audio_files ? (typeof settings.audio_files === 'string' ? JSON.parse(settings.audio_files) : settings.audio_files) : undefined,
                // Custom characters
                customCharactersEnabled: settings.customCharactersEnabled || false,
                customCharacters: settings.customCharacters || [],
                customCharactersAIEnhance: settings.customCharactersAIEnhance || false
              }),
            });
          }

          if (imagePromptResponse.ok) {
            console.log(`Successfully triggered ${isITV ? 'ITV' : isTTV ? 'TTV' : 'image'} prompt generation`);
          } else {
            console.error(`Failed to trigger ${isITV ? 'ITV' : isTTV ? 'TTV' : 'image'} prompt generation: ${imagePromptResponse.status}`);
            const errorText = await imagePromptResponse.text();
            console.error('Image prompt error response:', errorText);
          }
        } catch (error: any) {
          console.error(`Error triggering image prompt generation: ${error.message}`);
        }
      })();
      
      promises.push(imagePromptPromise);
    } else {
      if (skipTTVForAudio) {
        console.log('TTV mode with audio generation needed — skipping TTV prompt setup here; compile-audio will trigger setup-ttv-prompts after audio duration is known');
      } else if (skipITVForAudio) {
        console.log('ITV mode with audio generation needed — skipping ITV prompt setup here; compile-audio will trigger setup-itv-prompts after audio duration is known');
      } else if (skipMGForAudio) {
        console.log('MG mode with audio generation needed — skipping MG prompt setup here; compile-audio will trigger setup-mg-prompts after audio duration is known');
      } else {
        console.log('Using existing images or image processing disabled, skipping image generation');
      }
    }

    // Handle audio generation (only if processing audio and not using existing audio)
    if (settings.process_audio !== false && !settings.use_existing_audio) {
      const audioPromise = (async () => {
        try {
          // Determine model version and clone voice parameters based on voice prefix
          let finalModelVersion = settings.model_version || 'lemonfox';
          let cloneVoiceName: string | undefined;
          let cloneVoiceUrl: string | undefined;
          let cloneLanguage: string | undefined;
          
          if (!settings.model_version && settings.voice) {
            if (isCoreVoice(settings.voice)) {
              finalModelVersion = 'lemonfox';
            } else if (isPremiumVoice(settings.voice)) {
              finalModelVersion = 'v7';
            } else if (isApexVoice(settings.voice)) {
              finalModelVersion = 'speechify';
            } else if (isElevenLabsVoice(settings.voice)) {
              finalModelVersion = 'elevenlabs';
            } else if (isCloneVoice(settings.voice)) {
              finalModelVersion = 'clone';
              cloneVoiceName = settings.voice.split(':')[1];
              cloneLanguage = 'english';
              
              // Check if it's a predefined clone voice
              const predefinedVoice = predefinedCloneVoices.find(v => v.name === cloneVoiceName);
              if (predefinedVoice) {
                cloneVoiceUrl = predefinedVoice.voice_id;
              } else {
                // Custom voice - use the workspace format
                cloneVoiceUrl = `default-ujsa1wysgyitfqg3ixpqka__${cloneVoiceName}`;
              }
            }
          }

          // Handle explicit clone voice parameters from settings
          if (finalModelVersion === 'clone') {
            cloneVoiceName = cloneVoiceName || settings.clone_voice_name;
            cloneVoiceUrl = cloneVoiceUrl || settings.clone_voice_url;
            cloneLanguage = cloneLanguage || settings.clone_language;
          }

          // Extract voice name from the voice parameter
          const voiceName = settings.voice && settings.voice.includes(':') ? settings.voice.split(':')[1] : settings.voice;

          const audioResponse = await fetch(`${supabaseUrl}/functions/v1/setup-audio-tasks`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseServiceRoleKey,
            },
            body: JSON.stringify({
              user_id: userId,
              group_id: groupId,
              file_path: storyFilePath,
              story_title: settings.story_title,
              description: settings.description,
              doc_id: storyDoc.id, // Include the doc_id
              variant: audioVariant, // Use detected audio variant
              voice: voiceName,
              language: settings.language,
              model_version: finalModelVersion,
              elevenlabs_model_id: finalModelVersion === 'elevenlabs' ? (settings.elevenlabs_model_id || DEFAULT_ELEVENLABS_MODEL_ID) : undefined,
              speed: settings.speed,
              volume: settings.volume || settings.existing_audio_volume || 1.0, // Use volume or existing_audio_volume
              preference: settings.preference,
              remove_title_chapters: settings.remove_title_chapters,
              clone_voice_name: cloneVoiceName,
              clone_voice_url: cloneVoiceUrl,
              clone_language: cloneLanguage,
              videoProcess: true,
              tab,
              pauses: settings.pauses || false
            }),
          });

          if (audioResponse.ok) {
            console.log('Successfully triggered audio generation');
          } else {
            console.error(`Failed to trigger audio generation: ${audioResponse.status}`);
            const errorText = await audioResponse.text();
            console.error('Audio error response:', errorText);
          }
        } catch (error: any) {
          console.error(`Error triggering audio generation: ${error.message}`);
        }
      })();
      
      promises.push(audioPromise);
    } else {
      console.log('Using existing audio or audio processing disabled, skipping audio generation');
    }

    // Execute all promises concurrently
    if (promises.length > 0) {
      const results = await Promise.allSettled(promises);
      
      // Log results but don't throw errors
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error(`Operation ${index} failed:`, result.reason);
        }
      });
      
      console.log(`Completed ${results.length} operations concurrently`);
    } else {
      console.log('No operations needed - using all existing content or processes disabled');
    }
   
  } catch (error: any) {
    console.error(`Error in triggerImagePromptsAndAudioAsync: ${error.message}`);
    await logError('Error triggering image prompts and audio', error);
    
    // Update video task with error
    await supabase
      .from('video_tasks')
      .update({
        image_prompt_status: 'error',
        audio_status: 'error',
        overall_status: 'error',
        error_message: `Failed to trigger content generation: ${error.message}`,
        updated_at: new Date().toISOString()
      })
      .eq('id', videoTaskId);
  }
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const requestData: SetupVideoRequest = await req.json();
    if (!auth.isServiceRole && auth.userId) {
      requestData.user_id = auth.userId;
    }
   
    const validationError = validateInputs(requestData);
    if (validationError) {
      return new Response(JSON.stringify({ error: validationError }), { status: 400, headers: responseHeaders });
    }

    const {
      user_id, group_id, story_title, description, word_count,
      language = 'english',
      model = 'sonnet', // NEW: Image prompt model with default
      story_model = 'sonnet', // NEW: Story model with default
      image_style, use_character_descriptions, first_page_frequency, rest_frequency, image_model = null,
      voice, model_version, speed, volume = 1.0, existing_audio_volume, preference, remove_title_chapters, // NEW: existing_audio_volume
      elevenlabs_model_id, // NEW: ElevenLabs model id when model_version='elevenlabs'
      clone_voice_name, clone_voice_url, clone_language,
      output_video_name,
      bg_music, // NEW: Background music
      bg_music_volume = 0.25, // NEW: Background music volume with default
      video_loop, // NEW: Video loop
      loop_time, // NEW: Loop time
      transition_type, // NEW: Transition type
      animation_type, // NEW: Animation type - no default here
      effects_type, // NEW: Effects type - no default here
      subtitles = null, // Optional subtitle burn-in config (null = no subtitles)
      variant = 1,
      use_existing_story = false,
      story_file_path,
      use_existing_images = false,
      images_folder_path,
      image_prompt_path,
      use_existing_audio = false,
      audio_file_path,
      audio_folder_path,
      // NEW: Processing control flags
      video = true, // Default TRUE
      process_story = true, // Default TRUE
      process_images = true, // Default TRUE
      process_audio = true, // Default TRUE
      tab = 1, // Default 1 - tab number for enterprise users
      // NEW: Master prompt and runtime mode
      master_prompt,
      master_prompt_enhance_ai = false,
      is_runtime_mode = false,
      runtime_minutes,
      // NEW: Frequency configuration fields
      frequency_mode = 'wordcount',
      frequency_type = 'variable',
      consistent_frequency,
      audio_distribution_type = 'consistent',
      first_page_image_amount,
      rest_image_amount,
      total_audio_duration,
      image_amount,
      audio_files,
      // TTV/ITV visual pipeline fields
      visual_type = 'image',
      video_model,
      video_style,
      video_duration,
      audio_clip = false,
      itv_model,
      itv_duration,
      process_ttv = false,
      process_itv = false,
      // MG (Motion Graphics) visual pipeline fields
      mg_style_slug,
      mg_style_guidance,
      mg_clip_duration,
      mg_codegen_model,
      process_mg = false,
      // TTV/ITV folder/prompt paths (from frontend or bridge)
      ttv_prompt_path,
      itv_video_prompt_path,
      itv_image_prompt_path,
      // Custom characters fields
      customCharactersEnabled = false,
      customCharacters = [],
      customCharactersAIEnhance = false,
      pauses = false,
      youtube_links,
      youtube_transcript_text,
      // Optional: pre-created placeholder row ID forwarded by plan-video (Quick Generate flow)
      video_task_id: incomingVideoTaskId,
    } = requestData;

    // ── Insert placeholder row immediately so the frontend can poll for it ──
    // Two-row architecture: each call to setup-video-tasks creates its own
    // `video_tasks` row. Bridges (process-image / process-audio / process-TTV
    // / process-ITV) forward all user settings via `buildForwardPayload` so
    // the row created here has subtitles, master_prompt, volume, etc.
    // populated, giving the frontend everything it needs to display correctly.
    //
    // If plan-video (Quick Generate) already inserted a placeholder row and forwarded
    // its id via `video_task_id`, reuse that same id and upsert it — otherwise we'd
    // leave the original placeholder orphaned in the table and end up with two rows
    // for the same (user, group, tab).
    const earlyVideoTaskId = incomingVideoTaskId || crypto.randomUUID();
    const reusingPlaceholder = !!incomingVideoTaskId;
    try {
      // Demote any existing main row for this (user_id, group_id, tab) before
      // upserting the new placeholder. Keeps the partial unique index
      // (video_tasks_one_main_per_tab) satisfied at all times and records
      // a breadcrumb pointing at the row that replaced it.
      // Skip rows that already match the incoming id so we don't mark our own
      // placeholder as superseded by itself.
      // See docs/is-main-migration-plan.md §3 Phase B.
      try {
        let demoteQuery = supabase
          .from('video_tasks')
          .update({ is_main: false, superseded_by: earlyVideoTaskId })
          .eq('user_id', user_id)
          .eq('group_id', group_id)
          .eq('tab', tab ?? 1)
          .eq('is_main', true);
        if (reusingPlaceholder) {
          demoteQuery = demoteQuery.neq('id', earlyVideoTaskId);
        }
        const { error: demoteError } = await demoteQuery;
        if (demoteError) {
          console.error(`[setup-video-tasks] Failed to demote previous main row: ${demoteError.message}`, demoteError);
        }
      } catch (demoteErr: any) {
        console.warn(`[setup-video-tasks] Exception demoting previous main row: ${demoteErr?.message}`);
      }

      // Upsert on `id` so a forwarded plan-video placeholder is updated in place
      // rather than rejected as a duplicate (or left orphaned alongside a new row).
      const { error: insertError } = await supabase
        .from('video_tasks')
        .upsert({
          id: earlyVideoTaskId,
          user_id,
          group_id,
          tab,
          story_title,
          description,
          is_main: true,
          superseded_by: null,
          overall_status: 'planning',
          overall_progress: 0,
          story_status: 'pending',
          image_prompt_status: 'pending',
          image_generation_status: 'pending',
          audio_status: 'pending',
          video_creation_status: 'pending',
          individual_video_status: 'pending',
          ttv_prompt_status: 'pending',
          ttv_status: 'pending',
          itv_prompt_status: 'pending',
          itv_status: 'pending',
          visual_type: visual_type || 'image',
          settings: {},
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' });
      if (insertError) {
        console.error(`[setup-video-tasks] Failed to upsert placeholder row: ${insertError.message}`, insertError);
      } else {
        console.log(`[setup-video-tasks] ${reusingPlaceholder ? 'Reused forwarded' : 'Inserted'} placeholder video_tasks row: ${earlyVideoTaskId}`);
      }
    } catch (err: any) {
      console.warn(`[setup-video-tasks] Exception upserting early placeholder row: ${err?.message}`);
    }

    // Extract just the voice name, removing any prefix (e.g., "apex:benjamin" -> "benjamin")
    const extractedVoiceName = voice && voice.includes(':') ? voice.split(':')[1] : voice;

    // Convert "none" to null for animation_type and effects_type
    const finalAnimationType = animation_type === 'none' ? null : animation_type;
    const finalEffectsType = effects_type === 'none' ? null : effects_type;

    // Handle volume for existing audio - use existing_audio_volume if provided, otherwise use volume
    const finalVolume = use_existing_audio ? (existing_audio_volume || volume || 1.0) : (volume || 1.0);

    // Fix output video name - use story title if empty or just .mp4
    const finalOutputVideoName = (!output_video_name || output_video_name === '.mp4') 
      ? `${sanitizeFilename(story_title)}.mp4`
      : output_video_name;

    // For TTV/ITV/MG: if no image_style but video_style was provided, use video_style as the style
    // This ensures the style is stored in video_tasks.image_style for downstream functions
    // Falls back to master_prompt.visualStyle or 'Cinematic realistic' for TTV/ITV/MG to prevent empty style errors downstream
    const resolvedImageStyle = image_style
      || (visual_type === 'ttv' || visual_type === 'itv' || visual_type === 'mg' ? (video_style || master_prompt?.visualStyle || 'Cinematic realistic') : '')
      || '';

    // Check if video loop is used
    const hasVideoLoop = !!video_loop;

    // Check if all required content exists for direct video creation (only if video=true)
    // For TTV/ITV/MG pipelines, image_prompt_path is not required since visual prompts are stored differently
    const isTtvOrItv = visual_type === 'ttv' || visual_type === 'itv' || visual_type === 'mg';
    const allContentExists = video && use_existing_story && (use_existing_images || hasVideoLoop) && use_existing_audio && (image_prompt_path || hasVideoLoop || isTtvOrItv);
    
    // Check if story exists but images/audio need generation
    const storyExistsButContentNeeded = use_existing_story && ((!use_existing_images && !hasVideoLoop && process_images) || (!use_existing_audio && process_audio));
   
    const estimatedTokens = word_count ? estimateTokens(word_count) : 0;

    // Detect the correct variant for the final video based on existing story_documents
    const videoVariant = await detectVideoVariant(group_id, user_id, variant);
    if (videoVariant !== variant) {
      console.log(`Video variant auto-detected: requested=${variant}, using=${videoVariant} (existing final video found for group_id=${group_id})`);
    }

    // Handle case where all content exists (original functionality)
    if (allContentExists) {
      let imageCount = 1; // Default for video loop
      
      if (!hasVideoLoop) {
        console.log(`Checking images/clips folder: ${images_folder_path}`);
        // For TTV/ITV, count .mp4 clips; for image pipelines, count .png images
        const isTtvItv = visual_type === 'ttv' || visual_type === 'itv' || visual_type === 'mg';
        try {
          if (isTtvItv) {
            imageCount = await countVideoClipsInFolder(images_folder_path!);
          } else {
            imageCount = await countImagesInFolder(images_folder_path!);
          }
        } catch (error: any) {
          console.error('Error counting folder contents:', error);
          return new Response(JSON.stringify({
            error: `Failed to access folder: ${error.message}`,
            folder_path: images_folder_path
          }), { status: 400, headers: responseHeaders });
        }

        if (imageCount === 0) {
          const contentType = isTtvItv ? 'video clips (.mp4)' : 'numbered images (1.png, 2.png, etc.)';
          return new Response(JSON.stringify({
            error: `No ${contentType} found in the specified folder`,
            folder_path: images_folder_path
          }), { status: 400, headers: responseHeaders });
        }

        console.log(`Found ${imageCount} ${isTtvItv ? 'clips' : 'images'} in folder ${images_folder_path}`);
      } else {
        console.log('Using video loop, setting image count to 1');
      }

      // Determine model version and clone voice parameters based on voice prefix if not provided
      let finalModelVersion = model_version || 'lemonfox';
      let cloneVoiceName: string | undefined;
      let cloneVoiceUrl: string | undefined;
      let cloneLanguage: string | undefined;
      
      if (!model_version && voice) {
        if (isCoreVoice(voice)) {
          finalModelVersion = 'lemonfox';
        } else if (isPremiumVoice(voice)) {
          finalModelVersion = 'v7';
        } else if (isApexVoice(voice)) {
          finalModelVersion = 'speechify';
        } else if (isElevenLabsVoice(voice)) {
          finalModelVersion = 'elevenlabs';
        } else if (isCloneVoice(voice)) {
          finalModelVersion = 'clone';
          cloneVoiceName = voice.split(':')[1];
          cloneLanguage = 'english';
          
          // Check if it's a predefined clone voice
          const predefinedVoice = predefinedCloneVoices.find(v => v.name === cloneVoiceName);
          if (predefinedVoice) {
            cloneVoiceUrl = predefinedVoice.voice_id;
          } else {
            // Custom voice - use the workspace format
            cloneVoiceUrl = `default-ujsa1wysgyitfqg3ixpqka__${cloneVoiceName}`;
          }
        }
      }

      // Handle explicit clone voice parameters from request
      if (finalModelVersion === 'clone') {
        cloneVoiceName = cloneVoiceName || clone_voice_name;
        cloneVoiceUrl = cloneVoiceUrl || clone_voice_url;
        cloneLanguage = cloneLanguage || clone_language;
      }

      // NEW: Calculate transition batch progress for existing content
      const transitionBatchProgress = calculateTransitionBatchProgress(imageCount, transition_type, visual_type);
      console.log('Calculated transition batch progress for existing content:', transitionBatchProgress);

      // NEW: Query for document IDs when using existing content
      let storyDocumentId = null;
      let imagePromptDocumentId = null;
      let imageFolderDocumentId = null;
      let audioDocumentId = null;
      // May be overridden by audio_clip value stored in the TTV/ITV folder document
      let resolvedAudioClip = audio_clip;
      // May be overridden by audio_duration stored in the audio document
      let resolvedAudioDuration = total_audio_duration;
      // May be overridden by image_model stored in the image prompt document
      const validImageModels = ['flux-2-dev', 'grok-imagine-image', 'imagen-4-fast', 'gpt-image-1-mini', 'seedream-4.5', 'imagen-4-ultra', 'nano-banana-pro'];
      let resolvedImageModel: string | null = (image_model && validImageModels.includes(image_model)) ? image_model : null;

      if (use_existing_story && story_file_path) {
        const { data: storyDocData } = await supabase
          .from('story_documents')
          .select('id')
          .eq('file_path', story_file_path)
          .eq('user_id', user_id)
          .single();
        if (storyDocData) {
          storyDocumentId = storyDocData.id;
          console.log(`Found story document ID: ${storyDocumentId}`);
        }
      }

      if (use_existing_images && image_prompt_path) {
        const { data: imagePromptDocData } = await supabase
          .from('story_documents')
          .select('id, image_model')
          .eq('file_path', image_prompt_path)
          .eq('user_id', user_id)
          .single();
        if (imagePromptDocData) {
          imagePromptDocumentId = imagePromptDocData.id;
          console.log(`Found image prompt document ID: ${imagePromptDocumentId}`);
          // Auto-fill image_model from stored document if not supplied or invalid
          if (!resolvedImageModel && imagePromptDocData.image_model && validImageModels.includes(imagePromptDocData.image_model)) {
            resolvedImageModel = imagePromptDocData.image_model;
            console.log(`Auto-filled image_model=${resolvedImageModel} from image prompt document`);
          }
        }
      }

      if (use_existing_images && images_folder_path) {
        const { data: imageFolderDocData } = await supabase
          .from('story_documents')
          .select('id, audio_clip')
          .eq('file_path', images_folder_path)
          .eq('user_id', user_id)
          .single();
        if (imageFolderDocData) {
          imageFolderDocumentId = imageFolderDocData.id;
          console.log(`Found image folder document ID: ${imageFolderDocumentId}`);
          // Auto-detect audio_clip from the stored TTV/ITV folder document
          if (imageFolderDocData.audio_clip !== null && imageFolderDocData.audio_clip !== undefined) {
            resolvedAudioClip = imageFolderDocData.audio_clip;
            console.log(`Auto-detected audio_clip=${resolvedAudioClip} from folder document`);
          }
        }
      }

      if (use_existing_audio && (audio_file_path || audio_folder_path)) {
        const audioPath = audio_folder_path || audio_file_path;
        const { data: audioDocData } = await supabase
          .from('story_documents')
          .select('id, audio_duration')
          .eq('file_path', audioPath)
          .eq('user_id', user_id)
          .single();
        if (audioDocData) {
          audioDocumentId = audioDocData.id;
          console.log(`Found audio document ID: ${audioDocumentId}`);
          if (audioDocData.audio_duration) {
            resolvedAudioDuration = parseFloat(audioDocData.audio_duration);
            console.log(`Auto-detected total_audio_duration=${resolvedAudioDuration}s from audio document`);
          }
        }
      }

      // For ITV/TTV: resolve prompt document IDs from explicit paths or from the original video_tasks row
      let resolvedItvVideoPromptDocId: string | null = null;
      let resolvedItvImagePromptDocId: string | null = null;
      let resolvedTtvPromptDocId: string | null = null;

      if (visual_type === 'itv') {
        // 1. Try to resolve from explicit paths (sent by frontend folder mode)
        if (itv_video_prompt_path) {
          const { data: itvPromptDoc } = await supabase
            .from('story_documents')
            .select('id')
            .eq('file_path', itv_video_prompt_path)
            .eq('user_id', user_id)
            .single();
          if (itvPromptDoc) {
            resolvedItvVideoPromptDocId = itvPromptDoc.id;
            console.log(`Found ITV video prompt document ID from path: ${resolvedItvVideoPromptDocId}`);
          }
        }
        if (itv_image_prompt_path) {
          const { data: itvImgPromptDoc } = await supabase
            .from('story_documents')
            .select('id')
            .eq('file_path', itv_image_prompt_path)
            .eq('user_id', user_id)
            .single();
          if (itvImgPromptDoc) {
            resolvedItvImagePromptDocId = itvImgPromptDoc.id;
            console.log(`Found ITV image prompt document ID from path: ${resolvedItvImagePromptDocId}`);
          }
        }
        // 2. Fallback: look up from the original video_tasks row (bridge re-entry path)
        if (!resolvedItvVideoPromptDocId) {
          const { data: existingVt } = await supabase
            .from('video_tasks')
            .select('itv_video_prompt_document_id, itv_image_prompt_document_id')
            .eq('group_id', group_id)
            .eq('user_id', user_id)
            .eq('visual_type', 'itv')
            .not('itv_video_prompt_document_id', 'is', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (existingVt) {
            resolvedItvVideoPromptDocId = resolvedItvVideoPromptDocId || existingVt.itv_video_prompt_document_id;
            resolvedItvImagePromptDocId = resolvedItvImagePromptDocId || existingVt.itv_image_prompt_document_id;
            console.log(`Retrieved ITV prompt doc IDs from existing video_tasks: video_prompt=${resolvedItvVideoPromptDocId}, image_prompt=${resolvedItvImagePromptDocId}`);
          } else {
            console.log('No existing video_tasks row found with ITV prompt doc IDs');
          }
        }
      } else if (visual_type === 'ttv') {
        // 1. Try to resolve from explicit path (sent by frontend folder mode)
        if (ttv_prompt_path) {
          const { data: ttvPromptDoc } = await supabase
            .from('story_documents')
            .select('id')
            .eq('file_path', ttv_prompt_path)
            .eq('user_id', user_id)
            .single();
          if (ttvPromptDoc) {
            resolvedTtvPromptDocId = ttvPromptDoc.id;
            console.log(`Found TTV prompt document ID from path: ${resolvedTtvPromptDocId}`);
          }
        }
        // 2. Fallback: look up from the original video_tasks row (bridge re-entry path)
        if (!resolvedTtvPromptDocId) {
          const { data: existingVt } = await supabase
            .from('video_tasks')
            .select('ttv_prompt_document_id')
            .eq('group_id', group_id)
            .eq('user_id', user_id)
            .eq('visual_type', 'ttv')
            .not('ttv_prompt_document_id', 'is', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (existingVt) {
            resolvedTtvPromptDocId = existingVt.ttv_prompt_document_id;
            console.log(`Retrieved TTV prompt doc ID from existing video_tasks: ${resolvedTtvPromptDocId}`);
          } else {
            console.log('No existing video_tasks row found with TTV prompt doc ID');
          }
        }
      }

      // Upsert main video task (overwrites the early placeholder row)
      const mainVideoTaskId = earlyVideoTaskId;
      const gcVersion = await assignGcVersion();
      console.log(`Assigned gc_version ${gcVersion} for video task ${mainVideoTaskId}`);
      const mainVideoTask = {
        id: mainVideoTaskId,
        user_id,
        group_id,
        story_title,
        description,
        text_language: language,
        story_model: story_model, // NEW: Story model
        model: model, // NEW: Image prompt model
        master_prompt: null, // Will be set after story generation if master prompt is used
        gc_version: gcVersion,
        
        // NEW: Document ID tracking
        story_document_id: storyDocumentId,
        image_prompt_document_id: imagePromptDocumentId,
        image_folder_document_id: imageFolderDocumentId,
        audio_document_id: audioDocumentId,
        settings: {
          word_count: word_count || 0,
          image_style: resolvedImageStyle,
          use_character_descriptions: use_character_descriptions || false,
          first_page_frequency: first_page_frequency || 0,
          rest_frequency: rest_frequency || 0,
          image_model: resolvedImageModel || 'gpt-image-1-mini',
          voice: extractedVoiceName,
          language: 'en',
          model_version: finalModelVersion,
          elevenlabs_model_id: finalModelVersion === 'elevenlabs' ? (elevenlabs_model_id || DEFAULT_ELEVENLABS_MODEL_ID) : undefined,
          speed: speed || 1.0,
          volume: finalVolume, // Use finalVolume for existing audio
          preference: preference || 'merged',
          remove_title_chapters: remove_title_chapters || false,
          clone_voice_name: cloneVoiceName,
          clone_voice_url: cloneVoiceUrl,
          clone_language: cloneLanguage,
          output_video_name: finalOutputVideoName,
          bg_music, // NEW: Background music in settings
          bg_music_volume, // NEW: Background music volume in settings
          video_loop, // NEW: Video loop in settings
          loop_time, // NEW: Loop time in settings
          transition_type, // NEW: Transition type in settings
          animation_type: finalAnimationType, // NEW: Animation type in settings (null for "none")
          effects_type: finalEffectsType, // NEW: Effects type in settings (null for "none")
          text_language: language, // NEW: Text language in settings
          story_model: story_model, // NEW: Story model in settings
          model: model, // NEW: Image prompt model in settings
          use_existing_story,
          story_file_path,
          use_existing_images,
          images_folder_path,
          image_prompt_path,
          use_existing_audio,
          audio_file_path,
          audio_folder_path, // Include both for flexibility
          story_title,
          description,
          // NEW: Processing control flags in settings
          video,
          process_story,
          process_images,
          process_audio,
          // NEW: Skipped process indicators
          story_skipped: !process_story,
          images_skipped: !process_images,
          audio_skipped: !process_audio,
          // Custom characters
          customCharactersEnabled,
          customCharacters,
          customCharactersAIEnhance,
        },
       
        // Video-specific settings
        image_style: resolvedImageStyle,
        use_character_descriptions: use_character_descriptions || false,
        first_page_frequency: first_page_frequency || 0,
        rest_frequency: rest_frequency || 0,
        image_model: resolvedImageModel || 'gpt-image-1-mini',
       
        // Audio settings
        voice: extractedVoiceName,
        language: 'en',
        model_version: finalModelVersion,
        speed: speed || 1.0,
        volume: finalVolume, // Use finalVolume for existing audio
        preference: preference || 'merged',
        remove_title_chapters: remove_title_chapters || false,
       
        // Clone voice fields
        is_clone_voice: finalModelVersion === 'clone',
        clone_voice_name: finalModelVersion === 'clone' ? cloneVoiceName : null,
        clone_voice_url: finalModelVersion === 'clone' ? cloneVoiceUrl : null,
        clone_language: finalModelVersion === 'clone' ? cloneLanguage : null,
       
        // Video settings
        output_video_name: finalOutputVideoName,
        bg_music: bg_music || null, // NEW: Background music
        bg_music_volume: bg_music_volume, // NEW: Background music volume
        video_loop: video_loop || null, // NEW: Video loop
        loop_time: loop_time || null, // NEW: Loop time
        transition_type: transition_type || null, // NEW: Transition type
        subtitles: subtitles || null, // Optional subtitle burn-in config (null = no subtitles)
        animation_type: finalAnimationType, // NEW: Animation type (null for "none")
        effects_type: finalEffectsType, // NEW: Effects type (null for "none")
       
        // Tab support
        tab, // Tab number for enterprise users
       
        // File paths for existing content
        story_file_path: use_existing_story ? story_file_path : null,
       
        variant: videoVariant,
       
        // Batch info will be set by calculate-video-durations function
        // No batch fields on main task
       
        // Progress tracking - Reset to 0 initially
        story_progress: 100,
        image_prompt_progress: hasVideoLoop ? 100 : 100,
        image_generation_progress: hasVideoLoop ? 100 : 100,
        audio_progress: 100,
        video_creation_progress: 0,
        individual_video_progress: 0,
        overall_progress: 80, // Ready for video processing
       
        // Status tracking - all existing content is completed, use 'completed' not 'completed_final'
        story_status: 'completed',
        image_prompt_status: hasVideoLoop ? 'completed' : 'completed',
        image_generation_status: hasVideoLoop ? 'completed' : 'completed',
        audio_status: 'completed', // Use 'completed' not 'completed_final'
        individual_video_status: 'pending',
        video_creation_status: video ? 'running' : 'completed', // NEW: Set based on video flag
        overall_status: video ? 'running' : 'completed', // NEW: Set based on video flag
       
        // Additional tracking fields
        total_individual_videos: imageCount,
        completed_individual_videos: 0,
       
        // Individual processing tracking
        current_image_number: null,

        // NEW: Set transition batch progress
        transition_batch_progress: transitionBatchProgress,

        // NEW: Processing control flags
        video,
        process_story,
        process_images,
        process_audio,
        process_ttv,
        process_itv,
        process_mg,

        // TTV/ITV/MG visual pipeline fields
        visual_type: visual_type || 'image',
        video_model: video_model || null,
        video_duration: video_duration || null,
        audio_clip: resolvedAudioClip,
        itv_model: itv_model || null,
        itv_duration: itv_duration || null,

        // MG configuration columns (no-op when visual_type !== 'mg')
        mg_style_slug: visual_type === 'mg' ? (mg_style_slug || null) : null,
        mg_style_guidance: visual_type === 'mg' ? (mg_style_guidance || null) : null,
        mg_clip_duration: visual_type === 'mg' ? (Number(mg_clip_duration) || 10) : null,
        mg_codegen_model: visual_type === 'mg' ? (mg_codegen_model || 'claude-opus-4-6') : null,

        // MG status/progress — completed (not applicable) for non-MG, or completed if existing content
        mg_prompt_status: 'completed',
        mg_prompt_progress: visual_type === 'mg' ? 100 : 0,
        mg_status: 'completed',
        mg_progress: visual_type === 'mg' ? 100 : 0,

        // TTV status/progress - completed (not applicable) for non-TTV, or completed if existing content
        ttv_prompt_status: visual_type === 'ttv' ? 'completed' : 'completed',
        ttv_prompt_progress: visual_type === 'ttv' ? 100 : 0,
        ttv_status: visual_type === 'ttv' ? 'completed' : 'completed',
        ttv_progress: visual_type === 'ttv' ? 100 : 0,
        // Populate TTV document IDs from the looked-up image prompt / folder document IDs
        ttv_prompt_document_id: visual_type === 'ttv' ? (imagePromptDocumentId || resolvedTtvPromptDocId) : null,
        ttv_folder_document_id: visual_type === 'ttv' ? imageFolderDocumentId : null,

        // ITV status/progress - completed (not applicable) for non-ITV, or completed if existing content
        itv_prompt_status: visual_type === 'itv' ? 'completed' : 'completed',
        itv_prompt_progress: visual_type === 'itv' ? 100 : 0,
        itv_status: visual_type === 'itv' ? 'completed' : 'completed',
        itv_progress: visual_type === 'itv' ? 100 : 0,
        itv_image_prompt_document_id: visual_type === 'itv' ? (imagePromptDocumentId || resolvedItvImagePromptDocId) : null,
        itv_video_prompt_document_id: visual_type === 'itv' ? resolvedItvVideoPromptDocId : null,
        // Populate ITV clip folder document ID from the looked-up image folder document ID
        itv_video_folder_document_id: visual_type === 'itv' ? imageFolderDocumentId : null,

        // NEW: Frequency configuration fields for image prompts
        frequency_mode: frequency_mode || 'wordcount',
        frequency_type: frequency_type || 'variable',
        consistent_frequency: consistent_frequency || null,
        audio_distribution_type: audio_distribution_type || 'consistent',
        first_page_image_amount: first_page_image_amount || null,
        rest_image_amount: rest_image_amount || null,
        total_audio_duration: resolvedAudioDuration || null,
        // For existing-content runs imageCount is the real folder count — write it to
        // image_amount so the polling UI has an accurate number from the very first second
        // (process-ttv-task / process-itv-task will overwrite it with the exact count later).
        image_amount: image_amount || imageCount || null,
        audio_files: audio_files ? JSON.stringify(audio_files) : null,

        pauses: pauses || false,
       
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      // Insert/upsert main video task (overwrites any pre-created placeholder row)
      const { data: insertedMainTask, error: insertMainError } = await supabase
        .from('video_tasks')
        .upsert(mainVideoTask, { onConflict: 'id' })
        .select()
        .single();

      if (insertMainError) {
        throw new Error(`Failed to create main video task: ${insertMainError.message}`);
      }

      // Only trigger video processing if video=true
      if (video) {
        console.log(`Created main video task ${mainVideoTaskId} - triggering duration calculation`);

        // Fire and forget - trigger duration calculation asynchronously
        // This will calculate durations, create batch rows, and start processing
        triggerDurationCalculationAsync(mainVideoTaskId, user_id, group_id, tab);
      } else {
        console.log(`Created main video task ${mainVideoTaskId} with video=false - no batch tasks created`);
      }

      // Return immediately without waiting for the processing to start
      return new Response(JSON.stringify({
        video_task_id: mainVideoTaskId,
        estimated_tokens: estimatedTokens,
        next_step: video ? 'duration calculation and batch processing will start shortly' : 'processing completed - no video creation',
        message: video 
          ? (hasVideoLoop 
            ? `Video task created with video loop. Duration calculation will begin automatically.`
            : `Video task created with ${imageCount} images. Duration calculation and batch allocation will begin automatically.`)
          : `Task created without video creation. All content is available for use.`,
        settings: {
          use_existing_story,
          use_existing_images,
          use_existing_audio,
          has_image_prompt_path: !!image_prompt_path,
          has_background_music: !!bg_music, // NEW: Background music status
          bg_music_volume: bg_music_volume, // NEW: Background music volume
          has_video_loop: hasVideoLoop, // NEW: Video loop status
          loop_time: loop_time, // NEW: Loop time
          transition_type: transition_type, // NEW: Transition type
          animation_type: finalAnimationType, // NEW: Animation type (null for "none")
          effects_type: finalEffectsType, // NEW: Effects type (null for "none")
          text_language: language, // NEW: Text language
          story_model: story_model, // NEW: Story model
          volume: finalVolume, // Use finalVolume for existing audio
          model: model, // NEW: Image prompt model
          voice: extractedVoiceName, // Return the extracted voice name
          image_count: imageCount,
          batch_tasks_created: 0, // Will be created by duration calculation
          audio_format: finalModelVersion === 'v7' || finalModelVersion === 'speechify' || finalModelVersion === 'elevenlabs' ? 'mp3' : 'wav',
          model_version: finalModelVersion,
          output_video_name: finalOutputVideoName,
          transition_batch_progress: transitionBatchProgress, // NEW: Include in response
          // NEW: Processing control flags
          video,
          process_story,
          process_images,
          process_audio,
          // NEW: Clone voice details
          clone_voice_name: cloneVoiceName,
          clone_voice_url: cloneVoiceUrl,
          clone_language: cloneLanguage
        }
      }), { status: 200, headers: responseHeaders });
    }

    // Handle case where story exists but images/audio need generation
    else if (storyExistsButContentNeeded) {
      console.log('Creating video task for existing story with content generation needed...');

      // Verify the story file exists
      try {
        const { data: fileData, error: fileError } = await supabase.storage
          .from('stories')
          .download(story_file_path!);

        if (fileError) {
          throw new Error(`Story file not found: ${fileError.message}`);
        }

        console.log(`Verified story file exists: ${story_file_path}`);
      } catch (error: any) {
        return new Response(JSON.stringify({
          error: `Failed to access story file: ${error.message}`,
          story_file_path: story_file_path
        }), { status: 400, headers: responseHeaders });
      }

      // Determine model version and clone voice parameters based on voice prefix if not provided
      let finalModelVersion = model_version || 'lemonfox';
      let cloneVoiceName: string | undefined;
      let cloneVoiceUrl: string | undefined;
      let cloneLanguage: string | undefined;
      
      if (!model_version && voice) {
        if (isCoreVoice(voice)) {
          finalModelVersion = 'lemonfox';
        } else if (isPremiumVoice(voice)) {
          finalModelVersion = 'v7';
        } else if (isApexVoice(voice)) {
          finalModelVersion = 'speechify';
        } else if (isElevenLabsVoice(voice)) {
          finalModelVersion = 'elevenlabs';
        } else if (isCloneVoice(voice)) {
          finalModelVersion = 'clone';
          cloneVoiceName = voice.split(':')[1];
          cloneLanguage = 'english';
          
          // Check if it's a predefined clone voice
          const predefinedVoice = predefinedCloneVoices.find(v => v.name === cloneVoiceName);
          if (predefinedVoice) {
            cloneVoiceUrl = predefinedVoice.voice_id;
          } else {
            // Custom voice - use the workspace format
            cloneVoiceUrl = `default-ujsa1wysgyitfqg3ixpqka__${cloneVoiceName}`;
          }
        }
      }

      // Handle explicit clone voice parameters from request
      if (finalModelVersion === 'clone') {
        cloneVoiceName = cloneVoiceName || clone_voice_name;
        cloneVoiceUrl = cloneVoiceUrl || clone_voice_url;
        cloneLanguage = cloneLanguage || clone_language;
      }

      // NEW: For existing images, try to count them to estimate transition batches
      let estimatedImageCount = 1; // Default
      if ((visual_type === 'ttv' || visual_type === 'itv') && !hasVideoLoop) {
        // TTV/ITV: estimate clip count from audio duration / clip duration
        const clipDur = visual_type === 'itv' ? (itv_duration || 5) : (video_duration || 8);
        const estAudioDur = total_audio_duration || (word_count ? (word_count * 60 / 125) : 300);
        estimatedImageCount = Math.max(1, Math.ceil(estAudioDur / clipDur));
        console.log(`TTV/ITV estimated clip count: ${estimatedImageCount} (audioDur=${estAudioDur}, clipDur=${clipDur})`);
      } else if (use_existing_images && images_folder_path) {
        try {
          estimatedImageCount = await countImagesInFolder(images_folder_path);
          console.log(`Found ${estimatedImageCount} existing images for transition estimation`);
        } catch (error: any) {
          console.warn('Could not count existing images, using default estimate:', error.message);
          // Use a reasonable estimate based on word count
          estimatedImageCount = word_count ? Math.ceil(word_count / 100) : 10;
        }
      } else if (!hasVideoLoop && process_images) {
        // Estimate based on word count if no existing images
        estimatedImageCount = word_count ? Math.ceil(word_count / 100) : 10;
      }

      // NEW: Calculate transition batch progress for mixed content
      const transitionBatchProgress = calculateTransitionBatchProgress(estimatedImageCount, transition_type, visual_type);
      console.log('Calculated transition batch progress for mixed content:', transitionBatchProgress);

      // NEW: Query for document IDs when using existing content
      let storyDocumentId = null;
      let imagePromptDocumentId = null;
      let imageFolderDocumentId = null;
      let audioDocumentId = null;
      // May be overridden by audio_clip value stored in the TTV/ITV folder document
      let resolvedAudioClip = audio_clip;
      // May be overridden by audio_duration stored in the audio document
      let resolvedAudioDuration = total_audio_duration;

      if (use_existing_story && story_file_path) {
        const { data: storyDocData } = await supabase
          .from('story_documents')
          .select('id')
          .eq('file_path', story_file_path)
          .eq('user_id', user_id)
          .single();
        if (storyDocData) {
          storyDocumentId = storyDocData.id;
          console.log(`Found story document ID: ${storyDocumentId} for existing story`);
        }
      }

      if (use_existing_images && image_prompt_path) {
        const { data: imagePromptDocData } = await supabase
          .from('story_documents')
          .select('id')
          .eq('file_path', image_prompt_path)
          .eq('user_id', user_id)
          .single();
        if (imagePromptDocData) {
          imagePromptDocumentId = imagePromptDocData.id;
          console.log(`Found image prompt document ID: ${imagePromptDocumentId}`);
        }
      }

      if (use_existing_images && images_folder_path) {
        const { data: imageFolderDocData } = await supabase
          .from('story_documents')
          .select('id, audio_clip')
          .eq('file_path', images_folder_path)
          .eq('user_id', user_id)
          .single();
        if (imageFolderDocData) {
          imageFolderDocumentId = imageFolderDocData.id;
          console.log(`Found image folder document ID: ${imageFolderDocumentId}`);
          // Auto-detect audio_clip from the stored TTV/ITV folder document
          if (imageFolderDocData.audio_clip !== null && imageFolderDocData.audio_clip !== undefined) {
            resolvedAudioClip = imageFolderDocData.audio_clip;
            console.log(`Auto-detected audio_clip=${resolvedAudioClip} from folder document`);
          }
        }
      }

      if (use_existing_audio && (audio_file_path || audio_folder_path)) {
        const audioPath = audio_folder_path || audio_file_path;
        const { data: audioDocData } = await supabase
          .from('story_documents')
          .select('id, audio_duration')
          .eq('file_path', audioPath)
          .eq('user_id', user_id)
          .single();
        if (audioDocData) {
          audioDocumentId = audioDocData.id;
          console.log(`Found audio document ID: ${audioDocumentId}`);
          if (audioDocData.audio_duration) {
            resolvedAudioDuration = parseFloat(audioDocData.audio_duration);
            console.log(`Auto-detected total_audio_duration=${resolvedAudioDuration}s from audio document`);
          }
        }
      }

      // Upsert main video task (overwrites the early placeholder row)
      const mainVideoTaskId = earlyVideoTaskId;
      const gcVersion = await assignGcVersion();
      console.log(`Assigned gc_version ${gcVersion} for video task ${mainVideoTaskId}`);
      const mainVideoTask = {
        id: mainVideoTaskId,
        user_id,
        group_id,
        story_title,
        description,
        text_language: language,
        story_model: story_model, // NEW: Story model
        model: model, // NEW: Image prompt model
        master_prompt: null, // Will be set after story generation if master prompt is used
        gc_version: gcVersion,
        
        // NEW: Document ID tracking
        story_document_id: storyDocumentId,
        image_prompt_document_id: imagePromptDocumentId,
        image_folder_document_id: imageFolderDocumentId,
        audio_document_id: audioDocumentId,
        settings: {
          word_count: word_count || 0,
          image_style: resolvedImageStyle,
          use_character_descriptions: use_character_descriptions || false,
          first_page_frequency: first_page_frequency || 0,
          rest_frequency: rest_frequency || 0,
          image_model: image_model || 'gpt-image-1-mini',
          voice: extractedVoiceName,
          language: 'en',
          model_version: finalModelVersion,
          elevenlabs_model_id: finalModelVersion === 'elevenlabs' ? (elevenlabs_model_id || DEFAULT_ELEVENLABS_MODEL_ID) : undefined,
          speed: speed || 1.0,
          volume: finalVolume, // Use finalVolume for existing audio
          preference: preference || 'merged',
          remove_title_chapters: remove_title_chapters || false,
          clone_voice_name: cloneVoiceName,
          clone_voice_url: cloneVoiceUrl,
          clone_language: cloneLanguage,
          output_video_name: finalOutputVideoName,
          bg_music, // NEW: Background music in settings
          bg_music_volume, // NEW: Background music volume in settings
          video_loop, // NEW: Video loop in settings
          loop_time, // NEW: Loop time in settings
          transition_type, // NEW: Transition type in settings
          animation_type: finalAnimationType, // NEW: Animation type in settings (null for "none")
          effects_type: finalEffectsType, // NEW: Effects type in settings (null for "none")
          text_language: language, // NEW: Text language in settings
          story_model: story_model, // NEW: Story model in settings
          model: model, // NEW: Image prompt model in settings
          use_existing_story,
          story_file_path,
          use_existing_images,
          images_folder_path,
          image_prompt_path,
          use_existing_audio,
          audio_file_path,
          audio_folder_path,
          story_title,
          description,
          // NEW: Processing control flags in settings
          video,
          process_story,
          process_images,
          process_audio,
          // NEW: Skipped process indicators
          story_skipped: !process_story,
          images_skipped: !process_images,
          audio_skipped: !process_audio,
          // Custom characters
          customCharactersEnabled,
          customCharacters,
          customCharactersAIEnhance,
        },
       
        // Video-specific settings
        image_style: resolvedImageStyle,
        use_character_descriptions: use_character_descriptions || false,
        first_page_frequency: first_page_frequency || 0,
        rest_frequency: rest_frequency || 0,
        image_model: image_model || 'gpt-image-1-mini',
       
        // Audio settings
        voice: extractedVoiceName,
        language: 'en',
        model_version: finalModelVersion,
        speed: speed || 1.0,
        volume: finalVolume, // Use finalVolume for existing audio
        preference: preference || 'merged',
        remove_title_chapters: remove_title_chapters || false,
       
        // Clone voice fields
        is_clone_voice: finalModelVersion === 'clone',
        clone_voice_name: finalModelVersion === 'clone' ? cloneVoiceName : null,
        clone_voice_url: finalModelVersion === 'clone' ? cloneVoiceUrl : null,
        clone_language: finalModelVersion === 'clone' ? cloneLanguage : null,
       
        // Video settings
        output_video_name: finalOutputVideoName,
        bg_music: bg_music || null, // NEW: Background music
        bg_music_volume: bg_music_volume, // NEW: Background music volume
        video_loop: video_loop || null, // NEW: Video loop
        loop_time: loop_time || null, // NEW: Loop time
        transition_type: transition_type || null, // NEW: Transition type
        subtitles: subtitles || null, // Optional subtitle burn-in config (null = no subtitles)
        animation_type: finalAnimationType, // NEW: Animation type (null for "none")
        effects_type: finalEffectsType, // NEW: Effects type (null for "none")
       
        // Tab support
        tab, // Tab number for enterprise users
       
        // File paths for existing content
        story_file_path,
       
        variant: videoVariant,
       
        // Batch processing fields - will be updated when content is ready
        batch_size: 3, // CHANGED: from 4 to 3
        processing_batch_start: null,
        processing_batch_end: null,
        current_batch_number: null,
       
        // Progress tracking - Story is done, others depend on what needs generation
        story_progress: 100,
        image_prompt_progress: (use_existing_images || hasVideoLoop || !process_images || visual_type === 'ttv') ? 100 : 0,
        image_generation_progress: (use_existing_images || hasVideoLoop || !process_images || visual_type === 'ttv') ? 100 : 0,
        audio_progress: (use_existing_audio || !process_audio) ? 100 : 0,
        video_creation_progress: 0,
        individual_video_progress: 0,

        // NEW: Frequency configuration fields for image prompts
        frequency_mode: frequency_mode || 'wordcount',
        frequency_type: frequency_type || 'variable',
        consistent_frequency: consistent_frequency || null,
        audio_distribution_type: audio_distribution_type || 'consistent',
        first_page_image_amount: first_page_image_amount || null,
        rest_image_amount: rest_image_amount || null,
        total_audio_duration: resolvedAudioDuration || null,
        // For TTV/ITV generate runs, store the upfront estimated clip count so the polling
        // UI has a reasonable number immediately. process-ttv-task / process-itv-task will
        // overwrite image_amount with the exact count once clips are ready.
        image_amount: image_amount || (isTtvOrItv ? estimatedImageCount : null),
        audio_files: audio_files ? JSON.stringify(audio_files) : null,
        overall_progress: 25, // Story is complete (25%)
       
        // Status tracking - Mixed based on what exists and what's being processed
        story_status: 'completed',
        image_prompt_status: (use_existing_images || hasVideoLoop || !process_images || visual_type === 'ttv') ? 'completed' : (visual_type === 'itv' ? 'pending' : 'running'),
        image_generation_status: (use_existing_images || hasVideoLoop || !process_images || visual_type === 'ttv') ? 'completed' : 'pending',
        audio_status: (use_existing_audio || !process_audio) ? 'completed' : 'running',
        individual_video_status: 'pending',
        video_creation_status: 'pending',
        overall_status: 'running', // Content generation is starting
       
        // Additional tracking fields - will be updated when content is ready
        total_individual_videos: null,
        completed_individual_videos: 0,
       
        // Individual processing tracking
        current_image_number: null,

        // NEW: Set transition batch progress (estimated, will be updated later)
        transition_batch_progress: transitionBatchProgress,

        // NEW: Processing control flags
        video,
        process_story,
        process_images,
        process_audio,
        process_ttv,
        process_itv,
        process_mg,

        // TTV/ITV/MG visual pipeline fields
        visual_type: visual_type || 'image',
        video_model: video_model || null,
        video_duration: video_duration || null,
        audio_clip: resolvedAudioClip,
        itv_model: itv_model || null,
        itv_duration: itv_duration || null,

        // MG configuration columns
        mg_style_slug: visual_type === 'mg' ? (mg_style_slug || null) : null,
        mg_style_guidance: visual_type === 'mg' ? (mg_style_guidance || null) : null,
        mg_clip_duration: visual_type === 'mg' ? (Number(mg_clip_duration) || 10) : null,
        mg_codegen_model: visual_type === 'mg' ? (mg_codegen_model || 'claude-opus-4-6') : null,

        // MG status/progress
        mg_prompt_status: visual_type === 'mg' ? 'pending' : 'completed',
        mg_prompt_progress: 0,
        mg_status: visual_type === 'mg' ? 'pending' : 'completed',
        mg_progress: 0,
        mg_prompt_document_id: null,
        mg_folder_document_id: null,

        // TTV status/progress
        ttv_prompt_status: visual_type === 'ttv' ? 'pending' : 'completed',
        ttv_prompt_progress: 0,
        ttv_status: visual_type === 'ttv' ? 'pending' : 'completed',
        ttv_progress: 0,
        ttv_prompt_document_id: null,
        ttv_folder_document_id: null,

        // ITV status/progress
        itv_prompt_status: visual_type === 'itv' ? 'pending' : 'completed',
        itv_prompt_progress: 0,
        itv_status: visual_type === 'itv' ? 'pending' : 'completed',
        itv_progress: 0,
        itv_image_prompt_document_id: null,
        itv_video_prompt_document_id: null,
        itv_video_folder_document_id: null,

        pauses: pauses || false,
       
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      // Insert/upsert main video task (overwrites any pre-created placeholder row)
      const { data: insertedMainTask, error: insertMainError } = await supabase
        .from('video_tasks')
        .upsert(mainVideoTask, { onConflict: 'id' })
        .select()
        .single();

      if (insertMainError) {
        throw new Error(`Failed to create main video task: ${insertMainError.message}`);
      }

      console.log(`Created main video task ${mainVideoTaskId} for existing story with content generation`);

      // Fire and forget - trigger image prompts and audio generation asynchronously
      triggerImagePromptsAndAudioAsync(user_id, group_id, {
        story_title,
        description,
        image_style: resolvedImageStyle,
        use_character_descriptions,
        first_page_frequency,
        rest_frequency,
        image_model,
        voice: voice, // Pass original voice with prefix
        language: 'en',
        model_version: finalModelVersion,
        speed,
        volume: finalVolume, // Use finalVolume for existing audio
        existing_audio_volume: existing_audio_volume, // Pass existing_audio_volume for reference
        preference,
        remove_title_chapters,
        clone_voice_name: cloneVoiceName,
        clone_voice_url: cloneVoiceUrl,
        clone_language: cloneLanguage,
        variant: videoVariant,
        video_loop, // NEW: Pass video loop
        loop_time, // NEW: Pass loop time
        text_language: language, // NEW: Pass text language
        story_model: story_model, // NEW: Pass story model
        model: model, // NEW: Pass image prompt model
        use_existing_images,
        use_existing_audio,
        // NEW: Processing control flags
        process_story,
        process_images,
        process_audio,
        // NEW: Frequency configuration fields
        frequency_mode,
        frequency_type,
        consistent_frequency,
        audio_distribution_type,
        first_page_image_amount,
        rest_image_amount,
        total_audio_duration: resolvedAudioDuration, // Use resolved duration (from audio document) instead of raw request value
        image_amount,
        audio_files,
        // TTV/ITV pipeline fields
        visual_type,
        video_model,
        video_duration,
        itv_model,
        itv_duration,
        audio_clip,
        // Custom characters (needed for TTV/ITV prompt generation)
        customCharactersEnabled,
        customCharacters,
        customCharactersAIEnhance,
        pauses,
      }, story_file_path!, mainVideoTaskId, tab);

      // Return immediately without waiting for the processing to start
      return new Response(JSON.stringify({
        video_task_id: mainVideoTaskId,
        estimated_tokens: estimatedTokens,
        next_step: hasVideoLoop 
          ? (process_audio && !use_existing_audio ? 'audio generation will start shortly' : (video ? 'video processing will start shortly' : 'processing completed'))
          : (!use_existing_images && process_images && !use_existing_audio && process_audio ? 'image generation and audio generation will start shortly' : (!use_existing_images && process_images ? 'image generation will start shortly' : (process_audio && !use_existing_audio ? 'audio generation will start shortly' : (video ? 'video processing will start shortly' : 'processing completed')))),
        message: hasVideoLoop 
          ? (process_audio && !use_existing_audio ? `Video task created for existing story with video loop. Audio generation will begin automatically.` : (video ? `Video task created for existing story with video loop and existing audio. Video processing will begin automatically.` : `Task created for existing story with video loop. Processing completed.`))
          : `Video task created for existing story. ${!use_existing_images && process_images ? 'Image generation' : ''} ${!use_existing_images && process_images && !use_existing_audio && process_audio ? 'and' : ''} ${!use_existing_audio && process_audio ? 'audio generation' : ''} ${(!use_existing_images && process_images) || (!use_existing_audio && process_audio) ? 'will begin automatically.' : (video ? 'Video processing will begin automatically.' : 'Processing completed.')}`,
        settings: {
          use_existing_story,
          use_existing_images,
          use_existing_audio,
          has_background_music: !!bg_music, // NEW: Background music status
          bg_music_volume: bg_music_volume, // NEW: Background music volume
          has_video_loop: hasVideoLoop, // NEW: Video loop status
          loop_time: loop_time, // NEW: Loop time
          transition_type: transition_type, // NEW: Transition type
          animation_type: finalAnimationType, // NEW: Animation type (null for "none")
          effects_type: finalEffectsType, // NEW: Effects type (null for "none")
          text_language: language, // NEW: Text language
          story_model: story_model, // NEW: Story model
          volume: finalVolume, // Use finalVolume for existing audio
          model: model, // NEW: Image prompt model
          voice: extractedVoiceName, // Return the extracted voice name
          story_file_path,
          content_generation_needed: true,
          needs_images: !use_existing_images && !hasVideoLoop && process_images,
          needs_audio: !use_existing_audio && process_audio,
          audio_format: finalModelVersion === 'v7' || finalModelVersion === 'speechify' || finalModelVersion === 'elevenlabs' ? 'mp3' : 'wav',
          model_version: finalModelVersion,
          output_video_name: finalOutputVideoName,
          estimated_image_count: estimatedImageCount, // NEW: Include estimated image count
          transition_batch_progress: transitionBatchProgress, // NEW: Include in response
          // NEW: Processing control flags
          video,
          process_story,
          process_images,
          process_audio,
          // NEW: Clone voice details
          clone_voice_name: cloneVoiceName,
          clone_voice_url: cloneVoiceUrl,
          clone_language: cloneLanguage
        }
      }), { status: 200, headers: responseHeaders });
    }

    // Handle case where content needs to be generated (new functionality)
    else {
      console.log('Creating video task for content generation pipeline...');

      // Determine model version and clone voice parameters based on voice prefix if not provided
      let finalModelVersion = model_version || 'lemonfox';
      let cloneVoiceName: string | undefined;
      let cloneVoiceUrl: string | undefined;
      let cloneLanguage: string | undefined;
      
      if (!model_version && voice) {
        if (isCoreVoice(voice)) {
          finalModelVersion = 'lemonfox';
        } else if (isPremiumVoice(voice)) {
          finalModelVersion = 'v7';
        } else if (isApexVoice(voice)) {
          finalModelVersion = 'speechify';
        } else if (isElevenLabsVoice(voice)) {
          finalModelVersion = 'elevenlabs';
        } else if (isCloneVoice(voice)) {
          finalModelVersion = 'clone';
          cloneVoiceName = voice.split(':')[1];
          cloneLanguage = 'english';
          
          // Check if it's a predefined clone voice
          const predefinedVoice = predefinedCloneVoices.find(v => v.name === cloneVoiceName);
          if (predefinedVoice) {
            cloneVoiceUrl = predefinedVoice.voice_id;
          } else {
            // Custom voice - use the workspace format
            cloneVoiceUrl = `default-ujsa1wysgyitfqg3ixpqka__${cloneVoiceName}`;
          }
        }
      }

      // Handle explicit clone voice parameters from request
      if (finalModelVersion === 'clone') {
        cloneVoiceName = cloneVoiceName || clone_voice_name;
        cloneVoiceUrl = cloneVoiceUrl || clone_voice_url;
        cloneLanguage = cloneLanguage || clone_language;
      }

      // NEW: Estimate image count for transition batch calculation
      let estimatedImageCount = 10;
      if (hasVideoLoop) {
        estimatedImageCount = 1;
      } else if (visual_type === 'ttv' || visual_type === 'itv') {
        // TTV/ITV: estimate clip count from audio duration / clip duration
        const clipDur = visual_type === 'itv' ? (itv_duration || 5) : (video_duration || 8);
        const estAudioDur = total_audio_duration || (word_count ? (word_count * 60 / 125) : 300);
        estimatedImageCount = Math.max(1, Math.ceil(estAudioDur / clipDur));
        console.log(`TTV/ITV new content estimated clip count: ${estimatedImageCount} (audioDur=${estAudioDur}, clipDur=${clipDur})`);
      } else if (word_count && process_images) {
        estimatedImageCount = Math.ceil(word_count / 100);
      }
      const transitionBatchProgress = calculateTransitionBatchProgress(estimatedImageCount, transition_type, visual_type);
      console.log('Calculated transition batch progress for new content:', transitionBatchProgress);

      // Upsert main video task (overwrites the early placeholder row)
      const mainVideoTaskId = earlyVideoTaskId;
      const gcVersion = await assignGcVersion();
      console.log(`Assigned gc_version ${gcVersion} for video task ${mainVideoTaskId}`);
      const mainVideoTask = {
        id: mainVideoTaskId,
        user_id,
        group_id,
        story_title,
        description,
        text_language: language,
        story_model: story_model, // NEW: Story model
        model: model, // NEW: Image prompt model
        master_prompt: null, // Will be set after story generation if master prompt is used
        gc_version: gcVersion,
        settings: {
          word_count: word_count || 0,
          image_style: resolvedImageStyle,
          use_character_descriptions: use_character_descriptions || false,
          first_page_frequency: first_page_frequency || 0,
          rest_frequency: rest_frequency || 0,
          image_model: image_model || 'gpt-image-1-mini',
          voice: extractedVoiceName,
          language: 'en',
          model_version: finalModelVersion,
          elevenlabs_model_id: finalModelVersion === 'elevenlabs' ? (elevenlabs_model_id || DEFAULT_ELEVENLABS_MODEL_ID) : undefined,
          speed: speed || 1.0,
          volume: finalVolume, // Use finalVolume for existing audio
          preference: preference || 'merged',
          remove_title_chapters: remove_title_chapters || false,
          clone_voice_name: cloneVoiceName,
          clone_voice_url: cloneVoiceUrl,
          clone_language: cloneLanguage,
          output_video_name: finalOutputVideoName,
          bg_music, // NEW: Background music in settings
          bg_music_volume, // NEW: Background music volume in settings
          video_loop, // NEW: Video loop in settings
          loop_time, // NEW: Loop time in settings
          transition_type, // NEW: Transition type in settings
          animation_type: finalAnimationType, // NEW: Animation type in settings (null for "none")
          effects_type: finalEffectsType, // NEW: Effects type in settings (null for "none")
          text_language: language, // NEW: Text language in settings
          story_model: story_model, // NEW: Story model in settings
          model: model, // NEW: Image prompt model in settings
          use_existing_story,
          story_file_path,
          use_existing_images,
          images_folder_path,
          image_prompt_path,
          use_existing_audio,
          audio_file_path,
          audio_folder_path, // Include both for flexibility
          story_title,
          description,
          // NEW: Processing control flags in settings
          video,
          process_story,
          process_images,
          process_audio,
          // NEW: Skipped process indicators
          story_skipped: !process_story,
          images_skipped: !process_images,
          audio_skipped: !process_audio,
          // Custom characters
          customCharactersEnabled,
          customCharacters,
          customCharactersAIEnhance,
        },
       
        // Video-specific settings
        image_style: resolvedImageStyle,
        use_character_descriptions: use_character_descriptions || false,
        first_page_frequency: first_page_frequency || 0,
        rest_frequency: rest_frequency || 0,
        image_model: image_model || 'gpt-image-1-mini',
       
        // Audio settings
        voice: extractedVoiceName,
        language: 'en',
        model_version: finalModelVersion,
        speed: speed || 1.0,
        volume: finalVolume, // Use finalVolume for existing audio
        preference: preference || 'merged',
        remove_title_chapters: remove_title_chapters || false,
       
        // Clone voice fields
        is_clone_voice: finalModelVersion === 'clone',
        clone_voice_name: finalModelVersion === 'clone' ? cloneVoiceName : null,
        clone_voice_url: finalModelVersion === 'clone' ? cloneVoiceUrl : null,
        clone_language: finalModelVersion === 'clone' ? cloneLanguage : null,
       
        // Video settings
        output_video_name: finalOutputVideoName,
        bg_music: bg_music || null, // NEW: Background music
        bg_music_volume: bg_music_volume, // NEW: Background music volume
        video_loop: video_loop || null, // NEW: Video loop
        loop_time: loop_time || null, // NEW: Loop time
        transition_type: transition_type || null, // NEW: Transition type
        subtitles: subtitles || null, // Optional subtitle burn-in config (null = no subtitles)
        animation_type: finalAnimationType, // NEW: Animation type (null for "none")
        effects_type: finalEffectsType, // NEW: Effects type (null for "none")
       
        // Tab support
        tab, // Tab number for enterprise users
       
        // File paths for existing content
        story_file_path: use_existing_story ? story_file_path : null,
       
        variant: videoVariant,
       
        // Batch processing fields - will be updated when content is ready
        batch_size: 3, // CHANGED: from 4 to 3
        processing_batch_start: null,
        processing_batch_end: null,
        current_batch_number: null,
       
        // Progress tracking - Starting from story generation or skipping based on flags
        story_progress: process_story ? 0 : 100,
        image_prompt_progress: (hasVideoLoop || !process_images || visual_type === 'ttv') ? 100 : 0,
        image_generation_progress: (hasVideoLoop || !process_images || visual_type === 'ttv') ? 100 : 0,
        audio_progress: process_audio ? 0 : 100,
        video_creation_progress: 0,
        individual_video_progress: 0,
        overall_progress: 0, // Starting from beginning
       
        // Status tracking - Set based on processing flags and visual_type
        story_status: process_story ? 'running' : 'completed',
        image_prompt_status: (hasVideoLoop || !process_images || visual_type === 'ttv') ? 'completed' : 'pending',
        image_generation_status: (hasVideoLoop || !process_images || visual_type === 'ttv') ? 'completed' : 'pending',
        audio_status: process_audio ? 'pending' : 'completed',
        individual_video_status: 'pending',
        video_creation_status: 'pending',
        overall_status: 'running', // Process is starting
       
        // Additional tracking fields - will be updated when content is ready
        total_individual_videos: null,
        completed_individual_videos: 0,
       
        // Individual processing tracking
        current_image_number: null,

        // NEW: Set transition batch progress (estimated, will be updated when images are generated)
        transition_batch_progress: transitionBatchProgress,

        // NEW: Processing control flags
        video,
        process_story,
        process_images,
        process_audio,
        process_ttv,
        process_itv,
        process_mg,

        // TTV/ITV/MG visual pipeline fields
        visual_type: visual_type || 'image',
        video_model: video_model || null,
        video_duration: video_duration || null,
        audio_clip: audio_clip || false,
        itv_model: itv_model || null,
        itv_duration: itv_duration || null,

        // MG configuration columns
        mg_style_slug: visual_type === 'mg' ? (mg_style_slug || null) : null,
        mg_style_guidance: visual_type === 'mg' ? (mg_style_guidance || null) : null,
        mg_clip_duration: visual_type === 'mg' ? (Number(mg_clip_duration) || 10) : null,
        mg_codegen_model: visual_type === 'mg' ? (mg_codegen_model || 'claude-opus-4-6') : null,

        // MG status/progress - set based on visual_type
        mg_prompt_status: visual_type === 'mg' ? 'pending' : 'completed',
        mg_prompt_progress: 0,
        mg_status: visual_type === 'mg' ? 'pending' : 'completed',
        mg_progress: 0,
        mg_prompt_document_id: null,
        mg_folder_document_id: null,

        // TTV status/progress - set based on visual_type
        ttv_prompt_status: visual_type === 'ttv' ? 'pending' : 'completed',
        ttv_prompt_progress: 0,
        ttv_status: visual_type === 'ttv' ? 'pending' : 'completed',
        ttv_progress: 0,
        ttv_prompt_document_id: null,
        ttv_folder_document_id: null,

        // ITV status/progress - set based on visual_type
        itv_prompt_status: visual_type === 'itv' ? 'pending' : 'completed',
        itv_prompt_progress: 0,
        itv_status: visual_type === 'itv' ? 'pending' : 'completed',
        itv_progress: 0,
        itv_image_prompt_document_id: null,
        itv_video_prompt_document_id: null,
        itv_video_folder_document_id: null,

        // NEW: Frequency configuration fields for image prompts
        frequency_mode: frequency_mode || 'wordcount',
        frequency_type: frequency_type || 'variable',
        consistent_frequency: consistent_frequency || null,
        audio_distribution_type: audio_distribution_type || 'consistent',
        first_page_image_amount: first_page_image_amount || null,
        rest_image_amount: rest_image_amount || null,
        total_audio_duration: total_audio_duration || null,
        // For TTV/ITV, store the estimated clip count immediately so the polling UI
        // has a reasonable initial number. process-ttv-task / process-itv-task will
        // overwrite this with the exact count once clips are ready.
        image_amount: image_amount || (isTtvOrItv ? estimatedImageCount : null),
        audio_files: audio_files ? JSON.stringify(audio_files) : null,

        pauses: pauses || false,
       
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      // Insert/upsert main video task (overwrites any pre-created placeholder row)
      const { data: insertedMainTask, error: insertMainError } = await supabase
        .from('video_tasks')
        .upsert(mainVideoTask, { onConflict: 'id' })
        .select()
        .single();

      if (insertMainError) {
        throw new Error(`Failed to create main video task: ${insertMainError.message}`);
      }

      console.log(`Created main video task ${mainVideoTaskId} for content generation`);

      // Fire and forget - trigger story generation asynchronously only if processing story
      if (process_story) {
        // TODO: When master prompt is fully integrated for video process, uncomment this section:
        // 
        // // If master prompt is provided, call master-prompt edge function first
        // // It will enhance the prompt with AI and then trigger outline generation automatically
        // if (master_prompt) {
        //   console.log('Master prompt enabled for video process, calling master-prompt edge function...');
        //   
        //   fetch('https://master-prompt.storyscriptai.deno.net', {
        //     method: 'POST',
        //     headers: {
        //       'Content-Type': 'application/json',
        //     },
        //     body: JSON.stringify({
        //       user_id,
        //       group_id,
        //       title: story_title,
        //       description,
        //       word_count: word_count!,
        //       language,
        //       model: story_model,
        //       tab,
        //       variant: 1,
        //       master_prompt_data: master_prompt, // Assuming master_prompt contains the structured data
        //     }),
        //   }).then(response => {
        //     if (response.ok) {
        //       console.log('Master prompt enhancement triggered for video process');
        //     } else {
        //       console.error(`Failed to trigger master prompt enhancement: ${response.status}`);
        //       // Fallback to regular story generation if master prompt fails
        //       triggerStoryGenerationAsync(user_id, group_id, story_title, description, word_count!, language, model, story_model, tab);
        //     }
        //   }).catch(error => {
        //     console.error(`Error triggering master prompt enhancement: ${error.message}`);
        //     // Fallback to regular story generation
        //     triggerStoryGenerationAsync(user_id, group_id, story_title, description, word_count!, language, model, story_model, tab);
        //   });
        // } else {
        //   // No master prompt - regular story generation
        //   triggerStoryGenerationAsync(user_id, group_id, story_title, description, word_count!, language, model, story_model, tab);
        // }
        
        // Trigger story generation with master prompt support
        // Wrap in EdgeRuntime.waitUntil so the story generation chain
        // (setup-video-tasks → master-prompt → outline) stays alive after
        // this handler returns its Response to the frontend.
        EdgeRuntime.waitUntil(
          triggerStoryGenerationAsync(
            user_id,
            group_id,
            story_title,
            description,
            word_count!,
            language,
            model,
            story_model,
            tab,
            master_prompt || null,
            master_prompt_enhance_ai || false,
            is_runtime_mode || false,
            runtime_minutes || null,
            true, // videoProcess = true for video generation
            pauses || false,
            youtube_links || [],
            youtube_transcript_text || ''
          )
        );
      }

      // Return immediately without waiting for the processing to start
      return new Response(JSON.stringify({
        video_task_id: mainVideoTaskId,
        estimated_tokens: estimatedTokens,
        next_step: process_story ? 'story generation will start shortly' : 'content generation will start shortly',
        message: process_story 
          ? (hasVideoLoop 
            ? `Video task created with video loop using ${story_model} model. Story generation will begin automatically, followed by audio generation${video ? ' and video creation' : ''}.`
            : `Video task created using ${story_model} model. Story generation will begin automatically, followed by${process_images ? ' image prompts, image generation,' : ''}${process_audio ? ' audio generation,' : ''}${video ? ' and finally video creation' : ''}.`)
          : `Video task created with story processing disabled. ${process_images ? 'Image generation' : ''}${process_images && process_audio ? ' and' : ''}${process_audio ? ' audio generation' : ''} will begin automatically${video ? ', followed by video creation' : ''}.`,
        settings: {
          use_existing_story,
          use_existing_images,
          use_existing_audio,
          has_image_prompt_path: !!image_prompt_path,
          has_background_music: !!bg_music, // NEW: Background music status
          bg_music_volume: bg_music_volume, // NEW: Background music volume
          has_video_loop: hasVideoLoop, // NEW: Video loop status
          loop_time: loop_time, // NEW: Loop time
          transition_type: transition_type, // NEW: Transition type
          animation_type: finalAnimationType, // NEW: Animation type (null for "none")
          effects_type: finalEffectsType, // NEW: Effects type (null for "none")
          text_language: language, // NEW: Text language
          story_model: story_model, // NEW: Story model
          volume: finalVolume, // Use finalVolume for existing audio
          model: model, // NEW: Image prompt model
          voice: extractedVoiceName, // Return the extracted voice name
          word_count: word_count,
          content_generation_pipeline: true,
          audio_format: finalModelVersion === 'v7' || finalModelVersion === 'speechify' || finalModelVersion === 'elevenlabs' ? 'mp3' : 'wav',
          model_version: finalModelVersion,
          output_video_name: finalOutputVideoName,
          estimated_image_count: estimatedImageCount, // NEW: Include estimated image count
          transition_batch_progress: transitionBatchProgress, // NEW: Include in response
          // NEW: Processing control flags
          video,
          process_story,
          process_images,
          process_audio,
          // NEW: Clone voice details
          clone_voice_name: cloneVoiceName,
          clone_voice_url: cloneVoiceUrl,
          clone_language: cloneLanguage
        }
      }), { status: 200, headers: responseHeaders });
    }

  } catch (error: any) {
    await logError('Error in setup-video-tasks', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), { status: 500, headers: responseHeaders });
  }
});




