import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { supabase, logError, checkTokenAvailability, verifyAuth } from '../_shared/utils.ts';
import { fetchWithDenoFallback } from '../_shared/fetchWithDenoFallback.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseKey = Deno.env.get('SECRET_KEY') ?? '';
if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

// Predefined clone voices list (matching setup-video-tasks)
const predefinedCloneVoices = [
  { name: "Declan", voice_id: "default-ujsa1wysgyitfqg3ixpqka__declan" },
  { name: "Adrian", voice_id: "default-ujsa1wysgyitfqg3ixpqka__adrian" },
  { name: "Alfred", voice_id: "default-ujsa1wysgyitfqg3ixpqka__alfred" },
  { name: "Conrad", voice_id: "default-ujsa1wysgyitfqg3ixpqka__conrad" },
  { name: "Hugo", voice_id: "default-ujsa1wysgyitfqg3ixpqka__hugo" },
  { name: "Ryder", voice_id: "default-ujsa1wysgyitfqg3ixpqka__ryder" },
  { name: "Victor", voice_id: "default-ujsa1wysgyitfqg3ixpqka__victor" }
];

// Voice type detection functions (matching setup-video-tasks)
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

interface Chapter {
  number: number;
  title: string;
  part: string;
  word_count: number;
  summary: string;
}

interface StoryTask {
  id: string;
  user_id: string;
  group_id: string;
  batch: Chapter[];
  previous_content: string;
  total_word_count: number;
  batch_number: number;
  status: string;
  story_title: string;
  description: string;
  total_batches: number;
  pauses: boolean;
}

async function triggerNextVideoStep(userId: string, groupId: string, step: 'image_prompts'): Promise<void> {
  try {
    console.log(`Triggering next video step: ${step} for group ${groupId}`);
    
    // Get video task settings first to check for video_loop and processing flags
    const { data: videoTask } = await supabase
      .from('video_tasks')
      .select('*, frequency_mode, frequency_type, consistent_frequency')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .single();

    if (!videoTask) {
      throw new Error('Video task not found');
    }

    // Check processing flags
    const processImages = videoTask.process_images !== false;
    const processAudio = videoTask.process_audio !== false;

    // Detect visual pipeline type (image / ttv / itv)
    const visualType = videoTask.visual_type || 'image';
    const isTTV = visualType === 'ttv';
    const isITV = visualType === 'itv';

    // Check if video_loop is being used
    const hasVideoLoop = !!videoTask.video_loop || !!videoTask.settings?.video_loop;
    
    // Check if we're in audio mode and need to generate audio (not uploaded)
    const isAudioMode = videoTask.frequency_mode === 'audio';
    const hasUploadedAudio = videoTask.audio_files && Array.isArray(videoTask.audio_files) && videoTask.audio_files.length > 0;
    const needsAudioGeneration = isAudioMode && !hasUploadedAudio;
    
    // Get text language from video task
    const textLanguage = videoTask.text_language || 'english';
    
    // Check if all processes will be complete after story completion
    const storyWillBeCompleted = true;
    // If audio needs to be generated in audio mode, images will be triggered by compile-audio
    // For TTV: images not needed (completed). For ITV: images deferred to compile-audio.
    const imagesWillBeCompleted = !processImages || hasVideoLoop || needsAudioGeneration || isTTV || isITV;
    const audioWillBeCompleted = !processAudio;
    // TTV/ITV prompt setup always deferred to compile-audio (needs totalAudioDuration)
    const visualPipelineWillBeCompleted = !isTTV && !isITV;
    const allWillBeCompleted = videoTask.video === false && storyWillBeCompleted && imagesWillBeCompleted && audioWillBeCompleted && visualPipelineWillBeCompleted;

    // Build update object conditionally - don't update image statuses if waiting for audio generation
    const updateData: any = {
      story_status: allWillBeCompleted ? 'completed_final' : 'completed',
      story_progress: 100,
      audio_status: processAudio ? 'running' : (allWillBeCompleted ? 'completed_final' : 'completed'),
      overall_progress: allWillBeCompleted ? 100 : 25,
      updated_at: new Date().toISOString()
    };

    // Set visual pipeline statuses based on visual_type
    if (isTTV) {
      // TTV: images not needed, TTV pipeline deferred to compile-audio (needs totalAudioDuration)
      updateData.image_prompt_status = 'completed';
      updateData.image_generation_status = 'completed';
      updateData.ttv_prompt_status = 'pending'; // Will be set to 'running' by compile-audio
      updateData.ttv_status = 'pending';
      updateData.itv_prompt_status = 'completed';
      updateData.itv_status = 'completed';
    } else if (isITV) {
      // ITV Phase 1 (keyframe images) + Phase 2 (motion prompts) deferred to compile-audio
      updateData.image_prompt_status = 'pending';
      updateData.image_generation_status = 'pending';
      updateData.itv_prompt_status = 'pending';
      updateData.itv_status = 'pending';
      updateData.ttv_prompt_status = 'completed';
      updateData.ttv_status = 'completed';
    } else if (!needsAudioGeneration) {
      // Standard image pipeline: update image statuses if NOT waiting for audio generation
      // When needsAudioGeneration is true, compile-audio will update these after triggering image generation
      updateData.image_prompt_status = (processImages && !hasVideoLoop) ? 'running' : (allWillBeCompleted ? 'completed_final' : 'completed');
      updateData.image_generation_status = (processImages && !hasVideoLoop) ? 'pending' : (allWillBeCompleted ? 'completed_final' : 'completed');
    }

    // Add completion fields if all will be completed
    if (allWillBeCompleted) {
      updateData.overall_status = 'completed_final';
      updateData.video_creation_status = 'completed_final';
      updateData.individual_video_status = 'completed_final';
      updateData.completed_at = new Date().toISOString();
    }

    // Update video task status
    await supabase
      .from('video_tasks')
      .update(updateData)
      .eq('id', videoTask.id);

    // If all completed, skip the rest and return early
    if (allWillBeCompleted) {
      console.log(`All processes completed and video=false, set final completion status for video task ${videoTask.id}`);
      return;
    }

    // Get the completed story document
    const { data: storyDoc } = await supabase
      .from('story_documents')
      .select('*')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!storyDoc) {
      throw new Error('Story document not found');
    }

    // Update video task with story document ID
    await supabase
      .from('video_tasks')
      .update({
        story_file_path: storyDoc.file_path,
        doc_id: storyDoc.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', videoTask.id);

    // Only trigger image prompt generation if:
    // 1. Processing images is enabled
    // 2. NOT using video loop
    // 3. NOT in audio generation mode (audio mode with no uploaded audio)
    // 4. NOT TTV mode (TTV prompts triggered by compile-audio after totalAudioDuration is known)
    // 5. NOT ITV mode (ITV prompts triggered by compile-audio after totalAudioDuration is known)
    // In audio/TTV/ITV mode, compile-audio will trigger the appropriate prompts after calculating duration
    //
    // Build the image-prompt and audio kick-offs as independent async tasks and run them with
    // Promise.allSettled. They have no data dependency on each other, and audio MUST not be blocked
    // by a slow / falling-back image-prompts call (e.g. Deno Deploy 503 → Supabase fallback adds
    // multi-second latency, which previously caused the parent isolate to shut down before audio
    // was ever invoked when the trigger ran in the background).
    const shouldTriggerImagePrompts = processImages && !hasVideoLoop && !needsAudioGeneration && !isTTV && !isITV;

    const triggerImagePrompts = async (): Promise<void> => {
      if (!shouldTriggerImagePrompts) {
        if (!processImages) {
          console.log(`Skipping image generation - image processing disabled for video task ${videoTask.id}`);
        } else if (hasVideoLoop) {
          console.log(`Skipping image generation - using video loop for video task ${videoTask.id}`);
        } else if (isTTV) {
          console.log(`Skipping image generation - TTV mode, TTV prompts will be triggered by compile-audio for video task ${videoTask.id}`);
        } else if (isITV) {
          console.log(`Skipping image generation - ITV mode, ITV prompts will be triggered by compile-audio for video task ${videoTask.id}`);
        } else if (needsAudioGeneration) {
          console.log(`Skipping image generation - will be triggered by compile-audio after duration calculation for video task ${videoTask.id}`);
        }
        return;
      }

      const imagePromptResponse = await fetchWithDenoFallback('storyscriptai-setup-prompt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
        },
        body: JSON.stringify({
          user_id: userId,
          group_id: groupId,
          file_path: storyDoc.file_path,
          story_title: videoTask.story_title,
          description: videoTask.description,
          style: videoTask.image_style,
          useCharacterDescriptions: videoTask.use_character_descriptions,
          // Handle consistent vs variable frequency modes
          frequencyMode: videoTask.frequency_mode || 'wordcount',
          frequencyType: videoTask.frequency_type || 'variable',
          consistentFrequency: videoTask.consistent_frequency,
          firstPageFrequency: (videoTask.frequency_type === 'consistent')
            ? null
            : videoTask.first_page_frequency,
          restFrequency: (videoTask.frequency_type === 'consistent' && videoTask.consistent_frequency)
            ? videoTask.consistent_frequency
            : videoTask.rest_frequency,
          variant: videoTask.variant,
          doc_id: storyDoc.id,
          userTokenBalance: 1000000, // High number for video process
          imageModel: mapImageModelToLegacy(videoTask.image_model || 'gpt-image-1-mini'), // FIXED: Use mapImageModelToLegacy
          language: textLanguage, // Use text_language from video task
          model: videoTask.model || videoTask.settings?.model || 'sonnet', // FIXED: Add missing model parameter
          videoProcess: true,
          tab: videoTask.tab || 1, // Forward tab for enterprise users
          // Custom characters
          customCharactersEnabled: videoTask.settings?.customCharactersEnabled || false,
          customCharacters: videoTask.settings?.customCharacters || [],
          customCharactersAIEnhance: videoTask.settings?.customCharactersAIEnhance || false
        }),
      });

      if (!imagePromptResponse.ok) {
        throw new Error(`Failed to trigger image prompt generation: ${imagePromptResponse.status}`);
      }
      console.log(`Successfully triggered image prompt generation for video task ${videoTask.id}`);
    };

    const triggerAudio = async (): Promise<void> => {
      if (!processAudio) {
        console.log(`Skipping audio generation - audio processing disabled for video task ${videoTask.id}`);
        return;
      }

      // Determine model version and clone voice parameters based on voice prefix if not provided
      let finalModelVersion = videoTask.model_version || 'lemonfox';
      let cloneVoiceName: string | undefined;
      let cloneVoiceUrl: string | undefined;
      let cloneLanguage: string | undefined;
      
      if (!videoTask.model_version && videoTask.voice) {
        if (isCoreVoice(videoTask.voice)) {
          finalModelVersion = 'lemonfox';
        } else if (isPremiumVoice(videoTask.voice)) {
          finalModelVersion = 'v7';
        } else if (isApexVoice(videoTask.voice)) {
          finalModelVersion = 'speechify';
        } else if (isElevenLabsVoice(videoTask.voice)) {
          finalModelVersion = 'elevenlabs';
        } else if (isCloneVoice(videoTask.voice)) {
          finalModelVersion = 'clone';
          cloneVoiceName = videoTask.voice.split(':')[1];
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

      // Handle explicit clone voice parameters from videoTask
      if (finalModelVersion === 'clone') {
        cloneVoiceName = cloneVoiceName || videoTask.clone_voice_name;
        cloneVoiceUrl = cloneVoiceUrl || videoTask.clone_voice_url;
        cloneLanguage = cloneLanguage || videoTask.clone_language;
      }

      // Extract voice name from the voice parameter
      const voiceName = videoTask.voice && videoTask.voice.includes(':') ? videoTask.voice.split(':')[1] : videoTask.voice;

      // Retry logic: cold starts and transient network blips cause ~1% failures.
      // audio_status is already set to 'running' above, so we must succeed or explicitly reset it.
      const MAX_AUDIO_RETRIES = 3;
      const audioPayload = JSON.stringify({
        user_id: userId,
        group_id: groupId,
        file_path: storyDoc.file_path,
        story_title: videoTask.story_title,
        description: videoTask.description,
        doc_id: storyDoc.id,
        variant: videoTask.variant,
        voice: voiceName,
        language: videoTask.language,
        model_version: finalModelVersion,
        elevenlabs_model_id: finalModelVersion === 'elevenlabs' ? (videoTask.settings?.elevenlabs_model_id || videoTask.elevenlabs_model_id || 'eleven_multilingual_v2') : undefined,
        speed: videoTask.speed,
        volume: videoTask.volume || 1.0,
        preference: videoTask.preference,
        remove_title_chapters: videoTask.remove_title_chapters,
        clone_voice_name: cloneVoiceName,
        clone_voice_url: cloneVoiceUrl,
        clone_language: cloneLanguage,
        videoProcess: true,
        tab: videoTask.tab || 1,
        pauses: videoTask.pauses || false
      });

      let audioResponse: Response | null = null;
      let lastAudioError = '';
      for (let attempt = 0; attempt < MAX_AUDIO_RETRIES; attempt++) {
        if (attempt > 0) {
          const delay = 2000 * attempt; // 2s, 4s
          console.log(`Retrying setup-audio-tasks, attempt ${attempt + 1} after ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        try {
          const resp = await fetch(`${supabaseUrl}/functions/v1/setup-audio-tasks`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseKey,
            },
            body: audioPayload,
          });
          if (resp.ok || resp.status === 409) { // 409 = tasks already exist, treat as success
            audioResponse = resp;
            break;
          }
          lastAudioError = `HTTP ${resp.status}`;
          console.warn(`setup-audio-tasks attempt ${attempt + 1} failed: ${lastAudioError}`);
        } catch (fetchErr: any) {
          lastAudioError = fetchErr.message;
          console.warn(`setup-audio-tasks attempt ${attempt + 1} threw: ${lastAudioError}`);
        }
      }

      if (!audioResponse || (!audioResponse.ok && audioResponse.status !== 409)) {
        throw new Error(`Failed to trigger audio generation after ${MAX_AUDIO_RETRIES} attempts: ${lastAudioError}`);
      }
      console.log(`Successfully triggered audio generation for video task ${videoTask.id}`);
    };

    // Run image-prompt + audio kick-offs in parallel. Use allSettled so a failure in one
    // doesn't prevent the other from being invoked. Failures are logged + surfaced below;
    // image-prompt failure is fatal (throws); audio failure also throws so the catch block
    // resets audio_status='pending' for cron retry. Both are reported even when both fail.
    const [imageResult, audioResult] = await Promise.allSettled([
      triggerImagePrompts(),
      triggerAudio(),
    ]);

    const failures: string[] = [];
    if (imageResult.status === 'rejected') {
      failures.push(`image_prompts: ${imageResult.reason?.message || imageResult.reason}`);
    }
    if (audioResult.status === 'rejected') {
      failures.push(`audio: ${audioResult.reason?.message || audioResult.reason}`);
    }
    if (failures.length > 0) {
      throw new Error(failures.join(' | '));
    }

  } catch (error: any) {
    console.error(`Error triggering next video step: ${error.message}`);
    await logError('Error triggering next video step', error);
    
    // Update video task with error.
    // IMPORTANT: also reset audio_status from 'running' back to 'pending' so the row
    // doesn't stay permanently stuck with no audio_tasks ever created.
    await supabase
      .from('video_tasks')
      .update({
        story_status: 'error',
        overall_status: 'error',
        audio_status: 'pending', // Reset so cron/manual retry can restart audio
        error_message: `Failed to trigger next steps: ${error.message}`,
        updated_at: new Date().toISOString()
      })
      .eq('group_id', groupId)
      .eq('user_id', userId);
  }
}

function validateInputs(data: any): string | null {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!data.group_id || !uuidRegex.test(data.group_id)) return 'Missing or invalid group_id';
  if (!data.user_id || !uuidRegex.test(data.user_id)) return 'Missing or invalid user_id';
  if (typeof data.batch_number !== 'number' || data.batch_number < 1) return 'Missing or invalid batch_number';
  if (typeof data.total_batches !== 'number' || data.total_batches < 1) return 'Missing or invalid total_batches';
  if (typeof data.variant !== 'undefined' && (typeof data.variant !== 'number' || data.variant < 1)) return 'Invalid variant';
  return null;
}

async function getPreviousContent(userId: string, groupId: string, currentBatchNumber: number, tab: number = 1, variant: number = 1): Promise<string> {
  try {
    console.log(`Fetching previous content for group ${groupId}, batch ${currentBatchNumber}, tab ${tab}, variant ${variant}`);
    const { data, error } = await supabase
      .from('story_tasks')
      .select('previous_content')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('variant', variant)
      .lt('batch_number', currentBatchNumber)
      .order('batch_number', { ascending: true });
    if (error) throw new Error(`Failed to fetch previous content: ${error.message}`);
    if (!data || data.length === 0) {
      console.log(`No previous content found for group ${groupId}, batch ${currentBatchNumber}`);
      return '';
    }
    const content = data
      .map(task => task.previous_content)
      .filter(content => content)
      .join('\n\n');
    console.log(`Fetched previous content, length: ${content.length} characters`);
    return content;
  } catch (error: any) {
    console.error(`Error fetching previous content: ${error.message}`);
    await logError('Error fetching previous content', error);
    return '';
  }
}

async function callGenerateStory(chapters: Chapter[], previousContent: string, totalWordCount: number, groupId: string, userId: string, batchNumber: number, tab: number = 1, variant: number = 1): Promise<[string, number, number]> {
  try {
    // First check if story processing is enabled
    const { data: videoTask } = await supabase
      .from('video_tasks')
      .select('process_story')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .single();

    if (videoTask && videoTask.process_story === false) {
      console.log(`Story processing disabled for group ${groupId}, skipping generation`);
      return ['Story processing disabled', 0, 0];
    }

    // First check if the batch is already completed
    console.log(`Checking if batch ${batchNumber} is already completed...`);
    const { data: checkTask } = await supabase
      .from('story_tasks')
      .select('status, previous_content, input_tokens, output_tokens')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('batch_number', batchNumber)
      .eq('tab', tab)
      .eq('variant', variant)
      .single();
    
    if (checkTask?.status === 'completed' && checkTask.previous_content) {
      console.log(`Batch ${batchNumber} is already completed, using existing content`);
      return [checkTask.previous_content, checkTask.input_tokens || 0, checkTask.output_tokens || 0];
    }

    console.log(`Calling generate-story for batch ${batchNumber}`);

    // Fetch youtube_transcript and content_type from outline row (batch_number=0)
    let youtubeTranscript: string | null = null;
    let contentType: string = 'story';
    try {
      const { data: outlineRow } = await supabase
        .from('story_tasks')
        .select('youtube_transcript, content_type')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('batch_number', 0)
        .eq('tab', tab)
        .eq('variant', variant)
        .single();
      youtubeTranscript = outlineRow?.youtube_transcript || null;
      contentType = outlineRow?.content_type || 'story';
      if (youtubeTranscript) {
        console.log(`Found youtube_transcript (${youtubeTranscript.length} chars) for group ${groupId}`);
      }
      if (contentType !== 'story') {
        console.log(`Content type: ${contentType} for group ${groupId}`);
      }
    } catch (e: any) {
      console.warn(`Failed to fetch youtube_transcript/content_type for group ${groupId}: ${e.message}`);
    }

    const response = await fetch(`${supabaseUrl}/functions/v1/generate-story`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
      },
      body: JSON.stringify({
        chapters,
        previous_content: previousContent,
        total_word_count: totalWordCount,
        group_id: groupId,
        user_id: userId,
        batch_number: batchNumber,
        tab: tab,
        variant: variant,
        ...(youtubeTranscript ? { youtube_transcript: youtubeTranscript } : {}),
        ...(contentType !== 'story' ? { content_type: contentType } : {}),
      }),
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}: Failed to generate batch`);

    // Handle 202: generate-story is continuing in background (exceeded 130s idle limit)
    // It will save to DB and trigger next batch on its own.
    if (response.status === 202) {
      console.log(`Batch ${batchNumber} is being generated in background (202), waiting for completion...`);
      // Poll DB for up to ~120s (8 polls * 15s) - generate-story has up to 400s wall time
      for (let poll = 0; poll < 8; poll++) {
        await new Promise(resolve => setTimeout(resolve, 15000));
        const { data: bgCheck } = await supabase
          .from('story_tasks')
          .select('status, previous_content, input_tokens, output_tokens')
          .eq('group_id', groupId)
          .eq('user_id', userId)
          .eq('batch_number', batchNumber)
          .eq('tab', tab)
          .eq('variant', variant)
          .single();

        if (bgCheck?.status === 'completed' && bgCheck.previous_content) {
          console.log(`Background generation for batch ${batchNumber} completed after ~${(poll + 1) * 15}s of polling`);
          return [bgCheck.previous_content, bgCheck.input_tokens || 0, bgCheck.output_tokens || 0];
        }
        console.log(`Poll ${poll + 1}/8: batch ${batchNumber} still generating...`);
      }
      // Not done yet after polling - return empty, generate-story background will handle the rest
      console.log(`Batch ${batchNumber} still generating after polling, generate-story will trigger next batch when done`);
      return ['', 0, 0];
    }

    const result = await response.json();
    
    // Check if a retry was triggered
    if (result.retry_triggered) {
      console.log(`Retry was triggered for batch ${batchNumber}, checking for completion...`);
      
      // Wait a moment and check if the batch was completed by the retry
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const { data: retryCheckTask } = await supabase
        .from('story_tasks')
        .select('status, previous_content, input_tokens, output_tokens')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('batch_number', batchNumber)
        .eq('tab', tab)
        .eq('variant', variant)
        .single();
      
      if (retryCheckTask?.status === 'completed' && retryCheckTask.previous_content) {
        console.log(`Batch ${batchNumber} was completed by retry, using retry content`);
        return [retryCheckTask.previous_content, retryCheckTask.input_tokens || 0, retryCheckTask.output_tokens || 0];
      }
    }
    
    if (!result.content || typeof result.input_tokens !== 'number' || typeof result.output_tokens !== 'number') {
      throw new Error('Invalid generate-story response');
    }
    console.log(`Generated content for batch ${batchNumber}, length: ${result.content.length} characters`);
    return [result.content, result.input_tokens, result.output_tokens];
  } catch (error: any) {
    // Check if task was completed despite the error (including by retry)
    console.log(`Checking if batch ${batchNumber} was completed despite error...`);
    const { data: checkTask } = await supabase
      .from('story_tasks')
      .select('status, previous_content, input_tokens, output_tokens')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('batch_number', batchNumber)
      .eq('tab', tab)
      .eq('variant', variant)
      .single();
    
    if (checkTask?.status === 'completed' && checkTask.previous_content) {
      console.log(`Batch ${batchNumber} was completed despite error response, using existing content`);
      return [checkTask.previous_content, checkTask.input_tokens || 0, checkTask.output_tokens || 0];
    }
    
    console.error(`Error in generate-story for batch ${batchNumber}: ${error.message}`);
    await logError(`Generate-story failed for batch ${batchNumber}`, error);
    // Return empty content instead of throwing error
    return ['', 0, 0];
  }
}

async function compileFinalStory(userId: string, groupId: string, title: string, description: string, tab: number = 1, variant: number = 1) {
  try {
    console.log(`Compiling final story for group ${groupId}, tab ${tab}, variant ${variant}`);

    // Idempotency guard: if a document already exists, just ensure all tasks are marked completed_final
    const { data: existingDoc } = await supabase
      .from('story_documents')
      .select('id')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .limit(1)
      .single();

    if (existingDoc) {
      console.log(`Document already exists for group ${groupId} (tab ${tab}, variant ${variant}), skipping upload and marking all tasks completed_final`);
      await supabase
        .from('story_tasks')
        .update({ status: 'completed_final', story_document_id: existingDoc.id, updated_at: new Date().toISOString() })
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('tab', tab)
        .eq('variant', variant)
        .gt('batch_number', 0);
      return;
    }

    // Fetch pauses flag from the outline task (batch_number = 0)
    const { data: outlineTask } = await supabase
      .from('story_tasks')
      .select('pauses')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('variant', variant)
      .eq('batch_number', 0)
      .single();
    const pauses = outlineTask?.pauses === true;

    const { data, error } = await supabase
      .from('story_tasks')
      .select('previous_content, batch, batch_number, language')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('variant', variant)
      .gt('batch_number', 0)
      .order('batch_number', { ascending: true });
    if (error || !data) throw new Error(`Failed to fetch story content: ${error?.message || 'No data'}`);

    // Start with the story title
    let fullStoryText = `${title}\n\n`;

    // Add each chapter with dynamically generated titles
    data.forEach(task => {
      if (task.previous_content) {
        fullStoryText += `${task.previous_content.trim()}\n\n`;
      }
    });

    console.log(`Compiled final story, length: ${fullStoryText.length} characters`);

    const sanitizedTitle = title.replace(/[^a-zA-Z0-9\s-]/g, '').toLowerCase().trim().replace(/\s+/g, '-');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const finalFilePath = `documents/${userId}/${groupId}/${sanitizedTitle}_${timestamp}.txt`;

    const { error: uploadError } = await supabase.storage
      .from('stories')
      .upload(finalFilePath, new TextEncoder().encode(fullStoryText), { contentType: 'text/plain' });
    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);
    console.log(`Uploaded final story to ${finalFilePath}`);

    const { data: urlData } = supabase.storage.from('stories').getPublicUrl(finalFilePath);
    if (!urlData?.publicUrl) throw new Error('Failed to retrieve public URL');

    const wordCount = fullStoryText.split(/\s+/).filter(word => word.length > 0).length;

    const documentId = crypto.randomUUID();

    const { error: docError } = await supabase
      .from('story_documents')
      .insert({
        id: documentId,
        title,
        description,
        word_count: wordCount,
        version: 1,
        is_corrected: false,
        user_id: userId,
        file_path: finalFilePath,
        file_url: urlData.publicUrl,
        created_at: new Date().toISOString(),
        group_id: groupId,
        variant: variant,
        language: data[0]?.language || 'english',
        tab: tab,
        pauses: pauses,
      });
    if (docError) throw new Error(`Failed to save story document: ${docError.message}`);
    console.log(`Saved story document with ID ${documentId} for ${title}`);

    // Set all tasks to completed_final
    await supabase
      .from('story_tasks')
      .update({ 
        status: 'completed_final', 
        story_document_id: documentId, // Track document ID in task
        updated_at: new Date().toISOString() 
      })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .gt('batch_number', 0);
    console.log(`Marked all tasks as completed_final for group ${groupId}`);

    // Check if this is part of a video process
    // Filter by is_main so we never accidentally pick up batch sub-rows or
    // demoted main rows when this re-runs after a previous attempt.
    const { data: videoTask } = await supabase
      .from('video_tasks')
      .select('id')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('is_main', true)
      .maybeSingle();

    if (videoTask) {
      // Update video_tasks with story document ID
      await supabase
        .from('video_tasks')
        .update({ 
          story_document_id: documentId,
          doc_id: documentId, // Keep legacy field for compatibility
          updated_at: new Date().toISOString()
        })
        .eq('id', videoTask.id);
      
      console.log(`Updated video_tasks with story_document_id: ${documentId}`);

      // This is part of a video process, trigger both image prompts and audio generation.
      // CRITICAL: Wrap in EdgeRuntime.waitUntil so the isolate isn't shut down the moment
      // we send our HTTP response. Without this, the background trigger races against
      // isolate shutdown, and if the first awaited fetch (image-prompts) is slow — e.g. a
      // Deno Deploy 503 → Supabase fallback — the isolate dies before setup-audio-tasks
      // is ever invoked, leaving audio_status stuck at 'running' with zero audio_tasks rows.
      (EdgeRuntime as any).waitUntil(
        triggerNextVideoStep(userId, groupId, 'image_prompts').catch((error) => {
          console.error(`Background trigger of next video steps failed: ${error.message}`);
        })
      );
    }
  } catch (error: any) {
    console.error(`Error compiling final story: ${error.message}`);
    await logError('Error compiling final story', error);
    throw error;
  }
}

async function triggerNextBatch(groupId: string, userId: string, currentBatchNumber: number, totalBatches: number, tab: number = 1, variant: number = 1) {
  if (currentBatchNumber >= totalBatches) {
    console.log(`No more batches to trigger for group ${groupId}, tab ${tab}, variant ${variant}. Compiling final story.`);
    const { data: task } = await supabase
      .from('story_tasks')
      .select('story_title, description')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('batch_number', currentBatchNumber)
      .eq('tab', tab)
      .eq('variant', variant)
      .single();
    if (task) {
      await compileFinalStory(userId, groupId, task.story_title, task.description, tab, variant);
    }
    return;
  }
  const nextBatchNumber = currentBatchNumber + 1;
  try {
    console.log(`Triggering trigger-next-batch for batch ${nextBatchNumber} for group ${groupId}`);
    
    // Check if next batch is already running (set by generate-story)
    const { data: checkNextTask } = await supabase
      .from('story_tasks')
      .select('status')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('batch_number', nextBatchNumber)
      .eq('tab', tab)
      .eq('variant', variant)
      .single();

    if (checkNextTask && checkNextTask.status === 'running') {
      console.log(`Next batch ${nextBatchNumber} is already running, skipping trigger`);
      return;
    }

    fetch(`${supabaseUrl}/functions/v1/trigger-next-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
      },
      body: JSON.stringify({
        group_id: groupId,
        user_id: userId,
        current_batch_number: currentBatchNumber,
        tab: tab,
        variant: variant,
      }),
    }).catch(error => {
      console.error(`Error triggering batch ${nextBatchNumber}: ${error.message}`);
      logError(`Error triggering batch ${nextBatchNumber}`, error);
      supabase
        .from('story_tasks')
        .update({ status: 'running', updated_at: new Date().toISOString() })
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('batch_number', nextBatchNumber)
        .eq('tab', tab)
        .eq('variant', variant);
    });
    console.log(`Initiated trigger-next-batch for batch ${nextBatchNumber}`);
  } catch (error: any) {
    console.error(`Error in triggerNextBatch for batch ${nextBatchNumber}: ${error.message}`);
    await logError(`Error triggering batch ${nextBatchNumber}`, error);
  }
}

serve(async (req: Request) => {
  const responseHeaders = { ...getCorsHeaders(req), 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 300000; // 300 seconds
  let payload: any = {}; // Initialize payload to avoid ReferenceError

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    // Auth check
    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });
    }

    payload = await req.json();
    if (!auth.isServiceRole && auth.userId) { payload.user_id = auth.userId; }
    const validationError = validateInputs(payload);
    if (validationError) return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });

    const { batch_number, group_id, user_id, total_batches, tab = 1, variant = 1 } = payload;
    console.log(`Starting process-story for batch ${batch_number}, group ${group_id}, tab ${tab}, variant ${variant}`);

    // Check if story processing is enabled for this video task
    const { data: videoTask } = await supabase
      .from('video_tasks')
      .select('process_story')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .single();

    if (videoTask && videoTask.process_story === false) {
      console.log(`Story processing disabled for group ${group_id}, returning empty response`);
      return new Response(JSON.stringify({ 
        content: 'Story processing disabled', 
        input_tokens: 0, 
        output_tokens: 0, 
        batch_number,
        skipped: true 
      }), { status: 200, headers: responseHeaders });
    }

    // UPDATED: Check for sequence issues - ensure batches are processed in order
    const { data: allTasks, error: allTasksError } = await supabase
      .from('story_tasks')
      .select('batch_number, status')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('tab', tab)
      .eq('variant', variant)
      .order('batch_number', { ascending: true });

    if (!allTasksError && allTasks) {
      // Check if there are incomplete batches before this one
      const incompleteBefore = allTasks.find(t => 
        t.batch_number < batch_number && 
        t.batch_number > 0 && 
        t.status !== 'completed' && 
        t.status !== 'completed_final'
      );
      
      if (incompleteBefore) {
        console.log(`Found incomplete batch ${incompleteBefore.batch_number} before current batch ${batch_number}, deferring`);
        return new Response(JSON.stringify({ 
          error: `Batch ${incompleteBefore.batch_number} must be completed first`, 
          code: 409,
          defer: true 
        }), { status: 409, headers: responseHeaders });
      }
    }

    // Check for concurrent running tasks (but allow the current batch to proceed)
    const { data: runningTasks, error: runningError } = await supabase
      .from('story_tasks')
      .select('id, batch_number')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('tab', tab)
      .eq('variant', variant)
      .eq('status', 'running');
    if (runningError) throw new Error(`Failed to check running tasks: ${runningError.message}`);

    // Filter out the current batch from running tasks check
    const otherRunningTasks = runningTasks.filter(task => task.batch_number !== batch_number);
    if (otherRunningTasks.length > 0) {
      const errorMsg = `Another batch is running: ${JSON.stringify(otherRunningTasks)}`;
      console.error(errorMsg);
      return new Response(JSON.stringify({ error: errorMsg, code: 409 }), { status: 409, headers: responseHeaders });
    }

    // If the current batch is already running, that's fine - we can proceed
    if (runningTasks.some(task => task.batch_number === batch_number)) {
      console.log(`Batch ${batch_number} is already set to running, proceeding with processing`);
    }

    const { data: task, error: taskError } = await supabase
      .from('story_tasks')
      .select('id, batch, total_word_count, status, story_title, description, total_batches, previous_content, input_tokens, output_tokens')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('batch_number', batch_number)
      .eq('tab', tab)
      .eq('variant', variant)
      .single();

    if (taskError || !task) {
      await logError('Task query failed', taskError || new Error('No task found'));
      return new Response(JSON.stringify({ error: 'Task not found', code: 404 }), { status: 404, headers: responseHeaders });
    }

    if (task.status === 'completed' || task.status === 'completed_final') {
      console.log(`Batch ${batch_number} already completed, triggering next batch`);
      await triggerNextBatch(group_id, user_id, batch_number, total_batches, tab, variant);
      return new Response(JSON.stringify({ content: task.previous_content || '', input_tokens: task.input_tokens || 0, output_tokens: task.output_tokens || 0, batch_number }), { status: 200, headers: responseHeaders });
    }

    console.log(`Updating batch ${batch_number} to running`);
    await supabase.from('story_tasks').update({ status: 'running', updated_at: new Date().toISOString() }).eq('id', task.id);

    const previousContent = await getPreviousContent(user_id, group_id, batch_number, tab, variant);
    
    let batchText: string;
    let inputTokens: number;
    let outputTokens: number;
    
    [batchText, inputTokens, outputTokens] = await callGenerateStory(task.batch, previousContent, task.total_word_count, group_id, user_id, batch_number, tab, variant);
    
    // If generation failed (empty content), keep status as running and return success
    if (!batchText) {
      console.log(`Batch ${batch_number} generation failed, keeping status as running for retry`);
      return new Response(JSON.stringify({ content: '', input_tokens: 0, output_tokens: 0, batch_number }), { status: 200, headers: responseHeaders });
    }

    // Check current task status to see if it was updated by retry
    const { data: currentTask } = await supabase
      .from('story_tasks')
      .select('status, previous_content, input_tokens, output_tokens')
      .eq('id', task.id)
      .single();

    if (currentTask?.status === 'completed') {
      console.log(`Batch ${batch_number} was already completed by retry, using existing data`);
      batchText = currentTask.previous_content || batchText;
      inputTokens = currentTask.input_tokens || inputTokens;
      outputTokens = currentTask.output_tokens || outputTokens;
    } else {
      // Check if tokens can be added before updating
      const tokenCheck = await checkTokenAvailability(user_id, inputTokens, outputTokens);
      
      if (tokenCheck.canUseTokens) {
        // Update to completed with tokens
        const { error: updateError } = await supabase
          .from('story_tasks')
          .update({
            progress: 100,
            status: 'completed',
            previous_content: batchText,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id);

        if (updateError) {
          console.error(`Failed to update task ${task.id}: ${updateError.message}`);
        }
      } else {
        // Update to completed without tokens
        console.warn(`Skipping token update for task ${task.id}: ${tokenCheck.reason}`);
        const { error: updateError } = await supabase
          .from('story_tasks')
          .update({
            progress: 100,
            status: 'completed',
            previous_content: batchText,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id);

        if (updateError) {
          console.error(`Failed to update task ${task.id} without tokens: ${updateError.message}`);
        }
        
        // Log the token limit issue
        await logError(`Token limit exceeded for user ${user_id}`, new Error(tokenCheck.reason || 'Token limit exceeded'));
      }
    }

    console.log(`Batch ${batch_number} processing completed, triggering next batch`);
    await triggerNextBatch(group_id, user_id, batch_number, total_batches, tab, variant);

    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) {
      console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);
    }

    console.log(`Returning response for batch ${batch_number}`);
    return new Response(JSON.stringify({ content: batchText, input_tokens: inputTokens, output_tokens: outputTokens, batch_number }), { status: 200, headers: responseHeaders });
  } catch (error: any) {
    console.error(`Error in process-story for batch ${payload?.batch_number || 'unknown'}: ${error.message}`);
    await logError('Error in process-story', error);
    if (payload?.group_id && payload?.user_id && payload?.batch_number) {
      await supabase
        .from('story_tasks')
        .update({ status: 'running', updated_at: new Date().toISOString() })
        .eq('group_id', payload.group_id)
        .eq('user_id', payload.user_id)
        .eq('batch_number', payload.batch_number)
        .eq('tab', payload.tab || 1)
        .eq('variant', payload.variant || 1);
    }
    return new Response(JSON.stringify({ content: '', input_tokens: 0, output_tokens: 0, batch_number: payload?.batch_number }), { status: 200, headers: responseHeaders });
  }
});



