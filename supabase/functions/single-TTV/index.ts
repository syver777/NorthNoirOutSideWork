// single-TTV/index.ts
// Generates a single video clip from a user-supplied prompt.
//
// Flow:
//   1. Authenticate + validate inputs
//   2. Check token balance: video_duration × TOKENS_PER_SECOND[video_model]
//   3. Insert TTV_tasks row (single_ttv: true, variant: 0)
//   4. Return 202 immediately with { task_id, group_id }
//   5. EdgeRuntime.waitUntil → submit to generate-TTV
//      Short models: poll in-process (seedance, ltx, grok, veo*)
//      Long models: sleep initial delay then fire self-call chain (sora)
//   6. On completion: download, strip audio if needed, upload to storage,
//      create story_documents row (version 14), update TTV_tasks to completed_final.
//
// Self-call poll mode: { single_ttv_poll_mode: true, task_id, polling_id, polling_url?, video_model, video_duration, poll_attempt }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import OpenAI from 'npm:openai@6';
import { getCorsHeaders } from '../_shared/cors.ts';
import {
  getIsLegacyPlan,
  ttvTokensPerSecond,
  LEGACY_TTV_TOKENS_PER_SECOND,
} from '../_shared/tokenCosts.ts';
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

// Models that need a self-call chain (initial wait >= 180 s)
const LONG_POLL_MODELS = new Set(['sora2pro', 'sora2pro_highres']);

// Initial sleep before first poll attempt (ms)
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

const MAX_TOTAL_POLL_ATTEMPTS = 60;
// Leave ~60 s safety buffer before the 400 s edge function hard limit
const MAX_WAIT_MS = 340_000;

// Models that always generate audio (strip it unless audio_clip is requested)
const ALWAYS_AUDIO_MODELS = new Set(['grok', 'grok_highres', 'sora2pro', 'sora2pro_highres']);

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

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

// ── Pure-JS MP4 audio stripper (mirrors process-TTV) ──────────────────────────
function _u32(b: Uint8Array, o: number): number {
  return (((b[o] << 24) | (b[o+1] << 16) | (b[o+2] << 8) | b[o+3]) >>> 0);
}
function _concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}
function _boxes(buf: Uint8Array, s: number, e: number): { s: number; z: number; t: string }[] {
  const list: { s: number; z: number; t: string }[] = [];
  let p = s;
  while (p + 8 <= e) {
    let z = _u32(buf, p);
    const t = String.fromCharCode(buf[p+4], buf[p+5], buf[p+6], buf[p+7]);
    if (z === 1) { if (_u32(buf, p + 8) !== 0) break; z = _u32(buf, p + 12); }
    else if (z === 0) { z = e - p; }
    if (z < 8 || p + z > e) break;
    list.push({ s: p, z, t });
    p += z;
  }
  return list;
}
function _isSoundTrak(buf: Uint8Array, ts: number, tz: number): boolean {
  for (const mdia of _boxes(buf, ts + 8, ts + tz).filter(b => b.t === 'mdia')) {
    for (const hdlr of _boxes(buf, mdia.s + 8, mdia.s + mdia.z).filter(b => b.t === 'hdlr')) {
      const htOff = hdlr.s + 8 + 4 + 4;
      if (htOff + 4 <= buf.length) {
        const ht = String.fromCharCode(buf[htOff], buf[htOff+1], buf[htOff+2], buf[htOff+3]);
        if (ht === 'soun') return true;
      }
    }
  }
  return false;
}
function _patchChunkOffsets(buf: Uint8Array, delta: number): void {
  function walk(start: number, end: number): void {
    for (const box of _boxes(buf, start, end)) {
      if (box.t === 'stco') {
        const count = _u32(buf, box.s + 12);
        for (let i = 0; i < count; i++) {
          const off = box.s + 16 + i * 4;
          const v = _u32(buf, off) - delta;
          buf[off] = (v >>> 24) & 0xff; buf[off+1] = (v >>> 16) & 0xff;
          buf[off+2] = (v >>> 8) & 0xff; buf[off+3] = v & 0xff;
        }
      } else if (box.t === 'co64') {
        const count = _u32(buf, box.s + 12);
        for (let i = 0; i < count; i++) {
          const off = box.s + 16 + i * 8;
          const hi = _u32(buf, off); const lo = _u32(buf, off + 4);
          const v = hi * 4294967296 + lo - delta;
          const nhi = Math.floor(v / 4294967296); const nlo = v >>> 0;
          buf[off] = (nhi >>> 24) & 0xff; buf[off+1] = (nhi >>> 16) & 0xff;
          buf[off+2] = (nhi >>> 8) & 0xff; buf[off+3] = nhi & 0xff;
          buf[off+4] = (nlo >>> 24) & 0xff; buf[off+5] = (nlo >>> 16) & 0xff;
          buf[off+6] = (nlo >>> 8) & 0xff; buf[off+7] = nlo & 0xff;
        }
      } else if (['moov','trak','mdia','minf','stbl','udta'].includes(box.t)) {
        walk(box.s + 8, box.s + box.z);
      }
    }
  }
  walk(0, buf.length);
}

function stripAudio(input: Uint8Array): Uint8Array {
  const boxes = _boxes(input, 0, input.length);
  const moovBox = boxes.find(b => b.t === 'moov');
  if (!moovBox) return input;
  const traks = _boxes(input, moovBox.s + 8, moovBox.s + moovBox.z).filter(b => b.t === 'trak');
  const soundTraks = traks.filter(t => _isSoundTrak(input, t.s, t.z));
  if (soundTraks.length === 0) return input;

  let moovBytes = new Uint8Array(input.slice(moovBox.s, moovBox.s + moovBox.z));
  let removedBytes = 0;
  for (const st of soundTraks.slice().reverse()) {
    const relS = st.s - moovBox.s;
    const before = moovBytes.slice(0, relS - removedBytes);
    const after = moovBytes.slice(relS - removedBytes + st.z);
    moovBytes = _concat(before, after);
    removedBytes += st.z;
  }
  const newMoovSize = moovBytes.length;
  moovBytes[0] = (newMoovSize >>> 24) & 0xff; moovBytes[1] = (newMoovSize >>> 16) & 0xff;
  moovBytes[2] = (newMoovSize >>> 8) & 0xff;  moovBytes[3] = newMoovSize & 0xff;

  const delta = moovBox.z - newMoovSize;
  const beforeMoov = input.slice(0, moovBox.s);
  const afterMoov = input.slice(moovBox.s + moovBox.z);
  const result = _concat(beforeMoov, moovBytes, afterMoov);
  if (delta > 0) _patchChunkOffsets(result, delta);
  return result;
}

// ── Complete single TTV task ───────────────────────────────────────────────────
async function completeSingleTTVTask(
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
    audio_clip: audioClip,
    tab,
    variant,
  } = task;

  console.log(`[single-TTV] Completing task ${taskId} (model=${videoModel})`);

  // Download video bytes
  let videoBytes = await downloadVideo(videoModel, videoUrl, soraJobId);

  // Strip audio from models that always generate it (unless audio_clip requested)
  if (ALWAYS_AUDIO_MODELS.has(videoModel) && !audioClip) {
    try {
      videoBytes = stripAudio(videoBytes);
      console.log(`[single-TTV] Audio stripped for model ${videoModel}`);
    } catch (e: any) {
      console.warn(`[single-TTV] Audio strip failed: ${e.message} — using original bytes`);
    }
  }

  const sanitized = sanitizeTitle(
    storyTitle.replace(/^Single TTV:\s*/i, '').replace(/^TTV:\s*/i, ''),
  );
  const storagePath = `documents/${userId}/${groupId}/TTV-${sanitized}_${folderTimestamp}/1.mp4`;

  // Upload to storage (upsert)
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { error } = await supabase.storage
        .from('stories')
        .upload(storagePath, videoBytes, { contentType: 'video/mp4', upsert: true });
      if (error) throw new Error(`Storage upload error: ${error.message}`);
      console.log(`[single-TTV] Uploaded to ${storagePath}`);
      break;
    } catch (e: any) {
      if (attempt < maxAttempts) {
        console.warn(`[single-TTV] Upload attempt ${attempt} failed: ${e.message} — retrying in 5 s`);
        await sleep(5_000);
      } else throw e;
    }
  }

  // Calculate tokens
  const isLegacy = await getIsLegacyPlan(userId);
  const tps = ttvTokensPerSecond(isLegacy, videoModel, !!audioClip);
  const tokens = Math.round((videoDuration ?? 5) * tps);

  // Update TTV_tasks row
  const { error: updateErr } = await supabase
    .from('TTV_tasks')
    .update({
      status: 'completed_final',
      video_url: storagePath,
      tokens,
      token_updated: true,
      progress: 100,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  if (updateErr) {
    throw new Error(`Failed to update task: ${updateErr.message}`);
  }

  console.log(`[single-TTV] Task ${taskId} completed. Tokens: ${tokens}`);
}

// ── Self-call for poll chain ───────────────────────────────────────────────────
async function firePollSelfCall(
  task: Record<string, any>,
  pollingId: string,
  pollingUrl: string | null | undefined,
  pollAttempt: number,
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/functions/v1/single-TTV`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        single_ttv_poll_mode: true,
        task_id: task.id,
        polling_id: pollingId,
        polling_url: pollingUrl ?? null,
        video_model: task.video_model,
        video_duration: task.video_duration,
        poll_attempt: pollAttempt,
      }),
    });
    console.log(`[single-TTV] Fired self-call for poll attempt ${pollAttempt} (task ${task.id})`);
  } catch (e: any) {
    await logError(`Failed to fire poll self-call for single-TTV task ${task.id}`, e);
  }
}

// ── Delegate content-moderation failures to empty-redo-TTV ──────────────────
async function callEmptyRedoTTV(taskId: string): Promise<void> {
  console.log(`[single-TTV] Content moderation rejection for task ${taskId} — delegating to empty-redo-TTV for prompt rewrite`);
  try {
    await fetch(`${supabaseUrl}/functions/v1/empty-redo-TTV`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({ task_id: taskId }),
    });
  } catch (e: any) {
    await logError(`[single-TTV] Failed to call empty-redo-TTV for task ${taskId}`, e);
  }
}

// ── In-process poll loop for short models ────────────────────────────────────
async function pollUntilDone(
  task: Record<string, any>,
  pollingId: string,
  pollingUrl: string | null | undefined,
  startPollAttempt: number,
): Promise<void> {
  const { video_model: videoModel } = task;
  const startTime = Date.now();

  for (let attempt = startPollAttempt; attempt < MAX_TOTAL_POLL_ATTEMPTS; attempt++) {
    if (Date.now() - startTime > MAX_WAIT_MS - 60_000) {
      console.log(`[single-TTV] Time budget nearly exhausted at poll ${attempt} — firing self-call`);
      await firePollSelfCall(task, pollingId, pollingUrl, attempt);
      return;
    }

    await sleep(30_000);

    try {
      const pollResult = await callGenerateTTV({
        mode: 'poll',
        video_model: videoModel,
        polling_id: pollingId,
        polling_url: pollingUrl ?? null,
      });

      if (pollResult.status === 'completed') {
        await completeSingleTTVTask(task, pollResult.video_url, pollResult.sora_job_id);
        return;
      } else if (pollResult.status === 'failed') {
        if (pollResult.error === 'content_moderation') {
          console.log(`[single-TTV] Poll attempt ${attempt} — content moderation rejection for task ${task.id}, delegating to empty-redo-TTV`);
          await callEmptyRedoTTV(task.id);
          return;
        }
        throw new Error(`Video generation failed: ${pollResult.error || 'Unknown error'}`);
      }
      // still pending → continue loop
    } catch (e: any) {
      console.error(`[single-TTV] Poll attempt ${attempt} error:`, e.message);
      if (attempt >= MAX_TOTAL_POLL_ATTEMPTS - 1) throw e;
    }
  }

  throw new Error('[single-TTV] Max poll attempts reached without completion');
}

// ── Main handler ───────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: responseHeaders });
  }

  try {
    // ── Poll mode: self-call from a previous invocation ──────────────────────
    if (body.single_ttv_poll_mode) {
      const { task_id, polling_id, polling_url, video_model, video_duration, poll_attempt = 0 } = body;

      if (!task_id || !polling_id) {
        return new Response(
          JSON.stringify({ error: 'single_ttv_poll_mode: missing task_id or polling_id' }),
          { status: 400, headers: responseHeaders },
        );
      }

      const { data: task, error: taskErr } = await supabase
        .from('TTV_tasks')
        .select('*')
        .eq('id', task_id)
        .single();

      if (taskErr || !task) {
        return new Response(JSON.stringify({ error: 'Task not found' }), { status: 404, headers: responseHeaders });
      }

      // If already completed, skip
      if (task.status === 'completed_final') {
        console.log(`[single-TTV] poll_mode: task ${task_id} already completed — skipping`);
        return new Response(JSON.stringify({ status: 'already_done' }), { status: 200, headers: responseHeaders });
      }

      const response = new Response(
        JSON.stringify({ status: 'polling', task_id, poll_attempt }),
        { status: 200, headers: responseHeaders },
      );

      EdgeRuntime.waitUntil(
        (async () => {
          try {
            await sleep(30_000);

            const pollResult = await callGenerateTTV({
              mode: 'poll',
              video_model: video_model ?? task.video_model,
              polling_id,
              polling_url: polling_url ?? null,
            });

            if (pollResult.status === 'completed') {
              await completeSingleTTVTask(task, pollResult.video_url, pollResult.sora_job_id);
            } else if (pollResult.status === 'failed') {
              if (pollResult.error === 'content_moderation') {
                console.log(`[single-TTV] poll_mode — content moderation rejection for task ${task_id}, delegating to empty-redo-TTV`);
                await callEmptyRedoTTV(task_id);
              } else {
                throw new Error(pollResult.error || 'Video generation failed');
              }
            } else {
              const nextAttempt = (poll_attempt ?? 0) + 1;
              if (nextAttempt < MAX_TOTAL_POLL_ATTEMPTS) {
                await firePollSelfCall(task, polling_id, polling_url, nextAttempt);
              } else {
                throw new Error('[single-TTV] Max poll self-call attempts reached');
              }
            }
          } catch (e: any) {
            console.error(`[single-TTV] poll_mode background error for task ${task_id}:`, e.message);
            await logError('single-TTV poll_mode error', e);
            await supabase
              .from('TTV_tasks')
              .update({ status: 'error', error: e.message, updated_at: new Date().toISOString() })
              .eq('id', task_id);
          }
        })(),
      );

      return response;
    }

    // ── Initial request ──────────────────────────────────────────────────────
    const {
      group_id,
      story_title,
      prompt,
      style_prompt = '',
      video_model,
      video_duration,
      audio_clip = false,
      tab = 1,
    } = body;

    const finalPrompt: string = style_prompt
      ? `${prompt}\n\nVisual style: ${style_prompt}`
      : prompt;

    if (!group_id || !story_title || !prompt || !video_model || video_duration == null) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: group_id, story_title, prompt, video_model, video_duration' }),
        { status: 400, headers: responseHeaders },
      );
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(group_id)) {
      return new Response(JSON.stringify({ error: 'Invalid group_id' }), { status: 400, headers: responseHeaders });
    }

    if (!(video_model in LEGACY_TTV_TOKENS_PER_SECOND)) {
      return new Response(JSON.stringify({ error: `Unsupported video_model: ${video_model}` }), { status: 400, headers: responseHeaders });
    }

    if (typeof video_duration !== 'number' || video_duration < 1 || video_duration > 60) {
      return new Response(JSON.stringify({ error: 'video_duration must be between 1 and 60 seconds' }), { status: 400, headers: responseHeaders });
    }

    // Authenticate via Bearer token
    const authHeader = req.headers.get('Authorization');
    const userId = await getUserIdFromToken(authHeader);

    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized — valid Bearer token required' }),
        { status: 401, headers: responseHeaders },
      );
    }

    // Check token balance
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
    const isLegacy = planData.is_legacy_plan !== false; // default to legacy on null/missing
    const tps = ttvTokensPerSecond(isLegacy, video_model, !!audio_clip);
    const requiredTokens = Math.round(video_duration * tps);
    const tokensRemaining = planMaxTokensForUser(planType, isLegacy) - (planData.tokens_used || 0) + (planData.rollover_tokens || 0);

    if (tokensRemaining < requiredTokens) {
      return new Response(
        JSON.stringify({
          error: `Insufficient tokens. Required: ${requiredTokens}, Available: ${tokensRemaining}`,
          code: 403,
        }),
        { status: 403, headers: responseHeaders },
      );
    }

    // Insert TTV_tasks row
    const folderTimestamp = new Date().toISOString().replace(/[-:T.]/g, '');
    const taskId = crypto.randomUUID();

    const { error: insertErr } = await supabase.from('TTV_tasks').insert({
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
      version: 1,
      video_model,
      video_duration,
      audio_clip,
      tab,
      variant: 0,
      single_ttv: true,
      folder_timestamp: folderTimestamp,
      batch: [{ prompt: finalPrompt }],
      tokens: 0,
      token_updated: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    if (insertErr) {
      await logError('single-TTV task insert error', insertErr);
      return new Response(
        JSON.stringify({ error: `Failed to create task: ${insertErr.message}` }),
        { status: 500, headers: responseHeaders },
      );
    }

    const effectiveModel = video_model;
    const isLongPoll = LONG_POLL_MODELS.has(effectiveModel);

    // Return 202 immediately
    const response = new Response(
      JSON.stringify({
        status: 'processing',
        message: 'Single TTV generation started',
        task_id: taskId,
        group_id,
      }),
      { status: 202, headers: responseHeaders },
    );

    // Fetch full task for completeSingleTTVTask
    const taskRecord = {
      id: taskId,
      user_id: userId,
      group_id,
      story_title,
      video_model: effectiveModel,
      video_duration,
      audio_clip,
      tab,
      variant: 0,
      folder_timestamp: folderTimestamp,
    };

    EdgeRuntime.waitUntil(
      (async () => {
        try {
          // Submit to generate-TTV
          const submitResult = await callGenerateTTV({
            mode: 'submit',
            video_model: effectiveModel,
            prompt: finalPrompt,
            video_duration,
            audio_clip,
          });

          console.log(
            `[single-TTV] Submitted job for task ${taskId} (model=${effectiveModel}):`,
            JSON.stringify(submitResult).slice(0, 200),
          );

          // Immediate completion (very fast models / cached)
          if (submitResult.status === 'completed' && (submitResult.video_url || submitResult.sora_job_id)) {
            await completeSingleTTVTask(taskRecord, submitResult.video_url, submitResult.sora_job_id);
            return;
          }

          const pollingId: string = submitResult.polling_id;
          const pollingUrl: string | undefined = submitResult.polling_url;

          if (!pollingId) throw new Error('No polling_id returned from generate-TTV');

          if (isLongPoll) {
            const initialDelay = INITIAL_POLL_DELAY_MS[effectiveModel] ?? 360_000;
            const safeDelay = Math.min(initialDelay, MAX_WAIT_MS);
            console.log(`[single-TTV] Long-poll model ${effectiveModel} — sleeping ${safeDelay} ms`);
            await sleep(safeDelay);
            await firePollSelfCall(taskRecord, pollingId, pollingUrl, 0);
          } else {
            const initialDelay = INITIAL_POLL_DELAY_MS[effectiveModel] ?? 90_000;
            console.log(`[single-TTV] Short-poll model ${effectiveModel} — sleeping ${initialDelay} ms`);
            await sleep(initialDelay);
            await pollUntilDone(taskRecord, pollingId, pollingUrl, 0);
          }
        } catch (e: any) {
          console.error(`[single-TTV] Background error for task ${taskId}:`, e.message);
          await logError('single-TTV background error', e);
          await supabase
            .from('TTV_tasks')
            .update({ status: 'error', error: e.message, updated_at: new Date().toISOString() })
            .eq('id', taskId);
        }
      })(),
    );

    return response;

  } catch (e: any) {
    await logError('single-TTV unhandled error', e);
    return new Response(
      JSON.stringify({ error: e.message || 'Internal server error' }),
      { status: 500, headers: responseHeaders },
    );
  }
});
