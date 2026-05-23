// stop-MG-processing/index.ts
// Sets stop_requested=true on all MG_prompt_tasks and MG_tasks rows for the
// given group/variant/tab so in-flight Deno Deploy workers terminate gracefully.
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

interface StopMGRequest {
  group_id: string;
  user_id: string;
  tab?: number;
  variant?: number;
  /** Optional parent video_tasks row id (set when launched from the unified VideoGenerator). */
  video_task_id?: string | null;
}

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

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });
    }

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });
    }

    const requestData: StopMGRequest = await req.json();
    const { group_id, user_id } = requestData;
    const tab = requestData.tab ?? 1;
    const variant = requestData.variant ?? 1;

    if (!group_id || !user_id) {
      return new Response(JSON.stringify({ error: 'Missing required parameters' }), { status: 400, headers: responseHeaders });
    }

    const now = new Date().toISOString();

    // Mark MG_prompt_tasks
    const { error: promptErr } = await supabase
      .from('MG_prompt_tasks')
      .update({ stop_requested: true, updated_at: now })
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('tab', tab)
      .eq('variant', variant)
      .in('status', ['pending', 'queued', 'running', 'processing']);

    if (promptErr) console.error(`Failed to stop MG_prompt_tasks: ${promptErr.message}`);

    // Mark MG_tasks
    const { error: taskErr } = await supabase
      .from('MG_tasks')
      .update({ stop_requested: true, updated_at: now })
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('tab', tab)
      .in('status', ['pending', 'queued', 'running', 'processing', 'rendering']);

    if (taskErr) console.error(`Failed to stop MG_tasks: ${taskErr.message}`);

    // Integrated mode: clear MG status on the parent video_tasks row.
    if (requestData.video_task_id) {
      const { error: vtErr } = await supabase
        .from('video_tasks')
        .update({
          mg_status: 'stopped',
          updated_at: now,
        })
        .eq('id', requestData.video_task_id);
      if (vtErr) console.error(`Failed to update video_tasks.mg_status: ${vtErr.message}`);
    }

    return new Response(JSON.stringify({
      status: 'success',
      message: 'MG stop request issued',
    }), { status: 200, headers: responseHeaders });

  } catch (error: any) {
    await logError('Error in stop-MG-processing', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), { status: 500, headers: responseHeaders });
  }
});
