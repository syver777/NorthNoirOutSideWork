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

    const { returnUrl } = await req.json();
    const userId = authUser.id;

    // Validate returnUrl against allowed domains
    const allowedReturnDomains = ['https://storyscriptai.com', 'https://www.storyscriptai.com', 'https://northnoir.com', 'https://www.northnoir.com'];
    const returnUrlParsed = new URL(returnUrl);
    if (!allowedReturnDomains.some(d => returnUrlParsed.origin === d)) {
      return new Response(JSON.stringify({ error: 'Invalid return URL' }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Fetch the user's Stripe customer ID from the user_plans table
    const { data, error } = await supabase
      .from("user_plans")
      .select("stripe_customer_id, currency, is_legacy_plan")
      .eq("user_id", userId)
      .eq("is_active", true)
      .single();

    if (error || !data?.stripe_customer_id) {
      return new Response(JSON.stringify({ error: "No active subscription found" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Legacy users cannot use the Stripe Customer Portal: their archived
    // legacy prices are not exposed there post-cutover. Force them through
    // the in-app /pricing flow which calls manage-legacy-subscription.
    if ((data as { is_legacy_plan?: boolean }).is_legacy_plan === true) {
      return new Response(JSON.stringify({
        error: "Legacy subscriptions must be managed in-app",
        code: "LEGACY_PORTAL_BLOCKED",
      }), {
        status: 403,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const customerId = data.stripe_customer_id;

    if (!customerId) {
      return new Response(JSON.stringify({ error: "No customer ID found for subscription" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Create a Customer Portal session
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    return new Response(JSON.stringify({ url: portalSession.url }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error) {
    console.error("Error creating portal session:", error.message);
    return new Response(JSON.stringify({ error: `Internal Server Error: ${error.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});


