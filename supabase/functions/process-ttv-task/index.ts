
import { createClient } from 'npm:@supabase/supabase-js@2';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TTVSegment {
  text: string;
  start: number;
  video_duration: number;
}

interface TTVTask {
  id: string;
  user_id: string;
  group_id: string;
  story_title: string;
  description: string;
  batch: TTVSegment[];
  text_part: string;
  batch_output: string;
  total_batches: number;
  batch_number: number;
  total_prompts: number;
  total_videos: number;
  status: string;
  progress: number;
  error: null | string;
  settings: {
    style: string;
    useCharacterDescriptions: boolean;
    characters: Record<string, string>;
    video_model: string;
    video_duration: number;
  };
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
  video_process: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BATCH_SIZE = 2;         // Segments per batch
const TASK_INSERT_CHUNK = 20; // Rows per DB insert call
const BATCH_DELAY_MS = 500;
const MAX_RETRIES = 3;
const MAX_TEXT_PART_CHARS = 56000;
const MIN_TEXT_PART_LENGTH = 50;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SECRET_KEY") || ""
);

// ─── Text utilities ───────────────────────────────────────────────────────────

function calculateWordCount(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function normalizeText(text: string): string {
  if (!text) return text;
  // Strip SSML break tags (well-formed, malformed, and incomplete)
  text = text.replace(/<break\b[^>]*?\/?>/gi, '');
  text = text.replace(/<break\b[^>]*$/gm, '');
  text = text.replace(/^\s*["'\u2018\u2019\u201C\u201D]?\d+ms["'\u2018\u2019\u201C\u201D]?\s*\/?>/gm, '');
  let n = text
    .replace(/\uFFFD/g, "'").replace(/â€™/g, "'").replace(/â€œ/g, '"')
    .replace(/â€\u009D/g, '"').replace(/â€"/g, '—').replace(/â€"/g, '–')
    .replace(/â€¦/g, '…').replace(/Ã¢â‚¬â„¢/g, "'").replace(/Ã¢â‚¬Å"/g, '"')
    .replace(/Ã¢â‚¬Â/g, '"').replace(/Ã¢â‚¬â€œ/g, '—')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u2039\u203A]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/'/g, "'").replace(/'/g, "'").replace(/"/g, '"').replace(/"/g, '"')
    .replace(/[\u2010\u2011\u2012]/g, '-').replace(/\u2015/g, '—')
    .replace(/\u2026/g, '...').replace(/\u00A0/g, ' ');
  n = n.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(l => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return n;
}

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

function cleanTextForTTV(text: string): string {
  const lines = text.split('\n');
  const chapterPattern = /^\*\*Chapter \d+.*\*\*$/;
  const cleanedLines: string[] = [];
  let skipFirst = true;

  for (const line of lines) {
    if (chapterPattern.test(line.trim())) continue;
    if (skipFirst && line.trim() && !line.trim().startsWith('**')) {
      skipFirst = false;
      continue;
    }
    skipFirst = false;
    cleanedLines.push(line);
  }

  return normalizeText(cleanedLines.join('\n').trim());
}

function splitTextIfLarge(text: string): string[] {
  if (text.length <= MAX_TEXT_PART_CHARS) {
    if (text.length < MIN_TEXT_PART_LENGTH) return [];
    return [text];
  }
  const parts: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + MAX_TEXT_PART_CHARS, text.length);
    while (end > pos && !/\n\n|\. /.test(text.slice(end - 1, end + 1))) end--;
    if (end <= pos) end = Math.min(pos + MAX_TEXT_PART_CHARS, text.length);
    const part = text.slice(pos, end).trim();
    if (part.length >= MIN_TEXT_PART_LENGTH) parts.push(part);
    else if (part.length > 0 && parts.length > 0) parts[parts.length - 1] += '\n\n' + part;
    pos = end;
  }
  return parts.filter(p => p.trim().length >= MIN_TEXT_PART_LENGTH);
}

// ─── Segmentation ─────────────────────────────────────────────────────────────

/**
 * Finds the best position to split text near targetPos.
 * Priority: sentence boundary → paragraph boundary → word boundary (backward walk).
 * Search radii are scaled to idealSize so short segments aren't over-searched.
 * Always returns a position that is NOT mid-word.
 */
function findTTVSplitPoint(text: string, targetPos: number, minPos: number = 0, idealSize?: number): number {
  if (targetPos >= text.length) return text.length;
  if (targetPos <= minPos) return minPos;

  // Scale search windows proportionally to segment size (caps at legacy values for long segments)
  const sentenceRadius = idealSize && idealSize > 0
    ? Math.max(10, Math.min(Math.floor(idealSize * 0.20), 100))
    : 100;
  const paraRadius = idealSize && idealSize > 0
    ? Math.max(15, Math.min(Math.floor(idealSize * 0.35), 200))
    : 200;

  // 1. Sentence boundaries within sentenceRadius chars
  const sentenceEnds = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
  for (let offset = 0; offset < sentenceRadius; offset++) {
    const fwd = targetPos + offset;
    if (fwd < text.length && sentenceEnds.includes(text.slice(fwd - 1, fwd + 1))) return fwd;
    const bwd = targetPos - offset;
    if (bwd > minPos && sentenceEnds.includes(text.slice(bwd - 1, bwd + 1))) return bwd;
  }

  // 2. Paragraph boundaries within paraRadius chars
  for (let offset = 0; offset < paraRadius; offset++) {
    const fwd = targetPos + offset;
    if (fwd < text.length && text.slice(fwd - 1, fwd + 1) === '\n\n') return fwd;
    const bwd = targetPos - offset;
    if (bwd > minPos && text.slice(bwd - 1, bwd + 1) === '\n\n') return bwd;
  }

  // 3. Word boundary — walk backward until we're not mid-word, but not below minPos
  let pos = targetPos;
  while (pos > minPos && /[a-zA-Z0-9]/.test(text[pos - 1]) && /[a-zA-Z0-9]/.test(text[pos])) {
    pos--;
  }
  return pos > minPos ? pos : targetPos;
}

function forceExactSegments(text: string, n: number, videoDuration: number): TTVSegment[] {
  if (n <= 0) return [];
  const trimmed = text.trim();
  if (!trimmed) {
    return Array.from({ length: n }, () => ({ text: '', start: 0, video_duration: videoDuration }));
  }
  if (n === 1) return [{ text: trimmed, start: 0, video_duration: videoDuration }];

  const segments: TTVSegment[] = [];
  const textLength = trimmed.length;
  // Precompute ideal segment size so the split-point search radius stays proportional
  const idealSize = textLength / n;
  let currentPos = 0;

  for (let i = 0; i < n; i++) {
    // Skip leading whitespace so segments always start at real content,
    // preventing the backward scan from re-finding the previous sentence boundary.
    while (currentPos < textLength && /\s/.test(trimmed[currentPos])) {
      currentPos++;
    }

    if (i === n - 1 || currentPos >= textLength) {
      // Last segment (or text exhausted): take everything remaining
      const segText = trimmed.slice(currentPos).trim();
      segments.push({ text: segText || 'Content segment', start: currentPos, video_duration: videoDuration });
      break;
    } else {
      // Proportional target based on remaining text and remaining segments
      const remaining = textLength - currentPos;
      const remainingSegs = n - i;
      const targetEnd = currentPos + Math.round(remaining / remainingSegs);
      const actualEnd = Math.max(currentPos + 1, Math.min(findTTVSplitPoint(trimmed, targetEnd, currentPos, idealSize), textLength - (remainingSegs - 1)));

      const segText = trimmed.slice(currentPos, actualEnd).trim();
      segments.push({ text: segText || 'Content segment', start: currentPos, video_duration: videoDuration });
      currentPos = actualEnd;
    }
  }

  // Guarantee exactly n segments (safety pad)
  while (segments.length < n) {
    const last = segments[segments.length - 1];
    segments.push({ text: last?.text ?? 'Content segment', start: last?.start ?? 0, video_duration: videoDuration });
  }
  return segments.slice(0, n);
}

// ─── Task insertion ───────────────────────────────────────────────────────────

async function insertTTVTasksInChunks(tasks: TTVTask[], startTime: number, maxRuntime: number) {
  console.log(`Inserting ${tasks.length} TTV tasks`);
  for (let i = 0; i < tasks.length; i += TASK_INSERT_CHUNK) {
    if (Date.now() - startTime > maxRuntime * 0.9) throw new Error(`Runtime limit hit at task ${i}`);
    const chunk = tasks.slice(i, i + TASK_INSERT_CHUNK);
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const { error } = await supabase.from('TTV_prompt_tasks').insert(chunk);
        if (error) throw new Error(`DB insert failed at ${i}: ${error.message}`);
        console.log(`Inserted TTV tasks ${i + 1}–${i + chunk.length}`);
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

async function triggerFirstBatch(group_id: string, user_id: string, tab: number, variant: number) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SECRET_KEY") || "";

  const response = await fetch(`${supabaseUrl}/functions/v1/trigger-next-TTV-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': serviceKey,},
    body: JSON.stringify({ group_id, user_id, current_batch_number: 0, tab, variant }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to trigger first TTV batch: HTTP ${response.status} - ${errText}`);
  }
  console.log(`Triggered first TTV batch for group=${group_id}, tab=${tab}, variant=${variant}`);
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
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': corsOrigin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", 'Access-Control-Allow-Origin': corsOrigin },
    });
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get('Authorization');
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!authToken) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { "Content-Type": "application/json", 'Access-Control-Allow-Origin': corsOrigin },
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
          headers: { "Content-Type": "application/json", 'Access-Control-Allow-Origin': corsOrigin },
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

    // ── Read job_data ─────────────────────────────────────────────────────────

    const { data: jobData, error: jobError } = await supabase
      .from('job_data')
      .select('data')
      .eq('id', jobId)
      .eq('user_id', user_id)
      .single();

    if (jobError || !jobData) throw new Error(`Failed to fetch TTV job data: ${jobError?.message ?? 'Not found'}`);

    const {
      textParts,       // Array of part number strings ["1", "2", ...]
      group_id,
      file_path,
      story_title,
      description,
      style,
      video_model,
      video_duration,
      total_videos,    // Math.floor(totalAudioDuration / video_duration) — pre-computed in setup
      useCharacterDescriptions,
      variant,
      characters = {},
      totalInputTokens = 0,
      totalOutputTokens = 0,
      is_corrected = false,
      userTokenBalance,
      language,
      model,
      tab = 1,
      masterPromptData,
      environmentOnlyMode = false,
      audio_clip = false,
      high_res = false,
      videoProcess = false,
    } = jobData.data;

    // ── Validate required fields ───────────────────────────────────────────────

    if (!group_id || !uuidRegex.test(group_id)) throw new Error('Invalid group_id in job data');
    if (!file_path || typeof file_path !== 'string') throw new Error('Invalid file_path in job data');
    if (!story_title || typeof story_title !== 'string') throw new Error('Invalid story_title in job data');
    if (!description || typeof description !== 'string') throw new Error('Invalid description in job data');
    if (!style || typeof style !== 'string') throw new Error('Invalid style in job data');
    if (!video_model || typeof video_model !== 'string') throw new Error('Invalid video_model in job data');
    if (typeof video_duration !== 'number' || video_duration <= 0) throw new Error('Invalid video_duration in job data');
    if (typeof total_videos !== 'number' || total_videos < 1) throw new Error('Invalid total_videos in job data');
    if (!Array.isArray(textParts) || textParts.length === 0) throw new Error('Invalid textParts in job data');
    if (typeof variant !== 'number') throw new Error('Invalid variant in job data');
    if (typeof userTokenBalance !== 'number') throw new Error('Invalid userTokenBalance in job data');

    const validatedModel = ['deepseek', 'sonnet', 'opus'].includes(model || '') ? model : 'sonnet';
    const validatedLanguage = ['english', 'german', 'spanish', 'french'].includes(language || '') ? language : 'english';

    // ── Prevent duplicate runs ────────────────────────────────────────────────

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from('TTV_prompt_tasks')
      .select('*', { count: 'exact', head: true })
      .eq('group_id', group_id)
      .eq('variant', variant)
      .eq('tab', tab)
      .gte('created_at', fiveMinutesAgo);

    if (count && count > 0) {
      console.log(`TTV processing already in progress: group=${group_id}, variant=${variant}, tab=${tab}, count=${count}`);
      return new Response(JSON.stringify({ error: `TTV processing already in progress for variant ${variant}` }), {
        status: 409,
        headers: { "Content-Type": "application/json", 'Access-Control-Allow-Origin': corsOrigin },
      });
    }

    // ── Fetch all text parts from TTV_prompt_context ──────────────────────────

    const contextRows: Record<number, string> = {};
    for (const partStr of textParts) {
      const partNum = parseInt(partStr, 10);
      if (isNaN(partNum)) continue;

      const { data: ctxData, error: ctxError } = await supabase
        .from('TTV_prompt_context')
        .select('full_story_text')
        .eq('group_id', group_id)
        .eq('part_number', partNum)
        .eq('tab', tab)
        .single();

      if (ctxError || !ctxData) throw new Error(`Failed to fetch TTV context part ${partNum}: ${ctxError?.message ?? 'Not found'}`);
      contextRows[partNum] = ctxData.full_story_text;
    }

    // ── Calculate per-part video counts ───────────────────────────────────────

    const partTexts = Object.entries(contextRows).sort(([a], [b]) => Number(a) - Number(b)).map(([, t]) => t);
    const totalChars = partTexts.reduce((sum, t) => sum + t.length, 0);

    // ── Build TTV task rows ───────────────────────────────────────────────────

    const allTasks: TTVTask[] = [];
    let globalBatchNumber = 0;
    let globalPromptCount = 0;

    for (let partIdx = 0; partIdx < textParts.length; partIdx++) {
      const partNum = parseInt(textParts[partIdx], 10);
      const partText = contextRows[partNum];
      if (!partText) { console.log(`Part ${partNum} not found, skipping`); continue; }

      // Split into sub-parts if oversized
      const subParts = splitTextIfLarge(partText);
      if (subParts.length === 0) { console.log(`Part ${partNum} too small, skipping`); continue; }

      for (let subIdx = 0; subIdx < subParts.length; subIdx++) {
        const subText = subParts[subIdx];

        // Proportional share of total_videos for this sub-part
        const ratio = totalChars > 0 ? subText.length / totalChars : 1 / textParts.length;
        const subVideos = Math.max(1, Math.round(total_videos * ratio));

        console.log(`Part ${partNum}.${subIdx + 1}: ${subText.length} chars, ${subVideos} videos`);

        const rawSegments = forceExactSegments(subText, subVideos, video_duration);
        // Sanitize segment text to prevent AI JSON echo issues
        const segments = rawSegments.map(s => ({ ...s, text: sanitizeSegmentText(s.text) }));
        if (segments.length === 0) { console.log(`No segments for part ${partNum}.${subIdx + 1}, skipping`); continue; }

        globalPromptCount += segments.length;

        // Group segments into batches of BATCH_SIZE
        const batches: TTVSegment[][] = [];
        for (let b = 0; b < segments.length; b += BATCH_SIZE) {
          batches.push(segments.slice(b, b + BATCH_SIZE));
        }

        for (let bIdx = 0; bIdx < batches.length; bIdx++) {
          const batchNumber = globalBatchNumber + 1;
          const taskId = crypto.randomUUID();
          const isFirst = batchNumber === 1;

          const task: TTVTask = {
            id: taskId,
            user_id,
            group_id,
            story_title,
            description,
            batch: batches[bIdx],
            text_part: String(partNum),
            batch_output: '',
            total_batches: 0,           // Filled in after globalBatchNumber is known
            batch_number: batchNumber,
            total_prompts: globalPromptCount,
            total_videos,
            status: isFirst ? 'queued' : 'pending',
            progress: 0,
            error: null,
            settings: {
              style,
              useCharacterDescriptions,
              characters,
              video_model,
              video_duration,
              high_res,
            },
            variant,
            file_path,
            input_tokens: 0,
            output_tokens: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            version: is_corrected ? 13 : 12,
            language: validatedLanguage,
            model: validatedModel,
            video_model,
            video_duration,
            tab,
            is_corrected,
            audio_clip,
            video_process: videoProcess,
          };

          allTasks.push(task);
          globalBatchNumber++;
        }
      }
    }

    if (allTasks.length === 0) throw new Error('No valid TTV tasks could be created');

    // Backfill total_batches
    for (const t of allTasks) t.total_batches = globalBatchNumber;

    // Update job_data with final counts
    await supabase.from('job_data').update({
      data: { ...jobData.data, totalBatches: globalBatchNumber, totalPrompts: globalPromptCount },
    }).eq('id', jobId);

    // ── Insert all task rows ──────────────────────────────────────────────────

    await insertTTVTasksInChunks(allTasks, startTime, maxRuntime);

    // ── Update video_tasks.image_amount with actual TTV clip count ─────────
    // This lets the frontend use it for accurate time estimation on page reload
    const { error: imgAmtErr } = await supabase
      .from('video_tasks')
      .update({ image_amount: total_videos, updated_at: new Date().toISOString() })
      .eq('group_id', group_id)
      .eq('is_main', true);
    if (imgAmtErr) console.error(`Failed to update image_amount on video_tasks: ${imgAmtErr.message}`);
    else console.log(`Updated video_tasks.image_amount = ${total_videos} for group ${group_id}`);

    // Ensure first task is queued
    const firstTask = allTasks.find(t => t.batch_number === 1);
    if (firstTask) {
      await supabase.from('TTV_prompt_tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString() })
        .eq('id', firstTask.id);
      console.log(`Queued first TTV task id=${firstTask.id}`);
    }

    // ── Trigger first prompt batch ────────────────────────────────────────────

    await triggerFirstBatch(group_id, user_id, tab, variant);

    // ── Clean up job_data ─────────────────────────────────────────────────────

    const { error: delError } = await supabase.from('job_data').delete().eq('id', jobId);
    if (delError) console.error(`Failed to delete TTV job data: ${delError.message}`);
    else console.log(`Deleted TTV job data ${jobId}`);

    return new Response(JSON.stringify({
      task_ids: allTasks.map(t => t.id),
      total_batches: globalBatchNumber,
      total_prompts: globalPromptCount,
      total_videos,
      language: validatedLanguage,
      model: validatedModel,
      tab,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", 'Access-Control-Allow-Origin': corsOrigin },
    });

  } catch (error: any) {
    console.error(`Error in process-TTV-task: ${error.message}`);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", 'Access-Control-Allow-Origin': corsOrigin },
    });
  }
});



