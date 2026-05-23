import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { BookOpen, GitCompare, Image, Mic, Video, Image as ImageIcon, ArrowRight, Film, Clapperboard } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import DashboardLayout from '../components/DashboardLayout';
import WelcomeModal from '../components/WelcomeModal';
import { useIsLegacyPlan } from '../hooks/useIsLegacyPlan';
import { getPlanMaxTokens } from '../data/planMaxTokens';

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

const planFeatures = {
  free: {
    name: 'Free Plan',
    description: 'Start creating with a lifetime token allocation',
    textColor: 'text-slate-300',
    borderColor: 'border-slate-600',
    bgColor: 'bg-slate-950/85',
    barColor: 'bg-slate-400',
    tokens: '400,000',
  },
  standard: {
    name: 'Standard Plan',
    description: 'Ideal for consistent content production',
    textColor: 'text-green-300',
    borderColor: 'border-green-600',
    bgColor: 'bg-green-950/85',
    barColor: 'bg-green-500',
    tokens: '4,000,000',
  },
  plus: {
    name: 'Plus Plan',
    description: 'Great for regular content creators',
    textColor: 'text-blue-300',
    borderColor: 'border-blue-600',
    bgColor: 'bg-blue-950/85',
    barColor: 'bg-blue-500',
    tokens: '6,000,000',
  },
  premium: {
    name: 'Premium Plan',
    description: 'Designed for professional creators',
    textColor: 'text-purple-300',
    borderColor: 'border-purple-600',
    bgColor: 'bg-purple-950/85',
    barColor: 'bg-purple-500',
    tokens: '10,000,000',
  },
  pro: {
    name: 'Pro Plan',
    description: 'For high-volume content creators',
    textColor: 'text-red-300',
    borderColor: 'border-red-600',
    bgColor: 'bg-red-950/85',
    barColor: 'bg-red-500',
    tokens: '25,000,000',
  },
  elite: {
    name: 'Elite Plan',
    description: 'For enterprise-level content production',
    textColor: 'text-teal-300',
    borderColor: 'border-teal-600',
    bgColor: 'bg-teal-950/85',
    barColor: 'bg-teal-500',
    tokens: '50,000,000',
  },
  ultimate: {
    name: 'Ultimate Plan',
    description: 'For large-scale content studios',
    textColor: 'text-yellow-300',
    borderColor: 'border-yellow-600',
    bgColor: 'bg-yellow-950/85',
    barColor: 'bg-yellow-500',
    tokens: '75,000,000',
  },
  enterprise: {
    name: 'Enterprise Plan',
    description: 'For industry-leading content creators',
    textColor: 'text-indigo-300',
    borderColor: 'border-indigo-600',
    bgColor: 'bg-indigo-950/85',
    barColor: 'bg-indigo-500',
    tokens: '125,000,000',
  },
};

const tools = [
  {
    name: 'Video Generator',
    description: 'Create a complete video from a single prompt — story, voice, images, and assembly.',
    icon: Video,
    path: '/video-generator',
    borderColor: 'border-red-500',
    bgColor: 'bg-red-900/40',
    textColor: 'text-red-300',
    iconColor: '#ef4444',
    hoverBorder: 'rgba(239,68,68,1)',
    hoverBg: 'rgba(127,29,29,0.4)',
    hoverText: '#fca5a5',
  },
  {
    name: 'Story Generator',
    description: 'Craft detailed narratives from 1,000 to 150,000 words for YouTube videos.',
    icon: BookOpen,
    path: '/generator',
    borderColor: 'border-orange-500',
    bgColor: 'bg-orange-900/40',
    textColor: 'text-orange-300',
    iconColor: '#f97316',
    hoverBorder: 'rgba(249,115,22,1)',
    hoverBg: 'rgba(124,45,18,0.4)',
    hoverText: '#fdba74',
  },
  {
    name: 'Text-to-Speech',
    description: 'Convert scripts into narrated audio with multiple voices, supporting 20+ hours.',
    icon: Mic,
    path: '/text-to-speech',
    borderColor: 'border-amber-500',
    bgColor: 'bg-amber-900/40',
    textColor: 'text-amber-300',
    iconColor: '#f59e0b',
    hoverBorder: 'rgba(245,158,11,1)',
    hoverBg: 'rgba(120,53,15,0.4)',
    hoverText: '#fcd34d',
  },
  {
    name: 'Image Generator',
    description: 'Generate visuals from your story with multiple AI models and custom styles.',
    icon: Image,
    path: '/image-generator',
    borderColor: 'border-green-500',
    bgColor: 'bg-green-900/40',
    textColor: 'text-green-300',
    iconColor: '#22c55e',
    hoverBorder: 'rgba(34,197,94,1)',
    hoverBg: 'rgba(20,83,45,0.4)',
    hoverText: '#86efac',
  },
  {
    name: 'Text-to-Video',
    description: 'Generate video clips directly from text prompts with AI video models.',
    icon: Film,
    path: '/text-to-video-generator',
    borderColor: 'border-blue-500',
    bgColor: 'bg-blue-900/40',
    textColor: 'text-blue-300',
    iconColor: '#3b82f6',
    hoverBorder: 'rgba(59,130,246,1)',
    hoverBg: 'rgba(30,58,138,0.4)',
    hoverText: '#93c5fd',
  },
  {
    name: 'Image-to-Video',
    description: 'Animate your generated images into video clips with AI motion models.',
    icon: Clapperboard,
    path: '/image-to-video',
    borderColor: 'border-purple-500',
    bgColor: 'bg-purple-900/40',
    textColor: 'text-purple-300',
    iconColor: '#a855f7',
    hoverBorder: 'rgba(168,85,247,1)',
    hoverBg: 'rgba(88,28,135,0.4)',
    hoverText: '#d8b4fe',
  },
  {
    name: 'Image Prompts',
    description: 'Create consistent visual prompts for your stories before generating images.',
    icon: ImageIcon,
    path: '/image-prompts',
    borderColor: 'border-teal-500',
    bgColor: 'bg-teal-900/40',
    textColor: 'text-teal-300',
    iconColor: '#14b8a6',
    hoverBorder: 'rgba(20,184,166,1)',
    hoverBg: 'rgba(19,78,74,0.4)',
    hoverText: '#5eead4',
  },
  {
    name: 'Compare Stories',
    description: 'Evaluate and refine multiple story versions side by side.',
    icon: GitCompare,
    path: '/compare',
    borderColor: 'border-indigo-500',
    bgColor: 'bg-indigo-900/40',
    textColor: 'text-indigo-300',
    iconColor: '#6366f1',
    hoverBorder: 'rgba(99,102,241,1)',
    hoverBg: 'rgba(49,46,129,0.4)',
    hoverText: '#a5b4fc',
  },
];



export default function Home() {
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [showWelcome, setShowWelcome] = useState(false);
  const location = useLocation();
  const { isLegacy: isLegacyPlan, loading: isLegacyLoading } = useIsLegacyPlan();

  useEffect(() => {
    const fetchTokenUsage = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('No user found');
        if (isLegacyLoading) return;
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
        setLoading(false);
      }
    };
    fetchTokenUsage();
  }, [isLegacyPlan, isLegacyLoading]);

  // Handle scrolling to section based on URL hash
  useEffect(() => {
    if (location.hash) {
      const element = document.getElementById(location.hash.slice(1));
      if (element) {
        element.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [location.hash]);

  // Show welcome modal for first-time signups
  useEffect(() => {
    if (localStorage.getItem('northnoir_show_welcome') === 'true') {
      setShowWelcome(true);
    }
  }, []);

  const formatNumber = (num: number) => {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(1)}M`;
    }
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1)}K`;
    }
    return num.toString();
  };

  const handleDismissWelcome = () => {
    localStorage.removeItem('northnoir_show_welcome');
    setShowWelcome(false);
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent-text" />
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      {showWelcome && <WelcomeModal onClose={handleDismissWelcome} />}
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8" style={{ zoom: 1.1 }}>
        {/* Atmospheric gradient background */}
        <div className="pointer-events-none absolute inset-0 -top-20 overflow-hidden" aria-hidden="true">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120%] h-[500px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(220,38,38,0.14)_0%,transparent_70%)]" />
          <div className="absolute top-40 left-0 w-[40%] h-[300px] bg-[radial-gradient(ellipse_80%_80%_at_20%_50%,rgba(59,130,246,0.07)_0%,transparent_60%)]" />
          <div className="absolute top-60 right-0 w-[35%] h-[250px] bg-[radial-gradient(ellipse_80%_80%_at_80%_50%,rgba(34,197,94,0.06)_0%,transparent_60%)]" />
        </div>

        <div className="relative mb-8 dash-animate-in">
          <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Welcome to North Noir</h1>
          <p className="mt-2 text-text-secondary">Create up to 150,000-word scripts for YouTube automation</p>
        </div>
        {/* Token Usage Card */}
        {tokenUsage && (
          <div
            className={`mb-8 p-6 rounded-xl border transition-all duration-200 ${planFeatures[tokenUsage.plan_type].borderColor} ${planFeatures[tokenUsage.plan_type].bgColor} dash-animate-in`}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className={`text-xl font-semibold ${planFeatures[tokenUsage.plan_type].textColor}`}>
                  {planFeatures[tokenUsage.plan_type].name}
                </h2>
                <p className={`text-sm mt-0.5 ${planFeatures[tokenUsage.plan_type].textColor} opacity-75`}>{planFeatures[tokenUsage.plan_type].description}</p>
              </div>
            </div>
            <div className="space-y-4">
              {(() => {
                const total = tokenUsage.plan_max + tokenUsage.rollover_tokens;
                const usedDisplay = Math.min(Math.max(tokenUsage.tokens_used, 0), total);
                return (
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className={`${planFeatures[tokenUsage.plan_type].textColor} opacity-75`}>Token Usage</span>
                      <span className="text-white">
                        {formatNumber(usedDisplay)} / {formatNumber(total)}
                      </span>
                    </div>
                    <div className="w-full bg-black/30 rounded-full h-2">
                      <div
                        className={`${planFeatures[tokenUsage.plan_type].barColor} h-2 rounded-full transition-all duration-500`}
                        style={{ width: `${total > 0 ? (usedDisplay / total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                );
              })()}
              <Link
                to="/subscription"
                className={`inline-flex items-center text-sm ${planFeatures[tokenUsage.plan_type].textColor} opacity-75 hover:opacity-100 hover:text-white transition-all`}
              >
                Upgrade your plan
                <ArrowRight className="h-4 w-4 ml-1" />
              </Link>
            </div>
          </div>
        )}
        {/* Tools Grid */}
        <div className="mb-12 dash-animate-in" style={{ animationDelay: '100ms' }}>
          <h2 className="text-2xl font-display font-semibold tracking-tight text-white mb-6">Available Tools</h2>
          <div className="grid md:grid-cols-2 gap-4 dash-stagger">
            {tools.map((tool) => (
              <Link
                key={tool.name}
                to={tool.path}
                className="tool-card p-5 rounded-xl border border-white/10 bg-surface-input transition-all duration-200 group hover:scale-[1.01]"
                style={{
                  '--tool-border': tool.hoverBorder,
                  '--tool-bg': tool.hoverBg,
                  '--tool-text': tool.hoverText,
                  '--tool-icon': tool.iconColor,
                } as React.CSSProperties}
              >
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-white/[0.04] group-hover:bg-black/20 transition-colors duration-200">
                    <tool.icon className="h-6 w-6 tool-card-icon transition-colors duration-200" />
                  </div>
                  <div>
                    <h3 className="text-lg font-medium text-text-muted tool-card-title transition-colors duration-200">
                      {tool.name}
                    </h3>
                    <p className="text-sm mt-1 text-text-dim tool-card-desc transition-all duration-200">{tool.description}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* How It Works */}
        <div className="mb-12 dash-animate-in" style={{ animationDelay: '200ms' }}>
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-display font-semibold tracking-tight text-white">How It Works</h2>
            <Link
              to="/learn"
              className="text-sm text-text-muted hover:text-accent-text transition-colors inline-flex items-center gap-1"
            >
              Watch tutorials
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="flex flex-col gap-2.5">
            {/* Quick path callout — the only fully-colored card */}
            <div className="p-5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
              <div className="flex items-start gap-4">
                <div className="p-3 rounded-lg bg-black/30">
                  <Video className="h-6 w-6 text-red-500" />
                </div>
                <div>
                  <h3 className="text-lg font-medium text-text-secondary">Quickest Path: Video Generator</h3>
                  <p className="text-text-dim mt-1">Create a complete video from a single prompt — story, voice, images, and assembly all handled automatically. We recommend testing the individual tools first to find your preferred models, styles, and voice.</p>
                </div>
              </div>
            </div>

            {/* Step 1: Story */}
            <div className="p-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
              <div className="flex items-center gap-3">
                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-orange-500/15 text-orange-400 text-xs font-semibold">1</span>
                <div>
                  <h3 className="text-sm font-medium text-text-secondary">Generate a Story</h3>
                  <p className="text-text-dim text-sm mt-0.5">Write a title and description. North Noir creates stories from 1,000 to 150,000 words with AI.</p>
                </div>
              </div>
            </div>

            {/* Step 2: Audio */}
            <div className="p-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
              <div className="flex items-center gap-3">
                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-amber-500/15 text-amber-400 text-xs font-semibold">2</span>
                <div>
                  <h3 className="text-sm font-medium text-text-secondary">Convert to Audio</h3>
                  <p className="text-text-dim text-sm mt-0.5">Transform your story into narrated audio with Text-to-Speech — multiple voices available, supporting 20+ hours.</p>
                </div>
              </div>
            </div>

            {/* Visual approaches separator */}
            <p className="text-xs text-text-dim pl-1 pt-1">Choose your visual approach</p>

            {/* Step 3: Images */}
            <div className="p-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
              <div className="flex items-center gap-3">
                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-green-500/15 text-green-400 text-xs font-semibold">3</span>
                <div>
                  <h3 className="text-sm font-medium text-text-secondary">Generate Images</h3>
                  <p className="text-text-dim text-sm mt-0.5">Create AI images from your story with multiple models and custom styles.</p>
                </div>
              </div>
            </div>

            {/* Step 4: Text-to-Video */}
            <div className="p-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
              <div className="flex items-center gap-3">
                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-teal-500/15 text-teal-400 text-xs font-semibold">4</span>
                <div>
                  <h3 className="text-sm font-medium text-text-secondary">Generate Video Clips</h3>
                  <p className="text-text-dim text-sm mt-0.5">Create video clips directly from text prompts with AI video models.</p>
                </div>
              </div>
            </div>

            {/* Step 5: Image-to-Video */}
            <div className="p-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
              <div className="flex items-center gap-3">
                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-blue-500/15 text-blue-400 text-xs font-semibold">5</span>
                <div>
                  <h3 className="text-sm font-medium text-text-secondary">Animate Images</h3>
                  <p className="text-text-dim text-sm mt-0.5">Turn your generated images into motion clips with AI animation models.</p>
                </div>
              </div>
            </div>

            {/* Step 6: Assemble */}
            <div className="p-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
              <div className="flex items-center gap-3">
                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-slate-400/15 text-slate-400 text-xs font-semibold">6</span>
                <div>
                  <h3 className="text-sm font-medium text-text-secondary">Assemble Your Video</h3>
                  <p className="text-text-dim text-sm mt-0.5">Combine your audio and visuals into a complete, ready-to-upload YouTube video.</p>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </DashboardLayout>
  );
}


