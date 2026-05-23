import { createClient } from 'npm:@supabase/supabase-js@2';
import { fetchWithDenoFallback } from '../_shared/fetchWithDenoFallback.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'https://yilrqukialrbdzydvwmt.supabase.co';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') || '';
const supabaseAnonKey = (Deno.env.get('PUBLIC_KEY')) || '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('WARNING: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const ALLOWED_ORIGINS = [
  'https://storyscriptai.com',
  'https://www.storyscriptai.com',
  'https://northnoir.com',
  'https://www.northnoir.com',
  'http://localhost:5173',
];

function getCorsOrigin(req: Request): string {
  const origin = req.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}
function getCorsHeaders(req: Request): Record<string, string> {
  const corsOrigin = getCorsOrigin(req);
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
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
    if (dbError) {
      console.error('Failed to log error to database:', dbError);
    }
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

async function triggerSizeCalculation(docId: string, filePath: string, version: number): Promise<void> {
  try {
    let response;
    
    // For audio folders (versions 9-10), use the dedicated Deno Deploy function
    if (version === 9 || version === 10) {
      response = await fetchWithDenoFallback('audio-folder-size', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify({
          id: docId,
          file_path: filePath,
          version: version,
        }),
      });
    } else {
      // For single audio files (versions 7-8), use the main calculate-file-size function
      response = await fetch(`${supabaseUrl}/functions/v1/calculate-file-size`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify({
          id: docId,
          file_path: filePath,
          version: version,
        }),
      });
    }

    if (!response.ok) {
      console.warn(`Failed to trigger size calculation for ${docId}: HTTP ${response.status}`);
    } else {
      console.log(`Successfully triggered size calculation for ${docId}`);
    }
  } catch (error: any) {
    console.warn(`Error triggering size calculation for ${docId}:`, error.message);
  }
}

async function applyVolumeBoostIfNeeded(userId: string, folderPath: string, volume: number, modelVersion: string): Promise<number> {
  if (!volume || volume <= 1.0) {
    return 0; // No boost needed
  }

  console.log(`Applying volume boost of ${volume}x to final audio files in ${folderPath}`);
  
  try {
    const response = await fetch('https://us-central1-story-script-ai.cloudfunctions.net/boost-audio-volume', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        user_id: userId,
        audio_folder_path: folderPath,
        volume_multiplier: volume,
        model_version: modelVersion,
        is_single_file: false
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Volume boost failed: HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    const tokensUsed = result.tokens_used || 0;
    console.log(`Volume boost successful, used ${tokensUsed} tokens`);
    return tokensUsed;
  } catch (error: any) {
    console.error(`Volume boost failed: ${error.message}`);
    // Don't throw error, just log it and continue without volume boost
    return 0;
  }
}

// UPDATED: Check completion based on processing flags
async function checkAllStatusesCompleted(userId: string, groupId: string): Promise<boolean> {
  try {
    const { data: videoTask } = await supabase
      .from('video_tasks')
      .select('story_status, image_prompt_status, image_generation_status, audio_status, process_story, process_images, process_audio, visual_type, ttv_prompt_status, ttv_status, itv_prompt_status, itv_status')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .single();

    if (!videoTask) {
      return false;
    }

    const visualType = videoTask.visual_type || 'image';

    console.log(`Video task statuses (visual_type=${visualType}):`, {
      story_status: videoTask.story_status,
      image_prompt_status: videoTask.image_prompt_status,
      image_generation_status: videoTask.image_generation_status,
      audio_status: videoTask.audio_status,
      ttv_prompt_status: videoTask.ttv_prompt_status,
      ttv_status: videoTask.ttv_status,
      itv_prompt_status: videoTask.itv_prompt_status,
      itv_status: videoTask.itv_status,
      process_story: videoTask.process_story,
      process_images: videoTask.process_images,
      process_audio: videoTask.process_audio
    });

    // Check completion based on processing flags
    const storyCompleted = !videoTask.process_story || videoTask.story_status === 'completed';
    const imagesCompleted = !videoTask.process_images || (videoTask.image_prompt_status === 'completed' && videoTask.image_generation_status === 'completed');
    const audioCompleted = !videoTask.process_audio || videoTask.audio_status === 'completed';
    // TTV/ITV completion: only checked when visual_type matches
    const ttvCompleted = visualType !== 'ttv' || (videoTask.ttv_prompt_status === 'completed' && videoTask.ttv_status === 'completed');
    const itvCompleted = visualType !== 'itv' || (videoTask.itv_prompt_status === 'completed' && videoTask.itv_status === 'completed');

    const allCompleted = storyCompleted && imagesCompleted && audioCompleted && ttvCompleted && itvCompleted;

    console.log(`All statuses completed: ${allCompleted} (story: ${storyCompleted}, images: ${imagesCompleted}, audio: ${audioCompleted}, ttv: ${ttvCompleted}, itv: ${itvCompleted})`);
    return allCompleted;
  } catch (error: any) {
    console.error(`Error checking video task statuses: ${error.message}`);
    return false;
  }
}

async function deleteTaskRows(userId: string, groupId: string, variant: number, tab: number = 1): Promise<void> {
  try {
    console.log(`Deleting task rows for user ${userId}, group ${groupId}, variant ${variant}, tab ${tab}`);

    // Delete story_tasks
    const { error: storyError } = await supabase
      .from('story_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('group_id', groupId);
    
    if (storyError) {
      console.error(`Error deleting story_tasks: ${storyError.message}`);
    } else {
      console.log(`Successfully deleted story_tasks for group ${groupId}`);
    }

    // Delete image_prompt_tasks
    const { error: imagePromptError } = await supabase
      .from('image_prompt_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('group_id', groupId);
    
    if (imagePromptError) {
      console.error(`Error deleting image_prompt_tasks: ${imagePromptError.message}`);
    } else {
      console.log(`Successfully deleted image_prompt_tasks for group ${groupId}`);
    }

    // Delete image_prompt_context
    const { error: imageContextError } = await supabase
      .from('image_prompt_context')
      .delete()
      .eq('group_id', groupId);
    
    if (imageContextError) {
      console.error(`Error deleting image_prompt_context: ${imageContextError.message}`);
    } else {
      console.log(`Successfully deleted image_prompt_context for group ${groupId}`);
    }

    // Delete audio_tasks with tab and variant filters
    const { error: audioError } = await supabase
      .from('audio_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('variant', variant)
      .eq('tab', tab);
    
    if (audioError) {
      console.error(`Error deleting audio_tasks: ${audioError.message}`);
    } else {
      console.log(`Successfully deleted audio_tasks for group ${groupId}, tab ${tab}`);
    }

    // Delete image_tasks
    const { error: imageError } = await supabase
      .from('image_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('group_id', groupId);
    
    if (imageError) {
      console.error(`Error deleting image_tasks: ${imageError.message}`);
    } else {
      console.log(`Successfully deleted image_tasks for group ${groupId}`);
    }

    // Delete TTV_prompt_tasks
    const { error: ttvPromptError } = await supabase
      .from('TTV_prompt_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('group_id', groupId);
    
    if (ttvPromptError) {
      console.error(`Error deleting TTV_prompt_tasks: ${ttvPromptError.message}`);
    } else {
      console.log(`Successfully deleted TTV_prompt_tasks for group ${groupId}`);
    }

    // Delete TTV_tasks
    const { error: ttvError } = await supabase
      .from('TTV_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('group_id', groupId);
    
    if (ttvError) {
      console.error(`Error deleting TTV_tasks: ${ttvError.message}`);
    } else {
      console.log(`Successfully deleted TTV_tasks for group ${groupId}`);
    }

    // Delete ITV_prompt_tasks
    const { error: itvPromptError } = await supabase
      .from('ITV_prompt_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('group_id', groupId);
    
    if (itvPromptError) {
      console.error(`Error deleting ITV_prompt_tasks: ${itvPromptError.message}`);
    } else {
      console.log(`Successfully deleted ITV_prompt_tasks for group ${groupId}`);
    }

    // Delete ITV_tasks
    const { error: itvTaskError } = await supabase
      .from('ITV_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('group_id', groupId);
    
    if (itvTaskError) {
      console.error(`Error deleting ITV_tasks: ${itvTaskError.message}`);
    } else {
      console.log(`Successfully deleted ITV_tasks for group ${groupId}`);
    }

  } catch (error: any) {
    console.error(`Error in deleteTaskRows: ${error.message}`);
    await logError('Error deleting task rows', error);
  }
}

// UPDATED: Check video flag before triggering video creation
async function triggerVideoCreation(userId: string, groupId: string, variant: number, tab: number = 1): Promise<void> {
  try {
    console.log(`All statuses completed, checking video creation settings for group ${groupId}, variant ${variant}`);

    // Get video task settings
    const { data: videoTask } = await supabase
      .from('video_tasks')
      .select('*')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .single();

    if (!videoTask) {
      throw new Error('Video task not found');
    }

    console.log(`Found video task ${videoTask.id}, video flag: ${videoTask.video}`);

    // NEW: Check if video creation is enabled
    if (videoTask.video === false) {
      console.log(`Video creation disabled for task ${videoTask.id}, marking as completed_final`);
      
      // Update video task to completed_final instead of triggering video creation
      await supabase
        .from('video_tasks')
        .update({
          story_status: 'completed_final',
          image_prompt_status: 'completed_final',
          image_generation_status: 'completed_final',
          audio_status: 'completed_final',
          video_creation_status: 'completed_final',
          overall_status: 'completed_final',
          individual_video_status: 'completed_final',
          ttv_prompt_status: 'completed_final',
          ttv_status: 'completed_final',
          itv_prompt_status: 'completed_final',
          itv_status: 'completed_final',
          story_progress: 100,
          image_prompt_progress: 100,
          image_generation_progress: 100,
          audio_progress: 100,
          video_creation_progress: 100,
          individual_video_progress: 100,
          ttv_prompt_progress: 100,
          ttv_progress: 100,
          itv_prompt_progress: 100,
          itv_progress: 100,
          overall_progress: 100,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', videoTask.id);

      // Delete task rows since processing is complete
      await deleteTaskRows(userId, groupId, variant, tab);
      
      console.log(`Processing completed_final for video task ${videoTask.id} without video creation`);
      return;
    }

    // Original video creation logic for when video=true
    console.log(`Video creation enabled, triggering video creation for group ${groupId}`);

    // Update video task status to ready for video creation
    await supabase
      .from('video_tasks')
      .update({
        audio_status: 'completed',
        audio_progress: 100,
        video_creation_status: 'pending',
        overall_progress: 90,
        updated_at: new Date().toISOString()
      })
      .eq('group_id', groupId)
      .eq('user_id', userId);

    // Check if video_loop is being used
    const hasVideoLoop = !!videoTask.video_loop;

    // Get all the documents for this group
    const { data: documents } = await supabase
      .from('story_documents')
      .select('*')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('variant', videoTask.variant)
      .order('created_at', { ascending: true });

    if (!documents || documents.length === 0) {
      throw new Error('No documents found for video creation');
    }

    // Find required documents based on processing flags
    const storyDoc = !videoTask.process_story ? null : documents.find(d => !d.title.startsWith('Image') && !d.title.startsWith('Audio'));
    const imagePromptDoc = !videoTask.process_images ? null : documents.find(d => d.title.startsWith('Image Prompt:'));
    const imageOutputDoc = !videoTask.process_images ? null : documents.find(d => d.title.startsWith('Image Outputs:'));
    const audioOutputDoc = !videoTask.process_audio ? null : documents.find(d => d.title.startsWith('Audio Outputs:'));

    // Determine visual content folder based on visual_type
    const visualType = videoTask.visual_type || 'image';
    let visualFolderPath: string | null = null;
    let useExistingVisuals = false;
    let imagePromptPath: string | null = null;

    if (visualType === 'ttv' && videoTask.ttv_folder_document_id) {
      // TTV: use the TTV clips folder
      const { data: ttvDoc } = await supabase
        .from('story_documents')
        .select('file_path')
        .eq('id', videoTask.ttv_folder_document_id)
        .single();
      visualFolderPath = ttvDoc?.file_path || null;
      useExistingVisuals = !!visualFolderPath;
      console.log(`TTV clips folder: ${visualFolderPath}`);
    } else if (visualType === 'itv' && videoTask.itv_video_folder_document_id) {
      // ITV: use the ITV video clips folder
      const { data: itvDoc } = await supabase
        .from('story_documents')
        .select('file_path')
        .eq('id', videoTask.itv_video_folder_document_id)
        .single();
      visualFolderPath = itvDoc?.file_path || null;
      useExistingVisuals = !!visualFolderPath;
      console.log(`ITV clips folder: ${visualFolderPath}`);
    } else {
      // Image mode: use existing image output folder
      visualFolderPath = (!videoTask.process_images || hasVideoLoop) ? null : imageOutputDoc?.file_path;
      useExistingVisuals = !hasVideoLoop && videoTask.process_images;
      imagePromptPath = (!videoTask.process_images || hasVideoLoop) ? null : imagePromptDoc?.file_path;
    }

    // Call setup-video-tasks to start the final video process
    const response = await fetch(`${supabaseUrl}/functions/v1/setup-video-tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        user_id: userId,
        group_id: groupId,
        tab, // Forward tab so the new row is assigned to the correct tab
        story_title: videoTask.story_title,
        description: videoTask.description,
        word_count: 0, // Not needed since we're using existing content
        language: videoTask.text_language || 'english',
        image_style: videoTask.image_style,
        use_character_descriptions: videoTask.use_character_descriptions,
        first_page_frequency: videoTask.first_page_frequency,
        rest_frequency: videoTask.rest_frequency,
        image_model: videoTask.image_model,
        voice: videoTask.voice,
        model_version: videoTask.model_version,
        elevenlabs_model_id: videoTask.settings?.elevenlabs_model_id,
        speed: videoTask.speed,
        preference: videoTask.preference,
        remove_title_chapters: videoTask.remove_title_chapters,
        clone_voice_name: videoTask.clone_voice_name,
        clone_voice_url: videoTask.clone_voice_url,
        clone_language: videoTask.clone_language,
        output_video_name: videoTask.output_video_name,
        bg_music: videoTask.bg_music,
        video_loop: videoTask.video_loop,
        loop_time: videoTask.loop_time,
        transition_type: videoTask.transition_type,
        animation_type: videoTask.animation_type || 'drift',
        effects_type: videoTask.effects_type || 'film_grain',
        variant: videoTask.variant,
        use_existing_story: true,
        story_file_path: storyDoc?.file_path,
        use_existing_images: useExistingVisuals,
        images_folder_path: visualFolderPath,
        image_prompt_path: imagePromptPath,
        use_existing_audio: true,
        audio_folder_path: audioOutputDoc?.file_path,
        // TTV/ITV parameters
        visual_type: visualType,
        video_model: videoTask.video_model,
        video_duration: videoTask.video_duration,
        audio_clip: videoTask.audio_clip,
        itv_model: videoTask.itv_model,
        itv_duration: videoTask.itv_duration,
        process_ttv: visualType === 'ttv',
        process_itv: visualType === 'itv',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to trigger video creation: HTTP ${response.status}: ${errorText}`);
    }

    console.log(`Successfully triggered video creation for video task ${videoTask.id}`);

  } catch (error: any) {
    console.error(`Error triggering video creation: ${error.message}`);
    await logError('Error triggering video creation', error);
    
    await supabase
      .from('video_tasks')
      .update({
        audio_status: 'error',
        overall_status: 'error',
        error_message: `Failed to trigger video creation: ${error.message}`,
        updated_at: new Date().toISOString()
      })
      .eq('group_id', groupId)
      .eq('user_id', userId);
  }
}

/**
 * Strip ID3v2 tags, ID3v1 tags, and Xing/Info VBR header frames from an MP3 buffer.
 *
 * When naively concatenating multiple MP3 files, the Xing/LAME VBR header present in
 * the first file tells audio players the total number of frames (and therefore the total
 * duration) of ONLY that first file. Players that honour this header (virtually all modern
 * players do) will stop playback after ~2 minutes even though the full 30+ MB of merged
 * audio is present. Stripping the Xing frame from every individual buffer before
 * concatenation removes this bad signal and players fall back to bitrate-based duration
 * estimation, which is accurate for the merged result.
 */
function stripMp3Metadata(buffer: ArrayBuffer): ArrayBuffer {
  const data = new Uint8Array(buffer);
  let offset = 0;

  // 1. Strip ID3v2 tag (starts with "ID3")
  if (
    data.length > 10 &&
    data[0] === 0x49 && // 'I'
    data[1] === 0x44 && // 'D'
    data[2] === 0x33    // '3'
  ) {
    const flags = data[5];
    const hasFooter = (flags & 0x10) !== 0; // ID3v2 footer flag (bit 4)
    // Tag size is stored as a synchsafe integer (4 × 7 bits)
    const tagSize =
      ((data[6] & 0x7F) << 21) |
      ((data[7] & 0x7F) << 14) |
      ((data[8] & 0x7F) << 7) |
       (data[9] & 0x7F);
    offset = 10 + tagSize + (hasFooter ? 10 : 0);
  }

  // 2. Find the first MPEG sync word and check if that frame is a Xing/Info VBR header
  const searchLimit = Math.min(offset + 4096, data.length - 4);
  while (offset < searchLimit) {
    if (data[offset] === 0xFF && (data[offset + 1] & 0xE0) === 0xE0) {
      const b1 = data[offset + 1];
      const b2 = data[offset + 2];

      const mpegVersionBits = (b1 >> 3) & 0x3; // 3 = MPEG1, 2 = MPEG2.5, 0 = MPEG2
      const layerBits       = (b1 >> 1) & 0x3; // 1 = Layer III (MP3)
      const bitrateIdx      = (b2 >> 4) & 0xF;
      const sampleRateIdx   = (b2 >> 2) & 0x3;
      const padding         = (b2 >> 1) & 0x1;
      const channelMode     = (data[offset + 3] >> 6) & 0x3; // 3 = Mono

      // Only attempt to parse MPEG1/2 Layer 3 frames with valid bitrate/sample-rate indices
      if (layerBits === 1 && bitrateIdx !== 0 && bitrateIdx !== 15 && sampleRateIdx !== 3) {
        const bitrates          = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
        const sampleRatesMPEG1  = [44100, 48000, 32000, 0];
        const sampleRatesMPEG2  = [22050, 24000, 16000, 0];

        const bitrate    = bitrates[bitrateIdx] * 1000;
        const sampleRate = mpegVersionBits === 3
          ? sampleRatesMPEG1[sampleRateIdx]
          : sampleRatesMPEG2[sampleRateIdx];

        if (bitrate > 0 && sampleRate > 0) {
          const frameSize = Math.floor(144 * bitrate / sampleRate) + padding;

          // Xing/Info tag is located after the MPEG side-information block
          // MPEG1: stereo = 32 bytes, mono = 17 bytes
          // MPEG2: stereo = 17 bytes, mono = 9 bytes
          const sideInfoSize = mpegVersionBits === 3
            ? (channelMode === 3 ? 17 : 32)
            : (channelMode === 3 ?  9 : 17);

          const xingCheckOffset = offset + 4 + sideInfoSize;
          if (xingCheckOffset + 4 <= data.length) {
            const marker = String.fromCharCode(
              data[xingCheckOffset],
              data[xingCheckOffset + 1],
              data[xingCheckOffset + 2],
              data[xingCheckOffset + 3]
            );
            if (marker === 'Xing' || marker === 'Info') {
              // This entire frame is a VBR header — skip it
              offset += frameSize;
            }
          }
        }
      }
      break; // Sync word found; stop scanning regardless of VBR result
    }
    offset++;
  }

  // 3. Strip ID3v1 tag at the very end (exactly 128 bytes, starts with "TAG")
  let endOffset = data.length;
  if (
    data.length >= 128 &&
    data[data.length - 128] === 0x54 && // 'T'
    data[data.length - 127] === 0x41 && // 'A'
    data[data.length - 126] === 0x47    // 'G'
  ) {
    endOffset = data.length - 128;
  }

  return buffer.slice(offset, endOffset);
}

function mergeMp3Buffers(buffers: ArrayBuffer[]): ArrayBuffer {
  if (buffers.length === 0) throw new Error('No buffers to merge');
  if (buffers.length === 1) return buffers[0];

  // Strip ID3 tags and Xing/Info VBR headers from every individual buffer before
  // concatenation. Without this, the first file's Xing header tells players the total
  // duration equals only the duration of file 1 (~2 min), so they stop early even though
  // all audio data is present. After stripping, players fall back to bitrate-based
  // duration estimation, which is accurate for the full merged file.
  const strippedBuffers = buffers.map(buf => stripMp3Metadata(buf));

  const totalLen = strippedBuffers.reduce((sum, b) => sum + b.byteLength, 0);
  const result = new Uint8Array(totalLen);

  let offset = 0;
  for (const buf of strippedBuffers) {
    result.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }

  return result.buffer;
}

async function compileFinalAudio(
  userId: string,
  groupId: string,
  title: string,
  description: string,
  variant: number,
  isCorrected: boolean,
  inputVersion: number,
  folderTimestamp: string,
  modelVersion: string,
  preference: string,
  singleAudio: boolean,
  videoProcess: boolean,
  volume?: number,
  tab: number = 1
) {
  try {
    console.log(`Starting final audio compilation for group ${groupId}, tab ${tab}`);

    // Universal concurrency guard: claim lock via audio_tasks batch_number=1.
    // Only one invocation can set batch 1 to 'compiling' — duplicates are rejected.
    // Works for both videoProcess=true and videoProcess=false.
    const { data: lockResult } = await supabase
      .from('audio_tasks')
      .update({ status: 'compiling', updated_at: new Date().toISOString() })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('variant', variant)
      .eq('tab', tab)
      .eq('batch_number', 1)
      .not('status', 'in', '("compiling","completed_final")')
      .select('id');

    if (!lockResult || lockResult.length === 0) {
      const { data: currentTask } = await supabase
        .from('audio_tasks')
        .select('status')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('variant', variant)
        .eq('tab', tab)
        .eq('batch_number', 1)
        .single();

      console.log(`Compile lock not acquired for group ${groupId} (batch 1 status: ${currentTask?.status}). Skipping.`);
      return;
    }
    console.log(`Claimed compile lock (audio_tasks[1] → compiling) for group ${groupId}`);

    // Also update video_tasks status for tracking
    if (videoProcess) {
      await supabase
        .from('video_tasks')
        .update({ audio_status: 'compiling', updated_at: new Date().toISOString() })
        .eq('group_id', groupId)
        .eq('user_id', userId);
    }

    // Wait for all tasks to be completed
    let tasks;
    let completedTasks = 0;
    const checkDelay = 5000;
    const maxWaitTime = 300000; // 5 minutes
    const startWait = Date.now();

    while (Date.now() - startWait < maxWaitTime) {
      const { data, error } = await supabase
        .from('audio_tasks')
        .select('*')
        .eq('user_id', userId)
        .eq('group_id', groupId)
        .eq('variant', variant)
        .eq('tab', tab)
        .gt('batch_number', 0)
        .order('batch_number', { ascending: true });

      if (error || !data || data.length === 0) {
        throw new Error(`Failed to fetch tasks: ${error?.message || 'No data'}`);
      }

      tasks = data;
      // Count 'compiling' as completed (batch 1 has been locked by this invocation)
      completedTasks = tasks.filter(task => task.status === 'completed' || task.status === 'completed_final' || task.status === 'compiling').length;
      const totalBatches = tasks[0].total_batches;

      console.log(`Audio compilation progress: ${completedTasks}/${totalBatches} batches completed`);

      if (completedTasks >= totalBatches) {
        break;
      }

      console.log(`Not all batches completed yet (${completedTasks}/${totalBatches}), waiting ${checkDelay/1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, checkDelay));
    }

    if (Date.now() - startWait >= maxWaitTime) {
      throw new Error(`Timeout waiting for all batches to complete. Only ${completedTasks}/${tasks![0].total_batches} completed.`);
    }

    const totalBatches = tasks![0].total_batches;
    const numParts = totalBatches;
    const sanitizedTitle = title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
    const folderPath = `documents/${userId}/${groupId}/${sanitizedTitle}_${folderTimestamp}`;

    // All current voice models produce mp3
    const ext = 'mp3';
    const mergeFunc = mergeMp3Buffers;
 
    // Set thresholds based on model version
    let threshold: number;
    if (modelVersion === 'lemonfox') {
      threshold = 12; // lemonfox: merge if <12 parts
    } else {
      threshold = 20; // default: merge if <20 parts
    }
 
    const partPaths = Array.from({ length: numParts }, (_, i) => `${folderPath}/${i + 1}.${ext}`);
    let outputPath: string;
    let outputVersion: number;

    console.log(`Processing ${numParts} audio parts with preference: ${preference}, threshold: ${threshold}, volume: ${volume || 1.0}`);

    if (preference === 'merged' || numParts < threshold) {
      const mergedPath = `${folderPath}/merged.${ext}`;

      if (numParts === 1) {
        console.log('Single audio file, moving to merged location');
        const fromPath = partPaths[0];
        const { error: moveError } = await supabase.storage.from('stories').move(fromPath, mergedPath);
        if (moveError) throw new Error(`Failed to move single audio: ${moveError.message}`);
      } else {
        console.log(`Merging ${numParts} audio files into single file`);
        
        const DOWNLOAD_BATCH_SIZE = 10;
        const allBuffers: ArrayBuffer[] = [];
     
        for (let i = 0; i < partPaths.length; i += DOWNLOAD_BATCH_SIZE) {
          const batchPaths = partPaths.slice(i, i + DOWNLOAD_BATCH_SIZE);
          console.log(`Downloading batch ${Math.floor(i / DOWNLOAD_BATCH_SIZE) + 1}/${Math.ceil(partPaths.length / DOWNLOAD_BATCH_SIZE)}`);
          
          const batchBuffers = await Promise.all(
            batchPaths.map(async (p, idx) => {
              let buffer: ArrayBuffer;
              const maxDownloadAttempts = 15;
              const downloadDelay = 3000;

              for (let att = 0; att < maxDownloadAttempts; att++) {
                try {
                  const { data, error } = await supabase.storage.from('stories').download(p);
                  if (error) {
                    console.log(`Attempt ${att + 1}/${maxDownloadAttempts} - Failed to download ${p}: ${error.message}`);
                    if (att < maxDownloadAttempts - 1) {
                      await new Promise(resolve => setTimeout(resolve, downloadDelay));
                      continue;
                    }
                    throw new Error(`Failed to download after ${maxDownloadAttempts} attempts: ${error.message}`);
                  }
                  
                  buffer = await data.arrayBuffer();
                  if (buffer.byteLength > 100) {
                    console.log(`Successfully downloaded ${p} (${buffer.byteLength} bytes)`);
                    return buffer;
                  }
                  
                  console.log(`Audio from ${p} small (${buffer.byteLength} bytes), attempt ${att + 1}/${maxDownloadAttempts}`);
                  if (att < maxDownloadAttempts - 1) {
                    await new Promise(resolve => setTimeout(resolve, downloadDelay));
                  }
                } catch (downloadError: any) {
                  console.log(`Download error for ${p}: ${downloadError.message}`);
                  if (att < maxDownloadAttempts - 1) {
                    await new Promise(resolve => setTimeout(resolve, downloadDelay));
                  }
                }
              }
              throw new Error(`Audio from ${p} remains invalid after ${maxDownloadAttempts} attempts`);
            })
          );
          allBuffers.push(...batchBuffers);
       
          if (i + DOWNLOAD_BATCH_SIZE < partPaths.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }

        console.log(`Downloaded all ${allBuffers.length} audio files, starting merge`);
        const mergedBuffer = mergeFunc(allBuffers);
        console.log(`Merged audio size: ${mergedBuffer.byteLength} bytes`);
        
        const { error: uploadError } = await supabase.storage
          .from('stories')
          .upload(mergedPath, mergedBuffer, { contentType: `audio/${ext}` });
        if (uploadError) throw new Error(`Failed to upload merged audio: ${uploadError.message}`);
        
        console.log('Cleaning up individual audio files');
        await supabase.storage.from('stories').remove(partPaths);
      }

      outputPath = mergedPath;
      outputVersion = isCorrected ? 8 : 7;
    } else {
      console.log(`Creating grouped audio files (preference: separate, ${numParts} parts >= threshold ${threshold})`);
      
      // Group files for separate preference
      let maxPerGroup: number;
      if (modelVersion === 'lemonfox') {
        maxPerGroup = 10;
      } else {
        maxPerGroup = 19;
      }

      const numGroups = Math.ceil(numParts / maxPerGroup);
      const groupSizes = new Array(numGroups).fill(Math.floor(numParts / numGroups));
      let remainder = numParts % numGroups;
      for (let i = 0; i < remainder; i++) {
        groupSizes[i]++;
      }

      console.log(`Creating ${numGroups} groups with sizes: ${groupSizes.join(', ')}`);

      let partIndex = 0;
      for (let g = 0; g < numGroups; g++) {
        const size = groupSizes[g];
        const groupPartPaths = partPaths.slice(partIndex, partIndex + size);
        partIndex += size;
        const groupPath = `${folderPath}/group_${g + 1}.${ext}`;

        console.log(`Processing group ${g + 1}/${numGroups} with ${size} parts`);

        if (size === 1) {
          const fromPath = groupPartPaths[0];
          const { error: moveError } = await supabase.storage.from('stories').move(fromPath, groupPath);
          if (moveError) throw new Error(`Failed to move group audio: ${moveError.message}`);
        } else {
          const buffers = await Promise.all(
            groupPartPaths.map(async (p, idx) => {
              let buffer: ArrayBuffer;
              const maxDownloadAttempts = 15;
              const downloadDelay = 3000;
              
              for (let att = 0; att < maxDownloadAttempts; att++) {
                try {
                  const { data, error } = await supabase.storage.from('stories').download(p);
                  if (error) {
                    console.log(`Group ${g + 1}, file ${idx + 1} - Attempt ${att + 1}/${maxDownloadAttempts} failed: ${error.message}`);
                    if (att < maxDownloadAttempts - 1) {
                      await new Promise(resolve => setTimeout(resolve, downloadDelay));
                      continue;
                    }
                    throw new Error(`Failed to download after ${maxDownloadAttempts} attempts: ${error.message}`);
                  }
                  
                  buffer = await data.arrayBuffer();
                  if (buffer.byteLength > 100) {
                    return buffer;
                  }
                  
                  console.log(`Group ${g + 1}, file ${idx + 1} - Small audio (${buffer.byteLength} bytes), attempt ${att + 1}/${maxDownloadAttempts}`);
                  if (att < maxDownloadAttempts - 1) {
                    await new Promise(resolve => setTimeout(resolve, downloadDelay));
                  }
                } catch (downloadError: any) {
                  console.log(`Group ${g + 1}, file ${idx + 1} - Download error: ${downloadError.message}`);
                  if (att < maxDownloadAttempts - 1) {
                    await new Promise(resolve => setTimeout(resolve, downloadDelay));
                  }
                }
              }
              throw new Error(`Audio from ${p} remains invalid after ${maxDownloadAttempts} attempts`);
            })
          );
          
          const groupBuffer = mergeFunc(buffers);
          const { error: uploadError } = await supabase.storage
            .from('stories')
            .upload(groupPath, groupBuffer, { contentType: `audio/${ext}` });
          if (uploadError) throw new Error(`Failed to upload group audio: ${uploadError.message}`);
        }
      }
      
      await supabase.storage.from('stories').remove(partPaths);
      outputPath = folderPath;
      outputVersion = isCorrected ? 10 : 9;
    }

    // Volume boost is now fire-and-forget at the end of the function to avoid
    // Deno Deploy wall clock timeout (~150s) — GCloud boost takes ~163s.
    // GCloud replaces files in-place (same URLs) and handles its own token billing.

    const { data: urlData } = supabase.storage.from('stories').getPublicUrl(outputPath);
    if (!urlData?.publicUrl) throw new Error('Failed to retrieve public URL');

    const documentId = crypto.randomUUID();
    const cleanedTitle = title.replace('Audio Prompt: ', '');

    console.log('Saving final audio document to database');
    const { error: docError } = await supabase
      .from('story_documents')
      .insert({
        id: documentId,
        title: `Audio Outputs: ${cleanedTitle}`,
        description,
        version: outputVersion,
        is_corrected: isCorrected,
        is_prompted: false,
        user_id: userId,
        file_path: outputPath,
        file_url: urlData.publicUrl,
        created_at: new Date().toISOString(),
        group_id: groupId,
        variant,
        tab: tab
      });

    if (docError) throw new Error(`Failed to save document: ${docError.message}`);

    console.log(`Successfully created audio document with ID: ${documentId}`);

    // Trigger size calculation asynchronously (fire-and-forget)
    triggerSizeCalculation(documentId, outputPath, outputVersion).catch(err => 
      console.warn(`Size calculation failed for ${documentId}:`, err.message)
    );

    console.log('Updating all audio tasks to completed_final and tracking document ID');
    await supabase
      .from('audio_tasks')
      .update({ 
        status: 'completed_final',
        audio_document_id: documentId, // Track document ID in task
        updated_at: new Date().toISOString() 
      })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('variant', variant)
      .eq('tab', tab)
      .gt('batch_number', 0);

    // Check if this is part of a video process
    if (videoProcess) {
      console.log('This is a video process, updating video task status and tracking audio_document_id');
      
      // Update ALL video_tasks with audio_document_id (main task and batch tasks)
      const { data: updatedTasks, error: updateError } = await supabase
        .from('video_tasks')
        .update({ 
          audio_document_id: documentId,
          updated_at: new Date().toISOString()
        })
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .select('id, doc_id');
      
      if (updateError) {
        console.error(`Error updating video_tasks with audio_document_id: ${updateError.message}`);
        throw new Error(`Failed to update video_tasks with audio_document_id: ${updateError.message}`);
      }
      
      console.log(`Updated ${updatedTasks?.length || 0} video_tasks rows with audio_document_id: ${documentId}`);
      console.log(`Updated task IDs: ${updatedTasks?.map(t => t.id).join(', ')}`);

      // Check if audio mode is enabled - need to calculate duration and trigger image prompts
      const { data: videoTask, error: videoTaskError } = await supabase
        .from('video_tasks')
        .select('frequency_mode, frequency_type, consistent_frequency, audio_distribution_type, first_page_image_amount, rest_image_amount, image_amount, image_prompt_status, process_images, use_character_descriptions, image_style, image_model, text_language, model, story_title, description, story_file_path, visual_type, video_model, video_duration, itv_model, itv_duration, ttv_prompt_status, itv_prompt_status, audio_clip, settings')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .is('current_batch_number', null) // Main task only (batch tasks have current_batch_number set)
        .single();

      // Only process audio duration and trigger image prompts in audio mode
      if (videoTask && videoTask.frequency_mode === 'audio') {
        console.log('Audio mode detected, calculating actual audio duration from generated files...');

        try {
          // Step 1: Calculate actual duration from the created audio files
          const audioFolderPath = outputPath.substring(0, outputPath.lastIndexOf('/'));
          console.log(`Calling calculate-audio-duration for path: ${audioFolderPath}`);

          const durationResponse = await fetchWithDenoFallback('calculate-audio-duration', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseServiceRoleKey,
            },
            body: JSON.stringify({
              folderPath: audioFolderPath
            }),
          });

          if (!durationResponse.ok) {
            throw new Error(`Failed to calculate audio duration: ${durationResponse.status} ${await durationResponse.text()}`);
          }

          const durationData = await durationResponse.json();
          const totalDuration = durationData.totalDuration;
          console.log(`Calculated total audio duration: ${totalDuration} seconds`);

          // Step 2: Update story_documents table with audio_duration
          await supabase
            .from('story_documents')
            .update({
              audio_duration: totalDuration,
              updated_at: new Date().toISOString()
            })
            .eq('id', documentId);

          console.log(`Updated story_documents with audio_duration: ${totalDuration} seconds`);

          // Step 3: Update video_tasks table with total_audio_duration
          await supabase
            .from('video_tasks')
            .update({
              total_audio_duration: totalDuration,
              updated_at: new Date().toISOString()
            })
            .eq('group_id', groupId)
            .eq('user_id', userId);

          console.log(`Updated video_tasks with total_audio_duration: ${totalDuration} seconds`);

          // Step 4: Trigger image prompts if needed (pending and images enabled)
          if (videoTask.image_prompt_status === 'pending' && videoTask.process_images !== false) {
            console.log('Triggering image prompt generation with audio mode...');
            const setupPromptResponse = await fetchWithDenoFallback('storyscriptai-setup-prompt', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseServiceRoleKey,
              },
              body: JSON.stringify({
                user_id: userId,
                group_id: groupId,
                file_path: videoTask.story_file_path,
                story_title: videoTask.story_title,
                description: videoTask.description,
                style: videoTask.image_style,
                useCharacterDescriptions: videoTask.use_character_descriptions || false,
                firstPageFrequency: null, // Not used in audio mode
                restFrequency: 60, // Default value, not used in audio mode
                variant: variant,
                doc_id: documentId, // Pass the audio document ID
                userTokenBalance: 1000000,
                imageModel: mapImageModelToLegacy(videoTask.image_model || 'gpt-image-1-mini'),
                language: videoTask.text_language || 'english',
                model: videoTask.model || 'sonnet',
                videoProcess: true,
                tab: tab,
                // Audio mode configuration
                frequencyMode: 'audio',
                frequencyType: videoTask.frequency_type || 'consistent',
                consistentFrequency: videoTask.consistent_frequency,
                audioDistributionType: videoTask.audio_distribution_type || 'consistent',
                audioFirstPageImageCount: videoTask.first_page_image_amount,
                audioRestImageCount: videoTask.rest_image_amount,
                totalAudioDuration: totalDuration,
                imageAmount: videoTask.image_amount,
                // Custom characters
                customCharactersEnabled: videoTask.settings?.customCharactersEnabled || false,
                customCharacters: videoTask.settings?.customCharacters || [],
                customCharactersAIEnhance: videoTask.settings?.customCharactersAIEnhance || false
              }),
            });

            if (setupPromptResponse.ok) {
              console.log('Successfully triggered image prompt generation in audio mode');
            } else {
              const errorText = await setupPromptResponse.text();
              console.error(`Failed to trigger image prompts: ${setupPromptResponse.status} - ${errorText}`);
            }
          } else {
            if (videoTask.image_prompt_status !== 'pending') {
              console.log(`Skipping image prompt trigger - status is ${videoTask.image_prompt_status}, not pending`);
            } else if (videoTask.process_images === false) {
              console.log('Skipping image prompt trigger - image processing disabled');
            }
          }
        } catch (audioModeError: any) {
          console.error(`Error in audio mode flow: ${audioModeError.message}`);
          // Don't throw - let the process continue
        }
      } else {
        if (!videoTask) {
          console.log('No video task found for audio duration calculation');
        } else if (videoTask.frequency_mode !== 'audio') {
          console.log(`Skipping audio duration calculation - frequency_mode is ${videoTask.frequency_mode}, not audio`);
        }
      }

      // Handle TTV/ITV/MG prompt triggering after audio compilation
      // TTV/ITV/MG always need totalAudioDuration, so calculate it here if not done by audio mode
      const visualType = videoTask?.visual_type || 'image';
      if (videoTask && (visualType === 'ttv' || visualType === 'itv' || visualType === 'mg')) {
        try {
          let totalAudioDuration = 0;
          const audioFolderPathForDuration = outputPath.substring(0, outputPath.lastIndexOf('/'));

          if (videoTask.frequency_mode !== 'audio') {
            // Audio mode didn't run, so calculate duration now
            console.log(`Calculating audio duration for ${visualType} mode...`);
            const durationResp = await fetchWithDenoFallback('calculate-audio-duration', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseServiceRoleKey,
              },
              body: JSON.stringify({ folderPath: audioFolderPathForDuration }),
            });

            if (!durationResp.ok) {
              throw new Error(`Failed to calculate audio duration: ${durationResp.status}`);
            }

            const durationResult = await durationResp.json();
            totalAudioDuration = Number(durationResult.totalDuration) || 0;
            console.log(`Calculated total audio duration for ${visualType}: ${totalAudioDuration} seconds`);

            // Store duration
            await supabase
              .from('story_documents')
              .update({ audio_duration: totalAudioDuration, updated_at: new Date().toISOString() })
              .eq('id', documentId);

            await supabase
              .from('video_tasks')
              .update({ total_audio_duration: totalAudioDuration, updated_at: new Date().toISOString() })
              .eq('group_id', groupId)
              .eq('user_id', userId);
          } else {
            // Duration already calculated by audio mode flow above
            const { data: durationTask } = await supabase
              .from('video_tasks')
              .select('total_audio_duration')
              .eq('group_id', groupId)
              .eq('user_id', userId)
              .is('current_batch_number', null)
              .single();
            // Supabase returns `numeric` columns as strings — coerce to number
            totalAudioDuration = Number(durationTask?.total_audio_duration) || 0;
          }

          console.log(`Total audio duration for ${visualType}: ${totalAudioDuration} seconds`);
          if (totalAudioDuration <= 0) {
            throw new Error(`Cannot determine audio duration for ${visualType} prompt setup`);
          }

          if (visualType === 'ttv' && videoTask.ttv_prompt_status === 'pending') {
            console.log('Triggering TTV prompt setup...');
            const ttvResponse = await fetchWithDenoFallback('setup-ttv-prompts', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseServiceRoleKey,
              },
              body: JSON.stringify({
                user_id: userId,
                group_id: groupId,
                file_path: videoTask.story_file_path,
                story_title: videoTask.story_title,
                description: videoTask.description,
                style: videoTask.image_style,
                video_model: videoTask.video_model,
                video_duration: Number(videoTask.video_duration) || 4.91,
                totalAudioDuration: Number(totalAudioDuration),
                useCharacterDescriptions: videoTask.use_character_descriptions || false,
                model: videoTask.model || 'sonnet',
                language: videoTask.text_language || 'english',
                tab,
                variant,
                userTokenBalance: 1000000,
                audio_clip: videoTask.audio_clip || false,
                videoProcess: true, // skip token balance check when called from pipeline
                // Custom characters
                customCharactersEnabled: videoTask.settings?.customCharactersEnabled || false,
                customCharacters: videoTask.settings?.customCharacters || [],
                customCharactersAIEnhance: videoTask.settings?.customCharactersAIEnhance || false,
              }),
            });

            if (ttvResponse.ok) {
              console.log('Successfully triggered TTV prompt setup');
              await supabase
                .from('video_tasks')
                .update({ ttv_prompt_status: 'running', updated_at: new Date().toISOString() })
                .eq('group_id', groupId)
                .eq('user_id', userId);
            } else {
              const errorText = await ttvResponse.text();
              console.error(`Failed to trigger TTV prompts: ${ttvResponse.status} - ${errorText}`);
            }
          } else if (visualType === 'itv' && videoTask.itv_prompt_status === 'pending') {
            console.log('Triggering ITV prompt setup (Phase 1 image prompts + Phase 2 motion prompts)...');
            const itvResponse = await fetchWithDenoFallback('setup-itv-prompts', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseServiceRoleKey,
              },
              body: JSON.stringify({
                user_id: userId,
                group_id: groupId,
                file_path: videoTask.story_file_path,
                story_title: videoTask.story_title,
                description: videoTask.description,
                video_model: videoTask.itv_model || videoTask.video_model,
                clip_duration: Number(videoTask.itv_duration) || undefined,
                totalAudioDuration,
                image_model: videoTask.image_model,
                model: videoTask.model || 'sonnet',
                language: videoTask.text_language || 'english',
                tab,
                variant,
                audio_clip: videoTask.audio_clip || false,
                useCharacterDescriptions: videoTask.use_character_descriptions || false,
                userTokenBalance: 1000000,
                style: videoTask.image_style,
                videoProcess: true,
                // Custom characters
                customCharactersEnabled: videoTask.settings?.customCharactersEnabled || false,
                customCharacters: videoTask.settings?.customCharacters || [],
                customCharactersAIEnhance: videoTask.settings?.customCharactersAIEnhance || false,
              }),
            });

            if (itvResponse.ok) {
              console.log('Successfully triggered ITV prompt setup');
              await supabase
                .from('video_tasks')
                .update({
                  image_prompt_status: 'running',
                  itv_prompt_status: 'running',
                  updated_at: new Date().toISOString()
                })
                .eq('group_id', groupId)
                .eq('user_id', userId);
            } else {
              const errorText = await itvResponse.text();
              console.error(`Failed to trigger ITV prompts: ${itvResponse.status} - ${errorText}`);
            }
          } else if (visualType === 'mg' && videoTask.mg_prompt_status === 'pending') {
            console.log('Triggering MG prompt setup (Phase 1 segment prompts + Phase 2 clip codegen)...');
            const mgResponse = await fetchWithDenoFallback('setup-mg-prompts', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseServiceRoleKey,
              },
              body: JSON.stringify({
                user_id: userId,
                group_id: groupId,
                file_path: videoTask.story_file_path,
                story_title: videoTask.story_title,
                description: videoTask.description,
                style_slug: videoTask.mg_style_slug,
                style_guidance: videoTask.mg_style_guidance || null,
                clip_duration: Number(videoTask.mg_clip_duration) || 10,
                totalAudioDuration,
                codegen_model: videoTask.mg_codegen_model || 'claude-opus-4-6',
                model: videoTask.model || 'sonnet',
                language: videoTask.text_language || 'english',
                tab,
                variant,
                userTokenBalance: 1000000,
                audio_enabled: true,
                videoProcess: true,
                video_task_id: videoTask.id,
              }),
            });

            if (mgResponse.ok) {
              console.log('Successfully triggered MG prompt setup');
              await supabase
                .from('video_tasks')
                .update({
                  mg_prompt_status: 'running',
                  updated_at: new Date().toISOString(),
                })
                .eq('group_id', groupId)
                .eq('user_id', userId);
            } else {
              const errorText = await mgResponse.text();
              console.error(`Failed to trigger MG prompts: ${mgResponse.status} - ${errorText}`);
            }
          }
        } catch (ttvItvError: any) {
          console.error(`Error in ${visualType} prompt trigger flow: ${ttvItvError.message}`);
        }
      }

      // Check if all statuses will be completed after audio generation
      const { data: videoTaskCheck } = await supabase
        .from('video_tasks')
        .select('video, process_story, process_images, process_audio, story_status, image_prompt_status, image_generation_status, visual_type, ttv_prompt_status, ttv_status, itv_prompt_status, itv_status')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .single();

      const vtCheck = videoTaskCheck?.visual_type || 'image';
      const willBeAllCompleted = videoTaskCheck && 
        videoTaskCheck.video === false && 
        (!videoTaskCheck.process_story || videoTaskCheck.story_status === 'completed') &&
        (!videoTaskCheck.process_images || (videoTaskCheck.image_prompt_status === 'completed' && videoTaskCheck.image_generation_status === 'completed')) &&
        (vtCheck !== 'ttv' || (videoTaskCheck.ttv_prompt_status === 'completed' && videoTaskCheck.ttv_status === 'completed')) &&
        (vtCheck !== 'itv' || (videoTaskCheck.itv_prompt_status === 'completed' && videoTaskCheck.itv_status === 'completed'));

      // Update audio_status - set to completed_final if all will be complete and video=false
      await supabase
        .from('video_tasks')
        .update({
          audio_status: willBeAllCompleted ? 'completed_final' : 'completed',
          audio_progress: 100,
          overall_progress: willBeAllCompleted ? 100 : 75,
          overall_status: willBeAllCompleted ? 'completed_final' : undefined,
          video_creation_status: willBeAllCompleted ? 'completed_final' : undefined,
          individual_video_status: willBeAllCompleted ? 'completed_final' : undefined,
          completed_at: willBeAllCompleted ? new Date().toISOString() : undefined,
          updated_at: new Date().toISOString()
        })
        .eq('group_id', groupId)
        .eq('user_id', userId);

      // If all completed, trigger cleanup and return early
      if (willBeAllCompleted) {
        console.log(`All parts completed, setting final status and cleaning up for group ${groupId}`);
        await deleteTaskRows(userId, groupId, variant, tab);
        return;
      }

      // Check if all statuses are completed (using updated function)
      const allCompleted = await checkAllStatusesCompleted(userId, groupId);
      if (allCompleted) {
        // All parts are completed, trigger video creation (which will check video flag)
        await triggerVideoCreation(userId, groupId, variant, tab);
      } else {
        console.log(`Audio generation completed but other parts still pending for group ${groupId}`);
      }
    }

    // Fire-and-forget volume boost AFTER all DB updates and video triggers are done.
    // GCloud runs independently — even if this isolate dies, the boost completes.
    // Files are replaced in-place so URLs remain valid.
    if (volume && volume > 1.0) {
      console.log(`Firing volume boost of ${volume}x (non-blocking)`);
      applyVolumeBoostIfNeeded(userId, folderPath, volume, modelVersion)
        .then(tokens => console.log(`Volume boost completed, used ${tokens} tokens`))
        .catch(err => console.error(`Volume boost failed (non-blocking): ${err.message}`));
    }

    console.log(`Successfully compiled final audio for group ${groupId} ${volume && volume > 1.0 ? `with ${volume}x volume boost` : ''}`);

  } catch (error: any) {
    await logError('Error compiling final audio', error);
    // Only set tasks to 'error' that are NOT already 'completed' or 'completed_final'
    // This prevents a failing second invocation from corrupting successfully completed tasks
    // Also resets batch 1 from 'compiling' back to 'error' so retries can re-acquire the lock
    await supabase
      .from('audio_tasks')
      .update({ 
        status: 'error', 
        error: `Failed to compile audio: ${error.message}`, 
        updated_at: new Date().toISOString() 
      })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('variant', variant)
      .eq('tab', tab)
      .gt('batch_number', 0)
      .not('status', 'in', '("completed","completed_final")');

    // Revert video_tasks status for tracking
    if (videoProcess) {
      await supabase
        .from('video_tasks')
        .update({ audio_status: 'error', updated_at: new Date().toISOString() })
        .eq('group_id', groupId)
        .eq('user_id', userId);
    }
    throw error;
  }
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    // Verify authentication
    const authHeader = req.headers.get('Authorization');
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!authToken) {
      return new Response(JSON.stringify({ error: 'Missing authorization', code: 401 }), { status: 401, headers: responseHeaders });
    }    // authToken resolved above (Bearer or apikey)
    const _srvKey = Deno.env.get('SECRET_KEY') || '';
    const _secretKey = Deno.env.get('SECRET_KEY') || '';
    let userId: string | null = null;
    if (authToken !== _srvKey && authToken !== _secretKey) {
      const { data: { user: _authUser }, error: _authErr } = await supabase.auth.getUser(authToken);
      if (_authErr || !_authUser) {
        return new Response(JSON.stringify({ error: 'Invalid or expired token', code: 401 }), { status: 401, headers: responseHeaders });
      }
      userId = _authUser.id;
    }

    let payload;
    try {
      payload = await req.json();
    } catch (error) {
      await logError('Invalid JSON payload', error);
      return new Response(JSON.stringify({ error: 'Invalid JSON payload', code: 400 }), { status: 400, headers: responseHeaders });
    }

    // Override user_id from JWT for non-service-role calls
    if (userId) {
      payload.user_id = userId;
    }

    const {
      user_id,
      group_id,
      story_title,
      description,
      variant = 1,
      is_corrected,
      version,
      folder_timestamp,
      model_version,
      preference,
      single_audio,
      video_process,
      volume,
      tab = 1
    } = payload;

    // Validate required fields
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!user_id || !uuidRegex.test(user_id)) {
      return new Response(JSON.stringify({ error: 'Missing or invalid user_id', code: 400 }), { status: 400, headers: responseHeaders });
    }
    if (!group_id || !uuidRegex.test(group_id)) {
      return new Response(JSON.stringify({ error: 'Missing or invalid group_id', code: 400 }), { status: 400, headers: responseHeaders });
    }
    if (!story_title || typeof story_title !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing or invalid story_title', code: 400 }), { status: 400, headers: responseHeaders });
    }

    console.log(`Starting audio compilation for group ${group_id}, tab ${tab}, model: ${model_version}, preference: ${preference}, volume: ${volume || 1.0}`);

    await compileFinalAudio(
      user_id,
      group_id,
      story_title,
      description,
      variant,
      is_corrected,
      version,
      folder_timestamp,
      model_version,
      preference,
      single_audio,
      video_process || false,
      volume,
      tab
    );

    return new Response(JSON.stringify({ success: true, message: 'Audio compilation completed successfully' }), { status: 200, headers: responseHeaders });

  } catch (err: any) {
    await logError('Error in compile-audio', err);
    return new Response(JSON.stringify({ error: err.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});




