-- RF_tasks: language column (mirrors TTV_tasks; required by setup-RF-tasks)

ALTER TABLE public."RF_tasks"
  ADD COLUMN IF NOT EXISTS language text DEFAULT 'english';
