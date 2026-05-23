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
    const { error: dbError } = await supabase
      .from('error_logs')
      .insert({
        message,
        details: error.message || JSON.stringify(error),
        created_at: new Date().toISOString(),
      });
    if (dbError) console.error('Failed to log error to database:', dbError);
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

interface SetupRequest {
  user_id: string;
  group_id: string;
  file_path: string;
  story_title: string;
  description: string;
  doc_id: string;
  variant: number;
  image_model: string;
  videoProcess?: boolean;
  language?: string; // Add language field
  tab?: number; // Add tab support
  itv?: boolean; // TRUE = ITV image task (keyframe for image-to-video)
}

interface Prompt {
  text: string;
  index: number;
}

function extractImagePrompts(content: string): Prompt[] {
  const prompts: Prompt[] = [];
  const startMarker = '[Image Prompt:';
  const endMarker = ']';
  let currentPos = 0;
  let index = 1;

  while (true) {
    const startIndex = content.indexOf(startMarker, currentPos);
    if (startIndex === -1) break;

    const endIndex = content.indexOf(endMarker, startIndex + startMarker.length);
    if (endIndex === -1) break;

    const promptText = content.slice(startIndex + startMarker.length, endIndex).trim();
    if (promptText.length > 0) {
      prompts.push({ text: promptText, index });
      index++;
    }

    currentPos = endIndex + endMarker.length;
  }

  return prompts;
}

async function insertTasksInBatches(tasks: any[], startTime: number, maxRuntime: number) {
  const BATCH_SIZE = 20;
  
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    if (Date.now() - startTime > maxRuntime * 0.9) {
      throw new Error(`Approaching runtime limit during batch insertion at batch ${Math.floor(i / BATCH_SIZE) + 1}`);
    }

    const batch = tasks.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('image_tasks').insert(batch);
   
    if (error) throw new Error(`Failed to insert batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`);
   
    console.log(`Successfully inserted batch ${Math.floor(i / BATCH_SIZE) + 1}`);
   
    if (i + BATCH_SIZE < tasks.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
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
    const { user_id, group_id, file_path, story_title, description, doc_id, variant, image_model, videoProcess, language, tab, itv } = requestData;
    const tabNumber = tab || 1;
    const itvMode = itv === true;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!user_id || !uuidRegex.test(user_id)) throw new Error('Missing or invalid user_id');
    if (!group_id || !uuidRegex.test(group_id)) throw new Error('Missing or invalid group_id');
    if (!doc_id || !uuidRegex.test(doc_id)) throw new Error('Missing or invalid doc_id');
    if (!file_path || typeof file_path !== 'string') throw new Error('Missing or invalid file_path');
    if (!story_title || typeof story_title !== 'string') throw new Error('Missing or invalid story_title');
    if (!description || typeof description !== 'string') throw new Error('Missing or invalid description');
    if (typeof variant !== 'number') throw new Error('Missing or invalid variant');
    if (!image_model || typeof image_model !== 'string') throw new Error('Missing or invalid image_model');

    // Validate image_model is one of the supported models
    const supportedModels = ['imagen-4-fast', 'gpt-image-1-mini', 'imagen-4-ultra', 'flux-2-dev', 'grok-imagine-image', 'seedream-4.5', 'nano-banana-pro'];
    if (!supportedModels.includes(image_model)) {
      throw new Error(`Invalid image_model. Must be one of: ${supportedModels.join(', ')}`);
    }

    // Validate and set language
    const supportedLanguages = ['english', 'german', 'spanish', 'french'];
    const validatedLanguage = supportedLanguages.includes(language || '') ? language : 'english';

    // Check for existing variants in image generation
    // Normal: versions 5/6  |  ITV: versions 18/19 (ITV image folder docs)
    const versionsToCheck = itvMode ? [18, 19] : [5, 6];
    
    // Query image_tasks for existing variants
    const { data: existingTasks, error: tasksError } = await supabase
      .from('image_tasks')
      .select('variant')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('tab', tabNumber)
      .in('version', versionsToCheck);
    
    if (tasksError) {
      console.warn(`Warning: Could not check existing image tasks: ${tasksError.message}`);
    }
    
    // Query story_documents for existing variants
    const { data: existingDocs, error: docsError } = await supabase
      .from('story_documents')
      .select('variant')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('tab', tabNumber)
      .in('version', versionsToCheck);
    
    if (docsError) {
      console.warn(`Warning: Could not check existing image documents: ${docsError.message}`);
    }
    
    // Collect all existing variants
    const existingVariants = new Set<number>();
    if (existingTasks && existingTasks.length > 0) {
      existingTasks.forEach(t => {
        if (t.variant !== null && t.variant !== undefined) {
          existingVariants.add(t.variant);
        }
      });
    }
    if (existingDocs && existingDocs.length > 0) {
      existingDocs.forEach(d => {
        if (d.variant !== null && d.variant !== undefined) {
          existingVariants.add(d.variant);
        }
      });
    }
    
    // Determine final variant: use requested variant if available, otherwise find next available
    let finalVariant = variant;
    if (existingVariants.has(variant)) {
      // Requested variant exists, find highest and increment
      const highestVariant = Math.max(...Array.from(existingVariants));
      finalVariant = highestVariant + 1;
    }
    
    console.log(`Image variant check: requested=${variant}, existing_variants=[${Array.from(existingVariants).sort().join(', ')}], using=${finalVariant}`);

    const { data: docData, error: docError } = await supabase
      .from('story_documents')
      .select('is_corrected, version, language')
      .eq('id', doc_id)
      .single();

    if (docError) throw new Error(`Failed to fetch document metadata: ${docError.message}`);

    const { is_corrected, version } = docData;
    const documentLanguage = docData.language || validatedLanguage; // Use document language or fallback
    // ITV image tasks produce the ITV image folder document (version 18 original / 19 corrected).
    // Normal image tasks use the standard version formula.
    const outputVersion = itvMode
      ? (is_corrected ? 19 : 18)
      : (version === 3 ? 5 : version === 4 ? 6 : version + 2);

    const { data: fileData, error: fileError } = await supabase
      .storage
      .from('stories')
      .download(file_path);

    if (fileError) throw new Error(`Failed to download document: ${fileError.message}`);

    const content = await fileData.text();
    if (!content || content.length === 0) throw new Error('Document content is empty');

    // ITV tasks: parse JSON [{text, image_prompt}] output from Phase 1 ITV prompt generation.
    // Normal tasks: extract [Image Prompt: ...] markers from document.
    let prompts: Array<Prompt & { originalText?: string }>;
    if (itvMode) {
      let parsed: Array<{ text: string; image_prompt: string }>;
      try {
        parsed = JSON.parse(content);
      } catch (_) {
        throw new Error('ITV image prompts file is not valid JSON');
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('No ITV image prompts found in JSON file');
      }
      prompts = parsed
        .filter(p => p && typeof p.image_prompt === 'string' && p.image_prompt.trim().length > 0)
        .map((p, i) => ({ text: p.image_prompt.trim(), index: i + 1, originalText: p.text }));
      if (prompts.length === 0) throw new Error('No valid ITV image prompts found in JSON file');
    } else {
      prompts = extractImagePrompts(content);
      if (prompts.length === 0) throw new Error('No image prompts found in the document');
    }

    const totalPrompts = prompts.length;
    const totalBatches = totalPrompts; // One prompt per batch
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    const tasks = prompts.map((prompt, i) => ({
      id: crypto.randomUUID(),
      user_id,
      group_id,
      doc_id,
      story_title,
      description,
      file_path,
      // For ITV tasks: text_part stores the original story segment text for Phase 2 reference.
      // For normal image tasks: text_part is unused by process-image, so keep it empty
      // to avoid massive payload sizes (full document × N prompts was causing insert timeouts).
      text_part: itvMode ? (prompt.originalText || prompt.text) : '',
      batch: [{ text: prompt.text, index: prompt.index }],
      batch_output: '',
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
      image_model,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      folder_timestamp: timestamp,
      video_process: videoProcess || false,
      language: documentLanguage,
      tab: tabNumber,
      itv: itvMode, // TRUE = ITV keyframe image task
    }));

    await insertTasksInBatches(tasks, startTime, maxRuntime);

    const firstTask = tasks.find(task => task.batch_number === 1);
    if (firstTask) {
      await supabase
        .from('image_tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString() })
        .eq('id', firstTask.id);

      await fetch(`${supabaseUrl}/functions/v1/trigger-next-image`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify({ group_id, user_id, current_batch_number: 0, tab: tabNumber, variant: finalVariant }),
      }).catch(error => {
        console.error(`Error triggering first batch: ${error.message}`);
        logError('Error triggering first batch', error);
      });
    }

    return new Response(
      JSON.stringify({
        task_ids: tasks.map(task => task.id),
        total_batches: totalBatches,
        total_prompts: totalPrompts,
        tokens: 0,
        language: documentLanguage, // Return language used
      }),
      { status: 200, headers: responseHeaders }
    );

  } catch (error: any) {
    await logError('Error in setup-image-tasks', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});


