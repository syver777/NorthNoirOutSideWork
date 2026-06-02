-- Real Footage (RF) tables — client Supabase project only
-- Mirror TTV_prompt_context, TTV_prompt_tasks, TTV_tasks

CREATE TABLE IF NOT EXISTS public.RF_prompt_context (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL,
  part_number integer NOT NULL DEFAULT 1,
  user_id uuid NOT NULL,
  tab integer NOT NULL DEFAULT 1,
  full_story_text text,
  word_count integer,
  character_count integer,
  master_prompt_data jsonb,
  environment_only_mode boolean DEFAULT false,
  style_description text,
  character_descriptions jsonb,
  custom_chars_in_story boolean,
  video_model text DEFAULT 'stock',
  video_duration numeric DEFAULT 5,
  total_videos integer,
  audio_clip boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (group_id, tab, part_number)
);

CREATE TABLE IF NOT EXISTS public.RF_prompt_tasks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  group_id uuid NOT NULL,
  story_title text,
  description text,
  batch jsonb,
  text_part text,
  batch_output text DEFAULT '',
  total_batches integer,
  batch_number integer,
  total_prompts integer,
  total_videos integer,
  status text DEFAULT 'pending',
  progress integer DEFAULT 0,
  error text,
  settings jsonb,
  variant integer DEFAULT 1,
  file_path text,
  input_tokens integer DEFAULT 0,
  output_tokens integer DEFAULT 0,
  version integer DEFAULT 12,
  language text DEFAULT 'english',
  model text DEFAULT 'sonnet',
  video_model text DEFAULT 'stock',
  video_duration numeric DEFAULT 5,
  tab integer DEFAULT 1,
  is_corrected boolean DEFAULT false,
  audio_clip boolean DEFAULT false,
  ttv_prompt_document_id uuid,
  video_process boolean DEFAULT false,
  stop_requested boolean DEFAULT false,
  check_stuck boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rf_prompt_tasks_group ON public.RF_prompt_tasks (group_id, user_id, tab, variant);

CREATE TABLE IF NOT EXISTS public.RF_tasks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  group_id uuid NOT NULL,
  doc_id uuid,
  story_title text,
  description text,
  file_path text,
  text_part text,
  batch jsonb,
  batch_output text DEFAULT '',
  total_batches integer,
  batch_number integer,
  total_prompts integer,
  progress integer DEFAULT 0,
  status text DEFAULT 'pending',
  error text,
  settings jsonb,
  variant integer DEFAULT 1,
  is_corrected boolean DEFAULT false,
  tokens integer DEFAULT 0,
  token_updated boolean DEFAULT false,
  version integer DEFAULT 14,
  folder_timestamp text,
  video_model text DEFAULT 'stock',
  video_duration numeric DEFAULT 5,
  video_process boolean DEFAULT false,
  video_url text,
  stock_source text,
  stock_id text,
  polling_id text,
  polling_url text,
  poll_attempts integer DEFAULT 0,
  tab integer DEFAULT 1,
  language text DEFAULT 'english',
  audio_clip boolean DEFAULT false,
  single_rf boolean DEFAULT false,
  stop_requested boolean DEFAULT false,
  check_stuck boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rf_tasks_group ON public.RF_tasks (group_id, user_id, tab, variant);

ALTER TABLE public.RF_prompt_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.RF_prompt_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.RF_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY rf_prompt_context_user ON public.RF_prompt_context
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY rf_prompt_tasks_user ON public.RF_prompt_tasks
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY rf_tasks_user ON public.RF_tasks
  FOR ALL USING (auth.uid() = user_id);
