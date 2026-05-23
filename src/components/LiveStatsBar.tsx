import { useEffect, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

const CACHE_KEY = 'nn_stats_cache';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface CachedStats {
  count: number;
  ts: number;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export default function LiveStatsBar() {
  const [userCount, setUserCount] = useState<number | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const creatorsNumRef = useRef<HTMLSpanElement>(null);
  const videosNumRef = useRef<HTMLSpanElement>(null);
  const hasAnimated = useRef(false);

  // Fetch user count with caching
  useEffect(() => {
    async function fetchCount() {
      // Check cache
      try {
        const raw = sessionStorage.getItem(CACHE_KEY);
        if (raw) {
          const cached: CachedStats = JSON.parse(raw);
          if (Date.now() - cached.ts < CACHE_TTL) {
            setUserCount(cached.count);
            return;
          }
        }
      } catch { /* ignore parse errors */ }

      const { count, error } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true });

      if (!error && count !== null) {
        setUserCount(count);
        try {
          sessionStorage.setItem(CACHE_KEY, JSON.stringify({ count, ts: Date.now() }));
        } catch { /* quota exceeded — ignore */ }
      }
    }

    fetchCount();
  }, []);

  // GSAP counting animation on scroll-into-view
  useEffect(() => {
    if (userCount === null || hasAnimated.current) return;
    const section = sectionRef.current;
    if (!section) return;

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReduced) {
      if (creatorsNumRef.current) creatorsNumRef.current.textContent = formatNumber(userCount);
      if (videosNumRef.current) videosNumRef.current.textContent = formatNumber(userCount * 12);
      hasAnimated.current = true;
      return;
    }

    const st = ScrollTrigger.create({
      trigger: section,
      start: 'top 85%',
      once: true,
      onEnter: () => {
        hasAnimated.current = true;
        const obj = { creators: 0, videos: 0 };
        gsap.to(obj, {
          creators: userCount,
          videos: userCount * 12,
          duration: 2.2,
          ease: 'power2.out',
          onUpdate: () => {
            if (creatorsNumRef.current) creatorsNumRef.current.textContent = formatNumber(Math.round(obj.creators));
            if (videosNumRef.current) videosNumRef.current.textContent = formatNumber(Math.round(obj.videos));
          },
        });
      },
    });

    return () => st.kill();
  }, [userCount]);

  if (userCount === null) return null;

  return (
    <section ref={sectionRef} className="relative py-16 overflow-hidden" aria-label="Platform statistics">
      {/* Subtle red glow behind the stats */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_40%_at_50%_50%,rgba(220,38,38,0.04)_0%,transparent_70%)]" />

      <div className="relative z-10 max-w-4xl mx-auto px-6">
        <div className="flex flex-col sm:flex-row items-center justify-center gap-12 sm:gap-20">
          {/* Creators count */}
          <div className="text-center">
            <span
              ref={creatorsNumRef}
              className="block font-display text-[clamp(2.5rem,5vw,4rem)] text-accent font-medium tracking-tight leading-none"
              aria-live="polite"
              aria-atomic="true"
            >
              0
            </span>
            <span className="mt-3 block text-sm tracking-[0.15em] uppercase text-white/30 font-light">
              Creators already using North Noir
            </span>
          </div>

          {/* Divider */}
          <div className="hidden sm:block w-px h-16 bg-gradient-to-b from-transparent via-white/[0.08] to-transparent" />

          {/* Videos count */}
          <div className="text-center">
            <span
              ref={videosNumRef}
              className="block font-display text-[clamp(2.5rem,5vw,4rem)] text-white/90 font-light tracking-tight leading-none"
              aria-live="polite"
              aria-atomic="true"
            >
              0
            </span>
            <span className="mt-3 block text-sm tracking-[0.15em] uppercase text-white/30 font-light">
              Videos created
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
