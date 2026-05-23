/**
 * Fetch with Deno Deploy → Supabase Edge Function fallback.
 * Tries the primary Deno Deploy URL first. If it returns a 503 or a network
 * error (which indicates the Deno Deploy cluster is unavailable), retries
 * the same request against the equivalent Supabase Edge Function.
 */

const DENO_TO_SUPABASE_MAP: Record<string, string> = {
  'https://storyscriptai-setup-prompt.storyscriptai.deno.net': 'storyscriptai-setup-prompt',
  'https://storyscriptai-process-task.storyscriptai.deno.net': 'storyscriptai-process-task',
  'https://master-prompt.storyscriptai.deno.net': 'master-prompt',
  'https://storyscriptai-outline.storyscriptai.deno.net': 'storyscriptai-outline',
  'https://calculate-audio-duration.storyscriptai.deno.net': 'calculate-audio-duration',
  'https://plan-video.storyscriptai.deno.net': 'plan-video',
  'https://setup-itv-prompts.storyscriptai.deno.net': 'setup-itv-prompts',
  'https://setup-ttv-prompts.storyscriptai.deno.net': 'setup-ttv-prompts',
};

function isDenoDeployUnavailable(error: any, response?: Response): boolean {
  if (response) {
    return response.status === 503 || response.status === 502;
  }
  // Network errors (fetch itself threw)
  const msg = (error?.message || '').toLowerCase();
  return msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network') ||
    msg.includes('dns') ||
    msg.includes('econnrefused') ||
    msg.includes('no_valid_cluster');
}

export async function fetchWithFallback(
  primaryUrl: string,
  options: RequestInit
): Promise<Response> {
  const supabaseFnName = DENO_TO_SUPABASE_MAP[primaryUrl];

  // If no fallback mapping exists, just do a normal fetch
  if (!supabaseFnName) {
    return fetch(primaryUrl, options);
  }

  const supabaseUrl = import.meta.env.SUPABASE_URL;
  const fallbackUrl = `${supabaseUrl}/functions/v1/${supabaseFnName}`;

  try {
    const response = await fetch(primaryUrl, options);

    if (isDenoDeployUnavailable(null, response)) {
      console.warn(
        `[fallback] Deno Deploy returned ${response.status} for ${primaryUrl}, retrying with Supabase Edge Function...`
      );
      return fetch(fallbackUrl, options);
    }

    return response;
  } catch (error: any) {
    if (isDenoDeployUnavailable(error)) {
      console.warn(
        `[fallback] Deno Deploy unreachable for ${primaryUrl}: ${error.message}. Retrying with Supabase Edge Function...`
      );
      return fetch(fallbackUrl, options);
    }
    throw error;
  }
}
