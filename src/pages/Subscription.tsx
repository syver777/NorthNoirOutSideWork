import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { createClient } from '@supabase/supabase-js';
import DashboardLayout from '../components/DashboardLayout';
import { Coins, Calendar, CheckCircle2, Receipt, ExternalLink, FileText } from 'lucide-react';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

interface TokenUsage {
  tokens_used: number;
  plan_max: number;
  rollover_tokens: number;
  plan_type: 'free' | 'standard' | 'plus' | 'premium' | 'pro' | 'elite' | 'ultimate' | 'enterprise';
}

interface BillingEntry {
  date: string;
  amount: number;
  currency: string;
  plan_name: string;
  invoice_pdf: string | null;
  hosted_url: string | null;
  period_start: string | null;
  period_end: string | null;
  status: string;
}

const planFeatures = {
  free: {
    name: 'Free Plan',
    description: 'Lifetime allocation of tokens',
    color: 'text-slate-300',
    textColor: 'text-slate-300',
    barColor: 'bg-slate-400',
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
    textColor: 'text-green-300',
    barColor: 'bg-green-500',
    bgColor: 'bg-green-950/85',
    borderColor: 'border-green-600',
    tokens: '9,000,000',
    price: '$27/month',
    period: 'Monthly',
  },
  plus: {
    // NOTE: Plus is legacy-only; kept here so legacy users still render correctly.
    name: 'Plus Plan',
    description: 'Ideal for frequent content creators',
    color: 'text-blue-300',
    textColor: 'text-blue-300',
    barColor: 'bg-blue-500',
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
    textColor: 'text-purple-300',
    barColor: 'bg-purple-500',
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
    textColor: 'text-red-300',
    barColor: 'bg-red-500',
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
    textColor: 'text-teal-300',
    barColor: 'bg-teal-500',
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
    textColor: 'text-yellow-300',
    barColor: 'bg-yellow-500',
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
    textColor: 'text-indigo-300',
    barColor: 'bg-indigo-500',
    bgColor: 'bg-indigo-950/85',
    borderColor: 'border-indigo-600',
    tokens: '498,000,000',
    price: '$997/month',
    period: 'Monthly',
  },
};

// Legacy (grandfathered) overlay — only the fields that differ from `planFeatures`.
const planFeaturesLegacyOverlay: Record<string, { tokens: string; price: string }> = {
  standard:   { tokens: '4,000,000',   price: '$10/month' },
  plus:       { tokens: '6,000,000',   price: '$15/month' },
  premium:    { tokens: '10,000,000',  price: '$20/month' },
  pro:        { tokens: '25,000,000',  price: '$50/month' },
  elite:      { tokens: '50,000,000',  price: '$100/month' },
  ultimate:   { tokens: '75,000,000',  price: '$150/month' },
  enterprise: { tokens: '250,000,000', price: '$500/month' },
};

function getPlanFeatures(planType: keyof typeof planFeatures, isLegacy: boolean) {
  const base = planFeatures[planType];
  if (!isLegacy) return base;
  const overlay = planFeaturesLegacyOverlay[planType];
  return overlay ? { ...base, ...overlay } : base;
}

export default function Subscription() {
  const { user, loading: authLoading, signOut, getAccessToken } = useAuth();
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [nextPaymentDate, setNextPaymentDate] = useState<string | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null);
  const [pendingPlanType, setPendingPlanType] = useState<string | null>(null);
  const [isLegacyPlan, setIsLegacyPlan] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [billingHistory, setBillingHistory] = useState<BillingEntry[]>([]);
  const [billingEmail, setBillingEmail] = useState<string | null>(null);
  const navigate = useNavigate();

  // Per-plan token allotments. Split into legacy (grandfathered) and new
  // (post-cutover) tables; the active row is selected via `is_legacy_plan`.
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
  const getPlanMax = (planType: string, isLegacy: boolean): number => {
    const map = isLegacy ? planMaxTokensLegacy : planMaxTokensNew;
    return map[planType] ?? planMaxTokensLegacy[planType] ?? 400000;
  };

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

  const formatPaymentDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long', 
      day: 'numeric'
    });
  };

  useEffect(() => {
    const fetchTokenUsage = async () => {
      try {
        if (!user) return;
        const { data, error } = await supabase
          .rpc('get_user_token_usage', { user_id_param: user.id });
        if (error) throw error;
        // Fetch payment period data and subscription status
        const { data: planData } = await supabase
          .from('user_plans')
          .select('current_period_end, subscription_status, pending_plan_type, billing_history, stripe_customer_id, is_legacy_plan')
          .eq('user_id', user.id)
          .single();
        
        const isLegacy = (planData as { is_legacy_plan?: boolean } | null)?.is_legacy_plan === true;
        setIsLegacyPlan(isLegacy);
        if (data && data[0]) {
          const usage = data[0];
          setTokenUsage({
            tokens_used: usage.tokens_used,
            plan_max: getPlanMax(usage.plan_type, isLegacy),
            rollover_tokens: usage.rollover_tokens || 0,
            plan_type: usage.plan_type,
          });
        }
        
        if (planData) {
          if (planData.current_period_end) {
            setNextPaymentDate(planData.current_period_end);
          }
          setSubscriptionStatus(planData.subscription_status);
          setPendingPlanType(planData.pending_plan_type);
          if (planData.billing_history && Array.isArray(planData.billing_history)) {
            // Sort by date descending (newest first)
            const sorted = [...planData.billing_history].sort(
              (a: BillingEntry, b: BillingEntry) => new Date(b.date).getTime() - new Date(a.date).getTime()
            );
            setBillingHistory(sorted);
          }
        }
      } catch (err) {
        console.error('Error fetching token usage:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchTokenUsage();
  }, [user]);

  const formatNumber = (num: number) => {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(1)}M`;
    }
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1)}K`;
    }
    return num.toString();
  };

  const handleDeleteAccount = async () => {
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      if (!user?.id) {
        throw new Error('User ID is undefined');
      }
      const token = await getAccessToken();
      if (!token) {
        throw new Error('Not authenticated');
      }
      console.log('Attempting to invoke delete-account with user_id:', user.id);
      const response = await fetch('https://yilrqukialrbdzydvwmt.supabase.co/functions/v1/delete-account', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (!response.ok) {
        console.error('Supabase function error:', data.error);
        throw new Error(`Supabase function error: ${data.error || 'Unknown error'}`);
      }
      console.log('Delete account response:', data);
      // Sign out the user and redirect to home
      try {
        await signOut();
        navigate('/signin');
      } catch (error) {
        console.error('Error signing out:', error);
        navigate('/signin');
      }
    } catch (err: any) {
      console.error('Detailed error deleting account:', {
        message: err.message,
        stack: err.stack,
        name: err.name,
        context: err.context,
      });
      setDeleteError(`Failed to delete account: ${err.message || 'Unknown error'}`);
    } finally {
      setDeleteLoading(false);
      setShowDeleteConfirm(false);
    }
  };

  if (authLoading || loading) {
    return (
      <DashboardLayout>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent-text"></div>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  const paymentSectionContent = getPaymentSectionContent();

  return (
    <DashboardLayout>
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8" style={{ zoom: 1.1 }}>
        {/* Atmospheric gradient background */}
        <div className="pointer-events-none absolute inset-0 -top-20 overflow-hidden" aria-hidden="true">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120%] h-[500px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(220,38,38,0.14)_0%,transparent_70%)]" />
          <div className="absolute top-40 left-0 w-[40%] h-[300px] bg-[radial-gradient(ellipse_80%_80%_at_20%_50%,rgba(59,130,246,0.07)_0%,transparent_60%)]" />
          <div className="absolute top-60 right-0 w-[35%] h-[250px] bg-[radial-gradient(ellipse_80%_80%_at_80%_50%,rgba(34,197,94,0.06)_0%,transparent_60%)]" />
        </div>

        <div className="relative mb-8 dash-animate-in">
          <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Subscription</h1>
          <p className="mt-2 text-text-secondary">Manage your subscription and token usage</p>
        </div>
        {tokenUsage && (() => {
          const features = getPlanFeatures(tokenUsage.plan_type, isLegacyPlan);
          return (
          <div className="space-y-8 relative">
            {/* Current Plan Card */}
            <div className={`p-6 rounded-xl border transition-all duration-200 ${features.borderColor} ${features.bgColor} dash-animate-in`}>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className={`text-2xl font-semibold ${features.textColor} flex items-center gap-2 flex-wrap`}>
                    <span>{features.name}</span>
                    {isLegacyPlan && tokenUsage.plan_type !== 'free' && (
                      <span className="text-xs uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 align-middle">
                        Legacy
                      </span>
                    )}
                  </h2>
                  <p className={`text-sm mt-0.5 ${features.textColor} opacity-75`}>{features.description}</p>
                </div>
                <Coins className={`h-10 w-10 ${features.textColor}`} />
              </div>
              <div className="grid md:grid-cols-3 gap-6">
                <div className="bg-surface-card/50 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Calendar className={`h-5 w-5 ${features.textColor} opacity-75`} />
                    <h3 className="text-sm font-medium text-text-muted">Billing Period</h3>
                  </div>
                  <p className="text-white">{features.period}</p>
                  <p className="text-sm text-text-dim mt-1">{features.price}</p>
                </div>
                <div className="bg-surface-card/50 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Coins className={`h-5 w-5 ${features.textColor} opacity-75`} />
                    <h3 className="text-sm font-medium text-text-muted">Total Tokens</h3>
                  </div>
                  <p className="text-white">{formatNumber(tokenUsage.plan_max + tokenUsage.rollover_tokens)}</p>
                  <p className="text-sm text-text-dim mt-1">
                    {tokenUsage.rollover_tokens > 0
                      ? `${formatNumber(tokenUsage.plan_max)} + ${formatNumber(tokenUsage.rollover_tokens)} rollover`
                      : 'Maximum allocation'}
                  </p>
                </div>
                {(() => {
                  const total = tokenUsage.plan_max + tokenUsage.rollover_tokens;
                  const remainingDisplay = Math.max(total - tokenUsage.tokens_used, 0);
                  return (
                    <div className="bg-surface-card/50 rounded-xl p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <CheckCircle2 className={`h-5 w-5 ${features.textColor} opacity-75`} />
                        <h3 className="text-sm font-medium text-text-muted">Tokens Remaining</h3>
                      </div>
                      <p className="text-white">{formatNumber(remainingDisplay)}</p>
                      <p className="text-sm text-text-dim mt-1">Available to use</p>
                    </div>
                  );
                })()}
              </div>
              <div className="mt-6">
                {(() => {
                  const total = tokenUsage.plan_max + tokenUsage.rollover_tokens;
                  const usedDisplay = Math.min(Math.max(tokenUsage.tokens_used, 0), total);
                  return (
                    <>
                      <div className="flex justify-between text-sm mb-1">
                        <span className={`${features.textColor} opacity-75`}>Token Usage</span>
                        <span className="text-white">
                          {formatNumber(usedDisplay)} / {formatNumber(total)}
                        </span>
                      </div>
                      <div className="w-full bg-black/30 rounded-full h-2">
                        <div
                          className={`${features.barColor} h-2 rounded-full transition-all duration-500`}
                          style={{ width: `${total > 0 ? (usedDisplay / total) * 100 : 0}%` }}
                        />
                      </div>
                    </>
                  );
                })()}
                {tokenUsage.rollover_tokens > 0 && (
                  <p className="text-xs text-text-dim mt-2">Includes {formatNumber(tokenUsage.rollover_tokens)} rollover tokens from last month</p>
                )}
              </div>
            </div>

            {/* Next Payment Period Card */}
            <div className="bg-surface-card rounded-xl p-6 dash-animate-in" style={{ animationDelay: '100ms' }}>
              <h2 className="text-xl font-semibold text-white mb-4">{paymentSectionContent.title}</h2>
              <div className="bg-surface-elevated/50 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Calendar className="h-5 w-5 text-text-dim" />
                  <h3 className="text-sm font-medium text-text-muted">
                    {paymentSectionContent.title === 'Last Month' ? 'Subscription End Date' : 'Next Payment Date'}
                  </h3>
                </div>
                <p className="text-white">
                  {nextPaymentDate ? formatPaymentDate(nextPaymentDate) : 'N/A'}
                </p>
                <p className="text-sm text-text-dim mt-1">{paymentSectionContent.description}</p>
              </div>
            </div>

            {/* Account Information */}
            <div className="bg-surface-card rounded-xl p-6 dash-animate-in" style={{ animationDelay: '200ms' }}>
              <h2 className="text-xl font-semibold text-white mb-4">Account Information</h2>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-text-muted">Email</label>
                  <p className="mt-1 text-white">{user?.email}</p>
                </div>
              </div>
            </div>

            {/* Billing History */}
            <div className="bg-surface-card rounded-xl p-6 dash-animate-in" style={{ animationDelay: '250ms' }}>
              <div className="flex items-center gap-3 mb-4">
                <Receipt className="h-5 w-5 text-text-dim" />
                <h2 className="text-xl font-semibold text-white">Billing History</h2>
              </div>
              {billingHistory.length === 0 ? (
                <div className="bg-surface-elevated/50 rounded-xl p-6 text-center">
                  <FileText className="h-8 w-8 text-text-dim mx-auto mb-3" />
                  <p className="text-text-muted text-sm">No billing history yet</p>
                  <p className="text-text-dim text-xs mt-1">Invoices will appear here once you subscribe to a paid plan</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {billingHistory.map((entry, index) => {
                    const entryDate = new Date(entry.date).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    });
                    const amount = (entry.amount / 100).toFixed(2);
                    const currencySymbol = entry.currency === 'eur' ? '€' : '$';
                    const planDisplay = planFeatures[entry.plan_name as keyof typeof planFeatures];

                    return (
                      <div
                        key={`${entry.date}-${index}`}
                        className="bg-surface-elevated/50 rounded-xl p-4 flex items-center justify-between gap-4"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-sm font-medium ${planDisplay?.textColor || 'text-white'}`}>
                              {planDisplay?.name || entry.plan_name}
                            </span>
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/15 text-green-400">
                              {entry.status}
                            </span>
                          </div>
                          <p className="text-text-dim text-xs">{entryDate}</p>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="text-white font-medium text-sm whitespace-nowrap">
                            {currencySymbol}{amount} {entry.currency.toUpperCase()}
                          </span>
                          {(entry.invoice_pdf || entry.hosted_url) && (
                            <a
                              href={entry.hosted_url || entry.invoice_pdf || '#'}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 text-xs text-text-muted hover:text-white transition-colors"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                              <span className="hidden sm:inline">Invoice</span>
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Buttons */}
            <div className="flex justify-between items-center dash-animate-in" style={{ animationDelay: '300ms' }}>
              {/* <button
                onClick={() => setShowDeleteConfirm(true)}
                className="px-2 py-1 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors sm:px-6 sm:py-3"
              >
                Delete Account
              </button> */}
              <button
                onClick={() => navigate('../Pricing')}
                className="px-2 py-1 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors sm:px-6 sm:py-3"
              >
                Manage Subscription
              </button>
            </div>
            {/* Delete Confirmation Modal */}
            {showDeleteConfirm && (
              <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                <div className="bg-surface-card p-6 rounded-xl max-w-md w-full">
                  <h2 className="text-xl font-semibold text-white mb-4">Confirm Account Deletion</h2>
                  <p className="text-text-muted mb-6">
                    Are you sure you want to delete your account? This action cannot be undone.
                  </p>
                  {deleteError && (
                    <p className="text-status-error mb-4">{deleteError}</p>
                  )}
                  <div className="flex justify-end gap-4">
                    <button
                      onClick={() => setShowDeleteConfirm(false)}
                      className="px-4 py-2 bg-surface-elevated text-white rounded-xl hover:bg-surface-elevated transition-colors"
                      disabled={deleteLoading}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleDeleteAccount}
                      className="px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors"
                      disabled={deleteLoading}
                    >
                      {deleteLoading ? 'Deleting...' : 'Delete Account'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          );
        })()}
      </div>
    </DashboardLayout>
  );
}



