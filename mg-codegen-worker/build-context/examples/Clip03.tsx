import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  Sequence,
} from "remotion";

const CYAN = "#00CED1";
const CORAL = "#FF6B6B";
const TEAL = "#00B4D8";
const YELLOW = "#FFD166";
const WHITE = "#FFFFFF";
const DARK = "#1A1A2E";
const RED = "#EF4444";
const GREEN = "#10B981";
const LIGHT_BG = "#F0F4FF";
const PASTEL_BG = "#E8F8F5";

const PersonIcon: React.FC<{
  x: number;
  y: number;
  color: string;
  scale?: number;
}> = ({ x, y, color, scale = 1 }) => (
  <g transform={`translate(${x},${y}) scale(${scale})`}>
    <circle cx="0" cy="-12" r="8" fill={color} />
    <rect x="-6" y="-4" width="12" height="18" rx="4" fill={color} />
  </g>
);

const Phase1: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const mythScale = interpolate(frame, [0, 20], [3, 1], {
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const mythOp = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });
  const iconOp = interpolate(frame, [20, 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const meterPct = interpolate(frame, [60, 180], [100, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.45, 0, 0.55, 1),
  });
  const meterColor =
    meterPct > 60 ? GREEN : meterPct > 30 ? YELLOW : RED;
  const shakeX =
    frame > 120
      ? Math.sin(frame * 1.5) * interpolate(frame, [120, 180], [0, 6], { extrapolateRight: "clamp" })
      : 0;
  const crackOp = interpolate(frame, [150, 200], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const alarmScale =
    frame > 160
      ? 1 + Math.sin(frame * 0.4) * 0.15
      : 0;
  const exitOp = interpolate(frame, [260, 300], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: LIGHT_BG,
        justifyContent: "center",
        alignItems: "center",
        opacity: exitOp,
      }}
    >
      <div
        style={{
          transform: `scale(${mythScale}) translateX(${shakeX}px)`,
          opacity: mythOp,
          fontSize: 72,
          fontWeight: 900,
          color: RED,
          fontFamily: "sans-serif",
          letterSpacing: -2,
        }}
      >
        MYTH #1
      </div>
      <div
        style={{
          opacity: iconOp,
          marginTop: 20,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <svg width="80" height="80" viewBox="-30 -30 60 60">
          <PersonIcon x={0} y={0} color={DARK} scale={1.2} />
        </svg>
        <svg width="60" height="60" viewBox="0 0 60 60">
          <rect
            x="5"
            y="5"
            width="50"
            height="40"
            rx="12"
            fill={WHITE}
            stroke={RED}
            strokeWidth="3"
          />
          <line x1="18" y1="15" x2="42" y2="35" stroke={RED} strokeWidth="4" strokeLinecap="round" />
          <line x1="42" y1="15" x2="18" y2="35" stroke={RED} strokeWidth="4" strokeLinecap="round" />
        </svg>
      </div>
      <div
        style={{
          marginTop: 40,
          textAlign: "center",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: DARK,
            marginBottom: 10,
            letterSpacing: 3,
          }}
        >
          REPUTATION METER
        </div>
        <svg width="500" height="50" viewBox="0 0 500 50">
          <rect x="0" y="10" width="500" height="30" rx="15" fill="#DDD" />
          <rect
            x="0"
            y="10"
            width={meterPct * 5}
            height="30"
            rx="15"
            fill={meterColor}
          />
          <text x="250" y="32" textAnchor="middle" fontSize="18" fontWeight="bold" fill={DARK}>
            {Math.round(meterPct)}%
          </text>
        </svg>
        {crackOp > 0 && (
          <svg
            width="500"
            height="40"
            viewBox="0 0 500 40"
            style={{ opacity: crackOp, marginTop: -10 }}
          >
            <polyline
              points="200,0 220,15 210,20 240,35 225,40"
              fill="none"
              stroke={RED}
              strokeWidth="3"
            />
            <polyline
              points="300,0 280,12 295,22 270,38"
              fill="none"
              stroke={RED}
              strokeWidth="3"
            />
          </svg>
        )}
        {alarmScale > 0 && (
          <div
            style={{
              transform: `scale(${alarmScale})`,
              fontSize: 36,
              marginTop: 5,
            }}
          >
            ⚠️
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

const Phase2: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enterOp = interpolate(frame, [0, 30], [0, 1], {
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const leftSlide = interpolate(frame, [10, 50], [-200, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const rightSlide = interpolate(frame, [10, 50], [200, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const dotFade = interpolate(frame, [80, 130], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const clockRot = interpolate(frame, [140, 250], [0, 720], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const pathProgress = interpolate(frame, [200, 340], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.45, 0, 0.55, 1),
  });
  const smileOp = interpolate(frame, [280, 320], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${LIGHT_BG}, ${PASTEL_BG})`,
        opacity: enterOp,
        display: "flex",
        flexDirection: "row",
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          transform: `translateX(${leftSlide}px)`,
        }}
      >
        <svg width="400" height="300" viewBox="0 0 400 300">
          <PersonIcon x={120} y={130} color={TEAL} scale={1.8} />
          <PersonIcon x={280} y={130} color={CORAL} scale={1.8} />
          <rect x="90" y="60" width="70" height="40" rx="12" fill={WHITE} stroke={TEAL} strokeWidth="2" />
          <text x="125" y="85" textAnchor="middle" fontSize="14" fill={TEAL}>
            Hi! 👋
          </text>
          <rect x="245" y="60" width="80" height="40" rx="12" fill={WHITE} stroke={CORAL} strokeWidth="2" />
          <text x="285" y="85" textAnchor="middle" fontSize="12" fill={CORAL}>
            No thanks
          </text>
          <line
            x1="155"
            y1="140"
            x2="245"
            y2="140"
            stroke={DARK}
            strokeWidth="2"
            strokeDasharray="6 4"
            opacity={dotFade}
          />
          {pathProgress > 0 && (
            <>
              <circle
                cx={120 - pathProgress * 80}
                cy={200 + pathProgress * 40}
                r="6"
                fill={TEAL}
              />
              <circle
                cx={280 + pathProgress * 80}
                cy={200 + pathProgress * 40}
                r="6"
                fill={CORAL}
              />
              {smileOp > 0 && (
                <>
                  <text
                    x={120 - pathProgress * 80}
                    y={185 + pathProgress * 40}
                    textAnchor="middle"
                    fontSize="18"
                    opacity={smileOp}
                  >
                    😊
                  </text>
                  <text
                    x={280 + pathProgress * 80}
                    y={185 + pathProgress * 40}
                    textAnchor="middle"
                    fontSize="18"
                    opacity={smileOp}
                  >
                    😊
                  </text>
                </>
              )}
            </>
          )}
        </svg>
        <div
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: DARK,
            fontFamily: "sans-serif",
            opacity: smileOp,
          }}
        >
          Both move on peacefully
        </div>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          transform: `translateX(${rightSlide}px)`,
        }}
      >
        <svg width="120" height="120" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="50" fill="none" stroke={TEAL} strokeWidth="4" />
          <line
            x1="60"
            y1="60"
            x2="60"
            y2="25"
            stroke={DARK}
            strokeWidth="3"
            strokeLinecap="round"
            transform={`rotate(${clockRot}, 60, 60)`}
          />
          <line
            x1="60"
            y1="60"
            x2="80"
            y2="60"
            stroke={TEAL}
            strokeWidth="2"
            strokeLinecap="round"
            transform={`rotate(${clockRot * 0.08}, 60, 60)`}
          />
          <circle cx="60" cy="60" r="4" fill={DARK} />
        </svg>
        <div
          style={{
            fontSize: 16,
            color: DARK,
            fontFamily: "sans-serif",
            marginTop: 15,
            fontWeight: 600,
          }}
        >
          Time passes...
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Phase3: React.FC = () => {
  const frame = useCurrentFrame();
  const enterOp = interpolate(frame, [0, 30], [0, 1], {
    extrapolateRight: "clamp",
  });
  const concerns = [
    "📧", "🛒", "📱", "👨‍👩‍👧", "⚽", "📊", "🎮", "🍳",
    "💼", "🏠", "📚", "🎵", "✈️", "🐕", "💊", "🧹",
    "📝", "🚗", "👶", "💰", "🎂", "🏋️", "📺", "🌱",
  ];
  const words = "Everyone else is absorbed in their own lives".split(" ");

  return (
    <AbsoluteFill
      style={{
        background: WHITE,
        opacity: enterOp,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 40,
      }}
    >
      <svg width="800" height="380" viewBox="0 0 800 380">
        {concerns.map((emoji, i) => {
          const col = i % 8;
          const row = Math.floor(i / 8);
          const px = 60 + col * 95;
          const py = 50 + row * 120;
          const delay = i * 4 + 10;
          const op = interpolate(frame, [delay, delay + 20], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const bobY = Math.sin((frame + i * 20) * 0.06) * 3;
          return (
            <g key={i} opacity={op} transform={`translate(0,${bobY})`}>
              <circle cx={px} cy={py + 10} r="14" fill={PASTEL_BG} />
              <rect
                x={px - 14}
                y={py + 4}
                width="28"
                height="22"
                rx="6"
                fill={PASTEL_BG}
              />
              <rect
                x={px - 18}
                y={py - 25}
                width="36"
                height="24"
                rx="8"
                fill={WHITE}
                stroke="#CCC"
                strokeWidth="1.5"
              />
              <text
                x={px}
                y={py - 8}
                textAnchor="middle"
                fontSize="14"
              >
                {emoji}
              </text>
            </g>
          );
        })}
      </svg>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: 10,
          marginTop: 20,
        }}
      >
        {words.map((w, i) => {
          const wDelay = 180 + i * 8;
          const wOp = interpolate(frame, [wDelay, wDelay + 12], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const wY = interpolate(frame, [wDelay, wDelay + 12], [15, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          });
          return (
            <span
              key={i}
              style={{
                fontSize: 34,
                fontWeight: 800,
                color: TEAL,
                fontFamily: "sans-serif",
                opacity: wOp,
                transform: `translateY(${wY}px)`,
                display: "inline-block",
              }}
            >
              {w}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const Phase4: React.FC = () => {
  const frame = useCurrentFrame();
  const enterOp = interpolate(frame, [0, 30], [0, 1], {
    extrapolateRight: "clamp",
  });
  const barWidth = interpolate(frame, [20, 80], [0, 900], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const magX = interpolate(frame, [100, 250], [100, 750], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.45, 0, 0.55, 1),
  });
  const magOp = interpolate(frame, [90, 110], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const quoteOp = interpolate(frame, [220, 260], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const quoteY = interpolate(frame, [220, 260], [30, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const dotOp = interpolate(frame, [280, 340], [0.6, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: CORAL,
        opacity: enterOp,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: WHITE,
          fontFamily: "sans-serif",
          letterSpacing: 4,
          marginBottom: 20,
        }}
      >
        100 YEARS
      </div>
      <svg width="920" height="60" viewBox="0 0 920 60">
        <rect x="10" y="20" width={barWidth} height="20" rx="10" fill="rgba(255,255,255,0.3)" />
        {Array.from({ length: 80 }).map((_, i) => (
          <circle
            key={i}
            cx={15 + i * 11.2}
            cy={30}
            r={1.5}
            fill="rgba(255,255,255,0.5)"
            opacity={barWidth > i * 11.2 ? 1 : 0}
          />
        ))}
        <circle cx={460} cy={30} r={2} fill={YELLOW} opacity={dotOp} />
      </svg>
      {magOp > 0 && (
        <svg
          width="920"
          height="80"
          viewBox="0 0 920 80"
          style={{ marginTop: -30, opacity: magOp }}
        >
          <circle
            cx={magX}
            cy={30}
            r="20"
            fill="none"
            stroke={WHITE}
            strokeWidth="3"
          />
          <line
            x1={magX + 14}
            y1={44}
            x2={magX + 28}
            y2={58}
            stroke={WHITE}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <text
            x={magX}
            y={75}
            textAnchor="middle"
            fontSize="11"
            fill="rgba(255,255,255,0.7)"
            fontFamily="sans-serif"
          >
            searching...
          </text>
        </svg>
      )}
      <div
        style={{
          opacity: quoteOp,
          transform: `translateY(${quoteY}px)`,
          fontSize: 44,
          fontWeight: 900,
          color: WHITE,
          fontFamily: "sans-serif",
          textAlign: "center",
          marginTop: 40,
          lineHeight: 1.3,
          maxWidth: 700,
        }}
      >
        "In 100 years, no one will care"
      </div>
    </AbsoluteFill>
  );
};

const Phase5: React.FC = () => {
  const frame = useCurrentFrame();
  const enterOp = interpolate(frame, [0, 30], [0, 1], {
    extrapolateRight: "clamp",
  });
  const leftOp = interpolate(frame, [80, 160], [1, 0.3], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const rightBright = interpolate(frame, [80, 160], [0.7, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const textOp = interpolate(frame, [120, 170], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const textY = interpolate(frame, [120, 170], [25, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const pulseScale = 1 + Math.sin(frame * 0.08) * 0.02;
  const chainWiggle = Math.sin(frame * 0.15) * 2;

  return (
    <AbsoluteFill
      style={{
        background: DARK,
        opacity: enterOp,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 80,
          alignItems: "center",
          marginBottom: 50,
        }}
      >
        <div
          style={{
            opacity: leftOp,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <svg width="200" height="220" viewBox="0 0 200 220">
            <rect
              x="40"
              y="40"
              width="120"
              height="140"
              rx="8"
              fill="none"
              stroke="#666"
              strokeWidth="4"
            />
            <line x1="40" y1="80" x2="40" y2="180" stroke="#666" strokeWidth="4" />
            <line x1="160" y1="80" x2="160" y2="180" stroke="#666" strokeWidth="4" />
            <PersonIcon x={100} y={120} color="#888" scale={1.5} />
            <g transform={`translate(0,${chainWiggle})`}>
              {[0, 1, 2, 3].map((j) => (
                <ellipse
                  key={j}
                  cx={60 + j * 28}
                  cy={55}
                  rx="12"
                  ry="8"
                  fill="none"
                  stroke="#888"
                  strokeWidth="2.5"
                />
              ))}
            </g>
            <rect x="80" y="20" width="40" height="28" rx="6" fill="#888" />
            <circle cx="100" cy="38" r="4" fill={DARK} />
          </svg>
          <div
            style={{
              fontSize: 22,
              fontWeight: 800,
              color: RED,
              fontFamily: "sans-serif",
              letterSpacing: 3,
              marginTop: 8,
            }}
          >
            FEAR
          </div>
        </div>
        <div
          style={{
            width: 2,
            height: 200,
            background: "rgba(255,255,255,0.15)",
          }}
        />
        <div
          style={{
            opacity: rightBright,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <svg width="200" height="220" viewBox="0 0 200 220">
            <rect
              x="60"
              y="30"
              width="80"
              height="160"
              rx="6"
              fill="none"
              stroke={YELLOW}
              strokeWidth="3"
            />
            <rect
              x="62"
              y="32"
              width="76"
              height="156"
              rx="5"
              fill="rgba(255,209,102,0.1)"
            />
            {[0, 1, 2, 3, 4, 5].map((r) => (
              <line
                key={r}
                x1={140}
                y1={60 + r * 22}
                x2={140 + 20 + r * 8}
                y2={40 + r * 14}
                stroke={YELLOW}
                strokeWidth="2"
                opacity={0.5 + r * 0.08}
              />
            ))}
            <PersonIcon x={100} y={140} color={GREEN} scale={1.5} />
            <circle
              cx={100}
              cy={80}
              r="3"
              fill={YELLOW}
              opacity={0.6 + Math.sin(frame * 0.1) * 0.4}
            />
          </svg>
          <div
            style={{
              fontSize: 22,
              fontWeight: 800,
              color: YELLOW,
              fontFamily: "sans-serif",
              letterSpacing: 3,
              marginTop: 8,
            }}
          >
            TRUTH
          </div>
        </div>
      </div>
      <div
        style={{
          opacity: textOp,
          transform: `translateY(${textY}px) scale(${pulseScale})`,
          fontSize: 36,
          fontWeight: 900,
          color: WHITE,
          fontFamily: "sans-serif",
          textAlign: "center",
          maxWidth: 800,
          lineHeight: 1.4,
        }}
      >
        Fear is not a protector —{" "}
        <span style={{ color: YELLOW }}>it is a jailer</span>
      </div>
    </AbsoluteFill>
  );
};

export const Clip03: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ background: DARK }}>
      <Sequence from={0} durationInFrames={10 * fps}>
        <Phase1 />
      </Sequence>
      <Sequence from={10 * fps} durationInFrames={12 * fps}>
        <Phase2 />
      </Sequence>
      <Sequence from={22 * fps} durationInFrames={13 * fps}>
        <Phase3 />
      </Sequence>
      <Sequence from={35 * fps} durationInFrames={12 * fps}>
        <Phase4 />
      </Sequence>
      <Sequence from={47 * fps} durationInFrames={8 * fps}>
        <Phase5 />
      </Sequence>
    </AbsoluteFill>
  );
};