// setup-RF-tasks/index.ts
// Sets up RF_tasks rows from a compiled RF prompts JSON file (version 28/29 → 30/31)
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import {
  RF_CLIP_VERSION_CORRECTED,
  RF_CLIP_VERSION_ORIGINAL,
  rfClipVersion,
} from '../_shared/rfVersions.ts';
import { clampRFClipDuration } from '../_shared/rfClipDuration.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);



const SUPPORTED_VIDEO_MODELS = ['stock'];

interface SetupRequest {
  user_id: string;
  group_id: string;
  file_path: string;       // path to the RF prompts JSON (version 28/29 doc)
  story_title: string;
  description: string;
  doc_id: string;
  variant: number;
  video_model: string;
  video_duration: number;
  tab?: number;
  language?: string;
  audio_clip?: boolean;
  high_res?: boolean;
}

interface RFPromptItem {
  text: string;    // original story segment text
  prompt: string;  // generated stock search query
  video_duration?: number;
}

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

/** Start Phase 2 — must await; fire-and-forget often dies when the handler returns. */
async function triggerFirstRFBatch(payload: {
  group_id: string;
  user_id: string;
  current_batch_number: number;
  tab: number;
  variant: number;
}): Promise<void> {
  const headers = {
    'Content-Type': 'application/json',
    apikey: supabaseServiceRoleKey,
    Authorization: `Bearer ${supabaseServiceRoleKey}`,
  };
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/trigger-next-RF`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      console.log(`trigger-next-RF ok (attempt ${attempt}): ${text.slice(0, 200)}`);
      return;
    } catch (err) {
      lastError = err as Error;
      console.error(`trigger-next-RF attempt ${attempt} failed: ${lastError.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  await logError('Error triggering first RF batch after retries', lastError);
}

async function insertTasksInBatches(tasks: any[], startTime: number, maxRuntime: number) {
  const CHUNK = 20;
  for (let i = 0; i < tasks.length; i += CHUNK) {
    if (Date.now() - startTime > maxRuntime * 0.9) {
      throw new Error('Function runtime limit approaching — aborting task insert');
    }
    const slice = tasks.slice(i, i + CHUNK);
    const { error } = await supabase.from('RF_tasks').insert(slice);
    if (error) throw new Error(`Failed to insert TTV task batch: ${error.message}`);
    console.log(`Inserted TTV task chunk ${Math.floor(i / CHUNK) + 1} (${slice.length} rows)`);
    if (i + CHUNK < tasks.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 300000;

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const requestData: SetupRequest = await req.json();
    if (!auth.isServiceRole && auth.userId) {
      requestData.user_id = auth.userId;
    }
    const {
      user_id, group_id, file_path, story_title, description,
      doc_id, variant, video_model, video_duration, language,
    } = requestData;
    const tab = requestData.tab ?? 1;
    const audio_clip = requestData.audio_clip ?? false;
    const high_res = requestData.high_res ?? false;

    // ── Validation ─────────────────────────────────────────────────────────────
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!user_id || !uuidRegex.test(user_id))
      return new Response(JSON.stringify({ error: 'Missing or invalid user_id' }), { status: 400, headers: responseHeaders });
    if (!group_id || !uuidRegex.test(group_id))
      return new Response(JSON.stringify({ error: 'Missing or invalid group_id' }), { status: 400, headers: responseHeaders });
    if (!doc_id || !uuidRegex.test(doc_id))
      return new Response(JSON.stringify({ error: 'Missing or invalid doc_id' }), { status: 400, headers: responseHeaders });
    if (!file_path || typeof file_path !== 'string')
      return new Response(JSON.stringify({ error: 'Missing file_path' }), { status: 400, headers: responseHeaders });
    if (!story_title || typeof story_title !== 'string')
      return new Response(JSON.stringify({ error: 'Missing story_title' }), { status: 400, headers: responseHeaders });
    if (!description || typeof description !== 'string')
      return new Response(JSON.stringify({ error: 'Missing description' }), { status: 400, headers: responseHeaders });
    if (typeof variant !== 'number')
      return new Response(JSON.stringify({ error: 'Missing or invalid variant' }), { status: 400, headers: responseHeaders });
    const effectiveVideoModel = video_model && SUPPORTED_VIDEO_MODELS.includes(video_model) ? video_model : 'stock';
    if (typeof video_duration !== 'number' || video_duration <= 0)
      return new Response(JSON.stringify({ error: 'Invalid video_duration' }), { status: 400, headers: responseHeaders });

    const supportedLanguages = ['english', 'german', 'spanish', 'french'];
    const validatedLanguage = supportedLanguages.includes(language ?? '') ? language : 'english';

    // ── Variant collision detection (same logic as setup-image-tasks) ───────────
    const versionsToCheck = [RF_CLIP_VERSION_ORIGINAL, RF_CLIP_VERSION_CORRECTED];

    const [existingTasksRes, existingDocsRes] = await Promise.all([
      supabase.from('RF_tasks').select('variant')
        .eq('group_id', group_id).eq('user_id', user_id)
        .eq('tab', tab).in('version', versionsToCheck),
      supabase.from('story_documents').select('variant')
        .eq('group_id', group_id).eq('user_id', user_id)
        .eq('tab', tab).in('version', versionsToCheck),
    ]);

    const existingVariants = new Set<number>();
    existingTasksRes.data?.forEach((t: { variant: number | null }) => {
      if (t.variant != null) existingVariants.add(t.variant);
    });
    existingDocsRes.data?.forEach((d: { variant: number | null }) => {
      if (d.variant != null) existingVariants.add(d.variant);
    });

    let finalVariant = variant;
    if (existingVariants.has(variant)) {
      finalVariant = Math.max(...Array.from(existingVariants)) + 1;
    }

    console.log(`RF variant: requested=${variant}, existing=[${Array.from(existingVariants).sort().join(', ')}], using=${finalVariant}`);

    // ── Fetch source document metadata ─────────────────────────────────────────
    const { data: docData, error: docError } = await supabase
      .from('story_documents')
      .select('is_corrected, version, language')
      .eq('id', doc_id)
      .single();

    if (docError) throw new Error(`Failed to fetch document metadata: ${docError.message}`);

    const { is_corrected } = docData;
    const documentLanguage = docData.language || validatedLanguage;

    // version 28 (original RF prompts) → 30; version 29 (corrected) → 31
    const outputVersion = rfClipVersion(!!is_corrected);

    // ── Determine if this is a video pipeline call ───────────────────────────
    // Check if a video_tasks row exists with ttv='ttv' for this group.
    // If yes, these RF_tasks are part of the video pipeline and need video_process=true
    // so the frontend progress calculator can query them.
    let videoProcess = false;
    try {
      const { data: vtRow } = await supabase
        .from('video_tasks')
        .select('id')
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .eq('ttv', 'ttv')
        .maybeSingle();
      videoProcess = !!vtRow;
      if (videoProcess) console.log('Video pipeline detected — will set video_process=true on RF_tasks');
    } catch (err: any) {
      console.warn(`Could not check video_tasks for video_process: ${err.message}`);
    }

    // ── Download and parse RF prompts JSON ─────────────────────────────────────
    const { data: fileData, error: fileError } = await supabase
      .storage.from('stories').download(file_path);

    if (fileError) throw new Error(`Failed to download RF prompts file: ${fileError.message}`);

    const content = await fileData.text();
    if (!content || content.length === 0) throw new Error('TTV prompts file is empty');

    let prompts: RFPromptItem[];
    try {
      prompts = JSON.parse(content);
    } catch (_) {
      throw new Error('TTV prompts file is not valid JSON');
    }

    if (!Array.isArray(prompts) || prompts.length === 0) {
      throw new Error('No TTV prompts found in file');
    }

    const validPrompts = prompts.filter(p => p && typeof p.prompt === 'string' && p.prompt.trim().length > 0);
    if (validPrompts.length === 0) throw new Error('No valid TTV prompts found');

    const totalPrompts = validPrompts.length;
    const totalBatches = totalPrompts; // one task (= one video) per batch
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // ── Build task rows ─────────────────────────────────────────────────────────
    const tasks = validPrompts.map((item, i) => ({
      id: crypto.randomUUID(),
      user_id,
      group_id,
      doc_id,
      story_title,
      description,
      file_path,
      text_part: item.text || '',
      // batch stores: [{ text: original_segment, prompt: search_query, index }]
      batch: [{ text: item.text || '', prompt: item.prompt.trim(), index: i + 1 }],
      batch_output: '',
      total_batches: totalBatches,
      batch_number: i + 1,
      total_prompts: totalPrompts,
      progress: 0,
      status: i === 0 ? 'queued' : 'pending',
      error: null,
      settings: { high_res },
      variant: finalVariant,
      is_corrected,
      tokens: 0,
      token_updated: false,
      version: outputVersion,
      folder_timestamp: timestamp,
      video_model: effectiveVideoModel,
      video_duration: clampRFClipDuration(Number(item.video_duration) || video_duration),
      video_process: videoProcess,
      language: documentLanguage,
      tab,
      audio_clip,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    await insertTasksInBatches(tasks, startTime, maxRuntime);

    // Guarantee first task is queued then fire the trigger
    await supabase
      .from('RF_tasks')
      .update({ status: 'queued', updated_at: new Date().toISOString() })
      .eq('id', tasks[0].id);

    await triggerFirstRFBatch({
      group_id,
      user_id,
      current_batch_number: 0,
      tab,
      variant: finalVariant,
    });

    return new Response(
      JSON.stringify({
        task_ids: tasks.map(t => t.id),
        total_batches: totalBatches,
        total_prompts: totalPrompts,
        video_model: effectiveVideoModel,
        video_duration,
        variant: finalVariant,
        version: outputVersion,
        language: documentLanguage,
      }),
      { status: 200, headers: responseHeaders },
    );

  } catch (error: any) {
    await logError('Error in setup-RF-tasks', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error', code: 500 }),
      { status: 500, headers: responseHeaders },
    );
  }
});
