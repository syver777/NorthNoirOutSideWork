// trigger-next-audio/index.ts
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

function validateInputs(data: any): string | null {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!data.group_id || !uuidRegex.test(data.group_id)) return 'Missing or invalid group_id';
  if (!data.user_id || !uuidRegex.test(data.user_id)) return 'Missing or invalid user_id';
  if (typeof data.current_batch_number !== 'number' || data.current_batch_number < 0) return 'Missing or invalid current_batch_number';
  // tab is optional, defaults to 1
  if (typeof data.variant !== 'undefined' && (typeof data.variant !== 'number' || data.variant < 1)) return 'Invalid variant';
  return null;
}

async function resetStuckTasks(groupId: string, userId: string, tab: number = 1, variant: number = 1): Promise<void> {
  try {
    const { data: stuckTasks, error: stuckError } = await supabase
      .from('audio_tasks')
      .select('id, updated_at, batch_number, status')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .eq('status', 'running');

    if (stuckError) throw new Error(`Failed to check stuck tasks: ${stuckError.message}`);
  } catch (error: any) {
    await logError('Failed to reset stuck tasks', error);
    throw error;
  }
}

async function queueNextBatch(groupId: string, userId: string, currentBatchNumber: number, tab: number = 1, variant: number = 1): Promise<{ message: string; batch_number: number }> {
  try {
    // First, reset any stuck running tasks
    await resetStuckTasks(groupId, userId, tab, variant);

    // Get all tasks for this group
    const { data: tasks, error: tasksError } = await supabase
      .from('audio_tasks')
      .select('id, batch_number, status, total_batches')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .order('batch_number', { ascending: true });

    if (tasksError) throw new Error(`Failed to fetch tasks: ${tasksError.message}`);
    if (tasks.length === 0) throw new Error(`No tasks found for group ${groupId}, user ${userId}`);

    const totalBatches = tasks[0].total_batches || 0;
    
    // Check if we have any currently running tasks
    const runningTasks = tasks.filter(task => task.status === 'running');
    if (runningTasks.length > 0) {
      console.log(`Found ${runningTasks.length} running tasks, waiting for completion before queuing next batch`);
      return { 
        message: `Waiting for ${runningTasks.length} running tasks to complete`, 
        batch_number: currentBatchNumber 
      };
    }

    // Count completed tasks
    const completedTasks = tasks.filter(task => task.status === 'completed' || task.status === 'completed_final').length;

    // Check if all batches are completed
    if (completedTasks >= totalBatches && totalBatches > 0) {
      return { message: 'All batches completed', batch_number: currentBatchNumber };
    }

    // Find the next task to queue (prioritize queued tasks that might have been reset, then pending/error tasks)
    const nextTask = tasks.find(task => 
      task.status === 'queued' && task.batch_number > currentBatchNumber
    ) || tasks.find(task => 
      (task.status === 'pending' || task.status === 'error') && task.batch_number > currentBatchNumber
    );

    if (!nextTask) {
      if (currentBatchNumber >= totalBatches) {
        return { message: 'All batches completed', batch_number: currentBatchNumber };
      }
      throw new Error(`No available task found for batch > ${currentBatchNumber}`);
    }

    // Ensure the task is set to queued
    if (nextTask.status !== 'queued') {
      const { error: updateError } = await supabase
        .from('audio_tasks')
        .update({ 
          status: 'queued', 
          updated_at: new Date().toISOString(), 
          error: null 
        })
        .eq('id', nextTask.id);

      if (updateError) throw new Error(`Failed to queue batch ${nextTask.batch_number}: ${updateError.message}`);
      console.log(`Set batch ${nextTask.batch_number} to queued`);
    }

    // Trigger process-audio with error handling
    console.log(`Triggering process-audio for batch ${nextTask.batch_number}`);
    
    fetch(`${supabaseUrl}/functions/v1/process-audio`, {
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
    }).catch(async (error) => {
      console.error(`Error initiating process-audio for batch ${nextTask.batch_number}:`, error);
      await logError(`Error triggering process-audio for batch ${nextTask.batch_number}`, error);
      
      // Reset the task back to pending if trigger failed
      await supabase
        .from('audio_tasks')
        .update({ 
          status: 'pending', 
          error: `Failed to trigger process-audio: ${error.message}`, 
          updated_at: new Date().toISOString() 
        })
        .eq('id', nextTask.id);
    });

    return { 
      message: `Started batch ${nextTask.batch_number} processing`, 
      batch_number: nextTask.batch_number 
    };

  } catch (error: any) {
    await logError('Failed to queue batch', error);
    throw error;
  }
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 300000;

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    const payload = await req.json();
    const validationError = validateInputs(payload);
    if (validationError) return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });

    const { group_id, user_id, current_batch_number, tab = 1, variant = 1 } = payload;
    
    console.log(`Processing trigger-next-audio for group ${group_id}, current batch: ${current_batch_number}, tab: ${tab}, variant: ${variant}`);
    
    const result = await queueNextBatch(group_id, user_id, current_batch_number, tab, variant);

    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);

    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });

  } catch (error: any) {
    await logError('Error in trigger-next-audio', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal Server Error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});



