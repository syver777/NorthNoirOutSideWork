#!/usr/bin/env node
// Copies the Remotion project template + design skills + inspiration MD
// from the sibling `remotion-motion-graphics` repo into `build-context/`
// so the Dockerfile can `COPY` them into the image.
//
// Run from `mg-codegen-worker/` via: npm run prepare-context

import { mkdirSync, cpSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(__dirname, "..");
const remotionRoot = resolve(workerRoot, "..", "..", "remotion-motion-graphics");
const ctxRoot = resolve(workerRoot, "build-context");

if (!existsSync(remotionRoot)) {
  console.error(`❌  Sibling repo not found at: ${remotionRoot}`);
  process.exit(1);
}

console.log(`📦  Preparing build context from: ${remotionRoot}`);

// Wipe + recreate
rmSync(ctxRoot, { recursive: true, force: true });
mkdirSync(ctxRoot, { recursive: true });

// ── 1. Remotion template (project skeleton — NO node_modules, NO clip files) ──
const tmplDst = resolve(ctxRoot, "remotion-template");
mkdirSync(resolve(tmplDst, "src", "clips"), { recursive: true });
mkdirSync(resolve(tmplDst, "public"), { recursive: true });

// Copy files needed for `@remotion/bundler` to bundle the project.
const copyFile = (rel) => {
  const from = resolve(remotionRoot, rel);
  const to = resolve(tmplDst, rel);
  if (!existsSync(from)) {
    console.warn(`  ⚠️  skip (missing): ${rel}`);
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  console.log(`  + ${rel}`);
};

copyFile("package.json");
copyFile("tsconfig.json");
copyFile("remotion.config.ts");
copyFile("src/index.ts");
copyFile("src/index.css");

// We do NOT copy src/Root.tsx — the worker generates it dynamically per task.
// We do NOT copy src/clips/* — the worker writes a single Clip.tsx per task.
// We do NOT copy src/types/ — the per-task project has no MGInputProps deps.
// We do NOT copy HelloWorld* — not needed for the bundled site.

// ── 2. Skills (already synced into remotion repo at .agents/skills/) ─────────
const skillsSrc = resolve(remotionRoot, ".agents", "skills");
const skillsDst = resolve(ctxRoot, "skills");
if (!existsSync(skillsSrc)) {
  console.error(`❌  Skills missing at ${skillsSrc} — run the sync first.`);
  process.exit(1);
}
cpSync(skillsSrc, skillsDst, { recursive: true });
console.log(`  + skills/ (recursive)`);

// ── 3. Few-shot examples (Clip01..Clip09 from src/clips/) ────────────────────
// These are real, hand-crafted reference clips. We feed them to Claude
// as <example> blocks so it sees the level of ambition + the exact
// patterns we want (interpolate signatures, easings, layered SVG, etc.).
const examplesDst = resolve(ctxRoot, "examples");
mkdirSync(examplesDst, { recursive: true });
const clipsDir = resolve(remotionRoot, "src", "clips");
let exampleCount = 0;
for (let i = 1; i <= 9; i++) {
  const fname = `Clip0${i}.tsx`;
  const from = resolve(clipsDir, fname);
  if (!existsSync(from)) {
    console.warn(`  ⚠️  skip example (missing): ${fname}`);
    continue;
  }
  cpSync(from, resolve(examplesDst, fname));
  exampleCount++;
}
console.log(`  + examples/ (${exampleCount} clip files)`);

// ── 4. Inspiration markdown ──────────────────────────────────────────────────
const inspSrc = resolve(remotionRoot, "motion_graphics_inspiration.md");
const inspDst = resolve(ctxRoot, "motion_graphics_inspiration.md");
if (existsSync(inspSrc)) {
  cpSync(inspSrc, inspDst);
  console.log("  + motion_graphics_inspiration.md");
} else {
  writeFileSync(inspDst, "# Motion Graphics Inspiration\n\n(empty)\n", "utf8");
  console.warn("  ⚠️  inspiration MD missing — created empty placeholder");
}

console.log(`\n✅  build context ready at: ${ctxRoot}`);
