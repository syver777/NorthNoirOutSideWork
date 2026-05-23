import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { OpenAI } from 'npm:openai@4';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = (Deno.env.get('PUBLIC_KEY')) ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SECRET_KEY') ?? '';
const DEEPSEEK_API_KEY = Deno.env.get('DEEPSEEK_API_KEY') ?? '';
const MAX_WORDS_PER_BATCH = 500;
const MIN_WORDS_PER_CHAPTER = 400;
const WORD_COUNT_TOLERANCE = 0.05;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY || !DEEPSEEK_API_KEY) {
  throw new Error('Missing environment variables');
}

const supabase = createClient(SUPABASE_URL, ANON_KEY);
const openai = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

async function logError(message: string, error: any, context: Record<string, any> = {}) {
  console.error(`${message}:`, error);
  try {
    const details = typeof error === 'string' ? error : error.message || JSON.stringify(error).slice(0, 1000);
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

async function withSupabaseRetry<T>(operation: () => Promise<T>, retries: number = 3, delay: number = 5000): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      const message = error.message || JSON.stringify(error || 'Unknown error');
      if (message.includes('timeout') || message.includes('connection') || message.includes('network')) {
        if (attempt < retries) {
          console.log(`Supabase retry attempt ${attempt} failed: ${message}. Retrying in ${delay}ms...`);
          await logError(`Supabase retry attempt ${attempt} failed`, error, { attempt });
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
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
      return await operation();
    } catch (error: any) {
      lastError = error;
      const status = error.status?.toString();
      const message = error.message || '';
      if (['429', '500', '503'].includes(status) || message.toLowerCase().includes('overloaded')) {
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

function validateInputs(
  groupId: string,
  userId: string,
  title: string,
  description: string,
  taskId: string,
  partNumber: number,
  totalParts: number
): string | null {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!groupId || !uuidRegex.test(groupId)) return `Group ID must be a valid UUID`;
  if (!userId || !uuidRegex.test(userId)) return `User ID must be a valid UUID`;
  if (!taskId || !uuidRegex.test(taskId)) return `Task ID must be a valid UUID`;
  if (!title || typeof title !== 'string') return 'Title is missing or invalid';
  if (!description || typeof description !== 'string') return 'Description is missing or invalid';
  if (typeof partNumber !== 'number' || partNumber < 1) return `Invalid part_number: ${partNumber}`;
  if (typeof totalParts !== 'number' || totalParts < 1) return `Invalid total_parts: ${totalParts}`;
  return null;
}

interface Chapter {
  number: number;
  title: string;
  part: string;
  word_count: number;
  summary: string;
  part_number?: number;
}

interface Batch {
  batch_number: number;
  chapter_identifiers: string[];
  total_words: number;
  part_number?: number;
}

async function fetchCompletedParts(groupId: string, totalParts: number): Promise<any[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);
  try {
    const { data, error } = await supabase
      .from('story_tasks')
      .select('id, part_number, previous_content, batch, total_word_count, outline')
      .eq('group_id', groupId)
      .eq('status', 'completed')
      .in('part_number', Array.from({ length: totalParts }, (_, i) => i + 1))
      .order('part_number', { ascending: true })
      .abortSignal(controller.signal);
    if (error) throw new Error(`Failed to fetch completed parts: ${error.message}`);
    return data || [];
  } catch (error: any) {
    await logError('Fetch completed parts error', error, { groupId, totalParts });
    throw error.name === 'AbortError' ? new Error('Fetch timeout') : error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchNextPartTask(groupId: string, nextPartNumber: number): Promise<{ id: string; total_word_count: number } | null> {
  const { data, error } = await supabase
    .from('story_tasks')
    .select('id, total_word_count, status')
    .eq('group_id', groupId)
    .eq('part_number', nextPartNumber)
    .in('status', ['queued', 'pending', 'failed'])
    .single();
  if (error || !data) {
    await logError('Failed to fetch next part task', error || new Error('No task found'), { groupId, nextPartNumber });
    return null;
  }
  if (data.status === 'failed') {
    const { error: updateError } = await supabase
      .from('story_tasks')
      .update({
        status: 'queued',
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', data.id);
    if (updateError) {
      await logError('Failed to reset failed task status', updateError, { groupId, nextPartNumber, taskId: data.id });
      return null;
    }
  }
  return data;
}

async function triggerGenerateOutline(
  title: string,
  description: string,
  wordCount: number,
  groupId: string,
  userId: string,
  partNumber: number,
  totalParts: number,
  taskId: string
): Promise<void> {
  console.log(`Triggering generate-outline for part ${partNumber}, task ${taskId}`);
  const payload = {
    title,
    description,
    word_count: wordCount,
    group_id: groupId,
    user_id: userId,
    part_number: partNumber,
    total_parts: totalParts,
    task_id: taskId,
  };
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);
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
          taskId, groupId, partNumber
        });
      } else {
        console.log(`Generate-outline triggered successfully for part ${partNumber}, task ${taskId}`);
      }
    }).catch(async (error) => {
      clearTimeout(timeoutId);
      await logError('Generate-outline request timeout or error', error, { taskId, groupId, partNumber });
    });
  } catch (error: any) {
    await logError('Failed to initiate generate-outline', error, { taskId, groupId, partNumber });
  }
}

async function reparseBatch(batchesJson: string[], expectedWordCount: number): Promise<{ chapters: Chapter[]; batches: Batch[] }> {
  const systemPrompt = `You are an expert JSON parser. Given an array of JSON objects from multiple story parts, each containing 'chapters' and 'batches', combine them into a single JSON object with chapters listed sequentially (1, 2, 3, ...) across all parts and corresponding batches. Ensure:
- Chapters are numbered sequentially across parts (e.g., Part 1 ends at 17, Part 2 starts at 18).
- Chapter identifiers in batches match unified chapter numbers (e.g., "[18]").
- Deduplicate chapters if their titles or summaries are similar (within 80% similarity) or cover the same events, selecting the version with the most detailed summary or highest part_number if equally detailed.
- Remove 'part_number' from chapters in the final output.
- Each batch contains exactly one chapter with word count between ${MIN_WORDS_PER_CHAPTER} and ${MAX_WORDS_PER_BATCH}.
- Batch identifiers use "[number]" only, removing "Part X" suffixes.
- Batches are renumbered sequentially (1, 2, 3, ...).
- Maintain chronological flow: early life and labors 1–9 in parts 1–2, death and ascension in part 3.
- Total word count must be within ±${WORD_COUNT_TOLERANCE * 100}% of ${expectedWordCount}.

Return only the JSON object. Log input and output for debugging.`;

  const userPrompt = `Combine these batch JSONs:\n${JSON.stringify(batchesJson)}`;

  try {
    console.log('reparseBatch input:', JSON.stringify(batchesJson, null, 2));
    const parsedBatches = batchesJson.map(json => JSON.parse(json)).sort((a, b) => (a.chapters[0]?.part_number || 0) - (b.chapters[0]?.part_number || 0));
    let unifiedChapters: Chapter[] = [];
    let unifiedBatches: Batch[] = [];
    let chapterCounter = 1;
    const seenSummaries: Map<string, Chapter> = new Map();

    for (const batch of parsedBatches) {
      for (const chapter of batch.chapters) {
        const key = `${chapter.title}:${chapter.summary.slice(0, 100)}`;
        if (!seenSummaries.has(key)) {
          unifiedChapters.push({
            ...chapter,
            number: chapterCounter++,
            part_number: undefined,
          });
          seenSummaries.set(key, chapter);
        } else {
          const existing = seenSummaries.get(key)!;
          if (chapter.part_number && existing.part_number && chapter.part_number > existing.part_number) {
            const index = unifiedChapters.findIndex(c => c.number === existing.number);
            unifiedChapters[index] = {
              ...chapter,
              number: existing.number,
              part_number: undefined,
            };
          }
        }
      }
    }

    unifiedBatches = unifiedChapters.map((ch, idx) => ({
      batch_number: idx + 1,
      chapter_identifiers: [`[${ch.number}]`],
      total_words: ch.word_count,
    }));

    const totalWords = unifiedChapters.reduce((sum, ch) => sum + ch.word_count, 0);
    const minWordCount = expectedWordCount * (1 - WORD_COUNT_TOLERANCE);
    const maxWordCount = expectedWordCount * (1 + WORD_COUNT_TOLERANCE);
    if (totalWords < minWordCount || totalWords > maxWordCount) {
      await logError('Word count out of tolerance', new Error(`Total words: ${totalWords}, expected: ${minWordCount}-${maxWordCount}`), {});
      throw new Error(`Total word count ${totalWords} is outside tolerance`);
    }

    const result = { chapters: unifiedChapters, batches: unifiedBatches };
    console.log('reparseBatch output:', JSON.stringify(result, null, 2));
    return result;
  } catch (error: any) {
    await logError('reparseBatch failed', error, { batchesJson });
    throw new Error(`Failed to reparse batch: ${error.message}`);
  }
}

async function reparseOutline(outlines: string[], expectedWordCount: number): Promise<{ parsedData: { chapters: Chapter[]; batches: Batch[] }; outlineText: string }> {
  const systemPrompt = `You are an expert text parser. Given an array of outline texts from multiple story parts, combine them into a single unified outline. Ensure:
- Chapters are numbered sequentially across parts (e.g., Part 1 ends at 17, Part 2 starts at 18).
- Chapter identifiers in the batch plan match unified chapter numbers (e.g., "[18]").
- Deduplicate chapters if titles or summaries are similar (within 80% similarity) or cover the same events, selecting the most detailed summary or highest part_number.
- Remove 'part_number' from chapters.
- Each batch contains exactly one chapter with word count between ${MIN_WORDS_PER_CHAPTER} and ${MAX_WORDS_PER_BATCH}.
- Batch identifiers use "[number]" only, removing "Part X" suffixes.
- Batches are renumbered sequentially (1, 2, 3, ...).
- Maintain chronological flow: early life and labors 1–9 in parts 1–2, death and ascension in part 3.
- Total word count must be within ±${WORD_COUNT_TOLERANCE * 100}% of ${expectedWordCount}.
- Output includes 'parsedData' (JSON with chapters and batches) and 'outlineText' (text outline).

Return only the JSON object with 'parsedData' and 'outlineText'.`;

  const userPrompt = `Combine these outlines:\n${JSON.stringify(outlines)}`;

  try {
    console.log('reparseOutline input:', JSON.stringify(outlines, null, 2));
    const response = await withDeepSeekRetry(() =>
      openai.chat.completions.create({
        model: 'deepseek',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 8100,
        temperature: 0.0,
      })
    );
    const jsonOutput = response.choices[0]?.message?.content?.trim();
    if (!jsonOutput) throw new Error('No content in DeepSeek response');

    let parsed;
    try {
      parsed = JSON.parse(jsonOutput);
    } catch (error) {
      throw new Error(`Failed to parse DeepSeek response: ${error.message}`);
    }
    if (!parsed.parsedData || !parsed.outlineText) {
      throw new Error('Invalid outline parse response structure');
    }

    const totalWords = parsed.parsedData.chapters.reduce((sum: number, ch: Chapter) => sum + ch.word_count, 0);
    const minWordCount = expectedWordCount * (1 - WORD_COUNT_TOLERANCE);
    const maxWordCount = expectedWordCount * (1 + WORD_COUNT_TOLERANCE);
    if (totalWords < minWordCount || totalWords > maxWordCount) {
      throw new Error(`Total word count ${totalWords} is outside tolerance`);
    }

    return parsed;
  } catch (error: any) {
    await logError('reparseOutline failed', error, { outlines });
    throw new Error(`Failed to reparse outline: ${error.message}`);
  }
}

async function updateFinalRow(
  taskId: string,
  groupId: string,
  partNumber: number,
  totalParts: number,
  outlineText: string,
  parsedData: { chapters: Chapter[]; batches: Batch[] },
  currentTaskWordCount: number,
  title: string,
  description: string,
  userId: string
): Promise<void> {
  const { data: finalTask, error: finalTaskError } = await withSupabaseRetry(() =>
    supabase
      .from('story_tasks')
      .select('id, batch, outline, total_word_count, total_batches, status')
      .eq('group_id', groupId)
      .is('part_number', null)
      .in('status', ['queued', 'pending'])
      .single()
  );

  if (finalTaskError || !finalTask) {
    const errorMsg = finalTaskError ? `Failed to fetch final task: ${finalTaskError.message}` : 'Final task not found';
    await logError('Error getting final task', errorMsg, { taskId, groupId });
    throw new Error(errorMsg);
  }

  let currentBatch;
  try {
    currentBatch = finalTask.batch && finalTask.batch !== '[]' ? JSON.parse(finalTask.batch) : { chapters: [], batches: [] };
  } catch (error: any) {
    await logError('Failed to parse final task batch', error, { taskId, groupId });
    currentBatch = { chapters: [], batches: [] };
  }

  let currentOutline = finalTask.outline || outlineText || '';
  let totalWordCount = finalTask.total_word_count || 0;

  const completedParts = await fetchCompletedParts(groupId, totalParts);
  if (completedParts.length < totalParts) {
    const newChapterNumbers = parsedData.chapters.map(ch => ({ ...ch, part_number: partNumber }));
    const newBatches = parsedData.batches.map(b => ({ ...b, part_number: partNumber }));
    currentBatch.chapters = [...currentBatch.chapters, ...newChapterNumbers];
    currentBatch.batches = [...currentBatch.batches, ...newBatches].map((b, idx) => ({
      ...b,
      batch_number: idx + 1,
      chapter_identifiers: b.chapter_identifiers.map(id => id.replace(/\sPart\s\d+/, '')),
    }));
    totalWordCount += currentTaskWordCount;

    const chaptersText = currentBatch.chapters
      .sort((a, b) => (a.part_number || 0) - (b.part_number || 0) || a.number - b.number)
      .map((ch, index) => `${index + 1}. ${ch.title}${ch.part ? ` (${ch.part})` : ''} - ${ch.word_count} words: ${ch.summary}`)
      .join('\n');
    const batchPlanText = currentBatch.batches
      .map((b, index) => `- Batch ${index + 1}: Chapters [${b.chapter_identifiers[0]}], Total Words: ${b.total_words}`)
      .join('\n');
    currentOutline = `${chaptersText}\n\nBatch Plan:\n${batchPlanText}\nTotal Words: ${totalWordCount}`;
  } else {
    const batchesJson = completedParts.map(p => p.batch).filter(b => b && b !== '[]');
    const outlines = completedParts.map(p => p.outline).filter(o => o);
    const totalExpectedWords = completedParts.reduce((sum, part) => sum + part.total_word_count, 0);

    const finalBatch = await reparseBatch(batchesJson, totalExpectedWords);
    const { outlineText: finalOutline } = await reparseOutline(outlines, totalExpectedWords);

    currentBatch = finalBatch;
    currentOutline = finalOutline;
    totalWordCount = totalExpectedWords;
  }

  const status = completedParts.length >= totalParts ? 'completed' : 'pending';
  const { error: updateError } = await withSupabaseRetry(() =>
    supabase
      .from('story_tasks')
      .update({
        batch: JSON.stringify(currentBatch),
        outline: currentOutline,
        previous_content: currentOutline,
        total_word_count: totalWordCount,
        total_batches: currentBatch.batches.length,
        status,
        updated_at: new Date().toISOString(),
        error: null,
      })
      .eq('id', finalTask.id)
  );

  if (updateError) {
    await logError('Failed to update final task', updateError, { taskId, groupId });
    throw new Error(`Failed to update final task: ${updateError.message}`);
  }

  if (partNumber < totalParts && completedParts.length < totalParts) {
    const nextPartNumber = partNumber + 1;
    const nextPartTask = await fetchNextPartTask(groupId, nextPartNumber);
    if (nextPartTask) {
      await triggerGenerateOutline(
        title,
        description,
        nextPartTask.total_word_count,
        groupId,
        userId,
        nextPartNumber,
        totalParts,
        nextPartTask.id
      );
    } else {
      await logError('Next part task not found or invalid state', new Error('No valid task for next part'), { groupId, nextPartNumber });
    }
  }
}

export default serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed', code: 405 }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let payload;
    try {
      payload = await req.json();
      console.log('Received combine-outline payload:', {
        group_id: payload.group_id,
        task_id: payload.task_id,
        part_number: payload.part_number,
        total_parts: payload.total_parts,
      });
    } catch (error: any) {
      await logError('Invalid JSON payload', error);
      return new Response(
        JSON.stringify({ error: 'Invalid JSON payload', code: 400 }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const {
      group_id: rawGroupId = '',
      user_id: rawUserId = '',
      title = '',
      description = '',
      task_id: rawTaskId = '',
      part_number: rawPartNumber = 1,
      total_parts: rawTotalParts = 1,
    } = payload;

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
    const partNumber = parseInt(rawPartNumber.toString(), 10) || 1;
    const totalParts = parseInt(rawTotalParts.toString(), 10) || 1;

    const validationError = validateInputs(groupId, userId, title, description, taskId, partNumber, totalParts);
    if (validationError) {
      await logError('Validation error', new Error(validationError), { taskId, groupId });
      return new Response(
        JSON.stringify({ error: validationError, code: 400 }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: currentPart, error: partError } = await withSupabaseRetry(() =>
      supabase
        .from('story_tasks')
        .select('id, part_number, previous_content, batch, total_word_count')
        .eq('id', taskId)
        .eq('part_number', partNumber)
        .eq('status', 'completed')
        .single()
    );

    if (partError || !currentPart) {
      const errorMsg = partError ? `Failed to fetch part: ${partError.message}` : `Part ${partNumber} not completed or not found`;
      await logError('Part fetch error', errorMsg, { taskId, groupId, partNumber });
      return new Response(
        JSON.stringify({ error: errorMsg, code: 400 }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let parsedData: { chapters: any[], batches: any[] };
    try {
      parsedData = JSON.parse(currentPart.batch);
      if (!parsedData.chapters || !parsedData.batches) {
        throw new Error('Invalid batch structure');
      }
    } catch (error: any) {
      await logError('Failed to parse batch', error, { taskId, groupId });
      throw new Error(`Failed to parse batch: ${error.message}`);
    }

    const totalWords = parsedData.chapters.reduce((sum: number, ch: Chapter) => sum + ch.word_count, 0);
    const minWordCount = currentPart.total_word_count * (1 - WORD_COUNT_TOLERANCE);
    const maxWordCount = currentPart.total_word_count * (1 + WORD_COUNT_TOLERANCE);
    const isWithinTolerance = totalWords >= minWordCount && totalWords <= maxWordCount;

    if (!isWithinTolerance || !parsedData.batches.every((b: Batch) => b.chapter_identifiers.length === 1 && b.total_words >= MIN_WORDS_PER_CHAPTER && b.total_words <= MAX_WORDS_PER_BATCH)) {
      const errorMsg = 'Invalid batch: word count out of range or incorrect batch structure';
      await logError('Batch validation error', errorMsg, { taskId, groupId, totalWords, expected: currentPart.total_word_count });
      throw new Error(errorMsg);
    }

    await updateFinalRow(
      taskId,
      groupId,
      partNumber,
      totalParts,
      currentPart.previous_content,
      parsedData,
      currentPart.total_word_count,
      title,
      description,
      userId
    );

    return new Response(
      JSON.stringify({
        message: 'Outline part appended successfully',
        task_id: taskId,
        part_number: partNumber,
        total_parts: totalParts,
        total_batches: parsedData.batches.length,
        total_words: totalWords,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    await logError('Error in combine-outline', error, { taskId: payload?.task_id, groupId: payload?.group_id });
    if (payload?.task_id) {
      await withSupabaseRetry(() =>
        supabase
          .from('story_tasks')
          .update({
            status: 'failed',
            error: error.message || 'Internal server error',
            updated_at: new Date().toISOString(),
          })
          .eq('id', payload.task_id)
      );
    }
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error', code: 500 }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});


