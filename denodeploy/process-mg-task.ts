// denodeploy/process-mg-task.ts
// THE Remotion-Lambda invoker.
//
// Receives { task_id, group_id, user_id, batch_number, tab?, redo?, single_mg? }
// and:
//   1. Loads the MG_tasks row and pulls inputProps from batch[0].
//   2. Calls renderMediaOnLambda() to start the Remotion render.
//   3. Records lambda_render_id / bucket / function / region on the task row
//      and sets status='rendering'.
//   4. Polls getRenderProgress() every ~5s until done or fatal error.
//      Mid-poll, checks stop_requested and aborts cleanly if set.
//   5. On success: stores the S3 mp4 URL on MG_tasks.video_url, sets
//      status='completed', and inserts a gcf_runtime_log row for billing
//      (gcf_name='remotion-lambda', tokens_charged = round(seconds * 180)).
//   6. Calls trigger-next-MG so the next clip starts rendering (unless single_mg).
//
// Env required:
//   SUPABASE_URL, SUPABASE_SECRET_KEY,
//   AWS_ACCESS_KEY (alias: AWS_ACCESS_KEY_ID), AWS_ACCESS_SECRET_KEY (alias: AWS_SECRET_ACCESS_KEY),
//   TRIGGER_NEXT_MG_URL  (default: <SUPABASE_URL>/functions/v1/trigger-next-MG, kept for legacy compatibility — no longer used)
//   REMOTION_LAMBDA_REGION (default eu-north-1)
//   REMOTION_LAMBDA_FUNCTION (default remotion-render-4-0-458-mem3008mb-disk10240mb-240sec)
//   REMOTION_LAMBDA_BUCKET (default remotionlambda-eunorth1-xeueiza279)
//   REMOTION_SERVE_URL (default https://remotionlambda-eunorth1-xeueiza279.s3.eu-north-1.amazonaws.com/sites/motion-graphics-v1/index.html)
//   PROCESS_MG_URL (default: <SUPABASE_URL>/functions/v1/process-MG)

import { createClient } from 'jsr:@supabase/supabase-js@^2';
import { getRenderProgress, deleteRender } from 'npm:@remotion/lambda-client@4.0.458';
// deleteSite lives in the server package (@remotion/lambda), not in lambda-client.
import { deleteSite } from 'npm:@remotion/lambda@4.0.458';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SECRET_KEY = Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
// Accept both the AWS-standard names and the shorter aliases currently configured
// in Deno Deploy. First non-empty wins.
const AWS_ACCESS_KEY_ID =
  Deno.env.get('AWS_ACCESS_KEY_ID') ||
  Deno.env.get('AWS_ACCESS_KEY') ||
  '';
const AWS_SECRET_ACCESS_KEY =
  Deno.env.get('AWS_SECRET_ACCESS_KEY') ||
  Deno.env.get('AWS_ACCESS_SECRET_KEY') ||
  Deno.env.get('AWS_SECRET_KEY') ||
  '';

const REGION = Deno.env.get('REMOTION_LAMBDA_REGION') || 'eu-north-1';
const FUNCTION_NAME = Deno.env.get('REMOTION_LAMBDA_FUNCTION') || 'remotion-render-4-0-458-mem3008mb-disk10240mb-240sec';
const BUCKET_NAME = Deno.env.get('REMOTION_LAMBDA_BUCKET') || 'remotionlambda-eunorth1-xeueiza279';
const SERVE_URL = Deno.env.get('REMOTION_SERVE_URL') ||
  'https://remotionlambda-eunorth1-xeueiza279.s3.eu-north-1.amazonaws.com/sites/motion-graphics-v1/index.html';
const COMPOSITION_ID = 'MotionGraphic';
// Kept for legacy compatibility; the new flow routes finalization + next-batch
// triggering through process-MG with mode='after_render'.
const _TRIGGER_NEXT_MG_URL = Deno.env.get('TRIGGER_NEXT_MG_URL') || `${SUPABASE_URL}/functions/v1/trigger-next-MG`;
void _TRIGGER_NEXT_MG_URL;
const PROCESS_MG_URL = Deno.env.get('PROCESS_MG_URL') || `${SUPABASE_URL}/functions/v1/process-MG`;

// Billing: $0.0001507/s (3008MB Lambda) ÷ $0.000001/token max-cost = ~150 t/s.
// Use 180 t/s for ≥50% margin headroom. Mirrors GCloud billing pattern.
const MG_LAMBDA_TOKENS_PER_SECOND = 180;

// Set AWS creds for the Remotion client.
Deno.env.set('REMOTION_AWS_ACCESS_KEY_ID', AWS_ACCESS_KEY_ID);
Deno.env.set('REMOTION_AWS_SECRET_ACCESS_KEY', AWS_SECRET_ACCESS_KEY);

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('SUPABASE_URL or SUPABASE_SECRET_KEY missing');
}
if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
  console.error('AWS credentials missing — Remotion Lambda calls will fail');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

const ALLOWED_ORIGINS = [
  'https://storyscriptai.com',
  'https://www.storyscriptai.com',
  'https://northnoir.com',
  'https://www.northnoir.com',
  'http://localhost:5173',
];
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

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

// Polling tunables
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;   // 120 × 5s = 10 min hard cap (Lambda 4-min function ≪ this)

interface ProcessRequest {
  task_id: string;
  group_id: string;
  user_id: string;
  batch_number: number;
  tab?: number;
  redo?: boolean;
  single_mg?: boolean;
}

function sanitizeTitle(title: string): string {
  return title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
}

// Best-effort cleanup of AWS S3 artifacts after the mp4 is safely in Supabase.
// Failures are logged but never thrown — the user-visible flow has already succeeded.
async function cleanupS3Artifacts(
  taskId: string,
  renderId: string,
  renderBucket: string,
): Promise<void> {
  // 1) Delete the per-task deployed site (uploaded by mg-codegen-worker as
  //    sites/mg-jobs/<taskId>/ in BUCKET_NAME). Only applies to codegen flow.
  try {
    await deleteSite({
      region: REGION as any,
      bucketName: BUCKET_NAME,
      siteName: `mg-jobs/${taskId}`,
    });
    console.log(`[cleanup] deleted site mg-jobs/${taskId}`);
  } catch (e: any) {
    console.warn(`[cleanup] deleteSite failed for ${taskId}: ${e?.message ?? e}`);
  }

  // 2) Delete the rendered mp4 + chunks (renders/<renderId>/...) in the
  //    Lambda render bucket.
  try {
    await deleteRender({
      region: REGION as any,
      bucketName: renderBucket,
      renderId,
    });
    console.log(`[cleanup] deleted render ${renderId} from ${renderBucket}`);
  } catch (e: any) {
    console.warn(`[cleanup] deleteRender failed for ${renderId}: ${e?.message ?? e}`);
  }
}

async function billLambdaRun(userId: string, runtimeSeconds: number, success: boolean, startedAt: string, endedAt: string) {
  const tokensCharged = Math.round(runtimeSeconds * MG_LAMBDA_TOKENS_PER_SECOND);
  const { error } = await supabase.from('gcf_runtime_log').insert({
    user_id: userId,
    gcf_name: 'remotion-lambda',
    runtime_seconds: runtimeSeconds,
    tokens_charged: tokensCharged,
    success,
    started_at: startedAt,
    ended_at: endedAt,
    created_at: new Date().toISOString(),
  });
  if (error) console.error(`Failed to insert gcf_runtime_log: ${error.message}`);
}

async function processTask(payload: ProcessRequest): Promise<{ status: string; video_url?: string; error?: string }> {
  const { task_id } = payload;
  const tab = payload.tab ?? 1;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const { data: task, error: taskErr } = await supabase
    .from('MG_tasks')
    .select('*')
    .eq('id', task_id)
    .single();

  if (taskErr || !task) throw new Error(`MG_task ${task_id} not found: ${taskErr?.message}`);

  // Prefer payload values (legacy/document-mode flow), fall back to the task
  // row (codegen-worker handoff sends only { task_id, mode }).
  const user_id: string = payload.user_id ?? task.user_id;
  const group_id: string = payload.group_id ?? task.group_id;
  if (!user_id || !group_id) {
    throw new Error(`MG_task ${task_id} missing user_id/group_id (payload=${!!payload.user_id}/${!!payload.group_id}, task=${!!task.user_id}/${!!task.group_id})`);
  }

  if (task.stop_requested) {
    await supabase.from('MG_tasks')
      .update({ status: 'error', error: 'Stop requested before render', updated_at: new Date().toISOString() })
      .eq('id', task_id);
    return { status: 'stopped' };
  }

  // ── Code-gen only ────────────────────────────────────────────────────────
  // mg-codegen-worker is the single render entrypoint. It bundles the
  // per-task site and calls renderMediaOnLambda inside the AWS Lambda budget,
  // then writes lambda_render_id + lambda_bucket_name onto the row. This
  // worker is now only responsible for polling that render to completion.
  let renderId: string;
  let renderBucket: string;

  if (task.lambda_render_id && task.lambda_bucket_name) {
    renderId = task.lambda_render_id;
    renderBucket = task.lambda_bucket_name;
    console.log(
      `[process-mg-task] polling render ${renderId} from codegen worker (bucket=${renderBucket})`
    );
  } else {
    const msg = `MG_task ${task_id} has no lambda_render_id — codegen worker must produce the render. Legacy template fallback is disabled.`;
    await supabase.from('MG_tasks').update({
      status: 'error',
      error: msg,
      updated_at: new Date().toISOString(),
    }).eq('id', task_id);
    throw new Error(msg);
  }

  // Poll for completion
  let attempts = 0;
  let videoUrl: string | undefined;
  let lastError: string | undefined;

  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    // Check for stop request
    const { data: latest } = await supabase
      .from('MG_tasks')
      .select('stop_requested')
      .eq('id', task_id)
      .single();
    if (latest?.stop_requested) {
      await supabase.from('MG_tasks').update({
        status: 'error',
        error: 'Stop requested mid-render',
        updated_at: new Date().toISOString(),
      }).eq('id', task_id);
      const endedAt = new Date().toISOString();
      await billLambdaRun(user_id, (Date.now() - startMs) / 1000, false, startedAt, endedAt);
      return { status: 'stopped' };
    }

    let progress: any;
    try {
      progress = await getRenderProgress({
        renderId,
        bucketName: renderBucket,
        functionName: FUNCTION_NAME,
        region: REGION as any,
      });
    } catch (e: any) {
      console.warn(`getRenderProgress attempt ${attempts} failed: ${e.message}`);
      continue;
    }

    if (progress.fatalErrorEncountered) {
      lastError = progress.errors?.map((e: any) => e.message).join('; ') || 'Lambda render failed';
      break;
    }

    if (progress.done) {
      videoUrl = progress.outputFile ||
        `https://${renderBucket}.s3.${REGION}.amazonaws.com/renders/${renderId}/out.mp4`;
      break;
    }


    // Update progress %
    const pct = Math.min(99, Math.floor((progress.overallProgress || 0) * 100));
    await supabase.from('MG_tasks').update({
      progress: pct,
      poll_attempts: attempts,
      updated_at: new Date().toISOString(),
    }).eq('id', task_id);
  }

  const endedAt = new Date().toISOString();
  const runtimeSeconds = Math.max(0.1, (Date.now() - startMs) / 1000);

  if (!videoUrl) {
    const errMsg = lastError || `Render timed out after ${attempts} attempts`;

    // ── Render-failure retry ────────────────────────────────────────────────
    // Remotion runtime errors that slip past mg-codegen-worker's static checks
    // (e.g. invalid useVideoConfig math, missing font fallback) crash the
    // render but are almost always fixable on a second pass once Claude sees
    // the actual error. We retry once: clear the render artifacts, persist
    // the error onto the row so the codegen worker can feed it back into the
    // prompt, and re-invoke process-MG (same path as the first attempt).
    const priorAttempts: number = task.render_attempts ?? 0;
    const MAX_RENDER_RETRIES = 1;
    if (lastError && priorAttempts < MAX_RENDER_RETRIES) {
      const nextAttempt = priorAttempts + 1;
      console.warn(
        `[process-mg-task] render failed (attempt ${nextAttempt}/${MAX_RENDER_RETRIES + 1}) — retrying. error: ${errMsg.slice(0, 200)}`
      );
      // Bill the failed render runtime so the user isn't given a free retry slot.
      await billLambdaRun(user_id, runtimeSeconds, false, startedAt, endedAt);
      // Best-effort cleanup of the failed render's S3 artifacts.
      await cleanupS3Artifacts(task_id, renderId, renderBucket).catch(() => undefined);

      await supabase.from('MG_tasks').update({
        status: 'code_gen',
        render_attempts: nextAttempt,
        last_render_error: errMsg.slice(0, 1000),
        // Clear the prior render handles so the codegen worker creates a fresh one.
        lambda_render_id: null,
        lambda_bucket_name: null,
        progress: 0,
        error: null,
        updated_at: new Date().toISOString(),
      }).eq('id', task_id);

      // Re-trigger via the same edge function used on the first attempt.
      const retryUrl = `${SUPABASE_URL}/functions/v1/process-MG`;
      try {
        const r = await fetch(retryUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
          },
          body: JSON.stringify({
            task_id,
            group_id,
            user_id,
            batch_number: task.batch_number,
            tab,
            single_mg: task.single_mg ?? false,
          }),
        });
        console.log(`[process-mg-task] retry process-MG → HTTP ${r.status}`);
      } catch (e: any) {
        console.error(`[process-mg-task] retry invoke failed: ${e?.message ?? e}`);
      }

      return { status: 'retrying', error: errMsg };
    }

    await supabase.from('MG_tasks').update({
      status: 'error',
      error: errMsg,
      last_render_error: errMsg.slice(0, 1000),
      stuck_at_poll_attempts: attempts,
      updated_at: new Date().toISOString(),
    }).eq('id', task_id);
    await billLambdaRun(user_id, runtimeSeconds, false, startedAt, endedAt);
    throw new Error(errMsg);
  }

  // ── Upload mp4 to Supabase storage (mirrors TTV pattern) ─────────────────
  // We keep the rendered file alongside the rest of the user's project so it
  // can be served via signed URLs, downloaded in the ZIP, and deleted from a
  // single source on "Done".
  let storagePath: string | undefined;
  try {
    const dlRes = await fetch(videoUrl);
    if (!dlRes.ok) throw new Error(`download mp4 failed: HTTP ${dlRes.status}`);
    const videoBytes = new Uint8Array(await dlRes.arrayBuffer());

    const sanitized = sanitizeTitle(String(task.story_title ?? 'mg'));
    // folder_timestamp is set by the multi-MG setup flow; single-MG may omit it.
    const folderTimestamp = task.folder_timestamp
      ?? (task.created_at ? String(task.created_at).replace(/[^0-9]/g, '').slice(0, 14) : Date.now().toString());
    const batchNumber = task.batch_number ?? 1;
    storagePath = `documents/${user_id}/${group_id}/MG-${sanitized}_${folderTimestamp}/${batchNumber}.mp4`;

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { error: upErr } = await supabase.storage
        .from('stories')
        .upload(storagePath, videoBytes, { contentType: 'video/mp4', upsert: true });
      if (!upErr) {
        console.log(`[process-mg-task] uploaded ${videoBytes.length} bytes → ${storagePath}`);
        break;
      }
      if (attempt === maxAttempts) throw new Error(`Storage upload error: ${upErr.message}`);
      console.warn(`[process-mg-task] upload attempt ${attempt} failed: ${upErr.message} — retrying`);
      await new Promise(r => setTimeout(r, 3_000));
    }
  } catch (e: any) {
    // Don't fail the task — fall back to the S3 URL so the user still sees the
    // clip. Skip the AWS cleanup below since we still rely on the S3 object.
    console.error(`[process-mg-task] Supabase upload failed; keeping S3 URL: ${e?.message ?? e}`);
    storagePath = undefined;
  }

  // Success — store the Supabase storage path if upload succeeded, otherwise
  // fall back to the public S3 URL.
  const finalVideoUrl = storagePath ?? videoUrl;
  await supabase.from('MG_tasks').update({
    status: 'completed',
    video_url: finalVideoUrl,
    progress: 100,
    poll_attempts: attempts,
    redo_status: null,
    last_render_error: null,
    updated_at: new Date().toISOString(),
  }).eq('id', task_id);

  await billLambdaRun(user_id, runtimeSeconds, true, startedAt, endedAt);

  // ── Clean up AWS S3 (per-task site + rendered mp4) ──────────────────────
  // Only safe to do once Supabase owns the file. Errors are logged, never
  // re-thrown — the user-facing pipeline has already succeeded.
  if (storagePath) {
    await cleanupS3Artifacts(task_id, renderId, renderBucket);
  }

  // Hand control back to process-MG with mode='after_render'. It will either:
  //   - run compileFinalMGDocument (creates "MG Outputs: <title>"
  //     story_documents row + flips all MG_tasks for the group/tab/variant to
  //     'completed_final' with mg_folder_document_id set), when this was the
  //     last batch; or
  //   - fire trigger-next-MG to queue the next batch.
  // This mirrors the finalization edge used by process-TTV / process-image-batch.
  // The codegen-worker handoff sends only { task_id, mode }, so payload.batch_number
  // is undefined — always prefer the value persisted on the task row.
  if (!payload.single_mg && !task.single_mg) {
    const currentBatchNumber: number =
      typeof payload.batch_number === 'number' ? payload.batch_number :
      typeof task.batch_number === 'number' ? task.batch_number : 0;
    const triggerTab: number =
      typeof payload.tab === 'number' ? payload.tab :
      typeof task.tab === 'number' ? task.tab : 1;
    const totalBatches: number =
      typeof task.total_batches === 'number' ? task.total_batches : currentBatchNumber;

    fetch(PROCESS_MG_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SECRET_KEY,
      },
      body: JSON.stringify({
        mode: 'after_render',
        task_id,
        group_id, user_id,
        batch_number: currentBatchNumber,
        total_batches: totalBatches,
        tab: triggerTab,
        variant: task.variant ?? 1,
      }),
    }).catch(err => logError(`process-mg-task: failed to call process-MG after_render`, err));
  }

  return { status: 'completed', video_url: finalVideoUrl };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });
  }

  // Auth
  const authHeader = req.headers.get('Authorization') ?? '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!bearer || bearer !== SUPABASE_SECRET_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });
  }

  try {
    const payload: ProcessRequest = await req.json();
    const result = await processTask(payload);
    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });
  } catch (error: any) {
    await logError('Error in denodeploy/process-mg-task', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), { status: 500, headers: responseHeaders });
  }
});
