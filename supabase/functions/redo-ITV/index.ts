// redo-ITV/index.ts
// Handles redo of a single ITV video clip.
//
// Two modes:
//   Initial request: { group_id, batch_number }
//     - Authenticates user via Bearer token OR { user_id } in body with service-role key
//       (the latter is used when redo-image chains into this function after regenerating the keyframe)
//     - Fetches the ITV_task, validates tokens
//     - Updates ITV_tasks.image_url to the new image if provided in body
//     - Sets redo_status = 'redoing' on the task (if not already set)
//     - Returns 202 immediately
//     - In waitUntil: submits to generate-ITV, then polls until done
//     - Polls in-process with self-call fallback
//
//   Poll mode: { redo_poll_mode: true, task_id, polling_id, polling_url?, video_model, video_duration, poll_attempt }
//     - Server-side self-call; uses service role key
//     - Polls once; if still pending fires another self-call; if done completes the task
//
// On completion:
//   - Downloads video, uploads to same storage path (upsert → overwrites old clip)
//   - Updates ITV_tasks: clears redo_status/redo_started_at, sets new video_url, charges tokens
//   - Status remains 'completed_final' throughout

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';
import { getIsLegacyPlan, itvTokensPerSecond } from '../_shared/tokenCosts.ts';
import { planMaxTokensForUser } from '../_shared/planMaps.ts';

// ── Env ────────────────────────────────────────────────────────────────────────
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// corsHeaders is now set dynamically inside the serve handler via getCorsHeaders(req)

// ── Constants ──────────────────────────────────────────────────────────────────
// Per-action ITV token costs are resolved per-user via tokenCosts.ts
// (legacy users keep historical rates; new users hit the calibrated
// NEW_ITV_* map). Always use itvTokensPerSecond(...) at billing time.

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

// Initial sleep before first poll attempt (all fal.ai — 90 s)
const INITIAL_POLL_DELAY_MS: Record<string, number> = {
  wan22: 90_000,
  seedance1fast: 90_000,
  hailuo23fast: 90_000,
  seedance15: 90_000,
  ltx23fast: 90_000,
  veo31fast: 90_000,
  ltx23pro: 90_000,
  veo31: 90_000,
  ltx23pro4k: 90_000,
};

// Models with initial delay ≥ 180 s: one poll per invocation, chain via self-calls
// (currently empty — all models use fal.ai with 90 s delay)
const LONG_POLL_MODELS = new Set<string>();

// Max redo poll self-call chain depth (10 × 6 min = 60 min — within fal.ai's 1-hour result expiry)
const MAX_TOTAL_POLL_ATTEMPTS = 10;

// Leave ~60 s safety buffer before the 400 s edge function hard limit
const MAX_WAIT_MS = 340_000;

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

async function callGenerateITV(body: Record<string, any>): Promise<any> {
  const res = await fetch(`${supabaseUrl}/functions/v1/generate-ITV`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseServiceRoleKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`generate-ITV HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function downloadVideo(videoUrl: string): Promise<Uint8Array> {
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Video download HTTP ${res.status} from ${videoUrl.slice(0, 100)}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

// Check if an error indicates a fal.ai polling ID expiry requiring resubmission
function isExpiredError(errorMsg: any): boolean {
  const msg = (errorMsg?.message || errorMsg || '').toString().toLowerCase();
  return msg.includes('expired') && msg.includes('resubmit');
}

function sanitizeFeedback(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, 250);
}

function applyFeedback(prompt: string, feedback: string): string {
  if (!feedback) return prompt;
  return `${prompt}\n\nUser feedback for revision: ${feedback}`;
}

// Resubmit the video generation job after a fal.ai expiry and return new polling info
async function resubmitJob(
  task: Record<string, any>,
  feedback = '',
): Promise<{ pollingId: string; pollingUrl?: string; videoUrl?: string }> {
  const basePrompt = task.batch?.[0]?.prompt;
  if (!basePrompt) throw new Error('Cannot resubmit: no prompt found in task');
  const prompt = applyFeedback(basePrompt, feedback);

  // Resolve image URL — fal.ai cannot download raw Supabase storage URLs.
  // Handle both bare paths and full Supabase https URLs (mirrors process-ITV logic).
  let imageUrl = task.image_url;
  if (imageUrl && !imageUrl.startsWith('http')) {
    const { data } = await supabase.storage.from('stories').createSignedUrl(imageUrl, 7200);
    if (data?.signedUrl) imageUrl = data.signedUrl;
  } else if (imageUrl && imageUrl.includes('/storage/v1/object/')) {
    const storagePathMatch = imageUrl.match(/\/storage\/v1\/object\/(?:public\/)?stories\/(.+)$/);
    if (storagePathMatch) {
      const storagePath = decodeURIComponent(storagePathMatch[1]);
      const { data } = await supabase.storage.from('stories').createSignedUrl(storagePath, 7200);
      if (data?.signedUrl) imageUrl = data.signedUrl;
    }
  }

  // wan22 now uses fal.ai directly — no model conversion needed
  const effectiveModel = task.video_model;

  console.log(`[redo-ITV] Resubmitting job for task ${task.id} (model=${effectiveModel})`);

  const submitResult = await callGenerateITV({
    mode: 'submit',
    video_model: effectiveModel,
    prompt,
    image_url: imageUrl,
    video_duration: task.video_duration,
    audio_clip: task.audio_clip ?? false,
  });

  console.log(`[redo-ITV] Resubmit result:`, JSON.stringify(submitResult).slice(0, 200));

  if (submitResult.status === 'completed' && submitResult.video_url) {
    return { pollingId: '', videoUrl: submitResult.video_url };
  }

  if (!submitResult.polling_id) {
    throw new Error('Resubmit failed: no polling_id returned');
  }

  return { pollingId: submitResult.polling_id, pollingUrl: submitResult.polling_url };
}

// ── Pure-JS MP4 audio stripper ──────────────────────────────────────────────────
// Removes all 'soun' (audio) trak boxes from the moov container.
// No FFmpeg / WASM / Worker required. Mirrors process-TTV.

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
    if (z === 1) {
      if (_u32(buf, p + 8) !== 0) break;
      z = _u32(buf, p + 12);
    } else if (z === 0) {
      z = e - p;
    }
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
          const patched = (_u32(buf, off) - delta) >>> 0;
          buf[off]     = (patched >>> 24) & 0xff;
          buf[off + 1] = (patched >>> 16) & 0xff;
          buf[off + 2] = (patched >>>  8) & 0xff;
          buf[off + 3] =  patched         & 0xff;
        }
      } else if (box.t === 'co64') {
        const count = _u32(buf, box.s + 12);
        for (let i = 0; i < count; i++) {
          const off = box.s + 16 + i * 8;
          const patched = (_u32(buf, off + 4) - delta) >>> 0;
          buf[off + 4] = (patched >>> 24) & 0xff;
          buf[off + 5] = (patched >>> 16) & 0xff;
          buf[off + 6] = (patched >>>  8) & 0xff;
          buf[off + 7] =  patched         & 0xff;
        }
      } else if (['trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex'].includes(box.t)) {
        walk(box.s + 8, box.s + box.z);
      }
    }
  }
  walk(0, buf.length);
}

function stripAudioFromMp4(bytes: Uint8Array): Uint8Array {
  try {
    const topBoxes = _boxes(bytes, 0, bytes.length);
    const moovBox = topBoxes.find(b => b.t === 'moov');
    if (!moovBox) {
      console.log('stripAudio: no moov box — returning original');
      return bytes;
    }
    const keptParts: Uint8Array[] = [];
    let removed = 0;
    for (const child of _boxes(bytes, moovBox.s + 8, moovBox.s + moovBox.z)) {
      if (child.t === 'trak' && _isSoundTrak(bytes, child.s, child.z)) {
        removed++;
        continue;
      }
      keptParts.push(bytes.slice(child.s, child.s + child.z));
    }
    if (removed === 0) {
      console.log('stripAudio: no audio tracks found — returning original');
      return bytes;
    }
    const keptContent = _concat(...keptParts);
    const newMoovSize = 8 + keptContent.length;
    const sizeDiff = moovBox.z - newMoovSize;
    if (sizeDiff > 0) {
      const mdatBox = topBoxes.find(b => b.t === 'mdat');
      if (mdatBox && mdatBox.s > moovBox.s) {
        _patchChunkOffsets(keptContent, sizeDiff);
        console.log(`stripAudio: patched stco/co64 offsets by -${sizeDiff} (moov-before-mdat layout)`);
      }
    }
    const hdr = new Uint8Array(8);
    hdr[0] = (newMoovSize >>> 24) & 0xff;
    hdr[1] = (newMoovSize >>> 16) & 0xff;
    hdr[2] = (newMoovSize >>>  8) & 0xff;
    hdr[3] =  newMoovSize         & 0xff;
    hdr.set([0x6d, 0x6f, 0x6f, 0x76], 4); // 'moov'
    console.log(`stripAudio: removed ${removed} audio track(s), moov shrunk by ${sizeDiff} bytes`);
    return _concat(
      bytes.slice(0, moovBox.s),
      hdr,
      keptContent,
      bytes.slice(moovBox.s + moovBox.z),
    );
  } catch (e: any) {
    console.warn(`stripAudio: error — ${e.message} — returning original`);
    return bytes;
  }
}

// Download video → upload to storage (overwrite) → update ITV_tasks row
async function completeRedoTask(
  task: Record<string, any>,
  videoUrl: string,
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

  console.log(`[redo-ITV] Completing redo for task ${taskId} (batch ${batchNumber})`);

  // Download video bytes
  const rawVideoBytes = await downloadVideo(videoUrl);

  // seedance15 always generates audio regardless of user setting — strip when not requested.
  const shouldStripAudio = videoModel === 'seedance15' && !audioClip;
  const videoBytes = shouldStripAudio ? stripAudioFromMp4(rawVideoBytes) : rawVideoBytes;
  if (shouldStripAudio) console.log(`[redo-ITV] Stripping audio from seedance15 output for task ${taskId}`);

  // Build the same storage path used during original generation
  const cleanTitle = (storyTitle ?? '')
    .replace(/^ITV Prompt:\s*/i, '')
    .replace(/^ITV Prompts:\s*/i, '')
    .replace(/^ITV Outputs?:\s*/i, '')
    .trim();
  const sanitized = sanitizeTitle(cleanTitle);
  const storagePath = `documents/${userId}/${groupId}/ITV-${sanitized}_${folderTimestamp}/${batchNumber}.mp4`;

  // Upload (upsert → overwrites the old clip)
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { error } = await supabase.storage
        .from('stories')
        .upload(storagePath, videoBytes, { contentType: 'video/mp4', upsert: true });
      if (error) throw new Error(`Storage upload error: ${error.message}`);
      console.log(`[redo-ITV] Uploaded video to ${storagePath}`);
      break;
    } catch (e: any) {
      if (attempt < maxAttempts) {
        console.warn(`[redo-ITV] Upload attempt ${attempt} failed: ${e.message} — retrying in 5 s`);
        await sleep(5_000);
      } else throw e;
    }
  }

  // Calculate tokens for this video
  const isLegacy = await getIsLegacyPlan(userId);
  const tps = itvTokensPerSecond(isLegacy, videoModel, !!audioClip);
  const tokens = Math.round((videoDuration ?? 5) * tps);

  // Update task: clear redo fields, update video_url; status stays 'completed_final'
  const { error: updateErr } = await supabase
    .from('ITV_tasks')
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
    console.error(`[redo-ITV] Failed to update task ${taskId}:`, updateErr.message);
    throw new Error(`Failed to update task: ${updateErr.message}`);
  }

  console.log(`[redo-ITV] Redo complete for task ${taskId}`);
}

// Fire a self-call for the next poll attempt
async function firePollSelfCall(
  task: Record<string, any>,
  pollingId: string,
  pollingUrl: string | null | undefined,
  pollAttempt: number,
  feedback = '',
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/functions/v1/redo-ITV`, {
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
        feedback,
      }),
    });
    console.log(`[redo-ITV] Fired self-call for poll attempt ${pollAttempt} (task ${task.id})`);
  } catch (e: any) {
    await logError(`Failed to fire poll self-call for redo-ITV task ${task.id}`, e);
  }
}

// In-process poll loop for short models
async function pollUntilDone(
  task: Record<string, any>,
  initialPollingId: string,
  initialPollingUrl: string | null | undefined,
  startPollAttempt: number,
  feedback = '',
): Promise<void> {
  const { video_model: videoModel } = task;
  const startTime = Date.now();
  let pollingId = initialPollingId;
  let pollingUrl: string | null | undefined = initialPollingUrl;

  for (let attempt = startPollAttempt; attempt < MAX_TOTAL_POLL_ATTEMPTS; attempt++) {
    // If time budget is nearly exhausted, delegate to a self-call
    if (Date.now() - startTime > MAX_WAIT_MS - 60_000) {
      console.log(`[redo-ITV] Time budget nearly exhausted at poll ${attempt} — firing self-call`);
      await firePollSelfCall(task, pollingId, pollingUrl, attempt, feedback);
      return;
    }

    await sleep(30_000);

    try {
      const pollResult = await callGenerateITV({
        mode: 'poll',
        video_model: videoModel,
        polling_id: pollingId,
        polling_url: pollingUrl ?? null,
      });

      if (pollResult.status === 'completed') {
        await completeRedoTask(task, pollResult.video_url);
        return;
      } else if (pollResult.status === 'failed') {
        // Check for fal.ai polling ID expiry — resubmit the job instead of failing
        if (isExpiredError(pollResult.error)) {
          console.log(`[redo-ITV] Polling ID expired at attempt ${attempt} — resubmitting job`);
          const resubmit = await resubmitJob(task, feedback);
          if (resubmit.videoUrl) {
            await completeRedoTask(task, resubmit.videoUrl);
            return;
          }
          // Save fresh polling info and continue the chain, counting toward MAX_TOTAL_POLL_ATTEMPTS
          await supabase
            .from('ITV_tasks')
            .update({
              polling_id: resubmit.pollingId,
              polling_url: resubmit.pollingUrl ?? null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', task.id);
          pollingId = resubmit.pollingId;
          pollingUrl = resubmit.pollingUrl;
          await firePollSelfCall(task, resubmit.pollingId, resubmit.pollingUrl ?? null, attempt + 1, feedback);
          return;
        }
        throw new Error(`Video generation failed: ${pollResult.error || 'Unknown error'}`);
      }
      // still pending → continue loop
    } catch (e: any) {
      // Also catch expired errors that surface as exceptions
      if (isExpiredError(e)) {
        console.log(`[redo-ITV] Polling ID expired (exception) at attempt ${attempt} — resubmitting job`);
        const resubmit = await resubmitJob(task, feedback);
        if (resubmit.videoUrl) {
          await completeRedoTask(task, resubmit.videoUrl);
          return;
        }
        await supabase
          .from('ITV_tasks')
          .update({
            polling_id: resubmit.pollingId,
            polling_url: resubmit.pollingUrl ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id);
        pollingId = resubmit.pollingId;
        pollingUrl = resubmit.pollingUrl;
        await firePollSelfCall(task, resubmit.pollingId, resubmit.pollingUrl ?? null, attempt + 1, feedback);
        return;
      }
      console.error(`[redo-ITV] Poll attempt ${attempt} error:`, e.message);
      if (attempt >= MAX_TOTAL_POLL_ATTEMPTS - 1) throw e;
    }
  }

  throw new Error('[redo-ITV] Max poll attempts reached without completion');
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
      const { task_id, polling_id, polling_url, video_model, video_duration, poll_attempt = 0 } = body;
      const feedback = sanitizeFeedback(body.feedback);

      if (!task_id || !polling_id) {
        return new Response(
          JSON.stringify({ error: 'redo_poll_mode: missing task_id or polling_id' }),
          { status: 400, headers: responseHeaders },
        );
      }

      // Fetch the task so completeRedoTask has all its fields
      const { data: task, error: taskErr } = await supabase
        .from('ITV_tasks')
        .select('*')
        .eq('id', task_id)
        .single();

      if (taskErr || !task) {
        return new Response(JSON.stringify({ error: 'Task not found' }), { status: 404, headers: responseHeaders });
      }

      // If redo_status is already null the task was completed by a concurrent self-call
      if (!task.redo_status) {
        console.log(`[redo-ITV] poll_mode: task ${task_id} already completed — skipping`);
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
            const effectivePollModel = video_model ?? task.video_model;
            const pollSleepMs = INITIAL_POLL_DELAY_MS[effectivePollModel]
              ?? INITIAL_POLL_DELAY_MS[task.video_model]
              ?? 90_000;
            await sleep(pollSleepMs);

            const nextAttempt = (poll_attempt ?? 0) + 1;

            const pollResult = await callGenerateITV({
              mode: 'poll',
              video_model: effectivePollModel,
              polling_id,
              polling_url: polling_url ?? null,
            });

            // Increment poll_attempts in DB for observability
            await supabase
              .from('ITV_tasks')
              .update({ poll_attempts: nextAttempt, updated_at: new Date().toISOString() })
              .eq('id', task_id);

            if (pollResult.status === 'completed') {
              await completeRedoTask(task, pollResult.video_url);
            } else if (pollResult.status === 'failed') {
              // Check for fal.ai polling ID expiry — resubmit the job
              if (isExpiredError(pollResult.error)) {
                console.log(`[redo-ITV] poll_mode: polling ID expired — resubmitting job`);
                const resubmit = await resubmitJob(task, feedback);
                if (resubmit.videoUrl) {
                  await completeRedoTask(task, resubmit.videoUrl);
                  return;
                }
                // Save fresh polling info and continue the chain (do NOT reset to 0)
                await supabase
                  .from('ITV_tasks')
                  .update({
                    polling_id: resubmit.pollingId,
                    polling_url: resubmit.pollingUrl ?? null,
                    updated_at: new Date().toISOString(),
                  })
                  .eq('id', task_id);
                await firePollSelfCall(task, resubmit.pollingId, resubmit.pollingUrl ?? null, nextAttempt, feedback);
                return;
              }
              throw new Error(pollResult.error || 'Video generation failed');
            } else {
              // Still pending – fire another self-call if within limit
              if (nextAttempt < MAX_TOTAL_POLL_ATTEMPTS) {
                await firePollSelfCall(task, polling_id, polling_url, nextAttempt, feedback);
              } else {
                throw new Error('[redo-ITV] Max poll self-call attempts reached');
              }
            }
          } catch (e: any) {
            // Check for fal.ai expiry before marking as failed
            if (isExpiredError(e)) {
              try {
                console.log(`[redo-ITV] poll_mode: caught expired error — resubmitting job`);
                const resubmit = await resubmitJob(task, feedback);
                if (resubmit.videoUrl) {
                  await completeRedoTask(task, resubmit.videoUrl);
                  return;
                }
                await supabase
                  .from('ITV_tasks')
                  .update({
                    polling_id: resubmit.pollingId,
                    polling_url: resubmit.pollingUrl ?? null,
                    updated_at: new Date().toISOString(),
                  })
                  .eq('id', task_id);
                await firePollSelfCall(task, resubmit.pollingId, resubmit.pollingUrl ?? null, (poll_attempt ?? 0) + 1, feedback);
                return;
              } catch (resubmitErr: any) {
                console.error(`[redo-ITV] Resubmit after expiry failed:`, resubmitErr.message);
                // Fall through to mark as failed
              }
            }
            console.error(`[redo-ITV] poll_mode background error for task ${task_id}:`, e.message);
            await logError('redo-ITV poll_mode error', e);
            const existingMode = (task.redo_status as any)?.mode ?? 'video_only';
            await supabase
              .from('ITV_tasks')
              .update({ redo_status: { status: 'failed', mode: existingMode }, updated_at: new Date().toISOString() })
              .eq('id', task_id);
          }
        })(),
      );

      return response;
    }

    // ── Initial redo request ─────────────────────────────────────────────────
    const { group_id, batch_number, new_image_url, mode: redoMode = 'video_only' } = body;
    const feedback = sanitizeFeedback(body.feedback);

    if (!group_id || batch_number == null) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: group_id or batch_number' }),
        { status: 400, headers: responseHeaders },
      );
    }

    // Authenticate: Bearer token (from frontend) OR user_id in body + service-role auth
    // (the latter is used when redo-image chains into this function after regenerating a keyframe)
    const authHeader = req.headers.get('Authorization');
    let userId: string | null = null;

    const jwtUserId = await getUserIdFromToken(authHeader);
    if (jwtUserId) {
      userId = jwtUserId;
    } else if (body.user_id) {
      // Server-to-server call from redo-image using service role key
      // Verify the auth header carries the service role key to prevent abuse
      const token = authHeader?.replace('Bearer ', '') ?? '';
      if (token === supabaseServiceRoleKey) {
        userId = body.user_id;
      }
    }

    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized — valid Bearer token or service-role key required' }),
        { status: 401, headers: responseHeaders },
      );
    }

    // Fetch the ITV task
    const { data: task, error: taskErr } = await supabase
      .from('ITV_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', group_id)
      .eq('batch_number', batch_number)
      .single();

    if (taskErr || !task) {
      return new Response(
        JSON.stringify({ error: `Task not found for group_id: ${group_id}, batch_number: ${batch_number}` }),
        { status: 404, headers: responseHeaders },
      );
    }

    // Check user has enough tokens for one video (skip check for server-to-server calls
    // since redo-image already validated the image token balance)
    const { data: planData } = await supabase
      .from('user_plans')
      .select('plan_type, tokens_used, rollover_tokens, is_legacy_plan')
      .eq('user_id', userId)
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
    const tps = itvTokensPerSecond(isLegacy, task.video_model, !!task.audio_clip);
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

    // Use new_image_url if provided (redo-image supplies the freshly generated image path)
    // otherwise fall back to the stored image_url on the task
    const imageUrl = new_image_url ?? task.image_url;

    if (!imageUrl) {
      return new Response(
        JSON.stringify({ error: 'No image_url available for ITV redo' }),
        { status: 400, headers: responseHeaders },
      );
    }

    // Resolve image_url to a signed URL.
    // Must cover both storage paths (no http) AND full Supabase public https URLs —
    // fal.ai cannot download Supabase storage URLs without a signed token.
    // Mirrors the same logic used by process-ITV before submitting to generate-ITV.
    let resolvedImageUrl = imageUrl;
    if (!imageUrl.startsWith('http')) {
      // Bare storage path — create signed URL directly
      const { data: signedData, error: signErr } = await supabase.storage
        .from('stories')
        .createSignedUrl(imageUrl, 7200);
      if (signErr || !signedData?.signedUrl) {
        return new Response(
          JSON.stringify({ error: 'Failed to create signed URL for keyframe image' }),
          { status: 500, headers: responseHeaders },
        );
      }
      resolvedImageUrl = signedData.signedUrl;
    } else if (imageUrl.includes('/storage/v1/object/')) {
      // Full Supabase https storage URL — extract path and re-sign
      const storagePathMatch = imageUrl.match(/\/storage\/v1\/object\/(?:public\/)?stories\/(.+)$/);
      if (storagePathMatch) {
        const storagePath = decodeURIComponent(storagePathMatch[1]);
        const { data: signedData, error: signErr } = await supabase.storage
          .from('stories')
          .createSignedUrl(storagePath, 7200);
        if (!signErr && signedData?.signedUrl) {
          resolvedImageUrl = signedData.signedUrl;
          console.log(`[redo-ITV] Re-signed Supabase storage URL for keyframe image (path=${storagePath})`);
        } else {
          console.warn(`[redo-ITV] Failed to re-sign image URL (${signErr?.message}) — using original`);
        }
      }
    }

    // All models now use fal.ai directly — no model conversion needed
    const effectiveVideoModel = task.video_model;

    // Update image_url if a new one was supplied (so subsequent redos use the latest image)
    const taskUpdates: Record<string, any> = {
      redo_status: { status: 'redoing', mode: redoMode },
      redo_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      polling_id: null,
      polling_url: null,
      poll_attempts: 0,
      error: null,
    };
    if (new_image_url) {
      taskUpdates.image_url = new_image_url;
    }

    const { error: updateErr } = await supabase
      .from('ITV_tasks')
      .update(taskUpdates)
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
        message: 'ITV redo started — video is being regenerated',
        group_id,
        batch_number,
      }),
      { status: 202, headers: responseHeaders },
    );

    const redoTask = { ...task, video_model: effectiveVideoModel };
    const isLongPoll = LONG_POLL_MODELS.has(effectiveVideoModel);

    EdgeRuntime.waitUntil(
      (async () => {
        try {
          // Submit the video generation job
          const submitResult = await callGenerateITV({
            mode: 'submit',
            video_model: effectiveVideoModel,
            prompt,
            image_url: resolvedImageUrl,
            video_duration: redoTask.video_duration,
            audio_clip: redoTask.audio_clip ?? false,
          });

          console.log(
            `[redo-ITV] Submitted job for task ${redoTask.id} (model=${effectiveVideoModel}):`,
            JSON.stringify(submitResult).slice(0, 200),
          );

          // If the model returned video immediately
          if (submitResult.status === 'completed' && submitResult.video_url) {
            await completeRedoTask(redoTask, submitResult.video_url);
            return;
          }

          const pollingId: string = submitResult.polling_id;
          const pollingUrl: string | undefined = submitResult.polling_url;

          if (!pollingId) {
            throw new Error('No polling_id returned from generate-ITV');
          }

          // Save polling info to DB (mirrors process-ITV) — self-calls and UI can track progress
          await supabase
            .from('ITV_tasks')
            .update({
              polling_id: pollingId,
              polling_url: pollingUrl ?? null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', task.id);

          if (isLongPoll) {
            const initialDelay = INITIAL_POLL_DELAY_MS[effectiveVideoModel] ?? 360_000;
            const safeDelay = Math.min(initialDelay, MAX_WAIT_MS);
            console.log(
              `[redo-ITV] Long-poll model ${effectiveVideoModel} — sleeping ${safeDelay} ms before first poll`,
            );
            await sleep(safeDelay);
            await firePollSelfCall(redoTask, pollingId, pollingUrl, 0, feedback);
          } else {
            const initialDelay = INITIAL_POLL_DELAY_MS[effectiveVideoModel] ?? 90_000;
            console.log(
              `[redo-ITV] Short-poll model ${effectiveVideoModel} — sleeping ${initialDelay} ms before first poll`,
            );
            await sleep(initialDelay);
            await pollUntilDone(redoTask, pollingId, pollingUrl, 0, feedback);
          }
        } catch (e: any) {
          // Check for fal.ai expiry before marking as failed
          if (isExpiredError(e)) {
            try {
              console.log(`[redo-ITV] Background: caught expired error — resubmitting job`);
              const resubmit = await resubmitJob(redoTask, feedback);
              if (resubmit.videoUrl) {
                await completeRedoTask(redoTask, resubmit.videoUrl);
                return;
              }
              await firePollSelfCall(redoTask, resubmit.pollingId, resubmit.pollingUrl ?? null, 0, feedback);
              return;
            } catch (resubmitErr: any) {
              console.error(`[redo-ITV] Resubmit after expiry failed:`, resubmitErr.message);
              // Fall through to mark as failed
            }
          }
          console.error(`[redo-ITV] Background error for task ${task.id}:`, e.message);
          await logError('redo-ITV background error', e);
          const mode = (redoTask.redo_status as any)?.mode ?? redoMode ?? 'video_only';
          await supabase
            .from('ITV_tasks')
            .update({ redo_status: { status: 'failed', mode }, updated_at: new Date().toISOString() })
            .eq('id', task.id);
        }
      })(),
    );

    return response;
  } catch (e: any) {
    await logError('redo-ITV unhandled error', e);
    return new Response(
      JSON.stringify({ error: e.message || 'Internal server error' }),
      { status: 500, headers: responseHeaders },
    );
  }
});
