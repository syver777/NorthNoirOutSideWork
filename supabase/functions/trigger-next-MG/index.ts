// trigger-next-MG/index.ts
// Mirrors trigger-next-TTV: queues the next pending MG_tasks row and fires
// process-MG (which delegates to the Deno Deploy Remotion Lambda invoker).
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
    await supabase.from('error_logs').insert({
      message,
      details: error.message || JSON.stringify(error),
      created_at: new Date().toISOString(),
    });
  } catch (_) { /* silent */ }
}

function validateInputs(data: any): string | null {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!data.group_id || !uuidRegex.test(data.group_id)) return 'Missing or invalid group_id';
  if (!data.user_id || !uuidRegex.test(data.user_id)) return 'Missing or invalid user_id';
  if (typeof data.current_batch_number !== 'number' || data.current_batch_number < 0) return 'Missing or invalid current_batch_number';
  if (typeof data.variant !== 'undefined' && (typeof data.variant !== 'number' || data.variant < 1)) return 'Invalid variant';
  return null;
}

async function queueNextBatch(
  groupId: string,
  userId: string,
  currentBatchNumber: number,
  tab: number = 1,
  variant: number = 1,
): Promise<{ message: string; batch_number: number }> {
  const { data: tasks, error: tasksError } = await supabase
    .from('MG_tasks')
    .select('id, batch_number, status, total_batches')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('tab', tab)
    .order('batch_number', { ascending: true });

  if (tasksError) throw new Error(`Failed to fetch MG_tasks: ${tasksError.message}`);
  if (!tasks || tasks.length === 0) {
    throw new Error(`No MG_tasks found for group ${groupId}, user ${userId}, tab ${tab}`);
  }

  const totalBatches = tasks[0].total_batches || 0;
  const completedTasks = tasks.filter(t =>
    t.status === 'completed' || t.status === 'completed_final',
  ).length;

  // Re-try previous batch if not done (mirrors trigger-next-TTV)
  if (currentBatchNumber > 1) {
    const previousBatch = tasks.find(t => t.batch_number === currentBatchNumber - 1);
    if (
      previousBatch &&
      previousBatch.status !== 'completed' &&
      previousBatch.status !== 'completed_final' &&
      previousBatch.status !== 'rendering' &&
      previousBatch.status !== 'running'
    ) {
      await supabase
        .from('MG_tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString(), error: null })
        .eq('id', previousBatch.id);

      fetch(`${supabaseUrl}/functions/v1/process-MG`, {
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
          tab,
        }),
      }).catch(err => logError(`Error retrying MG batch ${previousBatch.batch_number}`, err));

      return {
        message: `Retrying previous MG batch ${previousBatch.batch_number}`,
        batch_number: previousBatch.batch_number,
      };
    }
  }

  if (completedTasks >= totalBatches && totalBatches > 0) {
    console.log(`All ${totalBatches} MG batches completed for group ${groupId}, tab ${tab}`);
    return { message: 'All MG batches completed', batch_number: currentBatchNumber };
  }

  const nextTask =
    tasks.find(t => t.status === 'queued' && t.batch_number >= currentBatchNumber) ||
    tasks.find(
      t => (t.status === 'pending' || t.status === 'error') && t.batch_number >= currentBatchNumber,
    );

  if (!nextTask) {
    if (currentBatchNumber + 1 > totalBatches)
      return { message: 'All MG batches completed', batch_number: currentBatchNumber };
    if (completedTasks >= totalBatches)
      return { message: 'All MG batches completed', batch_number: currentBatchNumber };
    throw new Error(`No queued, pending, or error MG task found for batch >= ${currentBatchNumber}`);
  }

  if (nextTask.status !== 'queued') {
    const { error: updateError } = await supabase
      .from('MG_tasks')
      .update({ status: 'queued', updated_at: new Date().toISOString(), error: null })
      .eq('id', nextTask.id);

    if (updateError) {
      throw new Error(`Failed to queue MG batch ${nextTask.batch_number}: ${updateError.message}`);
    }
  }

  fetch(`${supabaseUrl}/functions/v1/process-MG`, {
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
      tab,
    }),
  }).catch(err => {
    logError(`Error initiating process-MG for batch ${nextTask.batch_number}`, err);
    supabase
      .from('MG_tasks')
      .update({
        status: 'running',
        error: `Failed to trigger process-MG: ${err.message}`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', nextTask.id);
  });

  return {
    message: `Started MG batch ${nextTask.batch_number} processing`,
    batch_number: nextTask.batch_number,
  };
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });
    }

    if (req.method !== 'POST')
      return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    const payload = await req.json();
    const validationError = validateInputs(payload);
    if (validationError) return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });

    const { group_id, user_id, current_batch_number, tab, variant } = payload;
    const tabNumber = tab ?? 1;
    const variantNumber = variant ?? 1;

    const result = await queueNextBatch(group_id, user_id, current_batch_number, tabNumber, variantNumber);
    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });
  } catch (error: any) {
    await logError('Error in trigger-next-MG', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal Server Error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});
