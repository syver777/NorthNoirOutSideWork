-- RF_prompt_tasks: link compiled prompts JSON (mirrors TTV_prompt_tasks.ttv_prompt_document_id)

ALTER TABLE public."RF_prompt_tasks"
  ADD COLUMN IF NOT EXISTS ttv_prompt_document_id uuid;
