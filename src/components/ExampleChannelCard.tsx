import { useRef, useCallback } from 'react';
import { ExternalLink } from 'lucide-react';
import type { ExampleChannel } from '../data/exampleChannels';

interface ExampleChannelCardProps {
  channel: ExampleChannel;
  variant?: 'default' | 'deck';
  highlighted?: boolean;
}

export default function ExampleChannelCard({ channel, variant = 'default', highlighted = false }: ExampleChannelCardProps) {
  const cardRef = useRef<HTMLAnchorElement>(null);
  const spotlightRef = useRef<HTMLDivElement>(null);

  // Use CSS custom properties instead of React state to avoid re-renders on mousemove
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!cardRef.current || !spotlightRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    spotlightRef.current.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    spotlightRef.current.style.setProperty('--my', `${e.clientY - rect.top}px`);
  }, []);

  return (
    <a
      ref={cardRef}
      href={channel.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${channel.name} — opens in new window`}
      className="group relative block overflow-hidden rounded-2xl transition-shadow duration-300 ease-out shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_2px_20px_rgba(0,0,0,0.4)] hover:shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_8px_40px_rgba(0,0,0,0.5),0_0_80px_rgba(239,68,68,0.15)]"
      onMouseMove={handleMouseMove}
    >
      {/* Spotlight — driven by CSS custom properties, no re-renders */}
      <div
        ref={spotlightRef}
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: 'radial-gradient(300px circle at var(--mx, 50%) var(--my, 50%), rgba(239,68,68,0.15), transparent 80%)',
        }}
      />

        <div className={`relative h-full bg-gradient-to-b ${highlighted ? 'from-black/[0.70] to-black/[0.60]' : 'from-black/[0.60] to-black/[0.50]'}`}>
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

        <div className="aspect-video w-full overflow-hidden">
          <img
            src={channel.thumbnail}
            alt={`${channel.name} channel thumbnail`}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        </div>

        <div className="p-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <h3 className="text-xl font-semibold leading-tight text-white/[0.93] transition-colors duration-200 group-hover:text-white">
              {channel.name}
            </h3>
            <ExternalLink className="h-5 w-5 flex-shrink-0 p-0.5 text-white/40 transition-all duration-200 group-hover:translate-x-1 group-hover:text-accent-text" aria-hidden="true" />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-white/40">Subscribers</span>
              <span className="font-mono text-sm font-medium text-white/[0.93]">{channel.subscribers}</span>
            </div>

            <div className="h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />

            <div className="flex items-center justify-between">
              <span className="text-sm text-white/40">Peak Monthly Views</span>
              <span className="font-mono text-sm font-medium text-white/[0.93]">{channel.mvm}</span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-white/40">Peak Monthly Earnings</span>
              <span className="font-mono text-sm font-medium text-accent-text">{channel.mem}</span>
            </div>

            <div className="mt-4 pt-3 border-t border-white/[0.06]">
              <span className="inline-flex items-center rounded-full bg-accent/10 px-3 py-1 text-xs font-mono tracking-wider text-accent-text border border-accent/30">
                LAST YEAR
              </span>
            </div>
          </div>
        </div>
      </div>
    </a>
  );
}


