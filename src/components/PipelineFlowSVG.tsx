import { useEffect, useRef, useState, useCallback } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

interface MeasuredLayout {
  vb: string;
  converge: { x: number; y: number };
  merge: { x: number; y: number };
  paths: Record<string, string>;
}

/** Cubic bezier branch: departs vertically from split, arrives vertically at target */
function branchCurve(fx: number, fy: number, tx: number, ty: number) {
  const dy = ty - fy;
  const dx = tx - fx;
  return `M ${fx} ${fy} C ${fx + dx * 0.12} ${fy + dy * 0.4}, ${tx} ${ty - dy * 0.3}, ${tx} ${ty}`;
}

/** Cubic bezier converge: departs vertically from card bottom, arrives vertically at convergence */
function convergeCurve(fx: number, fy: number, tx: number, ty: number) {
  const dy = ty - fy;
  const dx = tx - fx;
  return `M ${fx} ${fy} C ${fx} ${fy + dy * 0.4}, ${tx + dx * 0.12} ${ty - dy * 0.3}, ${tx} ${ty}`;
}

/**
 * Pipeline flow diagram that measures real DOM positions and draws
 * SVG paths to match exactly — no hardcoded coordinates.
 *
 * Requires these data attributes on the parent section:
 *   data-pipeline-section   — on the <section> wrapper
 *   data-pipeline-origin    — on the origin marker (logo circle in heading)
 *   data-pipeline-heading   — on the heading block
 *   data-pipeline-step      — on each of the 3 glass card wrappers
 *   data-pipeline-converge  — on the Complete Video glass card
 */
export default function PipelineFlowSVG() {
  const svgRef = useRef<SVGSVGElement>(null);
  const tlRef = useRef<gsap.core.Timeline | null>(null);
  const [layout, setLayout] = useState<MeasuredLayout | null>(null);

  // ── Measure DOM and compute paths ──
  const measure = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const section = svg.closest('[data-pipeline-section]') as HTMLElement | null;
    if (!section) return;

    const sr = section.getBoundingClientRect();
    const w = sr.width;
    const h = sr.height;

    const toLocal = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        cx: r.left + r.width / 2 - sr.left,
        cy: r.top + r.height / 2 - sr.top,
        top: r.top - sr.top,
        bottom: r.bottom - sr.top,
      };
    };

    const headingEl = section.querySelector('[data-pipeline-heading]');
    const originEl = section.querySelector('[data-pipeline-origin]');
    const stepCards = section.querySelectorAll('[data-pipeline-step]');
    const convergeEl = section.querySelector('[data-pipeline-converge]');

    if (!headingEl || !originEl || stepCards.length < 3 || !convergeEl) return;

    const heading = toLocal(headingEl);
    const originMark = toLocal(originEl);
    const cards = Array.from(stepCards).map(toLocal);
    const conv = toLocal(convergeEl);

    // Origin: centered on the HTML origin marker
    const ox = originMark.cx;
    const oy = originMark.cy;

    // Split point: between heading bottom and first card top
    const splitY = heading.bottom + (cards[0].top - heading.bottom) * 0.5;

    // Branch targets: top-center of each glass card
    const targets = cards.map(c => ({ x: c.cx, y: c.top }));

    // Convergence sources: bottom-center of each glass card
    const bottoms = cards.map(c => ({ x: c.cx, y: c.bottom }));

    // Convergence target: top-center of convergence glass card
    const cx = conv.cx;
    const cy = conv.top;

    // Merge point: where 3 convergence lines meet before continuing as one wide line
    const maxBottom = Math.max(...bottoms.map(b => b.y));
    const mergeY = maxBottom + (cy - maxBottom) * 0.3;
    const mx = cx; // horizontally centered

    // Trunk: gentle S from origin bottom to split point
    const trunkStartY = originMark.bottom + 4;
    const trunk = `M ${ox} ${trunkStartY} C ${ox - 6} ${trunkStartY + (splitY - trunkStartY) * 0.5}, ${ox + 6} ${splitY - 30}, ${ox} ${splitY}`;

    const paths: Record<string, string> = {
      trunk,
      branchLeft: branchCurve(ox, splitY, targets[0].x, targets[0].y),
      branchCenter: branchCurve(ox, splitY, targets[1].x, targets[1].y),
      branchRight: branchCurve(ox, splitY, targets[2].x, targets[2].y),
      convergeLeft: convergeCurve(bottoms[0].x, bottoms[0].y, mx, mergeY),
      convergeCenter: convergeCurve(bottoms[1].x, bottoms[1].y, mx, mergeY),
      convergeRight: convergeCurve(bottoms[2].x, bottoms[2].y, mx, mergeY),
      mergedTrunk: `M ${mx} ${mergeY} L ${cx} ${cy}`,
      tail: `M ${cx} ${cy} C ${cx} ${cy + 40}, ${cx} ${Math.min(cy + 110, h - 30)}, ${cx} ${Math.min(cy + 130, h - 10)}`,
    };

    setLayout({ vb: `0 0 ${w} ${h}`, converge: { x: cx, y: cy }, merge: { x: mx, y: mergeY }, paths });
  }, []);

  // ── Measure on mount + resize ──
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const section = svg.closest('[data-pipeline-section]') as HTMLElement | null;
    if (!section) return;

    // Double rAF ensures fonts & layout are settled
    requestAnimationFrame(() => requestAnimationFrame(measure));

    const ro = new ResizeObserver(() => requestAnimationFrame(measure));
    ro.observe(section);
    return () => ro.disconnect();
  }, [measure]);

  // ── GSAP scroll-driven animation ──
  useEffect(() => {
    if (!layout || !svgRef.current) return;

    tlRef.current?.kill();
    ScrollTrigger.getAll().forEach(st => {
      if ((st.vars as { id?: string }).id === 'pipeline-flow') st.kill();
    });

    const svg = svgRef.current;
    const section = svg.closest('[data-pipeline-section]') as HTMLElement | null;
    if (!section) return;

    // Set dash offsets on all animated paths
    const animated = svg.querySelectorAll<SVGPathElement>('path[data-path]');
    animated.forEach(p => {
      const len = p.getTotalLength();
      gsap.set(p, { strokeDasharray: len, strokeDashoffset: len });
    });

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      animated.forEach(p => gsap.set(p, { strokeDashoffset: 0 }));
      return;
    }

    const tl = gsap.timeline({
      scrollTrigger: {
        id: 'pipeline-flow',
        trigger: section,
        start: 'top 70%',
        end: 'bottom 30%',
        scrub: 1.5,
      },
    });
    tlRef.current = tl;

    // Phase 1: trunk (0 → 0.20)
    tl.to(svg.querySelectorAll('[data-path="trunk"]'), { strokeDashoffset: 0, ease: 'none', duration: 0.20 }, 0);

    // Phase 2: branches (simultaneous, 0.20 → 0.40)
    for (const name of ['branchLeft', 'branchCenter', 'branchRight']) {
      tl.to(svg.querySelectorAll(`[data-path="${name}"]`), { strokeDashoffset: 0, ease: 'none', duration: 0.20 }, 0.20);
    }

    // Phase 3: convergence to merge point (0.45 → 0.65)
    for (const name of ['convergeLeft', 'convergeCenter', 'convergeRight']) {
      tl.to(svg.querySelectorAll(`[data-path="${name}"]`), { strokeDashoffset: 0, ease: 'none', duration: 0.20 }, 0.45);
    }

    // Phase 4: merged trunk — merge point to Complete Video (0.68 → 0.85)
    tl.to(svg.querySelectorAll('[data-path="mergedTrunk"]'), { strokeDashoffset: 0, ease: 'none', duration: 0.17 }, 0.68);

    // Phase 5: tail (0.85 → 1.0)
    tl.to(svg.querySelectorAll('[data-path="tail"]'), { strokeDashoffset: 0, ease: 'none', duration: 0.15 }, 0.85);

    return () => { tl.kill(); };
  }, [layout]);

  // ── Render helpers ──
  const renderPathSet = (d: string, name: string, wide = false) => {
    const m = wide ? 3 : 1;
    return (
      <>
        <path d={d} fill="none" stroke="rgba(220,38,38,0.03)" strokeWidth={3 * m} strokeLinecap="round" />
        <path data-path={name} d={d} fill="none" stroke="rgba(220,38,38,0.12)" strokeWidth={8 * m} filter="url(#flow-glow)" strokeLinecap="round" />
        <path data-path={name} d={d} fill="none" stroke="rgba(220,38,38,0.4)" strokeWidth={2 * m} strokeLinecap="round" />
      </>
    );
  };

  const { converge, merge, paths, vb } = layout ?? {};

  return (
    <svg
      ref={svgRef}
      className="scroll-progress-line"
      viewBox={vb ?? '0 0 100 100'}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <filter id="flow-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {paths && converge && merge && (
        <>
          {/* Wide trunk: origin → split */}
          {renderPathSet(paths.trunk, 'trunk', true)}

          {/* Narrow branches: split → card tops */}
          {renderPathSet(paths.branchLeft, 'branchLeft')}
          {renderPathSet(paths.branchCenter, 'branchCenter')}
          {renderPathSet(paths.branchRight, 'branchRight')}

          {/* Narrow convergence: card bottoms → merge point */}
          {renderPathSet(paths.convergeLeft, 'convergeLeft')}
          {renderPathSet(paths.convergeCenter, 'convergeCenter')}
          {renderPathSet(paths.convergeRight, 'convergeRight')}

          {/* Merge point marker */}
          <circle cx={merge.x} cy={merge.y} r="8" fill="rgba(220,38,38,0.12)" />
          <circle cx={merge.x} cy={merge.y} r="4" fill="rgba(220,38,38,0.35)" />

          {/* Wide merged trunk: merge point → Complete Video */}
          {renderPathSet(paths.mergedTrunk, 'mergedTrunk', true)}

          {/* Wide tail: continues past Complete Video */}
          {renderPathSet(paths.tail, 'tail', true)}

          {/* Convergence point marker at Complete Video */}
          <circle cx={converge.x} cy={converge.y} r="6" fill="rgba(220,38,38,0.15)" />
          <circle cx={converge.x} cy={converge.y} r="3" fill="rgba(220,38,38,0.4)" />
        </>
      )}
    </svg>
  );
}
