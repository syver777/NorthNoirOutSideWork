-- RF Phase 2 Task 1: dedicated document versions (28/29 prompts, 30/31 clip folders)
ALTER TABLE public."RF_prompt_tasks"
  ALTER COLUMN version SET DEFAULT 28;

ALTER TABLE public."RF_tasks"
  ALTER COLUMN version SET DEFAULT 30;
