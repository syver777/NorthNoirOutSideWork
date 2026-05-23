// process-MG/index.ts
// Lightweight orchestrator for a single MG_tasks row.
//
// Two modes (selected via body.mode):
//
//   1. 'codegen' (default — backward compatible):
//        Marks the task 'running' and fires the mg-codegen-worker AWS Lambda
//        directly (no Deno-worker hop). The Lambda handler does codegen +
//        bundle + renderMediaOnLambda + handoff to denodeploy/process-mg-task
//        (polling), all asynchronously. Returns immediately.
//
//   2. 'after_render':
//        Called by denodeploy/process-mg-task once a single clip has finished
//        rendering and been uploaded (status='completed'). This is the
//        symmetric finalization edge to process-TTV / process-image-batch:
//          - If this batch was the last one (batch_number === total_batches),
//            run compileFinalMGDocument: create the "MG Outputs: <title>"
//            story_documents row pointing at the MG folder, then flip every
//            MG_task for the group/tab/variant to 'completed_final' and set
//            mg_folder_document_id on each.
//          - Otherwise, fire trigger-next-MG to queue the next batch.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { LambdaClient, InvokeCommand } from 'npm:@aws-sdk/client-lambda@3';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
const AWS_REGION = 'eu-north-1';
const LAMBDA_NAME = 'mg-codegen-worker';
const AWS_ACCESS_KEY_ID =
  Deno.env.get('AWS_ACCESS_KEY_ID') ||
  Deno.env.get('AWS_ACCESS_KEY') || '';
const AWS_SECRET_ACCESS_KEY =
  Deno.env.get('AWS_SECRET_ACCESS_KEY') ||
  Deno.env.get('AWS_ACCESS_SECRET_KEY') || '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}
if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
  console.warn('[process-MG] AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set — Lambda invokes will fail');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
const lambda = new LambdaClient({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
});

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

interface ProcessRequest {
  group_id: string;
  user_id: string;
  batch_number: number;
  total_batches: number;
  tab?: number;
  // 'codegen' (default) → invoke mg-codegen-worker Lambda.
  // 'after_render'       → finalize folder doc or trigger next batch.
  mode?: 'codegen' | 'after_render';
  // Required when mode='after_render' so we can target the correct task row
  // without ambiguity (group/tab/variant can have multiple variants in flight).
  task_id?: string;
  variant?: number;
}

function sanitizeTitle(title: string): string {
  return title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
}

async function triggerSizeCalculation(docId: string, filePath: string, version: number): Promise<void> {
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/calculate-file-size`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey },
      body: JSON.stringify({ id: docId, file_path: filePath, version }),
    });
    if (!response.ok) {
      console.warn(`[process-MG] size calc HTTP ${response.status} for ${docId}`);
    }
  } catch (err: any) {
    console.warn(`[process-MG] size calc failed for ${docId}: ${err?.message ?? err}`);
  }
}

// ── compileFinalMGDocument ────────────────────────────────────────────────────
// Mirrors process-TTV's compileFinalTTVDocument: creates the folder
// story_documents row for the MG outputs and flips every MG_task in the
// group/tab/variant to 'completed_final' with mg_folder_document_id set.
async function compileFinalMGDocument(
  userId: string,
  groupId: string,
  title: string,
  description: string | null,
  variant: number,
  isCorrected: boolean,
  version: number,
  folderTimestamp: string,
  tab: number,
): Promise<void> {
  try {
    console.log(`[process-MG] compileFinalMGDocument: group=${groupId} variant=${variant} version=${version}`);

    // Duplicate guard — if a row already exists for this group/variant/version,
    // just make sure tasks are marked completed_final and exit.
    const { data: existingDoc } = await supabase
      .from('story_documents')
      .select('id, title')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('variant', variant)
      .eq('version', version)
      .ilike('title', 'MG Outputs:%')
      .limit(1);

    if (existingDoc && existingDoc.length > 0) {
      const docId = existingDoc[0].id;
      console.log(`[process-MG] MG document already exists (${docId}) — backfilling completed_final on tasks`);
      await supabase
        .from('MG_tasks')
        .update({
          status: 'completed_final',
          mg_folder_document_id: docId,
          updated_at: new Date().toISOString(),
        })
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('tab', tab)
        .eq('variant', variant)
        .eq('status', 'completed');
      return;
    }

    const sanitized = sanitizeTitle(title.replace(/^MG Prompt:\s*/i, '').replace(/^MG Prompts:\s*/i, ''));
    const folderPath = `documents/${userId}/${groupId}/MG-${sanitized}_${folderTimestamp}`;
    console.log(`[process-MG] MG folder path: ${folderPath}`);

    const { data: urlData } = supabase.storage.from('stories').getPublicUrl(folderPath);
    if (!urlData?.publicUrl) throw new Error('Failed to retrieve public folder URL for MG folder');

    const documentId = crypto.randomUUID();
    const cleanTitle = title
      .replace(/^MG Prompt:\s*/i, '')
      .replace(/^MG Prompts:\s*/i, '')
      .trim();

    const { error: docError } = await supabase
      .from('story_documents')
      .insert({
        id: documentId,
        title: `MG Outputs: ${cleanTitle}`,
        description,
        version,
        is_corrected: isCorrected,
        is_prompted: false,
        user_id: userId,
        file_path: folderPath,
        file_url: urlData.publicUrl,
        created_at: new Date().toISOString(),
        group_id: groupId,
        variant,
        tab,
      });

    if (docError) throw new Error(`Failed to save MG document: ${docError.message}`);
    console.log(`[process-MG] Created MG story_documents record: ${documentId}`);

    triggerSizeCalculation(documentId, folderPath, version).catch(err =>
      console.warn(`[process-MG] size calc failed for ${documentId}:`, err?.message ?? err)
    );

    const { error: updateError } = await supabase
      .from('MG_tasks')
      .update({
        status: 'completed_final',
        mg_folder_document_id: documentId,
        updated_at: new Date().toISOString(),
      })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .eq('status', 'completed');

    if (updateError) {
      console.error(`[process-MG] Error marking MG tasks completed_final: ${updateError.message}`);
    } else {
      console.log(`[process-MG] All MG tasks marked completed_final for group ${groupId}`);
    }
  } catch (error: any) {
    console.error(`[process-MG] Error in compileFinalMGDocument: ${error.message}`);
    await logError('Error compiling final MG document', error);
    throw error;
  }
}

async function triggerNextMG(
  groupId: string,
  userId: string,
  currentBatchNumber: number,
  tab: number,
  variant: number,
): Promise<void> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/trigger-next-MG`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey },
      body: JSON.stringify({
        group_id: groupId,
        user_id: userId,
        current_batch_number: currentBatchNumber,
        tab,
        variant,
      }),
    });
    if (!res.ok) {
      console.warn(`[process-MG] trigger-next-MG HTTP ${res.status}`);
    }
  } catch (err: any) {
    await logError(`process-MG: failed to call trigger-next-MG`, err);
  }
}

// ── after_render handler ─────────────────────────────────────────────────────
// Called by denodeploy/process-mg-task once a single clip has finished
// rendering + uploading and the task row is status='completed'. Decides
// whether to finalize the folder doc or trigger the next batch.
async function handleAfterRender(body: ProcessRequest): Promise<Response> {
  const responseHeaders = { 'Content-Type': 'application/json' };
  const { group_id, user_id, batch_number, total_batches } = body;
  const tab = body.tab ?? 1;

  if (!group_id || !user_id || typeof batch_number !== 'number' || typeof total_batches !== 'number') {
    return new Response(
      JSON.stringify({ error: 'Missing required parameters for after_render mode' }),
      { status: 400, headers: responseHeaders },
    );
  }

  // We need story_title / folder_timestamp / variant / version / is_corrected
  // / description. Prefer the explicit task_id; otherwise look up the task for
  // this batch (filtering by variant when provided to disambiguate).
  let taskQuery = supabase
    .from('MG_tasks')
    .select('id, story_title, description, folder_timestamp, variant, version, is_corrected, tab, batch_number, total_batches, video_task_id')
    .eq('group_id', group_id)
    .eq('user_id', user_id)
    .eq('tab', tab)
    .order('updated_at', { ascending: false })
    .limit(1);

  if (body.task_id) {
    taskQuery = supabase
      .from('MG_tasks')
      .select('id, story_title, description, folder_timestamp, variant, version, is_corrected, tab, batch_number, total_batches, video_task_id')
      .eq('id', body.task_id)
      .limit(1);
  } else {
    taskQuery = taskQuery.eq('batch_number', batch_number);
    if (typeof body.variant === 'number') taskQuery = taskQuery.eq('variant', body.variant);
  }

  const { data: taskRow, error: taskErr } = await taskQuery.maybeSingle();
  if (taskErr) {
    await logError('process-MG after_render: failed to fetch task', taskErr);
    return new Response(JSON.stringify({ error: taskErr.message }), { status: 500, headers: responseHeaders });
  }
  if (!taskRow) {
    return new Response(
      JSON.stringify({ error: `No MG_task found for batch ${batch_number}` }),
      { status: 404, headers: responseHeaders },
    );
  }

  const variant = typeof body.variant === 'number' ? body.variant : (taskRow.variant ?? 1);
  const videoTaskId: string | null = (taskRow as any).video_task_id ?? null;

  // Integrated VideoGenerator mode: update parent video_tasks.mg_progress on
  // every successful clip completion. The percent reflects how many MG_tasks
  // rows for this group/tab/variant are status='completed' (or _final).
  if (videoTaskId) {
    try {
      const { count: doneCount } = await supabase
        .from('MG_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .eq('tab', tab)
        .eq('variant', variant)
        .in('status', ['completed', 'completed_final']);
      const mgProgress = Math.min(100, Math.round(((doneCount ?? 0) / Math.max(1, total_batches)) * 100));
      await supabase
        .from('video_tasks')
        .update({
          mg_progress: mgProgress,
          updated_at: new Date().toISOString(),
        })
        .eq('id', videoTaskId);
    } catch (err: any) {
      console.warn(`[process-MG] failed to update mg_progress on video_tasks ${videoTaskId}: ${err?.message ?? err}`);
    }
  }

  if (batch_number >= total_batches) {
    await compileFinalMGDocument(
      user_id,
      group_id,
      taskRow.story_title ?? 'story',
      taskRow.description ?? null,
      variant,
      !!taskRow.is_corrected,
      taskRow.version ?? 26,
      taskRow.folder_timestamp ?? '',
      tab,
    );

    // Integrated mode: mark MG render phase complete on the parent and kick
    // off the gcloud final-video assembly chain (calculate-video-durations →
    // create-final-video). The gcloud calc function knows to source from
    // MG_tasks when video_tasks.visual_type='mg'.
    if (videoTaskId) {
      await supabase
        .from('video_tasks')
        .update({
          mg_status: 'completed',
          mg_progress: 100,
          updated_at: new Date().toISOString(),
        })
        .eq('id', videoTaskId);
      try {
        const calcUrl = Deno.env.get('CALC_VIDEO_DURATIONS_URL') ||
          Deno.env.get('CALCULATE_VIDEO_DURATIONS_URL') || '';
        if (calcUrl) {
          fetch(calcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_task_id: videoTaskId }),
          }).catch(err => logError('process-MG: failed to fire calculate-video-durations', err));
        } else {
          console.warn('[process-MG] CALC_VIDEO_DURATIONS_URL not set — final assembly NOT triggered');
        }
      } catch (err: any) {
        await logError('process-MG: error firing final assembly', err);
      }
    }

    return new Response(
      JSON.stringify({ status: 'finalized', batch_number, total_batches }),
      { status: 200, headers: responseHeaders },
    );
  }

  await triggerNextMG(group_id, user_id, batch_number, tab, variant);
  return new Response(
    JSON.stringify({ status: 'next_triggered', batch_number, total_batches }),
    { status: 200, headers: responseHeaders },
  );
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

    const body: ProcessRequest = await req.json();
    const { group_id, user_id, batch_number } = body;
    const tab = body.tab ?? 1;
    const mode = body.mode ?? 'codegen';

    if (mode === 'after_render') {
      // Re-use the same auth headers used by the codegen mode (apikey/service role).
      return await handleAfterRender(body);
    }

    if (!group_id || !user_id || typeof batch_number !== 'number') {
      return new Response(JSON.stringify({ error: 'Missing required parameters' }), { status: 400, headers: responseHeaders });
    }

    // Look up task row
    const { data: task, error: taskErr } = await supabase
      .from('MG_tasks')
      .select('id, status, stop_requested')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('batch_number', batch_number)
      .eq('tab', tab)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (taskErr) throw new Error(`Failed to fetch MG_task: ${taskErr.message}`);
    if (!task) {
      return new Response(JSON.stringify({ error: `No MG_task found for batch ${batch_number}` }), { status: 404, headers: responseHeaders });
    }

    if (task.stop_requested) {
      await supabase
        .from('MG_tasks')
        .update({ status: 'error', error: 'Stop requested before start', updated_at: new Date().toISOString() })
        .eq('id', task.id);
      return new Response(JSON.stringify({ status: 'stopped' }), { status: 200, headers: responseHeaders });
    }

    await supabase
      .from('MG_tasks')
      .update({ status: 'running', error: null, updated_at: new Date().toISOString() })
      .eq('id', task.id);

    // ─── Fire-and-forget Lambda invocation ───────────────────────────────
    const invoker = (async () => {
      try {
        const res = await lambda.send(new InvokeCommand({
          FunctionName: LAMBDA_NAME,
          InvocationType: 'Event',
          Payload: new TextEncoder().encode(JSON.stringify({ task_id: task.id })),
        }));
        console.log(`[process-MG] lambda invoke → status ${res.StatusCode} (task ${task.id})`);
      } catch (err: any) {
        await logError(`process-MG: lambda invoke failed for task ${task.id}`, err);
        await supabase.from('MG_tasks').update({
          status: 'error',
          error: `Failed to invoke mg-codegen-worker: ${err?.message ?? 'unknown'}`,
          updated_at: new Date().toISOString(),
        }).eq('id', task.id);
      }
    })();
    // @ts-ignore — EdgeRuntime is a Supabase global
    if (typeof EdgeRuntime !== 'undefined' && (EdgeRuntime as any)?.waitUntil) {
      // @ts-ignore
      (EdgeRuntime as any).waitUntil(invoker);
    } else {
      await invoker;
    }

    return new Response(JSON.stringify({ status: 'started', task_id: task.id }), { status: 202, headers: responseHeaders });
  } catch (error: any) {
    await logError('Error in process-MG', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), { status: 500, headers: responseHeaders });
  }
});
