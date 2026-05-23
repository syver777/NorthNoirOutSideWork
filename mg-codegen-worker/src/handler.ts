// Lambda entry point. Invoked via Function URL POST.
//
// Auth: requires header `Authorization: Bearer <FUNCTION_URL_AUTH_TOKEN>`
// Body: { "task_id": "<uuid>" }
//
// Returns 202 immediately and runs the pipeline; the Lambda is invoked
// asynchronously (InvocationType=Event) so the response is fire-and-forget
// from the caller's perspective.

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import {
  fetchTask,
  isStopRequested,
  updateStatus,
  saveGeneratedCode,
  saveRenderTrigger,
  saveCodegenUsage,
} from "./supabase.js";
import { generateClipTsx, repairClipTsx, resetUsage, getUsage } from "./codegen.js";
import { validateTsx } from "./validate.js";
import { fallbackComponent } from "./fallback.js";
import { setupScratchProject, bundleAndDeploy } from "./bundle.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_REPAIR_ATTEMPTS = 2; // initial generation + N repairs before fallback
const FPS = 30;
const PROCESS_MG_TASK_URL = process.env.PROCESS_MG_TASK_URL ?? "";
const PROCESS_MG_TASK_AUTH = process.env.PROCESS_MG_TASK_AUTH ?? "";
const FUNCTION_URL_AUTH_TOKEN = process.env.FUNCTION_URL_AUTH_TOKEN ?? "";

interface Body {
  task_id?: string;
}

function unauthorized(): APIGatewayProxyResultV2 {
  return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
}

function badRequest(msg: string): APIGatewayProxyResultV2 {
  return { statusCode: 400, body: JSON.stringify({ error: msg }) };
}

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  // ── detect invocation source ───────────────────────────────────────
  // Function URL / API GW invocations have event.headers; direct SDK
  // invocations send the raw payload as the event itself and are
  // implicitly authorized by IAM (lambda:InvokeFunction).
  const isHttpInvoke = !!(event as any)?.headers || !!(event as any)?.requestContext;

  // ── auth (HTTP invokes only) ───────────────────────────────────────
  if (isHttpInvoke && FUNCTION_URL_AUTH_TOKEN) {
    const hdr = event.headers?.authorization ?? event.headers?.Authorization ?? "";
    if (hdr !== `Bearer ${FUNCTION_URL_AUTH_TOKEN}`) {
      console.warn("[handler] unauthorized request");
      return unauthorized();
    }
  }

  // ── parse body ──────────────────────────────────────────────────────
  let body: Body = {};
  try {
    if (isHttpInvoke) {
      body = event.body ? (JSON.parse(event.body) as Body) : {};
    } else {
      // direct SDK invoke — event IS the payload
      body = (event as unknown as Body) ?? {};
    }
  } catch {
    return badRequest("invalid JSON body");
  }
  const taskId = body.task_id;
  if (!taskId) return badRequest("task_id is required");

  console.log(`[handler] task_id=${taskId} START`);
  resetUsage();

  try {
    const codegenModel = await runPipeline(taskId);
    const usage = getUsage(codegenModel);
    console.log(
      `[handler] task_id=${taskId} DONE — ${usage.inputTokens} in / ${usage.outputTokens} out platform tokens (${codegenModel})`
    );
    return { statusCode: 202, body: JSON.stringify({ ok: true, task_id: taskId, usage }) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[handler] task_id=${taskId} FAILED: ${msg}`);
    await updateStatus(taskId, {
      status: "error",
      error: msg.slice(0, 500),
    }).catch(() => undefined);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: msg }) };
  }
};

async function runPipeline(taskId: string): Promise<string> {
  // 1. Fetch task
  await updateStatus(taskId, { status: "code_gen" });
  const task = await fetchTask(taskId);
  const durationSec = Math.max(1, Math.min(120, task.duration_seconds ?? 10));
  const durationFrames = Math.round(durationSec * FPS);

  console.log(`[pipeline] task fetched — ${durationSec}s · ${durationFrames} frames${task.video_task_id ? ` · integrated (video_task_id=${task.video_task_id})` : ' · standalone'}`);
  const codegenModel =
    task.codegen_model === "claude-sonnet-4-6" || task.codegen_model === "claude-opus-4-6"
      ? task.codegen_model
      : "claude-opus-4-6";

  // 2. Generate TSX
  let attempts = { generation: 1, repairs: 0, usedFallback: false };
  let code = "";
  try {
    code = await generateClipTsx(task, durationFrames);
  } catch (err) {
    console.error(`[pipeline] generation error: ${(err as Error).message}`);
    code = "";
  }
  if (!code) {
    console.warn("[pipeline] generation returned empty — using fallback");
    code = fallbackComponent("Clip", task.motion_graphic_prompt);
    attempts.usedFallback = true;
  }

  // 3. Validate + repair loop
  if (!attempts.usedFallback) {
    const scratchValidateDir = join("/tmp", `mg-${taskId}-validate`);
    mkdirSync(scratchValidateDir, { recursive: true });
    const validateFile = join(scratchValidateDir, "Clip.tsx");
    writeFileSync(validateFile, code, "utf8");

    let v = await validateTsx(validateFile);
    let repairs = 0;
    while (!v.ok && repairs < MAX_REPAIR_ATTEMPTS) {
      repairs += 1;
      console.warn(`[pipeline] syntax error (try ${repairs}): ${v.error.slice(0, 200)}`);
      try {
        const repaired = await repairClipTsx(code, v.error, durationFrames, codegenModel);
        if (repaired) {
          code = repaired;
          writeFileSync(validateFile, code, "utf8");
          v = await validateTsx(validateFile);
        } else {
          break;
        }
      } catch (err) {
        console.error(`[pipeline] repair error: ${(err as Error).message}`);
        break;
      }
    }
    attempts.repairs = repairs;
    if (!v.ok) {
      console.warn("[pipeline] repair exhausted — using fallback");
      code = fallbackComponent("Clip", task.motion_graphic_prompt);
      attempts.usedFallback = true;
    }
  }

  await saveGeneratedCode(taskId, code, attempts);
  await saveCodegenUsage(taskId, getUsage(codegenModel), codegenModel);

  if (await isStopRequested(taskId)) {
    throw new Error("STOP_REQUESTED");
  }

  // 4. Setup scratch project + bundle + deploy + render
  await updateStatus(taskId, { status: "bundling" });
  const scratch = setupScratchProject(taskId, code, durationFrames);

  if (await isStopRequested(taskId)) {
    throw new Error("STOP_REQUESTED");
  }

  const trigger = await bundleAndDeploy(taskId, scratch, durationFrames);
  await saveRenderTrigger(taskId, trigger);

  // 5. Hand off to process-mg-task (Deno Deploy) for polling
  if (PROCESS_MG_TASK_URL) {
    console.log(`[pipeline] handing off to ${PROCESS_MG_TASK_URL}`);
    try {
      const res = await fetch(PROCESS_MG_TASK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PROCESS_MG_TASK_AUTH}`,
        },
        body: JSON.stringify({ task_id: taskId, mode: "codegen" }),
      });
      console.log(`[pipeline] process-mg-task → HTTP ${res.status}`);
    } catch (err) {
      console.error(`[pipeline] process-mg-task invoke error: ${(err as Error).message}`);
    }
  } else {
    console.warn("[pipeline] PROCESS_MG_TASK_URL not set — render will not be polled");
  }

  return codegenModel;
}
