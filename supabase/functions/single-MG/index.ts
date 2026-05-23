// single-MG/index.ts
// Code-gen pipeline for one-off Motion Graphics clips.
//
// Replaces the old 16-template flow. Now:
//   1. Validate auth + body.
//   2. Call Claude (opus/sonnet) — or DeepSeek — to rewrite the user prompt
//      into a vivid "motion_graphic_prompt" description.
//   3. INSERT a MG_tasks row (single_mg=true, status='code_gen').
//   4. Fire-and-forget POST to MG_CODEGEN_WORKER_URL (the Lambda that runs
//      Claude Opus → esbuild → bundle → deploySite → renderMediaOnLambda).
//   5. Return { task_id } so the dashboard can poll.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { LambdaClient, InvokeCommand } from 'npm:@aws-sdk/client-lambda@3';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const deepseekApiKey = Deno.env.get('DEEPSEEK_API_KEY') ?? '';
const AWS_REGION = 'eu-north-1';
const LAMBDA_NAME = 'mg-codegen-worker';
const AWS_ACCESS_KEY_ID =
  Deno.env.get('AWS_ACCESS_KEY_ID') ||
  Deno.env.get('AWS_ACCESS_KEY') ||
  '';
const AWS_SECRET_ACCESS_KEY =
  Deno.env.get('AWS_SECRET_ACCESS_KEY') ||
  Deno.env.get('AWS_ACCESS_SECRET_KEY') ||
  '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}
if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
  console.warn('[single-MG] AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set — Lambda invokes will fail');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const lambda = new LambdaClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

interface RequestBody {
  user_prompt: string;
  style_guidance?: string;
  duration_seconds?: number;
  user_id: string;
  tab?: number;
  ai_model?: 'sonnet' | 'opus' | 'deepseek' | string;
  /** Lambda codegen model for clip TSX. Defaults to 'opus'. */
  codegen_model?: 'opus' | 'sonnet';
  assets?: Array<{ name: string; purpose?: string }>;
  doc_id?: string | null;
  group_id?: string | null;
  story_title?: string | null;
  /** Optional parent video_tasks row id (set when launched from the unified VideoGenerator). */
  video_task_id?: string | null;
}

// ─── Prompt expansion (user_prompt → motion_graphic_prompt) ──────────────────
async function expandWithAnthropic(
  userPrompt: string,
  styleGuidance: string,
  durationSeconds: number,
  model: 'opus' | 'sonnet',
): Promise<string> {
  if (!anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const modelId = model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6';
  const system =
    'You are a senior motion designer. Take a short user prompt and rewrite it as a vivid, ' +
    'highly specific description of a single motion-graphic clip — what appears on screen ' +
    'frame by frame, the animation beats, the palette, the typography, the camera/transition ' +
    'language. 4-8 sentences. Concrete, no fluff, no markdown. The output is fed to a TSX ' +
    'code generator that builds the clip in Remotion 4.x, so it should describe the visuals ' +
    'and motion clearly enough that a developer could rebuild it from your text.';

  const userMsg =
    `Original prompt:\n${userPrompt.trim()}\n\n` +
    (styleGuidance.trim() ? `Style direction:\n${styleGuidance.trim()}\n\n` : '') +
    `Target duration: ${durationSeconds}s at 30fps.\n\n` +
    `Write the rewritten motion_graphic_prompt now. Reply with ONLY the rewritten description, ` +
    `no preamble.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 800,
      temperature: 0.5,
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic ${modelId} HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.content?.[0]?.text;
  if (!text) throw new Error(`Anthropic ${modelId} returned no text`);
  return String(text).trim();
}

async function expandWithDeepSeek(
  userPrompt: string,
  styleGuidance: string,
  durationSeconds: number,
): Promise<string> {
  if (!deepseekApiKey) throw new Error('DEEPSEEK_API_KEY not set');
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${deepseekApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      temperature: 0.5,
      max_tokens: 800,
      messages: [
        {
          role: 'system',
          content:
            'Rewrite the user prompt as a vivid, specific description of a single motion-graphic clip. ' +
            '4-8 sentences. Concrete. Plain text. No markdown.',
        },
        {
          role: 'user',
          content:
            `Original prompt:\n${userPrompt.trim()}\n\n` +
            (styleGuidance.trim() ? `Style direction:\n${styleGuidance.trim()}\n\n` : '') +
            `Target duration: ${durationSeconds}s at 30fps.\n\n` +
            `Reply with ONLY the rewritten description.`,
        },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DeepSeek HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('DeepSeek returned no text');
  return String(text).trim();
}

async function logError(message: string, err: unknown) {
  console.error(`${message}:`, err);
  try {
    await supabase.from('error_logs').insert({
      message,
      details: err instanceof Error ? err.message : JSON.stringify(err),
      created_at: new Date().toISOString(),
    });
  } catch (_) {
    /* silent */
  }
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  try {
    // verifyAuth returns { userId, isServiceRole } | null
    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      });
    }

    const body = (await req.json()) as RequestBody;

    // For non-service-role callers, trust the JWT's user_id over the body.
    const effectiveUserId = !auth.isServiceRole && auth.userId ? auth.userId : body.user_id;

    if (!body.user_prompt || !effectiveUserId) {
      return new Response(JSON.stringify({ error: 'user_prompt and user_id are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      });
    }

    const durationSeconds = Math.max(1, Math.min(120, Number(body.duration_seconds ?? 10)));
    const styleGuidance = (body.style_guidance ?? '').trim();
    const aiModel = body.ai_model ?? 'opus';

    console.log(
      `[single-MG] expanding prompt — model=${aiModel} duration=${durationSeconds}s`
    );

    let motionPrompt: string;
    try {
      if (aiModel === 'opus' || aiModel === 'sonnet') {
        motionPrompt = await expandWithAnthropic(
          body.user_prompt,
          styleGuidance,
          durationSeconds,
          aiModel as 'opus' | 'sonnet'
        );
      } else {
        motionPrompt = await expandWithDeepSeek(body.user_prompt, styleGuidance, durationSeconds);
      }
    } catch (err) {
      await logError('[single-MG] prompt expansion failed', err);
      // Fallback: just hand the raw user prompt straight through.
      motionPrompt = body.user_prompt.trim();
    }

    // ─── Insert MG_tasks row ─────────────────────────────────────────────
    // NOT NULL columns we MUST populate: group_id, story_title, batch,
    // total_batches, batch_number, total_prompts, style_slug, composition_id.
    const taskRow = {
      user_id: effectiveUserId,
      doc_id: body.doc_id ?? null,
      group_id: body.group_id ?? crypto.randomUUID(),
      story_title: body.story_title ?? 'single_mg',
      status: 'code_gen',
      single_mg: true,
      variant: 0,
      tab: body.tab ?? 0,
      video_duration: durationSeconds,
      // Code-gen pipeline doesn't use the 16-template system; these are placeholders
      // to satisfy NOT NULL constraints on the legacy template columns.
      style_slug: 'codegen',
      composition_id: 'Clip',
      batch: [{ text: body.user_prompt, inputProps: {}, index: 1 }],
      total_batches: 1,
      batch_number: 1,
      total_prompts: 1,
      user_prompt: body.user_prompt,
      style_guidance: styleGuidance || null,
      motion_graphic_prompt: motionPrompt,
      assets: body.assets ?? null,
      progress: 0,
      // MG video folder: v26 (original). single-MG has no corrected variant.
      version: 26,
      codegen_model:
        body.codegen_model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-6',
      video_task_id: body.video_task_id ?? null,
    };

    const { data: inserted, error: insertErr } = await supabase
      .from('MG_tasks')
      .insert(taskRow)
      .select('id')
      .single();

    if (insertErr || !inserted) {
      await logError('[single-MG] INSERT failed', insertErr);
      return new Response(JSON.stringify({ error: 'Failed to create task' }), {
        status: 500,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      });
    }

    const taskId: string = inserted.id;
    console.log(`[single-MG] task ${taskId} created — invoking worker`);

    // ─── Fire-and-forget worker invocation via AWS SDK ───────────────────
    if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
      const invoker = (async () => {
        try {
          const res = await lambda.send(
            new InvokeCommand({
              FunctionName: LAMBDA_NAME,
              InvocationType: 'Event', // async fire-and-forget
              Payload: new TextEncoder().encode(JSON.stringify({ task_id: taskId })),
            })
          );
          console.log(`[single-MG] lambda invoke → status ${res.StatusCode} (task ${taskId})`);
        } catch (err) {
          await logError(`[single-MG] lambda invoke failed task=${taskId}`, err);
        }
      })();
      // @ts-ignore — EdgeRuntime is a Supabase global
      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(invoker);
      } else {
        await invoker;
      }
    } else {
      console.warn('[single-MG] AWS creds missing — task queued but worker NOT invoked');
    }

    return new Response(
      JSON.stringify({ task_id: taskId, motion_graphic_prompt: motionPrompt }),
      { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } }
    );
  } catch (err) {
    await logError('[single-MG] unhandled error', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } }
    );
  }
});
