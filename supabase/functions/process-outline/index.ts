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

function validateInputs(outline: string, groupId: string, userId: string, taskId: string, wordCount: number): string | null {
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
  if (typeof wordCount !== 'number' || wordCount < 200 || wordCount > 40000) {
    return `Word count must be between 200 and 40000. Received: ${wordCount}`;
  }
  return null;
}

function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(word => word.length > 0).length;
  return Math.ceil(words * 1.33);
}

async function validateAndParseOutline(outline: string, wordCount: number, taskId: string): Promise<{ outlineText: string, inputTokens: number, outputTokens: number, batchCount: number, totalWords: number }> {
  await logError('Starting outline validation', { message: 'Initiating processing' }, { taskId, wordCount });

  const maxRetries = 3;
  const maxWordsPerBatch = MAX_WORDS_PER_BATCH;
  const targetBatches = Math.ceil(wordCount / maxWordsPerBatch); // 28 for 11000 words
  const targetWordCount = targetBatches * maxWordsPerBatch; // 11200 for 28 batches
  let finalOutlineText = outline;
  let finalInputTokens = 0;
  let finalOutputTokens = 0;
  let batchCount = 0;
  let totalWords = 0;

  const systemPrompt = `You are an expert text parser. Answer within 100 seconds, quickly. Given the story outline below, parse it into a structured JSON object with two keys: 'chapters' and 'batches'. The 'chapters' key should map to an array of chapter objects, each with 'number' (integer), 'title' (string), 'part' (string, e.g., "Part 1" or "" if not split), 'word_count' (integer), and 'summary' (string) keys. The 'batches' key should map to an array of batch objects, each with 'batch_number' (integer), 'chapter_identifiers' (array of strings, e.g., ["1", "2 Part 1"]), and 'total_words' (integer). The outline format will be:

1. Chapter Title - 400 words: Summary text...
2. Chapter Title (Part 1) - 400 words: Summary text...
3. Chapter Title (Part 2) - 400 words: Summary text...
(etc.)

Batch Plan:
- Batch 1: Chapters [list of chapter numbers or parts, e.g., "1", "2 Part 1"], Total Words: 400
- Batch 2: Chapters [list of chapter numbers or parts], Total Words: 400
(etc.)

Extract the chapter number, title, part (if any), word count, and summary from each chapter line, and parse the batch plan to extract batch numbers, chapter identifiers, and total words. Ensure exactly ${targetBatches} batches, each with exactly one chapter or part of 400 words, summing to ${targetWordCount} words. Remove any notes or extra text. Return only the JSON object. Example output:

{
    "chapters": [
        {"number": 1, "title": "Chapter Title", "part": "", "word_count": 400, "summary": "Summary text..."},
        {"number": 2, "title": "Another Title", "part": "Part 1", "word_count": 400, "summary": "Part 1 summary..."},
        {"number": 2, "title": "Another Title", "part": "Part 2", "word_count": 400, "summary": "Part 2 summary..."}
    ],
    "batches": [
        {"batch_number": 1, "chapter_identifiers": ["1"], "total_words": 400},
        {"batch_number": 2, "chapter_identifiers": ["2 Part 1"], "total_words": 400}
    ]
}
`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await logError(`Validation attempt ${attempt}`, { message: 'Parsing outline' }, { taskId });

    try {
      const response = await withDeepSeekRetry(() =>
        openai.chat.completions.create({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Parse this outline:\n${finalOutlineText}` },
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
        await logError(`Attempt ${attempt}: Invalid JSON format`, { message: 'Missing chapters or batches' }, { taskId });
        continue;
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

      const normalizedOutline = finalOutlineText.replace(/\r\n|\r/g, '\n').trim();
      const lines = normalizedOutline.split('\n').map(line => line.trim()).filter(line => line);
      const batchPlanStart = lines.findIndex(line => line.startsWith('Batch Plan:'));
      if (batchPlanStart === -1) {
        await logError(`Attempt ${attempt}: Batch Plan missing`, { message: 'Invalid outline' }, { taskId });
        continue;
      }

      const chapterLines = lines.slice(0, batchPlanStart).filter(line => !line.toLowerCase().includes('note:'));
      const batchLines = lines.slice(batchPlanStart + 1).filter(line => !line.toLowerCase().includes('note:'));

      const parsedChapters = chapterLines
        .filter(line => /^\d+\./.test(line))
        .map(line => {
          const match = line.match(/^(\d+)\.\s+(.+?)(?:\s*\(Part\s*(\d+)\))?\s*-\s*(\d+)\s*words\s*:\s*(.+)$/i);
          if (!match) return null;
          const wordCount = parseInt(match[4]);
          if (wordCount !== 400 || match[2].toLowerCase().includes('placeholder') || match[5].toLowerCase().includes('placeholder')) return null;
          return {
            index: parseInt(match[1]),
            title: match[2].trim(),
            part: match[3] ? `Part ${match[3]}` : '',
            word_count: wordCount,
            summary: match[5].trim(),
            original_line: line,
          };
        })
        .filter((ch): ch is any => ch !== null);

      if (parsedChapters.length < targetBatches) {
        await logError(`Attempt ${attempt}: Too few chapters`, { message: `Found ${parsedChapters.length}, need ${targetBatches}` }, { taskId });
        continue;
      }

      let valid = true;
      let assignedChapters = new Set<string>();
      let batchWordCounts: number[] = [];
      let invalidReferences: string[] = [];

      for (const line of batchLines) {
        const match = line.match(/^- Batch (\d+): Chapters \[([^\]]*)\], Total Words: (\d+)/);
        if (!match) {
          valid = false;
          invalidReferences.push(line);
          continue;
        }
        const chaptersStr = match[2];
        const batchWords = parseInt(match[3]);
        batchWordCounts.push(batchWords);
        if (chaptersStr) {
          const refs = chaptersStr.split(',').map(ref => ref.trim()).filter(ref => ref);
          if (refs.length !== 1) {
            valid = false;
            invalidReferences.push(`Invalid refs in ${line}`);
            continue;
          }
          for (const ref of refs) {
            const refMatch = ref.match(/^(\d+)(?:\s*Part\s*(\d+))?$/);
            if (!refMatch) {
              valid = false;
              invalidReferences.push(ref);
              continue;
            }
            const chapterNum = parseInt(refMatch[1]);
            const partNum = refMatch[2] ? `Part ${refMatch[2]}` : '';
            const found = parsedChapters.some(ch => ch.index === chapterNum && ch.part === partNum);
            if (!found) {
              valid = false;
              invalidReferences.push(ref);
            } else {
              assignedChapters.add(`${chapterNum}${partNum ? ' ' + partNum : ''}`);
            }
          }
        }
      }

      totalWords = parsedChapters.reduce((sum, ch) => sum + ch.word_count, 0);
      batchCount = batchLines.length;

      const isValid = (
        totalWords === targetWordCount &&
        batchCount === targetBatches &&
        batchLines.every(line => !line.includes('Chapters []')) &&
        assignedChapters.size === parsedChapters.length &&
        batchWordCounts.every(w => w === 400)
      );

      if (isValid) {
        await logError(`Attempt ${attempt}: Outline valid`, { message: 'Proceeding with outline' }, { taskId });
        finalInputTokens += response.usage?.prompt_tokens || estimateTokens(systemPrompt + finalOutlineText);
        finalOutputTokens += response.usage?.completion_tokens || estimateTokens(jsonOutput);
        break;
      }

      await logError(`Attempt ${attempt}: Invalid outline, redistributing`, { message: 'Generating new batch plan' }, { taskId });
      parsedChapters.sort((a, b) => {
        if (a.index !== b.index) return a.index - b.index;
        return a.part.localeCompare(b.part);
      });

      const selectedChapters = parsedChapters.slice(0, targetBatches);
      if (selectedChapters.length < targetBatches) {
        await logError(`Attempt ${attempt}: Insufficient chapters after filter`, { message: `Found ${selectedChapters.length}` }, { taskId });
        if (attempt === maxRetries) throw new Error('Failed to generate enough valid chapters');
        continue;
      }

      const newBatchPlan = selectedChapters.map((chapter, i) => {
        const chapterRef = `${chapter.index}${chapter.part ? ` ${chapter.part}` : ''}`;
        return `- Batch ${i + 1}: Chapters [${chapterRef}], Total Words: 400`;
      });

      finalOutlineText = selectedChapters.map(ch => ch.original_line).join('\n') + '\n\nBatch Plan:\n' + newBatchPlan.join('\n');
      totalWords = selectedChapters.reduce((sum, ch) => sum + ch.word_count, 0);
      batchCount = newBatchPlan.length;

      const isValidAfterRedistribution = (
        totalWords === targetWordCount &&
        batchCount === targetBatches &&
        newBatchPlan.every(line => !line.includes('Chapters []')) &&
        selectedChapters.length === targetBatches &&
        newBatchPlan.every(line => {
          const match = line.match(/Total Words: (\d+)/);
          return match && parseInt(match[1]) === 400;
        })
      );

      if (isValidAfterRedistribution) {
        await logError(`Attempt ${attempt}: Redistributed plan valid`, { message: 'Proceeding with outline' }, { taskId });
        finalInputTokens += response.usage?.prompt_tokens || estimateTokens(systemPrompt + finalOutlineText);
        finalOutputTokens += response.usage?.completion_tokens || estimateTokens(jsonOutput);
        break;
      }

      if (attempt === maxRetries) {
        throw new Error('Failed to generate a valid outline after all retries');
      }
    } catch (error: any) {
      await logError(`Attempt ${attempt}: Validation failed`, error, { taskId });
      if (attempt === maxRetries) throw error;
    }
  }

  return { outlineText: finalOutlineText, inputTokens: finalInputTokens, outputTokens: finalOutputTokens, batchCount, totalWords };
}

async function scheduleParseOutline(
  outline: string,
  groupId: string,
  userId: string,
  taskId: string
): Promise<void> {
  await logError('Scheduling parse-outline', { message: 'Preparing fetch request' }, { taskId });
  const payload = {
    outline,
    group_id: groupId,
    user_id: userId,
    task_id: taskId,
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    fetch(`${SUPABASE_URL}/functions/v1/parse-outline`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).then(async (response) => {
      clearTimeout(timeoutId);
      const responseText = await response.text();
      await logError('Parse-outline fetch response', { status: response.status, body: responseText }, { taskId, groupId });
      if (!response.ok) {
        await logError('Parse-outline request failed', new Error(`HTTP ${response.status}: ${responseText}`), { taskId, groupId });
      } else {
        console.log(`Parse-outline queued for task ${taskId}`);
      }
    }).catch(async (error) => {
      clearTimeout(timeoutId);
      await logError('Parse-outline request timeout or error', error, { taskId, groupId });
    });
  } catch (error: any) {
    await logError('Failed to initiate parse-outline', error, { taskId, groupId });
  }
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const startTime = Date.now();
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const auth = await verifyAuth(req);
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  let payload;
  try {
    payload = await req.json();
    await logError('Received process-outline payload', { message: 'Payload processing started' }, { outline: payload.outline?.slice(0, 100) + '...' });
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

    const { outline = '', group_id: rawGroupId = '', user_id: rawUserId = '', task_id: rawTaskId = '', word_count: rawWordCount = 0 } = payload;
    const groupId = rawGroupId.toString();
    const userId = rawUserId.toString();
    const taskId = rawTaskId.toString();
    const wordCount = parseInt(rawWordCount.toString(), 10);

    const validationError = validateInputs(outline, groupId, userId, taskId, wordCount);
    if (validationError) {
      await logError('Validation error', new Error(validationError), { taskId, groupId });
      return new Response(
        JSON.stringify({ error: validationError, code: 400 }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    await logError('Verifying task status', { message: 'Checking story_tasks' }, { taskId });
    let taskData = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const { data: tasks, error: taskError } = await withSupabaseRetry(() =>
          supabase
            .from('story_tasks')
            .select('status, created_at')
            .eq('id', taskId)
            .eq('status', 'outlined')
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
        await logError(`Task not found on attempt ${attempt}`, { message: 'Task not in outlined state' }, { taskId });
        if (attempt < 5) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (error: any) {
        if (attempt === 5) throw error;
      }
    }

    if (!taskData) {
      const errorMsg = 'No task found with the given task_id in outlined state';
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

    await logError('Before processing outline', { message: 'Starting validation' }, { taskId });
    const { outlineText, inputTokens, outputTokens, batchCount, totalWords } = await validateAndParseOutline(outline, wordCount, taskId);
    await logError('Outline processed', { message: 'Validation complete' }, { taskId });

    await logError('Before updating task to processed', { message: 'Preparing update' }, { taskId });
    await withSupabaseRetry(async () => {
      const { error } = await supabase
        .from('story_tasks')
        .update({
          outline: outlineText,
          status: 'processed',
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_batches: batchCount,
          total_word_count: totalWords,
          updated_at: new Date().toISOString(),
        })
        .eq('id', taskId);
      if (error) {
        await logError('Failed to update task to processed', error, { taskId });
        throw error;
      }
    });
    await logError('Task updated to processed', { message: 'Update successful' }, { taskId });

    await logError('Before scheduling parse-outline', { message: 'Initiating async trigger' }, { taskId });
    await scheduleParseOutline(outlineText, groupId, userId, taskId);
    await logError('Parse-outline scheduled', { message: 'Scheduling complete' }, { taskId });

    console.log(`Outline processing completed in ${Date.now() - startTime}ms`);
    return new Response(
      JSON.stringify({
        message: 'Outline processed and parse-outline queued',
        task_id: taskId,
        group_id: groupId,
        total_batches: batchCount,
        total_words: totalWords,
      }),
      { status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    await logError('Error in process-outline', error, { taskId: payload?.task_id, groupId: payload?.group_id });
    const status = error.message.includes('rate limit') || error.status === 429 ? 429 : 500;
    const errorMessage = status === 429 ? 'Rate limit exceeded. Please try again later.' : error.message || 'Internal server error';
    if (payload?.task_id) {
      await withSupabaseRetry(async () => {
        const { error } = await supabase
          .from('story_tasks')
          .update({
            status: 'failed',
            error: errorMessage,
            updated_at: new Date().toISOString(),
          })
          .eq('id', payload.task_id);
        if (error) await logError('Failed to update task status to failed', error, { task_id: payload.task_id });
      });
    }
    return new Response(
      JSON.stringify({ error: errorMessage, code: status }),
      { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
