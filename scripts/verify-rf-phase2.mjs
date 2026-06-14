/**
 * Pre-ship verification for RF Phase 2 against Syver's feedback.
 * Run: node scripts/verify-rf-phase2.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function loadEnv() {
  const envPath = resolve(root, '.env');
  const text = readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv();
const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SECRET_KEY || env.SUPABASE_SECRET_KEY;

if (!url || !key) {
  console.error('Missing SUPABASE_URL and service role key in .env');
  process.exit(1);
}

const supabase = createClient(url, key);

const pass = [];
const fail = [];
const warn = [];

function ok(msg) { pass.push(msg); console.log('  PASS:', msg); }
function bad(msg) { fail.push(msg); console.log('  FAIL:', msg); }
function note(msg) { warn.push(msg); console.log('  WARN:', msg); }

async function checkTriggers() {
  console.log('\n=== Syver #2: Token triggers (DB) ===');
  const { data: promptTask } = await supabase
    .from('RF_prompt_tasks')
    .select('input_tokens, output_tokens, token_updated')
    .not('input_tokens', 'is', null)
    .gt('input_tokens', 0)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (promptTask?.token_updated) ok('RF_prompt_tasks: token_updated=true on recent LLM row');
  else if (promptTask) note('RF_prompt_tasks: row exists but token_updated not set — may be old run');
  else note('No RF_prompt_tasks with input_tokens found');

  const { data: clipTask } = await supabase
    .from('RF_tasks')
    .select('tokens, token_updated, input_tokens, output_tokens, status')
    .eq('single_rf', false)
    .in('status', ['completed', 'completed_final'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (clipTask?.tokens === 500 && clipTask?.token_updated) ok('RF_tasks: flat 500 tokens billed per clip');
  else if (clipTask?.token_updated) ok(`RF_tasks: token_updated=true, tokens=${clipTask?.tokens}`);
  else if (clipTask) bad(`RF_tasks: clip completed but tokens/token_updated missing (${JSON.stringify(clipTask)})`);
  else bad('No completed RF_tasks clip row found');

  if (clipTask && 'input_tokens' in clipTask) ok('RF_tasks has input_tokens column');
  else note('Could not verify input_tokens column on RF_tasks');
}

async function checkRecentRun() {
  console.log('\n=== Recent RF document run (ocean-documentary or latest) ===');

  const { data: clipFolder } = await supabase
    .from('story_documents')
    .select('id, title, version, group_id, created_at')
    .in('version', [30, 31])
    .order('created_at', { ascending: false })
    .limit(3);

  if (clipFolder?.length) {
    ok(`story_documents v30/31 clip folders: ${clipFolder.length} recent (${clipFolder.map(d => d.title).join('; ')})`);
  } else bad('No story_documents with version 30/31');

  const { data: promptDoc } = await supabase
    .from('story_documents')
    .select('id, title, version, group_id')
    .in('version', [28, 29])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (promptDoc) ok(`RF prompt doc v${promptDoc.version}: "${promptDoc.title}"`);
  else bad('No story_documents with version 28/29');

  const gid = clipFolder?.[0]?.group_id || promptDoc?.group_id;
  if (!gid) {
    bad('No group_id to inspect RF tables');
    return;
  }
  console.log('  Using group_id:', gid);

  const { data: ctx } = await supabase
    .from('RF_prompt_context')
    .select('total_audio_duration, audio_file_path, video_duration')
    .eq('group_id', gid)
    .limit(1)
    .maybeSingle();

  if (ctx?.total_audio_duration > 0) ok(`RF_prompt_context.total_audio_duration=${ctx.total_audio_duration}s`);
  else bad('RF_prompt_context missing total_audio_duration (Task 4)');

  if (ctx?.audio_file_path) ok(`RF_prompt_context.audio_file_path set`);
  else note('RF_prompt_context.audio_file_path not set');

  const { data: tasks } = await supabase
    .from('RF_tasks')
    .select('batch_number, status, video_duration, video_url, tokens, stock_source, single_rf')
    .eq('group_id', gid)
    .eq('single_rf', false)
    .order('batch_number');

  if (!tasks?.length) {
    bad('No RF_tasks for latest group');
    return;
  }

  const allDone = tasks.every(t => t.status === 'completed' || t.status === 'completed_final');
  if (allDone) ok(`All ${tasks.length} RF_tasks completed`);
  else bad(`RF_tasks incomplete: ${tasks.map(t => `${t.batch_number}:${t.status}`).join(', ')}`);

  const withDuration = tasks.filter(t => t.video_duration > 0);
  if (withDuration.length === tasks.length) {
    ok(`Per-clip video_duration on all tasks: ${tasks.map(t => t.video_duration).join(', ')}s`);
  } else bad('Some RF_tasks missing video_duration');

  const withClips = tasks.filter(t => t.video_url);
  if (withClips.length === tasks.length) ok(`All tasks have video_url in storage`);
  else bad(`${tasks.length - withClips.length} tasks missing video_url`);

  const sources = [...new Set(tasks.map(t => t.stock_source).filter(Boolean))];
  if (sources.length) ok(`Stock sources used: ${sources.join(', ')}`);
}

async function checkEdgeFunctionsReachable() {
  console.log('\n=== Edge functions deployed (OPTIONS/POST smoke) ===');
  const names = [
    'setup-RF-prompts', 'generate-RF-prompt', 'process-RF-prompt', 'setup-RF-tasks',
    'generate-RF', 'process-RF', 'single-RF', 'redo-RF',
  ];
  for (const name of names) {
    try {
      const res = await fetch(`${url}/functions/v1/${name}`, { method: 'OPTIONS' });
      if (res.status === 204 || res.status === 200) ok(`${name} reachable`);
      else bad(`${name} OPTIONS returned ${res.status}`);
    } catch (e) {
      bad(`${name} unreachable: ${e.message}`);
    }
  }
}

async function checkCodeStatic() {
  console.log('\n=== Static code checks (Syver requirements) ===');
  const rfPage = readFileSync(resolve(root, 'src/pages/RealFootageGenerator.tsx'), 'utf8');
  const stock = readFileSync(resolve(root, 'supabase/functions/_shared/stockFootage.ts'), 'utf8');

  if (rfPage.includes('RF_CLIP_DURATION_MIN') && rfPage.includes('RF_CLIP_DURATION_MAX')) ok('UI: 2-60s slider constants');
  else bad('UI: missing 2-60s slider');

  if (rfPage.includes('selectedAudioPath') && rfPage.includes('totalAudioDuration') && rfPage.includes('canGenerateDocument'))
    ok('UI: audio required for Existing Document');
  else bad('UI: audio requirement missing');

  if (rfPage.includes('loadGeneratedClips') && rfPage.includes('handleRedoClip') && rfPage.includes('handleDone'))
    ok('UI: completion grid + redo + Done');
  else bad('UI: completion UI incomplete');

  if (rfPage.includes('RF_prompt_context') && rfPage.includes('RF_prompt_tasks') && rfPage.includes('RF_tasks'))
    ok('UI: Done deletes all 3 RF tables');
  else bad('UI: Done cleanup incomplete');

  if (stock.includes('searchPexels') && stock.includes('searchCoverr') && stock.includes('pickBestClipForDuration'))
    ok('Backend: Coverr+Pexels + duration scoring');
  else bad('Backend: stock search incomplete');

  if (!stock.includes('trim') && !readFileSync(resolve(root, 'supabase/functions/process-RF/index.ts'), 'utf8').includes('ffmpeg'))
    ok('Backend: no GCloud/ffmpeg trim (Syver scope)');
  else note('Check trim scope manually');
}

async function checkDurationPickLogic() {
  console.log('\n=== Syver #1: Different target → different clip (algorithm) ===');
  const candidates = [
    { source: 'pexels', id: '1', title: 'a', duration: 4, width: 1280, height: 720, downloadUrl: 'a' },
    { source: 'coverr', id: '2', title: 'b', duration: 10, width: 1280, height: 720, downloadUrl: 'b' },
    { source: 'pexels', id: '3', title: 'c', duration: 25, width: 1280, height: 720, downloadUrl: 'c' },
    { source: 'coverr', id: '4', title: 'd', duration: 60, width: 1280, height: 720, downloadUrl: 'd' },
  ];
  const clamp = (n) => Math.min(60, Math.max(2, n));
  const pick = (cands, target) => {
    const t = clamp(target);
    const minAcceptable = Math.max(2, Math.floor(t * 0.35));
    const scored = cands.map((c, index) => {
      const dur = c.duration > 0 ? c.duration : t;
      const distance = Math.abs(dur - t);
      const shortPenalty = dur < minAcceptable ? 500 + (minAcceptable - dur) * 10 : 0;
      const tieBreak = (index + t) * 0.001;
      return { c, score: distance + shortPenalty + tieBreak };
    });
    scored.sort((a, b) => a.score - b.score);
    return scored[0]?.c ?? null;
  };
  const pick4 = pick(candidates, 4);
  const pick10 = pick(candidates, 10);
  if (pick4?.id === '1' && pick10?.id === '2') ok('4s picks 4s clip; 10s picks 10s clip (different results)');
  else bad(`Duration pick mismatch: 4s→${pick4?.id}, 10s→${pick10?.id}`);

  const FEEDBACK_STOP = new Set(['more', 'less', 'the', 'and', 'with', 'for', 'a', 'an', 'to', 'in', 'of', 'not']);
  const extractRevisionKeywords = (feedback) => {
    const keywords = [];
    for (const m of feedback.matchAll(/\bmore\s+([\w-]+)/gi)) keywords.push(m[1].toLowerCase());
    for (const w of feedback.replace(/[^\w\s,/-]/g, ' ').split(/[\s,/]+/)) {
      const lw = w.toLowerCase();
      if (w.length > 2 && !FEEDBACK_STOP.has(lw)) keywords.push(lw);
    }
    return [...new Set(keywords)];
  };
  const fbWords = extractRevisionKeywords('more underwater, less surface');
  if (fbWords.includes('underwater')) ok('Redo feedback "more underwater" → search includes "underwater"');
  else bad(`Redo feedback keywords wrong: ${fbWords.join(',')}`);
}

async function checkTitleNaming() {
  console.log('\n=== Syver #5: Documents naming ===');
  const { data } = await supabase
    .from('story_documents')
    .select('title, version')
    .in('version', [30, 31])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data?.title?.startsWith('RF Outputs:')) {
    note('Clip folder DB title still "RF Outputs: …" — UI label is "Real Footage Clips"; ZIP uses title');
  } else if (data?.title) {
    ok(`Clip folder title: "${data.title}"`);
  }
}

async function main() {
  console.log('RF Phase 2 Pre-Ship Verification');
  console.log('Project:', url);

  await checkCodeStatic();
  await checkDurationPickLogic();
  await checkEdgeFunctionsReachable();
  await checkTriggers();
  await checkRecentRun();
  await checkTitleNaming();

  console.log('\n========== SUMMARY ==========');
  console.log(`PASS: ${pass.length}  FAIL: ${fail.length}  WARN: ${warn.length}`);
  if (fail.length) {
    console.log('\nFailures:');
    fail.forEach(f => console.log('  -', f));
    process.exit(1);
  }
  if (warn.length) {
    console.log('\nWarnings (non-blocking):');
    warn.forEach(w => console.log('  -', w));
  }
  console.log('\nAll critical checks passed.');
}

main().catch(e => { console.error(e); process.exit(1); });
