// redo-MG/index.ts
// Re-renders an existing MG_tasks row. Caller may override the
// codegen-pipeline fields (motion_graphic_prompt, user_prompt,
// style_guidance, video_duration, assets). Then sets redo_status='redoing'
// and re-fires the mg-codegen-worker Lambda directly.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { LambdaClient, InvokeCommand } from 'npm:@aws-sdk/client-lambda@3';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
const AWS_REGION = 'eu-north-1';
const LAMBDA_NAME = 'mg-codegen-worker';
const AWS_ACCESS_KEY_ID = Deno.env.get('AWS_ACCESS_KEY_ID') || Deno.env.get('AWS_ACCESS_KEY') || '';
const AWS_SECRET_ACCESS_KEY = Deno.env.get('AWS_SECRET_ACCESS_KEY') || Deno.env.get('AWS_ACCESS_SECRET_KEY') || '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
const lambda = new LambdaClient({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
});

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

interface RedoRequest {
  task_id: string;
  user_id: string;
  // Codegen-pipeline overrides:
  motion_graphic_prompt?: string;
  user_prompt?: string;
  style_guidance?: string;
  video_duration?: number;
  assets?: Array<{ name: string; purpose?: string }>;
  // Legacy field accepted but ignored (composition_id is always 'Clip'):
  composition_id?: string;
  // Legacy override (kept for backward compat with callers that still pass
  // inputProps containing motion_graphic_prompt / style_guidance):
  inputPropsOverride?: Record<string, any>;
  // Optional user feedback (≤ 40 chars) appended to the user_prompt before
  // regeneration.
  feedback?: string;
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });

    const body: RedoRequest = await req.json();
    if (!auth.isServiceRole && auth.userId) body.user_id = auth.userId;

    const feedback = typeof body.feedback === 'string' ? body.feedback.trim().slice(0, 250) : '';

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!body.task_id || !uuidRegex.test(body.task_id))
      return new Response(JSON.stringify({ error: 'Missing or invalid task_id' }), { status: 400, headers: responseHeaders });
    if (!body.user_id || !uuidRegex.test(body.user_id))
      return new Response(JSON.stringify({ error: 'Missing or invalid user_id' }), { status: 400, headers: responseHeaders });

    const { data: task, error: taskErr } = await supabase
      .from('MG_tasks')
      .select('*')
      .eq('id', body.task_id)
      .eq('user_id', body.user_id)
      .single();
    if (taskErr || !task) {
      return new Response(JSON.stringify({ error: 'MG task not found' }), { status: 404, headers: responseHeaders });
    }

    // Pull overrides from either top-level body fields or legacy
    // inputPropsOverride blob.
    const ipo = (body.inputPropsOverride && typeof body.inputPropsOverride === 'object') ? body.inputPropsOverride : {};
    const newMotionPrompt =
      (typeof body.motion_graphic_prompt === 'string' && body.motion_graphic_prompt.trim()) ||
      (typeof ipo.motion_graphic_prompt === 'string' && ipo.motion_graphic_prompt.trim()) ||
      task.motion_graphic_prompt;
    const newUserPrompt =
      (typeof body.user_prompt === 'string' && body.user_prompt.trim()) ||
      (typeof ipo.user_prompt === 'string' && ipo.user_prompt.trim()) ||
      task.user_prompt;
    const newStyleGuidance =
      (typeof body.style_guidance === 'string' && body.style_guidance.trim()) ||
      (typeof ipo.style_guidance === 'string' && ipo.style_guidance.trim()) ||
      task.style_guidance;
    const newVideoDuration = body.video_duration || task.video_duration;
    const newAssets = Array.isArray(body.assets) ? body.assets : task.assets;

    // Append optional user feedback to the user_prompt that drives the
    // codegen LLM. Empty feedback ⇒ no change.
    const finalUserPrompt = feedback
      ? `${newUserPrompt}\n\nUser feedback for revision: ${feedback}`
      : newUserPrompt;
    const finalMotionPrompt = feedback
      ? `${newMotionPrompt}\n\nUser feedback for revision: ${feedback}`
      : newMotionPrompt;

    // Keep batch[0].text in sync with the new user_prompt for UI display, and
    // mirror the resolved inputProps into the envelope (matches setup-MG-tasks
    // and MG_prompt_tasks.batch_output shape).
    const envelopeInputProps: Record<string, any> = {
      motion_graphic_prompt: finalMotionPrompt,
      style_guidance: newStyleGuidance,
      video_duration: newVideoDuration,
      user_prompt: finalUserPrompt,
    };
    if (newAssets) envelopeInputProps.assets = newAssets;
    const existingBatch = Array.isArray(task.batch) ? task.batch : [];
    const updatedBatch = existingBatch.length > 0
      ? [{ ...existingBatch[0], text: finalUserPrompt, inputProps: envelopeInputProps }]
      : [{ text: finalUserPrompt, inputProps: envelopeInputProps, index: 1 }];

    await supabase.from('MG_tasks').update({
      batch: updatedBatch,
      // Codegen pipeline: composition_id is always 'Clip'.
      composition_id: 'Clip',
      style_slug: 'codegen',
      motion_graphic_prompt: finalMotionPrompt,
      user_prompt: finalUserPrompt,
      style_guidance: newStyleGuidance,
      video_duration: newVideoDuration,
      assets: newAssets,
      status: 'queued',
      error: null,
      progress: 0,
      poll_attempts: 0,
      lambda_render_id: null,
      lambda_bucket_name: null,
      video_url: null,
      redo_status: 'redoing',
      redo_started_at: new Date().toISOString(),
      stop_requested: false,
      updated_at: new Date().toISOString(),
    }).eq('id', task.id);

    // Fire-and-forget Lambda invocation.
    const invoker = (async () => {
      try {
        const res = await lambda.send(new InvokeCommand({
          FunctionName: LAMBDA_NAME,
          InvocationType: 'Event',
          Payload: new TextEncoder().encode(JSON.stringify({ task_id: task.id })),
        }));
        console.log(`[redo-MG] lambda invoke → status ${res.StatusCode} (task ${task.id})`);
      } catch (err: any) {
        await logError(`redo-MG: lambda invoke failed for task ${task.id}`, err);
      }
    })();
    // @ts-ignore
    if (typeof EdgeRuntime !== 'undefined' && (EdgeRuntime as any)?.waitUntil) {
      // @ts-ignore
      (EdgeRuntime as any).waitUntil(invoker);
    } else {
      await invoker;
    }

    return new Response(JSON.stringify({ status: 'redo_started', task_id: task.id }), { status: 202, headers: responseHeaders });
  } catch (error: any) {
    await logError('Error in redo-MG', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), { status: 500, headers: responseHeaders });
  }
});
