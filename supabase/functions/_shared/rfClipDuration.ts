/** RF clip length bounds — keep in sync with src/constants/rfClipDuration.ts */
export const RF_CLIP_DURATION_MIN = 2;
export const RF_CLIP_DURATION_MAX = 60;

export function clampRFClipDuration(seconds: number): number {
  const n = Math.round(Number(seconds));
  if (Number.isNaN(n)) return 5;
  return Math.min(RF_CLIP_DURATION_MAX, Math.max(RF_CLIP_DURATION_MIN, n));
}

/** Scale per-clip durations so their sum is close to targetTotalSeconds (2–60 per clip). */
export function balanceClipDurationsToTotal(
  clips: Array<{ video_duration: number }>,
  targetTotalSeconds: number,
): void {
  if (!clips.length || targetTotalSeconds <= 0) return;

  for (const clip of clips) {
    clip.video_duration = clampRFClipDuration(clip.video_duration);
  }

  let sum = clips.reduce((s, c) => s + c.video_duration, 0);
  if (sum <= 0) {
    const even = clampRFClipDuration(Math.floor(targetTotalSeconds / clips.length));
    for (const clip of clips) clip.video_duration = even;
    sum = even * clips.length;
  }

  const tolerance = Math.max(5, targetTotalSeconds * 0.15);
  if (Math.abs(sum - targetTotalSeconds) <= tolerance) return;

  for (const clip of clips) {
    clip.video_duration = clampRFClipDuration(Math.round((clip.video_duration / sum) * targetTotalSeconds));
  }

  sum = clips.reduce((s, c) => s + c.video_duration, 0);
  const last = clips[clips.length - 1];
  const delta = targetTotalSeconds - sum;
  if (delta !== 0) {
    last.video_duration = clampRFClipDuration(last.video_duration + delta);
  }
}
