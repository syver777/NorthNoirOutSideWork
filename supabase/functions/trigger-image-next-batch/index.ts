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

function validateInputs(data: any): string | null {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!data.group_id || !uuidRegex.test(data.group_id)) return 'Missing or invalid group_id';
  if (!data.user_id || !uuidRegex.test(data.user_id)) return 'Missing or invalid user_id';
  if (typeof data.current_batch_number !== 'number' || data.current_batch_number < 0) return 'Missing or invalid current_batch_number';
  // tab is optional, defaults to 1
  if (typeof data.variant !== 'undefined' && (typeof data.variant !== 'number' || data.variant < 1)) return 'Invalid variant';
  return null;
}

function isRetryableError(error: any): boolean {
  const errorMsg = error.message || error.toString() || '';
  return errorMsg.includes('520') || 
         errorMsg.includes('500') || 
         errorMsg.includes('502') ||
         errorMsg.includes('503') ||
         errorMsg.includes('504') ||
         errorMsg.includes('connection') ||
         errorMsg.includes('timeout') ||
         errorMsg.includes('Failed to queue batch');
}

async function queueNextBatch(groupId: string, userId: string, currentBatchNumber: number, tab: number = 1, variant: number = 1): Promise<{ message: string; batch_number: number }> {
  try {
    console.log(`Fetching tasks for group ${groupId}, user ${userId}, current_batch_number ${currentBatchNumber}, tab ${tab}, variant ${variant}`);
    let tasks = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      console.log(`Query attempt ${attempt + 1}: SELECT id, batch_number, status, total_batches FROM image_prompt_tasks WHERE group_id = ${groupId} AND user_id = ${userId} AND tab = ${tab} ORDER BY batch_number ASC`);
      const { data, error: tasksError } = await supabase
        .from('image_prompt_tasks')
        .select('id, batch_number, status, total_batches')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('tab', tab)
        .eq('variant', variant)
        .order('batch_number', { ascending: true });
      if (tasksError) {
        const errorMsg = `Failed to fetch tasks (attempt ${attempt + 1}): ${tasksError.message}`;
        console.error(errorMsg);
        await logError('Failed to fetch tasks', tasksError);
        if (attempt < 2) {
          console.log('Retrying query in 2s...');
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        throw new Error(errorMsg);
      }
      tasks = data;
      console.log(`Fetched ${tasks.length} tasks: ${JSON.stringify(tasks, null, 2)}`);
      if (tasks.length > 0) break;
      console.log('No tasks found, retrying in 2s...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    if (tasks.length === 0) {
      const errorMsg = `No tasks found for group ${groupId}, user ${userId}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    const totalBatches = tasks[0].total_batches || 0;
    console.log(`Total batches: ${totalBatches}`);

    const completedTasks = tasks.filter(task => task.status === 'completed' || task.status === 'completed_final');
    console.log(`Completed tasks: ${completedTasks.length}`);
    if (completedTasks.length >= totalBatches && totalBatches > 0) {
      console.log('All batches completed.');
      return { message: 'All batches completed', batch_number: currentBatchNumber };
    }

    const nextTask = tasks.find(task => task.status === 'queued' && task.batch_number >= currentBatchNumber) ||
                     tasks.find(task => (task.status === 'pending' || task.status === 'error') && task.batch_number >= currentBatchNumber);

    if (!nextTask) {
      const errorMsg = `No queued, pending, or error task found for batch >= ${currentBatchNumber}`;
      console.error(errorMsg);
      if (currentBatchNumber >= totalBatches) {
        console.log('No more batches to process. Final compilation should be triggered.');
        return { message: 'All batches completed', batch_number: currentBatchNumber };
      }
      throw new Error(errorMsg);
    }

    console.log(`Selected task: batch ${nextTask.batch_number}, status ${nextTask.status}, id ${nextTask.id}`);

    if (nextTask.status !== 'queued') {
      console.log(`Updating batch ${nextTask.batch_number} to queued`);
      const { error: updateError } = await supabase
        .from('image_prompt_tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString(), error: null })
        .eq('id', nextTask.id);
      if (updateError) {
        const errorMsg = `Failed to queue batch ${nextTask.batch_number}: ${updateError.message}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
    }

    console.log(`Initiating process-image-batch asynchronously for batch ${nextTask.batch_number}`);
    fetch(`${supabaseUrl}/functions/v1/process-image-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        group_id: groupId,
        user_id: userId,
        batch_number: nextTask.batch_number,
        total_batches: nextTask.total_batches,
        tab: tab,
        variant: variant
      }),
    }).catch(error => {
      console.error(`Error initiating process-image-batch for batch ${nextTask.batch_number}: ${error.message}`);
      logError(`Error initiating process-image-batch for batch ${nextTask.batch_number}`, error);
      
      // Check if it's a retryable error and set to 'running' instead of 'pending'
      const status = isRetryableError(error) ? 'running' : 'pending';
      
      supabase
        .from('image_prompt_tasks')
        .update({ status, error: `Failed to trigger process-image-batch: ${error.message}`, updated_at: new Date().toISOString() })
        .eq('id', nextTask.id);
    });

    return { message: `Started batch ${nextTask.batch_number} processing`, batch_number: nextTask.batch_number };
  } catch (error: any) {
    console.error(`Failed to queue batch: ${error.message}\nStack: ${error.stack}`);
    await logError(`Failed to queue batch`, error);
    throw error;
  }
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 300000; // 300 seconds

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    const payload = await req.json();
    console.log(`Received payload: ${JSON.stringify(payload)}`);
    const validationError = validateInputs(payload);
    if (validationError) {
      console.error(`Validation error: ${validationError}`);
      return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });
    }

    const { group_id, user_id, current_batch_number, tab = 1, variant = 1 } = payload;
    const result = await queueNextBatch(group_id, user_id, current_batch_number, tab, variant);
    console.log(`Batch ${result.batch_number} queued: ${JSON.stringify(result)}`);

    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) {
      console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);
    }

    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });
  } catch (error: any) {
    console.error(`Error in trigger-image-next-batch: ${error.message}\nStack: ${error.stack}`);
    await logError('Error in trigger-image-next-batch', error);
    return new Response(JSON.stringify({ error: `HTTP 500: ${error.message || 'Internal Server Error'}`, code: 500 }), { status: 500, headers: responseHeaders });
  }
});



