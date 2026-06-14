/** RF clip length slider bounds (Task 3). */
export const RF_CLIP_DURATION_MIN = 2;
export const RF_CLIP_DURATION_MAX = 60;

export function clampRFClipDuration(seconds: number): number {
  const n = Math.round(Number(seconds));
  if (Number.isNaN(n)) return 5;
  return Math.min(RF_CLIP_DURATION_MAX, Math.max(RF_CLIP_DURATION_MIN, n));
}
