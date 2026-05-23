import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { supabase, logError, verifyAuth } from '../_shared/utils.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SECRET_KEY') ?? '';
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

function validateInputs(data: any): string | null {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!data.group_id || !uuidRegex.test(data.group_id)) return 'Missing or invalid group_id';
  if (!data.user_id || !uuidRegex.test(data.user_id)) return 'Missing or invalid user_id';
  if (typeof data.current_batch_number !== 'number' || data.current_batch_number < 0) return 'Missing or invalid current_batch_number';
  if (typeof data.tab !== 'undefined' && (typeof data.tab !== 'number' || data.tab < 1 || data.tab > 10)) return 'Invalid tab parameter';
  if (typeof data.variant !== 'undefined' && (typeof data.variant !== 'number' || data.variant < 1)) return 'Invalid variant parameter';
  return null;
}

async function queueNextCorrectedBatch(groupId: string, userId: string, currentBatchNumber: number, tab: number = 1, variant: number = 1): Promise<{ message: string; batch_number: number }> {
  try {
    console.log(`Fetching corrected tasks for group ${groupId}, user ${userId}, tab ${tab}, variant ${variant}`);
    
    const { data: tasks, error: tasksError } = await supabase
      .from('story_tasks')
      .select('id, batch_number, status, total_batches, updated_at')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('is_corrected', true)
      .eq('version', 2)
      .eq('variant', variant)
      .eq('tab', tab)
      .order('batch_number', { ascending: true });
    if (tasksError) {
      const errorMsg = `Failed to fetch corrected tasks: ${tasksError.message}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
    console.log(`Current corrected story_tasks state: ${JSON.stringify(tasks, null, 2)}`);

    const totalBatches = tasks.find(task => task.total_batches)?.total_batches || 0;
    const completedTasks = tasks.filter(task => task.status === 'completed' || task.status === 'completed_final');
    
    // Check if the current batch is the last one
    if (currentBatchNumber >= totalBatches && totalBatches > 0) {
      console.log('All corrected batches processed or current batch is last. Triggering final compilation.');
      const { data: task } = await supabase
        .from('story_tasks')
        .select('story_title, description')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('batch_number', 0)
        .eq('is_corrected', true)
        .eq('version', 2)
        .eq('variant', variant)
        .eq('tab', tab)
        .single();
      if (task) {
        await fetch(`${SUPABASE_URL}/functions/v1/process-corrected-story`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SERVICE_ROLE_KEY,
          },
          body: JSON.stringify({
            group_id: groupId,
            user_id: userId,
            batch_number: currentBatchNumber,
            total_batches: totalBatches,
            tab: tab,
            variant: variant,
          }),
        }).catch(error => {
          console.error(`Error triggering final corrected compilation for group ${groupId}: ${error.message}`);
          logError(`Error triggering final corrected compilation`, error);
        });
      }
      return { message: 'All corrected batches completed, final compilation triggered', batch_number: currentBatchNumber };
    }

    // UPDATED: Find the earliest incomplete batch instead of just next batch
    const incompleteBatch = tasks.find(task => 
      task.batch_number > 0 && 
      (task.status === 'pending' || task.status === 'error' || task.status === 'queued')
    );

    if (!incompleteBatch) {
      // Check if there's a running batch ahead of current
      const runningBatch = tasks.find(task => 
        task.batch_number > currentBatchNumber && 
        task.status === 'running'
      );
      
      if (runningBatch) {
        console.log(`Corrected batch ${runningBatch.batch_number} is already running ahead of current batch ${currentBatchNumber}`);
        return { message: `Corrected batch ${runningBatch.batch_number} already running`, batch_number: runningBatch.batch_number };
      }
      
      const errorMsg = `No incomplete corrected tasks found after batch ${currentBatchNumber}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    console.log(`Found incomplete corrected batch ${incompleteBatch.batch_number} with status ${incompleteBatch.status} for group ${groupId}`);
    
    // UPDATED: Check for sequence issues - if we're trying to queue a batch that's not the immediate next one
    if (incompleteBatch.batch_number > currentBatchNumber + 1) {
      console.warn(`Sequence gap detected: current batch ${currentBatchNumber}, next incomplete corrected batch ${incompleteBatch.batch_number}`);
      
      // Check if there are running batches in between
      const runningInBetween = tasks.find(task => 
        task.batch_number > currentBatchNumber && 
        task.batch_number < incompleteBatch.batch_number && 
        task.status === 'running'
      );
      
      if (runningInBetween) {
        console.log(`Corrected batch ${runningInBetween.batch_number} is running between current and next incomplete batch`);
        return { message: `Corrected batch ${runningInBetween.batch_number} already running`, batch_number: runningInBetween.batch_number };
      }
    }
    
    // Only update status if it's not already queued
    if (incompleteBatch.status !== 'queued') {
      console.log(`Queueing corrected batch ${incompleteBatch.batch_number} for group ${groupId}`);
      const { error: updateError } = await supabase
        .from('story_tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString() })
        .eq('id', incompleteBatch.id);
      if (updateError) {
        const errorMsg = `Failed to queue corrected batch ${incompleteBatch.batch_number}: ${updateError.message}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
    } else {
      console.log(`Corrected batch ${incompleteBatch.batch_number} is already queued for group ${groupId}`);
    }

    console.log(`Initiating process-corrected-story for batch ${incompleteBatch.batch_number}`);
    fetch(`${SUPABASE_URL}/functions/v1/process-corrected-story`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({
        group_id: groupId,
        user_id: userId,
        batch_number: incompleteBatch.batch_number,
        total_batches: incompleteBatch.total_batches,
        tab: tab,
        variant: variant,
      }),
    }).catch(error => {
      console.error(`Error initiating process-corrected-story for batch ${incompleteBatch.batch_number}: ${error.message}`);
      logError(`Error initiating process-corrected-story for batch ${incompleteBatch.batch_number}`, error);
    });

    return { message: `Started corrected batch ${incompleteBatch.batch_number} processing`, batch_number: incompleteBatch.batch_number };
  } catch (error: any) {
    console.error(`Failed to queue corrected batch: ${error.message}\nStack: ${error.stack}`);
    await logError(`Failed to queue corrected batch`, error);
    throw error;
  }
}

serve(async (req: Request) => {
  const responseHeaders = { ...getCorsHeaders(req), 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 300000;

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    // Auth check
    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });
    }

    const payload = await req.json();
    if (!auth.isServiceRole && auth.userId) { payload.user_id = auth.userId; }
    console.log(`Received payload: ${JSON.stringify(payload)}`);
    const validationError = validateInputs(payload);
    if (validationError) {
      console.error(`Validation error: ${validationError}`);
      return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });
    }

    const { group_id, user_id, current_batch_number, tab = 1, variant = 1 } = payload;
    const result = await queueNextCorrectedBatch(group_id, user_id, current_batch_number, tab, variant);
    console.log(`Corrected batch ${result.batch_number} queued: ${JSON.stringify(result)}`);

    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) {
      console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);
    }

    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });
  } catch (error: any) {
    console.error(`Error in trigger-next-corrected-batch: ${error.message}\nStack: ${error.stack}`);
    await logError('Error in trigger-next-corrected-batch', error);
    return new Response(JSON.stringify({ error: `HTTP 500: ${error.message || 'Internal Server Error'}`, code: 500 }), { status: 500, headers: responseHeaders });
  }
});



