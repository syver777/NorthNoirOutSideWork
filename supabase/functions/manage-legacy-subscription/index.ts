// supabase/functions/manage-legacy-subscription/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// In-app subscription manager for users on grandfathered "legacy" plans.
// They cannot use the Stripe Customer Portal because the legacy prices are
// archived post-cutover, so all switch / cancel / uncancel flows happen here.
//
// POST { action: 'switch',    newPriceId: string }  → instant migration to a NEW plan
// POST { action: 'cancel'  }                        → cancel at period end
// POST { action: 'uncancel'}                        → undo a pending cancel
//
// All actions verify the calling user actually owns an active legacy
// subscription. The DB is updated downstream by stripe-webhook
// (customer.subscription.updated), so this function only talks to Stripe and
// trusts the webhook to flip is_legacy_plan / tokens_allocated / etc.
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@16.8.0?target=deno&no-check";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { getCorsHeaders } from '../_shared/cors.ts';
import { NEW_PRICE_IDS, resolvePrice } from '../_shared/planMaps.ts';

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
  apiVersion: "2025-03-31.basil",
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SECRET_KEY") || ""
);

type Action = 'switch' | 'cancel' | 'uncancel';

interface RequestBody {
  action: Action;
  newPriceId?: string;
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  try {
    // Auth -----------------------------------------------------------------
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }    // authToken resolved above (Bearer or apikey)
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authUser) {
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    const userId = authUser.id;

    const body = (await req.json()) as RequestBody;
    const action = body.action;
    if (!action || !['switch', 'cancel', 'uncancel'].includes(action)) {
      return new Response(JSON.stringify({ error: 'Invalid action' }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Verify legacy subscription ------------------------------------------
    const { data: planRow, error: planError } = await supabase
      .from('user_plans')
      .select('stripe_subscription_id, is_legacy_plan, plan_type')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    if (planError || !planRow) {
      return new Response(JSON.stringify({ error: 'No active subscription found' }), {
        status: 404, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    if (planRow.is_legacy_plan !== true) {
      return new Response(JSON.stringify({
        error: 'This endpoint is for legacy subscriptions only. Use the Stripe Customer Portal.',
        code: 'NOT_LEGACY',
      }), {
        status: 403, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    const subscriptionId = planRow.stripe_subscription_id;
    if (!subscriptionId) {
      return new Response(JSON.stringify({ error: 'No Stripe subscription on file' }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Action dispatch ------------------------------------------------------
    if (action === 'switch') {
      const newPriceId = body.newPriceId;
      if (!newPriceId || !NEW_PRICE_IDS.has(newPriceId)) {
        return new Response(JSON.stringify({ error: 'newPriceId must be a valid NEW plan price id' }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Look up the current subscription item to swap (Stripe needs the item id).
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const currentItem = subscription.items.data[0];
      if (!currentItem) {
        return new Response(JSON.stringify({ error: 'Subscription has no items' }), {
          status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Idempotency: if already on this price, no-op.
      if (currentItem.price.id === newPriceId) {
        return new Response(JSON.stringify({ ok: true, noop: true }), {
          status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const resolved = resolvePrice(newPriceId);
      // Always charge/credit the difference immediately so the user gets the
      // NEW plan instantly — applies to both upgrades and downgrades per the
      // legacy-migration product spec.
      const updated = await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: currentItem.id, price: newPriceId }],
        proration_behavior: 'always_invoice',
        cancel_at_period_end: false, // also clears any pending cancel
        metadata: {
          ...(subscription.metadata || {}),
          plan_change_source: 'in_app_legacy_migration',
          target_plan: resolved.planName ?? '',
        },
      });

      return new Response(JSON.stringify({
        ok: true,
        action: 'switch',
        subscriptionId: updated.id,
        targetPlan: resolved.planName,
      }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (action === 'cancel') {
      const updated = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
        metadata: {
          plan_change_source: 'in_app_legacy_cancel',
        },
      });
      return new Response(JSON.stringify({
        ok: true,
        action: 'cancel',
        cancelAtPeriodEnd: updated.cancel_at_period_end,
      }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (action === 'uncancel') {
      const updated = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false,
      });
      return new Response(JSON.stringify({
        ok: true,
        action: 'uncancel',
        cancelAtPeriodEnd: updated.cancel_at_period_end,
      }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    return new Response(JSON.stringify({ error: 'Unhandled action' }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error('manage-legacy-subscription error:', (err as Error).message);
    return new Response(JSON.stringify({ error: `Internal Server Error: ${(err as Error).message}` }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
