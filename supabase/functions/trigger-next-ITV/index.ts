// trigger-next-ITV/index.ts
// Queues the next pending ITV_task and fires process-ITV.
// Mirrors trigger-next-TTV exactly but for ITV_tasks.
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
  if (typeof data.current_batch_number !== 'number' || data.current_batch_number < 0)
    return 'Missing or invalid current_batch_number';
  if (typeof data.variant !== 'undefined' && (typeof data.variant !== 'number' || data.variant < 1))
    return 'Invalid variant';
  return null;
}

async function queueNextBatch(
  groupId: string,
  userId: string,
  currentBatchNumber: number,
  tab: number = 1,
  variant: number = 1,
): Promise<{ message: string; batch_number: number }> {
  try {
    const { data: tasks, error: tasksError } = await supabase
      .from('ITV_tasks')
      .select('id, batch_number, status, total_batches')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .order('batch_number', { ascending: true });

    if (tasksError) throw new Error(`Failed to fetch ITV tasks: ${tasksError.message}`);
    if (!tasks || tasks.length === 0) {
      throw new Error(`No ITV tasks found for group ${groupId}, user ${userId}, tab ${tab}, variant ${variant}`);
    }

    const totalBatches = tasks[0].total_batches || 0;
    const completedTasks = tasks.filter(t =>
      t.status === 'completed' || t.status === 'completed_final',
    ).length;

    // ── Re-try previous batch if it is not done ─────────────────────────────
    if (currentBatchNumber > 1) {
      const previousBatch = tasks.find(t => t.batch_number === currentBatchNumber - 1);
      if (
        previousBatch &&
        previousBatch.status !== 'completed' &&
        previousBatch.status !== 'completed_final' &&
        previousBatch.status !== 'running'  // 'running' = actively polling, do NOT reset
      ) {
        console.log(`Previous ITV batch ${currentBatchNumber - 1} not completed (status: ${previousBatch.status}), retrying`);
        await supabase
          .from('ITV_tasks')
          .update({ status: 'queued', updated_at: new Date().toISOString(), error: null })
          .eq('id', previousBatch.id);

        fetch(`${supabaseUrl}/functions/v1/process-ITV`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
          body: JSON.stringify({
            group_id: groupId,
            user_id: userId,
            batch_number: previousBatch.batch_number,
            total_batches: previousBatch.total_batches,
            tab,
            variant,
          }),
        }).catch(err => logError(`Error retrying ITV batch ${previousBatch.batch_number}`, err));

        return { message: `Retrying previous ITV batch ${previousBatch.batch_number}`, batch_number: previousBatch.batch_number };
      }
    }

    // ── All batches completed ────────────────────────────────────────────────
    // compileFinalITVDocument is called from completeTask (process-ITV) when the last
    // batch finishes. We must NOT fire process-ITV here again (would create an infinite loop).
    if (completedTasks >= totalBatches && totalBatches > 0) {
      console.log(`All ${totalBatches} ITV batches completed for group ${groupId}, tab ${tab} — compilation was handled by completeTask`);
      return { message: 'All ITV batches completed', batch_number: currentBatchNumber };
    }

    // ── Find next actionable task ────────────────────────────────────────────
    const nextTask =
      tasks.find(t => t.status === 'queued' && t.batch_number >= currentBatchNumber) ||
      tasks.find(t => (t.status === 'pending' || t.status === 'error') && t.batch_number >= currentBatchNumber);

    if (!nextTask) {
      if (currentBatchNumber + 1 > totalBatches)
        return { message: 'All ITV batches completed', batch_number: currentBatchNumber };
      if (completedTasks >= totalBatches)
        return { message: 'All ITV batches completed', batch_number: currentBatchNumber };
      throw new Error(`No queued, pending, or error ITV task found for batch >= ${currentBatchNumber}`);
    }

    // Ensure task is in queued state before firing
    if (nextTask.status !== 'queued') {
      const { error: updateError } = await supabase
        .from('ITV_tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString(), error: null })
        .eq('id', nextTask.id);
      if (updateError) throw new Error(`Failed to queue ITV batch ${nextTask.batch_number}: ${updateError.message}`);
    }

    // Fire-and-forget: invoke process-ITV for the next batch
    fetch(`${supabaseUrl}/functions/v1/process-ITV`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
      body: JSON.stringify({
        group_id: groupId,
        user_id: userId,
        batch_number: nextTask.batch_number,
        total_batches: nextTask.total_batches,
        tab,
        variant,
      }),
    }).catch(err => {
      logError(`Error initiating process-ITV for batch ${nextTask.batch_number}`, err);
      supabase
        .from('ITV_tasks')
        .update({ status: 'running', error: `Failed to trigger process-ITV: ${err.message}`, updated_at: new Date().toISOString() })
        .eq('id', nextTask.id);
    });

    return { message: `Started ITV batch ${nextTask.batch_number} processing`, batch_number: nextTask.batch_number };
  } catch (error: any) {
    await logError('Failed to queue ITV batch', error);
    throw error;
  }
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method !== 'POST')
      return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    const payload = await req.json();
    const validationError = validateInputs(payload);
    if (validationError)
      return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });

    const { group_id, user_id, current_batch_number, tab, variant } = payload;
    const result = await queueNextBatch(group_id, user_id, current_batch_number, tab ?? 1, variant ?? 1);

    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });
  } catch (error: any) {
    await logError('Error in trigger-next-ITV', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal Server Error', code: 500 }),
      { status: 500, headers: responseHeaders },
    );
  }
});
