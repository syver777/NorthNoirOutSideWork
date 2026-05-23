/**
 * CaptionOverlay — renders preview subtitles over a video element.
 *
 * Style mapping mirrors `gcloudfunctions/subtitles.py`:
 *   - 10 fonts, 10 color presets, 10 sizes (in 1080p px), 3 modes, 3 positions.
 *
 * Note: ASS color format is `&HAABBGGRR`. The presets below are the CSS
 * equivalents of `SUBTITLE_COLOR_PRESETS` in subtitles.py. `border=3` styles
 * draw an opaque box (no outline); `border=1` styles use an outline.
 *
 * Driven by the host <video>'s `currentTime` via requestAnimationFrame so
 * cue timing tracks playback (including loop restart) without re-renders
 * between cue changes.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  PREVIEW_SUBTITLES,
  type PreviewCue,
  type PreviewWord,
} from '../data/previewSubtitles';
import type {
  SubtitleConfig,
  SubtitleMode,
  SubtitlePosition,
} from './SubtitleConfiguration';

// ─────────────────────────────────────────────────────────────────────────
// Style tables — keep in sync with gcloudfunctions/subtitles.py
// ─────────────────────────────────────────────────────────────────────────

const FONT_FAMILIES: string[] = [
  '"Montserrat", system-ui, sans-serif',                           // 1
  '"Bebas Neue", Impact, sans-serif',                              // 2
  '"Anton", Impact, sans-serif',                                   // 3
  '"Montserrat", system-ui, sans-serif',                           // 4 (Black weight)
  '"Poppins", system-ui, sans-serif',                              // 5
  '"Oswald", Impact, sans-serif',                                  // 6
  '"Lobster", "Brush Script MT", cursive',                         // 7
  '"Permanent Marker", "Marker Felt", cursive',                    // 8
  '"Bangers", Impact, sans-serif',                                 // 9
  '"Oswald", Impact, sans-serif',                                  // 10 (Bold weight)
];

// idx 4 (Montserrat Black) and 10 (Oswald Bold) need an explicit weight.
const FONT_WEIGHTS: number[] = [600, 400, 400, 900, 600, 500, 400, 400, 400, 700];

const SIZES_1080 = [32, 40, 48, 56, 64, 72, 84, 96, 112, 128];

interface ColorPreset {
  /** Active/spoken text color */
  primary: string;
  /** "Unsung" karaoke color (matches ASS Secondary &H000000FF = red). */
  secondary: string;
  /** Outline color */
  outline: string;
  /** Box background (used when border === 'box'). */
  back: string;
  /** Outline width in 1080p px. */
  outlineW: number;
  /** Render mode: 'outline' draws stroke; 'box' draws filled background. */
  border: 'outline' | 'box';
  /** Drop shadow size (1080p px). */
  shadow: number;
  /** Optional text-shadow color (defaults to outline). */
  shadowColor?: string;
}

// Mirrors SUBTITLE_COLOR_PRESETS in subtitles.py.
const COLOR_PRESETS: ColorPreset[] = [
  // 1 classic_white
  { primary: '#FFFFFF', secondary: '#FF0000', outline: '#000000', back: 'rgba(0,0,0,0.39)',
    outlineW: 3, border: 'outline', shadow: 0 },
  // 2 cinema_yellow
  { primary: '#FFF000', secondary: '#FF0000', outline: '#000000', back: 'rgba(0,0,0,0.39)',
    outlineW: 3, border: 'outline', shadow: 0 },
  // 3 clean_shadow
  { primary: '#FFFFFF', secondary: '#FF0000', outline: '#000000', back: 'rgba(0,0,0,0.78)',
    outlineW: 1, border: 'outline', shadow: 3, shadowColor: 'rgba(0,0,0,0.85)' },
  // 4 black_on_white (border=3 → opaque white box)
  { primary: '#000000', secondary: '#FF0000', outline: '#FFFFFF', back: '#FFFFFF',
    outlineW: 4, border: 'box', shadow: 0 },
  // 5 box_caption (border=3 → semi-opaque dark box)
  { primary: '#FFFFFF', secondary: '#FF0000', outline: 'rgba(0,0,0,0.47)', back: 'rgba(0,0,0,0.47)',
    outlineW: 8, border: 'box', shadow: 0 },
  // 6 synthwave (toned-down outline)
  { primary: '#00FFFF', secondary: '#FF0000', outline: '#330066', back: 'rgba(0,0,0,0.39)',
    outlineW: 2, border: 'outline', shadow: 0 },
  // 7 gold_premium
  { primary: '#FFC800', secondary: '#FF0000', outline: '#663300', back: 'rgba(0,0,0,0.39)',
    outlineW: 3, border: 'outline', shadow: 1, shadowColor: 'rgba(0,0,0,0.85)' },
  // 8 urgent_red
  { primary: '#FF0000', secondary: '#FF0000', outline: '#FFFFFF', back: 'rgba(0,0,0,0.39)',
    outlineW: 4, border: 'outline', shadow: 0 },
  // 9 gradient_sunset
  { primary: '#FFF000', secondary: '#FF0000', outline: '#FF8000', back: 'rgba(0,0,0,0.39)',
    outlineW: 6, border: 'outline', shadow: 1, shadowColor: 'rgba(0,0,0,0.85)' },
  // 10 classic_black
  { primary: '#000000', secondary: '#FF0000', outline: '#FFFFFF', back: 'rgba(0,0,0,0.39)',
    outlineW: 3, border: 'outline', shadow: 0 },
];

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const clampIdx = (idx: number, len: number) =>
  Math.max(0, Math.min(len - 1, idx - 1));

/** Build a multi-direction text-shadow that approximates an ASS outline. */
function buildOutline(color: string, width: number, drop: number, dropColor: string): string {
  if (width <= 0 && drop <= 0) return 'none';
  const shadows: string[] = [];
  if (width > 0) {
    // 8-direction outline + 4 cardinal at 0.5 step for crispness.
    const w = width;
    const offsets: [number, number][] = [
      [-w, -w], [0, -w], [w, -w],
      [-w,  0],          [w,  0],
      [-w,  w], [0,  w], [w,  w],
    ];
    offsets.forEach(([x, y]) => {
      shadows.push(`${x}px ${y}px 0 ${color}`);
    });
  }
  if (drop > 0) {
    shadows.push(`${drop}px ${drop}px ${Math.max(2, drop)}px ${dropColor}`);
  }
  return shadows.join(', ');
}

/** Find the cue active at the given time, or `null` if between cues. */
function findActiveCue(cues: PreviewCue[], t: number): PreviewCue | null {
  // Linear scan — array is small (<10 entries) and ordered.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (t >= c.start && t < c.end) return c;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────

interface CaptionOverlayProps {
  /** Ref to the host <video> element. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Subtitle styling/timing config. */
  config: SubtitleConfig;
  /** When false, overlay renders nothing. */
  enabled: boolean;
}

const CaptionOverlay: React.FC<CaptionOverlayProps> = ({
  videoRef,
  config,
  enabled,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerHeight, setContainerHeight] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const rafRef = useRef<number | null>(null);

  // Track container height to scale font/outline sizes from 1080p baseline.
  useEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerHeight(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);

  // Sync with video.currentTime via rAF (covers loop restarts and seeks).
  useEffect(() => {
    if (!enabled) return;
    const video = videoRef.current;
    if (!video) return;

    const tick = () => {
      setCurrentTime(video.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [enabled, videoRef]);

  if (!enabled) return null;

  const mode: SubtitleMode = config.mode;
  const position: SubtitlePosition = config.position;
  const preset = COLOR_PRESETS[clampIdx(config.color_idx, COLOR_PRESETS.length)];
  const fontFamily = FONT_FAMILIES[clampIdx(config.font_idx, FONT_FAMILIES.length)];
  const fontWeight = FONT_WEIGHTS[clampIdx(config.font_idx, FONT_WEIGHTS.length)];
  const baseSize1080 = SIZES_1080[clampIdx(config.size_idx, SIZES_1080.length)];

  // Scale to current container height (matches subtitles.py's 1080-relative scaling).
  const scale = containerHeight > 0 ? containerHeight / 1080 : 1;
  // Calibration: ASS `Fontsize` is rendered by libass roughly as the cap/ascent
  // height in PlayResY pixels, while CSS `font-size` sets the larger EM box.
  // Without this multiplier the preview text looks ~25–35% bigger than the
  // burned-in subtitles produced by gcloudfunctions/subtitles.py.
  const ASS_TO_CSS_FONT_RATIO = 0.62;
  const fontSize = Math.max(10, baseSize1080 * scale * ASS_TO_CSS_FONT_RATIO);
  const outlineW = Math.max(0, preset.outlineW * scale);
  const shadow = preset.shadow * scale;

  // Pick cue list based on mode (karaoke reuses phrase cues per data file note).
  const cueList: PreviewCue[] =
    mode === 'single_word'
      ? PREVIEW_SUBTITLES.cues.single_word
      : PREVIEW_SUBTITLES.cues.phrase;

  const activeCue = findActiveCue(cueList, currentTime);

  // Position: bottom = 6% from bottom; top = 6% from top; center = vertical center.
  // Mirrors `margin_v = max(40, video_height * 0.06)` in subtitles.py.
  // Keep the container at full size (so containerHeight reflects the video
  // height for font scaling) and place via flex justify + padding.
  const verticalPadPct = 6;
  const positionStyle: React.CSSProperties =
    position === 'top'
      ? { justifyContent: 'flex-start', paddingTop: `${verticalPadPct}%` }
      : position === 'center'
      ? { justifyContent: 'center' }
      : { justifyContent: 'flex-end', paddingBottom: `${verticalPadPct}%` };

  // Common text styling.
  const baseTextStyle: React.CSSProperties = {
    fontFamily,
    fontWeight,
    fontSize: `${fontSize}px`,
    lineHeight: 1.15,
    letterSpacing: '0.005em',
    textAlign: 'center',
    color: preset.primary,
    textShadow:
      preset.border === 'outline'
        ? buildOutline(preset.outline, outlineW, shadow, preset.shadowColor ?? 'rgba(0,0,0,0.7)')
        : shadow > 0
        ? `${shadow}px ${shadow}px ${Math.max(2, shadow)}px ${preset.shadowColor ?? 'rgba(0,0,0,0.7)'}`
        : 'none',
    padding: preset.border === 'box' ? `${0.15 * fontSize}px ${0.4 * fontSize}px` : undefined,
    background: preset.border === 'box' ? preset.back : 'transparent',
    borderRadius: preset.border === 'box' ? `${0.08 * fontSize}px` : undefined,
    // Prevent the box variant from spanning the whole row.
    display: 'inline-block',
    maxWidth: '90%',
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
  };

  const renderCueContent = () => {
    if (!activeCue) return null;

    if (mode === 'karaoke') {
      // Per-word color sweep: spoken words use primary, unspoken use secondary.
      return activeCue.words.map((w: PreviewWord, i: number) => {
        const spoken = currentTime >= w.start;
        return (
          <React.Fragment key={`${w.start}-${i}`}>
            <span
              style={{
                color: spoken ? preset.primary : preset.secondary,
                transition: 'color 90ms linear',
              }}
            >
              {w.word}
            </span>
            {i < activeCue.words.length - 1 ? ' ' : null}
          </React.Fragment>
        );
      });
    }

    // phrase / single_word: render the cue text as-is.
    return activeCue.words.map((w) => w.word).join(' ');
  };

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex flex-col justify-center items-center"
      style={positionStyle}
    >
      {activeCue && (
        <div style={baseTextStyle}>{renderCueContent()}</div>
      )}
    </div>
  );
};

export default CaptionOverlay;
