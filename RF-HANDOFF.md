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

## 6. Push when ready

Test full flow locally, then push branch for Syver review.
