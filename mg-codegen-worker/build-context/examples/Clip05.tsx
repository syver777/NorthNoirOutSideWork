import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  Sequence,
} from "remotion";

const WHITE = "#FAFAFA";
const DARK = "#1A1A2E";
const ORANGE = "#F97316";
const RED = "#EF4444";
const CYAN = "#06B6D4";
const GREEN = "#10B981";
const TEAL = "#14B8A6";
const YELLOW = "#FBBF24";
const PURPLE = "#8B5CF6";
const GREY = "#9CA3AF";
const LIGHT_GREY = "#E5E7EB";

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const easeIn = Easing.bezier(0.45, 0, 1, 1);

const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

const Brain: React.FC<{ scale: number; opacity: number }> = ({ scale, opacity }) => (
  <svg width={120} height={120} viewBox="0 0 120 120" style={{ transform: `scale(${scale})`, opacity }}>
    <ellipse cx={50} cy={55} rx={28} ry={35} fill={CYAN} opacity={0.8} />
    <ellipse cx={70} cy={55} rx={28} ry={35} fill={PURPLE} opacity={0.7} />
    <ellipse cx={60} cy={40} rx={18} ry={14} fill={TEAL} opacity={0.6} />
    <line x1={60} y1={90} x2={60} y2={110} stroke={DARK} strokeWidth={3} />
  </svg>
);

const MythBubble: React.FC<{ x: number; y: number; s: number; pulse: number; label: string }> = ({ x, y, s, pulse, label }) => (
  <div style={{ position: "absolute", left: x, top: y, transform: `scale(${s * pulse})`, opacity: Math.min(s, 1), display: "flex", flexDirection: "column", alignItems: "center" }}>
    <svg width={100} height={70} viewBox="0 0 100 70">
      <ellipse cx={50} cy={35} rx={48} ry={32} fill={ORANGE} opacity={0.15} />
      <ellipse cx={50} cy={35} rx={44} ry={28} fill="none" stroke={RED} strokeWidth={2.5} strokeDasharray="6 3" opacity={0.9} />
      <ellipse cx={50} cy={35} rx={44} ry={28} fill="none" stroke={ORANGE} strokeWidth={1.5} opacity={0.6} />
    </svg>
    <span style={{ fontSize: 11, fontWeight: 700, color: RED, marginTop: -8, fontFamily: "sans-serif", letterSpacing: 1 }}>{label}</span>
  </div>
);

const TruthBubble: React.FC<{ opacity: number; s: number }> = ({ opacity, s }) => (
  <div style={{ opacity, transform: `scale(${s})`, display: "flex", flexDirection: "column", alignItems: "center" }}>
    <svg width={60} height={45} viewBox="0 0 60 45">
      <ellipse cx={30} cy={22} rx={28} ry={20} fill={GREY} opacity={0.3} />
      <ellipse cx={30} cy={22} rx={24} ry={17} fill="none" stroke={GREY} strokeWidth={1.5} />
    </svg>
    <span style={{ fontSize: 10, fontWeight: 600, color: GREY, marginTop: -4, fontFamily: "sans-serif" }}>TRUTH</span>
  </div>
);

const StickFigure: React.FC<{ color: string; size?: number }> = ({ color, size = 30 }) => (
  <svg width={size} height={size * 1.6} viewBox="0 0 30 48">
    <circle cx={15} cy={8} r={6} fill="none" stroke={color} strokeWidth={2} />
    <line x1={15} y1={14} x2={15} y2={32} stroke={color} strokeWidth={2} />
    <line x1={15} y1={20} x2={5} y2={26} stroke={color} strokeWidth={2} />
    <line x1={15} y1={20} x2={25} y2={26} stroke={color} strokeWidth={2} />
    <line x1={15} y1={32} x2={7} y2={44} stroke={color} strokeWidth={2} />
    <line x1={15} y1={32} x2={23} y2={44} stroke={color} strokeWidth={2} />
  </svg>
);

const GridBg: React.FC = () => (
  <AbsoluteFill style={{ opacity: 0.15 }}>
    <svg width="100%" height="100%">
      {Array.from({ length: 25 }).map((_, i) => <line key={`h${i}`} x1={0} y1={i * 45} x2={1920} y2={i * 45} stroke={LIGHT_GREY} strokeWidth={0.5} />)}
      {Array.from({ length: 45 }).map((_, i) => <line key={`v${i}`} x1={i * 45} y1={0} x2={i * 45} y2={1080} stroke={LIGHT_GREY} strokeWidth={0.5} />)}
    </svg>
  </AbsoluteFill>
);

export const Clip05: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const s1End = 8 * fps;
  const s2End = 16 * fps;
  const s3End = 24 * fps;

  const fadeScene = (start: number, end: number) => {
    const fadeIn = interpolate(frame, [start, start + 15], [0, 1], clamp);
    const fadeOut = interpolate(frame, [end - 15, end], [1, 0], clamp);
    return Math.min(fadeIn, fadeOut);
  };

  const pulse = 1 + 0.06 * Math.sin(frame * 0.12);

  return (
    <AbsoluteFill style={{ backgroundColor: WHITE }}>
      <GridBg />

      <Sequence durationInFrames={s1End}>
        {(() => {
          const o = fadeScene(0, s1End);
          const brainS = interpolate(frame, [0, 40], [0, 1], { ...clamp, easing: ease });
          const bubbleT = interpolate(frame, [30, 90], [0, 1], { ...clamp, easing: ease });
          const vsT = interpolate(frame, [120, 150], [0, 1], { ...clamp, easing: ease });
          const truthT = interpolate(frame, [160, 190], [0, 1], { ...clamp, easing: ease });
          const labelT = interpolate(frame, [60, 100], [0, 1], { ...clamp, easing: ease });
          const heartOrbit = frame * 0.04;
          const exclOrbit = frame * 0.035 + Math.PI;
          return (
            <AbsoluteFill style={{ opacity: o }}>
              <div style={{ position: "absolute", left: 400, top: 340 }}>
                <Brain scale={brainS} opacity={brainS} />
              </div>
              <div style={{ position: "absolute", left: 350, top: 260, opacity: labelT, fontSize: 14, fontWeight: 800, color: ORANGE, fontFamily: "sans-serif", letterSpacing: 2 }}>EMOTIONALLY STICKY</div>
              <MythBubble x={280} y={180} s={bubbleT} pulse={pulse} label="MYTH" />
              <MythBubble x={520} y={160} s={interpolate(frame, [50, 110], [0, 1], { ...clamp, easing: ease })} pulse={pulse} label="MYTH" />
              <MythBubble x={400} y={120} s={interpolate(frame, [70, 130], [0, 1], { ...clamp, easing: ease })} pulse={pulse} label="MYTH" />
              {bubbleT > 0.5 && (
                <svg style={{ position: "absolute", left: 300, top: 200, opacity: bubbleT * 0.4 }} width={300} height={200}>
                  <line x1={80} y1={100} x2={150} y2={160} stroke={ORANGE} strokeWidth={1} strokeDasharray="4 4" />
                  <line x1={200} y1={80} x2={160} y2={160} stroke={ORANGE} strokeWidth={1} strokeDasharray="4 4" />
                </svg>
              )}
              <div style={{ position: "absolute", left: 440 + Math.cos(heartOrbit) * 80, top: 200 + Math.sin(heartOrbit) * 40, opacity: bubbleT, fontSize: 22 }}>❤️</div>
              <div style={{ position: "absolute", left: 440 + Math.cos(exclOrbit) * 90, top: 220 + Math.sin(exclOrbit) * 50, opacity: bubbleT, fontSize: 20 }}>❗</div>
              <div style={{ position: "absolute", left: 620, top: 310, opacity: vsT, fontSize: 48, fontWeight: 900, color: DARK, fontFamily: "sans-serif" }}>vs</div>
              <div style={{ position: "absolute", left: 750, top: 330 }}>
                <TruthBubble opacity={truthT} s={0.8} />
              </div>
            </AbsoluteFill>
          );
        })()}
      </Sequence>

      <Sequence from={s1End} durationInFrames={s2End - s1End}>
        {(() => {
          const lf = frame - s1End;
          const o = fadeScene(s1End, s2End);
          const figuresIn = interpolate(lf, [0, 40], [0, 1], { ...clamp, easing: ease });
          const glassIn = interpolate(lf, [50, 100], [0, 1], { ...clamp, easing: ease });
          const monsterS = interpolate(lf, [100, 160], [0, 1.2], { ...clamp, easing: ease });
          const isolate = interpolate(lf, [160, 220], [1, 0.4], { ...clamp, easing: easeIn });
          const breakProg = interpolate(lf, [180, 240], [0, 1], clamp);
          const figPositions = [[-80, 0], [-40, -50], [40, -50], [80, 0], [-60, 50], [60, 50]];
          return (
            <AbsoluteFill style={{ opacity: o }}>
              <div style={{ position: "absolute", left: 480, top: 500, opacity: figuresIn }}>
                <StickFigure color={CYAN} size={36} />
              </div>
              {figPositions.map((p, i) => {
                const lineOp = interpolate(breakProg, [i * 0.15, i * 0.15 + 0.2], [0.6, 0], clamp);
                return (
                  <React.Fragment key={i}>
                    <div style={{ position: "absolute", left: 480 + p[0] * 2.5, top: 500 + p[1] * 2, opacity: figuresIn }}>
                      <StickFigure color={GREY} size={28} />
                    </div>
                    <svg style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }} width={1920} height={1080}>
                      <line x1={498} y1={530} x2={498 + p[0] * 2.5} y2={530 + p[1] * 2} stroke={TEAL} strokeWidth={1.5} opacity={lineOp} strokeDasharray="4 3" />
                    </svg>
                  </React.Fragment>
                );
              })}
              <svg style={{ position: "absolute", left: 430, top: 440, opacity: isolate, transform: `scale(${isolate})` }} width={140} height={140}>
                <circle cx={70} cy={70} r={65} fill="none" stroke={CYAN} strokeWidth={2} strokeDasharray="8 4" opacity={0.5} />
              </svg>
              <div style={{ position: "absolute", left: 700, top: 200, transform: `scale(${glassIn})`, opacity: glassIn }}>
                <svg width={120} height={120} viewBox="0 0 120 120">
                  <circle cx={50} cy={50} r={35} fill="none" stroke={DARK} strokeWidth={4} />
                  <line x1={75} y1={75} x2={110} y2={110} stroke={DARK} strokeWidth={5} strokeLinecap="round" />
                </svg>
              </div>
              <div style={{ position: "absolute", left: 850, top: 280, transform: `scale(${monsterS})`, opacity: Math.min(monsterS, 1) }}>
                <svg width={100} height={90} viewBox="0 0 100 90">
                  <ellipse cx={50} cy={50} rx={45} ry={38} fill={RED} opacity={0.85} />
                  <circle cx={35} cy={40} r={6} fill={WHITE} /><circle cx={35} cy={42} r={3} fill={DARK} />
                  <circle cx={65} cy={40} r={6} fill={WHITE} /><circle cx={65} cy={42} r={3} fill={DARK} />
                  <polygon points="25,65 35,55 45,65 55,55 65,65 75,55 85,65" fill={WHITE} />
                </svg>
              </div>
              {monsterS > 0.5 && (
                <svg style={{ position: "absolute", left: 0, top: 0 }} width={1920} height={1080}>
                  <line x1={850} y1={340} x2={550} y2={500} stroke={RED} strokeWidth={2} opacity={monsterS * 0.6} markerEnd="" />
                  <polygon points={`550,495 560,505 540,505`} fill={RED} opacity={monsterS * 0.6} />
                </svg>
              )}
            </AbsoluteFill>
          );
        })()}
      </Sequence>

      <Sequence from={s2End} durationInFrames={s3End - s2End}>
        {(() => {
          const lf = frame - s2End;
          const o = fadeScene(s2End, s3End);
          const bannerX = interpolate(lf, [0, 40], [-1920, 0], { ...clamp, easing: ease });
          const bannerOp = interpolate(lf, [0, 30], [0, 1], clamp);
          const gaugeIn = interpolate(lf, [50, 90], [0, 1], { ...clamp, easing: ease });
          const needleAngle = interpolate(lf, [90, 140], [-90, -65], { ...clamp, easing: Easing.bezier(0.34, 1.56, 0.64, 1) });
          const card1 = interpolate(lf, [130, 160], [0, 1], { ...clamp, easing: ease });
          const card2 = interpolate(lf, [160, 190], [0, 1], { ...clamp, easing: ease });
          const card3 = interpolate(lf, [190, 220], [0, 1], { ...clamp, easing: ease });
          const renderCard = (x: number, prog: number, icon: string, label: string) => (
            <div style={{ position: "absolute", left: x, top: 580, width: 260, height: 160, backgroundColor: WHITE, borderRadius: 16, boxShadow: "0 4px 20px rgba(0,0,0,0.08)", border: `2px solid ${LIGHT_GREY}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", transform: `rotateY(${interpolate(prog, [0, 1], [90, 0])}deg)`, opacity: prog, perspective: 800 }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>{icon}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: DARK, fontFamily: "sans-serif", letterSpacing: 1 }}>{label}</div>
            </div>
          );
          return (
            <AbsoluteFill style={{ opacity: o }}>
              <div style={{ position: "absolute", left: 0, top: 100, width: 1920, height: 70, backgroundColor: GREEN, transform: `translateX(${bannerX}px)`, opacity: bannerOp, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 28, fontWeight: 900, color: WHITE, fontFamily: "sans-serif", letterSpacing: 4 }}>THE SOBERING REALITY</span>
              </div>
              <div style={{ position: "absolute", left: 560, top: 220, opacity: gaugeIn }}>
                <svg width={800} height={260} viewBox="0 0 800 260">
                  <defs>
                    <linearGradient id="gaugeFill" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor={GREEN} />
                      <stop offset="50%" stopColor={YELLOW} />
                      <stop offset="100%" stopColor={RED} />
                    </linearGradient>
                  </defs>
                  <path d="M 100 220 A 300 300 0 0 1 700 220" fill="none" stroke={LIGHT_GREY} strokeWidth={30} strokeLinecap="round" />
                  <path d="M 100 220 A 300 300 0 0 1 700 220" fill="none" stroke="url(#gaugeFill)" strokeWidth={24} strokeLinecap="round" opacity={0.8} />
                  <text x={100} y={250} fill={GREEN} fontSize={13} fontWeight={700} fontFamily="sans-serif">NO RISK</text>
                  <text x={650} y={250} fill={RED} fontSize={13} fontWeight={700} fontFamily="sans-serif">HIGH RISK</text>
                  <g transform={`rotate(${needleAngle} 400 220)`}>
                    <line x1={400} y1={220} x2={400} y2={40} stroke={DARK} strokeWidth={4} strokeLinecap="round" />
                    <circle cx={400} cy={220} r={10} fill={DARK} />
                  </g>
                  <rect x={140} y={180} width={120} height={26} rx={6} fill={GREEN} opacity={0.2} />
                  <text x={155} y={198} fill={GREEN} fontSize={13} fontWeight={800} fontFamily="sans-serif">LOW STAKES</text>
                </svg>
              </div>
              {renderCard(370, card1, "👋✕", "NORMAL")}
              {renderCard(660, card2, "💓〰️", "SURVIVABLE")}
              {renderCard(950, card3, "👍😊", "HUMAN")}
            </AbsoluteFill>
          );
        })()}
      </Sequence>

      <Sequence from={s3End} durationInFrames={900 - s3End}>
        {(() => {
          const lf = frame - s3End;
          const o = interpolate(lf, [0, 20], [0, 1], clamp);
          const badgeS = interpolate(lf, [10, 50], [0, 1], { ...clamp, easing: Easing.bezier(0.34, 1.56, 0.64, 1) });
          const checkDraw = interpolate(lf, [50, 80], [0, 1], clamp);
          const netOp = interpolate(lf, [60, 100], [0, 0.7], clamp);
          const confettiStart = 80;
          const confettiColors = [YELLOW, TEAL, WHITE, CYAN, GREEN, PURPLE];
          const confetti = Array.from({ length: 30 }).map((_, i) => {
            const seed = i * 137.5;
            const x = (seed * 7.3) % 1920;
            const speed = 1.2 + (i % 5) * 0.4;
            const yOff = interpolate(lf, [confettiStart, confettiStart + 200], [-(i % 4) * 80, 1200], clamp);
            const rot = lf * speed * 2;
            return { x, y: yOff - 100, rot, color: confettiColors[i % confettiColors.length], size: 6 + (i % 4) * 3 };
          });
          const netNodes = [[960, 300], [760, 400], [1160, 400], [860, 550], [1060, 550], [700, 600], [1220, 600], [800, 700], [1120, 700]];
          return (
            <AbsoluteFill style={{ opacity: o }}>
              {confetti.map((c, i) => {
                const cOp = interpolate(lf, [confettiStart, confettiStart + 30], [0, 0.8], clamp);
                return <div key={i} style={{ position: "absolute", left: c.x, top: c.y, width: c.size, height: c.size * 0.6, backgroundColor: c.color, borderRadius: 2, transform: `rotate(${c.rot}deg)`, opacity: cOp }} />;
              })}
              <svg style={{ position: "absolute", left: 0, top: 0, opacity: netOp }} width={1920} height={1080}>
                {netNodes.map((n, i) => netNodes.slice(i + 1).filter((_, j) => (i + j) % 2 === 0).map((m, j) => (
                  <line key={`${i}-${j}`} x1={n[0]} y1={n[1]} x2={m[0]} y2={m[1]} stroke={TEAL} strokeWidth={1} strokeDasharray="5 5" opacity={0.5} />
                )))}
                {netNodes.map((n, i) => <circle key={i} cx={n[0]} cy={n[1]} r={4} fill={CYAN} />)}
              </svg>
              {netNodes.map((n, i) => (
                <div key={i} style={{ position: "absolute", left: n[0] - 12, top: n[1] - 18, opacity: netOp }}>
                  <StickFigure color={TEAL} size={20} />
                </div>
              ))}
              <div style={{ position: "absolute", left: 960 - 150, top: 400, width: 300, height: 300, borderRadius: "50%", backgroundColor: GREEN, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", transform: `scale(${badgeS})`, boxShadow: "0 8px 40px rgba(16,185,129,0.3)" }}>
                <svg width={60} height={50} viewBox="0 0 60 50" style={{ marginBottom: 10 }}>
                  <polyline points="10,28 24,42 50,10" fill="none" stroke={WHITE} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={60} strokeDashoffset={interpolate(checkDraw, [0, 1], [60, 0])} />
                </svg>
                <div style={{ fontSize: 22, fontWeight: 900, color: WHITE, fontFamily: "sans-serif", textAlign: "center", lineHeight: 1.3, letterSpacing: 1, padding: "0 20px" }}>ENTIRELY SURVIVABLE</div>
              </div>
            </AbsoluteFill>
          );
        })()}
      </Sequence>
    </AbsoluteFill>
  );
};