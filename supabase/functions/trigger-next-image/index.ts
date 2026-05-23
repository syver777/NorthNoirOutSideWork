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

async function queueNextBatch(groupId: string, userId: string, currentBatchNumber: number, tab: number = 1, variant: number = 1): Promise<{ message: string; batch_number: number }> {
  try {
    const { data: tasks, error: tasksError } = await supabase
      .from('image_tasks')
      .select('id, batch_number, status, total_batches')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .order('batch_number', { ascending: true });

    if (tasksError) throw new Error(`Failed to fetch tasks: ${tasksError.message}`);
    if (tasks.length === 0) throw new Error(`No tasks found for group ${groupId}, user ${userId}`);

    const totalBatches = tasks[0].total_batches || 0;
    const completedTasks = tasks.filter(task => task.status === 'completed' || task.status === 'completed_final').length;

    // Check if previous batch is completed (except for batch 1)
    if (currentBatchNumber > 1) {
      const previousBatch = tasks.find(task => task.batch_number === currentBatchNumber - 1);
      if (previousBatch && previousBatch.status !== 'completed' && previousBatch.status !== 'completed_final') {
        console.log(`Previous batch ${currentBatchNumber - 1} is not completed (status: ${previousBatch.status}), retrying it first`);
        
        // Reset the previous batch to queued status
        const { error: updateError } = await supabase
          .from('image_tasks')
          .update({ status: 'queued', updated_at: new Date().toISOString(), error: null })
          .eq('id', previousBatch.id);

        if (updateError) throw new Error(`Failed to queue previous batch ${previousBatch.batch_number}: ${updateError.message}`);

        // Trigger the previous batch instead
        fetch(`${supabaseUrl}/functions/v1/process-image`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseServiceRoleKey,
          },
          body: JSON.stringify({
            group_id: groupId,
            user_id: userId,
            batch_number: previousBatch.batch_number,
            total_batches: previousBatch.total_batches,
            tab: tab,
          }),
        }).catch(error => {
          logError(`Error initiating process-image for previous batch ${previousBatch.batch_number}`, error);
          supabase
            .from('image_tasks')
            .update({ status: 'running', error: `Failed to trigger process-image: ${error.message}`, updated_at: new Date().toISOString() })
            .eq('id', previousBatch.id);
        });

        return { message: `Retrying previous batch ${previousBatch.batch_number} first`, batch_number: previousBatch.batch_number };
      }
    }

    // Check if all batches are actually completed
    if (completedTasks >= totalBatches && totalBatches > 0) {
      console.log(`All ${totalBatches} batches completed for group ${groupId}, tab ${tab}, triggering final compilation`);
      
      // Get a sample task to extract needed info
      const sampleTask = tasks.find(t => t.status === 'completed' || t.status === 'completed_final');
      if (sampleTask) {
        // Trigger process-image with the last batch to run final compilation
        fetch(`${supabaseUrl}/functions/v1/process-image`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseServiceRoleKey,
          },
          body: JSON.stringify({
            group_id: groupId,
            user_id: userId,
            batch_number: totalBatches, // Use the last batch number
            total_batches: totalBatches,
            tab: tab,
          }),
        }).catch(error => {
          console.error(`Error triggering final compilation:`, error);
          logError(`Error triggering final compilation for group ${groupId}, tab ${tab}`, error);
        });
        
        return { message: 'All batches completed, triggering final compilation', batch_number: totalBatches };
      }
      
      return { message: 'All batches completed', batch_number: currentBatchNumber };
    }

    const nextTask = tasks.find(task => task.status === 'queued' && task.batch_number >= currentBatchNumber) ||
                     tasks.find(task => (task.status === 'pending' || task.status === 'error') && task.batch_number >= currentBatchNumber);

    if (!nextTask) {
      // Double-check if all work is actually done before throwing error
      const nextBatchNumber = currentBatchNumber + 1;
      
      // Check if the next batch number would exceed total batches
      if (nextBatchNumber > totalBatches) {
        console.log(`Next batch ${nextBatchNumber} exceeds total batches ${totalBatches}, all work completed`);
        return { message: 'All batches completed', batch_number: currentBatchNumber };
      }
      
      // Check if we have enough completed tasks
      if (completedTasks >= totalBatches) {
        console.log(`Found ${completedTasks} completed tasks out of ${totalBatches} total, all work completed`);
        return { message: 'All batches completed', batch_number: currentBatchNumber };
      }
      
      // If we get here, there's genuinely a missing task
      throw new Error(`No queued, pending, or error task found for batch >= ${currentBatchNumber}`);
    }

    if (nextTask.status !== 'queued') {
      const { error: updateError } = await supabase
        .from('image_tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString(), error: null })
        .eq('id', nextTask.id);

      if (updateError) throw new Error(`Failed to queue batch ${nextTask.batch_number}: ${updateError.message}`);
    }

    fetch(`${supabaseUrl}/functions/v1/process-image`, {
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
        variant: variant,
      }),
    }).catch(error => {
      logError(`Error initiating process-image for batch ${nextTask.batch_number}`, error);
      supabase
        .from('image_tasks')
        .update({ status: 'running', error: `Failed to trigger process-image: ${error.message}`, updated_at: new Date().toISOString() })
        .eq('id', nextTask.id);
    });

    return { message: `Started batch ${nextTask.batch_number} processing`, batch_number: nextTask.batch_number };

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

    const { group_id, user_id, current_batch_number, tab, variant } = payload;
    const tabNumber = tab || 1;
    const variantNumber = variant || 1;

    const result = await queueNextBatch(group_id, user_id, current_batch_number, tabNumber, variantNumber);

    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);

    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });

  } catch (error: any) {
    await logError('Error in trigger-next-image', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal Server Error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});



