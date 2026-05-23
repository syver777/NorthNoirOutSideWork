// generate-TTV/index.ts
// Thin API gateway for all 9 video generation models.
// Two modes: 'submit' (kick off a job) and 'poll' (check status / get result URL).
//
// Submit response:  { status: 'submitted', polling_id, polling_url? }
//   Some models return a URL immediately — those set status: 'completed'.
//
// Poll response when done:
//   fal.ai / xAI → { status: 'completed', video_url: 'https://cdn...' }
//   fal.ai Veo   → { status: 'completed', video_url: 'https://v3.fal.media/...' }
//   OpenAI Sora  → { status: 'completed', sora_job_id: 'vid_...' }   (process-TTV downloads with Bearer auth)
//
// process-TTV owns the download-to-Supabase-storage step.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import OpenAI from 'npm:openai@6';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

// ── Env ────────────────────────────────────────────────────────────────────────
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
const xaiApiKey = Deno.env.get('XAI_API_KEY') ?? '';
const falApiKey = Deno.env.get('FAL_KEY') ?? '';
const openaiApiKey = Deno.env.get('OPENAI_API_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// ── Model metadata ─────────────────────────────────────────────────────────────
const MODEL_META: Record<string, {
  apiType: 'xai_grok' | 'fal_client' | 'fal_veo' | 'openai_sora';
  modelId?: string;
  apiUrl?: string;
  resolution?: string;
  highRes?: boolean;
}> = {
  seedance_pro_fast: {
    apiType: 'fal_client',
    modelId: 'fal-ai/bytedance/seedance/v1/pro/fast/text-to-video',
    resolution: '720p',
  },
  ltx23_fast: {
    apiType: 'fal_client',
    modelId: 'fal-ai/ltx-2.3/text-to-video/fast',
    resolution: '1080p',
  },
  seedance15_pro: {
    apiType: 'fal_client',
    modelId: 'fal-ai/bytedance/seedance/v1.5/pro/text-to-video',
    resolution: '1080p',
  },
  ltx23_pro: {
    apiType: 'fal_client',
    modelId: 'fal-ai/ltx-2.3/text-to-video',
    resolution: '1440p',
  },
  grok: {
    apiType: 'xai_grok',
    apiUrl: 'https://api.x.ai/v1/videos/generations',
  },
  grok_highres: {
    apiType: 'xai_grok',
    apiUrl: 'https://api.x.ai/v1/videos/generations',
    highRes: true,
  },
  veo31fast: {
    apiType: 'fal_veo',
    modelId: 'fal-ai/veo3.1/fast',
  },
  veo31: {
    apiType: 'fal_veo',
    modelId: 'fal-ai/veo3.1',
  },
  sora2pro: {
    apiType: 'openai_sora',
    modelId: 'sora-2-pro',
    resolution: '1280x720',
  },
  sora2pro_highres: {
    apiType: 'openai_sora',
    modelId: 'sora-2-pro',
    resolution: '1792x1024',
  },
};

// ── Types ──────────────────────────────────────────────────────────────────────
interface RequestBody {
  mode: 'submit' | 'poll';
  video_model: string;
  // submit fields
  prompt?: string;
  video_duration?: number;
  audio_clip?: boolean;
  high_res?: boolean;
  // poll fields
  polling_id?: string;
  polling_url?: string;
}

interface SubmitResult {
  status: 'submitted' | 'completed';
  polling_id?: string;
  polling_url?: string;
  video_url?: string;
  sora_job_id?: string;
}

interface PollResult {
  status: 'pending' | 'completed' | 'failed';
  video_url?: string;
  sora_job_id?: string;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    await supabase.from('error_logs').insert({
      message,
      details: error.message || JSON.stringify(error),
      created_at: new Date().toISOString(),
    });
  } catch (_) { /* silent */ }
}

// ── fal.ai generic client (Seedance, LTX-2.3) ─────────────────────────────────
async function submitFalClient(
  prompt: string,
  videoDuration: number,
  meta: typeof MODEL_META[string],
  audioClip: boolean = false,
): Promise<SubmitResult> {
  const modelId = meta.modelId!;
  const url = `https://queue.fal.run/${modelId}`;
  const durationSec = Math.round(videoDuration);
  const resolution = meta.resolution ?? '720p';

  // Build base arguments (common to all fal_client models)
  const args: Record<string, any> = {
    prompt,
    aspect_ratio: '16:9',
    resolution,
    generate_audio: audioClip,
  };

  // Model-specific arguments (mirrors SSAITTVGen.py generate_fal_client_video)
  if (modelId.startsWith('fal-ai/bytedance/seedance/')) {
    // Seedance models: duration as string, camera_fixed, seed
    args.duration = String(durationSec);
    args.camera_fixed = false;
    args.seed = -1;
    args.enable_safety_checker = false;
  } else if (modelId.startsWith('fal-ai/ltx-2.3/')) {
    // LTX-2.3 models: duration as number, fps
    args.duration = durationSec;
    const fps = modelId.includes('fast') ? 25 : 50;
    args.fps = fps;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${falApiKey}` },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`fal.ai client submit HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log('fal.ai client submit response:', JSON.stringify(data).slice(0, 500));

  const requestId = data.request_id;
  if (!requestId) throw new Error(`fal.ai client: no request_id in response: ${JSON.stringify(data).slice(0, 300)}`);
  return { status: 'submitted', polling_id: requestId, polling_url: data.status_url };
}

async function pollFalClient(pollingId: string, meta: typeof MODEL_META[string], storedPollingUrl?: string): Promise<PollResult> {
  const statusUrl = storedPollingUrl ?? `https://queue.fal.run/${meta.modelId!}/requests/${pollingId}/status`;
  console.log(`fal.ai client: polling status from ${statusUrl}`);
  const res = await fetch(statusUrl, { headers: { 'Authorization': `Key ${falApiKey}` } });
  if (!res.ok) {
    console.warn(`fal.ai client status HTTP ${res.status} for ${pollingId}`);
    return { status: 'pending' };
  }
  const data = await res.json();
  console.log('fal.ai client poll response:', JSON.stringify(data).slice(0, 500));

  const status = data.status as string | undefined;
  if (status === 'COMPLETED') {
    // Check for inline video URL in status response
    const inlineVideoUrl =
      data?.output?.video?.url ??
      data?.output?.videos?.[0]?.url ??
      data?.video?.url;
    if (inlineVideoUrl) {
      console.log(`fal.ai client: got inline video URL from status response`);
      return { status: 'completed', video_url: inlineVideoUrl };
    }

    // Fetch from response_url
    const resultUrl = data.response_url as string | null;
    if (!resultUrl) {
      console.warn(`fal.ai client: response_url is null for ${pollingId}`);
      return { status: 'failed', error: `fal.ai client result URL null — request expired` };
    }
    console.log(`fal.ai client: fetching result from ${resultUrl}`);
    const resultRes = await fetch(resultUrl, { headers: { 'Authorization': `Key ${falApiKey}` } });
    if (!resultRes.ok) {
      const errBody = await resultRes.text();
      console.warn(`fal.ai client result HTTP ${resultRes.status}: ${errBody.slice(0, 400)}`);
      if (resultRes.status === 500 || resultRes.status === 503) return { status: 'pending' };
      return { status: 'failed', error: `fal.ai client result HTTP ${resultRes.status}` };
    }
    const result = await resultRes.json();
    console.log('fal.ai client result:', JSON.stringify(result).slice(0, 500));
    const videoUrl =
      result?.video?.url ??
      result?.videos?.[0]?.url ??
      result?.output?.video?.url ??
      result?.output?.videos?.[0]?.url;
    if (!videoUrl) return { status: 'failed', error: `No video URL in fal.ai client result` };
    return { status: 'completed', video_url: videoUrl };
  }
  if (status === 'FAILED') return { status: 'failed', error: data.error ?? 'fal.ai client job failed' };
  return { status: 'pending' };
}

// ── xAI Grok ──────────────────────────────────────────────────────────────────
async function submitGrok(prompt: string, videoDuration: number, highRes: boolean = false): Promise<SubmitResult> {
  const payload = {
    model: 'grok-imagine-video',
    prompt,
    duration: Math.round(videoDuration),
    aspect_ratio: '16:9',
    resolution: highRes ? '720p' : '480p',
  };
  const res = await fetch('https://api.x.ai/v1/videos/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiApiKey}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`xAI Grok submit HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log('Grok submit response:', JSON.stringify(data).slice(0, 500));
  const requestId = data.request_id ?? data.id;
  if (!requestId) throw new Error(`xAI Grok: no request_id in response: ${JSON.stringify(data).slice(0, 300)}`);
  return { status: 'submitted', polling_id: requestId };
}

async function pollGrok(pollingId: string): Promise<PollResult> {
  const res = await fetch(`https://api.x.ai/v1/videos/${pollingId}`, {
    headers: { 'Authorization': `Bearer ${xaiApiKey}` },
  });

  // Always parse the body — Grok returns 4xx with a JSON error for content moderation.
  // Only skip parsing on network-level failures where there is no body.
  let data: any;
  try {
    data = await res.json();
  } catch (_) {
    console.warn(`Grok poll: non-JSON response (HTTP ${res.status}) for polling_id ${pollingId}`);
    return { status: 'pending' };
  }

  console.log(`Grok poll response (HTTP ${res.status}):`, JSON.stringify(data).slice(0, 500));

  // Content moderation rejection — Grok returns 4xx with { error: "...content moderation..." }
  if (data?.error && typeof data.error === 'string') {
    const errLower = (data.error as string).toLowerCase();
    if (errLower.includes('content moderation')) {
      console.log(`Grok content moderation rejection for polling_id ${pollingId}: ${data.error}`);
      return { status: 'failed', error: 'content_moderation' };
    }
    // Any other explicit error field on a non-ok response is a hard failure
    if (!res.ok) {
      return { status: 'failed', error: data.error };
    }
  }

  if (!res.ok) {
    console.warn(`Grok poll HTTP ${res.status} for ${pollingId} — treating as pending`);
    return { status: 'pending' };
  }

  // Check for video URL in response
  if (data?.video?.url) return { status: 'completed', video_url: data.video.url };
  const status = data.status as string | undefined;
  if (status === 'done') {
    const videoUrl = data?.video?.url;
    if (videoUrl) return { status: 'completed', video_url: videoUrl };
    return { status: 'pending' };
  }
  if (status === 'expired' || status === 'failed' || status === 'error') {
    return { status: 'failed', error: data.error ?? `xAI status: ${status}` };
  }
  return { status: 'pending' };
}

// ── Google Veo ─────────────────────────────────────────────────────────────────
async function submitFalVeo(prompt: string, videoDuration: number, meta: typeof MODEL_META[string], audioClip: boolean = false): Promise<SubmitResult> {
  const url = `https://queue.fal.run/${meta.modelId!}`;
  // fal.ai requires duration as a string like '4s', '6s', '8s'
  const durationSec = Math.round(videoDuration);
  const durationStr = `${durationSec}s`;
  const payload = {
    prompt,
    duration: durationStr,
    aspect_ratio: '16:9',
    resolution: '1080p',
    generate_audio: audioClip,
    auto_fix: true,
    safety_tolerance: '4',
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${falApiKey}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`fal.ai Veo submit HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log('fal.ai Veo submit response:', JSON.stringify(data).slice(0, 500));

  const requestId = data.request_id;
  if (!requestId) throw new Error(`fal.ai Veo: no request_id in response: ${JSON.stringify(data).slice(0, 300)}`);
  return { status: 'submitted', polling_id: requestId, polling_url: data.status_url };
}

async function pollFalVeo(pollingId: string, meta: typeof MODEL_META[string], storedPollingUrl?: string): Promise<PollResult> {
  // fal.ai normalises the model path in the status URL it returns (e.g. veo3.1/fast → veo3.1),
  // so always use the URL fal.ai gave us at submit time rather than reconstructing it.
  const statusUrl = storedPollingUrl ?? `https://queue.fal.run/${meta.modelId!}/requests/${pollingId}/status`;
  console.log(`fal.ai Veo: polling status from ${statusUrl}`);
  const res = await fetch(statusUrl, { headers: { 'Authorization': `Key ${falApiKey}` } });
  if (!res.ok) {
    console.warn(`fal.ai Veo status fetch HTTP ${res.status} for ${pollingId}`);
    return { status: 'pending' };
  }
  const data = await res.json();
  console.log('fal.ai Veo poll response:', JSON.stringify(data).slice(0, 300));

  const status = data.status as string | undefined;
  if (status === 'COMPLETED') {
    // fal.ai returns the output inline in the COMPLETED status response
    const inlineVideoUrl =
      data?.output?.video?.url ??
      data?.output?.videos?.[0]?.url ??
      data?.video?.url;
    if (inlineVideoUrl) {
      console.log(`fal.ai Veo: got inline video URL from status response`);
      return { status: 'completed', video_url: inlineVideoUrl };
    }

    // Fall back: fetch from the result URL (status URL without /status)
    const resultUrl =
      (data.response_url as string | null) ??
      (storedPollingUrl ? storedPollingUrl.replace(/\/status$/, '') : null) ??
      `https://queue.fal.run/${meta.modelId!}/requests/${pollingId}`;
    console.log(`fal.ai Veo: fetching result from ${resultUrl}`);
    const resultRes = await fetch(resultUrl, { headers: { 'Authorization': `Key ${falApiKey}` } });
    if (!resultRes.ok) {
      const errText = await resultRes.text().catch(() => '');
      console.error(`fal.ai Veo result fetch HTTP ${resultRes.status} for ${pollingId}: ${errText.slice(0, 300)}`);
      if (resultRes.status === 500 || resultRes.status === 503) {
        // Transient server error — treat as pending so the next poll attempt retries
        console.warn(`fal.ai Veo result HTTP ${resultRes.status} — will retry next poll`);
        return { status: 'pending' };
      }
      return { status: 'failed', error: `fal.ai result fetch HTTP ${resultRes.status}: ${errText.slice(0, 200)}` };
    }
    const result = await resultRes.json();
    console.log('fal.ai Veo result:', JSON.stringify(result).slice(0, 500));
    const videoUrl =
      result?.video?.url ??
      result?.videos?.[0]?.url ??
      result?.output?.video?.url ??
      result?.output?.videos?.[0]?.url;
    if (!videoUrl) return { status: 'failed', error: `No video URL in fal.ai Veo result: ${JSON.stringify(result).slice(0, 300)}` };
    return { status: 'completed', video_url: videoUrl };
  }
  if (status === 'FAILED') return { status: 'failed', error: data.error ?? 'fal.ai Veo job failed' };
  return { status: 'pending' }; // IN_QUEUE or IN_PROGRESS
}

// ── OpenAI Sora ────────────────────────────────────────────────────────────────
function createOpenAIClient(): OpenAI {
  return new OpenAI({ apiKey: openaiApiKey });
}

async function submitSora(
  prompt: string,
  videoDuration: number,
  meta: typeof MODEL_META[string],
): Promise<SubmitResult> {
  const client = createOpenAIClient();
  // Sora API requires seconds as one of the string literals '4', '8', or '12'
  const rawSec = Math.round(videoDuration);
  const soraSeconds: '4' | '8' | '12' =
    rawSec <= 4 ? '4' : rawSec <= 8 ? '8' : '12';
  const gen = await (client as any).videos.create({
    model: meta.modelId,
    prompt,
    size: meta.resolution ?? '1280x720',
    seconds: soraSeconds,
  });
  console.log('Sora submit response:', JSON.stringify(gen).slice(0, 500));
  const jobId = gen?.id;
  if (!jobId) throw new Error(`OpenAI Sora: no id in response: ${JSON.stringify(gen).slice(0, 300)}`);
  return { status: 'submitted', polling_id: jobId };
}

async function pollSora(pollingId: string): Promise<PollResult> {
  const client = createOpenAIClient();
  const job = await (client as any).videos.retrieve(pollingId);
  console.log('Sora poll response:', JSON.stringify(job).slice(0, 300));

  const status = job?.status as string | undefined;
  if (status === 'completed') {
    // process-TTV will download using the job ID and its own OPENAI_API_KEY
    return { status: 'completed', sora_job_id: pollingId };
  }
  if (status === 'failed' || status === 'cancelled') {
    return { status: 'failed', error: job?.error ?? `Sora status: ${status}` };
  }
  return { status: 'pending' };
}

// ── Main serve ─────────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method !== 'POST')
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });

    const body: RequestBody = await req.json();
    const { mode, video_model } = body;

    if (!mode || (mode !== 'submit' && mode !== 'poll'))
      return new Response(JSON.stringify({ error: "mode must be 'submit' or 'poll'" }), { status: 400, headers: responseHeaders });
    if (!video_model || !MODEL_META[video_model])
      return new Response(JSON.stringify({ error: `Unsupported video_model: ${video_model}` }), { status: 400, headers: responseHeaders });

    const meta = MODEL_META[video_model];

    // ── SUBMIT ────────────────────────────────────────────────────────────────
    if (mode === 'submit') {
      const { prompt, video_duration } = body;
      if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0)
        return new Response(JSON.stringify({ error: 'Missing prompt' }), { status: 400, headers: responseHeaders });
      if (typeof video_duration !== 'number' || video_duration <= 0)
        return new Response(JSON.stringify({ error: 'Invalid video_duration' }), { status: 400, headers: responseHeaders });

      let result: SubmitResult;
      switch (meta.apiType) {
        case 'fal_client':
          result = await submitFalClient(prompt, video_duration, meta, body.audio_clip ?? false);
          break;
        case 'xai_grok':
          result = await submitGrok(prompt, video_duration, (meta as any).highRes ?? body.high_res ?? false);
          break;
        case 'fal_veo':
          result = await submitFalVeo(prompt, video_duration, meta, body.audio_clip ?? false);
          break;
        case 'openai_sora':
          result = await submitSora(prompt, video_duration, meta);
          break;
        default:
          return new Response(JSON.stringify({ error: 'Unknown apiType' }), { status: 500, headers: responseHeaders });
      }

      return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });
    }

    // ── POLL ──────────────────────────────────────────────────────────────────
    const { polling_id, polling_url } = body;
    if (!polling_id)
      return new Response(JSON.stringify({ error: 'Missing polling_id for poll mode' }), { status: 400, headers: responseHeaders });

    let result: PollResult;
    switch (meta.apiType) {
      case 'fal_client':
        result = await pollFalClient(polling_id, meta, polling_url ?? undefined);
        break;
      case 'xai_grok':
        result = await pollGrok(polling_id);
        break;
      case 'fal_veo':
        result = await pollFalVeo(polling_id, meta, polling_url ?? undefined);
        break;
      case 'openai_sora':
        result = await pollSora(polling_id);
        break;
      default:
        return new Response(JSON.stringify({ error: 'Unknown apiType' }), { status: 500, headers: responseHeaders });
    }

    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });

  } catch (error: any) {
    await logError('Error in generate-TTV', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: responseHeaders },
    );
  }
});

