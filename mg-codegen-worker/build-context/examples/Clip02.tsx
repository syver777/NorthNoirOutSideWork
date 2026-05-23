import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  Sequence,
} from "remotion";

export const Clip02: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const ease = Easing.bezier(0.16, 1, 0.3, 1);
  const easeIn = Easing.bezier(0.4, 0, 1, 0.5);
  const easeInOut = Easing.bezier(0.45, 0, 0.55, 1);

  return (
    <AbsoluteFill style={{ backgroundColor: "#F8F6F1", overflow: "hidden" }}>
      {/* Subtle background texture dots */}
      <AbsoluteFill style={{ opacity: 0.03 }}>
        {Array.from({ length: 40 }).map((_, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              width: 4,
              height: 4,
              borderRadius: "50%",
              backgroundColor: "#1a1a2e",
              left: `${(i * 137.5) % 100}%`,
              top: `${(i * 73.7) % 100}%`,
            }}
          />
        ))}
      </AbsoluteFill>

      {/* SCENE 1: Unlocked Door (0–5s) */}
      <Sequence durationInFrames={5 * fps}>
        <DoorScene fps={fps} ease={ease} />
      </Sequence>

      {/* SCENE 2: Phantom Ghost (4s–11s) */}
      <Sequence from={4 * fps} durationInFrames={7 * fps}>
        <GhostScene fps={fps} ease={ease} easeInOut={easeInOut} />
      </Sequence>

      {/* SCENE 3: Bar Chart + Phone (10s–20s) */}
      <Sequence from={10 * fps} durationInFrames={10 * fps}>
        <ChartScene fps={fps} ease={ease} />
      </Sequence>

      {/* SCENE 4: Distorted Bars + Tiny Figure (19s–27s) */}
      <Sequence from={19 * fps} durationInFrames={8 * fps}>
        <DistortionScene fps={fps} ease={ease} easeIn={easeIn} />
      </Sequence>

      {/* SCENE 5: Wound/Shatter (26s–32s) */}
      <Sequence from={26 * fps} durationInFrames={6 * fps}>
        <WoundScene fps={fps} ease={ease} />
      </Sequence>

      {/* SCENE 6: Two Myth Pillars (31s–38s) */}
      <Sequence from={31 * fps} durationInFrames={7 * fps}>
        <MythScene fps={fps} ease={ease} />
      </Sequence>
    </AbsoluteFill>
  );
};

const DoorScene: React.FC<{ fps: number; ease: (t: number) => number }> = ({ fps, ease }) => {
  const frame = useCurrentFrame();
  const fadeIn = interpolate(frame, [0, fps * 0.8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const doorSwing = interpolate(frame, [fps * 0.5, fps * 2], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const sceneOut = interpolate(frame, [fps * 3.5, fps * 4.5], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const textIn = interpolate(frame, [fps * 1.5, fps * 2.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const textY = interpolate(frame, [fps * 1.5, fps * 2.5], [30, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });

  return (
    <AbsoluteFill style={{ opacity: sceneOut, justifyContent: "center", alignItems: "center" }}>
      <svg width={300} height={400} viewBox="0 0 300 400" style={{ opacity: fadeIn }}>
        {/* Door frame */}
        <rect x={60} y={40} width={180} height={320} rx={4} fill="none" stroke="#1a1a2e" strokeWidth={6} />
        {/* Door panel - swings open */}
        <g style={{ transformOrigin: "60px 200px", transform: `perspective(600px) rotateY(${doorSwing * -70}deg)` }}>
          <rect x={60} y={40} width={180} height={320} rx={2} fill="#E8E4DD" stroke="#1a1a2e" strokeWidth={3} />
          <circle cx={210} cy={200} r={8} fill="#F59E0B" stroke="#1a1a2e" strokeWidth={2} />
        </g>
        {/* Unlocked padlock icon */}
        <g transform="translate(130, 380)">
          <rect x={5} y={12} width={30} height={22} rx={3} fill="#10B981" />
          <path d="M12 12 V8 A8 8 0 0 1 28 8" fill="none" stroke="#10B981" strokeWidth={3} strokeLinecap="round" />
        </g>
      </svg>
      <div style={{ position: "absolute", bottom: 80, opacity: textIn, transform: `translateY(${textY}px)`, textAlign: "center" }}>
        <div style={{ fontSize: 22, fontWeight: 600, color: "#64748B", letterSpacing: 3, textTransform: "uppercase" }}>
          Not a locked door
        </div>
      </div>
    </AbsoluteFill>
  );
};

const GhostScene: React.FC<{ fps: number; ease: (t: number) => number; easeInOut: (t: number) => number }> = ({ fps, ease, easeInOut }) => {
  const frame = useCurrentFrame();
  const fadeIn = interpolate(frame, [0, fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const pulse = interpolate(frame, [0, fps * 7], [0, Math.PI * 14], { extrapolateRight: "clamp" });
  const breathe = 1 + Math.sin(pulse) * 0.04;
  const heartGlow = 0.3 + Math.abs(Math.sin(pulse * 1.5)) * 0.5;
  const textIn = interpolate(frame, [fps * 1.5, fps * 2.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const textY = interpolate(frame, [fps * 1.5, fps * 2.5], [40, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const subIn = interpolate(frame, [fps * 3, fps * 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const sceneOut = interpolate(frame, [fps * 5.5, fps * 6.5], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ opacity: fadeIn * sceneOut, justifyContent: "center", alignItems: "center" }}>
      <div style={{ transform: `scale(${breathe})`, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <svg width={260} height={340} viewBox="0 0 260 340">
          <defs>
            <linearGradient id="ghostGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#06B6D4" stopOpacity={0.6} />
              <stop offset="100%" stopColor="#8B5CF6" stopOpacity={0.15} />
            </linearGradient>
          </defs>
          {/* Ghost body */}
          <path d="M130 30 C60 30 30 90 30 170 C30 250 30 300 30 310 L60 290 L90 310 L120 290 L150 310 L180 290 L210 310 L230 290 L230 170 C230 90 200 30 130 30Z" fill="url(#ghostGrad)" stroke="#06B6D4" strokeWidth={2} />
          {/* Eyes */}
          <ellipse cx={100} cy={150} rx={18} ry={22} fill="#1a1a2e" opacity={0.7} />
          <ellipse cx={160} cy={150} rx={18} ry={22} fill="#1a1a2e" opacity={0.7} />
          {/* Heart glow */}
          <circle cx={130} cy={220} r={16} fill="#F87171" opacity={heartGlow} />
          <circle cx={130} cy={220} r={28} fill="#F87171" opacity={heartGlow * 0.3} />
        </svg>
      </div>
      <div style={{ position: "absolute", bottom: 120, textAlign: "center" }}>
        <div style={{ fontSize: 48, fontWeight: 800, color: "#8B5CF6", opacity: textIn, transform: `translateY(${textY}px)`, letterSpacing: -1 }}>
          Phantom Fear
        </div>
        <div style={{ fontSize: 20, fontWeight: 500, color: "#F97316", opacity: subIn, marginTop: 12, letterSpacing: 4, textTransform: "uppercase" }}>
          Silent Pandemic
        </div>
      </div>
    </AbsoluteFill>
  );
};

const ChartScene: React.FC<{ fps: number; ease: (t: number) => number }> = ({ fps, ease }) => {
  const frame = useCurrentFrame();
  const fadeIn = interpolate(frame, [0, fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const barHeights = [0.3, 0.45, 0.55, 0.65, 0.72, 0.82, 0.9, 1.0];
  const colors = ["#06B6D4", "#0891B2", "#F97316", "#EA580C", "#8B5CF6", "#7C3AED", "#F43F5E", "#E11D48"];
  const sceneOut = interpolate(frame, [fps * 8.5, fps * 9.5], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const phoneIn = interpolate(frame, [fps * 3, fps * 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const phoneX = interpolate(frame, [fps * 3, fps * 4], [60, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const labelIn = interpolate(frame, [fps * 1.5, fps * 2.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const ampIn = interpolate(frame, [fps * 5, fps * 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });

  return (
    <AbsoluteFill style={{ opacity: fadeIn * sceneOut, justifyContent: "center", alignItems: "center" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 20 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#1a1a2e", marginBottom: 16, opacity: labelIn, textAlign: "center" }}>
            Fear of Social Rejection
          </div>
          <svg width={420} height={300} viewBox="0 0 420 300">
            <line x1={30} y1={270} x2={400} y2={270} stroke="#CBD5E1" strokeWidth={2} />
            <line x1={30} y1={270} x2={30} y2={20} stroke="#CBD5E1" strokeWidth={2} />
            {barHeights.map((h, i) => {
              const delay = fps * 0.8 + i * 8;
              const grow = interpolate(frame, [delay, delay + fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
              const barH = h * 230 * grow;
              return (
                <rect key={i} x={45 + i * 45} y={270 - barH} width={32} height={barH} rx={4} fill={colors[i]} opacity={0.85} />
              );
            })}
          </svg>
        </div>
        {/* Phone icon */}
        <div style={{ opacity: phoneIn, transform: `translateX(${phoneX}px)`, marginBottom: 40 }}>
          <svg width={80} height={140} viewBox="0 0 80 140">
            <rect x={10} y={5} width={60} height={130} rx={12} fill="#1E293B" />
            <rect x={16} y={20} width={48} height={90} rx={4} fill="#334155" />
            <circle cx={40} cy={125} r={6} fill="#475569" />
            {/* Ripple waves */}
            {[0, 1, 2].map((r) => {
              const ripplePhase = interpolate(frame, [0, fps * 10], [0, Math.PI * 20], { extrapolateRight: "clamp" });
              const rippleOp = 0.15 + Math.sin(ripplePhase + r * 1.2) * 0.15;
              return (
                <circle key={r} cx={40} cy={65} r={50 + r * 20} fill="none" stroke="#06B6D4" strokeWidth={2} opacity={rippleOp * phoneIn} />
              );
            })}
          </svg>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#06B6D4", textAlign: "center", marginTop: 8, opacity: ampIn, letterSpacing: 2, textTransform: "uppercase" }}>
            Digital<br />Amplification
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const DistortionScene: React.FC<{ fps: number; ease: (t: number) => number; easeIn: (t: number) => number }> = ({ fps, ease, easeIn }) => {
  const frame = useCurrentFrame();
  const fadeIn = interpolate(frame, [0, fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const sceneOut = interpolate(frame, [fps * 6.5, fps * 7.5], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const distort = interpolate(frame, [fps * 1.5, fps * 4], [1, 2.8], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const glitch = Math.sin(frame * 0.7) * 3;
  const figureIn = interpolate(frame, [fps * 3, fps * 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const figureY = interpolate(frame, [fps * 3, fps * 4], [20, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const barData = [0.5, 0.7, 0.85, 1.0, 0.9, 0.75];
  const barColors = ["#F43F5E", "#E11D48", "#BE123C", "#9F1239", "#881337", "#701A2B"];

  return (
    <AbsoluteFill style={{ opacity: fadeIn * sceneOut, justifyContent: "center", alignItems: "center" }}>
      <svg width={600} height={420} viewBox="0 0 600 420">
        {/* Chart frame */}
        <rect x={50} y={30} width={500} height={320} fill="none" stroke="#E2E8F0" strokeWidth={2} strokeDasharray="6 4" />
        {barData.map((h, i) => {
          const barH = h * 280 * distort;
          const jagX = Math.sin(frame * 0.3 + i) * glitch;
          return (
            <g key={i}>
              <rect x={80 + i * 80 + jagX} y={350 - Math.min(barH, 500)} width={50} height={Math.min(barH, 500)} rx={3} fill={barColors[i]} opacity={0.9} />
              {barH > 320 && (
                <polygon points={`${80 + i * 80 + jagX},30 ${105 + i * 80 + jagX},10 ${130 + i * 80 + jagX},30`} fill={barColors[i]} opacity={0.7} />
              )}
            </g>
          );
        })}
        {/* Tiny human figure */}
        <g style={{ opacity: figureIn, transform: `translateY(${figureY}px)` }}>
          <circle cx={300} cy={370} r={6} fill="#1a1a2e" />
          <line x1={300} y1={376} x2={300} y2={400} stroke="#1a1a2e" strokeWidth={2.5} />
          <line x1={290} y1={388} x2={310} y2={388} stroke="#1a1a2e" strokeWidth={2} />
          <line x1={296} y1={400} x2={290} y2={415} stroke="#1a1a2e" strokeWidth={2} />
          <line x1={304} y1={400} x2={310} y2={415} stroke="#1a1a2e" strokeWidth={2} />
        </g>
      </svg>
      <div style={{ position: "absolute", top: 50, fontSize: 16, fontWeight: 700, color: "#F43F5E", letterSpacing: 3, textTransform: "uppercase", opacity: interpolate(frame, [fps * 2, fps * 3], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
        Monstrous Distortion of Reality
      </div>
    </AbsoluteFill>
  );
};

const WoundScene: React.FC<{ fps: number; ease: (t: number) => number }> = ({ fps, ease }) => {
  const frame = useCurrentFrame();
  const fadeIn = interpolate(frame, [0, fps * 0.6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const sceneOut = interpolate(frame, [fps * 4.5, fps * 5.5], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const iconIn = interpolate(frame, [fps * 0.3, fps * 1.2], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const xIn = interpolate(frame, [fps * 1.5, fps * 2], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const textIn = interpolate(frame, [fps * 2, fps * 3], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const shatter = interpolate(frame, [fps * 3, fps * 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const shatterPieces = [
    { x: -40, y: -30, r: -15 }, { x: 30, y: -40, r: 20 }, { x: -20, y: 35, r: -25 },
    { x: 45, y: 25, r: 12 }, { x: 0, y: -50, r: -8 },
  ];

  return (
    <AbsoluteFill style={{ opacity: fadeIn * sceneOut, justifyContent: "center", alignItems: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 40 }}>
        {/* Bandage icon with X */}
        <div style={{ position: "relative", opacity: iconIn }}>
          <svg width={120} height={120} viewBox="0 0 120 120">
            <rect x={20} y={40} width={80} height={40} rx={8} fill="#FDE68A" stroke="#F59E0B" strokeWidth={3} />
            <line x1={40} y1={50} x2={40} y2={70} stroke="#F59E0B" strokeWidth={2} />
            <line x1={60} y1={50} x2={60} y2={70} stroke="#F59E0B" strokeWidth={2} />
            <line x1={80} y1={50} x2={80} y2={70} stroke="#F59E0B" strokeWidth={2} />
          </svg>
          {/* Red X */}
          <svg width={120} height={120} viewBox="0 0 120 120" style={{ position: "absolute", top: 0, left: 0, opacity: xIn }}>
            <line x1={25} y1={25} x2={95} y2={95} stroke="#EF4444" strokeWidth={8} strokeLinecap="round" />
            <line x1={95} y1={25} x2={25} y2={95} stroke="#EF4444" strokeWidth={8} strokeLinecap="round" />
          </svg>
        </div>
        {/* Shattering text */}
        <div style={{ position: "relative" }}>
          <div style={{ fontSize: 42, fontWeight: 900, color: "#1a1a2e", opacity: textIn * (1 - shatter), letterSpacing: -1 }}>
            Catastrophic Wound
          </div>
          {shatter > 0 && shatterPieces.map((p, i) => (
            <div key={i} style={{
              position: "absolute", top: 0, left: `${i * 20}%`, width: "22%", height: "100%", overflow: "hidden",
              transform: `translate(${p.x * shatter}px, ${p.y * shatter}px) rotate(${p.r * shatter}deg)`,
              opacity: 1 - shatter * 0.8,
            }}>
              <div style={{ fontSize: 42, fontWeight: 900, color: "#EF4444", whiteSpace: "nowrap", marginLeft: `-${i * 20}%` }}>
                Catastrophic Wound
              </div>
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const MythScene: React.FC<{ fps: number; ease: (t: number) => number }> = ({ fps, ease }) => {
  const frame = useCurrentFrame();
  const fadeIn = interpolate(frame, [0, fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const leftIn = interpolate(frame, [fps * 0.5, fps * 2], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const leftX = interpolate(frame, [fps * 0.5, fps * 2], [-300, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const rightIn = interpolate(frame, [fps * 1, fps * 2.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const rightX = interpolate(frame, [fps * 1, fps * 2.5], [300, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const pathGlow = interpolate(frame, [fps * 3, fps * 4.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const figuresIn = interpolate(frame, [fps * 4, fps * 5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const titleIn = interpolate(frame, [fps * 5, fps * 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const titleY = interpolate(frame, [fps * 5, fps * 6], [30, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const glowPulse = 0.6 + Math.sin(frame * 0.1) * 0.4;

  const Pillar: React.FC<{ label: string; color: string; x: number; opacity: number }> = ({ label, color, x, opacity: op }) => (
    <div style={{ opacity: op, transform: `translateX(${x}px)`, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <svg width={100} height={320} viewBox="0 0 100 320">
        <rect x={10} y={0} width={80} height={320} rx={6} fill={color} opacity={0.9} />
        <rect x={5} y={0} width={90} height={30} rx={4} fill={color} />
        <rect x={5} y={290} width={90} height={30} rx={4} fill={color} />
      </svg>
      <div style={{ fontSize: 28, fontWeight: 900, color, letterSpacing: 2 }}>{label}</div>
      {/* Guard icon */}
      <svg width={50} height={70} viewBox="0 0 50 70" style={{ marginTop: -8 }}>
        <circle cx={25} cy={14} r={10} fill="#1a1a2e" />
        <rect x={15} y={24} width={20} height={28} rx={4} fill="#1a1a2e" />
        <line x1={10} y1={35} x2={15} y2={30} stroke="#1a1a2e" strokeWidth={3} strokeLinecap="round" />
        <line x1={40} y1={35} x2={35} y2={30} stroke="#1a1a2e" strokeWidth={3} strokeLinecap="round" />
        <line x1={20} y1={52} x2={16} y2={68} stroke="#1a1a2e" strokeWidth={3} strokeLinecap="round" />
        <line x1={30} y1={52} x2={34} y2={68} stroke="#1a1a2e" strokeWidth={3} strokeLinecap="round" />
      </svg>
    </div>
  );

  return (
    <AbsoluteFill style={{ opacity: fadeIn, justifyContent: "center", alignItems: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 120, position: "relative" }}>
        <Pillar label="MYTH 1" color="#F97316" x={leftX} opacity={leftIn} />
        {/* Glowing path between pillars */}
        <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: 120, height: 300, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <svg width={120} height={300} viewBox="0 0 120 300" style={{ opacity: pathGlow }}>
            <defs>
              <linearGradient id="pathGrad" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" stopColor="#FDE68A" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#F59E0B" stopOpacity={glowPulse * 0.8} />
              </linearGradient>
            </defs>
            <rect x={20} y={0} width={80} height={300} rx={40} fill="url(#pathGrad)" />
            <line x1={60} y1={280} x2={60} y2={20} stroke="#F59E0B" strokeWidth={2} opacity={0.5} strokeDasharray="8 6" />
          </svg>
          {/* Hesitant figures */}
          <div style={{ position: "absolute", bottom: 20, display: "flex", gap: 12, opacity: figuresIn }}>
            {[0, 1, 2].map((i) => (
              <svg key={i} width={24} height={44} viewBox="0 0 24 44">
                <circle cx={12} cy={7} r={5} fill="#64748B" />
                <rect x={6} y={12} width={12} height={18} rx={3} fill="#64748B" />
                <line x1={9} y1={30} x2={7} y2={42} stroke="#64748B" strokeWidth={2} strokeLinecap="round" />
                <line x1={15} y1={30} x2={17} y2={42} stroke="#64748B" strokeWidth={2} strokeLinecap="round" />
              </svg>
            ))}
          </div>
        </div>
        <Pillar label="MYTH 2" color="#8B5CF6" x={rightX} opacity={rightIn} />
      </div>
      <div style={{ position: "absolute", bottom: 60, textAlign: "center", opacity: titleIn, transform: `translateY(${titleY}px)` }}>
        <div style={{ fontSize: 36, fontWeight: 900, color: "#1a1a2e", letterSpacing: -0.5 }}>
          Two Potent Myths
        </div>
        <div style={{ fontSize: 16, fontWeight: 500, color: "#64748B", marginTop: 10, letterSpacing: 1 }}>
          False gatekeepers between people and the life they want
        </div>
      </div>
    </AbsoluteFill>
  );
};