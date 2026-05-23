// generate-MG-prompt/index.ts
// =============================================================================
// CODEGEN-PIPELINE prompt generator for Motion Graphics.
//
// For each segment in the incoming batch, this function produces a single rich
// "motion_graphic_prompt" — a vivid 4–8 sentence description of one Remotion
// clip — which is later handed verbatim to the mg-codegen-worker Lambda
// (Claude Opus → TSX → esbuild → renderMediaOnLambda).
//
// Mirrors the contextual-prompting pattern used by generate-image-prompts:
//   1. Fetch full story context from `MG_prompt_context` (group_id + part_number).
//   2. Fetch the last 3 *already-generated* `motion_graphic_prompt`s in the
//      same group (sequential context — what came before).
//   3. Fetch the next 3 *pending* raw segment texts (planning context — what's
//      coming next), plus a one-line outline of the rest of the story.
//   4. Call Claude Opus (default) or DeepSeek (fallback) once per batch with
//      ALL of that context, and produce { items: [{ motion_graphic_prompt }] }.
//   5. Write `[{ text, inputProps: { motion_graphic_prompt, style_guidance,
//      video_duration, user_prompt } }, ...]` to MG_prompt_tasks.batch_output.
//
// Output schema is intentionally compatible with the existing
// process-MG-prompt → setup-MG-tasks → MG_tasks chain.
// =============================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const deepseekApiKey = Deno.env.get('DEEPSEEK_API_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// ─── Constants ───────────────────────────────────────────────────────────────
const TOKEN_PER_WORD = 1.33;
const CONTEXT_PREV_CLIPS = 3;
const CONTEXT_NEXT_CLIPS = 3;
const FULL_STORY_MAX_CHARS = 18_000; // hard cap to keep prompt size sane
const OUTLINE_MAX_CHARS = 4_000;

function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter((w) => w.length > 0).length * TOKEN_PER_WORD);
}

async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    await supabase.from('error_logs').insert({
      message,
      details: error?.message || JSON.stringify(error),
      created_at: new Date().toISOString(),
    });
  } catch (_) {
    /* silent */
  }
}

// ─── JSON cleaning (reused from generate-TTV-prompt / image-prompts) ─────────
function cleanAndParseJSON(raw: string): any {
  let s = raw.trim();
  if (s.startsWith('```json')) s = s.slice(7);
  if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  s = s.trim();

  const stripBackslashes = (str: string) => str.replace(/\\(?!["\\/bfnrtu])/g, '');
  const escapeBackslashes = (str: string) => str.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');

  const attempts: Array<() => string> = [
    () => s,
    () => escapeBackslashes(s),
    () => stripBackslashes(s),
  ];

  const arrMatch = s.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    const arr = arrMatch[0];
    attempts.push(() => arr, () => escapeBackslashes(arr), () => stripBackslashes(arr));
  }
  const objMatch = s.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const obj = objMatch[0];
    attempts.push(() => obj, () => escapeBackslashes(obj), () => stripBackslashes(obj));
  }

  let lastErr: any = null;
  for (const make of attempts) {
    try { return JSON.parse(make()); } catch (e) { lastErr = e; }
  }
  throw new Error(`JSON parse failed: ${lastErr?.message ?? 'unknown'}`);
}

// ─── Context fetchers ────────────────────────────────────────────────────────

/**
 * Fetch the full story context for this MG group.
 * Mirrors fetchFullContext in generate-image-prompts/index.ts. Supports
 * per-part rows for very long stories (>~11k words).
 */
async function fetchFullContext(groupId: string, partNumber: number, tab: number) {
  const tryFetch = async (filters: Record<string, any>) => {
    let q = supabase.from('MG_prompt_context').select('*').eq('group_id', groupId);
    for (const [k, v] of Object.entries(filters)) {
      q = v === null ? q.is(k, null) : q.eq(k, v);
    }
    const { data, error } = await q.limit(1).maybeSingle();
    if (error) {
      console.log(`MG_prompt_context fetch error (${JSON.stringify(filters)}): ${error.message}`);
      return null;
    }
    return data;
  };

  // 1. Exact match on (group_id, part_number, tab)
  let ctx = await tryFetch({ part_number: partNumber, tab });
  // 2. Match on (group_id, part_number) only
  if (!ctx) ctx = await tryFetch({ part_number: partNumber });
  // 3. Legacy: row exists with null part_number
  if (!ctx) ctx = await tryFetch({ part_number: null });
  // 4. Last resort: any row for this group
  if (!ctx) {
    const { data } = await supabase
      .from('MG_prompt_context')
      .select('*')
      .eq('group_id', groupId)
      .order('part_number', { ascending: true, nullsFirst: true })
      .limit(1)
      .maybeSingle();
    ctx = data ?? null;
  }
  if (ctx) {
    console.log(
      `MG context loaded (group=${groupId} part=${ctx.part_number ?? 'null'}): ` +
      `${ctx.full_story_text?.length ?? 0} chars, style=${ctx.style_slug}`,
    );
  } else {
    console.log(`MG context not found for group=${groupId}`);
  }
  return ctx;
}

/**
 * Pull the last N previously-generated motion_graphic_prompt entries
 * (across batches with lower batch_number) for sequential continuity.
 */
async function fetchPriorPrompts(
  groupId: string,
  userId: string,
  tab: number,
  variant: number,
  currentBatchNumber: number,
  limit: number,
): Promise<Array<{ batch_number: number; index: number; text: string; motion_graphic_prompt: string }>> {
  if (currentBatchNumber <= 1) return [];
  const { data, error } = await supabase
    .from('MG_prompt_tasks')
    .select('batch_number, batch_output')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('tab', tab)
    .eq('variant', variant)
    .lt('batch_number', currentBatchNumber)
    .in('status', ['completed', 'completed_final'])
    .order('batch_number', { ascending: false })
    .limit(limit + 2); // a couple extra in case some batches contain multiple items
  if (error || !data) {
    console.log(`fetchPriorPrompts error: ${error?.message ?? 'no data'}`);
    return [];
  }
  const all: Array<{ batch_number: number; index: number; text: string; motion_graphic_prompt: string }> = [];
  for (const row of data) {
    if (!row.batch_output) continue;
    let parsed: any;
    try { parsed = JSON.parse(row.batch_output); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    for (const item of parsed) {
      const ip = item?.inputProps ?? {};
      const mgp = (ip.motion_graphic_prompt as string) || (ip.motionGraphicPrompt as string) || '';
      if (!mgp) continue;
      all.push({
        batch_number: row.batch_number,
        index: typeof item.index === 'number' ? item.index : 0,
        text: typeof item.text === 'string' ? item.text : '',
        motion_graphic_prompt: mgp,
      });
    }
  }
  // Most-recent first → take `limit` then reverse so the prompt reads
  // chronologically (oldest of the slice first, then progressing).
  all.sort((a, b) => (b.batch_number - a.batch_number) || (b.index - a.index));
  return all.slice(0, limit).reverse();
}

/**
 * Look at upcoming pending batches to give the LLM a sense of where the story
 * is going. Returns raw segment texts (NOT yet generated motion_graphic_prompts).
 */
async function fetchUpcomingSegments(
  groupId: string,
  userId: string,
  tab: number,
  variant: number,
  currentBatchNumber: number,
  limit: number,
): Promise<{ next: Array<{ batch_number: number; index: number; text: string }>; rest_outline: string }> {
  const { data, error } = await supabase
    .from('MG_prompt_tasks')
    .select('batch_number, batch')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('tab', tab)
    .eq('variant', variant)
    .gt('batch_number', currentBatchNumber)
    .order('batch_number', { ascending: true })
    .limit(60);
  if (error || !data) return { next: [], rest_outline: '' };

  const flat: Array<{ batch_number: number; index: number; text: string }> = [];
  for (const row of data) {
    const batch = Array.isArray(row.batch) ? row.batch : [];
    for (const seg of batch) {
      flat.push({
        batch_number: row.batch_number,
        index: typeof seg.index === 'number' ? seg.index : 0,
        text: typeof seg.text === 'string' ? seg.text : '',
      });
    }
  }
  const next = flat.slice(0, limit);
  const rest = flat.slice(limit);
  // Build a compact one-line-per-segment outline of the remaining story.
  const outlineLines: string[] = [];
  let totalLen = 0;
  for (const seg of rest) {
    const oneLine = seg.text.replace(/\s+/g, ' ').slice(0, 140);
    const line = `  #${seg.index}: ${oneLine}${seg.text.length > 140 ? '…' : ''}`;
    if (totalLen + line.length > OUTLINE_MAX_CHARS) break;
    outlineLines.push(line);
    totalLen += line.length + 1;
  }
  return { next, rest_outline: outlineLines.join('\n') };
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

function buildSystemPrompt(language: string, videoDuration: number, styleGuidance: string): string {
  return `You are a senior motion designer writing **clip briefs** for a code-generation pipeline.

For each story segment in the input batch you must produce ONE vivid, specific
"motion_graphic_prompt" — a 4–8 sentence description of a single Remotion
motion-graphic clip that runs ~${videoDuration} seconds at 30fps. A downstream
LLM (Claude Opus) will translate your brief directly into TSX code, so be
concrete: name the elements that appear on screen, the animation beats per
~second, the palette (use hex codes when describing colors), the typography
intent, the camera/transition language, and the pacing. Never speak in
abstractions — write like a director's shot-list.

OUTPUT LANGUAGE: ${language}. Write the motion_graphic_prompt in ${language}.

OUTPUT WRAPPER (STRICT JSON, NO PROSE, NO MARKDOWN):
{ "items": [
    { "motion_graphic_prompt": "..." },
    { "motion_graphic_prompt": "..." }
] }

The "items" array length MUST equal the input segments length, in the same
order. Each item is a single object with ONE key: "motion_graphic_prompt".

STYLE DIRECTION (apply to EVERY clip — this defines the visual identity of
the whole sequence; deviating breaks visual cohesion):
${styleGuidance.trim() || '(no specific style guidance provided — use a clean modern motion-graphics aesthetic with a dark background and one accent color)'}

CRITICAL RULES:
1. Output ONLY the { "items": [...] } JSON object. No fences. No commentary.
2. Each motion_graphic_prompt is plain prose (no markdown, no bullet lists,
   no JSON inside the string). Use straight ASCII quotes only.
3. Describe what appears on screen, in what order, and how each element
   animates. Aim for ~120–220 words per clip.
4. Do NOT invent facts that aren't in the segment text or wider story context.
5. Do NOT include any unsafe content (violence, hate, sexual, self-harm,
   illegal acts, real-person defamation). Frame visuals abstractly when the
   source text is sensitive.
6. Reference visual continuity with the previous clips when relevant
   (e.g. "the same teal accent color carries over from the prior clip"),
   but each clip must be a complete standalone scene.
7. JSON string safety: the only allowed backslash sequences inside string
   values are \\" \\\\ \\/ \\n \\r \\t \\b \\f \\uXXXX. Never emit any other
   backslash sequence.
`;
}

function buildUserPrompt(args: {
  storyTitle: string;
  fullStory: string;
  styleGuidance: string;
  videoDuration: number;
  currentBatchNumber: number;
  totalBatches: number;
  priorPrompts: Array<{ batch_number: number; index: number; text: string; motion_graphic_prompt: string }>;
  upcoming: { next: Array<{ batch_number: number; index: number; text: string }>; rest_outline: string };
  segments: Array<{ index: number; text: string }>;
}): string {
  const {
    storyTitle, fullStory, videoDuration,
    currentBatchNumber, totalBatches,
    priorPrompts, upcoming, segments,
  } = args;

  const fullStoryClipped = fullStory.length > FULL_STORY_MAX_CHARS
    ? fullStory.slice(0, FULL_STORY_MAX_CHARS) + '\n\n[...story continues, truncated for brevity...]'
    : fullStory;

  const priorBlock = priorPrompts.length === 0
    ? '(none — this is the first batch in the sequence)'
    : priorPrompts.map((p) =>
        `--- Clip #${p.index} (batch ${p.batch_number}) ---\n` +
        `Source text: ${p.text.slice(0, 220)}${p.text.length > 220 ? '…' : ''}\n` +
        `Already-generated brief: ${p.motion_graphic_prompt}`,
      ).join('\n\n');

  const nextBlock = upcoming.next.length === 0
    ? '(none — this batch ends the sequence)'
    : upcoming.next.map((s) =>
        `  Clip #${s.index} (batch ${s.batch_number}) — source text: ${s.text.slice(0, 220)}${s.text.length > 220 ? '…' : ''}`,
      ).join('\n');

  const restBlock = upcoming.rest_outline.trim() || '(none beyond the next clips listed above)';

  const segmentsBlock = segments.map((s) =>
    `--- SEGMENT #${s.index} ---\n${s.text}`,
  ).join('\n\n');

  return `Story title: ${storyTitle}
Total clips in this sequence: ${totalBatches} batches (this is batch ${currentBatchNumber}/${totalBatches}).
Clip duration: ${videoDuration}s @ 30fps.

================================================================================
FULL STORY (for context — do NOT invent beyond it):
================================================================================
${fullStoryClipped}

================================================================================
PREVIOUS CLIPS (already generated — maintain visual continuity):
================================================================================
${priorBlock}

================================================================================
UPCOMING CLIPS (raw source text — what comes after this batch):
================================================================================
${nextBlock}

REST-OF-STORY OUTLINE (one line per remaining clip):
${restBlock}

================================================================================
THIS BATCH — WRITE A motion_graphic_prompt FOR EACH SEGMENT BELOW:
================================================================================
${segmentsBlock}

Return the JSON object { "items": [...] } now. items.length must equal ${segments.length}.`;
}

// ─── LLM callers ─────────────────────────────────────────────────────────────

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  model: 'opus' | 'sonnet',
): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
  if (!anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const modelId = model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 16_000,
      temperature: 0.6,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic ${modelId} HTTP ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const content = blocks
    .filter((b: any) => b?.type === 'text' && typeof b?.text === 'string')
    .map((b: any) => b.text)
    .join('')
    .trim();
  if (!content) throw new Error(`Anthropic ${modelId} returned no text content`);
  return {
    content,
    promptTokens: data?.usage?.input_tokens ?? estimateTokens(systemPrompt + userPrompt),
    completionTokens: data?.usage?.output_tokens ?? estimateTokens(content),
  };
}

async function callDeepSeek(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
  if (!deepseekApiKey) throw new Error('DEEPSEEK_API_KEY not set');
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${deepseekApiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 16_000,
      temperature: 0.5,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DeepSeek HTTP ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('DeepSeek returned no content');
  return {
    content,
    promptTokens: data?.usage?.prompt_tokens ?? estimateTokens(systemPrompt + userPrompt),
    completionTokens: data?.usage?.completion_tokens ?? estimateTokens(content),
  };
}

// ─── Request body ────────────────────────────────────────────────────────────
interface RequestBody {
  task_id: string;
  group_id: string;
  user_id: string;
  tab?: number;
  variant?: number;
  batch_segments: Array<{ text: string; inputProps?: any; index?: number }>;
  style_slug?: string;
  composition_id?: string; // accepted but ignored (legacy)
  video_duration: number;
  language?: string;
  model?: string; // 'opus' | 'sonnet' | 'deepseek'
  part_number?: number;
}

// ─── Handler ─────────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });
  }

  try {
    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });
    }

    const body: RequestBody = await req.json();
    const {
      task_id, group_id, user_id, batch_segments,
      video_duration, style_slug,
    } = body;
    const tab = body.tab ?? 1;
    const variant = body.variant ?? 1;
    const language = body.language || 'english';
    const partNumber = body.part_number ?? 1;
    const requestedModel = (body.model || 'opus').toLowerCase();

    if (!task_id || !group_id || !user_id || !Array.isArray(batch_segments) || batch_segments.length === 0) {
      return new Response(JSON.stringify({ error: 'Missing task_id / group_id / user_id / batch_segments' }), {
        status: 400, headers: responseHeaders,
      });
    }

    // Look up the originating MG_prompt_tasks row for batch_number / total_batches / story_title.
    const { data: taskRow, error: taskErr } = await supabase
      .from('MG_prompt_tasks')
      .select('id, batch_number, total_batches, story_title')
      .eq('id', task_id)
      .single();
    if (taskErr || !taskRow) {
      return new Response(JSON.stringify({ error: `MG_prompt_tasks row not found for task_id=${task_id}` }), {
        status: 404, headers: responseHeaders,
      });
    }
    const currentBatchNumber: number = taskRow.batch_number;
    const totalBatches: number = taskRow.total_batches;
    const storyTitle: string = taskRow.story_title || 'Untitled';

    // ── Fetch all the context we need in parallel ─────────────────────────
    const [context, priorPrompts, upcoming] = await Promise.all([
      fetchFullContext(group_id, partNumber, tab),
      fetchPriorPrompts(group_id, user_id, tab, variant, currentBatchNumber, CONTEXT_PREV_CLIPS),
      fetchUpcomingSegments(group_id, user_id, tab, variant, currentBatchNumber, CONTEXT_NEXT_CLIPS),
    ]);

    const styleGuidance: string =
      (context?.style_description as string) ||
      (style_slug ? `Style: ${style_slug}` : '');
    const fullStory: string = (context?.full_story_text as string) || '';
    const effectiveDuration: number = video_duration || (context?.video_duration as number) || 10;

    const segments = batch_segments.map((s, i) => ({
      index: typeof s.index === 'number' ? s.index : i + 1,
      text: (s.text || '').trim(),
    }));

    const systemPrompt = buildSystemPrompt(language, effectiveDuration, styleGuidance);
    const userPrompt = buildUserPrompt({
      storyTitle, fullStory, styleGuidance, videoDuration: effectiveDuration,
      currentBatchNumber, totalBatches, priorPrompts, upcoming, segments,
    });

    // ── Call LLM (opus default, deepseek fallback) ────────────────────────
    let llmContent = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let usedModel = requestedModel;
    try {
      if (requestedModel === 'sonnet') {
        const r = await callAnthropic(systemPrompt, userPrompt, 'sonnet');
        llmContent = r.content; promptTokens = r.promptTokens; completionTokens = r.completionTokens;
      } else if (requestedModel === 'deepseek') {
        const r = await callDeepSeek(systemPrompt, userPrompt);
        llmContent = r.content; promptTokens = r.promptTokens; completionTokens = r.completionTokens;
      } else {
        const r = await callAnthropic(systemPrompt, userPrompt, 'opus');
        llmContent = r.content; promptTokens = r.promptTokens; completionTokens = r.completionTokens;
      }
    } catch (primaryErr: any) {
      console.warn(`[generate-MG-prompt] primary model (${requestedModel}) failed: ${primaryErr.message}. Falling back to deepseek.`);
      try {
        const r = await callDeepSeek(systemPrompt, userPrompt);
        llmContent = r.content; promptTokens = r.promptTokens; completionTokens = r.completionTokens;
        usedModel = 'deepseek';
      } catch (fallbackErr: any) {
        await supabase.from('MG_prompt_tasks').update({
          status: 'error',
          error: `LLM call failed (primary: ${primaryErr.message}; fallback: ${fallbackErr.message})`.slice(0, 500),
          updated_at: new Date().toISOString(),
        }).eq('id', task_id);
        throw fallbackErr;
      }
    }

    // ── Parse response ────────────────────────────────────────────────────
    let parsed: any;
    try {
      parsed = cleanAndParseJSON(llmContent);
    } catch (e: any) {
      await logError(`generate-MG-prompt parse failed for task ${task_id}; preview: ${llmContent.slice(0, 1500)}`, e);
      await supabase.from('MG_prompt_tasks').update({
        status: 'error',
        error: `JSON parse failed: ${e.message}`.slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq('id', task_id);
      throw e;
    }

    let items: any[] = [];
    if (Array.isArray(parsed)) items = parsed;
    else if (Array.isArray(parsed?.items)) items = parsed.items;
    else if (Array.isArray(parsed?.clips)) items = parsed.clips;
    else if (Array.isArray(parsed?.prompts)) items = parsed.prompts;

    if (items.length === 0) {
      throw new Error('LLM returned no items array');
    }

    // Build the legacy [{text, inputProps}] envelope with the new codegen fields.
    const pairs = segments.map((seg, i) => {
      const it = items[i] && typeof items[i] === 'object' ? items[i] : {};
      const motionPrompt: string = (typeof it.motion_graphic_prompt === 'string' && it.motion_graphic_prompt.trim())
        || (typeof it.motionGraphicPrompt === 'string' && it.motionGraphicPrompt.trim())
        || (typeof it.prompt === 'string' && it.prompt.trim())
        || seg.text;
      return {
        text: seg.text,
        index: seg.index,
        inputProps: {
          motion_graphic_prompt: motionPrompt,
          style_guidance: styleGuidance,
          video_duration: effectiveDuration,
          user_prompt: seg.text,
        },
      };
    });

    // ── Apply per-model token multiplier so the BEFORE-INSERT/UPDATE trigger
    // (`mg_prompt_tasks_token_update`) can use the generic `input * 0.25 +
    // output` formula — mirrors the pattern in setup-ttv-prompts /
    // setup-itv-prompts. Multipliers must stay in sync with those files.
    const MG_PROMPT_MODEL_MULTIPLIER: Record<string, number> = {
      deepseek: 1.0,
      sonnet:   11.0,
      opus:     19.0,
    };
    const multiplier = MG_PROMPT_MODEL_MULTIPLIER[usedModel] ?? 1.0;
    const billedInputTokens  = Math.round(promptTokens     * 1.25 * multiplier);
    const billedOutputTokens = Math.round(completionTokens *        multiplier);

    await supabase.from('MG_prompt_tasks').update({
      batch_output: JSON.stringify(pairs),
      status: 'completed',
      progress: 100,
      input_tokens: billedInputTokens,
      output_tokens: billedOutputTokens,
      model: usedModel,
      error: null,
      updated_at: new Date().toISOString(),
    }).eq('id', task_id);

    return new Response(JSON.stringify({
      status: 'ok',
      count: pairs.length,
      model: usedModel,
      input_tokens: billedInputTokens,
      output_tokens: billedOutputTokens,
    }), { status: 200, headers: responseHeaders });
  } catch (error: any) {
    await logError('Error in generate-MG-prompt', error);
    return new Response(JSON.stringify({ error: error?.message || 'Internal server error' }), {
      status: 500, headers: responseHeaders,
    });
  }
});
