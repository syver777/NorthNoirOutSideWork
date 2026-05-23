import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { OpenAI } from 'npm:openai@4';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SECRET_KEY') ?? '';
const DEEPSEEK_API_KEY = Deno.env.get('DEEPSEEK_API_KEY') ?? '';
const MAX_WORDS_PER_BATCH = 400;
const MIN_WORDS_PER_BATCH = 100;
const TOKEN_PER_WORD = 1.33;
const SUPABASE_TIMEOUT_MS = 120000;
const MAX_INPUT_TOKENS = 30000; // DeepSeek limit approximation

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
    if (dbError) console.error('Error logging to database:', dbError);
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
      await logError(`Supabase attempt ${attempt} failed`, error, { attempt });
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

async function withDeepSeekRetry<T>(operation: () => Promise<T>, retries: number = 3, delay: number = 10000): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 180000);
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

function validateInputs(outline: string, groupId: string, userId: string, taskId: string): string | null {
  if (!outline || typeof outline !== 'string' || outline.trim().length === 0) {
    return 'Outline is missing or invalid';
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!groupId || !uuidRegex.test(groupId)) {
    return `Group ID must be a valid UUID. Received: ${groupId}`;
  }
  if (!userId || !uuidRegex.test(userId)) {
    return `User ID must be a valid UUID. Received: ${userId}`;
  }
  if (!taskId || !uuidRegex.test(taskId)) {
    return 'Task ID must be a valid UUID';
  }
  const estimatedTokens = estimateTokens(outline);
  if (estimatedTokens > MAX_INPUT_TOKENS) {
    return `Outline exceeds maximum input token limit of ${MAX_INPUT_TOKENS}. Estimated: ${estimatedTokens}`;
  }
  return null;
}

function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(word => word.length > 0).length;
  return Math.ceil(words * TOKEN_PER_WORD);
}

async function parseOutline(outline: string, taskId: string): Promise<{ chapters: any[], batches: any[], inputTokens: number, outputTokens: number }> {
  await logError('Starting outline parsing', { message: 'Initiating DeepSeek call' }, { taskId });

  const systemPrompt = `Parse the story outline into a JSON object with 'chapters' and 'batches' keys. 'chapters' is an array of objects with 'number' (integer), 'title' (string), 'part' (string, e.g., "Part 1" or ""), 'word_count' (integer), and 'summary' (string). 'batches' is an array of objects with 'batch_number' (integer), 'chapter_identifiers' (array of strings, e.g., ["1", "2 Part 1"]), and 'total_words' (integer). Outline format:

1. Chapter Title - 400 words: Summary...
2. Chapter Title (Part 1) - 400 words: Summary...
Batch Plan:
- Batch 1: Chapters [1], Total Words: 400
- Batch 2: Chapters [2 Part 1], Total Words: 400

Ensure each batch has one chapter/part of 400 words. Return only the JSON object.`;

  const userPrompt = `Parse this outline:\n${outline}`;

  try {
    const response = await withDeepSeekRetry(() =>
      openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 8100,
        temperature: 0.6,
      })
    );

    let jsonOutput = response.choices[0]?.message?.content || '';
    if (jsonOutput.startsWith('```json')) jsonOutput = jsonOutput.slice(7);
    if (jsonOutput.endsWith('```')) jsonOutput = jsonOutput.slice(0, -3);
    jsonOutput = jsonOutput.trim();

    const parsedData = JSON.parse(jsonOutput);
    if (!parsedData.chapters || !parsedData.batches) {
      throw new Error('Invalid JSON format: missing chapters or batches');
    }

    const chapters = parsedData.chapters.map(ch => ({
      number: parseInt(ch.number),
      title: ch.title.toString(),
      part: ch.part.toString(),
      word_count: parseInt(ch.word_count),
      summary: ch.summary.toString(),
    }));

    const batches = parsedData.batches.map(b => ({
      batch_number: parseInt(b.batch_number),
      chapter_identifiers: b.chapter_identifiers.map(String),
      total_words: parseInt(b.total_words),
    }));

    const inputTokens = response.usage?.prompt_tokens || estimateTokens(systemPrompt + userPrompt);
    const outputTokens = response.usage?.completion_tokens || estimateTokens(jsonOutput);

    await logError('Outline parsed successfully', { message: 'DeepSeek response processed' }, { taskId });
    return { chapters, batches, inputTokens, outputTokens };
  } catch (error: any) {
    await logError('Outline parsing failed', error, { taskId });
    throw error;
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
    await logError('Received parse-outline payload', { message: 'Payload processing started' }, { outline: payload.outline?.slice(0, 100) + '...' });
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

    const { outline = '', group_id: rawGroupId = '', user_id: rawUserId = '', task_id: rawTaskId = '' } = payload;

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

    const groupId = rawGroupId.toString();
    const userId = rawUserId.toString();
    const taskId = rawTaskId.toString();

    const validationError = validateInputs(outline, groupId, userId, taskId);
    if (validationError) {
      await logError('Validation error', new Error(validationError), { taskId, groupId });
      await withSupabaseRetry(async () => {
        const { error } = await supabase
          .from('story_tasks')
          .update({
            status: 'failed',
            error: validationError,
            updated_at: new Date().toISOString(),
          })
          .eq('id', taskId);
        if (error) await logError('Failed to update task status to failed', error, { taskId });
      });
      return new Response(
        JSON.stringify({ error: validationError, code: 400 }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let taskData = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const { data: tasks, error: taskError } = await withSupabaseRetry(() =>
          supabase
            .from('story_tasks')
            .select('status, total_word_count')
            .eq('id', taskId)
            .eq('status', 'processed')
            .order('created_at', { ascending: false })
        );
        if (taskError) {
          await logError(`Task verification attempt ${attempt} failed`, taskError, { taskId });
          throw new Error(`Task verification failed: ${taskError.message}`);
        }
        if (tasks && tasks.length > 0) {
          taskData = tasks[0];
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
        await logError(`Task not found on attempt ${attempt}`, { message: 'Task not in processed state' }, { taskId });
        if (attempt < 5) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (error: any) {
        if (attempt === 5) throw error;
      }
    }

    if (!taskData) {
      const errorMsg = 'No task found with the given task_id in processed state';
      await logError('No task found', errorMsg, { taskId, groupId });
      await withSupabaseRetry(async () => {
        const { error } = await supabase
          .from('story_tasks')
          .update({
            status: 'failed',
            error: errorMsg,
            updated_at: new Date().toISOString(),
          })
          .eq('id', taskId);
        if (error) await logError('Failed to update task status to failed', error, { taskId });
      });
      return new Response(
        JSON.stringify({ error: errorMsg, code: 400 }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    await logError('Before parsing outline', { message: 'Starting parse process' }, { taskId });
    const { chapters, batches, inputTokens, outputTokens } = await parseOutline(outline, taskId);
    await logError('Outline parsed', { message: 'Parsing complete' }, { taskId });

    const totalWords = chapters.reduce((sum: number, ch: any) => sum + ch.word_count, 0);

    await logError('Before updating task to parsed', { message: 'Preparing update' }, { taskId });
    await withSupabaseRetry(async () => {
      const { error } = await supabase
        .from('story_tasks')
        .update({
          batch: JSON.stringify({ chapters, batches }),
          total_batches: batches.length,
          total_word_count: totalWords,
          status: 'parsed',
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          updated_at: new Date().toISOString(),
          progress: 100,
        })
        .eq('id', taskId);
      if (error) {
        await logError('Failed to update task to parsed', error, { taskId });
        throw error;
      }
    });
    await logError('Task updated to parsed', { message: 'Update successful' }, { taskId });

    console.log(`Outline parsing completed in ${Date.now() - startTime}ms`);
    return new Response(
      JSON.stringify({
        message: 'Outline parsed successfully',
        task_id: taskId,
        total_batches: batches.length,
        total_words: totalWords,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    await logError('Error in parse-outline', error, { taskId: payload?.task_id, groupId: payload?.group_id });
    const errorMessage = error.message || 'Internal server error';
    if (payload?.task_id) {
      await withSupabaseRetry(async () => {
        const { error: updateError } = await supabase
          .from('story_tasks')
          .update({
            status: 'failed',
            error: errorMessage,
            updated_at: new Date().toISOString(),
          })
          .eq('id', payload.task_id);
        if (updateError) await logError('Failed to update task status to failed', updateError, { task_id: payload.task_id });
      });
    }
    const status = errorMessage.includes('rate limit') || error.status === 429 ? 429 : 500;
    return new Response(
      JSON.stringify({ error: errorMessage, code: status }),
      { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
