# AWS Lambda Node.js 22 base image (arm64)
FROM public.ecr.aws/lambda/nodejs:22

# Working dir inside the image; LAMBDA_TASK_ROOT = /var/task
WORKDIR ${LAMBDA_TASK_ROOT}

# ── Install worker deps ───────────────────────────────────────────────
COPY package.json ./
COPY tsconfig.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm install --no-save typescript@^5.6.0 @types/node@^22.7.0 @types/aws-lambda@^8.10.145 @types/react@19.2.7

# ── Build worker TypeScript ───────────────────────────────────────────
COPY src ./src
RUN npx tsc -p tsconfig.json

# Strip TS dev deps after build to keep image small
RUN npm prune --omit=dev

# ── Bake the Remotion project template + skills + inspiration MD ──────
# These are produced by `npm run prepare-context` before docker build.
COPY build-context/remotion-template ./remotion-template
COPY build-context/skills ./skills
COPY build-context/examples ./examples
COPY build-context/motion_graphics_inspiration.md ./motion_graphics_inspiration.md

# Lambda needs the handler exported via CMD ["fileBaseName.handlerName"]
CMD ["dist/handler.handler"]
