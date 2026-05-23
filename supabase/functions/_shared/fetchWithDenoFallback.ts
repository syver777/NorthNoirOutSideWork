/**
 * Server-side fetch utility that tries Deno Deploy first,
 * then falls back to Supabase Edge Function on 502/503/network errors,
 * and on 500s that look like Deno Deploy infra errors (cold-start crash,
 * isolate boot failure, etc. — i.e. responses where user code never ran).
 *
 * Only applies to functions that have BOTH a Deno Deploy version AND
 * a Supabase Edge Function backup.
 */

// Map of function names that exist on both Deno Deploy and Supabase
const DENO_DEPLOY_FUNCTIONS = new Set([
  'audio-folder-size',
  'calculate-audio-duration',
  'compile-audio',
  'master-prompt',
  'plan-video',
  'process-itv-task',
  'process-ttv-task',
  'setup-itv-prompts',
  'setup-mg-prompts',
  'setup-ttv-prompts',
  'storyscriptai-outline',
  'storyscriptai-parse',
  'storyscriptai-process-task',
  'storyscriptai-setup-prompt',
]);

/**
 * Attempts fetch to Deno Deploy first; on 502/503/network error falls back to Supabase.
 *
 * @param functionName  The edge-function name (e.g. "master-prompt")
 * @param init          Standard RequestInit (method, headers, body, …)
 * @returns             The Response from whichever succeeded
 */
export async function fetchWithDenoFallback(
  functionName: string,
  init: RequestInit,
): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const denoUrl = `https://${functionName}.storyscriptai.deno.net`;
  const supabaseFallbackUrl = `${supabaseUrl}/functions/v1/${functionName}`;

  // If this function doesn't have a Deno Deploy counterpart, go straight to Supabase
  if (!DENO_DEPLOY_FUNCTIONS.has(functionName)) {
    return fetch(supabaseFallbackUrl, init);
  }

  try {
    const response = await fetch(denoUrl, init);

    // Always treat 502/503 as infra failure → fall back.
    // For 500, only fall back if the body doesn't look like a user-code JSON error
    // (i.e. it's likely a Deno Deploy isolate boot/cold-start crash where user code
    // never ran and therefore produced no logs).
    if (
      response.status === 502 ||
      response.status === 503 ||
      response.status === 500
    ) {
      // Buffer the body so we can both inspect it and (if we don't fall back)
      // hand a readable Response back to the caller.
      const bodyText = await response.text();
      const contentType = response.headers.get('content-type') || '';

      let shouldFallback = response.status !== 500;

      if (response.status === 500) {
        // Heuristic: a user-code 500 from these functions returns JSON like
        // {"error": "..."} via their catch block. A Deno infra 500 is usually
        // HTML, empty, or a bare text/plain message.
        const looksLikeUserJsonError =
          contentType.includes('application/json') &&
          /"error"\s*:/.test(bodyText);
        shouldFallback = !looksLikeUserJsonError;
      }

      if (shouldFallback) {
        console.warn(
          `[fetchWithDenoFallback] Deno Deploy ${functionName} returned ${response.status} (content-type=${contentType}): ${bodyText.slice(0, 200)}. Falling back to Supabase.`,
        );
        return fetch(supabaseFallbackUrl, init);
      }

      // 500 with a user-code JSON error → pass through unchanged.
      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return response;
  } catch (error) {
    console.warn(
      `[fetchWithDenoFallback] Deno Deploy ${functionName} network error: ${(error as Error).message}. Falling back to Supabase.`,
    );
    return fetch(supabaseFallbackUrl, init);
  }
}
