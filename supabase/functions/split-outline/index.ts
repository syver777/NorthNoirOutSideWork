import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { OpenAI } from 'npm:openai@4';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SECRET_KEY') ?? '';
const DEEPSEEK_API_KEY = Deno.env.get('DEEPSEEK_API_KEY') ?? '';
const MAX_WORDS_PER_PART = 10000;
const MAX_DESCRIPTION_LENGTH = 5000;
const SUPABASE_TIMEOUT_MS = 100000;
const FETCH_TIMEOUT_MS = 100000;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !DEEPSEEK_API_KEY) {
  throw new Error('SUPABASE_URL, SECRET_KEY, or DEEPSEEK_API_KEY is not set');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const openai = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

async function logError(message: string, error: any, context: Record<string, any> = {}) {
  console.error(`${message}:`, error);
  try {
    const { error: dbError } = await supabase
      .from('error_logs')
      .insert({
        message,
        details: error.message || JSON.stringify(error),
        created_at: new Date().toISOString(),
        context: JSON.stringify(context),
      });
    if (dbError) console.error('Failed to log error to database:', dbError);
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

async function withSupabaseRetry<T>(operation: () => Promise<T>, retries: number = 3, baseDelay: number = 1000): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
      const result = await operation();
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      lastError = error;
      console.log(`Supabase attempt ${attempt} failed: ${error.message}`);
      if (attempt < retries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function withDeepSeekRetry<T>(operation: () => Promise<T>, retries: number = 5, delay: number = 15000): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      const status = error.status?.toString();
      const message = error.message || '';
      console.log(`DeepSeek attempt ${attempt} failed: ${message} (status: ${status})`);
      await logError(`DeepSeek attempt ${attempt} failed`, error, { attempt, status });
      if (['429', '500', '503'].includes(status) || message.toLowerCase().includes('overloaded')) {
        if (attempt < retries) {
          console.log(`Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
      throw error;
    }
  }
  throw lastError;
}

function validateInputs(data: any): string | null {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!data.title || typeof data.title !== 'string' || data.title.trim().length === 0) {
    return 'Missing or invalid title';
  }
  if (!data.description || typeof data.description !== 'string' || data.description.trim().length === 0) {
    return 'Missing or invalid description';
  }
  if (data.description.length > MAX_DESCRIPTION_LENGTH) {
    return `Description exceeds maximum length of ${MAX_DESCRIPTION_LENGTH} characters`;
  }
  if (typeof data.word_count !== 'number' || data.word_count < 200) {
    return `Word count must be at least 200. You entered: ${data.word_count}`;
  }
  if (!data.group_id || !uuidRegex.test(data.group_id)) {
    return 'Missing or invalid group_id';
  }
  if (!data.user_id) {
    return 'Missing or invalid user_id';
  }
  return null;
}

async function planPartDescriptions(
  title: string,
  originalDescription: string,
  totalParts: number,
  wordCount: number
): Promise<{ parts: { part_number: number; scope: string; word_count: number }[] }> {
  const baseWordCount = Math.floor(wordCount / totalParts);
  const remainder = wordCount % totalParts;
  const systemPrompt = `You are an expert narrative planner for a mythological epic. Given a story title, an original description, the number of parts, and total word count, plan the narrative scope for each part to ensure a cohesive story arc. The plan must:

- Divide the story into ${totalParts} parts, each with a distinct narrative focus, progressing logically from Hercules’ birth to his ascension:
  - Early parts cover birth, Hera’s wrath, youth, madness, and the Oracle’s decree (e.g., serpents in cradle, slaying tutor, family’s murder).
  - Middle parts cover the twelve labors, distributed evenly (e.g., for 3 parts, labors 1–8 in part 2, 9–12 in part 3; for 5 parts, ~2–3 labors per part).
  - Final part includes the poisoned robe, death, and ascension to Olympus.
- Ensure continuity: Each part builds on the previous, leading to a climactic end.
- Distribute word count: ${wordCount} across ${totalParts} parts (base: ${baseWordCount}, add 1 word to the first ${remainder} parts).
- Return a JSON object with a "parts" array, each entry containing:
  - part_number: 1 to ${totalParts}.
  - scope: Brief description of the part’s narrative focus (<100 words).
  - word_count: Calculated word count for the part.

Example for 3 parts:
{
  "parts": [
    {"part_number": 1, "scope": "Hercules’ birth under Hera’s wrath, youth, madness, and Oracle’s decree.", "word_count": 8334},
    {"part_number": 2, "scope": "Labors 1–8, from Nemean Lion to Mares of Diomedes, battling chaos.", "word_count": 8333},
    {"part_number": 3, "scope": "Labors 9–12, poisoned robe, death, and ascension to Olympus.", "word_count": 8333}
  ]
}

Return only the JSON object.`;

  const userPrompt = `Title: ${title}
Original Description: ${originalDescription}
Total Parts: ${totalParts}
Total Word Count: ${wordCount}

Plan the narrative scope for ${totalParts} parts.`;

  try {
    const response = await withDeepSeekRetry(() =>
      openai.chat.completions.create({
        model: 'deepseek',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2000,
        temperature: 0.5,
      })
    );
    const jsonOutput = response.choices[0]?.message?.content?.trim();
    if (!jsonOutput) {
      await logError('Empty DeepSeek planning response', new Error('No content returned'), {});
      throw new Error('No content in DeepSeek planning response');
    }

    let plan;
    try {
      plan = JSON.parse(jsonOutput);
      if (!plan.parts || !Array.isArray(plan.parts) || plan.parts.length !== totalParts) {
        throw new Error(`Expected ${totalParts} parts in plan, got ${plan.parts?.length}`);
      }
      for (let i = 0; i < totalParts; i++) {
        const part = plan.parts[i];
        if (part.part_number !== i + 1 || !part.scope || part.word_count !== baseWordCount + (i < remainder ? 1 : 0)) {
          throw new Error(`Invalid part ${i + 1} in plan`);
        }
      }
    } catch (error) {
      await logError('Failed to parse DeepSeek planning JSON', error, { jsonOutput: jsonOutput.slice(0, 200) });
      throw new Error(`Failed to parse DeepSeek planning response: ${error.message}`);
    }

    console.log(`DeepSeek planning successful:`, JSON.stringify(plan, null, 2));
    return plan;
  } catch (error: any) {
    await logError('Failed to plan part descriptions', error, { title, totalParts });
    // Fallback plan
    const parts = [];
    for (let part = 1; part <= totalParts; part++) {
      const partWordCount = baseWordCount + (part <= remainder ? 1 : 0);
      let scope;
      if (part === 1) {
        scope = "Hercules’ birth under Hera’s wrath, youth, madness, and Oracle’s decree.";
      } else if (part === totalParts) {
        scope = "Final labors, poisoned robe, death, and ascension to Olympus.";
      } else {
        scope = `Labors ${part * Math.floor(12 / totalParts) - Math.floor(12 / totalParts) + 1}–${part * Math.floor(12 / totalParts)}, battling chaos.`;
      }
      parts.push({
        part_number: part,
        scope,
        word_count: partWordCount,
      });
    }
    return { parts };
  }
}

async function generatePartDescription(
  title: string,
  originalDescription: string,
  partNumber: number,
  totalParts: number,
  scope: string,
  wordCount: number
): Promise<string> {
  const systemPrompt = `You are an expert narrative planner for a mythological epic. Given a story title, an original description, a part number, total parts, a narrative scope, and a word count, generate a custom description for the specified part. The description must:

- Focus on the narrative scope: ${scope}
- Align with the original description’s thunderous, poetic, prophetic tone, using high, reverent, eternal language, avoiding modern phrasing.
- Be concise (<500 words, max 5000 characters), distinct from the original description.
- Reflect the part’s role in the story arc (part ${partNumber} of ${totalParts}, ${wordCount} words).
- Use symbolism: blood, fire, stone, rivers, stars, serpents, divine ichor, wheel of fate.
- Be written as a standalone narrative summary, ready for direct insertion into a database’s description column.

Example for Part 1 of 3:
"I, Zeus, proclaim the genesis of Hercules, born of Alcmene’s mortal womb and my divine fire. Hera’s serpents assail his cradle, yet his infant hands crush their coils. Madness stains his youth, kin’s blood upon his hands, and the Oracle’s decree binds him to labors that shall defy fate’s wheel."

Return only the plain text description.`;

  const userPrompt = `Title: ${title}
Original Description: ${originalDescription}
Part Number: ${partNumber}
Total Parts: ${totalParts}
Scope: ${scope}
Word Count: ${wordCount}

Generate a custom description for part ${partNumber}.`;

  try {
    const response = await withDeepSeekRetry(() =>
      openai.chat.completions.create({
        model: 'deepseek',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 1000,
        temperature: 0.5,
      })
    );
    const description = response.choices[0]?.message?.content?.trim();
    if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
      await logError('Invalid DeepSeek description response', new Error('Empty or too long'), { partNumber, description: description?.slice(0, 200) });
      throw new Error('Invalid description from DeepSeek');
    }
    console.log(`DeepSeek description for part ${partNumber}:`, description);
    return description;
  } catch (error: any) {
    await logError('Failed to generate description', error, { title, partNumber });
    return `Placeholder for part ${partNumber}: Narrative segment focusing on ${scope.toLowerCase()}.`;
  }
}

async function createPartTasks(
  title: string,
  originalDescription: string,
  wordCount: number,
  groupId: string,
  userId: string
): Promise<{ tasks: any[], totalParts: number }> {
  const startTime = Date.now();
  console.log(`Creating part tasks for ${groupId}`);

  // Check for existing tasks to prevent duplicates
  const { data: existingTasks, error: fetchError } = await withSupabaseRetry(() =>
    supabase
      .from('story_tasks')
      .select('id')
      .eq('group_id', groupId)
  );
  if (fetchError) {
    await logError('Failed to check existing tasks', fetchError, { groupId });
    throw new Error(`Failed to check existing tasks: ${fetchError.message}`);
  }
  if (existingTasks && existingTasks.length > 0) {
    throw new Error(`Tasks already exist for group ${groupId}`);
  }

  const totalParts = Math.ceil(wordCount / MAX_WORDS_PER_PART);
  const plan = await planPartDescriptions(title, originalDescription, totalParts, wordCount);

  const tasks = [];
  for (const part of plan.parts) {
    const description = await generatePartDescription(
      title,
      originalDescription,
      part.part_number,
      totalParts,
      part.scope,
      part.word_count
    );
    tasks.push({
      id: crypto.randomUUID(),
      user_id: userId,
      group_id: groupId,
      story_title: title,
      description,
      total_word_count: part.word_count,
      part_number: part.part_number,
      total_parts: totalParts,
      batch: JSON.stringify([]),
      previous_content: '',
      outline: '',
      status: 'queued',
      batch_number: 0,
      progress: 0,
      total_batches: 0,
      is_corrected: false,
      stop_requested: false,
      input_tokens: 0,
      output_tokens: 0,
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      feedback: '',
      doc_id: null,
      file_path: null,
      settings: null,
      variant: null,
      error: null,
    });
  }
  tasks.push({
    id: crypto.randomUUID(),
    user_id: userId,
    group_id: groupId,
    story_title: title,
    description: originalDescription,
    total_word_count: 0,
    part_number: null,
    total_parts: null,
    batch: JSON.stringify([]),
    previous_content: '',
    outline: '',
    status: 'queued',
    batch_number: 0,
    progress: 0,
    total_batches: 0,
    is_corrected: false,
    stop_requested: false,
    input_tokens: 0,
    output_tokens: 0,
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    feedback: '',
    doc_id: null,
    file_path: null,
    settings: null,
    variant: null,
    error: null,
  });

  // Insert all tasks
  for (const task of tasks) {
    try {
      await withSupabaseRetry(async () => {
        const { error } = await supabase.from('story_tasks').insert(task);
        if (error) throw error;
        console.log(`Inserted task ${task.id} for ${task.part_number ? `part ${task.part_number}` : 'final task'}`);
        return true;
      });
    } catch (error: any) {
      await logError('Failed to insert task', error, { taskId: task.id, groupId, partNumber: task.part_number });
      throw new Error(`Failed to insert task ${task.id}: ${error.message}`);
    }
  }

  console.log(`Created ${tasks.length} tasks in ${Date.now() - startTime}ms`);
  return { tasks, totalParts };
}

async function triggerGenerateOutline(
  task: any,
  title: string,
  description: string,
  wordCount: number,
  groupId: string,
  userId: string,
  partNumber: number,
  totalParts: number
): Promise<void> {
  const startTime = Date.now();
  console.log(`Queueing generate-outline for part ${partNumber}, task ${task.id}`);
  const payload = {
    title,
    description,
    word_count: wordCount,
    group_id: groupId,
    user_id: userId,
    part_number: partNumber,
    total_parts: totalParts,
    task_id: task.id,
    last_chapter_number: 0, // Simplified for this example
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    fetch(`${SUPABASE_URL}/functions/v1/generate-outline`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).then(async (response) => {
      clearTimeout(timeoutId);
      if (!response.ok) {
        const errorText = await response.text();
        await logError('Generate-outline request failed', new Error(`HTTP ${response.status}: ${errorText}`), {
          taskId: task.id,
          groupId,
          partNumber,
        });
      } else {
        console.log(`Generate-outline queued for part ${partNumber}, task ${task.id} in ${Date.now() - startTime}ms`);
      }
    }).catch(async (error) => {
      clearTimeout(timeoutId);
      await logError('Generate-outline request timeout or error', error, { taskId: task.id, groupId, partNumber });
    });
  } catch (error: any) {
    await logError('Failed to initiate generate-outline', error, { taskId: task.id, groupId, partNumber });
  }
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const startTime = Date.now();
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let payload;
  try {
    payload = await req.json();
    console.log('Received payload:', { ...payload, description: payload.description?.slice(0, 100) + '...' });
  } catch (error: any) {
    await logError('Invalid JSON payload', error);
    return new Response(
      JSON.stringify({ error: 'Invalid JSON payload', code: 400 }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed', code: 405 }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const validationError = validateInputs(payload);
    if (validationError) {
      await logError('Validation error', new Error(validationError), { payload });
      return new Response(
        JSON.stringify({ error: validationError, code: 400 }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized', code: 401 }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    if (!auth.isServiceRole && auth.userId) {
      payload.user_id = auth.userId;
    }

    const { title, description, word_count, group_id, user_id } = payload;
    const { tasks, totalParts } = await createPartTasks(title, description, word_count, group_id, user_id);

    const firstTask = tasks.find(t => t.part_number === 1);
    if (!firstTask) {
      await logError('No task created for part 1', new Error('First task not found'), { group_id });
      throw new Error('No task created for part 1');
    }

    await triggerGenerateOutline(
      firstTask,
      title,
      firstTask.description,
      firstTask.total_word_count,
      group_id,
      user_id,
      firstTask.part_number,
      totalParts
    );

    console.log(`Returning response after ${Date.now() - startTime}ms`);
    return new Response(
      JSON.stringify({
        message: 'Outline generation queued for first part',
        task_ids: tasks.map(t => t.id),
        total_parts: totalParts,
        group_id,
      }),
      { status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    await logError('Error in split-outline', error, { payload: { ...payload, description: payload?.description?.slice(0, 100) + '...' } });
    const status = error.message.includes('rate limit') || error.status === 429 ? 429 : 500;
    const errorMessage = status === 429 ? 'Rate limit exceeded. Please try again later.' : error.message || 'Internal server error';
    return new Response(
      JSON.stringify({ error: errorMessage, code: status }),
      { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});


