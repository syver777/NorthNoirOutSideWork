import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { OpenAI } from 'npm:openai@4';
import { crypto } from 'https://deno.land/std@0.214.0/crypto/mod.ts';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SECRET_KEY') ?? '';
const DEEPSEEK_API_KEY = Deno.env.get('DEEPSEEK_API_KEY') ?? '';
const MAX_WORDS_PER_BATCH = 400;
const MIN_WORDS_PER_BATCH = 100;
const MAX_DESCRIPTION_LENGTH = 5000;
const SUPABASE_TIMEOUT_MS = 120000;
const FETCH_TIMEOUT_MS = 600000;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !DEEPSEEK_API_KEY) {
  throw new Error('Missing environment variables: SUPABASE_URL, SECRET_KEY, or DEEPSEEK_API_KEY');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const openai = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

async function logError(message: string, error: any, context: Record<string, any> = {}) {
  console.error(`${message}:`, error);
  try {
    const details = typeof error === 'string' ? error : error?.message || JSON.stringify(error).slice(0, 1000);
    const contextStr = JSON.stringify(context).slice(0, 1000);
    const { error: dbError } = await supabase
      .from('error_logs')
      .insert({
        message,
        details,
        created_at: new Date().toISOString(),
        context: contextStr,
      });
    if (dbError) console.error('Failed to log error to database:', dbError);
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

async function withSupabaseRetry<T>(operation: () => Promise<T>, retries: number = 5, baseDelay: number = 1000): Promise<T> {
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

async function withDeepSeekRetry<T>(operation: () => Promise<T>, retries: number = 5, delay: number = 10000): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);
      const result = await Promise.race([
        operation(),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Operation timed out'))))
      ]);
      clearTimeout(timeoutId);
      return result as T;
    } catch (error: any) {
      lastError = error;
      const status = error.status?.toString();
      const message = error.message || 'Unknown error';
      if (['429', '500', '503'].includes(status) || message.includes('overloaded') || message.includes('timed out') || message.includes('network')) {
        if (attempt < retries) {
          console.log(`DeepSeek retry attempt ${attempt} failed: ${message}. Retrying in ${delay}ms...`);
          await logError(`DeepSeek retry attempt ${attempt} failed`, error, { attempt });
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
  if (typeof data.word_count !== 'number' || data.word_count < 200 || data.word_count > 40000) {
    return `Word count must be between 200 and 40000. You entered: ${data.word_count}`;
  }
  if (!data.group_id || !uuidRegex.test(data.group_id)) {
    return 'Missing or invalid group_id';
  }
  if (!data.user_id || !uuidRegex.test(data.user_id)) {
    return 'Missing or invalid user_id';
  }
  if (data.task_id && !uuidRegex.test(data.task_id)) {
    return 'Invalid task_id format';
  }
  return null;
}

function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(word => word.length > 0).length;
  return Math.ceil(words * 1.33);
}

async function createTask(
  title: string,
  description: string,
  wordCount: number,
  groupId: string,
  userId: string,
  taskId: string
): Promise<void> {
  const task = {
    id: taskId,
    user_id: userId,
    group_id: groupId,
    batch: JSON.stringify([]),
    previous_content: '',
    total_word_count: wordCount,
    batch_number: 0,
    progress: null,
    status: 'queued',
    outline: '',
    description,
    story_title: title,
    total_batches: 0, // Defer to process-outline
    is_corrected: false,
    stop_requested: false,
    input_tokens: 0,
    output_tokens: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    feedback: '',
    error: '',
    settings: null,
    variant: null,
    file_path: null,
    doc_id: null,
  };

  try {
    await withSupabaseRetry(async () => {
      const { error } = await supabase.from('story_tasks').insert(task);
      if (error) throw error;
      console.log(`Inserted task ${taskId}`);
    });
  } catch (error: any) {
    await logError('Failed to insert task', error, { taskId, groupId });
    throw new Error(`Failed to insert task ${taskId}: ${error.message}`);
  }
}

async function generateInitialOutline(
  title: string,
  description: string,
  wordCount: number,
  taskId: string
): Promise<{ outlineText: string, inputTokens: number, outputTokens: number }> {
  await logError('Starting initial outline generation', { message: 'Initiating DeepSeek API call' }, { taskId, wordCount });
  const targetBatches = Math.ceil(wordCount / MAX_WORDS_PER_BATCH) + 1; // 11 for 4000 words
  const targetWordCount = targetBatches * MAX_WORDS_PER_BATCH; // 4400 for 11 batches
  let systemPrompt = '';

  if (wordCount < 3000) {
    const minChapters = 2;
    systemPrompt = `You are an expert story planner. Create a detailed outline for a short story with the given title, description, and total word count (under 3000 words). Follow these steps:

1. Divide the story into at least ${minChapters} chapters or chapter parts. Each chapter or part must have a unique, descriptive title, a target word count of exactly 400 words, and a detailed summary including specific plot points, character moments, and thematic elements. Ensure the structure is simple and natural for a shorter story.
2. The total word count for all chapters MUST sum to EXACTLY ${wordCount} words. This is critical and non-negotiable.
3. If a chapter’s word count exceeds ${MAX_WORDS_PER_BATCH} words, split it into parts (e.g., a 1000-word chapter into three parts: 400, 400, 200). Each part must be listed as a separate chapter with its own index (e.g., '4. Chapter Title (Part 1)', '5. Chapter Title (Part 2)') and have a word count of exactly 400 words.
4. Assign each chapter or chapter part to its own batch, ensuring exactly ${targetBatches} batches. Each batch MUST contain exactly one chapter or part of 400 words. The total words across batches MUST equal ${wordCount}.
5. Format the outline strictly as follows, with no extra formatting, bolding, Markdown symbols (e.g., ** or *), or additional commentary, notes, or placeholders beyond the chapters and batch plan:

1. Chapter Title - 400 words: Summary
2. Chapter Title (Part 1) - 400 words: Summary
3. Chapter Title (Part 2) - 400 words: Summary
(etc.)

Batch Plan:
- Batch 1: Chapters [1], Total Words: 400
- Batch 2: Chapters [2 Part 1], Total Words: 400
- Batch 3: Chapters [3 Part 2], Total Words: 400
(etc.)

Ensure the batch plan assigns each chapter or part to exactly one batch, with exactly ${targetBatches} batches, each exactly 400 words, and the total words across batches EXACTLY equals ${wordCount}. Each chapter or part must be referenced correctly (e.g., "2 Part 1"). Do not include notes, alternative plans, placeholders, or any text beyond the required format.`;
  } else {
    systemPrompt = `You are an expert story planner. Create a detailed outline for a novel with the given title, description, and total word count. The critical requirement is to produce EXACTLY ${targetBatches} batches, each containing EXACTLY ONE chapter or chapter part with a word count of 400 words, summing to EXACTLY ${targetWordCount} words. Follow these steps:

1. Plan a cohesive story arc covering EXACTLY ${targetWordCount} words, with a clear beginning, middle, and end. Divide the story into EXACTLY ${targetBatches} chapters or chapter parts, each with a unique, descriptive title and a detailed summary including specific plot points, character moments, and thematic elements.
2. Assign each chapter or part a word count of EXACTLY 400 words. If a chapter exceeds ${MAX_WORDS_PER_BATCH} words, split it into parts (e.g., a 1200-word chapter into three 400-word parts). Each part must be listed as a separate chapter with its own index (e.g., '4. Chapter Title (Part 1)', '5. Chapter Title (Part 2)').
3. In the outline, list ONLY the ${targetBatches} chapters or chapter parts, each exactly 400 words. The total word count of all listed chapters/parts MUST sum to EXACTLY ${targetWordCount} words.
4. Assign each chapter or part to its own batch, ensuring EXACTLY ${targetBatches} batches. Each batch MUST contain EXACTLY ONE chapter or part of 400 words. The total word count across batches MUST equal ${targetWordCount}.
5. Format the outline exactly as follows, with no extra formatting, bolding, Markdown symbols, or commentary. List only the ${targetBatches} chapters or chapter parts with their word counts and summaries:

1. Chapter Title - 400 words: Summary
2. Chapter Title (Part 1) - 400 words: Summary
3. Chapter Title (Part 2) - 400 words: Summary
(etc.)

Batch Plan:
- Batch 1: Chapters [1], Total Words: 400
- Batch 2: Chapters [2 Part 1], Total Words: 400
- Batch 3: Chapters [3 Part 2], Total Words: 400
(etc.)

Ensure the batch plan assigns each of the ${targetBatches} chapters or parts to EXACTLY ONE batch, each exactly 400 words, and the total words across batches EXACTLY equals ${targetWordCount}. Each chapter or part must be referenced correctly (e.g., "2 Part 1"). Do not include notes, alternative plans, placeholders, or any text beyond the required format.`;
  }

  const userPrompt = `Create an outline for:\nTitle: ${title}\nDescription: ${description}\nTotal Words: ${wordCount}. Produce EXACTLY ${targetBatches} parts, each 400 words, summing to ${targetWordCount} words.`;

  try {
    const response = await withDeepSeekRetry(() =>
      openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 8100,
        temperature: 0.8,
      })
    );
    const outlineText = response.choices[0]?.message?.content;
    if (!outlineText) throw new Error('No content in DeepSeek response');
    const inputTokens = response.usage?.prompt_tokens || estimateTokens(systemPrompt + userPrompt);
    const outputTokens = response.usage?.completion_tokens || estimateTokens(outlineText);

    await logError('Initial outline generated successfully', { message: 'DeepSeek response received' }, { taskId });
    return { outlineText, inputTokens, outputTokens };
  } catch (error: any) {
    await logError('Initial outline generation failed', error, { taskId });
    throw error;
  }
}

async function scheduleProcessOutline(
  outline: string,
  groupId: string,
  userId: string,
  taskId: string,
  wordCount: number
): Promise<void> {
  await logError('Starting process-outline scheduling', { message: 'Verifying task before fetch' }, { taskId });

  let taskFound = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const { data: tasks, error: taskError } = await withSupabaseRetry(() =>
        supabase
          .from('story_tasks')
          .select('status')
          .eq('id', taskId)
          .eq('status', 'outlined')
      );
      if (taskError) {
        await logError(`Task verification attempt ${attempt} failed`, taskError, { taskId });
        throw new Error(`Task verification failed: ${taskError.message}`);
      }
      if (tasks && tasks.length > 0) {
        taskFound = true;
        if (tasks.length > 1) {
          await logError('Multiple tasks found', { message: `Found ${tasks.length} tasks for task_id ${taskId}` }, { taskId });
          const duplicateIds = tasks.slice(1).map(t => t.id);
          await withSupabaseRetry(async () => {
            const { error } = await supabase
              .from('story_tasks')
              .update({ status: 'failed', error: 'Duplicate task detected', updated_at: new Date().toISOString() })
              .in('id', duplicateIds);
            if (error) await logError('Failed to mark duplicate tasks as failed', error, { taskId });
          });
        }
        break;
      }
      await logError(`Task not found on attempt ${attempt}`, { message: 'Task not in outlined state' }, { taskId });
      if (attempt < 5) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (error: any) {
      await logError(`Task verification attempt ${attempt} error`, error, { taskId });
      if (attempt === 5) throw error;
    }
  }

  if (!taskFound) {
    await logError('No task found after retries', { message: 'Aborting scheduling' }, { taskId });
    throw new Error('No task found in outlined state for task_id after retries');
  }

  await new Promise(resolve => setTimeout(resolve, 2000));

  const payload = {
    outline,
    group_id: groupId,
    user_id: userId,
    task_id: taskId,
    word_count: wordCount,
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    fetch(`${SUPABASE_URL}/functions/v1/process-outline`, {
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
        await logError('Process-outline request failed', new Error(`HTTP ${response.status}: ${errorText}`), { taskId, groupId });
      } else {
        console.log(`Process-outline queued for task ${taskId}`);
      }
    }).catch(async (error) => {
      clearTimeout(timeoutId);
      await logError('Process-outline request timeout or error', error, { taskId, groupId });
    });
  } catch (error: any) {
    await logError('Failed to initiate process-outline', error, { taskId, groupId });
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
    await logError('Received generate-outline payload', { message: 'Payload processing started' }, { description: payload.description?.slice(0, 100) + '...' });
  } catch (error: any) {
    await logError('Invalid JSON payload', error);
    return new Response(
      JSON.stringify({ error: 'Invalid JSON payload', code: 400 }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let task_id: string | undefined;
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
    task_id = payload.task_id || crypto.randomUUID();
    const wordCount = parseInt(word_count.toString(), 10);

    await logError('Checking for existing tasks', { message: 'Querying story_tasks' }, { group_id });
    const { data: existingTasks, error: fetchError } = await withSupabaseRetry(() =>
      supabase.from('story_tasks').select('id').eq('group_id', group_id)
    );
    if (fetchError) {
      await logError('Failed to check existing tasks', fetchError, { group_id });
      throw new Error(`Failed to check existing tasks: ${fetchError.message}`);
    }
    if (existingTasks && existingTasks.length > 0) {
      throw new Error(`Tasks already exist for group ${group_id}`);
    }

    await logError('Creating task', { message: 'Inserting into story_tasks' }, { task_id, group_id });
    await createTask(title, description, wordCount, group_id, user_id, task_id);

    await logError('Updating task to running', { message: 'Setting initial status' }, { task_id });
    await withSupabaseRetry(async () => {
      const { error } = await supabase
        .from('story_tasks')
        .update({ status: 'running', updated_at: new Date().toISOString() })
        .eq('id', task_id);
      if (error) {
        await logError('Failed to update task to running', error, { task_id });
        throw error;
      }
    });

    const { outlineText, inputTokens, outputTokens } = await generateInitialOutline(title, description, wordCount, task_id);

    await logError('Updating task with initial outline', { message: 'Storing outline and tokens' }, { task_id });
    await withSupabaseRetry(async () => {
      const { error } = await supabase
        .from('story_tasks')
        .update({
          status: 'outlined',
          outline: outlineText,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          updated_at: new Date().toISOString(),
        })
        .eq('id', task_id);
      if (error) {
        await logError('Failed to update task to outlined', error, { task_id });
        throw error;
      }
    });

    await logError('Scheduling process-outline', { message: 'Initiating async trigger' }, { task_id });
    await scheduleProcessOutline(outlineText, group_id, user_id, task_id, wordCount);

    console.log(`Initial outline generation completed in ${Date.now() - startTime}ms`);
    return new Response(
      JSON.stringify({
        message: 'Initial outline generation completed and process-outline queued',
        task_id,
        group_id,
      }),
      { status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    await logError('Error in generate-outline', error, { payload: { ...payload, description: payload?.description?.slice(0, 100) + '...' }, task_id });
    const status = error.message.includes('rate limit') || error.status === 429 ? 429 : 500;
    const errorMessage = status === 429 ? 'Rate limit exceeded. Please try again later.' : error.message || 'Internal server error';
    if (task_id) {
      await withSupabaseRetry(async () => {
        const { error } = await supabase
          .from('story_tasks')
          .update({
            status: 'failed',
            error: errorMessage,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task_id);
        if (error) await logError('Failed to update task status to failed', error, { task_id });
      });
    }
    return new Response(
      JSON.stringify({ error: errorMessage, code: status }),
      { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
