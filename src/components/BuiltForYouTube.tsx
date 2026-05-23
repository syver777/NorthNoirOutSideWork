import { useRef, useEffect } from 'react';
import { Clock, Bookmark, MousePointerClick, Upload, DollarSign, Layers } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const features = [
  {
    icon: Clock,
    title: 'Up to 20 Hours',
    detail: 'Generate videos of any length — from short explainers to marathon narrations that keep viewers watching.',
  },
  {
    icon: Bookmark,
    title: 'Auto Chapters',
    detail: 'Timestamps generated from your script structure. Viewers can jump straight to what interests them.',
  },
  {
    icon: MousePointerClick,
    title: 'One Prompt, Done',
    detail: 'Describe your video idea. North Noir handles the script, visuals, voiceover, and editing — no manual steps.',
  },
  {
    icon: Upload,
    title: 'Upload-Ready Format',
    detail: 'Every video exports in YouTube-native format. Download, upload, publish — no conversion needed.',
  },
  {
    icon: DollarSign,
    title: 'Fraction of the Cost',
    detail: 'Full-length videos from $8. No subscriptions to multiple AI tools — one platform covers everything.',
  },
  {
    icon: Layers,
    title: 'Complete Package',
    detail: 'Script, voiceover, images, video, chapters, titles, thumbnails — everything from one prompt.',
  },
];

export default function BuiltForYouTube() {
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = gsap.context(() => {
      if (headingRef.current) {
        gsap.from(headingRef.current, {
          y: 35,
          opacity: 0,
          duration: 1,
          ease: 'power4.out',
          scrollTrigger: {
            trigger: headingRef.current,
            start: 'top 85%',
            end: 'top 55%',
            scrub: 1,
          },
        });
      }

      if (gridRef.current) {
        const items = gridRef.current.querySelectorAll('.yt-feature');
        gsap.from(items, {
          y: 40,
          opacity: 0,
          duration: 1,
          stagger: 0.08,
          ease: 'power4.out',
          scrollTrigger: {
            trigger: gridRef.current,
            start: 'top 80%',
            end: 'top 40%',
            scrub: 1,
          },
        });
      }
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <section ref={sectionRef} className="relative py-40 overflow-hidden" aria-label="YouTube features">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_70%_30%,rgba(220,38,38,0.03)_0%,transparent_70%)]" />

      <div className="relative z-10 max-w-6xl mx-auto px-6">
        <div ref={headingRef} className="max-w-2xl mb-20">
          <div className="inline-flex items-center rounded-full bg-accent/10 px-4 py-2 text-[11px] font-mono tracking-[0.2em] text-accent-text/70 border border-accent/20 mb-8">
            YOUTUBE-OPTIMIZED
          </div>
          <h2 className="font-display text-[clamp(2rem,5vw,3.5rem)] text-white tracking-tight font-light">
            The Cheapest Way to Create{' '}
            <span className="text-accent font-medium">Long-Form AI Videos</span>
          </h2>
          <p className="mt-5 text-lg text-white/30 font-light">
            Full-length YouTube videos for a fraction of what other AI platforms charge.
            Scripts, voiceover, images, and video — all from one prompt, starting at $8.
          </p>
        </div>

        {/* Asymmetric feature grid — 2 cols on desktop, staggered alignment */}
        <div ref={gridRef} className="grid md:grid-cols-2 gap-x-10 gap-y-14">
          {features.map((f, i) => (
            <div
              key={f.title}
              className={`yt-feature flex gap-5 ${i % 2 === 1 ? 'md:translate-y-8' : ''}`}
            >
              <div className="flex-shrink-0 mt-1">
                <div className="w-10 h-10 rounded-lg bg-accent/[0.06] border border-accent/10 flex items-center justify-center">
                  <f.icon className="w-4.5 h-4.5 text-accent-text/70" />
                </div>
              </div>
              <div>
                <h3 className="font-display text-lg text-white/85 tracking-wide mb-2">
                  {f.title}
                </h3>
                <p className="text-sm text-white/30 leading-relaxed font-light">
                  {f.detail}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
