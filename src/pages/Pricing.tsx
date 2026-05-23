import React, { useState, useEffect } from "react";
import { Check, Coins, Calendar, CheckCircle2, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { createClient } from "@supabase/supabase-js";
import { loadStripe } from "@stripe/stripe-js";
import { Helmet } from 'react-helmet-async';
import { trackConversion, CONVERSION_EVENTS } from "../utils/gtagConversions";

// Initialize Supabase client
const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

// Initialize Stripe
const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);

// Helper function to calculate audio hours from tokens
const calculateAudioHours = (tokens: number): string => {
  // Using standard model: 1 token per character
  // 5.5 characters per word, 7500 words per hour
  const hours = tokens / (5.5 * 7500);
  
  if (hours < 1) {
    return `Up to ${Math.ceil(hours * 60)} minutes of audio`;
  } else if (hours < 10) {
    return `Up to ${Math.ceil(hours)} hours of audio`;
  } else {
    return `Up to ${Math.round(hours)} hours of audio`;
  }
};

// Define plan hierarchy (lower index = lower tier)
// LEGACY plans — existing grandfathered tiers (Free + 7 paid). Their Stripe
// prices will be archived post-cutover; the only way to subscribe to one of
// these now is to already be on it.
const legacyPlans = [
  {
    name: "Free",
    priceUSD: "0",
    priceEUR: "0",
    description: "Perfect for trying out North Noir",
    features: [
      "Lifetime allocation of 400,000 tokens",
      calculateAudioHours(400000),
      "Story revision & style testing",
      "Email support",
    ],
    buttonText: "Get Started",
    buttonLink: "/signup",
    popular: false,
    tier: 0,
    priceIdUSD: null,
    priceIdEUR: null,
  },
  {
    name: "Standard",
    priceUSD: "10",
    priceEUR: "9",
    description: "For regular content creators",
    features: [
      "4,000,000 tokens per month",
      calculateAudioHours(4000000),
      "1-month token rollover",
      "Story revision & style testing",
      "Priority email support",
      "Image Generation",
      "Video Generation",
      "Text-to-Speech Generation",
      "All Free features included",
    ],
    buttonText: "Subscribe Now",
    priceIdUSD: "price_1RYoM9LnHJrgLLrv4TX17pkL",
    priceIdEUR: "price_1SiZc6LnHJrgLLrvlvSiUd4h",
    popular: false,
    tier: 1,
  },
  {
    name: "Plus",
    priceUSD: "15",
    priceEUR: "13",
    description: "For frequent content creators",
    features: [
      "6,000,000 tokens per month",
      calculateAudioHours(6000000),
      "1-month token rollover",
      "Story revision & style testing",
      "Priority support",
      "Image Generation",
      "Video Generation",
      "Text-to-Speech Generation",
      "All Standard features included",
    ],
    buttonText: "Subscribe Now",
    priceIdUSD: "price_1RYoTfLnHJrgLLrvIS0Ynj2n",
    priceIdEUR: "price_1SiZcrLnHJrgLLrvB5dDl8md",
    popular: false,
    tier: 2,
  },
  {
    name: "Premium",
    priceUSD: "20",
    priceEUR: "17",
    description: "For professional content creators",
    features: [
      "10,000,000 tokens per month",
      calculateAudioHours(10000000),
      "1-month token rollover",
      "Story revision & style testing",
      "Video Generation",
      "24/7 priority support",
      "Image Generation",
      "Text-to-Speech Generation",
      "All Plus features included",
    ],
    buttonText: "Subscribe Now",
    priceIdUSD: "price_1RdznuLnHJrgLLrvkvBLxA5Q",
    priceIdEUR: "price_1SiZdeLnHJrgLLrv3icJFhwx",
    popular: true,
    tier: 3,
  },
  {
    name: "Pro",
    priceUSD: "50",
    priceEUR: "43",
    description: "For high-volume content creators",
    features: [
      "25,000,000 tokens per month",
      calculateAudioHours(25000000),
      "1-month token rollover",
      "Story revision & style testing",
      "Video Generation",
      "24/7 priority support",
      "Image Generation",
      "Text-to-Speech Generation",
      "All Plus features included",
    ],
    buttonText: "Subscribe Now",
    priceIdUSD: "price_1Rt7nvLnHJrgLLrvzP0ew3a6",
    priceIdEUR: "price_1SiZeCLnHJrgLLrvwNPa2tqj",
    popular: false,
    tier: 4,
  },
  {
    name: "Elite",
    priceUSD: "100",
    priceEUR: "85",
    description: "For enterprise-level content production",
    features: [
      "50,000,000 tokens per month",
      calculateAudioHours(50000000),
      "1-month token rollover",
      "Story revision & style testing",
      "Video Generation",
      "24/7 priority support",
      "Image Generation",
      "Text-to-Speech Generation",
      "Extra storage for generated content",
      "Generate up to 10 processes simultaneously",
      "All Plus features included",
    ],
    buttonText: "Subscribe Now",
    priceIdUSD: "price_1Rt7q6LnHJrgLLrvYmsKDsLB",
    priceIdEUR: "price_1SiZfPLnHJrgLLrv39uXPBkS",
    popular: false,
    tier: 5,
  },
  {
    name: "Ultimate",
    priceUSD: "150",
    priceEUR: "128",
    description: "For large-scale content studios",
    features: [
      "75,000,000 tokens per month",
      calculateAudioHours(75000000),
      "1-month token rollover",
      "Story revision & style testing",
      "Video Generation",
      "24/7 priority support",
      "Image Generation",
      "Text-to-Speech Generation",
      "Extra storage for generated content",
      "Generate up to 10 processes simultaneously",
      "All Plus features included",
    ],
    buttonText: "Subscribe Now",
    priceIdUSD: "price_1Rt7qrLnHJrgLLrvMyE2xBDi",
    priceIdEUR: "price_1SiZg0LnHJrgLLrvCPpXJH2c",
    popular: false,
    tier: 6,
  },
  {
    name: "Enterprise",
    priceUSD: "500",
    priceEUR: "425",
    description: "For industry-leading content creators",
    features: [
      "250,000,000 tokens per month",
      calculateAudioHours(250000000),
      "1-month token rollover",
      "Story revision & style testing",
      "Video Generation",
      "24/7 priority support",
      "Image Generation",
      "Text-to-Speech Generation",
      "Extra storage for generated content",
      "Generate up to 10 processes simultaneously",
      "All Plus features included",
    ],
    buttonText: "Subscribe Now",
    priceIdUSD: "price_1S3zjRLnHJrgLLrvPNeQIR6X",
    priceIdEUR: "price_1SiZgiLnHJrgLLrv7P151tDK",
    popular: false,
    tier: 7,
  },
];

// NEW plans — the post-cutover tiers shown to all new subscribers and to
// legacy users who explicitly switch via /pricing. No "Plus" tier in the new
// lineup. Token allocations and prices come from `new plans.txt`.
const newPlans = [
  {
    name: "Free",
    priceUSD: "0",
    priceEUR: "0",
    description: "Perfect for trying out North Noir",
    features: [
      "Lifetime allocation of 400,000 tokens",
      calculateAudioHours(400000),
      "Story revision & style testing",
      "Email support",
    ],
    buttonText: "Get Started",
    buttonLink: "/signup",
    popular: false,
    tier: 0,
    priceIdUSD: null,
    priceIdEUR: null,
  },
  {
    name: "Standard",
    priceUSD: "27",
    priceEUR: "24.99",
    description: "For regular content creators",
    features: [
      "9,000,000 tokens per month",
      calculateAudioHours(9000000),
      "1-month token rollover",
      "Story revision & style testing",
      "Priority email support",
      "Image Generation",
      "Video Generation",
      "Text-to-Speech Generation",
      "All Free features included",
    ],
    buttonText: "Subscribe Now",
    priceIdUSD: "price_1TU3PULnHJrgLLrvFlTqlcuq",
    priceIdEUR: "price_1TU3QCLnHJrgLLrv6bs1OB0Q",
    popular: false,
    tier: 1,
  },
  {
    name: "Premium",
    priceUSD: "47",
    priceEUR: "42.99",
    description: "For professional content creators",
    features: [
      "18,500,000 tokens per month",
      calculateAudioHours(18500000),
      "1-month token rollover",
      "Story revision & style testing",
      "Image Generation",
      "Video Generation",
      "Text-to-Speech Generation",
      "24/7 priority support",
      "All Standard features included",
    ],
    buttonText: "Subscribe Now",
    priceIdUSD: "price_1TU3RfLnHJrgLLrvGms7O3gD",
    priceIdEUR: "price_1TU3SOLnHJrgLLrv98kERiht",
    popular: true,
    tier: 2,
  },
  {
    name: "Pro",
    priceUSD: "97",
    priceEUR: "88.99",
    description: "For high-volume content creators",
    features: [
      "38,500,000 tokens per month",
      calculateAudioHours(38500000),
      "1-month token rollover",
      "Story revision & style testing",
      "Image Generation",
      "Video Generation",
      "Text-to-Speech Generation",
      "24/7 priority support",
      "All Premium features included",
    ],
    buttonText: "Subscribe Now",
    priceIdUSD: "price_1TU3WoLnHJrgLLrvP6u7uTUc",
    priceIdEUR: "price_1TU3XMLnHJrgLLrv9vTMnFsT",
    popular: false,
    tier: 3,
  },
  {
    name: "Elite",
    priceUSD: "197",
    priceEUR: "179.99",
    description: "For enterprise-level content production",
    features: [
      "78,500,000 tokens per month",
      calculateAudioHours(78500000),
      "1-month token rollover",
      "Story revision & style testing",
      "Image Generation",
      "Video Generation",
      "Text-to-Speech Generation",
      "24/7 priority support",
      "Extra storage for generated content",
      "Generate up to 10 processes simultaneously",
      "All Pro features included",
    ],
    buttonText: "Subscribe Now",
    priceIdUSD: "price_1TU3YBLnHJrgLLrvGhNLAbFY",
    priceIdEUR: "price_1TU3YgLnHJrgLLrvmYwFBPA9",
    popular: false,
    tier: 4,
  },
  {
    name: "Ultimate",
    priceUSD: "397",
    priceEUR: "359.99",
    description: "For large-scale content studios",
    features: [
      "198,000,000 tokens per month",
      calculateAudioHours(198000000),
      "1-month token rollover",
      "Story revision & style testing",
      "Image Generation",
      "Video Generation",
      "Text-to-Speech Generation",
      "24/7 priority support",
      "Extra storage for generated content",
      "Generate up to 10 processes simultaneously",
      "All Elite features included",
    ],
    buttonText: "Subscribe Now",
    priceIdUSD: "price_1TU3ZdLnHJrgLLrvYpHM9KrS",
    priceIdEUR: "price_1TU3aKLnHJrgLLrvugPxQ5on",
    popular: false,
    tier: 5,
  },
  {
    name: "Enterprise",
    priceUSD: "997",
    priceEUR: "899.99",
    description: "For industry-leading content creators",
    features: [
      "498,000,000 tokens per month",
      calculateAudioHours(498000000),
      "1-month token rollover",
      "Story revision & style testing",
      "Image Generation",
      "Video Generation",
      "Text-to-Speech Generation",
      "24/7 priority support",
      "Extra storage for generated content",
      "Generate up to 10 processes simultaneously",
      "All Ultimate features included",
    ],
    buttonText: "Subscribe Now",
    priceIdUSD: "price_1TU3bULnHJrgLLrvCG1y0U0s",
    priceIdEUR: "price_1TU3bxLnHJrgLLrvjzxOCigA",
    popular: false,
    tier: 6,
  },
];

interface TokenUsage {
  tokens_used: number;
  plan_max: number;
  rollover_tokens: number;
  plan_type: string;
  current_period_end: string;
}

const planMaxTokensLegacy: Record<string, number> = {
  free: 400000,
  standard: 4000000,
  plus: 6000000,
  premium: 10000000,
  pro: 25000000,
  elite: 50000000,
  ultimate: 75000000,
  enterprise: 250000000,
};

const planMaxTokensNew: Record<string, number> = {
  free: 400000,
  standard: 9000000,
  premium: 18500000,
  pro: 38500000,
  elite: 78500000,
  ultimate: 198000000,
  enterprise: 498000000,
};

function getPlanMaxTokens(planType: string, isLegacy: boolean): number {
  const map = isLegacy ? planMaxTokensLegacy : planMaxTokensNew;
  return map[planType] ?? planMaxTokensLegacy[planType] ?? 400000;
}

const planFeatures = {
  free: {
    name: 'Free Plan',
    description: 'Lifetime allocation of tokens',
    color: 'text-slate-300',
    bgColor: 'bg-slate-950/85',
    borderColor: 'border-slate-600',
    tokens: '400,000',
    price: 'Free forever',
    period: 'Lifetime',
  },
  standard: {
    name: 'Standard Plan',
    description: 'Perfect for regular content creators',
    color: 'text-green-300',
    bgColor: 'bg-green-950/85',
    borderColor: 'border-green-600',
    tokens: '9,000,000',
    price: '$27/month',
    period: 'Monthly',
  },
  plus: {
    name: 'Plus Plan',
    description: 'Ideal for frequent content creators',
    color: 'text-blue-300',
    bgColor: 'bg-blue-950/85',
    borderColor: 'border-blue-600',
    tokens: '6,000,000',
    price: '$15/month',
    period: 'Monthly',
  },
  premium: {
    name: 'Premium Plan',
    description: 'For professional content creators',
    color: 'text-purple-300',
    bgColor: 'bg-purple-950/85',
    borderColor: 'border-purple-600',
    tokens: '18,500,000',
    price: '$47/month',
    period: 'Monthly',
  },
  pro: {
    name: 'Pro Plan',
    description: 'For high-volume content creators',
    color: 'text-red-300',
    bgColor: 'bg-red-950/85',
    borderColor: 'border-red-600',
    tokens: '38,500,000',
    price: '$97/month',
    period: 'Monthly',
  },
  elite: {
    name: 'Elite Plan',
    description: 'For enterprise-level content production',
    color: 'text-teal-300',
    bgColor: 'bg-teal-950/85',
    borderColor: 'border-teal-600',
    tokens: '78,500,000',
    price: '$197/month',
    period: 'Monthly',
  },
  ultimate: {
    name: 'Ultimate Plan',
    description: 'For large-scale content studios',
    color: 'text-yellow-300',
    bgColor: 'bg-yellow-950/85',
    borderColor: 'border-yellow-600',
    tokens: '198,000,000',
    price: '$397/month',
    period: 'Monthly',
  },
  enterprise: {
    name: 'Enterprise Plan',
    description: 'For industry-leading content creators',
    color: 'text-indigo-300',
    bgColor: 'bg-indigo-950/85',
    borderColor: 'border-indigo-600',
    tokens: '498,000,000',
    price: '$997/month',
    period: 'Monthly',
  },
};

// Legacy-tier display overlay — same colors as the NEW variants, but with the
// grandfathered token allotments and prices so the "Your Current Plan" card
// shows the right numbers for legacy users.
const planFeaturesLegacy: typeof planFeatures = {
  free: { ...planFeatures.free },
  standard: { ...planFeatures.standard, name: 'Standard Plan (Legacy)', tokens: '4,000,000', price: '$10/month' },
  plus: { ...planFeatures.plus, name: 'Plus Plan (Legacy)' },
  premium: { ...planFeatures.premium, name: 'Premium Plan (Legacy)', tokens: '10,000,000', price: '$20/month' },
  pro: { ...planFeatures.pro, name: 'Pro Plan (Legacy)', tokens: '25,000,000', price: '$50/month' },
  elite: { ...planFeatures.elite, name: 'Elite Plan (Legacy)', tokens: '50,000,000', price: '$100/month' },
  ultimate: { ...planFeatures.ultimate, name: 'Ultimate Plan (Legacy)', tokens: '75,000,000', price: '$150/month' },
  enterprise: { ...planFeatures.enterprise, name: 'Enterprise Plan (Legacy)', tokens: '250,000,000', price: '$500/month' },
};

function getPlanFeatures(planType: string, isLegacy: boolean) {
  const key = (planType || 'free').toLowerCase() as keyof typeof planFeatures;
  const map = isLegacy ? planFeaturesLegacy : planFeatures;
  return map[key] ?? planFeatures.free;
}

const TOKENS_PER_GROUP = 200000; // 200k tokens per group

export default function Pricing() {
  const { user, loading: authLoading, getAccessToken } = useAuth();
  const [selectedCurrency, setSelectedCurrency] = useState<"USD" | "EUR">("USD");
  const [userPlan, setUserPlan] = useState<{
    plan_type: string;
    subscription_status: string;
    pending_plan_type: string | null;
    stripe_subscription_id: string | null;
    is_legacy_plan: boolean;
    cancel_at_period_end?: boolean;
  } | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [couponCode, setCouponCode] = useState("");
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [tokenGroupsInput, setTokenGroupsInput] = useState<string>("");
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  // Tracks which subscription action button is currently processing.
  // Holds the plan name (e.g. "Standard") or "manage" for the portal action, otherwise null.
  const [subscribeLoading, setSubscribeLoading] = useState<string | null>(null);
  const [nextPaymentDate, setNextPaymentDate] = useState<string | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null);
  const [pendingPlanType, setPendingPlanType] = useState<string | null>(null);

  // Plan hierarchy for comparison
  const planHierarchy: Record<string, number> = {
    free: 0,
    standard: 1,
    plus: 2,
    premium: 3,
    pro: 4,
    elite: 5,
    ultimate: 6,
    enterprise: 7
  };

  const comparePlans = (currentPlan: string, pendingPlan: string) => {
    const currentLevel = planHierarchy[currentPlan] || 0;
    const pendingLevel = planHierarchy[pendingPlan] || 0;
    
    if (pendingLevel > currentLevel) return 'upgrade';
    if (pendingLevel < currentLevel) return 'downgrade';
    return 'same';
  };

  const getPaymentSectionContent = () => {
    if (subscriptionStatus === 'last_month') {
      if (pendingPlanType === 'free') {
        return {
          title: "Last Month",
          description: "Your subscription will end on this date"
        };
      } else if (tokenUsage?.plan_type && pendingPlanType) {
        const comparison = comparePlans(tokenUsage.plan_type, pendingPlanType);
        return {
          title: "Next Payment Period",
          description: comparison === 'downgrade' 
            ? "Your subscription will downgrade on this date"
            : "Your subscription will upgrade on this date"
        };
      }
    }
    
    return {
      title: "Next Payment Period",
      description: "Your subscription will renew on this date"
    };
  };

  useEffect(() => {
    if (!user) {
      setPlanLoading(false);
      return;
    }

    const fetchUserPlan = async () => {
      try {
        const { data, error } = await supabase
          .from("user_plans")
          .select("plan_type, subscription_status, pending_plan_type, stripe_subscription_id, is_legacy_plan")
          .eq("user_id", user.id)
          .eq("is_active", true)
          .single();

        if (error) {
          console.error("Error fetching user plan:", error);
          setUserPlan(null);
        } else if (data) {
          setUserPlan({
            plan_type: data.plan_type,
            subscription_status: data.subscription_status,
            pending_plan_type: data.pending_plan_type,
            stripe_subscription_id: data.stripe_subscription_id,
            is_legacy_plan: (data as { is_legacy_plan?: boolean }).is_legacy_plan === true,
          });
          setSubscriptionStatus(data.subscription_status);
          setPendingPlanType(data.pending_plan_type);
        } else {
          setUserPlan(null);
        }
      } catch (err) {
        console.error("Unexpected error fetching user plan:", err);
        setUserPlan(null);
      } finally {
        setPlanLoading(false);
      }
    };

    fetchUserPlan();
  }, [user]);

  useEffect(() => {
    if (!user) return;
    // Wait until the user_plans row has loaded before resolving plan_max,
    // otherwise `userPlan?.is_legacy_plan` reads as `false` on the first
    // pass and legacy users get NEW (post-cutover) allotments shown
    // (e.g. Standard legacy → 9M instead of 4M).
    if (planLoading) return;

    const fetchTokenUsage = async () => {
      try {
        const { data, error } = await supabase
          .rpc('get_user_token_usage', { user_id_param: user.id });
        if (error) throw error;
        if (data && data[0]) {
          const usage = data[0];
          // Token-allocation source-of-truth: if the user is on a legacy plan,
          // use the legacy table; otherwise the new (post-cutover) table.
          const isLegacyForUsage = userPlan?.is_legacy_plan === true;
          setTokenUsage({
            tokens_used: usage.tokens_used,
            plan_max: getPlanMaxTokens(usage.plan_type, isLegacyForUsage),
            rollover_tokens: usage.rollover_tokens || 0,
            plan_type: usage.plan_type,
            current_period_end: usage.current_period_end || '',
          });
        }

        // Fetch payment period data and subscription status
        const { data: planData } = await supabase
          .from('user_plans')
          .select('current_period_end, subscription_status, pending_plan_type')
          .eq('user_id', user.id)
          .single();
        
        if (planData) {
          if (planData.current_period_end) {
            setNextPaymentDate(planData.current_period_end);
          }
          setSubscriptionStatus(planData.subscription_status);
          setPendingPlanType(planData.pending_plan_type);
        }
      } catch (err) {
        console.error('Error fetching token usage:', err);
      }
    };

    fetchTokenUsage();
  }, [user, planLoading, userPlan?.is_legacy_plan]);

  const handleSubscribe = async (plan: any) => {
    if (subscribeLoading) return;
    if (!user) {
      setSubscribeLoading(plan.name);
      window.location.href = "/signup";
      return;
    }

    const priceId = selectedCurrency === "USD" ? plan.priceIdUSD : plan.priceIdEUR;

    setSubscribeLoading(plan.name);
    try {
      const token = await getAccessToken();
      if (!token) { alert('Please sign in first.'); setSubscribeLoading(null); return; }
      const response = await fetch(
        `${import.meta.env.SUPABASE_URL}/functions/v1/create-checkout-session`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            priceId,
            userId: user.id,
            planName: plan.name,
            currency: selectedCurrency,
            successUrl: "https://northnoir.com/success",
            cancelUrl: "https://northnoir.com/pricing",
            couponCode: couponCode.trim() || null,
            referral: (window as any).promotekit_referral || null,
          }),
        }
      );

      const { sessionId, error } = await response.json();
      if (error) {
        console.error("Error creating checkout session:", error);
        // Check if it's a coupon-related error
        if (error.includes("No such coupon") || error.includes("No such promotion_code")) {
          alert("The coupon code you entered does not exist or is no longer valid. Please check the code and try again.");
        } else {
          alert("Failed to initiate payment. Please try again.");
        }
        setSubscribeLoading(null);
        return;
      }

      // Track purchase initiation conversion
      trackConversion(CONVERSION_EVENTS.PURCHASE_INITIATED, {
        value: plan.priceUSD,
        currency: selectedCurrency,
        plan_name: plan.name,
      });

      const stripe = await stripePromise;
      if (stripe) {
        await stripe.redirectToCheckout({ sessionId });
      }
      // Leave loading state on intentionally — page is redirecting to Stripe.
    } catch (error) {
      console.error("Error creating checkout session:", error);
      alert("Failed to initiate payment. Please try again.");
      setSubscribeLoading(null);
    }
  };

  const handleTokenPurchase = async () => {
    const tokenGroupsToPurchase = parseInt(tokenGroupsInput) || 0;
    
    if (!user || tokenGroupsToPurchase <= 0) return;

    // Validate minimum token group purchase
    if (tokenGroupsToPurchase < 1) {
      alert("Minimum purchase is 1 group (200,000 tokens).");
      return;
    }

    // Validate user has used enough tokens
    if (!tokenUsage || tokenUsage.tokens_used < TOKENS_PER_GROUP) {
      alert("You must have used at least 200,000 tokens to purchase token resets.");
      return;
    }

    // Calculate maximum groups user can purchase
    const maxGroups = Math.floor(tokenUsage.tokens_used / TOKENS_PER_GROUP);

    // Validate user doesn't exceed their maximum groups
    if (tokenGroupsToPurchase > maxGroups) {
      alert(`Cannot purchase more than ${maxGroups} groups (${maxGroups * TOKENS_PER_GROUP} tokens).`);
      return;
    }

    setPurchaseLoading(true);
    try {
      const token = await getAccessToken();
      if (!token) { alert('Please sign in first.'); setPurchaseLoading(false); return; }
      const response = await fetch(
        `${import.meta.env.SUPABASE_URL}/functions/v1/create-token-purchase-session`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            userId: user.id,
            tokenGroups: tokenGroupsToPurchase,
            currency: selectedCurrency,
            successUrl: "https://northnoir.com/success",
            cancelUrl: "https://northnoir.com/pricing",
          }),
        }
      );

      const { sessionId, error } = await response.json();
      if (error) {
        alert(`Failed to initiate token purchase: ${error}`);
        return;
      }

      // Calculate total tokens and price for tracking
      const totalTokens = tokenGroupsToPurchase * TOKENS_PER_GROUP;
      const pricePerGroup = selectedCurrency === "USD" ? 0.60 : 0.52;
      const totalPrice = tokenGroupsToPurchase * pricePerGroup;

      // Track token purchase conversion
      trackConversion(CONVERSION_EVENTS.TOKEN_PURCHASE, {
        token_amount: totalTokens,
        value: totalPrice,
        currency: selectedCurrency,
      });

      const stripe = await stripePromise;
      if (stripe) {
        await stripe.redirectToCheckout({ sessionId });
      }
    } catch (error) {
      console.error("Error creating token purchase session:", error);
      alert("Failed to initiate token purchase. Please try again.");
    } finally {
      setPurchaseLoading(false);
    }
  };

  const handleManageSubscription = async () => {
    if (subscribeLoading) return;
    if (!user) {
      setSubscribeLoading("manage");
      window.location.href = "/signup";
      return;
    }

    setSubscribeLoading("manage");
    try {
      const token = await getAccessToken();
      if (!token) { alert('Please sign in first.'); setSubscribeLoading(null); return; }
      const response = await fetch(
        `${import.meta.env.SUPABASE_URL}/functions/v1/create-portal-session`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            userId: user.id,
            returnUrl: "https://northnoir.com/pricing",
          }),
        }
      );

      const { url, error } = await response.json();
      if (error) {
        console.error("Error creating portal session:", error);
        alert("Failed to access subscription management. Please try again.");
        setSubscribeLoading(null);
        return;
      }

      window.location.href = url;
      // Leave loading state on intentionally — page is redirecting to Stripe portal.
    } catch (error) {
      console.error("Error creating portal session:", error);
      alert("Failed to access subscription management. Please try again.");
      setSubscribeLoading(null);
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // Legacy-subscription actions. These hit the in-app `manage-legacy-subscription`
  // edge function instead of Stripe Checkout / Customer Portal because the
  // legacy prices are archived post-cutover.
  // ───────────────────────────────────────────────────────────────────────────
  const callManageLegacy = async (
    body: { action: 'switch'; newPriceId: string } | { action: 'cancel' } | { action: 'uncancel' }
  ) => {
    const token = await getAccessToken();
    if (!token) {
      alert('Please sign in first.');
      return null;
    }
    const response = await fetch(
      `${import.meta.env.SUPABASE_URL}/functions/v1/manage-legacy-subscription`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    );
    const json = await response.json();
    if (!response.ok || json.error) {
      alert(json.error || 'Subscription update failed. Please try again.');
      return null;
    }
    return json;
  };

  const handleLegacySwitch = async (plan: { name: string; priceIdUSD: string | null; priceIdEUR: string | null }) => {
    if (subscribeLoading) return;
    if (!user) {
      window.location.href = '/signup';
      return;
    }
    const newPriceId = selectedCurrency === 'USD' ? plan.priceIdUSD : plan.priceIdEUR;
    if (!newPriceId) return;
    const ok = window.confirm(
      `Switch to the new ${plan.name} plan now?\n\n` +
      `Your subscription will update immediately and you'll be charged or credited the prorated difference. ` +
      `You will lose your legacy plan permanently.`
    );
    if (!ok) return;

    setSubscribeLoading(plan.name);
    const result = await callManageLegacy({ action: 'switch', newPriceId });
    if (result?.ok) {
      // Webhook updates the DB; clear local cache so the next page load reads fresh.
      try { sessionStorage.removeItem('nn_is_legacy_plan_v1'); } catch { /* ignore */ }
      window.location.href = '/success';
    } else {
      setSubscribeLoading(null);
    }
  };

  const handleLegacyCancel = async () => {
    if (subscribeLoading) return;
    const ok = window.confirm(
      'Cancel your subscription at the end of the current billing period?\n\n' +
      'You will keep your current plan and tokens until the period ends, then revert to the Free plan.'
    );
    if (!ok) return;
    setSubscribeLoading('cancel');
    const result = await callManageLegacy({ action: 'cancel' });
    if (result?.ok) {
      window.location.reload();
    } else {
      setSubscribeLoading(null);
    }
  };

  const handleLegacyUncancel = async () => {
    if (subscribeLoading) return;
    setSubscribeLoading('uncancel');
    const result = await callManageLegacy({ action: 'uncancel' });
    if (result?.ok) {
      window.location.reload();
    } else {
      setSubscribeLoading(null);
    }
  };

  const formatNumber = (num: number) => {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(1)}M`;
    }
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1)}K`;
    }
    return num.toString();
  };

  const formatPaymentDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long', 
      day: 'numeric'
    });
  };

  const calculateGroupCost = (groups: number) => {
    const pricePerGroup = selectedCurrency === "USD" ? 0.60 : 0.52;
    const cost = groups * pricePerGroup;
    const currencySymbol = selectedCurrency === "USD" ? "$" : "€";
    const totalTokens = groups * TOKENS_PER_GROUP;
    return {
      cost: `${currencySymbol}${cost.toFixed(2)}`,
      tokens: formatNumber(totalTokens)
    };
  };

  // Calculate max groups and related values
  const maxGroups = tokenUsage ? Math.floor(tokenUsage.tokens_used / TOKENS_PER_GROUP) : 0;
  const canPurchaseTokens = tokenUsage && tokenUsage.tokens_used >= TOKENS_PER_GROUP;
  const tokenGroupsToPurchase = parseInt(tokenGroupsInput) || 0;
  const costInfo = calculateGroupCost(tokenGroupsToPurchase);

  if (authLoading || planLoading) {
    return (
      <div className="min-h-screen bg-surface-primary flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent"></div>
      </div>
    );
  }

  // Show coupon section only if user has free plan and no stripe subscription
  const showCouponSection = user && 
    (!userPlan || (userPlan.plan_type.toLowerCase() === 'free' && !userPlan.stripe_subscription_id));

  const paymentSectionContent = getPaymentSectionContent();

  return (
    <div className="page-enter max-w-7xl mx-auto px-4 pt-section pb-section sm:px-6 lg:px-8" style={{ zoom: 1.1 }}>
      <Helmet>
        <title>Pricing - North Noir</title>
        <link rel="canonical" href="https://northnoir.com/pricing" />
      </Helmet>
      <div className="max-w-3xl">
        <h1 className="text-4xl md:text-5xl font-display font-medium text-white mb-5 tracking-tight">Pricing</h1>
        <p className="text-lg text-white/60 leading-relaxed">
          Token-based plans that scale with your production needs.
        </p>
      </div>

      {/* Currency Selector */}
      <div className="flex mt-10 mb-10">
        <div className="bg-surface-secondary rounded-full p-1 flex">
          <button
            onClick={() => setSelectedCurrency("USD")}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 ${
              selectedCurrency === "USD"
                ? "bg-accent text-white"
                : "text-white/50 hover:text-white"
            }`}
          >
            USD
          </button>
          <button
            onClick={() => setSelectedCurrency("EUR")}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 ${
              selectedCurrency === "EUR"
                ? "bg-accent text-white"
                : "text-white/50 hover:text-white"
            }`}
          >
            EUR
          </button>
        </div>
      </div>

      {/* Coupon Code Section - Only show for free plan users without stripe subscription */}
      {showCouponSection && (
        <div className="mb-10">
          <div className="bg-surface-secondary rounded-lg p-6 max-w-md border border-white/[0.04]">
            <h3 className="text-sm font-semibold text-white mb-3">Have a coupon code?</h3>
            <input
              type="text"
              placeholder="Enter coupon code"
              value={couponCode}
              onChange={(e) => setCouponCode(e.target.value)}
              className="w-full px-3 py-2 bg-surface-tertiary text-white rounded-md border border-white/[0.06] focus:border-accent focus:outline-none"
            />
            <p className="text-xs text-white/40 mt-2">
              Enter your coupon code before selecting a plan
            </p>
          </div>
        </div>
      )}

      {(() => {
        // ─────────────────────────────────────────────────────────────────────
        // Plan grid rendering branches on three states:
        //   1. Legacy paid user  → "Your Current Plan" (legacy card + cancel/uncancel)
        //                          + NEW plan grid with "Switch to X" buttons that
        //                          call manage-legacy-subscription (instant migration).
        //   2. New paid user     → NEW plan grid with checkout / portal buttons (today's flow).
        //   3. Free / signed-out → NEW plan grid with checkout buttons.
        // ─────────────────────────────────────────────────────────────────────
        const isLegacyUser = !!userPlan?.is_legacy_plan
          && userPlan.plan_type?.toLowerCase() !== 'free';
        const currentLegacyPlan = isLegacyUser
          ? legacyPlans.find((p) => p.name.toLowerCase() === userPlan!.plan_type.toLowerCase())
          : null;
        const isPendingCancel = userPlan?.subscription_status === 'last_month'
          && userPlan?.pending_plan_type === 'free';

        const renderNewPlanCard = (plan: typeof newPlans[number]) => {
          // For new-plan users + free/signed-out users we keep the existing
          // checkout / portal flow. For legacy users every paid card becomes a
          // "Switch to X" CTA that triggers the in-app migration.
          const hasSubscription = !!userPlan?.stripe_subscription_id;
          const isCurrentPlan = !isLegacyUser
            && !!userPlan
            && userPlan.plan_type.toLowerCase() === plan.name.toLowerCase();
          const isDowngradePending = !isLegacyUser
            && userPlan?.pending_plan_type?.toLowerCase() === plan.name.toLowerCase();
          const currentPlanTier = newPlans.find(
            (p) => p.name.toLowerCase() === userPlan?.plan_type?.toLowerCase()
          )?.tier ?? 0;

          let buttonText: string;
          if (isLegacyUser && plan.name !== 'Free') {
            buttonText = `Switch to ${plan.name}`;
          } else if (isCurrentPlan) {
            buttonText = 'Manage Subscription';
          } else if (isDowngradePending) {
            buttonText = `Downgrading to ${plan.name}`;
          } else if (hasSubscription && plan.tier > currentPlanTier && !isLegacyUser) {
            buttonText = 'Upgrade Subscription';
          } else if (hasSubscription && plan.tier <= currentPlanTier && !isLegacyUser) {
            buttonText = 'Downgrade Subscription';
          } else {
            buttonText = plan.buttonText;
          }

          const buttonClass = isDowngradePending
            ? 'bg-green-600/80 text-white cursor-default'
            : isCurrentPlan
              ? 'bg-green-600/80 text-white hover:bg-green-600'
              : plan.popular
              ? 'bg-accent text-white hover:bg-red-700'
              : 'bg-surface-tertiary text-white hover:bg-white/[0.08]';

          const displayPrice = selectedCurrency === 'USD' ? plan.priceUSD : plan.priceEUR;
          const currencySymbol = selectedCurrency === 'USD' ? '$' : '€';

          return (
            <div
              key={`new-${plan.name}`}
              className={`bg-surface-secondary rounded-lg overflow-hidden border ${
                plan.popular ? 'border-accent ring-1 ring-accent' : isCurrentPlan ? 'border-green-600/60' : 'border-white/[0.04]'
              }`}
            >
              {isCurrentPlan && !plan.popular && (
                <div className="bg-green-600/80 text-white text-center py-1 text-xs font-medium uppercase tracking-wider">
                  Current Plan
                </div>
              )}
              {plan.popular && (
                <div className="bg-accent text-white text-center py-1 text-xs font-medium uppercase tracking-wider">
                  Most Popular
                </div>
              )}
              <div className="p-6">
                <h2 className="text-lg font-display font-medium mb-2">{plan.name}</h2>
                <div className="flex items-baseline mb-4">
                  <span className="text-3xl font-display font-medium">{currencySymbol}{displayPrice}</span>
                  <span className="text-white/40 ml-2 text-sm">/month</span>
                </div>
                <p className="text-white/50 text-sm mb-6">{plan.description}</p>
                {plan.name === 'Free' && (!hasSubscription || isCurrentPlan) ? (
                  <Link
                    to={isCurrentPlan ? '/home' : (plan.buttonLink ?? '/signup')}
                    className={`block w-full text-center py-2 px-4 rounded-lg font-medium transition-colors ${buttonClass}`}
                  >
                    {buttonText}
                  </Link>
                ) : (() => {
                  // Action key drives the per-button loading state. Legacy
                  // switches use the plan name; new-plan flows reuse the prior
                  // 'manage' / plan-name keys.
                  const actionKey = isLegacyUser
                    ? plan.name
                    : (hasSubscription ? 'manage' : plan.name);
                  const isThisLoading = subscribeLoading === actionKey;
                  const isOtherLoading = subscribeLoading !== null && !isThisLoading;
                  const isDisabled = isDowngradePending || isThisLoading || isOtherLoading;
                  const onClick = () => {
                    if (isLegacyUser) {
                      handleLegacySwitch(plan);
                    } else if (hasSubscription) {
                      handleManageSubscription();
                    } else {
                      handleSubscribe(plan);
                    }
                  };
                  return (
                    <>
                      <button
                        onClick={onClick}
                        className={`flex items-center justify-center gap-2 w-full text-center py-2 px-4 rounded-lg font-medium transition-colors ${buttonClass} ${
                          isDisabled ? 'cursor-not-allowed' : ''
                        } ${isOtherLoading ? 'opacity-60' : ''}`}
                        disabled={isDisabled}
                        aria-busy={isThisLoading}
                      >
                        {isThisLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                        <span>{isThisLoading ? (isLegacyUser ? 'Switching…' : 'Redirecting…') : buttonText}</span>
                      </button>
                      {isCurrentPlan && (
                        <p className="text-white/30 text-xs text-center mt-2">Update payment method, view invoices &amp; more</p>
                      )}
                    </>
                  );
                })()}
                <ul className="mt-6 space-y-3">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start">
                      <Check className="h-4 w-4 text-accent-text mr-2 flex-shrink-0 mt-0.5" />
                      <span className="text-white/50 text-sm">{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        };

        return (
          <>
            {/* Legacy users: highlight their current plan separately. */}
            {isLegacyUser && currentLegacyPlan && (() => {
              const currencySymbol = selectedCurrency === 'USD' ? '$' : '€';
              const displayPrice = selectedCurrency === 'USD' ? currentLegacyPlan.priceUSD : currentLegacyPlan.priceEUR;
              const cancelLoading = subscribeLoading === 'cancel';
              const uncancelLoading = subscribeLoading === 'uncancel';
              return (
                <div className="mb-10">
                  <div className="flex items-baseline justify-between mb-4">
                    <h2 className="text-xl font-display font-medium text-white">Your Current Plan</h2>
                    <span className="text-xs uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                      Legacy
                    </span>
                  </div>
                  <div className="bg-surface-secondary rounded-lg overflow-hidden border border-amber-500/30 p-6">
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                      <div>
                        <h3 className="text-lg font-display font-medium mb-1">
                          {currentLegacyPlan.name} <span className="text-amber-300/80 text-sm font-normal">(Legacy)</span>
                        </h3>
                        <div className="flex items-baseline mb-3">
                          <span className="text-2xl font-display font-medium">{currencySymbol}{displayPrice}</span>
                          <span className="text-white/40 ml-2 text-sm">/month</span>
                        </div>
                        <p className="text-white/50 text-sm mb-4">
                          You're on a grandfathered plan. You can keep it as long as you stay subscribed,
                          but switching to a new plan is one-way — your legacy pricing won't be available again.
                        </p>
                        <ul className="space-y-2">
                          {currentLegacyPlan.features.slice(0, 4).map((feature) => (
                            <li key={feature} className="flex items-start">
                              <Check className="h-4 w-4 text-accent-text mr-2 flex-shrink-0 mt-0.5" />
                              <span className="text-white/60 text-sm">{feature}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="flex flex-col gap-2 md:min-w-[14rem]">
                        {isPendingCancel ? (
                          <button
                            onClick={handleLegacyUncancel}
                            disabled={!!subscribeLoading}
                            aria-busy={uncancelLoading}
                            className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium bg-accent text-white hover:bg-red-700 transition-colors disabled:opacity-60"
                          >
                            {uncancelLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                            <span>Resume Subscription</span>
                          </button>
                        ) : (
                          <button
                            onClick={handleLegacyCancel}
                            disabled={!!subscribeLoading}
                            aria-busy={cancelLoading}
                            className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium bg-surface-tertiary text-white hover:bg-white/[0.08] transition-colors disabled:opacity-60"
                          >
                            {cancelLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                            <span>Cancel Subscription</span>
                          </button>
                        )}
                        {isPendingCancel && (
                          <p className="text-xs text-amber-300/70 text-center">
                            Cancels at end of current billing period.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  <p className="text-white/40 text-sm mt-6">
                    Want to change plans? Pick a new plan below — the switch is instant and you'll be charged
                    or credited the prorated difference.
                  </p>
                </div>
              );
            })()}

            {/* NEW plan grid (shown to everyone). */}
            <div className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {newPlans.map(renderNewPlanCard)}
            </div>
          </>
        );
      })()}

      <div className="mt-16 text-center">
        <p className="text-white/40 text-sm">
          All plans include access to core features. Upgrade, downgrade, or
          cancel anytime via your subscription management portal.
        </p>
        
        {/* Token Purchase Section */}
        {user && (
          <div className="mt-8 bg-surface-secondary rounded-lg p-6 max-w-4xl mx-auto text-left border border-white/[0.04]">
            <h3 className="text-lg font-display font-medium text-white mb-2">Add Tokens</h3>
            <p className="text-white/50 text-sm mb-4">
              Reset your token usage to extend your content creation capacity. 
              Purchase token groups at {selectedCurrency === "USD" ? "$0.60" : "€0.52"} per 200,000 tokens.
            </p>
            {!canPurchaseTokens && (
              <p className="text-white/30 text-xs mb-4 italic">
                Token purchases unlock after using 200,000 tokens.
              </p>
            )}
            <div className="flex flex-col gap-4">
              <div className="mb-2">
                <p className="text-white font-medium text-sm">
                  Cost: {costInfo.cost} ({costInfo.tokens} tokens)
                </p>
                <p className="text-xs text-white/40">
                  Minimum: 1 group (200K tokens){canPurchaseTokens ? ` | Maximum: ${maxGroups} groups (${formatNumber(maxGroups * TOKENS_PER_GROUP)} tokens)` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="1"
                  max={maxGroups || 1}
                  value={tokenGroupsInput}
                  onChange={(e) => setTokenGroupsInput(e.target.value)}
                  placeholder="Amount of groups"
                  disabled={!canPurchaseTokens}
                  className={`px-3 py-2 bg-surface-tertiary text-white rounded-md border border-white/[0.06] focus:border-accent focus:outline-none w-48 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${!canPurchaseTokens ? 'opacity-40 cursor-not-allowed' : ''}`}
                  style={{ MozAppearance: 'textfield' }}
                />
                <button
                  onClick={() => setTokenGroupsInput(maxGroups.toString())}
                  disabled={!canPurchaseTokens}
                  className={`px-3 py-2 bg-surface-tertiary text-white rounded-md hover:bg-white/[0.08] transition-colors text-sm ${!canPurchaseTokens ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  Max
                </button>
                <button
                  onClick={handleTokenPurchase}
                  disabled={!canPurchaseTokens || purchaseLoading || tokenGroupsToPurchase < 1 || tokenGroupsToPurchase > maxGroups}
                  className="px-10 py-2 bg-accent text-white rounded-md hover:bg-red-700 transition-colors disabled:bg-white/[0.06] disabled:text-white/30 disabled:cursor-not-allowed"
                >
                  {purchaseLoading ? "Processing..." : "Purchase Tokens"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Token Usage Display - Only for paid plan users */}
        {user && tokenUsage && userPlan && userPlan.plan_type.toLowerCase() !== 'free' && (() => {
          const features = getPlanFeatures(tokenUsage.plan_type, userPlan.is_legacy_plan);
          return (
          <div className="mt-8">
            <div className={`p-6 rounded-lg border text-left ${features.borderColor} ${features.bgColor} max-w-4xl mx-auto`}>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className={`text-lg font-display font-medium ${features.color}`}>
                    {features.name}
                    {userPlan.is_legacy_plan && (
                      <span className="ml-2 text-xs uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 align-middle">
                        Legacy
                      </span>
                    )}
                  </h2>
                  <p className="text-white/40 text-sm">{features.description}</p>
                </div>
                <Coins className={`h-8 w-8 ${features.color}`} />
              </div>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                <div className="bg-white/[0.03] rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Calendar className="h-4 w-4 text-white/30" />
                    <h3 className="text-xs font-medium text-white/50">
                      {paymentSectionContent.title === 'Last Month' ? 'Subscription End Date' : 'Next Payment Date'}
                    </h3>
                  </div>
                  <p className="text-white text-sm">
                    {nextPaymentDate ? formatPaymentDate(nextPaymentDate) : 'N/A'}
                  </p>
                  <p className="text-xs text-white/40 mt-1">{paymentSectionContent.description}</p>
                </div>
                <div className="bg-white/[0.03] rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Coins className="h-4 w-4 text-white/30" />
                    <h3 className="text-xs font-medium text-white/50">Total Tokens</h3>
                  </div>
                  <p className="text-white text-sm">{formatNumber(tokenUsage.plan_max + tokenUsage.rollover_tokens)}</p>
                  <p className="text-xs text-white/40 mt-1">
                    {tokenUsage.rollover_tokens > 0
                      ? `${formatNumber(tokenUsage.plan_max)} + ${formatNumber(tokenUsage.rollover_tokens)} rollover`
                      : 'Maximum allocation'}
                  </p>
                </div>
                {(() => {
                  const total = tokenUsage.plan_max + tokenUsage.rollover_tokens;
                  const usedDisplay = Math.min(Math.max(tokenUsage.tokens_used, 0), total);
                  const remainingDisplay = Math.max(total - tokenUsage.tokens_used, 0);
                  return (
                    <>
                      <div className="bg-white/[0.03] rounded-lg p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <Coins className="h-4 w-4 text-white/30" />
                          <h3 className="text-xs font-medium text-white/50">Tokens Used</h3>
                        </div>
                        <p className="text-white text-sm">{formatNumber(usedDisplay)}</p>
                        <p className="text-xs text-white/40 mt-1">Used this period</p>
                      </div>
                      <div className="bg-white/[0.03] rounded-lg p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <CheckCircle2 className="h-4 w-4 text-white/30" />
                          <h3 className="text-xs font-medium text-white/50">Tokens Remaining</h3>
                        </div>
                        <p className="text-white text-sm">{formatNumber(remainingDisplay)}</p>
                        <p className="text-xs text-white/40 mt-1">Available to use</p>
                      </div>
                    </>
                  );
                })()}
              </div>
              <div className="mt-6">
                {(() => {
                  const total = tokenUsage.plan_max + tokenUsage.rollover_tokens;
                  const usedDisplay = Math.min(Math.max(tokenUsage.tokens_used, 0), total);
                  return (
                    <>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-white/40">Token Usage</span>
                        <span className="text-white/60">
                          {formatNumber(usedDisplay)} / {formatNumber(total)}
                        </span>
                      </div>
                      <div className="w-full bg-white/[0.06] rounded-full h-1.5">
                        <div
                          className="bg-accent h-1.5 rounded-full transition-all duration-300"
                          style={{ width: `${total > 0 ? (usedDisplay / total) * 100 : 0}%` }}
                        />
                      </div>
                    </>
                  );
                })()}
                {tokenUsage.rollover_tokens > 0 && (
                  <p className="text-xs text-white/30 mt-2">Includes {formatNumber(tokenUsage.rollover_tokens)} rollover tokens from last month</p>
                )}
              </div>
            </div>
          </div>
          );
        })()}

        {/* Custom token amounts section */}
        <div className="mt-8 bg-surface-secondary rounded-lg p-6 max-w-2xl mx-auto text-center border border-white/[0.04]">
          <h3 className="text-lg font-display font-medium text-white mb-2">Need Custom Solutions?</h3>
          <p className="text-white/50 text-sm">
            Custom token amounts and enterprise solutions are available. Email us at{" "}
            <a href="mailto:contact@northnoir.com" className="text-accent-text hover:text-white transition-colors">
              contact@northnoir.com
            </a>{" "}
            to discuss personalized plans.
          </p>
        </div>
      </div>
    </div>
  );
}



