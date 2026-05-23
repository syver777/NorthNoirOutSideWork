import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.75.1';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { DEFAULT_ELEVENLABS_MODEL_ID, elevenLabsTokensPerChar } from '../_shared/elevenlabs.ts';

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
  voice: string;
  language: string;
  model_version: 'v7' | 'lemonfox' | 'speechify' | 'clone' | 'elevenlabs';
  speed: number;
  preference: 'merged' | 'separate';
  remove_title_chapters: boolean;
  volume?: number;
  videoProcess?: boolean;
  single_audio?: boolean;
  clone_voice_name?: string;
  clone_voice_url?: string;
  clone_language?: string;
  tab?: number;
  pauses?: boolean;
  /** Required when model_version === 'elevenlabs'. */
  elevenlabs_model_id?: string;
}

function cleanText(text: string): string {
  text = text.replace(/\*/g, '');
  const lines = text.split('\n');
  const chapterPattern = /^Chapter \d+.*$/i;
  let firstChapterIdx: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (chapterPattern.test(lines[i].trim())) {
      firstChapterIdx = i;
      break;
    }
  }

  if (firstChapterIdx !== null) {
    lines.splice(0, firstChapterIdx);
  }

  const filteredLines = lines
    .filter(line => !chapterPattern.test(line.trim()) && line.trim().length > 0)
    .map(line => line.trim());

  return filteredLines.join(' ');
}

function calculateWordCount(content: string): number {
  return content.trim().split(/\s+/).filter(word => word.length > 0).length;
}

function splitText(content: string, model_version: 'v7' | 'lemonfox' | 'speechify' | 'clone' | 'elevenlabs'): string[] {
  if (model_version === 'lemonfox' || model_version === 'elevenlabs') {
    // Lemonfox / ElevenLabs: split by max 5000 characters to prevent memory issues
    const maxChars = 5000;
    const parts: string[] = [];
    let start = 0;

    while (start < content.length) {
      let end = Math.min(start + maxChars, content.length);
      if (end < content.length) {
        const spacePos = content.lastIndexOf(' ', end);
        if (spacePos > start) {
          end = spacePos + 1;
        }
      }
      parts.push(content.slice(start, end));
      start = end;
    }

    // Post-processing to handle small last part
    const minChars = 40;
    const redistCount = 3;

    if (parts.length > 1) {
      let lastPart = parts[parts.length - 1];
      if (lastPart.length < minChars) {
        const k = Math.min(redistCount, parts.length);
        const lastK = parts.splice(-k, k);
        const allText = lastK.join('');
        const totalChars = allText.length;
        const partSize = Math.floor(totalChars / k);
        const remainder = totalChars % k;

        let idx = 0;
        for (let j = 0; j < k; j++) {
          const size = partSize + (j < remainder ? 1 : 0);
          const pText = allText.slice(idx, idx + size);
          parts.push(pText);
          idx += size;
        }
      }
    }

    return parts;
  } else if (model_version === 'speechify') {
    // Speechify: split by max 1800 characters (reduced from 2000 for safety)
    const maxChars = 1800;
    const parts: string[] = [];
    let start = 0;

    while (start < content.length) {
      let end = Math.min(start + maxChars, content.length);
      if (end < content.length) {
        const spacePos = content.lastIndexOf(' ', end);
        if (spacePos > start) {
          end = spacePos + 1;
        }
      }
      parts.push(content.slice(start, end));
      start = end;
    }

    // Post-processing to handle small last part
    const minChars = 40;
    const redistCount = 3;

    if (parts.length > 1) {
      let lastPart = parts[parts.length - 1];
      if (lastPart.length < minChars) {
        const k = Math.min(redistCount, parts.length);
        const lastK = parts.splice(-k, k);
        const allText = lastK.join('');
        const totalChars = allText.length;
        const partSize = Math.floor(totalChars / k);
        const remainder = totalChars % k;

        let idx = 0;
        for (let j = 0; j < k; j++) {
          const size = partSize + (j < remainder ? 1 : 0);
          const pText = allText.slice(idx, idx + size);
          parts.push(pText);
          idx += size;
        }
      }
    }

    return parts;
  } else { // v7 or clone: split by max 1800 characters for Inworld (reduced from 2000 for safety)
    const maxChars = 1800;
    const parts: string[] = [];
    let start = 0;

    while (start < content.length) {
      let end = Math.min(start + maxChars, content.length);
      if (end < content.length) {
        const spacePos = content.lastIndexOf(' ', end);
        if (spacePos > start) {
          end = spacePos + 1;
        }
      }
      parts.push(content.slice(start, end));
      start = end;
    }

    // Post-processing to handle small last part
    const minChars = 40;
    const redistCount = 3;

    if (parts.length > 1) {
      let lastPart = parts[parts.length - 1];
      if (lastPart.length < minChars) {
        const k = Math.min(redistCount, parts.length);
        const lastK = parts.splice(-k, k);
        const allText = lastK.join('');
        const totalChars = allText.length;
        const partSize = Math.floor(totalChars / k);
        const remainder = totalChars % k;

        let idx = 0;
        for (let j = 0; j < k; j++) {
          const size = partSize + (j < remainder ? 1 : 0);
          const pText = allText.slice(idx, idx + size);
          parts.push(pText);
          idx += size;
        }
      }
    }

    return parts;
  }
}

async function insertTasksInBatches(tasks: any[], startTime: number, maxRuntime: number) {
  const BATCH_SIZE = 20;
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    if (Date.now() - startTime > maxRuntime * 0.9) {
      throw new Error(`Approaching runtime limit during batch insertion at batch ${Math.floor(i / BATCH_SIZE) + 1}`);
    }

    const batch = tasks.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('audio_tasks').insert(batch);
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
    const {
      user_id, group_id, file_path, story_title, description, doc_id, variant,
      voice, language, model_version, speed, preference, remove_title_chapters,
      volume = 1.0, videoProcess, single_audio = false, clone_voice_name, clone_voice_url, clone_language,
      tab = 1, pauses = false, elevenlabs_model_id,
    } = requestData;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!user_id || !uuidRegex.test(user_id)) throw new Error('Missing or invalid user_id');
    if (!group_id || !uuidRegex.test(group_id)) throw new Error('Missing or invalid group_id');
    if (!doc_id || !uuidRegex.test(doc_id)) throw new Error('Missing or invalid doc_id');
    if (!file_path || typeof file_path !== 'string') throw new Error('Missing or invalid file_path');
    if (!story_title || typeof story_title !== 'string') throw new Error('Missing or invalid story_title');
    if (!description || typeof description !== 'string') throw new Error('Missing or invalid description');
    if (typeof variant !== 'number') throw new Error('Missing or invalid variant');
    if (!voice || typeof voice !== 'string') throw new Error('Missing or invalid voice');
    if (!language || typeof language !== 'string') throw new Error('Missing or invalid language');
    if (!['v7', 'lemonfox', 'speechify', 'clone', 'elevenlabs'].includes(model_version)) throw new Error('Invalid model_version');
    if (typeof speed !== 'number' || speed < 0.5 || (model_version === 'lemonfox' ? speed > 4.0 : model_version === 'speechify' ? speed > 2.0 : speed > 2.0)) throw new Error('Invalid speed');
    if (!['merged', 'separate'].includes(preference)) throw new Error('Invalid preference');
    if (typeof remove_title_chapters !== 'boolean') throw new Error('Missing or invalid remove_title_chapters');
    if (typeof volume !== 'number' || volume < 1.0 || volume > 8.0) throw new Error('Invalid volume range (1.0-8.0)');

    // Validate clone voice fields if model_version is 'clone'
    if (model_version === 'clone') {
      if (!clone_voice_name || typeof clone_voice_name !== 'string') throw new Error('Missing or invalid clone_voice_name for clone model');
      if (!clone_voice_url || typeof clone_voice_url !== 'string') throw new Error('Missing or invalid clone_voice_url for clone model');
      if (!clone_language || typeof clone_language !== 'string') throw new Error('Missing or invalid clone_language for clone model');
    }

    // Check audio_tasks for existing variants BEFORE deletion
    // (this determines what variant number to use for the new generation)
    const { data: existingTasksForVariant, error: tasksError } = await supabase
      .from('audio_tasks')
      .select('variant')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('tab', tab);
    
    if (tasksError) {
      console.warn(`Warning: Could not check existing audio tasks: ${tasksError.message}`);
    }
    
    // Collect all existing variants from audio_tasks only
    const existingVariants = new Set<number>();
    if (existingTasksForVariant && existingTasksForVariant.length > 0) {
      existingTasksForVariant.forEach(t => {
        if (t.variant !== null && t.variant !== undefined) {
          existingVariants.add(t.variant);
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
    
    console.log(`Audio variant check: requested=${variant}, existing_variants=[${Array.from(existingVariants).sort().join(', ')}], using=${finalVariant}`);

    // Check if tasks already exist and are in progress to prevent duplicates for this specific variant
    const { data: existingTasks } = await supabase
      .from('audio_tasks')
      .select('id, status')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('variant', finalVariant)
      .eq('tab', tab);

    if (existingTasks && existingTasks.length > 0) {
      const hasActiveTasks = existingTasks.some(task => 
        task.status === 'running' || task.status === 'queued'
      );
      
      if (hasActiveTasks) {
        console.log(`Audio tasks already exist and are in progress for group ${group_id}`);
        return new Response(
          JSON.stringify({ 
            error: 'Audio tasks already exist and are in progress for this group',
            existing_tasks: existingTasks.length,
            code: 409
          }),
          { status: 409, headers: responseHeaders }
        );
      }
    }

    const { data: docData, error: docError } = await supabase
      .from('story_documents')
      .select('is_corrected, version')
      .eq('id', doc_id)
      .single();

    if (docError) throw new Error(`Failed to fetch document metadata: ${docError.message}`);

    const { is_corrected, version } = docData;

    const { data: fileData, error: fileError } = await supabase
      .storage
      .from('stories')
      .download(file_path);

    if (fileError) throw new Error(`Failed to download document: ${fileError.message}`);

    let content = await fileData.text();
    if (!content || content.length === 0) throw new Error('Document content is empty');

    if (remove_title_chapters) {
      content = cleanText(content);
    }

    // Predefined clone voices list (matching frontend)
    const predefinedCloneVoices = [
      { name: "Declan", voice_id: "default-ujsa1wysgyitfqg3ixpqka__declan" },
      { name: "Adrian", voice_id: "default-ujsa1wysgyitfqg3ixpqka__adrian" },
      { name: "Alfred", voice_id: "default-ujsa1wysgyitfqg3ixpqka__alfred" },
      { name: "Conrad", voice_id: "default-ujsa1wysgyitfqg3ixpqka__conrad" },
      { name: "Hugo", voice_id: "default-ujsa1wysgyitfqg3ixpqka__hugo" },
      { name: "Ryder", voice_id: "default-ujsa1wysgyitfqg3ixpqka__ryder" },
      { name: "Victor", voice_id: "default-ujsa1wysgyitfqg3ixpqka__victor" }
    ];

    // Determine actual model version and voice ID
    let actualModelVersion = model_version;
    let actualVoiceId = voice;

    // Check if this is a predefined clone voice
    const predefinedVoice = predefinedCloneVoices.find(v => v.name === voice);
    if (predefinedVoice) {
      // Treat predefined clone voices as premium voices (v7) with workspace endpoint
      actualModelVersion = 'v7';
      actualVoiceId = predefinedVoice.voice_id;
      console.log(`Using predefined clone voice: ${voice} -> ${actualVoiceId} (model: v7)`);
    } else if (model_version === 'clone') {
      // This is a custom clone voice - treat as v7 and use provided clone_voice_url
      actualModelVersion = 'v7';
      actualVoiceId = clone_voice_url || voice;
      console.log(`Using custom clone voice: ${voice} -> ${actualVoiceId} (model: v7)`);
    } else if (model_version === 'v7') {
      // Regular v7 voice - use voice name as-is (no workspace prefix)
      actualVoiceId = voice;
      console.log(`Using regular v7 voice: ${voice}`);
    }

    const parts = splitText(content, actualModelVersion);
    if (parts.length === 0) throw new Error('No text parts found in the document');

    const totalBatches = parts.length;
    // Generate timestamp once for all tasks in this group
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // Calculate total tokens for the entire content (base tokens only, volume boost tokens calculated in compile-audio)
    let costPerChar: number;
    if (actualModelVersion === 'elevenlabs') {
      costPerChar = elevenLabsTokensPerChar(elevenlabs_model_id);
    } else if (actualModelVersion === 'v7' || actualModelVersion === 'clone') {
      costPerChar = 4; // Premium and clone voices: 4 tokens per character
    } else if (actualModelVersion === 'lemonfox') {
      costPerChar = 2; // Core voices: 2 tokens per character
    } else if (actualModelVersion === 'speechify') {
      costPerChar = 8; // Apex voices: 8 tokens per character
    } else {
      costPerChar = 2; // Core voices: 2 tokens per character
    }

    const baseTokens = content.length * costPerChar;
    const totalTokens = baseTokens; // No volume tokens here, will be added in compile-audio

    const tasks = parts.map((part, i) => ({
      id: crypto.randomUUID(),
      user_id,
      group_id,
      doc_id,
      story_title,
      description,
      file_path,
      text_part: part,
      batch_output: '',
      total_batches: totalBatches,
      batch_number: i + 1,
      total_prompts: totalBatches,
      progress: 0,
      status: i === 0 ? 'queued' : 'pending',
      error: null,
      settings: {
        voice: actualVoiceId,
        language,
        speed,
        preference,
        volume,
        ...(actualModelVersion === 'elevenlabs'
          ? { elevenlabs_model_id: elevenlabs_model_id || DEFAULT_ELEVENLABS_MODEL_ID }
          : {}),
      },
      model_version: actualModelVersion, // Use actual model version
      voice: actualVoiceId, // Use actual voice ID
      language,
      speed,
      preference,
      volume,
      variant: finalVariant,
      is_corrected,
      tokens: Math.ceil(baseTokens / parts.length), // Base tokens only
      version,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      folder_timestamp: timestamp, // Use the same timestamp for ALL tasks
      single_audio, // Set the single_audio flag
      remove_title_chapters,
      video_process: videoProcess || false,
      tab, // Add tab number
      // Only set clone voice fields for custom clone voices
      clone_voice_name: (model_version === 'clone' && !predefinedVoice) ? clone_voice_name : null,
      clone_voice_url: (model_version === 'clone' && !predefinedVoice) ? actualVoiceId : null,
      clone_language: (model_version === 'clone' && !predefinedVoice) ? clone_language : null,
      pauses: pauses || false,
    }));

    await insertTasksInBatches(tasks, startTime, maxRuntime);

    const firstTask = tasks.find(task => task.batch_number === 1);
    if (firstTask) {
      await supabase
        .from('audio_tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString() })
        .eq('id', firstTask.id);

      await fetch(`${supabaseUrl}/functions/v1/trigger-next-audio`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify({ group_id, user_id, current_batch_number: 0, tab, variant: finalVariant }),
      }).catch(error => {
        console.error(`Error triggering first batch: ${error.message}`);
        logError('Error triggering first batch', error);
      });
    }

    return new Response(
      JSON.stringify({
        task_ids: tasks.map(task => task.id),
        total_batches: totalBatches,
        total_prompts: totalBatches,
        tokens: totalTokens,
        group_id,
      }),
      { status: 200, headers: responseHeaders }
    );

  } catch (error: any) {
    await logError('Error in setup-audio-tasks', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});


