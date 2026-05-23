// empty-redo-MG/index.ts
// When a codegen render comes back empty (no video_url) or fails with a
// moderation error, ask DeepSeek to rewrite the codegen text fields
// (motion_graphic_prompt, user_prompt) into safer language and re-fire the
// mg-codegen-worker Lambda directly.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { LambdaClient, InvokeCommand } from 'npm:@aws-sdk/client-lambda@3';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
const deepseekApiKey = Deno.env.get('DEEPSEEK_API_KEY') ?? '';
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

const SYSTEM_PROMPT = `You are a content-moderation safety rewriter for motion-graphics clip briefs.
You will receive a JSON object with TWO fields: { "motion_graphic_prompt": string, "user_prompt": string }.
Rewrite BOTH fields so the visual / narrative meaning is preserved, but any potentially unsafe
content (violence, hate, sexual, self-harm, illegal acts, named real persons, brand names) is
removed or rephrased into neutral, abstract wording. Specific facts that are not unsafe
(numbers, dates, places, abstract concepts) should be retained.
Return ONLY the rewritten JSON object — no commentary, no markdown fences.`;

async function rewriteCodegenFields(
  motionGraphicPrompt: string,
  userPrompt: string,
): Promise<{ motion_graphic_prompt: string; user_prompt: string }> {
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${deepseekApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ motion_graphic_prompt: motionGraphicPrompt, user_prompt: userPrompt }) },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4000,
      temperature: 0.3,
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`DeepSeek rewrite failed: HTTP ${resp.status} - ${txt}`);
  }
  const result = await resp.json();
  let content: string = result.choices?.[0]?.message?.content ?? '';
  content = content.trim();
  if (content.startsWith('```json')) content = content.slice(7);
  if (content.startsWith('```')) content = content.slice(3);
  if (content.endsWith('```')) content = content.slice(0, -3);
  const parsed = JSON.parse(content.trim());
  return {
    motion_graphic_prompt: typeof parsed.motion_graphic_prompt === 'string' ? parsed.motion_graphic_prompt : motionGraphicPrompt,
    user_prompt: typeof parsed.user_prompt === 'string' ? parsed.user_prompt : userPrompt,
  };
}

interface EmptyRedoRequest {
  task_id: string;
  user_id: string;
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });

    const body: EmptyRedoRequest = await req.json();
    if (!auth.isServiceRole && auth.userId) body.user_id = auth.userId;

    const { data: task, error: taskErr } = await supabase
      .from('MG_tasks')
      .select('*')
      .eq('id', body.task_id)
      .eq('user_id', body.user_id)
      .single();

    if (taskErr || !task) return new Response(JSON.stringify({ error: 'MG task not found' }), { status: 404, headers: responseHeaders });

    const originalMotion = (task.motion_graphic_prompt as string) || '';
    const originalUser = (task.user_prompt as string) || (Array.isArray(task.batch) ? task.batch[0]?.text : '') || '';
    if (!originalMotion && !originalUser) {
      return new Response(JSON.stringify({ error: 'Task has no prompt fields to rewrite' }), { status: 400, headers: responseHeaders });
    }

    const rewritten = await rewriteCodegenFields(originalMotion, originalUser);

    // Keep batch[0].text in sync with rewritten user_prompt and mirror the
    // resolved inputProps into the envelope (matches setup-MG-tasks shape).
    const envelopeInputProps: Record<string, any> = {
      motion_graphic_prompt: rewritten.motion_graphic_prompt,
      style_guidance: (task.style_guidance as string) || '',
      video_duration: task.video_duration,
      user_prompt: rewritten.user_prompt,
    };
    if (Array.isArray(task.assets)) envelopeInputProps.assets = task.assets;
    const existingBatch = Array.isArray(task.batch) ? task.batch : [];
    const newBatch = existingBatch.length > 0
      ? [{ ...existingBatch[0], text: rewritten.user_prompt, inputProps: envelopeInputProps }]
      : [{ text: rewritten.user_prompt, inputProps: envelopeInputProps, index: 1 }];

    await supabase.from('MG_tasks').update({
      batch: newBatch,
      motion_graphic_prompt: rewritten.motion_graphic_prompt,
      user_prompt: rewritten.user_prompt,
      // Codegen pipeline contract:
      composition_id: 'Clip',
      style_slug: 'codegen',
      status: 'queued',
      error: null,
      progress: 0,
      poll_attempts: 0,
      lambda_render_id: null,
      lambda_bucket_name: null,
      video_url: null,
      is_corrected: true,
      redo_status: 'empty_redo',
      redo_started_at: new Date().toISOString(),
      stop_requested: false,
      updated_at: new Date().toISOString(),
    }).eq('id', task.id);

    const invoker = (async () => {
      try {
        const res = await lambda.send(new InvokeCommand({
          FunctionName: LAMBDA_NAME,
          InvocationType: 'Event',
          Payload: new TextEncoder().encode(JSON.stringify({ task_id: task.id })),
        }));
        console.log(`[empty-redo-MG] lambda invoke → status ${res.StatusCode} (task ${task.id})`);
      } catch (err: any) {
        await logError(`empty-redo-MG: lambda invoke failed for task ${task.id}`, err);
      }
    })();
    // @ts-ignore
    if (typeof EdgeRuntime !== 'undefined' && (EdgeRuntime as any)?.waitUntil) {
      // @ts-ignore
      (EdgeRuntime as any).waitUntil(invoker);
    } else {
      await invoker;
    }

    return new Response(JSON.stringify({ status: 'empty_redo_started', task_id: task.id }), { status: 202, headers: responseHeaders });
  } catch (error: any) {
    await logError('Error in empty-redo-MG', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), { status: 500, headers: responseHeaders });
  }
});
