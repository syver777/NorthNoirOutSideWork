// process-RF — download stock clips (Coverr/Pexels) and store in Supabase storage.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

function sanitizeTitle(title: string): string {
  return title.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 80);
}

async function logError(message: string, error: unknown) {
  console.error(message, error);
  try {
    await supabase.from('error_logs').insert({
      message,
      details: (error as Error).message || JSON.stringify(error),
      created_at: new Date().toISOString(),
    });
  } catch { /* ignore */ }
}

async function callGenerateRF(query: string): Promise<{
  status: string;
  video_url?: string;
  stock_source?: string;
  stock_id?: string;
  error?: string;
}> {
  const res = await fetch(`${supabaseUrl}/functions/v1/generate-RF`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseServiceRoleKey },
    body: JSON.stringify({ mode: 'search', query }),
  });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`generate-RF invalid JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(String(data.error ?? `HTTP ${res.status}`));
  return data as { status: string; video_url?: string; stock_source?: string; stock_id?: string; error?: string };
}

async function downloadVideoBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function uploadVideoToStorage(videoBytes: Uint8Array, storagePath: string): Promise<void> {
  const { error } = await supabase.storage
    .from('stories')
    .upload(storagePath, videoBytes, { contentType: 'video/mp4', upsert: true });
  if (error) throw new Error(error.message);
}

async function triggerNextRF(
  groupId: string,
  userId: string,
  currentBatchNumber: number,
  tab: number,
  variant: number,
): Promise<void> {
  await fetch(`${supabaseUrl}/functions/v1/trigger-next-RF`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseServiceRoleKey },
    body: JSON.stringify({
      group_id: groupId,
      user_id: userId,
      current_batch_number: currentBatchNumber,
      tab,
      variant,
    }),
  });
}

async function compileFinalRFDocument(
  userId: string,
  groupId: string,
  title: string,
  description: string,
  variant: number,
  isCorrected: boolean,
  version: number,
  folderTimestamp: string,
  tab: number,
): Promise<void> {
  const { data: existingDoc } = await supabase
    .from('story_documents')
    .select('id')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('variant', variant)
    .eq('version', version)
    .limit(1);

  if (existingDoc?.length) return;

  const sanitized = sanitizeTitle(title.replace(/^RF Prompt:\s*/i, '').replace(/^RF Prompts:\s*/i, ''));
  const folderPath = `documents/${userId}/${groupId}/RF-${sanitized}_${folderTimestamp}`;
  const { data: urlData } = supabase.storage.from('stories').getPublicUrl(folderPath);
  const documentId = crypto.randomUUID();
  const cleanTitle = title.replace(/^RF Prompt:\s*/i, '').replace(/^RF Prompts:\s*/i, '').trim();

  await supabase.from('story_documents').insert({
    id: documentId,
    title: `RF Outputs: ${cleanTitle}`,
    description,
    version,
    is_corrected: isCorrected,
    is_prompted: false,
    user_id: userId,
    file_path: folderPath,
    file_url: urlData?.publicUrl ?? '',
    image_model: 'stock',
    created_at: new Date().toISOString(),
    group_id: groupId,
    variant,
    tab,
  });

  await supabase
    .from('RF_tasks')
    .update({ status: 'completed_final', updated_at: new Date().toISOString() })
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('tab', tab)
    .eq('variant', variant);

  await supabase
    .from('tabs')
    .update({ status: 'complete', updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('page', 'rf')
    .eq('tab_number', tab)
    .eq('group_id', groupId);
}

async function completeTask(task: Record<string, unknown>, remoteUrl: string, stockSource: string, stockId: string): Promise<void> {
  const taskId = task.id as string;
  const userId = task.user_id as string;
  const groupId = task.group_id as string;
  const batchNumber = task.batch_number as number;
  const totalBatches = task.total_batches as number;
  const tab = (task.tab as number) ?? 1;
  const variant = (task.variant as number) ?? 1;

  const bytes = await downloadVideoBytes(remoteUrl);
  const sanitized = sanitizeTitle(String(task.story_title).replace(/^RF Prompt:\s*/i, ''));
  const storagePath = `documents/${userId}/${groupId}/RF-${sanitized}_${task.folder_timestamp}/${batchNumber}.mp4`;
  await uploadVideoToStorage(bytes, storagePath);

  await supabase
    .from('RF_tasks')
    .update({
      status: 'completed',
      video_url: storagePath,
      stock_source: stockSource,
      stock_id: stockId,
      progress: 100,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  if (batchNumber >= totalBatches) {
    await compileFinalRFDocument(
      userId,
      groupId,
      String(task.story_title),
      String(task.description ?? task.story_title),
      variant,
      !!task.is_corrected,
      (task.version as number) ?? 14,
      String(task.folder_timestamp),
      tab,
    );
  } else {
    await triggerNextRF(groupId, userId, batchNumber, tab, variant);
  }
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });
    }

    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });
    }

    const { group_id, user_id, batch_number, total_batches, tab, variant } = await req.json();
    const tabNum = tab ?? 1;
    const variantNum = variant ?? 1;

    const { data: tasks, error: fetchErr } = await supabase
      .from('RF_tasks')
      .select('*')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('batch_number', batch_number)
      .eq('tab', tabNum)
      .eq('variant', variantNum)
      .in('status', ['queued', 'pending', 'error'])
      .order('created_at', { ascending: true })
      .limit(1);

    if (fetchErr) {
      return new Response(JSON.stringify({ error: fetchErr.message }), { status: 500, headers: responseHeaders });
    }

    if (!tasks?.length) {
      await triggerNextRF(group_id, user_id, batch_number, tabNum, variantNum);
      return new Response(JSON.stringify({ message: 'No actionable task — triggered next' }), { status: 200, headers: responseHeaders });
    }

    const task = tasks[0];
    let searchQuery = '';
    try {
      const batchArr = Array.isArray(task.batch) ? task.batch : JSON.parse(String(task.batch));
      searchQuery = batchArr[0]?.prompt ?? '';
    } catch {
      searchQuery = task.text_part ?? '';
    }
    if (!searchQuery?.trim()) {
      return new Response(JSON.stringify({ error: 'Task has no search query' }), { status: 400, headers: responseHeaders });
    }

    await supabase
      .from('RF_tasks')
      .update({ status: 'running', error: null, updated_at: new Date().toISOString() })
      .eq('id', task.id);

    const response = new Response(
      JSON.stringify({ message: 'Processing stock clip', batch_number, task_id: task.id }),
      { status: 200, headers: responseHeaders },
    );

    EdgeRuntime.waitUntil(
      (async () => {
        try {
          const gen = await callGenerateRF(searchQuery.trim());
          if (gen.status !== 'completed' || !gen.video_url) {
            await supabase
              .from('RF_tasks')
              .update({
                status: 'error',
                error: gen.error ?? 'No clip found',
                updated_at: new Date().toISOString(),
              })
              .eq('id', task.id);
            return;
          }
          await completeTask(
            task,
            gen.video_url,
            gen.stock_source ?? 'unknown',
            gen.stock_id ?? '',
          );
        } catch (e) {
          await logError(`process-RF failed for ${task.id}`, e);
          await supabase
            .from('RF_tasks')
            .update({
              status: 'error',
              error: (e as Error).message,
              updated_at: new Date().toISOString(),
            })
            .eq('id', task.id);
        }
      })(),
    );

    return response;
  } catch (error) {
    await logError('process-RF error', error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: responseHeaders },
    );
  }
});
