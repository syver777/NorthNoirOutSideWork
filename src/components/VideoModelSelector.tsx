import React, { useState, useRef, useMemo } from 'react';
import { Play, X, Clock, Zap, CheckCircle2 } from 'lucide-react';
import {
  LEGACY_TTV_TOKENS_PER_SECOND,
  NEW_TTV_TOKENS_PER_SECOND,
} from '../data/tokenCosts';

// ─── Styles shared across all video models ───────────────────────────────────

export const TTV_STYLES = [
  {
    name: 'Classical Oil Painting',
    description: 'Baroque-inspired oil painting',
    videoFileName: 'Classical_Oil_Painting',
    style: `A classical oil painting style inspired by the Baroque masters, particularly Caravaggio and Rembrandt, emphasizing emotional realism, dramatic chiaroscuro lighting, and a subdued, earthy palette. Figures, architecture, and objects are rendered with painterly precision and soft, blended brushwork, capturing lifelike textures such as weathered fabric, aged skin, and stone walls. The lighting is intimate and directional, often sourced from a single candle or window, casting deep shadows and highlighting facial expressions and gesture with theatrical intensity. The atmosphere evokes solemnity and inner depth, with backgrounds kept dim and ambient to draw focus toward the emotional gravity of the foreground. The overall effect is timeless, reverent, and psychologically rich. Bright vivid colors. Wide format.`,
  },
  {
    name: 'Realistic Animation',
    description: 'hyper-realistic animated style',
    videoFileName: 'Realistic_Animation',
    style: `A hyper-realistic animated style in wide format. Features high-resolution textures, lifelike surface details, and dynamic environmental lighting. The animation leans into dramatic perspective with exaggerated scale, emphasizing the colossal presence of the subject. Pixar like animation. Rich, saturated colors and sharp shadows create a vivid, high-contrast look, while the rendering mimics real-world physics—reflections, ambient occlusion, and depth of field included. The style evokes cutting-edge CGI from blockbuster creature features, balancing realism with intense visual energy. Movements would feel weighty and tactile, with subtle skin flexing, muscle shifts, and light interaction enhancing the sense of realism. Backgrounds are lush and detailed, often filled with atmospheric effects like volumetric light and soft lens flare, giving the scene an immersive, cinematic punch.`,
  },
  {
    name: 'Enchanted Anime',
    description: 'painterly hand-drawn animation',
    videoFileName: 'Studio_Ghibli_Style',
    style: `A painterly, hand-drawn animation style in the tradition of classic Japanese feature animation, evoking the visual sensibility of landmark studios such as Studio Ghibli. Wide format with gentle, organic linework and subtle textures that mimic traditional cel animation. The palette is lush and nature-inspired—rich greens, soft pastels, golden sunlight, and warm earth tones—evoking emotional warmth and whimsical realism. Characters are expressive with large, emotive eyes and understated facial details. Backgrounds are intricately detailed yet softly rendered, often featuring idyllic countryside, cozy interiors, or magical environments with a nostalgic glow. Lighting is natural and dynamic, shifting gently across scenes to mirror time and mood. The overall aesthetic is warm, soulful, and immersive, blending everyday simplicity with quiet enchantment.`,
  },
  {
    name: 'Old Comic Book',
    description: 'black-and-white old comic book-style',
    videoFileName: 'Old_Comic_Book',
    style: `A black-and-white old comic book-style illustration in wide format. Features dramatic contrast, rich textures, and expressive, rough linework resembling vintage war comics. High cinematic shadows with intense lighting, giving a moody, atmospheric tone. Characters are drawn with raw, emotional detail, and each scene feels like a hand-drawn storyboard frame. Backgrounds are layered with depth, and the overall composition balances realism with a surreal, haunted quality. The style evokes mid-20th-century graphic novels with a gritty, psychological edge. Make the image bright.`,
  },
  {
    name: 'Anime Modern Shonen',
    description: 'dynamic high-contrast anime',
    videoFileName: 'Anime_Modern_Shonen',
    style: `A high-contrast, digitally inked anime style in wide format. Features sharp, dynamic linework with bold character outlines, intense facial expressions, and exaggerated action poses. Colors are vibrant and saturated—neon blues, deep reds, and glowing yellows—with energetic lighting and dramatic highlights. Hair and clothing are stylized with clear motion lines, and visual effects like speed blurs, energy auras, or glowing eyes enhance the sense of impact. Backgrounds range from minimalist to hyper-detailed depending on the emotional beat, often with radial gradients or stylized skies. This style embodies modern action anime, cinematic in scope and driven by expressive motion.`,
  },
  {
    name: 'Art Nouveau Illustration',
    description: 'decorative Art Nouveau style',
    videoFileName: 'Art_Nouveau_Illustration',
    style: `A decorative Art Nouveau style in wide format, inspired by the works of Alphonse Mucha. Features flowing, elegant linework with intricate patterns, floral motifs, and sinuous forms. Figures are idealized and graceful, often framed within ornate borders or circular compositions. The color palette leans toward soft pastels, warm sepia tones, and muted golds, with gentle gradients and hand-drawn textures. Hair and garments follow organic curves, blending into botanical backdrops or abstract ornamentation. The overall aesthetic is romantic, timeless, and lush, with a focus on harmony, femininity, and visual rhythm.`,
  },
  {
    name: 'Bright Illustration',
    description: 'clean vector-based illustration',
    videoFileName: 'Bright_Illustration',
    style: `A brightly colored digital illustration in wide format. Features clean, smooth linework with clear, uniform outlines and minimal shading. The color palette is warm and slightly muted, dominated by earthy oranges, soft browns, and beige tones, creating a cohesive and stylized aesthetic. Characters are drawn with rounded, cartoon-like features and expressive facial details that emphasize clarity and simplicity. Textures are minimal, with a flat, poster-like quality. The overall look is inspired by modern vector-based animation with subtle nods to ancient art motifs in the clothing and accessories. The background is sparse, directing focus toward character interaction. Make the image bright.`,
  },
  {
    name: 'Charcoal and Chalk',
    description: 'dramatic charcoal and chalk drawing',
    videoFileName: 'Charcoal_and_Chalk',
    style: `A dramatic charcoal and chalk drawing style in wide format. Utilizes rich black strokes, powdery smudges, and stark white highlights for intense contrast and expressive texture. The linework is bold, raw, and often sketchy, with a focus on light and shadow rather than fine detail. Backgrounds may dissolve into textured gradients or remain abstract. Figures appear rough yet emotionally powerful, emerging from deep shadows with luminous accents. The monochrome palette enhances a moody, timeless atmosphere, ideal for conveying drama, introspection, or historical gravitas.`,
  },
  {
    name: 'Cinematic Film',
    description: 'Hollywood film quality',
    videoFileName: 'Cinematic_Film',
    style: `Cinematic film style with dramatic lighting, shallow depth of field, wide-angle composition, professional color grading, authentic environments and naturalistic movement.`,
  },
  {
    name: 'Dark Medieval Fantasy',
    description: 'dark medieval animation',
    videoFileName: 'Dark_Medieval_Fantasy',
    style: `A dark medieval fantasy illustration in wide format. Features bold, heavy linework with rough, painterly textures and a muted, earthy color palette of deep reds, browns, and shadows. Lighting is stark and dramatic, casting faces into harsh highlights and deep gloom. Characters are drawn with exaggerated, grim expressions, evoking dread and authority. Backgrounds feature gothic stained glass, stone walls, and banners, enhancing the ominous tone. The overall composition feels like a hand-painted tapestry mixed with comic-book intensity, with an atmosphere of ritual, judgment, and foreboding power. Make the image bright.`,
  },
  {
    name: 'Dreamy Painting',
    description: 'fantasy art with serene celestial themes',
    videoFileName: 'Dreamy_Painting',
    style: `A dreamy digital painting in wide format, inspired by fantasy art and serene celestial themes. The palette is composed of cool, calming tones—deep navy blues, moonlit silvers, and soft cloud whites—creating a tranquil nighttime ambiance. Backgrounds include drifting clouds, distant stars, and a vast, luminous night sky, occasionally punctuated by birds or constellations. The lighting is soft and atmospheric, enhancing the peaceful, almost meditative mood. The brushwork is smooth and blended, lending a dreamy, high-fantasy aesthetic similar to cinematic concept art or modern digital illustrations with a painterly touch. The overall feeling is one of divine calm, sleep-inducing wonder, and timeless serenity.`,
  },
  {
    name: 'Ink & Wash',
    description: 'East Asian ink-and-wash painting',
    videoFileName: 'Ink_and_Wash',
    style: `A traditional East Asian ink-and-wash painting style in wide format, inspired by Chinese and Japanese landscape art. The linework is expressive and brush-based, varying in thickness with fluid, calligraphic strokes. Monochrome or limited muted palettes—grays, blacks, and sepia tones—are layered with subtle watercolor washes to evoke mist, wind, or flowing water. Figures and scenery are often stylized and abstracted, emphasizing harmony with nature rather than anatomical precision. Negative space is used intentionally, and compositions feel balanced and meditative. This aesthetic conveys quiet power, simplicity, and spiritual depth.`,
  },
  {
    name: 'Medieval Oil Painting',
    description: 'late medieval or early Renaissance style',
    videoFileName: 'Medieval_Oil_Painting',
    style: `A richly colored oil painting in the style of late medieval or early Renaissance European art or Viking paintings. Features clear composition, vibrant tones, painterly textures, realistic proportions, expressive facial detail, and soft, atmospheric backgrounds. Lighting is natural with soft shadows, evoking the emotional depth and storytelling found in historical panel paintings and illuminated manuscripts. Vivid bright Colors.`,
  },
  {
    name: 'Modern Infographic',
    description: 'flat vector-based illustration',
    videoFileName: 'Modern_Infographic',
    style: `A flat, vector-based illustration style in wide format, commonly used in educational or infographic visuals. Clean geometric shapes, crisp lines, and minimal gradients define the look. Colors are often high-contrast, matte, and chosen for clarity—bold reds, clear blues, bright yellows—with strong use of white space and iconographic symbols. Characters and objects are simplified and schematic, emphasizing communication over realism. Shadows and perspective are either absent or extremely subtle. The tone is modern, accessible, and efficient—ideal for conveying data, instruction, or abstract concepts in a visually digestible way.`,
  },
  {
    name: 'Pencil Sketch',
    description: 'monochromatic pencil sketch',
    videoFileName: 'Pencil_Sketch',
    style: `A monochromatic pencil sketch style in wide format. Features soft graphite textures, smudging, and fine crosshatching to render depth and tone. The linework varies from loose and gestural to tight and controlled, capturing both quick impressions and detailed studies. Figures and environments appear raw and unpolished, with construction lines sometimes visible, lending an in-progress or documentary feel. The grayscale palette allows lighting and shading to take center stage. The overall aesthetic is intimate, thoughtful, and process-oriented—perfect for character studies, architectural drafts, or emotional storytelling.`,
  },
  {
    name: 'Pixel Art',
    description: 'retro 8-bit/16-bit pixel art',
    videoFileName: 'Pixel_Art',
    style: `A retro pixel art aesthetic in wide format. Rendered with blocky, low-resolution graphics and a limited color palette inspired by 8-bit and 16-bit era video games. Characters are made up of clearly visible pixels, with expressive poses and exaggerated features to convey personality despite simplicity. The color use is bold and saturated—vivid blues, electric purples, hot pinks—and scenes often include grid-based environments like forests, dungeons, or cities. Lighting is represented through dithering or basic color shifts. The overall effect is nostalgic, playful, and full of charm, reminiscent of classic console RPGs or arcade games.`,
  },
];

// ─── Model-to-style-folder mapping ───────────────────────────────────────────

export const VIDEO_STYLE_FOLDERS: Record<string, string> = {
  wan22: 'Wan2.2Videos',
  seedance_pro_fast: 'seedanceProFastVideo',
  ltx23_fast: 'ltx23FastVideo',
  seedance15_pro: 'seedance15ProVideo',
  ltx23_pro: 'ltx23ProVideo',
  grok: 'grokVideo',
  veo31fast: 'Veo31Fast',
  veo31: 'Veo31',
  sora2pro: 'Sora2Pro',
  sora2pro_highres: 'Sora2Pro_HighRes',
};

export function getStyleVideoUrl(modelValue: string, videoFileName: string): string {
  const folder = VIDEO_STYLE_FOLDERS[modelValue] ?? 'Wan2.2Videos';
  return `https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/${folder}/${videoFileName}.mp4`;
}

// ─── Model duration configurations ───────────────────────────────────────────

export interface VideoModelConfig {
  value: string;
  label: string;
  tier: string;
  description: string;
  longDescription: string;
  tokensPerSecond: number;
  durationType: 'fixed' | 'options' | 'slider';
  defaultDuration: number;
  durationOptions?: number[];
  durationMin?: number;
  durationMax?: number;
  resolution: string;
  exampleVideoUrl: string;
  exampleThumbnail: string;
  borderColor: string;
  bgColor: string;
  textColor: string;
  badgeBg: string;
  badgeText: string;
  tierOrder: number;
  recommended?: boolean;
}

export const VIDEO_MODEL_OPTIONS: VideoModelConfig[] = [
  // NOTE: 'wan22' has been retired from the TTV selector. The execution backend
  // (generate-TTV / single-TTV / process-TTV / redo-TTV / setup-TTV-tasks) still
  // accepts 'wan22' so that already-queued in-flight tasks can finish, but it is
  // no longer offered as a new selection in the UI or by the planner.
  {
    value: 'seedance_pro_fast',
    label: 'Seedance 1.0 Pro Fast',
    tier: 'Standard',
    description: 'Fast & reliable 720p',
    longDescription: 'Seedance 1.0 Pro Fast delivers reliable 720p video with flexible 2–12 second clip durations. Fast processing at a competitive price point.',
    tokensPerSecond: 13200,
    durationType: 'slider',
    defaultDuration: 6,
    durationMin: 2,
    durationMax: 12,
    resolution: '720p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/TTVExamples/seedance_pro_fast_example.mp4',
    exampleThumbnail: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ThumbnailTest.jpg',
    borderColor: 'border-model-standard-a-accent',
    bgColor: 'bg-cyan-900/25',
    textColor: 'text-model-standard-a',
    badgeBg: 'bg-model-standard-a-accent',
    badgeText: 'text-white',
    tierOrder: 2,
  },
  {
    value: 'ltx23_fast',
    label: 'LTX 2.3 Fast',
    tier: 'Standard',
    description: '1080p with native audio',
    longDescription: 'LTX 2.3 Fast produces crisp 1080p video at 25 fps with native audio support at no extra cost. Choose from 6, 10, or 16 second clips.',
    tokensPerSecond: 24000,
    durationType: 'options',
    defaultDuration: 6,
    durationOptions: [6, 10, 16],
    resolution: '1080p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/TTVExamples/ltx23_fast_example.mp4',
    exampleThumbnail: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ThumbnailTest.jpg',
    borderColor: 'border-model-standard-b-accent',
    bgColor: 'bg-blue-900/25',
    textColor: 'text-model-standard-b',
    badgeBg: 'bg-model-standard-b-accent',
    badgeText: 'text-white',
    tierOrder: 3,
  },
  {
    value: 'grok',
    label: 'Grok Video',
    tier: 'Plus',
    description: 'Best balance of quality & cost',
    longDescription: 'xAI\'s Grok video model with flexible duration control — set any length from 2 to 15 seconds per clip. Excellent quality at a competitive price point.',
    tokensPerSecond: 30000,
    durationType: 'slider',
    defaultDuration: 5,
    durationMin: 2,
    durationMax: 15,
    resolution: '480p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/TTVExamples/grok_example.mp4',
    exampleThumbnail: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ThumbnailTest.jpg',
    borderColor: 'border-model-plus-a-accent',
    bgColor: 'bg-indigo-900/25',
    textColor: 'text-model-plus-a',
    badgeBg: 'bg-model-plus-a-accent',
    badgeText: 'text-white',
    tierOrder: 4,
    recommended: true,
  },
  {
    value: 'seedance15_pro',
    label: 'Seedance 1.5 Pro',
    tier: 'Plus',
    description: 'Premium 1080p with optional audio',
    longDescription: 'Seedance 1.5 Pro delivers premium 1080p motion fidelity with 4–12 second clips. Optional audio generation at 2× token cost for immersive content.',
    tokensPerSecond: 34800,
    durationType: 'slider',
    defaultDuration: 6,
    durationMin: 4,
    durationMax: 12,
    resolution: '1080p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/TTVExamples/seedance15_pro_example.mp4',
    exampleThumbnail: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ThumbnailTest.jpg',
    borderColor: 'border-model-plus-b-accent',
    bgColor: 'bg-violet-900/25',
    textColor: 'text-model-plus-b',
    badgeBg: 'bg-model-plus-b-accent',
    badgeText: 'text-white',
    tierOrder: 5,
  },
  {
    value: 'veo31fast',
    label: 'Veo 3.1 Fast',
    tier: 'Pro',
    description: 'Google Veo, high speed',
    longDescription: 'Google\'s Veo 3.1 model in fast mode. High-quality cinematic output optimised for throughput.',
    tokensPerSecond: 60000,
    durationType: 'options',
    defaultDuration: 4,
    durationOptions: [4, 6, 8],
    resolution: '1080p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/TTVExamples/veo31fast_example.mp4',
    exampleThumbnail: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ThumbnailTest.jpg',
    borderColor: 'border-model-pro-a-accent',
    bgColor: 'bg-teal-900/25',
    textColor: 'text-model-pro-a',
    badgeBg: 'bg-model-pro-a-accent',
    badgeText: 'text-white',
    tierOrder: 6,
  },
  {
    value: 'ltx23_pro',
    label: 'LTX 2.3 Pro',
    tier: 'Pro',
    description: 'Ultra HD 1440p with native audio',
    longDescription: 'LTX 2.3 Pro produces stunning 1440p ultra-HD video at 50 fps with native audio support at no extra cost. Premium visual fidelity.',
    tokensPerSecond: 72000,
    durationType: 'options',
    defaultDuration: 6,
    durationOptions: [6, 8, 10],
    resolution: '1440p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/TTVExamples/ltx23_pro_example.mp4',
    exampleThumbnail: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ThumbnailTest.jpg',
    borderColor: 'border-model-pro-b-accent',
    bgColor: 'bg-purple-900/25',
    textColor: 'text-model-pro-b',
    badgeBg: 'bg-model-pro-b-accent',
    badgeText: 'text-white',
    tierOrder: 7,
  },
  {
    value: 'veo31',
    label: 'Veo 3.1',
    tier: 'Elite',
    description: 'Google\'s top video AI',
    longDescription: 'Google\'s premium Veo 3.1 model delivering state-of-the-art video quality with exceptional realism and motion coherence.',
    tokensPerSecond: 120000,
    durationType: 'options',
    defaultDuration: 4,
    durationOptions: [4, 6, 8],
    resolution: '1080p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/TTVExamples/veo31_example.mp4',
    exampleThumbnail: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ThumbnailTest.jpg',
    borderColor: 'border-model-elite-accent',
    bgColor: 'bg-emerald-900/25',
    textColor: 'text-model-elite',
    badgeBg: 'bg-model-elite-accent',
    badgeText: 'text-white',
    tierOrder: 8,
  },
  {
    value: 'sora2pro',
    label: 'Sora 2 Pro',
    tier: 'Ultimate',
    description: 'OpenAI Sora — 720p',
    longDescription: 'OpenAI\'s industry-leading Sora 2 Pro model. Unmatched temporal coherence, cinematic quality, and story comprehension. 1280×720 standard, 1792×1024 high-res.',
    tokensPerSecond: 180000,
    durationType: 'options',
    defaultDuration: 4,
    durationOptions: [4, 8, 12],
    resolution: '1280×720',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/TTVExamples/sora2pro_example.mp4',
    exampleThumbnail: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ThumbnailTest.jpg',
    borderColor: 'border-model-ultimate-accent',
    bgColor: 'bg-yellow-900/25',
    textColor: 'text-model-ultimate',
    badgeBg: 'bg-gradient-to-r from-model-ultimate to-model-ultimate-accent',
    badgeText: 'text-surface-primary',
    tierOrder: 9,
  },
];

// Returns a plan-aware copy of VIDEO_MODEL_OPTIONS with per-second token rates
// swapped in from the active plan map.
export function buildVideoModelOptions(isLegacy: boolean): VideoModelConfig[] {
  const tps = isLegacy ? LEGACY_TTV_TOKENS_PER_SECOND : NEW_TTV_TOKENS_PER_SECOND;
  return VIDEO_MODEL_OPTIONS.map(m => ({
    ...m,
    tokensPerSecond: tps[m.value] ?? m.tokensPerSecond,
  }));
}

// ─── Component props ──────────────────────────────────────────────────────────

interface VideoModelSelectorProps {
  selectedModel: string;
  selectedStyle: string;
  videoDuration: number;
  onModelChange: (model: string) => void;
  onStyleChange: (style: string) => void;
  onDurationChange: (duration: number) => void;
  disabled?: boolean;
  /** Defaults to true (legacy plan rates) so unspecified callers stay safe. */
  isLegacy?: boolean;
}

// ─── Per-model card ───────────────────────────────────────────────────────────

interface ModelCardProps {
  model: VideoModelConfig;
  isSelected: boolean;
  selectedStyle: string;
  videoDuration: number;
  onSelect: () => void;
  onStyleChange: (style: string) => void;
  onDurationChange: (duration: number) => void;
  disabled?: boolean;
}

function ModelCard({
  model,
  isSelected,
  selectedStyle,
  videoDuration,
  onSelect,
  onStyleChange,
  onDurationChange,
  disabled,
}: ModelCardProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [sliderValue, setSliderValue] = useState<number>(model.defaultDuration);
  const [inputValue, setInputValue] = useState<string>(String(model.defaultDuration));
  const videoRef = useRef<HTMLVideoElement>(null);

  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!model.exampleVideoUrl) return;
    setIsPlaying(true);
    setTimeout(() => videoRef.current?.play(), 50);
  };

  const handleVideoClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsPlaying(false);
    videoRef.current?.pause();
    if (videoRef.current) videoRef.current.currentTime = 0;
  };

  const handleSliderChange = (val: number) => {
    setSliderValue(val);
    setInputValue(String(val));
    onDurationChange(val);
  };

  const handleInputChange = (raw: string) => {
    setInputValue(raw);
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed >= (model.durationMin ?? 1) && parsed <= (model.durationMax ?? 99)) {
      setSliderValue(parsed);
      onDurationChange(parsed);
    }
  };

  const effectiveDuration = model.durationType === 'slider' ? sliderValue : videoDuration;

  const costPerClip = (effectiveDuration * model.tokensPerSecond).toLocaleString();

  return (
    <div
      onClick={() => !disabled && onSelect()}
      className={`relative rounded-xl border-2 transition-all cursor-pointer overflow-hidden ${
        isSelected
          ? `${model.borderColor} ${model.bgColor}`
          : 'border-border bg-surface-card hover:border-border-subtle hover:bg-surface-elevated/50'
      } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
    >
      {/* Recommended badge */}
      {model.recommended && (
        <div className="absolute -top-2 -right-2 bg-status-success-muted text-white text-xs px-2 py-1 rounded-full z-10">
          Recommended
        </div>
      )}

      {/* Selected checkmark */}
      {isSelected && (
        <div className="absolute top-2 right-2 z-10">
          <CheckCircle2 className={`h-5 w-5 ${model.textColor}`} />
        </div>
      )}

      {/* Video preview area */}
      <div className="relative w-full h-36 bg-surface-card overflow-hidden">
        {/* Thumbnail */}
        {model.exampleThumbnail && !isPlaying && (
          <img
            src={model.exampleThumbnail}
            alt={`${model.label} example`}
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        )}

        {/* No thumbnail fallback */}
        {!model.exampleThumbnail && !isPlaying && (
          <div className="w-full h-full flex items-center justify-center bg-surface-card">
            <span className="text-text-dim text-xs text-center px-2">Preview coming soon</span>
          </div>
        )}

        {/* Video element (lazy loaded) */}
        {isPlaying && model.exampleVideoUrl && (
          <video
            ref={videoRef}
            src={model.exampleVideoUrl}
            className="w-full h-full object-cover"
            loop
            muted
            playsInline
            onError={() => setIsPlaying(false)}
          />
        )}

        {/* Play button overlay */}
        {!isPlaying && (
          <button
            onClick={handlePlay}
            className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/50 transition-colors group"
            title="Play example"
          >
            <div className="w-10 h-10 rounded-full bg-white/90 flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
              <Play className="h-4 w-4 text-surface-primary ml-0.5" fill="currentColor" />
            </div>
          </button>
        )}

        {/* Stop video button */}
        {isPlaying && (
          <button
            onClick={handleVideoClose}
            className="absolute top-1 right-1 w-7 h-7 rounded-full bg-black/70 flex items-center justify-center hover:bg-black/90 transition-colors z-20"
          >
            <X className="h-3 w-3 text-white" />
          </button>
        )}
      </div>

      {/* Model info */}
      <div className="p-3">
        <div className="flex items-start justify-between mb-1">
          <h3 className={`text-sm font-semibold ${isSelected ? model.textColor : 'text-white'}`}>
            {model.label}
          </h3>
          <span className="text-xs text-text-dim ml-1">{model.resolution}</span>
        </div>
        <p className="text-xs text-text-dim mb-2">{model.description}</p>

        {/* Token cost indicator */}
        <div className="flex items-center gap-1 text-xs text-text-dim">
          <Zap className="h-3 w-3" />
          <span>{(model.tokensPerSecond / 1000).toFixed(0)}K tokens/sec</span>
        </div>

        {/* Expanded: duration + styles (only when selected) */}
        {isSelected && (
          <div className="mt-3 space-y-3" onClick={(e) => e.stopPropagation()}>
            {/* Duration configuration */}
            <div>
              <div className="flex items-center gap-1 mb-1.5">
                <Clock className="h-3 w-3 text-text-dim" />
                <span className="text-xs font-medium text-text-muted">Clip Duration</span>
                <span className="text-xs text-text-dim ml-1">• {costPerClip} tokens/clip</span>
              </div>

              {model.durationType === 'fixed' && (
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-semibold ${model.textColor}`}>
                    {model.defaultDuration}s
                  </span>
                  <span className="text-xs text-text-dim">(fixed for this model)</span>
                </div>
              )}

              {model.durationType === 'options' && model.durationOptions && (
                <div className="flex flex-wrap gap-1.5">
                  {model.durationOptions.map((opt) => (
                    <button
                      key={opt}
                      onClick={() => onDurationChange(opt)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                        videoDuration === opt
                          ? `${model.bgColor} ${model.borderColor} border ${model.textColor}`
                          : 'bg-surface-elevated border border-border text-text-muted hover:border-border-subtle'
                      }`}
                    >
                      {opt}s
                    </button>
                  ))}
                </div>
              )}

              {model.durationType === 'slider' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={model.durationMin}
                      max={model.durationMax}
                      value={sliderValue}
                      onChange={(e) => handleSliderChange(Number(e.target.value))}
                      className="flex-1 h-2 bg-surface-elevated rounded-lg appearance-none cursor-pointer accent-indigo-500"
                    />
                    <div className="flex items-center">
                      <input
                        type="number"
                        value={inputValue}
                        onChange={(e) => handleInputChange(e.target.value)}
                        min={model.durationMin}
                        max={model.durationMax}
                        className={`w-12 text-center text-xs rounded-md border py-1 bg-surface-card ${model.borderColor} ${model.textColor} focus:outline-none`}
                      />
                      <span className="text-xs text-text-dim ml-1">s</span>
                    </div>
                  </div>
                  <div className="flex justify-between text-xs text-text-dim">
                    <span>{model.durationMin}s min</span>
                    <span>{model.durationMax}s max</span>
                  </div>
                </div>
              )}
            </div>

            {/* Style selection */}
            <div>
              <span className="text-xs font-medium text-text-muted block mb-1.5">Visual Style</span>
              <div className="grid grid-cols-2 gap-1.5 max-h-44 overflow-y-auto pr-0.5">
                {TTV_STYLES.map((style) => (
                  <button
                    key={style.name}
                    onClick={() => onStyleChange(style.style)}
                    className={`text-left rounded-lg overflow-hidden border transition-all ${
                      selectedStyle === style.style
                        ? `${model.borderColor} ${model.bgColor}`
                        : 'border-border bg-surface-elevated hover:border-border-subtle'
                    }`}
                  >
                    {/* Style thumbnail */}
                    <div className="h-12 bg-surface-card overflow-hidden">
                      <video
                        src={getStyleVideoUrl(model.value, style.videoFileName)}
                        className="w-full h-full object-cover"
                        preload="metadata"
                        muted
                        playsInline
                      />
                    </div>
                    <div className="px-1.5 py-1">
                      <div className={`text-xs font-medium leading-tight ${selectedStyle === style.style ? model.textColor : 'text-text-muted'}`}>
                        {style.name}
                      </div>
                      <div className="text-xs text-text-dim leading-tight">{style.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Long description */}
            <p className="text-xs text-text-dim leading-relaxed border-t border-border pt-2">
              {model.longDescription}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main VideoModelSelector ──────────────────────────────────────────────────

export default function VideoModelSelector({
  selectedModel,
  selectedStyle,
  videoDuration,
  onModelChange,
  onStyleChange,
  onDurationChange,
  disabled = false,
  isLegacy = true,
}: VideoModelSelectorProps) {
  const options = useMemo(() => buildVideoModelOptions(isLegacy), [isLegacy]);
  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {options.map((model) => (
          <ModelCard
            key={model.value}
            model={model}
            isSelected={selectedModel === model.value}
            selectedStyle={selectedStyle}
            videoDuration={videoDuration}
            onSelect={() => {
              onModelChange(model.value);
              // Set default duration for the newly selected model
              const defaultDur =
                model.durationType === 'fixed'
                  ? model.defaultDuration
                  : model.durationOptions?.[0] ?? model.defaultDuration;
              onDurationChange(defaultDur);
              // Reset style when model changes (optional — styles are shared, so keep selection)
            }}
            onStyleChange={onStyleChange}
            onDurationChange={onDurationChange}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}
