// src/hooks/useIsLegacyPlan.ts
// ─────────────────────────────────────────────────────────────────────────────
// Resolves the active user's `user_plans.is_legacy_plan` flag once per session
// and caches the result in sessionStorage. Defaults to TRUE on any failure
// (we'd rather under-charge a new user than over-charge a grandfathered one).
//
// Use alongside helpers from src/data/tokenCosts.ts to keep frontend
// estimators / display labels in lockstep with backend billing.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useAuth } from '../contexts/AuthContext';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY,
);

const CACHE_KEY = 'nn_is_legacy_plan_v1';
let inFlight: Promise<boolean> | null = null;

function readCache(userId: string): boolean | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { userId: string; isLegacy: boolean };
    if (parsed.userId !== userId) return null;
    return parsed.isLegacy === true;
  } catch {
    return null;
  }
}

function writeCache(userId: string, isLegacy: boolean) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ userId, isLegacy }));
  } catch {
    /* ignore quota errors */
  }
}

async function fetchIsLegacyPlan(userId: string): Promise<boolean> {
  if (!userId) return true;
  try {
    const { data, error } = await supabase
      .from('user_plans')
      .select('is_legacy_plan')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    if (error || !data) return true;
    return (data as { is_legacy_plan?: boolean }).is_legacy_plan === true;
  } catch {
    return true;
  }
}

/**
 * Returns the cached legacy-plan flag plus a `loading` indicator.
 * Defaults to TRUE while loading and on any lookup failure.
 */
export function useIsLegacyPlan(): { isLegacy: boolean; loading: boolean } {
  const { user } = useAuth();
  const cached = user ? readCache(user.id) : null;
  const [isLegacy, setIsLegacy] = useState<boolean>(cached ?? true);
  const [loading, setLoading] = useState<boolean>(cached === null);

  useEffect(() => {
    if (!user) {
      setIsLegacy(true);
      setLoading(false);
      return;
    }
    const c = readCache(user.id);
    if (c !== null) {
      setIsLegacy(c);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    if (!inFlight) inFlight = fetchIsLegacyPlan(user.id).finally(() => { inFlight = null; });
    inFlight.then((flag) => {
      if (cancelled) return;
      writeCache(user.id, flag);
      setIsLegacy(flag);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [user]);

  return { isLegacy, loading };
}

/** Imperative variant for non-React code paths (utils, async handlers). */
export async function getIsLegacyPlanForUser(userId: string): Promise<boolean> {
  if (!userId) return true;
  const cached = readCache(userId);
  if (cached !== null) return cached;
  const flag = await fetchIsLegacyPlan(userId);
  writeCache(userId, flag);
  return flag;
}
