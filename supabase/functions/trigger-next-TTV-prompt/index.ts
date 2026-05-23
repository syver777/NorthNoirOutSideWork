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

function isRetryableError(error: any): boolean {
  const msg = error.message || error.toString() || '';
  return ['520', '500', '502', '503', '504', 'connection', 'timeout', 'Failed to queue batch']
    .some(s => msg.includes(s));
}

async function queueNextBatch(
  groupId: string,
  userId: string,
  currentBatchNumber: number,
  tab: number = 1,
  variant: number = 1,
): Promise<{ message: string; batch_number: number }> {
  let tasks: any[] = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await supabase
      .from('TTV_prompt_tasks')
      .select('id, batch_number, status, total_batches')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .order('batch_number', { ascending: true });

    if (error) {
      console.error(`Fetch attempt ${attempt + 1} failed: ${error.message}`);
      if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
      throw new Error(`Failed to fetch TTV tasks: ${error.message}`);
    }

    tasks = data ?? [];
    console.log(`Fetched ${tasks.length} TTV tasks for group ${groupId}, tab ${tab}, variant ${variant}`);
    if (tasks.length > 0) break;
    console.log('No tasks found yet, retrying in 2s…');
    await new Promise(r => setTimeout(r, 2000));
  }

  if (tasks.length === 0) throw new Error(`No TTV tasks found for group ${groupId}`);

  const totalBatches = tasks[0].total_batches ?? 0;
  const completedTasks = tasks.filter(t => t.status === 'completed' || t.status === 'completed_final');

  if (completedTasks.length >= totalBatches && totalBatches > 0) {
    console.log('All TTV batches completed.');
    return { message: 'All batches completed', batch_number: currentBatchNumber };
  }

  const nextTask =
    tasks.find(t => t.status === 'queued' && t.batch_number >= currentBatchNumber) ??
    tasks.find(t => (t.status === 'pending' || t.status === 'error') && t.batch_number >= currentBatchNumber);

  if (!nextTask) {
    if (currentBatchNumber >= totalBatches) {
      console.log('No more batches to process. Final compilation should be triggered.');
      return { message: 'All batches completed', batch_number: currentBatchNumber };
    }
    throw new Error(`No queued/pending/error TTV task found for batch >= ${currentBatchNumber}`);
  }

  console.log(`Selected TTV task: batch ${nextTask.batch_number}, status ${nextTask.status}, id ${nextTask.id}`);

  if (nextTask.status !== 'queued') {
    const { error: updateError } = await supabase
      .from('TTV_prompt_tasks')
      .update({ status: 'queued', updated_at: new Date().toISOString(), error: null })
      .eq('id', nextTask.id);
    if (updateError) throw new Error(`Failed to re-queue TTV batch ${nextTask.batch_number}: ${updateError.message}`);
  }

  console.log(`Fire-and-forget: triggering process-TTV-prompt for batch ${nextTask.batch_number}`);
  fetch(`${supabaseUrl}/functions/v1/process-TTV-prompt`, {
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
      variant,
    }),
  }).catch(err => {
    console.error(`Error firing process-TTV-prompt for batch ${nextTask.batch_number}: ${err.message}`);
    logError(`Error firing process-TTV-prompt for batch ${nextTask.batch_number}`, err);
    const status = isRetryableError(err) ? 'running' : 'pending';
    supabase
      .from('TTV_prompt_tasks')
      .update({ status, error: `Failed to trigger process-TTV-prompt: ${err.message}`, updated_at: new Date().toISOString() })
      .eq('id', nextTask.id);
  });

  return { message: `Started TTV batch ${nextTask.batch_number} processing`, batch_number: nextTask.batch_number };
}

// ─── serve ────────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    const payload = await req.json();
    console.log(`trigger-next-TTV-prompt received: ${JSON.stringify(payload)}`);

    const validationError = validateInputs(payload);
    if (validationError) return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });

    const { group_id, user_id, current_batch_number, tab = 1, variant = 1 } = payload;
    const result = await queueNextBatch(group_id, user_id, current_batch_number, tab, variant);
    console.log(`TTV batch ${result.batch_number} queued: ${result.message}`);

    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });
  } catch (error: any) {
    console.error(`Error in trigger-next-TTV-prompt: ${error.message}`);
    await logError('Error in trigger-next-TTV-prompt', error);
    return new Response(JSON.stringify({ error: `HTTP 500: ${error.message || 'Internal Server Error'}`, code: 500 }), { status: 500, headers: responseHeaders });
  }
});
