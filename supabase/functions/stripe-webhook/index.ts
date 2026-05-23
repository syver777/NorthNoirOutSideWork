import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@16.8.0?target=deno&no-check";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { v4 as uuidv4 } from "https://esm.sh/uuid@10.0.0";
import { getCorsHeaders } from '../_shared/cors.ts';
import {
  LEGACY_PRICE_TO_PLAN_USD,
  LEGACY_PRICE_TO_PLAN_EUR,
  NEW_PRICE_TO_PLAN_USD,
  NEW_PRICE_TO_PLAN_EUR,
  resolvePrice,
  tokensForPlan,
} from '../_shared/planMaps.ts';

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
  apiVersion: "2025-03-31.basil",
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SECRET_KEY") || ""
);

// Combined price→plan lookups (LEGACY + NEW). Used only for plan-name resolution;
// the legacy/new flag is always derived via `resolvePrice` so it stays in lockstep
// with whichever map the priceId actually came from.
const priceToPlanMap: Record<string, string> = {
  ...LEGACY_PRICE_TO_PLAN_USD,
  ...NEW_PRICE_TO_PLAN_USD,
};
const priceToPlanMapEUR: Record<string, string> = {
  ...LEGACY_PRICE_TO_PLAN_EUR,
  ...NEW_PRICE_TO_PLAN_EUR,
};


// Helper function to convert Unix timestamp to ISO string safely
const toSafeISOString = (unixSeconds: number): string => {
  console.log(`Converting timestamp: ${unixSeconds}`);
  if (!Number.isInteger(unixSeconds) || unixSeconds <= 0) {
    console.warn(`Invalid Unix timestamp: ${unixSeconds}, falling back to current time`);
    return new Date().toISOString();
  }
  const date = new Date(unixSeconds * 1000);
  if (isNaN(date.getTime())) {
    console.warn(`Invalid date from timestamp: ${unixSeconds}, falling back to current time`);
    return new Date().toISOString();
  }
  return date.toISOString();
};

// Helper function to retry Stripe API calls
const retryStripeCall = async <T>(fn: () => Promise<T>, retries: number = 3, delay: number = 1000): Promise<T> => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      console.error(`Attempt ${i + 1} failed: ${error.message}`);
      if (i < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error("Retry limit reached");
};

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

  const body = await req.text();
  const sig = req.headers.get("stripe-signature");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  try {
    console.log("Received webhook with signature:", sig);
    if (!webhookSecret || !Deno.env.get("STRIPE_SECRET_KEY") || !Deno.env.get("SUPABASE_URL") || !(Deno.env.get('SECRET_KEY'))) {
      throw new Error("Missing environment variables");
    }

    const event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
    console.log("Webhook event type:", event.type);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.client_reference_id;
      const subscriptionId = session.subscription;

      console.log("Session data:", {
        id: session.id,
        client_reference_id: userId,
        subscription: subscriptionId,
        metadata: session.metadata,
        created: session.created,
      });

      // Check if this is a token purchase (not a subscription)
      if (session.metadata?.purchase_type === 'token_reset') {
        const tokenAmount = parseInt(session.metadata.token_amount);
        
        console.log("Processing token reset:", { userId, tokenAmount });

        if (!userId || !tokenAmount) {
          throw new Error(`Missing userId or tokenAmount in token reset session ${session.id}`);
        }

        // First get current tokens_used, then calculate new value
        const { data: currentPlan } = await supabase
          .from("user_plans")
          .select("tokens_used")
          .eq("user_id", userId)
          .eq("is_active", true)
          .single();

        const newTokensUsed = Math.max((currentPlan?.tokens_used || 0) - tokenAmount, 0);

        // Subtract purchased tokens from tokens_used (reset effect)
        const { error: resetError } = await supabase
          .from("user_plans")
          .update({
            tokens_used: newTokensUsed,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId)
          .eq("is_active", true);

        if (resetError) {
          console.error("Error resetting tokens:", resetError);
          throw new Error(`Failed to reset tokens: ${resetError.message}`);
        }

        console.log(`Reset ${tokenAmount} tokens for user ${userId}`);
        
        return new Response(JSON.stringify({ message: "Token reset processed" }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (!userId) {
        throw new Error(`Missing userId in session ${session.id}`);
      }

      let planName = session.metadata?.plan_name;
      let currency = session.metadata?.currency || 'USD';
      // Track the priceId so we can resolve LEGACY vs NEW for the is_legacy_plan flag.
      let resolvedPriceId: string | null = null;
      console.log("Initial plan_name:", planName, "currency:", currency);

      if (!planName) {
        console.log("Plan name not found in metadata, fetching line_items");
        const sessionWithLineItems = await stripe.checkout.sessions.retrieve(
          session.id,
          { expand: ["line_items"] }
        );
        const priceId = sessionWithLineItems.line_items?.data[0]?.price?.id;
        console.log("Price ID from line_items:", priceId);
        resolvedPriceId = priceId || null;
        planName = priceToPlanMap[priceId] || priceToPlanMapEUR[priceId];

        // Determine currency from price ID if not in metadata
        if (priceToPlanMapEUR[priceId]) {
          currency = 'EUR';
        }

        if (!planName) {
          console.log("Price ID not mapped, querying subscription");
          if (!subscriptionId) {
            throw new Error(`No subscription ID in session ${session.id}`);
          }
          const subscription = await retryStripeCall(() => stripe.subscriptions.retrieve(subscriptionId));
          const subPriceId = subscription.items.data[0]?.price.id;
          console.log("Subscription Price ID:", subPriceId);
          resolvedPriceId = subPriceId || null;
          planName = priceToPlanMap[subPriceId] || priceToPlanMapEUR[subPriceId] || "Standard";
          
          // Determine currency from subscription price ID
          if (priceToPlanMapEUR[subPriceId]) {
            currency = 'EUR';
          }
        }
      } else if (subscriptionId) {
        // plan_name was in metadata; still need the priceId to resolve legacy/new.
        try {
          const subscription = await retryStripeCall(() => stripe.subscriptions.retrieve(subscriptionId));
          resolvedPriceId = subscription.items.data[0]?.price?.id || null;
        } catch (e) {
          console.warn("Failed to retrieve subscription for priceId resolution:", (e as Error).message);
        }
      }

      console.log("Final planName:", planName, "currency:", currency);

      if (!planName) {
        throw new Error(`Unable to determine plan name for session ${session.id}`);
      }

      let currentPeriodStart, currentPeriodEnd;
      if (subscriptionId) {
        try {
          const subscription = await retryStripeCall(() => stripe.subscriptions.retrieve(subscriptionId));
          console.log("Subscription data:", {
            id: subscription.id,
            current_period_start: subscription.current_period_start,
            current_period_end: subscription.current_period_end,
            status: subscription.status,
          });
          currentPeriodStart = toSafeISOString(subscription.current_period_start);
        } catch (error) {
          console.error("Error retrieving subscription after retries:", error.message);
          console.log("Falling back to session.created for timestamps");
          currentPeriodStart = toSafeISOString(session.created);
        }
      } else {
        console.log("No subscription ID, using session.created for timestamps");
        currentPeriodStart = toSafeISOString(session.created);
      }

      const endDate = new Date(new Date(currentPeriodStart).getTime());
      endDate.setMonth(endDate.getMonth() + 1);
      currentPeriodEnd = toSafeISOString(endDate.getTime() / 1000);

      console.log("Timestamps:", { currentPeriodStart, currentPeriodEnd });

      const isLegacyPlan = resolvePrice(resolvedPriceId).isLegacy;
      const planTokens = tokensForPlan(planName, isLegacyPlan);
      console.log("Plan resolution:", { planName, isLegacyPlan, planTokens, resolvedPriceId });

      const { data: existingPlan, error: selectError } = await supabase
        .from("user_plans")
        .select("id, tokens_used, plan_type")
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("updated_at", { ascending: false })
        .limit(1);

      if (selectError) {
        console.error("Error selecting existing plan:", selectError);
        throw new Error(`Failed to select existing plan: ${selectError.message}`);
      }

      console.log("Existing plan:", existingPlan);

      // Determine if upgrading from free plan
      const isUpgradingFromFree = existingPlan && existingPlan[0] && 
        existingPlan[0].plan_type === 'free' && 
        planName.toLowerCase() !== 'free';

      console.log("Is upgrading from free:", isUpgradingFromFree);

      const planPayload = {
        plan_type: planName.toLowerCase(),
        tokens_allocated: planTokens,
        tokens_used: isUpgradingFromFree ? 0 : (existingPlan && existingPlan[0] ? existingPlan[0].tokens_used : 0),
        rollover_tokens: 0,
        updated_at: new Date().toISOString(),
        current_period_start: currentPeriodStart,
        current_period_end: currentPeriodEnd,
        is_active: true,
        stripe_subscription_id: subscriptionId || null,
        stripe_customer_id: session.customer || null,
        subscription_status: "active",
        pending_plan_type: null,
        currency: currency,
        is_legacy_plan: isLegacyPlan,
      };

      console.log("Plan payload:", planPayload);

      if (existingPlan && existingPlan[0]) {
        const { error } = await supabase
          .from("user_plans")
          .update(planPayload)
          .eq("id", existingPlan[0].id)
          .eq("user_id", userId)
          .eq("is_active", true);

        if (error) {
          console.error("Error updating plan:", error);
          throw new Error(`Failed to update plan: ${error.message}`);
        }
      } else {
        const { error } = await supabase.from("user_plans").insert({
          id: uuidv4(),
          user_id: userId,
          created_at: new Date().toISOString(),
          ...planPayload,
        });

        if (error) {
          console.error("Error inserting plan:", error);
          throw new Error(`Failed to insert: ${error.message}`);
        }
      }

      // Call the SQL function to ensure current_period_end is set to current_period_start + 1 month
      const { error: triggerError } = await supabase.rpc("update_period_end", { user_id_param: userId });
      if (triggerError) {
        console.error("Error calling update_period_end function:", triggerError);
        throw new Error(`Failed to update period end: ${triggerError.message}`);
      }

      // Record initial invoice in billing history
      try {
        if (subscriptionId && session.customer) {
          const invoices = await stripe.invoices.list({
            subscription: subscriptionId,
            limit: 1,
            status: 'paid',
          });
          if (invoices.data.length > 0) {
            const inv = invoices.data[0];
            const billingEntry = {
              date: new Date(inv.created * 1000).toISOString(),
              amount: inv.amount_paid,
              currency: inv.currency,
              plan_name: planName.toLowerCase(),
              invoice_pdf: inv.invoice_pdf || null,
              hosted_url: inv.hosted_invoice_url || null,
              period_start: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : currentPeriodStart,
              period_end: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : currentPeriodEnd,
              status: inv.status || 'paid',
            };
            // Append to billing_history JSONB array
            await supabase.rpc('append_billing_history', {
              user_id_param: userId,
              new_entry: billingEntry,
            });
            console.log("Initial billing history entry recorded");
          }
        }
      } catch (billingError) {
        console.error("Error recording initial billing history (non-fatal):", billingError.message);
      }

      console.log("Plan updated/inserted and period end set successfully");

      return new Response(JSON.stringify({ message: "Success" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } else if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object;
      const userId = subscription.metadata?.user_id;
      const subscriptionId = subscription.id;
      const priceId = subscription.items.data[0]?.price.id;
      const cancelAtPeriodEnd = subscription.cancel_at_period_end;
      const pendingUpdate = subscription.pending_update;
      const scheduleId = subscription.schedule;

      console.log("Subscription updated:", { subscriptionId, userId, priceId, cancelAtPeriodEnd, pendingUpdate, scheduleId });
      console.log("Subscription update timestamps:", {
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end,
      });

      if (!userId || !subscriptionId) {
        throw new Error(`Missing userId:${userId} or subscriptionId:${subscriptionId} in subscription ${subscriptionId}`);
      }

      let planName = priceToPlanMap[priceId] || priceToPlanMapEUR[priceId];
      let pendingPlanName = null;
      let currency = subscription.metadata?.currency || 'USD';

      // Determine currency from price ID if not in metadata
      if (priceToPlanMapEUR[priceId]) {
        currency = 'EUR';
      }

      // Check pending_update first
      if (pendingUpdate?.subscription_items?.[0]?.price?.id) {
        const pendingPriceId = pendingUpdate.subscription_items[0].price.id;
        pendingPlanName = priceToPlanMap[pendingPriceId] || priceToPlanMapEUR[pendingPriceId];
      }
      // If no pending_update, check subscription schedule
      else if (scheduleId) {
        try {
          const schedule = await retryStripeCall(() => stripe.subscriptionSchedules.retrieve(scheduleId));
          const nextPhase = schedule.phases.find(
            (phase) => phase.start_date > Math.floor(Date.now() / 1000)
          );
          if (nextPhase?.items?.[0]?.price) {
            const nextPriceId = nextPhase.items[0].price;
            pendingPlanName = priceToPlanMap[nextPriceId] || priceToPlanMapEUR[nextPriceId];
          }
        } catch (error) {
          console.warn(`Failed to retrieve subscription schedule ${scheduleId}: ${error.message}`);
        }
      }

      if (!planName) {
        throw new Error(`Invalid price ID: ${priceId}`);
      }

      // Resolve LEGACY vs NEW from the active priceId. A subscription that
      // moves from a legacy price to a new price flips this row to
      // is_legacy_plan = FALSE, which makes every billing surface (edge
      // functions + frontend estimators) switch to the NEW token map.
      const isLegacyPlan = resolvePrice(priceId).isLegacy;
      const planTokens = tokensForPlan(planName, isLegacyPlan);
      console.log("Plan resolution (sub.updated):", { planName, isLegacyPlan, planTokens, priceId });

      const { data: existingPlan, error: selectError } = await supabase
        .from("user_plans")
        .select("id, tokens_used")
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("updated_at", { ascending: false })
        .limit(1);

      if (selectError) {
        console.error("Error selecting existing plan:", selectError);
        throw new Error(`Failed to select existing plan: ${selectError.message}`);
      }

      const planPayload = {
        plan_type: planName.toLowerCase(),
        tokens_allocated: planTokens,
        tokens_used: existingPlan && existingPlan[0] ? existingPlan[0].tokens_used : 0,
        updated_at: new Date().toISOString(),
        is_active: true,
        stripe_subscription_id: subscriptionId,
        stripe_customer_id: subscription.customer || null,
        subscription_status: (cancelAtPeriodEnd || pendingPlanName) ? "last_month" : "active",
        pending_plan_type: pendingPlanName ? pendingPlanName.toLowerCase() : cancelAtPeriodEnd ? "free" : null,
        currency: currency,
        is_legacy_plan: isLegacyPlan,
      };

      console.log("Plan payload:", planPayload);

      if (existingPlan && existingPlan[0]) {
        const { error } = await supabase
          .from("user_plans")
          .update(planPayload)
          .eq("id", existingPlan[0].id)
          .eq("user_id", userId)
          .eq("is_active", true);

        if (error) {
          console.error("Error updating plan:", error);
          throw new Error(`Failed to update plan: ${error.message}`);
        }
      } else {
        const { error } = await supabase.from("user_plans").insert({
          id: uuidv4(),
          user_id: userId,
          created_at: new Date().toISOString(),
          ...planPayload,
          current_period_start: toSafeISOString(subscription.current_period_start),
          current_period_end: toSafeISOString(subscription.current_period_end),
        });

        if (error) {
          console.error("Error inserting plan:", error);
          throw new Error(`Failed to insert: ${error.message}`);
        }
      }

      console.log("Plan updated successfully");

      return new Response(JSON.stringify({ message: "Success" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } else if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const userId = subscription.metadata?.user_id;
      const subscriptionId = subscription.id;

      console.log("Subscription deleted:", { subscriptionId, userId });

      if (!userId || !subscriptionId) {
        throw new Error(`Missing userId or subscriptionId in subscription ${subscriptionId}`);
      }

      const { data: existingPlan, error: selectError } = await supabase
        .from("user_plans")
        .select("id, tokens_used, pending_plan_type, is_legacy_plan")
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("updated_at", { ascending: false })
        .limit(1);

      if (selectError) {
        console.error("Error selecting user plan:", selectError);
        throw new Error(`Failed to select user plan: ${selectError.message}`);
      }

      if (!existingPlan || !existingPlan[0]) {
        console.warn(`No active plan found for user ${userId}, creating new Free plan`);
        const { error } = await supabase.from("user_plans").insert({
          id: uuidv4(),
          user_id: userId,
          created_at: new Date().toISOString(),
          plan_type: "free",
          tokens_allocated: tokensForPlan("Free", false),
          tokens_used: 0,
          rollover_tokens: 0,
          updated_at: new Date().toISOString(),
          current_period_start: new Date().toISOString(),
          current_period_end: new Date(new Date().setMonth(new Date().getMonth() + 1)).toISOString(),
          is_active: true,
          stripe_subscription_id: null,
          subscription_status: "active",
          pending_plan_type: null,
          currency: 'USD',
          is_legacy_plan: false,
        });

        if (error) {
          console.error("Error inserting free plan:", error);
          throw new Error(`Failed to insert free plan: ${error.message}`);
        }

        console.log("Free plan inserted successfully");
        return new Response(JSON.stringify({ message: "Success" }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const pendingPlanName = existingPlan[0].pending_plan_type || "free";
      const pendingPlanCanonical = pendingPlanName.charAt(0).toUpperCase() + pendingPlanName.slice(1);
      // After cancellation we no longer have a Stripe priceId to consult;
      // honor the existing row's legacy flag so a legacy user who cancels
      // and reverts to Free isn't silently flipped to a NEW-plan token map.
      const existingLegacyFlag = (existingPlan[0] as { is_legacy_plan?: boolean }).is_legacy_plan === true;
      const isLegacyAfterCancel = pendingPlanName.toLowerCase() === 'free' ? false : existingLegacyFlag;
      const planTokens = tokensForPlan(pendingPlanCanonical, isLegacyAfterCancel);

      const { error } = await supabase
        .from("user_plans")
        .update({
          plan_type: pendingPlanName.toLowerCase(),
          tokens_allocated: planTokens,
          tokens_used: existingPlan[0].tokens_used,
          rollover_tokens: 0,
          updated_at: new Date().toISOString(),
          current_period_start: new Date().toISOString(),
          current_period_end: new Date(new Date().setMonth(new Date().getMonth() + 1)).toISOString(),
          is_active: true,
          stripe_subscription_id: null,
          subscription_status: "active",
          pending_plan_type: null,
          currency: 'USD',
          is_legacy_plan: isLegacyAfterCancel,
        })
        .eq("id", existingPlan[0].id)
        .eq("user_id", userId)
        .eq("is_active", true);

      if (error) {
        console.error("Error updating plan to pending type:", error);
        throw new Error(`Failed to update plan: ${error.message}`);
      }

      console.log("Plan updated to pending type successfully");

      return new Response(JSON.stringify({ message: "Success" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } else if (event.type === "invoice.paid") {
      // Monthly subscription renewal — perform rollover reset
      const invoice = event.data.object;
      const subscriptionId = invoice.subscription;

      // Skip the very first invoice (subscription creation is handled by checkout.session.completed)
      if (invoice.billing_reason === "subscription_create") {
        console.log("Skipping invoice.paid for initial subscription creation");
        return new Response(JSON.stringify({ message: "Skipped initial invoice" }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      console.log("Invoice paid (renewal):", { subscriptionId, billing_reason: invoice.billing_reason });

      if (!subscriptionId) {
        console.log("No subscription ID on invoice, skipping rollover");
        return new Response(JSON.stringify({ message: "No subscription" }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Find user by stripe_subscription_id
      const { data: userPlan, error: planError } = await supabase
        .from("user_plans")
        .select("id, user_id, tokens_allocated, tokens_used, plan_type")
        .eq("stripe_subscription_id", subscriptionId)
        .eq("is_active", true)
        .single();

      if (planError || !userPlan) {
        console.error("Error finding user plan for subscription:", subscriptionId, planError);
        return new Response(JSON.stringify({ message: "User plan not found" }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Call the rollover reset function
      const { error: rolloverError } = await supabase.rpc("reset_tokens_with_rollover", {
        user_id_param: userPlan.user_id,
      });

      if (rolloverError) {
        console.error("Error performing rollover reset:", rolloverError);
        throw new Error(`Failed to perform rollover reset: ${rolloverError.message}`);
      }

      // Update period dates from Stripe subscription
      try {
        const subscription = await retryStripeCall(() => stripe.subscriptions.retrieve(subscriptionId));
        const { error: periodError } = await supabase
          .from("user_plans")
          .update({
            current_period_start: toSafeISOString(subscription.current_period_start),
            current_period_end: toSafeISOString(subscription.current_period_end),
          })
          .eq("id", userPlan.id);

        if (periodError) {
          console.error("Error updating period dates:", periodError);
        }
      } catch (error) {
        console.error("Error retrieving subscription for period update:", error.message);
      }

      // Record renewal invoice in billing history
      try {
        const billingEntry = {
          date: new Date(invoice.created * 1000).toISOString(),
          amount: invoice.amount_paid,
          currency: invoice.currency,
          plan_name: userPlan.plan_type,
          invoice_pdf: invoice.invoice_pdf || null,
          hosted_url: invoice.hosted_invoice_url || null,
          period_start: invoice.period_start ? new Date(invoice.period_start * 1000).toISOString() : null,
          period_end: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
          status: invoice.status || 'paid',
        };
        await supabase.rpc('append_billing_history', {
          user_id_param: userPlan.user_id,
          new_entry: billingEntry,
        });
        console.log("Billing history entry recorded for renewal");
      } catch (billingError) {
        console.error("Error recording billing history (non-fatal):", billingError.message);
      }

      const rolloverAmount = Math.max(userPlan.tokens_allocated - userPlan.tokens_used, 0);
      console.log(`Rollover reset complete for user ${userPlan.user_id}: rollover=${rolloverAmount}, tokens_used reset to 0`);

      return new Response(JSON.stringify({ message: "Rollover reset complete" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    console.log("Event not handled:", event.type);
    return new Response(JSON.stringify({ message: "Event not handled" }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error) {
    console.error("Webhook error:", error.message);
    return new Response(JSON.stringify({ error: `Webhook Error: ${error.message}` }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});



