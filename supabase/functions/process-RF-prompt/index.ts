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

const startTime = Date.now();
const maxRuntime = 400000;   // 400 s
const idleTimeout = 140000;  // 140 s (Supabase idle-timeout is 150 s)

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface RequestBody {
  group_id: string;
  user_id: string;
  batch_number: number;
  total_batches: number;
  tab?: number;
  variant?: number;
}

interface RFTask {
  id: string;
  user_id: string;
  group_id: string;
  story_title: string;
  description: string;
  batch: Array<{ text: string; start: number; video_duration: number }>;
  text_part: string;
  batch_output: string;
  total_batches: number;
  total_prompts: number;
  batch_number: number;
  status: string;
  progress: number;
  error: string | null;
  settings: {
    style: string;
    useCharacterDescriptions: boolean;
    video_model: string;
    video_duration: number;
    characters: Record<string, string>;
    high_res?: boolean;
  };
  file_path: string;
  input_tokens: number;
  output_tokens: number;
  variant: number;
  is_corrected: boolean;
  version: number;
  language: string;
  model: string;
  video_model: string;
  video_duration: number;
  tab: number;
  audio_clip?: boolean;
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
  if (typeof data?.variant !== 'undefined' && (typeof data.variant !== 'number' || data.variant < 1)) return 'Invalid variant';
  return null;
}

function isRetryableError(error: any): boolean {
  const msg = error.message || error.toString() || '';
  return ['520', '500', '502', '503', '504', 'connection', 'timeout', 'Failed to download', 'Failed to trigger']
    .some(s => msg.includes(s));
}

// Detects ReferenceError / "X is not defined" style code bugs and transient
// LLM response-shape failures (e.g. "Failed to parse response", "missing text
// or prompt", "Invalid response: missing results array"). When these occur we
// silently mark the task as 'running' (with no `error` column) so the
// stuck-task retry system can pick it up without surfacing a hard error.
function isSilentError(error: any): boolean {
  const msg = error?.message || error?.toString() || '';
  const name = error?.name || '';
  if (name === 'ReferenceError' || msg.includes('is not defined')) return true;
  if (msg.includes('Failed to parse response')) return true;
  if (msg.includes('missing text or prompt')) return true;
  if (msg.includes('Invalid response: missing results array')) return true;
  if (msg.includes('Failed to generate TTV prompts')) return true;
  return false;
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
      .eq('ttv', 'ttv')
      .maybeSingle();

    if (!vt) return; // No video_tasks row for TTV — nothing to update

    const { error } = await supabase
      .from('video_tasks')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', vt.id);

    if (error) console.warn(`video_tasks progress update failed: ${error.message}`);
  } catch (err: any) {
    console.warn(`video_tasks progress update error (non-fatal): ${err.message}`);
  }
}

function validateSegments(segments: Array<{ text: string; start: number; video_duration: number }>): string | null {
  if (!segments || !Array.isArray(segments) || segments.length === 0) return 'Batch segments are empty or invalid';
  for (let i = 0; i < segments.length; i++) {
    if (!segments[i].text || segments[i].text.trim().length === 0) return `Segment ${i + 1} has empty text`;
    if (typeof segments[i].video_duration !== 'number' || segments[i].video_duration <= 0) return `Segment ${i + 1} has invalid video_duration`;
  }
  return null;
}

// ─── Reset stuck tasks ────────────────────────────────────────────────────────

async function resetStuckTasks(groupId: string, userId: string, tab: number = 1, variant: number = 1) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data: stuckTasks, error } = await supabase
        .from('RF_prompt_tasks')
        .select('id, updated_at, batch_number')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('tab', tab)
        .eq('variant', variant)
        .eq('status', 'running');

      if (error) throw new Error(`Failed to check stuck TTV tasks: ${error.message}`);

      const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
      const now = Date.now();
      for (const task of (stuckTasks ?? [])) {
        const age = now - new Date(task.updated_at).getTime();
        if (age > STUCK_THRESHOLD_MS) {
          console.log(`Resetting stuck TTV task ${task.id} (batch ${task.batch_number}, age ${Math.round(age / 1000)}s)`);
          await supabase
            .from('RF_prompt_tasks')
            .update({ status: 'queued', error: 'Reset from stuck running state', updated_at: new Date().toISOString() })
            .eq('id', task.id);
        }
      }
      return;
    } catch (err: any) {
      console.error(`Error resetting stuck TTV tasks (attempt ${attempt + 1}): ${err.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
      else { await logError('Failed to reset stuck TTV tasks', err); throw err; }
    }
  }
}

// ─── Compile final TTV document ───────────────────────────────────────────────

async function compileFinalRFDocument(
  userId: string,
  groupId: string,
  title: string,
  description: string,
  variant: number,
  isCorrected: boolean,
  version: number,
  videoModel: string,
  language: string,
  model: string,
  tab: number = 1,
): Promise<{ documentId: string; filePath: string; videoDuration: number }> {
  try {
    console.log(`Compiling final TTV document for group ${groupId}, tab ${tab}`);

    const { data, error } = await supabase
      .from('RF_prompt_tasks')
      .select('batch_output, batch_number, version, story_title, description, variant, is_corrected, video_model, video_duration, language, model')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('variant', variant)
      .gt('batch_number', 0)
      .order('batch_number', { ascending: true });

    if (error || !data || data.length === 0) throw new Error(`Failed to fetch TTV tasks for compilation: ${error?.message ?? 'No data'}`);

    const videoDuration: number = data[0]?.video_duration ?? 0;

    // Aggregate all [{text, prompt}] items from every batch into one flat array
    const allPrompts: Array<{ text: string; prompt: string }> = [];
    for (const task of data) {
      if (!task.batch_output) continue;
      try {
        const parsed = JSON.parse(task.batch_output);
        if (Array.isArray(parsed)) allPrompts.push(...parsed);
      } catch (_) {
        console.error(`Could not parse batch_output for batch ${task.batch_number}`);
      }
    }

    if (allPrompts.length === 0) throw new Error('No prompts found in completed batches — cannot compile');

    const fullContent = JSON.stringify(allPrompts, null, 2);
    console.log(`Compiled ${allPrompts.length} TTV prompts, JSON size: ${fullContent.length} chars`);

    const sanitizedTitle = title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const finalFilePath = `documents/${userId}/${groupId}/ttv-prompts-${sanitizedTitle}_${timestamp}.json`;

    const { error: uploadError } = await supabase.storage
      .from('stories')
      .upload(finalFilePath, new TextEncoder().encode(fullContent), { contentType: 'application/json' });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);
    console.log(`Uploaded TTV prompts to ${finalFilePath}`);

    const { data: urlData } = supabase.storage.from('stories').getPublicUrl(finalFilePath);
    if (!urlData?.publicUrl) throw new Error('Failed to retrieve public URL for TTV document');

    const documentId = crypto.randomUUID();
    const { error: docError } = await supabase
      .from('story_documents')
      .insert({
        id: documentId,
        title: `TTV Prompt: ${title}`,
        description,
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
        image_model: videoModel,   // reuse image_model column for video model name
        language,
        model,
        tab,
      });

    if (docError) throw new Error(`Failed to save TTV document: ${docError.message}`);
    console.log(`Saved story_documents record for TTV: ${title}, ID: ${documentId}`);

    // Trigger size calculation asynchronously (fire-and-forget)
    triggerSizeCalculation(documentId, finalFilePath, version).catch(err =>
      console.warn(`Size calculation failed for ${documentId}:`, err.message)
    );

    // Mark all tasks as completed_final and store document ID
    const { error: updateError } = await supabase
      .from('RF_prompt_tasks')
      .update({
        status: 'completed_final',
        ttv_prompt_document_id: documentId,
        updated_at: new Date().toISOString(),
      })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .gt('batch_number', 0);

    if (updateError) throw new Error(`Failed to mark TTV tasks as completed_final: ${updateError.message}`);
    console.log(`Marked all TTV tasks as completed_final for group ${groupId}, tab ${tab}`);

    // Update video_tasks: TTV prompts phase complete
    await updateVideoTasksProgress(userId, groupId, tab, {
      ttv_prompt_status: 'completed',
      ttv_prompt_progress: 100,
      ttv_prompt_document_id: documentId,
    });

    return { documentId, filePath: finalFilePath, videoDuration };

  } catch (err: any) {
    console.error(`Error compiling final TTV document: ${err.message}`);
    await logError('Error compiling final TTV document', err);
    await supabase
      .from('RF_prompt_tasks')
      .update({ status: 'error', error: `Failed to compile TTV document: ${err.message}`, updated_at: new Date().toISOString() })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .gt('batch_number', 0);
    throw err;
  }
}

// ─── Trigger TTV video generation ────────────────────────────────────────────

async function triggerTTVVideoGeneration(
  userId: string,
  groupId: string,
  documentId: string,
  filePath: string,
  title: string,
  description: string,
  variant: number,
  videoModel: string,
  videoDuration: number,
  tab: number,
  language: string,
  audioClip: boolean = false,
  highRes: boolean = false,
): Promise<void> {
  try {
    console.log(`Triggering TTV video generation for group ${groupId}, tab ${tab}`);

    const response = await fetch(`${supabaseUrl}/functions/v1/setup-RF-tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        user_id: userId,
        group_id: groupId,
        file_path: filePath,
        story_title: title,
        description,
        doc_id: documentId,
        variant,
        video_model: videoModel,
        video_duration: videoDuration,
        tab,
        language,
        audio_clip: audioClip,
        high_res: highRes,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to trigger setup-RF-tasks: HTTP ${response.status}: ${errorText.slice(0, 300)}`);
    }

    console.log(`Successfully triggered setup-RF-tasks for group ${groupId}, tab ${tab}`);
  } catch (err: any) {
    // Log but do NOT rethrow — the prompts document is already saved successfully
    console.error(`Error triggering TTV video generation: ${err.message}`);
    await logError('Error triggering TTV video generation', err);
  }
}

// ─── Trigger next batch ───────────────────────────────────────────────────────

async function triggerNextBatch(
  groupId: string,
  userId: string,
  currentBatchNumber: number,
  totalBatches: number,
  tab: number = 1,
  variant: number = 1,
) {
  const retryDelays = [5000, 10000, 20000];
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      await resetStuckTasks(groupId, userId, tab, variant);

      if (currentBatchNumber >= totalBatches) {
        console.log(`All TTV batches processed for group ${groupId}, tab ${tab}. Checking completion…`);

        const { data: tasks, error: tasksError } = await supabase
          .from('RF_prompt_tasks')
          .select('story_title, description, variant, is_corrected, status, version, video_model, video_duration, language, model, audio_clip, settings')
          .eq('group_id', groupId)
          .eq('user_id', userId)
          .eq('tab', tab)
          .gt('batch_number', 0)
          .order('batch_number', { ascending: true });

        if (tasksError || !tasks || tasks.length === 0) {
          const msg = `No TTV tasks found for group ${groupId}, tab ${tab}`;
          await logError(msg, new Error(msg));
          await supabase.from('RF_prompt_tasks')
            .update({ status: 'error', error: msg, updated_at: new Date().toISOString() })
            .eq('group_id', groupId).eq('user_id', userId).eq('tab', tab).gt('batch_number', 0);
          throw new Error(msg);
        }

        const completedCount = tasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
        if (completedCount < totalBatches) {
          const msg = `Not all TTV batches completed: ${completedCount}/${totalBatches}`;
          await logError(msg, new Error(msg));
          throw new Error(msg);
        }

        const task = tasks.find(t => t.story_title && t.description);
        if (!task) throw new Error(`No TTV task with valid metadata found for group ${groupId}`);

        // Determine audio_clip from any task row (all share the same setting)
        const audioClip = (tasks as any[]).some(t => t.audio_clip === true);
        const highRes = (tasks as any[]).some(t => t.settings?.high_res === true);

        const { documentId, filePath, videoDuration } = await compileFinalRFDocument(
          userId, groupId, task.story_title, task.description,
          task.variant, task.is_corrected, task.version,
          task.video_model ?? '', task.language ?? 'english', task.model ?? 'deepseek', tab,
        );

        await triggerTTVVideoGeneration(
          userId, groupId, documentId, filePath,
          task.story_title, task.description, variant,
          task.video_model ?? '', videoDuration, tab,
          task.language ?? 'english', audioClip, highRes,
        );

        // Update video_tasks: TTV video generation phase now running
        await updateVideoTasksProgress(userId, groupId, tab, {
          ttv_status: 'running',
        });

        return;
      }

      const nextBatchNumber = currentBatchNumber + 1;
      console.log(`Triggering trigger-next-RF-prompt for batch ${nextBatchNumber}, group ${groupId}, tab ${tab}`);

      const response = await fetch(`${supabaseUrl}/functions/v1/trigger-next-RF-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
        body: JSON.stringify({ group_id: groupId, user_id: userId, current_batch_number: currentBatchNumber, tab, variant }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to trigger TTV batch ${nextBatchNumber}: HTTP ${response.status}: ${errorText}`);
      }
      console.log(`Successfully triggered TTV batch ${nextBatchNumber}`);
      return;
    } catch (err: any) {
      console.error(`Error in TTV triggerNextBatch (attempt ${attempt + 1}): ${err.message}`);
      if (attempt < retryDelays.length && (err.message.includes('409') || err.message.includes('running'))) {
        await new Promise(r => setTimeout(r, retryDelays[attempt]));
        continue;
      }
      await logError(`Error triggering TTV batch ${currentBatchNumber + 1}`, err);
      await supabase.from('RF_prompt_tasks')
        .update(buildErrorUpdate(err, 'Failed to trigger batch'))
        .eq('group_id', groupId).eq('user_id', userId).eq('tab', tab).eq('variant', variant)
        .eq('batch_number', currentBatchNumber + 1);
      throw err;
    }
  }
  throw new Error(`Failed to trigger next TTV batch after ${retryDelays.length + 1} attempts`);
}

// ─── Call generate-RF-prompt ─────────────────────────────────────────────────

async function callGenerateRFPrompts(payload: any, taskId: string, batchNumber: number): Promise<any> {
  const retryDelays = [10000, 20000, 40000, 80000, 160000, 320000];
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      console.log(`Calling generate-RF-prompt for batch ${batchNumber}, attempt ${attempt + 1}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        console.log(`TTV batch ${batchNumber} request aborted after 390s`);
      }, 390000);

      let response: Response;
      try {
        response = await fetch(`${supabaseUrl}/functions/v1/generate-RF-prompt`, {
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
          console.log(`Received ${response.status} for TTV batch ${batchNumber}, retry in ${retryDelays[attempt] / 1000}s`);
          await new Promise(r => setTimeout(r, retryDelays[attempt]));
          continue;
        }
        throw new Error(msg);
      }

      const result = await response.json();
      if (!result.results || !Array.isArray(result.results)) throw new Error('Invalid response: missing results array');
      console.log(`TTV batch ${batchNumber} generated ${result.results.length} prompts`);
      return result;
    } catch (err: any) {
      console.error(`TTV generate-prompt error (batch ${batchNumber}, attempt ${attempt + 1}): ${err.message}`);
      if (attempt < retryDelays.length &&
        (err.message.includes('429') || err.message.includes('500') || err.message.includes('502') ||
          err.message.includes('503') || err.message.includes('504') || err.message.includes('520') ||
          err.message.includes('overloaded') || err.message.includes('timeout') || err.name === 'AbortError')) {
        await new Promise(r => setTimeout(r, retryDelays[attempt]));
        continue;
      }
      await supabase.from('RF_prompt_tasks')
        .update(buildErrorUpdate(err, 'Failed to generate TTV prompts'))
        .eq('id', taskId);
      throw err;
    }
  }
  throw new Error(`Failed to generate TTV prompts after ${retryDelays.length + 1} attempts`);
}

// ─── Process TTV task ─────────────────────────────────────────────────────────

async function processRFTask(
  task: RFTask,
  groupId: string,
  userId: string,
  batchNumber: number,
  totalBatches: number,
  tab: number = 1,
  variant: number = 1,
) {
  try {
    if (task.status === 'completed' || task.status === 'completed_final') {
      console.log(`TTV batch ${batchNumber} already completed, triggering next`);
      await triggerNextBatch(groupId, userId, batchNumber, totalBatches, tab, variant);
      return { content: task.batch_output ?? '', input_tokens: task.input_tokens ?? 0, output_tokens: task.output_tokens ?? 0, batch_number: batchNumber };
    }

    if (task.status !== 'queued') {
      await supabase.from('RF_prompt_tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString(), error: null })
        .eq('id', task.id).eq('variant', variant);
    }

    await supabase.from('RF_prompt_tasks')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', task.id).eq('variant', variant);

    // Validate segments
    const segmentError = validateSegments(task.batch);
    if (segmentError) {
      await supabase.from('RF_prompt_tasks')
        .update({ status: 'running', error: segmentError, updated_at: new Date().toISOString() })
        .eq('id', task.id).eq('variant', variant);
      throw new Error(segmentError);
    }

    const payload = {
      batch_segments: task.batch,
      text_part: task.text_part,
      settings: task.settings,
      use_character_descriptions: task.settings.useCharacterDescriptions,
      characters: task.settings.characters,
      language: task.language ?? 'english',
      model: task.model ?? 'deepseek',
      task_id: task.id,
      group_id: task.group_id,
      tab: tab,
      variant: variant,
      audio_clip: task.audio_clip ?? false,
    };

    const chunkResult = await callGenerateRFPrompts(payload, task.id, batchNumber);
    const results: Array<{ text: string; prompt: string }> = chunkResult.results;
    const input_tokens: number = chunkResult.input_tokens ?? 0;
    const output_tokens: number = chunkResult.output_tokens ?? 0;

    if (!results || results.length === 0) {
      const msg = `No TTV prompts generated for batch ${batchNumber}`;
      await supabase.from('RF_prompt_tasks')
        .update({ status: 'running', error: msg, updated_at: new Date().toISOString() })
        .eq('id', task.id).eq('variant', variant);
      throw new Error(msg);
    }

    // Store batch_output as JSON string [{text, prompt}, ...]
    const batchOutput = JSON.stringify(results);

    await supabase.from('RF_prompt_tasks')
      .update({
        status: 'completed',
        batch_output: batchOutput,
        progress: 100,
        input_tokens,
        output_tokens,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id).eq('variant', variant);

    console.log(`TTV batch ${batchNumber} completed (${results.length} prompts), triggering next`);

    // Update video_tasks with TTV prompt progress (non-fatal)
    const progressPct = Math.round((batchNumber / totalBatches) * 100);
    await updateVideoTasksProgress(userId, groupId, tab, {
      ttv_prompt_status: batchNumber >= totalBatches ? 'completed' : 'running',
      ttv_prompt_progress: progressPct,
    });

    await triggerNextBatch(groupId, userId, batchNumber, totalBatches, tab, variant);

    return { content: batchOutput, input_tokens, output_tokens, batch_number: batchNumber };
  } catch (err: any) {
    console.error(`Error in processRFTask batch ${batchNumber}: ${err.message}`);
    await logError('Error in processRFTask', err);
    await supabase.from('RF_prompt_tasks')
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

    const { group_id, user_id, batch_number, total_batches, tab = 1, variant = 1 } = payload!;
    console.log(`process-RF-prompt: batch ${batch_number}, group ${group_id}, tab ${tab}, variant ${variant}`);

    await resetStuckTasks(group_id, user_id, tab, variant);

    let task: RFTask | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error } = await supabase
        .from('RF_prompt_tasks')
        .select('*')
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .eq('tab', tab)
        .eq('variant', variant)
        .eq('batch_number', batch_number)
        .single();

      if (error || !data) {
        console.error(`TTV task query failed (attempt ${attempt + 1}): ${error?.message ?? 'Not found'}`);
        if (attempt < 2) { await new Promise(r => setTimeout(r, 5000)); continue; }
        responseSent.value = true;
        return new Response(JSON.stringify({ error: 'TTV task not found', code: 404 }), { status: 404, headers: responseHeaders });
      }
      task = data;
      break;
    }

    if (!task) {
      responseSent.value = true;
      return new Response(JSON.stringify({ error: 'TTV task not found', code: 404 }), { status: 404, headers: responseHeaders });
    }

    console.log(`TTV task found: ID ${task.id}, language: ${task.language}, model: ${task.model}`);

    const processPromise = processRFTask(task, group_id, user_id, batch_number, total_batches, tab, variant)
      .catch(async err => {
        console.error(`TTV background processing failed for batch ${batch_number}: ${err.message}`);
        await logError('TTV background processing failed', err);
      });

    // Keep alive hint before idle timeout
    setTimeout(async () => {
      if (!responseSent.value && Date.now() - startTime > idleTimeout - 5000) {
        console.log(`Approaching idle timeout, marking TTV task ${task!.id} as running`);
        await supabase.from('RF_prompt_tasks')
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

    // Return 202 and let background task continue
    console.log(`Sending 202 Accepted for TTV batch ${batch_number}`);
    responseSent.value = true;
    return new Response(
      JSON.stringify({ message: 'TTV processing started, results will be available in RF_prompt_tasks', batch_number }),
      { status: 202, headers: responseHeaders },
    );
  } catch (error: any) {
    console.error(`Error in process-RF-prompt: ${error.message}`);
    await logError('Error in process-RF-prompt', error);
    if (payload) {
      await supabase.from('RF_prompt_tasks')
        .update(buildErrorUpdate(error, 'Processing failed'))
        .eq('group_id', payload.group_id).eq('user_id', payload.user_id)
        .eq('tab', payload.tab ?? 1).eq('variant', payload.variant ?? 1)
        .eq('batch_number', payload.batch_number);
    }
    if (!responseSent.value) {
      responseSent.value = true;
      return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
    }
    throw error;
  }
});
