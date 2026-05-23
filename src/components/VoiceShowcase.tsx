import { useRef, useEffect, useState } from 'react';
import { Play, Pause, Volume2 } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

/* ═══════════════════════════════════════════════════════════════
   Sample script text for the typewriter effect
   ═══════════════════════════════════════════════════════════════ */

const SCRIPT_TEXT = `In the winter of 1962, a Soviet submarine captain faced an impossible choice. Three hundred meters beneath the Caribbean Sea, cut off from Moscow, he held the launch key to a nuclear torpedo. The American destroyers above were dropping depth charges. His crew was suffocating in the heat. And the order had been clear: if attacked, retaliate.`;

/* ═══════════════════════════════════════════════════════════════
   Stats data
   ═══════════════════════════════════════════════════════════════ */

const stats = [
  { value: '100+',   label: 'voices' },
  { value: 'From $4',     label: 'per 1M chars · Core model' },
  { value: '99%',    label: 'cheaper than ElevenLabs' },
];

const AUDIO_SRC = 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Declan_example.mp3';

/* ═══════════════════════════════════════════════════════════════
   Component
   ═══════════════════════════════════════════════════════════════ */

export default function VoiceShowcase() {
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const promptBoxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const connectorRef = useRef<SVGSVGElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);
  const autoRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [playProgress, setPlayProgress] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);

  /* ── Update progress via rAF for smooth tracking ── */
  const updateProgress = () => {
    const audio = audioRef.current;
    if (audio && audio.duration && !audio.paused) {
      setPlayProgress(audio.currentTime / audio.duration);
      rafRef.current = requestAnimationFrame(updateProgress);
    }
  };

  /* ── Initialise audio element once ── */
  useEffect(() => {
    const audio = new Audio(AUDIO_SRC);
    audio.preload = 'metadata';
    audioRef.current = audio;

    const onLoaded = () => setAudioDuration(audio.duration);
    const onEnded = () => {
      setIsPlaying(false);
      setPlayProgress(0);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };

    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('ended', onEnded);
      audio.pause();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      audioRef.current = null;
    };
  }, []);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      setIsPlaying(false);
    } else {
      audio.play();
      setIsPlaying(true);
      rafRef.current = requestAnimationFrame(updateProgress);
    }
  }

  /* ── GSAP animations ── */
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = gsap.context(() => {

      /* Heading reveal */
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

      /* ── Typewriter effect on the prompt box ── */
      if (textRef.current && promptBoxRef.current) {
        const words = SCRIPT_TEXT.split(' ');
        const wordSpans: HTMLSpanElement[] = [];

        // Build word spans
        textRef.current.innerHTML = '';
        words.forEach((word, i) => {
          const span = document.createElement('span');
          span.textContent = (i > 0 ? ' ' : '') + word;
          span.style.opacity = '0';
          textRef.current!.appendChild(span);
          wordSpans.push(span);
        });

        // Scroll-driven reveal: words appear as you scroll
        const tl = gsap.timeline({
          scrollTrigger: {
            trigger: promptBoxRef.current,
            start: 'top 85%',
            end: 'bottom 20%',
            scrub: 0.8,
          },
        });

        wordSpans.forEach((span, i) => {
          tl.to(span, {
            opacity: 1,
            duration: 0.02,
            ease: 'none',
          }, i * 0.025);
        });

        // Blinking cursor
        if (cursorRef.current) {
          gsap.to(cursorRef.current, {
            opacity: 0,
            duration: 0.5,
            repeat: -1,
            yoyo: true,
            ease: 'steps(1)',
          });
        }
      }

      /* ── Connector SVG draw-on ── */
      if (connectorRef.current) {
        const pathEl = connectorRef.current.querySelector('.connector-path') as SVGPathElement | null;
        if (pathEl) {
          const length = pathEl.getTotalLength();
          gsap.set(pathEl, { strokeDasharray: length, strokeDashoffset: length });
          gsap.to(pathEl, {
            strokeDashoffset: 0,
            ease: 'none',
            scrollTrigger: {
              trigger: connectorRef.current,
              start: 'top 65%',
              end: 'top 30%',
              scrub: 0.8,
            },
          });
        }

        // Glowing dot along the path
        const dot = connectorRef.current.querySelector('.connector-dot') as SVGCircleElement | null;
        if (dot) {
          gsap.from(dot, {
            opacity: 0,
            scrollTrigger: {
              trigger: connectorRef.current,
              start: 'top 60%',
              end: 'top 40%',
              scrub: 1,
            },
          });
        }
      }

      /* ── Player fade-in ── */
      if (playerRef.current) {
        gsap.from(playerRef.current, {
          y: 30,
          opacity: 0,
          duration: 1,
          ease: 'power4.out',
          scrollTrigger: {
            trigger: playerRef.current,
            start: 'top 80%',
            end: 'top 55%',
            scrub: 1,
          },
        });
      }

      /* ── Stats staggered reveal ── */
      if (statsRef.current) {
        const items = statsRef.current.querySelectorAll('.stat-item');
        gsap.from(items, {
          y: 25,
          opacity: 0,
          stagger: 0.1,
          duration: 0.8,
          ease: 'power4.out',
          scrollTrigger: {
            trigger: statsRef.current,
            start: 'top 82%',
            end: 'top 55%',
            scrub: 1,
          },
        });
      }

      /* ── Auto-pauses feature callout ── */
      if (autoRef.current) {
        gsap.from(autoRef.current, {
          y: 20,
          opacity: 0,
          duration: 1,
          ease: 'power4.out',
          scrollTrigger: {
            trigger: autoRef.current,
            start: 'top 85%',
            end: 'top 60%',
            scrub: 1,
          },
        });
      }

    }, sectionRef);

    return () => ctx.revert();
  }, []);

  /* ── Format time display ── */
  const totalDuration = Math.round(audioDuration) || 47;
  const currentSec = Math.floor(playProgress * totalDuration);
  const formatTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <section
      ref={sectionRef}
      className="relative py-40 overflow-hidden"
      aria-label="Text-to-speech voice showcase"
    >
      {/* Atmospheric glow */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_50%_60%_at_30%_40%,rgba(220,38,38,0.04)_0%,transparent_70%)]" />

      <div className="relative z-10 max-w-6xl mx-auto px-6">

        {/* ── Heading ── */}
        <div ref={headingRef} className="max-w-2xl mb-24">
          <div className="inline-flex items-center rounded-full bg-accent/10 px-4 py-2 text-[11px] font-mono tracking-[0.2em] text-accent-text/70 border border-accent/20 mb-8">
            VOICE ENGINE
          </div>
          <h2 className="font-display text-[clamp(2rem,5vw,3.5rem)] text-white tracking-tight font-light">
            Text-To-
            <span className="text-accent font-medium">Speech</span>
          </h2>
          <p className="mt-5 text-lg text-white/30 font-light">
            Upload a text file or use one you've written in North Noir and turn it into
            professional narration — over 100 voices, natural pacing, and intelligent
            auto-pauses, up to 20 hours of audio at a fraction of what you'd pay anywhere else.
          </p>
        </div>

        {/* ── Main showcase: stacked prompt → connector → player ── */}
        <div className="flex flex-col items-center gap-0 mb-28 max-w-2xl mx-auto">

          {/* ─── Prompt box (top) ─── */}
          <div ref={promptBoxRef} className="relative w-full">
            <div className="absolute -top-6 left-0 text-[10px] font-mono tracking-[0.15em] text-white/20 uppercase">
              Script Input
            </div>
            <div className="relative rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 md:p-8 min-h-[260px]">
              {/* Faint line number gutter */}
              <div className="absolute left-3 top-6 md:top-8 flex flex-col gap-[1.35rem] text-[10px] font-mono text-white/[0.08] select-none" aria-hidden="true">
                {Array.from({ length: 8 }, (_, i) => (
                  <span key={i}>{String(i + 1).padStart(2, '0')}</span>
                ))}
              </div>

              <div className="pl-7 md:pl-9">
                <span
                  ref={textRef}
                  className="text-[15px] md:text-base leading-[1.85] text-white/70 font-light"
                  style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}
                />
                <span
                  ref={cursorRef}
                  className="inline-block w-[2px] h-[1.1em] bg-accent/80 align-middle ml-[2px]"
                  aria-hidden="true"
                />
              </div>
            </div>
          </div>

          {/* ─── Connector SVG (vertical, between boxes) ─── */}
          <div className="flex items-center justify-center py-2">
            <svg
              ref={connectorRef}
              viewBox="0 0 40 100"
              className="w-10 h-[100px]"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="connGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgba(220,38,38,0.6)" />
                  <stop offset="50%" stopColor="rgba(220,38,38,0.25)" />
                  <stop offset="100%" stopColor="rgba(220,38,38,0.6)" />
                </linearGradient>
                <filter id="connGlow">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              {/* Glow layer */}
              <path
                d="M 20 5 C 20 30, 20 70, 20 95"
                fill="none"
                stroke="rgba(220,38,38,0.08)"
                strokeWidth="6"
                filter="url(#connGlow)"
              />
              {/* Main path */}
              <path
                className="connector-path"
                d="M 20 5 C 20 30, 20 70, 20 95"
                fill="none"
                stroke="url(#connGrad)"
                strokeWidth="1.5"
                strokeDasharray="5 3"
              />

              {/* Flowing dot */}
              <circle className="connector-dot" r="3" fill="rgba(220,38,38,0.9)">
                <animateMotion dur="2s" repeatCount="indefinite">
                  <mpath href="#connMotion" />
                </animateMotion>
              </circle>
              <path id="connMotion" d="M 20 5 C 20 30, 20 70, 20 95" fill="none" stroke="none" />

              {/* Label */}
              <text
                x="20"
                y="54"
                textAnchor="middle"
                className="fill-white/20"
                style={{ fontSize: '7px', fontFamily: 'DM Sans, system-ui, sans-serif', letterSpacing: '0.15em' }}
              >
                TTS
              </text>
            </svg>
          </div>

          {/* ─── Audio player (below) ─── */}
          <div ref={playerRef} className="relative w-full">
            <div className="absolute -top-6 left-0 text-[10px] font-mono tracking-[0.15em] text-white/20 uppercase">
              Audio Output
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 md:p-8">

              {/* Voice label */}
              <div className="flex items-center gap-3 mb-6">
                <div className="w-8 h-8 rounded-full bg-accent/[0.12] border border-accent/20 flex items-center justify-center">
                  <Volume2 className="w-3.5 h-3.5 text-accent-text/70" />
                </div>
                <div>
                  <div className="text-sm text-white/70">Declan</div>
                  <div className="text-[11px] text-white/25 font-mono">Voice Sample</div>
                </div>
              </div>

              {/* Transport controls */}
              <div className="flex items-center gap-4">
                <button
                  onClick={togglePlay}
                  className="w-10 h-10 rounded-full bg-accent/[0.15] border border-accent/25 flex items-center justify-center hover:bg-accent/25 transition-colors duration-200 group"
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? (
                    <Pause className="w-4 h-4 text-accent-text/90 group-hover:text-white transition-colors" />
                  ) : (
                    <Play className="w-4 h-4 text-accent-text/90 group-hover:text-white transition-colors ml-0.5" />
                  )}
                </button>
                <div className="flex-1">
                  {/* Progress scrubber */}
                  <div className="relative h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full"
                      style={{
                        width: `${playProgress * 100}%`,
                        backgroundColor: 'rgba(220, 38, 38, 0.7)',
                      }}
                    />
                  </div>
                </div>
                <span className="text-[11px] font-mono text-white/25 tabular-nums w-16 text-right">
                  {formatTime(currentSec)} / {formatTime(totalDuration)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Stats row ── */}
        <div ref={statsRef} className="flex flex-wrap justify-center gap-4 mb-8">
          {stats.map(s => (
            <div key={s.label} className="stat-item inline-flex items-center gap-3 px-5 py-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
              <span className="text-base font-display text-white/80 font-medium tracking-tight">
                {s.value}
              </span>
              <span className="text-[13px] text-white/30 font-light">
                {s.label}
              </span>
            </div>
          ))}
        </div>

        {/* ── Auto-pauses feature callout ── */}
        <div ref={autoRef} className="max-w-xl mx-auto text-center">
          <div className="inline-flex items-center gap-3 px-5 py-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-accent/60" />
              <div className="w-3 h-1.5 rounded-full bg-white/10" />
              <div className="w-1.5 h-1.5 rounded-full bg-accent/60" />
            </div>
            <span className="text-sm text-white/40 font-light">
              Auto-pauses between scenes — natural breathing room, no manual editing
            </span>
          </div>
        </div>

      </div>
    </section>
  );
}
