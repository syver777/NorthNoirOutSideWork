import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import Stripe from 'https://esm.sh/stripe@16.8.0?target=deno&no-check';

import { getCorsHeaders } from '../_shared/cors.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SECRET_KEY') || ''
);

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2025-03-31.basil',
});

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    // Verify JWT authentication
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!token) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization header' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }    // authToken resolved above (Bearer or apikey)
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authUser) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Use authenticated user's ID — ignore any user_id from request body
    const user_id = authUser.id;

    // Fetch user plan to get stripe_subscription_id
    const { data: plan, error: planError } = await supabase
      .from('user_plans')
      .select('stripe_subscription_id, plan_type')
      .eq('user_id', user_id)
      .single();

    if (planError || !plan) {
      return new Response(
        JSON.stringify({ error: 'User plan not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // If user has a paid plan and a Stripe subscription, cancel it
    if (plan.stripe_subscription_id) {
      try {
        await stripe.subscriptions.cancel(plan.stripe_subscription_id);
        // Update user_plans to set stripe_subscription_id to null
        const { error: updateError } = await supabase
          .from('user_plans')
          .update({ stripe_subscription_id: null })
          .eq('user_id', user_id);
        if (updateError) {
          console.error('Error updating user plan:', updateError);
          return new Response(
            JSON.stringify({ error: 'Failed to update user plan' }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
      } catch (stripeError: any) {
        console.error('Stripe error:', {
          message: stripeError.message,
          type: stripeError.type,
          code: stripeError.code,
          status: stripeError.statusCode,
        });
        return new Response(
          JSON.stringify({ error: `Failed to cancel Stripe subscription: ${stripeError.message || 'Unknown error'}` }),
          { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
    }

    // Delete user from user_plans table
    const { error: planDeleteError } = await supabase
      .from('user_plans')
      .delete()
      .eq('user_id', user_id);

    if (planDeleteError) {
      console.error('User plan deletion error:', planDeleteError);
      return new Response(
        JSON.stringify({ error: 'Failed to delete user plan' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Delete user from auth.users
    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(user_id);

    if (authDeleteError) {
      console.error('Auth deletion error:', authDeleteError);
      return new Response(
        JSON.stringify({ error: 'Failed to delete user' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    return new Response(
      JSON.stringify({ message: 'Account deleted successfully' }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  } catch (err) {
    console.error('Unexpected error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
});
