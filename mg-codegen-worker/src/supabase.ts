// Supabase service-role client + MG_tasks helpers.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CodegenTask, CodegenUsage, RenderTrigger } from "./types.js";
import { DEFAULT_MODEL as CODEGEN_MODEL } from "./codegen.js";

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

export async function fetchTask(taskId: string): Promise<CodegenTask> {
  const sb = getClient();
  const { data, error } = await sb
    .from("MG_tasks")
    .select(
      "id, user_id, group_id, batch_number, total_batches, story_title, tab, variant, single_mg, motion_graphic_prompt, user_prompt, video_duration, style_guidance, assets, stop_requested, last_render_error, render_attempts, codegen_model, video_task_id"
    )
    .eq("id", taskId)
    .single();
  if (error) throw new Error(`fetchTask: ${error.message}`);
  if (!data) throw new Error(`fetchTask: no row for id=${taskId}`);
  if (data.stop_requested) throw new Error("STOP_REQUESTED");

  const task: CodegenTask = {
    id: data.id,
    user_id: data.user_id,
    motion_graphic_prompt: data.motion_graphic_prompt ?? "",
    user_prompt: data.user_prompt,
    duration_seconds: data.video_duration,
    style_guidance: data.style_guidance,
    assets: data.assets,
    last_render_error: data.last_render_error,
    render_attempts: data.render_attempts ?? 0,
    codegen_model: data.codegen_model ?? null,
    video_task_id: data.video_task_id ?? null,
  };

  // ─── Batch context (sequential continuity) ───────────────────────────
  // Only populated for true batch renders (single_mg=false). For single-MG
  // calls there is no surrounding sequence, so we skip the extra queries.
  if (!data.single_mg && data.group_id && typeof data.batch_number === "number") {
    try {
      const groupId: string = data.group_id;
      const userId: string = data.user_id;
      const tab: number = data.tab ?? 1;
      const variant: number = data.variant ?? 1;
      const current: number = data.batch_number;
      const total: number = data.total_batches ?? current;
      const PREV = 3;
      const NEXT = 3;

      // Previous clips: only those already generated (status running/completed/rendering).
      const { data: prevRows } = await sb
        .from("MG_tasks")
        .select("batch_number, motion_graphic_prompt, user_prompt")
        .eq("group_id", groupId)
        .eq("user_id", userId)
        .eq("tab", tab)
        .eq("variant", variant)
        .lt("batch_number", current)
        .order("batch_number", { ascending: false })
        .limit(PREV);
      const prev = (prevRows ?? [])
        .reverse()
        .map((r) => ({
          batch_number: r.batch_number,
          motion_graphic_prompt: r.motion_graphic_prompt ?? "",
          user_prompt: r.user_prompt ?? "",
        }));

      // Upcoming clips: raw user_prompt only (their motion_graphic_prompt
      // may already be set by generate-MG-prompt; that's fine).
      const { data: nextRows } = await sb
        .from("MG_tasks")
        .select("batch_number, user_prompt")
        .eq("group_id", groupId)
        .eq("user_id", userId)
        .eq("tab", tab)
        .eq("variant", variant)
        .gt("batch_number", current)
        .order("batch_number", { ascending: true })
        .limit(NEXT + 30);
      const allNext = (nextRows ?? []).map((r) => ({
        batch_number: r.batch_number,
        user_prompt: r.user_prompt ?? "",
      }));
      const next = allNext.slice(0, NEXT);
      const restOutlineLines: string[] = [];
      let restLen = 0;
      for (const r of allNext.slice(NEXT)) {
        const oneLine = (r.user_prompt || "").replace(/\s+/g, " ").slice(0, 140);
        const line = `  #${r.batch_number}: ${oneLine}${r.user_prompt.length > 140 ? "…" : ""}`;
        if (restLen + line.length > 3000) break;
        restOutlineLines.push(line);
        restLen += line.length + 1;
      }

      // Full story text (mirrors generate-MG-prompt context lookup).
      let fullStory: string | null = null;
      const tryCtx = async (filters: Record<string, unknown>) => {
        let q = sb.from("MG_prompt_context").select("full_story_text").eq("group_id", groupId);
        for (const [k, v] of Object.entries(filters)) {
          q = v === null ? q.is(k, null) : q.eq(k, v);
        }
        const { data: ctxRow } = await q.limit(1).maybeSingle();
        return ctxRow?.full_story_text ?? null;
      };
      fullStory = await tryCtx({ part_number: 1, tab });
      if (!fullStory) fullStory = await tryCtx({ part_number: 1 });
      if (!fullStory) fullStory = await tryCtx({ part_number: null });

      task.batch_context = {
        story_title: data.story_title,
        full_story_text: fullStory,
        batch_number: current,
        total_batches: total,
        prev,
        next,
        rest_outline: restOutlineLines.join("\n"),
      };
    } catch (ctxErr: any) {
      console.warn(`[fetchTask] batch_context lookup failed (task=${taskId}): ${ctxErr?.message ?? ctxErr}`);
    }
  }

  return task;
}

export async function isStopRequested(taskId: string): Promise<boolean> {
  const sb = getClient();
  const { data } = await sb
    .from("MG_tasks")
    .select("stop_requested")
    .eq("id", taskId)
    .single();
  return !!data?.stop_requested;
}

export async function updateStatus(
  taskId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const sb = getClient();
  const { error } = await sb
    .from("MG_tasks")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", taskId);
  if (error) console.error(`[supabase] updateStatus error: ${error.message}`);
}

export async function saveGeneratedCode(
  taskId: string,
  tsxCode: string,
  attempts: { generation: number; repairs: number; usedFallback: boolean }
): Promise<void> {
  await updateStatus(taskId, {
    generated_tsx_code: tsxCode,
    code_gen_attempts: attempts.generation,
    code_gen_repair_count: attempts.repairs,
    code_gen_used_fallback: attempts.usedFallback,
  });
}

export async function saveRenderTrigger(
  taskId: string,
  trigger: RenderTrigger
): Promise<void> {
  await updateStatus(taskId, {
    lambda_render_id: trigger.render_id,
    lambda_bucket_name: trigger.bucket_name,
    bundle_url: trigger.bundle_url,
    composition_id: trigger.composition_id,
    status: "rendering",
  });
}

export async function saveCodegenUsage(
  taskId: string,
  usage: CodegenUsage,
  actualModel?: string,
): Promise<void> {
  // `inputTokens` / `outputTokens` are already platform-billing tokens (see
  // getUsage in codegen.ts — Anthropic USD already converted with margin
  // applied per-model). Sum them into `tokens` and flip `token_updated` so
  // the `mg_tasks_tokens_update` trigger bills user_plans exactly once.
  // `codegen_model` records which Claude model produced these tokens —
  // prefer the model actually used for this task (Opus or Sonnet 4.6) and
  // fall back to the worker default.
  const totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  await updateStatus(taskId, {
    codegen_input_tokens: usage.inputTokens,
    codegen_output_tokens: usage.outputTokens,
    codegen_model: actualModel ?? CODEGEN_MODEL,
    tokens: totalTokens,
    token_updated: true,
  });
}
