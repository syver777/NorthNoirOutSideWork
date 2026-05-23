import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@16.8.0?target=deno&no-check";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { getCorsHeaders } from '../_shared/cors.ts';
import { verifyAuth } from '../_shared/utils.ts';

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
  apiVersion: "2025-03-31.basil",
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SECRET_KEY") || ""
);

const planConfig = {
  Free: { tokens: 400000 },
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

  const auth = await verifyAuth(req);
  if (!auth || !auth.isServiceRole) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    // Fetch all active user plans with a Stripe subscription
    const { data: userPlans, error: fetchError } = await supabase
      .from("user_plans")
      .select("id, user_id, stripe_subscription_id, tokens_used")
      .eq("is_active", true)
      .not("stripe_subscription_id", "is", null);

    if (fetchError) {
      console.error("Error fetching user plans:", fetchError);
      throw new Error(`Failed to fetch user plans: ${fetchError.message}`);
    }

    if (!userPlans || userPlans.length === 0) {
      console.log("No active subscriptions found.");
      return new Response(JSON.stringify({ message: "No subscriptions to check" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    for (const plan of userPlans) {
      const subscriptionId = plan.stripe_subscription_id;
      try {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        console.log(`Subscription ${subscriptionId} status: ${subscription.status}`);

        if (subscription.status === "past_due") {
          console.log(`Processing past_due subscription ${subscriptionId} for user ${plan.user_id}`);
          
          // Cancel the subscription in Stripe
          try {
            await stripe.subscriptions.cancel(subscriptionId);
            console.log(`Successfully canceled subscription ${subscriptionId} in Stripe`);
          } catch (cancelError) {
            console.error(`Error canceling subscription ${subscriptionId} in Stripe:`, cancelError.message);
            // Continue with downgrade even if Stripe cancellation fails
          }

          // Downgrade to free, similar to deletion handling
          const planData = planConfig.Free;
          const updatePayload = {
            plan_type: "free",
            tokens_allocated: planData.tokens,
            tokens_used: plan.tokens_used, // Preserve tokens_used
            updated_at: new Date().toISOString(),
            current_period_start: new Date().toISOString(),
            current_period_end: new Date(new Date().setMonth(new Date().getMonth() + 1)).toISOString(),
            is_active: true,
            stripe_subscription_id: null,
            subscription_status: "active",
            pending_plan_type: null,
          };

          console.log(`Downgrading user ${plan.user_id} to free. Payload:`, updatePayload);

          const { error: updateError } = await supabase
            .from("user_plans")
            .update(updatePayload)
            .eq("id", plan.id)
            .eq("user_id", plan.user_id)
            .eq("is_active", true);

          if (updateError) {
            console.error(`Error updating plan for user ${plan.user_id}:`, updateError);
            // Continue to next, don't throw to avoid stopping the loop
          } else {
            console.log(`Successfully downgraded user ${plan.user_id} to free.`);
            
            // Send payment failure email
            try {
              console.log(`Sending payment failure email to user ${plan.user_id}`);
              
              const emailResponse = await fetch(
                `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-payment-failure-email`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    apikey: (Deno.env.get('SECRET_KEY')) ?? "",
                  },
                  body: JSON.stringify({
                    userId: plan.user_id,
                  }),
                }
              );

              if (!emailResponse.ok) {
                const errorText = await emailResponse.text();
                console.error(`Failed to send payment failure email to user ${plan.user_id}:`, errorText);
              } else {
                console.log(`Payment failure email sent successfully to user ${plan.user_id}`);
              }
            } catch (emailError) {
              console.error(`Error sending payment failure email to user ${plan.user_id}:`, emailError.message);
              // Don't throw - we still want to continue processing other users
            }
          }
        }
      } catch (subError) {
        console.error(`Error retrieving subscription ${subscriptionId} for user ${plan.user_id}:`, subError.message);
        // Continue to next
      }
    }

    return new Response(JSON.stringify({ message: "Downgrade check completed" }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error) {
    console.error("Error in downgrade-subscription:", error.message);
    return new Response(JSON.stringify({ error: `Internal Server Error: ${error.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});



