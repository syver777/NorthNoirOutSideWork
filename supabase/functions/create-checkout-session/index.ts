import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@16.8.0?target=deno&no-check";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { getCorsHeaders } from '../_shared/cors.ts';

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
  apiVersion: "2025-03-31.basil",
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SECRET_KEY") || ""
);


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
    // Verify JWT authentication
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }    // authToken resolved above (Bearer or apikey)
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authUser) {
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const { priceId, planName, successUrl, cancelUrl, couponCode, currency, referral } = await req.json();
    const userId = authUser.id;
    console.log("Creating session with:", { priceId, userId, planName, couponCode, currency, referral });

    if (!priceId || !userId || !planName || !successUrl || !cancelUrl) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Define payment methods based on currency
    const paymentMethods = currency === "EUR" 
      ? ["card", "ideal", "klarna"]
      : ["card", "us_bank_account"];

    const sessionConfig = {
      mode: "subscription",
      payment_method_types: paymentMethods,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: userId,
      metadata: {
        plan_name: planName,
        user_id: userId,
        currency: currency || 'USD',
        ...(referral ? { promotekit_referral: referral } : {}),
      },
      subscription_data: {
        metadata: {
          user_id: userId,
          currency: currency || 'USD',
          ...(referral ? { promotekit_referral: referral } : {}),
        },
      },
    };

    // Add coupon if provided
    if (couponCode) {
      try {
        // First, try to find the promotion code by the code string
        const promotionCodes = await stripe.promotionCodes.list({
          code: couponCode,
          active: true,
          limit: 1,
        });

        if (promotionCodes.data.length > 0) {
          // Use the promotion code ID
          sessionConfig.discounts = [{ promotion_code: promotionCodes.data[0].id }];
          console.log("Applied promotion code:", promotionCodes.data[0].id);
        } else {
          // If not found as promotion code, try as coupon ID directly
          try {
            await stripe.coupons.retrieve(couponCode);
            sessionConfig.discounts = [{ coupon: couponCode }];
            console.log("Applied as coupon:", couponCode);
          } catch (couponError) {
            // Neither promotion code nor coupon found
            return new Response(JSON.stringify({ error: "No such coupon or promotion code found" }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }
        }
      } catch (promoError) {
        console.warn("Error finding promotion code:", promoError.message);
        // Try as coupon fallback
        try {
          await stripe.coupons.retrieve(couponCode);
          sessionConfig.discounts = [{ coupon: couponCode }];
          console.log("Applied as coupon fallback:", couponCode);
        } catch (couponError) {
          return new Response(JSON.stringify({ error: "No such coupon or promotion code found" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
      }
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    console.log("Session created:", session.id);
    console.log("Session metadata:", session.metadata);
    console.log("Payment methods:", paymentMethods);
    return new Response(JSON.stringify({ sessionId: session.id }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error) {
    console.error("Error creating checkout session:", error.message);
    return new Response(JSON.stringify({ error: `Internal Server Error: ${error.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});


