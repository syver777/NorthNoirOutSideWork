import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { supabase, logError, checkTokenAvailability, verifyAuth } from '../_shared/utils.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SECRET_KEY') ?? '';
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
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
  feedback: string;
}

function validateInputs(data: any): string | null {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!data.group_id || !uuidRegex.test(data.group_id)) return 'Missing or invalid group_id';
  if (!data.user_id || !uuidRegex.test(data.user_id)) return 'Missing or invalid user_id';
  if (typeof data.batch_number !== 'number' || data.batch_number < 1) return 'Missing or invalid batch_number';
  if (typeof data.total_batches !== 'number' || data.total_batches < 1) return 'Missing or invalid total_batches';
  if (typeof data.tab !== 'undefined' && (typeof data.tab !== 'number' || data.tab < 1 || data.tab > 10)) return 'Invalid tab parameter';
  if (typeof data.variant !== 'undefined' && (typeof data.variant !== 'number' || data.variant < 1)) return 'Invalid variant parameter';
  return null;
}

async function getPreviousContent(userId: string, groupId: string, currentBatchNumber: number, tab: number = 1, variant: number = 1): Promise<string> {
  try {
    console.log(`Fetching previous content for group ${groupId}, batch ${currentBatchNumber}, tab ${tab}, variant ${variant}, is_corrected: true, version: 2`);
    const { data, error } = await supabase
      .from('story_tasks')
      .select('previous_content')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('is_corrected', true)
      .eq('version', 2)
      .eq('variant', variant)
      .eq('tab', tab)
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

async function getFeedback(userId: string, groupId: string, tab: number = 1, variant: number = 1): Promise<string> {
  try {
    console.log(`Fetching feedback for group ${groupId}, tab ${tab}, variant ${variant}, is_corrected: true, version: 2, batch_number: 0`);
    const { data, error } = await supabase
      .from('story_tasks')
      .select('feedback')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('is_corrected', true)
      .eq('version', 2)
      .eq('variant', variant)
      .eq('tab', tab)
      .eq('batch_number', 0)
      .single();
    if (error) throw new Error(`Failed to fetch feedback: ${error.message}`);
    if (!data || !data.feedback) {
      throw new Error('No feedback found in corrected outline task');
    }
    console.log(`Fetched feedback, length: ${data.feedback.length} characters`);
    return data.feedback;
  } catch (error: any) {
    console.error(`Error fetching feedback: ${error.message}`);
    await logError('Error fetching feedback', error);
    throw error;
  }
}

async function callGenerateCorrectedStory(chapters: Chapter[], previousContent: string, feedback: string, totalWordCount: number, groupId: string, userId: string, batchNumber: number, tab: number = 1, variant: number = 1, youtubeTranscript: string | null = null, contentType: string = 'story'): Promise<[string, number, number]> {
  try {
    // First check if the batch is already completed
    console.log(`Checking if corrected batch ${batchNumber} is already completed...`);
    const { data: checkTask } = await supabase
      .from('story_tasks')
      .select('status, previous_content, input_tokens, output_tokens')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('batch_number', batchNumber)
      .eq('is_corrected', true)
      .eq('version', 2)
      .eq('variant', variant)
      .eq('tab', tab)
      .single();
    
    if (checkTask?.status === 'completed' && checkTask.previous_content) {
      console.log(`Corrected batch ${batchNumber} is already completed, using existing content`);
      return [checkTask.previous_content, checkTask.input_tokens || 0, checkTask.output_tokens || 0];
    }

    console.log(`Calling generate-corrected-story for batch ${batchNumber}`);
    const response = await fetch(`${SUPABASE_URL}/functions/v1/generate-corrected-story`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({
        chapters,
        previous_content: previousContent,
        feedback,
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
    
    if (!response.ok) throw new Error(`HTTP ${response.status}: Failed to generate corrected batch`);
    const result = await response.json();
    
    // Check if a retry was triggered
    if (result.retry_triggered) {
      console.log(`Retry was triggered for corrected batch ${batchNumber}, checking for completion...`);
      
      // Wait a moment and check if the batch was completed by the retry
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const { data: retryCheckTask } = await supabase
        .from('story_tasks')
        .select('status, previous_content, input_tokens, output_tokens')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('batch_number', batchNumber)
        .eq('is_corrected', true)
        .eq('version', 2)
        .eq('variant', variant)
        .eq('tab', tab)
        .single();
      
      if (retryCheckTask?.status === 'completed' && retryCheckTask.previous_content) {
        console.log(`Corrected batch ${batchNumber} was completed by retry, using retry content`);
        return [retryCheckTask.previous_content, retryCheckTask.input_tokens || 0, retryCheckTask.output_tokens || 0];
      }
    }

    // Check if final compilation was triggered
    if (result.final_compilation_triggered) {
      console.log(`Final compilation was triggered for corrected batch ${batchNumber}`);
    }
    
    if (!result.content || typeof result.input_tokens !== 'number' || typeof result.output_tokens !== 'number') {
      throw new Error('Invalid generate-corrected-story response');
    }
    console.log(`Generated corrected content for batch ${batchNumber}, length: ${result.content.length} characters`);
    return [result.content, result.input_tokens, result.output_tokens];
  } catch (error: any) {
    // Check if task was completed despite the error (including by retry)
    console.log(`Checking if corrected batch ${batchNumber} was completed despite error...`);
    const { data: checkTask } = await supabase
      .from('story_tasks')
      .select('status, previous_content, input_tokens, output_tokens')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('batch_number', batchNumber)
      .eq('is_corrected', true)
      .eq('version', 2)
      .eq('variant', variant)
      .single();
    
    if (checkTask?.status === 'completed' && checkTask.previous_content) {
      console.log(`Corrected batch ${batchNumber} was completed despite error response, using existing content`);
      return [checkTask.previous_content, checkTask.input_tokens || 0, checkTask.output_tokens || 0];
    }
    
    console.error(`Error in generate-corrected-story for batch ${batchNumber}: ${error.message}`);
    await logError(`Generate-corrected-story failed for batch ${batchNumber}`, error);
    // Return empty content instead of throwing error
    return ['', 0, 0];
  }
}

async function compileFinalCorrectedStory(userId: string, groupId: string, title: string, description: string, tab: number = 1, variant: number = 1, language: string = 'english') {
  try {
    console.log(`Compiling final corrected story for group ${groupId}, tab ${tab}, variant ${variant} in language: ${language}`);

    // Fetch pauses flag from the original outline task (batch_number = 0, not corrected)
    const { data: outlineTask } = await supabase
      .from('story_tasks')
      .select('pauses')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('variant', variant)
      .eq('batch_number', 0)
      .eq('is_corrected', false)
      .single();
    const pauses = outlineTask?.pauses === true;

    const { data, error } = await supabase
      .from('story_tasks')
      .select('previous_content, batch, batch_number')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('is_corrected', true)
      .eq('version', 2)
      .eq('variant', variant)
      .eq('tab', tab)
      .gt('batch_number', 0)
      .order('batch_number', { ascending: true });
    if (error || !data) throw new Error(`Failed to fetch corrected story content: ${error?.message || 'No data'}`);

    let fullStoryText = `${title}\n\n`;
    data.forEach(task => {
      if (task.previous_content) {
        fullStoryText += `${task.previous_content.trim()}\n\n`;
      }
    });
    console.log(`Compiled final corrected story, length: ${fullStoryText.length} characters`);

    const sanitizedTitle = title.replace(/[^a-zA-Z0-9\s-]/g, '').toLowerCase().trim().replace(/\s+/g, '-');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const finalFilePath = `documents/${userId}/${groupId}/${sanitizedTitle}_corrected_${timestamp}.txt`;

    const { error: uploadError } = await supabase.storage
      .from('stories')
      .upload(finalFilePath, new TextEncoder().encode(fullStoryText), { contentType: 'text/plain' });
    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);
    console.log(`Uploaded final corrected story to ${finalFilePath}`);

    const { data: urlData } = supabase.storage.from('stories').getPublicUrl(finalFilePath);
    if (!urlData?.publicUrl) throw new Error('Failed to retrieve public URL');

    const wordCount = fullStoryText.split(/\s+/).filter(word => word.length > 0).length;
    const { error: docError } = await supabase
      .from('story_documents')
      .insert({
        title: `${title} (Corrected)`,
        description,
        word_count: wordCount,
        version: 2,
        is_corrected: true,
        user_id: userId,
        file_path: finalFilePath,
        file_url: urlData.publicUrl,
        created_at: new Date().toISOString(),
        group_id: groupId,
        variant: variant,
        is_prompted: false,
        tab: tab,
        pauses: pauses,
      });
    if (docError) throw new Error(`Failed to save corrected story document: ${docError.message}`);
    console.log(`Saved corrected story document for ${title}`);

    await supabase
      .from('story_tasks')
      .update({ status: 'completed_final', updated_at: new Date().toISOString() })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('is_corrected', true)
      .eq('version', 2)
      .eq('variant', variant)
      .eq('tab', tab)
      .gt('batch_number', 0);
    console.log(`Marked all corrected tasks as completed_final for group ${groupId}`);
  } catch (error: any) {
    console.error(`Error compiling final corrected story: ${error.message}`);
    await logError('Error compiling final corrected story', error);
    throw error;
  }
}

async function triggerNextCorrectedBatch(groupId: string, userId: string, currentBatchNumber: number, totalBatches: number, tab: number = 1, variant: number = 1) {
  if (currentBatchNumber >= totalBatches) {
    console.log(`No more corrected batches to trigger for group ${groupId}, tab ${tab}, variant ${variant}. Compiling final corrected story.`);
    const { data: task } = await supabase
      .from('story_tasks')
      .select('story_title, description, language')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('batch_number', currentBatchNumber)
      .eq('is_corrected', true)
      .eq('version', 2)
      .eq('variant', variant)
      .eq('tab', tab)
      .single();
    if (task) {
      const taskLanguage = task.language || 'english';
      await compileFinalCorrectedStory(userId, groupId, task.story_title, task.description, tab, variant, taskLanguage);
    }
    return;
  }
  const nextBatchNumber = currentBatchNumber + 1;
  try {
    console.log(`Triggering trigger-next-corrected-batch for batch ${nextBatchNumber} for group ${groupId}`);
    
    // Check if next batch is already running (set by generate-corrected-story)
    const { data: checkNextTask } = await supabase
      .from('story_tasks')
      .select('status')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('batch_number', nextBatchNumber)
      .eq('is_corrected', true)
      .eq('version', 2)
      .eq('variant', variant)
      .single();

    if (checkNextTask && checkNextTask.status === 'running') {
      console.log(`Next corrected batch ${nextBatchNumber} is already running, skipping trigger`);
      return;
    }

    fetch(`${SUPABASE_URL}/functions/v1/trigger-next-corrected-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({
        group_id: groupId,
        user_id: userId,
        current_batch_number: currentBatchNumber,
        tab: tab,
        variant: variant,
      }),
    }).catch(error => {
      console.error(`Error triggering corrected batch ${nextBatchNumber}: ${error.message}`);
      logError(`Error triggering corrected batch ${nextBatchNumber}`, error);
      supabase
        .from('story_tasks')
        .update({ status: 'running', updated_at: new Date().toISOString() })
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('batch_number', nextBatchNumber)
        .eq('is_corrected', true)
        .eq('version', 2)
        .eq('variant', variant)
        .eq('tab', tab);
    });
    console.log(`Initiated trigger-next-corrected-batch for batch ${nextBatchNumber}`);
  } catch (error: any) {
    console.error(`Error in triggerNextCorrectedBatch for batch ${nextBatchNumber}: ${error.message}`);
    await logError(`Error triggering corrected batch ${nextBatchNumber}`, error);
  }
}

serve(async (req: Request) => {
  const responseHeaders = { ...getCorsHeaders(req), 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 300000;
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
    console.log(`Starting process-corrected-story for batch ${batch_number}, group ${group_id}, tab ${tab}, variant ${variant}`);

    // UPDATED: Check for sequence issues - ensure batches are processed in order
    const { data: allTasks, error: allTasksError } = await supabase
      .from('story_tasks')
      .select('batch_number, status')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('is_corrected', true)
      .eq('version', 2)
      .eq('variant', variant)
      .eq('tab', tab)
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
        console.log(`Found incomplete corrected batch ${incompleteBefore.batch_number} before current batch ${batch_number}, deferring`);
        return new Response(JSON.stringify({ 
          error: `Corrected batch ${incompleteBefore.batch_number} must be completed first`, 
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
      .eq('is_corrected', true)
      .eq('version', 2)
      .eq('variant', variant)
      .eq('tab', tab)
      .eq('status', 'running');
    if (runningError) throw new Error(`Failed to check running corrected tasks: ${runningError.message}`);

    // Filter out the current batch from running tasks check
    const otherRunningTasks = runningTasks.filter(task => task.batch_number !== batch_number);
    if (otherRunningTasks.length > 0) {
      const errorMsg = `Another corrected batch is running: ${JSON.stringify(otherRunningTasks)}`;
      console.error(errorMsg);
      return new Response(JSON.stringify({ error: errorMsg, code: 409 }), { status: 409, headers: responseHeaders });
    }

    // If the current batch is already running, that's fine - we can proceed
    if (runningTasks.some(task => task.batch_number === batch_number)) {
      console.log(`Corrected batch ${batch_number} is already set to running, proceeding with processing`);
    }

    const { data: task, error: taskError } = await supabase
      .from('story_tasks')
      .select('id, batch, total_word_count, status, story_title, description, total_batches, previous_content, input_tokens, output_tokens')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('batch_number', batch_number)
      .eq('is_corrected', true)
      .eq('version', 2)
      .eq('variant', variant)
      .eq('tab', tab)
      .single();

    if (taskError || !task) {
      await logError('Corrected task query failed', taskError || new Error('No corrected task found'));
      return new Response(JSON.stringify({ error: 'Corrected task not found', code: 404 }), { status: 404, headers: responseHeaders });
    }

    if (task.status === 'completed' || task.status === 'completed_final') {
      console.log(`Corrected batch ${batch_number} already completed, triggering next batch`);
      await triggerNextCorrectedBatch(group_id, user_id, batch_number, total_batches, tab, variant);
      return new Response(JSON.stringify({ content: task.previous_content || '', input_tokens: task.input_tokens || 0, output_tokens: task.output_tokens || 0, batch_number }), { status: 200, headers: responseHeaders });
    }

    console.log(`Updating corrected batch ${batch_number} to running`);
    await supabase.from('story_tasks').update({ status: 'running', updated_at: new Date().toISOString() }).eq('id', task.id);

    const previousContent = await getPreviousContent(user_id, group_id, batch_number, tab, variant);
    const feedback = await getFeedback(user_id, group_id, tab, variant);

    // Fetch youtube_transcript and content_type from original outline row (batch_number=0)
    let youtubeTranscript: string | null = null;
    let contentType: string = 'story';
    try {
      const { data: outlineRow } = await supabase
        .from('story_tasks')
        .select('youtube_transcript, content_type')
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .eq('batch_number', 0)
        .eq('is_corrected', false)
        .eq('tab', tab)
        .eq('variant', variant)
        .single();
      youtubeTranscript = outlineRow?.youtube_transcript || null;
      contentType = outlineRow?.content_type || 'story';
      if (youtubeTranscript) {
        console.log(`Found youtube_transcript (${youtubeTranscript.length} chars) for corrected story group ${group_id}`);
      }
      if (contentType !== 'story') {
        console.log(`Content type: ${contentType} for corrected story group ${group_id}`);
      }
    } catch (e: any) {
      console.warn(`Failed to fetch youtube_transcript/content_type for corrected story group ${group_id}: ${e.message}`);
    }
    
    let batchText: string;
    let inputTokens: number;
    let outputTokens: number;
    
    [batchText, inputTokens, outputTokens] = await callGenerateCorrectedStory(task.batch, previousContent, feedback, task.total_word_count, group_id, user_id, batch_number, tab, variant, youtubeTranscript, contentType);
    
    // If generation failed (empty content), keep status as running and return success
    if (!batchText) {
      console.log(`Corrected batch ${batch_number} generation failed, keeping status as running for retry`);
      return new Response(JSON.stringify({ content: '', input_tokens: 0, output_tokens: 0, batch_number }), { status: 200, headers: responseHeaders });
    }

    // Check current task status to see if it was updated by retry
    const { data: currentTask } = await supabase
      .from('story_tasks')
      .select('status, previous_content, input_tokens, output_tokens')
      .eq('id', task.id)
      .single();

    if (currentTask?.status === 'completed') {
      console.log(`Corrected batch ${batch_number} was already completed by retry, using existing data`);
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
          console.error(`Failed to update corrected task ${task.id}: ${updateError.message}`);
        }
      } else {
        // Update to completed without tokens
        console.warn(`Skipping token update for corrected task ${task.id}: ${tokenCheck.reason}`);
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
          console.error(`Failed to update corrected task ${task.id} without tokens: ${updateError.message}`);
        }
        
        // Log the token limit issue
        await logError(`Token limit exceeded for user ${user_id}`, new Error(tokenCheck.reason || 'Token limit exceeded'));
      }
    }

    console.log(`Corrected batch ${batch_number} processing completed`);
    
    // Check if this is the last batch - if so, trigger final compilation directly
    if (batch_number >= total_batches) {
      console.log(`Batch ${batch_number} is the last batch, compiling final corrected story`);
      const { data: taskData } = await supabase
        .from('story_tasks')
        .select('story_title, description, language')
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .eq('batch_number', batch_number)
        .eq('is_corrected', true)
        .eq('version', 2)
        .eq('variant', variant)
        .eq('tab', tab)
        .single();
      
      if (taskData) {
        const taskLanguage = taskData.language || 'english';
        await compileFinalCorrectedStory(user_id, group_id, taskData.story_title, taskData.description, tab, variant, taskLanguage);
      }
    } else {
      // Not the last batch, trigger the next one
      await triggerNextCorrectedBatch(group_id, user_id, batch_number, total_batches, tab, variant);
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) {
      console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);
    }

    console.log(`Returning response for corrected batch ${batch_number}`);
    return new Response(JSON.stringify({ content: batchText, input_tokens: inputTokens, output_tokens: outputTokens, batch_number }), { status: 200, headers: responseHeaders });
  } catch (error: any) {
    console.error(`Error in process-corrected-story for batch ${payload?.batch_number || 'unknown'}: ${error.message}`);
    await logError('Error in process-corrected-story', error);
    if (payload?.group_id && payload?.user_id && payload?.batch_number) {
      await supabase
        .from('story_tasks')
        .update({ status: 'running', updated_at: new Date().toISOString() })
        .eq('group_id', payload.group_id)
        .eq('user_id', payload.user_id)
        .eq('batch_number', payload.batch_number)
        .eq('is_corrected', true)
        .eq('version', 2)
        .eq('variant', payload.variant || 1)
        .eq('tab', payload.tab || 1);
    }
    return new Response(JSON.stringify({ content: '', input_tokens: 0, output_tokens: 0, batch_number: payload?.batch_number }), { status: 200, headers: responseHeaders });
  }
});



