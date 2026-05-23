// process-mg-task/index.ts
// Thin Supabase Edge wrapper that forwards to the Deno Deploy worker at
// PROCESS_MG_TASK_URL. The Deno Deploy worker actually invokes the Remotion
// Lambda render and polls until complete (which can take several minutes).
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const PROCESS_MG_TASK_URL = Deno.env.get('PROCESS_MG_TASK_URL') ||
  'https://process-mg-task.storyscriptai.deno.net/';

const supabaseSecretKey = Deno.env.get('SECRET_KEY') ?? '';

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });
  }

  const auth = await verifyAuth(req);
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });
  }

  try {
    const body = await req.json();

    // Fire-and-forget: Deno Deploy worker may run for minutes; we don't want
    // the Supabase Edge Function to hold the connection open. Return 202 immediately.
    // NOTE: deno worker requires `Authorization: Bearer <SECRET_KEY>`.
    fetch(PROCESS_MG_TASK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseSecretKey}`,
        'apikey': supabaseSecretKey,
      },
      body: JSON.stringify(body),
    }).catch(err => console.error(`process-mg-task forward failed: ${err.message}`));

    return new Response(JSON.stringify({ status: 'forwarded', target: PROCESS_MG_TASK_URL }), { status: 202, headers: responseHeaders });
  } catch (error: any) {
    console.error(`Error in process-mg-task wrapper: ${error.message}`);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: responseHeaders });
  }
});
