// setup-MG-tasks/index.ts
// Mirrors setup-TTV-tasks but for Motion Graphics. Reads a compiled
// MG-prompts JSON file (an array of { text, inputProps }) from storage and
// inserts MG_tasks rows ready for the Remotion Lambda invoker.
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
  file_path: string;
  story_title: string;
  doc_id: string;
  variant: number;
  style_slug: string;
  composition_id: string;
  video_duration: number;
  tab?: number;
  language?: string;
  /** Forwarded from MG_prompt_tasks.codegen_model; written on every MG_tasks row. */
  codegen_model?: string | null;
  /** Optional parent video_tasks row id (set when launched from the unified VideoGenerator). */
  video_task_id?: string | null;
}

interface MGPromptItem {
  text: string;
  inputProps: Record<string, any>;
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
      throw new Error('Function runtime limit approaching — aborting MG task insert');
    }
    const slice = tasks.slice(i, i + CHUNK);
    const { error } = await supabase.from('MG_tasks').insert(slice);
    if (error) throw new Error(`Failed to insert MG task batch: ${error.message}`);
    if (i + CHUNK < tasks.length) await new Promise(r => setTimeout(r, 200));
  }
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 300_000;

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });
    }

    const requestData: SetupRequest = await req.json();
    if (!auth.isServiceRole && auth.userId) requestData.user_id = auth.userId;

    const {
      user_id, group_id, file_path, story_title, doc_id,
      variant, style_slug, composition_id, video_duration, language,
      codegen_model, video_task_id,
    } = requestData;
    const tab = requestData.tab ?? 1;
    const resolvedCodegenModel =
      codegen_model && (codegen_model === 'claude-sonnet-4-6' || codegen_model === 'claude-opus-4-6')
        ? codegen_model
        : 'claude-opus-4-6';

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!user_id || !uuidRegex.test(user_id))
      return new Response(JSON.stringify({ error: 'Missing or invalid user_id' }), { status: 400, headers: responseHeaders });
    if (!group_id || !uuidRegex.test(group_id))
      return new Response(JSON.stringify({ error: 'Missing or invalid group_id' }), { status: 400, headers: responseHeaders });
    if (!doc_id || !uuidRegex.test(doc_id))
      return new Response(JSON.stringify({ error: 'Missing or invalid doc_id' }), { status: 400, headers: responseHeaders });
    if (!file_path || typeof file_path !== 'string')
      return new Response(JSON.stringify({ error: 'Missing file_path' }), { status: 400, headers: responseHeaders });
    if (!story_title) return new Response(JSON.stringify({ error: 'Missing story_title' }), { status: 400, headers: responseHeaders });
    if (typeof variant !== 'number')
      return new Response(JSON.stringify({ error: 'Missing or invalid variant' }), { status: 400, headers: responseHeaders });
    if (!style_slug || typeof style_slug !== 'string')
      return new Response(JSON.stringify({ error: 'Missing style_slug' }), { status: 400, headers: responseHeaders });
    if (!composition_id || typeof composition_id !== 'string')
      return new Response(JSON.stringify({ error: 'Missing composition_id' }), { status: 400, headers: responseHeaders });
    if (typeof video_duration !== 'number' || video_duration <= 0)
      return new Response(JSON.stringify({ error: 'Invalid video_duration' }), { status: 400, headers: responseHeaders });

    const supportedLanguages = ['english', 'german', 'spanish', 'french'];
    const validatedLanguage = supportedLanguages.includes(language ?? '') ? language : 'english';

    // Variant collision detection (mirror TTV logic). MG video folders are
    // story_documents v26 (original) / v27 (corrected).
    const versionsToCheck = [26, 27];
    const [existingTasksRes, existingDocsRes] = await Promise.all([
      supabase.from('MG_tasks').select('variant').eq('group_id', group_id).eq('user_id', user_id).eq('tab', tab).in('version', versionsToCheck),
      supabase.from('story_documents').select('variant').eq('group_id', group_id).eq('user_id', user_id).eq('tab', tab).in('version', versionsToCheck),
    ]);
    const existingVariants = new Set<number>();
    existingTasksRes.data?.forEach(t => { if (t.variant != null) existingVariants.add(t.variant); });
    existingDocsRes.data?.forEach(d => { if (d.variant != null) existingVariants.add(d.variant); });

    let finalVariant = variant;
    if (existingVariants.has(variant)) finalVariant = Math.max(...Array.from(existingVariants)) + 1;

    // Source doc metadata
    const { data: docData, error: docError } = await supabase
      .from('story_documents')
      .select('is_corrected, version, language')
      .eq('id', doc_id)
      .single();
    if (docError) throw new Error(`Failed to fetch document metadata: ${docError.message}`);
    // story_documents.is_corrected is nullable, but MG_tasks.is_corrected is
    // NOT NULL (default false). An explicit null on insert overrides the default,
    // so coerce missing values to false here.
    const is_corrected: boolean = docData.is_corrected === true;
    const documentLanguage = docData.language || validatedLanguage;
    const outputVersion = is_corrected ? 27 : 26;

    // Download MG-prompts JSON
    const { data: fileData, error: fileError } = await supabase
      .storage.from('stories').download(file_path);
    if (fileError) throw new Error(`Failed to download MG prompts file: ${fileError.message}`);

    const content = await fileData.text();
    if (!content) throw new Error('MG prompts file is empty');

    let prompts: MGPromptItem[];
    try {
      prompts = JSON.parse(content);
    } catch (_) {
      throw new Error('MG prompts file is not valid JSON');
    }

    if (!Array.isArray(prompts) || prompts.length === 0) throw new Error('No MG prompts found in file');

    const validPrompts = prompts.filter(p =>
      p && p.inputProps && typeof p.inputProps === 'object',
    );
    if (validPrompts.length === 0) throw new Error('No valid MG prompts found');

    const totalPrompts = validPrompts.length;
    const totalBatches = totalPrompts;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // ─── Codegen-only pipeline ───────────────────────────────────────────
    // Every MG_tasks row is shaped exactly like a single-MG row:
    //   style_slug      = 'codegen'
    //   composition_id  = 'Clip'
    //   user_prompt     = the segment text (original story slice for this clip)
    //   motion_graphic_prompt = the LLM-rewritten vivid clip brief
    //                          (produced by generate-MG-prompt with full
    //                           batch context)
    //   style_guidance  = long-form style direction (from MG_prompt_context
    //                     or the preset's style_guidance)
    // batch[0].inputProps is kept as an empty object purely to preserve the
    // existing { text, inputProps, index } envelope shape that the rest of
    // the chain still reads.
    const tasks = validPrompts.map((item, i) => {
      const ip = (item.inputProps && typeof item.inputProps === 'object') ? item.inputProps : {};
      const motionPrompt: string =
        (typeof ip.motion_graphic_prompt === 'string' && ip.motion_graphic_prompt.trim()) ||
        (typeof ip.motionGraphicPrompt === 'string' && ip.motionGraphicPrompt.trim()) ||
        (typeof item.text === 'string' ? item.text.trim() : '');
      const styleGuidance: string =
        (typeof ip.style_guidance === 'string' && ip.style_guidance.trim()) ||
        (typeof ip.styleGuidance === 'string' && ip.styleGuidance.trim()) ||
        '';
      const segmentText: string =
        (typeof ip.user_prompt === 'string' && ip.user_prompt.trim()) ||
        (typeof item.text === 'string' ? item.text.trim() : '');
      const clipDuration: number =
        typeof ip.video_duration === 'number' ? ip.video_duration :
        typeof ip.videoDuration === 'number' ? ip.videoDuration :
        video_duration;
      const assets = Array.isArray(ip.assets) ? ip.assets : null;

      // Preserve the resolved inputProps inside the batch envelope so the
      // row mirrors MG_prompt_tasks.batch_output (and matches the TTV/image
      // pipeline shape where the prompt is visible on the task row). The
      // codegen pipeline still reads the dedicated columns below — this is
      // purely for visibility and debugging.
      const envelopeInputProps: Record<string, any> = {
        motion_graphic_prompt: motionPrompt,
        style_guidance: styleGuidance,
        video_duration: clipDuration,
        user_prompt: segmentText,
      };
      if (assets) envelopeInputProps.assets = assets;

      return {
        id: crypto.randomUUID(),
        user_id,
        group_id,
        doc_id,
        story_title,
        batch: [{ text: segmentText, inputProps: envelopeInputProps, index: i + 1 }],
        total_batches: totalBatches,
        batch_number: i + 1,
        total_prompts: totalPrompts,
        progress: 0,
        status: i === 0 ? 'queued' : 'pending',
        error: null,
        settings: {},
        variant: finalVariant,
        is_corrected,
        tokens: 0,
        version: outputVersion,
        folder_timestamp: timestamp,
        // Codegen pipeline contract:
        style_slug: 'codegen',
        composition_id: 'Clip',
        video_duration: clipDuration,
        user_prompt: segmentText,
        motion_graphic_prompt: motionPrompt,
        style_guidance: styleGuidance,
        assets,
        poll_attempts: 0,
        language: documentLanguage,
        tab,
        single_mg: false,
        codegen_model: resolvedCodegenModel,
        video_task_id: video_task_id ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    });

    await insertTasksInBatches(tasks, startTime, maxRuntime);

    await supabase
      .from('MG_tasks')
      .update({ status: 'queued', updated_at: new Date().toISOString() })
      .eq('id', tasks[0].id);

    // Integrated mode: mark MG render phase as started on the parent video_tasks row.
    if (video_task_id) {
      await supabase
        .from('video_tasks')
        .update({
          mg_status: 'processing',
          mg_progress: 0,
          total_individual_videos: totalPrompts,
          updated_at: new Date().toISOString(),
        })
        .eq('id', video_task_id);
    }

    fetch(`${supabaseUrl}/functions/v1/trigger-next-MG`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        group_id, user_id,
        current_batch_number: 0,
        tab, variant: finalVariant,
      }),
    }).catch(err => logError('Error triggering first MG batch', err));

    return new Response(JSON.stringify({
      task_ids: tasks.map(t => t.id),
      total_batches: totalBatches,
      total_prompts: totalPrompts,
      style_slug, composition_id, video_duration,
      variant: finalVariant,
      version: outputVersion,
      language: documentLanguage,
    }), { status: 200, headers: responseHeaders });
  } catch (error: any) {
    await logError('Error in setup-MG-tasks', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});
