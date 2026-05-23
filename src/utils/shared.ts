// Shared utility functions used across multiple pages

export function checkNetworkStatus(): boolean {
  return navigator.onLine;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Operation "${operation}" timed out after ${timeoutMs / 1000} seconds`)), timeoutMs);
    }),
  ]);
}

export function formatNumber(num: number): string {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return num.toString();
}

export function getWordCount(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

/**
 * Check if a string is a valid numeric value (integer or decimal).
 * Rejects inputs like "18gg", "500xxx", "12.5abc" that parseFloat/parseInt silently truncate.
 * Accepts: "18", "18.5", ".5", "1200", empty string (returns false).
 */
export function isValidNumericInput(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^-?\d*\.?\d+$/.test(trimmed);
}
