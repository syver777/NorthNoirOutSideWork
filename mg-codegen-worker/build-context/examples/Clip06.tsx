import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  Sequence,
} from "remotion";

export const Clip06: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const ease = Easing.bezier(0.16, 1, 0.3, 1);
  const easeIn = Easing.bezier(0.45, 0, 0.55, 1);

  return (
    <AbsoluteFill style={{ backgroundColor: "#F0F4F8" }}>
      {/* Subtle geometric background */}
      <AbsoluteFill>
        {[...Array(12)].map((_, i) => {
          const x = (i % 4) * 320 + 100;
          const y = Math.floor(i / 4) * 300 + 80;
          const rot = interpolate(frame, [0, 1260], [0, 360 * (i % 2 === 0 ? 1 : -1)]);
          const op = interpolate(frame, [0, 60], [0, 0.06], { extrapolateRight: "clamp" });
          return (
            <div key={i} style={{
              position: "absolute", left: x, top: y, width: 80, height: 80,
              border: `2px solid rgba(0,180,180,${op})`,
              borderRadius: i % 3 === 0 ? "50%" : i % 3 === 1 ? "8px" : "0",
              transform: `rotate(${rot}deg)`,
            }} />
          );
        })}
      </AbsoluteFill>

      {/* SECTION 1: Brain with Fear & Shield (0 - 8s) */}
      <Sequence durationInFrames={8 * fps}>
        <BrainSection fps={fps} ease={ease} />
      </Sequence>

      {/* SECTION 2: Split screen comparison (8s - 18s) */}
      <Sequence from={8 * fps} durationInFrames={10 * fps}>
        <SplitSection fps={fps} ease={ease} />
      </Sequence>

      {/* SECTION 3: Timeline pathway (18s - 30s) */}
      <Sequence from={18 * fps} durationInFrames={12 * fps}>
        <TimelineSection fps={fps} ease={ease} easeIn={easeIn} />
      </Sequence>

      {/* SECTION 4: Checklist (30s - 42s) */}
      <Sequence from={30 * fps} durationInFrames={12 * fps}>
        <ChecklistSection fps={fps} ease={ease} />
      </Sequence>
    </AbsoluteFill>
  );
};

const BrainSection: React.FC<{ fps: number; ease: (t: number) => number }> = ({ fps, ease }) => {
  const frame = useCurrentFrame();

  const brainScale = interpolate(frame, [0, 40], [0.3, 1], { extrapolateRight: "clamp", easing: ease });
  const brainOp = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  const fearOp = interpolate(frame, [50, 70], [0, 1], { extrapolateRight: "clamp" });
  const fearPulse = 1 + 0.08 * Math.sin(frame * 0.15);
  const shieldX = interpolate(frame, [120, 170], [400, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const shieldOp = interpolate(frame, [120, 150], [0, 1], { extrapolateRight: "clamp" });
  const fearFade = interpolate(frame, [160, 190], [1, 0.15], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ position: "relative", transform: `scale(${brainScale})`, opacity: brainOp }}>
        <svg width="280" height="240" viewBox="0 0 280 240">
          <ellipse cx="100" cy="120" rx="70" ry="90" fill="#E0F2F1" stroke="#00B4B4" strokeWidth="3" />
          <ellipse cx="180" cy="120" rx="70" ry="90" fill="#E0F2F1" stroke="#00B4B4" strokeWidth="3" />
          <path d="M100 40 Q140 20 180 40" fill="none" stroke="#00B4B4" strokeWidth="2.5" />
          <path d="M80 80 Q140 60 200 80" fill="none" stroke="#00B4B4" strokeWidth="2" opacity="0.5" />
          <path d="M85 140 Q140 120 195 140" fill="none" stroke="#00B4B4" strokeWidth="2" opacity="0.5" />
          <line x1="140" y1="50" x2="140" y2="210" stroke="#00B4B4" strokeWidth="2" opacity="0.4" />
        </svg>

        {/* Fear label */}
        <div style={{
          position: "absolute", top: "50%", left: "50%",
          transform: `translate(-50%, -50%) scale(${fearPulse})`,
          opacity: fearOp * fearFade,
          backgroundColor: "rgba(239,68,68,0.15)", borderRadius: 12,
          padding: "8px 20px", border: "2px solid #EF4444",
        }}>
          <span style={{ color: "#EF4444", fontWeight: 800, fontSize: 18, fontFamily: "sans-serif", letterSpacing: 1 }}>
            FEAR OF REJECTION
          </span>
        </div>

        {/* Shield */}
        <div style={{
          position: "absolute", top: "50%", left: "50%",
          transform: `translate(calc(-50% + ${shieldX}px), -55%)`,
          opacity: shieldOp,
        }}>
          <svg width="160" height="180" viewBox="0 0 160 180">
            <path d="M80 10 L150 50 L140 140 Q80 175 20 140 L10 50 Z"
              fill="rgba(0,180,180,0.2)" stroke="#00B4B4" strokeWidth="3.5" />
            <path d="M80 30 L130 58 L122 128 Q80 155 38 128 L30 58 Z"
              fill="rgba(0,180,180,0.1)" stroke="#00B4B4" strokeWidth="1.5" />
            <polygon points="70,75 80,60 90,75 85,75 85,110 75,110 75,75" fill="#00B4B4" />
            <rect x="65" y="100" width="30" height="8" rx="2" fill="#00B4B4" />
          </svg>
          <div style={{
            position: "absolute", bottom: -30, left: "50%", transform: "translateX(-50%)",
            whiteSpace: "nowrap", color: "#00897B", fontWeight: 800, fontSize: 15,
            fontFamily: "sans-serif", letterSpacing: 1.5,
          }}>
            ADVANCE PREPARATION
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const SplitSection: React.FC<{ fps: number; ease: (t: number) => number }> = ({ fps, ease }) => {
  const frame = useCurrentFrame();

  const dividerX = interpolate(frame, [0, 40], [1920, 960], { extrapolateRight: "clamp", easing: ease });
  const leftOp = interpolate(frame, [20, 50], [0, 1], { extrapolateRight: "clamp" });
  const rightOp = interpolate(frame, [60, 90], [0, 1], { extrapolateRight: "clamp" });
  const boltShake = frame > 80 && frame < 130 ? Math.sin(frame * 2.5) * 6 : 0;
  const boltOp = interpolate(frame, [80, 95], [0, 1], { extrapolateRight: "clamp" });
  const rightBoltBounce = interpolate(frame, [150, 180], [0, 1], { extrapolateRight: "clamp", easing: ease });
  const rightBoltX = interpolate(rightBoltBounce, [0, 0.5, 1], [0, -10, 60]);
  const rightBoltRot = interpolate(rightBoltBounce, [0, 1], [0, 45]);
  const greenOp = interpolate(frame, [190, 220], [0, 1], { extrapolateRight: "clamp" });

  const figureStyle = (color: string): React.CSSProperties => ({
    width: 50, height: 100, display: "flex", flexDirection: "column", alignItems: "center",
  });

  return (
    <AbsoluteFill>
      {/* Divider */}
      <div style={{
        position: "absolute", left: dividerX, top: 120, width: 3, height: 840,
        background: "linear-gradient(180deg, transparent, #CBD5E1, transparent)",
      }} />

      {/* LEFT side */}
      <div style={{
        position: "absolute", left: 80, top: 160, width: 800, height: 760,
        opacity: leftOp, transform: `translateX(${boltShake}px)`,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: "#64748B", fontFamily: "sans-serif", marginBottom: 40, letterSpacing: 1 }}>
          WITHOUT PREPARATION
        </div>
        <div style={figureStyle("#64748B")}>
          <svg width="60" height="120" viewBox="0 0 60 120">
            <circle cx="30" cy="18" r="16" fill="#94A3B8" />
            <rect x="18" y="38" width="24" height="45" rx="8" fill="#94A3B8" />
            <rect x="10" y="85" width="14" height="30" rx="5" fill="#94A3B8" />
            <rect x="36" y="85" width="14" height="30" rx="5" fill="#94A3B8" />
          </svg>
        </div>
        <div style={{
          marginTop: 30, padding: "14px 28px", backgroundColor: "#F1F5F9",
          borderRadius: 12, border: "2px solid #94A3B8", fontSize: 18, fontWeight: 700,
          color: "#475569", fontFamily: "sans-serif",
        }}>
          Social Scenario
        </div>
        {/* Lightning bolt */}
        <svg width="80" height="100" viewBox="0 0 80 100" style={{ marginTop: 20, opacity: boltOp }}>
          <polygon points="45,0 15,45 35,45 25,100 65,40 40,40" fill="#EF4444" />
        </svg>
        <div style={{
          marginTop: 10, color: "#EF4444", fontWeight: 800, fontSize: 20,
          fontFamily: "sans-serif", letterSpacing: 2, opacity: boltOp,
        }}>
          AMBUSH
        </div>
      </div>

      {/* RIGHT side */}
      <div style={{
        position: "absolute", right: 80, top: 160, width: 800, height: 760,
        opacity: rightOp,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: "#00897B", fontFamily: "sans-serif", marginBottom: 40, letterSpacing: 1 }}>
          WITH PREPARATION
        </div>
        <div style={{ position: "relative" }}>
          <svg width="60" height="120" viewBox="0 0 60 120">
            <circle cx="30" cy="18" r="16" fill="#00B4B4" />
            <rect x="18" y="38" width="24" height="45" rx="8" fill="#00B4B4" />
            <rect x="10" y="85" width="14" height="30" rx="5" fill="#00B4B4" />
            <rect x="36" y="85" width="14" height="30" rx="5" fill="#00B4B4" />
          </svg>
          <svg width="40" height="50" viewBox="0 0 40 50" style={{ position: "absolute", left: -30, top: 20 }}>
            <path d="M20 2 L38 15 L35 42 Q20 50 5 42 L2 15 Z" fill="rgba(0,180,180,0.3)" stroke="#00B4B4" strokeWidth="2" />
          </svg>
        </div>
        <div style={{
          marginTop: 30, padding: "14px 28px", backgroundColor: "#F1F5F9",
          borderRadius: 12, border: "2px solid #94A3B8", fontSize: 18, fontWeight: 700,
          color: "#475569", fontFamily: "sans-serif",
        }}>
          Social Scenario
        </div>
        {/* Bouncing bolt */}
        <svg width="80" height="100" viewBox="0 0 80 100" style={{
          marginTop: 20, opacity: rightBoltBounce > 0 ? 0.5 : 0,
          transform: `translateX(${rightBoltX}px) rotate(${rightBoltRot}deg)`,
        }}>
          <polygon points="45,0 15,45 35,45 25,100 65,40 40,40" fill="#CBD5E1" />
        </svg>
        <div style={{
          marginTop: 10, color: "#10B981", fontWeight: 800, fontSize: 20,
          fontFamily: "sans-serif", letterSpacing: 1.5, opacity: greenOp,
        }}>
          MANAGEABLE OUTCOME
        </div>
      </div>
    </AbsoluteFill>
  );
};

const TimelineSection: React.FC<{ fps: number; ease: (t: number) => number; easeIn: (t: number) => number }> = ({ fps, ease }) => {
  const frame = useCurrentFrame();

  const pathOp = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  const milestones = [
    { label: "Before You Ask", icon: "question", color: "#F97316", activateAt: 60 },
    { label: "Expect a No", icon: "check", color: "#EAB308", activateAt: 130 },
    { label: "Mentally Prepared", icon: "thumb", color: "#00B4B4", activateAt: 200 },
  ];

  const pathGlow = (idx: number) => {
    const m = milestones[idx];
    return interpolate(frame, [m.activateAt, m.activateAt + 30], [0, 1], {
      extrapolateLeft: "clamp", extrapolateRight: "clamp",
    });
  };

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ opacity: pathOp, width: 1400, position: "relative" }}>
        {/* Title */}
        <div style={{
          textAlign: "center", fontSize: 36, fontWeight: 800, color: "#1E293B",
          fontFamily: "sans-serif", marginBottom: 80, letterSpacing: 1,
          opacity: interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" }),
          transform: `translateY(${interpolate(frame, [0, 30], [20, 0], { extrapolateRight: "clamp", easing: ease })}px)`,
        }}>
          THE PATH TO REDUCED FEAR
        </div>

        {/* Dotted path */}
        <svg width="1400" height="12" style={{ position: "absolute", top: 200 }}>
          {[...Array(70)].map((_, i) => {
            const segIdx = i < 23 ? 0 : i < 46 ? 1 : 2;
            const glow = pathGlow(segIdx);
            return (
              <circle key={i} cx={i * 20 + 10} cy={6} r={3}
                fill={interpolate(glow, [0, 1], [0, 1]) > 0.5 ? milestones[segIdx].color : "#CBD5E1"}
                opacity={interpolate(glow, [0, 1], [0.4, 1])}
              />
            );
          })}
        </svg>

        {/* Milestones */}
        {milestones.map((m, i) => {
          const prog = interpolate(frame, [m.activateAt, m.activateAt + 40], [0, 1], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease,
          });
          const x = 140 + i * 500;
          return (
            <div key={i} style={{
              position: "absolute", top: 120, left: x, width: 200,
              display: "flex", flexDirection: "column", alignItems: "center",
              opacity: prog, transform: `scale(${interpolate(prog, [0, 1], [0.6, 1])})`,
            }}>
              <div style={{
                width: 80, height: 80, borderRadius: "50%",
                backgroundColor: m.color + "22", border: `3px solid ${m.color}`,
                display: "flex", justifyContent: "center", alignItems: "center",
              }}>
                {m.icon === "question" && (
                  <svg width="36" height="36" viewBox="0 0 36 36">
                    <rect x="2" y="2" width="32" height="28" rx="6" fill="none" stroke={m.color} strokeWidth="2.5" />
                    <text x="18" y="24" textAnchor="middle" fill={m.color} fontSize="22" fontWeight="800" fontFamily="sans-serif">?</text>
                  </svg>
                )}
                {m.icon === "check" && (
                  <svg width="36" height="36" viewBox="0 0 36 36">
                    <circle cx="18" cy="18" r="15" fill="none" stroke={m.color} strokeWidth="2.5" />
                    <polyline points="11,18 16,24 26,13" fill="none" stroke={m.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {m.icon === "thumb" && (
                  <svg width="36" height="36" viewBox="0 0 36 36">
                    <path d="M10 20 L10 30 L16 30 L16 20 Z" fill={m.color} />
                    <path d="M16 22 Q16 12 22 8 L24 8 Q23 14 24 16 L30 16 Q32 16 32 18 L31 28 Q31 30 29 30 L16 30" fill={m.color} opacity="0.8" />
                  </svg>
                )}
              </div>
              <div style={{
                marginTop: 20, fontSize: 18, fontWeight: 700, color: m.color,
                fontFamily: "sans-serif", textAlign: "center",
              }}>
                {m.label}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const ChecklistSection: React.FC<{ fps: number; ease: (t: number) => number }> = ({ fps, ease }) => {
  const frame = useCurrentFrame();

  const items = [
    { text: "Acknowledge rejection as possible", color: "#F97316", delay: 30 },
    { text: "Accept it as normal", color: "#EAB308", delay: 90 },
    { text: "Build a simple response plan", color: "#00B4B4", delay: 150 },
    { text: "WHEN_IF", color: "#F87171", delay: 210 },
  ];

  const titleOp = interpolate(frame, [0, 25], [0, 1], { extrapolateRight: "clamp" });
  const titleY = interpolate(frame, [0, 25], [30, 0], { extrapolateRight: "clamp", easing: ease });

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ width: 900 }}>
        <div style={{
          fontSize: 36, fontWeight: 800, color: "#1E293B", fontFamily: "sans-serif",
          textAlign: "center", marginBottom: 60, letterSpacing: 1,
          opacity: titleOp, transform: `translateY(${titleY}px)`,
        }}>
          YOUR PREPARATION CHECKLIST
        </div>

        {items.map((item, i) => {
          const prog = interpolate(frame, [item.delay, item.delay + 35], [0, 1], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease,
          });
          const checkProg = interpolate(frame, [item.delay + 20, item.delay + 45], [0, 1], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease,
          });
          const isLast = i === 3;

          return (
            <div key={i} style={{
              display: "flex", alignItems: "center", marginBottom: 32,
              opacity: prog, transform: `translateX(${interpolate(prog, [0, 1], [-40, 0])}px)`,
            }}>
              <div style={{ marginRight: 10, fontSize: 16, fontWeight: 700, color: "#94A3B8", fontFamily: "sans-serif", width: 60 }}>
                Step {i + 1}
              </div>
              {/* Checkbox */}
              <div style={{
                width: 44, height: 44, borderRadius: 10, marginRight: 24,
                border: `3px solid ${item.color}`,
                backgroundColor: interpolate(checkProg, [0, 1], [0, 0.2]) > 0.1 ? item.color + "33" : "transparent",
                display: "flex", justifyContent: "center", alignItems: "center",
                position: "relative", overflow: "hidden",
              }}>
                <div style={{
                  position: "absolute", bottom: 0, left: 0, width: "100%",
                  height: `${checkProg * 100}%`, backgroundColor: item.color + "44",
                }} />
                <svg width="24" height="24" viewBox="0 0 24 24" style={{ opacity: checkProg, transform: `scale(${interpolate(checkProg, [0, 0.5, 1], [0.3, 1.2, 1])})` }}>
                  <polyline points="4,12 10,18 20,6" fill="none" stroke={item.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              {/* Text */}
              {!isLast ? (
                <span style={{ fontSize: 22, fontWeight: 600, color: "#334155", fontFamily: "sans-serif" }}>
                  {item.text}
                </span>
              ) : (
                <span style={{ fontSize: 22, fontWeight: 600, color: "#334155", fontFamily: "sans-serif" }}>
                  Ask{" "}
                  <span style={{
                    fontSize: 30, fontWeight: 900, color: "#00B4B4",
                    transform: `scale(${interpolate(frame, [item.delay + 40, item.delay + 55], [0.8, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease })})`,
                    display: "inline-block",
                  }}>
                    WHEN
                  </span>
                  {" "}not{" "}
                  <span style={{ position: "relative", display: "inline-block" }}>
                    <span style={{ color: "#94A3B8", fontSize: 22 }}>IF</span>
                    <div style={{
                      position: "absolute", top: "50%", left: -4, right: -4, height: 3,
                      backgroundColor: "#EF4444", transform: "translateY(-50%)",
                      width: `${interpolate(frame, [item.delay + 50, item.delay + 65], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}%`,
                    }} />
                  </span>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};