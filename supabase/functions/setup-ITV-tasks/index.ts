// setup-ITV-tasks/index.ts
// Called after BOTH Phase 2 video prompts AND ITV keyframe images are complete (dual-completion).
// Downloads the video prompts JSON (version 20/21), pairs each {text,prompt} with its
// keyframe image URL (from image_tasks where itv=TRUE), then creates ITV_tasks rows.
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



interface SetupRequest {
  user_id: string;
  group_id: string;
  tab?: number;
  variant?: number;
}

interface ITVPromptItem {
  text: string;
  prompt: string;
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

async function insertTasksInBatches(tasks: any[], startTime: number, maxRuntime: number) {
  const CHUNK = 20;
  for (let i = 0; i < tasks.length; i += CHUNK) {
    if (Date.now() - startTime > maxRuntime * 0.9) {
      throw new Error('Function runtime limit approaching — aborting ITV task insert');
    }
    const slice = tasks.slice(i, i + CHUNK);
    const { error } = await supabase.from('ITV_tasks').insert(slice);
    if (error) throw new Error(`Failed to insert ITV task batch: ${error.message}`);
    console.log(`Inserted ITV task chunk ${Math.floor(i / CHUNK) + 1} (${slice.length} rows)`);
    if (i + CHUNK < tasks.length) await new Promise(r => setTimeout(r, 200));
  }
}

serve(async (req: Request) => {
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
    const { user_id, group_id } = requestData;
    const tab = requestData.tab ?? 1;
    const variant = requestData.variant ?? 1;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!user_id || !uuidRegex.test(user_id))
      return new Response(JSON.stringify({ error: 'Missing or invalid user_id' }), { status: 400, headers: responseHeaders });
    if (!group_id || !uuidRegex.test(group_id))
      return new Response(JSON.stringify({ error: 'Missing or invalid group_id' }), { status: 400, headers: responseHeaders });

    console.log(`setup-ITV-tasks: group=${group_id}, tab=${tab}, variant=${variant}`);

    // ── 1. Find Phase 2 video prompts document (version 20 or 21) ─────────────
    const { data: videoPromptsDocs, error: vpDocError } = await supabase
      .from('story_documents')
      .select('id, file_path, is_corrected, version, title, description, language')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('tab', tab)
      .in('version', [20, 21])
      .order('created_at', { ascending: false });

    if (vpDocError || !videoPromptsDocs || videoPromptsDocs.length === 0) {
      throw new Error(`No ITV video prompts document found for group ${group_id}, tab ${tab}: ${vpDocError?.message ?? 'Not found'}`);
    }

    const videoPromptsDoc = videoPromptsDocs[0];
    console.log(`Found video prompts doc: id=${videoPromptsDoc.id}, version=${videoPromptsDoc.version}, path=${videoPromptsDoc.file_path}`);

    // ── 2. Download and parse video prompts JSON [{text, prompt}] ──────────────
    const { data: fileData, error: fileError } = await supabase
      .storage.from('stories').download(videoPromptsDoc.file_path);

    if (fileError) throw new Error(`Failed to download ITV video prompts file: ${fileError.message}`);

    const content = await fileData.text();
    if (!content || content.length === 0) throw new Error('ITV video prompts file is empty');

    let videoPrompts: ITVPromptItem[];
    try {
      videoPrompts = JSON.parse(content);
    } catch (_) {
      throw new Error('ITV video prompts file is not valid JSON');
    }

    if (!Array.isArray(videoPrompts) || videoPrompts.length === 0) {
      throw new Error('No ITV video prompts found in file');
    }

    const validPrompts = videoPrompts.filter(p => p && typeof p.prompt === 'string' && p.prompt.trim().length > 0);
    if (validPrompts.length === 0) throw new Error('No valid ITV video prompts');

    console.log(`Parsed ${validPrompts.length} ITV video prompts`);

    // ── 3. Get ITV settings from ITV_prompt_context (itv=false, part_number=1) ─
    // These were stored by setup-itv-prompts when the user kicked off the ITV job.
    const { data: itvContext, error: ctxError } = await supabase
      .from('ITV_prompt_context')
      .select('video_model, video_duration, audio_clip, image_model')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('tab', tab)
      .eq('itv', false)
      .eq('part_number', 1)
      .single();

    if (ctxError || !itvContext) {
      throw new Error(`Failed to fetch ITV context for group ${group_id}, tab ${tab}: ${ctxError?.message ?? 'Not found'}`);
    }

    const videoModel: string = itvContext.video_model ?? 'wan22';
    const videoDuration: number = itvContext.video_duration ?? 5.06;
    const audioClip: boolean = itvContext.audio_clip ?? false;
    const imageModel: string = itvContext.image_model ?? 'imagen-4-fast';

    console.log(`ITV settings: video_model=${videoModel}, duration=${videoDuration}, audio_clip=${audioClip}`);

    // ── 3b. Determine if this is a video pipeline call ───────────────────────
    // Check if a video_tasks row exists with visual_type='itv' for this group.
    // If yes, these ITV_tasks are part of the video pipeline and need video_process=true
    // so the frontend progress calculator can query them.
    let videoProcess = false;
    try {
      const { data: vtRow } = await supabase
        .from('video_tasks')
        .select('id')
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .eq('visual_type', 'itv')
        .maybeSingle();
      videoProcess = !!vtRow;
      if (videoProcess) console.log('Video pipeline detected — will set video_process=true on ITV_tasks');
    } catch (err: any) {
      console.warn(`Could not check video_tasks for video_process: ${err.message}`);
    }

    // ── 4. Get ITV keyframe image tasks (completed) ────────────────────────────
    const { data: imageTasks, error: imageTasksError } = await supabase
      .from('image_tasks')
      .select('id, batch_number, batch_output, text_part, status, folder_timestamp')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('tab', tab)
      .eq('itv', true)
      .in('status', ['completed_final', 'completed'])
      .order('batch_number', { ascending: true });

    if (imageTasksError || !imageTasks || imageTasks.length === 0) {
      throw new Error(`No completed ITV image tasks found for group ${group_id}, tab ${tab}: ${imageTasksError?.message ?? 'Not found'}`);
    }

    console.log(`Found ${imageTasks.length} completed ITV image tasks`);

    // ── 5. Extract image URLs from image tasks ─────────────────────────────────
    // batch_output is stored as "Image N saved to: <url>" by process-image — extract just the URL.
    const imageEntries: Array<{ imageUrl: string; imageNumber: number }> = [];
    for (const imgTask of imageTasks) {
      const rawOutput = (imgTask.batch_output as string) ?? '';
      if (!rawOutput || typeof rawOutput !== 'string' || rawOutput.trim().length === 0) {
        console.warn(`Skipping image task ${imgTask.id} (batch ${imgTask.batch_number}): empty batch_output`);
        continue;
      }
      // Strip "Image N saved to: " prefix if present (format written by process-image)
      const savedToMatch = rawOutput.trim().match(/^Image\s+\d+\s+saved\s+to:\s+(https?:\/\/.+)$/i);
      const imageUrl = savedToMatch ? savedToMatch[1].trim() : rawOutput.trim();
      if (!imageUrl.startsWith('http')) {
        console.warn(`Skipping image task ${imgTask.id} (batch ${imgTask.batch_number}): batch_output is not a URL: ${rawOutput.slice(0, 80)}`);
        continue;
      }
      imageEntries.push({ imageUrl, imageNumber: imgTask.batch_number });
    }

    if (imageEntries.length === 0) throw new Error('No image URLs found in completed ITV image tasks');

    const totalImages = imageEntries.length;
    const effectivePrompts = validPrompts.slice(0, totalImages);
    if (effectivePrompts.length < validPrompts.length) {
      console.warn(`Have ${validPrompts.length} video prompts but only ${totalImages} images — truncating`);
    }

    console.log(`Pairing ${effectivePrompts.length} prompts with ${totalImages} images`);

    // ── 6. Variant collision check for ITV_tasks (versions 22/23) ─────────────
    const versionsToCheck = [22, 23];

    const [existingTasksRes, existingDocsRes] = await Promise.all([
      supabase.from('ITV_tasks').select('variant')
        .eq('group_id', group_id).eq('user_id', user_id)
        .eq('tab', tab).in('version', versionsToCheck),
      supabase.from('story_documents').select('variant')
        .eq('group_id', group_id).eq('user_id', user_id)
        .eq('tab', tab).in('version', versionsToCheck),
    ]);

    const existingVariants = new Set<number>();
    existingTasksRes.data?.forEach(t => { if (t.variant != null) existingVariants.add(t.variant); });
    existingDocsRes.data?.forEach(d => { if (d.variant != null) existingVariants.add(d.variant); });

    let finalVariant = variant;
    if (existingVariants.has(variant)) {
      finalVariant = Math.max(...Array.from(existingVariants)) + 1;
    }

    console.log(`ITV variant: requested=${variant}, using=${finalVariant}`);

    const isCorrected = videoPromptsDoc.is_corrected ?? false;
    const outputVersion = isCorrected ? 23 : 22;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const documentLanguage = videoPromptsDoc.language ?? 'english';
    const storyTitle = videoPromptsDoc.title?.replace(/^ITV Video Prompts:\s*/i, '') ?? 'story';
    const description = videoPromptsDoc.description ?? '';

    // ── 7. Build ITV_tasks rows ────────────────────────────────────────────────
    const tasks = effectivePrompts.map((item, i) => {
      const entry = imageEntries[i] ?? { imageUrl: '', imageNumber: i + 1 };
      return {
        id: crypto.randomUUID(),
        user_id,
        group_id,
        doc_id: videoPromptsDoc.id,
        story_title: storyTitle,
        description,
        file_path: videoPromptsDoc.file_path,
        text_part: item.text || '',
        batch: [{
          text: item.text || '',
          prompt: item.prompt.trim(),
          image_url: entry.imageUrl,
          image_number: entry.imageNumber,
          index: i + 1,
        }],
        batch_output: '',
        total_batches: effectivePrompts.length,
        batch_number: i + 1,
        total_prompts: effectivePrompts.length,
        progress: 0,
        status: i === 0 ? 'queued' : 'pending',
        error: null,
        variant: finalVariant,
        is_corrected: isCorrected,
        tokens: 0,
        token_updated: false,
        version: outputVersion,
        folder_timestamp: timestamp,
        video_model: videoModel,
        video_duration: videoDuration,
        image_model: imageModel,
        language: documentLanguage,
        tab,
        audio_clip: audioClip,
        image_url: entry.imageUrl,
        image_number: entry.imageNumber,
        video_process: videoProcess,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    });

    await insertTasksInBatches(tasks, startTime, maxRuntime);
    console.log(`Inserted ${tasks.length} ITV_tasks for group ${group_id}, tab ${tab}`);

    // Guarantee first task is queued
    await supabase
      .from('ITV_tasks')
      .update({ status: 'queued', updated_at: new Date().toISOString() })
      .eq('id', tasks[0].id);

    // ── 9. Fire trigger-next-ITV ───────────────────────────────────────────────
    fetch(`${supabaseUrl}/functions/v1/trigger-next-ITV`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceRoleKey,},
      body: JSON.stringify({ group_id, user_id, current_batch_number: 0, tab, variant: finalVariant }),
    }).catch(err => {
      console.error(`Error triggering first ITV batch: ${err.message}`);
      logError('Error triggering first ITV batch', err);
    });

    return new Response(
      JSON.stringify({
        task_ids: tasks.map(t => t.id),
        total_tasks: tasks.length,
        video_model: videoModel,
        video_duration: videoDuration,
        variant: finalVariant,
        version: outputVersion,
        language: documentLanguage,
      }),
      { status: 200, headers: responseHeaders },
    );

  } catch (error: any) {
    await logError('Error in setup-ITV-tasks', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error', code: 500 }),
      { status: 500, headers: responseHeaders },
    );
  }
});
