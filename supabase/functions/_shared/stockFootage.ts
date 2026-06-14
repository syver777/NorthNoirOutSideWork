/**
 * Coverr + Pexels stock video search for Real Footage.
 */
import { clampRFClipDuration, RF_CLIP_DURATION_MIN } from './rfClipDuration.ts';

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

/** Prefer HD (720p–1080p) — good preview quality while avoiding 4K download sizes. */
function pickBestMp4(files: { quality?: string; width?: number; link?: string }[]): {
  link: string;
  width: number;
  height?: number;
} | null {
  const withLink = files.filter((f) => f.link);
  if (!withLink.length) return null;

  const byWidthDesc = [...withLink].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));

  // 1) Explicit HD rendition (~1280 wide)
  const hd = byWidthDesc.find((f) => f.quality === 'hd');
  if (hd?.link) return { link: hd.link, width: hd.width ?? 1280 };

  // 2) Best width in 720p–1080p range (avoid 4K for edge download limits)
  const sweetSpot = byWidthDesc.find((f) => {
    const w = f.width ?? 0;
    return w >= 1280 && w <= 1920;
  });
  if (sweetSpot?.link) return { link: sweetSpot.link, width: sweetSpot.width ?? 1280 };

  // 3) Largest up to 1920 (e.g. 1280 when no hd label)
  const capped = byWidthDesc.find((f) => (f.width ?? 0) > 0 && (f.width ?? 0) <= 1920);
  if (capped?.link) return { link: capped.link, width: capped.width ?? 1280 };

  // 4) Last resort — smallest available (legacy SD fallback)
  const smallest = [...withLink].sort((a, b) => (a.width ?? 9999) - (b.width ?? 9999));
  const fallback = smallest[0];
  return fallback?.link ? { link: fallback.link, width: fallback.width ?? 640 } : null;
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
    const picked = pickBestMp4(files.map((f: { quality?: string; width?: number; height?: number; link?: string }) => ({
      quality: f.quality,
      width: f.width,
      height: f.height,
      link: f.link,
    })));
    if (!picked) continue;
    out.push({
      source: 'pexels',
      id: String(v.id),
      title: v.url?.split('/').pop() ?? `pexels-${v.id}`,
      duration: v.duration ?? 0,
      width: picked.width,
      height: v.height ?? Math.round(picked.width * 9 / 16),
      downloadUrl: picked.link,
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
    // Prefer full download over preview (preview is low-res / pixelated)
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

const FEEDBACK_STOP = new Set(['more', 'less', 'the', 'and', 'with', 'for', 'a', 'an', 'to', 'in', 'of', 'not']);

function sanitizeBaseQueryLine(query: string): string {
  let q = query.trim();
  const criticalIdx = q.search(/\n\s*⚠️|\n\s*CRITICAL REQUIREMENT/i);
  if (criticalIdx >= 0) q = q.slice(0, criticalIdx);
  q = q.split('\n').map((l) => l.trim()).find(Boolean) ?? q;
  q = q.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
  q = q.replace(/[^\w\s,.-]/g, ' ').replace(/\s+/g, ' ').trim();
  return q;
}

function extractRevisionKeywords(feedback: string): string[] {
  const keywords: string[] = [];
  for (const m of feedback.matchAll(/\bmore\s+([\w-]+)/gi)) {
    keywords.push(m[1].toLowerCase());
  }
  for (const w of feedback.replace(/[^\w\s,/-]/g, ' ').split(/[\s,/]+/)) {
    const lw = w.toLowerCase();
    if (w.length > 2 && !FEEDBACK_STOP.has(lw)) keywords.push(lw);
  }
  return [...new Set(keywords)];
}

/** Build a short keyword phrase for stock APIs; revision feedback keywords are prioritized. */
export function buildStockSearchQuery(baseQuery: string, revisionFeedback?: string): string {
  let q = baseQuery.trim();
  let feedback = revisionFeedback?.trim() ?? '';
  const fbMatch = q.match(/User feedback for revision:\s*(.+)/is);
  if (fbMatch) {
    if (!feedback) feedback = fbMatch[1].split('\n')[0].trim();
    q = q.slice(0, fbMatch.index).trim();
  }

  const baseWords = sanitizeBaseQueryLine(q).split(/\s+/).filter(Boolean);

  if (feedback) {
    const fbWords = extractRevisionKeywords(feedback);
    const merged = [...new Set([...fbWords, ...baseWords])].slice(0, 7);
    return merged.join(' ').slice(0, 100);
  }

  const words = baseWords.length > 7 ? baseWords.slice(0, 7) : baseWords;
  return words.join(' ').slice(0, 100);
}

/** Short keyword phrase for stock APIs (TTV prompts include long warnings / emoji). */
export function sanitizeStockSearchQuery(query: string): string {
  return buildStockSearchQuery(query);
}

export interface StockSearchOptions {
  revisionFeedback?: string;
  excludeStock?: { source: string; id: string };
}

/** Pick the candidate whose duration is closest to the requested length (no trimming). */
export function pickBestClipForDuration(
  candidates: StockClipCandidate[],
  targetDurationSeconds: number,
  excludeStock?: { source: string; id: string },
): StockClipCandidate | null {
  if (!candidates.length) return null;

  const target = clampRFClipDuration(targetDurationSeconds);
  const minAcceptable = Math.max(RF_CLIP_DURATION_MIN, Math.floor(target * 0.35));

  const scored = candidates.map((c, index) => {
    const dur = c.duration > 0 ? c.duration : target;
    const distance = Math.abs(dur - target);
    const shortPenalty = dur < minAcceptable ? 500 + (minAcceptable - dur) * 10 : 0;
    const tieBreak = (index + target) * 0.001;
    return { c, score: distance + shortPenalty + tieBreak };
  });

  scored.sort((a, b) => a.score - b.score);

  if (excludeStock) {
    const filtered = scored.filter(
      (s) => !(s.c.source === excludeStock.source && s.c.id === excludeStock.id),
    );
    if (filtered.length) return filtered[0].c;
  }

  return scored[0]?.c ?? null;
}

/** Merge Pexels + Coverr results; rank by duration when targetDurationSeconds is set. */
export async function searchStockFootage(
  query: string,
  targetDurationSeconds?: number,
  options?: StockSearchOptions,
): Promise<StockSearchResult> {
  const trimmed = buildStockSearchQuery(query ?? '', options?.revisionFeedback);
  if (!trimmed) return { status: 'failed', error: 'Empty search query' };

  const target = targetDurationSeconds != null
    ? clampRFClipDuration(targetDurationSeconds)
    : undefined;
  const perPage = target != null ? 15 : 5;

  const results: StockClipCandidate[] = [];
  const errors: string[] = [];

  try {
    results.push(...await searchPexels(trimmed, perPage));
  } catch (e) {
    errors.push(`Pexels: ${(e as Error).message}`);
  }

  try {
    results.push(...await searchCoverr(trimmed, perPage));
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

  const exclude = options?.excludeStock;
  let clip: StockClipCandidate | null | undefined;
  if (target != null) {
    clip = pickBestClipForDuration(results, target, exclude);
  } else if (exclude) {
    clip = results.find((c) => !(c.source === exclude.source && c.id === exclude.id)) ?? results[0];
  } else {
    clip = results[0];
  }

  if (!clip) {
    return {
      status: 'failed',
      error: 'No suitable clip for target duration',
      candidates: results,
    };
  }

  return { status: 'completed', clip, candidates: results };
}
