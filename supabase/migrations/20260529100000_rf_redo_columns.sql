-- Add redo columns to RF_tasks (mirrors TTV_tasks redo flow for redo-RF)

ALTER TABLE public.rf_tasks
  ADD COLUMN IF NOT EXISTS redo_status text,
  ADD COLUMN IF NOT EXISTS redo_started_at timestamptz;
