
import { createClient } from 'npm:@supabase/supabase-js@2';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ITVSegment {
  text: string;
  index: number;
}

interface ITVTask {
  id: string;
  user_id: string;
  group_id: string;
  story_title: string;
  description: string;
  batch: ITVSegment[];
  text_part: string;
  batch_output: string;
  total_batches: number;
  batch_number: number;
  total_prompts: number;
  total_videos: number;
  status: string;
  progress: number;
  error: null | string;
  settings: Record<string, unknown>;
  variant: number;
  file_path: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  updated_at: string;
  version: number;
  language: string;
  model: string;
  video_model: string;
  video_duration: number;
  tab: number;
  is_corrected: boolean;
  audio_clip: boolean;
  itv: boolean;  // false = Phase 1 (image prompts)
  video_process: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BATCH_SIZE = 2;
const TASK_INSERT_CHUNK = 20;
const BATCH_DELAY_MS = 500;
const MAX_RETRIES = 3;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SECRET_KEY") || ""
);

// Sanitise segment text so that when the AI echoes it back inside its JSON response,
// stray backslashes and double-quote chars do not produce invalid JSON.
function sanitizeSegmentText(text: string): string {
  // Strip any SSML break tag remnants (well-formed, malformed, or orphaned fragments)
  text = text.replace(/<break\b[^>]*?\/?>/gi, '');
  text = text.replace(/<break\b[^>]*$/gm, '');
  text = text.replace(/^\s*["'\u2018\u2019\u201C\u201D]?\d+ms["'\u2018\u2019\u201C\u201D]?\s*\/?>/gm, '');
  return text
    .replace(/\\/g, '')      // remove lone backslashes
    .replace(/"/g, "'");    // replace double quotes with single quotes
}

// ─── Task insertion ───────────────────────────────────────────────────────────

async function insertITVTasksInChunks(tasks: ITVTask[], startTime: number, maxRuntime: number) {
  console.log(`Inserting ${tasks.length} ITV prompt tasks`);
  for (let i = 0; i < tasks.length; i += TASK_INSERT_CHUNK) {
    if (Date.now() - startTime > maxRuntime * 0.9) throw new Error(`Runtime limit hit at task ${i}`);
    const chunk = tasks.slice(i, i + TASK_INSERT_CHUNK);
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const { error } = await supabase.from('ITV_prompt_tasks').insert(chunk);
        if (error) throw new Error(`DB insert failed at ${i}: ${error.message}`);
        console.log(`Inserted ITV tasks ${i + 1}–${i + chunk.length}`);
        break;
      } catch (err: any) {
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
          continue;
        }
        throw err;
      }
    }
    if (i + TASK_INSERT_CHUNK < tasks.length) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
  }
}

// ─── Trigger first batch ──────────────────────────────────────────────────────

async function triggerFirstBatch(group_id: string, user_id: string, tab: number, variant: number, itv: boolean) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SECRET_KEY") || "";

  const response = await fetch(`${supabaseUrl}/functions/v1/trigger-next-ITV-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': serviceKey,},
    body: JSON.stringify({ group_id, user_id, current_batch_number: 0, tab, variant, itv }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to trigger first ITV prompt batch: HTTP ${response.status} - ${errText}`);
  }
  console.log(`Triggered first ITV prompt batch for group=${group_id}, tab=${tab}, variant=${variant}, itv=${itv}`);
}

// ─── serve ────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://storyscriptai.com',
  'https://www.storyscriptai.com',
  'https://northnoir.com',
  'https://www.northnoir.com',
  'http://localhost:5173',
];

function getCorsOrigin(req: Request): string {
  const origin = req.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

Deno.serve(async (req) => {
  const corsOrigin = getCorsOrigin(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
    });
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get('Authorization');
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!authToken) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
      });
    }    // authToken resolved above (Bearer or apikey)
    const _srvKey = Deno.env.get('SECRET_KEY') || '';
    const _secretKey = Deno.env.get('SECRET_KEY') || '';
    let userId: string | null = null;
    if (authToken !== _srvKey && authToken !== _secretKey) {
      const { data: { user: _authUser }, error: _authErr } = await supabase.auth.getUser(authToken);
      if (_authErr || !_authUser) {
        return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
        });
      }
      userId = _authUser.id;
    }

    const startTime = Date.now();
    const maxRuntime = 300000;

    const requestData = await req.json();
    // Override user_id from JWT for non-service-role calls
    if (userId) {
      requestData.user_id = userId;
    }
    const { jobId, user_id } = requestData;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!jobId || !uuidRegex.test(jobId)) throw new Error('Missing or invalid jobId');
    if (!user_id || !uuidRegex.test(user_id)) throw new Error('Missing or invalid user_id');

    // ── Read job data ─────────────────────────────────────────────────────────

    const { data: jobData, error: jobError } = await supabase
      .from('job_data')
      .select('data')
      .eq('id', jobId)
      .eq('user_id', user_id)
      .single();

    if (jobError || !jobData) throw new Error(`Failed to fetch ITV job data: ${jobError?.message ?? 'Not found'}`);

    const {
      group_id,
      file_path,
      story_title,
      description,
      video_model,
      clip_duration,
      total_images,
      image_model = 'imagen-4-fast',
      variant,
      is_corrected = false,
      userTokenBalance,
      language,
      model,
      tab = 1,
      audio_clip = false,
      style = '',
      // New multi-part format from setup-itv-prompts
      segmentsByPart,
      textParts: textPartKeys,
      // Legacy fallback: flat segments array
      segments: legacySegments,
      characters = {},
      useCharacterDescriptions = true,
      videoProcess = false,
    } = jobData.data;

    // ── Validate ──────────────────────────────────────────────────────────────

    if (!group_id || !uuidRegex.test(group_id)) throw new Error('Invalid group_id in job data');
    if (!file_path || typeof file_path !== 'string') throw new Error('Invalid file_path in job data');
    if (!story_title || typeof story_title !== 'string') throw new Error('Invalid story_title in job data');
    if (!description || typeof description !== 'string') throw new Error('Invalid description in job data');
    if (!video_model || typeof video_model !== 'string') throw new Error('Invalid video_model in job data');
    if (typeof clip_duration !== 'number' || clip_duration <= 0) throw new Error('Invalid clip_duration in job data');
    if (typeof total_images !== 'number' || total_images < 1) throw new Error('Invalid total_images in job data');
    if (typeof variant !== 'number') throw new Error('Invalid variant in job data');

    // Normalise to segmentsByPart — support both new multi-part and old flat format
    const resolvedSegmentsByPart: Record<string, Array<{ text: string; index: number }>> =
      segmentsByPart && typeof segmentsByPart === 'object' && !Array.isArray(segmentsByPart)
        ? segmentsByPart
        : { '1': Array.isArray(legacySegments) ? legacySegments : [] };

    const resolvedTextPartKeys: string[] =
      Array.isArray(textPartKeys) && textPartKeys.length > 0
        ? textPartKeys
        : Object.keys(resolvedSegmentsByPart).sort((a, b) => Number(a) - Number(b));

    if (resolvedTextPartKeys.length === 0 || resolvedTextPartKeys.every(k => (resolvedSegmentsByPart[k]?.length ?? 0) === 0)) {
      throw new Error('Invalid or empty segments in job data');
    }

    const validatedModel = ['deepseek', 'sonnet', 'opus'].includes(model || '') ? model : 'sonnet';
    const validatedLanguage = ['english', 'german', 'spanish', 'french'].includes(language || '') ? language : 'english';

    // ── Prevent duplicate runs ────────────────────────────────────────────────

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from('ITV_prompt_tasks')
      .select('*', { count: 'exact', head: true })
      .eq('group_id', group_id)
      .eq('variant', variant)
      .eq('tab', tab)
      .eq('itv', false)
      .gte('created_at', fiveMinutesAgo);

    if (count && count > 0) {
      console.log(`ITV Phase 1 tasks already exist: group=${group_id}, variant=${variant}, tab=${tab}`);
      return new Response(JSON.stringify({ error: 'ITV Phase 1 tasks already in progress' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
      });
    }

    // ── Build ITV_prompt_tasks rows (Phase 1, itv=false) ─────────────────────
    // Loop over each text part, creating batches whose text_part mirrors part_number
    // in ITV_prompt_context — exactly matching the TTV multi-part approach.

    const allTasks: ITVTask[] = [];
    let globalBatchNumber = 0;
    let totalSegments = 0;
    for (const pk of resolvedTextPartKeys) totalSegments += resolvedSegmentsByPart[pk]?.length ?? 0;

    for (const partKey of resolvedTextPartKeys) {
      const partSegments = resolvedSegmentsByPart[partKey] ?? [];
      if (partSegments.length === 0) continue;

      // Sanitize segment text to prevent AI JSON echo issues
      const sanitizedSegments = partSegments.map((seg: ITVSegment) => ({
        ...seg,
        text: sanitizeSegmentText(seg.text),
      }));

      const partBatches: ITVSegment[][] = [];
      for (let b = 0; b < sanitizedSegments.length; b += BATCH_SIZE) {
        partBatches.push(sanitizedSegments.slice(b, b + BATCH_SIZE));
      }

      for (let bIdx = 0; bIdx < partBatches.length; bIdx++) {
        const batchNumber = globalBatchNumber + 1;
        const isFirst = batchNumber === 1;

        const task: ITVTask = {
          id: crypto.randomUUID(),
          user_id,
          group_id,
          story_title,
          description,
          batch: partBatches[bIdx],
          text_part: partKey,  // mirrors part_number in ITV_prompt_context(itv=false)
          batch_output: '',
          total_batches: 0,  // filled after all tasks are counted
          batch_number: batchNumber,
          total_prompts: totalSegments,
          total_videos: total_images,
          status: isFirst ? 'queued' : 'pending',
          progress: 0,
          error: null,
          settings: {
            video_model,
            clip_duration,
            image_model,
            audio_clip,
            characters,
            useCharacterDescriptions,
          },
          variant,
          file_path,
          input_tokens: 0,
          output_tokens: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: is_corrected ? 17 : 16,
          language: validatedLanguage,
          model: validatedModel,
          video_model,
          video_duration: clip_duration,
          image_model,
          tab,
          is_corrected,
          audio_clip,
          itv: false,
          video_process: videoProcess,
        };

        allTasks.push(task);
        globalBatchNumber++;
      }
    }

    if (allTasks.length === 0) throw new Error('No ITV prompt tasks could be created');

    // Backfill total_batches
    for (const t of allTasks) t.total_batches = globalBatchNumber;

    // ── Insert task rows ──────────────────────────────────────────────────────

    await insertITVTasksInChunks(allTasks, startTime, maxRuntime);

    // ── Update video_tasks.image_amount with actual ITV clip count ─────────
    // This lets the frontend use it for accurate time estimation on page reload
    const { error: imgAmtErr } = await supabase
      .from('video_tasks')
      .update({ image_amount: total_images, updated_at: new Date().toISOString() })
      .eq('group_id', group_id)
      .eq('is_main', true);
    if (imgAmtErr) console.error(`Failed to update image_amount on video_tasks: ${imgAmtErr.message}`);
    else console.log(`Updated video_tasks.image_amount = ${total_images} for group ${group_id}`);

    // Ensure first task is queued
    const firstTask = allTasks.find(t => t.batch_number === 1);
    if (firstTask) {
      await supabase.from('ITV_prompt_tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString() })
        .eq('id', firstTask.id);
    }

    // ── Trigger first Phase 1 batch ───────────────────────────────────────────

    await triggerFirstBatch(group_id, user_id, tab, variant, false);

    // ── Clean up job data ─────────────────────────────────────────────────────

    const { error: delError } = await supabase.from('job_data').delete().eq('id', jobId);
    if (delError) console.error(`Failed to delete ITV job data: ${delError.message}`);
    else console.log(`Deleted ITV job data ${jobId}`);

    return new Response(JSON.stringify({
      task_ids: allTasks.map(t => t.id),
      total_batches: globalBatchNumber,
      total_images,
      language: validatedLanguage,
      model: validatedModel,
      tab,
      variant,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
    });

  } catch (error: any) {
    console.error(`Error in process-itv-task: ${error.message}`);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
    });
  }
});




