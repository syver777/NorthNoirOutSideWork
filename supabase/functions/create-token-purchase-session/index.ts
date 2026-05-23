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

const TOKEN_PRICE_ID_USD = "price_1SlGvCLnHJrgLLrvEMwOr3kK";
const TOKEN_PRICE_ID_EUR = "price_1Sl75uLnHJrgLLrvQujxMRX5";
const TOKENS_PER_GROUP = 200000; // 200k tokens per group
const MIN_TOKEN_PURCHASE = TOKENS_PER_GROUP; // Minimum 1 group (200k tokens)


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

    const { tokenGroups, successUrl, cancelUrl, currency = "USD" } = await req.json();
    const userId = authUser.id;
    
    if (!userId || !tokenGroups || !successUrl || !cancelUrl) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Validate minimum token group purchase
    if (tokenGroups < 1) {
      return new Response(JSON.stringify({ error: "Minimum purchase is 1 group (200,000 tokens)" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Calculate total tokens from groups
    const totalTokens = tokenGroups * TOKENS_PER_GROUP;

    // Get user's current token usage
    const { data: userPlan, error: planError } = await supabase
      .from("user_plans")
      .select("tokens_used")
      .eq("user_id", userId)
      .eq("is_active", true)
      .single();

    if (planError || !userPlan) {
      return new Response(JSON.stringify({ error: "User plan not found" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Validate user has used enough tokens (at least 200k)
    if (userPlan.tokens_used < MIN_TOKEN_PURCHASE) {
      return new Response(JSON.stringify({ error: "You must have used at least 200,000 tokens to purchase token resets" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Calculate maximum groups user can purchase (round down)
    const maxGroups = Math.floor(userPlan.tokens_used / TOKENS_PER_GROUP);

    // Validate user doesn't exceed their maximum groups
    if (tokenGroups > maxGroups) {
      return new Response(JSON.stringify({ error: `Cannot purchase more than ${maxGroups} groups (${maxGroups * TOKENS_PER_GROUP} tokens)` }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const priceId = currency === "EUR" ? TOKEN_PRICE_ID_EUR : TOKEN_PRICE_ID_USD;
    const paymentMethods = currency === "EUR" 
      ? ["card", "ideal", "klarna"]
      : ["card", "us_bank_account"];

    // Use the pre-created price with token groups as quantity
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: paymentMethods,
      line_items: [{
        price: priceId,
        quantity: tokenGroups, // Number of 200k token groups
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: userId,
      metadata: {
        user_id: userId,
        token_groups: tokenGroups.toString(),
        token_amount: totalTokens.toString(), // For webhook processing
        purchase_type: 'token_reset',
        currency: currency,
      },
    });

    console.log("Token purchase session created:", {
      sessionId: session.id,
      userId,
      tokenGroups,
      totalTokens,
      currency,
      priceId,
    });

    return new Response(JSON.stringify({ sessionId: session.id }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error) {
    console.error("Error creating token purchase session:", error);
    return new Response(JSON.stringify({ error: `Internal Server Error: ${error.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});




