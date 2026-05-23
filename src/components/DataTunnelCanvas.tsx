import { useEffect, useRef } from 'react';

/**
 * Ambient DataTunnel canvas — flowing horizontal lines with glowing red signals.
 * Inspired by ExampleDesign/DataTunnel/ (Three.js bloom lines + traveling signals),
 * adapted to Canvas 2D for performance as a full-height background spanning
 * multiple landing page sections.
 *
 * - Lazy-initialized via IntersectionObserver
 * - Pauses when off-screen to save GPU cycles
 * - Skipped entirely for prefers-reduced-motion
 * - Responsive: fewer lines/particles on mobile
 * - aria-hidden — purely decorative
 */
export default function DataTunnelCanvas({ className = '' }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let running = false;
    let w = 0;
    let h = 0;

    // ── Resize ──
    function resize() {
      const dpr = Math.min(window.devicePixelRatio, 2);
      const rect = canvas!.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ── Config ──
    const mobile = window.innerWidth < 640;
    const LINE_COUNT = mobile ? 24 : 50;
    const SIGNAL_COUNT = mobile ? 24 : 50;

    // ── Line definitions ──
    // Lines spread evenly across the full height. Each line has a subtle wave.
    const lines = Array.from({ length: LINE_COUNT }, (_, i) => ({
      yRatio: i / (LINE_COUNT - 1), // 0..1 mapped to canvas height
      phase: Math.random() * Math.PI * 2,
      freq: 0.8 + Math.random() * 1.6,
      amp: 1.5 + Math.random() * 3,
      opacity: 0.02 + Math.random() * 0.03,
    }));

    // ── Signal (traveling dot) definitions ──
    const signals = Array.from({ length: SIGNAL_COUNT }, () => ({
      lineIdx: Math.floor(Math.random() * LINE_COUNT),
      t: Math.random(), // position along line 0..1
      speed: 0.0005 + Math.random() * 0.002,
      trailLen: 4 + Math.floor(Math.random() * 6),
      size: 0.8 + Math.random() * 1.6,
      brightness: 0.25 + Math.random() * 0.65,
      direction: Math.random() > 0.3 ? 1 : -1, // most flow right, some reverse
      history: [] as { x: number; y: number }[],
    }));

    // ── Y position on a given line at horizontal position t (0..1) ──
    function lineY(line: (typeof lines)[0], t: number, time: number): number {
      const baseY = line.yRatio * h;
      const wave = Math.sin(t * line.freq * Math.PI * 2 + time * 0.4 + line.phase) * line.amp;
      // Gentle vertical drift over time
      const drift = Math.sin(time * 0.15 + line.phase * 2) * 2;
      return baseY + wave + drift;
    }

    // ── Draw ──
    let time = 0;

    function draw() {
      ctx!.clearRect(0, 0, w, h);
      time += 0.016;

      // Draw lines — subtle horizontal strokes
      ctx!.lineWidth = 0.5;
      for (const line of lines) {
        ctx!.strokeStyle = `rgba(220, 38, 38, ${line.opacity})`;
        ctx!.beginPath();
        const steps = 60;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const x = t * w;
          const y = lineY(line, t, time);
          if (i === 0) ctx!.moveTo(x, y);
          else ctx!.lineTo(x, y);
        }
        ctx!.stroke();
      }

      // Draw signals — traveling glow dots with fading trails
      for (const sig of signals) {
        sig.t += sig.speed * sig.direction;

        // Wrap around
        if (sig.t > 1.05) {
          sig.t = -0.05;
          sig.lineIdx = Math.floor(Math.random() * LINE_COUNT);
          sig.history = [];
        } else if (sig.t < -0.05) {
          sig.t = 1.05;
          sig.lineIdx = Math.floor(Math.random() * LINE_COUNT);
          sig.history = [];
        }

        const x = sig.t * w;
        const y = lineY(lines[sig.lineIdx], sig.t, time);

        sig.history.push({ x, y });
        if (sig.history.length > sig.trailLen) {
          sig.history.shift();
        }

        // Draw trail — single path stroke
        const trailLen = sig.history.length;
        if (trailLen > 1) {
          ctx!.strokeStyle = `rgba(239, 68, 68, ${sig.brightness * 0.25})`;
          ctx!.lineWidth = sig.size * 0.6;
          ctx!.beginPath();
          ctx!.moveTo(sig.history[0].x, sig.history[0].y);
          for (let i = 1; i < trailLen; i++) {
            ctx!.lineTo(sig.history[i].x, sig.history[i].y);
          }
          ctx!.stroke();
        }

        // Glow halo
        const glowRadius = sig.size * 5;
        const grad = ctx!.createRadialGradient(x, y, 0, x, y, glowRadius);
        grad.addColorStop(0, `rgba(239, 68, 68, ${sig.brightness * 0.35})`);
        grad.addColorStop(0.4, `rgba(220, 38, 38, ${sig.brightness * 0.1})`);
        grad.addColorStop(1, 'rgba(220, 38, 38, 0)');
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.arc(x, y, glowRadius, 0, Math.PI * 2);
        ctx!.fill();

        // Core dot
        ctx!.fillStyle = `rgba(239, 68, 68, ${sig.brightness})`;
        ctx!.beginPath();
        ctx!.arc(x, y, sig.size, 0, Math.PI * 2);
        ctx!.fill();
      }

      if (running) {
        raf = requestAnimationFrame(draw);
      }
    }

    // ── Visibility management — pause when off-screen ──
    function start() {
      if (running) return;
      running = true;
      resize();
      raf = requestAnimationFrame(draw);
    }

    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          start();
        } else {
          stop();
        }
      },
      { threshold: 0, rootMargin: '200px' },
    );
    observer.observe(container);

    window.addEventListener('resize', resize);

    return () => {
      observer.disconnect();
      stop();
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div ref={containerRef} className={className}>
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        aria-hidden="true"
      />
    </div>
  );
}
