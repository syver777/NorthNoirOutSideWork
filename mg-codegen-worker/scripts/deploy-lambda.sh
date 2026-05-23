#!/usr/bin/env bash
# Create or update the Lambda function from the ECR container image.
# Run from mg-codegen-worker/ after `push-to-ecr.sh`.
#
# Required env:
#   AWS_ACCOUNT_ID
#   AWS_REGION (default eu-north-1)
#   ECR_REPO_NAME (default mg-codegen-worker)
#   IMAGE_TAG (default latest)
#   LAMBDA_NAME (default mg-codegen-worker)
#   LAMBDA_ROLE_ARN (must exist with Remotion Lambda + S3 + ECR access)
#
#   ANTHROPIC_API_KEY
#   SUPABASE_URL
#   SUPABASE_SECRET_KEY
#   REMOTION_BUCKET_NAME      (default remotionlambda-eunorth1-xeueiza279)
#   REMOTION_FUNCTION_NAME    (default remotion-render-4-0-458-mem3008mb-disk10240mb-240sec)
#   PROCESS_MG_TASK_URL       (default https://process-mg-task.storyscriptai.deno.net/)
#   PROCESS_MG_TASK_AUTH      (same as SUPABASE_SECRET_KEY)
#   FUNCTION_URL_AUTH_TOKEN   (shared secret with edge function)

set -euo pipefail

# Load local config if present (fill in scripts/env.sh with your values).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/env.sh
[[ -f "${SCRIPT_DIR}/env.sh" ]] && source "${SCRIPT_DIR}/env.sh"

: "${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID is required}"
: "${LAMBDA_ROLE_ARN:?LAMBDA_ROLE_ARN is required}"
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_SECRET_KEY:?SUPABASE_SECRET_KEY is required}"
: "${FUNCTION_URL_AUTH_TOKEN:?FUNCTION_URL_AUTH_TOKEN is required}"

AWS_REGION="${AWS_REGION:-eu-north-1}"
ECR_REPO_NAME="${ECR_REPO_NAME:-mg-codegen-worker}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
LAMBDA_NAME="${LAMBDA_NAME:-mg-codegen-worker}"
REMOTION_BUCKET_NAME="${REMOTION_BUCKET_NAME:-remotionlambda-eunorth1-xeueiza279}"
REMOTION_FUNCTION_NAME="${REMOTION_FUNCTION_NAME:-remotion-render-4-0-458-mem3008mb-disk10240mb-240sec}"
PROCESS_MG_TASK_URL="${PROCESS_MG_TASK_URL:-https://process-mg-task.storyscriptai.deno.net/}"
PROCESS_MG_TASK_AUTH="${PROCESS_MG_TASK_AUTH:-${SUPABASE_SECRET_KEY}}"

IMAGE_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}:${IMAGE_TAG}"

ENV_VARS="Variables={ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY},SUPABASE_URL=${SUPABASE_URL},SUPABASE_SECRET_KEY=${SUPABASE_SECRET_KEY},REMOTION_BUCKET_NAME=${REMOTION_BUCKET_NAME},REMOTION_FUNCTION_NAME=${REMOTION_FUNCTION_NAME},REMOTION_REGION=${AWS_REGION},PROCESS_MG_TASK_URL=${PROCESS_MG_TASK_URL},PROCESS_MG_TASK_AUTH=${PROCESS_MG_TASK_AUTH},FUNCTION_URL_AUTH_TOKEN=${FUNCTION_URL_AUTH_TOKEN},NODE_OPTIONS=--max-old-space-size=2048}"

if aws lambda get-function --region "${AWS_REGION}" --function-name "${LAMBDA_NAME}" >/dev/null 2>&1; then
  echo "♻️   Updating existing Lambda ${LAMBDA_NAME}"
  aws lambda update-function-code \
    --region "${AWS_REGION}" \
    --function-name "${LAMBDA_NAME}" \
    --image-uri "${IMAGE_URI}" >/dev/null

  aws lambda wait function-updated \
    --region "${AWS_REGION}" \
    --function-name "${LAMBDA_NAME}"

  aws lambda update-function-configuration \
    --region "${AWS_REGION}" \
    --function-name "${LAMBDA_NAME}" \
    --timeout 900 \
    --memory-size 3008 \
    --ephemeral-storage Size=10240 \
    --environment "${ENV_VARS}" >/dev/null
else
  echo "🆕  Creating Lambda ${LAMBDA_NAME}"
  aws lambda create-function \
    --region "${AWS_REGION}" \
    --function-name "${LAMBDA_NAME}" \
    --package-type Image \
    --code "ImageUri=${IMAGE_URI}" \
    --role "${LAMBDA_ROLE_ARN}" \
    --timeout 900 \
    --memory-size 3008 \
    --ephemeral-storage Size=10240 \
    --architectures arm64 \
    --environment "${ENV_VARS}" >/dev/null

  echo "🌐  Creating Function URL"
  aws lambda create-function-url-config \
    --region "${AWS_REGION}" \
    --function-name "${LAMBDA_NAME}" \
    --auth-type NONE \
    --invoke-mode BUFFERED >/dev/null

  aws lambda add-permission \
    --region "${AWS_REGION}" \
    --function-name "${LAMBDA_NAME}" \
    --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl \
    --principal "*" \
    --function-url-auth-type NONE >/dev/null
fi

URL=$(aws lambda get-function-url-config \
  --region "${AWS_REGION}" \
  --function-name "${LAMBDA_NAME}" \
  --query FunctionUrl --output text)

echo ""
echo "✅  Lambda ${LAMBDA_NAME} ready"
echo "    Function URL: ${URL}"
echo ""
echo "Set in Supabase edge function env as MG_CODEGEN_WORKER_URL=${URL}"
