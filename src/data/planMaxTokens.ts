// src/data/planMaxTokens.ts
// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for the per-plan monthly token allotment shown in the
// frontend. Mirrors supabase/functions/_shared/planMaps.ts on the backend.
// All UI estimators / progress bars MUST go through `getPlanMaxTokens` so the
// legacy vs new token allotments stay in lockstep with `is_legacy_plan`.
// ─────────────────────────────────────────────────────────────────────────────

export type PlanType =
  | 'free'
  | 'standard'
  | 'plus'
  | 'premium'
  | 'pro'
  | 'elite'
  | 'ultimate'
  | 'enterprise';

/** Grandfathered allotments — only valid when `user_plans.is_legacy_plan === true`. */
export const LEGACY_PLAN_MAX_TOKENS: Record<PlanType, number> = {
  free: 400_000,
  standard: 4_000_000,
  plus: 6_000_000,
  premium: 10_000_000,
  pro: 25_000_000,
  elite: 50_000_000,
  ultimate: 75_000_000,
  enterprise: 250_000_000,
};

/** New (post-cutover) allotments — used when `is_legacy_plan === false`. */
export const NEW_PLAN_MAX_TOKENS: Record<PlanType, number> = {
  free: 400_000,
  standard: 9_000_000,
  // Plus is legacy-only; if a NEW user is somehow tagged 'plus', fall back to legacy.
  plus: 6_000_000,
  premium: 18_500_000,
  pro: 38_500_000,
  elite: 78_500_000,
  ultimate: 198_000_000,
  enterprise: 498_000_000,
};

/**
 * Returns the correct monthly token allotment for a plan, accounting for
 * whether the subscription is grandfathered (legacy) or on the new pricing.
 * Defaults to the Free legacy allotment if the plan name is unknown.
 */
export function getPlanMaxTokens(planType: string | null | undefined, isLegacy: boolean): number {
  const key = (planType ?? 'free').toLowerCase() as PlanType;
  const map = isLegacy ? LEGACY_PLAN_MAX_TOKENS : NEW_PLAN_MAX_TOKENS;
  return map[key] ?? LEGACY_PLAN_MAX_TOKENS[key] ?? LEGACY_PLAN_MAX_TOKENS.free;
}
