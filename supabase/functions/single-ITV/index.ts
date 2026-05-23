// single-ITV/index.ts
// Generates a single ITV video clip from a pre-generated keyframe image.
// Called internally by single-image after the keyframe upload is complete.
//
// Init mode  (from single-image): { single_itv_init: true, task_id }
// Poll chain (self-call):         { single_itv_poll_mode: true, task_id, polling_id, polling_url?, video_model, poll_attempt }
//
// Flow:
//   1. single-image fires this with single_itv_init=true after uploading the keyframe.
//   2. Reads ITV_tasks row (already created by single-image), updates status → 'running'.
//   3. Submits job to generate-ITV with the prompt + image_url.
//   4. Polls in-process until complete, then fires self-call chain if time runs out.
//   5. On completion: downloads video, uploads to Supabase Storage, updates ITV_tasks → completed_final.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { getIsLegacyPlan, itvTokensPerSecond } from '../_shared/tokenCosts.ts';

// ── Env ────────────────────────────────────────────────────────────────────────
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);



// ── Constants ──────────────────────────────────────────────────────────────────
// Per-action ITV token costs are resolved per-user via tokenCosts.ts
// (legacy users keep historical rates; new users hit the calibrated
// NEW_ITV_* map). Always use itvTokensPerSecond(...) at billing time.

// Models that need a long initial wait before first poll (currently none — all fal.ai)
const LONG_POLL_MODELS = new Set<string>();

// Initial sleep before first poll attempt (ms) — all fal.ai
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

const MAX_TOTAL_POLL_ATTEMPTS = 60;
// Leave ~60 s safety buffer before the 400 s edge function hard limit
const MAX_WAIT_MS = 340_000;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Helpers ────────────────────────────────────────────────────────────────────
async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    await supabase.from('error_logs').insert({
      message,
      details: error?.message || JSON.stringify(error),
      created_at: new Date().toISOString(),
    });
  } catch (_) { /* silent */ }
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

// ── Complete single ITV task ───────────────────────────────────────────────────
async function completeSingleITVTask(
  task: Record<string, any>,
  videoUrl: string,
): Promise<void> {
  const {
    id: taskId,
    user_id: userId,
    video_model: videoModel,
    video_duration: videoDuration,
    group_id: groupId,
    folder_timestamp: folderTimestamp,
    audio_clip: audioClip,
  } = task;

  console.log(`[single-ITV] Completing task ${taskId} (model=${videoModel})`);

  // Download video bytes
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error(`Video download HTTP ${videoRes.status} from ${videoUrl.slice(0, 100)}`);
  const rawVideoBytes = new Uint8Array(await videoRes.arrayBuffer());

  if (rawVideoBytes.length === 0) throw new Error('Downloaded video is empty (0 bytes)');

  // seedance15 always generates audio regardless of user setting — strip when not requested.
  const shouldStripAudio = videoModel === 'seedance15' && !audioClip;
  const videoBytes = shouldStripAudio ? stripAudioFromMp4(rawVideoBytes) : rawVideoBytes;
  if (shouldStripAudio) console.log(`[single-ITV] Stripping audio from seedance15 output for task ${taskId}`);

  const storagePath = `documents/${userId}/${groupId}/ITV-single_${folderTimestamp}/1.mp4`;

  // Upload to storage (retry up to 3 times)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await supabase.storage
      .from('stories')
      .upload(storagePath, videoBytes, { contentType: 'video/mp4', upsert: true });
    if (!error) break;
    if (attempt < 3) {
      console.warn(`[single-ITV] Upload attempt ${attempt} failed: ${error.message} — retrying in 5 s`);
      await sleep(5_000);
    } else {
      throw new Error(`Storage upload failed after 3 attempts: ${error.message}`);
    }
  }

  // Calculate tokens to deduct
  const isLegacy = await getIsLegacyPlan(userId);
  const tps = itvTokensPerSecond(isLegacy, videoModel, !!audioClip);
  const tokens = Math.round((videoDuration ?? 5) * tps);

  // Update ITV_tasks to completed_final — DB trigger deducts tokens from user_plans
  const { error: updateErr } = await supabase
    .from('ITV_tasks')
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
    throw new Error(`Failed to update ITV_tasks: ${updateErr.message}`);
  }

  console.log(`[single-ITV] Task ${taskId} completed. Storage: ${storagePath} | Tokens: ${tokens}`);
}

// ── Self-call for poll chain ───────────────────────────────────────────────────
async function firePollSelfCall(
  task: Record<string, any>,
  pollingId: string,
  pollingUrl: string | null | undefined,
  pollAttempt: number,
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/functions/v1/single-ITV`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        single_itv_poll_mode: true,
        task_id: task.id,
        polling_id: pollingId,
        polling_url: pollingUrl ?? null,
        video_model: task.video_model,
        video_duration: task.video_duration,
        poll_attempt: pollAttempt,
      }),
    });
    console.log(`[single-ITV] Fired self-call for poll attempt ${pollAttempt} (task ${task.id})`);
  } catch (e: any) {
    await logError(`Failed to fire poll self-call for single-ITV task ${task.id}`, e);
  }
}

// ── In-process poll loop for short-poll models ────────────────────────────────
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
      console.log(`[single-ITV] Time budget nearly exhausted at poll ${attempt} — firing self-call`);
      await firePollSelfCall(task, pollingId, pollingUrl, attempt);
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
        await completeSingleITVTask(task, pollResult.video_url);
        return;
      } else if (pollResult.status === 'failed') {
        throw new Error(`Video generation failed: ${pollResult.error || 'Unknown error'}`);
      }
      // still pending → continue loop
    } catch (e: any) {
      console.error(`[single-ITV] Poll attempt ${attempt} error:`, e.message);
      if (attempt >= MAX_TOTAL_POLL_ATTEMPTS - 1) throw e;
    }
  }

  throw new Error('[single-ITV] Max poll attempts reached without completion');
}

// ── Main handler ───────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });
  }

  const auth = await verifyAuth(req);
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: responseHeaders });
  }

  try {
    // ── Poll chain mode: self-call from a previous invocation ─────────────────
    if (body.single_itv_poll_mode) {
      const { task_id, polling_id, polling_url, video_model, poll_attempt = 0 } = body;

      if (!task_id || !polling_id) {
        return new Response(
          JSON.stringify({ error: 'single_itv_poll_mode: missing task_id or polling_id' }),
          { status: 400, headers: responseHeaders },
        );
      }

      const { data: task, error: taskErr } = await supabase
        .from('ITV_tasks')
        .select('*')
        .eq('id', task_id)
        .single();

      if (taskErr || !task) {
        return new Response(JSON.stringify({ error: 'Task not found' }), { status: 404, headers: responseHeaders });
      }

      // If already completed or errored, skip
      if (task.status === 'completed_final' || task.status === 'error') {
        console.log(`[single-ITV] poll_mode: task ${task_id} already in status ${task.status} — skipping`);
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

            const pollResult = await callGenerateITV({
              mode: 'poll',
              video_model: video_model ?? task.video_model,
              polling_id,
              polling_url: polling_url ?? null,
            });

            if (pollResult.status === 'completed') {
              await completeSingleITVTask(task, pollResult.video_url);
            } else if (pollResult.status === 'failed') {
              throw new Error(pollResult.error || 'Video generation failed');
            } else {
              const nextAttempt = (poll_attempt ?? 0) + 1;
              if (nextAttempt < MAX_TOTAL_POLL_ATTEMPTS) {
                await firePollSelfCall(task, polling_id, polling_url, nextAttempt);
              } else {
                throw new Error('[single-ITV] Max poll self-call attempts reached');
              }
            }
          } catch (e: any) {
            console.error(`[single-ITV] poll_mode background error for task ${task_id}:`, e.message);
            await logError('single-ITV poll_mode error', e);
            await supabase
              .from('ITV_tasks')
              .update({ status: 'error', error: e.message, updated_at: new Date().toISOString() })
              .eq('id', task_id);
          }
        })(),
      );

      return response;
    }

    // ── Init mode: called by single-image after keyframe upload ───────────────
    if (body.single_itv_init) {
      const { task_id } = body;

      if (!task_id) {
        return new Response(
          JSON.stringify({ error: 'single_itv_init: missing task_id' }),
          { status: 400, headers: responseHeaders },
        );
      }

      const { data: task, error: taskErr } = await supabase
        .from('ITV_tasks')
        .select('*')
        .eq('id', task_id)
        .single();

      if (taskErr || !task) {
        return new Response(JSON.stringify({ error: 'Task not found' }), { status: 404, headers: responseHeaders });
      }

      if (!task.image_url) {
        return new Response(
          JSON.stringify({ error: 'ITV_tasks row has no image_url — single-image must set it before calling single-ITV' }),
          { status: 400, headers: responseHeaders },
        );
      }

      // Update status to running
      await supabase
        .from('ITV_tasks')
        .update({ status: 'running', updated_at: new Date().toISOString() })
        .eq('id', task_id);

      // All models now use fal.ai directly — no model conversion needed
      const effectiveModel = task.video_model;
      const isLongPoll = LONG_POLL_MODELS.has(effectiveModel);

      const response = new Response(
        JSON.stringify({ status: 'processing', task_id }),
        { status: 202, headers: responseHeaders },
      );

      // Build task record
      const taskRecord: Record<string, any> = { ...task };

      EdgeRuntime.waitUntil(
        (async () => {
          try {
            // Extract prompt from batch
            const prompt: string = task.batch?.[0]?.prompt ?? task.batch?.[0]?.text ?? '';
            const imageUrl: string = task.image_url;

            // Convert Supabase public URL → signed URL so external APIs (fal.ai etc.)
            // can download the image even when the bucket is not publicly accessible.
            let imageUrlForITV = imageUrl;
            const storageMarker = `/storage/v1/object/public/stories/`;
            const markerIdx = imageUrl.indexOf(storageMarker);
            if (markerIdx !== -1) {
              const storagePath = imageUrl.slice(markerIdx + storageMarker.length);
              const { data: signedData, error: signErr } = await supabase.storage
                .from('stories')
                .createSignedUrl(storagePath, 7200); // 2-hour expiry
              if (signedData?.signedUrl) {
                imageUrlForITV = signedData.signedUrl;
                console.log(`[single-ITV] Using signed URL for task ${task_id} (path=${storagePath})`);
              } else {
                console.warn(`[single-ITV] Could not create signed URL (${signErr?.message}) — falling back to public URL`);
              }
            }

            console.log(`[single-ITV] Submitting job for task ${task_id} (model=${effectiveModel}, image=${imageUrlForITV.slice(0, 80)}...)`);

            const submitResult = await callGenerateITV({
              mode: 'submit',
              video_model: effectiveModel,
              prompt,
              image_url: imageUrlForITV,
              video_duration: task.video_duration,
              audio_clip: task.audio_clip ?? false,
            });

            console.log(
              `[single-ITV] Submit result for ${task_id}:`,
              JSON.stringify(submitResult).slice(0, 200),
            );

            // Immediate completion (e.g. very fast / cached)
            if (submitResult.status === 'completed' && submitResult.video_url) {
              await completeSingleITVTask(taskRecord, submitResult.video_url);
              return;
            }

            const pollingId: string = submitResult.polling_id;
            const pollingUrl: string | undefined = submitResult.polling_url;

            if (!pollingId) throw new Error('No polling_id returned from generate-ITV');

            if (isLongPoll) {
              const initialDelay = INITIAL_POLL_DELAY_MS[effectiveModel] ?? 360_000;
              const safeDelay = Math.min(initialDelay, MAX_WAIT_MS);
              console.log(`[single-ITV] Long-poll model ${effectiveModel} — sleeping ${safeDelay} ms`);
              await sleep(safeDelay);
              await firePollSelfCall(taskRecord, pollingId, pollingUrl, 0);
            } else {
              const initialDelay = INITIAL_POLL_DELAY_MS[effectiveModel] ?? 120_000;
              console.log(`[single-ITV] Short-poll model ${effectiveModel} — sleeping ${initialDelay} ms`);
              await sleep(initialDelay);
              await pollUntilDone(taskRecord, pollingId, pollingUrl, 0);
            }
          } catch (e: any) {
            console.error(`[single-ITV] Init background error for task ${task_id}:`, e.message);
            await logError('single-ITV init background error', e);
            await supabase
              .from('ITV_tasks')
              .update({ status: 'error', error: e.message, updated_at: new Date().toISOString() })
              .eq('id', task_id);
          }
        })(),
      );

      return response;
    }

    return new Response(
      JSON.stringify({ error: 'Request must include single_itv_init or single_itv_poll_mode' }),
      { status: 400, headers: responseHeaders },
    );

  } catch (e: any) {
    await logError('single-ITV unhandled error', e);
    return new Response(
      JSON.stringify({ error: e.message || 'Internal server error' }),
      { status: 500, headers: responseHeaders },
    );
  }
});
