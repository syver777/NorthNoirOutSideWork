import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Sequence,
  Easing,
} from "remotion";

export const Clip04: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: "#0D0D1A" }}>
      <Sequence durationInFrames={240}>
        <Scene1 />
      </Sequence>
      <Sequence from={240} durationInFrames={360}>
        <Scene2 />
      </Sequence>
      <Sequence from={600} durationInFrames={360}>
        <Scene3 />
      </Sequence>
      <Sequence from={960} durationInFrames={300}>
        <Scene4 />
      </Sequence>
      <Sequence from={1260} durationInFrames={90}>
        <Scene5 />
      </Sequence>
    </AbsoluteFill>
  );
};

const Scene1: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const headlines = ["DATING APPS ARE DANGEROUS!", "STRANGER DANGER: Dating Edition", "Is Your Date a THREAT?", "The Hidden Risks of Meeting Online"];
  const phoneScale = interpolate(frame, [0, 30], [0.3, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const shatterStart = 180;
  const shatterProgress = interpolate(frame, [shatterStart, shatterStart + 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const mythScale = spring({ frame: Math.max(0, frame - shatterStart - 15), fps, config: { damping: 12, mass: 0.8 } });
  const bustedScale = spring({ frame: Math.max(0, frame - shatterStart - 35), fps, config: { damping: 10, mass: 1.2 } });
  const scrollY = interpolate(frame, [30, shatterStart], [0, -300], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const gearAngle = frame * 2;
  const orbitR = 220;

  return (
    <AbsoluteFill style={{ backgroundColor: "#0D0D1A", justifyContent: "center", alignItems: "center" }}>
      {shatterProgress < 1 && (
        <div style={{ transform: `scale(${phoneScale})`, opacity: 1 - shatterProgress, position: "absolute" }}>
          <div style={{ width: 260, height: 480, borderRadius: 28, background: "linear-gradient(180deg, #1a1a2e 0%, #16213e 100%)", border: "3px solid #333", overflow: "hidden", position: "relative", boxShadow: "0 0 40px rgba(0,255,255,0.15)" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 40, background: "#111", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ width: 60, height: 6, borderRadius: 3, background: "#333" }} />
            </div>
            <div style={{ position: "absolute", top: 45, left: 10, right: 10, bottom: 10, overflow: "hidden" }}>
              <div style={{ transform: `translateY(${scrollY}px)` }}>
                {headlines.map((h, i) => {
                  const cardPulse = Math.sin((frame - i * 15) * 0.15) * 0.15 + 1;
                  return (
                    <div key={i} style={{ background: `rgba(239,68,68,${0.15 + Math.sin((frame + i * 20) * 0.1) * 0.1})`, border: "1px solid rgba(239,68,68,0.4)", borderRadius: 10, padding: "12px 10px", marginBottom: 10, transform: `scale(${cardPulse})` }}>
                      <div style={{ color: "#ef4444", fontSize: 13, fontWeight: 700, fontFamily: "sans-serif" }}>{h}</div>
                      <div style={{ color: "#888", fontSize: 9, marginTop: 4, fontFamily: "sans-serif" }}>⚠️ Trending • Algorithm Boosted</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          {[0, 1, 2].map((i) => {
            const angle = (gearAngle + i * 120) * (Math.PI / 180);
            const x = Math.cos(angle) * orbitR;
            const y = Math.sin(angle) * orbitR;
            const iconOpacity = interpolate(frame, [20, 50], [0, 0.8], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            return (
              <svg key={i} width="36" height="36" viewBox="0 0 36 36" style={{ position: "absolute", left: `calc(50% + ${x}px - 18px)`, top: `calc(50% + ${y}px - 18px)`, opacity: iconOpacity }}>
                <circle cx="18" cy="18" r="8" fill="none" stroke="#00FFFF" strokeWidth="2" />
                {[0, 60, 120, 180, 240, 300].map((a) => (
                  <rect key={a} x="16" y="4" width="4" height="6" rx="1" fill="#00FFFF" transform={`rotate(${a} 18 18)`} />
                ))}
              </svg>
            );
          })}
        </div>
      )}
      {shatterProgress > 0 && (
        <>
          {Array.from({ length: 8 }).map((_, i) => {
            const angle = (i / 8) * Math.PI * 2;
            const dist = shatterProgress * 300;
            return (
              <div key={i} style={{ position: "absolute", left: `calc(50% + ${Math.cos(angle) * dist}px)`, top: `calc(50% + ${Math.sin(angle) * dist}px)`, width: 40, height: 60, background: "#1a1a2e", border: "1px solid #333", opacity: 1 - shatterProgress, transform: `rotate(${i * 45 + shatterProgress * 180}deg)`, borderRadius: 4 }} />
            );
          })}
          <div style={{ position: "absolute", transform: `scale(${mythScale})`, textAlign: "center" }}>
            <div style={{ fontSize: 90, fontWeight: 900, color: "#ef4444", fontFamily: "sans-serif", letterSpacing: 8, textShadow: "0 0 30px rgba(239,68,68,0.5)" }}>MYTH</div>
            <div style={{ transform: `scale(${bustedScale}) rotate(-12deg)`, marginTop: -20, fontSize: 52, fontWeight: 900, color: "#10B981", fontFamily: "sans-serif", border: "5px solid #10B981", borderRadius: 12, padding: "4px 24px", display: "inline-block", textShadow: "0 0 20px rgba(16,185,129,0.5)", boxShadow: "0 0 25px rgba(16,185,129,0.3)" }}>BUSTED</div>
          </div>
        </>
      )}
    </AbsoluteFill>
  );
};

const Scene2: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const titleOpacity = interpolate(frame, [0, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const titleY = interpolate(frame, [0, 30], [-30, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const bar1Height = interpolate(frame, [40, 90], [0, 22], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const bar2Height = interpolate(frame, [100, 200], [0, 352], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.22, 1, 0.36, 1) });
  const multiplierOpacity = interpolate(frame, [210, 240], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const multiplierScale = spring({ frame: Math.max(0, frame - 210), fps, config: { damping: 10, mass: 1 } });
  const pulse = Math.sin(frame * 0.08) * 0.08 + 1;
  const arrowProgress = interpolate(frame, [240, 290], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const label1Op = interpolate(frame, [60, 80], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const label2Op = interpolate(frame, [150, 180], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: "#0D0D1A", justifyContent: "center", alignItems: "center" }}>
      <div style={{ opacity: titleOpacity, transform: `translateY(${titleY}px)`, fontSize: 36, fontWeight: 800, color: "#fff", fontFamily: "sans-serif", textAlign: "center", marginBottom: 40, position: "absolute", top: 60 }}>
        The Real <span style={{ color: "#00FFFF" }}>Statistics</span>
      </div>
      <svg width="700" height="500" viewBox="0 0 700 500" style={{ marginTop: 40 }}>
        <line x1="100" y1="440" x2="600" y2="440" stroke="#333" strokeWidth="2" />
        <rect x="180" y={440 - bar1Height} width="100" height={bar1Height} rx="6" fill="#F97316" />
        <text x="230" y="470" textAnchor="middle" fill="#aaa" fontSize="13" fontFamily="sans-serif" fontWeight="600" opacity={label1Op}>Risk of harming</text>
        <text x="230" y="488" textAnchor="middle" fill="#aaa" fontSize="13" fontFamily="sans-serif" fontWeight="600" opacity={label1Op}>a date</text>
        <rect x="420" y={440 - bar2Height} width="100" height={bar2Height} rx="6" fill="#3B82F6" />
        <text x="470" y="470" textAnchor="middle" fill="#aaa" fontSize="13" fontFamily="sans-serif" fontWeight="600" opacity={label2Op}>Risk of self-harm</text>
        <text x="470" y="488" textAnchor="middle" fill="#aaa" fontSize="13" fontFamily="sans-serif" fontWeight="600" opacity={label2Op}>at home</text>
        {arrowProgress > 0 && (
          <>
            <line x1="280" y1={440 - 22} x2={280 + (420 - 280) * arrowProgress} y2={440 - 22} stroke="#00FFFF" strokeWidth="2" strokeDasharray="6 4" opacity={arrowProgress} />
            {arrowProgress > 0.8 && <polygon points={`${420 - 4},${440 - 28} ${420 + 8},${440 - 22} ${420 - 4},${440 - 16}`} fill="#00FFFF" opacity={arrowProgress} />}
          </>
        )}
      </svg>
      <div style={{ position: "absolute", right: 140, top: 160, opacity: multiplierOpacity, transform: `scale(${multiplierScale * pulse})`, textAlign: "center" }}>
        <div style={{ fontSize: 100, fontWeight: 900, color: "#00FFFF", fontFamily: "sans-serif", textShadow: "0 0 40px rgba(0,255,255,0.4)" }}>16×</div>
        <div style={{ fontSize: 16, color: "#8B5CF6", fontWeight: 700, fontFamily: "sans-serif", marginTop: -8 }}>MORE LIKELY</div>
      </div>
    </AbsoluteFill>
  );
};

const Scene3: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dividerX = interpolate(frame, [0, 30], [960, 540], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const leftOp = interpolate(frame, [20, 50], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const rightOp = interpolate(frame, [40, 70], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const uberMeter = interpolate(frame, [60, 160], [0, 0.6], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const dateMeter = interpolate(frame, [80, 180], [0, 0.12], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const carX = interpolate(frame, [40, 280], [0, 320], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const labelOp = interpolate(frame, [180, 220], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const uberPulse = 1 + Math.sin(frame * 0.06) * 0.03;
  const roadDash = frame * 2;

  return (
    <AbsoluteFill style={{ backgroundColor: "#0D0D1A" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: dividerX, height: "100%", opacity: leftOp, overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, #1a1520 0%, #0D0D1A 100%)" }} />
        <div style={{ position: "absolute", top: 50, left: 0, right: 0, textAlign: "center", fontSize: 22, fontWeight: 700, color: "#F97316", fontFamily: "sans-serif" }}>🚗 UBER RIDE</div>
        <svg width="100%" height="200" viewBox="0 0 500 200" style={{ position: "absolute", top: 180 }}>
          <line x1="20" y1="120" x2="480" y2="120" stroke="#444" strokeWidth="3" strokeDasharray="12 8" strokeDashoffset={-roadDash} />
          <rect x={40 + carX} y="90" width="50" height="25" rx="8" fill="#F97316" />
          <circle cx={50 + carX} cy="118" r="6" fill="#666" />
          <circle cx={80 + carX} cy="118" r="6" fill="#666" />
          <rect x={45 + carX} y="85" width="20" height="12" rx="3" fill="#F9731688" />
        </svg>
        <div style={{ position: "absolute", bottom: 180, left: "50%", transform: `translateX(-50%) scale(${uberPulse})` }}>
          <svg width="60" height="200" viewBox="0 0 60 200">
            <rect x="10" y="10" width="40" height="180" rx="20" fill="#1a1a2e" stroke="#444" strokeWidth="2" />
            <rect x="14" y={190 - uberMeter * 170} width="32" height={uberMeter * 170} rx="16" fill={uberMeter > 0.4 ? "#F97316" : "#eab308"} />
            <circle cx="30" cy="185" r="6" fill={uberMeter > 0.2 ? "#F97316" : "#666"} />
          </svg>
        </div>
        <div style={{ position: "absolute", bottom: 100, left: 0, right: 0, textAlign: "center", opacity: labelOp, fontSize: 15, fontWeight: 700, color: "#F97316", fontFamily: "sans-serif", padding: "0 20px" }}>Higher Statistical Risk</div>
      </div>
      <div style={{ position: "absolute", left: dividerX, top: 0, right: 0, height: "100%", opacity: rightOp, overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, #0f1a15 0%, #0D0D1A 100%)" }} />
        <div style={{ position: "absolute", top: 50, left: 0, right: 0, textAlign: "center", fontSize: 22, fontWeight: 700, color: "#10B981", fontFamily: "sans-serif" }}>🍽️ THE DATE</div>
        <svg width="200" height="140" viewBox="0 0 200 140" style={{ position: "absolute", top: 200, left: "50%", transform: "translateX(-50%)" }}>
          <ellipse cx="100" cy="110" rx="80" ry="10" fill="#1a2a1f" />
          <rect x="60" y="70" width="80" height="40" rx="4" fill="#1a2a1f" stroke="#10B981" strokeWidth="1.5" />
          <circle cx="80" cy="55" r="14" fill="#10B981" opacity="0.6" />
          <circle cx="120" cy="55" r="14" fill="#8B5CF6" opacity="0.6" />
          <rect x="75" y="55" width="4" height="30" rx="2" fill="#666" />
          <rect x="121" y="55" width="4" height="30" rx="2" fill="#666" />
        </svg>
        <div style={{ position: "absolute", bottom: 180, left: "50%", transform: "translateX(-50%)" }}>
          <svg width="60" height="200" viewBox="0 0 60 200">
            <rect x="10" y="10" width="40" height="180" rx="20" fill="#1a1a2e" stroke="#444" strokeWidth="2" />
            <rect x="14" y={190 - dateMeter * 170} width="32" height={dateMeter * 170} rx="16" fill="#10B981" />
            <circle cx="30" cy="185" r="6" fill={dateMeter > 0.05 ? "#10B981" : "#666"} />
          </svg>
        </div>
        <div style={{ position: "absolute", bottom: 100, left: 0, right: 0, textAlign: "center", opacity: labelOp, fontSize: 15, fontWeight: 700, color: "#10B981", fontFamily: "sans-serif", padding: "0 20px" }}>Lower Risk</div>
      </div>
      <div style={{ position: "absolute", left: dividerX - 1, top: 0, width: 2, height: "100%", background: "linear-gradient(180deg, transparent, #8B5CF6, transparent)" }} />
    </AbsoluteFill>
  );
};

const Scene4: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const bgOp = interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const personScale = spring({ frame: Math.max(0, frame - 10), fps, config: { damping: 12 } });
  const foodX = interpolate(frame, [40, 120], [-200, 30], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const badgeScale = spring({ frame: Math.max(0, frame - 130), fps, config: { damping: 10, mass: 1.2 } });
  const text = "The REAL daily risk you never think about.";
  const charsVisible = Math.floor(interpolate(frame, [160, 260], [0, text.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const forkScale = spring({ frame: Math.max(0, frame - 140), fps, config: { damping: 14 } });

  return (
    <AbsoluteFill style={{ background: "linear-gradient(135deg, #0a2a1f 0%, #0D0D1A 50%, #1a0f20 100%)", opacity: bgOp, justifyContent: "center", alignItems: "center" }}>
      <svg width="160" height="200" viewBox="0 0 160 200" style={{ position: "absolute", left: "50%", top: 140, transform: `translateX(-50%) scale(${personScale})` }}>
        <circle cx="80" cy="40" r="28" fill="#10B981" opacity="0.7" />
        <rect x="55" y="72" width="50" height="60" rx="10" fill="#10B981" opacity="0.5" />
        <rect x="40" y="130" width="80" height="8" rx="4" fill="#1a2a1f" stroke="#10B981" strokeWidth="1" />
      </svg>
      <svg width="50" height="50" viewBox="0 0 50 50" style={{ position: "absolute", left: `calc(50% + ${foodX}px)`, top: 200, transform: "translateY(-50%)" }}>
        <circle cx="25" cy="25" r="18" fill="#F97316" />
        <circle cx="20" cy="20" r="4" fill="#ef4444" />
        <circle cx="30" cy="28" r="3" fill="#eab308" />
      </svg>
      <div style={{ position: "absolute", left: "50%", top: 100, transform: `translate(-50%, -50%) scale(${badgeScale})` }}>
        <svg width="200" height="200" viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="70" fill="#1a0a0a" stroke="#ef4444" strokeWidth="3" />
          <text x="100" y="85" textAnchor="middle" fill="#ef4444" fontSize="14" fontFamily="sans-serif" fontWeight="700">⚠️ CHOKING</text>
          <text x="100" y="108" textAnchor="middle" fill="#ef4444" fontSize="13" fontFamily="sans-serif" fontWeight="800">RISK</text>
          <text x="100" y="132" textAnchor="middle" fill="#F97316" fontSize="18" fontFamily="sans-serif" fontWeight="900">~5,000/yr</text>
          <line x1="40" y1="160" x2="90" y2="100" stroke="#888" strokeWidth="2" transform={`scale(${forkScale})`} style={{ transformOrigin: "65px 130px" }} />
          <line x1="160" y1="160" x2="110" y2="100" stroke="#888" strokeWidth="2" transform={`scale(${forkScale})`} style={{ transformOrigin: "135px 130px" }} />
        </svg>
      </div>
      <div style={{ position: "absolute", bottom: 120, left: 0, right: 0, textAlign: "center", padding: "0 100px" }}>
        <span style={{ fontSize: 30, fontWeight: 800, fontFamily: "sans-serif", color: "#fff", lineHeight: 1.4 }}>
          {text.slice(0, charsVisible).split("REAL").map((part, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span style={{ color: "#F97316" }}>REAL</span>}
              {part}
            </React.Fragment>
          ))}
          <span style={{ opacity: frame % 20 < 12 ? 1 : 0, color: "#00FFFF" }}>|</span>
        </span>
      </div>
    </AbsoluteFill>
  );
};

const Scene5: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cards = [
    { icon: "🏠", title: "Self-Harm Risk", stat: "16× higher", color: "#3B82F6", sub: "than harming a date" },
    { icon: "🚗", title: "Uber Ride", stat: "More dangerous", color: "#F97316", sub: "than the date itself" },
    { icon: "🍴", title: "Choking Risk", stat: "~5,000/yr", color: "#ef4444", sub: "a daily risk ignored" },
  ];

  return (
    <AbsoluteFill style={{ backgroundColor: "#0D0D1A", justifyContent: "center", alignItems: "center" }}>
      <div style={{ display: "flex", gap: 30 }}>
        {cards.map((card, i) => {
          const slideIn = spring({ frame: Math.max(0, frame - i * 8), fps, config: { damping: 14 } });
          const pulse = 1 + Math.sin((frame + i * 20) * 0.1) * 0.02;
          return (
            <div key={i} style={{ width: 260, padding: 28, borderRadius: 16, background: "linear-gradient(135deg, #1a1a2e 0%, #111 100%)", border: `1px solid ${card.color}44`, transform: `translateY(${(1 - slideIn) * 80}px) scale(${slideIn * pulse})`, opacity: slideIn, textAlign: "center", boxShadow: `0 0 30px ${card.color}22` }}>
              <div style={{ fontSize: 44, marginBottom: 10 }}>{card.icon}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: card.color, fontFamily: "sans-serif", marginBottom: 8 }}>{card.title}</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: "#fff", fontFamily: "sans-serif", marginBottom: 6 }}>{card.stat}</div>
              <div style={{ fontSize: 13, color: "#888", fontFamily: "sans-serif" }}>{card.sub}</div>
            </div>
          );
        })}
      </div>
      <div style={{ position: "absolute", bottom: 80, opacity: interpolate(frame, [40, 60], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }), fontSize: 20, fontWeight: 700, color: "#00FFFF", fontFamily: "sans-serif", textAlign: "center", textShadow: "0 0 20px rgba(0,255,255,0.3)" }}>
        Fear sells clicks. Data tells the truth.
      </div>
    </AbsoluteFill>
  );
};