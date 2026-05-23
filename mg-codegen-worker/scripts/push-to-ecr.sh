#!/usr/bin/env bash
# Push the local docker image to ECR. Run from mg-codegen-worker/.
#
# Required env (export before running):
#   AWS_ACCOUNT_ID  — your AWS account id
#   AWS_REGION      — eu-north-1
#   ECR_REPO_NAME   — defaults to mg-codegen-worker
#   IMAGE_TAG       — defaults to latest

set -euo pipefail

# Load local config if present (fill in scripts/env.sh with your values).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/env.sh
[[ -f "${SCRIPT_DIR}/env.sh" ]] && source "${SCRIPT_DIR}/env.sh"

: "${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID is required}"
AWS_REGION="${AWS_REGION:-eu-north-1}"
ECR_REPO_NAME="${ECR_REPO_NAME:-mg-codegen-worker}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"

echo "📦  Pushing to ${ECR_URI}:${IMAGE_TAG}"

# 1. assume repo already exists (create it in the AWS Console if it doesn't).
#    We skip describe/create here because they require extra IAM permissions
#    that the deploy user often doesn't have. `docker push` will fail clearly
#    if the repo is genuinely missing.

# 2. login
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin \
      "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# 3. tag + push
docker tag mg-codegen-worker:latest "${ECR_URI}:${IMAGE_TAG}"
docker push "${ECR_URI}:${IMAGE_TAG}"

echo "✅  Pushed ${ECR_URI}:${IMAGE_TAG}"
