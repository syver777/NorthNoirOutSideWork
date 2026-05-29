# Real Footage (RF) Feature Plan

## Context
- **Client:** Syver
- **Developer:** Bryce
- **Project:** NorthNoir video generation platform (Vite + React + TypeScript + Tailwind)
- **Goal:** Add a new "Real Footage" page that finds & downloads stock video clips instead of generating AI video

## Tools Used
- **opencode** (terminal) with Big Pickle / OpenCode Zen models
- **Claude Sonnet 4.6** — set `ANTHROPIC_API_KEY` in Supabase secrets (never commit keys)
- **Supabase** project: `ncrfscpuwzdpgogirktf`
- **Need to set up:** Coverr (free) + Pexels (free) API keys

## Architecture

### Pattern
Mirror the **TTV (Text-to-Video)** two-phase pipeline but with stock footage APIs instead of AI video generation.

### Phase 1 — Prompt Generation
User inputs story text → segmented → AI generates search keywords → stored

### Phase 2 — Clip Search & Download
Search keywords → query Coverr + Pexels → download best matching clips → upload to storage

## Supabase Edge Functions to Create (11 total)

### Prompt Generation Pipeline
1. **`setup-RF-prompts`** — Accepts story text, splits into segments, stores context in `RF_prompt_context`, creates `RF_prompt_tasks` batches
2. **`process-RF-tasks`** — Reads job data, creates task batches, triggers first prompt
3. **`trigger-next-RF-prompt`** — Queues next batch, fires `process-RF-prompt`
4. **`process-RF-prompt`** — Calls `generate-RF-prompt`, stores AI results, triggers next batch
5. **`generate-RF-prompt`** — Calls **Claude Sonnet 4.6** to generate search keywords for stock footage (NOT cinematic video prompts)

### Clip Download Pipeline
6. **`setup-RF-tasks`** — Reads compiled JSON, creates `RF_tasks` rows
7. **`trigger-next-RF`** — Queues next task, fires `process-RF`
8. **`process-RF`** — Executes clip search via `generate-RF`, downloads & stores
9. **`generate-RF`** — Thin gateway to Coverr + Pexels APIs

### Individual prompt / redo (testing)
10. **`single-RF`** — One user search query → one stock clip
11. **`redo-RF`** — Re-fetch stock clip for one RF_tasks row

## Database Tables
| Table | Purpose |
|---|---|
| `RF_prompt_context` | Story text context per part |
| `RF_prompt_tasks` | Search query generation tasks |
| `RF_tasks` | Clip download tasks |

## Frontend
- **New files:** `src/pages/RealFootageGenerator.tsx`, `src/pages/RealFootageGeneratorContainer.tsx`
- **New route:** `/real-footage-generator` (protected, add to `src/App.tsx`)
- Don't touch existing pages or components

## Key Differences from TTV
| TTV | RF |
|---|---|
| Uses fal.ai / xAI / OpenAI Sora | Uses Coverr + Pexels APIs |
| AI-generated video output | Downloaded stock clips |
| DeepSeek / Claude / Opus for prompts | **Claude Sonnet 4.6 only** for search keywords |
| Has `video_model` parameter | No video model (stock only) |

## Environment Variables
See [.env.example](.env.example) — copy to `.env` locally.

## Deployment Notes
- All new Supabase functions must use `--no-verify-jwt`
- Do NOT modify existing TTV, ITV, or MG functions/tables
- Do NOT modify Deno Deploy functions or Google Cloud functions

## Key Files Referenced (existing TTV pattern)
- `supabase/functions/setup-ttv-prompts/index.ts` (931 lines)
- `supabase/functions/process-ttv-task/index.ts` (604 lines)
- `supabase/functions/setup-TTV-tasks/index.ts` (293 lines)
- `supabase/functions/process-TTV/index.ts` (1200+ lines)
- `supabase/functions/generate-TTV/index.ts` (517 lines)
- `supabase/functions/trigger-next-TTV/index.ts` (240 lines)
- `supabase/functions/trigger-next-TTV-prompt/index.ts` (167 lines)
- `supabase/functions/generate-TTV-prompt/index.ts` (770 lines)
- `supabase/functions/process-TTV-prompt/index.ts` (793 lines)
- `src/pages/TextToVideoGenerator.tsx`, `TextToVideoGeneratorContainer.tsx`
- `src/App.tsx` (routes)
- `supabase/functions/_shared/` (utils.ts, cors.ts, tokenCosts.ts, fetchWithDenoFallback.ts)

## Unanswered Questions (to discuss next session)
1. Frontend design — same layout as TTV page?
2. Coverr + Pexels API keys — set up by you or client?
3. Clip selection logic — best match? Random from top results?
4. Output format — folder of clips? Or stitched video?
5. Navigation — where does "Real Footage" link appear in the UI?
