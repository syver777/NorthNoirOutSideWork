// process-ITV-prompt/index.ts
// Dual-phase ITV prompt processor.
//
// Phase 1 (itv=false):
//   - Calls generate-ITV-prompt for keyframe image prompts → [{text, image_prompt}]
//   - On last batch: compiles doc, calls setup-image-tasks(itv=true), creates Phase 2 tasks,
//     fires trigger-next-ITV-prompt(itv=true)
//
// Phase 2 (itv=true):
//   - Calls generate-ITV-prompt for motion/animation prompts → [{text, prompt}]
//   - On last batch: compiles doc, dual-completion check with image_tasks(itv=TRUE)
//     → if both complete fires setup-ITV-tasks
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const startTime = Date.now();
const idleTimeout = 140000;  // 140 s

const BATCH_SIZE = 2;

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface RequestBody {
  group_id: string;
  user_id: string;
  batch_number: number;
  total_batches: number;
  itv: boolean;   // false=Phase 1, true=Phase 2
  tab?: number;
  variant?: number;
}

interface ITVPromptTask {
  id: string;
  user_id: string;
  group_id: string;
  story_title: string;
  description: string;
  batch: Array<{ text: string; index: number; image_prompt?: string }>;
  text_part: string;
  batch_output: string;
  total_batches: number;
  total_prompts: number;
  batch_number: number;
  status: string;
  error: string | null;
  settings: {
    video_model: string;
    clip_duration: number;
    image_model: string;
    audio_clip: boolean;
    style?: string;
    characters?: Record<string, string>;
    useCharacterDescriptions?: boolean;
  };
  input_tokens: number;
  output_tokens: number;
  variant: number;
  is_corrected: boolean;
  version: number;
  language: string;
  model: string;
  tab: number;
  itv: boolean;
  audio_clip: boolean;
  video_process?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function validateInputs(data: any): string | null {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!data?.group_id || !uuidRegex.test(data.group_id)) return 'Missing or invalid group_id';
  if (!data?.user_id || !uuidRegex.test(data.user_id)) return 'Missing or invalid user_id';
  if (typeof data?.batch_number !== 'number' || data.batch_number < 1) return 'Missing or invalid batch_number';
  if (typeof data?.total_batches !== 'number' || data.total_batches < 1) return 'Missing or invalid total_batches';
  if (typeof data?.itv !== 'boolean') return 'Missing or invalid itv (must be boolean)';
  if (typeof data?.variant !== 'undefined' && (typeof data.variant !== 'number' || data.variant < 1)) return 'Invalid variant';
  return null;
}

function isRetryableError(error: any): boolean {
  const msg = error.message || error.toString() || '';
  return ['520', '500', '502', '503', '504', 'connection', 'timeout', 'Failed to']
    .some(s => msg.includes(s));
}

// Detects ReferenceError / "X is not defined" style code bugs. When these
// occur we silently mark the task as 'running' (with no `error` column) so
// the stuck-task retry system can pick it up without surfacing a hard error.
function isSilentError(error: any): boolean {
  const msg = error?.message || error?.toString() || '';
  const name = error?.name || '';
  return name === 'ReferenceError' || msg.includes('is not defined');
}

function buildErrorUpdate(error: any, prefix: string): Record<string, any> {
  const silent = isSilentError(error);
  const status = silent || isRetryableError(error) ? 'running' : 'pending';
  return {
    status,
    error: silent ? null : `${prefix}: ${error.message}`,
    updated_at: new Date().toISOString(),
  };
}

// ─── video_tasks progress helper (non-fatal) ─────────────────────────────────

async function updateVideoTasksProgress(
  userId: string,
  groupId: string,
  tab: number,
  updates: Record<string, any>,
): Promise<void> {
  try {
    const { data: vt } = await supabase
      .from('video_tasks')
      .select('id')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('visual_type', 'itv')
      .maybeSingle();

    if (!vt) return; // No video_tasks row for ITV — nothing to update

    const { error } = await supabase
      .from('video_tasks')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', vt.id);

    if (error) console.warn(`video_tasks progress update failed: ${error.message}`);
  } catch (err: any) {
    console.warn(`video_tasks progress update error (non-fatal): ${err.message}`);
  }
}

// ─── Reset stuck tasks ────────────────────────────────────────────────────────

async function resetStuckTasks(groupId: string, userId: string, itvFlag: boolean, tab: number = 1, variant: number = 1) {
  try {
    const { data: stuckTasks, error } = await supabase
      .from('ITV_prompt_tasks')
      .select('id, updated_at, batch_number')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .eq('itv', itvFlag)
      .eq('status', 'running');

    if (error) throw new Error(`Failed to check stuck ITV tasks: ${error.message}`);

    const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
    const now = Date.now();
    for (const task of (stuckTasks ?? [])) {
      const age = now - new Date(task.updated_at).getTime();
      if (age > STUCK_THRESHOLD_MS) {
        console.log(`Resetting stuck ITV task ${task.id} (batch ${task.batch_number}, age ${Math.round(age / 1000)}s)`);
        await supabase
          .from('ITV_prompt_tasks')
          .update({ status: 'queued', error: 'Reset from stuck running state', updated_at: new Date().toISOString() })
          .eq('id', task.id);
      }
    }
  } catch (err: any) {
    console.error(`Error resetting stuck ITV tasks: ${err.message}`);
    await logError('Failed to reset stuck ITV tasks', err);
  }
}

// ─── Trigger size calculation ──────────────────────────────────────────────────

async function triggerSizeCalculation(docId: string, filePath: string, version: number): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/functions/v1/calculate-file-size`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
      body: JSON.stringify({ id: docId, file_path: filePath, version }),
    });
  } catch (err: any) {
    console.warn(`Size calculation failed for ${docId}: ${err.message}`);
  }
}

// ─── Compile final Phase 1 document and trigger Phase 2 setup ────────────────

async function compileFinalPhase1Document(
  task: ITVPromptTask,
  userId: string,
  groupId: string,
  tab: number,
  variant: number,
): Promise<void> {
  console.log(`Compiling final Phase 1 ITV document for group ${groupId}, tab ${tab}`);

  const { data, error } = await supabase
    .from('ITV_prompt_tasks')
    .select('batch_output, batch_number, version, story_title, is_corrected, settings, language, model, audio_clip')
    .eq('user_id', userId)
    .eq('group_id', groupId)
    .eq('tab', tab)
    .eq('variant', variant)
    .eq('itv', false)
    .gt('batch_number', 0)
    .order('batch_number', { ascending: true });

  if (error || !data || data.length === 0) throw new Error(`Failed to fetch Phase 1 ITV tasks for compilation: ${error?.message ?? 'No data'}`);

  // Aggregate all [{text, image_prompt}] items
  const allPhase1Prompts: Array<{ text: string; image_prompt: string }> = [];
  for (const row of data) {
    if (!row.batch_output) continue;
    try {
      const parsed = JSON.parse(row.batch_output);
      if (Array.isArray(parsed)) allPhase1Prompts.push(...parsed);
    } catch (_) {
      console.error(`Could not parse batch_output for Phase 1 batch ${row.batch_number}`);
    }
  }

  if (allPhase1Prompts.length === 0) throw new Error('No Phase 1 image prompts found — cannot compile');

  const fullContent = JSON.stringify(allPhase1Prompts, null, 2);
  console.log(`Compiled ${allPhase1Prompts.length} Phase 1 ITV image prompts`);

  const sanitizedTitle = task.story_title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const finalFilePath = `documents/${userId}/${groupId}/itv-image-prompts-${sanitizedTitle}_${timestamp}.json`;

  const { error: uploadError } = await supabase.storage
    .from('stories')
    .upload(finalFilePath, new TextEncoder().encode(fullContent), { contentType: 'application/json' });

  if (uploadError) throw new Error(`Phase 1 upload failed: ${uploadError.message}`);
  console.log(`Uploaded Phase 1 ITV doc to ${finalFilePath}`);

  const { data: urlData } = supabase.storage.from('stories').getPublicUrl(finalFilePath);
  if (!urlData?.publicUrl) throw new Error('Failed to get public URL for Phase 1 ITV doc');

  const isCorrected = task.is_corrected;
  const version = isCorrected ? 17 : 16;
  const documentId = crypto.randomUUID();

  const { error: docError } = await supabase
    .from('story_documents')
    .insert({
      id: documentId,
      title: `ITV Image Prompts: ${task.story_title}`,
      description: task.description,
      word_count: countWords(fullContent),
      version,
      is_corrected: isCorrected,
      is_prompted: true,
      user_id: userId,
      file_path: finalFilePath,
      file_url: urlData.publicUrl,
      created_at: new Date().toISOString(),
      group_id: groupId,
      variant,
      image_model: task.settings.image_model,
      language: task.language ?? 'english',
      model: task.model ?? 'deepseek',
      tab,
    });

  if (docError) throw new Error(`Failed to save Phase 1 ITV story_documents: ${docError.message}`);
  console.log(`Saved Phase 1 ITV story_documents record: ${documentId}`);

  // Fire-and-forget size calculation
  triggerSizeCalculation(documentId, finalFilePath, version).catch(() => {});

  // Mark all Phase 1 tasks as completed_final and store document ID
  const { error: updateError } = await supabase
    .from('ITV_prompt_tasks')
    .update({
      status: 'completed_final',
      itv_image_prompt_document_id: documentId,
      updated_at: new Date().toISOString(),
    })
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('tab', tab)
    .eq('variant', variant)
    .eq('itv', false)
    .gt('batch_number', 0);

  if (updateError) throw new Error(`Failed to mark Phase 1 ITV tasks as completed_final: ${updateError.message}`);

  // Update video_tasks: ITV image prompts phase complete
  await updateVideoTasksProgress(userId, groupId, tab, {
    image_prompt_status: 'completed',
    image_prompt_progress: 100,
    image_generation_status: 'running',
    itv_image_prompt_document_id: documentId,
  });

  // Upsert ITV_prompt_context(itv=true) with phase1_document_path
  await supabase
    .from('ITV_prompt_context')
    .upsert({
      group_id: groupId,
      user_id: userId,
      tab,
      variant,
      part_number: 1,
      itv: true,
      phase1_document_path: finalFilePath,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'group_id,tab,part_number,itv' });

  // ── Trigger image generation for the keyframes ──────────────────────────
  console.log(`Calling setup-image-tasks with itv=true for group ${groupId}, tab ${tab}`);
  fetch(`${supabaseUrl}/functions/v1/setup-image-tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
    body: JSON.stringify({
      user_id: userId,
      group_id: groupId,
      doc_id: documentId,
      file_path: finalFilePath,
      story_title: task.story_title,
      description: task.description,
      version,
      is_corrected: isCorrected,
      variant,
      image_model: task.settings.image_model,
      language: task.language ?? 'english',
      model: task.model ?? 'deepseek',
      tab,
      audio_clip: task.settings.audio_clip ?? false,
      itv: true,
      videoProcess: task.video_process || false,
    }),
  }).catch(err => {
    console.error(`Error calling setup-image-tasks (itv=true): ${err.message}`);
    logError('Error calling setup-image-tasks (itv=true)', err);
  });

  // ── Create Phase 2 ITV_prompt_tasks(itv=true) ────────────────────────────
  const phase2Version = isCorrected ? 21 : 20;
  const totalPhase2Prompts = allPhase1Prompts.length;
  const totalPhase2Batches = Math.ceil(totalPhase2Prompts / BATCH_SIZE);

  console.log(`Creating ${totalPhase2Batches} Phase 2 ITV prompt batches (${totalPhase2Prompts} prompts)`);

  const phase2Rows: any[] = [];
  for (let i = 0; i < totalPhase2Batches; i++) {
    const batchNumber = i + 1;
    const slice = allPhase1Prompts.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    const batchItems = slice.map((p, j) => ({
      text: p.text,
      image_prompt: p.image_prompt,
      index: i * BATCH_SIZE + j + 1,
    }));

    phase2Rows.push({
      user_id: userId,
      group_id: groupId,
      story_title: task.story_title,
      description: task.description,
      batch: batchItems,
      text_part: String(1),  // All Phase 2 batches reference part_number=1 in ITV_prompt_context (itv=true)
      batch_number: batchNumber,
      total_batches: totalPhase2Batches,
      total_prompts: totalPhase2Prompts,
      status: batchNumber === 1 ? 'queued' : 'pending',
      version: phase2Version,
      is_corrected: isCorrected,
      variant,
      language: task.language ?? 'english',
      model: task.model ?? 'deepseek',
      tab,
      itv: true,
      audio_clip: task.settings.audio_clip ?? false,
      video_process: task.video_process || false,
      settings: task.settings,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  const { error: insertError } = await supabase.from('ITV_prompt_tasks').insert(phase2Rows);
  if (insertError) throw new Error(`Failed to create Phase 2 ITV prompt tasks: ${insertError.message}`);
  console.log(`Created ${phase2Rows.length} Phase 2 ITV prompt tasks for group ${groupId}, tab ${tab}`);

  // Fire trigger-next-ITV-prompt for Phase 2
  fetch(`${supabaseUrl}/functions/v1/trigger-next-ITV-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
    body: JSON.stringify({ group_id: groupId, user_id: userId, current_batch_number: 0, itv: true, tab, variant }),
  }).catch(err => {
    console.error(`Error firing trigger-next-ITV-prompt (itv=true): ${err.message}`);
    logError('Error firing trigger-next-ITV-prompt (Phase 2)', err);
  });

  console.log(`Phase 1 ITV compilation complete. Phase 2 + image generation triggered for group ${groupId}, tab ${tab}`);
}

// ─── Compile final Phase 2 document and dual-completion check ────────────────

async function compileFinalPhase2Document(
  task: ITVPromptTask,
  userId: string,
  groupId: string,
  tab: number,
  variant: number,
): Promise<void> {
  console.log(`Compiling final Phase 2 ITV document for group ${groupId}, tab ${tab}`);

  const { data, error } = await supabase
    .from('ITV_prompt_tasks')
    .select('batch_output, batch_number, version, is_corrected')
    .eq('user_id', userId)
    .eq('group_id', groupId)
    .eq('tab', tab)
    .eq('variant', variant)
    .eq('itv', true)
    .gt('batch_number', 0)
    .order('batch_number', { ascending: true });

  if (error || !data || data.length === 0) throw new Error(`Failed to fetch Phase 2 ITV tasks for compilation: ${error?.message ?? 'No data'}`);

  // Aggregate all [{text, prompt}] items
  const allPhase2Prompts: Array<{ text: string; prompt: string }> = [];
  for (const row of data) {
    if (!row.batch_output) continue;
    try {
      const parsed = JSON.parse(row.batch_output);
      if (Array.isArray(parsed)) allPhase2Prompts.push(...parsed);
    } catch (_) {
      console.error(`Could not parse batch_output for Phase 2 batch ${row.batch_number}`);
    }
  }

  if (allPhase2Prompts.length === 0) throw new Error('No Phase 2 motion prompts found — cannot compile');

  const fullContent = JSON.stringify(allPhase2Prompts, null, 2);
  console.log(`Compiled ${allPhase2Prompts.length} Phase 2 ITV motion prompts`);

  const sanitizedTitle = task.story_title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const finalFilePath = `documents/${userId}/${groupId}/itv-video-prompts-${sanitizedTitle}_${timestamp}.json`;

  const { error: uploadError } = await supabase.storage
    .from('stories')
    .upload(finalFilePath, new TextEncoder().encode(fullContent), { contentType: 'application/json' });

  if (uploadError) throw new Error(`Phase 2 upload failed: ${uploadError.message}`);
  console.log(`Uploaded Phase 2 ITV doc to ${finalFilePath}`);

  const { data: urlData } = supabase.storage.from('stories').getPublicUrl(finalFilePath);
  if (!urlData?.publicUrl) throw new Error('Failed to get public URL for Phase 2 ITV doc');

  const isCorrected = task.is_corrected;
  const version = isCorrected ? 21 : 20;
  const documentId = crypto.randomUUID();

  const { error: docError } = await supabase
    .from('story_documents')
    .insert({
      id: documentId,
      title: `ITV Video Prompts: ${task.story_title}`,
      description: task.description,
      word_count: countWords(fullContent),
      version,
      is_corrected: isCorrected,
      is_prompted: true,
      user_id: userId,
      file_path: finalFilePath,
      file_url: urlData.publicUrl,
      created_at: new Date().toISOString(),
      group_id: groupId,
      variant,
      image_model: task.settings.video_model,
      language: task.language ?? 'english',
      model: task.model ?? 'deepseek',
      tab,
    });

  if (docError) throw new Error(`Failed to save Phase 2 ITV story_documents: ${docError.message}`);
  console.log(`Saved Phase 2 ITV story_documents record: ${documentId}`);

  triggerSizeCalculation(documentId, finalFilePath, version).catch(() => {});

  // Mark all Phase 2 tasks as completed_final
  const { error: updateError } = await supabase
    .from('ITV_prompt_tasks')
    .update({
      status: 'completed_final',
      itv_video_prompt_document_id: documentId,
      updated_at: new Date().toISOString(),
    })
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('tab', tab)
    .eq('variant', variant)
    .eq('itv', true)
    .gt('batch_number', 0);

  if (updateError) throw new Error(`Failed to mark Phase 2 ITV tasks as completed_final: ${updateError.message}`);

  // Update video_tasks: ITV motion prompts phase complete
  await updateVideoTasksProgress(userId, groupId, tab, {
    itv_prompt_status: 'completed',
    itv_prompt_progress: 100,
    itv_video_prompt_document_id: documentId,
  });

  // ── Dual-completion check ──────────────────────────────────────────────
  // Both Phase 2 prompts AND image generation (image_tasks itv=TRUE) must be
  // completed_final before we can start video generation.
  console.log(`Phase 2 prompts compiled. Checking image_tasks completion for group ${groupId}, tab ${tab}`);

  const { data: imageTasks, error: imageTasksError } = await supabase
    .from('image_tasks')
    .select('id, status')
    .eq('group_id', groupId)
    .eq('tab', tab)
    .eq('itv', true);

  if (imageTasksError) {
    console.error(`Error querying image_tasks for dual-completion: ${imageTasksError.message}`);
    await logError('Error querying image_tasks for ITV dual-completion', imageTasksError);
    return;
  }

  if (!imageTasks || imageTasks.length === 0) {
    console.log('No ITV image_tasks found yet — image generation will trigger setup-ITV-tasks when done');
    return;
  }

  const allImagesDone = imageTasks.every(t => t.status === 'completed_final');
  if (!allImagesDone) {
    const doneCount = imageTasks.filter(t => t.status === 'completed_final').length;
    console.log(`ITV image generation still in progress (${doneCount}/${imageTasks.length} done). Video generation will be triggered when images complete.`);
    return;
  }

  // Both complete — fire setup-ITV-tasks
  console.log(`Dual-completion check passed for group ${groupId}, tab ${tab}. Firing setup-ITV-tasks.`);
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/setup-ITV-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
      body: JSON.stringify({ group_id: groupId, user_id: userId, tab, variant }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    console.log(`setup-ITV-tasks triggered successfully for group ${groupId}, tab ${tab}`);

    // Update video_tasks: ITV video generation phase now running
    await updateVideoTasksProgress(userId, groupId, tab, {
      itv_status: 'running',
    });
  } catch (err: any) {
    console.error(`Error triggering setup-ITV-tasks: ${err.message}`);
    await logError('Error triggering setup-ITV-tasks from process-ITV-prompt', err);
  }
}

// ─── Call generate-ITV-prompt ─────────────────────────────────────────────────

async function callGenerateITVPrompt(payload: any, taskId: string, batchNumber: number, itvFlag: boolean): Promise<any> {
  const retryDelays = [10000, 20000, 40000, 80000, 160000, 320000];

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      console.log(`Calling generate-ITV-prompt (itv=${itvFlag}) for batch ${batchNumber}, attempt ${attempt + 1}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        console.log(`ITV prompt batch ${batchNumber} request aborted after 390s`);
      }, 390000);

      let response: Response;
      try {
        response = await fetch(`${supabaseUrl}/functions/v1/generate-ITV-prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err: any) {
        if (err.name === 'AbortError') throw new Error('Request timed out after 390 seconds');
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const errorText = await response.text();
        const msg = `HTTP ${response.status}: ${errorText.slice(0, 200)}`;
        if ([429, 500, 502, 503, 504, 520].includes(response.status) && attempt < retryDelays.length) {
          console.log(`Received ${response.status} for ITV prompt batch ${batchNumber}, retry in ${retryDelays[attempt] / 1000}s`);
          await new Promise(r => setTimeout(r, retryDelays[attempt]));
          continue;
        }
        throw new Error(msg);
      }

      const result = await response.json();
      if (!result.output || !Array.isArray(result.output)) throw new Error('Invalid response: missing output array');
      console.log(`ITV prompt batch ${batchNumber} generated ${result.output.length} items (itv=${itvFlag})`);
      return result;
    } catch (err: any) {
      console.error(`ITV generate-prompt error (batch ${batchNumber}, attempt ${attempt + 1}): ${err.message}`);
      if (attempt < retryDelays.length &&
        (err.message.includes('429') || err.message.includes('500') || err.message.includes('502') ||
          err.message.includes('503') || err.message.includes('504') || err.message.includes('520') ||
          err.message.includes('overloaded') || err.message.includes('timeout') || err.name === 'AbortError')) {
        await new Promise(r => setTimeout(r, retryDelays[attempt]));
        continue;
      }
      await supabase.from('ITV_prompt_tasks')
        .update(buildErrorUpdate(err, 'Failed to generate ITV prompts'))
        .eq('id', taskId);
      throw err;
    }
  }
  throw new Error(`Failed to generate ITV prompts after ${retryDelays.length + 1} attempts`);
}

// ─── Trigger next batch ───────────────────────────────────────────────────────

async function triggerNextBatch(
  groupId: string,
  userId: string,
  currentBatchNumber: number,
  totalBatches: number,
  itvFlag: boolean,
  tab: number = 1,
  variant: number = 1,
  task: ITVPromptTask,
) {
  const retryDelays = [5000, 10000, 20000];

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      await resetStuckTasks(groupId, userId, itvFlag, tab, variant);

      if (currentBatchNumber >= totalBatches) {
        console.log(`All ITV prompt batches (itv=${itvFlag}) processed for group ${groupId}, tab ${tab}. Compiling…`);

        // Verify all batches are completed
        const { data: tasks, error: tasksError } = await supabase
          .from('ITV_prompt_tasks')
          .select('status, batch_number')
          .eq('group_id', groupId)
          .eq('user_id', userId)
          .eq('tab', tab)
          .eq('variant', variant)
          .eq('itv', itvFlag)
          .gt('batch_number', 0);

        if (tasksError || !tasks || tasks.length === 0) {
          const msg = `No ITV prompt tasks found for compilation, group ${groupId}, itv=${itvFlag}`;
          await logError(msg, new Error(msg));
          throw new Error(msg);
        }

        const completedCount = tasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
        if (completedCount < totalBatches) {
          const msg = `Not all ITV prompt batches completed: ${completedCount}/${totalBatches}`;
          await logError(msg, new Error(msg));
          throw new Error(msg);
        }

        if (!itvFlag) {
          await compileFinalPhase1Document(task, userId, groupId, tab, variant);
        } else {
          await compileFinalPhase2Document(task, userId, groupId, tab, variant);
        }
        return;
      }

      const nextBatchNumber = currentBatchNumber + 1;
      console.log(`Triggering trigger-next-ITV-prompt (itv=${itvFlag}) for batch ${nextBatchNumber}`);

      const response = await fetch(`${supabaseUrl}/functions/v1/trigger-next-ITV-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
        body: JSON.stringify({ group_id: groupId, user_id: userId, current_batch_number: currentBatchNumber, itv: itvFlag, tab, variant }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to trigger ITV batch ${nextBatchNumber}: HTTP ${response.status}: ${errorText}`);
      }
      console.log(`Successfully triggered ITV prompt batch ${nextBatchNumber} (itv=${itvFlag})`);
      return;
    } catch (err: any) {
      console.error(`Error in ITV triggerNextBatch (attempt ${attempt + 1}): ${err.message}`);
      if (attempt < retryDelays.length && (err.message.includes('409') || err.message.includes('running'))) {
        await new Promise(r => setTimeout(r, retryDelays[attempt]));
        continue;
      }
      await logError(`Error triggering ITV prompt batch ${currentBatchNumber + 1} (itv=${itvFlag})`, err);
      await supabase.from('ITV_prompt_tasks')
        .update(buildErrorUpdate(err, 'Failed to trigger batch'))
        .eq('group_id', groupId).eq('user_id', userId).eq('tab', tab).eq('variant', variant)
        .eq('itv', itvFlag).eq('batch_number', currentBatchNumber + 1);
      throw err;
    }
  }
  throw new Error(`Failed to trigger next ITV prompt batch after ${retryDelays.length + 1} attempts`);
}

// ─── Process ITV task ─────────────────────────────────────────────────────────

async function processITVPromptTask(
  task: ITVPromptTask,
  groupId: string,
  userId: string,
  batchNumber: number,
  totalBatches: number,
  itvFlag: boolean,
  tab: number = 1,
  variant: number = 1,
) {
  try {
    if (task.status === 'completed' || task.status === 'completed_final') {
      console.log(`ITV prompt batch ${batchNumber} (itv=${itvFlag}) already completed, triggering next`);
      await triggerNextBatch(groupId, userId, batchNumber, totalBatches, itvFlag, tab, variant, task);
      return { content: task.batch_output ?? '', input_tokens: task.input_tokens ?? 0, output_tokens: task.output_tokens ?? 0, batch_number: batchNumber };
    }

    if (task.status !== 'queued') {
      await supabase.from('ITV_prompt_tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString(), error: null })
        .eq('id', task.id).eq('variant', variant);
    }

    await supabase.from('ITV_prompt_tasks')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', task.id).eq('variant', variant);

    if (!task.batch || task.batch.length === 0) {
      const msg = `ITV prompt batch ${batchNumber} has empty segments`;
      await supabase.from('ITV_prompt_tasks')
        .update({ status: 'running', error: msg, updated_at: new Date().toISOString() })
        .eq('id', task.id).eq('variant', variant);
      throw new Error(msg);
    }

    // Fetch style_description from context (stored by setup-itv-prompts)
    // Use task.text_part as part_number so multi-part stories look up the right context row.
    let style = task.settings?.style ?? '';
    if (!style) {
      const partNumber = parseInt(task.text_part ?? '1', 10) || 1;
      const { data: ctxRow } = await supabase
        .from('ITV_prompt_context')
        .select('style_description')
        .eq('group_id', task.group_id)
        .eq('tab', tab)
        .eq('part_number', partNumber)
        .eq('itv', false)
        .maybeSingle();
      style = ctxRow?.style_description ?? '';
    }

    // Build payload based on phase
    const basePayload = {
      itv: itvFlag,
      task_id: task.id,
      group_id: task.group_id,
      tab,
      variant,
      language: task.language ?? 'english',
      model: task.model ?? 'deepseek',
      audio_clip: task.audio_clip ?? false,
      style,
      text_part: task.text_part ?? '1',  // used by generate-ITV-prompt as part_number for context lookup
      characters: (task.settings?.useCharacterDescriptions !== false) ? (task.settings?.characters ?? {}) : {},
    };

    const payload = itvFlag
      ? { ...basePayload, phase2_segments: task.batch }
      : { ...basePayload, batch_segments: task.batch };

    const chunkResult = await callGenerateITVPrompt(payload, task.id, batchNumber, itvFlag);
    const output: Array<{ text: string; image_prompt?: string; prompt?: string }> = chunkResult.output;
    const input_tokens: number = chunkResult.input_tokens ?? 0;
    const output_tokens: number = chunkResult.output_tokens ?? 0;

    if (!output || output.length === 0) {
      const msg = `No ITV prompts generated for batch ${batchNumber} (itv=${itvFlag})`;
      await supabase.from('ITV_prompt_tasks')
        .update({ status: 'running', error: msg, updated_at: new Date().toISOString() })
        .eq('id', task.id).eq('variant', variant);
      throw new Error(msg);
    }

    const batchOutput = JSON.stringify(output);

    await supabase.from('ITV_prompt_tasks')
      .update({
        status: 'completed',
        batch_output: batchOutput,
        progress: 100,
        input_tokens,
        output_tokens,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id).eq('variant', variant);

    console.log(`ITV prompt batch ${batchNumber} (itv=${itvFlag}) completed (${output.length} items)`);

    // Update video_tasks with ITV prompt progress (non-fatal)
    const progressPct = Math.round((batchNumber / totalBatches) * 100);
    if (!itvFlag) {
      // Phase 1: image prompt progress
      await updateVideoTasksProgress(userId, groupId, tab, {
        image_prompt_status: batchNumber >= totalBatches ? 'completed' : 'running',
        image_prompt_progress: progressPct,
      });
    } else {
      // Phase 2: motion/video prompt progress
      await updateVideoTasksProgress(userId, groupId, tab, {
        itv_prompt_status: batchNumber >= totalBatches ? 'completed' : 'running',
        itv_prompt_progress: progressPct,
      });
    }

    await triggerNextBatch(groupId, userId, batchNumber, totalBatches, itvFlag, tab, variant, task);

    return { content: batchOutput, input_tokens, output_tokens, batch_number: batchNumber };
  } catch (err: any) {
    console.error(`Error in processITVPromptTask batch ${batchNumber} (itv=${itvFlag}): ${err.message}`);
    await logError('Error in processITVPromptTask', err);
    await supabase.from('ITV_prompt_tasks')
      .update(buildErrorUpdate(err, 'Processing failed'))
      .eq('id', task.id).eq('variant', variant);
    throw err;
  }
}

// ─── serve ────────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
  const responseSent = { value: false };
  let payload: RequestBody | null = null;

  try {
    if (req.method === 'OPTIONS') { responseSent.value = true; return new Response(null, { status: 204, headers: responseHeaders }); }

    const auth = await verifyAuth(req);
    if (!auth) {
      responseSent.value = true;
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method !== 'POST') { responseSent.value = true; return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders }); }

    try { payload = await req.json(); } catch (_) {
      responseSent.value = true;
      return new Response(JSON.stringify({ error: 'Invalid JSON payload', code: 400 }), { status: 400, headers: responseHeaders });
    }

    const validationError = validateInputs(payload);
    if (validationError) {
      responseSent.value = true;
      return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });
    }

    const { group_id, user_id, batch_number, total_batches, itv, tab = 1, variant = 1 } = payload!;
    console.log(`process-ITV-prompt: batch ${batch_number}, itv=${itv}, group ${group_id}, tab ${tab}, variant ${variant}`);

    await resetStuckTasks(group_id, user_id, itv, tab, variant);

    let task: ITVPromptTask | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error } = await supabase
        .from('ITV_prompt_tasks')
        .select('*')
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .eq('tab', tab)
        .eq('variant', variant)
        .eq('itv', itv)
        .eq('batch_number', batch_number)
        .single();

      if (error || !data) {
        console.error(`ITV prompt task query failed (attempt ${attempt + 1}): ${error?.message ?? 'Not found'}`);
        if (attempt < 2) { await new Promise(r => setTimeout(r, 5000)); continue; }
        responseSent.value = true;
        return new Response(JSON.stringify({ error: 'ITV prompt task not found', code: 404 }), { status: 404, headers: responseHeaders });
      }
      task = data;
      break;
    }

    if (!task) {
      responseSent.value = true;
      return new Response(JSON.stringify({ error: 'ITV prompt task not found', code: 404 }), { status: 404, headers: responseHeaders });
    }

    console.log(`ITV prompt task found: ID ${task.id}, itv=${task.itv}, language: ${task.language}`);

    const processPromise = processITVPromptTask(task, group_id, user_id, batch_number, total_batches, itv, tab, variant)
      .catch(async err => {
        console.error(`ITV prompt background processing failed for batch ${batch_number}: ${err.message}`);
        await logError('ITV prompt background processing failed', err);
      });

    setTimeout(async () => {
      if (!responseSent.value && Date.now() - startTime > idleTimeout - 5000) {
        console.log(`Approaching idle timeout, keeping ITV prompt task ${task!.id} alive`);
        await supabase.from('ITV_prompt_tasks')
          .update({ status: 'running', updated_at: new Date().toISOString() })
          .eq('id', task!.id).eq('variant', variant);
      }
    }, idleTimeout - 5000);

    const quickResult = await Promise.race([
      processPromise,
      new Promise(resolve => setTimeout(() => resolve(null), idleTimeout)),
    ]);

    if (quickResult) {
      responseSent.value = true;
      return new Response(JSON.stringify(quickResult), { status: 200, headers: responseHeaders });
    }

    console.log(`Sending 202 Accepted for ITV prompt batch ${batch_number} (itv=${itv})`);
    responseSent.value = true;
    return new Response(
      JSON.stringify({ message: 'ITV prompt processing started', batch_number }),
      { status: 202, headers: responseHeaders },
    );
  } catch (error: any) {
    console.error(`Error in process-ITV-prompt: ${error.message}`);
    await logError('Error in process-ITV-prompt', error);
    if (payload) {
      await supabase.from('ITV_prompt_tasks')
        .update(buildErrorUpdate(error, 'Processing failed'))
        .eq('group_id', payload.group_id).eq('user_id', payload.user_id)
        .eq('tab', payload.tab ?? 1).eq('variant', payload.variant ?? 1)
        .eq('itv', payload.itv).eq('batch_number', payload.batch_number);
    }
    if (!responseSent.value) {
      responseSent.value = true;
      return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
    }
    throw error;
  }
});
