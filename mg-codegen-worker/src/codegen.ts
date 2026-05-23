// Claude calls for code generation + repair.
// Mirrors SSAITMG Gen.py:generate_tsx_component + repair_tsx.
// Supports per-task model selection (Opus 4.6 default, Sonnet 4.6 ~1.7×
// cheaper) — passed via MG_tasks.codegen_model and forwarded to both
// generateClipTsx() and getUsage() so prices match the model actually used.

import Anthropic from "@anthropic-ai/sdk";
import { loadSkills } from "./skills.js";
import type { CodegenTask, CodegenUsage } from "./types.js";

export const DEFAULT_MODEL =
  process.env.CODEGEN_MODEL ?? "claude-opus-4-6";

interface ModelPricing {
  in: number;        // USD per 1M input tokens
  out: number;       // USD per 1M output tokens
  cacheRead: number; // USD per 1M cache-read tokens (≈0.1× input)
  cacheWrite: number; // USD per 1M cache-write tokens (≈1.25× input)
}
const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6":   { in: 5.0, out: 25.0, cacheRead: 0.5,  cacheWrite: 6.25 },
  "claude-sonnet-4-6": { in: 3.0, out: 15.0, cacheRead: 0.3,  cacheWrite: 3.75 },
};
function pricingFor(model: string): ModelPricing {
  return PRICING[model] ?? PRICING["claude-opus-4-6"];
}

// Platform pricing: users pay $2 per 1M platform tokens; we want 40% margin.
const MARGIN = 0.4;
const USER_PRICE_PER_MTOK = 2.0;
// Convert API USD → platform tokens:
//   userChargeUsd = apiUsd / (1 - MARGIN)
//   platformTokens = userChargeUsd / USER_PRICE_PER_MTOK × 1_000_000
const USD_TO_PLATFORM_TOKENS = 1_000_000 / (USER_PRICE_PER_MTOK * (1 - MARGIN));

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.warn("[codegen] WARNING: ANTHROPIC_API_KEY not set at module load");
}

const client = new Anthropic({ apiKey: apiKey ?? "missing" });

// Running ledger across all calls for one Lambda invocation.
const ledger = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function resetUsage(): void {
  ledger.input = 0;
  ledger.output = 0;
  ledger.cacheRead = 0;
  ledger.cacheWrite = 0;
}

export function getUsage(model: string = DEFAULT_MODEL): CodegenUsage {
  const inp = ledger.input;
  const out = ledger.output;
  const cr = ledger.cacheRead;
  const cw = ledger.cacheWrite;
  const p = pricingFor(model);
  // Per-side API USD. Cache reads/writes are charged at the input rate family,
  // so they roll into the input bucket.
  const inputApiUsd =
    (inp * p.in + cr * p.cacheRead + cw * p.cacheWrite) / 1_000_000;
  const outputApiUsd = (out * p.out) / 1_000_000;
  return {
    inputTokens: Math.round(inputApiUsd * USD_TO_PLATFORM_TOKENS),
    outputTokens: Math.round(outputApiUsd * USD_TO_PLATFORM_TOKENS),
  };
}

function resolveModel(task: Pick<CodegenTask, "codegen_model">): string {
  const raw = (task.codegen_model ?? "").trim();
  if (raw === "claude-opus-4-6" || raw === "claude-sonnet-4-6") return raw;
  return DEFAULT_MODEL;
}

function stripFences(s: string): string {
  let t = s.trim();
  for (const fence of ["```tsx", "```typescript", "```ts", "```"]) {
    if (t.startsWith(fence)) {
      t = t.slice(fence.length).replace(/^\n/, "");
      break;
    }
  }
  if (t.endsWith("```")) t = t.slice(0, -3).trimEnd();
  return t;
}

const BASE_RULES = `You are an expert Remotion 4.x developer creating professional motion graphics.

CRITICAL RULES — follow exactly or the build will fail:
1. ONLY import from 'react' (default React) and 'remotion'.
   Allowed remotion exports: AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Sequence, Easing, staticFile, Img
2. NO external libraries, NO web fonts, NO Tailwind, NO CSS classes.
   Images: ONLY allowed if listed in the "Available assets" section of the user message.
   Reference them with <Img src={staticFile("filename.ext")} style={{...}} /> — never use plain <img> or external URLs.
3. ALL styling via inline style={{}} objects.
4. Export the component EXACTLY as specified (export const Clip: React.FC = () => { ... }).
5. Do NOT add any extra top-level exports, types, or interfaces outside the component.
6. noUnusedLocals is enforced — import only what you actually use.
7. Default palette: dark background #0D0D1A; neon accents: cyan #00FFFF, purple #8B5CF6, orange #F97316, green #10B981.
   When the prompt or style guidance calls for a different palette (e.g. white cinematic background), follow that direction.
8. Every visible element must animate (fade-in, slide-in, count-up, bar-grow, line-draw, etc.).
9. Use SVG for charts/bars/lines/pie — prefer simple geometric shapes (rect, circle, line, polygon, short path).
   NEVER write long SVG path data strings with hundreds of coordinates.
10. Keep the total component under 250 lines. Prioritise clear, correct, complete code over visual complexity.
11. Return ONLY raw TSX code — no markdown fences, no prose. The code MUST be complete and syntactically valid.
12. When using interpolate(), every value in inputRange and outputRange MUST be a literal number.
    NEVER pass a string into outputRange — coerce with Number(...) first if it could be string-typed.
13. inputRange in interpolate() MUST be STRICTLY monotonically increasing — every value greater
    than the previous one. NEVER repeat the same frame (e.g. [0, 30, 30, 75] is invalid).
    For instant changes, separate by at least 1 frame (e.g. [0, 30, 31, 75]). When chaining
    fade-in / hold / fade-out, use 4 distinct ascending frames like [0, 30, 90, 120].

The <skill> blocks above are authoritative reference material. Apply the Remotion technical rules
strictly (they override any conflicting habit), and use the design skills for visual taste —
hierarchy, motion, color, typography, polish. The "Motion Graphics Inspiration" examples show
the level of ambition and technique expected — borrow ideas, don't copy. Do NOT echo any
of this back; just follow it.`;

export async function generateClipTsx(
  task: CodegenTask,
  durationFrames: number
): Promise<string> {
  const name = "Clip";
  const model = resolveModel(task);
  const skillContext = loadSkills();
  const system = (skillContext ? skillContext + "\n\n---\n\n" : "") + BASE_RULES;

  let user =
    `Create a Remotion component named \`${name}\`.\n` +
    `Export: export const ${name}: React.FC = () => { ... }\n\n` +
    `Duration: ${durationFrames} frames at 30 fps = ${(durationFrames / 30).toFixed(2)}s\n\n`;

  if (task.style_guidance && task.style_guidance.trim()) {
    user += `Design direction:\n${task.style_guidance.trim()}\n\n`;
  }

  user += `Animation description:\n${task.motion_graphic_prompt}\n`;

  if (task.user_prompt && task.user_prompt.trim()) {
    user += `\nOriginal user prompt (context):\n${task.user_prompt.slice(0, 600)}\n`;
  }

  // If a prior render attempt of this exact task crashed at runtime, feed the
  // error back so Claude doesn't reproduce the same broken pattern (e.g. a
  // non-monotonic interpolate inputRange that esbuild can't see).
  if (task.last_render_error && task.last_render_error.trim()) {
    user +=
      `\n⚠️  PREVIOUS RENDER ATTEMPT FAILED WITH THIS ERROR — fix the underlying pattern, do NOT repeat it:\n` +
      `${task.last_render_error.slice(0, 800)}\n`;
  }

  // ─── Sequential batch context (only present for batch renders) ─────────
  // Lets the LLM keep visual + narrative continuity with surrounding clips.
  if (task.batch_context) {
    const bc = task.batch_context;
    user += `\n─── SEQUENCE CONTEXT ─────────────────────────────────────────────\n`;
    user += `This clip is #${bc.batch_number} of ${bc.total_batches} in a sequence`;
    if (bc.story_title) user += ` for the story "${bc.story_title}"`;
    user += `.\n`;

    if (bc.full_story_text && bc.full_story_text.trim()) {
      const fs = bc.full_story_text.trim();
      const truncated = fs.length > 6000 ? fs.slice(0, 6000) + "\n[…truncated…]" : fs;
      user += `\nFull story context (do NOT invent beyond this):\n${truncated}\n`;
    }

    if (bc.prev && bc.prev.length > 0) {
      user += `\nPrevious clips in this sequence (maintain visual continuity — same palette, similar typography weight, related motion language):\n`;
      for (const p of bc.prev) {
        const mgp = (p.motion_graphic_prompt || "").slice(0, 600);
        user += `  Clip #${p.batch_number}: ${mgp}\n`;
      }
    }

    if (bc.next && bc.next.length > 0) {
      user += `\nUpcoming clips (raw source text — for forward awareness only, do NOT render them):\n`;
      for (const n of bc.next) {
        user += `  Clip #${n.batch_number}: ${(n.user_prompt || "").slice(0, 220)}\n`;
      }
    }

    if (bc.rest_outline && bc.rest_outline.trim()) {
      user += `\nRest-of-sequence outline (one line each):\n${bc.rest_outline}\n`;
    }

    user += `\nYour clip MUST stand alone but should feel like part #${bc.batch_number} of a cohesive sequence.\n`;
    user += `─── END SEQUENCE CONTEXT ─────────────────────────────────────────\n`;
  }

  if (task.assets && task.assets.length > 0) {
    const lines = task.assets
      .filter((a) => a.name)
      .map((a) => `  - ${a.name}  —  ${a.purpose ?? ""}`)
      .join("\n");
    if (lines) {
      user +=
        `\nAvailable assets (REAL images already downloaded into public/, ` +
        `use them via <Img src={staticFile("...")} />):\n${lines}\n` +
        `Integrate at least one of these prominently — they raise production value ` +
        `far more than abstract shapes alone.\n`;
    }
  }

  console.log(`[codegen] requesting ${model} — clip name=${name}, durationFrames=${durationFrames}`);
  const resp = await client.messages.create({
    model,
    max_tokens: 16000,
    // 0.55 strikes a balance between consistency (low) and visual variety (high).
    // Repair pass below stays low (0.1) for deterministic fixes.
    temperature: 0.55,
    // Static skills + examples + base rules → cached for 5 minutes.
    // Cache writes cost 1.25× input; cache reads cost 0.1× input.
    // For our ~90K-token system prompt this drops per-request cost ~10×.
    system: [
      {
        type: "text",
        text: system,
        // cache_control is supported by the API on Opus 4.6 but not yet
        // typed in @anthropic-ai/sdk 0.32 — cast through unknown.
        cache_control: { type: "ephemeral" },
      } as unknown as Anthropic.TextBlockParam,
    ],
    messages: [{ role: "user", content: user }],
  });

  ledger.input += resp.usage.input_tokens;
  ledger.output += resp.usage.output_tokens;
  const cacheRead = (resp.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
  const cacheWrite = (resp.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;
  ledger.cacheRead += cacheRead;
  ledger.cacheWrite += cacheWrite;
  console.log(
    `[codegen] usage: +${resp.usage.input_tokens} in / +${resp.usage.output_tokens} out` +
      ` (cache read=${cacheRead}, write=${cacheWrite})`
  );

  const block = resp.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Claude returned no text block");
  }
  return stripFences(block.text);
}

export async function repairClipTsx(
  code: string,
  errorMsg: string,
  durationFrames: number,
  model: string = DEFAULT_MODEL,
): Promise<string> {
  const system =
    "You are a TypeScript/React expert. Fix the syntax errors in this Remotion component. " +
    "Return ONLY the corrected raw TSX code — no markdown fences, no prose. " +
    "Keep it under 250 lines. Use only 'react' and 'remotion' imports. " +
    "The component MUST be exported as `export const Clip: React.FC = () => { ... }`.";
  const user =
    `This Remotion component has syntax errors:\n\nERROR:\n${errorMsg.slice(0, 600)}\n\n` +
    `BROKEN CODE:\n${code}\n\n` +
    `Fix it completely. The component is named \`Clip\` and must be ${durationFrames} frames long at 30fps.`;

  console.log(`[codegen] repair request (${model}) — error head: ${errorMsg.slice(0, 120)}`);
  const resp = await client.messages.create({
    model,
    max_tokens: 16000,
    temperature: 0.1,
    system,
    messages: [{ role: "user", content: user }],
  });

  ledger.input += resp.usage.input_tokens;
  ledger.output += resp.usage.output_tokens;
  console.log(`[codegen] repair usage: +${resp.usage.input_tokens} in / +${resp.usage.output_tokens} out`);

  const block = resp.content[0];
  if (!block || block.type !== "text") return "";
  return stripFences(block.text);
}
