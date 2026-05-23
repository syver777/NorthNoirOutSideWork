import React, { useState } from 'react';
import { Info, CheckCircle2 } from 'lucide-react';

// Prime Model Styles with Images
const PRIME_STYLES = [
  {
    name: 'Old Comic Book',
    description: 'black-and-white old comic book-style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Old_Comic_Book.jpg',
    style: `A black-and-white old comic book-style illustration in wide format. Features dramatic contrast, rich textures, and expressive, rough linework resembling vintage war comics. High cinematic shadows with intense lighting, giving a moody, atmospheric tone. Characters are drawn with raw, emotional detail, and each scene feels like a hand-drawn storyboard frame. Backgrounds are layered with depth, and the overall composition balances realism with a surreal, haunted quality. The style evokes mid-20th-century graphic novels with a gritty, psychological edge. Make the image bright.`,
  },
  {
    name: 'Medieval Oil Painting',
    description: 'late medieval or early Renaissance style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Medieval_Oil_Painting.jpg',
    style: `A richly colored oil painting in the style of late medieval or early Renaissance European art or Viking paintings. Features clear composition, vibrant tones, painterly textures, realistic proportions, expressive facial detail, and soft, atmospheric backgrounds. Lighting is natural with soft shadows, evoking the emotional depth and storytelling found in historical panel paintings and illuminated manuscripts. Vivid bright Colors.`,
  },
  {
    name: 'Enchanted Anime',
    description: 'painterly hand-drawn animation',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Studio_Ghibli_Style.jpg',
    style: `A painterly, hand-drawn animation style in the tradition of classic Japanese feature animation, evoking the visual sensibility of landmark studios such as Studio Ghibli. Wide format with gentle, organic linework and subtle textures that mimic traditional cel animation. The palette is lush and nature-inspired—rich greens, soft pastels, golden sunlight, and warm earth tones—evoking emotional warmth and whimsical realism. Characters are expressive with large, emotive eyes and understated facial details. Backgrounds are intricately detailed yet softly rendered, often featuring idyllic countryside, cozy interiors, or magical environments with a nostalgic glow. Lighting is natural and dynamic, shifting gently across scenes to mirror time and mood. The overall aesthetic is warm, soulful, and immersive, blending everyday simplicity with quiet enchantment.`,
  },
  {
    name: 'Pixel Art',
    description: 'retro 8-bit/16-bit pixel art',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Pixel_Art.jpg',
    style: `A retro pixel art aesthetic in wide format. Rendered with blocky, low-resolution graphics and a limited color palette inspired by 8-bit and 16-bit era video games. Characters are made up of clearly visible pixels, with expressive poses and exaggerated features to convey personality despite simplicity. The color use is bold and saturated—vivid blues, electric purples, hot pinks—and scenes often include grid-based environments like forests, dungeons, or cities. Lighting is represented through dithering or basic color shifts. The overall effect is nostalgic, playful, and full of charm, reminiscent of classic console RPGs or arcade games.`,
  },
  {
    name: 'Realistic Animation',
    description: 'hyper-realistic animated style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Realistic_Animation.jpg',
    style: `A hyper-realistic animated style in wide format. Features high-resolution textures, lifelike surface details, and dynamic environmental lighting. The animation leans into dramatic perspective with exaggerated scale, emphasizing the colossal presence of the subject. Pixar like animation. Rich, saturated colors and sharp shadows create a vivid, high-contrast look, while the rendering mimics real-world physics—reflections, ambient occlusion, and depth of field included. The style evokes cutting-edge CGI from blockbuster creature features, balancing realism with intense visual energy. Movements would feel weighty and tactile, with subtle skin flexing, muscle shifts, and light interaction enhancing the sense of realism. Backgrounds are lush and detailed, often filled with atmospheric effects like volumetric light and soft lens flare, giving the scene an immersive, cinematic punch.`,
  },
  {
    name: 'Classical Oil Painting',
    description: 'Baroque-inspired oil painting',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Classical_Oil_Painting.jpg',
    style: `A classical oil painting style inspired by the Baroque masters, particularly Caravaggio and Rembrandt, emphasizing emotional realism, dramatic chiaroscuro lighting, and a subdued, earthy palette. Figures, architecture, and objects are rendered with painterly precision and soft, blended brushwork, capturing lifelike textures such as weathered fabric, aged skin, and stone walls. The lighting is intimate and directional, often sourced from a single candle or window, casting deep shadows and highlighting facial expressions and gesture with theatrical intensity. The atmosphere evokes solemnity and inner depth, with backgrounds kept dim and ambient to draw focus toward the emotional gravity of the foreground. The overall effect is timeless, reverent, and psychologically rich—ideal for contemplative, spiritual, or philosophical themes. Bright vivid colors. Wide format.`,
  },
  {
    name: 'Anime Modern Shonen',
    description: 'dynamic high-contrast anime',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Anime_Modern_Shonen.jpg',
    style: `A high-contrast, digitally inked anime style in wide format. Features sharp, dynamic linework with bold character outlines, intense facial expressions, and exaggerated action poses. Colors are vibrant and saturated—neon blues, deep reds, and glowing yellows—with energetic lighting and dramatic highlights. Hair and clothing are stylized with clear motion lines, and visual effects like speed blurs, energy auras, or glowing eyes enhance the sense of impact. Backgrounds range from minimalist to hyper-detailed depending on the emotional beat, often with radial gradients or stylized skies. This style embodies modern action anime, cinematic in scope and driven by expressive motion.`,
  },
  {
    name: 'Dreamy Painting',
    description: 'fantasy art with serene celestial themes',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Dreamy_Painting.jpg',
    style: `A dreamy digital painting in wide format, inspired by fantasy art and serene celestial themes. The palette is composed of cool, calming tones—deep navy blues, moonlit silvers, and soft cloud whites—creating a tranquil nighttime ambiance. Backgrounds include drifting clouds, distant stars, and a vast, luminous night sky, occasionally punctuated by birds or constellations. The lighting is soft and atmospheric, enhancing the peaceful, almost meditative mood. The brushwork is smooth and blended, lending a dreamy, high-fantasy aesthetic similar to cinematic concept art or modern digital illustrations with a painterly touch. The overall feeling is one of divine calm, sleep-inducing wonder, and timeless serenity.`,
  },
  {
    name: 'Ink & Wash',
    description: 'East Asian ink-and-wash painting',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Ink_and_Wash.jpg',
    style: `A traditional East Asian ink-and-wash painting style in wide format, inspired by Chinese and Japanese landscape art. The linework is expressive and brush-based, varying in thickness with fluid, calligraphic strokes. Monochrome or limited muted palettes—grays, blacks, and sepia tones—are layered with subtle watercolor washes to evoke mist, wind, or flowing water. Figures and scenery are often stylized and abstracted, emphasizing harmony with nature rather than anatomical precision. Negative space is used intentionally, and compositions feel balanced and meditative. This aesthetic conveys quiet power, simplicity, and spiritual depth.`,
  },
  {
    name: 'Dark Medieval Fantasy',
    description: 'dark medieval animation',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Dark_Medieval_Fantasy.jpg',
    style: `A dark medieval fantasy illustration in wide format. Features bold, heavy linework with rough, painterly textures and a muted, earthy color palette of deep reds, browns, and shadows. Lighting is stark and dramatic, casting faces into harsh highlights and deep gloom. Characters are drawn with exaggerated, grim expressions, evoking dread and authority. Backgrounds feature gothic stained glass, stone walls, and banners, enhancing the ominous tone. The overall composition feels like a hand-painted tapestry mixed with comic-book intensity, with an atmosphere of ritual, judgment, and foreboding power. Make the image bright.`,
  },
  {
    name: 'Bright Illustration',
    description: 'clean vector-based illustration',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Bright_Illustration.jpg',
    style: `A brightly colored digital illustration in wide format. Features clean, smooth linework with clear, uniform outlines and minimal shading. The color palette is warm and slightly muted, dominated by earthy oranges, soft browns, and beige tones, creating a cohesive and stylized aesthetic. Characters are drawn with rounded, cartoon-like features and expressive facial details that emphasize clarity and simplicity. Textures are minimal, with a flat, poster-like quality. The overall look is inspired by modern vector-based animation with subtle nods to ancient art motifs in the clothing and accessories. The background is sparse, directing focus toward character interaction. Make the image bright.`,
  },
  {
    name: 'Modern Infographic',
    description: 'flat vector-based illustration',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Modern_Infographic.jpg',
    style: `A flat, vector-based illustration style in wide format, commonly used in educational or infographic visuals. Clean geometric shapes, crisp lines, and minimal gradients define the look. Colors are often high-contrast, matte, and chosen for clarity—bold reds, clear blues, bright yellows—with strong use of white space and iconographic symbols. Characters and objects are simplified and schematic, emphasizing communication over realism. Shadows and perspective are either absent or extremely subtle. The tone is modern, accessible, and efficient—ideal for conveying data, instruction, or abstract concepts in a visually digestible way.`,
  },
  {
    name: 'Pencil Sketch',
    description: 'monochromatic pencil sketch',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Pencil_Sketch.jpg',
    style: `A monochromatic pencil sketch style in wide format. Features soft graphite textures, smudging, and fine crosshatching to render depth and tone. The linework varies from loose and gestural to tight and controlled, capturing both quick impressions and detailed studies. Figures and environments appear raw and unpolished, with construction lines sometimes visible, lending an in-progress or documentary feel. The grayscale palette allows lighting and shading to take center stage. The overall aesthetic is intimate, thoughtful, and process-oriented—perfect for character studies, architectural drafts, or emotional storytelling.`,
  },
  {
    name: 'Low-Poly 3D Render',
    description: 'minimalist low-polygon 3D',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Low-Poly_3D_Render.jpg',
    style: `A minimalist 3D illustration style using low-polygon modeling, presented in wide format. Scenes are constructed with simplified geometric shapes and faceted surfaces, creating a clean, stylized aesthetic. Colors are flat and pastel or matte, often with subtle ambient lighting and no texture mapping. Shadows are soft and angles crisp, giving the image a playful, toy-like quality. Figures and environments are abstracted, relying on silhouette and proportion for clarity. The overall look is modern, design-oriented, and ideal for stylized infographics, games, or architectural visualizations.`,
  },
  {
    name: 'Art Nouveau Illustration',
    description: 'decorative Art Nouveau style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Art_Nouveau_Illustration.jpg',
    style: `A decorative Art Nouveau style in wide format, inspired by the works of Alphonse Mucha. Features flowing, elegant linework with intricate patterns, floral motifs, and sinuous forms. Figures are idealized and graceful, often framed within ornate borders or circular compositions. The color palette leans toward soft pastels, warm sepia tones, and muted golds, with gentle gradients and hand-drawn textures. Hair and garments follow organic curves, blending into botanical backdrops or abstract ornamentation. The overall aesthetic is romantic, timeless, and lush, with a focus on harmony, femininity, and visual rhythm.`,
  },
  {
    name: 'Charcoal and Chalk',
    description: 'dramatic charcoal and chalk drawing',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/SeedDream4.5/Charcoal_and_Chalk.jpg',
    style: `A dramatic charcoal and chalk drawing style in wide format. Utilizes rich black strokes, powdery smudges, and stark white highlights for intense contrast and expressive texture. The linework is bold, raw, and often sketchy, with a focus on light and shadow rather than fine detail. Backgrounds may dissolve into textured gradients or remain abstract. Figures appear rough yet emotionally powerful, emerging from deep shadows with luminous accents. The monochrome palette enhances a moody, timeless atmosphere, ideal for conveying drama, introspection, or historical gravitas.`,
  },
];

interface MasterPromptData {
  visualStyle: string;
  setting: string;
  atmosphere: string;
  environmentOnly: boolean;
  characters: Array<{ name: string; description: string }>;
}

interface MasterPromptProps {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  enhanceAI: boolean;
  setEnhanceAI: (enabled: boolean) => void;
  data: MasterPromptData | null;
  setData: (data: MasterPromptData | null) => void;
  disabled: boolean;
}

export default function MasterPrompt({
  enabled,
  setEnabled,
  enhanceAI,
  setEnhanceAI,
  data,
  setData,
  disabled
}: MasterPromptProps) {
  const [showMoreStyles, setShowMoreStyles] = useState(false);
  const [selectedStyleIndex, setSelectedStyleIndex] = useState<number | null>(null);

  const handleStyleSelect = (style: typeof PRIME_STYLES[0], index: number) => {
    if (!data) return;
    setData({
      ...data,
      visualStyle: style.style
    });
    setSelectedStyleIndex(index);
  };

  const handleStyleKeyDown = (e: React.KeyboardEvent, style: typeof PRIME_STYLES[0], index: number) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleStyleSelect(style, index);
    }
  };

  return (
    <div className="space-y-5">
      {/* Master Prompt Toggle Header — standalone glass box */}
      <div className="p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card">
        <div className="flex items-center justify-between">
          <div>
            <label className="flex items-center text-sm font-medium text-text-secondary">
              Enhanced Master Prompt
              <span className="ml-2 px-2.5 py-0.5 text-xs font-medium bg-status-success text-status-success rounded-full border border-status-success">
                Recommended
              </span>
            </label>
            <p className="text-xs text-text-muted mt-1">
              Provide detailed context for more accurate story generation
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Toggle enhanced master prompt"
            onClick={() => {
              const newEnabled = !enabled;
              setEnabled(newEnabled);
              if (newEnabled && !data) {
                setData({
                  visualStyle: '',
                  setting: '',
                  atmosphere: '',
                  environmentOnly: false,
                  characters: [{ name: '', description: '' }]
                });
              }
            }}
            disabled={disabled}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              enabled ? 'bg-accent' : 'bg-border'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Master Prompt Fields — each in its own glass box when enabled */}
      {enabled && data && (
        <>
          {/* Visual Style & Colors */}
          <div className="p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card">
            <label className="block text-sm font-medium text-text-secondary mb-2">
              Visual Style & Colors
              <span className="text-xs text-text-muted ml-2">(Optional)</span>
            </label>

            <div className="flex items-start gap-2 mb-4 p-2.5 bg-blue-900/20 border border-blue-500/50 rounded-xl">
              <Info className="h-4 w-4 text-blue-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-blue-200">
                Style examples are from the Prime model. Results vary by image generation model.
              </p>
            </div>

            <p className="text-xs text-text-muted mb-3">
              Style Inspiration — click to select:
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {PRIME_STYLES.slice(0, showMoreStyles ? 16 : 4).map((style, index) => (
                <div
                  key={style.name}
                  role="button"
                  tabIndex={disabled ? -1 : 0}
                  aria-label={`Select ${style.name} style`}
                  aria-pressed={selectedStyleIndex === index}
                  className={`relative rounded-2xl overflow-hidden transition-all duration-200 ${
                    disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                  } ${
                    selectedStyleIndex === index
                      ? 'ring-2 ring-accent shadow-[0_0_16px_rgba(220,38,38,0.2)]'
                      : 'ring-1 ring-white/[0.06] hover:ring-white/[0.12] hover:shadow-[0_0_20px_rgba(220,38,38,0.08)]'
                  }`}
                  onClick={() => !disabled && handleStyleSelect(style, index)}
                  onKeyDown={(e) => handleStyleKeyDown(e, style, index)}
                >
                  <div className="aspect-video w-full">
                    <img src={style.image} alt={`${style.name} style example`} className="w-full h-full object-cover" loading="lazy" />
                  </div>
                  <div className="p-3 bg-white/[0.02]">
                    <h3 className="text-sm font-medium text-white mb-0.5">{style.name}</h3>
                    <p className="text-xs text-text-muted">{style.description}</p>
                  </div>
                  {selectedStyleIndex === index && (
                    <div className="absolute top-2 right-2 bg-accent text-white rounded-full p-1">
                      <CheckCircle2 className="h-4 w-4" />
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex justify-center mt-4 mb-4">
              <button
                type="button"
                onClick={() => setShowMoreStyles(!showMoreStyles)}
                disabled={disabled}
                className={`px-5 py-2 rounded-full text-sm text-text-secondary bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition-colors ${
                  disabled ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                {showMoreStyles ? 'Show Less' : 'Show More +12'}
              </button>
            </div>

            <p className="text-xs text-text-muted mb-2">
              Or describe your own custom style:
            </p>
            <textarea
              value={data.visualStyle}
              onChange={(e) => {
                setData({
                  ...data,
                  visualStyle: e.target.value
                });
                setSelectedStyleIndex(null);
              }}
              placeholder="e.g., Dark moody colors with deep purples and blues, cinematic lighting"
              className="w-full px-4 py-3 bg-surface-input border border-white/[0.13] rounded-xl text-white/95 placeholder-white/50 text-sm focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 resize-none transition duration-150 ease-in-out"
              rows={3}
              disabled={disabled}
            />
          </div>

          {/* Setting & Time Period */}
          <div className="p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card">
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Setting & Time Period
              <span className="text-xs text-text-muted ml-2">(Optional)</span>
            </label>
            <p className="text-xs text-text-muted mb-2">
              Specify when and where the story takes place
            </p>
            <textarea
              value={data.setting}
              onChange={(e) => setData({
                ...data,
                setting: e.target.value
              })}
              placeholder="e.g., Victorian London, 1880s, foggy cobblestone streets"
              className="w-full px-4 py-3 bg-surface-input border border-white/[0.13] rounded-xl text-white/95 placeholder-white/50 text-sm focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 resize-none transition duration-150 ease-in-out"
              rows={2}
              disabled={disabled}
            />
          </div>

          {/* Atmosphere & Mood */}
          <div className="p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card">
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Atmosphere & Mood
              <span className="text-xs text-text-muted ml-2">(Optional)</span>
            </label>
            <p className="text-xs text-text-muted mb-2">
              Define the emotional tone and atmosphere of your story
            </p>
            <textarea
              value={data.atmosphere}
              onChange={(e) => setData({
                ...data,
                atmosphere: e.target.value
              })}
              placeholder="e.g., Mysterious and suspenseful with underlying sense of dread"
              className="w-full px-4 py-3 bg-surface-input border border-white/[0.13] rounded-xl text-white/95 placeholder-white/50 text-sm focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 resize-none transition duration-150 ease-in-out"
              rows={2}
              disabled={disabled}
            />
          </div>

          {/* Environment-Only Mode Toggle */}
          <div className="p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card">
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-text-secondary">
                  Environment-Only Mode
                </label>
                <p className="text-xs text-text-muted mt-1">
                  Focus only on setting/atmosphere without character descriptions
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={data.environmentOnly}
                aria-label="Toggle environment-only mode"
                onClick={() => setData({
                  ...data,
                  environmentOnly: !data.environmentOnly
                })}
                disabled={disabled}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  data.environmentOnly ? 'bg-accent' : 'bg-border'
                } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    data.environmentOnly ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Character Descriptions */}
          {!data.environmentOnly && (
            <div className="p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card">
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Character Descriptions
                <span className="text-xs text-text-muted ml-2">(Optional — Max 10)</span>
              </label>
              <p className="text-xs text-text-muted mb-3">
                Add main characters with their descriptions
              </p>
              
              <div className="space-y-3">
                {data.characters.map((char, index) => (
                  <div key={index} className="flex gap-2 items-start">
                    <div className="flex-1 space-y-2">
                      <input
                        type="text"
                        value={char.name}
                        onChange={(e) => {
                          const newChars = [...data.characters];
                          newChars[index].name = e.target.value;
                          setData({ ...data, characters: newChars });
                        }}
                        placeholder="Character name"
                        className="w-full px-4 py-3 bg-surface-input border border-white/[0.13] rounded-xl text-white/95 placeholder-white/50 text-sm focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out"
                        disabled={disabled}
                      />
                      <textarea
                        value={char.description}
                        onChange={(e) => {
                          const newChars = [...data.characters];
                          newChars[index].description = e.target.value;
                          setData({ ...data, characters: newChars });
                        }}
                        placeholder="Physical appearance, personality, background..."
                        className="w-full px-4 py-3 bg-surface-input border border-white/[0.13] rounded-xl text-white/95 placeholder-white/50 text-sm focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 resize-none transition duration-150 ease-in-out"
                        rows={2}
                        disabled={disabled}
                      />
                    </div>
                    {data.characters.length > 1 && (
                      <button
                        type="button"
                        aria-label={`Remove character ${index + 1}`}
                        onClick={() => {
                          const newChars = data.characters.filter((_, i) => i !== index);
                          setData({ ...data, characters: newChars });
                        }}
                        disabled={disabled}
                        className="mt-1 p-2 text-accent-text hover:text-accent rounded-xl hover:bg-white/[0.04] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {data.characters.length < 10 && (
                <button
                  type="button"
                  onClick={() => {
                    setData({
                      ...data,
                      characters: [...data.characters, { name: '', description: '' }]
                    });
                  }}
                  disabled={disabled}
                  className="mt-3 w-full py-2.5 rounded-xl text-accent-text text-sm font-medium flex items-center justify-center gap-2 bg-surface-card border border-border-card hover:bg-white/[0.06] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add Character
                </button>
              )}
            </div>
          )}

          {/* AI Enhancement Toggle */}
          <div className="p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <label className="flex items-center text-sm font-medium text-text-secondary">
                  AI Enhancement
                  <span className="ml-2 px-2.5 py-0.5 text-xs font-medium bg-status-success text-status-success rounded-full border border-status-success">
                    Recommended
                  </span>
                </label>
                <p className="mt-1 text-xs text-text-muted">
                  Let AI transform your basic guidelines into rich, detailed consistency notes for visual and narrative coherence.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enhanceAI}
                aria-label="Toggle AI enhancement"
                onClick={() => setEnhanceAI(!enhanceAI)}
                disabled={disabled}
                className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  enhanceAI ? 'bg-accent' : 'bg-border'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    enhanceAI ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
