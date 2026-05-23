// Shared Stripe price ↔ plan-name maps and per-plan token allocations.
// Used by stripe-webhook and manage-legacy-subscription so they agree on
// which prices are LEGACY (grandfathered) vs NEW (post-cutover).
//
// Adding a price ID here is the SINGLE source of truth. The webhook
// derives `is_legacy_plan` from which map a priceId belongs to.

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY price IDs (the original 7 paid tiers, archived in Stripe at cutover).
// ─────────────────────────────────────────────────────────────────────────────
export const LEGACY_PRICE_TO_PLAN_USD: Record<string, string> = {
  price_1RYoM9LnHJrgLLrv4TX17pkL: 'Standard',
  price_1RYoTfLnHJrgLLrvIS0Ynj2n: 'Plus',
  price_1RdznuLnHJrgLLrvkvBLxA5Q: 'Premium',
  price_1Rt7nvLnHJrgLLrvzP0ew3a6: 'Pro',
  price_1Rt7q6LnHJrgLLrvYmsKDsLB: 'Elite',
  price_1Rt7qrLnHJrgLLrvMyE2xBDi: 'Ultimate',
  price_1S3zjRLnHJrgLLrvPNeQIR6X: 'Enterprise',
};

export const LEGACY_PRICE_TO_PLAN_EUR: Record<string, string> = {
  price_1SiZc6LnHJrgLLrvlvSiUd4h: 'Standard',
  price_1SiZcrLnHJrgLLrvB5dDl8md: 'Plus',
  price_1SiZdeLnHJrgLLrv3icJFhwx: 'Premium',
  price_1SiZeCLnHJrgLLrvwNPa2tqj: 'Pro',
  price_1SiZfPLnHJrgLLrv39uXPBkS: 'Elite',
  price_1SiZg0LnHJrgLLrvCPpXJH2c: 'Ultimate',
  price_1SiZgiLnHJrgLLrv7P151tDK: 'Enterprise',
};

// ─────────────────────────────────────────────────────────────────────────────
// NEW price IDs (six post-cutover tiers — no Plus tier).
// ─────────────────────────────────────────────────────────────────────────────
export const NEW_PRICE_TO_PLAN_USD: Record<string, string> = {
  price_1TU3PULnHJrgLLrvFlTqlcuq: 'Standard',
  price_1TU3RfLnHJrgLLrvGms7O3gD: 'Premium',
  price_1TU3WoLnHJrgLLrvP6u7uTUc: 'Pro',
  price_1TU3YBLnHJrgLLrvGhNLAbFY: 'Elite',
  price_1TU3ZdLnHJrgLLrvYpHM9KrS: 'Ultimate',
  price_1TU3bULnHJrgLLrvCG1y0U0s: 'Enterprise',
};

export const NEW_PRICE_TO_PLAN_EUR: Record<string, string> = {
  price_1TU3QCLnHJrgLLrv6bs1OB0Q: 'Standard',
  price_1TU3SOLnHJrgLLrv98kERiht: 'Premium',
  price_1TU3XMLnHJrgLLrv9vTMnFsT: 'Pro',
  price_1TU3YgLnHJrgLLrvmYwFBPA9: 'Elite',
  price_1TU3aKLnHJrgLLrvugPxQ5on: 'Ultimate',
  price_1TU3bxLnHJrgLLrvjzxOCigA: 'Enterprise',
};

// Convenience sets.
export const LEGACY_PRICE_IDS: Set<string> = new Set([
  ...Object.keys(LEGACY_PRICE_TO_PLAN_USD),
  ...Object.keys(LEGACY_PRICE_TO_PLAN_EUR),
]);

export const NEW_PRICE_IDS: Set<string> = new Set([
  ...Object.keys(NEW_PRICE_TO_PLAN_USD),
  ...Object.keys(NEW_PRICE_TO_PLAN_EUR),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Token allocations per plan, by tier.
// LEGACY values match the original launch; NEW values come from
// `new plans.txt` (calibrated for ≥40% margin at $2/M).
// ─────────────────────────────────────────────────────────────────────────────
export const LEGACY_PLAN_TOKENS: Record<string, number> = {
  Free: 400_000,
  Standard: 4_000_000,
  Plus: 6_000_000,
  Premium: 10_000_000,
  Pro: 25_000_000,
  Elite: 50_000_000,
  Ultimate: 75_000_000,
  Enterprise: 250_000_000,
};

export const NEW_PLAN_TOKENS: Record<string, number> = {
  Free: 400_000,
  Standard: 9_000_000,
  Premium: 18_500_000,
  Pro: 38_500_000,
  Elite: 78_500_000,
  Ultimate: 198_000_000,
  Enterprise: 498_000_000,
};

// Resolve {planName, isLegacy, currency} for any priceId.
export function resolvePrice(priceId: string | null | undefined): {
  planName: string | null;
  isLegacy: boolean;
  currency: 'USD' | 'EUR';
} {
  if (!priceId) return { planName: null, isLegacy: false, currency: 'USD' };
  if (LEGACY_PRICE_TO_PLAN_USD[priceId]) {
    return { planName: LEGACY_PRICE_TO_PLAN_USD[priceId], isLegacy: true, currency: 'USD' };
  }
  if (LEGACY_PRICE_TO_PLAN_EUR[priceId]) {
    return { planName: LEGACY_PRICE_TO_PLAN_EUR[priceId], isLegacy: true, currency: 'EUR' };
  }
  if (NEW_PRICE_TO_PLAN_USD[priceId]) {
    return { planName: NEW_PRICE_TO_PLAN_USD[priceId], isLegacy: false, currency: 'USD' };
  }
  if (NEW_PRICE_TO_PLAN_EUR[priceId]) {
    return { planName: NEW_PRICE_TO_PLAN_EUR[priceId], isLegacy: false, currency: 'EUR' };
  }
  return { planName: null, isLegacy: false, currency: 'USD' };
}

// Look up token allocation from a (planName, isLegacy) pair.
export function tokensForPlan(planName: string, isLegacy: boolean): number {
  const map = isLegacy ? LEGACY_PLAN_TOKENS : NEW_PLAN_TOKENS;
  // Plus only exists in legacy — fall back to legacy table if needed so a
  // mis-tagged Plus price can never crash the webhook.
  return map[planName] ?? LEGACY_PLAN_TOKENS[planName] ?? LEGACY_PLAN_TOKENS.Free;
}

// `user_plans.plan_type` is stored lowercase ('standard', 'premium', …) while
// LEGACY_PLAN_TOKENS / NEW_PLAN_TOKENS are keyed Title-Case ('Standard', …).
// This helper bridges the two so balance checks honour the user's
// `is_legacy_plan` flag instead of always reading the legacy map.
export function planMaxTokensForUser(
  planTypeLower: string | null | undefined,
  isLegacy: boolean,
): number {
  const lower = (planTypeLower ?? 'free').toLowerCase();
  const titled = lower.charAt(0).toUpperCase() + lower.slice(1);
  return tokensForPlan(titled, isLegacy);
}
