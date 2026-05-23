import { useRef, useEffect, useState, useCallback } from 'react';
import { Play, X } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useSafariAutoplay } from '../hooks/useSafariAutoplay';

gsap.registerPlugin(ScrollTrigger);

/* ── Inline autoplay video (one hook instance per card) ── */
function AutoplayVideo({ src, poster, ariaLabel, className }: { src: string; poster?: string; ariaLabel: string; className?: string }) {
  const videoRef = useSafariAutoplay<HTMLVideoElement>();
  return (
    <video
      ref={videoRef}
      className={className}
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      poster={poster}
      aria-label={ariaLabel}
    >
      <source src={src} type="video/mp4" />
    </video>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Visual-style data
   ═══════════════════════════════════════════════════════════════ */

interface StyleInfo {
  name: string;
  tag: string;
  description: string;
  duration: string;
  model: string;
  model2?: string;
  count: number;
  countLabel: string;
  cost: string;
  accentHsl: string;
  videoUrl: string;
  posterUrl: string;
}

const styles: StyleInfo[] = [
  {
    name: 'Image Generation',
    tag: 'IG',
    description: 'AI-generated images with Ken Burns motion — cinematic panning and zooming across each scene.',
    duration: '~1 hour',
    model: 'Prime',
    count: 113,
    countLabel: 'images',
    cost: '$8',
    accentHsl: '346 80% 50%',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Spartan%20War.mp4',
    posterUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Posters/spartan_war_poster.jpg',
  },
  {
    name: 'Text to Video',
    tag: 'TTV',
    description: 'Full AI video generation — every frame rendered from your script with motion and continuity.',
    duration: '~10 min',
    model: 'Grok',
    count: 79,
    countLabel: 'videos',
    cost: '$30',
    accentHsl: '217 90% 55%',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/The%20Honey%20Man.mp4',
    posterUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Posters/the_honey_man_poster.jpg',
  },
  {
    name: 'Image to Video',
    tag: 'ITV',
    description: 'AI images brought to life — each generated scene animated with natural camera movement.',
    duration: '~8 min',
    model: 'Prime',
    model2: 'Wan 2.2',
    count: 92,
    countLabel: 'images & videos',
    cost: '$14',
    accentHsl: '38 92% 50%',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Man%20in%20the%20sky.mp4',
    posterUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Posters/man_in_the_sky_poster.jpg',
  },
  {
    name: 'Motion Graphics',
    tag: 'MG',
    description: 'Code-rendered animated scenes — typography, shapes, and motion programmed by Claude and rendered by Remotion.',
    duration: '~15 min',
    model: 'Claude Opus',
    count: 30,
    countLabel: 'clips',
    cost: '$20',
    accentHsl: '270 80% 60%',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/motion_graphics_example.mp4',
    posterUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Posters/motion_graphics_poster.jpg',
  },
];

/* ═══════════════════════════════════════════════════════════════
   Component
   ═══════════════════════════════════════════════════════════════ */

export default function VisualStyleGallery() {
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalVideoUrl, setModalVideoUrl] = useState('');
  const modalVideoRef = useRef<HTMLVideoElement>(null);

  const openModal = useCallback((url: string) => {
    setModalVideoUrl(url);
    setModalOpen(true);
  }, []);
  const closeModal = useCallback(() => {
    setModalOpen(false);
    if (modalVideoRef.current) {
      modalVideoRef.current.pause();
    }
  }, []);

  /* Close on Escape */
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen, closeModal]);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = gsap.context(() => {
      /* Heading reveal */
      if (headingRef.current) {
        gsap.from(headingRef.current, {
          y: 30,
          opacity: 0,
          duration: 0.8,
          ease: 'power4.out',
          scrollTrigger: {
            trigger: headingRef.current,
            start: 'top 88%',
            toggleActions: 'play none none reverse',
          },
        });
      }

      /* Staggered card reveals */
      if (cardsRef.current) {
        const cards = cardsRef.current.querySelectorAll('.style-card');
        gsap.from(cards, {
          y: 50,
          opacity: 0,
          stagger: 0.15,
          duration: 0.7,
          ease: 'power3.out',
          scrollTrigger: {
            trigger: cardsRef.current,
            start: 'top 82%',
            toggleActions: 'play none none reverse',
          },
        });
      }
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <section
      ref={sectionRef}
      className="relative py-24 md:py-32"
      role="region"
      aria-labelledby="visual-styles-heading"
    >
      {/* Heading */}
      <div ref={headingRef} className="max-w-6xl mx-auto px-6 mb-14">
        <div className="inline-flex items-center rounded-full bg-accent/10 px-4 py-2 text-[11px] font-mono tracking-[0.2em] text-accent-text/70 border border-accent/20 mb-4">
          FOUR VISUAL STYLES
        </div>
        <h2
          id="visual-styles-heading"
          className="font-display text-[clamp(2rem,5vw,3.5rem)] text-white tracking-tight font-light max-w-2xl"
        >
          Choose Your{' '}
          <span className="text-accent font-medium">Look</span>
        </h2>
      </div>

      {/* Cards grid */}
      <div
        ref={cardsRef}
        className="max-w-6xl mx-auto px-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5"
        role="list"
      >
        {styles.map((style) => (
          <article
            key={style.tag}
            className="style-card group relative rounded-xl border overflow-hidden transition-colors duration-300"
            style={{
              borderColor: `hsla(${style.accentHsl} / 0.12)`,
              backgroundColor: `hsla(${style.accentHsl} / 0.02)`,
            }}
            role="listitem"
          >
            {/* Hover glow */}
            <div
              className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
              style={{
                background: `radial-gradient(ellipse 80% 60% at 50% 0%, hsla(${style.accentHsl} / 0.08) 0%, transparent 70%)`,
              }}
            />

            <div className="relative z-10 p-6 md:p-7 flex flex-col h-full">
              {/* Tag + Name */}
              <div className="flex items-center gap-2.5 mb-4">
                <span
                  className="px-2 py-0.5 rounded text-[10px] font-mono tracking-[0.15em] border"
                  style={{
                    borderColor: `hsla(${style.accentHsl} / 0.35)`,
                    backgroundColor: `hsla(${style.accentHsl} / 0.1)`,
                    color: `hsla(${style.accentHsl} / 0.9)`,
                  }}
                >
                  {style.tag}
                </span>
                <h3 className="font-display text-lg text-white/90 tracking-wide">
                  {style.name}
                </h3>
              </div>

              {/* Description */}
              <p className="text-sm text-white/45 leading-relaxed mb-5 font-body">
                {style.description}
              </p>

              {/* Video preview */}
              <div
                className="relative rounded-lg overflow-hidden mb-6 border"
                style={{ borderColor: `hsla(${style.accentHsl} / 0.15)` }}
              >
                <AutoplayVideo
                  src={style.videoUrl}
                  poster={style.posterUrl}
                  ariaLabel={`Example video for ${style.name} style`}
                  className="w-full aspect-[16/10] object-cover"
                />
                <div
                  className="absolute inset-0 pointer-events-none ring-1 ring-inset rounded-lg"
                  style={{ boxShadow: `inset 0 0 20px 2px hsla(${style.accentHsl} / 0.08)` }}
                />
                {/* See Video button */}
                <button
                  onClick={() => openModal(style.videoUrl)}
                  className="absolute bottom-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-mono tracking-wide text-white/80 bg-black/60 backdrop-blur-sm border border-white/10 hover:bg-black/80 hover:text-white transition-all duration-200 cursor-pointer"
                  aria-label={`Watch full ${style.name} video`}
                >
                  <Play className="w-3 h-3" />
                  See Video
                </button>
              </div>

              {/* Stats grid: 2×2 */}
              <div
                className="grid grid-cols-2 gap-x-4 gap-y-5 pt-5 border-t"
                style={{ borderColor: `hsla(${style.accentHsl} / 0.1)` }}
              >
                {/* Model */}
                <div className="flex flex-col">
                  <span className="text-[9px] font-mono tracking-[0.15em] text-white/25 uppercase mb-1.5">
                    Model
                  </span>
                  <span className="text-base font-display text-white/80 tracking-wide">
                    {style.model}
                    {style.model2 && (
                      <span className="text-white/35 text-xs ml-1">+ {style.model2}</span>
                    )}
                  </span>
                </div>

                {/* Assets */}
                <div className="flex flex-col">
                  <span className="text-[9px] font-mono tracking-[0.15em] text-white/25 uppercase mb-1.5">
                    Assets
                  </span>
                  <span className="text-base font-mono text-white/60">
                    {style.count} <span className="text-[10px] font-mono text-white/25">{style.countLabel}</span>
                  </span>
                </div>

                {/* Cost */}
                <div className="flex flex-col">
                  <span className="text-[9px] font-mono tracking-[0.15em] text-white/25 uppercase mb-1.5">
                    Cost
                  </span>
                  <span
                    className="text-xl font-display tracking-wide"
                    style={{ color: `hsla(${style.accentHsl} / 0.9)` }}
                  >
                    {style.cost}
                  </span>
                </div>

                {/* Length */}
                <div className="flex flex-col">
                  <span className="text-[9px] font-mono tracking-[0.15em] text-white/25 uppercase mb-1.5">
                    Length
                  </span>
                  <span className="text-base font-mono text-white/55 tracking-wide">
                    {style.duration}
                  </span>
                </div>
              </div>
            </div>
          </article>
        ))}
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
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/85 backdrop-blur-sm" />

          {/* Content */}
          <div
            className="relative z-10 w-full max-w-4xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              onClick={closeModal}
              className="absolute -top-12 right-0 flex items-center gap-2 text-sm text-white/50 hover:text-white transition-colors cursor-pointer"
              aria-label="Close video"
            >
              <span className="text-xs font-mono tracking-wide">ESC</span>
              <X className="w-5 h-5" />
            </button>

            {/* Video with native controls */}
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
                <source src={modalVideoUrl} type="video/mp4" />
              </video>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
