// single-RF — fetch one stock clip from a user-supplied search query (Coverr/Pexels).
//
// Flow:
//   1. Authenticate + validate inputs
//   2. Check token balance (flat stock-clip cost)
//   3. Insert RF_tasks row (single_rf: true, variant: 0)
//   4. Return 202 with { task_id, group_id }
//   5. EdgeRuntime.waitUntil → generate-RF search → download → storage → completed_final

import { createClient } from 'npm:@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';
import { planMaxTokensForUser } from '../_shared/planMaps.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

/** Flat token cost per stock clip download (testing / individual prompt). */
const RF_STOCK_TOKENS_PER_CLIP = 500;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function sanitizeTitle(title: string): string {
  return title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
}

async function logError(message: string, error: unknown) {
  console.error(message, error);
  try {
    await supabase.from('error_logs').insert({
      message,
      details: (error as Error).message || JSON.stringify(error),
      created_at: new Date().toISOString(),
    });
  } catch { /* ignore */ }
}

async function getUserIdFromToken(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

async function callGenerateRF(query: string): Promise<{
  status: string;
  video_url?: string;
  stock_source?: string;
  stock_id?: string;
  error?: string;
}> {
  const res = await fetch(`${supabaseUrl}/functions/v1/generate-RF`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseServiceRoleKey },
    body: JSON.stringify({ mode: 'search', query }),
  });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`generate-RF invalid JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(String(data.error ?? `HTTP ${res.status}`));
  return data as { status: string; video_url?: string; stock_source?: string; stock_id?: string; error?: string };
}

async function downloadVideoBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function completeSingleRFTask(
  task: Record<string, unknown>,
  remoteUrl: string,
  stockSource: string,
  stockId: string,
): Promise<void> {
  const taskId = task.id as string;
  const userId = task.user_id as string;
  const groupId = task.group_id as string;
  const storyTitle = String(task.story_title);

  const bytes = await downloadVideoBytes(remoteUrl);
  const sanitized = sanitizeTitle(storyTitle.replace(/^Single RF:\s*/i, '').replace(/^RF:\s*/i, ''));
  const storagePath = `documents/${userId}/${groupId}/RF-${sanitized}_${task.folder_timestamp}/1.mp4`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await supabase.storage
      .from('stories')
      .upload(storagePath, bytes, { contentType: 'video/mp4', upsert: true });
    if (!error) break;
    if (attempt >= 3) throw new Error(`Storage upload error: ${error.message}`);
    await sleep(5_000);
  }

  const { error: updateErr } = await supabase
    .from('RF_tasks')
    .update({
      status: 'completed_final',
      video_url: storagePath,
      stock_source: stockSource,
      stock_id: stockId,
      tokens: RF_STOCK_TOKENS_PER_CLIP,
      token_updated: true,
      progress: 100,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  if (updateErr) throw new Error(`Failed to update task: ${updateErr.message}`);
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: responseHeaders });
  }

  try {
    const {
      group_id,
      story_title,
      prompt,
      style_prompt = '',
      video_duration = 5,
      tab = 1,
    } = body as {
      group_id?: string;
      story_title?: string;
      prompt?: string;
      style_prompt?: string;
      video_duration?: number;
      tab?: number;
    };

    const finalQuery = style_prompt
      ? `${prompt}\n\nVisual style: ${style_prompt}`
      : String(prompt ?? '');

    if (!group_id || !story_title || !prompt?.trim()) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: group_id, story_title, prompt' }),
        { status: 400, headers: responseHeaders },
      );
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(group_id)) {
      return new Response(JSON.stringify({ error: 'Invalid group_id' }), { status: 400, headers: responseHeaders });
    }

    const authHeader = req.headers.get('Authorization');
    const userId = await getUserIdFromToken(authHeader);
    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized — valid Bearer token required' }),
        { status: 401, headers: responseHeaders },
      );
    }

    const { data: planData } = await supabase
      .from('user_plans')
      .select('plan_type, tokens_used, rollover_tokens, is_legacy_plan')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (!planData) {
      return new Response(JSON.stringify({ error: 'User plan not found' }), { status: 403, headers: responseHeaders });
    }

    const planType = planData.plan_type || 'free';
    const isLegacy = planData.is_legacy_plan !== false;
    const tokensRemaining =
      planMaxTokensForUser(planType, isLegacy) -
      (planData.tokens_used || 0) +
      (planData.rollover_tokens || 0);

    if (tokensRemaining < RF_STOCK_TOKENS_PER_CLIP) {
      return new Response(
        JSON.stringify({
          error: `Insufficient tokens. Required: ${RF_STOCK_TOKENS_PER_CLIP}, Available: ${tokensRemaining}`,
        }),
        { status: 403, headers: responseHeaders },
      );
    }

    const folderTimestamp = new Date().toISOString().replace(/[-:T.]/g, '');
    const taskId = crypto.randomUUID();

    const { error: insertErr } = await supabase.from('RF_tasks').insert({
      id: taskId,
      user_id: userId,
      group_id,
      story_title,
      description: story_title,
      batch_number: 1,
      total_batches: 1,
      total_prompts: 1,
      status: 'running',
      progress: 0,
      version: 14,
      video_model: 'stock',
      video_duration,
      tab,
      variant: 0,
      single_rf: true,
      folder_timestamp: folderTimestamp,
      batch: [{ prompt: finalQuery.trim() }],
      tokens: 0,
      token_updated: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    if (insertErr) {
      await logError('single-RF task insert error', insertErr);
      return new Response(
        JSON.stringify({ error: `Failed to create task: ${insertErr.message}` }),
        { status: 500, headers: responseHeaders },
      );
    }

    const taskRecord = {
      id: taskId,
      user_id: userId,
      group_id,
      story_title,
      folder_timestamp: folderTimestamp,
    };

    const response = new Response(
      JSON.stringify({
        status: 'processing',
        message: 'Single RF stock clip search started',
        task_id: taskId,
        group_id,
      }),
      { status: 202, headers: responseHeaders },
    );

    EdgeRuntime.waitUntil(
      (async () => {
        try {
          const gen = await callGenerateRF(finalQuery.trim());
          if (gen.status !== 'completed' || !gen.video_url) {
            throw new Error(gen.error ?? 'No stock clip found');
          }
          await completeSingleRFTask(
            taskRecord,
            gen.video_url,
            gen.stock_source ?? 'unknown',
            gen.stock_id ?? '',
          );
        } catch (e) {
          await logError('single-RF background error', e);
          await supabase
            .from('RF_tasks')
            .update({
              status: 'error',
              error: (e as Error).message,
              updated_at: new Date().toISOString(),
            })
            .eq('id', taskId);
        }
      })(),
    );

    return response;
  } catch (e) {
    await logError('single-RF unhandled error', e);
    return new Response(
      JSON.stringify({ error: (e as Error).message || 'Internal server error' }),
      { status: 500, headers: responseHeaders },
    );
  }
});
