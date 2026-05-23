import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from "remotion";

export const Clip01: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const personPath = (scale = 1, color: string, x: number, y: number) => {
    return (
      <g transform={`translate(${x}, ${y}) scale(${scale})`}>
        <circle cx="0" cy="-28" r="14" fill={color} />
        <rect x="-12" y="-12" width="24" height="36" rx="8" fill={color} />
        <rect x="-14" y="24" width="10" height="24" rx="4" fill={color} />
        <rect x="4" y="24" width="10" height="24" rx="4" fill={color} />
      </g>
    );
  };

  const gridOpacity = interpolate(frame, [0, 30], [0, 0.15], { extrapolateRight: "clamp", extrapolateLeft: "clamp" });

  const centralFigureOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp" });
  const centralFigureScale = interpolate(frame, [0, 20], [0.5, 1], { extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1), extrapolateLeft: "clamp" });

  const groupSlide = interpolate(frame, [fps * 1, fps * 2], [400, 0], { extrapolateRight: "clamp", extrapolateLeft: "clamp", easing: Easing.bezier(0.22, 1, 0.36, 1) });
  const groupOpacity = interpolate(frame, [fps * 1, fps * 1.5], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp" });

  const lineProgress = interpolate(frame, [fps * 3, fps * 4], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp", easing: Easing.bezier(0.45, 0, 0.55, 1) });

  const breakProgress = interpolate(frame, [fps * 4.5, fps * 5.2], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const lineBreakOpacity = interpolate(frame, [fps * 4.5, fps * 5.2], [1, 0], { extrapolateRight: "clamp", extrapolateLeft: "clamp" });

  const groupShift = interpolate(frame, [fps * 4.5, fps * 5.5], [0, 60], { extrapolateRight: "clamp", extrapolateLeft: "clamp", easing: Easing.bezier(0.22, 1, 0.36, 1) });

  const anxietyCircleScale = interpolate(frame, [fps * 4.5, fps * 5.5], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp", easing: Easing.bezier(0.34, 1.56, 0.64, 1) });
  const pulsePhase = Math.sin(frame * 0.08) * 0.08;

  const bannerOpacity = interpolate(frame, [fps * 6, fps * 6.8], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp" });
  const bannerY = interpolate(frame, [fps * 6, fps * 6.8], [30, 0], { extrapolateRight: "clamp", extrapolateLeft: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });

  const bar1Fill = interpolate(frame, [fps * 7.5, fps * 9], [0, 74], { extrapolateRight: "clamp", extrapolateLeft: "clamp", easing: Easing.bezier(0.22, 1, 0.36, 1) });
  const bar2Fill = interpolate(frame, [fps * 8, fps * 9.5], [0, 56], { extrapolateRight: "clamp", extrapolateLeft: "clamp", easing: Easing.bezier(0.22, 1, 0.36, 1) });
  const statsOpacity = interpolate(frame, [fps * 7.5, fps * 8.2], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp" });

  const groupColors = ["#F97316", "#FBBF24", "#10B981", "#8B5CF6", "#EC4899"];
  const groupPositions = [
    { x: 0, y: 0 },
    { x: 40, y: -15 },
    { x: -35, y: 10 },
    { x: 45, y: 20 },
    { x: -10, y: -25 },
  ];

  const floatingIcons = [
    { x: 120, y: 150, delay: 0, symbol: "bubble" },
    { x: 1700, y: 200, delay: 20, symbol: "heart" },
    { x: 300, y: 800, delay: 40, symbol: "thumb" },
    { x: 1550, y: 750, delay: 60, symbol: "bubble" },
    { x: 900, y: 100, delay: 10, symbol: "heart" },
    { x: 1400, y: 500, delay: 35, symbol: "thumb" },
  ];

  const particles = Array.from({ length: 8 }, (_, i) => {
    const angle = (i / 8) * Math.PI * 2;
    const dist = breakProgress * 60;
    return {
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      opacity: 1 - breakProgress,
    };
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#F8F6F2" }}>
      {/* Grid pattern */}
      <svg width="1920" height="1080" style={{ position: "absolute", opacity: gridOpacity }}>
        {Array.from({ length: 25 }, (_, i) => (
          <line key={`v${i}`} x1={i * 80} y1="0" x2={i * 80} y2="1080" stroke="#C8C4BE" strokeWidth="0.5" />
        ))}
        {Array.from({ length: 15 }, (_, i) => (
          <line key={`h${i}`} x1="0" y1={i * 80} x2="1920" y2={i * 80} stroke="#C8C4BE" strokeWidth="0.5" />
        ))}
      </svg>

      {/* Pastel gradient accents */}
      <div style={{ position: "absolute", top: -100, left: -100, width: 500, height: 500, borderRadius: "50%", background: "radial-gradient(circle, rgba(251,191,36,0.12) 0%, transparent 70%)", opacity: interpolate(frame, [0, 60], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp" }) }} />
      <div style={{ position: "absolute", bottom: -80, right: -80, width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(236,72,153,0.1) 0%, transparent 70%)", opacity: interpolate(frame, [0, 60], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp" }) }} />

      {/* Floating background icons */}
      {floatingIcons.map((icon, i) => {
        const drift = Math.sin((frame + icon.delay) * 0.03) * 15;
        const driftX = Math.cos((frame + icon.delay) * 0.02) * 10;
        const fOpacity = interpolate(frame, [icon.delay, icon.delay + 40], [0, 0.18], { extrapolateRight: "clamp", extrapolateLeft: "clamp" });
        return (
          <svg key={i} width="40" height="40" style={{ position: "absolute", left: icon.x + driftX, top: icon.y + drift, opacity: fOpacity }}>
            {icon.symbol === "bubble" && (
              <>
                <rect x="4" y="4" width="32" height="24" rx="8" fill="none" stroke="#E88" strokeWidth="2" />
                <polygon points="14,28 18,34 22,28" fill="none" stroke="#E88" strokeWidth="2" />
                <line x1="13" y1="15" x2="27" y2="15" stroke="#E88" strokeWidth="2" />
                <line x1="12" y1="14" x2="28" y2="22" stroke="#D55" strokeWidth="2.5" />
              </>
            )}
            {icon.symbol === "heart" && (
              <g transform="translate(20,22) scale(0.8)">
                <path d="M0,-8 C-5,-18 -18,-12 -14,-2 C-10,6 0,14 0,14 C0,14 10,6 14,-2 C18,-12 5,-18 0,-8Z" fill="none" stroke="#E88" strokeWidth="2" />
                <line x1="-10" y1="-10" x2="10" y2="10" stroke="#D55" strokeWidth="2.5" />
              </g>
            )}
            {icon.symbol === "thumb" && (
              <g transform="translate(8,8)">
                <rect x="0" y="14" width="6" height="14" rx="2" fill="none" stroke="#E88" strokeWidth="2" />
                <path d="M8,26 L8,12 C8,8 12,4 14,4 L18,4 C20,4 22,6 22,8 L22,14 L18,14 L22,14 L22,20 C22,24 20,26 16,26Z" fill="none" stroke="#E88" strokeWidth="2" />
                <line x1="2" y1="10" x2="22" y2="30" stroke="#D55" strokeWidth="2.5" />
              </g>
            )}
          </svg>
        );
      })}

      {/* Main scene */}
      <svg width="1920" height="1080" style={{ position: "absolute" }}>
        {/* Anxiety circle */}
        {frame > fps * 4.5 && (
          <circle
            cx="580"
            cy="420"
            r={120 * anxietyCircleScale * (1 + pulsePhase)}
            fill="rgba(239,68,68,0.12)"
            stroke="rgba(239,68,68,0.3)"
            strokeWidth="2"
          />
        )}

        {/* Central figure */}
        <g style={{ opacity: centralFigureOpacity }} transform={`translate(0,0) scale(${centralFigureScale})`}>
          <g transform={`translate(580, 420) scale(1)`}>
            <circle cx="0" cy="-28" r="14" fill="#0D9488" />
            <rect x="-12" y="-12" width="24" height="36" rx="8" fill="#0D9488" />
            <rect x="-14" y="24" width="10" height="24" rx="4" fill="#0D9488" />
            <rect x="4" y="24" width="10" height="24" rx="4" fill="#0D9488" />
          </g>
        </g>

        {/* Dashed connection lines */}
        {frame >= fps * 3 && frame < fps * 5.2 && (
          <g opacity={lineBreakOpacity}>
            {[0, 1, 2].map((i) => {
              const targetX = 1100 + groupShift + groupPositions[i].x;
              const targetY = 420 + groupPositions[i].y;
              const dx = targetX - 620;
              const dy = targetY - 420;
              const endX = 620 + dx * lineProgress;
              const endY = 420 + dy * lineProgress;
              return (
                <line key={`line${i}`} x1="620" y1="420" x2={endX} y2={endY} stroke="#0D9488" strokeWidth="2.5" strokeDasharray="8 6" opacity={0.7} />
              );
            })}
          </g>
        )}

        {/* Break particles */}
        {frame >= fps * 4.5 && breakProgress > 0 && breakProgress < 1 && (
          <g>
            {particles.map((p, i) => (
              <circle key={`p${i}`} cx={860 + p.x} cy={420 + p.y} r={3} fill="#F97316" opacity={p.opacity} />
            ))}
          </g>
        )}

        {/* Group of figures */}
        <g transform={`translate(${groupSlide + groupShift}, 0)`} opacity={groupOpacity}>
          {groupColors.map((color, i) => (
            <g key={i}>
              {personPath(0.9, color, 1100 + groupPositions[i].x, 420 + groupPositions[i].y)}
            </g>
          ))}
        </g>
      </svg>

      {/* Banner text */}
      <div style={{
        position: "absolute",
        top: 580,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        opacity: bannerOpacity,
        transform: `translateY(${bannerY}px)`,
      }}>
        <div style={{
          background: "linear-gradient(135deg, #F87171, #FB923C)",
          padding: "18px 60px",
          borderRadius: 14,
          boxShadow: "0 8px 32px rgba(248,113,113,0.3)",
        }}>
          <span style={{
            color: "#FFFFFF",
            fontSize: 42,
            fontWeight: 800,
            fontFamily: "system-ui, -apple-system, sans-serif",
            letterSpacing: 3,
          }}>
            FEAR OF SOCIAL REJECTION
          </span>
        </div>
      </div>

      {/* Stats bars */}
      <div style={{
        position: "absolute",
        top: 700,
        left: 360,
        right: 360,
        opacity: statsOpacity,
      }}>
        {/* Bar 1 */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ color: "#3F3F46", fontSize: 22, fontWeight: 700, fontFamily: "system-ui, sans-serif" }}>
              74% of people experience it
            </span>
            <span style={{ color: "#F87171", fontSize: 22, fontWeight: 800, fontFamily: "system-ui, sans-serif" }}>
              {Math.round(bar1Fill)}%
            </span>
          </div>
          <div style={{ width: "100%", height: 28, backgroundColor: "#E8E4DE", borderRadius: 14, overflow: "hidden" }}>
            <div style={{
              width: `${bar1Fill}%`,
              height: "100%",
              background: "linear-gradient(90deg, #F87171, #EF4444)",
              borderRadius: 14,
              boxShadow: "0 2px 12px rgba(248,113,113,0.4)",
            }} />
          </div>
        </div>
        {/* Bar 2 */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ color: "#3F3F46", fontSize: 22, fontWeight: 700, fontFamily: "system-ui, sans-serif" }}>
              56% avoid social events
            </span>
            <span style={{ color: "#F59E0B", fontSize: 22, fontWeight: 800, fontFamily: "system-ui, sans-serif" }}>
              {Math.round(bar2Fill)}%
            </span>
          </div>
          <div style={{ width: "100%", height: 28, backgroundColor: "#E8E4DE", borderRadius: 14, overflow: "hidden" }}>
            <div style={{
              width: `${bar2Fill}%`,
              height: "100%",
              background: "linear-gradient(90deg, #FBBF24, #F59E0B)",
              borderRadius: 14,
              boxShadow: "0 2px 12px rgba(251,191,36,0.4)",
            }} />
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};