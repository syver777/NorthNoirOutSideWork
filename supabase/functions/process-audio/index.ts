import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.75.1';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { fetchWithDenoFallback } from '../_shared/fetchWithDenoFallback.ts';
import { buildForwardPayload } from '../_shared/forwardSetupPayload.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    const { error: dbError } = await supabase
      .from('error_logs')
      .insert({
        message: message || 'Unknown error',
        details: error?.message || JSON.stringify(error) || 'No details available',
        error_message: error?.message || 'Unknown error',
        created_at: new Date().toISOString(),
      });
    if (dbError) console.error('Failed to log error to database:', dbError);
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

interface RequestBody {
  group_id: string;
  user_id: string;
  batch_number: number;
  total_batches: number;
  tab?: number;
  variant?: number;
}

interface AudioTask {
  id: string;
  user_id: string;
  group_id: string;
  story_title: string;
  text_part: string;
  batch_output: string;
  total_batches: number;
  total_prompts: number;
  batch_number: number;
  status: string;
  progress: number;
  error: string | null;
  settings: {};
  file_path: string;
  tokens: number;
  variant: number;
  is_corrected: boolean;
  description: string;
  version: number;
  folder_timestamp: string;
  model_version: string;
  voice: string;
  language: string;
  speed: number;
  preference: string;
  volume: number;
  single_audio: boolean;
  video_process: boolean;
  clone_voice_name?: string;
  clone_voice_url?: string;
  clone_language?: string;
  pauses: boolean;
}

function validateInputs(data: any): string | null {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!data?.group_id || !uuidRegex.test(data.group_id)) return 'Missing or invalid group_id';
  if (!data?.user_id || !uuidRegex.test(data.user_id)) return 'Missing or invalid user_id';
  if (typeof data?.batch_number !== 'number' || data.batch_number < 1) return 'Missing or invalid batch_number';
  if (typeof data?.total_batches !== 'number' || data.total_batches < 1) return 'Missing or invalid total_batches';
  if (typeof data.variant !== 'undefined' && (typeof data.variant !== 'number' || data.variant < 1)) return 'Invalid variant';
  // tab is optional, defaults to 1
  return null;
}

async function resetStuckTasks(groupId: string, userId: string, tab: number = 1, variant: number = 1): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data: stuckTasks, error: stuckError } = await supabase
        .from('audio_tasks')
        .select('id, updated_at, batch_number')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('tab', tab)
        .eq('variant', variant)
        .eq('status', 'running');

      if (stuckError) throw new Error(`Failed to check stuck tasks: ${stuckError.message}`);
      return;
    } catch (error: any) {
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        await logError('Failed to reset stuck tasks', error);
        throw error;
      }
    }
  }
}

async function checkAllStatusesCompleted(userId: string, groupId: string): Promise<boolean> {
  try {
    console.log(`Checking all statuses for user ${userId}, group ${groupId}`);
   
    const { data: videoTask, error } = await supabase
      .from('video_tasks')
      .select('story_status, image_prompt_status, image_generation_status, audio_status, process_story, process_images, process_audio, visual_type, ttv_prompt_status, ttv_status, itv_prompt_status, itv_status')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .single();

    if (error) {
      console.error(`Error fetching video task: ${error.message}`);
      return false;
    }

    if (!videoTask) {
      console.log(`No video task found for group ${groupId}`);
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
    await logError('Error checking video task statuses', error);
    return false;
  }
}

async function deleteTaskRows(userId: string, groupId: string, tab: number = 1, variant: number = 1): Promise<void> {
  try {
    console.log(`Deleting task rows for user ${userId}, group ${groupId}, tab ${tab}, variant ${variant}`);

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

    // Delete audio_tasks with tab and variant filter
    const { error: audioError } = await supabase
      .from('audio_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('variant', variant);
   
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
  } catch (error: any) {
    console.error(`Error in deleteTaskRows: ${error.message}`);
    await logError('Error deleting task rows', error);
  }
}

async function triggerVideoCreation(userId: string, groupId: string): Promise<void> {
  try {
    console.log(`All statuses completed, triggering video creation for group ${groupId}`);

    // Get video task settings
    const { data: videoTask, error: videoTaskError } = await supabase
      .from('video_tasks')
      .select('*')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .single();

    if (videoTaskError || !videoTask) {
      throw new Error(`Video task not found: ${videoTaskError?.message || 'No data'}`);
    }

    console.log(`Found video task ${videoTask.id}, video flag: ${videoTask.video}`);

    // Check if video creation is enabled
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
          story_progress: 100,
          image_prompt_progress: 100,
          image_generation_progress: 100,
          audio_progress: 100,
          video_creation_progress: 100,
          individual_video_progress: 100,
          overall_progress: 100,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', videoTask.id);

      // Delete task rows since processing is complete
      await deleteTaskRows(userId, groupId, 1, videoTask.variant || 1);
      
      console.log(`Processing completed_final for video task ${videoTask.id} without video creation`);
      return;
    }

    // Handle audio path based on use_existing_audio setting
    let audioFolderPath = '';
    if (videoTask.use_existing_audio) {
      // Try audio_folder_path first, then fallback to audio_file_path
      audioFolderPath = videoTask.audio_folder_path || videoTask.settings?.audio_folder_path || videoTask.settings?.audio_file_path || videoTask.audio_file_path;
      console.log(`Using existing audio from settings: ${audioFolderPath}`);
    }

    // Get all the documents for this group (but make audio optional if using existing)
    let documentsQuery = supabase
      .from('story_documents')
      .select('*')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (videoTask.variant == null) {
      documentsQuery = documentsQuery.is('variant', null);
    } else {
      documentsQuery = documentsQuery.eq('variant', videoTask.variant);
    }

    const { data: documents, error: documentsError } = await documentsQuery;

    if (documentsError) {
      throw new Error(`Error fetching documents: ${documentsError.message}`);
    }
    if (!documents || documents.length === 0) {
      throw new Error('No documents found for video creation');
    }

    console.log(`Found ${documents.length} documents:`, documents.map(d => d.title));

    // Find required documents based on processing flags
    const storyDoc = !videoTask.process_story ? null : documents.find(d => !d.title.startsWith('Image') && !d.title.startsWith('Audio'));
    const imagePromptDoc = !videoTask.process_images ? null : documents.find(d => d.title.startsWith('Image Prompt:'));
    const imageOutputDoc = !videoTask.process_images ? null : documents.find(d => d.title.startsWith('Image Outputs:'));
    
    // First try to find by file path if using existing audio
    let audioOutputDoc = null;
    if (videoTask.process_audio) {
      if (videoTask.use_existing_audio && audioFolderPath) {
        audioOutputDoc = documents.find(d => d.file_path === audioFolderPath);
      }
      // Fallback to title-based search for generated audio
      if (!audioOutputDoc) {
        audioOutputDoc = documents.find(d => d.title.startsWith('Audio Outputs:')) || 
                         documents.find(d => d !== storyDoc && d !== imagePromptDoc && d !== imageOutputDoc);
      }
    }

    // If not using existing audio from settings, get it from document
    if (!audioFolderPath && audioOutputDoc) {
      audioFolderPath = audioOutputDoc.file_path || '';
    }

    // Get the actual folder path from completed image tasks
    const { data: sampleImageTask } = await supabase
      .from('image_tasks')
      .select('batch_output')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('status', 'completed')
      .limit(1)
      .single();

    // Extract folder path from the actual saved image URL
    let images_folder_path = imageOutputDoc?.file_path || '';
    if (sampleImageTask?.batch_output) {
      const actualImagePath = sampleImageTask.batch_output.match(/documents\/[^\/]+\/[^\/]+\/[^\/]+/)?.[0];
      if (actualImagePath) {
        images_folder_path = actualImagePath;
        console.log(`Using actual image folder path from completed task: ${images_folder_path}`);
      } else {
        console.log(`Could not extract folder path from batch_output, using document file_path: ${images_folder_path}`);
      }
    }

    console.log('Document mapping:', {
      story: storyDoc?.title,
      imagePrompt: imagePromptDoc?.title,
      imageOutput: imageOutputDoc?.title,
      audioOutput: audioOutputDoc?.title,
      audioFolderPath: audioFolderPath,
      images_folder_path: images_folder_path,
      process_story: videoTask.process_story,
      process_images: videoTask.process_images,
      process_audio: videoTask.process_audio
    });

    // Validation based on processing flags
    const hasValidStory = !videoTask.process_story || !!storyDoc;
    const hasValidImages = !videoTask.process_images || !!imagePromptDoc && !!imageOutputDoc;
    const hasValidAudio = !videoTask.process_audio || (!!audioOutputDoc || (videoTask.use_existing_audio && !!audioFolderPath));

    if (!hasValidStory || !hasValidImages || !hasValidAudio) {
      throw new Error(`Missing required documents: story=${hasValidStory}, imagePrompt=${!!imagePromptDoc}, imageOutput=${!!imageOutputDoc}, audioOutput=${hasValidAudio}`);
    }

    // Backfill total_audio_duration when reusing existing audio.
    // compile-audio normally writes this column, but the use_existing_audio
    // path skips compile-audio entirely — leaving the column NULL on every
    // video_tasks row in the group. Downstream the time-remaining estimator
    // (src/utils/timeEstimates.ts) then falls back to a wpm heuristic, which
    // produces noticeably different (often larger) numbers than the real
    // duration once batch rows arrive. Calculate it now so the column is
    // populated before setup-video-tasks creates the next row.
    if (videoTask.use_existing_audio && audioFolderPath
        && (!videoTask.total_audio_duration || Number(videoTask.total_audio_duration) <= 0)) {
      try {
        // audio_folder_path may point at the merged file (…/merged.mp3) or at
        // the folder itself. calculate-audio-duration expects a folder, so
        // strip a trailing audio-file segment when present.
        const audioExtRe = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
        const folderForDuration = audioExtRe.test(audioFolderPath)
          ? audioFolderPath.substring(0, audioFolderPath.lastIndexOf('/'))
          : audioFolderPath;
        console.log(`Backfilling total_audio_duration from existing audio folder: ${folderForDuration}`);
        const durResp = await fetchWithDenoFallback('calculate-audio-duration', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseServiceRoleKey,
          },
          body: JSON.stringify({ folderPath: folderForDuration }),
        });
        if (durResp.ok) {
          const durResult = await durResp.json();
          const totalDuration = Number(durResult?.totalDuration) || 0;
          if (totalDuration > 0) {
            await supabase
              .from('video_tasks')
              .update({ total_audio_duration: totalDuration, updated_at: new Date().toISOString() })
              .eq('group_id', groupId)
              .eq('user_id', userId);
            videoTask.total_audio_duration = totalDuration;
            console.log(`Backfilled total_audio_duration=${totalDuration}s on video_tasks (group ${groupId})`);
          } else {
            console.warn(`calculate-audio-duration returned 0/invalid for ${folderForDuration}; leaving column NULL`);
          }
        } else {
          console.warn(`calculate-audio-duration failed: HTTP ${durResp.status} ${await durResp.text()}`);
        }
      } catch (durErr: any) {
        // Non-fatal — estimator falls back to its existing heuristics.
        console.warn(`Failed to backfill total_audio_duration: ${durErr?.message || durErr}`);
      }
    }

    // Call setup-video-tasks to start the final video process.
    // Spread `buildForwardPayload(...)` to forward every user setting
    // (subtitles, volume, master_prompt, etc.) so the new row created by
    // setup-video-tasks contains everything the frontend needs to display.
    // (avoids creating a duplicate `doc_id IS NULL` placeholder row) and
    // forward every user setting (subtitles, volume, master_prompt, etc.).
    const setupPayload = {
      ...buildForwardPayload({ vt: videoTask, userId, groupId, tab: videoTask.tab }),
      use_existing_story: true,
      story_file_path: storyDoc?.file_path,
      use_existing_images: true,
      images_folder_path: images_folder_path,
      image_prompt_path: imagePromptDoc?.file_path,
      use_existing_audio: true,
      audio_folder_path: audioFolderPath,
    };

    console.log(`Calling setup-video-tasks with payload:`, setupPayload);

    const response = await fetch(`${supabaseUrl}/functions/v1/setup-video-tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify(setupPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to trigger video creation: HTTP ${response.status}: ${errorText}`);
    }

    const responseData = await response.json();
    console.log(`Successfully triggered video creation response:`, responseData);

    console.log(`Video creation triggered successfully for video task ${videoTask.id}`);
  } catch (error: any) {
    console.error(`Error triggering video creation: ${error.message}`);
    await logError('Error triggering video creation', error);
   
    // Get variant for error handling
    const { data: videoTask } = await supabase
      .from('video_tasks')
      .select('variant')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .single();

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

// UPDATED: Helper function to check if voice is a custom clone voice
function isCustomCloneVoice(voiceId: string): boolean {
  // Check if it's a workspace voice that contains __
  if (!voiceId.includes('__')) return false;
  
  // Predefined clone voices list (matching frontend and setup-audio-tasks)
  const predefinedCloneVoices = [
    'default-ujsa1wysgyitfqg3ixpqka__declan',
    'default-ujsa1wysgyitfqg3ixpqka__adrian',
    'default-ujsa1wysgyitfqg3ixpqka__alfred',
    'default-ujsa1wysgyitfqg3ixpqka__conrad',
    'default-ujsa1wysgyitfqg3ixpqka__hugo',
    'default-ujsa1wysgyitfqg3ixpqka__ryder',
    'default-ujsa1wysgyitfqg3ixpqka__victor'
  ];
  
  // It's custom if it has __ but is not in the predefined list
  return !predefinedCloneVoices.includes(voiceId);
}

// UPDATED: Helper function to clean up custom clone voice with storage cleanup
async function cleanupCustomCloneVoice(voiceId: string, userId: string, audioFilePath?: string | null): Promise<void> {
  try {
    console.log(`Cleaning up custom clone voice: ${voiceId}`);
    
    const requestBody: any = {
      action: 'delete',
      voice_id: voiceId
    };

    // Add audio file path if available
    if (audioFilePath) {
      requestBody.audio_file_path = audioFilePath;
    }
    
    const response = await fetch(`${supabaseUrl}/functions/v1/manage-clone-voice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`Failed to delete custom clone voice ${voiceId}: ${errorText}`);
    } else {
      console.log(`Successfully deleted custom clone voice: ${voiceId}`);
      
      // After successful workspace deletion, clean up storage files
      try {
        console.log(`Cleaning up clone voice files for user ${userId}`);
        
        // List all files in user's clone_voices folder
        const { data: files, error: listError } = await supabase.storage
          .from('audio')
          .list(`${userId}/clone_voices`, {
            limit: 100,
            offset: 0
          });

        if (!listError && files && files.length > 0) {
          // Create array of file paths to delete
          const filePaths = files.map(file => `${userId}/clone_voices/${file.name}`);
          
          // Delete all clone voice files for this user
          const { error: deleteError } = await supabase.storage
            .from('audio')
            .remove(filePaths);

          if (deleteError) {
            console.warn(`Failed to delete clone voice files for user ${userId}: ${deleteError.message}`);
          } else {
            console.log(`Successfully deleted ${filePaths.length} clone voice files for user ${userId}`);
          }
        } else if (listError) {
          console.warn(`Failed to list clone voice files for user ${userId}: ${listError.message}`);
        } else {
          console.log(`No clone voice files found for user ${userId}`);
        }
      } catch (error: any) {
        console.warn(`Error cleaning up clone voice files for user ${userId}: ${error.message}`);
      }
    }
  } catch (error: any) {
    console.warn(`Error cleaning up custom clone voice ${voiceId}: ${error.message}`);
  }
}

async function triggerCompileAudio(userId: string, groupId: string, tab: number = 1, variant: number = 1): Promise<void> {
  try {
    console.log(`Triggering compile-audio for group ${groupId}, tab ${tab}, variant ${variant}`);

    const { data: tasks, error: tasksError } = await supabase
      .from('audio_tasks')
      .select('story_title, description, variant, is_corrected, version, folder_timestamp, model_version, preference, single_audio, video_process, volume, voice')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .gt('batch_number', 0)
      .order('batch_number', { ascending: true });

    if (tasksError || !tasks || tasks.length === 0) {
      await logError('No tasks found for final audio compilation', new Error('Tasks not found'));
      throw new Error('No tasks found for final audio compilation');
    }

    const task = tasks.find(t => t.story_title && t.description && t.folder_timestamp);
    if (!task) throw new Error('No task with valid story_title, description, or folder_timestamp');

    const compilePayload = {
      user_id: userId,
      group_id: groupId,
      story_title: task.story_title,
      description: task.description,
      variant: variant,
      is_corrected: task.is_corrected,
      version: task.version,
      folder_timestamp: task.folder_timestamp,
      model_version: task.model_version,
      preference: task.preference,
      single_audio: task.single_audio,
      video_process: task.video_process,
      volume: task.volume || 1.0,
      tab: tab
    };

    const response = await fetchWithDenoFallback('compile-audio', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify(compilePayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to trigger compile-audio: HTTP ${response.status}: ${errorText}`);
    }

    console.log(`Successfully triggered compile-audio for group ${groupId} with volume: ${task.volume || 1.0}`);

    // Clean up custom clone voice after successful audio compilation
    if (task.voice && isCustomCloneVoice(task.voice)) {
      console.log(`Detected custom clone voice usage: ${task.voice}, cleaning up...`);
      
      // UPDATED: Get audio file path for cleanup - try to find the uploaded audio file path
      let audioFilePath = null;
      
      // Try to get the audio file path from a completed task's batch_output
      // This will help us locate the original uploaded clone voice audio file
      try {
        const { data: taskWithOutput, error: taskOutputError } = await supabase
          .from('audio_tasks')
          .select('batch_output')
          .eq('group_id', groupId)
          .eq('user_id', userId)
          .eq('status', 'completed')
          .not('batch_output', 'is', null)
          .limit(1)
          .single();

        if (!taskOutputError && taskWithOutput?.batch_output) {
          // Extract the folder path from batch_output
          const audioUrl = taskWithOutput.batch_output.match(/https:\/\/[^\s]+/)?.[0];
          if (audioUrl) {
            // The clone voice audio file would be in the audio bucket, not stories bucket
            // We'll pass the URL and let manage-clone-voice handle the path extraction
            audioFilePath = audioUrl;
          }
        }
      } catch (error: any) {
        console.warn(`Could not retrieve audio file path for cleanup: ${error.message}`);
      }

      await cleanupCustomCloneVoice(task.voice, userId, audioFilePath);
    }

    // Check if this is a video process
    if (task.video_process === true) {
      console.log(`This is a video process, updating video task status and checking if all parts completed`);

      // First update the video task to mark audio as completed
      const { error: videoUpdateError } = await supabase
        .from('video_tasks')
        .update({
          audio_status: 'completed',
          audio_progress: 100,
          overall_progress: 75,
          updated_at: new Date().toISOString()
        })
        .eq('group_id', groupId)
        .eq('user_id', userId);

      if (videoUpdateError) {
        console.error(`Error updating video task: ${videoUpdateError.message}`);
        await logError('Error updating video task audio status', videoUpdateError);
      } else {
        console.log(`Successfully updated video task audio status to completed`);
      }

      // Check if all statuses are completed
      const allCompleted = await checkAllStatusesCompleted(userId, groupId);
      if (allCompleted) {
        console.log(`All parts completed, triggering video creation`);
        // All parts are completed, trigger video creation
        await triggerVideoCreation(userId, groupId);
      } else {
        console.log(`Audio generation completed but other parts still pending for group ${groupId}`);
      }
    }

  } catch (error: any) {
    await logError('Error triggering compile-audio', error);
    // Only set tasks to 'error' that are NOT already being compiled or completed
    // This prevents a failing duplicate call from corrupting a successful compilation in progress
    await supabase
      .from('audio_tasks')
      .update({ 
        status: 'error', 
        error: `Failed to trigger compile-audio: ${error.message}`, 
        updated_at: new Date().toISOString() 
      })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .gt('batch_number', 0)
      .not('status', 'in', '("compiling","completed","completed_final")');
    throw error;
  }
}

async function triggerNextBatch(groupId: string, userId: string, currentBatchNumber: number, totalBatches: number, tab: number = 1, variant: number = 1) {
  const retryDelays = [5000, 10000, 20000];

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      await resetStuckTasks(groupId, userId, tab, variant);

      if (currentBatchNumber >= totalBatches) {
        // All batches completed, trigger compile-audio
        await triggerCompileAudio(userId, groupId, tab, variant);
        return;
      }

      const nextBatchNumber = currentBatchNumber + 1;

      const response = await fetch(`${supabaseUrl}/functions/v1/trigger-next-audio`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify({
          group_id: groupId,
          user_id: userId,
          current_batch_number: currentBatchNumber,
          tab: tab,
          variant: variant
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        if ([429, 500, 502, 503, 504, 520].some(code => response.status === code) && attempt < retryDelays.length) {
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`Failed to trigger batch ${nextBatchNumber}: HTTP ${response.status}: ${errorText}`);
      }

      return;
    } catch (error: any) {
      if (attempt < retryDelays.length) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }

      await logError(`Error triggering batch ${currentBatchNumber + 1}`, error);
      await supabase
        .from('audio_tasks')
        .update({ status: 'pending', error: `Failed to trigger batch: ${error.message}`, updated_at: new Date().toISOString() })
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('tab', tab)
        .eq('variant', variant)
        .eq('batch_number', currentBatchNumber + 1);
      throw error;
    }
  }
}

async function callGenerateAudio(payload: any, taskId: string, batchNumber: number): Promise<{ audio_url?: string; audio_base64?: string; tokens: number }> {
  const retryDelays = [10000, 20000, 30000, 20000, 10000, 10000, 10000, 1000, 5000, 50000];

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 390000);

      const response = await fetch(`${supabaseUrl}/functions/v1/generate-audio`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      if (!result.audio_url && !result.audio_base64) throw new Error('Invalid response: Missing audio_url or audio_base64');

      return result;
    } catch (error: any) {
      if (attempt < retryDelays.length) {
        console.log(`Error generating audio for batch ${batchNumber}: ${error.message}, retrying after ${retryDelays[attempt]/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }

      await supabase
        .from('audio_tasks')
        .update({ status: 'pending', error: `Failed to generate audio: ${error.message}`, updated_at: new Date().toISOString() })
        .eq('id', taskId);
      throw error;
    }
  }

  throw new Error('Failed to generate audio after 10 attempts');
}

async function processAudioTask(task: AudioTask, tab: number = 1, variant: number = 1) {
  const { group_id, user_id, batch_number, total_batches } = task;
  const MAX_TASK_RETRIES = 3;
  const TASK_RETRY_DELAY = 30000; // 30 seconds between task retries

  for (let taskRetry = 0; taskRetry < MAX_TASK_RETRIES; taskRetry++) {
    try {
      // Check if audio processing is enabled for this video task
      const { data: videoTask } = await supabase
        .from('video_tasks')
        .select('process_audio')
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .single();

      if (videoTask && videoTask.process_audio === false) {
        console.log(`Audio processing disabled for group ${group_id}, returning empty response`);
        await supabase
          .from('audio_tasks')
          .update({
            status: 'completed',
            batch_output: 'Audio processing disabled',
            progress: 100,
            tokens: 0,
            token_updated: true,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id);
        
        await triggerNextBatch(group_id, user_id, batch_number, total_batches, tab, variant);
        return { content: 'Audio processing disabled', tokens: 0, batch_number, skipped: true };
      }

      if (task.status === 'completed' || task.status === 'completed_final') {
        await triggerNextBatch(group_id, user_id, batch_number, total_batches, tab, variant);
        return { content: task.batch_output || '', tokens: task.tokens || 0, batch_number };
      }

      await supabase
        .from('audio_tasks')
        .update({ status: 'running', updated_at: new Date().toISOString() })
        .eq('id', task.id);

      if (!task.text_part || task.text_part.length === 0) {
        await supabase
          .from('audio_tasks')
          .update({ status: 'pending', error: 'Invalid text_part data', updated_at: new Date().toISOString() })
          .eq('id', task.id);
        throw new Error('Invalid text_part data');
      }

      const prompt = task.text_part;
      const audioNumber = task.batch_number;
      const sanitizedTitle = task.story_title.replace('Audio Prompt: ', '').replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
      const folderTimestamp = task.folder_timestamp || new Date().toISOString().replace(/[:.]/g, '-');
      const audioFolder = `documents/${user_id}/${group_id}/${sanitizedTitle}_${folderTimestamp}`;
   
      const ext = 'mp3';
   
      const audioPath = `${audioFolder}/${audioNumber}.${ext}`;
    
      // Check if file already exists first
      const { data: existingFile } = await supabase.storage.from('stories').download(audioPath);
      if (existingFile && existingFile.size > 100) {
        // File exists and is valid, mark as completed
        console.log(`Audio file ${audioPath} already exists, marking task as completed`);
    
        const { data: urlData } = supabase.storage.from('stories').getPublicUrl(audioPath);
        const batchContent = `Audio ${audioNumber} saved to: ${urlData.publicUrl}`;
    
        await supabase
          .from('audio_tasks')
          .update({
            status: 'completed',
            batch_output: batchContent,
            progress: 100,
            tokens: task.tokens || prompt.length * (task.model_version === 'lemonfox' ? 2 : task.model_version === 'speechify' ? 8 : task.model_version === 'elevenlabs' ? ((task.settings as any)?.elevenlabs_model_id === 'eleven_multilingual_v2' ? 200 : 100) : 4),
            token_updated: true,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id);
        await triggerNextBatch(group_id, user_id, batch_number, total_batches, tab);
        return { content: batchContent, tokens: task.tokens || 0, batch_number };
      }
    
      // File doesn't exist, generate new audio
      let audioData: ArrayBuffer;
      let tokens: number;
    
      const generatePayload: any = {
        prompt,
        voice_id: task.voice,
        language: task.language,
        speed: task.speed,
        model_version: task.model_version,
      };

      // Forward ElevenLabs model id (stashed in settings during setup-audio-tasks).
      if (task.model_version === 'elevenlabs') {
        const settings: any = task.settings || {};
        if (settings.elevenlabs_model_id) {
          generatePayload.elevenlabs_model_id = settings.elevenlabs_model_id;
        }
      }

      console.log(`Processing task with model: ${task.model_version}, voice: ${task.voice}`);
    
      const result = await callGenerateAudio(generatePayload, task.id, batch_number);
      tokens = result.tokens;
    
      if (!result.audio_base64) throw new Error(`Missing audio_base64 for ${task.model_version}`);
      audioData = base64ToArrayBuffer(result.audio_base64);
      if (audioData.byteLength <= 100) {
        throw new Error(`Invalid audio data from ${task.model_version} API`);
      }
    
      // Check if task still exists before uploading (cancellation check)
      const { data: taskCheck, error: taskCheckError } = await supabase
        .from('audio_tasks')
        .select('id')
        .eq('id', task.id)
        .single();

      if (taskCheckError || !taskCheck) {
        console.log(`Task ${task.id} no longer exists, skipping file upload and exiting`);
        return { content: 'Task cancelled', tokens: 0, batch_number };
      }
    
      // Upload with upsert option to overwrite if exists
      const { error: uploadError } = await supabase.storage
        .from('stories')
        .upload(audioPath, audioData, {
          contentType: `audio/${ext}`,
          upsert: true
        });
      
      if (uploadError) {
        console.log(`Upload failed, resetting task to queued for retry: ${uploadError.message}`);
        await supabase
          .from('audio_tasks')
          .update({ 
            status: 'queued', 
            error: null,
            updated_at: new Date().toISOString() 
          })
          .eq('id', task.id);
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10s delay
        return { content: 'Upload failed, task reset for retry', tokens: 0, batch_number };
      }

      // No volume boost here - will be handled in compile-audio
      const finalTokens = tokens;
    
      const { data: urlData } = supabase.storage.from('stories').getPublicUrl(audioPath);
      if (!urlData?.publicUrl) throw new Error('Failed to retrieve public URL');
    
      const batchContent = `Audio ${audioNumber} saved to: ${urlData.publicUrl}`;
    
      await supabase
        .from('audio_tasks')
        .update({
          status: 'completed',
          batch_output: batchContent,
          progress: 100,
          tokens: finalTokens,
          token_updated: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', task.id);
    
      await triggerNextBatch(group_id, user_id, batch_number, total_batches, tab, variant);
      return { content: batchContent, tokens: finalTokens, batch_number };

    } catch (error: any) {
      console.error(`Task retry ${taskRetry + 1}/${MAX_TASK_RETRIES} failed for batch ${batch_number}:`, error.message);
      await logError(`Task retry ${taskRetry + 1}/${MAX_TASK_RETRIES} failed for batch ${batch_number}`, error);
      
      if (taskRetry < MAX_TASK_RETRIES - 1) {
        // Not the last retry, reset task to queued and wait
        await supabase
          .from('audio_tasks')
          .update({ 
            status: 'queued', 
            error: `Retry ${taskRetry + 1}/${MAX_TASK_RETRIES} failed: ${error.message}. Will retry in ${TASK_RETRY_DELAY/1000}s`, 
            updated_at: new Date().toISOString() 
          })
          .eq('id', task.id);
        
        console.log(`Waiting ${TASK_RETRY_DELAY/1000}s before retry ${taskRetry + 2}/${MAX_TASK_RETRIES}...`);
        await new Promise(resolve => setTimeout(resolve, TASK_RETRY_DELAY));
        continue; // Try again
      } else {
        // Last retry failed, set to pending for manual intervention
        await supabase
          .from('audio_tasks')
          .update({ 
            status: 'pending', 
            error: `All ${MAX_TASK_RETRIES} retries failed: ${error.message}`, 
            updated_at: new Date().toISOString() 
          })
          .eq('id', task.id);
        
        // Don't throw the error, just return a failure result
        console.error(`All retries exhausted for batch ${batch_number}, task set to pending`);
        return { content: 'Task failed after all retries', tokens: 0, batch_number, error: error.message };
      }
    }
  }
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 400000;
  const { method } = req;

  try {
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    let payload: RequestBody;
    try {
      payload = await req.json();
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Invalid JSON payload', code: 400 }), { status: 400, headers: responseHeaders });
    }

    const validationError = validateInputs(payload);
    if (validationError) return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });

    const { group_id, user_id, batch_number, total_batches, tab = 1, variant = 1 } = payload;

    const { data: task, error: taskError } = await supabase
      .from('audio_tasks')
      .select('*')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('batch_number', batch_number)
      .eq('tab', tab)
      .eq('variant', variant)
      .single();

    if (taskError || !task) {
      await logError('Task not found', taskError || new Error('No task found'));
      return new Response(JSON.stringify({ error: 'Task not found', code: 404 }), { status: 404, headers: responseHeaders });
    }

    const { readable, writable } = new TransformStream();
    const response = new Response(readable, { headers: responseHeaders, status: 200 });

    (async () => {
      const writer = writable.getWriter();
      try {
        const result = await processAudioTask(task, tab, variant);
        await writer.write(new TextEncoder().encode(JSON.stringify(result)));
      } catch (error: any) {
        // This catch should rarely be hit now since processAudioTask handles its own retries
        await logError('Unexpected error in process-audio', error);
        await writer.write(new TextEncoder().encode(JSON.stringify({ error: error.message || 'Internal server error', code: 500 })));
      } finally {
        writer.close();
        const elapsed = Date.now() - startTime;
        if (elapsed > maxRuntime) console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);
      }
    })();

    return response;

  } catch (error: any) {
    await logError('Error in process-audio', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});




