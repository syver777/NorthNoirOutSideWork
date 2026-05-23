
import { createClient } from 'npm:@supabase/supabase-js@2';
import { v4 as uuidv4 } from 'https://esm.sh/uuid@9.0.0';

interface Chapter {
  index: number;
  number: number;
  title: string;
  part: string | null;
  word_count: number;
  summary: string;
  group_id?: string;
}

interface Batch {
  batch_number: number;
  chapter_identifiers: string[];
  total_words: number;
  group_id?: string;
}

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseKey = (Deno.env.get('PUBLIC_KEY')) ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
const supabaseSecretKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing environment variables: SUPABASE_URL or SUPABASE_ANON_KEY');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Model configurations
const MODEL_CONFIGS = {
  deepseek: { maxWordsPerBatch: 1100 },
  sonnet: { maxWordsPerBatch: 3000 }, // Updated from 3500 to 3000
  opus: { maxWordsPerBatch: 3000 } // Updated from 3500 to 3000
};

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY = 2000;
const BATCH_INSERT_CHUNK_SIZE = 10;
const MAX_SUMMARY_LENGTH = 500; // Add summary length limit

const WORD_PATTERNS_PARSE: Record<string, string> = {
  english: 'words',
  german: 'Wörter',
  spanish: 'palabras',
  french: 'mots'
};

// Sanitize AI-generated outline that may contain markdown formatting
function sanitizeOutlineMarkdown(rawText: string): string {
  const wordPatternStr = Object.values(WORD_PATTERNS_PARSE).join('|');
  const chapterStartRegex = new RegExp(`^\\d+\\.\\s+.+?-\\s*\\d+\\s*(?:${wordPatternStr})`);
  const hasSummaryRegex = new RegExp(`^\\d+\\.\\s+.+?-\\s*\\d+\\s*(?:${wordPatternStr})\\s*:\\s*.+`);

  let text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let lines = text.split("\n");

  // Strip markdown formatting from each line
  lines = lines.map(line => {
    let cleaned = line;
    cleaned = cleaned.replace(/\*\*/g, '');
    cleaned = cleaned.replace(/(?<!\w)\*(?!\w)/g, '');
    cleaned = cleaned.replace(/^#{1,6}\s+/, '');
    if (/^-{3,}$/.test(cleaned.trim())) return '';
    return cleaned.trim();
  });

  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) { i++; continue; }

    if (chapterStartRegex.test(line)) {
      if (hasSummaryRegex.test(line)) {
        result.push(line);
        i++;
      } else {
        let summary = '';
        i++;
        while (i < lines.length) {
          const nextLine = lines[i];
          if (!nextLine) { i++; continue; }
          if (chapterStartRegex.test(nextLine) ||
              /batch\s*plan/i.test(nextLine) ||
              nextLine.startsWith('- Batch') || nextLine.startsWith('- Lot')) {
            break;
          }
          summary += (summary ? ' ' : '') + nextLine;
          i++;
        }
        result.push(summary ? `${line}: ${summary}` : line);
      }
    } else if (/batch\s*plan/i.test(line)) {
      result.push('Batch Plan:');
      i++;
    } else if (/^-\s*(Batch|Lot|Lote)\s+\d+/i.test(line)) {
      result.push(line);
      i++;
    } else {
      i++;
    }
  }

  return result.join('\n');
}

async function parseOutline(outline: string, group_id: string, model: string = 'sonnet'): Promise<{ chapters: Chapter[]; batches: Batch[] }> {
  if (!outline || typeof outline !== 'string' || outline.trim().length === 0) {
    throw new Error('Missing or invalid outline');
  }
  if (!group_id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(group_id)) {
    throw new Error('Missing or invalid group_id');
  }

  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS] || MODEL_CONFIGS.deepseek;
  const maxWordsPerBatch = config.maxWordsPerBatch;

  try {
    // Sanitize markdown formatting before parsing
    const sanitizedOutline = sanitizeOutlineMarkdown(outline);
    const [chapterSection, batchSection] = sanitizedOutline.split('Batch Plan:').map(s => s.trim());
    if (!chapterSection || !batchSection) {
      throw new Error('Outline missing chapters or batch plan');
    }

    const chapterLines = chapterSection.split('\n').filter(line => line.trim());
    const chapters: Chapter[] = [];
    const titleToLogicalNumber: { [key: string]: number } = {};
    let logicalNum = 1;

    for (let i = 0; i < chapterLines.length; i++) {
      const line = chapterLines[i];
      const match = line.match(/^(\d+)\.\s+(.+?)(?:\s*\(Part\s*(\d+)\))?\s*-\s*(\d+)\s*(?:words|Wörter|palabras|mots)\s*:\s*(.+)$/);
      if (match) {
        const index = parseInt(match[1]);
        const chapterTitle = match[2].trim();
        const part = match[3] ? `Part ${match[3]}` : null;
        const wordCount = parseInt(match[4]);
        let summary = match[5].trim();

        // Truncate summary if it's too long
        if (summary.length > MAX_SUMMARY_LENGTH) {
          summary = summary.substring(0, MAX_SUMMARY_LENGTH - 3) + '...';
        }

        if (chapterTitle.toLowerCase().includes('placeholder') || summary.toLowerCase().includes('placeholder')) {
          throw new Error('Outline contains placeholders');
        }
        
        if (!titleToLogicalNumber[chapterTitle]) {
          titleToLogicalNumber[chapterTitle] = logicalNum++;
        }

        chapters.push({
          index: i,
          number: titleToLogicalNumber[chapterTitle],
          title: chapterTitle,
          part,
          word_count: wordCount,
          summary,
          group_id,
        });
      } else {
        console.warn(`Skipping unparsable chapter line: ${line}`);
      }
    }

    if (chapters.length === 0) {
      throw new Error('No valid chapters parsed');
    }

    const batchLines = batchSection.split('\n').filter(line => line.trim().startsWith('- Batch'));
    const batches: Batch[] = [];

    for (const line of batchLines) {
      const match = line.match(/- Batch (\d+): Chapters \[([^\]]*)\], Total Words: (\d+)/);
      if (match) {
        const batchNumber = parseInt(match[1]);
        const chapterIdentifiers = match[2].split(',').map(s => s.trim()).filter(s => s);
        const totalWords = parseInt(match[3]);

        if (totalWords > maxWordsPerBatch) {
          console.warn(`Batch ${batchNumber} exceeds ${maxWordsPerBatch} words: ${totalWords}, skipping`);
          continue;
        }

        const validIdentifiers: string[] = [];
        for (const identifier of chapterIdentifiers) {
          let chapterNum: number;
          let part: string | null = null;

          if (identifier.includes('Part')) {
            const [num, partStr] = identifier.split(' Part ');
            chapterNum = parseInt(num, 10);
            part = `Part ${partStr}`;
          } else {
            chapterNum = parseInt(identifier, 10);
          }

          const matchingChapter = chapters.find(ch =>
            ch.number === chapterNum &&
            (part === null ? !ch.part : ch.part === part)
          );

          if (!matchingChapter) {
            console.warn(`Invalid chapter identifier in batch ${batchNumber}: ${identifier}, skipping`);
            continue;
          }

          validIdentifiers.push(identifier);
        }

        if (validIdentifiers.length > 0) {
          batches.push({
            batch_number: batchNumber,
            chapter_identifiers: validIdentifiers,
            total_words: totalWords,
            group_id,
          });
        } else {
          console.warn(`No valid identifiers in batch ${batchNumber}, skipping`);
        }
      } else {
        console.warn(`Skipping unparsable batch line: ${line}`);
      }
    }

    if (batches.length === 0) {
      throw new Error('No valid batches parsed');
    }

    console.log(`Parsed ${chapters.length} chapters and ${batches.length} batches from outline`);
    return { chapters, batches };
  } catch (error: any) {
    throw new Error(`Failed to parse outline: ${error.message}`);
  }
}

async function updateOutlineTask(group_id: string, user_id: string, batches: Batch[], tab: number = 1): Promise<void> {
  const { error: updateError } = await supabase
    .from('story_tasks')
    .update({
      batch: batches,
      total_batches: batches.length,
      updated_at: new Date().toISOString(),
    })
    .eq('group_id', group_id)
    .eq('user_id', user_id)
    .eq('batch_number', 0)
    .eq('tab', tab);

  if (updateError) {
    throw new Error(`Failed to update outline task with batches: ${updateError.message}`);
  }

  console.log(`Updated outline task with ${batches.length} batches for group ${group_id}, tab ${tab}`);
}

async function createBatchTasks(
  user_id: string,
  group_id: string,
  title: string,
  description: string,
  chapters: Chapter[],
  batches: Batch[],
  total_word_count: number,
  isVideoProcess: boolean = false,
  language: string = 'english',
  model: string = 'sonnet',
  tab: number = 1,
  variant: number = 1,
  pauses: boolean = false,
  masterPrompt?: string | null
): Promise<number> {
  // Read variant and content_type from the outline task (batch_number 0) to ensure consistency
  const { data: outlineTask, error: outlineError } = await supabase
    .from('story_tasks')
    .select('variant, content_type')
    .eq('group_id', group_id)
    .eq('user_id', user_id)
    .eq('tab', tab)
    .eq('batch_number', 0)
    .single();
  
  let finalVariant = variant; // Use passed variant as default
  let contentType = 'story'; // Default content_type
  
  if (!outlineError && outlineTask) {
    // Use the variant from the outline task to ensure all tasks in the group have the same variant
    finalVariant = outlineTask.variant || variant;
    contentType = outlineTask.content_type || 'story';
    console.log(`Using variant ${finalVariant}, content_type '${contentType}' from outline task (batch_number 0)`);
  } else {
    console.warn(`Could not read outline task variant/content_type: ${outlineError?.message}, using passed variant: ${variant}`);
  }
  
  console.log(`Story variant: using=${finalVariant} for group ${group_id}, tab ${tab}`);
  
  const tasks = batches.map(batch => {
    const chapterIdentifiers = batch.chapter_identifiers || [];
    if (!chapterIdentifiers.length) {
      console.warn(`Batch ${batch.batch_number} has no chapter identifiers`);
      return null;
    }

    const identifier = chapterIdentifiers[0];
    let chapterNum: number;
    let part: string | null = null;

    if (identifier.includes('Part')) {
      const [num, partStr] = identifier.split(' Part ');
      chapterNum = parseInt(num, 10);
      part = `Part ${partStr}`;
    } else {
      chapterNum = parseInt(identifier, 10);
    }

    let chapterForBatch = chapters.find(ch =>
      ch.number === chapterNum &&
      (part === null ? !ch.part : ch.part === part)
    );

    if (!chapterForBatch) {
      console.warn(`No chapter found for identifiers: ${chapterIdentifiers}`);
      return null;
    }

    // Ensure summary is not too long for database storage
    const processedChapter = {
      ...chapterForBatch,
      summary: chapterForBatch.summary.length > MAX_SUMMARY_LENGTH ? 
        chapterForBatch.summary.substring(0, MAX_SUMMARY_LENGTH - 3) + '...' : 
        chapterForBatch.summary
    };

    return {
      id: uuidv4(),
      user_id,
      group_id,
      batch: [processedChapter],
      previous_content: null,
      total_word_count: batch.total_words,
      batch_number: batch.batch_number,
      progress: 0,
      status: 'pending',
      story_title: title,
      description,
      total_batches: batches.length,
      is_corrected: false,
      version: 1,
      variant: finalVariant,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      stop_requested: false,
      video_process: isVideoProcess,
      language: language,
      model: model,
      tab: tab,
      pauses: pauses || false,
      master_prompt: masterPrompt || null,
      content_type: contentType,
    };
  }).filter((task): task is NonNullable<typeof task> => task !== null);

  if (tasks.length === 0) {
    throw new Error('No valid tasks created');
  }

  console.log(`Saving ${tasks.length} batch tasks for group ${group_id} in chunks of ${BATCH_INSERT_CHUNK_SIZE} with language: ${language}, model: ${model}, tab: ${tab}`);
  for (let i = 0; i < tasks.length; i += BATCH_INSERT_CHUNK_SIZE) {
    const chunk = tasks.slice(i, i + BATCH_INSERT_CHUNK_SIZE);
    console.log(`Inserting chunk ${i / BATCH_INSERT_CHUNK_SIZE + 1} with ${chunk.length} tasks`);
    const { error: insertError } = await supabase
      .from('story_tasks')
      .insert(chunk);

    if (insertError) {
      throw new Error(`Failed to insert batch tasks chunk ${i / BATCH_INSERT_CHUNK_SIZE + 1}: ${insertError.message}`);
    }
  }

  console.log(`Successfully saved ${tasks.length} batch tasks with video_process: ${isVideoProcess}, language: ${language}, model: ${model}, tab: ${tab}`);
  
  return finalVariant;
}

async function triggerNextBatch(group_id: string, user_id: string, current_batch_number: number, tab: number = 1, variant: number = 1): Promise<void> {
  let retries = 0;
  let delay = INITIAL_RETRY_DELAY;

  while (retries < MAX_RETRIES) {
    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/trigger-next-batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify({
          group_id,
          user_id,
          current_batch_number,
          tab,
          variant,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: Failed to trigger next batch`);
      }

      console.log(`Triggered next batch for group ${group_id}, batch ${current_batch_number}, tab ${tab}, variant ${variant}`);
      return;
    } catch (error: any) {
      retries++;
      if (retries >= MAX_RETRIES) {
        throw new Error(`Failed to trigger next batch after ${MAX_RETRIES} attempts: ${error.message}`);
      }
      console.warn(`Retry ${retries}/${MAX_RETRIES} for triggerNextBatch: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

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

Deno.serve(async (req: Request) => {
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
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin } }
    );
  }

  let rawBody = '';
  let payload: any;

  try {
    rawBody = await req.text();
    console.log('Raw request body:', rawBody);

    // Verify authentication
    const _authHeader = req.headers.get('Authorization');
    const _authToken = _authHeader?.startsWith('Bearer ') ? _authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!_authToken) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization' }),
        { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin } }
      );
    }    // authToken resolved above (Bearer or apikey)
    let _authenticatedUserId: string | null = null;

    if (_authToken === supabaseServiceRoleKey || _authToken === supabaseSecretKey) {
      // Service call or backward-compatible frontend call
      // TODO: Remove supabaseKey check after frontend deploys with JWT auth
    } else {
      const { data: { user: _authUser }, error: _authErr } = await supabase.auth.getUser(_authToken);
      if (_authErr || !_authUser) {
        return new Response(
          JSON.stringify({ error: 'Invalid or expired token' }),
          { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin } }
        );
      }
      _authenticatedUserId = _authUser.id;
    }

    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      console.error('Failed to parse request body as JSON:', e.message);
      return new Response(
        JSON.stringify({ error: 'Invalid JSON payload' }),
        { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin } }
      );
    }

    // When JWT auth is used, override body user_id with authenticated user
    if (_authenticatedUserId && payload.user_id) {
      payload.user_id = _authenticatedUserId;
    }

    const { group_id, user_id, title, description, total_word_count, language = 'english', model = 'sonnet', tab = 1, variant = 1, pauses = false } = payload;

    if (!group_id || !user_id || !title || !description || !total_word_count) {
      console.error('Missing required fields in payload:', { group_id, user_id, title, description, total_word_count });
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin } }
      );
    }

    // Validate language
    const supportedLanguages = ['english', 'german', 'spanish', 'french'];
    const validatedLanguage = supportedLanguages.includes(language) ? language : 'english';

    // Validate model
    const supportedModels = ['deepseek', 'sonnet', 'opus'];
    const validatedModel = supportedModels.includes(model) ? model : 'sonnet';

    const { data: tasks, error: fetchError } = await supabase
      .from('story_tasks')
      .select('id, outline, video_process, language, model, master_prompt')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('batch_number', 0)
      .eq('tab', tab)
      .limit(1);

    if (fetchError) {
      console.error('Error fetching outline task:', fetchError.message);
      return new Response(
        JSON.stringify({ error: `Failed to fetch outline task: ${fetchError.message}` }),
        { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin } }
      );
    }

    if (!tasks || tasks.length === 0 || !tasks[0].outline) {
      console.error('No outline task found or outline is empty');
      return new Response(
        JSON.stringify({ error: 'No outline task found or outline is empty' }),
        { status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin } }
      );
    }

    const outline = tasks[0].outline;
    const isVideoProcess = tasks[0].video_process || false;
    const taskLanguage = tasks[0].language || validatedLanguage;
    const taskModel = tasks[0].model || validatedModel;

    console.log(`Processing outline for group ${group_id}, video_process: ${isVideoProcess}, language: ${taskLanguage}, model: ${taskModel}, tab: ${tab}`);

    const { chapters, batches } = await parseOutline(outline, group_id, taskModel);

    const totalWords = chapters.reduce((sum, ch) => sum + ch.word_count, 0);
    const batchTotalWords = batches.reduce((sum, b) => sum + b.total_words, 0);
    
    // Adjust validation tolerance based on word count
    const wordCountTolerance = total_word_count > 100000 ? 1000 : (total_word_count > 10000 ? 1000 : 1000);

    
    if (totalWords !== batchTotalWords || Math.abs(totalWords - total_word_count) > wordCountTolerance) {
      throw new Error(`Mismatch in word counts: chapters (${totalWords}) vs. batches (${batchTotalWords}) vs. requested (${total_word_count}), tolerance: ±${wordCountTolerance}`);
    }

    await updateOutlineTask(group_id, user_id, batches, tab);

    const taskMasterPrompt = tasks[0].master_prompt || null;
    const finalVariant = await createBatchTasks(user_id, group_id, title, description, chapters, batches, total_word_count, isVideoProcess, taskLanguage, taskModel, tab, variant, pauses, taskMasterPrompt);

    await triggerNextBatch(group_id, user_id, 0, tab, finalVariant);

    return new Response(
      JSON.stringify({ 
        message: 'Outline parsed, batch tasks created, and outline task updated successfully',
        video_process: isVideoProcess,
        language: taskLanguage,
        model: taskModel,
        tab: tab
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin } }
    );
  } catch (error: any) {
    console.error('Error in storyscriptai-parse:', error.message, { rawBody, stack: error.stack });
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin } }
    );
  }
});



