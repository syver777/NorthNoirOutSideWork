// Returns an always-renderable Remotion component, used when Claude fails
// repeatedly. Mirrors SSAITMG Gen.py's fallback_component.

export function fallbackComponent(name: string, promptText: string): string {
  const safe = promptText
    .slice(0, 280)
    .replace(/"/g, "'")
    .replace(/\n/g, " ")
    .replace(/</g, "")
    .replace(/>/g, "");

  return `import React from 'react';
import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';

export const ${name}: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: 'clamp' });
  const y = interpolate(frame, [0, 45], [80, 0], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{
      backgroundColor: '#0D0D1A',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      padding: '80px',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{ opacity, transform: \`translateY(\${y}px)\`, color: '#00FFFF', fontSize: 52, fontWeight: 'bold', textAlign: 'center', marginBottom: 40 }}>
        ${name}
      </div>
      <div style={{ opacity, color: '#e2e8f0', fontSize: 26, textAlign: 'center', maxWidth: 1200, lineHeight: 1.7 }}>
        ${safe}
      </div>
    </AbsoluteFill>
  );
};
`;
}
