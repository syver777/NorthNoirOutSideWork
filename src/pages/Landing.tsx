import { useEffect, useRef, useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { PenSquare, Mic, Video, ArrowRight, Play } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useAuth } from '../contexts/AuthContext';
import ExampleChannelCard from '../components/ExampleChannelCard';
import PipelineCanvas from '../components/PipelineCanvas';
import Preloader from '../components/Preloader';
import PipelineFlowSVG from '../components/PipelineFlowSVG';
import LiveStatsBar from '../components/LiveStatsBar';
import VisualStyleGallery from '../components/VisualStyleGalleryNew';
import VoiceShowcase from '../components/VoiceShowcase';
import BuiltForYouTube from '../components/BuiltForYouTube';
import BeforeAfter from '../components/BeforeAfter';
import VideoPlayer from '../components/VideoPlayer';
import TrustSignals from '../components/TrustSignals';
import DataTunnelCanvas from '../components/DataTunnelCanvas';
import { exampleChannels } from '../data/exampleChannels';
import { Helmet } from 'react-helmet-async';

gsap.registerPlugin(ScrollTrigger);

function Landing() {
  const { user, loading } = useAuth();
  const landingRef = useRef<HTMLDivElement>(null);
  const pipelineHeadingRef = useRef<HTMLDivElement>(null);
  const pipelineStepsRef = useRef<HTMLDivElement>(null);
  const pipelineConvergeRef = useRef<HTMLDivElement>(null);
  const channelsHeadingRef = useRef<HTMLDivElement>(null);
  const channelsCardsRef = useRef<HTMLDivElement>(null);
  const channelsCtaRef = useRef<HTMLDivElement>(null);
  const ctaSectionRef = useRef<HTMLDivElement>(null);

  // Preloader: show only once per session
  const [showPreloader, setShowPreloader] = useState(() => {
    if (typeof window === 'undefined') return false;
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return false;
    return !sessionStorage.getItem('nn_preloader_seen');
  });

  const handlePreloaderComplete = useCallback(() => {
    sessionStorage.setItem('nn_preloader_seen', '1');
    setShowPreloader(false);
  }, []);

  const featuredChannels = [
    exampleChannels.find(c => c.name === "Truth By Philosophers"),
    exampleChannels.find(c => c.name === "Sleepless Historian"),
    exampleChannels.find(c => c.name === "Let's Read Podcast")
  ].filter(Boolean);

  // GSAP scroll-driven section reveals
  useEffect(() => {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) return;

    const ctx = gsap.context(() => {
      // Pipeline heading reveal
      if (pipelineHeadingRef.current) {
        gsap.from(pipelineHeadingRef.current, {
          y: 40,
          opacity: 0,
          duration: 1,
          ease: 'power4.out',
          scrollTrigger: {
            trigger: pipelineHeadingRef.current,
            start: 'top 85%',
            end: 'top 55%',
            scrub: 1,
          },
        });
      }

      // Pipeline steps — staggered reveal
      if (pipelineStepsRef.current) {
        const steps = pipelineStepsRef.current.querySelectorAll('.pipeline-step');
        gsap.from(steps, {
          y: 50,
          opacity: 0,
          duration: 1,
          stagger: 0.15,
          ease: 'power4.out',
          scrollTrigger: {
            trigger: pipelineStepsRef.current,
            start: 'top 80%',
            end: 'top 45%',
            scrub: 1,
          },
        });
      }

      // Channels heading reveal
      if (channelsHeadingRef.current) {
        gsap.from(channelsHeadingRef.current, {
          y: 35,
          opacity: 0,
          duration: 1,
          ease: 'power4.out',
          scrollTrigger: {
            trigger: channelsHeadingRef.current,
            start: 'top 85%',
            end: 'top 55%',
            scrub: 1,
          },
        });
      }

      // Channel cards reveal
      if (channelsCardsRef.current) {
        const cards = channelsCardsRef.current.querySelectorAll('.channel-card');
        gsap.from(cards, {
          scale: 0.92,
          opacity: 0,
          duration: 1,
          stagger: 0.12,
          ease: 'power3.out',
          scrollTrigger: {
            trigger: channelsCardsRef.current,
            start: 'top 80%',
            end: 'top 40%',
            scrub: 1,
          },
        });
      }

      // Complete Video convergence reveal (matches pipeline steps animation)
      if (pipelineConvergeRef.current) {
        gsap.from(pipelineConvergeRef.current, {
          y: 50,
          opacity: 0,
          scale: 0.92,
          duration: 1,
          ease: 'power4.out',
          scrollTrigger: {
            trigger: pipelineConvergeRef.current,
            start: 'top 85%',
            end: 'top 50%',
            scrub: 1,
          },
        });
      }

      // Channels CTA reveal
      if (channelsCtaRef.current) {
        gsap.from(channelsCtaRef.current, {
          y: 25,
          opacity: 0,
          duration: 1,
          ease: 'power4.out',
          scrollTrigger: {
            trigger: channelsCtaRef.current,
            start: 'top 90%',
            end: 'top 65%',
            scrub: 1,
          },
        });
      }

      // Final CTA reveal
      if (ctaSectionRef.current) {
        gsap.from(ctaSectionRef.current, {
          y: 40,
          opacity: 0,
          duration: 1,
          ease: 'power4.out',
          scrollTrigger: {
            trigger: ctaSectionRef.current,
            start: 'top 85%',
            end: 'top 55%',
            scrub: 1,
          },
        });
      }
    }, landingRef);

    return () => ctx.revert();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-primary flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent" />
      </div>
    );
  }

  return (
    <div ref={landingRef} className={`bg-surface-primary${showPreloader ? ' hero-waiting' : ''}`}>
      {showPreloader && <Preloader onComplete={handlePreloaderComplete} />}
      <Helmet>
        <title>North Noir – Complete YouTube Video Generator</title>
        <meta name="description" content="Generate complete YouTube videos — scripts, images, voiceover, and video — from a single prompt. The cheapest all-in-one platform for long-form content creators." />
      </Helmet>

      {/* ═══════════════════ HERO ═══════════════════ */}
      <section className="relative min-h-[100vh] flex items-center justify-center overflow-hidden">
        {/* Atmospheric red glow from top */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(220,38,38,0.14)_0%,transparent_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_40%_40%_at_75%_60%,rgba(220,38,38,0.03)_0%,transparent_60%)]" />

        <div className="relative z-10 max-w-4xl mx-auto px-6 text-center">
          <h1
            className="font-display tracking-tight text-white hero-reveal"
            style={{ animationDelay: '0s' }}
          >
            <span className="block text-[clamp(3rem,8vw,6.5rem)] leading-[0.92] font-light">
              Complete YouTube Videos
            </span>
            <span className="block text-[clamp(3rem,8vw,6.5rem)] leading-[0.92] text-accent font-medium mt-3">
              From a Single Prompt
            </span>
          </h1>

          <p
            className="mt-10 text-lg md:text-xl text-white/40 max-w-2xl mx-auto leading-relaxed font-light hero-reveal"
            style={{ animationDelay: '0.12s' }}
          >
            Script. Voiceover. Images. Video. Everything you need for professional
            long-form content — up to 20 hours — at a fraction of traditional
            production costs.
          </p>

          <div
            className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-5 hero-reveal"
            style={{ animationDelay: '0.25s' }}
          >
            <Link
              to="/home"
              className="group relative px-10 py-4 text-lg font-medium rounded-lg text-white bg-accent transition-all duration-300 hover:bg-accent-hover hover:scale-[1.02] active:scale-[0.98]"
              style={{
                boxShadow:
                  '0 0 40px rgba(220,38,38,0.3), 0 0 80px rgba(220,38,38,0.08)',
              }}
            >
              Start Creating
              <span className="absolute inset-0 rounded-lg bg-red-400 opacity-0 group-hover:opacity-10 transition-opacity duration-300" />
            </Link>
            <Link
              to="/pricing"
              className="px-10 py-4 text-lg font-light text-white/30 hover:text-white/70 transition-colors duration-300"
            >
              View Pricing
            </Link>
          </div>
        </div>
      </section>

      {/* ═══════════════════ PIPELINE FLOW ═══════════════════ */}
      {/* This section holds the full pipeline flow SVG as a background overlay.
          The SVG's origin circle sits at the top, trunk goes down to the heading,
          branches split to 3 pipeline steps, then reconverge to "Complete Video". */}
      <section data-pipeline-section className="relative py-40 overflow-hidden">
        <PipelineCanvas className="absolute inset-0 opacity-50" />
        <div className="absolute inset-0 bg-gradient-to-b from-surface-primary via-transparent to-surface-primary pointer-events-none" />

        {/* Pipeline flow SVG overlay — fills entire section, measures DOM positions */}
        <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 6 }}>
          <PipelineFlowSVG />
        </div>

        <div className="relative z-10 max-w-5xl mx-auto px-6">
          <div data-pipeline-heading ref={pipelineHeadingRef} className="text-center mb-96">
            <h2 className="font-display text-[clamp(2rem,5vw,3.5rem)] text-white tracking-tight font-light">
              One Prompt.{' '}
              <span className="text-accent font-medium">Complete Video.</span>
            </h2>
            <p className="mt-5 text-lg text-white/30 max-w-xl mx-auto font-light">
              Every stage of production, handled automatically.
            </p>

            {/* Origin marker — SVG trunk starts from here */}
            <div data-pipeline-origin className="flex justify-center mt-12">
              <div className="pipeline-icon-circle w-14 h-14 rounded-full bg-accent/5 flex items-center justify-center">
                <img
                  src="https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/logo.png"
                  alt=""
                  className="w-8 h-8"
                />
              </div>
            </div>
          </div>

          <div ref={pipelineStepsRef} className="grid md:grid-cols-3 gap-8 md:gap-10 mb-96">
            {[
              {
                icon: PenSquare,
                label: 'Script & Story',
                detail:
                  'Enter your concept. North Noir generates a detailed script with narrative structure and pacing — from 1,000 to 150,000 words.',
              },
              {
                icon: Mic,
                label: 'Voice & Audio',
                detail:
                  'Your script converts to professional narration with natural pacing, supporting 20+ hours of continuous audio.',
              },
              {
                icon: Video,
                label: 'Images & Video',
                detail:
                  'Matching visuals are generated and assembled into a complete, upload-ready video.',
              },
            ].map((step) => (
              <div key={step.label} data-pipeline-step className="pipeline-step relative z-20 text-center rounded-xl border border-border-card bg-[#0A0A0B] p-8">
                <div data-pipeline-step-icon className="pipeline-icon-circle inline-flex items-center justify-center w-12 h-12 rounded-full bg-accent/5 mb-6">
                  <step.icon className="h-5 w-5 text-accent-text" />
                </div>
                <h3 className="text-lg font-display text-white/90 mb-3 tracking-wide">
                  {step.label}
                </h3>
                <p className="text-sm text-white/40 leading-relaxed font-light">
                  {step.detail}
                </p>
              </div>
            ))}
          </div>

          {/* ─── Complete Video convergence point ─── */}
          <div ref={pipelineConvergeRef} className="relative z-20 flex justify-center">
            <div data-pipeline-converge className="text-center rounded-xl border border-border-card bg-[#0A0A0B] px-12 py-10 max-w-md">
              <div className="pipeline-icon-circle inline-flex items-center justify-center w-14 h-14 rounded-full bg-accent/10 mb-6">
                <Video className="h-6 w-6 text-accent-text" />
              </div>
              <h3 className="font-display text-2xl text-white/90 tracking-wide mb-3">
                Complete Video
              </h3>
              <p className="text-sm text-white/40 leading-relaxed font-light">
                All three stages merge into a single, upload-ready video — assembled automatically.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════ DATA TUNNEL BACKGROUND — spans all sections below pipeline ═══════════════════ */}
      <div className="relative">
        <DataTunnelCanvas className="absolute inset-0 opacity-40 pointer-events-none" />

      {/* ═══════════════════ LIVE STATS BAR ═══════════════════ */}
      <LiveStatsBar />

      </div>{/* end DataTunnel background wrapper */}

      {/* ═══════════════════ VISUAL STYLE GALLERY ═══════════════════ */}
      <VisualStyleGallery />

      {/* ═══════════════════ VOICE SHOWCASE ═══════════════════ */}
      <VoiceShowcase />

      {/* ═══════════════════ BUILT FOR YOUTUBE ═══════════════════ */}
      <BuiltForYouTube />

      {/* ═══════════════════ BEFORE & AFTER ═══════════════════ */}
      <BeforeAfter />

      {/* ═══════════════════ SEE IT IN ACTION ═══════════════════ */}
      <section className="relative py-32 sm:py-40 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_50%_40%,rgba(220,38,38,0.06)_0%,transparent_70%)]" />

        <div className="max-w-5xl mx-auto px-6 relative z-10">
          <div className="text-center mb-14">
            <div className="inline-flex items-center rounded-full bg-accent/10 px-4 py-2 text-[11px] font-mono tracking-[0.2em] text-accent-text/70 border border-accent/20 mb-8">
              SEE IT IN ACTION
            </div>
            <h2 className="font-display text-[clamp(2rem,5vw,3.5rem)] font-light tracking-tight text-white mb-5">
              See How It All Works
            </h2>
            <p className="text-lg text-white/30 leading-relaxed max-w-xl mx-auto font-light">
              A full walkthrough of North Noir and every feature — from story generation to finished video.
            </p>
          </div>

          <div className="rounded-2xl overflow-hidden border border-white/[0.06] bg-[#0A0A0B]">
            <VideoPlayer
              videoUrl="https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20North%20Noir.mp4"
              thumbnailUrl="https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ThumbnailTest.jpg"
              thumbnailAlt="How to use North Noir — full walkthrough"
            />
          </div>

          <div className="flex justify-center mt-10">
            <Link
              to="/help"
              className="group inline-flex items-center gap-2.5 px-7 py-3.5 rounded-lg text-sm font-medium text-white/70 hover:text-white border border-accent/20 hover:border-accent/50 transition-all duration-300 hover:shadow-[0_0_20px_rgba(220,38,38,0.12)] bg-accent/[0.03] hover:bg-accent/[0.08]"
            >
              <Play className="h-4 w-4 text-accent-text" />
              See all tutorials
              <ArrowRight className="h-3.5 w-3.5 opacity-50 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
            </Link>
          </div>
        </div>
      </section>

      {/* ═══════════════════ EXAMPLE CHANNELS ═══════════════════ */}
      <section className="relative py-56 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,rgba(220,38,38,0.05)_0%,transparent_70%)]" />

        <div className="max-w-7xl mx-auto px-6 relative z-10">
          <div ref={channelsHeadingRef} className="text-center mb-24">
            <div className="inline-flex items-center rounded-full bg-accent/10 px-4 py-2 text-[11px] font-mono tracking-[0.2em] text-accent-text/70 border border-accent/20 mb-8">
              REAL CHANNEL EXAMPLES
            </div>
            <h2 className="font-display text-[clamp(2.5rem,6vw,4rem)] font-light tracking-tight text-white mb-6">
              Built for This
            </h2>
            <p className="text-lg text-white/30 leading-relaxed max-w-2xl mx-auto font-light">
              Channels like these earn thousands monthly with long-form content.
              North Noir gives you the tools to produce the same format — from a
              single prompt.
            </p>
          </div>

          <div ref={channelsCardsRef} className="relative h-[580px] md:h-[620px] flex items-center justify-center mb-16">
            {/* Center card */}
            <div className="channel-card absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm md:max-w-md z-30 px-4">
              <ExampleChannelCard
                channel={featuredChannels[0]}
                highlighted={true}
              />
            </div>

            {/* Left card — hidden on small screens */}
            <div className="channel-card hidden md:block absolute left-[10%] top-1/2 -translate-y-1/2 w-full max-w-sm z-20 blur-[2px] scale-90 opacity-60">
              <ExampleChannelCard channel={featuredChannels[1]} />
            </div>

            {/* Right card — hidden on small screens */}
            <div className="channel-card hidden md:block absolute right-[10%] top-1/2 -translate-y-1/2 w-full max-w-sm z-20 blur-[2px] scale-90 opacity-60">
              <ExampleChannelCard channel={featuredChannels[2]} />
            </div>
          </div>

          <div ref={channelsCtaRef} className="flex justify-center">
            <Link
              to="/about#example-usage"
              className="group inline-flex items-center gap-3 px-8 py-4 rounded-lg text-white/60 hover:text-white border border-accent/20 hover:border-accent/50 transition-all duration-300 hover:shadow-[0_0_24px_rgba(220,38,38,0.15)] bg-accent/[0.03] hover:bg-accent/[0.08]"
            >
              See More Examples
              <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1.5 text-accent-text/60 group-hover:text-accent-text" />
            </Link>
          </div>
        </div>
      </section>

      {/* ═══════════════════ TRUST SIGNALS ═══════════════════ */}
      <TrustSignals />

      {/* ═══════════════════ FINAL CTA ═══════════════════ */}
      <section className="relative py-56">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_50%_60%_at_50%_100%,rgba(220,38,38,0.07)_0%,transparent_70%)]" />

        <div ref={ctaSectionRef} className="relative z-10 max-w-2xl mx-auto px-6 text-center">
          <h2 className="font-display text-[clamp(2.5rem,6vw,4rem)] text-white tracking-tight font-light mb-6">
            Ready to Create?
          </h2>
          <p className="text-lg text-white/30 mb-12 font-light">
            Join creators producing professional long-form YouTube videos for a
            fraction of the traditional cost.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-5">
            <Link
              to={user ? '/home' : '/signup'}
              className="px-10 py-4 text-lg font-medium rounded-lg text-white bg-accent transition-all duration-300 hover:bg-accent-hover hover:scale-[1.02] active:scale-[0.98]"
              style={{
                boxShadow:
                  '0 0 40px rgba(220,38,38,0.25), 0 0 80px rgba(220,38,38,0.06)',
              }}
            >
              {user ? 'Go to Dashboard' : 'Get Started Free'}
            </Link>
            <Link
              to="/help"
              className="px-10 py-4 text-lg font-light text-white/25 hover:text-white/60 transition-colors duration-300"
            >
              Watch Tutorials
            </Link>
          </div>
        </div>
      </section>

    </div>
  );
}

export default Landing;



