# Real Footage — deploy & test

**Test project:** `ncrfscpuwzdpgogirktf`  
**Status (Jun 2026):** MVP on test Supabase. Syver UI feedback applied: no visual style picker, no vendor names on page (Source = “Stock footage” only).

## 1. Local setup

```bash
cp .env.example .env
# Fill SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SECRET_KEY from client
npm install
npm run dev
```

Open: http://localhost:5173/real-footage-generator

## 2. Supabase migrations (run in SQL editor)

Apply in order (skip full `rf_tables` if tables already exist):

1. `supabase/migrations/20260529000000_rf_tables.sql`
2. `supabase/migrations/20260529100000_rf_redo_columns.sql`
3. `supabase/migrations/20260529200000_rf_prompt_document_id.sql`
4. `supabase/migrations/20260529300000_rf_tasks_language.sql`

If PostgREST shows lowercase `rf_*` tables, rename to quoted `"RF_*"` and `NOTIFY pgrst, 'reload schema';`.

## 3. Edge function secrets

- `SECRET_KEY`
- `PUBLIC_KEY` (if used)
- `SUPABASE_URL`
- `ANTHROPIC_API_KEY`
- `COVERR_API_KEY`
- `PEXELS_API_KEY`

## 4. Deploy functions (`--no-verify-jwt` each)

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

**Test project deploy status (verified):** all above respond except `redo-RF` (deploy if redo needed).

## 5. What was added

| Area | Path |
|------|------|
| Tables SQL | `supabase/migrations/20260529000000_rf_tables.sql` |
| Stock APIs | `supabase/functions/_shared/stockFootage.ts` |
| Edge functions | `setup-RF-prompts` … `redo-RF` |
| Page | `src/pages/RealFootageGenerator.tsx` |
| Container | `src/pages/RealFootageGeneratorContainer.tsx` |
| Route | `/real-footage-generator` in `src/App.tsx` |

## 6. Frontend (Syver feedback — Jun 2026)

- **What to Expect** info box
- **Mode:** Existing Document vs Individual Prompt (`single-RF`)
- **TabManager** (`page: rf`)
- **DocumentSelector** (story docs v1–2)
- **Source** label: “Stock footage” only (no vendor names on page)
- **No visual style** picker (removed per Syver)
- **StatusBanner** generating / complete
- Per-tab settings via `useTabSessionStorage`
- **Documents:** RF output folders labeled “Real Footage Clips”

## 7. Backend fixes

| Commit | Fix |
|--------|-----|
| `e699faf` | Sanitize Pexels queries; smaller clip files |
| `46917cf` | Phase 2 auto-start after `setup-RF-tasks` |

## 8. Test checklist

- [ ] **Existing Document:** story → Phase 1 100% → Phase 2 12/12 → RF Outputs in Documents
- [ ] **Individual Prompt:** prompt → clip preview + download (`single-RF` deployed)
- [ ] **Tabs:** create/switch tabs (enterprise)

## 9. Production (when Syver approves)

1. Run migrations on prod Supabase
2. Deploy all RF functions + secrets (client Pexels/Coverr keys)
3. Point hosting env at prod Supabase
4. One E2E test on prod

## 10. Not changed (per scope)

- `VideoGenerator`, TTV/ITV/MG pages (except Documents label for RF Outputs folders)
- Deno Deploy workers
- GCloud final-video
