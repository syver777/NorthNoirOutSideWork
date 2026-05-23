// process-ITV/index.ts
// Main orchestrator for Image-to-Video (ITV) clip generation.
//
// Submit flow (normal mode):
//   1. Fetch queued ITV_task from DB
//   2. Call generate-ITV (submit mode) with { prompt, image_url, … } → polling_id / polling_url
//   3. Store polling info, send HTTP 200
//   4. EdgeRuntime.waitUntil → sleep → poll → download → upload to storage → update DB → trigger next
//
// Retry poll mode (all models):
//   process-ITV fires itself with { poll_mode: true, task_id, polling_id, poll_attempt, … }
//   One poll per invocation; chains via self-calls until completed or MAX_TOTAL_POLL_ATTEMPTS.
//
// compileFinalITVDocument:
//   Called when batch_number === total_batches.
//   Creates story_documents record pointing to the ITV folder (versions 22/23).
//   Marks all ITV_tasks completed_final.  Sets itv_video_folder_document_id.  Updates tabs.status = 'complete'.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { buildForwardPayload } from '../_shared/forwardSetupPayload.ts';
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

// Initial sleep (ms) before first poll attempt (all fal.ai — 90 s)
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

// Short models can fit multiple polls in one invocation (90 s × 3 = 270 s < 400 s budget)
const MAX_IN_PROCESS_POLL_ATTEMPTS = 3;
// Max total poll rounds across all self-call chains (prevents infinite loops)
// 5 × 90 s = 7.5 min max; check_stuck_itv_tasks resets tasks at poll_attempts=5
const MAX_TOTAL_POLL_ATTEMPTS = 5;
// Models with initial delay ≥ 180 s: one poll per invocation, chain via self-calls
// (currently empty — all models use fal.ai with 90 s delay)
const LONG_POLL_MODELS = new Set<string>();

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
    }
  } catch (error: any) {
    console.warn(`Error triggering size calculation for ${docId}:`, error.message);
  }
}

// ── generate-ITV caller ────────────────────────────────────────────────────────
async function callGenerateITV(body: Record<string, any>): Promise<any> {
  const res = await fetch(`${supabaseUrl}/functions/v1/generate-ITV`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`generate-ITV HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ── Video downloader ───────────────────────────────────────────────────────────
// All ITV models serve videos on public CDN URLs — no auth needed.
async function downloadVideo(videoUrl: string): Promise<Uint8Array> {
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Video download HTTP ${res.status} from ${videoUrl.slice(0, 200)}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

// ── Upload to storage (with retries) ──────────────────────────────────────────
async function uploadVideoToStorage(videoBytes: Uint8Array, storagePath: string): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { error } = await supabase.storage
        .from('stories')
        .upload(storagePath, videoBytes, { contentType: 'video/mp4', upsert: true });
      if (error) throw new Error(`Storage upload error: ${error.message}`);
      console.log(`Uploaded ITV video to ${storagePath}`);
      return;
    } catch (e: any) {
      if (attempt < maxAttempts) {
        console.warn(`ITV upload attempt ${attempt} failed: ${e.message} — retrying in 5 s`);
        await sleep(5_000);
      } else {
        throw e;
      }
    }
  }
}

// ── compileFinalITVDocument ────────────────────────────────────────────────────
async function compileFinalITVDocument(
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
    console.log(`compileFinalITVDocument: group=${groupId} variant=${variant} version=${version}`);

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
      console.log(`ITV document already exists for group ${groupId}, variant ${variant}, version ${version} — skipping`);
      return;
    }

    const cleanTitle = title
      .replace(/^ITV Prompt:\s*/i, '')
      .replace(/^ITV Prompts:\s*/i, '')
      .replace(/^ITV Outputs?:\s*/i, '')
      .trim();

    const sanitized = sanitizeTitle(cleanTitle);
    const folderPath = `documents/${userId}/${groupId}/ITV-${sanitized}_${folderTimestamp}`;
    console.log(`ITV folder path: ${folderPath}`);

    const { data: urlData } = supabase.storage.from('stories').getPublicUrl(folderPath);
    if (!urlData?.publicUrl) throw new Error('Failed to retrieve public folder URL for ITV folder');

    const documentId = crypto.randomUUID();
    const outputVersion = isCorrected ? 23 : 22;

    const { error: docError } = await supabase
      .from('story_documents')
      .insert({
        id: documentId,
        title: `ITV Outputs: ${cleanTitle}`,
        description,
        version: outputVersion,
        is_corrected: isCorrected,
        is_prompted: false,
        user_id: userId,
        file_path: folderPath,
        file_url: urlData.publicUrl,
        image_model: videoModel,      // store video model name in image_model column
        audio_clip: audioClip,
        created_at: new Date().toISOString(),
        group_id: groupId,
        variant,
        tab,
      });

    if (docError) throw new Error(`Failed to save ITV document: ${docError.message}`);
    console.log(`Created ITV story_documents record: ${documentId}`);

    // Trigger size calculation asynchronously (fire-and-forget)
    triggerSizeCalculation(documentId, folderPath, outputVersion).catch(err =>
      console.warn(`Size calculation failed for ${documentId}:`, err.message)
    );

    // Mark all ITV_tasks as completed_final and store folder document ID
    const { error: updateError } = await supabase
      .from('ITV_tasks')
      .update({
        status: 'completed_final',
        itv_video_folder_document_id: documentId,
        updated_at: new Date().toISOString(),
      })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant);

    if (updateError) {
      console.error(`Error marking ITV tasks completed_final: ${updateError.message}`);
    } else {
      console.log(`All ITV tasks marked completed_final for group ${groupId}`);
    }

    // Bridge to video_tasks pipeline: if this ITV run was triggered from the
    // main video pipeline (compile-audio → setup-itv-prompts), update statuses
    // and trigger the final video assembly chain.
    await bridgeITVToVideoTasks(userId, groupId, variant, tab, documentId);

    console.log(`compileFinalITVDocument completed for group ${groupId}`);
  } catch (error: any) {
    console.error(`Error in compileFinalITVDocument: ${error.message}`);
    await logError('Error compiling final ITV document', error);
    throw error;
  }
}

// ── Bridge ITV completion to video_tasks pipeline ──────────────────────────────
async function bridgeITVToVideoTasks(
  userId: string,
  groupId: string,
  variant: number,
  tab: number,
  folderDocumentId: string,
): Promise<void> {
  try {
    const { data: vt, error: vtError } = await supabase
      .from('video_tasks')
      .select('*')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .is('current_batch_number', null)
      .maybeSingle();

    if (vtError) {
      console.error(`Error querying video_tasks for ITV bridge: ${vtError.message}`);
    }

    if (!vt || vt.visual_type !== 'itv') {
      console.log('No video_tasks ITV row found — standalone ITV run, skipping bridge');
      return;
    }

    console.log(`Bridging ITV completion to video_tasks (task ${vt.id})`);

    // 1. Update ALL ITV-related statuses to completed
    await supabase
      .from('video_tasks')
      .update({
        image_prompt_status: 'completed',
        image_prompt_progress: 100,
        image_generation_status: 'completed',
        image_generation_progress: 100,
        itv_prompt_status: 'completed',
        itv_prompt_progress: 100,
        itv_status: 'completed',
        itv_progress: 100,
        itv_video_folder_document_id: folderDocumentId,
        updated_at: new Date().toISOString(),
      })
      .eq('group_id', groupId)
      .eq('user_id', userId);

    // 2. Check if all other pipeline steps are completed
    const storyOk = !vt.process_story || vt.story_status === 'completed';
    const audioOk = !vt.process_audio || vt.audio_status === 'completed';

    if (!(storyOk && audioOk)) {
      console.log(`video_tasks not fully ready yet — story:${storyOk} audio:${audioOk}`);
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
      try {
        const settingsObj = typeof vt.settings === 'string' ? JSON.parse(vt.settings) : vt.settings;
        if (settingsObj?.audio_file_path) audioFilePathForSetup = settingsObj.audio_file_path;
        else if (settingsObj?.audio_folder_path) audioFolderPathForSetup = settingsObj.audio_folder_path;
      } catch (_) { /* ignore */ }
    }

    const { data: folderDoc } = await supabase
      .from('story_documents')
      .select('file_path')
      .eq('id', folderDocumentId)
      .single();

    const visualFolderPath = folderDoc?.file_path || null;

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
        visual_type: 'itv',
        audio_clip: vt.audio_clip,
        process_ttv: false,
        process_itv: true,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`Failed to trigger setup-video-tasks from ITV bridge: HTTP ${resp.status}: ${errText.slice(0, 300)}`);
    } else {
      console.log('Successfully triggered video creation from ITV bridge');
    }
  } catch (err: any) {
    console.error(`Error in bridgeITVToVideoTasks: ${err.message}`);
    await logError('Error bridging ITV to video_tasks', err);
  }
}

// ── Trigger next ITV ───────────────────────────────────────────────────────────
async function triggerNextITV(
  groupId: string,
  userId: string,
  currentBatchNumber: number,
  tab: number,
  variant: number,
): Promise<void> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/trigger-next-ITV`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
      body: JSON.stringify({ group_id: groupId, user_id: userId, current_batch_number: currentBatchNumber, tab, variant }),
    });
    if (!res.ok) {
      console.warn(`trigger-next-ITV returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } else {
      console.log(`trigger-next-ITV called successfully after batch ${currentBatchNumber}`);
    }
  } catch (e: any) {
    console.error(`Error calling trigger-next-ITV: ${e.message}`);
    await logError('Error calling trigger-next-ITV', e);
  }
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

// ── Core: complete a task after poll succeeded ─────────────────────────────────
async function completeTask(
  task: Record<string, any>,
  videoUrl: string,
): Promise<void> {
  const {
    id: taskId, user_id: userId, group_id: groupId,
    batch_number: batchNumber, total_batches: totalBatches,
    story_title: storyTitle, description, variant, is_corrected: isCorrected,
    version, folder_timestamp: folderTimestamp, video_model: videoModel,
    video_duration: videoDuration, tab, audio_clip: audioClip,
  } = task;

  // Download video bytes from CDN
  // Retries handle CDN propagation delay: ModelsLab can return a success + URL before
  // the R2 object is fully available, causing a transient 404 on first fetch.
  console.log(`Downloading ITV video for task ${taskId} (model=${videoModel})`);
  let videoBytes: Uint8Array | null = null;
  const downloadDelays = [5_000, 15_000, 30_000];
  for (let dlAttempt = 0; dlAttempt <= downloadDelays.length; dlAttempt++) {
    try {
      videoBytes = await downloadVideo(videoUrl);
      break;
    } catch (e: any) {
      if (dlAttempt < downloadDelays.length) {
        console.warn(
          `ITV video download attempt ${dlAttempt + 1} failed for task ${taskId}: ${e.message}` +
          ` — retrying in ${downloadDelays[dlAttempt] / 1000}s`,
        );
        await sleep(downloadDelays[dlAttempt]);
      } else {
        // All retries exhausted — reset the task so trigger-next-ITV resubmits it
        // rather than leaving it stuck in 'running' until the cron runs.
        console.error(
          `ITV video download failed after ${dlAttempt + 1} attempts for task ${taskId}: ${e.message}` +
          ` — resetting task to queued for resubmit`,
        );
        await logError(`ITV video download failed for task ${taskId}`, e);
        await supabase
          .from('ITV_tasks')
          .update({
            status: 'queued',
            polling_id: null,
            polling_url: null,
            poll_attempts: 0,
            error: `CDN download failed: ${e.message}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', taskId);
        await triggerNextITV(groupId, userId, batchNumber, tab, variant);
        return;
      }
    }
  }
  if (!videoBytes) return; // unreachable — satisfies TypeScript

  // Safety net: seedance15 may still produce audio even when generate_audio=false — strip here when not requested.
  // Other models (ltx23*, veo31*) properly respect the generate_audio API parameter.
  const shouldStripAudio = videoModel === 'seedance15' && !audioClip;
  const finalVideoBytes = shouldStripAudio ? stripAudioFromMp4(videoBytes) : videoBytes;
  if (shouldStripAudio) console.log(`ITV task ${taskId}: stripping audio from seedance15 output`);

  // Build storage path: documents/{userId}/{groupId}/ITV-{sanitized}_{folderTimestamp}/{batchNumber}.mp4
  const cleanTitle = (storyTitle ?? '')
    .replace(/^ITV Prompt:\s*/i, '')
    .replace(/^ITV Prompts:\s*/i, '')
    .replace(/^ITV Outputs?:\s*/i, '')
    .trim();
  const sanitized = sanitizeTitle(cleanTitle);
  const storagePath = `documents/${userId}/${groupId}/ITV-${sanitized}_${folderTimestamp}/${batchNumber}.mp4`;

  // Upload
  try {
    await uploadVideoToStorage(finalVideoBytes, storagePath);
  } catch (e: any) {
    console.error(`ITV upload failed for task ${taskId}: ${e.message}`);
    return;
  }

  // Calculate tokens consumed
  const isLegacy = await getIsLegacyPlan(userId);
  const tps = itvTokensPerSecond(isLegacy, videoModel, !!audioClip);
  const tokens = Math.round((videoDuration ?? 5) * tps);

  // Mark task as completed
  await supabase
    .from('ITV_tasks')
    .update({
      status: 'completed',
      video_url: storagePath,
      tokens,
      token_updated: true,
      progress: 100,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  console.log(`ITV task ${taskId} (batch ${batchNumber}/${totalBatches}) completed — tokens ${tokens}`);

  // Update video_tasks with incremental ITV progress (non-fatal)
  try {
    const progressPct = Math.round((batchNumber / totalBatches) * 100);
    const { data: vt } = await supabase
      .from('video_tasks')
      .select('id')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('visual_type', 'itv')
      .maybeSingle();
    if (vt) {
      await supabase
        .from('video_tasks')
        .update({
          itv_progress: progressPct,
          itv_status: batchNumber >= totalBatches ? 'completed' : 'running',
          updated_at: new Date().toISOString(),
        })
        .eq('id', vt.id);
      console.log(`video_tasks itv_progress updated to ${progressPct}%`);
    }
  } catch (err: any) {
    console.warn(`Failed to update video_tasks itv_progress (non-fatal): ${err.message}`);
  }

  // Final compilation or trigger next
  if (batchNumber >= totalBatches) {
    await compileFinalITVDocument(
      userId, groupId, storyTitle, description, variant, isCorrected, version, folderTimestamp, videoModel, tab, audioClip,
    );
  } else {
    await triggerNextITV(groupId, userId, batchNumber, tab, variant);
  }
}

// ── Fire a poll-retry self-call ────────────────────────────────────────────────
async function firePollSelfCall(task: Record<string, any>, pollAttempt: number): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/functions/v1/process-ITV`, {
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
    await logError(`Failed to fire poll retry self-call for ITV task ${task.id}`, e);
  }
}

// ── Poll loop (runs inside EdgeRuntime.waitUntil) ──────────────────────────────
async function pollLoop(task: Record<string, any>): Promise<void> {
  const { id: taskId, video_model: videoModel, polling_id, polling_url } = task;
  const initialDelay = INITIAL_POLL_DELAY_MS[videoModel] ?? 90_000;

  // First sleep: wait the full model interval before first poll
  await sleep(initialDelay);

  console.log(`ITV polling attempt 1 for task ${taskId} (${videoModel})`);
  let pollResult: any;
  try {
    pollResult = await callGenerateITV({
      mode: 'poll',
      video_model: videoModel,
      polling_id,
      polling_url: polling_url ?? undefined,
    });
  } catch (e: any) {
    console.error(`ITV poll attempt 1 error for task ${taskId}: ${e.message}`);
    return; // leave as running for cron
  }

  await supabase
    .from('ITV_tasks')
    .update({ poll_attempts: 1, updated_at: new Date().toISOString() })
    .eq('id', taskId);

  if (pollResult?.status === 'completed') {
    await completeTask(task, pollResult.video_url);
    return;
  }
  if (pollResult?.status === 'failed') {
    console.error(`ITV generation failed (model=${videoModel}, task=${taskId}): ${pollResult.error}`);
    await supabase
      .from('ITV_tasks')
      .update({ status: 'error', error: pollResult.error ?? 'ITV generation failed', updated_at: new Date().toISOString() })
      .eq('id', taskId);
    return;
  }

  // Still pending after attempt 1
  console.log(`ITV task ${taskId} still pending (attempt 1) — model: ${videoModel}`);

  if (LONG_POLL_MODELS.has(videoModel)) {
    // All fal.ai models: poll in-process, chain via self-calls if time runs out
    console.log(`Long-poll model (${videoModel}) — scheduling retry self-call`);
    await firePollSelfCall(task, 1);
    return;
  }

  // Short models (90 s initial delay): do up to 2 more polls within this invocation
  // (3 × 90 s = 270 s < 400 s edge function budget)
  for (let attempt = 2; attempt <= MAX_IN_PROCESS_POLL_ATTEMPTS; attempt++) {
    await sleep(initialDelay);

    console.log(`ITV polling attempt ${attempt} for task ${taskId} (${videoModel})`);
    let result: any;
    try {
      result = await callGenerateITV({
        mode: 'poll',
        video_model: videoModel,
        polling_id,
        polling_url: polling_url ?? undefined,
      });
    } catch (e: any) {
      console.error(`ITV poll attempt ${attempt} error for task ${taskId}: ${e.message}`);
      if (attempt < MAX_IN_PROCESS_POLL_ATTEMPTS) continue;
      break;
    }

    await supabase
      .from('ITV_tasks')
      .update({ poll_attempts: attempt, updated_at: new Date().toISOString() })
      .eq('id', taskId);

    if (result?.status === 'completed') {
      await completeTask(task, result.video_url);
      return;
    }
    if (result?.status === 'failed') {
      console.error(`ITV generation failed (model=${videoModel}, task=${taskId}): ${result.error}`);
      await supabase
        .from('ITV_tasks')
        .update({ status: 'error', error: result.error ?? 'ITV generation failed', updated_at: new Date().toISOString() })
        .eq('id', taskId);
      return;
    }
    console.log(`ITV task ${taskId} still pending (attempt ${attempt}/${MAX_IN_PROCESS_POLL_ATTEMPTS})`);
  }

  // In-process attempts exhausted — schedule a retry self-call to continue later
  console.log(`In-process polls exhausted for ITV task ${taskId} (${videoModel}) — scheduling retry self-call`);
  await firePollSelfCall(task, MAX_IN_PROCESS_POLL_ATTEMPTS);
}

// ── Generic retry poll loop — called via poll_mode self-call ───────────────────
// Sleeps the model's full interval, polls once, fires another self-call if still
// pending and under MAX_TOTAL_POLL_ATTEMPTS.
async function retryPollLoop(task: Record<string, any>, currentAttempt: number): Promise<void> {
  const { id: taskId, video_model: videoModel, polling_id, polling_url } = task;
  const initialDelay = INITIAL_POLL_DELAY_MS[videoModel] ?? 360_000;

  if (currentAttempt >= MAX_TOTAL_POLL_ATTEMPTS) {
    console.log(`Max poll attempts (${MAX_TOTAL_POLL_ATTEMPTS}) reached for ITV task ${taskId} — leaving as running for cron`);
    return;
  }

  await sleep(initialDelay);

  const nextAttempt = currentAttempt + 1;
  console.log(`ITV retry poll attempt ${nextAttempt} for task ${taskId} (${videoModel})`);

  let pollResult: any;
  try {
    pollResult = await callGenerateITV({
      mode: 'poll',
      video_model: videoModel,
      polling_id,
      polling_url: polling_url ?? undefined,
    });
  } catch (e: any) {
    console.error(`ITV retry poll error for task ${taskId}: ${e.message}`);
    return; // leave as running for cron
  }

  await supabase
    .from('ITV_tasks')
    .update({ poll_attempts: nextAttempt, updated_at: new Date().toISOString() })
    .eq('id', taskId);

  if (pollResult?.status === 'completed') {
    await completeTask(task, pollResult.video_url);
    return;
  }
  if (pollResult?.status === 'failed') {
    console.error(`ITV generation failed (model=${videoModel}, task=${taskId}): ${pollResult.error}`);
    await supabase
      .from('ITV_tasks')
      .update({ status: 'error', error: pollResult.error ?? 'ITV generation failed', updated_at: new Date().toISOString() })
      .eq('id', taskId);
    return;
  }

  // Still pending — schedule another round
  console.log(`ITV task ${taskId} still pending (retry ${nextAttempt}/${MAX_TOTAL_POLL_ATTEMPTS}) — scheduling next retry in ${initialDelay / 1000}s`);
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

    // ── POLL RETRY MODE ───────────────────────────────────────────────────────
    if (body.poll_mode === true) {
      const { task_id, group_id, user_id, polling_id, polling_url, poll_attempt } = body;

      if (!task_id || !group_id || !user_id || !polling_id) {
        return new Response(JSON.stringify({ error: 'Missing required poll_mode fields' }), { status: 400, headers: responseHeaders });
      }

      // Fetch fresh task data for completeTask
      const { data: freshTask, error: fetchErr } = await supabase
        .from('ITV_tasks')
        .select('*')
        .eq('id', task_id)
        .single();

      if (fetchErr || !freshTask) {
        return new Response(JSON.stringify({ error: `ITV task not found: ${fetchErr?.message}` }), { status: 404, headers: responseHeaders });
      }

      // Override polling fields from the call body (in case DB hasn't been updated yet)
      const patchedTask = {
        ...freshTask,
        polling_id,
        polling_url: polling_url ?? freshTask.polling_url,
      };

      const currentAttempt: number = typeof poll_attempt === 'number' ? poll_attempt : 0;

      // Generic retry: sleep full model interval → poll once → chain if still pending
      (EdgeRuntime as any).waitUntil(retryPollLoop(patchedTask, currentAttempt));

      return new Response(
        JSON.stringify({ message: 'ITV poll retry started', task_id, poll_attempt: currentAttempt }),
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

    // Fetch the ITV task
    const { data: tasks, error: fetchErr } = await supabase
      .from('ITV_tasks')
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
      // Check if task is actively 'running' (poll chain in progress) — avoid starting next prematurely
      const { data: runningCheck } = await supabase
        .from('ITV_tasks')
        .select('id, status')
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .eq('batch_number', batch_number)
        .eq('tab', tabNum)
        .eq('variant', variantNum)
        .maybeSingle();

      if (runningCheck?.status === 'running') {
        console.log(`ITV task for batch ${batch_number} is already running — skipping re-submission`);
        return new Response(
          JSON.stringify({ message: `ITV task for batch ${batch_number} is already running`, batch_number }),
          { status: 200, headers: responseHeaders },
        );
      }

      // Task is completed/completed_final or doesn't exist — safe to trigger next
      console.log(`No actionable ITV task found for batch ${batch_number} — triggering next`);
      await triggerNextITV(group_id, user_id, batch_number, tabNum, variantNum);
      return new Response(
        JSON.stringify({ message: `No actionable ITV task for batch ${batch_number}`, batch_number }),
        { status: 200, headers: responseHeaders },
      );
    }

    const task = tasks[0];

    // If already completed, just fire next
    if (task.status === 'completed' || task.status === 'completed_final') {
      await triggerNextITV(group_id, user_id, batch_number, tabNum, variantNum);
      return new Response(JSON.stringify({ message: 'ITV task already completed', batch_number }), { status: 200, headers: responseHeaders });
    }

    // ── Extract prompt and image_url from task batch ──────────────────────────
    let prompt: string;
    let imageUrl: string;
    try {
      const batchArr = Array.isArray(task.batch) ? task.batch : JSON.parse(task.batch ?? '[]');
      prompt = batchArr[0]?.prompt ?? '';
      imageUrl = batchArr[0]?.image_url ?? task.image_url ?? '';
    } catch (_) {
      prompt = task.prompt ?? '';
      imageUrl = task.image_url ?? '';
    }

    if (!prompt) {
      await logError(`ITV task ${task.id} has no prompt`, new Error('empty prompt'));
      return new Response(JSON.stringify({ error: 'ITV task has no prompt' }), { status: 400, headers: responseHeaders });
    }
    if (!imageUrl) {
      await logError(`ITV task ${task.id} has no image_url`, new Error('empty image_url'));
      return new Response(JSON.stringify({ error: 'ITV task has no image_url (required for ITV models)' }), { status: 400, headers: responseHeaders });
    }

    // ── Convert Supabase storage URL → signed URL for external API access ────
    // Public-bucket URLs may be blocked by external services; signed URLs are
    // always accessible. Mirrors Python's upload_image_to_supabase() pattern.
    if (imageUrl.includes('/storage/v1/object/')) {
      try {
        const storagePathMatch = imageUrl.match(/\/storage\/v1\/object\/(?:public\/)?stories\/(.+)$/);
        if (storagePathMatch) {
          const storagePath = decodeURIComponent(storagePathMatch[1]);
          const { data: signedData, error: signErr } = await supabase.storage
            .from('stories')
            .createSignedUrl(storagePath, 7200); // 2-hour window — more than enough for any model
          if (!signErr && signedData?.signedUrl) {
            console.log(`ITV task ${task.id}: using signed URL for image (path=${storagePath})`);
            imageUrl = signedData.signedUrl;
          } else {
            console.warn(`ITV task ${task.id}: failed to create signed URL (${signErr?.message}), falling back to original`);
          }
        }
      } catch (e: any) {
        console.warn(`ITV task ${task.id}: error creating signed URL: ${e.message}`);
      }
    }

    // ── Set status to running ─────────────────────────────────────────────────
    const { error: runErr } = await supabase
      .from('ITV_tasks')
      .update({ status: 'running', updated_at: new Date().toISOString(), error: null })
      .eq('id', task.id);

    if (runErr) {
      return new Response(JSON.stringify({ error: `Failed to set ITV task running: ${runErr.message}` }), { status: 500, headers: responseHeaders });
    }

    // ── Submit ITV generation job ─────────────────────────────────────────────
    let submitResult: any;
    try {
      submitResult = await callGenerateITV({
        mode: 'submit',
        video_model: task.video_model,
        prompt,
        image_url: imageUrl,
        video_duration: task.video_duration,
        audio_clip: task.audio_clip ?? false,
      });
    } catch (e: any) {
      console.error(`generate-ITV submit failed for task ${task.id}: ${e.message}`);
      await logError(`generate-ITV submit failed for task ${task.id}`, e);
      // Leave as running for cron
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: responseHeaders });
    }

    console.log(`ITV job submitted for task ${task.id}: ${JSON.stringify(submitResult).slice(0, 200)}`);

    // ── If model returned video immediately ───────────────────────────────────
    if (submitResult.status === 'completed') {
      (EdgeRuntime as any).waitUntil((async () => {
        try {
          await completeTask(task, submitResult.video_url);
        } catch (e: any) {
          await logError('ITV immediate completion error', e);
        }
      })());

      return new Response(
        JSON.stringify({ message: 'ITV video ready immediately', batch_number, task_id: task.id }),
        { status: 200, headers: responseHeaders },
      );
    }

    // ── Store polling info ────────────────────────────────────────────────────
    const { polling_id, polling_url } = submitResult;
    await supabase
      .from('ITV_tasks')
      .update({
        polling_id: polling_id ?? null,
        polling_url: polling_url ?? null,
        poll_attempts: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id);

    // ── Return 200 and poll in background ─────────────────────────────────────
    const patchedTask = { ...task, polling_id, polling_url: polling_url ?? null };
    (EdgeRuntime as any).waitUntil(pollLoop(patchedTask));

    return new Response(
      JSON.stringify({
        message: 'ITV generation submitted, polling in background',
        batch_number,
        task_id: task.id,
        video_model: task.video_model,
        polling_id,
      }),
      { status: 200, headers: responseHeaders },
    );

  } catch (error: any) {
    await logError('Unexpected error in process-ITV', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: responseHeaders },
    );
  }
});
