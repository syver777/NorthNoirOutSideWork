-- RF Phase 2 Task 2: token billing triggers (prompt LLM + stock clip flat cost)

-- RF_prompt_tasks needs token_updated for the prompt-phase billing trigger
ALTER TABLE public."RF_prompt_tasks"
  ADD COLUMN IF NOT EXISTS token_updated boolean DEFAULT false;

-- RF_tasks: LLM token columns (input*0.25 + output billing when set)
ALTER TABLE public."RF_tasks"
  ADD COLUMN IF NOT EXISTS input_tokens integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_tokens integer DEFAULT 0;

-- Prompt phase: mirror ttv_prompt_tasks_token_update
CREATE OR REPLACE FUNCTION public.rf_prompt_tasks_token_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.input_tokens IS NOT NULL
     AND NEW.output_tokens IS NOT NULL
     AND NOT NEW.token_updated
     AND (NEW.input_tokens > 0 OR NEW.output_tokens > 0)
  THEN
    UPDATE user_plans
    SET tokens_used = tokens_used + (NEW.input_tokens * 0.25 + NEW.output_tokens),
        updated_at = NOW()
    WHERE user_id = NEW.user_id
      AND is_active = TRUE;
    NEW.token_updated = TRUE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rf_prompt_tasks_token_update ON public."RF_prompt_tasks";
CREATE TRIGGER rf_prompt_tasks_token_update
  BEFORE INSERT OR UPDATE ON public."RF_prompt_tasks"
  FOR EACH ROW
  EXECUTE FUNCTION public.rf_prompt_tasks_token_update();

-- RF_tasks LLM billing (input*0.25 + output) — reserved for rows that set input/output
CREATE OR REPLACE FUNCTION public.rf_tasks_token_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.input_tokens IS NOT NULL
     AND NEW.output_tokens IS NOT NULL
     AND NOT NEW.token_updated
     AND (NEW.input_tokens > 0 OR NEW.output_tokens > 0)
  THEN
    UPDATE user_plans
    SET tokens_used = tokens_used + (NEW.input_tokens * 0.25 + NEW.output_tokens),
        updated_at = NOW()
    WHERE user_id = NEW.user_id
      AND is_active = TRUE;
    NEW.token_updated = TRUE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rf_tasks_token_update ON public."RF_tasks";
CREATE TRIGGER rf_tasks_token_update
  BEFORE INSERT OR UPDATE ON public."RF_tasks"
  FOR EACH ROW
  EXECUTE FUNCTION public.rf_tasks_token_update();

-- RF_tasks stock clip billing: mirror mg_tasks_tokens_update
CREATE OR REPLACE FUNCTION public.rf_tasks_tokens_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.token_updated = TRUE
     AND NEW.tokens IS NOT NULL
     AND NEW.tokens > 0
     AND (OLD.tokens IS DISTINCT FROM NEW.tokens
          OR OLD.token_updated IS DISTINCT FROM NEW.token_updated)
  THEN
    UPDATE user_plans
    SET tokens_used = COALESCE(tokens_used, 0) + NEW.tokens,
        updated_at = NOW()
    WHERE user_id = NEW.user_id
      AND is_active = TRUE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rf_tasks_tokens_update ON public."RF_tasks";
CREATE TRIGGER rf_tasks_tokens_update
  BEFORE INSERT OR UPDATE ON public."RF_tasks"
  FOR EACH ROW
  EXECUTE FUNCTION public.rf_tasks_tokens_update();
