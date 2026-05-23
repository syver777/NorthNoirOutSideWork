# MG Code-Gen Pipeline — Deploy Guide

End-to-end deploy steps for the Option-A motion-graphics architecture:

```
Frontend  →  single-MG-codegen (Supabase edge)
               └─► EdgeRuntime.waitUntil → POST mg-codegen-worker (AWS Lambda)
                     ├─ Claude Opus generates Clip.tsx
                     ├─ esbuild validate + Claude repair + fallback
                     ├─ bundle() + deploySite() → unique S3 site per task
                     ├─ renderMediaOnLambda()
                     └─ POST process-mg-task (Deno Deploy) → polls render
```

## 0. Verify prerequisites

- AWS account access in `eu-north-1` (same region as Remotion Lambda).
- Local Docker with `linux/arm64` build support.
- AWS CLI configured (`aws configure`) with the same account.
- Supabase project secrets unchanged: `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `SUPABASE_URL`, `SECRET_KEY`, `PROCESS_MG_TASK_URL`.

## 1. Apply the DB migration

```bash
cd /Users/syver-augustmeyer/Desktop/NorthNoir
# Run via Supabase SQL editor or:
supabase db push
```

Migration file: [supabase/migrations/20250520_mg_codegen_columns.sql](supabase/migrations/20250520_mg_codegen_columns.sql)

Adds to `MG_tasks`: `motion_graphic_prompt`, `user_prompt`, `style_guidance`, `assets`, `generated_tsx_code`, `code_gen_attempts`, `code_gen_repair_count`, `code_gen_used_fallback`, `codegen_input_tokens`, `codegen_output_tokens`, `codegen_api_cost_usd`, `codegen_user_charge_usd`, `bundle_url`.

## 2. Create the Lambda IAM role (one-time)

```bash
ROLE_NAME=mg-codegen-worker-role

cat > /tmp/lambda-trust.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
JSON

aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document file:///tmp/lambda-trust.json

aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

cat > /tmp/lambda-inline.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject", "s3:GetObject", "s3:DeleteObject",
        "s3:ListBucket", "s3:GetBucketLocation",
        "s3:PutObjectAcl", "s3:CreateBucket"
      ],
      "Resource": [
        "arn:aws:s3:::remotionlambda-eunorth1-xeueiza279",
        "arn:aws:s3:::remotionlambda-eunorth1-xeueiza279/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "lambda:InvokeFunction",
        "lambda:GetFunction"
      ],
      "Resource": "arn:aws:lambda:eu-north-1:*:function:remotion-render-*"
    }
  ]
}
JSON

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name mg-codegen-worker-inline \
  --policy-document file:///tmp/lambda-inline.json

aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text
# → save this ARN as LAMBDA_ROLE_ARN
```

## 3. Build + push the worker image

```bash
cd /Users/syver-augustmeyer/Desktop/NorthNoir/mg-codegen-worker

# Sync remotion template + skills from sibling repo
npm install
npm run prepare-context

# Build for arm64
docker build --platform linux/arm64 -t mg-codegen-worker:latest .

# Push to ECR
export AWS_ACCOUNT_ID=<your account id>
export AWS_REGION=eu-north-1
chmod +x scripts/push-to-ecr.sh scripts/deploy-lambda.sh
./scripts/push-to-ecr.sh
```

## 4. Create / update the Lambda

```bash
# These must be exported in your shell:
export AWS_ACCOUNT_ID=<your account id>
export AWS_REGION=eu-north-1
export LAMBDA_ROLE_ARN=<the role arn from step 2>
export ANTHROPIC_API_KEY=<your Anthropic key>
export SUPABASE_URL=<your Supabase project URL>
export SUPABASE_SECRET_KEY=<your service role key>
export FUNCTION_URL_AUTH_TOKEN=<generate a long random string>

./scripts/deploy-lambda.sh
# → prints the Function URL. Save it for step 5.
```

## 5. Set the worker URL + auth in Supabase

```bash
cd /Users/syver-augustmeyer/Desktop/NorthNoir

# Replace the URL with the one printed by deploy-lambda.sh
supabase secrets set \
  MG_CODEGEN_WORKER_URL=<https://xxxx.lambda-url.eu-north-1.on.aws/> \
  MG_CODEGEN_WORKER_AUTH=<same value as FUNCTION_URL_AUTH_TOKEN>
```

## 6. Deploy the edge function

```bash
supabase functions deploy single-MG-codegen --no-verify-jwt
```

## 7. Redeploy process-mg-task (Deno Deploy)

The patched `denodeploy/process-mg-task.ts` short-circuits its renderMediaOnLambda call when the worker has already triggered one (it sees `lambda_render_id` already set). Deploy normally:

```bash
deployctl deploy \
  --project=process-mg-task \
  --prod \
  --import-map=denodeploy/import_map.json \
  denodeploy/process-mg-task.ts
```

## 8. Test

1. Open the dashboard, switch to **Individual Prompt** mode in Motion Graphics.
2. Pick the `claude-opus-4-6` model.
3. Optionally fill the "Style description" textarea — this becomes the design direction passed to Claude.
4. Enter a prompt, click **Generate**.
5. Watch in CloudWatch (`/aws/lambda/mg-codegen-worker`) — you should see logs:
   - `[skills] loaded N skill sources`
   - `[codegen] requesting claude-opus-4-6`
   - `[codegen] usage: +X in / +Y out`
   - `[pipeline] syntax error` then `[codegen] repair request` if Claude's first draft has issues
   - `[bundle] webpack progress`
   - `[bundle] site live at ...`
   - `[bundle] renderId=...`
   - `[pipeline] handing off to process-mg-task...`
6. Watch process-mg-task logs (Deno Deploy) for `codegen mode — reusing render`.
7. After ~30–90s the video URL appears on the dashboard.

## Iterating on the worker

After any change to `mg-codegen-worker/src/**`:

```bash
cd /Users/syver-augustmeyer/Desktop/NorthNoir/mg-codegen-worker
npm run prepare-context
docker build --platform linux/arm64 -t mg-codegen-worker:latest .
./scripts/push-to-ecr.sh
./scripts/deploy-lambda.sh
```

## Cost model

Per generation:

| line item                                                            | typical                  |
| -------------------------------------------------------------------- | ------------------------ |
| Claude Opus codegen (1k in / 6k out + 15% repair)                    | ~$0.16                   |
| Claude Opus prompt expansion (200 in / 500 out)                      | ~$0.014                  |
| Lambda bundle/render trigger Lambda runtime (~60s @ 3008MB arm64)    | ~$0.003                  |
| Remotion render Lambda (per-second, MG_LAMBDA_TOKENS_PER_SECOND=180) | varies w/ clip length    |
| S3 storage of per-task site (~5MB)                                   | negligible until cleanup |

Billed to user with 40 % margin: `user_charge = api_cost / (1 − 0.40)`.

## Known limitations / follow-ups

- **No per-task site cleanup yet.** Each render leaves a site at `s3://remotionlambda-eunorth1-xeueiza279/sites/mg-jobs/<task_id>/`. Add a nightly cleanup job (S3 lifecycle rule on the `sites/mg-jobs/` prefix with 7-day expiration) to keep costs flat.
- **Document mode unchanged.** The existing `single-MG` + `process-mg-task` legacy template path still works for the document flow. Migrating it to codegen is straightforward (same edge function shape) but out of scope for this rollout.
- **`testTS` Python pipeline does NOT have the numeric-coercion bug.** Each `ClipNN.tsx` is bespoke per call, so Claude bakes literal numbers into `interpolate()` calls. The worker also enforces this in BASE_RULES rule #12.
- **No automatic LLM retry on render failure.** If the Lambda render itself errors after bundling, we don't currently re-prompt Claude — we just surface the error.
