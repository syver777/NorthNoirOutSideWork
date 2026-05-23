import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { buildForwardPayload } from '../_shared/forwardSetupPayload.ts';
import { getIsLegacyPlan, imageTokens } from '../_shared/tokenCosts.ts';
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
        error_message: error.message || JSON.stringify(error),
        details: error.message || JSON.stringify(error),
        created_at: new Date().toISOString(),
      });
    if (dbError) console.error('Failed to log error to database:', dbError);
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}
async function triggerSizeCalculation(docId: string, filePath: string, version: number): Promise<void> {
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/calculate-file-size`, {
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
    if (!response.ok) {
      console.warn(`Failed to trigger size calculation for ${docId}: HTTP ${response.status}`);
    } else {
      console.log(`Successfully triggered size calculation for ${docId}`);
    }
  } catch (error: any) {
    console.warn(`Error triggering size calculation for ${docId}:`, error.message);
  }
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
interface RequestBody {
  group_id: string;
  user_id: string;
  batch_number: number;
  total_batches: number;
  tab?: number;
}
interface ImageTask {
  id: string;
  user_id: string;
  group_id: string;
  story_title: string;
  batch: Array<{ text: string; index: number }>;
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
  image_model: string;
  video_process: boolean;
  itv: boolean;
  tab: number;
}
async function checkTokenAvailability(userId: string, expectedTokens: number): Promise<boolean> {
  try {
    const { data: userPlan, error } = await supabase
      .from('user_plans')
      .select('tokens_allocated, tokens_used, rollover_tokens')
      .eq('user_id', userId)
      .single();
    if (error || !userPlan) {
      console.error(`Error fetching user plan for ${userId}:`, error);
      return false;
    }
    const tokensAllocated = userPlan.tokens_allocated || 0;
    const tokensUsed = userPlan.tokens_used || 0;
    const rolloverTokens = userPlan.rollover_tokens || 0;
    const totalAvailable = tokensAllocated + rolloverTokens;
    const wouldExceed = (tokensUsed + expectedTokens) > totalAvailable;
    console.log(`Token check for user ${userId}: used=${tokensUsed}, allocated=${tokensAllocated}, rollover=${rolloverTokens}, totalAvailable=${totalAvailable}, expected=${expectedTokens}, wouldExceed=${wouldExceed}`);
   
    return !wouldExceed;
  } catch (error: any) {
    console.error(`Error checking token availability for user ${userId}:`, error);
    return false;
  }
}
async function resetStuckTasks(groupId: string, userId: string, tab: number = 1, variant: number = 1): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data: stuckTasks, error: stuckError } = await supabase
        .from('image_tasks')
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
      .select('story_status, image_prompt_status, image_generation_status, audio_status, process_story, process_images, process_audio')
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
    console.log(`Video task statuses:`, {
      story_status: videoTask.story_status,
      image_prompt_status: videoTask.image_prompt_status,
      image_generation_status: videoTask.image_generation_status,
      audio_status: videoTask.audio_status,
      process_story: videoTask.process_story,
      process_images: videoTask.process_images,
      process_audio: videoTask.process_audio
    });
    // Check completion based on processing flags
    const storyCompleted = !videoTask.process_story || videoTask.story_status === 'completed';
    const imagesCompleted = !videoTask.process_images || (videoTask.image_prompt_status === 'completed' && videoTask.image_generation_status === 'completed');
    const audioCompleted = !videoTask.process_audio || videoTask.audio_status === 'completed';
    const allCompleted = storyCompleted && imagesCompleted && audioCompleted;
    console.log(`All statuses completed: ${allCompleted} (story: ${storyCompleted}, images: ${imagesCompleted}, audio: ${audioCompleted})`);
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
    // Delete audio_tasks
    const { error: audioError } = await supabase
      .from('audio_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('group_id', groupId);
  
    if (audioError) {
      console.error(`Error deleting audio_tasks: ${audioError.message}`);
    } else {
      console.log(`Successfully deleted audio_tasks for group ${groupId}`);
    }
    // Delete image_tasks
    const { error: imageError } = await supabase
      .from('image_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('variant', variant);
  
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
    // Get video task settings including document IDs
    // Note: We don't filter by doc_id because it might be set to story_document_id for existing stories
    const { data: videoTasks, error: videoTaskError } = await supabase
      .from('video_tasks')
      .select('*, story_document_id, image_prompt_document_id, image_folder_document_id, audio_document_id')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    
    if (videoTaskError || !videoTasks || videoTasks.length === 0) {
      throw new Error(`Video task not found: ${videoTaskError?.message || 'No data'}`);
    }
    
    // Find the main task using the is_main flag (falls back to legacy doc_id IS NULL convention).
    const videoTask = videoTasks.find(t => t.is_main) || videoTasks.find(t => t.doc_id === null) || videoTasks[0];
    
    console.log(`Found video task ${videoTask.id}, video flag: ${videoTask.video}`);
    console.log('Document IDs from video_tasks:', {
      story_document_id: videoTask.story_document_id,
      image_prompt_document_id: videoTask.image_prompt_document_id,
      image_folder_document_id: videoTask.image_folder_document_id,
      audio_document_id: videoTask.audio_document_id
    });
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
    // Handle audio path based on use_existing_audio setting.
    // Resolve folder vs single-file separately so we forward the correct field
    // to setup-video-tasks (sending a single file as audio_folder_path passes
    // validation but breaks downstream code that lists clips in the folder).
    let audioFolderPath: string = '';
    let audioFilePath: string = '';
    if (videoTask.use_existing_audio) {
      audioFolderPath = videoTask.audio_folder_path || videoTask.settings?.audio_folder_path || '';
      audioFilePath = videoTask.audio_file_path || videoTask.settings?.audio_file_path || '';
      console.log(`Using existing audio — folder: ${audioFolderPath || '(none)'}, file: ${audioFilePath || '(none)'}`);
    }
    
    // NEW APPROACH: Use document IDs from video_tasks to fetch specific documents
    console.log('Fetching documents using document IDs from video_tasks:', {
      story_document_id: videoTask.story_document_id,
      image_prompt_document_id: videoTask.image_prompt_document_id,
      image_folder_document_id: videoTask.image_folder_document_id,
      audio_document_id: videoTask.audio_document_id
    });
    
    // FIXED: Build array of document IDs based on what was processed
    // If document IDs are missing, try to find them by querying story_documents
    let storyDocumentId = videoTask.story_document_id;
    let imagePromptDocumentId = videoTask.image_prompt_document_id;
    let imageFolderDocumentId = videoTask.image_folder_document_id;
    let audioDocumentId = videoTask.audio_document_id;
    
    // Query for missing document IDs if needed
    if (!storyDocumentId && videoTask.process_story !== false && videoTask.story_file_path) {
      const { data: storyDoc } = await supabase
        .from('story_documents')
        .select('id')
        .eq('file_path', videoTask.story_file_path)
        .eq('user_id', userId)
        .single();
      if (storyDoc) {
        storyDocumentId = storyDoc.id;
        console.log(`Found missing story_document_id via file_path query: ${storyDocumentId}`);
      }
    }
    
    if (!audioDocumentId && videoTask.process_audio !== false) {
      // Try to find audio document by title pattern and variant
      const { data: audioDoc } = await supabase
        .from('story_documents')
        .select('id')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .like('title', '%Audio%')
        .eq('variant', videoTask.variant || 1)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (audioDoc) {
        audioDocumentId = audioDoc.id;
        console.log(`Found missing audio_document_id via title query: ${audioDocumentId}`);
      }
    }
    
    const documentIdsToFetch = [];
    if (videoTask.process_story !== false && storyDocumentId) {
      documentIdsToFetch.push(storyDocumentId);
    }
    if (videoTask.process_images !== false) {
      if (imagePromptDocumentId) documentIdsToFetch.push(imagePromptDocumentId);
      if (imageFolderDocumentId) documentIdsToFetch.push(imageFolderDocumentId);
    }
    if (videoTask.process_audio !== false && audioDocumentId) {
      documentIdsToFetch.push(audioDocumentId);
    }
    
    let documents = [];
    if (documentIdsToFetch.length > 0) {
      // Fetch documents by their specific IDs
      const { data: docsById, error: docsByIdError } = await supabase
        .from('story_documents')
        .select('*')
        .in('id', documentIdsToFetch)
        .order('created_at', { ascending: true });
      
      if (docsByIdError) {
        console.error(`Error fetching documents by ID: ${docsByIdError.message}`);
      } else {
        documents = docsById || [];
        console.log(`Fetched ${documents.length} documents by ID`);
      }
    }
    
    // FALLBACK: If no document IDs or documents not found, use legacy variant-based query
    if (documents.length === 0) {
      console.log('No documents found by ID, falling back to variant-based query');
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
      
      const { data: docsByVariant, error: documentsError } = await documentsQuery;
      if (documentsError) {
        throw new Error(`Error fetching documents: ${documentsError.message}`);
      }
      documents = docsByVariant || [];
    }
    
    if (!documents || documents.length === 0) {
      throw new Error('No documents found for video creation');
    }
    console.log(`Found ${documents.length} documents:`, documents.map(d => ({ id: d.id, title: d.title })));
    
    // Find required documents - prioritize by document ID match, then by title
    const storyDoc = !videoTask.process_story ? null : 
      documents.find(d => d.id === videoTask.story_document_id) ||
      documents.find(d => !d.title.startsWith('Image') && !d.title.startsWith('Audio'));
    
    const imagePromptDoc = !videoTask.process_images ? null : 
      documents.find(d => d.id === videoTask.image_prompt_document_id) ||
      documents.find(d => d.title.startsWith('Image Prompt:'));
    
    const imageOutputDoc = !videoTask.process_images ? null : 
      documents.find(d => d.id === videoTask.image_folder_document_id) ||
      documents.find(d => d.title.startsWith('Image Outputs:'));
   
    // First try to find by document ID, then file path if using existing audio, then by title
    let audioOutputDoc = null;
    if (videoTask.process_audio) {
      audioOutputDoc = documents.find(d => d.id === videoTask.audio_document_id);
      
      if (!audioOutputDoc && videoTask.use_existing_audio && audioFolderPath) {
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
    const hasValidAudio = !videoTask.process_audio || (!!audioOutputDoc || (videoTask.use_existing_audio && (!!audioFolderPath || !!audioFilePath)));
    if (!hasValidStory || !hasValidImages || !hasValidAudio) {
      throw new Error(`Missing required documents: story=${hasValidStory}, imagePrompt=${!!imagePromptDoc}, imageOutput=${!!imageOutputDoc}, audioOutput=${hasValidAudio}`);
    }
    // Call setup-video-tasks to start the final video process.
    // Spread `buildForwardPayload(...)` to forward every user setting
    // (subtitles, volume, master_prompt, etc.) so the new row created by
    // setup-video-tasks contains everything the frontend needs to display.
    const setupPayload = {
      ...buildForwardPayload({ vt: videoTask, userId, groupId, tab: videoTask.tab }),
      use_existing_story: true,
      story_file_path: storyDoc?.file_path,
      use_existing_images: true,
      images_folder_path: images_folder_path,
      image_prompt_path: imagePromptDoc?.file_path,
      use_existing_audio: true,
      audio_folder_path: audioFolderPath || null,
      audio_file_path: audioFilePath || null,
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
  
    await supabase
      .from('video_tasks')
      .update({
        image_generation_status: 'error',
        overall_status: 'error',
        error_message: `Failed to trigger video creation: ${error.message}`,
        updated_at: new Date().toISOString()
      })
      .eq('group_id', groupId)
      .eq('user_id', userId);
  }
}
async function compileFinalDocument(userId: string, groupId: string, title: string, description: string, variant: number, isCorrected: boolean, version: number, folderTimestamp: string, tab: number = 1, imageModel?: string | null) {
  try {
    console.log(`Starting compileFinalDocument for group ${groupId}, title: ${title}, variant: ${variant}, version: ${version}, tab: ${tab}`);
    
    // Check if document already exists for this exact combination to prevent duplicates
    const { data: existingDoc } = await supabase
      .from('story_documents')
      .select('id')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('variant', variant)
      .eq('version', version)
      .limit(1);
    
    if (existingDoc && existingDoc.length > 0) {
      console.log(`Document already exists for group ${groupId}, variant ${variant}, version ${version}, skipping compilation`);
      return;
    }
    
    const { data, error } = await supabase
      .from('image_tasks')
      .select('batch_output, batch_number, video_process, itv')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('variant', variant)
      .gt('batch_number', 0)
      .order('batch_number', { ascending: true });
    if (error || !data || data.length === 0) {
      const errorMsg = `Failed to fetch image tasks: ${error?.message || 'No data'}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
    console.log(`Found ${data.length} image tasks to compile`);
    const sanitizedTitle = title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
    const folderPath = `documents/${userId}/${groupId}/${sanitizedTitle}_${folderTimestamp}`;
    console.log(`Generated folder path: ${folderPath}`);
    const { data: urlData } = supabase.storage.from('stories').getPublicUrl(folderPath);
    if (!urlData?.publicUrl) throw new Error('Failed to retrieve public folder URL');
    const documentId = crypto.randomUUID();
    const cleanedTitle = title.replace('Image Prompt: ', '');
    console.log(`Creating story document with title: "Image Outputs: ${cleanedTitle}"`);
    const { error: docError } = await supabase
      .from('story_documents')
      .insert({
        id: documentId,
        title: `Image Outputs: ${cleanedTitle}`,
        description,
        version,
        is_corrected: isCorrected,
        is_prompted: false,
        user_id: userId,
        file_path: folderPath,
        file_url: urlData.publicUrl,
        created_at: new Date().toISOString(),
        group_id: groupId,
        variant,
        tab,
        image_model: imageModel || null,
      });
    if (docError) {
      const errorMsg = `Failed to save document: ${docError.message}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
    console.log(`Successfully created story document with ID: ${documentId}`);
    // Trigger size calculation asynchronously (fire-and-forget)
    triggerSizeCalculation(documentId, folderPath, version).catch(err =>
      console.warn(`Size calculation failed for ${documentId}:`, err.message)
    );
    // Update all image tasks to completed_final and track document ID
    const { error: updateError } = await supabase
      .from('image_tasks')
      .update({ 
        status: 'completed_final',
        image_folder_document_id: documentId, // Track document ID in task
        updated_at: new Date().toISOString() 
      })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .gt('batch_number', 0);
    if (updateError) {
      console.error(`Error updating image tasks: ${updateError.message}`);
    } else {
      console.log(`Updated all image tasks to completed_final for group ${groupId}, tab ${tab}`);
    }
    // Check if this is part of a video process (exclude ITV — handled separately below)
    const isVideoProcess = data.some(task => task.video_process === true && task.itv !== true);
    console.log(`Is video process: ${isVideoProcess}`);
    if (isVideoProcess) {
      console.log(`This is a video process, updating video task status`);
      
      // Update video_tasks with image_folder_document_id
      await supabase
        .from('video_tasks')
        .update({ 
          image_folder_document_id: documentId,
          updated_at: new Date().toISOString()
        })
        .eq('group_id', groupId)
        .eq('user_id', userId);
      
      console.log(`Updated video_tasks with image_folder_document_id: ${documentId}`);
      
      // Check if all statuses will be completed after image generation
      const { data: videoTaskCheck } = await supabase
        .from('video_tasks')
        .select('video, process_story, process_images, process_audio, story_status, audio_status')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .single();
      const willBeAllCompleted = videoTaskCheck &&
        videoTaskCheck.video === false &&
        (!videoTaskCheck.process_story || videoTaskCheck.story_status === 'completed') &&
        (!videoTaskCheck.process_audio || videoTaskCheck.audio_status === 'completed');
      const { error: videoUpdateError } = await supabase
        .from('video_tasks')
        .update({
          image_prompt_status: willBeAllCompleted ? 'completed_final' : 'completed',
          image_generation_status: willBeAllCompleted ? 'completed_final' : 'completed',
          image_generation_progress: 100,
          overall_progress: willBeAllCompleted ? 100 : 75,
          overall_status: willBeAllCompleted ? 'completed_final' : undefined,
          video_creation_status: willBeAllCompleted ? 'completed_final' : undefined,
          individual_video_status: willBeAllCompleted ? 'completed_final' : undefined,
          completed_at: willBeAllCompleted ? new Date().toISOString() : undefined,
          updated_at: new Date().toISOString()
        })
        .eq('group_id', groupId)
        .eq('user_id', userId);
      if (videoUpdateError) {
        console.error(`Error updating video task: ${videoUpdateError.message}`);
        await logError('Error updating video task image generation status', videoUpdateError);
      } else {
        console.log(`Successfully updated video task image generation status to ${willBeAllCompleted ? 'completed_final' : 'completed'}`);
      }
      // If all completed, trigger cleanup and return early
      if (willBeAllCompleted) {
        console.log(`All parts completed, setting final status and cleaning up for group ${groupId}`);
        await deleteTaskRows(userId, groupId, tab, variant);
        return;
      }
      // Check if all statuses are completed
      const allCompleted = await checkAllStatusesCompleted(userId, groupId);
      if (allCompleted) {
        console.log(`All parts completed, triggering video creation`);
        // All parts are completed, trigger video creation
        await triggerVideoCreation(userId, groupId);
      } else {
        console.log(`Image generation completed but other parts still pending for group ${groupId}`);
      }
    }

    // ── ITV dual-completion check ───────────────────────────────────────────────
    // ITV image tasks run in parallel with Phase 2 ITV prompt tasks.
    // Whichever finishes last triggers setup-ITV-tasks.
    const isItvProcess = data.some((task: any) => task.itv === true);
    if (isItvProcess) {
      console.log(`ITV image generation complete for group ${groupId}, tab ${tab}. Checking ITV prompt tasks (Phase 2)…`);

      // Update video_tasks: ITV image generation phase complete
      await supabase
        .from('video_tasks')
        .update({
          image_generation_status: 'completed',
          image_generation_progress: 100,
          image_folder_document_id: documentId,
          updated_at: new Date().toISOString(),
        })
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('visual_type', 'itv');

      const { data: itvPromptTasks, error: itvPromptError } = await supabase
        .from('ITV_prompt_tasks')
        .select('status')
        .eq('group_id', groupId)
        .eq('tab', tab)
        .eq('itv', true);

      if (itvPromptError) {
        console.error(`Error querying ITV_prompt_tasks: ${itvPromptError.message}`);
      } else {
        const allItvPromptsComplete =
          itvPromptTasks &&
          itvPromptTasks.length > 0 &&
          itvPromptTasks.every((t: any) => t.status === 'completed_final');

        if (allItvPromptsComplete) {
          console.log(`Both ITV images and ITV Phase 2 prompts complete — triggering setup-ITV-tasks`);

          // Update video_tasks: ITV video generation phase now running
          await supabase
            .from('video_tasks')
            .update({
              itv_status: 'running',
              updated_at: new Date().toISOString(),
            })
            .eq('group_id', groupId)
            .eq('user_id', userId)
            .eq('visual_type', 'itv');

          fetch(`${supabaseUrl}/functions/v1/setup-ITV-tasks`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseServiceRoleKey,
            },
            body: JSON.stringify({ group_id: groupId, user_id: userId, tab, variant }),
          }).catch((err: any) => {
            console.error(`Error triggering setup-ITV-tasks: ${err.message}`);
            logError('Error triggering setup-ITV-tasks from process-image', err);
          });
        } else {
          console.log(`ITV images done but Phase 2 prompts not yet complete — waiting for dual completion`);
        }
      }
      return;
    }

    console.log(`compileFinalDocument completed successfully for group ${groupId}`);
  } catch (error: any) {
    console.error(`Error in compileFinalDocument: ${error.message}`);
    await logError('Error compiling final document', error);
  
    await supabase
      .from('image_tasks')
      .update({ status: 'error', error: `Failed to compile document: ${error.message}`, updated_at: new Date().toISOString() })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('variant', variant)
      .gt('batch_number', 0);
  
    // Also update video task if this was a video process
    await supabase
      .from('video_tasks')
      .update({
        image_generation_status: 'error',
        overall_status: 'error',
        error_message: `Failed to compile final document: ${error.message}`,
        updated_at: new Date().toISOString()
      })
      .eq('group_id', groupId)
      .eq('user_id', userId);
  
    throw error;
  }
}
async function triggerNextBatch(groupId: string, userId: string, currentBatchNumber: number, totalBatches: number, tab: number = 1, variant: number = 1) {
  const retryDelays = [5000, 10000, 20000];
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      await resetStuckTasks(groupId, userId, tab, variant);
      if (currentBatchNumber >= totalBatches) {
        console.log(`All batches completed for group ${groupId}, tab ${tab}, starting final document compilation`);
      
        // Add a small delay to ensure the current batch's 'completed' status is committed to DB
        await new Promise(resolve => setTimeout(resolve, 1000));
      
        const { data: tasks, error: tasksError } = await supabase
          .from('image_tasks')
          .select('story_title, description, variant, is_corrected, status, version, folder_timestamp, video_process, itv, image_model')
          .eq('group_id', groupId)
          .eq('user_id', userId)
          .eq('tab', tab)
          .eq('variant', variant)
          .gt('batch_number', 0)
          .order('batch_number', { ascending: true });
        if (tasksError || !tasks || tasks.length === 0) {
          const errorMsg = `No tasks found for final document compilation: ${tasksError?.message || 'No data'}`;
          console.error(errorMsg);
          await logError('No tasks found for final document compilation', new Error(errorMsg));
          throw new Error(errorMsg);
        }
        console.log(`Found ${tasks.length} tasks for compilation`);
        const completedTasks = tasks.filter(task => task.status === 'completed' || task.status === 'completed_final').length;
        console.log(`Completed tasks: ${completedTasks}/${totalBatches}`);
      
        if (completedTasks < totalBatches) {
          const errorMsg = `Not all batches completed: ${completedTasks}/${totalBatches}`;
          console.error(errorMsg);
          throw new Error(errorMsg);
        }
        const task = tasks.find(t => t.story_title && t.description && t.folder_timestamp);
        if (!task) {
          const errorMsg = 'No task with valid story_title, description, or folder_timestamp';
          console.error(errorMsg);
          throw new Error(errorMsg);
        }
        console.log(`Starting compilation with task:`, {
          story_title: task.story_title,
          description: task.description,
          variant: task.variant,
          folder_timestamp: task.folder_timestamp,
          video_process: task.video_process
        });
        await compileFinalDocument(userId, groupId, task.story_title, task.description, task.variant, task.is_corrected, task.version, task.folder_timestamp, tab, task.image_model);
        return;
      }
      const nextBatchNumber = currentBatchNumber + 1;
      console.log(`Triggering next batch ${nextBatchNumber} for group ${groupId}, tab ${tab}`);
      const response = await fetch(`${supabaseUrl}/functions/v1/trigger-next-image`, {
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
          variant: variant,
        }),
      });
      if (!response.ok) {
        const errorText = await response.text();
       
        // Check if the error is about no next batch found
        if (errorText.includes('No queued, pending, or error task found') ||
            errorText.includes('All batches completed')) {
          console.log(`No next batch found (${nextBatchNumber}), checking if all work is completed`);
         
          // Check if we actually have all batches completed
          const { data: allTasks } = await supabase
            .from('image_tasks')
            .select('status, batch_number')
            .eq('group_id', groupId)
            .eq('user_id', userId)
            .eq('tab', tab)
            .eq('variant', variant)
            .gt('batch_number', 0)
            .order('batch_number', { ascending: true });
           
          if (allTasks) {
            const completedCount = allTasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
            console.log(`Found ${completedCount} completed tasks out of ${totalBatches} total batches`);
           
            if (completedCount >= totalBatches) {
              console.log(`All batches are actually completed, proceeding to final compilation`);
              
              // Add a small delay to ensure all status updates are committed
              await new Promise(resolve => setTimeout(resolve, 1000));
              
              // Proceed to final compilation since all batches are done
              const { data: tasks, error: tasksError } = await supabase
                .from('image_tasks')
                .select('story_title, description, variant, is_corrected, status, version, folder_timestamp, video_process, itv, image_model')
                .eq('group_id', groupId)
                .eq('user_id', userId)
                .eq('tab', tab)
                .eq('variant', variant)
                .gt('batch_number', 0)
                .order('batch_number', { ascending: true });
              if (tasksError || !tasks || tasks.length === 0) {
                console.error(`No tasks found for final compilation: ${tasksError?.message || 'No data'}`);
                return; // Don't throw error, just return
              }
              const task = tasks.find(t => t.story_title && t.description && t.folder_timestamp);
              if (task) {
                await compileFinalDocument(userId, groupId, task.story_title, task.description, task.variant, task.is_corrected, task.version, task.folder_timestamp, tab, task.image_model);
              }
              return;
            }
          }
        }
       
        if ([429, 500, 502, 503, 504, 520].some(code => response.status === code) && attempt < retryDelays.length) {
          console.log(`Retryable error ${response.status}, retrying after ${retryDelays[attempt]/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
       
        // Log the error but don't throw - this prevents setting current batch to error
        console.error(`Failed to trigger next batch ${nextBatchNumber}: HTTP ${response.status}: ${errorText}`);
        await logError(`Failed to trigger next batch ${nextBatchNumber}`, new Error(`HTTP ${response.status}: ${errorText}`));
        return; // Return instead of throwing
      }
      console.log(`Successfully triggered batch ${nextBatchNumber}`);
      return;
    } catch (error: any) {
      console.error(`Error in triggerNextBatch attempt ${attempt + 1}: ${error.message}`);
    
      if (attempt < retryDelays.length) {
        console.log(`Retrying after ${retryDelays[attempt]/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      // Log the error but don't update current batch status or throw
      console.error(`Final error triggering next batch after all attempts: ${error.message}`);
      await logError(`Error triggering batch ${currentBatchNumber + 1}`, error);
      return; // Return instead of throwing
    }
  }
}
async function callGenerateImage(payload: any, taskId: string, batchNumber: number): Promise<{ image_url?: string; tokens?: number; status?: string }> {
  const retryDelays = [10000, 20000, 30000, 40000, 50000];
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 390000);
      const response = await fetch(`${supabaseUrl}/functions/v1/generate-image`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      // Handle 202 response for flux-2-dev background processing
      if (response.status === 202) {
        console.log(`Received 202 for flux-2-dev task ${taskId}, batch ${batchNumber} - processing in background`);
        const result = await response.json();
        return { status: 'flux_processing' };
      }

      if (!response.ok) {
        const errorText = await response.text();
        
        // Handle HTTP 546 WORKER_LIMIT error specially
        if (response.status === 546 && errorText.includes('WORKER_LIMIT')) {
          console.log(`HTTP 546 WORKER_LIMIT error for task ${taskId}, batch ${batchNumber}, checking if image was actually created...`);
          
          // Check if the task was actually completed despite the error
          const { data: taskCheck, error: checkError } = await supabase
            .from('image_tasks')
            .select('status, batch_output, tokens')
            .eq('id', taskId)
            .single();
            
          if (!checkError && taskCheck && taskCheck.status === 'completed' && taskCheck.batch_output) {
            console.log(`Task ${taskId} was actually completed despite HTTP 546 error, using existing result`);
            // Extract image URL from batch_output if possible
            const urlMatch = taskCheck.batch_output.match(/https?:\/\/[^\s]+/);
            return { 
              image_url: urlMatch ? urlMatch[0] : taskCheck.batch_output, 
              tokens: taskCheck.tokens || 0 
            };
          }
          
          // If not completed, wait a bit and check again in case it's still processing
          console.log(`Task ${taskId} not yet completed, waiting 10 seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, 10000));
          
          const { data: taskCheck2, error: checkError2 } = await supabase
            .from('image_tasks')
            .select('status, batch_output, tokens')
            .eq('id', taskId)
            .single();
            
          if (!checkError2 && taskCheck2 && taskCheck2.status === 'completed' && taskCheck2.batch_output) {
            console.log(`Task ${taskId} completed after waiting, using result`);
            const urlMatch = taskCheck2.batch_output.match(/https?:\/\/[^\s]+/);
            return { 
              image_url: urlMatch ? urlMatch[0] : taskCheck2.batch_output, 
              tokens: taskCheck2.tokens || 0 
            };
          }
          
          // If still not completed, treat as retryable error
          if (attempt < retryDelays.length) {
            console.log(`HTTP 546 error and task not completed, retrying attempt ${attempt + 1}...`);
            await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
            continue;
          }
        }
        
        if ([429, 500, 502, 503, 504, 520].some(code => response.status === code) && attempt < retryDelays.length) {
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      if (!result.image_url) throw new Error('Invalid response: Missing image_url');
      return result;
    } catch (error: any) {
      // If it's a model unavailable error or content filtering error, don't retry - let it go to empty-redo immediately
      if (error.name === 'ModelUnavailableError' ||
          error.message.includes('Content is filtered') ||
          error.message.includes('Support codes:')) {
        throw error;
      }
    
      if (attempt < retryDelays.length && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504') || error.message.includes('520') || error.name === 'AbortError')) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Failed to generate image after 5 attempts');
}
async function callEmptyRedo(payload: any, taskId: string, batchNumber: number): Promise<{ image_url?: string; tokens?: number; status?: string }> {
  const retryDelays = [10000, 20000, 30000, 40000, 50000];
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 390000);
      // Add task_id to the payload for empty-redo
      const emptyRedoPayload = {
        ...payload,
        task_id: taskId
      };
      const response = await fetch(`${supabaseUrl}/functions/v1/empty-redo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify(emptyRedoPayload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      // Handle 202 response for flux-2-dev background processing
      if (response.status === 202) {
        console.log(`Received 202 from empty-redo for flux-2-dev task ${taskId}, batch ${batchNumber} - processing in background`);
        const result = await response.json();
        return { status: 'flux_processing' };
      }

      if (!response.ok) {
        const errorText = await response.text();
        
        // Handle HTTP 546 WORKER_LIMIT error specially
        if (response.status === 546 && errorText.includes('WORKER_LIMIT')) {
          console.log(`HTTP 546 WORKER_LIMIT error in empty-redo for task ${taskId}, batch ${batchNumber}, checking if image was actually created...`);
          
          // Check if the task was actually completed despite the error
          const { data: taskCheck, error: checkError } = await supabase
            .from('image_tasks')
            .select('status, batch_output, tokens')
            .eq('id', taskId)
            .single();
            
          if (!checkError && taskCheck && taskCheck.status === 'completed' && taskCheck.batch_output) {
            console.log(`Task ${taskId} was actually completed in empty-redo despite HTTP 546 error, using existing result`);
            const urlMatch = taskCheck.batch_output.match(/https?:\/\/[^\s]+/);
            return { 
              image_url: urlMatch ? urlMatch[0] : taskCheck.batch_output, 
              tokens: taskCheck.tokens || 0 
            };
          }
          
          // Wait and check again
          await new Promise(resolve => setTimeout(resolve, 10000));
          
          const { data: taskCheck2, error: checkError2 } = await supabase
            .from('image_tasks')
            .select('status, batch_output, tokens')
            .eq('id', taskId)
            .single();
            
          if (!checkError2 && taskCheck2 && taskCheck2.status === 'completed' && taskCheck2.batch_output) {
            console.log(`Task ${taskId} completed in empty-redo after waiting, using result`);
            const urlMatch = taskCheck2.batch_output.match(/https?:\/\/[^\s]+/);
            return { 
              image_url: urlMatch ? urlMatch[0] : taskCheck2.batch_output, 
              tokens: taskCheck2.tokens || 0 
            };
          }
          
          if (attempt < retryDelays.length) {
            await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
            continue;
          }
        }
        
        if ([429, 500, 502, 503, 504, 520].some(code => response.status === code) && attempt < retryDelays.length) {
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      if (!result.image_url) throw new Error('Invalid response: Missing image_url');
      console.log(`Successfully retried with empty-redo for task ${taskId}, batch ${batchNumber}`);
      return result;
    } catch (error: any) {
      if (attempt < retryDelays.length && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504') || error.message.includes('520') || error.name === 'AbortError')) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      await supabase
        .from('image_tasks')
        .update({ status: 'pending', error: `Failed to redo empty image: ${error.message}`, updated_at: new Date().toISOString() })
        .eq('id', taskId);
      throw error;
    }
  }
  throw new Error('Failed to redo empty image after 5 attempts');
}
async function processImageTask(task: ImageTask, responseSent: { value: boolean }, tab: number = 1, variant: number = 1) {
  const { group_id, user_id, batch_number, total_batches } = task;
  try {
    // Check if image processing is enabled for this video task
    const { data: videoTask } = await supabase
      .from('video_tasks')
      .select('process_images')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .single();
    if (videoTask && videoTask.process_images === false) {
      console.log(`Image processing disabled for group ${group_id}, returning empty response`);
      await supabase
        .from('image_tasks')
        .update({
          status: 'completed',
          batch_output: 'Image processing disabled',
          progress: 100,
          tokens: 0,
          token_updated: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', task.id);
     
      await triggerNextBatch(group_id, user_id, batch_number, total_batches, tab, variant);
      return { content: 'Image processing disabled', tokens: 0, batch_number, skipped: true };
    }
    if (task.status === 'completed' || task.status === 'completed_final') {
      await triggerNextBatch(group_id, user_id, batch_number, total_batches, tab, variant);
      return { content: task.batch_output || '', tokens: task.tokens || 0, batch_number };
    }
    await supabase
      .from('image_tasks')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', task.id);
    if (!task.batch || !Array.isArray(task.batch) || task.batch.length !== 1 || !task.batch[0]?.text) {
      await supabase
        .from('image_tasks')
        .update({ status: 'pending', error: 'Invalid batch data', updated_at: new Date().toISOString() })
        .eq('id', task.id);
      throw new Error('Invalid batch data');
    }
    const prompt = task.batch[0].text;
    const imageNumber = task.batch_number;
    const sanitizedTitle = task.story_title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
    const folderTimestamp = task.folder_timestamp || new Date().toISOString().replace(/[:.]/g, '-');
    const imageFolder = `documents/${user_id}/${group_id}/${sanitizedTitle}_${folderTimestamp}`;
    const imagePath = `${imageFolder}/${imageNumber}.png`;
    const generatePayload = {
      prompt,
      image_number: imageNumber,
      image_model: task.image_model,
      task_id: task.id,
      // Forward the real user_id so generate-image (called under service-role) can
      // resolve is_legacy_plan for THIS user instead of defaulting to legacy.
      user_id
    };
    let image_url: string = '';
    let tokens: number = 0;
    let imageData: ArrayBuffer;
    let useEmptyRedo = false;
    // Get expected tokens based on model AND user's legacy status, so the pre-flight
    // quota check uses the correct (NEW vs LEGACY) per-image price for this user.
    const isLegacy = await getIsLegacyPlan(user_id);
    const expectedTokens = imageTokens(isLegacy, task.image_model);
    // Check token availability before proceeding
    const canUseTokens = await checkTokenAvailability(user_id, expectedTokens);
    console.log(`Token availability for user ${user_id}: ${canUseTokens ? 'available' : 'exceeded'}`);
    try {
      const result = await callGenerateImage(generatePayload, task.id, batch_number);
      
      // Handle flux-2-dev background processing (202 response)
      if (result.status === 'flux_processing') {
        console.log(`Flux-2-dev processing in background for task ${task.id}, batch ${batch_number}`);
        // Task remains in 'running' status, background process will complete it
        return { content: `Flux-2-dev processing in background for image ${batch_number}`, tokens: 0, batch_number };
      }
      
      image_url = result.image_url!;
      tokens = result.tokens!;
      
      // Handle data URL vs HTTP URL
      if (image_url.startsWith('data:image/')) {
        // Handle data URL - extract base64 and convert to ArrayBuffer
        const base64Data = image_url.split(',')[1];
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        imageData = bytes.buffer;
      } else {
        // Handle HTTP URL - fetch as before
        const imageResponse = await fetch(image_url);
        if (!imageResponse.ok) throw new Error(`Failed to download image: HTTP ${imageResponse.status}`);
        imageData = await imageResponse.arrayBuffer();
      }
      
      if (imageData.byteLength === 0) {
        console.log(`Empty image file detected for task ${task.id}, batch ${batch_number}, trying empty-redo`);
        useEmptyRedo = true;
      } else if (imageData.byteLength < 100000) {
        console.log(`Image file too small (${imageData.byteLength} bytes) for task ${task.id}, batch ${batch_number}, trying empty-redo`);
        useEmptyRedo = true;
      }
    } catch (error: any) {
      // If it's a model unavailable error, content filtering error, or any other error from generate-image, try empty-redo
      if (error.name === 'ModelUnavailableError' ||
          error.message.includes('cannot be generated') ||
          error.message.includes('try use another model') ||
          error.message.includes('Content is filtered') ||
          error.message.includes('Support codes:')) {
        console.log(`Model unavailable or content filtered for task ${task.id}, batch ${batch_number}, trying empty-redo`);
        useEmptyRedo = true;
      } else {
        console.log(`Initial image generation failed for task ${task.id}, batch ${batch_number}, trying empty-redo`);
        useEmptyRedo = true;
      }
    }
    // If we need to use empty-redo
    if (useEmptyRedo) {
      try {
        const result = await callEmptyRedo(generatePayload, task.id, batch_number);
        
        // Handle flux-2-dev background processing in empty-redo (202 response)
        if (result.status === 'flux_processing') {
          console.log(`Flux-2-dev empty-redo processing in background for task ${task.id}, batch ${batch_number}`);
          // Task remains in 'running' status, background process will complete it
          return { content: `Flux-2-dev empty-redo processing in background for image ${batch_number}`, tokens: 0, batch_number };
        }
        
        image_url = result.image_url!;
        tokens = result.tokens!;
        
        // Handle data URL vs HTTP URL for empty-redo result
        if (image_url.startsWith('data:image/')) {
          // Handle data URL - extract base64 and convert to ArrayBuffer
          const base64Data = image_url.split(',')[1];
          const binaryString = atob(base64Data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          imageData = bytes.buffer;
        } else {
          // Handle HTTP URL - fetch as before
          const imageResponse = await fetch(image_url);
          if (!imageResponse.ok) throw new Error(`Failed to download image: HTTP ${imageResponse.status}`);
          imageData = await imageResponse.arrayBuffer();
        }
        
        if (imageData.byteLength === 0) {
          await logError(`Empty image file after empty-redo for task ${task.id}, batch ${batch_number}`, { message: 'Redone image is still 0 bytes' });
          await supabase
            .from('image_tasks')
            .update({ status: 'pending', error: 'Redone image is still 0 bytes', updated_at: new Date().toISOString() })
            .eq('id', task.id);
          throw new Error('Redone image is still 0 bytes');
        } else if (imageData.byteLength < 100000) {
          console.warn(`Image still small after empty-redo (${imageData.byteLength} bytes) for task ${task.id}, batch ${batch_number}, accepting anyway`);
        }
      } catch (error: any) {
        throw error; // Throw error if empty-redo fails
      }
    }
    let uploadAttempt = 0;
    const maxUploadAttempts = 3;
    const uploadRetryDelays = [5000, 10000, 20000];
  
    while (uploadAttempt < maxUploadAttempts) {
      try {
        console.log(`Upload attempt ${uploadAttempt + 1} for ${imagePath}`);
       
        // Upload the file
        const { error: uploadError } = await supabase.storage
          .from('stories')
          .upload(imagePath, imageData, { contentType: 'image/png' });
       
        if (uploadError && !uploadError.message.includes('The resource already exists')) {
          throw new Error(`Failed to upload image: ${uploadError.message}`);
        }
       
        if (uploadError && uploadError.message.includes('The resource already exists')) {
          console.log(`File already exists: ${imagePath}, verifying...`);
        } else {
          console.log(`Successfully uploaded: ${imagePath}`);
        }
       
        // Wait for storage propagation
        await new Promise(resolve => setTimeout(resolve, 2000));
       
        // Verify using list() - much more efficient
        const pathParts = imagePath.split('/');
        const fileName = pathParts.pop();
        const folderPath = pathParts.join('/');
        
        const { data: fileList, error: listError } = await supabase.storage
          .from('stories')
          .list(folderPath, { search: fileName });
        
        if (listError) {
          throw new Error(`File verification failed: ${listError.message}`);
        }
        
        const fileInfo = fileList?.find(f => f.name === fileName);
        
        if (!fileInfo) {
          throw new Error(`File not found in storage: ${fileName}`);
        }
        
        const fileSize = fileInfo.metadata?.size || 0;
        const minSize = 100000; // 100KB
        
        if (fileSize < minSize) {
          console.warn(`File smaller than expected: ${fileSize} bytes (threshold: ${minSize} bytes), accepting since image was validated before upload`);
        }
        
        console.log(`Successfully verified file: ${imagePath} (${fileSize} bytes)`);
        break; // Success - exit retry loop
       
      } catch (uploadError: any) {
        console.error(`Upload attempt ${uploadAttempt + 1} failed:`, uploadError.message);
       
        if (uploadAttempt < maxUploadAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, uploadRetryDelays[uploadAttempt]));
          uploadAttempt++;
          continue;
        }
       
        // All attempts failed
        await logError(`Failed to upload and verify image after ${maxUploadAttempts} attempts`, uploadError);
        await supabase
          .from('image_tasks')
          .update({
            status: 'pending',
            error: `Failed to upload/verify image: ${uploadError.message}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id);
        throw uploadError;
      }
    }
    const { data: urlData } = supabase.storage.from('stories').getPublicUrl(imagePath);
    if (!urlData?.publicUrl) throw new Error('Failed to retrieve public URL');
    const batchContent = `Image ${imageNumber} saved to: ${urlData.publicUrl}`;
    // Determine tokens to record based on availability
    const tokensToRecord = canUseTokens ? tokens : 0;
    // Mark the current batch as completed - this should always happen if image processing succeeded
    await supabase
      .from('image_tasks')
      .update({
        status: 'completed',
        batch_output: batchContent,
        progress: 100,
        tokens: tokensToRecord,
        token_updated: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id);
    // NOTE: user_plans.tokens_used is updated by the image_tasks_tokens_update DB trigger
    // when token_updated is set to true above. No direct update needed here.
    
    // Check if this is the last batch - if so, trigger final compilation immediately
    if (batch_number >= total_batches) {
      console.log(`Last batch ${batch_number} completed, checking if all batches are done for final compilation`);
      
      try {
        // Add a small delay to ensure the status update is committed
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Verify all batches are completed
        const { data: allTasks, error: tasksError } = await supabase
          .from('image_tasks')
          .select('id, status, batch_number, story_title, description, variant, is_corrected, version, folder_timestamp, video_process, image_model')
          .eq('group_id', group_id)
          .eq('user_id', user_id)
          .eq('tab', tab)
          .eq('variant', variant)
          .gt('batch_number', 0)
          .order('batch_number', { ascending: true });
        
        if (tasksError) {
          console.error(`Error fetching tasks for final compilation check: ${tasksError.message}`);
          throw tasksError;
        }
        
        if (!allTasks || allTasks.length === 0) {
          console.error('No tasks found for final compilation');
          throw new Error('No tasks found for final compilation');
        }
        
        const completedCount = allTasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
        console.log(`Batch ${batch_number}: ${completedCount}/${total_batches} tasks completed`);
        
        if (completedCount >= total_batches) {
          console.log(`All ${total_batches} batches completed, triggering final compilation now`);
          
          // Get task metadata for compilation
          const taskWithMetadata = allTasks.find(t => t.story_title && t.description && t.folder_timestamp);
          
          if (!taskWithMetadata) {
            console.error('No task found with required metadata for final compilation');
            throw new Error('No task with valid metadata found');
          }
          
          // Directly call compileFinalDocument to ensure all tasks get updated to completed_final
          await compileFinalDocument(
            user_id,
            group_id,
            taskWithMetadata.story_title,
            taskWithMetadata.description,
            taskWithMetadata.variant,
            taskWithMetadata.is_corrected,
            taskWithMetadata.version,
            taskWithMetadata.folder_timestamp,
            tab,
            taskWithMetadata.image_model
          );
          
          console.log(`Final compilation completed successfully for group ${group_id}, tab ${tab}`);
        } else {
          console.log(`Not all batches completed yet (${completedCount}/${total_batches}), finding missing batch to retry`);
          
          // Find the lowest batch_number that is not completed
          const missingBatch = allTasks.find(t => t.status !== 'completed' && t.status !== 'completed_final');
          
          if (missingBatch) {
            console.log(`Found missing batch ${missingBatch.batch_number} with status '${missingBatch.status}', setting to queued and triggering retry`);
            
            // Set the missing batch to queued
            const { error: updateError } = await supabase
              .from('image_tasks')
              .update({ 
                status: 'queued', 
                error: null,
                updated_at: new Date().toISOString() 
              })
              .eq('id', missingBatch.id);
            
            if (updateError) {
              console.error(`Error updating missing batch ${missingBatch.batch_number} to queued: ${updateError.message}`);
            } else {
              // Trigger processing for the missing batch
              try {
                await fetch(`${supabaseUrl}/functions/v1/trigger-next-image`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'apikey': supabaseServiceRoleKey,
                  },
                  body: JSON.stringify({
                    group_id: group_id,
                    user_id: user_id,
                    current_batch_number: missingBatch.batch_number - 1,
                    tab: tab,
                    variant: variant,
                  }),
                });
                console.log(`Successfully triggered retry for missing batch ${missingBatch.batch_number}`);
              } catch (retryError: any) {
                console.error(`Error triggering retry for missing batch ${missingBatch.batch_number}:`, retryError.message);
                await logError(`Error triggering retry for missing batch ${missingBatch.batch_number}`, retryError);
              }
            }
          } else {
            console.warn(`No missing batch found but completed count (${completedCount}) < total batches (${total_batches})`);
          }
        }
      } catch (error: any) {
        console.error(`Error during final compilation for last batch ${batch_number}:`, error.message);
        await logError(`Error during final compilation for last batch ${batch_number}`, error);
        // Don't throw - we'll rely on the fallback triggerNextBatch mechanism
      }
    } else {
      // Not the last batch, trigger next batch normally
      try {
        await triggerNextBatch(group_id, user_id, batch_number, total_batches, tab, variant);
      } catch (error: any) {
        // Log the error but don't throw - current batch is already completed
        console.error(`Failed to trigger next batch after completing batch ${batch_number}:`, error.message);
        await logError(`Failed to trigger next batch after completing batch ${batch_number}`, error);
      }
    }
    
    return { content: batchContent, tokens: tokensToRecord, batch_number };
  } catch (error: any) {
    await logError('Error in process-image task', error);
    await supabase
      .from('image_tasks')
      .update({ status: 'pending', error: `Processing failed: ${error.message}`, updated_at: new Date().toISOString() })
      .eq('id', task.id);
    
    // Always trigger next batch even on failure so pipeline doesn't stall
    try {
      console.log(`Triggering next batch after failure on batch ${batch_number}`);
      await triggerNextBatch(group_id, user_id, batch_number, total_batches, tab, variant);
    } catch (triggerError: any) {
      console.error(`Failed to trigger next batch after error on batch ${batch_number}:`, triggerError.message);
    }
    
    throw error;
  }
}
serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 400000;
  const idleTimeout = 390000;
  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });
    let payload: RequestBody;
    try {
      payload = await req.json();
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Invalid JSON payload', code: 400 }), { status: 400, headers: responseHeaders });
    }
    const validationError = validateInputs(payload);
    if (validationError) return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });
    const { group_id, user_id, batch_number, total_batches, tab = 1, variant = 1 } = payload;
    const tabNumber = tab;
    const variantNumber = variant;
    const { data: task, error: taskError } = await supabase
      .from('image_tasks')
      .select('*')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('batch_number', batch_number)
      .eq('tab', tabNumber)
      .eq('variant', variantNumber)
      .single();
    if (taskError || !task) {
      await logError('Task not found', taskError || new Error('No task found'));
      return new Response(JSON.stringify({ error: 'Task not found', code: 404 }), { status: 404, headers: responseHeaders });
    }
    const responseSent = { value: false };
    setTimeout(async () => {
      if (!responseSent.value && Date.now() - startTime > idleTimeout - 5000) {
        await supabase
          .from('image_tasks')
          .update({ status: 'running', updated_at: new Date().toISOString() })
          .eq('id', task.id);
      }
    }, idleTimeout - 5000);
    const result = await processImageTask(task, responseSent, tabNumber, variantNumber);
    responseSent.value = true;
    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);
    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });
  } catch (error: any) {
    await logError('Error in process-image', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});



