# Real Footage — Phase 2 Plan (Syver feedback, Jun 10 2026)

**Client:** Syver  
**Developer:** Bryce  
**Test Supabase:** `ncrfscpuwzdpgogirktf` (NorthNoirOutSideWork)  
**Status:** Task 0 complete — plan ready; implement one task at a time.

## Rules (do not break)

| Do | Don't |
|----|--------|
| RF scope only | GCloud clip trimming (Syver handles later) |
| Test project first | Prod deploy without approval |
| Mirror TTV/MG patterns | Change Video Generator / unrelated pages |
| Coverr/Pexels in backend only | Vendor names on RF UI |
| Supabase edge functions only | Deno Deploy for RF |
| Deploy with `--no-verify-jwt` | Modify existing TTV/ITV/MG functions |

---

## Syver's 6 work streams (summary)

| # | Stream | One-line |
|---|--------|----------|
| 1 | Clip length + stock search | 2–60s slider; duration-aware Coverr/Pexels; different length → different clip |
| 2 | Token billing | `input_tokens` + `output_tokens` on `RF_tasks`; trigger → `user_plans` |
| 3 | Audio + AI duration planning | Existing Document requires audio; AI plans per-clip duration (always on) |
| 4 | Completion UI | TTV-style clip grid, redo, Done → delete 3 RF tables + tab idle |
| 5 | RF document versions | Dedicated versions (not TTV 12–15); Documents page labels |
| 6 | Process | Plan first → one task at a time → MCP for SQL migrations |

---

## Document version map

| Asset | Original | Corrected |
|-------|----------|-----------|
| Story | 1 | 2 |
| Image prompts | 3 | 4 |
| Images | 5 | 6 |
| Audio file | 7 | 8 |
| Audio folder | 9 | 10 |
| Final video | 11 | — |
| TTV prompts / clips | 12 | 13 → **14** | **15** |
| ITV image prompts / images | 16 | 17 → **18** | **19** |
| ITV video prompts / videos | 20 | 21 → **22** | **23** |
| MG prompts / videos | 24 | 25 → **26** | **27** |
| **RF (proposed)** | **28** | **29** → **30** | **31** |

**Problem today:** RF reuses TTV versions 12–15 and `RF Outputs:` title hack on version 14.  
**Fix:** Use **28/29** for compiled RF prompt JSON, **30/31** for RF clip output folders.

---

## Reference code (read before implementing)

### TTV — copy these patterns

| Feature | File | Notes |
|---------|------|-------|
| Grok duration slider (2–15s) | `src/components/VideoModelSelector.tsx` | `durationType: 'slider'`, `durationMin`/`durationMax` |
| Slider UI + typed input | `src/pages/TextToVideoGenerator.tsx` ~1902+ | `sliderInputValue`, `selectedModelCfg.durationType === 'slider'` |
| Audio upload + select | `src/pages/TextToVideoGenerator.tsx` ~556–900 | `audioFiles`, version 7 upload, `.in('version', [7,8,9,10])` |
| Audio drives runtime | `TextToVideoGenerator.tsx` ~1278 | `totalAudioDuration` passed to `setup-ttv-prompts` |
| Completion clip grid | `TextToVideoGenerator.tsx` ~2901–2990 | `generatedVideos`, Show clips, per-clip Download/Redo |
| Redo | `TextToVideoGenerator.tsx` ~757–781 | `redo-TTV` fetch + polling ~626–669 |
| Redo modal | `TextToVideoGenerator.tsx` ~3116+ | `RedoFeedbackModal` |
| Done cleanup | `TextToVideoGenerator.tsx` ~1419–1455 | Deletes `TTV_tasks`, `TTV_prompt_tasks`, `TTV_prompt_context`; `updateTabStatus(..., 'idle')`; **keeps storage files** |
| Token trigger (reference SQL) | Syver chat | `ttv_prompt_tasks_token_update()`: `input*0.25 + output` → `user_plans` |
| TTV prompt versions | `setup-ttv-prompts`, `setup-TTV-tasks` | 12/13 prompts → 14/15 clip folders |

### MG — copy these patterns

| Feature | File | Notes |
|---------|------|-------|
| Audio (same as TTV) | `src/pages/MotionGraphicsGenerator.tsx` ~463–740 | version 7 audio upload |
| MG prompt versions | `process-mg-task`, `setup-MG-tasks` | 24/25 prompts |
| MG clip folder versions | `process-MG/index.ts`, `single-MG` | **26** original / **27** corrected |
| Individual prompt tokens | `single-MG/index.ts` | Check `token_updated` pattern for flat-cost rows |
| Per-clip duration in prompt | `generate-MG-prompt/index.ts` | `video_duration` in system prompt (~253–342) |
| AI planning (full pipeline) | `supabase/functions/plan-video/index.ts` | `clampClipDuration`, MG clip count — **RF needs Supabase-only equivalent**, not Deno Deploy |

### RF — current state (what to change)

| File | Current issue |
|------|----------------|
| `src/pages/RealFootageGenerator.tsx` | Fixed 4–10s buttons; no audio; no completion grid/redo/Done; uses TTV doc versions 12–15 |
| `supabase/functions/_shared/stockFootage.ts` | Merges Coverr+Pexels but **ignores target duration**; always picks `results[0]` |
| `supabase/functions/setup-RF-tasks/index.ts` | Comment says TTV 12/13 → 14/15 |
| `supabase/functions/process-RF/index.ts` | Creates `story_documents` with version **14** |
| `supabase/functions/single-RF/index.ts` | version **14** |
| `RF_tasks` table | Has `tokens`, `token_updated`; **missing** `input_tokens`, `output_tokens` |
| `RF_prompt_tasks` table | Already has `input_tokens`, `output_tokens`; trigger may be missing on test DB |
| `src/pages/Documents.tsx` | RF hack on version 14 label; needs 28–31 |

---

## Build order (one task at a time)

```
Task 0  Plan & setup                    ← YOU ARE HERE
Task 1  RF document versions (28–31)
Task 2  Token migrations + triggers
Task 3  Duration slider (2–60s) + stock search by length
Task 4  Audio required + AI per-clip duration planning
Task 5  Completion UI (clips, redo, Done)
Task 6  E2E test, handoff, push, message Syver
```

---

## Task 1 — RF document versions (#5)

### Database / edge functions
- [ ] Confirm versions **28/29** (prompt JSON), **30/31** (clip folders) with Syver if needed
- [ ] `setup-RF-prompts` / `process-RF-prompt`: write prompt docs as version 28 or 29
- [ ] `setup-RF-tasks`: read prompt JSON from v28/29 (not 12/13)
- [ ] `process-RF`: create output folder doc as version 30 or 31 (not 14/15)
- [ ] `single-RF`: use version 30 for single-clip output
- [ ] `RF_tasks.version` default / inserts → 30/31

### Frontend
- [ ] `RealFootageGenerator.tsx`: filter story docs for RF prompts (28/29), not 12–15
- [ ] `Documents.tsx`:
  - [ ] `getDocumentLabel`: 28 = RF Prompts, 29 = Corrected RF Prompts, 30/31 = Real Footage Clips
  - [ ] `isFolder` checks include 30, 31
  - [ ] ZIP download handlers include 30, 31
  - [ ] Remove `RF Outputs:` title hack on version 14
- [ ] `calculate-file-size/index.ts`, `audio-folder-size/index.ts`: add 30/31 to mp4 folder list

### Test
- [ ] New RF run creates docs with v28+ and v30+, not v14
- [ ] Documents page shows correct labels

---

## Task 2 — Token billing (#2)

### Migrations (run in SQL editor on test)
- [ ] `ALTER TABLE RF_tasks ADD COLUMN input_tokens integer DEFAULT 0`
- [ ] `ALTER TABLE RF_tasks ADD COLUMN output_tokens integer DEFAULT 0`
- [ ] Create `rf_tasks_token_update()` function (mirror `ttv_prompt_tasks_token_update`)
- [ ] Create trigger on `RF_tasks` BEFORE INSERT OR UPDATE
- [ ] Verify/create `rf_prompt_tasks_token_update()` trigger on `RF_prompt_tasks`
- [ ] Inspect live DB for `MG_tasks` trigger via Syver's SQL query; mirror for `single-RF`

### Edge functions
- [ ] `generate-RF-prompt`: persist `input_tokens`, `output_tokens` on `RF_prompt_tasks`
- [ ] Any LLM call in clip phase: write tokens on `RF_tasks`
- [ ] `single-RF`: follow `single-MG` / `single-TTV` token pattern
- [ ] `redo-RF`: token handling on redo (check `redo-TTV`)

### Test
- [ ] Run generation → `user_plans.tokens_used` increases
- [ ] Formula: `input_tokens * 0.25 + output_tokens`

---

## Task 3 — Clip length + stock search (#1)

### Frontend
- [ ] Replace `CLIP_DURATIONS` buttons with **2–60s slider + number input** (TTV Grok pattern)
- [ ] Individual Prompt: same control (target length for one clip)
- [ ] Existing Document: default/target length until Task 4 per-clip planning overrides

### Backend (`stockFootage.ts`, `generate-RF`, `process-RF`)
- [ ] Pass `targetDurationSeconds` into `searchStockFootage(query, targetDuration)`
- [ ] Score candidates by `|candidate.duration - target|` (prefer closest, min duration threshold)
- [ ] Search more candidates (`per_page` / page_size) when no good match
- [ ] Same query + different target → different selected clip
- [ ] **Do not** trim video files

### Test
- [ ] 4s vs 10s same prompt → different clips
- [ ] Slider min 2, max 60

---

## Task 4 — Audio + AI per-clip duration (#3)

### Frontend (Existing Document only)
- [ ] Copy TTV audio section: load audio files (v7–10), upload, select
- [ ] Block Generate until story doc **and** audio selected
- [ ] `totalAudioDuration` from selected audio (not manual seconds field as primary)
- [ ] Pass `audio_file_path` / duration to `setup-RF-prompts`

### Backend
- [ ] `setup-RF-prompts`: accept audio metadata; compute total runtime from audio
- [ ] New or extended AI step in `generate-RF-prompt` (Supabase only):
  - Input: story segments + total audio seconds
  - Output: per-segment **search query** + **clip duration** (2–60)
  - Always on (not optional like MG UI toggle)
- [ ] `setup-RF-tasks`: create `RF_tasks` rows with **per-row `video_duration`**
- [ ] `process-RF` / `generate-RF`: use row's `video_duration` for stock search

### Reference for AI planning logic
- `plan-video/index.ts` — `clampClipDuration`, clip count from runtime (adapt for stock 2–60s, no AI video models)
- MG uses fixed `video_duration` per batch today; RF needs **variable per clip**

### Test
- [ ] No audio → cannot start Existing Document run
- [ ] With audio → clip count/durations sum sensibly to audio length
- [ ] Individual Prompt unchanged (no audio)

---

## Task 5 — Completion UI (#4)

### Frontend (`RealFootageGenerator.tsx`)
- [ ] On `completed_final` for all `RF_tasks`: load signed URLs into `generatedClips[]` (like TTV `generatedVideos`)
- [ ] "Show N clips" button + vertical clip list with `<video controls>`
- [ ] Per clip: Download + **Redo** → `redo-RF` + polling (copy TTV ~626–781)
- [ ] `RedoFeedbackModal` if redo needs user feedback text
- [ ] **Done** button (`handleDone`):
  - Delete `RF_tasks`, `RF_prompt_tasks`, `RF_prompt_context` for `group_id` + `tab`
  - `updateTabStatus(userId, 'rf', tab, 'idle')`
  - Reset all local state
  - **Keep** storage files (match TTV — confirm with Syver)
- [ ] Optional: Download ZIP (TTV has `JSZip` ~1457+ — ask Syver if required)

### Backend
- [ ] Ensure `redo-RF` works with per-clip `video_duration` from Task 4

### Test
- [ ] Full run → see all clips → redo one → Done clears DB + UI idle

---

## Task 6 — Ship

- [ ] All migrations applied on test SQL editor
- [ ] Deploy changed edge functions (`--no-verify-jwt`)
- [ ] E2E checklist in `RF-HANDOFF.md`
- [ ] Push `main`
- [ ] WhatsApp Syver: summary + how to test
- [ ] Log hours: **Real Footage Phase 2**

---

## Supabase CLI & MCP setup (Task 0)

### CLI status (verified)

```powershell
cd C:\Users\Bryce\Documents\NorthNoirOutSideWork
supabase projects list
```

Expected: **NorthNoirOutSideWork** `ncrfscpuwzdpgogirktf` shows **LINKED (●)**.

If not linked:

```powershell
supabase login
supabase link --project-ref ncrfscpuwzdpgogirktf
```

`supabase status` only works for **local** Docker Supabase — ignore that error for remote projects.

### Cursor Supabase MCP (for migrations / schema context)

1. Open **Cursor Settings → MCP → Add server**
2. Add Supabase MCP (or use [Supabase MCP docs](https://supabase.com/docs/guides/getting-started/mcp))
3. Authenticate with the account Syver invited
4. Point at project `ncrfscpuwzdpgogirktf`
5. When implementing Task 2, ask Copilot to:
   - List triggers on `TTV_prompt_tasks`, `MG_tasks`, `RF_prompt_tasks`
   - Generate migration SQL matching `ttv_prompt_tasks_token_update`

### Deploy reminder

```bash
supabase functions deploy <name> --no-verify-jwt
```

---

## Open questions for Syver

1. RF versions **28/29** and **30/31** — OK?
2. **Done** button: delete DB rows only, keep clip files in Documents (like TTV)?
3. **Download ZIP** on completion — required for RF?
4. **`RF_prompt_tasks`** trigger: create on test if missing?

---

## Hours log (Phase 2)

| Date | Task | Hours |
|------|------|-------|
| | Task 0 — Plan & setup | |
| | Task 1 — RF versions | |
| | Task 2 — Tokens | |
| | Task 3 — Duration + search | |
| | Task 4 — Audio + AI planning | |
| | Task 5 — Completion UI | |
| | Task 6 — Ship | |
