# Real Footage — deploy & test (local first)

## 1. Local setup

```bash
cp .env.example .env
# Fill SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SECRET_KEY from client
bun install
bun run dev
```

Open: http://localhost:5173/real-footage-generator

## 2. Supabase (client project)

Run migration in SQL editor:

- [supabase/migrations/20260529000000_rf_tables.sql](supabase/migrations/20260529000000_rf_tables.sql)

Edge function secrets:

- `ANTHROPIC_API_KEY`
- `COVERR_API_KEY`
- `PEXELS_API_KEY`
- `SECRET_KEY`
- `SUPABASE_URL`

## 3. Deploy functions (each with JWT off per client)

```bash
supabase link --project-ref ncrfscpuwzdpgogirktf

supabase functions deploy setup-RF-prompts --no-verify-jwt
supabase functions deploy process-RF-tasks --no-verify-jwt
supabase functions deploy generate-RF-prompt --no-verify-jwt
supabase functions deploy process-RF-prompt --no-verify-jwt
supabase functions deploy trigger-next-RF-prompt --no-verify-jwt
supabase functions deploy setup-RF-tasks --no-verify-jwt
supabase functions deploy generate-RF --no-verify-jwt
supabase functions deploy process-RF --no-verify-jwt
supabase functions deploy trigger-next-RF --no-verify-jwt
supabase functions deploy single-RF --no-verify-jwt
supabase functions deploy redo-RF --no-verify-jwt
```

Also run in SQL editor (if not already applied):

- [supabase/migrations/20260529100000_rf_redo_columns.sql](supabase/migrations/20260529100000_rf_redo_columns.sql) — `redo_status`, `redo_started_at` on `rf_tasks`

## 4. What was added

| Area | Path |
|------|------|
| Tables SQL | `supabase/migrations/20260529000000_rf_tables.sql` |
| Stock APIs | `supabase/functions/_shared/stockFootage.ts` |
| Edge functions | `supabase/functions/setup-RF-prompts/` … `trigger-next-RF/`, `single-RF/`, `redo-RF/` |
| Page | `src/pages/RealFootageGenerator.tsx` |
| Route | `/real-footage-generator` in `src/App.tsx` |

## 5. Not changed (per scope)

- `VideoGenerator`, TTV/ITV/MG pages
- Deno Deploy workers
- GCloud final-video

## 6. Frontend (Syver feedback — Jun 2026)

Real Footage page now mirrors Text-to-Video layout:

- **What to Expect** info box
- **Mode:** Existing Document vs Individual Prompt (`single-RF`)
- **TabManager** for enterprise multi-tab (`page: rf`)
- **DocumentSelector** upload + listbox (story docs v1–2)
- **Visual style** grid + custom style (same cards as TTV)
- **StatusBanner** for generating / complete
- Per-tab settings via `useTabSessionStorage`

## 7. Phase 2 auto-start

Commit `46917cf`: `setup-RF-tasks` awaits `trigger-next-RF` with retries.

## 8. Push when ready

Test full flow locally, then push branch for Syver review.
