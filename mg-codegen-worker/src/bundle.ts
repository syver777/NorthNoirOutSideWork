// Bundles the per-task Remotion project + deploys a unique S3 site + triggers Lambda render.
//
// Lifecycle:
//   1. setupScratchProject() — copies the baked /var/task/remotion-template/ into /tmp/<task_id>/
//   2. writes Clip.tsx + a generated Root.tsx that registers only the Clip composition
//   3. bundle() the project to a directory
//   4. deploySite() uploads it under `sites/mg-jobs/<task_id>/` for true per-render uniqueness
//   5. renderMediaOnLambda() returns a renderId; we hand it to process-mg-task for polling.

import { cpSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { deploySite } from "@remotion/lambda";
import { renderMediaOnLambda } from "@remotion/lambda/client";
import type { RenderTrigger } from "./types.js";

const TASK_ROOT = process.env.LAMBDA_TASK_ROOT ?? process.cwd();
const TEMPLATE_DIR = join(TASK_ROOT, "remotion-template");

const REGION = (process.env.REMOTION_REGION ?? "eu-north-1") as
  | "eu-north-1"
  | "us-east-1"
  | "eu-central-1";
const BUCKET_NAME = process.env.REMOTION_BUCKET_NAME ?? "";
const FUNCTION_NAME = process.env.REMOTION_FUNCTION_NAME ?? "";

if (!BUCKET_NAME) console.warn("[bundle] WARNING: REMOTION_BUCKET_NAME not set");
if (!FUNCTION_NAME) console.warn("[bundle] WARNING: REMOTION_FUNCTION_NAME not set");

const COMPOSITION_ID = "Clip";
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;

export function setupScratchProject(taskId: string, clipTsx: string, durationFrames: number): string {
  const scratch = join("/tmp", `mg-${taskId}`);
  rmSync(scratch, { recursive: true, force: true });

  if (!existsSync(TEMPLATE_DIR)) {
    throw new Error(`Remotion template missing at ${TEMPLATE_DIR}`);
  }
  cpSync(TEMPLATE_DIR, scratch, { recursive: true });

  // We need node_modules. The Lambda image doesn't ship the Remotion project's
  // own node_modules — we reuse the worker's installed packages by symlinking.
  // @remotion/bundler resolves from the project root, so we ensure node_modules
  // points at the worker's installed packages.
  const tmplNm = join(scratch, "node_modules");
  if (!existsSync(tmplNm)) {
    // Lambda /tmp can't symlink across read-only mounts reliably — copy is safest
    // but expensive. Instead, point @remotion/bundler at our worker dir via
    // a small package-resolution shim: write a tiny package.json that pulls deps
    // from the parent worker node_modules via "file:" links.
    // SIMPLER: link the worker's node_modules into the scratch project.
    try {
      symlinkSync(join(TASK_ROOT, "node_modules"), tmplNm, "dir");
      console.log(`[bundle] symlinked node_modules → ${TASK_ROOT}/node_modules`);
    } catch (err) {
      console.warn(`[bundle] symlink failed (${(err as Error).message}); copying instead`);
      cpSync(join(TASK_ROOT, "node_modules"), tmplNm, { recursive: true });
    }
  }

  const clipsDir = join(scratch, "src", "clips");
  mkdirSync(clipsDir, { recursive: true });
  writeFileSync(join(clipsDir, "Clip.tsx"), clipTsx, "utf8");

  // Minimal Root.tsx registering ONLY this clip — overwrites whatever was in the template.
  const rootTsx = `import "./index.css";
import React from "react";
import { Composition } from "remotion";
import { Clip } from "./clips/Clip";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="${COMPOSITION_ID}"
      component={Clip}
      durationInFrames={${durationFrames}}
      fps={${FPS}}
      width={${WIDTH}}
      height={${HEIGHT}}
    />
  );
};
`;
  writeFileSync(join(scratch, "src", "Root.tsx"), rootTsx, "utf8");

  // Overwrite template index.css — clips are styled inline (per the codegen
  // prompt: "NO Tailwind, NO CSS classes"). The template ships with
  // `@import "tailwindcss";` which webpack can't resolve because tailwindcss
  // is not installed in the Lambda image.
  writeFileSync(
    join(scratch, "src", "index.css"),
    "body { margin: 0; padding: 0; background: #000; }\n",
    "utf8"
  );

  console.log(`[bundle] scratch project ready at ${scratch}`);
  return scratch;
}

export async function bundleAndDeploy(
  taskId: string,
  scratchDir: string,
  durationFrames: number
): Promise<RenderTrigger> {
  const entry = join(scratchDir, "src", "index.ts");
  console.log(`[bundle] deploying site (deploySite bundles internally) entry=${entry}`);

  // deploySite (from @remotion/lambda) bundles + uploads to S3 in one step.
  // No separate bundle() call needed — that path is for non-Lambda renders.
  const { serveUrl } = await deploySite({
    bucketName: BUCKET_NAME,
    siteName: `mg-jobs/${taskId}`,
    entryPoint: entry,
    region: REGION,
    options: {
      onBundleProgress: (p) => {
        if (p % 25 < 1) console.log(`[bundle] webpack progress ${p}%`);
      },
    },
  });

  console.log(`[bundle] site live at ${serveUrl}; triggering renderMediaOnLambda`);

  const { renderId, bucketName } = await renderMediaOnLambda({
    region: REGION,
    functionName: FUNCTION_NAME,
    serveUrl,
    composition: COMPOSITION_ID,
    inputProps: {},
    codec: "h264",
    maxRetries: 1,
    privacy: "public",
    downloadBehavior: { type: "play-in-browser" },
    framesPerLambda: 60,
  });

  console.log(`[bundle] renderId=${renderId} bucket=${bucketName}`);

  return {
    render_id: renderId,
    bucket_name: bucketName,
    bundle_url: serveUrl,
    composition_id: COMPOSITION_ID,
    duration_frames: durationFrames,
  };
}
