-- RF Phase 2 Task 4: audio metadata on prompt context for AI duration planning

ALTER TABLE public."RF_prompt_context"
  ADD COLUMN IF NOT EXISTS total_audio_duration numeric,
  ADD COLUMN IF NOT EXISTS audio_file_path text;
