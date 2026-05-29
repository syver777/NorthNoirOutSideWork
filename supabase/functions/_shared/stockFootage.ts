/**
 * Coverr + Pexels stock video search for Real Footage.
 */

export interface StockClipCandidate {
  source: 'coverr' | 'pexels';
  id: string;
  title: string;
  duration: number;
  width: number;
  height: number;
  downloadUrl: string;
  previewUrl?: string;
}

export interface StockSearchResult {
  status: 'completed' | 'failed';
  clip?: StockClipCandidate;
  error?: string;
  candidates?: StockClipCandidate[];
}

function pickBestMp4(files: { quality?: string; width?: number; link?: string }[]): string | null {
  if (!files?.length) return null;
  const sorted = [...files].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  const hd = sorted.find(f => f.link && (f.quality === 'hd' || f.quality === 'sd' || f.quality === 'uhd'));
  return (hd ?? sorted[0])?.link ?? null;
}

export async function searchPexels(query: string, perPage = 5): Promise<StockClipCandidate[]> {
  const key = Deno.env.get('PEXELS_API_KEY') ?? '';
  if (!key) throw new Error('PEXELS_API_KEY is not set');

  const url = new URL('https://api.pexels.com/videos/search');
  url.searchParams.set('query', query);
  url.searchParams.set('per_page', String(Math.min(perPage, 15)));
  url.searchParams.set('orientation', 'landscape');

  const res = await fetch(url.toString(), {
    headers: { Authorization: key },
  });
  if (!res.ok) throw new Error(`Pexels search HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const videos = data.videos ?? [];
  const out: StockClipCandidate[] = [];

  for (const v of videos) {
    const files = v.video_files ?? [];
    const downloadUrl = pickBestMp4(files.map((f: { quality?: string; width?: number; link?: string }) => ({
      quality: f.quality,
      width: f.width,
      link: f.link,
    })));
    if (!downloadUrl) continue;
    out.push({
      source: 'pexels',
      id: String(v.id),
      title: v.url?.split('/').pop() ?? `pexels-${v.id}`,
      duration: v.duration ?? 0,
      width: v.width ?? 1920,
      height: v.height ?? 1080,
      downloadUrl,
      previewUrl: v.image,
    });
  }
  return out;
}

export async function searchCoverr(query: string, perPage = 5): Promise<StockClipCandidate[]> {
  const key = Deno.env.get('COVERR_API_KEY') ?? '';
  if (!key) throw new Error('COVERR_API_KEY is not set');

  const url = new URL('https://api.coverr.co/videos');
  url.searchParams.set('query', query);
  url.searchParams.set('page_size', String(Math.min(perPage, 20)));
  url.searchParams.set('urls', 'true');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Coverr search HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const hits = data.hits ?? [];
  const out: StockClipCandidate[] = [];

  for (const h of hits) {
    const downloadUrl = h.urls?.mp4_download ?? h.urls?.mp4 ?? h.urls?.mp4_preview;
    if (!downloadUrl) continue;
    out.push({
      source: 'coverr',
      id: String(h.id),
      title: h.title ?? `coverr-${h.id}`,
      duration: h.duration ?? 0,
      width: h.max_width ?? 1920,
      height: h.max_height ?? 1080,
      downloadUrl,
      previewUrl: h.thumbnail ?? h.poster,
    });
  }
  return out;
}

/** Merge Pexels + Coverr results; first result is default pick (Pexels preferred). */
export async function searchStockFootage(query: string): Promise<StockSearchResult> {
  const trimmed = query?.trim();
  if (!trimmed) return { status: 'failed', error: 'Empty search query' };

  const results: StockClipCandidate[] = [];
  const errors: string[] = [];

  try {
    results.push(...await searchPexels(trimmed, 5));
  } catch (e) {
    errors.push(`Pexels: ${(e as Error).message}`);
  }

  try {
    results.push(...await searchCoverr(trimmed, 5));
  } catch (e) {
    errors.push(`Coverr: ${(e as Error).message}`);
  }

  if (results.length === 0) {
    return {
      status: 'failed',
      error: errors.length ? errors.join('; ') : 'No clips found',
      candidates: [],
    };
  }

  const clip = results[0];
  return { status: 'completed', clip, candidates: results };
}
