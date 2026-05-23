import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { verifyAuth } from '../_shared/utils.ts';

const ELEVENLABS_API_KEY = Deno.env.get('ELEVENLABS_API_KEY') ?? '';

if (!ELEVENLABS_API_KEY) {
  console.warn('ELEVENLABS_API_KEY is not set');
}

// Allow-list of ElevenLabs query params we forward to the upstream API.
// Keeping this strict avoids accidental SSRF / unexpected behaviour.
const SHARED_PARAMS = new Set([
  'page_size',
  'category',
  'gender',
  'age',
  'accent',
  'language',
  'search',
  'use_cases',
  'descriptives',
  'featured',
  'reader_app_enabled',
  'owner_id',
  'sort',
  'page',
  'min_notice_period_days',
  'include_custom_rates',
  'include_live_moderated',
]);

const LIBRARY_PARAMS = new Set([
  'page_size',
  'next_page_token',
  'search',
  'sort',
  'sort_direction',
  'voice_type',
  'category',
  'fine_tuning_state',
  'collection_id',
  'include_total_count',
]);

function buildUpstreamUrl(source: 'shared' | 'library', incoming: URL): string {
  const base =
    source === 'shared'
      ? 'https://api.elevenlabs.io/v1/shared-voices'
      : 'https://api.elevenlabs.io/v2/voices';
  const allowed = source === 'shared' ? SHARED_PARAMS : LIBRARY_PARAMS;
  const out = new URL(base);
  for (const [key, value] of incoming.searchParams.entries()) {
    if (key === 'source') continue;
    if (allowed.has(key)) out.searchParams.set(key, value);
  }
  if (!out.searchParams.has('page_size')) {
    out.searchParams.set('page_size', '30');
  }
  return out.toString();
}

serve(async (req: Request) => {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Require an authenticated Supabase user (prevents leaking the key via the proxy)
  const authResult = await verifyAuth(req);
  if (!authResult) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (!ELEVENLABS_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'ElevenLabs API key not configured' }),
      {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      },
    );
  }

  try {
    const url = new URL(req.url);
    const sourceParam = (url.searchParams.get('source') ?? 'shared').toLowerCase();
    if (sourceParam !== 'shared' && sourceParam !== 'library') {
      return new Response(
        JSON.stringify({ error: "source must be 'shared' or 'library'" }),
        {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        },
      );
    }

    const upstreamUrl = buildUpstreamUrl(sourceParam, url);
    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        Accept: 'application/json',
      },
    });

    const body = await upstream.text();

    return new Response(body, {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        // Allow client to cache list responses briefly to mirror ElevenLabs UX
        'Cache-Control': 'private, max-age=10',
      },
    });
  } catch (err) {
    console.error('elevenlabs-list-voices error:', err);
    return new Response(
      JSON.stringify({ error: 'Upstream request failed' }),
      {
        status: 502,
        headers: { ...cors, 'Content-Type': 'application/json' },
      },
    );
  }
});
