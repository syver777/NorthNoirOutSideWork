// esbuild-based TSX validator. Returns { ok, error } per call.
// Runs as a library call (no subprocess) for speed inside the Lambda.

import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

export interface ValidationResult {
  ok: boolean;
  error: string;
}

// Catches the most common Remotion runtime crash that esbuild can't see:
//   interpolate(frame, [0, 30, 30, 75], [...])
// Remotion requires inputRange to be strictly monotonically increasing. If
// any literal interpolate(..., [n1, n2, ...], ...) array has equal or
// decreasing adjacent numeric values, we flag it as a syntax error so the
// repair loop kicks in (instead of failing at renderMediaOnLambda time).
function checkInterpolateInputRanges(source: string): string | null {
  const regex = /\binterpolate\s*\(\s*[^,()]+,\s*\[([^\][]*)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const raw = match[1];
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const nums: number[] = [];
    for (const p of parts) {
      if (!/^-?\d+(\.\d+)?$/.test(p)) { nums.length = 0; break; }
      nums.push(parseFloat(p));
    }
    if (nums.length < 2) continue;
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] <= nums[i - 1]) {
        return `interpolate() inputRange must be strictly monotonically increasing but got [${nums.join(", ")}]. Fix by separating adjacent values by at least 1 (e.g. [0, 30, 31, 75]).`;
      }
    }
  }
  return null;
}

export async function validateTsx(filePath: string): Promise<ValidationResult> {
  try {
    await esbuild.build({
      entryPoints: [filePath],
      bundle: false,
      write: false,
      loader: { ".tsx": "tsx", ".ts": "ts" },
      jsx: "automatic",
      logLevel: "silent",
      // With bundle:false esbuild only parses+transforms the entry file
      // (no module resolution), so we don't need `external`. Adding
      // `external` here is actually an esbuild error: "Cannot use external
      // without bundle".
    });
    try {
      const src = readFileSync(filePath, "utf8");
      const semErr = checkInterpolateInputRanges(src);
      if (semErr) return { ok: false, error: semErr };
    } catch { /* ignore — file already validated by esbuild */ }
    return { ok: true, error: "" };
  } catch (err: unknown) {
    const e = err as { errors?: Array<{ text?: string; location?: { line?: number; column?: number; file?: string } }>; message?: string };
    if (e?.errors && e.errors.length > 0) {
      const lines = e.errors.slice(0, 5).map((ee) => {
        const loc = ee.location ? `:${ee.location.line}:${ee.location.column}` : "";
        return `${loc} ${ee.text ?? ""}`;
      });
      return { ok: false, error: lines.join("\n").trim() };
    }
    return { ok: false, error: e?.message ?? String(err) };
  }
}
