// generate-ITV/index.ts
// Thin API gateway for Image-to-Video generation models.
// All models now use fal.ai. Two modes: 'submit' (kick off a job) and 'poll' (check status / get result URL).
//
// ALL models require `image_url` — the keyframe image to animate.
//
// Submit response:  { status: 'submitted', polling_id, polling_url? }
//                or { status: 'completed', video_url }
//
// Poll response when done:
//   fal.ai    → { status: 'completed', video_url: 'https://v3.fal.media/...' }
//
// process-ITV owns the download-to-Supabase-storage step.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

// ── Env ────────────────────────────────────────────────────────────────────────
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
const falApiKey = Deno.env.get('FAL_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// ── Negative prompt ────────────────────────────────────────────────────────────
const BASE_NEGATIVE_PROMPT =
  'blurry, low quality, distorted, extra limbs, missing limbs, broken fingers, deformed, ' +
  'glitch, artifacts, unrealistic, low resolution, bad anatomy, duplicate, cropped, watermark, ' +
  'text, logo, jpeg artifacts, noisy, oversaturated, underexposed, overexposed, flicker, ' +
  'unstable motion, motion blur, stretched, mutated, out of frame, bad proportions';

// ── ITV Model metadata — all models now use fal.ai ─────────────────────────────
const ITV_MODEL_META: Record<string, {
  apiType: 'fal_generic_itv' | 'fal_veo_itv';
  modelId: string;
  supportsAudio?: boolean;
  defaultConfig?: Record<string, any>;
}> = {
  wan22: {
    apiType: 'fal_generic_itv',
    modelId: 'fal-ai/wan/v2.2-a14b/image-to-video/turbo',
    defaultConfig: {
      resolution: '480p',
      aspect_ratio: '16:9',
      enable_safety_checker: false,
      enable_output_safety_checker: false,
      enable_prompt_expansion: false,
    },
  },
  seedance1fast: {
    apiType: 'fal_generic_itv',
    modelId: 'fal-ai/bytedance/seedance/v1/pro/fast/image-to-video',
    defaultConfig: {
      resolution: '720p',
      aspect_ratio: '16:9',
      enable_safety_checker: false,
    },
  },
  hailuo23fast: {
    apiType: 'fal_generic_itv',
    modelId: 'fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video',
    defaultConfig: {},
  },
  seedance15: {
    apiType: 'fal_generic_itv',
    modelId: 'fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
    supportsAudio: true,
    defaultConfig: {
      resolution: '1080p',
      aspect_ratio: '16:9',
      enable_safety_checker: false,
    },
  },
  ltx23fast: {
    apiType: 'fal_generic_itv',
    modelId: 'fal-ai/ltx-2.3/image-to-video/fast',
    supportsAudio: true,
    defaultConfig: {
      resolution: '1440p',
      aspect_ratio: '16:9',
      fps: 25,
    },
  },
  ltx23pro: {
    apiType: 'fal_generic_itv',
    modelId: 'fal-ai/ltx-2.3/image-to-video',
    supportsAudio: true,
    defaultConfig: {
      resolution: '1440p',
      aspect_ratio: '16:9',
      fps: 25,
    },
  },
  veo31fast: {
    apiType: 'fal_veo_itv',
    modelId: 'fal-ai/veo3.1/fast/image-to-video',
    supportsAudio: true,
  },
  ltx23pro4k: {
    apiType: 'fal_generic_itv',
    modelId: 'fal-ai/ltx-2.3/image-to-video',
    supportsAudio: true,
    defaultConfig: {
      resolution: '2160p',
      aspect_ratio: '16:9',
      fps: 25,
    },
  },
  veo31: {
    apiType: 'fal_veo_itv',
    modelId: 'fal-ai/veo3.1/image-to-video',
    supportsAudio: true,
  },
};

// ── Types ──────────────────────────────────────────────────────────────────────
interface RequestBody {
  mode: 'submit' | 'poll';
  video_model: string;
  // submit fields
  prompt?: string;
  image_url?: string;       // required for all ITV models
  video_duration?: number;
  audio_clip?: boolean;
  // poll fields
  polling_id?: string;
  polling_url?: string;
}

interface SubmitResult {
  status: 'submitted' | 'completed';
  polling_id?: string;
  polling_url?: string;
  video_url?: string;
}

interface PollResult {
  status: 'pending' | 'completed' | 'failed';
  video_url?: string;
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

function extractFalVideoUrl(data: any): string | null {
  return (
    data?.video?.url ??
    data?.videos?.[0]?.url ??
    data?.output?.video?.url ??
    data?.output?.videos?.[0]?.url ??
    null
  );
}

// ── fal.ai generic ITV (all non-Veo models) ───────────────────────────────────
async function submitFalGenericITV(
  prompt: string,
  imageUrl: string,
  videoDuration: number,
  meta: typeof ITV_MODEL_META[string],
  audioClip: boolean = false,
): Promise<SubmitResult> {
  const url = `https://queue.fal.run/${meta.modelId}`;

  const payload: Record<string, any> = {
    prompt,
    image_url: imageUrl,
    duration: videoDuration,
    ...(meta.defaultConfig || {}),
  };

  // Override audio if model supports it
  if (meta.supportsAudio) {
    payload.generate_audio = audioClip;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${falApiKey}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`fal.ai generic ITV submit HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log('fal.ai generic ITV submit response:', JSON.stringify(data).slice(0, 500));

  const requestId = data.request_id;
  if (!requestId) throw new Error(`fal.ai generic ITV: no request_id: ${JSON.stringify(data).slice(0, 300)}`);
  return { status: 'submitted', polling_id: requestId, polling_url: data.status_url };
}

async function pollFalGenericITV(
  pollingId: string,
  meta: typeof ITV_MODEL_META[string],
  storedPollingUrl?: string,
): Promise<PollResult> {
  const statusUrl = storedPollingUrl ?? `https://queue.fal.run/${meta.modelId}/requests/${pollingId}/status`;
  console.log(`fal.ai generic ITV: polling status from ${statusUrl}`);

  const res = await fetch(statusUrl, { headers: { 'Authorization': `Key ${falApiKey}` } });
  if (!res.ok) {
    console.warn(`fal.ai generic ITV status HTTP ${res.status} for ${pollingId}`);
    if (res.status === 405) {
      return { status: 'failed', error: `fal.ai generic ITV status HTTP 405 — request expired, needs resubmit` };
    }
    return { status: 'pending' };
  }
  const data = await res.json();
  console.log('fal.ai generic ITV poll response:', JSON.stringify(data).slice(0, 300));

  const status = data.status as string | undefined;
  if (status === 'COMPLETED') {
    // Check for inline video URL in the status response
    const inlineVideoUrl = extractFalVideoUrl(data);
    if (inlineVideoUrl) {
      console.log(`fal.ai generic ITV: got inline video URL from status response`);
      return { status: 'completed', video_url: inlineVideoUrl };
    }

    // Fetch from result URL
    const resultUrl =
      (data.response_url as string | null) ??
      `https://queue.fal.run/${meta.modelId}/requests/${pollingId}`;
    console.log(`fal.ai generic ITV: fetching result from ${resultUrl}`);
    const resultRes = await fetch(resultUrl, { headers: { 'Authorization': `Key ${falApiKey}` } });
    if (!resultRes.ok) {
      if (resultRes.status === 500 || resultRes.status === 503) {
        console.warn(`fal.ai generic ITV result HTTP ${resultRes.status} — will retry next poll`);
        return { status: 'pending' };
      }
      if (resultRes.status === 422) {
        let errMsg = `fal.ai generic ITV job failed (HTTP 422)`;
        try {
          const errBody = await resultRes.text();
          const errJson = JSON.parse(errBody);
          const detail = errJson?.detail?.[0]?.msg ?? errJson?.error ?? null;
          if (detail) errMsg = `fal.ai generic ITV: ${detail}`;
        } catch (_) { /* use default message */ }
        return { status: 'failed', error: errMsg };
      }
      return { status: 'failed', error: `fal.ai generic ITV result HTTP ${resultRes.status}` };
    }
    const result = await resultRes.json();
    console.log('fal.ai generic ITV result:', JSON.stringify(result).slice(0, 500));
    const videoUrl = extractFalVideoUrl(result);
    if (!videoUrl) return { status: 'failed', error: `No video URL in fal.ai generic ITV result: ${JSON.stringify(result).slice(0, 300)}` };
    return { status: 'completed', video_url: videoUrl };
  }
  if (status === 'FAILED') return { status: 'failed', error: data.error ?? 'fal.ai generic ITV job failed' };
  return { status: 'pending' }; // IN_QUEUE or IN_PROGRESS
}

// ── fal.ai Veo 3.1 ITV ────────────────────────────────────────────────────────
async function submitFalVeoITV(
  prompt: string,
  imageUrl: string,
  videoDuration: number,
  meta: typeof ITV_MODEL_META[string],
  audioClip: boolean = false,
): Promise<SubmitResult> {
  const url = `https://queue.fal.run/${meta.modelId}`;
  const durationSec = Math.round(videoDuration);
  const durationStr = `${durationSec}s`;

  const payload = {
    prompt,
    image_url: imageUrl,
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
  if (!res.ok) throw new Error(`fal.ai Veo ITV submit HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log('fal.ai Veo ITV submit response:', JSON.stringify(data).slice(0, 500));

  const requestId = data.request_id;
  if (!requestId) throw new Error(`fal.ai Veo ITV: no request_id in response: ${JSON.stringify(data).slice(0, 300)}`);
  return { status: 'submitted', polling_id: requestId, polling_url: data.status_url };
}

async function pollFalVeoITV(
  pollingId: string,
  meta: typeof ITV_MODEL_META[string],
  storedPollingUrl?: string,
): Promise<PollResult> {
  const statusUrl = storedPollingUrl ?? `https://queue.fal.run/${meta.modelId}/requests/${pollingId}/status`;
  console.log(`fal.ai Veo ITV: polling status from ${statusUrl}`);

  const res = await fetch(statusUrl, { headers: { 'Authorization': `Key ${falApiKey}` } });
  if (!res.ok) {
    console.warn(`fal.ai Veo ITV status fetch HTTP ${res.status} for ${pollingId}`);
    return { status: 'pending' };
  }
  const data = await res.json();
  console.log('fal.ai Veo ITV poll response:', JSON.stringify(data).slice(0, 300));

  const status = data.status as string | undefined;
  if (status === 'COMPLETED') {
    // fal.ai may return the output inline in the COMPLETED status response
    const inlineVideoUrl =
      data?.output?.video?.url ??
      data?.output?.videos?.[0]?.url ??
      data?.video?.url;
    if (inlineVideoUrl) {
      console.log(`fal.ai Veo ITV: got inline video URL from status response`);
      return { status: 'completed', video_url: inlineVideoUrl };
    }

    // Fall back: fetch from the result URL
    const resultUrl =
      (data.response_url as string | null) ??
      (storedPollingUrl ? storedPollingUrl.replace(/\/status$/, '') : null) ??
      `https://queue.fal.run/${meta.modelId}/requests/${pollingId}`;
    console.log(`fal.ai Veo ITV: fetching result from ${resultUrl}`);
    const resultRes = await fetch(resultUrl, { headers: { 'Authorization': `Key ${falApiKey}` } });
    if (!resultRes.ok) {
      if (resultRes.status === 500 || resultRes.status === 503) {
        console.warn(`fal.ai Veo ITV result HTTP ${resultRes.status} — will retry next poll`);
        return { status: 'pending' };
      }
      return { status: 'failed', error: `fal.ai Veo ITV result fetch HTTP ${resultRes.status}` };
    }
    const result = await resultRes.json();
    console.log('fal.ai Veo ITV result:', JSON.stringify(result).slice(0, 500));
    const videoUrl =
      result?.video?.url ??
      result?.videos?.[0]?.url ??
      result?.output?.video?.url ??
      result?.output?.videos?.[0]?.url;
    if (!videoUrl) return { status: 'failed', error: `No video URL in fal.ai Veo ITV result: ${JSON.stringify(result).slice(0, 300)}` };
    return { status: 'completed', video_url: videoUrl };
  }
  if (status === 'FAILED') return { status: 'failed', error: data.error ?? 'fal.ai Veo ITV job failed' };
  return { status: 'pending' }; // IN_QUEUE or IN_PROGRESS
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
    if (!video_model || !ITV_MODEL_META[video_model])
      return new Response(JSON.stringify({ error: `Unsupported ITV video_model: ${video_model}` }), { status: 400, headers: responseHeaders });

    const meta = ITV_MODEL_META[video_model];

    // ── SUBMIT ────────────────────────────────────────────────────────────────
    if (mode === 'submit') {
      const { prompt, image_url, video_duration } = body;

      if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0)
        return new Response(JSON.stringify({ error: 'Missing prompt' }), { status: 400, headers: responseHeaders });
      if (!image_url || typeof image_url !== 'string' || image_url.trim().length === 0)
        return new Response(JSON.stringify({ error: 'Missing image_url (required for ITV models)' }), { status: 400, headers: responseHeaders });
      if (typeof video_duration !== 'number' || video_duration <= 0)
        return new Response(JSON.stringify({ error: 'Invalid video_duration' }), { status: 400, headers: responseHeaders });

      let result: SubmitResult;
      switch (meta.apiType) {
        case 'fal_generic_itv':
          result = await submitFalGenericITV(prompt, image_url, video_duration, meta, body.audio_clip ?? false);
          break;
        case 'fal_veo_itv':
          result = await submitFalVeoITV(prompt, image_url, video_duration, meta, body.audio_clip ?? false);
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
      case 'fal_generic_itv':
        result = await pollFalGenericITV(polling_id, meta, polling_url ?? undefined);
        break;
      case 'fal_veo_itv':
        result = await pollFalVeoITV(polling_id, meta, polling_url ?? undefined);
        break;
      default:
        return new Response(JSON.stringify({ error: 'Unknown apiType' }), { status: 500, headers: responseHeaders });
    }

    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });

  } catch (error: any) {
    await logError('Error in generate-ITV', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: responseHeaders },
    );
  }
});
