// process-MG-prompt/index.ts
// Mirror of process-TTV-prompt: fetches a single MG_prompt_tasks row,
// dispatches it to generate-MG-prompt for the LLM call, then on completion
// (final batch) compiles all batch_outputs into a single JSON document,
// uploads it to storage, creates a story_documents row, and triggers
// setup-MG-tasks. Non-final batches just trigger the next prompt batch.
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

function sanitizeFilename(s: string): string {
  return (s || 'untitled').replace(/[^a-z0-9-_]/gi, '_').slice(0, 60);
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

async function triggerSizeCalculation(docId: string, filePath: string, version: number): Promise<void> {
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/calculate-file-size`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey },
      body: JSON.stringify({ id: docId, file_path: filePath, version }),
    });
    if (!response.ok) {
      console.warn(`[process-MG-prompt] size calc HTTP ${response.status} for ${docId}`);
    }
  } catch (err: any) {
    console.warn(`[process-MG-prompt] size calc failed for ${docId}: ${err?.message ?? err}`);
  }
}

interface ProcessPromptRequest {
  group_id: string;
  user_id: string;
  batch_number: number;
  total_batches: number;
  tab?: number;
  variant?: number;
}

async function compileFinalMGDocument(
  groupId: string,
  userId: string,
  variant: number,
  tab: number,
): Promise<{ filePath: string; storyTitle: string; styleSlug: string; compositionId: string; videoDuration: number; docId: string; codegenModel: string | null; videoTaskId: string | null } | null> {
  const { data: tasks, error } = await supabase
    .from('MG_prompt_tasks')
    .select('batch_number, batch_output, story_title, style_slug, composition_id, video_duration, doc_id, codegen_model, video_task_id')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('variant', variant)
    .eq('tab', tab)
    .order('batch_number', { ascending: true });

  if (error) throw new Error(`Failed to fetch MG_prompt_tasks for compile: ${error.message}`);
  if (!tasks || tasks.length === 0) return null;

  const allItems: Array<{ text: string; inputProps: any }> = [];
  for (const t of tasks) {
    if (!t.batch_output) continue;
    try {
      const parsed = JSON.parse(t.batch_output);
      if (Array.isArray(parsed)) allItems.push(...parsed);
    } catch (e: any) {
      console.error(`Skipping unparseable batch_output for batch ${t.batch_number}: ${e.message}`);
    }
  }

  if (allItems.length === 0) return null;

  const meta = tasks[0];
  const storyTitle = meta.story_title || 'Untitled Motion Graphics';
  const sanitized = sanitizeFilename(storyTitle);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = `documents/${userId}/${groupId}/mg-prompts-${sanitized}_${timestamp}.json`;

  const { error: uploadErr } = await supabase
    .storage.from('stories')
    .upload(filePath, JSON.stringify(allItems, null, 2), {
      contentType: 'application/json',
      upsert: true,
    });
  if (uploadErr) throw new Error(`Failed to upload compiled MG prompts: ${uploadErr.message}`);

  // Resolve is_corrected from the source story_document (the one that the
  // MG_prompt_tasks rows reference via doc_id). Mirrors setup-MG-tasks which
  // does the same lookup to decide between original/corrected output versions.
  let sourceIsCorrected = false;
  const sourceDocId = tasks.find(t => t.doc_id)?.doc_id;
  if (sourceDocId) {
    const { data: srcDoc, error: srcErr } = await supabase
      .from('story_documents')
      .select('is_corrected')
      .eq('id', sourceDocId)
      .single();
    if (srcErr) {
      console.warn(`[process-MG-prompt] source doc lookup failed (${sourceDocId}): ${srcErr.message}`);
    } else {
      sourceIsCorrected = srcDoc?.is_corrected === true;
    }
  }
  // MG prompt file: v24 (original) / v25 (corrected) — keeps MG distinct from
  // TTV (12/13) and ITV (16/17, 20/21) in story_documents.
  const outputVersion = sourceIsCorrected ? 25 : 24;

  // Word count: combine the user-visible prompt fields across all clips —
  // segment text + LLM-generated motion_graphic_prompt — matching the
  // "total words in the prompt document" convention used by TTV / ITV / image.
  const wordCountSource = allItems.map(it => {
    const ip = (it as any)?.inputProps && typeof (it as any).inputProps === 'object' ? (it as any).inputProps : {};
    const motion = typeof ip.motion_graphic_prompt === 'string' ? ip.motion_graphic_prompt
                  : typeof ip.motionGraphicPrompt === 'string' ? ip.motionGraphicPrompt : '';
    const userPrompt = typeof ip.user_prompt === 'string' ? ip.user_prompt : '';
    const text = typeof (it as any).text === 'string' ? (it as any).text : '';
    return [text, motion, userPrompt].filter(Boolean).join(' ');
  }).join(' ');
  const wordCount = countWords(wordCountSource);

  // Create story_documents row
  const docId = crypto.randomUUID();
  await supabase.from('story_documents').insert({
    id: docId,
    user_id: userId,
    group_id: groupId,
    title: `MG Prompt: ${storyTitle}`,
    file_path: filePath,
    version: outputVersion,
    is_corrected: sourceIsCorrected,
    variant,
    tab,
    word_count: wordCount,
    description: `Motion Graphics prompts for "${storyTitle}" (${meta.style_slug})`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  // Trigger size calculation asynchronously (fire-and-forget)
  triggerSizeCalculation(docId, filePath, outputVersion).catch(err =>
    console.warn(`[process-MG-prompt] size calc failed for ${docId}:`, err?.message ?? err)
  );

  // Mark all completed prompt tasks as completed_final
  await supabase
    .from('MG_prompt_tasks')
    .update({ status: 'completed_final', mg_prompt_document_id: docId, updated_at: new Date().toISOString() })
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('variant', variant)
    .eq('tab', tab)
    .eq('status', 'completed');

  return {
    filePath,
    storyTitle,
    styleSlug: meta.style_slug,
    compositionId: meta.composition_id,
    videoDuration: meta.video_duration,
    docId,
    codegenModel: (meta as any).codegen_model ?? null,
    videoTaskId: (meta as any).video_task_id ?? null,
  };
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });
    }

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });
    }

    const body: ProcessPromptRequest = await req.json();
    const { group_id, user_id, batch_number, total_batches } = body;
    const tab = body.tab ?? 1;
    const variant = body.variant ?? 1;

    if (!group_id || !user_id || typeof batch_number !== 'number') {
      return new Response(JSON.stringify({ error: 'Missing required parameters' }), { status: 400, headers: responseHeaders });
    }

    // Fetch the prompt task row
    const { data: task, error: taskErr } = await supabase
      .from('MG_prompt_tasks')
      .select('*')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('batch_number', batch_number)
      .eq('variant', variant)
      .eq('tab', tab)
      .maybeSingle();

    if (taskErr) throw new Error(`Failed to fetch MG_prompt_tasks: ${taskErr.message}`);
    if (!task) {
      return new Response(JSON.stringify({ error: `No MG_prompt_task found for batch ${batch_number}` }), { status: 404, headers: responseHeaders });
    }

    if (task.stop_requested) {
      await supabase.from('MG_prompt_tasks')
        .update({ status: 'error', error: 'Stop requested', updated_at: new Date().toISOString() })
        .eq('id', task.id);
      return new Response(JSON.stringify({ status: 'stopped' }), { status: 200, headers: responseHeaders });
    }

    await supabase.from('MG_prompt_tasks')
      .update({ status: 'running', error: null, updated_at: new Date().toISOString() })
      .eq('id', task.id);

    // Invoke generate-MG-prompt synchronously (LLM call). It writes batch_output
    // back onto the task row and marks it completed.
    const llmResp = await fetch(`${supabaseUrl}/functions/v1/generate-MG-prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        task_id: task.id,
        group_id, user_id, tab, variant,
        batch_segments: task.batch,
        style_slug: task.style_slug,
        composition_id: task.composition_id,
        video_duration: task.video_duration,
        language: task.language || 'english',
        model: task.model || 'deepseek',
      }),
    });

    if (!llmResp.ok) {
      const errText = await llmResp.text();
      await supabase.from('MG_prompt_tasks')
        .update({ status: 'error', error: `generate-MG-prompt failed: ${errText}`, updated_at: new Date().toISOString() })
        .eq('id', task.id);
      console.error(`generate-MG-prompt failed for batch ${batch_number}: HTTP ${llmResp.status} - ${errText}. Continuing chain.`);
      // Do NOT throw — image flow continues batch chain even when one batch
      // errors. Mirror that: fire the next-batch trigger so 1 failure cannot
      // strand all remaining pending batches.
      if (batch_number < total_batches) {
        fetch(`${supabaseUrl}/functions/v1/trigger-next-MG-prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey },
          body: JSON.stringify({ group_id, user_id, current_batch_number: batch_number, tab, variant }),
        }).catch(err => logError('Failed to trigger next MG prompt batch after error', err));
      }
      return new Response(JSON.stringify({ status: 'error', batch_number, error: errText }), { status: 200, headers: responseHeaders });
    }

    // Last batch? Compile everything and trigger setup-MG-tasks.
    if (batch_number >= total_batches) {
      const compiled = await compileFinalMGDocument(group_id, user_id, variant, tab);
      if (compiled) {
        // If this MG run is parented to a video_tasks row (integrated VideoGenerator
        // mode), mark prompt phase as complete and store the prompt doc id.
        if (compiled.videoTaskId) {
          await supabase
            .from('video_tasks')
            .update({
              mg_prompt_status: 'completed',
              mg_prompt_progress: 100,
              mg_prompt_document_id: compiled.docId,
              updated_at: new Date().toISOString(),
            })
            .eq('id', compiled.videoTaskId);
        }
        fetch(`${supabaseUrl}/functions/v1/setup-MG-tasks`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseServiceRoleKey,
          },
          body: JSON.stringify({
            user_id, group_id,
            file_path: compiled.filePath,
            story_title: compiled.storyTitle,
            doc_id: compiled.docId,
            variant,
            style_slug: compiled.styleSlug,
            composition_id: compiled.compositionId,
            video_duration: compiled.videoDuration,
            tab,
            language: task.language || 'english',
            codegen_model: compiled.codegenModel ?? null,
            video_task_id: compiled.videoTaskId ?? null,
          }),
        }).catch(err => logError('Failed to fire setup-MG-tasks', err));
      }
    } else {
      // Trigger next batch of prompt generation
      fetch(`${supabaseUrl}/functions/v1/trigger-next-MG-prompt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify({
          group_id, user_id,
          current_batch_number: batch_number,
          tab, variant,
        }),
      }).catch(err => logError('Failed to trigger next MG prompt batch', err));
    }

    return new Response(JSON.stringify({ status: 'completed', batch_number }), { status: 200, headers: responseHeaders });
  } catch (error: any) {
    await logError('Error in process-MG-prompt', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), { status: 500, headers: responseHeaders });
  }
});
