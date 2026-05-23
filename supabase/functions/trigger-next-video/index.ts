import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// corsHeaders is now set dynamically inside the serve handler via getCorsHeaders(req)

interface TriggerNextVideoRequest {
  video_task_id: string;
  user_id: string;
  group_id: string;
  individual_videos_paths?: string[];
  next_step: 'process_images' | 'create_final_video';
  completed_batch?: number;
  tab?: number; // Default 1 - tab number for enterprise users
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

async function getNextBatchToProcess(video_task_id: string) {
  try {
    // Get the main task
    const { data: mainTask, error: mainError } = await supabase
      .from('video_tasks')
      .select('*')
      .eq('id', video_task_id)
      .single();

    if (mainError || !mainTask) {
      throw new Error(`Failed to fetch main task: ${mainError?.message || 'Task not found'}`);
    }

    // Get all batch tasks for this main task
    const { data: batchTasks, error: batchError } = await supabase
      .from('video_tasks')
      .select('*')
      .eq('doc_id', video_task_id)
      .order('current_batch_number', { ascending: true });

    if (batchError) {
      throw new Error(`Failed to fetch batch tasks: ${batchError.message}`);
    }

    if (!batchTasks || batchTasks.length === 0) {
      throw new Error('No batch tasks found');
    }

    const totalBatches = batchTasks.length;

    // Find the next pending batch task
    const nextBatch = batchTasks.find(task => 
      task.video_creation_status === 'pending'
    );

    if (!nextBatch) {
      return {
        hasNext: false,
        nextBatchNumber: null,
        nextBatchTaskId: null,
        batchStart: null,
        batchEnd: null,
        totalBatches,
        completedBatches: batchTasks.filter(t => t.video_creation_status === 'completed').length
      };
    }

    return {
      hasNext: true,
      nextBatchNumber: nextBatch.current_batch_number,
      nextBatchTaskId: nextBatch.id,
      batchStart: nextBatch.processing_batch_start,
      batchEnd: nextBatch.processing_batch_end,
      batchSize: nextBatch.batch_size,
      totalBatches,
      completedBatches: batchTasks.filter(t => t.video_creation_status === 'completed').length
    };
  } catch (error: any) {
    console.error(`Error getting next batch to process:`, error);
    throw error;
  }
}

// Fire-and-forget function to call Google Cloud Function with retry logic
async function triggerBatchProcessingAsync(data: TriggerNextVideoRequest, batchInfo: any) {
  const { video_task_id, user_id, group_id, tab = 1 } = data;
  const { nextBatchNumber, nextBatchTaskId, batchStart, batchEnd, batchSize } = batchInfo;
  
  // Fetch gc_version for versioned GCF routing
  const { data: taskVersionData } = await supabase
    .from('video_tasks')
    .select('gc_version')
    .eq('id', video_task_id)
    .single();
  const gcVersion: number = taskVersionData?.gc_version ?? 1;
  const gcfSuffix = gcVersion > 1 ? String(gcVersion) : '';
  const imageProcessorUrl = `https://us-central1-story-script-ai.cloudfunctions.net/image-to-video-processor${gcfSuffix}`;
  console.log(`Using GCF URL: ${imageProcessorUrl} (gc_version=${gcVersion})`);

  const maxRetries = 10;
  // Timeout to confirm the request is dispatched to GCF without waiting for full processing
  const DISPATCH_TIMEOUT_MS = 8000;
  
  const makeRequest = async (attemptNum: number): Promise<boolean> => {
    try {
      console.log(`Attempt ${attemptNum}/${maxRetries}: Triggering GCF for batch ${nextBatchNumber} (images ${batchStart}-${batchEnd})`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
      
      try {
        const response = await fetch(imageProcessorUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseServiceRoleKey,
          },
          body: JSON.stringify({
            video_task_id,
            user_id,
            group_id,
            tab,
            batch_number: nextBatchNumber,
            batch_task_id: nextBatchTaskId,
            batch_start: batchStart,
            batch_end: batchEnd,
            batch_size: batchSize
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          console.log(`Successfully triggered GCF for batch ${nextBatchNumber} on attempt ${attemptNum}`);
          return true;
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          // Request was dispatched to GCF, we just didn't wait for it to finish processing
          console.log(`GCF request dispatched for batch ${nextBatchNumber} (timed out waiting for response — expected for long-running GCF)`);
          return true;
        }
        throw err;
      }
    } catch (error: any) {
      const errorMessage = error.message || 'Unknown error';
      console.error(`Attempt ${attemptNum}/${maxRetries} failed for batch ${nextBatchNumber}: ${errorMessage}`);
      
      // Check if this is a retryable error
      const isRetryable = 
        errorMessage.includes('dns error') ||
        errorMessage.includes('failed to lookup') ||
        errorMessage.includes('Temporary failure') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('ECONNRESET') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('fetch failed') ||
        error.code === 'ENOTFOUND' ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT';

      if (!isRetryable) {
        console.error(`Non-retryable error for batch ${nextBatchNumber}: ${errorMessage}`);
        return false;
      }

      if (attemptNum >= maxRetries) {
        console.error(`All ${maxRetries} attempts failed for batch ${nextBatchNumber}. Final error: ${errorMessage}`);
        return false;
      }

      // Before retrying, check if the batch was already completed by the first
      // invocation (which may have finished while the fetch was timing out).
      // This prevents duplicate GCF invocations for the same batch.
      try {
        const { data: batchCheck } = await supabase
          .from('video_tasks')
          .select('video_creation_status')
          .eq('id', nextBatchTaskId)
          .single();
        if (batchCheck?.video_creation_status === 'completed') {
          console.log(`Batch ${nextBatchNumber} is already completed (first invocation finished) — skipping retry`);
          return true;
        }
      } catch (checkErr: any) {
        console.log(`Could not check batch status before retry: ${checkErr.message}`);
      }

      // Wait 5 seconds before retry
      const delay = 5000;
      console.log(`Waiting ${delay}ms before retry ${attemptNum + 1} for batch ${nextBatchNumber}`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      return makeRequest(attemptNum + 1);
    }
  };

  // Await the first attempt so the fetch completes before the Deno handler returns.
  // Retries (if needed) still happen inline since makeRequest is recursive.
  const success = await makeRequest(1);
  if (success) {
    console.log(`Batch ${nextBatchNumber} processing triggered successfully`);
  } else {
    console.error(`Failed to trigger batch ${nextBatchNumber} after ${maxRetries} attempts`);
  }
}

async function triggerImageProcessing(data: TriggerNextVideoRequest) {
  const { video_task_id, user_id, group_id } = data;
  
  console.log(`Triggering batch processing for task ${video_task_id}`);
  
  try {
    // Get main task to check for video loop
    const { data: mainTask, error: mainTaskError } = await supabase
      .from('video_tasks')
      .select('video_loop, loop_time, tab')
      .eq('id', video_task_id)
      .single();

    if (mainTaskError) {
      throw new Error(`Failed to fetch main task: ${mainTaskError.message}`);
    }

    // If video loop is used, trigger batch processing which will handle the video loop
    if (mainTask?.video_loop) {
      console.log('Video loop detected, triggering batch processing to handle video loop');
      
      // Get next batch info (should be the first batch for video loop)
      const batchInfo = await getNextBatchToProcess(video_task_id);
      
      if (!batchInfo.hasNext) {
        console.log('No batches to process for video loop');
        return {
          status: 'completed',
          message: 'All batches have been processed',
          completed_batches: batchInfo.completedBatches,
          total_batches: batchInfo.totalBatches
        };
      }

      const { nextBatchNumber, nextBatchTaskId, batchStart, batchEnd } = batchInfo;
      
      console.log(`Processing video loop batch ${nextBatchNumber}`);
      
      // Update main task with current batch info and set to running
      await supabase
        .from('video_tasks')
        .update({
          individual_video_status: 'running',
          video_creation_status: 'running', // CHANGED: Set to running
          current_batch_number: nextBatchNumber,
          next_batch_to_process: nextBatchNumber,
          overall_status: 'running',
          updated_at: new Date().toISOString()
        })
        .eq('id', video_task_id);

      // Update batch task to 'running'
      if (nextBatchTaskId) {
        await supabase
          .from('video_tasks')
          .update({
            video_creation_status: 'running',
            overall_status: 'running',
            updated_at: new Date().toISOString()
          })
          .eq('id', nextBatchTaskId);
      }
      
      // Await the GCF call so it completes before the handler returns
      await triggerBatchProcessingAsync(data, batchInfo);
      
      return {
        status: 'triggered',
        message: `Video loop batch ${nextBatchNumber} processing started`,
        batch_number: nextBatchNumber,
        batch_start: batchStart,
        batch_end: batchEnd,
        batch_task_id: nextBatchTaskId,
        is_video_loop: true
      };
    }
    
    // Original image processing logic
    const batchInfo = await getNextBatchToProcess(video_task_id);
    
    if (!batchInfo.hasNext) {
      console.log('No more batches to process');
      return {
        status: 'completed',
        message: 'All batches have been processed',
        completed_batches: batchInfo.completedBatches,
        total_batches: batchInfo.totalBatches
      };
    }

    const { nextBatchNumber, nextBatchTaskId, batchStart, batchEnd } = batchInfo;
    
    console.log(`Processing batch ${nextBatchNumber} (images ${batchStart}-${batchEnd})`);
    
    // Update main task with current batch info and set to running
    await supabase
      .from('video_tasks')
      .update({
        individual_video_status: 'running',
        video_creation_status: 'running', // CHANGED: Set to running
        current_batch_number: nextBatchNumber,
        next_batch_to_process: nextBatchNumber,
        overall_status: 'running',
        updated_at: new Date().toISOString()
      })
      .eq('id', video_task_id);

    // Update batch task to 'running'
    if (nextBatchTaskId) {
      await supabase
        .from('video_tasks')
        .update({
          video_creation_status: 'running',
          overall_status: 'running',
          updated_at: new Date().toISOString()
        })
        .eq('id', nextBatchTaskId);
    }
    
    // Await the GCF call so it completes before the handler returns
    await triggerBatchProcessingAsync(data, batchInfo);
    
    return {
      status: 'triggered',
      message: `Batch ${nextBatchNumber} processing started`,
      batch_number: nextBatchNumber,
      batch_start: batchStart,
      batch_end: batchEnd,
      batch_task_id: nextBatchTaskId
    };
    
  } catch (error: any) {
    console.error(`Error triggering batch processing:`, error);
    
    // Update video task with error
    await supabase
      .from('video_tasks')
      .update({
        individual_video_status: 'error',
        overall_status: 'error',
        error_message: `Failed to trigger batch processing: ${error.message}`,
        updated_at: new Date().toISOString()
      })
      .eq('id', video_task_id);
    
    throw error;
  }
}

// Fire-and-forget function to call create-final-video with retry logic
async function triggerCreateFinalVideoAsync(data: TriggerNextVideoRequest) {
  const { video_task_id, user_id, group_id, individual_videos_paths, tab = 1 } = data;
  
  const maxRetries = 10;
  const DISPATCH_TIMEOUT_MS = 8000;
  
  const makeRequest = async (attemptNum: number): Promise<boolean> => {
    try {
      console.log(`Attempt ${attemptNum}/${maxRetries}: Triggering create-final-video for task ${video_task_id}`);
      
      // Fetch transition settings and gc_version from the main task
      const { data: mainTask, error: mainTaskError } = await supabase
        .from('video_tasks')
        .select('settings, gc_version')
        .eq('id', video_task_id)
        .single();

      if (mainTaskError) {
        console.error('Failed to fetch main task for transition settings:', mainTaskError);
      }

      const settings = mainTask?.settings || {};
      // Add default values for null animation_type and effects_type
      const animation_type = settings.animation_type || 'drift';
      const effects_type = settings.effects_type || 'film_grain';

      const gcVersion: number = mainTask?.gc_version ?? 1;
      const gcfSuffix = gcVersion > 1 ? String(gcVersion) : '';
      const createFinalVideoUrl = `https://us-central1-story-script-ai.cloudfunctions.net/create-final-video${gcfSuffix}`;
      console.log(`Using GCF URL: ${createFinalVideoUrl} (gc_version=${gcVersion})`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
      
      try {
        const response = await fetch(createFinalVideoUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseServiceRoleKey,
          },
          body: JSON.stringify({
            video_task_id,
            user_id,
            group_id,
            individual_videos_paths,
            tab,
            transition_type: settings.transition_type,
            transition_duration: settings.transition_duration,
            animation_type: animation_type,
            effects_type: effects_type
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          console.log(`Successfully triggered create-final-video on attempt ${attemptNum}`);
          return true;
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          console.log(`GCF request dispatched for create-final-video (timed out waiting for response — expected for long-running GCF)`);
          return true;
        }
        throw err;
      }
    } catch (error: any) {
      const errorMessage = error.message || 'Unknown error';
      console.error(`Attempt ${attemptNum}/${maxRetries} failed for create-final-video: ${errorMessage}`);
      
      // Check if this is a retryable error
      const isRetryable = 
        errorMessage.includes('dns error') ||
        errorMessage.includes('failed to lookup') ||
        errorMessage.includes('Temporary failure') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('ECONNRESET') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('fetch failed') ||
        error.code === 'ENOTFOUND' ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT';

      if (!isRetryable) {
        console.error(`Non-retryable error for create-final-video: ${errorMessage}`);
        return false;
      }

      if (attemptNum >= maxRetries) {
        console.error(`All ${maxRetries} attempts failed for create-final-video. Final error: ${errorMessage}`);
        return false;
      }

      // Wait 5 seconds before retry
      const delay = 5000;
      console.log(`Waiting ${delay}ms before retry ${attemptNum + 1} for create-final-video`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      return makeRequest(attemptNum + 1);
    }
  };

  // Await the first attempt so the fetch completes before the Deno handler returns.
  const success = await makeRequest(1);
  if (success) {
    console.log(`Create-final-video triggered successfully`);
  } else {
    console.error(`Failed to trigger create-final-video after ${maxRetries} attempts`);
  }
}

async function triggerCreateFinalVideo(data: TriggerNextVideoRequest) {
  const { video_task_id, user_id, group_id, individual_videos_paths } = data;
  
  console.log(`Triggering create-final-video for task ${video_task_id}`);
  
  try {
    // Update main task status to indicate final video creation has started
    await supabase
      .from('video_tasks')
      .update({
        video_creation_status: 'running',
        updated_at: new Date().toISOString()
      })
      .eq('id', video_task_id);

    // Update only non-completed batch tasks to indicate final processing has started
    await supabase
      .from('video_tasks')
      .update({
        overall_status: 'running',
        updated_at: new Date().toISOString()
      })
      .eq('doc_id', video_task_id)
      .neq('overall_status', 'completed');
    
    // Await the create-final-video call so it completes before the handler returns
    await triggerCreateFinalVideoAsync(data);
    
    return {
      status: 'triggered',
      message: 'Final video creation started'
    };
    
  } catch (error: any) {
    console.error(`Error triggering create final video:`, error);
    
    // Update video task with error
    await supabase
      .from('video_tasks')
      .update({
        video_creation_status: 'error',
        overall_status: 'error',
        error_message: `Failed to trigger final video creation: ${error.message}`,
        updated_at: new Date().toISOString()
      })
      .eq('id', video_task_id);
    
    throw error;
  }
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

async function checkVideoTaskProgress(video_task_id: string) {
  try {
    const { data: task, error } = await supabase
      .from('video_tasks')
      .select('*')
      .eq('id', video_task_id)
      .single();

    if (error) {
      throw new Error(`Failed to fetch video task: ${error.message}`);
    }

    if (!task) {
      throw new Error('Video task not found');
    }

    console.log(`Video task ${video_task_id} status:`, {
      individual_video_status: task.individual_video_status,
      video_creation_status: task.video_creation_status,
      overall_status: task.overall_status,
      completed_individual_videos: task.completed_individual_videos,
      total_individual_videos: task.total_individual_videos,
      current_batch: task.current_batch_number,
      has_video_loop: !!task.video_loop
    });

    return task;
  } catch (error: any) {
    console.error(`Error checking video task progress:`, error);
    throw error;
  }
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: responseHeaders });
    }

    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }), 
        { status: 405, headers: responseHeaders }
      );
    }

    // Auth check
    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });
    }

    const requestData: TriggerNextVideoRequest = await req.json();
    
    const { video_task_id, user_id, group_id, individual_videos_paths, next_step, completed_batch, tab = 1 } = requestData;

    if (!video_task_id || !user_id || !group_id || !next_step) {
      return new Response(
        JSON.stringify({ error: 'Missing required parameters' }), 
        { status: 400, headers: responseHeaders }
      );
    }

    console.log(`Processing trigger request for video task ${video_task_id}, next step: ${next_step}`);

    let result;
    
    switch (next_step) {
      case 'process_images':
        result = await triggerImageProcessing(requestData);
        break;
        
      case 'create_final_video':
        // Check current task progress first
        const task = await checkVideoTaskProgress(video_task_id);
        
        // Skip individual video validation for video loops (handled directly by create-final-video)
        if (!task.video_loop) {
          // Validate that individual videos are completed
          if (task.individual_video_status !== 'completed') {
            return new Response(
              JSON.stringify({ 
                error: 'Individual videos are not completed yet',
                current_status: task.individual_video_status
              }), 
              { status: 400, headers: responseHeaders }
            );
          }
        }
        result = await triggerCreateFinalVideo(requestData);
        break;
      
      default:
        return new Response(
          JSON.stringify({ error: `Unknown next step: ${next_step}` }), 
          { status: 400, headers: responseHeaders }
        );
    }

    return new Response(JSON.stringify({
      status: 'success',
      message: `Successfully triggered ${next_step}`,
      video_task_id,
      next_step,
      result
    }), { status: 200, headers: responseHeaders });

  } catch (error: any) {
    await logError('Error in trigger-next-video', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }), 
      { status: 500, headers: responseHeaders }
    );
  }
});




