-- =============================================================================
-- Add Motion Graphics ('mg') as a 4th visual_type in the unified video pipeline.
--
-- Adds:
--   * `mg_*` progress / config columns on public.video_tasks
--   * nullable `video_task_id` FKs on MG_prompt_context, MG_prompt_tasks, MG_tasks
--     so MG runs triggered from the unified VideoGenerator can be parented to a
--     video_tasks row (standalone /motion-graphics page leaves them NULL).
--   * relaxes any existing CHECK on video_tasks.visual_type to allow 'mg'.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- video_tasks: new MG configuration + progress columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.video_tasks
  ADD COLUMN IF NOT EXISTS mg_style_slug         text,
  ADD COLUMN IF NOT EXISTS mg_style_guidance     text,
  ADD COLUMN IF NOT EXISTS mg_clip_duration      integer DEFAULT 10,
  ADD COLUMN IF NOT EXISTS mg_codegen_model      text    DEFAULT 'claude-opus-4-6',
  ADD COLUMN IF NOT EXISTS mg_prompt_status      text    DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS mg_prompt_progress    integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mg_status             text    DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS mg_progress           integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mg_prompt_document_id uuid,
  ADD COLUMN IF NOT EXISTS mg_folder_document_id uuid,
  ADD COLUMN IF NOT EXISTS process_mg            boolean DEFAULT false;

-- Relax visual_type constraint if one exists, then re-add with 'mg' included.
-- Defensive: only act if a CHECK constraint named like the conventional one exists.
DO $$
DECLARE
  cons_name text;
BEGIN
  SELECT conname INTO cons_name
  FROM pg_constraint
  WHERE conrelid = 'public.video_tasks'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%visual_type%';

  IF cons_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.video_tasks DROP CONSTRAINT %I', cons_name);
  END IF;
END$$;

ALTER TABLE public.video_tasks
  ADD CONSTRAINT video_tasks_visual_type_check
  CHECK (visual_type IS NULL OR visual_type IN ('image','ttv','itv','mg'));

-- ---------------------------------------------------------------------------
-- MG_prompt_context: link back to parent video_tasks when integrated.
-- ---------------------------------------------------------------------------
ALTER TABLE public."MG_prompt_context"
  ADD COLUMN IF NOT EXISTS video_task_id uuid REFERENCES public.video_tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_mg_prompt_context_video_task_id
  ON public."MG_prompt_context"(video_task_id);

-- ---------------------------------------------------------------------------
-- MG_prompt_tasks: link back to parent video_tasks.
-- ---------------------------------------------------------------------------
ALTER TABLE public."MG_prompt_tasks"
  ADD COLUMN IF NOT EXISTS video_task_id uuid REFERENCES public.video_tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_mg_prompt_tasks_video_task_id
  ON public."MG_prompt_tasks"(video_task_id);

-- ---------------------------------------------------------------------------
-- MG_tasks: link back to parent video_tasks so the final-video assembler can
-- query clips for a given main task.
-- ---------------------------------------------------------------------------
ALTER TABLE public."MG_tasks"
  ADD COLUMN IF NOT EXISTS video_task_id uuid REFERENCES public.video_tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_mg_tasks_video_task_id
  ON public."MG_tasks"(video_task_id);
