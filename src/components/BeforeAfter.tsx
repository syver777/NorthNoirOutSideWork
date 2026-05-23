import { useRef, useEffect, useState, useCallback } from 'react';
import { FileText, Play, X } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useSafariAutoplay } from '../hooks/useSafariAutoplay';

gsap.registerPlugin(ScrollTrigger);

function BeforeAfterVideo() {
  const videoRef = useSafariAutoplay<HTMLVideoElement>();
  return (
    <video
      ref={videoRef}
      className="w-full h-full object-cover"
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      poster="https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Posters/harbinger_poster.jpg"
      aria-label="Harbinger of the End: The Black Death Arrives in Europe — generated video"
    >
      <source src="https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Harbinger%20of%20the%20End_%20The%20Black%20Death%20Arrives%20in%20Europe.mp4" type="video/mp4" />
    </video>
  );
}

const sampleScript = `The year is 1347. A Genoese trading ship drifts into the harbor of Messina, Sicily. No one comes to greet it. The sails hang limp. The crew — what's left of them — lie scattered across the deck, their skin marked with dark, swollen boils that weep blood and pus.

The harbormaster watches from the dock. He doesn't know it yet, but he is looking at the end of the world as he knows it.

Within weeks, the pestilence will spread through the city like fire through dry wheat. Within months, it will cross the Alps. Within years, it will kill one in every three people in Europe.

This is the story of the Black Death — the most devastating pandemic in human history.`;

// Video freezes at 4s out of ~7.7s total
const VIDEO_FREEZE_TIME = 4;

/* ── Measured paths for the overlay SVG ── */
interface FlowLayout {
  vb: string;
  line1: string;
  line2: string;
}

export default function BeforeAfter() {
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const scriptPanelRef = useRef<HTMLDivElement>(null);
  const videoPanelRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const bookContainerRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tlRef = useRef<gsap.core.Timeline | null>(null);
  const [layout, setLayout] = useState<FlowLayout | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const modalVideoRef = useRef<HTMLVideoElement>(null);
  // When the browser plays the WebM (no alpha), use screen blend to hide black bg.
  // When it plays HEVC alpha (Safari), no blend needed — alpha is real.
  const [useBlend, setUseBlend] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const checkSource = () => {
      const src = video.currentSrc || '';
      if (src.endsWith('.webm')) setUseBlend(true);
    };
    video.addEventListener('loadeddata', checkSource, { once: true });
    return () => video.removeEventListener('loadeddata', checkSource);
  }, []);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    if (modalVideoRef.current) modalVideoRef.current.pause();
  }, []);

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen, closeModal]);

  // ── Measure DOM positions, compute SVG paths ──
  const measure = useCallback(() => {
    const flow = flowRef.current;
    const svg = svgRef.current;
    if (!flow || !svg) return;

    const fr = flow.getBoundingClientRect();
    const w = fr.width;
    const h = fr.height;

    const toLocal = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        cx: r.left + r.width / 2 - fr.left,
        top: r.top - fr.top,
        bottom: r.bottom - fr.top,
      };
    };

    const script = scriptPanelRef.current;
    const book = bookContainerRef.current;
    const video = videoPanelRef.current;
    if (!script || !book || !video) return;

    const s = toLocal(script);
    const b = toLocal(book);
    const v = toLocal(video);
    const cx = w / 2;

    // Line 1: script bottom → book top (gentle S-curve)
    const y1s = s.bottom;
    const y1e = b.top;
    const line1 = `M ${cx} ${y1s} C ${cx - 4} ${y1s + (y1e - y1s) * 0.4}, ${cx + 4} ${y1e - (y1e - y1s) * 0.3}, ${cx} ${y1e}`;

    // Line 2: book bottom → video top (gentle S-curve)
    const y2s = b.bottom;
    const y2e = v.top;
    const line2 = `M ${cx} ${y2s} C ${cx + 4} ${y2s + (y2e - y2s) * 0.4}, ${cx - 4} ${y2e - (y2e - y2s) * 0.3}, ${cx} ${y2e}`;

    setLayout({ vb: `0 0 ${w} ${h}`, line1, line2 });
  }, []);

  // ── Measure on mount + resize ──
  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(measure));
    const ro = new ResizeObserver(() => requestAnimationFrame(measure));
    if (flowRef.current) ro.observe(flowRef.current);
    return () => ro.disconnect();
  }, [measure]);

  // ── GSAP sequential scroll-driven timeline ──
  useEffect(() => {
    if (!layout || !svgRef.current) return;
    const video = videoRef.current;
    const svg = svgRef.current;
    const section = sectionRef.current;
    if (!section || !video) return;

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Set dash offsets on all animated paths
    const animated = svg.querySelectorAll<SVGPathElement>('path[data-path]');
    animated.forEach((p) => {
      const len = p.getTotalLength();
      gsap.set(p, { strokeDasharray: len, strokeDashoffset: len });
    });

    if (prefersReduced) {
      animated.forEach((p) => gsap.set(p, { strokeDashoffset: 0 }));
      return;
    }

    if (video) video.pause();

    // Kill previous timeline
    tlRef.current?.kill();
    ScrollTrigger.getAll().forEach((st) => {
      if ((st.vars as { id?: string }).id === 'ba-flow') st.kill();
    });

    const ctx = gsap.context(() => {
      // ── Heading + script entrances (independent) ──
      if (headingRef.current) {
        gsap.from(headingRef.current, {
          y: 35, opacity: 0, ease: 'power4.out',
          scrollTrigger: { trigger: headingRef.current, start: 'top 85%', end: 'top 60%', scrub: 1 },
        });
      }
      if (scriptPanelRef.current) {
        gsap.from(scriptPanelRef.current, {
          y: 40, opacity: 0, ease: 'power4.out',
          scrollTrigger: { trigger: scriptPanelRef.current, start: 'top 85%', end: 'top 60%', scrub: 1 },
        });
      }

      // ── Main sequential timeline ──
      const tl = gsap.timeline({
        scrollTrigger: {
          id: 'ba-flow',
          trigger: flowRef.current,
          start: 'top 65%',
          end: 'bottom 15%',
          scrub: 1.5,
        },
      });
      tlRef.current = tl;

      // Phase 1 (0 → 0.20): Line 1 draws from Script → Book
      tl.to(svg.querySelectorAll('[data-path="line1"]'), {
        strokeDashoffset: 0, ease: 'none', duration: 0.20,
      }, 0);

      // Phase 2 (0.12 → 0.29): Book video plays shortly after Line 1 starts
      tl.to({}, {
        duration: 0.17,
        onUpdate: function () {
          const p = this.progress();
          if (video && video.readyState >= 2) {
            video.currentTime = p * VIDEO_FREEZE_TIME;
          }
          if (bookContainerRef.current) {
            const glowOpacity = 0.15 + p * 0.45;
            bookContainerRef.current.style.filter =
              `drop-shadow(0 0 ${8 + p * 20}px rgba(220, 38, 38, ${glowOpacity}))`;
          }
        },
      }, 0.12);

      // Phase 3 (0.15 → 0.55): Line 2 draws from Book → Video (starts earlier)
      tl.to(svg.querySelectorAll('[data-path="line2"]'), {
        strokeDashoffset: 0, ease: 'none', duration: 0.40,
      }, 0.15);

      // Phase 4 (0.45 → 0.65): Video panel fades in
      if (videoPanelRef.current) {
        gsap.set(videoPanelRef.current, { y: 25, opacity: 0 });
        tl.to(videoPanelRef.current, {
          y: 0, opacity: 1, ease: 'power4.out', duration: 0.20,
        }, 0.45);
      }

      // Phase 5: Info text beside line 2 — first left, then right
      const infoEls = section.querySelectorAll<HTMLElement>('.ba-info-text');
      infoEls.forEach((el, i) => {
        gsap.set(el, { y: 20, opacity: 0 });
        tl.to(el, {
          y: 0, opacity: 1, ease: 'power4.out', duration: 0.15,
        }, 0.22 + i * 0.14);
      });
    }, section);

    return () => { ctx.revert(); tlRef.current?.kill(); };
  }, [layout]);

  /* ── Render a path set: ghost + glow + main (PipelineFlowSVG pattern) ── */
  const renderPathSet = (d: string, name: string) => (
    <>
      <path d={d} fill="none" stroke="rgba(220,38,38,0.03)" strokeWidth="3" strokeLinecap="round" />
      <path data-path={name} d={d} fill="none" stroke="rgba(220,38,38,0.12)" strokeWidth="8" filter="url(#ba-glow)" strokeLinecap="round" />
      <path data-path={name} d={d} fill="none" stroke="rgba(220,38,38,0.45)" strokeWidth="2" strokeLinecap="round" />
    </>
  );

  return (
    <section ref={sectionRef} className="relative py-32 md:py-40 overflow-visible" aria-label="Before and after comparison">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_50%_60%_at_50%_40%,rgba(220,38,38,0.03)_0%,transparent_70%)]" />

      <div className="relative z-10 max-w-6xl mx-auto px-6">
        {/* Heading */}
        <div ref={headingRef} className="text-center mb-16 md:mb-24">
          <h2 className="font-display text-[clamp(2rem,5vw,3.5rem)] text-white tracking-tight font-light">
            One Prompt to{' '}
            <span className="text-accent font-medium">Full Video</span>
          </h2>
          <p className="mt-5 text-lg text-white/30 max-w-xl mx-auto font-light">
            A single idea becomes a complete, long-form video — automatically.
          </p>
        </div>

        {/* Stacked flow with overlay SVG */}
        <div ref={flowRef} className="relative flex flex-col items-center max-w-2xl mx-auto">

          {/* ── Overlay SVG (measures DOM, draws connecting lines) ── */}
          <svg
            ref={svgRef}
            className="absolute inset-0 pointer-events-none z-10"
            viewBox={layout?.vb ?? '0 0 100 100'}
            preserveAspectRatio="none"
            style={{ width: '100%', height: '100%' }}
            aria-hidden="true"
          >
            <defs>
              <filter id="ba-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {layout && (
              <>
                {renderPathSet(layout.line1, 'line1')}
                {renderPathSet(layout.line2, 'line2')}
              </>
            )}
          </svg>

          {/* ─── Script panel ─── */}
          <div ref={scriptPanelRef} className="relative w-full z-20">
            <div className="absolute -top-6 left-0 text-[10px] font-mono tracking-[0.15em] text-white/20 uppercase">
              Script Input
            </div>
            <div className="relative rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
              <div className="flex items-center gap-3 px-6 py-4 border-b border-white/[0.06]">
                <FileText className="w-4 h-4 text-accent-text/60" />
                <span className="text-xs font-mono tracking-[0.15em] text-white/40 uppercase">Your Prompt</span>
              </div>
              <div className="relative p-6 md:p-8 min-h-[240px]">
                {/* Line number gutter */}
                <div className="absolute left-3 top-6 md:top-8 flex flex-col gap-[1.35rem] text-[10px] font-mono text-white/[0.08] select-none" aria-hidden="true">
                  {Array.from({ length: 12 }, (_, i) => (
                    <span key={i}>{String(i + 1).padStart(2, '0')}</span>
                  ))}
                </div>
                <div className="pl-7 md:pl-9">
                  <p className="text-[15px] md:text-base text-white/35 leading-[1.85] font-body font-light">
                    {sampleScript}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* ─── Spacer for Line 1 ─── */}
          <div className="h-24 md:h-32" />

          {/* ─── Book animation — scroll-driven video ─── */}
          <div
            ref={bookContainerRef}
            className="relative z-20 flex-shrink-0 w-[180px] h-[180px] md:w-[200px] md:h-[200px]"
            style={useBlend ? { mixBlendMode: 'screen' } : undefined}
          >
            <video
              ref={videoRef}
              className="w-full h-full object-contain"
              muted
              playsInline
              preload="auto"
              aria-label="Animated book representing the transformation process"
            >
              <source src="/bok_reading_red_200_alpha_hevc.mp4" type='video/mp4; codecs="hvc1"' />
              <source src="/bok_reading_red_200_alpha.webm" type="video/webm" />
            </video>
          </div>

          {/* ─── Line 2 area with info text (left then right) ─── */}
          <div className="relative w-full h-[420px] md:h-[560px]">
            {/* First text — left side, upper third */}
            <div className="absolute left-0 top-[28%] -translate-y-1/2 w-[calc(50%-40px)] ba-info-text">
              <p className="text-sm md:text-base text-white/40 font-light leading-relaxed text-right">
                Start generating and leave the page — your video renders in the background. Come back when it's done.
              </p>
            </div>
            {/* Second text — right side, lower third */}
            <div className="absolute right-0 top-[68%] -translate-y-1/2 w-[calc(50%-40px)] ba-info-text">
              <p className="text-sm md:text-base text-white/40 font-light leading-relaxed">
                Generate up to <span className="text-accent-text/70 font-medium">10 videos at a time</span> with the Elite plan or higher.
              </p>
            </div>
          </div>

          {/* ─── Video output panel ─── */}
          <div ref={videoPanelRef} className="relative w-full max-w-lg">
            <div className="absolute -top-6 left-0 text-[10px] font-mono tracking-[0.15em] text-white/20 uppercase">
              Video Output
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
              <div className="flex items-center gap-3 px-6 py-4 border-b border-white/[0.06]">
                <Play className="w-4 h-4 text-accent-text/60" aria-hidden="true" />
                <span className="text-xs font-mono tracking-[0.15em] text-white/40 uppercase">Complete Video</span>
              </div>
              <div className="aspect-video relative bg-surface-secondary overflow-hidden">
                <BeforeAfterVideo />
                <button
                  onClick={() => setModalOpen(true)}
                  className="absolute bottom-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-mono tracking-wide text-white/80 bg-black/60 backdrop-blur-sm border border-white/10 hover:bg-black/80 hover:text-white transition-all duration-200 cursor-pointer"
                  aria-label="Watch full video"
                >
                  <Play className="w-3 h-3" />
                  See Video
                </button>
              </div>
              <div className="px-6 py-4">
                <p className="text-sm font-display text-white/60 tracking-wide">
                  Harbinger of the End: The Black Death Arrives in Europe
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Video modal ── */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4 md:p-8"
          onClick={closeModal}
          role="dialog"
          aria-modal="true"
          aria-label="Video preview"
        >
          <div className="absolute inset-0 bg-black/85 backdrop-blur-sm" />
          <div
            className="relative z-10 w-full max-w-4xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={closeModal}
              className="absolute -top-12 right-0 flex items-center gap-2 text-sm text-white/50 hover:text-white transition-colors cursor-pointer"
              aria-label="Close video"
            >
              <span className="text-xs font-mono tracking-wide">ESC</span>
              <X className="w-5 h-5" />
            </button>
            <div className="rounded-xl overflow-hidden border border-white/10 bg-black">
              <video
                ref={modalVideoRef}
                className="w-full aspect-video"
                controls
                autoPlay
                playsInline
                preload="auto"
                aria-label="Full video preview with controls"
              >
                <source src="https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Harbinger%20of%20the%20End_%20The%20Black%20Death%20Arrives%20in%20Europe.mp4" type="video/mp4" />
              </video>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
