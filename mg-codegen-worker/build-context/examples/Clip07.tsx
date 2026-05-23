import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  Sequence,
} from "remotion";

export const Clip07: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const white = "#FFFFFF";
  const teal = "#00B4D8";
  const coral = "#FF6B6B";
  const brightGreen = "#10B981";
  const sunnyYellow = "#FBBF24";
  const purple = "#8B5CF6";
  const darkOrange = "#E67E22";
  const darkBg = "#F0F4F8";

  const s = (sec: number) => sec * fps;

  const impactFrame = s(2);
  const labelsStart = s(5);
  const splitStart = s(12);
  const progressStart = s(22);
  const transformStart = s(28);
  const compareStart = s(30);
  const finalFigureStart = s(36);
  const textStart = s(40);

  const impactScale = frame < impactFrame ? 0 : interpolate(frame, [impactFrame, impactFrame + 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.exp) });
  const ripple1 = interpolate((frame - impactFrame) % 60, [0, 60], [0, 120], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const rippleOp = frame < impactFrame ? 0 : interpolate((frame - impactFrame) % 60, [0, 60], [0.6, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const figureOpacity = interpolate(frame, [0, s(1)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const figureScale = interpolate(frame, [0, s(1)], [0.8, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });

  const scene1Opacity = interpolate(frame, [splitStart - 15, splitStart], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scene2Opacity = interpolate(frame, [splitStart - 5, splitStart + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scene2Out = interpolate(frame, [progressStart - 15, progressStart], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scene3Opacity = interpolate(frame, [progressStart - 5, progressStart + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scene3Out = interpolate(frame, [transformStart - 10, transformStart], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scene4Opacity = interpolate(frame, [transformStart - 5, transformStart + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scene4Out = interpolate(frame, [finalFigureStart - 10, finalFigureStart], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scene5Opacity = interpolate(frame, [finalFigureStart - 5, finalFigureStart + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scene5Out = interpolate(frame, [textStart - 10, textStart], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scene6Opacity = interpolate(frame, [textStart - 5, textStart + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const Silhouette: React.FC<{ color: string; x: number; y: number; scale?: number; hunched?: boolean }> = ({ color, x, y, scale: sc = 1, hunched }) => (
    <g transform={`translate(${x},${y}) scale(${sc})`}>
      <circle cx={0} cy={-70} r={28} fill={color} />
      <rect x={-18} y={-42} width={36} height={hunched ? 55 : 65} rx={12} fill={color} />
      <rect x={-22} y={hunched ? 10 : 20} width={16} height={hunched ? 35 : 45} rx={6} fill={color} />
      <rect x={6} y={hunched ? 10 : 20} width={16} height={hunched ? 35 : 45} rx={6} fill={color} />
      {hunched && <ellipse cx={0} cy={-42} rx={20} ry={8} fill={color} opacity={0.5} />}
    </g>
  );

  const Badge: React.FC<{ label: string; color: string; x: number; y: number; delay: number }> = ({ label, color, x, y, delay }) => {
    const badgeIn = interpolate(frame, [labelsStart + delay, labelsStart + delay + 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.exp) });
    const pulse = 1 + 0.05 * Math.sin((frame - labelsStart - delay) * 0.15);
    return (
      <g transform={`translate(${x},${y}) scale(${badgeIn * pulse})`} opacity={badgeIn}>
        <polygon points="-42,-16 42,-16 46,0 42,16 -42,16 -46,0" fill={color} />
        <text x={0} y={5} textAnchor="middle" fill={white} fontSize={14} fontWeight={800} fontFamily="system-ui">{label}</text>
      </g>
    );
  };

  const progressVal = interpolate(frame, [progressStart, progressStart + s(6)], [100, 10], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const progressColor = progressVal > 60 ? coral : progressVal > 30 ? sunnyYellow : brightGreen;
  const barWidth = interpolate(progressVal, [0, 100], [0, 600], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const tapPoints = [{ cx: 540, cy: 280 }, { cx: 520, cy: 350 }, { cx: 540, cy: 400 }, { cx: 560, cy: 310 }, { cx: 540, cy: 450 }];

  const finalText = "STAND UNSHAKEN";
  const charsVisible = interpolate(frame, [textStart + 15, textStart + s(2.5)], [0, finalText.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: darkBg }}>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 40%, ${white} 0%, ${darkBg} 100%)` }} />

      {/* Scene 1: Silhouette + Impact + Labels */}
      <AbsoluteFill style={{ opacity: scene1Opacity }}>
        <svg width={1920} height={1080} viewBox="0 0 1920 1080" style={{ position: "absolute" }}>
          <g opacity={figureOpacity} transform={`translate(960,480) scale(${figureScale})`}>
            <Silhouette color={teal} x={0} y={0} scale={2.2} />
          </g>
          {frame >= impactFrame && frame < splitStart && (
            <g>
              <circle cx={960} cy={420} r={ripple1} fill="none" stroke={coral} strokeWidth={3} opacity={rippleOp} />
              <circle cx={960} cy={420} r={ripple1 * 0.7} fill="none" stroke={darkOrange} strokeWidth={2} opacity={rippleOp * 0.7} />
              <circle cx={960} cy={420} r={ripple1 * 0.4} fill="none" stroke={sunnyYellow} strokeWidth={2} opacity={rippleOp * 0.5} />
              <circle cx={960} cy={420} r={14 * impactScale} fill={coral} opacity={0.9} />
            </g>
          )}
          {frame >= labelsStart && frame < splitStart && (
            <g>
              <Badge label="HURT" color={coral} x={760} y={340} delay={0} />
              <Badge label="SHAME" color={purple} x={1160} y={340} delay={10} />
              <Badge label="FEAR" color={darkOrange} x={960} y={620} delay={20} />
            </g>
          )}
        </svg>
      </AbsoluteFill>

      {/* Scene 2: Split screen — funnel + tapping */}
      <AbsoluteFill style={{ opacity: scene2Opacity * scene2Out }}>
        <svg width={1920} height={1080} viewBox="0 0 1920 1080" style={{ position: "absolute" }}>
          <line x1={960} y1={100} x2={960} y2={980} stroke="#CBD5E1" strokeWidth={2} />
          {/* Left: Funnel */}
          <g>
            <text x={480} y={140} textAnchor="middle" fill="#334155" fontSize={28} fontWeight={700} fontFamily="system-ui">EMOTIONAL DISCHARGE</text>
            <polygon points="380,250 580,250 520,450 440,450" fill="none" stroke={teal} strokeWidth={3} />
            {(() => {
              const drainProg = interpolate(frame, [splitStart, splitStart + s(8)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
              const darkH = interpolate(drainProg, [0, 1], [180, 10], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
              const greenH = interpolate(drainProg, [0, 1], [0, 170], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
              return (
                <g>
                  <rect x={395} y={260 + (180 - darkH)} width={170} height={darkH} rx={4} fill="#4A1A2E" opacity={0.7} />
                  <rect x={395} y={260} width={170} height={greenH} rx={4} fill={brightGreen} opacity={0.6} />
                </g>
              );
            })()}
            <rect x={455} y={455} width={50} height={80} rx={6} fill="#94A3B8" />
            {(() => {
              const drops = [0, 15, 30, 45];
              return drops.map((d, i) => {
                const dropY = interpolate((frame - splitStart + d * 2) % 90, [0, 90], [540, 700], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
                const dropOp = interpolate((frame - splitStart + d * 2) % 90, [0, 70, 90], [0.8, 0.8, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
                return <circle key={i} cx={480 + (i - 1.5) * 12} cy={dropY} r={5} fill={brightGreen} opacity={frame >= splitStart ? dropOp : 0} />;
              });
            })()}
          </g>
          {/* Right: Tapping */}
          <g>
            <text x={1440} y={140} textAnchor="middle" fill="#334155" fontSize={28} fontWeight={700} fontFamily="system-ui">TAPPING POINTS</text>
            <g transform="translate(900,0)">
              <Silhouette color={teal} x={540} y={480} scale={2} />
            </g>
            {tapPoints.map((p, i) => {
              const tapPulse = Math.sin((frame - splitStart) * 0.12 + i * 1.5);
              const r = 16 + tapPulse * 4;
              const op = 0.6 + tapPulse * 0.3;
              return (
                <g key={i}>
                  <circle cx={p.cx + 900} cy={p.cy} r={r + 10} fill={sunnyYellow} opacity={frame >= splitStart ? op * 0.3 : 0} />
                  <circle cx={p.cx + 900} cy={p.cy} r={r} fill={sunnyYellow} opacity={frame >= splitStart ? op : 0} />
                </g>
              );
            })}
          </g>
        </svg>
      </AbsoluteFill>

      {/* Scene 3: Progress bar */}
      <AbsoluteFill style={{ opacity: scene3Opacity * scene3Out }}>
        <div style={{ position: "absolute", top: 300, left: 0, width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ fontSize: 36, fontWeight: 800, color: "#334155", fontFamily: "system-ui", marginBottom: 20, opacity: interpolate(frame, [progressStart, progressStart + 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
            EMOTIONAL INTENSITY
          </div>
          <svg width={700} height={80}>
            <rect x={40} y={15} width={620} height={50} rx={25} fill="#E2E8F0" />
            <rect x={40} y={15} width={Math.max(0, barWidth + 20)} height={50} rx={25} fill={progressColor} />
            <text x={350} y={50} textAnchor="middle" fill={white} fontSize={24} fontWeight={800} fontFamily="system-ui">{Math.round(progressVal)}%</text>
          </svg>
          <div style={{ marginTop: 60, display: "flex", gap: 80 }}>
            {[{ label: "HURT", val: interpolate(progressVal, [100, 10], [95, 5], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }), color: coral },
              { label: "SHAME", val: interpolate(progressVal, [100, 10], [88, 8], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }), color: purple },
              { label: "FEAR", val: interpolate(progressVal, [100, 10], [80, 3], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }), color: darkOrange }].map((item, i) => (
              <div key={i} style={{ textAlign: "center" }}>
                <svg width={100} height={100}>
                  <circle cx={50} cy={50} r={40} fill="none" stroke="#E2E8F0" strokeWidth={8} />
                  <circle cx={50} cy={50} r={40} fill="none" stroke={item.color} strokeWidth={8}
                    strokeDasharray={`${item.val * 2.51} 251`} strokeLinecap="round"
                    transform="rotate(-90 50 50)" />
                  <text x={50} y={55} textAnchor="middle" fill="#334155" fontSize={16} fontWeight={700} fontFamily="system-ui">{Math.round(item.val)}%</text>
                </svg>
                <div style={{ fontSize: 14, fontWeight: 700, color: item.color, fontFamily: "system-ui", marginTop: 4 }}>{item.label}</div>
              </div>
            ))}
          </div>
        </div>
      </AbsoluteFill>

      {/* Scene 4: Before/After */}
      <AbsoluteFill style={{ opacity: scene4Opacity * scene4Out }}>
        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", display: "flex" }}>
          {/* Before */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "linear-gradient(180deg, #CBD5E1 0%, #94A3B8 100%)" }}>
            <svg width={300} height={400} viewBox="0 0 300 400">
              <ellipse cx={150} cy={60} rx={100} ry={30} fill="#64748B" opacity={0.5} />
              <ellipse cx={120} cy={50} rx={60} ry={20} fill="#475569" opacity={0.6} />
              <Silhouette color="#475569" x={150} y={250} scale={1.5} hunched />
              {[0, 1, 2].map(i => {
                const ly = 80 + i * 15;
                return <line key={i} x1={80 + i * 20} y1={ly} x2={220 - i * 20} y2={ly + 5} stroke="#64748B" strokeWidth={2} opacity={0.4} />;
              })}
            </svg>
            <div style={{ fontSize: 32, fontWeight: 800, color: "#475569", fontFamily: "system-ui", marginTop: 20 }}>BEFORE</div>
          </div>
          {/* After */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: `linear-gradient(180deg, #ECFDF5 0%, ${white} 100%)` }}>
            <svg width={300} height={400} viewBox="0 0 300 400">
              <circle cx={150} cy={70} r={45} fill={sunnyYellow} opacity={0.3} />
              <circle cx={150} cy={70} r={30} fill={sunnyYellow} opacity={0.5} />
              <circle cx={150} cy={70} r={18} fill={sunnyYellow} opacity={0.8} />
              {Array.from({ length: 8 }).map((_, i) => {
                const angle = (i / 8) * Math.PI * 2;
                return <line key={i} x1={150 + Math.cos(angle) * 50} y1={70 + Math.sin(angle) * 50} x2={150 + Math.cos(angle) * 65} y2={70 + Math.sin(angle) * 65} stroke={sunnyYellow} strokeWidth={3} strokeLinecap="round" />;
              })}
              <Silhouette color={teal} x={150} y={250} scale={1.5} />
              <g transform="translate(150,170)">
                <ellipse cx={0} cy={0} rx={22} ry={28} fill="none" stroke={brightGreen} strokeWidth={3} />
                <line x1={-8} y1={2} x2={-2} y2={10} stroke={brightGreen} strokeWidth={3} strokeLinecap="round" />
                <line x1={-2} y1={10} x2={10} y2={-8} stroke={brightGreen} strokeWidth={3} strokeLinecap="round" />
              </g>
            </svg>
            <div style={{ fontSize: 32, fontWeight: 800, color: teal, fontFamily: "system-ui", marginTop: 20 }}>AFTER</div>
          </div>
        </div>
        {/* Sparkle particles */}
        {Array.from({ length: 12 }).map((_, i) => {
          const px = 960 + Math.sin(i * 1.3) * 300;
          const py = interpolate((frame - transformStart + i * 10) % 120, [0, 120], [600, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          const pOp = interpolate((frame - transformStart + i * 10) % 120, [0, 80, 120], [0.8, 0.8, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return <div key={i} style={{ position: "absolute", left: px, top: py, width: 6, height: 6, borderRadius: "50%", backgroundColor: sunnyYellow, opacity: frame >= transformStart ? pOp : 0 }} />;
        })}
      </AbsoluteFill>

      {/* Scene 5: Confident figure + check/X + stability line */}
      <AbsoluteFill style={{ opacity: scene5Opacity * scene5Out }}>
        <svg width={1920} height={1080} viewBox="0 0 1920 1080" style={{ position: "absolute" }}>
          <Silhouette color={teal} x={960} y={420} scale={2.5} />
          {/* Checkmark */}
          <g transform="translate(700,350)">
            <circle r={40} fill={brightGreen} opacity={0.15} />
            <circle r={28} fill={brightGreen} opacity={0.9} />
            <polyline points="-10,2 -3,10 12,-8" fill="none" stroke={white} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
          </g>
          {/* X mark */}
          <g transform="translate(1220,350)">
            <circle r={40} fill={coral} opacity={0.15} />
            <circle r={28} fill={coral} opacity={0.9} />
            <line x1={-8} y1={-8} x2={8} y2={8} stroke={white} strokeWidth={4} strokeLinecap="round" />
            <line x1={8} y1={-8} x2={-8} y2={8} stroke={white} strokeWidth={4} strokeLinecap="round" />
          </g>
          {/* Stability line */}
          <text x={960} y={680} textAnchor="middle" fill="#64748B" fontSize={18} fontWeight={600} fontFamily="system-ui">EMOTIONAL STABILITY</text>
          <line x1={360} y1={720} x2={1560} y2={720} stroke="#E2E8F0" strokeWidth={2} />
          {(() => {
            const lineProgress = interpolate(frame, [finalFigureStart + 20, finalFigureStart + s(3)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            const endX = 360 + lineProgress * 1200;
            return <line x1={360} y1={720} x2={endX} y2={720} stroke={brightGreen} strokeWidth={4} strokeLinecap="round" />;
          })()}
          <text x={960} y={780} textAnchor="middle" fill={brightGreen} fontSize={22} fontWeight={700} fontFamily="system-ui" opacity={interpolate(frame, [finalFigureStart + s(2), finalFigureStart + s(3)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}>
            UNSHAKEABLE
          </text>
        </svg>
      </AbsoluteFill>

      {/* Scene 6: Final text */}
      <Sequence from={textStart}>
        <AbsoluteFill style={{ opacity: scene6Opacity, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "relative" }}>
            <div style={{ fontSize: 96, fontWeight: 900, fontFamily: "system-ui", color: coral, letterSpacing: 6, textAlign: "center", filter: `drop-shadow(0 0 ${20 + Math.sin(frame * 0.08) * 8}px ${coral}55)` }}>
              {finalText.split("").map((char, i) => {
                const charOp = interpolate(charsVisible, [i, i + 1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
                const charY = interpolate(charsVisible, [i, i + 1], [30, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.exp) });
                return (
                  <span key={i} style={{ display: "inline-block", opacity: charOp, transform: `translateY(${charY}px)`, minWidth: char === " " ? 24 : undefined }}>
                    {char}
                  </span>
                );
              })}
            </div>
            <div style={{ width: interpolate(frame - textStart, [s(2.5), s(3.5)], [0, 400], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }), height: 4, backgroundColor: coral, margin: "20px auto 0", borderRadius: 2, opacity: interpolate(frame - textStart, [s(2.5), s(3)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }} />
          </div>
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
};