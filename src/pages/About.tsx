import React, { useState, useEffect, useRef } from 'react';
import { Users } from 'lucide-react';
import { Helmet } from 'react-helmet-async';
import { useAuth } from '../contexts/AuthContext';
import ExampleChannelCard from '../components/ExampleChannelCard';
import { exampleChannels } from '../data/exampleChannels';
import { trackConversion, CONVERSION_EVENTS } from '../utils/gtagConversions';

export default function About() {
  const { user } = useAuth();
  const [isExampleSectionVisible, setIsExampleSectionVisible] = useState(false);
  const exampleSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Track About page view conversion
    trackConversion(CONVERSION_EVENTS.ABOUT_PAGE_VIEW);

    const hash = window.location.hash;
    if (hash === '#example-usage') {
      setTimeout(() => {
        const element = document.getElementById('example-usage');
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 100);
    }
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !isExampleSectionVisible) {
            setIsExampleSectionVisible(true);
          }
        });
      },
      {
        threshold: 0.05,
        rootMargin: '0px 0px 0px 0px'
      }
    );

    if (exampleSectionRef.current) {
      observer.observe(exampleSectionRef.current);
    }

    return () => {
      if (exampleSectionRef.current) {
        observer.unobserve(exampleSectionRef.current);
      }
    };
  }, [isExampleSectionVisible]);

  return (
    <>
      <Helmet>
        <title>About – North Noir</title>
        <link rel="canonical" href="https://northnoir.com/about" />
      </Helmet>

      <div style={{ zoom: 1.1 }}>
      <div className="page-enter">
        {/* Hero */}
        <div className="max-w-7xl mx-auto px-4 pt-section sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <h1 className="text-4xl md:text-5xl font-display font-medium text-white mb-5 tracking-tight">
              About North Noir
            </h1>
            <p className="text-lg text-white/60 leading-relaxed">
              A complete YouTube video generation platform — from a single prompt to a ready-to-upload package with script, visuals, and narration.
            </p>
          </div>
        </div>

        {/* Mission / Vision — side by side, no cards */}
        <div className="max-w-7xl mx-auto px-4 mt-16 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-2 gap-16 border-t border-white/[0.06] pt-12">
            <div>
              <div className="text-xs uppercase tracking-widest text-accent-text mb-4">Mission</div>
              <p className="text-white/60 leading-relaxed">
                Make professional video production accessible to every creator. North Noir replaces a full production team — writers, voiceover artists, image creators — with one AI-powered workflow, reducing costs by 90% while delivering broadcast-quality results.
              </p>
            </div>
            <div>
              <div className="text-xs uppercase tracking-widest text-accent-text mb-4">Vision</div>
              <p className="text-white/60 leading-relaxed">
                A future where anyone can produce professional long-form content. From 30-minute explainers to 20-hour epics, North Noir handles the full pipeline so creators can focus on ideas.
              </p>
            </div>
          </div>
        </div>

        {/* Key advantages — stacked, not card grid */}
        <div className="max-w-7xl mx-auto px-4 mt-section sm:px-6 lg:px-8">
          <h2 className="text-2xl font-display font-medium text-white mb-10">
            Why it works
          </h2>
          <div className="space-y-0 divide-y divide-white/[0.06]">
            <div className="grid md:grid-cols-[200px_1fr] gap-4 py-8 first:pt-0">
              <div className="text-sm font-medium text-white">Fraction of the cost</div>
              <p className="text-white/50 leading-relaxed">
                Traditional production — scriptwriters, voiceover artists, editors — runs thousands per video. North Noir delivers comparable results from one platform, saving 90%+ on production.
              </p>
            </div>
            <div className="grid md:grid-cols-[200px_1fr] gap-4 py-8">
              <div className="text-sm font-medium text-white">Effortless production</div>
              <p className="text-white/50 leading-relaxed">
                What normally requires a full team — writers, voiceover artists, editors — is handled by one platform. Enter a concept, adjust settings, and receive a complete video package ready for upload.
              </p>
            </div>
            <div className="grid md:grid-cols-[200px_1fr] gap-4 py-8">
              <div className="text-sm font-medium text-white">Algorithm-aligned</div>
              <p className="text-white/50 leading-relaxed">
                YouTube rewards watch time. Longer content keeps viewers on-platform, earning better recommendations in niches like storytelling, history, and tutorials.
              </p>
            </div>
            <div className="grid md:grid-cols-[200px_1fr] gap-4 py-8">
              <div className="text-sm font-medium text-white">Full pipeline</div>
              <p className="text-white/50 leading-relaxed">
                Script generation with narrative structure, consistent image prompts converted to professional visuals, and broadcast-quality narration — all synced automatically.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Example Usage Section - Full Width */}
      <div id="example-usage" className="scroll-mt-16 mt-section" ref={exampleSectionRef}>
        <div className="relative py-16 md:py-32 overflow-hidden bg-surface-primary">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(220,38,38,0.04)_0%,transparent_60%)]" />

          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            <div className={`mb-16 transition-all duration-700 ${
              isExampleSectionVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
            }`}>
              <div className="text-xs uppercase tracking-widest text-accent-text mb-4">
                Real channel examples
              </div>
              <h2 className="text-3xl md:text-4xl font-display font-medium text-white mb-5 tracking-tight">
                Example Usage
              </h2>
              <p className="text-white/50 leading-relaxed max-w-2xl">
                These YouTube channels showcase content types that North Noir can produce. While they may not have used our platform, they demonstrate the format and earning potential available to creators. All statistics are from the last year.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
              {exampleChannels.map((channel, index) => (
                <div
                  key={channel.url}
                  className={`transition-all duration-700 ${
                    isExampleSectionVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
                  }`}
                  style={{
                    transitionDelay: isExampleSectionVisible ? `${0.1 + index * 0.08}s` : '0s'
                  }}
                >
                  <ExampleChannelCard channel={channel} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Meet the Team */}
      <div className="max-w-7xl mx-auto px-4 pt-section pb-section sm:px-6 lg:px-8" style={{ zoom: 1.1 }}>
        <h2 className="text-2xl font-display font-medium text-white mb-12 text-center">
          Meet the Team
        </h2>
        <div className="grid sm:grid-cols-2 gap-12 max-w-2xl mx-auto">
          <div className="flex flex-col items-center text-center">
            <img
              src="https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Syver.jpeg"
              alt="Syver-August, Developer"
              className="w-20 h-20 rounded-full object-cover object-top mb-5"
            />
            <div className="text-xs uppercase tracking-widest text-accent-text mb-1">Developer</div>
            <h3 className="text-lg font-display font-medium text-white mb-2">Syver-August</h3>
            <p className="text-white/50 text-sm leading-relaxed">
              Built the technical foundation behind North Noir's AI pipeline — from story generation to fully assembled video packages.
            </p>
          </div>
          <div className="flex flex-col items-center text-center">
            <img
              src="https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Sebastian.jpeg"
              alt="Sebastian, Marketing Manager"
              className="w-20 h-20 rounded-full object-cover object-top mb-5"
            />
            <div className="text-xs uppercase tracking-widest text-accent-text mb-1">Marketing Manager</div>
            <h3 className="text-lg font-display font-medium text-white mb-2">Sebastian</h3>
            <p className="text-white/50 text-sm leading-relaxed">
              Connects North Noir with creators worldwide and drives growth of the platform's creator community.
            </p>
          </div>
        </div>
      </div>

      {/* Affiliate + Contact */}
      <div className="max-w-7xl mx-auto px-4 py-section sm:px-6 lg:px-8">
        <div className="max-w-xl mx-auto text-center">
          <h2 className="text-2xl font-display font-medium text-white mb-3">
            Affiliate Program
          </h2>
          <p className="text-white/50 mb-6 leading-relaxed">
            Earn 20% commission on every referral. Sign up for free, get your unique link and promo code, and start earning. Customers who use your code get 10% off.
          </p>
          <a
            href="https://northnoir.promotekit.com/"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackConversion(CONVERSION_EVENTS.AFFILIATE_SIGNUP)}
            className="bg-accent hover:bg-red-700 text-white font-medium py-3 px-8 rounded-lg transition-colors inline-flex items-center justify-center min-w-[200px]"
          >
            Join Affiliate Program
          </a>
          <p className="text-white/40 text-sm mt-8">
            Questions? <a href="mailto:contact@northnoir.com" className="text-accent-text hover:text-white transition-colors">contact@northnoir.com</a>
          </p>
        </div>
      </div>

      </div>
  </>
  );
}




