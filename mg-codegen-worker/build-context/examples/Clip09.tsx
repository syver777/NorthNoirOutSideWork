import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  Sequence,
} from "remotion";

export const Clip09: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const ease = Easing.bezier(0.16, 1, 0.3, 1);
  const easeIn = Easing.bezier(0.45, 0, 1, 1);

  return (
    <AbsoluteFill style={{ backgroundColor: "#F5F3EE" }}>
      {/* SCENE 1: Self-Worth Pillar (0-8s) */}
      <Sequence durationInFrames={8 * fps}>
        <AbsoluteFill>
          <Scene1Pillars frame={frame} fps={fps} ease={ease} easeIn={easeIn} />
        </AbsoluteFill>
      </Sequence>

      {/* SCENE 2: NO → Data Point (8-18s) */}
      <Sequence from={8 * fps} durationInFrames={10 * fps}>
        <AbsoluteFill>
          <Scene2Rejection frame={frame - 8 * fps} fps={fps} ease={ease} />
        </AbsoluteFill>
      </Sequence>

      {/* SCENE 3: Confidence Gauge (18-26s) */}
      <Sequence from={18 * fps} durationInFrames={8 * fps}>
        <AbsoluteFill>
          <Scene3Gauge frame={frame - 18 * fps} fps={fps} ease={ease} />
        </AbsoluteFill>
      </Sequence>

      {/* SCENE 4: Bridge & Alliance (26-40s) */}
      <Sequence from={26 * fps} durationInFrames={14 * fps}>
        <AbsoluteFill>
          <Scene4Bridge frame={frame - 26 * fps} fps={fps} ease={ease} easeIn={easeIn} />
        </AbsoluteFill>
      </Sequence>

      {/* SCENE 5: Heart & Finale (40-49.6s) */}
      <Sequence from={40 * fps} durationInFrames={Math.ceil(9.6 * fps)}>
        <AbsoluteFill>
          <Scene5Finale frame={frame - 40 * fps} fps={fps} ease={ease} />
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
};

const Scene1Pillars: React.FC<{ frame: number; fps: number; ease: (t: number) => number; easeIn: (t: number) => number }> = ({ frame, fps, ease, easeIn }) => {
  const pillarH = interpolate(frame, [0, 2 * fps], [0, 320], { extrapolateRight: "clamp", easing: ease });
  const glow = interpolate(frame, [1.5 * fps, 3 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const titleOp = interpolate(frame, [2 * fps, 3 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const wobblyPillars = [
    { label: "External\nValidation", x: 200, delay: 0.5 },
    { label: "Others'\nApproval", x: 380, delay: 0.8 },
    { label: "Social\nStatus", x: 1140, delay: 0.6 },
    { label: "Peer\nPressure", x: 1320, delay: 1.0 },
  ];

  return (
    <AbsoluteFill style={{ backgroundColor: "#F5F3EE" }}>
      {/* Title */}
      <div style={{ position: "absolute", top: 50, width: "100%", textAlign: "center", opacity: titleOp, transform: `translateY(${interpolate(titleOp, [0, 1], [20, 0])}px)` }}>
        <span style={{ fontFamily: "sans-serif", fontWeight: 800, fontSize: 42, color: "#1A1A2E", letterSpacing: -1 }}>FOUNDATIONS OF SELF-WORTH</span>
      </div>

      {/* Wobbly pillars that fade */}
      {wobblyPillars.map((p, i) => {
        const appear = interpolate(frame, [p.delay * fps, (p.delay + 1) * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
        const fadeOut = interpolate(frame, [4 * fps, 6 * fps], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeIn });
        const wobble = Math.sin(frame * 0.08 + i * 2) * 3;
        const h = 100 + i * 30;
        return (
          <div key={i} style={{ position: "absolute", bottom: 200, left: p.x - 30, opacity: appear * fadeOut, transform: `rotate(${wobble}deg)` }}>
            <div style={{ width: 60, height: h * appear, backgroundColor: "#D4D0C8", borderRadius: 6, border: "2px solid #B8B4AC" }} />
            <div style={{ marginTop: 8, textAlign: "center", fontFamily: "sans-serif", fontSize: 11, color: "#888", fontWeight: 600, whiteSpace: "pre-line", lineHeight: 1.2 }}>{p.label}</div>
          </div>
        );
      })}

      {/* Central golden pillar */}
      <div style={{ position: "absolute", bottom: 200, left: "50%", transform: "translateX(-50%)" }}>
        <div style={{
          width: 90, height: pillarH, borderRadius: 8,
          background: `linear-gradient(180deg, #FFD700 0%, #F5A623 50%, #E8912D 100%)`,
          boxShadow: `0 0 ${40 * glow}px ${20 * glow}px rgba(255,215,0,${0.4 * glow})`,
          position: "relative",
        }}>
          <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%) rotate(-90deg)", fontFamily: "sans-serif", fontWeight: 900, fontSize: 16, color: "#fff", letterSpacing: 3, whiteSpace: "nowrap", textShadow: "0 1px 4px rgba(0,0,0,0.3)" }}>SELF-WORTH</div>
        </div>
        {/* Foundation */}
        <div style={{ width: 140, height: 20, backgroundColor: "#4A4A5A", borderRadius: 4, marginLeft: -25, marginTop: 0 }} />
        <div style={{ textAlign: "center", marginTop: 10, fontFamily: "sans-serif", fontWeight: 700, fontSize: 14, color: "#4A4A5A" }}>Independent Foundation</div>
      </div>

      {/* Callout text */}
      {frame > 5 * fps && (
        <div style={{
          position: "absolute", bottom: 100, width: "100%", textAlign: "center",
          opacity: interpolate(frame, [5 * fps, 6 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          transform: `translateY(${interpolate(frame, [5 * fps, 6 * fps], [15, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px)`,
        }}>
          <span style={{ fontFamily: "sans-serif", fontWeight: 700, fontSize: 22, color: "#E8912D", padding: "8px 20px", backgroundColor: "rgba(255,215,0,0.12)", borderRadius: 8 }}>
            Identity stands on its own foundations
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};

const Scene2Rejection: React.FC<{ frame: number; fps: number; ease: (t: number) => number }> = ({ frame, fps, ease }) => {
  const stampScale = interpolate(frame, [0.5 * fps, 1 * fps], [4, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const stampOp = interpolate(frame, [0.3 * fps, 0.8 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const shrink = interpolate(frame, [3 * fps, 5 * fps], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const dotAppear = interpolate(frame, [4.5 * fps, 5.5 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const chartOp = interpolate(frame, [3 * fps, 4.5 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });

  const dots = [
    { x: 180, y: 120 }, { x: 320, y: 200 }, { x: 420, y: 80 }, { x: 250, y: 280 },
    { x: 500, y: 160 }, { x: 380, y: 320 }, { x: 150, y: 220 }, { x: 550, y: 260 },
    { x: 480, y: 100 }, { x: 220, y: 350 }, { x: 600, y: 300 }, { x: 340, y: 140 },
  ];

  const titleOp = interpolate(frame, [0, 1 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: "#F5F3EE", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", top: 50, width: "100%", textAlign: "center", opacity: titleOp }}>
        <span style={{ fontFamily: "sans-serif", fontWeight: 800, fontSize: 38, color: "#1A1A2E" }}>REFRAMING REJECTION</span>
      </div>

      {/* Stamp NO */}
      {shrink > 0.01 && (
        <div style={{
          position: "absolute", top: "40%", left: "50%",
          transform: `translate(-50%,-50%) scale(${stampScale * shrink})`,
          opacity: stampOp * shrink,
          fontFamily: "sans-serif", fontWeight: 900, fontSize: 120,
          color: interpolate(frame, [3 * fps, 5 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) > 0.5 ? "#5B8DEF" : "#E74C3C",
          border: `6px solid ${interpolate(frame, [3 * fps, 5 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) > 0.5 ? "#5B8DEF" : "#E74C3C"}`,
          padding: "4px 30px", borderRadius: 12,
          transform: `translate(-50%,-50%) scale(${stampScale * shrink}) rotate(-12deg)`,
        }}>NO</div>
      )}

      {/* Scatter chart */}
      <div style={{ position: "absolute", top: 140, left: 280, opacity: chartOp }}>
        <svg width={700} height={420} viewBox="0 0 700 420">
          <line x1={60} y1={380} x2={660} y2={380} stroke="#CCC" strokeWidth={2} />
          <line x1={60} y1={380} x2={60} y2={20} stroke="#CCC" strokeWidth={2} />
          <text x={360} y={415} textAnchor="middle" fontFamily="sans-serif" fontWeight={700} fontSize={14} fill="#888">Match →</text>
          <text x={20} y={200} textAnchor="middle" fontFamily="sans-serif" fontWeight={700} fontSize={14} fill="#888" transform="rotate(-90,20,200)">Mismatch →</text>
          <text x={360} y={15} textAnchor="middle" fontFamily="sans-serif" fontWeight={800} fontSize={18} fill="#4A4A5A">Compatibility Data</text>
          {dots.map((d, i) => {
            const dOp = interpolate(frame, [5 * fps + i * 4, 5.5 * fps + i * 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            return <circle key={i} cx={d.x} cy={d.y} r={8} fill="#5B8DEF" opacity={dOp * 0.5} />;
          })}
          {/* The rejection dot */}
          <circle cx={400} cy={240} r={interpolate(dotAppear, [0, 1], [0, 10])} fill="#5B8DEF" opacity={dotAppear} />
          {dotAppear > 0.5 && (
            <text x={420} y={235} fontFamily="sans-serif" fontWeight={700} fontSize={13} fill="#5B8DEF" opacity={interpolate(frame, [6 * fps, 7 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}>Just one data point</text>
          )}
        </svg>
      </div>

      {frame > 7 * fps && (
        <div style={{
          position: "absolute", bottom: 80, width: "100%", textAlign: "center",
          opacity: interpolate(frame, [7 * fps, 8 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        }}>
          <span style={{ fontFamily: "sans-serif", fontWeight: 700, fontSize: 22, color: "#5B8DEF", backgroundColor: "rgba(91,141,239,0.1)", padding: "8px 20px", borderRadius: 8 }}>
            Not a verdict on worth — merely information
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};

const Scene3Gauge: React.FC<{ frame: number; fps: number; ease: (t: number) => number }> = ({ frame, fps, ease }) => {
  const needleAngle = interpolate(frame, [1 * fps, 5 * fps], [-80, 60], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const wobble = frame < 3 * fps ? Math.sin(frame * 0.3) * 8 : 0;
  const titleOp = interpolate(frame, [0, fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const labelOp = interpolate(frame, [5 * fps, 6 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: "#F5F3EE", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", top: 60, width: "100%", textAlign: "center", opacity: titleOp }}>
        <span style={{ fontFamily: "sans-serif", fontWeight: 800, fontSize: 42, color: "#1A1A2E" }}>CONFIDENCE METER</span>
      </div>

      <svg width={500} height={300} viewBox="0 0 500 300" style={{ marginTop: 40 }}>
        {/* Gauge arc segments */}
        <path d="M 60 260 A 190 190 0 0 1 170 90" fill="none" stroke="#E74C3C" strokeWidth={30} strokeLinecap="round" opacity={0.8} />
        <path d="M 175 85 A 190 190 0 0 1 325 85" fill="none" stroke="#F5A623" strokeWidth={30} strokeLinecap="round" opacity={0.8} />
        <path d="M 330 90 A 190 190 0 0 1 440 260" fill="none" stroke="#10B981" strokeWidth={30} strokeLinecap="round" opacity={0.8} />

        <text x={70} y={285} fontFamily="sans-serif" fontWeight={700} fontSize={13} fill="#E74C3C">Low</text>
        <text x={230} y={55} fontFamily="sans-serif" fontWeight={700} fontSize={13} fill="#F5A623" textAnchor="middle">Medium</text>
        <text x={420} y={285} fontFamily="sans-serif" fontWeight={700} fontSize={13} fill="#10B981">High</text>

        {/* Needle */}
        <g transform={`rotate(${needleAngle + wobble}, 250, 260)`}>
          <line x1={250} y1={260} x2={250} y2={90} stroke="#1A1A2E" strokeWidth={4} strokeLinecap="round" />
          <circle cx={250} cy={260} r={12} fill="#1A1A2E" />
        </g>
      </svg>

      <div style={{
        position: "absolute", bottom: 140, width: "100%", textAlign: "center", opacity: labelOp,
        transform: `translateY(${interpolate(labelOp, [0, 1], [10, 0])}px)`,
      }}>
        <span style={{
          fontFamily: "sans-serif", fontWeight: 800, fontSize: 28, color: "#10B981",
          padding: "10px 28px", backgroundColor: "rgba(16,185,129,0.12)", borderRadius: 12,
        }}>✓ Stable Confidence</span>
      </div>

      {frame > 5.5 * fps && (
        <div style={{
          position: "absolute", bottom: 70, width: "100%", textAlign: "center",
          opacity: interpolate(frame, [5.5 * fps, 6.5 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        }}>
          <span style={{ fontFamily: "sans-serif", fontWeight: 600, fontSize: 18, color: "#666" }}>
            Self-worth independent of external approval
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};

const Scene4Bridge: React.FC<{ frame: number; fps: number; ease: (t: number) => number; easeIn: (t: number) => number }> = ({ frame, fps, ease, easeIn }) => {
  const leftX = interpolate(frame, [0, 3 * fps], [-200, 260], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const rightX = interpolate(frame, [0, 3 * fps], [1400, 820], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });

  const bricks = ["Respect", "Courage", "Connection", "Partnership"];
  const ghosts = ["Fear", "Rejection\nAnxiety", "Self-Doubt"];

  const bannerOp = interpolate(frame, [9 * fps, 10.5 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });

  return (
    <AbsoluteFill style={{ backgroundColor: "#F5F3EE" }}>
      <div style={{ position: "absolute", top: 40, width: "100%", textAlign: "center", opacity: interpolate(frame, [0, fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
        <span style={{ fontFamily: "sans-serif", fontWeight: 800, fontSize: 36, color: "#1A1A2E" }}>BUILDING THE ALLIANCE</span>
      </div>

      {/* Platforms */}
      <div style={{ position: "absolute", bottom: 180, left: leftX, width: 120, height: 20, backgroundColor: "#4A4A5A", borderRadius: 6 }} />
      <div style={{ position: "absolute", bottom: 180, left: rightX, width: 120, height: 20, backgroundColor: "#4A4A5A", borderRadius: 6 }} />

      {/* Silhouettes */}
      <svg style={{ position: "absolute", bottom: 200, left: leftX + 30 }} width={60} height={120} viewBox="0 0 60 120">
        <circle cx={30} cy={18} r={16} fill="#5B8DEF" />
        <rect x={15} y={36} width={30} height={50} rx={8} fill="#5B8DEF" />
        <rect x={10} y={86} width={14} height={30} rx={5} fill="#5B8DEF" />
        <rect x={36} y={86} width={14} height={30} rx={5} fill="#5B8DEF" />
      </svg>
      <svg style={{ position: "absolute", bottom: 200, left: rightX + 30 }} width={60} height={120} viewBox="0 0 60 120">
        <circle cx={30} cy={18} r={16} fill="#E8668A" />
        <rect x={12} y={36} width={36} height={50} rx={10} fill="#E8668A" />
        <rect x={10} y={86} width={14} height={30} rx={5} fill="#E8668A" />
        <rect x={36} y={86} width={14} height={30} rx={5} fill="#E8668A" />
      </svg>

      {/* Bridge bricks */}
      {bricks.map((label, i) => {
        const bStart = 3.5 * fps + i * fps;
        const bOp = interpolate(frame, [bStart, bStart + 0.8 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
        const bY = interpolate(bOp, [0, 1], [30, 0]);
        return (
          <div key={i} style={{
            position: "absolute", bottom: 182, left: 395 + i * 55, opacity: bOp,
            transform: `translateY(${bY}px)`,
          }}>
            <div style={{
              width: 52, height: 18, backgroundColor: "#F5A623", borderRadius: 3,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: "sans-serif", fontWeight: 700, fontSize: 8, color: "#fff",
              boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
            }}>{label}</div>
          </div>
        );
      })}

      {/* Ghost figures dissolving */}
      {ghosts.map((g, i) => {
        const ghostOp = interpolate(frame, [8 * fps, 10 * fps], [0.6, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeIn });
        const drift = interpolate(frame, [8 * fps, 10 * fps], [0, -60 - i * 20], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const gx = [300, 540, 700][i];
        return (
          <div key={i} style={{
            position: "absolute", top: 280 + i * 30, left: gx, opacity: ghostOp,
            transform: `translateY(${drift}px)`,
            fontFamily: "sans-serif", fontWeight: 600, fontSize: 14, color: "#AAA",
            whiteSpace: "pre-line", textAlign: "center",
          }}>{g}</div>
        );
      })}

      {/* Banner */}
      <div style={{
        position: "absolute", top: 120, width: "100%", textAlign: "center", opacity: bannerOp,
        transform: `scaleX(${interpolate(bannerOp, [0, 1], [0.3, 1])})`,
      }}>
        <span style={{
          fontFamily: "sans-serif", fontWeight: 900, fontSize: 30, color: "#fff",
          backgroundColor: "#E8912D", padding: "10px 40px", borderRadius: 8,
          boxShadow: "0 4px 20px rgba(232,145,45,0.3)",
        }}>THE GREATEST ALLIANCE</span>
      </div>
    </AbsoluteFill>
  );
};

const Scene5Finale: React.FC<{ frame: number; fps: number; ease: (t: number) => number }> = ({ frame, fps, ease }) => {
  const heartScale = interpolate(frame, [0, 1.5 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const pulse = 1 + Math.sin(frame * 0.15) * 0.05;
  const ringCount = 5;

  const checks = ["Self-Worth", "Resilience", "Courage", "Partnership"];
  const trendY = (x: number) => 200 - x * 0.3 - Math.sin(x * 0.04) * 20;

  return (
    <AbsoluteFill style={{ backgroundColor: "#F5F3EE" }}>
      {/* Concentric rings */}
      {Array.from({ length: ringCount }).map((_, i) => {
        const ringOp = interpolate(frame, [1 * fps + i * 8, 2 * fps + i * 8], [0, 0.3 - i * 0.05], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const ringR = 80 + i * 50 + interpolate(frame, [0, 9 * fps], [0, 30], { extrapolateRight: "clamp" });
        return (
          <div key={i} style={{
            position: "absolute", top: "50%", left: "50%",
            width: ringR * 2, height: ringR * 2,
            borderRadius: "50%", border: `2px solid rgba(232,102,138,${ringOp})`,
            transform: "translate(-50%,-50%)",
          }} />
        );
      })}

      {/* Heart */}
      <div style={{
        position: "absolute", top: "50%", left: "50%",
        transform: `translate(-50%,-50%) scale(${heartScale * pulse})`,
      }}>
        <svg width={120} height={110} viewBox="0 0 120 110">
          <path d="M60 100 C60 100 10 65 10 35 C10 15 30 5 50 5 C55 5 60 10 60 15 C60 10 65 5 70 5 C90 5 110 15 110 35 C110 65 60 100 60 100Z"
            fill="#E8668A" stroke="none" />
        </svg>
      </div>

      {/* Upward trend line */}
      <svg style={{ position: "absolute", bottom: 60, left: 80 }} width={300} height={220} viewBox="0 0 300 220">
        <line x1={0} y1={200} x2={280} y2={200} stroke="#DDD" strokeWidth={1} />
        <line x1={0} y1={200} x2={0} y2={0} stroke="#DDD" strokeWidth={1} />
        {(() => {
          const len = interpolate(frame, [2 * fps, 6 * fps], [0, 280], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
          const pts = Array.from({ length: Math.floor(len) }, (_, x) => `${x},${trendY(x)}`).join(" ");
          return <polyline points={pts} fill="none" stroke="#10B981" strokeWidth={3} />;
        })()}
        <text x={140} y={218} textAnchor="middle" fontFamily="sans-serif" fontWeight={700} fontSize={11} fill="#888">Growth →</text>
      </svg>

      {/* Checkmarks */}
      <div style={{ position: "absolute", top: 100, right: 100 }}>
        {checks.map((c, i) => {
          const cOp = interpolate(frame, [3 * fps + i * 15, 4 * fps + i * 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
          return (
            <div key={i} style={{
              opacity: cOp, display: "flex", alignItems: "center", gap: 10, marginBottom: 14,
              transform: `translateX(${interpolate(cOp, [0, 1], [20, 0])}px)`,
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: 6, backgroundColor: "#10B981",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: "sans-serif", fontWeight: 900, fontSize: 16, color: "#fff",
              }}>✓</div>
              <span style={{ fontFamily: "sans-serif", fontWeight: 700, fontSize: 16, color: "#4A4A5A" }}>{c}</span>
            </div>
          );
        })}
      </div>

      {/* Network nodes */}
      <svg style={{ position: "absolute", bottom: 80, right: 80 }} width={200} height={160} viewBox="0 0 200 160">
        {[{ x: 40, y: 40 }, { x: 120, y: 30 }, { x: 160, y: 90 }, { x: 80, y: 120 }, { x: 30, y: 100 }].map((n, i, arr) => {
          const nOp = interpolate(frame, [4 * fps + i * 10, 5 * fps + i * 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return (
            <React.Fragment key={i}>
              {i < arr.length - 1 && <line x1={n.x} y1={n.y} x2={arr[i + 1].x} y2={arr[i + 1].y} stroke="#20C9B0" strokeWidth={2} opacity={nOp * 0.5} />}
              <circle cx={n.x} cy={n.y} r={8} fill="#20C9B0" opacity={nOp} />
            </React.Fragment>
          );
        })}
      </svg>

      {/* Final text */}
      <div style={{
        position: "absolute", bottom: 30, width: "100%", textAlign: "center",
        opacity: interpolate(frame, [6 * fps, 7.5 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        transform: `translateY(${interpolate(frame, [6 * fps, 7.5 * fps], [15, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px)`,
      }}>
        <span style={{ fontFamily: "sans-serif", fontWeight: 800, fontSize: 24, color: "#E8668A" }}>
          The treasured partnership — renewed
        </span>
      </div>
    </AbsoluteFill>
  );
};