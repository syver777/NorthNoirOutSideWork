import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { BookOpen, LogOut, CreditCard, FileText, GitCompare, Image as ImageIcon, Home, Video, Mic, Image, GraduationCap, Sparkles, Film } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useIsLegacyPlan } from '../hooks/useIsLegacyPlan';
import { getPlanMaxTokens } from '../data/planMaxTokens';
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);
interface DashboardLayoutProps {
  children: React.ReactNode;
}
interface TokenUsage {
  tokens_used: number;
  plan_max: number;
  rollover_tokens: number;
  plan_type: 'free' | 'standard' | 'plus' | 'premium' | 'pro' | 'elite' | 'ultimate' | 'enterprise';
}
const DashboardLayout: React.FC<DashboardLayoutProps> = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, signOut, loading } = useAuth();
  const { isLegacy: isLegacyPlan, loading: isLegacyLoading } = useIsLegacyPlan();
  const [tokenUsage, setTokenUsage] = React.useState<TokenUsage | null>(null);
  const [loadingTokens, setLoadingTokens] = React.useState(true);
  React.useEffect(() => {
    const fetchTokenUsage = async () => {
      if (!user || isLegacyLoading) return;
      try {
        const { data, error } = await supabase
          .rpc('get_user_token_usage', { user_id_param: user.id });
        if (error) throw error;
        if (data && data[0]) {
          const usage = data[0];
          setTokenUsage({
            tokens_used: usage.tokens_used,
            plan_max: getPlanMaxTokens(usage.plan_type, isLegacyPlan),
            rollover_tokens: usage.rollover_tokens || 0,
            plan_type: usage.plan_type,
          });
        }
      } catch (err) {
        console.error('Error fetching token usage:', err);
      } finally {
        setLoadingTokens(false);
      }
    };
    fetchTokenUsage();
  }, [user, isLegacyPlan, isLegacyLoading]);
  const handleSignOut = async () => {
    try {
      await signOut();
      navigate('/signin');
    } catch (error) {
      console.error('Error signing out:', error);
      navigate('/signin');
    }
  };
  const handleSubscriptionClick = () => {
    navigate('/subscription');
  };
  const getInitial = () => {
    if (loading || !user) return '...';
    return user.email.charAt(0).toUpperCase();
  };
  const getTruncatedEmail = () => {
    if (loading || !user) return '...';
    const email = user.email;
    if (email.length > 12) {
      return `${email.slice(0, 9)}...`;
    }
    return email;
  };
  const formatTokenCount = (count: number) => {
    if (count >= 1000000) {
      return `${(count / 1000000).toFixed(1)}M`;
    } else if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}K`;
    }
    return count.toString();
  };
  const getPlanColor = (plan: string) => {
    switch (plan) {
      case 'premium': return 'text-plan-premium';
      case 'plus': return 'text-plan-plus';
      case 'standard': return 'text-plan-standard';
      case 'pro': return 'text-plan-pro';
      case 'elite': return 'text-plan-elite';
      case 'ultimate': return 'text-plan-ultimate';
      case 'enterprise': return 'text-plan-enterprise';
      default: return 'text-plan-free';
    }
  };
  
  const mainNavigation = [
    {
      name: 'Home',
      path: '/home',
      icon: <Home className="h-5 w-5" />
    },
    {
      name: 'Learn',
      path: '/learn',
      icon: <GraduationCap className="h-5 w-5" />
    },
    {
      name: 'Video Generator',
      path: '/video-generator',
      icon: <Video className="h-5 w-5" />
    },
    {
      name: 'Your Documents',
      path: '/documents',
      icon: <FileText className="h-5 w-5" />
    },
  ];

  const singleFeaturesNavigation = [
    {
      name: 'Story Generator',
      path: '/generator',
      icon: <BookOpen className="h-5 w-5" />
    },
    {
      name: 'Text-to-Speech',
      path: '/text-to-speech',
      icon: <Mic className="h-5 w-5" />
    },
    {
      name: 'Image Generator',
      path: '/image-generator',
      icon: <Image className="h-5 w-5" />
    },
    {
      name: 'Text-To-Video',
      path: '/text-to-video-generator',
      icon: <Video className="h-5 w-5" />
    },
    {
      name: 'Real Footage',
      path: '/real-footage-generator',
      icon: <Film className="h-5 w-5" />
    },
    {
      name: 'Motion Graphics',
      path: '/motion-graphics-generator',
      icon: <Sparkles className="h-5 w-5" />
    },
    {
      name: 'Image-To-Video',
      path: '/image-to-video',
      icon: <Video className="h-5 w-5" />
    },
  ];

  const extraFeaturesNavigation = [
    {
      name: 'Image Prompts',
      path: '/image-prompts',
      icon: <ImageIcon className="h-5 w-5" />
    },
    {
      name: 'Compare Stories',
      path: '/compare',
      icon: <GitCompare className="h-5 w-5" />
    },
    {
      name: 'Combine Videos',
      path: '/combine-video',
      icon: <Video className="h-5 w-5" />
    },
  ];
  
  if (loading) {
    return (
      <div className="min-h-screen bg-surface-primary flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent"></div>
      </div>
    );
  }
  if (!user) {
    navigate('/signin');
    return null;
  }
  return (
    <div className="h-screen bg-surface-primary flex overflow-hidden">
      {/* Sidebar */}
      <div className="w-16 sm:w-48 bg-surface-secondary border-r border-border h-full overflow-y-auto">
        <div className="p-3 border-b border-border">
          <button
            onClick={() => navigate('/')}
            className="flex items-center space-x-2 hover:bg-surface-tertiary/50 rounded-lg transition-colors"
          >
            <img
              src="https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/logo.png"
              alt="North Noir Logo"
              className="h-6 w-6"
            />
            <span className="text-lg font-bold font-display tracking-wide text-white hidden sm:inline">North Noir</span>
          </button>
        </div>
        <div className="p-3 sm:p-3">
          {/* User Info */}
          <div className="mb-6">
            <div className="flex items-center space-x-2 mb-2">
              <button
                onClick={handleSubscriptionClick}
                className="h-8 w-8 rounded-full bg-accent flex items-center justify-center text-white font-semibold text-sm hover:bg-accent-hover transition-colors"
              >
                {getInitial()}
              </button>
              <span className="text-sm text-text-secondary hidden sm:inline">{getTruncatedEmail()}</span>
            </div>
            {/* Token Usage */}
            {loadingTokens ? (
              <div className="bg-surface-tertiary/50 rounded-lg p-2 hidden sm:block">
                <div className="animate-pulse h-4 bg-surface-tertiary rounded w-3/4"></div>
              </div>
            ) : tokenUsage ? (
              <div className="bg-surface-tertiary/50 rounded-lg p-2 hidden sm:block">
                <div className="flex items-center gap-1 mb-1">
                  <span className={`text-xs font-medium ${getPlanColor(tokenUsage.plan_type)}`}>
                    {tokenUsage.plan_type.charAt(0).toUpperCase() + tokenUsage.plan_type.slice(1)} Plan
                  </span>
                </div>
                <div className="flex flex-col">
                  {(() => {
                    const total = tokenUsage.plan_max + tokenUsage.rollover_tokens;
                    const usedDisplay = Math.min(Math.max(tokenUsage.tokens_used, 0), total);
                    return (
                      <>
                        <span className="text-xs text-text-muted">
                          {formatTokenCount(usedDisplay)} / {formatTokenCount(total)}
                        </span>
                        <div className="w-full bg-surface-tertiary rounded-full h-1.5 mt-1">
                          <div
                            className="bg-accent h-1.5 rounded-full transition-all duration-300"
                            style={{ width: `${total > 0 ? (usedDisplay / total) * 100 : 0}%` }}
                          />
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            ) : null}
          </div>
          {/* Navigation */}
          <nav className="space-y-1">
            {/* Main Navigation */}
            {mainNavigation.map((item) => (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all duration-200 text-sm ${
                  location.pathname === item.path
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:bg-surface-tertiary/50 hover:text-white'
                }`}
              >
                {item.icon}
                <span className="hidden sm:inline">{item.name}</span>
              </button>
            ))}
            
            {/* Single Features Section */}
            <div className="border-t border-border my-2"></div>
            <div className="flex items-center justify-between px-2 py-1 text-text-muted text-sm hidden sm:flex">
              <span>Single Features</span>
            </div>
            {singleFeaturesNavigation.map((item) => (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all duration-200 text-sm ${
                  location.pathname === item.path
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:bg-surface-tertiary/50 hover:text-white'
                }`}
              >
                {item.icon}
                <span className="hidden sm:inline">{item.name}</span>
              </button>
            ))}

            {/* Extra Features Section */}
            <div className="border-t border-border my-2"></div>
            <div className="flex items-center justify-between px-2 py-1 text-text-muted text-sm hidden sm:flex">
              <span>Extra Features</span>
            </div>
            {extraFeaturesNavigation.map((item) => (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all duration-200 text-sm ${
                  location.pathname === item.path
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:bg-surface-tertiary/50 hover:text-white'
                }`}
              >
                {item.icon}
                <span className="hidden sm:inline">{item.name}</span>
              </button>
            ))}
          </nav>
          {/* Bottom Actions */}
          <div className="mt-8 p-2 bg-surface-tertiary/50 rounded-lg hidden sm:block">
            <div className="space-y-1">
              <button
                onClick={handleSubscriptionClick}
                className={`w-full flex items-center justify-center sm:justify-start gap-2 px-2 py-2 sm:py-1.5 rounded-lg transition-all duration-200 text-sm ${
                  location.pathname === '/subscription'
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:bg-surface-tertiary/50 hover:text-white'
                }`}
              >
                <CreditCard className="h-8 w-8 sm:h-5 sm:w-5" />
                <span className="hidden sm:inline">Subscription</span>
              </button>
              <button
                onClick={handleSignOut}
                className={`w-full flex items-center justify-center sm:justify-start gap-2 px-2 py-2 sm:py-1.5 rounded-lg transition-all duration-200 text-sm text-text-secondary hover:bg-surface-tertiary/50 hover:text-white`}
              >
                <LogOut className="h-8 w-8 sm:h-5 sm:w-5" />
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            </div>
          </div>
          {/* Mobile Sign Out Button */}
          <div className="mt-2 sm:hidden">
            <button
              onClick={handleSignOut}
              className="w-full flex items-center justify-center p-2 rounded-lg transition-colors text-text-secondary hover:bg-surface-tertiary/50 hover:text-white"
            >
              <LogOut className="h-8 w-8" />
            </button>
          </div>
        </div>
      </div>
      {/* Main Content */}
      <div className="flex-1 overflow-auto">
        <div className="py-8">
          {children}
        </div>
      </div>
    </div>
  );
};
export default DashboardLayout;

