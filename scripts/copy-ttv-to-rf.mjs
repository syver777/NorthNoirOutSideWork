import fs from 'fs';
import path from 'path';

const root = path.join(import.meta.dirname, '..');
const maps = [
  ['setup-ttv-prompts', 'setup-RF-prompts'],
  ['process-ttv-task', 'process-RF-tasks'],
  ['generate-TTV-prompt', 'generate-RF-prompt'],
  ['process-TTV-prompt', 'process-RF-prompt'],
  ['trigger-next-TTV-prompt', 'trigger-next-RF-prompt'],
  ['setup-TTV-tasks', 'setup-RF-tasks'],
  ['generate-TTV', 'generate-RF'],
  ['process-TTV', 'process-RF'],
  ['trigger-next-TTV', 'trigger-next-RF'],
];

const replacements = [
  ['TTV_prompt_context', 'RF_prompt_context'],
  ['TTV_prompt_tasks', 'RF_prompt_tasks'],
  ['TTV_tasks', 'RF_tasks'],
  ['process-ttv-task', 'process-RF-tasks'],
  ['process-TTV-prompt', 'process-RF-prompt'],
  ['trigger-next-TTV-prompt', 'trigger-next-RF-prompt'],
  ['trigger-next-TTV', 'trigger-next-RF'],
  ['setup-ttv-prompts', 'setup-RF-prompts'],
  ['setup-TTV-tasks', 'setup-RF-tasks'],
  ['generate-TTV-prompt', 'generate-RF-prompt'],
  ['generate-TTV', 'generate-RF'],
  ['process-TTV', 'process-RF'],
  ['cleanTextForTTV', 'cleanTextForRF'],
  ['estimateTTVTokens', 'estimateRFTokens'],
  ['insertTTVTasks', 'insertRFTasks'],
  ['TTVSegment', 'RFSegment'],
  ['TTVTask', 'RFTask'],
  ['compileFinalTTVDocument', 'compileFinalRFDocument'],
  ['completeSingleTTVTask', 'completeSingleRFTask'],
  ['callGenerateTTV', 'callGenerateRF'],
  ['ttvTokensPerSecond', 'rfTokensPerSecond'],
  ['single_ttv', 'single_rf'],
  ['single-TTV', 'single-RF'],
  ['visual_type', 'ttv', 'visual_type', 'rf'],
];

function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
}

function transform(content) {
  let c = content;
  for (const [from, to] of replacements) {
    if (from.length === 4 && to.length === 4 && from === 'visual_type') continue;
    c = c.split(from).join(to);
  }
  c = c.replaceAll("fetchWithDenoFallback('process-RF-tasks'", "fetchSupabaseFunction('process-RF-tasks'");
  c = c.replaceAll("fetchWithDenoFallback(\"process-RF-tasks\"", "fetchSupabaseFunction('process-RF-tasks'");
  if (c.includes('setup-RF-prompts') && c.includes('fetchWithDenoFallback')) {
    c = c.replace(
      /import \{ fetchWithDenoFallback \} from '\.\.\/_shared\/fetchWithDenoFallback\.ts';/,
      `async function fetchSupabaseFunction(name: string, init: RequestInit): Promise<Response> {
  const url = \`\${Deno.env.get('SUPABASE_URL')}/functions/v1/\${name}\`;
  return fetch(url, init);
}`,
    );
  }
  return c;
}

for (const [src, dst] of maps) {
  const srcPath = path.join(root, 'supabase/functions', src);
  const dstPath = path.join(root, 'supabase/functions', dst);
  copyDir(srcPath, dstPath);
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.ts') || ent.name.endsWith('.json')) {
        const raw = fs.readFileSync(p, 'utf8');
        fs.writeFileSync(p, transform(raw));
      }
    }
  };
  walk(dstPath);
  console.log('Copied', src, '->', dst);
}
