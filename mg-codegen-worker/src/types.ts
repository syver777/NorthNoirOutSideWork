// Shared types between the Supabase MG_tasks row and the worker.

export interface CodegenBatchContext {
  /** Title of the parent story (for high-level context). */
  story_title?: string | null;
  /** Full story text (or this part of it) — may be very large. */
  full_story_text?: string | null;
  /** This clip's batch_number / total_batches (1-indexed). */
  batch_number: number;
  total_batches: number;
  /** The last N already-generated motion_graphic_prompts in the sequence. */
  prev: Array<{ batch_number: number; motion_graphic_prompt: string; user_prompt: string }>;
  /** The next N upcoming raw segment texts (already in MG_tasks rows). */
  next: Array<{ batch_number: number; user_prompt: string }>;
  /** One-line outline of remaining clips beyond `next`. */
  rest_outline?: string;
}

export interface CodegenTask {
  id: string;
  user_id: string;
  // The Claude-generated description of what the motion graphic should DO.
  // Free-form English; this is what Claude Opus turns into Clip.tsx.
  motion_graphic_prompt: string;
  // Optional original user prompt (for fallback display + context).
  user_prompt?: string | null;
  // Total clip duration in seconds (defaults to 10).
  duration_seconds?: number | null;
  // Optional style direction text the user typed in the dashboard.
  style_guidance?: string | null;
  // Optional pre-downloaded asset filenames available in public/.
  assets?: Array<{ name: string; purpose?: string }> | null;
  // If the previous render of this task failed at runtime (e.g. bad
  // interpolate inputRange), the message is fed back into the regen prompt
  // so Claude can avoid the same pattern.
  last_render_error?: string | null;
  render_attempts?: number;
  // Anthropic model to use for codegen. 'claude-opus-4-6' (default, best
  // quality) or 'claude-sonnet-4-6' (~1.7× cheaper). Selected by user in UI
  // and forwarded through setup-MG-tasks / single-MG onto the MG_tasks row.
  codegen_model?: string | null;
  // Optional parent video_tasks row id. NULL for standalone /motion-graphics
  // jobs; populated for integrated VideoGenerator runs. The worker treats
  // this as pure passthrough — it only logs the field for observability.
  video_task_id?: string | null;
  // Sequential context populated when the task is part of a batch render
  // (single_mg=false). Lets the codegen LLM maintain visual + narrative
  // continuity across the clip sequence.
  batch_context?: CodegenBatchContext | null;
}

export interface RenderTrigger {
  render_id: string;
  bucket_name: string;
  bundle_url: string;
  composition_id: string; // always "Clip" for code-gen flow
  duration_frames: number;
}

export interface CodegenUsage {
  // Platform billing tokens — already multiplied so $2 / 1M tokens gives the
  // platform a 40% margin over the actual Anthropic API cost. These are the
  // values written into MG_tasks.codegen_input_tokens / codegen_output_tokens,
  // mirroring how TTV stores input_tokens / output_tokens.
  inputTokens: number;
  outputTokens: number;
}
