import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  Sequence,
} from "remotion";

const clamp = (v: number) => ({ extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const });

const PersonIcon: React.FC<{ color: string; x: number; y: number; scale?: number; opacity?: number }> = ({ color, x, y, scale = 1, opacity = 1 }) => (
  <g transform={`translate(${x},${y}) scale(${scale})`} opacity={opacity}>
    <circle cx={0} cy={-12} r={8} fill={color} />
    <rect x={-10} y={-4} width={20} height={28} rx={6} fill={color} />
  </g>
);

const SpeechBubble: React.FC<{ x: number; y: number; w: number; h: number; color: string; opacity: number; scale: number }> = ({ x, y, w, h, color, opacity, scale }) => (
  <g transform={`translate(${x},${y}) scale(${scale})`} opacity={opacity}>
    <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={12} fill={color} />
    <polygon points={`${-10},${h / 2} ${10},${h / 2} ${0},${h / 2 + 14}`} fill={color} />
  </g>
);

export const Clip08: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const e = Easing.bezier(0.16, 1, 0.3, 1);
  const eIn = Easing.bezier(0.45, 0, 0.55, 1);

  const phase1End = 12 * fps;
  const phase2Start = 12 * fps;
  const phase2End = 24 * fps;
  const phase3Start = 24 * fps;

  const phase1Opacity = interpolate(frame, [phase1End - 20, phase1End], [1, 0], { ...clamp(0) });
  const phase2Opacity = interpolate(frame, [phase2Start, phase2Start + 20, phase2End - 20, phase2End], [0, 1, 1, 0], { ...clamp(0) });
  const phase3Opacity = interpolate(frame, [phase3Start, phase3Start + 20], [0, 1], { ...clamp(0) });

  const pathways = [
    { label: "Blame", angle: -40, color: "#DC2626" },
    { label: "Accusations", angle: 0, color: "#EA580C" },
    { label: "Withdrawal", angle: 40, color: "#B91C1C" },
  ];

  const bubblePulse = interpolate(frame, [0, 60, 120, 180, 240, 300, 360], [1, 1.06, 1, 1.06, 1, 1.06, 1], { ...clamp(0) });
  const isolationRadius = interpolate(frame, [3 * fps, 7 * fps], [0, 130], { ...clamp(0), easing: e });
  const isolationOpacity = interpolate(frame, [3 * fps, 7 * fps], [0, 0.15], { ...clamp(0) });

  const wipeProgress = interpolate(frame, [phase2Start, phase2Start + 25], [0, 1], { ...clamp(0), easing: e });

  const quoteWords = "I'm feeling insecure today, and it's making me fear you're pulling away".split(" ");
  const wordDelay = 4;
  const quoteStartFrame = phase2Start + 60;

  const heartPulse = interpolate(frame % 40, [0, 10, 20, 30, 40], [1, 1.2, 1, 1.1, 1], { ...clamp(0) });

  const bars = [
    { label: "Solutions", color: "#10B981", icon: "💡", delay: 0 },
    { label: "Compromise", color: "#0EA5E9", icon: "🤝", delay: 15 },
    { label: "Understanding", color: "#8B5CF6", icon: "💜", delay: 30 },
  ];

  const gridOpacity = 0.06;

  const soundWavePhase = (frame % 30) / 30;

  return (
    <AbsoluteFill style={{ backgroundColor: "#F8F9FA" }}>
      {/* Grid pattern */}
      <svg width={1920} height={1080} style={{ position: "absolute", top: 0, left: 0 }}>
        {Array.from({ length: 25 }).map((_, i) => (
          <line key={`v${i}`} x1={i * 80} y1={0} x2={i * 80} y2={1080} stroke="#94A3B8" strokeWidth={0.5} opacity={gridOpacity} />
        ))}
        {Array.from({ length: 14 }).map((_, i) => (
          <line key={`h${i}`} x1={0} y1={i * 80} x2={1920} y2={i * 80} stroke="#94A3B8" strokeWidth={0.5} opacity={gridOpacity} />
        ))}
      </svg>

      {/* PHASE 1 */}
      <Sequence durationInFrames={phase1End + 20}>
        <AbsoluteFill style={{ opacity: phase1Opacity }}>
          <svg width={1920} height={1080} viewBox="0 0 1920 1080" style={{ position: "absolute" }}>
            {/* Isolation bubble */}
            <circle cx={960} cy={440} r={isolationRadius * bubblePulse} fill="none" stroke="#DC2626" strokeWidth={3} opacity={isolationOpacity * 4} strokeDasharray="8 6" />
            <circle cx={960} cy={440} r={isolationRadius * bubblePulse} fill="#DC2626" opacity={isolationOpacity} />

            {/* Central person */}
            <PersonIcon color="#F87171" x={960} y={440} scale={2.2} />

            {/* Pathways */}
            {pathways.map((p, i) => {
              const startF = 1.5 * fps + i * 25;
              const arrowLen = interpolate(frame, [startF, startF + 60], [0, 280], { ...clamp(0), easing: e });
              const rad = (p.angle * Math.PI) / 180;
              const dx = Math.cos(rad);
              const dy = Math.sin(rad);
              const ex = 960 + dx * arrowLen;
              const ey = 440 + dy * arrowLen;
              const labelOp = interpolate(frame, [startF + 30, startF + 50], [0, 1], { ...clamp(0) });

              const personPush = interpolate(frame, [startF + 40, startF + 90], [0, 400], { ...clamp(0), easing: e });
              const personOp = interpolate(frame, [startF + 60, startF + 90], [1, 0], { ...clamp(0) });

              const jagX1 = 960 + dx * 60;
              const jagY1 = 440 + dy * 60;

              return (
                <g key={i}>
                  <line x1={jagX1} y1={jagY1} x2={ex} y2={ey} stroke={p.color} strokeWidth={4} strokeLinecap="round" />
                  {arrowLen > 50 && (
                    <polygon
                      points={`${ex},${ey} ${ex - dx * 16 + dy * 8},${ey - dy * 16 - dx * 8} ${ex - dx * 16 - dy * 8},${ey - dy * 16 + dx * 8}`}
                      fill={p.color}
                    />
                  )}
                  <text x={960 + dx * 180} y={440 + dy * 180 - 30} textAnchor="middle" fill={p.color} fontSize={22} fontWeight={700} fontFamily="sans-serif" opacity={labelOp}>
                    {p.label}
                  </text>
                  <PersonIcon color="#94A3B8" x={960 + dx * (300 + personPush)} y={440 + dy * (300 + personPush)} scale={1.2} opacity={personOp} />
                </g>
              );
            })}
          </svg>
        </AbsoluteFill>
      </Sequence>

      {/* Wipe transition */}
      {frame >= phase2Start && frame < phase2Start + 30 && (
        <div style={{ position: "absolute", top: 0, left: 0, width: `${wipeProgress * 100}%`, height: "100%", background: "linear-gradient(90deg, #F0FDFA, #F8F9FA)", zIndex: 5 }} />
      )}

      {/* PHASE 2 */}
      <Sequence from={phase2Start} durationInFrames={phase2End - phase2Start + 20}>
        <AbsoluteFill style={{ opacity: phase2Opacity }}>
          <svg width={1920} height={1080} viewBox="0 0 1920 1080" style={{ position: "absolute" }}>
            {/* Glowing central person */}
            <circle cx={500} cy={440} r={60} fill="#14B8A6" opacity={0.12 + 0.04 * Math.sin(frame * 0.08)} />
            <circle cx={500} cy={440} r={40} fill="#14B8A6" opacity={0.08 + 0.03 * Math.sin(frame * 0.1)} />
            <PersonIcon color="#14B8A6" x={500} y={440} scale={2.2} />
          </svg>

          {/* Speech bubble */}
          <div style={{ position: "absolute", left: 620, top: 200, width: 900 }}>
            {(() => {
              const bubbleScale = interpolate(frame - phase2Start, [40, 65], [0, 1], { ...clamp(0), easing: Easing.bezier(0.34, 1.56, 0.64, 1) });
              const bubbleOp = interpolate(frame - phase2Start, [40, 55], [0, 1], { ...clamp(0) });
              return (
                <div style={{ transform: `scale(${bubbleScale})`, opacity: bubbleOp, transformOrigin: "left center", background: "#FFFFFF", borderRadius: 20, padding: "36px 44px", boxShadow: "0 8px 40px rgba(20,184,166,0.15)", border: "2px solid #99F6E4", position: "relative" }}>
                  <div style={{ position: "absolute", left: -16, top: 60, width: 0, height: 0, borderTop: "12px solid transparent", borderBottom: "12px solid transparent", borderRight: "16px solid #99F6E4" }} />
                  <p style={{ fontSize: 28, lineHeight: 1.6, fontFamily: "sans-serif", color: "#1E293B", margin: 0 }}>
                    {quoteWords.map((word, wi) => {
                      const wFrame = quoteStartFrame + wi * wordDelay;
                      const wOp = interpolate(frame, [wFrame, wFrame + 6], [0, 1], { ...clamp(0) });
                      const wY = interpolate(frame, [wFrame, wFrame + 10], [8, 0], { ...clamp(0), easing: Easing.bezier(0.34, 1.56, 0.64, 1) });
                      const highlight = ["feeling", "insecure", "fear"].includes(word.replace(/[^a-zA-Z]/g, "").toLowerCase());
                      return (
                        <span key={wi} style={{ opacity: wOp, display: "inline-block", transform: `translateY(${wY}px)`, marginRight: 7, background: highlight ? "#FEF08A" : "transparent", padding: highlight ? "2px 4px" : 0, borderRadius: 4, fontWeight: highlight ? 800 : 400, color: highlight ? "#92400E" : "#1E293B" }}>
                          {word}
                        </span>
                      );
                    })}
                  </p>
                </div>
              );
            })()}
          </div>

          {/* Transparent Ownership label */}
          <div style={{ position: "absolute", left: 620, top: 560, display: "flex", alignItems: "center", gap: 12, opacity: interpolate(frame - phase2Start, [200, 220], [0, 1], { ...clamp(0) }) }}>
            <span style={{ fontSize: 26, fontWeight: 700, fontFamily: "sans-serif", color: "#0F766E", letterSpacing: 1 }}>Transparent Ownership</span>
            <span style={{ fontSize: 28, transform: `scale(${heartPulse})`, display: "inline-block" }}>❤️</span>
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* PHASE 3 */}
      <Sequence from={phase3Start} durationInFrames={1140 - phase3Start}>
        <AbsoluteFill style={{ opacity: phase3Opacity }}>
          {/* Progress bars */}
          <div style={{ position: "absolute", left: 100, top: 140, width: 800 }}>
            {bars.map((b, i) => {
              const barStart = 30 + b.delay;
              const localFrame = frame - phase3Start;
              const fill = interpolate(localFrame, [barStart, barStart + 80], [0, 100], { ...clamp(0), easing: eIn });
              const labelOp = interpolate(localFrame, [barStart, barStart + 20], [0, 1], { ...clamp(0) });
              return (
                <div key={i} style={{ marginBottom: 50, opacity: labelOp }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
                    <span style={{ fontSize: 32 }}>{b.icon}</span>
                    <span style={{ fontSize: 24, fontWeight: 700, fontFamily: "sans-serif", color: "#334155" }}>{b.label}</span>
                    <span style={{ fontSize: 22, fontWeight: 600, fontFamily: "sans-serif", color: b.color, marginLeft: "auto" }}>{Math.round(fill)}%</span>
                  </div>
                  <div style={{ width: "100%", height: 28, borderRadius: 14, background: "#E2E8F0", overflow: "hidden" }}>
                    <div style={{ width: `${fill}%`, height: "100%", borderRadius: 14, background: b.color, boxShadow: `0 0 16px ${b.color}44` }} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Two people communicating */}
          <svg width={600} height={400} viewBox="0 0 600 400" style={{ position: "absolute", right: 100, top: 120 }}>
            <PersonIcon color="#14B8A6" x={150} y={200} scale={2.5} />
            <PersonIcon color="#6366F1" x={450} y={200} scale={2.5} />

            {/* Sound waves */}
            {[1, 2, 3].map((w) => {
              const wOp = interpolate((soundWavePhase + w * 0.2) % 1, [0, 0.5, 1], [0.6, 0.1, 0.6], { ...clamp(0) });
              return <circle key={w} cx={200} cy={180} r={20 + w * 18} fill="none" stroke="#14B8A6" strokeWidth={2} opacity={wOp} />;
            })}

            {/* Ear icon */}
            <text x={400} y={170} fontSize={36} textAnchor="middle">👂</text>

            {/* Checkmark */}
            {(() => {
              const checkOp = interpolate(frame - phase3Start, [120, 145], [0, 1], { ...clamp(0) });
              const checkScale = interpolate(frame - phase3Start, [120, 145], [0, 1], { ...clamp(0), easing: Easing.bezier(0.34, 1.56, 0.64, 1) });
              return (
                <g transform={`translate(450,110) scale(${checkScale})`} opacity={checkOp}>
                  <circle cx={0} cy={0} r={20} fill="#10B981" />
                  <polyline points="-8,0 -2,8 10,-6" fill="none" stroke="#fff" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" />
                </g>
              );
            })()}
          </svg>

          {/* VS comparison */}
          <div style={{ position: "absolute", bottom: 80, left: 0, right: 0, display: "flex", justifyContent: "center", alignItems: "center", gap: 60 }}>
            {(() => {
              const vsOp = interpolate(frame - phase3Start, [200, 230], [0, 1], { ...clamp(0) });
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 60, opacity: vsOp }}>
                  {/* Bad */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    <div style={{ position: "relative" }}>
                      <SpeechBubble x={0} y={0} w={70} h={50} color="#FCA5A5" opacity={1} scale={1} />
                      <svg width={70} height={64} viewBox="-35 -32 70 64" style={{ position: "absolute", top: 0, left: -35 }}>
                        <text x={0} y={4} textAnchor="middle" fontSize={22}>😠</text>
                      </svg>
                    </div>
                    <svg width={40} height={40} viewBox="0 0 40 40">
                      <circle cx={20} cy={20} r={18} fill="#EF4444" />
                      <line x1={12} y1={12} x2={28} y2={28} stroke="#fff" strokeWidth={3.5} strokeLinecap="round" />
                      <line x1={28} y1={12} x2={12} y2={28} stroke="#fff" strokeWidth={3.5} strokeLinecap="round" />
                    </svg>
                  </div>

                  <span style={{ fontSize: 28, fontWeight: 800, color: "#94A3B8", fontFamily: "sans-serif" }}>VS</span>

                  {/* Good */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    <div style={{ position: "relative" }}>
                      <SpeechBubble x={0} y={0} w={70} h={50} color="#A7F3D0" opacity={1} scale={1} />
                      <svg width={70} height={64} viewBox="-35 -32 70 64" style={{ position: "absolute", top: 0, left: -35 }}>
                        <text x={0} y={4} textAnchor="middle" fontSize={22}>😊</text>
                      </svg>
                    </div>
                    <svg width={40} height={40} viewBox="0 0 40 40">
                      <circle cx={20} cy={20} r={18} fill="#10B981" />
                      <polyline points="12,20 18,28 30,14" fill="none" stroke="#fff" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>

                  {/* Label */}
                  <span style={{
                    fontSize: 30, fontWeight: 700, fontFamily: "sans-serif", color: "#1E293B",
                    opacity: interpolate(frame - phase3Start, [240, 270], [0, 1], { ...clamp(0) }),
                    transform: `translateY(${interpolate(frame - phase3Start, [240, 270], [12, 0], { ...clamp(0), easing: e })}px)`,
                  }}>
                    Listen, don't attack
                  </span>
                </div>
              );
            })()}
          </div>
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
};