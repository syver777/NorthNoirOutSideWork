# mg-codegen-worker

AWS Lambda container image (Node.js 22, `eu-north-1`) that:

1. Receives `{ task_id }` from the Supabase `single-MG` edge function.
2. Loads design + Remotion skills baked into the image.
3. Calls **Claude Opus** (`claude-opus-4-6`) to generate a bespoke Remotion
   `Clip.tsx` from the per-task motion-graphic prompt.
4. Validates the generated TSX with `esbuild`. Auto-repairs with Claude on
   failure (up to 3 attempts), falls back to a stub on final failure.
5. Writes the clip + a fresh `Root.tsx` into a `/tmp/<task_id>/` Remotion
   project skeleton.
6. Bundles it with `@remotion/bundler` and **deploys a per-render site** to
   `s3://remotionlambda-eunorth1-xeueiza279/sites/mg-jobs/<task_id>/` via
   `@remotion/lambda`'s `deploySite()`.
7. Triggers `renderMediaOnLambda` against that fresh site.
8. Writes `bundle_url`, `render_id`, `bucket_name` to the `MG_tasks` row
   and pings the existing Deno Deploy `process-mg-task` worker to poll
   render progress + bill.

## Architecture

```
Frontend
  └─► Supabase Edge: single-MG
        ├─ Claude Opus → motion_graphic_prompt + duration
        ├─ INSERT MG_tasks (status='code_gen')
        └─ POST Lambda Function URL ←──────────┐
                                               │ EdgeRuntime.waitUntil
mg-codegen-worker (this) ─ AWS Lambda eu-north-1
  ├─ load skills from image
  ├─ Claude Opus → Clip.tsx
  ├─ esbuild validate → repair → fallback
  ├─ bundle() + deploySite()  → per-job S3 site
  ├─ renderMediaOnLambda      → returns renderId
  ├─ UPDATE MG_tasks (status='rendering', render_id, bundle_url)
  └─ POST process-mg-task.storyscriptai.deno.net
                                               │
Deno Deploy: process-mg-task ──────────────────┘
  └─ poll render progress, set video_url, bill via gcf_runtime_log
```

## Build & Deploy

```bash
cd mg-codegen-worker

# 1. Pull the latest Remotion project template + skills from the sibling repo
npm run prepare-context

# 2. Build the container image
docker build --platform linux/arm64 -t mg-codegen-worker:latest .

# 3. Push to ECR
./scripts/push-to-ecr.sh

# 4. Create / update the Lambda function (one-time setup + redeploys)
./scripts/deploy-lambda.sh
```

## Environment variables (set on the Lambda)

| var                       | purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | Claude Opus calls                                               |
| `SUPABASE_URL`            | DB writes                                                       |
| `SUPABASE_SECRET_KEY`     | service role                                                    |
| `REMOTION_BUCKET_NAME`    | `remotionlambda-eunorth1-xeueiza279`                            |
| `REMOTION_FUNCTION_NAME`  | `remotion-render-4-0-458-mem3008mb-disk10240mb-240sec`          |
| `REMOTION_REGION`         | `eu-north-1`                                                    |
| `PROCESS_MG_TASK_URL`     | `https://process-mg-task.storyscriptai.deno.net/`               |
| `PROCESS_MG_TASK_AUTH`    | bearer token (same `SUPABASE_SECRET_KEY` value)                 |
| `FUNCTION_URL_AUTH_TOKEN` | shared secret the edge function sends in `Authorization` header |
