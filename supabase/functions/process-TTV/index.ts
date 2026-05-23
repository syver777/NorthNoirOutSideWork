// process-TTV/index.ts
// Main orchestrator for video generation.
//
// Submit flow (normal mode):
//   1. Fetch queued TTV_task from DB
//   2. Call generate-TTV (submit mode) → get polling_id / polling_url
//   3. Store polling info, send HTTP 200
//   4. EdgeRuntime.waitUntil → sleep → poll → download → upload to storage → update DB → trigger next
//
// Phase 2 poll mode (Sora 2 Pro High Res only):
//   process-TTV fires itself after 290 s with { poll_mode: true, task_id, polling_id, … }
//   Phase 2 sleeps 180 s then polls up to 3 more times.
//
// compileFinalTTVDocument:
//   Called when batch_number === total_batches.
//   Creates story_documents record pointing to the TTV folder.
//   Marks all tasks completed_final.  Updates tabs.status = 'complete'.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import OpenAI from 'npm:openai@6';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { buildForwardPayload } from '../_shared/forwardSetupPayload.ts';
import { getIsLegacyPlan, ttvTokensPerSecond } from '../_shared/tokenCosts.ts';
// Audio stripping (grok/sora always generate audio) is handled in pure TypeScript
// by manipulating the MP4 box (atom) structure directly — no Worker required.
// Video cropping to exact 16:9 is deferred to a GCloud function (FFmpeg WASM is
// not supported in the Supabase Edge Runtime).

// ── Env ────────────────────────────────────────────────────────────────────────
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
const openaiApiKey = Deno.env.get('OPENAI_API_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// ── Constants ──────────────────────────────────────────────────────────────────
// Per-action token costs are resolved per-user via tokenCosts.ts so that
// legacy (grandfathered) users keep paying the historical rates while new
// users hit the calibrated NEW_TTV_* map. Always use ttvTokensPerSecond(...)
// at billing time — never hard-code a tokens/s value here.

// Initial sleep (ms) before first poll attempt
const INITIAL_POLL_DELAY_MS: Record<string, number> = {
  seedance_pro_fast: 90_000,
  ltx23_fast: 90_000,
  seedance15_pro: 90_000,
  ltx23_pro: 90_000,
  grok: 90_000,
  grok_highres: 90_000,
  veo31fast: 90_000,  // poll every 90 s (matches other short models; 3 × 90 s = 270 s < 400 s budget)
  veo31: 90_000,      // poll every 90 s
  sora2pro: 360_000, // 6 min
  sora2pro_highres: 290_000, // phase 1 fires self-call after 290 s
};

// Short models can fit multiple polls in one invocation (90 s × 3 = 270 s < 400 s budget)
const MAX_IN_PROCESS_POLL_ATTEMPTS = 3;
// Max total rounds across all self-call chains (prevents infinite loops)
const MAX_TOTAL_POLL_ATTEMPTS = 5;
// Max wall-clock time we're willing to stay alive (leave 20 s buffer before hard 400 s limit)
const MAX_WAIT_MS = 380_000;
// Models where initialDelay >= 180 s: one poll per invocation, chain via self-calls
// (multiple in-process sleeps would exceed the 400 s edge function budget)
const LONG_POLL_MODELS = new Set(['sora2pro', 'sora2pro_highres']);

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

async function triggerSizeCalculation(docId: string, filePath: string, version: number): Promise<void> {
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/calculate-file-size`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({ id: docId, file_path: filePath, version }),
    });
    if (!response.ok) {
      console.warn(`Failed to trigger size calculation for ${docId}: HTTP ${response.status}`);
    } else {
      console.log(`Successfully triggered size calculation for ${docId}`);
    }
  } catch (error: any) {
    console.warn(`Error triggering size calculation for ${docId}:`, error.message);
  }
}

// ── generate-TTV caller ────────────────────────────────────────────────────────
async function callGenerateTTV(body: Record<string, any>): Promise<any> {
  const res = await fetch(`${supabaseUrl}/functions/v1/generate-TTV`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`generate-TTV HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ── Video downloader ───────────────────────────────────────────────────────────
// Returns the raw video bytes as Uint8Array.
async function downloadVideo(
  videoModel: string,
  videoUrl: string | undefined,
  soraJobId: string | undefined,
): Promise<Uint8Array> {
  // Sora: download using the OpenAI SDK (mirrors Python client.videos.download_content)
  if (videoModel === 'sora2pro' || videoModel === 'sora2pro_highres') {
    if (!soraJobId) throw new Error('Sora download: missing sora_job_id');
    const openaiClient = new OpenAI({ apiKey: openaiApiKey });
    const response = await (openaiClient as any).videos.downloadContent(soraJobId, { variant: 'video' });
    // The SDK returns a Response-like object; get raw bytes
    if (response?.arrayBuffer) {
      const buf = await response.arrayBuffer();
      return new Uint8Array(buf);
    }
    // Fallback: some SDK versions return the buffer directly
    if (response instanceof Uint8Array) return response;
    if (response instanceof ArrayBuffer) return new Uint8Array(response);
    throw new Error('Sora download: unexpected response type from SDK');
  }

  // fal.ai / xAI: plain public CDN URL, no auth needed.
  if (!videoUrl) throw new Error('downloadVideo: missing video_url');
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Video download HTTP ${res.status} from ${videoUrl.slice(0, 100)}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

// ── compileFinalTTVDocument ────────────────────────────────────────────────────
async function compileFinalTTVDocument(
  userId: string,
  groupId: string,
  title: string,
  description: string,
  variant: number,
  isCorrected: boolean,
  version: number,
  folderTimestamp: string,
  videoModel: string,
  tab: number,
  audioClip: boolean = false,
): Promise<void> {
  try {
    console.log(`compileFinalTTVDocument: group=${groupId} variant=${variant} version=${version}`);

    // Duplicate guard
    const { data: existingDoc } = await supabase
      .from('story_documents')
      .select('id')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('variant', variant)
      .eq('version', version)
      .limit(1);

    if (existingDoc && existingDoc.length > 0) {
      console.log(`TTV document already exists for group ${groupId}, variant ${variant}, version ${version} — skipping`);
      return;
    }

    const sanitized = sanitizeTitle(title.replace(/^TTV Prompt:\s*/i, '').replace(/^TTV Prompts:\s*/i, ''));
    const folderPath = `documents/${userId}/${groupId}/TTV-${sanitized}_${folderTimestamp}`;
    console.log(`TTV folder path: ${folderPath}`);

    const { data: urlData } = supabase.storage.from('stories').getPublicUrl(folderPath);
    if (!urlData?.publicUrl) throw new Error('Failed to retrieve public folder URL for TTV folder');

    const documentId = crypto.randomUUID();
    const cleanTitle = title
      .replace(/^TTV Prompt:\s*/i, '')
      .replace(/^TTV Prompts:\s*/i, '')
      .trim();

    const { error: docError } = await supabase
      .from('story_documents')
      .insert({
        id: documentId,
        title: `TTV Outputs: ${cleanTitle}`,
        description,
        version,
        is_corrected: isCorrected,
        is_prompted: false,
        user_id: userId,
        file_path: folderPath,
        file_url: urlData.publicUrl,
        image_model: videoModel, // store video model in image_model column
        audio_clip: audioClip,
        created_at: new Date().toISOString(),
        group_id: groupId,
        variant,
        tab,
      });

    if (docError) throw new Error(`Failed to save TTV document: ${docError.message}`);
    console.log(`Created TTV story_documents record: ${documentId}`);

    // Trigger size calculation asynchronously (fire-and-forget)
    triggerSizeCalculation(documentId, folderPath, version).catch(err =>
      console.warn(`Size calculation failed for ${documentId}:`, err.message)
    );

    // Mark all TTV_tasks as completed_final and store folder document ID
    const { error: updateError } = await supabase
      .from('TTV_tasks')
      .update({
        status: 'completed_final',
        ttv_folder_document_id: documentId,
        updated_at: new Date().toISOString(),
      })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant);

    if (updateError) {
      console.error(`Error marking TTV tasks completed_final: ${updateError.message}`);
    } else {
      console.log(`All TTV tasks marked completed_final for group ${groupId}`);
    }

    // Bridge to video_tasks pipeline: if this TTV run was triggered from the
    // main video pipeline (compile-audio → setup-ttv-prompts), update statuses
    // and trigger the final video assembly chain.
    await bridgeTTVToVideoTasks(userId, groupId, variant, tab, documentId);

    console.log(`compileFinalTTVDocument completed for group ${groupId}`);
  } catch (error: any) {
    console.error(`Error in compileFinalTTVDocument: ${error.message}`);
    await logError('Error compiling final TTV document', error);
    throw error;
  }
}

// ── Bridge TTV completion to video_tasks pipeline ──────────────────────────────
// When the main pipeline (setup-video-tasks → compile-audio) triggers TTV, it
// writes ttv_prompt_status / ttv_status into the video_tasks row.  After all
// TTV clips are done we need to:
//   1. Mark those columns 'completed'
//   2. Store the folder document ID so create-final-video can find the clips
//   3. Check whether every other pipeline step is also done
//   4. If so, call setup-video-tasks to kick off the final video assembly
async function bridgeTTVToVideoTasks(
  userId: string,
  groupId: string,
  variant: number,
  tab: number,
  folderDocumentId: string,
): Promise<void> {
  try {
    // Only proceed if a video_tasks row exists with visual_type='ttv'
    const { data: vt, error: vtError } = await supabase
      .from('video_tasks')
      .select('*')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .is('current_batch_number', null) // main task row only
      .maybeSingle();

    if (vtError) {
      console.error(`Error querying video_tasks for TTV bridge: ${vtError.message}`);
    }

    if (!vt || vt.visual_type !== 'ttv') {
      console.log('No video_tasks TTV row found — standalone TTV run, skipping bridge');
      return;
    }

    console.log(`Bridging TTV completion to video_tasks (task ${vt.id})`);

    // 1. Update TTV statuses to completed + store folder document ID
    await supabase
      .from('video_tasks')
      .update({
        ttv_prompt_status: 'completed',
        ttv_prompt_progress: 100,
        ttv_status: 'completed',
        ttv_progress: 100,
        ttv_folder_document_id: folderDocumentId,
        updated_at: new Date().toISOString(),
      })
      .eq('group_id', groupId)
      .eq('user_id', userId);

    // 2. Check if all other pipeline steps are completed
    const storyOk = !vt.process_story || vt.story_status === 'completed';
    const imagesOk = !vt.process_images ||
      (vt.image_prompt_status === 'completed' && vt.image_generation_status === 'completed');
    const audioOk = !vt.process_audio || vt.audio_status === 'completed';

    if (!(storyOk && imagesOk && audioOk)) {
      console.log(`video_tasks not fully ready yet — story:${storyOk} images:${imagesOk} audio:${audioOk}`);
      return;
    }

    // 3. If video creation is disabled, mark everything completed_final
    if (vt.video === false) {
      console.log('Video creation disabled — marking all statuses completed_final');
      await supabase
        .from('video_tasks')
        .update({
          story_status: 'completed_final',
          image_prompt_status: 'completed_final',
          image_generation_status: 'completed_final',
          audio_status: 'completed_final',
          video_creation_status: 'completed_final',
          overall_status: 'completed_final',
          individual_video_status: 'completed_final',
          ttv_prompt_status: 'completed_final',
          ttv_status: 'completed_final',
          itv_prompt_status: 'completed_final',
          itv_status: 'completed_final',
          overall_progress: 100,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('group_id', groupId)
        .eq('user_id', userId);
      return;
    }

    // 4. All statuses completed and video=true → trigger final video assembly
    console.log('All pipeline steps completed — triggering final video creation');

    // Gather documents
    const { data: documents } = await supabase
      .from('story_documents')
      .select('*')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('variant', variant)
      .order('created_at', { ascending: true });

    const audioOutputDoc = documents?.find((d: any) => d.title.startsWith('Audio Outputs:'));
    const storyDoc = documents?.find((d: any) =>
      !d.title.startsWith('Image') && !d.title.startsWith('Audio') &&
      !d.title.startsWith('TTV') && !d.title.startsWith('ITV'));

    // Resolve audio source. When a merged "Audio Outputs:" folder doc exists
    // (generated audio), pass it as audio_folder_path. Otherwise fall back to
    // the uploaded single-file audio document referenced by vt.audio_document_id
    // (use_existing_audio = true case) and pass it as audio_file_path so
    // setup-video-tasks validation passes.
    let audioFolderPathForSetup: string | null = audioOutputDoc?.file_path || null;
    let audioFilePathForSetup: string | null = null;
    if (!audioFolderPathForSetup && vt.audio_document_id) {
      const { data: uploadedAudioDoc } = await supabase
        .from('story_documents')
        .select('file_path')
        .eq('id', vt.audio_document_id)
        .maybeSingle();
      audioFilePathForSetup = uploadedAudioDoc?.file_path || null;
    }
    if (!audioFolderPathForSetup && !audioFilePathForSetup) {
      // Last-resort fallback: read audio_file_path from the original settings JSON
      try {
        const settingsObj = typeof vt.settings === 'string' ? JSON.parse(vt.settings) : vt.settings;
        if (settingsObj?.audio_file_path) audioFilePathForSetup = settingsObj.audio_file_path;
        else if (settingsObj?.audio_folder_path) audioFolderPathForSetup = settingsObj.audio_folder_path;
      } catch (_) { /* ignore */ }
    }

    // Get TTV clips folder path
    const { data: folderDoc } = await supabase
      .from('story_documents')
      .select('file_path')
      .eq('id', folderDocumentId)
      .single();

    const visualFolderPath = folderDoc?.file_path || null;

    // Update statuses to reflect video creation starting
    await supabase
      .from('video_tasks')
      .update({
        audio_status: 'completed',
        audio_progress: 100,
        video_creation_status: 'pending',
        overall_progress: 90,
        updated_at: new Date().toISOString(),
      })
      .eq('group_id', groupId)
      .eq('user_id', userId);

    // Call setup-video-tasks to create the video assembly task + batch rows
    const resp = await fetch(`${supabaseUrl}/functions/v1/setup-video-tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        // Forward all settings + video_task_id to prevent duplicate placeholder
        // row + preserve subtitles, master_prompt, volume, etc.
        ...buildForwardPayload({ vt, userId, groupId, tab }),
        use_existing_story: true,
        story_file_path: storyDoc?.file_path,
        use_existing_images: true,
        images_folder_path: visualFolderPath,
        image_prompt_path: null,
        use_existing_audio: true,
        audio_file_path: audioFilePathForSetup,
        audio_folder_path: audioFolderPathForSetup,
        visual_type: 'ttv',
        audio_clip: vt.audio_clip,
        process_ttv: true,
        process_itv: false,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`Failed to trigger setup-video-tasks from TTV bridge: HTTP ${resp.status}: ${errText.slice(0, 300)}`);
    } else {
      console.log('Successfully triggered video creation from TTV bridge');
    }
  } catch (err: any) {
    // Log but don't throw — the TTV document is already saved
    console.error(`Error in bridgeTTVToVideoTasks: ${err.message}`);
    await logError('Error bridging TTV to video_tasks', err);
  }
}

// ── Trigger next TTV ───────────────────────────────────────────────────────────
async function triggerNextTTV(
  groupId: string,
  userId: string,
  currentBatchNumber: number,
  tab: number,
  variant: number,
): Promise<void> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/trigger-next-TTV`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
      body: JSON.stringify({ group_id: groupId, user_id: userId, current_batch_number: currentBatchNumber, tab, variant }),
    });
    if (!res.ok) {
      console.warn(`trigger-next-TTV returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } else {
      console.log(`trigger-next-TTV called successfully after batch ${currentBatchNumber}`);
    }
  } catch (e: any) {
    console.error(`Error calling trigger-next-TTV: ${e.message}`);
    await logError('Error calling trigger-next-TTV', e);
  }
}

// ── Upload to storage (with retries) ──────────────────────────────────────────
async function uploadVideoToStorage(
  videoBytes: Uint8Array,
  storagePath: string,
): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { error } = await supabase.storage
        .from('stories')
        .upload(storagePath, videoBytes, { contentType: 'video/mp4', upsert: true });
      if (error) throw new Error(`Storage upload error: ${error.message}`);
      console.log(`Uploaded video to ${storagePath}`);
      return;
    } catch (e: any) {
      if (attempt < maxAttempts) {
        console.warn(`Upload attempt ${attempt} failed: ${e.message} — retrying in 5 s`);
        await sleep(5_000);
      } else {
        throw e;
      }
    }
  }
}

// ── Pure-JS MP4 audio stripper ────────────────────────────────────────────────
// Removes all 'soun' (audio) trak boxes from the moov container.
// The orphaned audio bytes in mdat are simply ignored by video players.
// No FFmpeg / WASM / Worker required.

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
      // 64-bit extended size — only handle files < 4 GB
      if (_u32(buf, p + 8) !== 0) break;
      z = _u32(buf, p + 12);
    } else if (z === 0) {
      z = e - p; // extends to end
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
      // FullBox: box-hdr(8) + version/flags(4) + pre_defined(4) + handler_type(4)
      const htOff = hdlr.s + 8 + 4 + 4;
      if (htOff + 4 <= buf.length) {
        const ht = String.fromCharCode(buf[htOff], buf[htOff+1], buf[htOff+2], buf[htOff+3]);
        if (ht === 'soun') return true;
      }
    }
  }
  return false;
}

// Patch every stco/co64 chunk-offset entry in buf by subtracting delta.
// Required when moov shrinks and precedes mdat: mdat shifts earlier by delta bytes,
// so every absolute sample offset in the video trak must be decremented accordingly.
function _patchChunkOffsets(buf: Uint8Array, delta: number): void {
  function walk(start: number, end: number): void {
    for (const box of _boxes(buf, start, end)) {
      if (box.t === 'stco') {
        // FullBox: box-hdr(8) + version/flags(4) + entry_count(4); entries at +16, 4 bytes each
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
        // FullBox: box-hdr(8) + version/flags(4) + entry_count(4); entries at +16, 8 bytes each
        const count = _u32(buf, box.s + 12);
        for (let i = 0; i < count; i++) {
          const off = box.s + 16 + i * 8;
          // Files < 4 GB: upper 4 bytes are 0; patch only the lower 4
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
        continue; // drop audio trak
      }
      keptParts.push(bytes.slice(child.s, child.s + child.z));
    }

    if (removed === 0) {
      console.log('stripAudio: no audio tracks found — returning original');
      return bytes;
    }

    // Rebuild moov content and compute how much smaller it is
    const keptContent = _concat(...keptParts);
    const newMoovSize = 8 + keptContent.length;
    const sizeDiff = moovBox.z - newMoovSize;

    // Grok (and most web-optimised MP4s) place moov BEFORE mdat (fast-start layout).
    // Removing the audio trak shrinks moov, which shifts mdat sizeDiff bytes earlier.
    // Every stco/co64 chunk offset in the retained video trak must be patched down by sizeDiff.
    if (sizeDiff > 0) {
      const mdatBox = topBoxes.find(b => b.t === 'mdat');
      if (mdatBox && mdatBox.s > moovBox.s) {
        _patchChunkOffsets(keptContent, sizeDiff);
        console.log(`stripAudio: patched stco/co64 offsets by -${sizeDiff} (moov-before-mdat layout)`);
      }
    }

    // Rebuild moov with updated 4-byte size header
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

// ── Video audio stripping ─────────────────────────────────────────────────────
// Grok and Sora always generate audio even when not requested — strip it here.
// Cropping to exact 16:9 is handled later by a GCloud function.

// ── Core: complete a task after poll succeeded ─────────────────────────────────
async function completeTask(
  task: Record<string, any>,
  videoUrl: string | undefined,
  soraJobId: string | undefined,
): Promise<void> {
  const {
    id: taskId, user_id: userId, group_id: groupId,
    batch_number: batchNumber, total_batches: totalBatches,
    story_title: storyTitle, description, variant, is_corrected: isCorrected,
    version, folder_timestamp: folderTimestamp, video_model: videoModel,
    video_duration: videoDuration, tab, audio_clip: audioClip,
  } = task;

  // Download video bytes
  console.log(`Downloading video for task ${taskId} (model=${videoModel})`);
  let rawBytes: Uint8Array;
  try {
    rawBytes = await downloadVideo(videoModel, videoUrl, soraJobId);
  } catch (e: any) {
    console.error(`Video download failed for task ${taskId}: ${e.message}`);
    // Leave as running for cron
    return;
  }

  // Grok and Sora always generate audio regardless of the flag; strip it when audio_clip is false
  const stripAudio = ['grok', 'grok_highres', 'sora2pro', 'sora2pro_highres'].includes(videoModel) && !audioClip;
  const videoBytes: Uint8Array = stripAudio ? stripAudioFromMp4(rawBytes) : rawBytes;

  // Build storage path
  const sanitized = sanitizeTitle(storyTitle.replace(/^TTV Prompt:\s*/i, '').replace(/^TTV Prompts:\s*/i, ''));
  const storagePath = `documents/${userId}/${groupId}/TTV-${sanitized}_${folderTimestamp}/${batchNumber}.mp4`;

  // Upload
  try {
    await uploadVideoToStorage(videoBytes, storagePath);
  } catch (e: any) {
    console.error(`Upload failed for task ${taskId}: ${e.message}`);
    // Leave as running for cron
    return;
  }

  // Calculate tokens (audio mode costs more for some models; grok_highres/sora2pro_highres have their own rates)
  const isLegacy = await getIsLegacyPlan(userId);
  const tps = ttvTokensPerSecond(isLegacy, videoModel, !!audioClip);
  const tokens = Math.round((videoDuration ?? 5) * tps);

  // Update task: completed
  await supabase
    .from('TTV_tasks')
    .update({
      status: 'completed',
      video_url: storagePath,
      tokens,
      token_updated: true,
      progress: 100,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  console.log(`Task ${taskId} (batch ${batchNumber}/${totalBatches}) completed — tokens ${tokens}`);

  // Final compilation or trigger next
  if (batchNumber >= totalBatches) {
    await compileFinalTTVDocument(
      userId, groupId, storyTitle, description, variant, isCorrected, version, folderTimestamp, videoModel, tab, audioClip,
    );
  } else {
    await triggerNextTTV(groupId, userId, batchNumber, tab, variant);
  }
}

// ── Fire a poll-retry self-call ───────────────────────────────────────────────
// Must be AWAITED at every call site so the HTTP request is dispatched before
// waitUntil resolves and the Edge Runtime shuts down the function.
async function firePollSelfCall(task: Record<string, any>, pollAttempt: number): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/functions/v1/process-TTV`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
      body: JSON.stringify({
        poll_mode: true,
        task_id: task.id,
        group_id: task.group_id,
        user_id: task.user_id,
        batch_number: task.batch_number,
        total_batches: task.total_batches,
        tab: task.tab,
        variant: task.variant,
        video_model: task.video_model,
        video_duration: task.video_duration,
        polling_id: task.polling_id,
        polling_url: task.polling_url ?? null,
        poll_attempt: pollAttempt,
      }),
    });
  } catch (e: any) {
    await logError(`Failed to fire poll retry self-call for task ${task.id}`, e);
  }
}

// ── Delegate content-moderation failures to empty-redo-TTV ──────────────────
// empty-redo-TTV rewrites the prompt with DeepSeek before requeuing the task,
// preventing the same prompt from hitting content moderation again in a loop.
async function callEmptyRedoTTV(taskId: string): Promise<void> {
  console.log(`[process-TTV] Content moderation rejection for task ${taskId} — delegating to empty-redo-TTV for prompt rewrite`);
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
    await logError(`Failed to call empty-redo-TTV for task ${taskId}`, e);
  }
}

// ── Poll loop (runs inside EdgeRuntime.waitUntil) ──────────────────────────────
async function pollLoop(task: Record<string, any>): Promise<void> {
  const { id: taskId, video_model: videoModel, polling_id, polling_url } = task;
  const initialDelay = INITIAL_POLL_DELAY_MS[videoModel] ?? 90_000;

  if (videoModel === 'sora2pro_highres') {
    // Phase 1: sleep 290 s then fire phase 2 self-call
    await sleep(Math.min(initialDelay, MAX_WAIT_MS - 20_000));
    console.log(`Sora high-res phase 1 complete for task ${taskId} — firing phase 2 self-call`);
    await firePollSelfCall(task, 0);
    return;
  }

  // First sleep: wait the full model interval before polling
  await sleep(initialDelay);

  console.log(`Polling attempt 1 for task ${taskId} (${videoModel})`);
  let pollResult: any;
  try {
    pollResult = await callGenerateTTV({
      mode: 'poll',
      video_model: videoModel,
      polling_id,
      polling_url: polling_url ?? undefined,
    });
  } catch (e: any) {
    console.error(`Poll attempt 1 error for task ${taskId}: ${e.message}`);
    return; // leave as running for cron
  }

  await supabase
    .from('TTV_tasks')
    .update({ poll_attempts: 1, updated_at: new Date().toISOString() })
    .eq('id', taskId);

  console.log(`Poll attempt 1 raw result for task ${taskId} (${videoModel}): status=${pollResult?.status} error=${pollResult?.error ?? 'none'}`);

  if (pollResult?.status === 'completed') {
    await completeTask(task, pollResult.video_url, pollResult.sora_job_id);
    return;
  }
  if (pollResult?.status === 'failed') {
    if (pollResult.error === 'content_moderation') {
      await callEmptyRedoTTV(taskId);
      return;
    }
    console.error(`Video generation failed (model=${videoModel}, task=${taskId}): ${pollResult.error}`);
    return;
  }

  // Still pending after attempt 1
  console.log(`Task ${taskId} still pending (attempt 1) — model: ${videoModel}`);

  if (LONG_POLL_MODELS.has(videoModel)) {
    // Long-poll models (sora2pro): one poll per invocation, chain via self-calls
    console.log(`Long-poll model (${videoModel}) — scheduling retry self-call after another ${initialDelay / 1000}s`);
    await firePollSelfCall(task, 1);
    return;
  }

  // Short models (90 s): do up to 2 more polls within this invocation (3 × 90 s = 270 s < 400 s budget)
  for (let attempt = 2; attempt <= MAX_IN_PROCESS_POLL_ATTEMPTS; attempt++) {
    await sleep(initialDelay);

    console.log(`Polling attempt ${attempt} for task ${taskId} (${videoModel})`);
    let result: any;
    try {
      result = await callGenerateTTV({
        mode: 'poll',
        video_model: videoModel,
        polling_id,
        polling_url: polling_url ?? undefined,
      });
    } catch (e: any) {
      console.error(`Poll attempt ${attempt} error for task ${taskId}: ${e.message}`);
      if (attempt < MAX_IN_PROCESS_POLL_ATTEMPTS) continue;
      break;
    }

    await supabase
      .from('TTV_tasks')
      .update({ poll_attempts: attempt, updated_at: new Date().toISOString() })
      .eq('id', taskId);

    console.log(`Poll attempt ${attempt} raw result for task ${taskId} (${videoModel}): status=${result?.status} error=${result?.error ?? 'none'}`);

    if (result?.status === 'completed') {
      await completeTask(task, result.video_url, result.sora_job_id);
      return;
    }
    if (result?.status === 'failed') {
      if (result.error === 'content_moderation') {
        await callEmptyRedoTTV(taskId);
        return;
      }
      console.error(`Video generation failed (model=${videoModel}, task=${taskId}): ${result.error}`);
      return;
    }
    console.log(`Task ${taskId} still pending (attempt ${attempt}/${MAX_IN_PROCESS_POLL_ATTEMPTS})`);
  }

  // In-process attempts exhausted — schedule a retry self-call to continue later
  console.log(`In-process polls exhausted for task ${taskId} (${videoModel}) — scheduling retry self-call`);
  await firePollSelfCall(task, MAX_IN_PROCESS_POLL_ATTEMPTS);
}

// ── Phase 2 poll loop (Sora High Res only — 180 s after 290 s phase 1) ─────────
async function phase2PollLoop(task: Record<string, any>): Promise<void> {
  const { id: taskId, video_model: videoModel, polling_id, polling_url } = task;

  // Phase 1 slept 290 s; wait the remaining ~180 s before first poll
  await sleep(180_000);

  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`Sora high-res poll attempt ${attempt} for task ${taskId}`);
    let pollResult: any;
    try {
      pollResult = await callGenerateTTV({
        mode: 'poll',
        video_model: videoModel,
        polling_id,
        polling_url: polling_url ?? undefined,
      });
    } catch (e: any) {
      console.error(`Sora high-res poll error (attempt ${attempt}): ${e.message}`);
      if (attempt < 4) { await sleep(30_000); continue; }
      return;
    }

    await supabase
      .from('TTV_tasks')
      .update({ poll_attempts: 10 + attempt, updated_at: new Date().toISOString() })
      .eq('id', taskId);

    if (pollResult?.status === 'completed') {
      await completeTask(task, pollResult.video_url, pollResult.sora_job_id);
      return;
    }
    if (pollResult?.status === 'failed') { return; }

    console.log(`Sora high-res: task ${taskId} still pending (${attempt}/4)`);
    if (attempt < 4) await sleep(30_000);
  }

  console.log(`Sora high-res phase 2 exhausted for task ${taskId} — leaving as running for cron`);
}

// ── Generic retry poll loop — called via poll_mode self-call ───────────────────
// Used by: sora2pro and short-model overflow chains.
// Sleeps the model's full interval, polls once, fires another self-call if still
// pending and under MAX_TOTAL_POLL_ATTEMPTS.
async function retryPollLoop(task: Record<string, any>, currentAttempt: number): Promise<void> {
  const { id: taskId, video_model: videoModel, polling_id, polling_url } = task;
  const initialDelay = INITIAL_POLL_DELAY_MS[videoModel] ?? 360_000;

  if (currentAttempt >= MAX_TOTAL_POLL_ATTEMPTS) {
    console.log(`Max poll attempts (${MAX_TOTAL_POLL_ATTEMPTS}) reached for task ${taskId} — leaving as running for cron`);
    return;
  }

  await sleep(initialDelay);

  const nextAttempt = currentAttempt + 1;
  console.log(`Retry poll attempt ${nextAttempt} for task ${taskId} (${videoModel})`);

  let pollResult: any;
  try {
    pollResult = await callGenerateTTV({
      mode: 'poll',
      video_model: videoModel,
      polling_id,
      polling_url: polling_url ?? undefined,
    });
  } catch (e: any) {
    console.error(`Retry poll error for task ${taskId}: ${e.message}`);
    return; // leave as running for cron
  }

  await supabase
    .from('TTV_tasks')
    .update({ poll_attempts: nextAttempt, updated_at: new Date().toISOString() })
    .eq('id', taskId);

  console.log(`Retry poll attempt ${nextAttempt} raw result for task ${taskId} (${videoModel}): status=${pollResult?.status} error=${pollResult?.error ?? 'none'}`);

  if (pollResult?.status === 'completed') {
    await completeTask(task, pollResult.video_url, pollResult.sora_job_id);
    return;
  }
  if (pollResult?.status === 'failed') {
    if (pollResult.error === 'content_moderation') {
      await callEmptyRedoTTV(taskId);
      return;
    }
    console.error(`Video generation failed (model=${videoModel}, task=${taskId}): ${pollResult.error}`);
    return;
  }

  // Still pending — schedule another round
  console.log(`Task ${taskId} still pending (retry attempt ${nextAttempt}/${MAX_TOTAL_POLL_ATTEMPTS}) — scheduling next retry in ${initialDelay / 1000}s`);
  await firePollSelfCall(task, nextAttempt);
}

// ── Main serve ─────────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method !== 'POST')
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });

    const body = await req.json();

    // ── PHASE 2 POLL MODE (Sora High Res) ─────────────────────────────────────
    if (body.poll_mode === true) {
      const { task_id, group_id, user_id, batch_number, total_batches, tab, variant,
              video_model, video_duration, polling_id, polling_url } = body;

      if (!task_id || !group_id || !user_id || !polling_id) {
        return new Response(JSON.stringify({ error: 'Missing required poll_mode fields' }), { status: 400, headers: responseHeaders });
      }

      // Fetch fresh task data for completeTask
      const { data: freshTask, error: fetchErr } = await supabase
        .from('TTV_tasks')
        .select('*')
        .eq('id', task_id)
        .single();

      if (fetchErr || !freshTask) {
        return new Response(JSON.stringify({ error: `Task not found: ${fetchErr?.message}` }), { status: 404, headers: responseHeaders });
      }

      // Override polling fields from the call (in case DB doesn't have them yet)
      const patchedTask = { ...freshTask, polling_id, polling_url: polling_url ?? freshTask.polling_url };

      const pollAttempt: number = typeof body.poll_attempt === 'number' ? body.poll_attempt : 0;

      if (patchedTask.video_model === 'sora2pro_highres') {
        // Special phase 2: 180 s sleep then tight retry loop (fits in 400 s)
        (EdgeRuntime as any).waitUntil(phase2PollLoop(patchedTask));
      } else {
        // Generic retry: sleep full model interval → poll once → chain if still pending
        (EdgeRuntime as any).waitUntil(retryPollLoop(patchedTask, pollAttempt));
      }

      return new Response(
        JSON.stringify({ message: 'Poll retry started', task_id, batch_number, poll_attempt: pollAttempt }),
        { status: 200, headers: responseHeaders },
      );
    }

    // ── NORMAL SUBMIT MODE ────────────────────────────────────────────────────
    const { group_id, user_id, batch_number, total_batches, tab, variant } = body;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!group_id || !uuidRegex.test(group_id))
      return new Response(JSON.stringify({ error: 'Missing or invalid group_id' }), { status: 400, headers: responseHeaders });
    if (!user_id || !uuidRegex.test(user_id))
      return new Response(JSON.stringify({ error: 'Missing or invalid user_id' }), { status: 400, headers: responseHeaders });
    if (typeof batch_number !== 'number' || batch_number < 1)
      return new Response(JSON.stringify({ error: 'Missing or invalid batch_number' }), { status: 400, headers: responseHeaders });
    if (typeof total_batches !== 'number' || total_batches < 1)
      return new Response(JSON.stringify({ error: 'Missing or invalid total_batches' }), { status: 400, headers: responseHeaders });

    const tabNum = tab || 1;
    const variantNum = variant || 1;

    // Fetch the task
    const { data: tasks, error: fetchErr } = await supabase
      .from('TTV_tasks')
      .select('*')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('batch_number', batch_number)
      .eq('tab', tabNum)
      .eq('variant', variantNum)
      .in('status', ['queued', 'pending', 'error'])
      .order('created_at', { ascending: true })
      .limit(1);

    if (fetchErr)
      return new Response(JSON.stringify({ error: `DB fetch error: ${fetchErr.message}` }), { status: 500, headers: responseHeaders });

    if (!tasks || tasks.length === 0) {
      // Check whether the task is actively 'running' (poll chain in progress).
      // If so, do NOT call triggerNextTTV — that would start the next batch prematurely
      // and create concurrent parallel jobs (the root cause of re-submission).
      const { data: runningCheck } = await supabase
        .from('TTV_tasks')
        .select('id, status')
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .eq('batch_number', batch_number)
        .eq('tab', tabNum)
        .eq('variant', variantNum)
        .maybeSingle();

      if (runningCheck?.status === 'running') {
        console.log(`Task for batch ${batch_number} is already running — skipping re-submission`);
        return new Response(
          JSON.stringify({ message: `Task for batch ${batch_number} is already running`, batch_number }),
          { status: 200, headers: responseHeaders },
        );
      }

      // Task is completed/completed_final or doesn't exist — safe to trigger next
      console.log(`No actionable TTV task found for batch ${batch_number} — triggering next`);
      await triggerNextTTV(group_id, user_id, batch_number, tabNum, variantNum);
      return new Response(
        JSON.stringify({ message: `No actionable task for batch ${batch_number}`, batch_number }),
        { status: 200, headers: responseHeaders },
      );
    }

    const task = tasks[0];

    // If already completed, just fire next
    if (task.status === 'completed' || task.status === 'completed_final') {
      await triggerNextTTV(group_id, user_id, batch_number, tabNum, variantNum);
      return new Response(JSON.stringify({ message: 'Task already completed', batch_number }), { status: 200, headers: responseHeaders });
    }

    // ── Extract prompt ──────────────────────────────────────────────────────
    let prompt: string;
    try {
      const batchArr = Array.isArray(task.batch) ? task.batch : JSON.parse(task.batch);
      prompt = batchArr[0]?.prompt ?? '';
    } catch (_) {
      prompt = task.text_part ?? '';
    }
    if (!prompt) {
      await logError(`Task ${task.id} has no prompt`, new Error('empty prompt'));
      return new Response(JSON.stringify({ error: 'Task has no prompt' }), { status: 400, headers: responseHeaders });
    }

    // ── Set status to running ───────────────────────────────────────────────
    const { error: runErr } = await supabase
      .from('TTV_tasks')
      .update({ status: 'running', updated_at: new Date().toISOString(), error: null })
      .eq('id', task.id);

    if (runErr) {
      return new Response(JSON.stringify({ error: `Failed to set task running: ${runErr.message}` }), { status: 500, headers: responseHeaders });
    }

    // ── Submit video generation job ─────────────────────────────────────────
    let submitResult: any;
    try {
      submitResult = await callGenerateTTV({
        mode: 'submit',
        video_model: task.video_model,
        prompt,
        video_duration: task.video_duration,
        audio_clip: task.audio_clip ?? false,
      });
    } catch (e: any) {
      console.error(`generate-TTV submit failed for task ${task.id}: ${e.message}`);
      await logError(`generate-TTV submit failed for task ${task.id}`, e);
      // Leave as running for cron
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: responseHeaders });
    }

    console.log(`Video job submitted for task ${task.id}: ${JSON.stringify(submitResult).slice(0, 200)}`);

    // ── If model returned immediately (e.g. cached) ─────────────────────────
    if (submitResult.status === 'completed') {
      // Build storage path and complete inline (no waitUntil needed)
      const sanitized = sanitizeTitle(
        task.story_title.replace(/^TTV Prompt:\s*/i, '').replace(/^TTV Prompts:\s*/i, '')
      );
      const storagePath = `documents/${user_id}/${group_id}/TTV-${sanitized}_${task.folder_timestamp}/${batch_number}.mp4`;
      const isLegacy = await getIsLegacyPlan(user_id);
      const tps = ttvTokensPerSecond(isLegacy, task.video_model, !!task.audio_clip);
      const tokens = Math.round((task.video_duration ?? 5) * tps);

      (EdgeRuntime as any).waitUntil((async () => {
        try {
          const rawBytes = await downloadVideo(task.video_model, submitResult.video_url, submitResult.sora_job_id);
          const immediateStripAudio = ['grok', 'grok_highres', 'sora2pro', 'sora2pro_highres'].includes(task.video_model) && !(task.audio_clip ?? false);
          const videoBytes = immediateStripAudio ? stripAudioFromMp4(rawBytes) : rawBytes;
          await uploadVideoToStorage(videoBytes, storagePath);
          await supabase.from('TTV_tasks').update({
            status: 'completed', video_url: storagePath, tokens, token_updated: true,
            progress: 100,
            updated_at: new Date().toISOString(),
          }).eq('id', task.id);
          if (batch_number >= total_batches) {
            await compileFinalTTVDocument(user_id, group_id, task.story_title, task.description,
              task.variant, task.is_corrected, task.version, task.folder_timestamp, task.video_model, tabNum, task.audio_clip ?? false);
          } else {
            await triggerNextTTV(group_id, user_id, batch_number, tabNum, variantNum);
          }
        } catch (e: any) { await logError('Immediate completion error', e); }
      })());

      return new Response(
        JSON.stringify({ message: 'Video ready immediately', batch_number, task_id: task.id }),
        { status: 200, headers: responseHeaders },
      );
    }

    // ── Store polling info ──────────────────────────────────────────────────
    const { polling_id, polling_url } = submitResult;
    await supabase
      .from('TTV_tasks')
      .update({
        polling_id: polling_id ?? null,
        polling_url: polling_url ?? null,
        poll_attempts: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id);

    // ── Return 200 and poll in background ───────────────────────────────────
    const patchedTask = { ...task, polling_id, polling_url: polling_url ?? null };
    (EdgeRuntime as any).waitUntil(pollLoop(patchedTask));

    return new Response(
      JSON.stringify({
        message: 'Video generation submitted, polling in background',
        batch_number,
        task_id: task.id,
        video_model: task.video_model,
        polling_id,
      }),
      { status: 200, headers: responseHeaders },
    );

  } catch (error: any) {
    await logError('Unexpected error in process-TTV', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: responseHeaders },
    );
  }
});
