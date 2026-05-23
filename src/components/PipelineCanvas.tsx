import { useEffect, useRef } from 'react';

/**
 * Atmospheric Canvas 2D animation inspired by the DataTunnel reference.
 * Renders flowing lines that converge left-to-right with glowing red particles,
 * visualizing the production pipeline (Script → Audio → Images → Video).
 *
 * - Lazy-initialized via IntersectionObserver
 * - Skipped entirely for prefers-reduced-motion
 * - Responsive: fewer lines/particles on mobile
 * - aria-hidden — purely decorative
 */
export default function PipelineCanvas({ className = '' }: { className?: string }) {
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
    let started = false;
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

    // ── Line & particle setup ──
    const mobile = window.innerWidth < 640;
    const LINE_N = mobile ? 20 : 38;
    const PART_N = mobile ? 20 : 48;

    const lines = Array.from({ length: LINE_N }, (_, i) => ({
      yOff: (i / (LINE_N - 1)) - 0.5,
      phase: Math.random() * Math.PI * 2,
      freq: 1.8 + Math.random() * 2.4,
    }));

    const particles = Array.from({ length: PART_N }, () => ({
      li: Math.floor(Math.random() * LINE_N),
      t: Math.random(),
      spd: 0.0005 + Math.random() * 0.002,
      sz: 0.8 + Math.random() * 1.6,
      op: 0.25 + Math.random() * 0.65,
    }));

    // ── Path math ──
    // Lines spread vertically on the left, converge toward the lower portion on the right
    function yAt(l: (typeof lines)[0], t: number, time: number) {
      const spread = h * 0.44;
      const tight = h * 0.035;
      const s = spread + (tight - spread) * Math.pow(t, 1.8);
      const wave =
        Math.sin(t * l.freq * Math.PI + time * 0.45 + l.phase) *
        3.5 *
        (1 - t * 0.65);
      // Convergence baseline shifts from center (h*0.5) on the left
      // down to h*0.68 on the right, so the focal point sits below the heading text
      const baseline = h * 0.5 + (h * 0.18) * Math.pow(t, 1.4);
      return baseline + l.yOff * s * 2 + wave;
    }

    // ── Draw loop ──
    let time = 0;

    function draw() {
      ctx!.clearRect(0, 0, w, h);
      time += 0.016;

      // Lines
      ctx!.lineWidth = 0.6;
      ctx!.strokeStyle = 'rgba(220,38,38,0.055)';
      for (const l of lines) {
        ctx!.beginPath();
        for (let i = 0; i <= 80; i++) {
          const t = i / 80;
          const x = t * w;
          const y = yAt(l, t, time);
          if (i === 0) ctx!.moveTo(x, y);
          else ctx!.lineTo(x, y);
        }
        ctx!.stroke();
      }

      // Particles — use radial gradient fill instead of expensive shadowBlur
      for (const p of particles) {
        p.t += p.spd;
        if (p.t > 1) {
          p.t = 0;
          p.li = Math.floor(Math.random() * LINE_N);
        }
        const x = p.t * w;
        const y = yAt(lines[p.li], p.t, time);

        // Outer glow (larger, faint)
        const glowSize = p.sz * 4;
        const grad = ctx!.createRadialGradient(x, y, 0, x, y, glowSize);
        grad.addColorStop(0, `rgba(239,68,68,${p.op * 0.5})`);
        grad.addColorStop(0.4, `rgba(220,38,38,${p.op * 0.15})`);
        grad.addColorStop(1, 'rgba(220,38,38,0)');
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.arc(x, y, glowSize, 0, Math.PI * 2);
        ctx!.fill();

        // Core dot (crisp)
        ctx!.fillStyle = `rgba(239,68,68,${p.op})`;
        ctx!.beginPath();
        ctx!.arc(x, y, p.sz, 0, Math.PI * 2);
        ctx!.fill();
      }

      raf = requestAnimationFrame(draw);
    }

    // ── Start on intersect ──
    function start() {
      if (started) return;
      started = true;
      resize();
      window.addEventListener('resize', resize);
      raf = requestAnimationFrame(draw);
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          start();
          observer.disconnect();
        }
      },
      { threshold: 0.05, rootMargin: '200px' },
    );
    observer.observe(container);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
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
