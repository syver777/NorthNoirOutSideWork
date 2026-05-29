// redo-RF — re-fetch one stock clip for an existing RF_tasks row (Coverr/Pexels).
//
// Initial request: { group_id, batch_number, feedback? }
//   - Authenticates user, sets redo_status = 'redoing', returns 202
//   - waitUntil: generate-RF search → download → overwrite storage path
//
// On completion: clears redo_status, updates video_url / stock metadata, charges tokens.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';
import { planMaxTokensForUser } from '../_shared/planMaps.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const RF_STOCK_TOKENS_PER_CLIP = 500;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function sanitizeTitle(title: string): string {
  return title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
}

function sanitizeFeedback(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, 250);
}

function applyFeedback(query: string, feedback: string): string {
  if (!feedback) return query;
  return `${query}\n\nUser feedback for revision: ${feedback}`;
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

async function completeRedoTask(
  task: Record<string, unknown>,
  remoteUrl: string,
  stockSource: string,
  stockId: string,
): Promise<void> {
  const taskId = task.id as string;
  const userId = task.user_id as string;
  const groupId = task.group_id as string;
  const batchNumber = task.batch_number as number;
  const storyTitle = String(task.story_title);

  const bytes = await downloadVideoBytes(remoteUrl);
  const sanitized = sanitizeTitle(
    storyTitle.replace(/^RF Prompt:\s*/i, '').replace(/^RF Prompts:\s*/i, ''),
  );
  const storagePath = `documents/${userId}/${groupId}/RF-${sanitized}_${task.folder_timestamp}/${batchNumber}.mp4`;

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
      redo_status: null,
      redo_started_at: null,
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

  try {
    const body = await req.json();
    const { group_id, batch_number } = body;
    const feedback = sanitizeFeedback(body.feedback);

    if (!group_id || batch_number == null) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: group_id or batch_number' }),
        { status: 400, headers: responseHeaders },
      );
    }

    const authHeader = req.headers.get('Authorization');
    const jwtUserId = await getUserIdFromToken(authHeader);
    if (!jwtUserId) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized — valid Bearer token required' }),
        { status: 401, headers: responseHeaders },
      );
    }

    const { data: task, error: taskErr } = await supabase
      .from('RF_tasks')
      .select('*')
      .eq('user_id', jwtUserId)
      .eq('group_id', group_id)
      .eq('batch_number', batch_number)
      .single();

    if (taskErr || !task) {
      return new Response(
        JSON.stringify({ error: `Task not found for group_id: ${group_id}, batch_number: ${batch_number}` }),
        { status: 404, headers: responseHeaders },
      );
    }

    if (!task.batch || !Array.isArray(task.batch) || !task.batch[0]?.prompt) {
      return new Response(
        JSON.stringify({ error: 'No search query found in task batch data' }),
        { status: 400, headers: responseHeaders },
      );
    }

    const { data: planData } = await supabase
      .from('user_plans')
      .select('plan_type, tokens_used, rollover_tokens, is_legacy_plan')
      .eq('user_id', jwtUserId)
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
          error: `Insufficient tokens for redo. Required: ${RF_STOCK_TOKENS_PER_CLIP}, Available: ${tokensRemaining}`,
        }),
        { status: 403, headers: responseHeaders },
      );
    }

    const searchQuery = applyFeedback(String(task.batch[0].prompt), feedback);

    const { error: updateErr } = await supabase
      .from('RF_tasks')
      .update({
        redo_status: 'redoing',
        redo_started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id);

    if (updateErr) {
      return new Response(JSON.stringify({ error: 'Failed to update task for redo' }), { status: 500, headers: responseHeaders });
    }

    const response = new Response(
      JSON.stringify({
        status: 'processing',
        message: 'RF redo started — stock clip is being re-fetched',
        group_id,
        batch_number,
      }),
      { status: 202, headers: responseHeaders },
    );

    EdgeRuntime.waitUntil(
      (async () => {
        try {
          const gen = await callGenerateRF(searchQuery.trim());
          if (gen.status !== 'completed' || !gen.video_url) {
            throw new Error(gen.error ?? 'No stock clip found');
          }
          await completeRedoTask(task, gen.video_url, gen.stock_source ?? 'unknown', gen.stock_id ?? '');
        } catch (e) {
          await logError('redo-RF background error', e);
          await supabase
            .from('RF_tasks')
            .update({ redo_status: 'failed', updated_at: new Date().toISOString() })
            .eq('id', task.id);
        }
      })(),
    );

    return response;
  } catch (e) {
    await logError('redo-RF unhandled error', e);
    return new Response(
      JSON.stringify({ error: (e as Error).message || 'Internal server error' }),
      { status: 500, headers: responseHeaders },
    );
  }
});
