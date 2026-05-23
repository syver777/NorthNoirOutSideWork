import { useRef, useEffect } from 'react';
import { Shield, Globe, Headphones } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const signals = [
  { icon: Shield, label: '99.9% Uptime' },
  { icon: Globe, label: 'Global CDN Delivery' },
  { icon: Headphones, label: '24/7 Support' },
];

export default function TrustSignals() {
  const stripRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = gsap.context(() => {
      if (stripRef.current) {
        gsap.from(stripRef.current, {
          y: 20,
          opacity: 0,
          duration: 1,
          ease: 'power4.out',
          scrollTrigger: {
            trigger: stripRef.current,
            start: 'top 90%',
            end: 'top 65%',
            scrub: 1,
          },
        });
      }
    });

    return () => ctx.revert();
  }, []);

  return (
    <section ref={stripRef} className="relative py-16 overflow-hidden" aria-label="Trust signals">
      <div className="max-w-5xl mx-auto px-6">
        <div className="flex flex-col sm:flex-row items-center justify-center gap-8 sm:gap-16">
          {signals.map((s, i) => (
            <div key={i} className="flex items-center gap-3">
              <s.icon className="w-4 h-4 text-white/30" aria-hidden="true" />
              <span className="text-sm text-white/30 font-light tracking-wide">{s.label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
