// redo-TTV/index.ts
// Handles redo of a single TTV video clip.
//
// Two modes:
//   Initial request: { group_id, batch_number }
//     - Authenticates user via Bearer token
//     - Fetches the TTV_task, validates tokens
//     - Sets redo_status = 'redoing' on the task
//     - Returns 202 immediately
//     - In waitUntil: submits to generate-TTV, then polls until done
//     - Short models (<180 s initial delay): polls in-process
//     - Long models (sora): sleeps initial delay, fires self-call chain
//
//   Poll mode: { redo_poll_mode: true, task_id, polling_id, polling_url?, video_model, video_duration, poll_attempt }
//     - Server-side self-call; uses service role key
//     - Polls once; if still pending fires another self-call; if done completes the task
//
// On completion:
//   - Downloads video, uploads to same storage path (upsert → overwrites old clip)
//   - Updates TTV_tasks: clears redo_status/redo_started_at, sets new video_url, charges tokens
//   - Status remains 'completed_final' throughout

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import OpenAI from 'npm:openai@6';
import { getCorsHeaders } from '../_shared/cors.ts';
import { getIsLegacyPlan, ttvTokensPerSecond } from '../_shared/tokenCosts.ts';
import { planMaxTokensForUser } from '../_shared/planMaps.ts';

// ── Env ────────────────────────────────────────────────────────────────────────
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
const openaiApiKey = Deno.env.get('OPENAI_API_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// corsHeaders is now set dynamically inside the serve handler via getCorsHeaders(req)

// ── Constants ──────────────────────────────────────────────────────────────────
// Per-action TTV token costs are resolved per-user via tokenCosts.ts
// (legacy users keep historical rates; new users hit the calibrated
// NEW_TTV_* map). Always use ttvTokensPerSecond(...) at billing time.

const planMaxTokens: Record<string, number> = {
  free: 400000,
  standard: 4000000,
  plus: 6000000,
  premium: 10000000,
  pro: 25000000,
  elite: 50000000,
  ultimate: 75000000,
  enterprise: 250000000,
};

// Models that require a self-call chain (initial wait >= 180 s)
const LONG_POLL_MODELS = new Set(['sora2pro', 'sora2pro_highres']);

// Initial sleep before first poll (ms) – mirrors process-TTV values
const INITIAL_POLL_DELAY_MS: Record<string, number> = {
  seedance_pro_fast: 90_000,
  ltx23_fast: 90_000,
  seedance15_pro: 90_000,
  ltx23_pro: 90_000,
  grok: 90_000,
  grok_highres: 90_000,
  veo31fast: 90_000,
  veo31: 90_000,
  sora2pro: 360_000,
  sora2pro_highres: 290_000,
};

// Max redo poll self-call chain depth (prevents infinite loops)
const MAX_TOTAL_POLL_ATTEMPTS = 60;

// Max times we resubmit a fresh job after a 'failed' poll result
const MAX_RESUBMITS = 2;

// Leave a ~60 s safety buffer before the 400 s edge function hard limit
const MAX_WAIT_MS = 340_000;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function errorToString(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    if ('message' in err && typeof (err as any).message === 'string') return (err as any).message;
    try { return JSON.stringify(err); } catch { /* fall through */ }
  }
  return String(err);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    await supabase.from('error_logs').insert({
      message,
      error_message: error.message || JSON.stringify(error),
      details: error.message || JSON.stringify(error),
      created_at: new Date().toISOString(),
    });
  } catch (_) { /* silent */ }
}

function sanitizeFeedback(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, 250);
}

function applyFeedback(prompt: string, feedback: string): string {
  if (!feedback) return prompt;
  return `${prompt}\n\nUser feedback for revision: ${feedback}`;
}

function sanitizeTitle(title: string): string {
  return title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
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

async function callGenerateTTV(body: Record<string, any>): Promise<any> {
  const res = await fetch(`${supabaseUrl}/functions/v1/generate-TTV`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseServiceRoleKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`generate-TTV HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Download the generated video bytes (mirrors process-TTV's downloadVideo)
async function downloadVideo(
  videoModel: string,
  videoUrl: string | undefined,
  soraJobId: string | undefined,
): Promise<Uint8Array> {
  if (videoModel === 'sora2pro' || videoModel === 'sora2pro_highres') {
    if (!soraJobId) throw new Error('Sora download: missing sora_job_id');
    const openaiClient = new OpenAI({ apiKey: openaiApiKey });
    const response = await (openaiClient as any).videos.downloadContent(soraJobId, { variant: 'video' });
    if (response?.arrayBuffer) {
      const buf = await response.arrayBuffer();
      return new Uint8Array(buf);
    }
    if (response instanceof Uint8Array) return response;
    if (response instanceof ArrayBuffer) return new Uint8Array(response);
    throw new Error('Sora download: unexpected response type');
  }
  if (!videoUrl) throw new Error('downloadVideo: missing video_url');
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Video download HTTP ${res.status} from ${videoUrl.slice(0, 100)}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

// Token deduction is handled by the ttv_tasks_tokens_update DB trigger.

// Download video → upload to storage (overwrite) → update TTV_tasks row
async function completeRedoTask(
  task: Record<string, any>,
  videoUrl: string | undefined,
  soraJobId: string | undefined,
): Promise<void> {
  const {
    id: taskId,
    user_id: userId,
    video_model: videoModel,
    video_duration: videoDuration,
    story_title: storyTitle,
    group_id: groupId,
    folder_timestamp: folderTimestamp,
    batch_number: batchNumber,
    audio_clip: audioClip,
  } = task;

  console.log(`[redo-TTV] Completing redo for task ${taskId} (batch ${batchNumber})`);

  // Download video bytes
  const videoBytes = await downloadVideo(videoModel, videoUrl, soraJobId);

  // Build the same storage path used during original generation
  const sanitized = sanitizeTitle(
    storyTitle.replace(/^TTV Prompt:\s*/i, '').replace(/^TTV Prompts:\s*/i, ''),
  );
  const storagePath = `documents/${userId}/${groupId}/TTV-${sanitized}_${folderTimestamp}/${batchNumber}.mp4`;

  // Upload (upsert → overwrites the old clip)
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { error } = await supabase.storage
        .from('stories')
        .upload(storagePath, videoBytes, { contentType: 'video/mp4', upsert: true });
      if (error) throw new Error(`Storage upload error: ${error.message}`);
      console.log(`[redo-TTV] Uploaded video to ${storagePath}`);
      break;
    } catch (e: any) {
      if (attempt < maxAttempts) {
        console.warn(`[redo-TTV] Upload attempt ${attempt} failed: ${e.message} — retrying in 5 s`);
        await sleep(5_000);
      } else throw e;
    }
  }

  // Calculate tokens for this video (Veo audio mode costs more)
  const isLegacy = await getIsLegacyPlan(userId);
  const tps = ttvTokensPerSecond(isLegacy, videoModel, !!audioClip);
  const tokens = Math.round((videoDuration ?? 5) * tps);

  // Update task: clear redo fields, update video_url; status stays 'completed_final'
  const { error: updateErr } = await supabase
    .from('TTV_tasks')
    .update({
      redo_status: null,
      redo_started_at: null,
      video_url: storagePath,
      tokens,
      token_updated: true,
      progress: 100,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  if (updateErr) {
    console.error(`[redo-TTV] Failed to update task ${taskId}:`, updateErr.message);
    throw new Error(`Failed to update task: ${updateErr.message}`);
  }

  console.log(`[redo-TTV] Redo complete for task ${taskId}, tokens charged via DB trigger`);  
}

// Fire a self-call for the next poll attempt
async function firePollSelfCall(
  task: Record<string, any>,
  pollingId: string,
  pollingUrl: string | null | undefined,
  pollAttempt: number,
  resubmitCount = 0,
  feedback = '',
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/functions/v1/redo-TTV`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        redo_poll_mode: true,
        task_id: task.id,
        polling_id: pollingId,
        polling_url: pollingUrl ?? null,
        video_model: task.video_model,
        video_duration: task.video_duration,
        poll_attempt: pollAttempt,
        resubmit_count: resubmitCount,
        feedback,
      }),
    });
    console.log(`[redo-TTV] Fired self-call for poll attempt ${pollAttempt} (task ${task.id}, resubmits=${resubmitCount})`);
  } catch (e: any) {
    await logError(`Failed to fire poll self-call for redo-TTV task ${task.id}`, e);
  }
}

// In-process poll loop for short models (seedance, ltx, grok, veo31fast, veo31)
async function pollUntilDone(
  task: Record<string, any>,
  pollingId: string,
  pollingUrl: string | null | undefined,
  startPollAttempt: number,
  resubmitCount = 0,
  feedback = '',
): Promise<void> {
  const { video_model: videoModel } = task;
  const startTime = Date.now();
  let currentPollingId = pollingId;
  let currentPollingUrl = pollingUrl;

  for (let attempt = startPollAttempt; attempt < MAX_TOTAL_POLL_ATTEMPTS; attempt++) {
    // If time budget is nearly exhausted, delegate to a self-call
    if (Date.now() - startTime > MAX_WAIT_MS - 60_000) {
      console.log(`[redo-TTV] Time budget nearly exhausted at poll ${attempt} — firing self-call`);
      await firePollSelfCall(task, currentPollingId, currentPollingUrl, attempt, resubmitCount, feedback);
      return;
    }

    await sleep(30_000);

    try {
      const pollResult = await callGenerateTTV({
        mode: 'poll',
        video_model: videoModel,
        polling_id: currentPollingId,
        polling_url: currentPollingUrl ?? null,
      });

      if (pollResult.status === 'completed') {
        await completeRedoTask(task, pollResult.video_url, pollResult.sora_job_id);
        return;
      } else if (pollResult.status === 'failed') {
        const errMsg = errorToString(pollResult.error) || 'Unknown error';
        console.warn(`[redo-TTV] Poll attempt ${attempt} got failed: ${errMsg}`);

        if (resubmitCount < MAX_RESUBMITS) {
          console.log(`[redo-TTV] Resubmitting fresh job (resubmit ${resubmitCount + 1}/${MAX_RESUBMITS}) for task ${task.id}`);
          const basePrompt = task.batch?.[0]?.prompt as string;
          if (!basePrompt) throw new Error('Cannot resubmit — no prompt in task batch');
          const prompt = applyFeedback(basePrompt, feedback);
          const freshResult = await callGenerateTTV({
            mode: 'submit',
            video_model: videoModel,
            prompt,
            video_duration: task.video_duration,
            audio_clip: task.audio_clip ?? false,
          });
          if (freshResult.status === 'completed' && (freshResult.video_url || freshResult.sora_job_id)) {
            await completeRedoTask(task, freshResult.video_url, freshResult.sora_job_id);
            return;
          }
          if (!freshResult.polling_id) throw new Error('Resubmit returned no polling_id');
          currentPollingId = freshResult.polling_id;
          currentPollingUrl = freshResult.polling_url ?? null;
          resubmitCount++;
          const initialDelay = INITIAL_POLL_DELAY_MS[videoModel] ?? 90_000;
          const safeDelay = Math.min(initialDelay, MAX_WAIT_MS - (Date.now() - startTime) - 60_000);
          if (safeDelay > 0) await sleep(safeDelay);
          continue;
        }
        throw new Error(`Video generation failed after ${resubmitCount} resubmits: ${errMsg}`);
      }
      // still pending → continue loop
    } catch (e: any) {
      console.error(`[redo-TTV] Poll attempt ${attempt} error:`, e.message);
      if (attempt >= MAX_TOTAL_POLL_ATTEMPTS - 1) throw e;
    }
  }

  throw new Error('[redo-TTV] Max poll attempts reached without completion');
}

// ── Main handler ───────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });
  }

  try {
    const body = await req.json();

    // ── Poll mode: self-call from a previous invocation ─────────────────────
    if (body.redo_poll_mode) {
      const { task_id, polling_id, polling_url, video_model, video_duration, poll_attempt = 0, resubmit_count = 0 } = body;
      const feedback = sanitizeFeedback(body.feedback);

      if (!task_id || !polling_id) {
        return new Response(
          JSON.stringify({ error: 'redo_poll_mode: missing task_id or polling_id' }),
          { status: 400, headers: responseHeaders },
        );
      }

      // Fetch the task so completeRedoTask has all its fields
      const { data: task, error: taskErr } = await supabase
        .from('TTV_tasks')
        .select('*')
        .eq('id', task_id)
        .single();

      if (taskErr || !task) {
        return new Response(JSON.stringify({ error: 'Task not found' }), { status: 404, headers: responseHeaders });
      }

      // If redo_status is already null the task was completed by a concurrent self-call
      if (!task.redo_status) {
        console.log(`[redo-TTV] poll_mode: task ${task_id} already completed — skipping`);
        return new Response(JSON.stringify({ status: 'already_done' }), { status: 200, headers: responseHeaders });
      }

      // Return 200 immediately; do the actual work in waitUntil
      const response = new Response(
        JSON.stringify({ status: 'polling', task_id, poll_attempt }),
        { status: 200, headers: responseHeaders },
      );

      EdgeRuntime.waitUntil(
        (async () => {
          try {
            await sleep(30_000); // brief delay before polling

            const pollResult = await callGenerateTTV({
              mode: 'poll',
              video_model: video_model ?? task.video_model,
              polling_id,
              polling_url: polling_url ?? null,
            });

            if (pollResult.status === 'completed') {
              await completeRedoTask(task, pollResult.video_url, pollResult.sora_job_id);
            } else if (pollResult.status === 'failed') {
              const errMsg = errorToString(pollResult.error) || 'Video generation failed';
              console.warn(`[redo-TTV] poll_mode: poll returned failed for task ${task_id}: ${errMsg}`);

              // Resubmit a fresh job if under the limit
              if (resubmit_count < MAX_RESUBMITS) {
                const basePrompt = task.batch?.[0]?.prompt as string;
                if (!basePrompt) throw new Error('Cannot resubmit — no prompt in task batch');
                const prompt = applyFeedback(basePrompt, feedback);
                console.log(`[redo-TTV] poll_mode: resubmitting fresh job (resubmit ${resubmit_count + 1}/${MAX_RESUBMITS}) for task ${task_id}`);
                const freshResult = await callGenerateTTV({
                  mode: 'submit',
                  video_model: video_model ?? task.video_model,
                  prompt,
                  video_duration: video_duration ?? task.video_duration,
                  audio_clip: task.audio_clip ?? false,
                });
                if (freshResult.status === 'completed' && (freshResult.video_url || freshResult.sora_job_id)) {
                  await completeRedoTask(task, freshResult.video_url, freshResult.sora_job_id);
                  return;
                }
                if (!freshResult.polling_id) throw new Error('Resubmit returned no polling_id');
                // Fire a new self-call chain with the fresh polling_id
                await firePollSelfCall(task, freshResult.polling_id, freshResult.polling_url ?? null, 0, resubmit_count + 1, feedback);
                return;
              }
              throw new Error(`Video generation failed after ${resubmit_count} resubmits: ${errMsg}`);
            } else {
              // Still pending – fire another self-call if within limit
              const nextAttempt = (poll_attempt ?? 0) + 1;
              if (nextAttempt < MAX_TOTAL_POLL_ATTEMPTS) {
                await firePollSelfCall(task, polling_id, polling_url, nextAttempt, resubmit_count, feedback);
              } else {
                throw new Error('[redo-TTV] Max poll self-call attempts reached');
              }
            }
          } catch (e: any) {
            console.error(`[redo-TTV] poll_mode background error for task ${task_id}:`, e.message);
            await logError('redo-TTV poll_mode error', e);
            await supabase
              .from('TTV_tasks')
              .update({ redo_status: 'failed', updated_at: new Date().toISOString() })
              .eq('id', task_id);
          }
        })(),
      );

      return response;
    }

    // ── Initial redo request ─────────────────────────────────────────────────
    const { group_id, batch_number } = body;
    const feedback = sanitizeFeedback(body.feedback);

    if (!group_id || batch_number == null) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: group_id or batch_number' }),
        { status: 400, headers: responseHeaders },
      );
    }

    // Authenticate via Bearer token
    const authHeader = req.headers.get('Authorization');
    const jwtUserId = await getUserIdFromToken(authHeader);

    if (!jwtUserId) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized — valid Bearer token required' }),
        { status: 401, headers: responseHeaders },
      );
    }

    // Fetch the TTV task
    const { data: task, error: taskErr } = await supabase
      .from('TTV_tasks')
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

    // Check user has enough tokens for one video
    const { data: planData } = await supabase
      .from('user_plans')
      .select('plan_type, tokens_used, rollover_tokens, is_legacy_plan')
      .eq('user_id', jwtUserId)
      .eq('is_active', true)
      .single();

    if (!planData) {
      return new Response(
        JSON.stringify({ error: 'User plan not found' }),
        { status: 403, headers: responseHeaders },
      );
    }

    const planType = planData.plan_type || 'free';
    const isLegacy = planData.is_legacy_plan !== false;
    const tps = ttvTokensPerSecond(isLegacy, task.video_model, !!task.audio_clip);
    const requiredTokens = Math.round((task.video_duration ?? 5) * tps);
    const tokensRemaining = planMaxTokensForUser(planType, isLegacy) - (planData.tokens_used || 0) + (planData.rollover_tokens || 0);

    if (tokensRemaining < requiredTokens) {
      return new Response(
        JSON.stringify({
          error: `Insufficient tokens for redo. Required: ${requiredTokens}, Available: ${tokensRemaining}`,
        }),
        { status: 403, headers: responseHeaders },
      );
    }

    // Extract the video prompt from the task's batch column
    if (!task.batch || !Array.isArray(task.batch) || task.batch.length === 0 || !task.batch[0]?.prompt) {
      return new Response(
        JSON.stringify({ error: 'No video prompt found in task batch data' }),
        { status: 400, headers: responseHeaders },
      );
    }

    const prompt = applyFeedback(task.batch[0].prompt as string, feedback);

    // Mark task as redoing (status stays 'completed_final')
    const { error: updateErr } = await supabase
      .from('TTV_tasks')
      .update({
        redo_status: 'redoing',
        redo_started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id);

    if (updateErr) {
      return new Response(
        JSON.stringify({ error: 'Failed to update task for redo' }),
        { status: 500, headers: responseHeaders },
      );
    }

    // Return 202 immediately
    const response = new Response(
      JSON.stringify({
        status: 'processing',
        message: 'TTV redo started — video is being regenerated',
        group_id,
        batch_number,
      }),
      { status: 202, headers: responseHeaders },
    );

    const redoTask = task;
    const isLongPoll = LONG_POLL_MODELS.has(redoTask.video_model);

    EdgeRuntime.waitUntil(
      (async () => {
        try {
          // Submit the video generation job
          const submitResult = await callGenerateTTV({
            mode: 'submit',
            video_model: redoTask.video_model,
            prompt,
            video_duration: redoTask.video_duration,
            audio_clip: redoTask.audio_clip ?? false,
          });

          console.log(
            `[redo-TTV] Submitted job for task ${redoTask.id} (model=${redoTask.video_model}):`,
            JSON.stringify(submitResult).slice(0, 200),
          );

          // If the model returned video immediately (rare / very fast models)
          if (
            submitResult.status === 'completed' &&
            (submitResult.video_url || submitResult.sora_job_id)
          ) {
            await completeRedoTask(redoTask, submitResult.video_url, submitResult.sora_job_id);
            return;
          }

          const pollingId: string = submitResult.polling_id;
          const pollingUrl: string | undefined = submitResult.polling_url;

          if (!pollingId) {
            throw new Error('No polling_id returned from generate-TTV');
          }

          if (isLongPoll) {
            // Long models: sleep the initial delay then hand off to self-call chain
            const initialDelay = INITIAL_POLL_DELAY_MS[redoTask.video_model] ?? 360_000;
            const safeDelay = Math.min(initialDelay, MAX_WAIT_MS);
            console.log(
              `[redo-TTV] Long-poll model ${redoTask.video_model} — sleeping ${safeDelay} ms before first poll`,
            );
            await sleep(safeDelay);
            await firePollSelfCall(redoTask, pollingId, pollingUrl, 0, 0, feedback);
          } else {
            // Short models: poll in-process
            const initialDelay = INITIAL_POLL_DELAY_MS[redoTask.video_model] ?? 90_000;
            console.log(
              `[redo-TTV] Short-poll model ${redoTask.video_model} — sleeping ${initialDelay} ms before first poll`,
            );
            await sleep(initialDelay);
            await pollUntilDone(redoTask, pollingId, pollingUrl, 0, 0, feedback);
          }
        } catch (e: any) {
          console.error(`[redo-TTV] Background error for task ${task.id}:`, e.message);
          await logError('redo-TTV background error', e);
          await supabase
            .from('TTV_tasks')
            .update({ redo_status: 'failed', updated_at: new Date().toISOString() })
            .eq('id', task.id);
        }
      })(),
    );

    return response;
  } catch (e: any) {
    await logError('redo-TTV unhandled error', e);
    return new Response(
      JSON.stringify({ error: e.message || 'Internal server error' }),
      { status: 500, headers: responseHeaders },
    );
  }
});
