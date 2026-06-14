# Real Footage — Phase 2 handoff (Syver feedback, Jun 2026)

**Test project:** `ncrfscpuwzdpgogirktf`  
**Status:** Phase 2 complete on test — pushed to `main`. Prod deploy when Syver approves.

## What shipped (Tasks 0–5)

| Stream | Summary |
|--------|---------|
| **Clip length + stock** | 2–60s slider; Coverr + Pexels; duration-aware pick; HD ~720p downloads |
| **Token billing** | `input_tokens`/`output_tokens` on `RF_tasks`; LLM trigger `input×0.25 + output`; flat 500/clip |
| **Audio + AI duration** | Existing Document requires audio; AI plans per-clip `video_duration` (2–60s) |
| **Completion UI** | TTV-style clip grid, redo + feedback, Done clears 3 RF tables + tab idle (keeps storage) |
| **RF versions** | Prompts **28/29**, clip folders **30/31**; Documents labels updated |

## Migrations (run in SQL editor on prod when approved)

Apply after base RF tables (skip if already applied on test):

1. `20260601000000_rf_version_defaults.sql`
2. `20260611000000_rf_token_billing.sql`
3. `20260612000000_rf_audio_duration_context.sql`

## Edge functions — deploy all with `--no-verify-jwt`

```bash
supabase link --project-ref ncrfscpuwzdpgogirktf

supabase functions deploy setup-RF-prompts --no-verify-jwt
supabase functions deploy generate-RF-prompt --no-verify-jwt
supabase functions deploy process-RF-prompt --no-verify-jwt
supabase functions deploy process-RF-tasks --no-verify-jwt
supabase functions deploy trigger-next-RF-prompt --no-verify-jwt
supabase functions deploy setup-RF-tasks --no-verify-jwt
supabase functions deploy generate-RF --no-verify-jwt
supabase functions deploy process-RF --no-verify-jwt
supabase functions deploy trigger-next-RF --no-verify-jwt
supabase functions deploy single-RF --no-verify-jwt
supabase functions deploy redo-RF --no-verify-jwt
```

**Secrets:** `SECRET_KEY`, `SUPABASE_URL`, `ANTHROPIC_API_KEY`, `COVERR_API_KEY`, `PEXELS_API_KEY`

## How to test on test project

1. Open `/real-footage-generator`
2. **Existing Document:** select story + narration audio → Generate
3. Phase 1 (prompts) → Phase 2 (clips) → **Show N Clips**
4. **Redo** one clip with feedback (e.g. "more underwater")
5. **Done** → tab idle; clips remain in **Documents** (v28 prompts, v30 clips, Download ZIP)
6. **Individual Prompt:** single clip search still works (no audio)

Verify script: `node scripts/verify-rf-phase2.mjs`

## Out of scope (Syver)

- GCloud clip trimming / exact length
- TTV / ITV / MG / Video Generator changes (except Documents RF labels)

## Production (when approved)

1. Run Phase 2 migrations on prod SQL editor
2. Deploy all RF edge functions + secrets
3. One E2E Existing Document run on prod
4. Point hosting env at prod Supabase if needed
