// Loads skill files baked into the Lambda image at /var/task/skills/ +
// the inspiration markdown at /var/task/motion_graphics_inspiration.md.
//
// Cached on first call for the lifetime of the warm container.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";

const TASK_ROOT = process.env.LAMBDA_TASK_ROOT ?? process.cwd();
const SKILLS_DIR = join(TASK_ROOT, "skills");
const EXAMPLES_DIR = join(TASK_ROOT, "examples");
const INSPIRATION_PATH = join(TASK_ROOT, "motion_graphics_inspiration.md");

// Authoritative order — Remotion rules first, then design skills, then inspiration.
const SKILL_ORDER = [
  "remotion-best-practices/SKILL.md",
  "remotion-best-practices/rules/text-animations.md",
  "remotion-best-practices/rules/timing.md",
  "remotion-best-practices/rules/transitions.md",
  "remotion-best-practices/rules/sequencing.md",
  "remotion-best-practices/rules/images.md",
  "frontend-design/SKILL.md",
  "animate/SKILL.md",
  "colorize/SKILL.md",
  "typeset/SKILL.md",
  "polish/SKILL.md",
  "arrange/SKILL.md",
  "bolder/SKILL.md",
  "delight/SKILL.md",
  "overdrive/SKILL.md",
  "distill/SKILL.md",
];

let cached: string | null = null;

export function loadSkills(): string {
  if (cached !== null) return cached;

  const parts: string[] = [];

  for (const rel of SKILL_ORDER) {
    const full = join(SKILLS_DIR, rel);
    if (!existsSync(full)) continue;
    try {
      const body = readFileSync(full, "utf8").trim();
      if (body) {
        const label = `${basename(dirname(full))}/${basename(full)}`;
        parts.push(`<skill source="${label}">\n${body}\n</skill>`);
      }
    } catch {
      /* skip */
    }
  }

  // Pull in any extra rule .md files we haven't explicitly listed
  // (so dropping new files into remotion-best-practices/rules/ works automatically).
  const rulesDir = join(SKILLS_DIR, "remotion-best-practices", "rules");
  if (existsSync(rulesDir) && statSync(rulesDir).isDirectory()) {
    for (const fname of readdirSync(rulesDir)) {
      const rel = `remotion-best-practices/rules/${fname}`;
      if (SKILL_ORDER.includes(rel)) continue;
      if (!fname.endsWith(".md")) continue;
      try {
        const body = readFileSync(join(rulesDir, fname), "utf8").trim();
        if (body) {
          parts.push(`<skill source="${rel}">\n${body}\n</skill>`);
        }
      } catch {
        /* skip */
      }
    }
  }

  if (existsSync(INSPIRATION_PATH)) {
    try {
      const body = readFileSync(INSPIRATION_PATH, "utf8").trim();
      if (body) {
        parts.push(`<skill source="motion_graphics_inspiration.md">\n${body}\n</skill>`);
      }
    } catch {
      /* skip */
    }
  }

  // Few-shot examples — real hand-crafted clips (Clip01..Clip09).
  // Placed AFTER skills + inspiration so they sit closest to the user
  // message; Claude weights nearby content more heavily.
  if (existsSync(EXAMPLES_DIR) && statSync(EXAMPLES_DIR).isDirectory()) {
    const exampleHeader =
      "Below are reference clips from our production library. " +
      "Study their patterns — interpolate() signatures, easing choices, " +
      "layered SVG, fps-based timing, color palettes, animation density. " +
      "Match this LEVEL OF AMBITION and TECHNIQUE in your own output. " +
      "Do NOT copy any clip verbatim; build something new for the task at hand.";
    parts.push(`<examples_intro>\n${exampleHeader}\n</examples_intro>`);

    const exampleFiles = readdirSync(EXAMPLES_DIR)
      .filter((f) => f.endsWith(".tsx"))
      .sort();
    for (const fname of exampleFiles) {
      try {
        const body = readFileSync(join(EXAMPLES_DIR, fname), "utf8").trim();
        if (body) {
          const name = fname.replace(/\.tsx$/, "");
          parts.push(`<example name="${name}">\n\`\`\`tsx\n${body}\n\`\`\`\n</example>`);
        }
      } catch {
        /* skip */
      }
    }
  }

  cached = parts.join("\n\n");
  console.log(`[skills] loaded ${parts.length} skill sources (${cached.length} chars)`);
  return cached;
}
