// generate-RF — search Coverr + Pexels for stock clips (no AI video generation).
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { searchStockFootage } from '../_shared/stockFootage.ts';

interface GenerateRFBody {
  mode: 'search';
  query: string;
  segment_text?: string;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const headers = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
    }

    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
    }

    const body: GenerateRFBody = await req.json();
    if (body.mode !== 'search') {
      return new Response(JSON.stringify({ error: 'Only mode=search is supported for RF' }), { status: 400, headers });
    }

    const query = body.query?.trim() || body.segment_text?.trim();
    if (!query) {
      return new Response(JSON.stringify({ error: 'Missing query' }), { status: 400, headers });
    }

    const result = await searchStockFootage(query);
    if (result.status === 'failed') {
      return new Response(JSON.stringify(result), { status: 422, headers });
    }

    return new Response(
      JSON.stringify({
        status: 'completed',
        video_url: result.clip!.downloadUrl,
        stock_source: result.clip!.source,
        stock_id: result.clip!.id,
        title: result.clip!.title,
        duration: result.clip!.duration,
      }),
      { status: 200, headers },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ status: 'failed', error: (e as Error).message }),
      { status: 500, headers },
    );
  }
});
