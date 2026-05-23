// setup-mg-prompts/index.ts
// Thin Supabase Edge wrapper that forwards to the long-running Deno Deploy
// orchestrator at SETUP_MG_PROMPTS_URL. The wrapper exists so the frontend
// always calls a stable supabase.functions.invoke() endpoint regardless of
// where the heavy LLM work runs.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const SETUP_MG_PROMPTS_URL = Deno.env.get('SETUP_MG_PROMPTS_URL') ||
  'https://setup-mg-prompts.storyscriptai.deno.net/';

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
    if (!auth.isServiceRole && auth.userId) {
      body.user_id = auth.userId;
    }

    const resp = await fetch(SETUP_MG_PROMPTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseSecretKey,
      },
      body: JSON.stringify(body),
    });

    const text = await resp.text();
    return new Response(text, { status: resp.status, headers: responseHeaders });
  } catch (error: any) {
    console.error(`Error in setup-mg-prompts wrapper: ${error.message}`);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: responseHeaders });
  }
});
