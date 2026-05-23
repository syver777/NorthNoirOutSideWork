import React, { useState, useMemo } from 'react';
import { CheckCircle2, ChevronDown, Info, AlertCircle, RefreshCw, X } from 'lucide-react';
import { Listbox, Transition } from '@headlessui/react';
import ImageFrequencyConfiguration from './ImageFrequencyConfiguration';
import { useIsLegacyPlan } from '../hooks/useIsLegacyPlan';
import {
  LEGACY_LLM_MULTIPLIERS,
  NEW_LLM_MULTIPLIERS,
  LEGACY_IMAGE_TOKENS_PER_IMAGE,
  NEW_IMAGE_TOKENS_PER_IMAGE,
} from '../data/tokenCosts';

// Approximate storage footprint (MB) per generated image; mirrors ImageGenerator.tsx.
const IMAGE_SIZE_MB = 1;

// Types
interface StoryDocument {
  id: string;
  title: string;
  description?: string;
  is_corrected: boolean;
  version?: number;
  group_id?: string;
  created_at: string;
  file_path: string;
  word_count?: number;
  image_model?: string;
}

interface AudioFile {
  path: string;
  name: string;
  duration: number;
  url?: string;
}

interface NewPromptsSettings {
  style: string;
  useCharacterDescriptions: boolean;
  customCharactersEnabled: boolean;
  customCharacters: Array<{ name: string; description: string }>;
  customCharactersAIEnhance: boolean;
  firstPageFrequency: string;
  restFrequency: string;
  imageModel: 'standard' | 'plus' | 'premium' | 'spark' | 'prime' | 'genesis';
  language: string;
  model: string;
  frequencyMode?: 'wordcount' | 'audio';
  frequencyType?: 'consistent' | 'variable';
  consistentFrequency?: string;
  audioFiles?: AudioFile[];
  totalAudioDuration?: number;
  imageAmount?: string;
  audioDistributionType?: 'consistent' | 'variable';
  audioFirstPageImageCount?: string;
  audioRestImageCount?: string;
}

interface ValidationErrors {
  firstPageFrequency?: string;
  restFrequency?: string;
}

interface CombinedEstimate {
  totalImages: number;
  promptTokens: number;
  imageTokens: number;
  totalTokens: number;
  storageNeeded: number;
}

// Style arrays (complete arrays from ImageModelSelector.tsx)
const STANDARD_STYLES = [
  {
    name: 'Old Comic Book',
    description: 'black-and-white old comic book-style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Old%20Comic%20Book.jpg',
    style: `A black-and-white old comic book-style illustration in wide format. Features dramatic contrast, rich textures, and expressive, rough linework resembling vintage war comics. High cinematic shadows with intense lighting, giving a moody, atmospheric tone. Characters are drawn with raw, emotional detail, and each scene feels like a hand-drawn storyboard frame. Backgrounds are layered with depth, and the overall composition balances realism with a surreal, haunted quality. The style evokes mid-20th-century graphic novels with a gritty, psychological edge. Make the image bright.`,
  },
  {
    name: 'Medieval Oil Painting',
    description: 'late medieval or early Renaissance style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Medieval%20Oil%20Painting.jpg',
    style: `A richly colored oil painting in the style of late medieval or early Renaissance European art or Viking paintings. Features clear composition, vibrant tones, painterly textures, realistic proportions, expressive facial detail, and soft, atmospheric backgrounds. Lighting is natural with soft shadows, evoking the emotional depth and storytelling found in historical panel paintings and illuminated manuscripts. Vivid bright Colors.`,
  },
  {
    name: 'Enchanted Anime',
    description: 'painterly hand-drawn animation',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Studio%20Ghibli%20Style.jpg',
    style: `A painterly, hand-drawn animation style in the tradition of classic Japanese feature animation, evoking the visual sensibility of landmark studios such as Studio Ghibli. Wide format with gentle, organic linework and subtle textures that mimic traditional cel animation. The palette is lush and nature-inspired—rich greens, soft pastels, golden sunlight, and warm earth tones—evoking emotional warmth and whimsical realism. Characters are expressive with large, emotive eyes and understated facial details. Backgrounds are intricately detailed yet softly rendered, often featuring idyllic countryside, cozy interiors, or magical environments with a nostalgic glow. Lighting is natural and dynamic, shifting gently across scenes to mirror time and mood. The overall aesthetic is warm, soulful, and immersive, blending everyday simplicity with quiet enchantment.`,
  },
  {
    name: 'Pixel Art',
    description: 'retro 8-bit/16-bit pixel art',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Pixel%20Art.jpg',
    style: `A retro pixel art aesthetic in wide format. Rendered with blocky, low-resolution graphics and a limited color palette inspired by 8-bit and 16-bit era video games. Characters are made up of clearly visible pixels, with expressive poses and exaggerated features to convey personality despite simplicity. The color use is bold and saturated—vivid blues, electric purples, hot pinks—and scenes often include grid-based environments like forests, dungeons, or cities. Lighting is represented through dithering or basic color shifts. The overall effect is nostalgic, playful, and full of charm, reminiscent of classic console RPGs or arcade games.`,
  },
  {
    name: 'Realistic Animation',
    description: 'hyper-realistic animated style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Realistic%20Animation.jpg',
    style: `A hyper-realistic animated style in wide format. Features high-resolution textures, lifelike surface details, and dynamic environmental lighting. The animation leans into dramatic perspective with exaggerated scale, emphasizing the colossal presence of the subject. Pixar like animation. Rich, saturated colors and sharp shadows create a vivid, high-contrast look, while the rendering mimics real-world physics—reflections, ambient occlusion, and depth of field included. The style evokes cutting-edge CGI from blockbuster creature features, balancing realism with intense visual energy. Movements would feel weighty and tactile, with subtle skin flexing, muscle shifts, and light interaction enhancing the sense of realism. Backgrounds are lush and detailed, often filled with atmospheric effects like volumetric light and soft lens flare, giving the scene an immersive, cinematic punch.`,
  },
  {
    name: 'Classical Oil Painting',
    description: 'Baroque-inspired oil painting',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Classical%20Oil%20Painting.jpg',
    style: `A classical oil painting style inspired by the Baroque masters, particularly Caravaggio and Rembrandt, emphasizing emotional realism, dramatic chiaroscuro lighting, and a subdued, earthy palette. Figures, architecture, and objects are rendered with painterly precision and soft, blended brushwork, capturing lifelike textures such as weathered fabric, aged skin, and stone walls. The lighting is intimate and directional, often sourced from a single candle or window, casting deep shadows and highlighting facial expressions and gesture with theatrical intensity. The atmosphere evokes solemnity and inner depth, with backgrounds kept dim and ambient to draw focus toward the emotional gravity of the foreground. The overall effect is timeless, reverent, and psychologically rich—ideal for contemplative, spiritual, or philosophical themes. Bright vivid colors. Wide format.`,
  },
  {
    name: 'Anime Modern Shonen',
    description: 'dynamic high-contrast anime',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Anime%20Modern%20Shonen.jpg',
    style: `A high-contrast, digitally inked anime style in wide format. Features sharp, dynamic linework with bold character outlines, intense facial expressions, and exaggerated action poses. Colors are vibrant and saturated—neon blues, deep reds, and glowing yellows—with energetic lighting and dramatic highlights. Hair and clothing are stylized with clear motion lines, and visual effects like speed blurs, energy auras, or glowing eyes enhance the sense of impact. Backgrounds range from minimalist to hyper-detailed depending on the emotional beat, often with radial gradients or stylized skies. This style embodies modern action anime, cinematic in scope and driven by expressive motion.`,
  },
  {
    name: 'Dreamy Painting',
    description: 'fantasy art with serene celestial themes',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Dreamy%20Painting.jpg',
    style: `A dreamy digital painting in wide format, inspired by fantasy art and serene celestial themes. The palette is composed of cool, calming tones—deep navy blues, moonlit silvers, and soft cloud whites—creating a tranquil nighttime ambiance. Backgrounds include drifting clouds, distant stars, and a vast, luminous night sky, occasionally punctuated by birds or constellations. The lighting is soft and atmospheric, enhancing the peaceful, almost meditative mood. The brushwork is smooth and blended, lending a dreamy, high-fantasy aesthetic similar to cinematic concept art or modern digital illustrations with a painterly touch. The overall feeling is one of divine calm, sleep-inducing wonder, and timeless serenity.`,
  },
  {
    name: 'Ink & Wash',
    description: 'East Asian ink-and-wash painting',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Ink_and_Wash.jpg',
    style: `A traditional East Asian ink-and-wash painting style in wide format, inspired by Chinese and Japanese landscape art. The linework is expressive and brush-based, varying in thickness with fluid, calligraphic strokes. Monochrome or limited muted palettes—grays, blacks, and sepia tones—are layered with subtle watercolor washes to evoke mist, wind, or flowing water. Figures and scenery are often stylized and abstracted, emphasizing harmony with nature rather than anatomical precision. Negative space is used intentionally, and compositions feel balanced and meditative. This aesthetic conveys quiet power, simplicity, and spiritual depth.`,
  },
  {
    name: 'Dark Medieval Fantasy',
    description: 'dark medieval animation',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Dark%20Medieval%20Fantasy.jpg',
    style: `A dark medieval fantasy illustration in wide format. Features bold, heavy linework with rough, painterly textures and a muted, earthy color palette of deep reds, browns, and shadows. Lighting is stark and dramatic, casting faces into harsh highlights and deep gloom. Characters are drawn with exaggerated, grim expressions, evoking dread and authority. Backgrounds feature gothic stained glass, stone walls, and banners, enhancing the ominous tone. The overall composition feels like a hand-painted tapestry mixed with comic-book intensity, with an atmosphere of ritual, judgment, and foreboding power. Make the image bright.`,
  },
  {
    name: 'Bright Illustration',
    description: 'clean vector-based illustration',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Bright%20Illustration.jpg',
    style: `A brightly colored digital illustration in wide format. Features clean, smooth linework with clear, uniform outlines and minimal shading. The color palette is warm and slightly muted, dominated by earthy oranges, soft browns, and beige tones, creating a cohesive and stylized aesthetic. Characters are drawn with rounded, cartoon-like features and expressive facial details that emphasize clarity and simplicity. Textures are minimal, with a flat, poster-like quality. The overall look is inspired by modern vector-based animation with subtle nods to ancient art motifs in the clothing and accessories. The background is sparse, directing focus toward character interaction. Make the image bright.`,
  },
  {
    name: 'Modern Infographic',
    description: 'flat vector-based illustration',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Modern%20Infographic.jpg',
    style: `A flat, vector-based illustration style in wide format, commonly used in educational or infographic visuals. Clean geometric shapes, crisp lines, and minimal gradients define the look. Colors are often high-contrast, matte, and chosen for clarity—bold reds, clear blues, bright yellows—with strong use of white space and iconographic symbols. Characters and objects are simplified and schematic, emphasizing communication over realism. Shadows and perspective are either absent or extremely subtle. The tone is modern, accessible, and efficient—ideal for conveying data, instruction, or abstract concepts in a visually digestible way.`,
  },
  {
    name: 'Pencil Sketch',
    description: 'monochromatic pencil sketch',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Pencil%20Sketch.jpg',
    style: `A monochromatic pencil sketch style in wide format. Features soft graphite textures, smudging, and fine crosshatching to render depth and tone. The linework varies from loose and gestural to tight and controlled, capturing both quick impressions and detailed studies. Figures and environments appear raw and unpolished, with construction lines sometimes visible, lending an in-progress or documentary feel. The grayscale palette allows lighting and shading to take center stage. The overall aesthetic is intimate, thoughtful, and process-oriented—perfect for character studies, architectural drafts, or emotional storytelling.`,
  },
  {
    name: 'Low-Poly 3D Render',
    description: 'minimalist low-polygon 3D',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Low-Poly%203D%20Render.jpg',
    style: `A minimalist 3D illustration style using low-polygon modeling, presented in wide format. Scenes are constructed with simplified geometric shapes and faceted surfaces, creating a clean, stylized aesthetic. Colors are flat and pastel or matte, often with subtle ambient lighting and no texture mapping. Shadows are soft and angles crisp, giving the image a playful, toy-like quality. Figures and environments are abstracted, relying on silhouette and proportion for clarity. The overall look is modern, design-oriented, and ideal for stylized infographics, games, or architectural visualizations.`,
  },
  {
    name: 'Art Nouveau Illustration',
    description: 'decorative Art Nouveau style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Art%20Nouveau%20Illustration.jpg',
    style: `A decorative Art Nouveau style in wide format, inspired by the works of Alphonse Mucha. Features flowing, elegant linework with intricate patterns, floral motifs, and sinuous forms. Figures are idealized and graceful, often framed within ornate borders or circular compositions. The color palette leans toward soft pastels, warm sepia tones, and muted golds, with gentle gradients and hand-drawn textures. Hair and garments follow organic curves, blending into botanical backdrops or abstract ornamentation. The overall aesthetic is romantic, timeless, and lush, with a focus on harmony, femininity, and visual rhythm.`,
  },
  {
    name: 'Charcoal and Chalk',
    description: 'dramatic charcoal and chalk drawing',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Imagen4Fast/Charcoal%20and%20Chalk.jpg',
    style: `A dramatic charcoal and chalk drawing style in wide format. Utilizes rich black strokes, powdery smudges, and stark white highlights for intense contrast and expressive texture. The linework is bold, raw, and often sketchy, with a focus on light and shadow rather than fine detail. Backgrounds may dissolve into textured gradients or remain abstract. Figures appear rough yet emotionally powerful, emerging from deep shadows with luminous accents. The monochrome palette enhances a moody, timeless atmosphere, ideal for conveying drama, introspection, or historical gravitas.`,
  },
];

const PLUS_STYLES = [
  {
    name: 'Old Comic Book',
    description: 'black-and-white old comic book-style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Old_Comic_Book.jpg',
    style: `A black-and-white old comic book-style illustration in wide format. Features dramatic contrast, rich textures, and expressive, rough linework resembling vintage war comics. High cinematic shadows with intense lighting, giving a moody, atmospheric tone. Characters are drawn with raw, emotional detail, and each scene feels like a hand-drawn storyboard frame. Backgrounds are layered with depth, and the overall composition balances realism with a surreal, haunted quality. The style evokes mid-20th-century graphic novels with a gritty, psychological edge. Make the image bright.`,
  },
  {
    name: 'Medieval Oil Painting',
    description: 'late medieval or early Renaissance style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Medieval_Oil_Painting.jpg',
    style: `A richly colored oil painting in the style of late medieval or early Renaissance European art or Viking paintings. Features clear composition, vibrant tones, painterly textures, realistic proportions, expressive facial detail, and soft, atmospheric backgrounds. Lighting is natural with soft shadows, evoking the emotional depth and storytelling found in historical panel paintings and illuminated manuscripts. Vivid bright Colors.`,
  },
  {
    name: 'Enchanted Anime',
    description: 'painterly hand-drawn animation',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Studio_Ghibli_Style.jpg',
    style: `A painterly, hand-drawn animation style in the tradition of classic Japanese feature animation, evoking the visual sensibility of landmark studios such as Studio Ghibli. Wide format with gentle, organic linework and subtle textures that mimic traditional cel animation. The palette is lush and nature-inspired—rich greens, soft pastels, golden sunlight, and warm earth tones—evoking emotional warmth and whimsical realism. Characters are expressive with large, emotive eyes and understated facial details. Backgrounds are intricately detailed yet softly rendered, often featuring idyllic countryside, cozy interiors, or magical environments with a nostalgic glow. Lighting is natural and dynamic, shifting gently across scenes to mirror time and mood. The overall aesthetic is warm, soulful, and immersive, blending everyday simplicity with quiet enchantment.`,
  },
  {
    name: 'Pixel Art',
    description: 'retro 8-bit/16-bit pixel art',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Pixel_Art.jpg',
    style: `A retro pixel art aesthetic in wide format. Rendered with blocky, low-resolution graphics and a limited color palette inspired by 8-bit and 16-bit era video games. Characters are made up of clearly visible pixels, with expressive poses and exaggerated features to convey personality despite simplicity. The color use is bold and saturated—vivid blues, electric purples, hot pinks—and scenes often include grid-based environments like forests, dungeons, or cities. Lighting is represented through dithering or basic color shifts. The overall effect is nostalgic, playful, and full of charm, reminiscent of classic console RPGs or arcade games.`,
  },
  {
    name: 'Realistic Animation',
    description: 'hyper-realistic animated style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Realistic_Animation.jpg',
    style: `A hyper-realistic animated style in wide format. Features high-resolution textures, lifelike surface details, and dynamic environmental lighting. The animation leans into dramatic perspective with exaggerated scale, emphasizing the colossal presence of the subject. Pixar like animation. Rich, saturated colors and sharp shadows create a vivid, high-contrast look, while the rendering mimics real-world physics—reflections, ambient occlusion, and depth of field included. The style evokes cutting-edge CGI from blockbuster creature features, balancing realism with intense visual energy. Movements would feel weighty and tactile, with subtle skin flexing, muscle shifts, and light interaction enhancing the sense of realism. Backgrounds are lush and detailed, often filled with atmospheric effects like volumetric light and soft lens flare, giving the scene an immersive, cinematic punch.`,
  },
  {
    name: 'Classical Oil Painting',
    description: 'Baroque-inspired oil painting',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Classical_Oil_Painting.jpg',
    style: `A classical oil painting style inspired by the Baroque masters, particularly Caravaggio and Rembrandt, emphasizing emotional realism, dramatic chiaroscuro lighting, and a subdued, earthy palette. Figures, architecture, and objects are rendered with painterly precision and soft, blended brushwork, capturing lifelike textures such as weathered fabric, aged skin, and stone walls. The lighting is intimate and directional, often sourced from a single candle or window, casting deep shadows and highlighting facial expressions and gesture with theatrical intensity. The atmosphere evokes solemnity and inner depth, with backgrounds kept dim and ambient to draw focus toward the emotional gravity of the foreground. The overall effect is timeless, reverent, and psychologically rich—ideal for contemplative, spiritual, or philosophical themes. Bright vivid colors. Wide format.`,
  },
  {
    name: 'Anime Modern Shonen',
    description: 'dynamic high-contrast anime',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Anime_Modern_Shonen.jpg',
    style: `A high-contrast, digitally inked anime style in wide format. Features sharp, dynamic linework with bold character outlines, intense facial expressions, and exaggerated action poses. Colors are vibrant and saturated—neon blues, deep reds, and glowing yellows—with energetic lighting and dramatic highlights. Hair and clothing are stylized with clear motion lines, and visual effects like speed blurs, energy auras, or glowing eyes enhance the sense of impact. Backgrounds range from minimalist to hyper-detailed depending on the emotional beat, often with radial gradients or stylized skies. This style embodies modern action anime, cinematic in scope and driven by expressive motion.`,
  },
  {
    name: 'Dreamy Painting',
    description: 'fantasy art with serene celestial themes',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Dreamy_Painting.jpg',
    style: `A dreamy digital painting in wide format, inspired by fantasy art and serene celestial themes. The palette is composed of cool, calming tones—deep navy blues, moonlit silvers, and soft cloud whites—creating a tranquil nighttime ambiance. Backgrounds include drifting clouds, distant stars, and a vast, luminous night sky, occasionally punctuated by birds or constellations. The lighting is soft and atmospheric, enhancing the peaceful, almost meditative mood. The brushwork is smooth and blended, lending a dreamy, high-fantasy aesthetic similar to cinematic concept art or modern digital illustrations with a painterly touch. The overall feeling is one of divine calm, sleep-inducing wonder, and timeless serenity.`,
  },
  {
    name: 'Ink & Wash',
    description: 'East Asian ink-and-wash painting',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Ink_and_Wash.jpg',
    style: `A traditional East Asian ink-and-wash painting style in wide format, inspired by Chinese and Japanese landscape art. The linework is expressive and brush-based, varying in thickness with fluid, calligraphic strokes. Monochrome or limited muted palettes—grays, blacks, and sepia tones—are layered with subtle watercolor washes to evoke mist, wind, or flowing water. Figures and scenery are often stylized and abstracted, emphasizing harmony with nature rather than anatomical precision. Negative space is used intentionally, and compositions feel balanced and meditative. This aesthetic conveys quiet power, simplicity, and spiritual depth.`,
  },
  {
    name: 'Dark Medieval Fantasy',
    description: 'dark medieval animation',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Dark_Medieval_Fantasy.jpg',
    style: `A dark medieval fantasy illustration in wide format. Features bold, heavy linework with rough, painterly textures and a muted, earthy color palette of deep reds, browns, and shadows. Lighting is stark and dramatic, casting faces into harsh highlights and deep gloom. Characters are drawn with exaggerated, grim expressions, evoking dread and authority. Backgrounds feature gothic stained glass, stone walls, and banners, enhancing the ominous tone. The overall composition feels like a hand-painted tapestry mixed with comic-book intensity, with an atmosphere of ritual, judgment, and foreboding power. Make the image bright.`,
  },
  {
    name: 'Bright Illustration',
    description: 'clean vector-based illustration',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Bright_Illustration.jpg',
    style: `A brightly colored digital illustration in wide format. Features clean, smooth linework with clear, uniform outlines and minimal shading. The color palette is warm and slightly muted, dominated by earthy oranges, soft browns, and beige tones, creating a cohesive and stylized aesthetic. Characters are drawn with rounded, cartoon-like features and expressive facial details that emphasize clarity and simplicity. Textures are minimal, with a flat, poster-like quality. The overall look is inspired by modern vector-based animation with subtle nods to ancient art motifs in the clothing and accessories. The background is sparse, directing focus toward character interaction. Make the image bright.`,
  },
  {
    name: 'Modern Infographic',
    description: 'flat vector-based illustration',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Modern_Infographic.jpg',
    style: `A flat, vector-based illustration style in wide format, commonly used in educational or infographic visuals. Clean geometric shapes, crisp lines, and minimal gradients define the look. Colors are often high-contrast, matte, and chosen for clarity—bold reds, clear blues, bright yellows—with strong use of white space and iconographic symbols. Characters and objects are simplified and schematic, emphasizing communication over realism. Shadows and perspective are either absent or extremely subtle. The tone is modern, accessible, and efficient—ideal for conveying data, instruction, or abstract concepts in a visually digestible way.`,
  },
  {
    name: 'Pencil Sketch',
    description: 'monochromatic pencil sketch',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Pencil_Sketch.jpg',
    style: `A monochromatic pencil sketch style in wide format. Features soft graphite textures, smudging, and fine crosshatching to render depth and tone. The linework varies from loose and gestural to tight and controlled, capturing both quick impressions and detailed studies. Figures and environments appear raw and unpolished, with construction lines sometimes visible, lending an in-progress or documentary feel. The grayscale palette allows lighting and shading to take center stage. The overall aesthetic is intimate, thoughtful, and process-oriented—perfect for character studies, architectural drafts, or emotional storytelling.`,
  },
  {
    name: 'Low-Poly 3D Render',
    description: 'minimalist low-polygon 3D',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Low-Poly_3D_Render.jpg',
    style: `A minimalist 3D illustration style using low-polygon modeling, presented in wide format. Scenes are constructed with simplified geometric shapes and faceted surfaces, creating a clean, stylized aesthetic. Colors are flat and pastel or matte, often with subtle ambient lighting and no texture mapping. Shadows are soft and angles crisp, giving the image a playful, toy-like quality. Figures and environments are abstracted, relying on silhouette and proportion for clarity. The overall look is modern, design-oriented, and ideal for stylized infographics, games, or architectural visualizations.`,
  },
  {
    name: 'Art Nouveau Illustration',
    description: 'decorative Art Nouveau style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Art_Nouveau_Illustration.jpg',
    style: `A decorative Art Nouveau style in wide format, inspired by the works of Alphonse Mucha. Features flowing, elegant linework with intricate patterns, floral motifs, and sinuous forms. Figures are idealized and graceful, often framed within ornate borders or circular compositions. The color palette leans toward soft pastels, warm sepia tones, and muted golds, with gentle gradients and hand-drawn textures. Hair and garments follow organic curves, blending into botanical backdrops or abstract ornamentation. The overall aesthetic is romantic, timeless, and lush, with a focus on harmony, femininity, and visual rhythm.`,
  },
  {
    name: 'Charcoal and Chalk',
    description: 'dramatic charcoal and chalk drawing',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Charcoal_and_Chalk.jpg',
    style: `A dramatic charcoal and chalk drawing style in wide format. Utilizes rich black strokes, powdery smudges, and stark white highlights for intense contrast and expressive texture. The linework is bold, raw, and often sketchy, with a focus on light and shadow rather than fine detail. Backgrounds may dissolve into textured gradients or remain abstract. Figures appear rough yet emotionally powerful, emerging from deep shadows with luminous accents. The monochrome palette enhances a moody, timeless atmosphere, ideal for conveying drama, introspection, or historical gravitas.`,
  },
];

const PREMIUM_STYLES = [
  {
    name: 'Old Comic Book',
    description: 'black-and-white old comic book-style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Old_Comic_Book.jpg',
    style: `A black-and-white old comic book-style illustration in wide format. Features dramatic contrast, rich textures, and expressive, rough linework resembling vintage war comics. High cinematic shadows with intense lighting, giving a moody, atmospheric tone. Characters are drawn with raw, emotional detail, and each scene feels like a hand-drawn storyboard frame. Backgrounds are layered with depth, and the overall composition balances realism with a surreal, haunted quality. The style evokes mid-20th-century graphic novels with a gritty, psychological edge. Make the image bright.`,
  },
  {
    name: 'Medieval Oil Painting',
    description: 'late medieval or early Renaissance style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Medieval_Oil_Painting.jpg',
    style: `A richly colored oil painting in the style of late medieval or early Renaissance European art or Viking paintings. Features clear composition, vibrant tones, painterly textures, realistic proportions, expressive facial detail, and soft, atmospheric backgrounds. Lighting is natural with soft shadows, evoking the emotional depth and storytelling found in historical panel paintings and illuminated manuscripts. Vivid bright Colors.`,
  },
  {
    name: 'Realistic Animation',
    description: 'hyper-realistic animated style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Realistic_Animation.jpg',
    style: `A hyper-realistic animated style in wide format. Features high-resolution textures, lifelike surface details, and dynamic environmental lighting. The animation leans into dramatic perspective with exaggerated scale, emphasizing the colossal presence of the subject. Pixar like animation. Rich, saturated colors and sharp shadows create a vivid, high-contrast look, while the rendering mimics real-world physics—reflections, ambient occlusion, and depth of field included. The style evokes cutting-edge CGI from blockbuster creature features, balancing realism with intense visual energy. Movements would feel weighty and tactile, with subtle skin flexing, muscle shifts, and light interaction enhancing the sense of realism. Backgrounds are lush and detailed, often filled with atmospheric effects like volumetric light and soft lens flare, giving the scene an immersive, cinematic punch.`,
  },
  {
    name: 'Enchanted Anime',
    description: 'painterly hand-drawn animation',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Studio_Ghibli_Style.jpg',
    style: `A painterly, hand-drawn animation style in the tradition of classic Japanese feature animation, evoking the visual sensibility of landmark studios such as Studio Ghibli. Wide format with gentle, organic linework and subtle textures that mimic traditional cel animation. The palette is lush and nature-inspired—rich greens, soft pastels, golden sunlight, and warm earth tones—evoking emotional warmth and whimsical realism. Characters are expressive with large, emotive eyes and understated facial details. Backgrounds are intricately detailed yet softly rendered, often featuring idyllic countryside, cozy interiors, or magical environments with a nostalgic glow. Lighting is natural and dynamic, shifting gently across scenes to mirror time and mood. The overall aesthetic is warm, soulful, and immersive, blending everyday simplicity with quiet enchantment.`,
  },
  {
    name: 'Classical Oil Painting',
    description: 'Baroque-inspired oil painting',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Classical_Oil_Painting.jpg',
    style: `A classical oil painting style inspired by the Baroque masters, particularly Caravaggio and Rembrandt, emphasizing emotional realism, dramatic chiaroscuro lighting, and a subdued, earthy palette. Figures, architecture, and objects are rendered with painterly precision and soft, blended brushwork, capturing lifelike textures such as weathered fabric, aged skin, and stone walls. The lighting is intimate and directional, often sourced from a single candle or window, casting deep shadows and highlighting facial expressions and gesture with theatrical intensity. The atmosphere evokes solemnity and inner depth, with backgrounds kept dim and ambient to draw focus toward the emotional gravity of the foreground. The overall effect is timeless, reverent, and psychologically rich—ideal for contemplative, spiritual, or philosophical themes. Bright vivid colors. Wide format.`,
  },
  {
    name: 'Anime Modern Shonen',
    description: 'dynamic high-contrast anime',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Anime_Modern_Shonen.jpg',
    style: `A high-contrast, digitally inked anime style in wide format. Features sharp, dynamic linework with bold character outlines, intense facial expressions, and exaggerated action poses. Colors are vibrant and saturated—neon blues, deep reds, and glowing yellows—with energetic lighting and dramatic highlights. Hair and clothing are stylized with clear motion lines, and visual effects like speed blurs, energy auras, or glowing eyes enhance the sense of impact. Backgrounds range from minimalist to hyper-detailed depending on the emotional beat, often with radial gradients or stylized skies. This style embodies modern action anime, cinematic in scope and driven by expressive motion.`,
  },
  {
    name: 'Dreamy Painting',
    description: 'fantasy art with serene celestial themes',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Dreamy_Painting.jpg',
    style: `A dreamy digital painting in wide format, inspired by fantasy art and serene celestial themes. The palette is composed of cool, calming tones—deep navy blues, moonlit silvers, and soft cloud whites—creating a tranquil nighttime ambiance. Backgrounds include drifting clouds, distant stars, and a vast, luminous night sky, occasionally punctuated by birds or constellations. The lighting is soft and atmospheric, enhancing the peaceful, almost meditative mood. The brushwork is smooth and blended, lending a dreamy, high-fantasy aesthetic similar to cinematic concept art or modern digital illustrations with a painterly touch. The overall feeling is one of divine calm, sleep-inducing wonder, and timeless serenity.`,
  },
  {
    name: 'Ink & Wash',
    description: 'East Asian ink-and-wash painting',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Ink_and_Wash.jpg',
    style: `A traditional East Asian ink-and-wash painting style in wide format, inspired by Chinese and Japanese landscape art. The linework is expressive and brush-based, varying in thickness with fluid, calligraphic strokes. Monochrome or limited muted palettes—grays, blacks, and sepia tones—are layered with subtle watercolor washes to evoke mist, wind, or flowing water. Figures and scenery are often stylized and abstracted, emphasizing harmony with nature rather than anatomical precision. Negative space is used intentionally, and compositions feel balanced and meditative. This aesthetic conveys quiet power, simplicity, and spiritual depth.`,
  },
  {
    name: 'Dark Medieval Fantasy',
    description: 'dark medieval animation',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Dark_Medieval_Fantasy.jpg',
    style: `A dark medieval fantasy illustration in wide format. Features bold, heavy linework with rough, painterly textures and a muted, earthy color palette of deep reds, browns, and shadows. Lighting is stark and dramatic, casting faces into harsh highlights and deep gloom. Characters are drawn with exaggerated, grim expressions, evoking dread and authority. Backgrounds feature gothic stained glass, stone walls, and banners, enhancing the ominous tone. The overall composition feels like a hand-painted tapestry mixed with comic-book intensity, with an atmosphere of ritual, judgment, and foreboding power. Make the image bright.`,
  },
  {
    name: 'Bright Illustration',
    description: 'clean vector-based illustration',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Bright_Illustration.jpg',
    style: `A brightly colored digital illustration in wide format. Features clean, smooth linework with clear, uniform outlines and minimal shading. The color palette is warm and slightly muted, dominated by earthy oranges, soft browns, and beige tones, creating a cohesive and stylized aesthetic. Characters are drawn with rounded, cartoon-like features and expressive facial details that emphasize clarity and simplicity. Textures are minimal, with a flat, poster-like quality. The overall look is inspired by modern vector-based animation with subtle nods to ancient art motifs in the clothing and accessories. The background is sparse, directing focus toward character interaction. Make the image bright.`,
  },
  {
    name: 'Pixel Art',
    description: 'retro 8-bit/16-bit pixel art',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Pixel_Art.jpg',
    style: `A retro pixel art aesthetic in wide format. Rendered with blocky, low-resolution graphics and a limited color palette inspired by 8-bit and 16-bit era video games. Characters are made up of clearly visible pixels, with expressive poses and exaggerated features to convey personality despite simplicity. The color use is bold and saturated—vivid blues, electric purples, hot pinks—and scenes often include grid-based environments like forests, dungeons, or cities. Lighting is represented through dithering or basic color shifts. The overall effect is nostalgic, playful, and full of charm, reminiscent of classic console RPGs or arcade games.`,
  },
  {
    name: 'Modern Infographic',
    description: 'flat vector-based illustration',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Modern_Infographic.jpg',
    style: `A flat, vector-based illustration style in wide format, commonly used in educational or infographic visuals. Clean geometric shapes, crisp lines, and minimal gradients define the look. Colors are often high-contrast, matte, and chosen for clarity—bold reds, clear blues, bright yellows—with strong use of white space and iconographic symbols. Characters and objects are simplified and schematic, emphasizing communication over realism. Shadows and perspective are either absent or extremely subtle. The tone is modern, accessible, and efficient—ideal for conveying data, instruction, or abstract concepts in a visually digestible way.`,
  },
  {
    name: 'Pencil Sketch',
    description: 'monochromatic pencil sketch',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Pencil_Sketch.jpg',
    style: `A monochromatic pencil sketch style in wide format. Features soft graphite textures, smudging, and fine crosshatching to render depth and tone. The linework varies from loose and gestural to tight and controlled, capturing both quick impressions and detailed studies. Figures and environments appear raw and unpolished, with construction lines sometimes visible, lending an in-progress or documentary feel. The grayscale palette allows lighting and shading to take center stage. The overall aesthetic is intimate, thoughtful, and process-oriented—perfect for character studies, architectural drafts, or emotional storytelling.`,
  },
  {
    name: 'Low-Poly 3D Render',
    description: 'minimalist low-polygon 3D',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Low-Poly_3D_Render.jpg',
    style: `A minimalist 3D illustration style using low-polygon modeling, presented in wide format. Scenes are constructed with simplified geometric shapes and faceted surfaces, creating a clean, stylized aesthetic. Colors are flat and pastel or matte, often with subtle ambient lighting and no texture mapping. Shadows are soft and angles crisp, giving the image a playful, toy-like quality. Figures and environments are abstracted, relying on silhouette and proportion for clarity. The overall look is modern, design-oriented, and ideal for stylized infographics, games, or architectural visualizations.`,
  },
  {
    name: 'Art Nouveau Illustration',
    description: 'decorative Art Nouveau style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Art_Nouveau_Illustration.jpg',
    style: `A decorative Art Nouveau style in wide format, inspired by the works of Alphonse Mucha. Features flowing, elegant linework with intricate patterns, floral motifs, and sinuous forms. Figures are idealized and graceful, often framed within ornate borders or circular compositions. The color palette leans toward soft pastels, warm sepia tones, and muted golds, with gentle gradients and hand-drawn textures. Hair and garments follow organic curves, blending into botanical backdrops or abstract ornamentation. The overall aesthetic is romantic, timeless, and lush, with a focus on harmony, femininity, and visual rhythm.`,
  },
  {
    name: 'Charcoal and Chalk',
    description: 'dramatic charcoal and chalk drawing',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ImagenUltra/Charcoal_and_Chalk.jpg',
    style: `A dramatic charcoal and chalk drawing style in wide format. Utilizes rich black strokes, powdery smudges, and stark white highlights for intense contrast and expressive texture. The linework is bold, raw, and often sketchy, with a focus on light and shadow rather than fine detail. Backgrounds may dissolve into textured gradients or remain abstract. Figures appear rough yet emotionally powerful, emerging from deep shadows with luminous accents. The monochrome palette enhances a moody, timeless atmosphere, ideal for conveying drama, introspection, or historical gravitas.`,
  },
];

const SPARK_STYLES = [
  {
    name: 'Old Comic Book',
    description: 'black-and-white old comic book-style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Old_Comic_Book.jpg',
    style: `A black-and-white old comic book-style illustration in wide format. Features dramatic contrast, rich textures, and expressive, rough linework resembling vintage war comics. High cinematic shadows with intense lighting, giving a moody, atmospheric tone. Characters are drawn with raw, emotional detail, and each scene feels like a hand-drawn storyboard frame. Backgrounds are layered with depth, and the overall composition balances realism with a surreal, haunted quality. The style evokes mid-20th-century graphic novels with a gritty, psychological edge. Make the image bright.`,
  },
  {
    name: 'Medieval Oil Painting',
    description: 'late medieval or early Renaissance style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Medieval_Oil_Painting.jpg',
    style: `A richly colored oil painting in the style of late medieval or early Renaissance European art or Viking paintings. Features clear composition, vibrant tones, painterly textures, realistic proportions, expressive facial detail, and soft, atmospheric backgrounds. Lighting is natural with soft shadows, evoking the emotional depth and storytelling found in historical panel paintings and illuminated manuscripts. Vivid bright Colors.`,
  },
  {
    name: 'Enchanted Anime',
    description: 'painterly hand-drawn animation',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Studio_Ghibli_Style.jpg',
    style: `A painterly, hand-drawn animation style in the tradition of classic Japanese feature animation, evoking the visual sensibility of landmark studios such as Studio Ghibli. Wide format with gentle, organic linework and subtle textures that mimic traditional cel animation. The palette is lush and nature-inspired—rich greens, soft pastels, golden sunlight, and warm earth tones—evoking emotional warmth and whimsical realism. Characters are expressive with large, emotive eyes and understated facial details. Backgrounds are intricately detailed yet softly rendered, often featuring idyllic countryside, cozy interiors, or magical environments with a nostalgic glow. Lighting is natural and dynamic, shifting gently across scenes to mirror time and mood. The overall aesthetic is warm, soulful, and immersive, blending everyday simplicity with quiet enchantment.`,
  },
  {
    name: 'Pixel Art',
    description: 'retro 8-bit/16-bit pixel art',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Pixel_Art.jpg',
    style: `A retro pixel art aesthetic in wide format. Rendered with blocky, low-resolution graphics and a limited color palette inspired by 8-bit and 16-bit era video games. Characters are made up of clearly visible pixels, with expressive poses and exaggerated features to convey personality despite simplicity. The color use is bold and saturated—vivid blues, electric purples, hot pinks—and scenes often include grid-based environments like forests, dungeons, or cities. Lighting is represented through dithering or basic color shifts. The overall effect is nostalgic, playful, and full of charm, reminiscent of classic console RPGs or arcade games.`,
  },
  {
    name: 'Realistic Animation',
    description: 'hyper-realistic animated style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Realistic_Animation.jpg',
    style: `A hyper-realistic animated style in wide format. Features high-resolution textures, lifelike surface details, and dynamic environmental lighting. The animation leans into dramatic perspective with exaggerated scale, emphasizing the colossal presence of the subject. Pixar like animation. Rich, saturated colors and sharp shadows create a vivid, high-contrast look, while the rendering mimics real-world physics—reflections, ambient occlusion, and depth of field included. The style evokes cutting-edge CGI from blockbuster creature features, balancing realism with intense visual energy. Movements would feel weighty and tactile, with subtle skin flexing, muscle shifts, and light interaction enhancing the sense of realism. Backgrounds are lush and detailed, often filled with atmospheric effects like volumetric light and soft lens flare, giving the scene an immersive, cinematic punch.`,
  },
  {
    name: 'Classical Oil Painting',
    description: 'Baroque-inspired oil painting',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Classical_Oil_Painting.jpg',
    style: `A classical oil painting style inspired by the Baroque masters, particularly Caravaggio and Rembrandt, emphasizing emotional realism, dramatic chiaroscuro lighting, and a subdued, earthy palette. Figures, architecture, and objects are rendered with painterly precision and soft, blended brushwork, capturing lifelike textures such as weathered fabric, aged skin, and stone walls. The lighting is intimate and directional, often sourced from a single candle or window, casting deep shadows and highlighting facial expressions and gesture with theatrical intensity. The atmosphere evokes solemnity and inner depth, with backgrounds kept dim and ambient to draw focus toward the emotional gravity of the foreground. The overall effect is timeless, reverent, and psychologically rich—ideal for contemplative, spiritual, or philosophical themes. Bright vivid colors. Wide format.`,
  },
  {
    name: 'Anime Modern Shonen',
    description: 'dynamic high-contrast anime',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Anime_Modern_Shonen.jpg',
    style: `A high-contrast, digitally inked anime style in wide format. Features sharp, dynamic linework with bold character outlines, intense facial expressions, and exaggerated action poses. Colors are vibrant and saturated—neon blues, deep reds, and glowing yellows—with energetic lighting and dramatic highlights. Hair and clothing are stylized with clear motion lines, and visual effects like speed blurs, energy auras, or glowing eyes enhance the sense of impact. Backgrounds range from minimalist to hyper-detailed depending on the emotional beat, often with radial gradients or stylized skies. This style embodies modern action anime, cinematic in scope and driven by expressive motion.`,
  },
  {
    name: 'Dreamy Painting',
    description: 'fantasy art with serene celestial themes',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Dreamy_Painting.jpg',
    style: `A dreamy digital painting in wide format, inspired by fantasy art and serene celestial themes. The palette is composed of cool, calming tones—deep navy blues, moonlit silvers, and soft cloud whites—creating a tranquil nighttime ambiance. Backgrounds include drifting clouds, distant stars, and a vast, luminous night sky, occasionally punctuated by birds or constellations. The lighting is soft and atmospheric, enhancing the peaceful, almost meditative mood. The brushwork is smooth and blended, lending a dreamy, high-fantasy aesthetic similar to cinematic concept art or modern digital illustrations with a painterly touch. The overall feeling is one of divine calm, sleep-inducing wonder, and timeless serenity.`,
  },
  {
    name: 'Ink & Wash',
    description: 'East Asian ink-and-wash painting',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Ink_and_Wash.jpg',
    style: `A traditional East Asian ink-and-wash painting style in wide format, inspired by Chinese and Japanese landscape art. The linework is expressive and brush-based, varying in thickness with fluid, calligraphic strokes. Monochrome or limited muted palettes—grays, blacks, and sepia tones—are layered with subtle watercolor washes to evoke mist, wind, or flowing water. Figures and scenery are often stylized and abstracted, emphasizing harmony with nature rather than anatomical precision. Negative space is used intentionally, and compositions feel balanced and meditative. This aesthetic conveys quiet power, simplicity, and spiritual depth.`,
  },
  {
    name: 'Dark Medieval Fantasy',
    description: 'dark medieval animation',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Dark_Medieval_Fantasy.jpg',
    style: `A dark medieval fantasy illustration in wide format. Features bold, heavy linework with rough, painterly textures and a muted, earthy color palette of deep reds, browns, and shadows. Lighting is stark and dramatic, casting faces into harsh highlights and deep gloom. Characters are drawn with exaggerated, grim expressions, evoking dread and authority. Backgrounds feature gothic stained glass, stone walls, and banners, enhancing the ominous tone. The overall composition feels like a hand-painted tapestry mixed with comic-book intensity, with an atmosphere of ritual, judgment, and foreboding power. Make the image bright.`,
  },
  {
    name: 'Bright Illustration',
    description: 'clean vector-based illustration',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Bright_Illustration.jpg',
    style: `A brightly colored digital illustration in wide format. Features clean, smooth linework with clear, uniform outlines and minimal shading. The color palette is warm and slightly muted, dominated by earthy oranges, soft browns, and beige tones, creating a cohesive and stylized aesthetic. Characters are drawn with rounded, cartoon-like features and expressive facial details that emphasize clarity and simplicity. Textures are minimal, with a flat, poster-like quality. The overall look is inspired by modern vector-based animation with subtle nods to ancient art motifs in the clothing and accessories. The background is sparse, directing focus toward character interaction. Make the image bright.`,
  },
  {
    name: 'Modern Infographic',
    description: 'flat vector-based illustration',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Modern_Infographic.jpg',
    style: `A flat, vector-based illustration style in wide format, commonly used in educational or infographic visuals. Clean geometric shapes, crisp lines, and minimal gradients define the look. Colors are often high-contrast, matte, and chosen for clarity—bold reds, clear blues, bright yellows—with strong use of white space and iconographic symbols. Characters and objects are simplified and schematic, emphasizing communication over realism. Shadows and perspective are either absent or extremely subtle. The tone is modern, accessible, and efficient—ideal for conveying data, instruction, or abstract concepts in a visually digestible way.`,
  },
  {
    name: 'Pencil Sketch',
    description: 'monochromatic pencil sketch',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Pencil_Sketch.jpg',
    style: `A monochromatic pencil sketch style in wide format. Features soft graphite textures, smudging, and fine crosshatching to render depth and tone. The linework varies from loose and gestural to tight and controlled, capturing both quick impressions and detailed studies. Figures and environments appear raw and unpolished, with construction lines sometimes visible, lending an in-progress or documentary feel. The grayscale palette allows lighting and shading to take center stage. The overall aesthetic is intimate, thoughtful, and process-oriented—perfect for character studies, architectural drafts, or emotional storytelling.`,
  },
  {
    name: 'Low-Poly 3D Render',
    description: 'minimalist low-polygon 3D',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Low-Poly_3D_Render.jpg',
    style: `A minimalist 3D illustration style using low-polygon modeling, presented in wide format. Scenes are constructed with simplified geometric shapes and faceted surfaces, creating a clean, stylized aesthetic. Colors are flat and pastel or matte, often with subtle ambient lighting and no texture mapping. Shadows are soft and angles crisp, giving the image a playful, toy-like quality. Figures and environments are abstracted, relying on silhouette and proportion for clarity. The overall look is modern, design-oriented, and ideal for stylized infographics, games, or architectural visualizations.`,
  },
  {
    name: 'Art Nouveau Illustration',
    description: 'decorative Art Nouveau style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Art_Nouveau_Illustration.jpg',
    style: `A decorative Art Nouveau style in wide format, inspired by the works of Alphonse Mucha. Features flowing, elegant linework with intricate patterns, floral motifs, and sinuous forms. Figures are idealized and graceful, often framed within ornate borders or circular compositions. The color palette leans toward soft pastels, warm sepia tones, and muted golds, with gentle gradients and hand-drawn textures. Hair and garments follow organic curves, blending into botanical backdrops or abstract ornamentation. The overall aesthetic is romantic, timeless, and lush, with a focus on harmony, femininity, and visual rhythm.`,
  },
  {
    name: 'Charcoal and Chalk',
    description: 'dramatic charcoal and chalk drawing',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/flux2/Charcoal_and_Chalk.jpg',
    style: `A dramatic charcoal and chalk drawing style in wide format. Utilizes rich black strokes, powdery smudges, and stark white highlights for intense contrast and expressive texture. The linework is bold, raw, and often sketchy, with a focus on light and shadow rather than fine detail. Backgrounds may dissolve into textured gradients or remain abstract. Figures appear rough yet emotionally powerful, emerging from deep shadows with luminous accents. The monochrome palette enhances a moody, timeless atmosphere, ideal for conveying drama, introspection, or historical gravitas.`,
  },
];

const GROK_STYLES = [
  {
    name: 'Old Comic Book',
    description: 'black-and-white old comic book-style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Old_Comic_Book.jpeg',
    style: `A black-and-white old comic book-style illustration in wide format. Features dramatic contrast, rich textures, and expressive, rough linework resembling vintage war comics. High cinematic shadows with intense lighting, giving a moody, atmospheric tone. Characters are drawn with raw, emotional detail, and each scene feels like a hand-drawn storyboard frame. Backgrounds are layered with depth, and the overall composition balances realism with a surreal, haunted quality. The style evokes mid-20th-century graphic novels with a gritty, psychological edge. Make the image bright.`,
  },
  {
    name: 'Medieval Oil Painting',
    description: 'late medieval or early Renaissance style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Medieval_Oil_Painting.jpeg',
    style: `A richly colored oil painting in the style of late medieval or early Renaissance European art or Viking paintings. Features clear composition, vibrant tones, painterly textures, realistic proportions, expressive facial detail, and soft, atmospheric backgrounds. Lighting is natural with soft shadows, evoking the emotional depth and storytelling found in historical panel paintings and illuminated manuscripts. Vivid bright Colors.`,
  },
  {
    name: 'Enchanted Anime',
    description: 'painterly hand-drawn animation',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Enchanted_Anime.jpeg',
    style: `A painterly, hand-drawn animation style in the tradition of classic Japanese feature animation, evoking the visual sensibility of landmark studios such as Studio Ghibli. Wide format with gentle, organic linework and subtle textures that mimic traditional cel animation. The palette is lush and nature-inspired—rich greens, soft pastels, golden sunlight, and warm earth tones—evoking emotional warmth and whimsical realism. Characters are expressive with large, emotive eyes and understated facial details. Backgrounds are intricately detailed yet softly rendered, often featuring idyllic countryside, cozy interiors, or magical environments with a nostalgic glow. Lighting is natural and dynamic, shifting gently across scenes to mirror time and mood. The overall aesthetic is warm, soulful, and immersive, blending everyday simplicity with quiet enchantment.`,
  },
  {
    name: 'Pixel Art',
    description: 'retro 8-bit/16-bit pixel art',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Pixel_Art.jpeg',
    style: `A retro pixel art aesthetic in wide format. Rendered with blocky, low-resolution graphics and a limited color palette inspired by 8-bit and 16-bit era video games. Characters are made up of clearly visible pixels, with expressive poses and exaggerated features to convey personality despite simplicity. The color use is bold and saturated—vivid blues, electric purples, hot pinks—and scenes often include grid-based environments like forests, dungeons, or cities. Lighting is represented through dithering or basic color shifts. The overall effect is nostalgic, playful, and full of charm, reminiscent of classic console RPGs or arcade games.`,
  },
  {
    name: 'Realistic Animation',
    description: 'hyper-realistic animated style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Realistic_Animation.jpeg',
    style: `A hyper-realistic animated style in wide format. Features high-resolution textures, lifelike surface details, and dynamic environmental lighting. The animation leans into dramatic perspective with exaggerated scale, emphasizing the colossal presence of the subject. Pixar like animation. Rich, saturated colors and sharp shadows create a vivid, high-contrast look, while the rendering mimics real-world physics—reflections, ambient occlusion, and depth of field included. The style evokes cutting-edge CGI from blockbuster creature features, balancing realism with intense visual energy. Movements would feel weighty and tactile, with subtle skin flexing, muscle shifts, and light interaction enhancing the sense of realism. Backgrounds are lush and detailed, often filled with atmospheric effects like volumetric light and soft lens flare, giving the scene an immersive, cinematic punch.`,
  },
  {
    name: 'Classical Oil Painting',
    description: 'Baroque-inspired oil painting',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Classical_Oil_Painting.jpeg',
    style: `A classical oil painting style inspired by the Baroque masters, particularly Caravaggio and Rembrandt, emphasizing emotional realism, dramatic chiaroscuro lighting, and a subdued, earthy palette. Figures, architecture, and objects are rendered with painterly precision and soft, blended brushwork, capturing lifelike textures such as weathered fabric, aged skin, and stone walls. The lighting is intimate and directional, often sourced from a single candle or window, casting deep shadows and highlighting facial expressions and gesture with theatrical intensity. The atmosphere evokes solemnity and inner depth, with backgrounds kept dim and ambient to draw focus toward the emotional gravity of the foreground. The overall effect is timeless, reverent, and psychologically rich—ideal for contemplative, spiritual, or philosophical themes. Bright vivid colors. Wide format.`,
  },
  {
    name: 'Anime Modern Shonen',
    description: 'dynamic high-contrast anime',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Anime_Modern_Shonen.jpeg',
    style: `A high-contrast, digitally inked anime style in wide format. Features sharp, dynamic linework with bold character outlines, intense facial expressions, and exaggerated action poses. Colors are vibrant and saturated—neon blues, deep reds, and glowing yellows—with energetic lighting and dramatic highlights. Hair and clothing are stylized with clear motion lines, and visual effects like speed blurs, energy auras, or glowing eyes enhance the sense of impact. Backgrounds range from minimalist to hyper-detailed depending on the emotional beat, often with radial gradients or stylized skies. This style embodies modern action anime, cinematic in scope and driven by expressive motion.`,
  },
  {
    name: 'Dreamy Painting',
    description: 'fantasy art with serene celestial themes',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Dreamy_Painting.jpeg',
    style: `A dreamy digital painting in wide format, inspired by fantasy art and serene celestial themes. The palette is composed of cool, calming tones—deep navy blues, moonlit silvers, and soft cloud whites—creating a tranquil nighttime ambiance. Backgrounds include drifting clouds, distant stars, and a vast, luminous night sky, occasionally punctuated by birds or constellations. The lighting is soft and atmospheric, enhancing the peaceful, almost meditative mood. The brushwork is smooth and blended, lending a dreamy, high-fantasy aesthetic similar to cinematic concept art or modern digital illustrations with a painterly touch. The overall feeling is one of divine calm, sleep-inducing wonder, and timeless serenity.`,
  },
  {
    name: 'Ink & Wash',
    description: 'East Asian ink-and-wash painting',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Ink_and_Wash.jpeg',
    style: `A traditional East Asian ink-and-wash painting style in wide format, inspired by Chinese and Japanese landscape art. The linework is expressive and brush-based, varying in thickness with fluid, calligraphic strokes. Monochrome or limited muted palettes—grays, blacks, and sepia tones—are layered with subtle watercolor washes to evoke mist, wind, or flowing water. Figures and scenery are often stylized and abstracted, emphasizing harmony with nature rather than anatomical precision. Negative space is used intentionally, and compositions feel balanced and meditative. This aesthetic conveys quiet power, simplicity, and spiritual depth.`,
  },
  {
    name: 'Dark Medieval Fantasy',
    description: 'dark medieval animation',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Dark_Medieval_Fantasy.jpeg',
    style: `A dark medieval fantasy illustration in wide format. Features bold, heavy linework with rough, painterly textures and a muted, earthy color palette of deep reds, browns, and shadows. Lighting is stark and dramatic, casting faces into harsh highlights and deep gloom. Characters are drawn with exaggerated, grim expressions, evoking dread and authority. Backgrounds feature gothic stained glass, stone walls, and banners, enhancing the ominous tone. The overall composition feels like a hand-painted tapestry mixed with comic-book intensity, with an atmosphere of ritual, judgment, and foreboding power. Make the image bright.`,
  },
  {
    name: 'Bright Illustration',
    description: 'clean vector-based illustration',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Bright_Illustration.jpeg',
    style: `A brightly colored digital illustration in wide format. Features clean, smooth linework with clear, uniform outlines and minimal shading. The color palette is warm and slightly muted, dominated by earthy oranges, soft browns, and beige tones, creating a cohesive and stylized aesthetic. Characters are drawn with rounded, cartoon-like features and expressive facial details that emphasize clarity and simplicity. Textures are minimal, with a flat, poster-like quality. The overall look is inspired by modern vector-based animation with subtle nods to ancient art motifs in the clothing and accessories. The background is sparse, directing focus toward character interaction. Make the image bright.`,
  },
  {
    name: 'Modern Infographic',
    description: 'flat vector-based illustration',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Modern_Infographic.jpeg',
    style: `A flat, vector-based illustration style in wide format, commonly used in educational or infographic visuals. Clean geometric shapes, crisp lines, and minimal gradients define the look. Colors are often high-contrast, matte, and chosen for clarity—bold reds, clear blues, bright yellows—with strong use of white space and iconographic symbols. Characters and objects are simplified and schematic, emphasizing communication over realism. Shadows and perspective are either absent or extremely subtle. The tone is modern, accessible, and efficient—ideal for conveying data, instruction, or abstract concepts in a visually digestible way.`,
  },
  {
    name: 'Pencil Sketch',
    description: 'monochromatic pencil sketch',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Pencil_Sketch.jpeg',
    style: `A monochromatic pencil sketch style in wide format. Features soft graphite textures, smudging, and fine crosshatching to render depth and tone. The linework varies from loose and gestural to tight and controlled, capturing both quick impressions and detailed studies. Figures and environments appear raw and unpolished, with construction lines sometimes visible, lending an in-progress or documentary feel. The grayscale palette allows lighting and shading to take center stage. The overall aesthetic is intimate, thoughtful, and process-oriented—perfect for character studies, architectural drafts, or emotional storytelling.`,
  },
  {
    name: 'Low-Poly 3D Render',
    description: 'minimalist low-polygon 3D',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Low-Poly_3D_Render.jpeg',
    style: `A minimalist 3D illustration style using low-polygon modeling, presented in wide format. Scenes are constructed with simplified geometric shapes and faceted surfaces, creating a clean, stylized aesthetic. Colors are flat and pastel or matte, often with subtle ambient lighting and no texture mapping. Shadows are soft and angles crisp, giving the image a playful, toy-like quality. Figures and environments are abstracted, relying on silhouette and proportion for clarity. The overall look is modern, design-oriented, and ideal for stylized infographics, games, or architectural visualizations.`,
  },
  {
    name: 'Art Nouveau Illustration',
    description: 'decorative Art Nouveau style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Art_Nouveau_Illustration.jpeg',
    style: `A decorative Art Nouveau style in wide format, inspired by the works of Alphonse Mucha. Features flowing, elegant linework with intricate patterns, floral motifs, and sinuous forms. Figures are idealized and graceful, often framed within ornate borders or circular compositions. The color palette leans toward soft pastels, warm sepia tones, and muted golds, with gentle gradients and hand-drawn textures. Hair and garments follow organic curves, blending into botanical backdrops or abstract ornamentation. The overall aesthetic is romantic, timeless, and lush, with a focus on harmony, femininity, and visual rhythm.`,
  },
  {
    name: 'Charcoal and Chalk',
    description: 'dramatic charcoal and chalk drawing',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/GrokImage/Charcoal_and_Chalk.jpeg',
    style: `A dramatic charcoal and chalk drawing style in wide format. Utilizes rich black strokes, powdery smudges, and stark white highlights for intense contrast and expressive texture. The linework is bold, raw, and often sketchy, with a focus on light and shadow rather than fine detail. Backgrounds may dissolve into textured gradients or remain abstract. Figures appear rough yet emotionally powerful, emerging from deep shadows with luminous accents. The monochrome palette enhances a moody, timeless atmosphere, ideal for conveying drama, introspection, or historical gravitas.`,
  },
];

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

const GENESIS_STYLES = [
  {
    name: 'Old Comic Book',
    description: 'black-and-white old comic book-style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Old_Comic_Book.jpg',
    style: `A black-and-white old comic book-style illustration in wide format. Features dramatic contrast, rich textures, and expressive, rough linework resembling vintage war comics. High cinematic shadows with intense lighting, giving a moody, atmospheric tone. Characters are drawn with raw, emotional detail, and each scene feels like a hand-drawn storyboard frame. Backgrounds are layered with depth, and the overall composition balances realism with a surreal, haunted quality. The style evokes mid-20th-century graphic novels with a gritty, psychological edge. Make the image bright.`,
  },
  {
    name: 'Medieval Oil Painting',
    description: 'late medieval or early Renaissance style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Medieval_Oil_Painting.jpg',
    style: `A richly colored oil painting in the style of late medieval or early Renaissance European art or Viking paintings. Features clear composition, vibrant tones, painterly textures, realistic proportions, expressive facial detail, and soft, atmospheric backgrounds. Lighting is natural with soft shadows, evoking the emotional depth and storytelling found in historical panel paintings and illuminated manuscripts. Vivid bright Colors.`,
  },
  {
    name: 'Enchanted Anime',
    description: 'painterly hand-drawn animation',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Studio_Ghibli_Style.jpg',
    style: `A painterly, hand-drawn animation style in the tradition of classic Japanese feature animation, evoking the visual sensibility of landmark studios such as Studio Ghibli. Wide format with gentle, organic linework and subtle textures that mimic traditional cel animation. The palette is lush and nature-inspired—rich greens, soft pastels, golden sunlight, and warm earth tones—evoking emotional warmth and whimsical realism. Characters are expressive with large, emotive eyes and understated facial details. Backgrounds are intricately detailed yet softly rendered, often featuring idyllic countryside, cozy interiors, or magical environments with a nostalgic glow. Lighting is natural and dynamic, shifting gently across scenes to mirror time and mood. The overall aesthetic is warm, soulful, and immersive, blending everyday simplicity with quiet enchantment.`,
  },
  {
    name: 'Pixel Art',
    description: 'retro 8-bit/16-bit pixel art',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Pixel_Art.jpg',
    style: `A retro pixel art aesthetic in wide format. Rendered with blocky, low-resolution graphics and a limited color palette inspired by 8-bit and 16-bit era video games. Characters are made up of clearly visible pixels, with expressive poses and exaggerated features to convey personality despite simplicity. The color use is bold and saturated—vivid blues, electric purples, hot pinks—and scenes often include grid-based environments like forests, dungeons, or cities. Lighting is represented through dithering or basic color shifts. The overall effect is nostalgic, playful, and full of charm, reminiscent of classic console RPGs or arcade games.`,
  },
  {
    name: 'Realistic Animation',
    description: 'hyper-realistic animated style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Realistic_Animation.jpg',
    style: `A hyper-realistic animated style in wide format. Features high-resolution textures, lifelike surface details, and dynamic environmental lighting. The animation leans into dramatic perspective with exaggerated scale, emphasizing the colossal presence of the subject. Pixar like animation. Rich, saturated colors and sharp shadows create a vivid, high-contrast look, while the rendering mimics real-world physics—reflections, ambient occlusion, and depth of field included. The style evokes cutting-edge CGI from blockbuster creature features, balancing realism with intense visual energy. Movements would feel weighty and tactile, with subtle skin flexing, muscle shifts, and light interaction enhancing the sense of realism. Backgrounds are lush and detailed, often filled with atmospheric effects like volumetric light and soft lens flare, giving the scene an immersive, cinematic punch.`,
  },
  {
    name: 'Classical Oil Painting',
    description: 'Baroque-inspired oil painting',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Classical_Oil_Painting.jpg',
    style: `A classical oil painting style inspired by the Baroque masters, particularly Caravaggio and Rembrandt, emphasizing emotional realism, dramatic chiaroscuro lighting, and a subdued, earthy palette. Figures, architecture, and objects are rendered with painterly precision and soft, blended brushwork, capturing lifelike textures such as weathered fabric, aged skin, and stone walls. The lighting is intimate and directional, often sourced from a single candle or window, casting deep shadows and highlighting facial expressions and gesture with theatrical intensity. The atmosphere evokes solemnity and inner depth, with backgrounds kept dim and ambient to draw focus toward the emotional gravity of the foreground. The overall effect is timeless, reverent, and psychologically rich—ideal for contemplative, spiritual, or philosophical themes. Bright vivid colors. Wide format.`,
  },
  {
    name: 'Anime Modern Shonen',
    description: 'dynamic high-contrast anime',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Anime_Modern_Shonen.jpg',
    style: `A high-contrast, digitally inked anime style in wide format. Features sharp, dynamic linework with bold character outlines, intense facial expressions, and exaggerated action poses. Colors are vibrant and saturated—neon blues, deep reds, and glowing yellows—with energetic lighting and dramatic highlights. Hair and clothing are stylized with clear motion lines, and visual effects like speed blurs, energy auras, or glowing eyes enhance the sense of impact. Backgrounds range from minimalist to hyper-detailed depending on the emotional beat, often with radial gradients or stylized skies. This style embodies modern action anime, cinematic in scope and driven by expressive motion.`,
  },
  {
    name: 'Dreamy Painting',
    description: 'fantasy art with serene celestial themes',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Dreamy_Painting.jpg',
    style: `A dreamy digital painting in wide format, inspired by fantasy art and serene celestial themes. The palette is composed of cool, calming tones—deep navy blues, moonlit silvers, and soft cloud whites—creating a tranquil nighttime ambiance. Backgrounds include drifting clouds, distant stars, and a vast, luminous night sky, occasionally punctuated by birds or constellations. The lighting is soft and atmospheric, enhancing the peaceful, almost meditative mood. The brushwork is smooth and blended, lending a dreamy, high-fantasy aesthetic similar to cinematic concept art or modern digital illustrations with a painterly touch. The overall feeling is one of divine calm, sleep-inducing wonder, and timeless serenity.`,
  },
  {
    name: 'Ink & Wash',
    description: 'East Asian ink-and-wash painting',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Ink_and_Wash.jpg',
    style: `A traditional East Asian ink-and-wash painting style in wide format, inspired by Chinese and Japanese landscape art. The linework is expressive and brush-based, varying in thickness with fluid, calligraphic strokes. Monochrome or limited muted palettes—grays, blacks, and sepia tones—are layered with subtle watercolor washes to evoke mist, wind, or flowing water. Figures and scenery are often stylized and abstracted, emphasizing harmony with nature rather than anatomical precision. Negative space is used intentionally, and compositions feel balanced and meditative. This aesthetic conveys quiet power, simplicity, and spiritual depth.`,
  },
  {
    name: 'Dark Medieval Fantasy',
    description: 'dark medieval animation',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Dark_Medieval_Fantasy.jpg',
    style: `A dark medieval fantasy illustration in wide format. Features bold, heavy linework with rough, painterly textures and a muted, earthy color palette of deep reds, browns, and shadows. Lighting is stark and dramatic, casting faces into harsh highlights and deep gloom. Characters are drawn with exaggerated, grim expressions, evoking dread and authority. Backgrounds feature gothic stained glass, stone walls, and banners, enhancing the ominous tone. The overall composition feels like a hand-painted tapestry mixed with comic-book intensity, with an atmosphere of ritual, judgment, and foreboding power. Make the image bright.`,
  },
  {
    name: 'Bright Illustration',
    description: 'clean vector-based illustration',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Bright_Illustration.jpg',
    style: `A brightly colored digital illustration in wide format. Features clean, smooth linework with clear, uniform outlines and minimal shading. The color palette is warm and slightly muted, dominated by earthy oranges, soft browns, and beige tones, creating a cohesive and stylized aesthetic. Characters are drawn with rounded, cartoon-like features and expressive facial details that emphasize clarity and simplicity. Textures are minimal, with a flat, poster-like quality. The overall look is inspired by modern vector-based animation with subtle nods to ancient art motifs in the clothing and accessories. The background is sparse, directing focus toward character interaction. Make the image bright.`,
  },
  {
    name: 'Modern Infographic',
    description: 'flat vector-based illustration',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Modern_Infographic.jpg',
    style: `A flat, vector-based illustration style in wide format, commonly used in educational or infographic visuals. Clean geometric shapes, crisp lines, and minimal gradients define the look. Colors are often high-contrast, matte, and chosen for clarity—bold reds, clear blues, bright yellows—with strong use of white space and iconographic symbols. Characters and objects are simplified and schematic, emphasizing communication over realism. Shadows and perspective are either absent or extremely subtle. The tone is modern, accessible, and efficient—ideal for conveying data, instruction, or abstract concepts in a visually digestible way.`,
  },
  {
    name: 'Pencil Sketch',
    description: 'monochromatic pencil sketch',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Pencil_Sketch.jpg',
    style: `A monochromatic pencil sketch style in wide format. Features soft graphite textures, smudging, and fine crosshatching to render depth and tone. The linework varies from loose and gestural to tight and controlled, capturing both quick impressions and detailed studies. Figures and environments appear raw and unpolished, with construction lines sometimes visible, lending an in-progress or documentary feel. The grayscale palette allows lighting and shading to take center stage. The overall aesthetic is intimate, thoughtful, and process-oriented—perfect for character studies, architectural drafts, or emotional storytelling.`,
  },
  {
    name: 'Low-Poly 3D Render',
    description: 'minimalist low-polygon 3D',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Low-Poly_3D_Render.jpg',
    style: `A minimalist 3D illustration style using low-polygon modeling, presented in wide format. Scenes are constructed with simplified geometric shapes and faceted surfaces, creating a clean, stylized aesthetic. Colors are flat and pastel or matte, often with subtle ambient lighting and no texture mapping. Shadows are soft and angles crisp, giving the image a playful, toy-like quality. Figures and environments are abstracted, relying on silhouette and proportion for clarity. The overall look is modern, design-oriented, and ideal for stylized infographics, games, or architectural visualizations.`,
  },
  {
    name: 'Art Nouveau Illustration',
    description: 'decorative Art Nouveau style',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Art_Nouveau_Illustration.jpg',
    style: `A decorative Art Nouveau style in wide format, inspired by the works of Alphonse Mucha. Features flowing, elegant linework with intricate patterns, floral motifs, and sinuous forms. Figures are idealized and graceful, often framed within ornate borders or circular compositions. The color palette leans toward soft pastels, warm sepia tones, and muted golds, with gentle gradients and hand-drawn textures. Hair and garments follow organic curves, blending into botanical backdrops or abstract ornamentation. The overall aesthetic is romantic, timeless, and lush, with a focus on harmony, femininity, and visual rhythm.`,
  },
  {
    name: 'Charcoal and Chalk',
    description: 'dramatic charcoal and chalk drawing',
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/NanoBananaPro/Charcoal_and_Chalk.jpg',
    style: `A dramatic charcoal and chalk drawing style in wide format. Utilizes rich black strokes, powdery smudges, and stark white highlights for intense contrast and expressive texture. The linework is bold, raw, and often sketchy, with a focus on light and shadow rather than fine detail. Backgrounds may dissolve into textured gradients or remain abstract. Figures appear rough yet emotionally powerful, emerging from deep shadows with luminous accents. The monochrome palette enhances a moody, timeless atmosphere, ideal for conveying drama, introspection, or historical gravitas.`,
  },
];

// Language options
const LANGUAGE_OPTIONS = [
  { value: 'english', label: 'English' },
  { value: 'german', label: 'German' },
  { value: 'spanish', label: 'Spanish' },
  { value: 'french', label: 'French' },
];

// Model options (LEGACY default; in-component shadow flips to NEW for non-grandfathered users).
function buildModelOptions(isLegacy: boolean) {
  const m = isLegacy ? LEGACY_LLM_MULTIPLIERS : NEW_LLM_MULTIPLIERS;
  return [
    { value: 'deepseek', label: 'Core Model',        tokenMultiplier: m.deepseek, description: `${m.deepseek}x tokens` },
    { value: 'sonnet',   label: 'Claude Sonnet 4.6', tokenMultiplier: m.sonnet,   description: `${m.sonnet}x tokens` },
    { value: 'opus',     label: 'Claude Opus 4.6',   tokenMultiplier: m.opus,     description: `${m.opus}x tokens` },
  ];
}
const modelOptions = buildModelOptions(true);

// Image model options
const IMAGE_MODEL_OPTIONS = [
  {
    value: 'standard',
    label: 'Lite Model',
    backendValue: 'imagen-4-fast',
    tokensPerImage: 14000,
    borderColor: 'border-blue-500',
    bgColor: 'bg-blue-500/20',
    textColor: 'text-blue-300',
    hoverBorder: 'hover:border-blue-400',
    description: 'Cheapest option'
  },
  {
    value: 'grok',
    label: 'Grok Model',
    backendValue: 'grok-imagine-image',
    tokensPerImage: 16000,
    borderColor: 'border-orange-500',
    bgColor: 'bg-orange-500/20',
    textColor: 'text-orange-300',
    hoverBorder: 'hover:border-orange-400',
    description: 'Fast & affordable'
  },
  {
    value: 'plus',
    label: 'Core Model',
    backendValue: 'gpt-image-1-mini',
    tokensPerImage: 30000,
    borderColor: 'border-green-500',
    bgColor: 'bg-green-500/20',
    textColor: 'text-green-300',
    hoverBorder: 'hover:border-green-400'
  },
  {
    value: 'prime',
    label: 'Prime Model',
    backendValue: 'seedream-4.5',
    tokensPerImage: 35000,
    recommended: true,
    borderColor: 'border-teal-500',
    bgColor: 'bg-teal-500/20',
    textColor: 'text-teal-300',
    hoverBorder: 'hover:border-teal-400'
  },
  {
    value: 'premium',
    label: 'Heavy Model',
    backendValue: 'imagen-4-ultra',
    tokensPerImage: 42000,
    borderColor: 'border-purple-500',
    bgColor: 'bg-purple-500/20',
    textColor: 'text-purple-300',
    hoverBorder: 'hover:border-purple-400'
  },
  {
    value: 'genesis',
    label: 'Genesis Model',
    backendValue: 'nano-banana-pro',
    tokensPerImage: 100000,
    borderColor: 'border-yellow-500',
    bgColor: 'bg-yellow-500/20',
    textColor: 'text-yellow-300',
    hoverBorder: 'hover:border-yellow-400'
  }
];

// Image-model option list — module-scope is the LEGACY default; the
// `buildImageModelOptions` factory mirrors NEW-plan rates when needed.
function buildImageModelOptions(isLegacy: boolean) {
  const m = isLegacy ? LEGACY_IMAGE_TOKENS_PER_IMAGE : NEW_IMAGE_TOKENS_PER_IMAGE;
  return IMAGE_MODEL_OPTIONS.map(opt => ({
    ...opt,
    tokensPerImage: m[opt.backendValue] ?? opt.tokensPerImage,
  }));
}

// Helper functions
const formatNumber = (num: number) => {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
};

const formatTime = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

// Calculate estimated image count based on Python logic
const calculateEstimatedImageCount = (wordCount: number, firstPageFreq: number, restFreq: number): number => {
  if (!wordCount || wordCount <= 0) return 0;
  
  const totalChars = wordCount * 5; // Use 5 chars per word (Python uses this)
  
  // First page calculation
  const firstPageCharsPerSegment = Math.max(100, Math.min(3000, Math.round(firstPageFreq * 13.67))); // Use 13.67 CHARS_PER_SECOND
  const firstPageSegments = Math.ceil(3000 / firstPageCharsPerSegment);
  
  // Rest calculation
  const remainingChars = Math.max(0, totalChars - 3000);
  const restCharsPerSegment = Math.max(100, Math.round(restFreq * 13.67)); // Use 13.67 CHARS_PER_SECOND
  const restSegments = remainingChars > 0 ? Math.ceil(remainingChars / restCharsPerSegment) : 0;
  
  const totalPrompts = firstPageSegments + restSegments;
  
  // Apply 18% increase as per Python logic
  return Math.round(totalPrompts * 1.18);
};

// Calculate estimated token cost for images. Optional `mapOverride` lets the
// caller pass a plan-aware tokens-per-image map; falls back to LEGACY default.
const calculateEstimatedImageTokens = (
  imageCount: number,
  imageModel: string,
  mapOverride?: Record<string, number>,
): number => {
  if (imageCount <= 0) return 0;

  const m = mapOverride ?? LEGACY_IMAGE_TOKENS_PER_IMAGE;
  const tokensPerImage: Record<string, number> = {
    standard: m['imagen-4-fast'], 'imagen-4-fast': m['imagen-4-fast'],
    grok: m['grok-imagine-image'], 'grok-imagine-image': m['grok-imagine-image'],
    plus: m['gpt-image-1-mini'], 'gpt-image-1-mini': m['gpt-image-1-mini'],
    premium: m['imagen-4-ultra'], 'imagen-4-ultra': m['imagen-4-ultra'],
    spark: m['flux-2-dev'], 'flux-2-dev': m['flux-2-dev'],
    prime: m['seedream-4.5'], 'seedream-4.5': m['seedream-4.5'],
    genesis: m['nano-banana-pro'], 'nano-banana-pro': m['nano-banana-pro'],
  };

  return imageCount * (tokensPerImage[imageModel] || 30000);
};

// Calculate prompt generation token cost. Optional `optionsOverride` lets the
// caller pass a plan-aware modelOptions list; falls back to LEGACY default.
const calculatePromptTokens = (
  wordCount: number,
  settings: NewPromptsSettings,
  optionsOverride?: typeof modelOptions,
): number => {
  if (!wordCount || wordCount <= 0) return 0;

  const opts = optionsOverride ?? modelOptions;
  const selectedModel = opts.find(m => m.value === settings.model) || opts[0];
  const totalLength = wordCount * 5;
  
  // Calculate number of prompts using Python logic
  const firstPageFreq = parseFloat(settings.firstPageFrequency);
  const restFreq = parseFloat(settings.restFrequency);
  const firstPageCharsPerSegment = Math.max(100, Math.min(3000, Math.round(firstPageFreq * 13.67)));
  const firstPageSegments = Math.ceil(3000 / firstPageCharsPerSegment);
  
  const remainingChars = Math.max(0, totalLength - 3000);
  const restCharsPerSegment = Math.max(100, Math.round(restFreq * 13.67));
  const restSegments = remainingChars > 0 ? Math.ceil(remainingChars / restCharsPerSegment) : 0;
  
  let totalPrompts = firstPageSegments + restSegments;
  // Apply 18% increase as per Python logic
  totalPrompts = Math.round(totalPrompts * 1.18);
  
  // Calculate token usage using Python logic
  let totalInputTokens = wordCount * 1.33;
  const segmentsPerBatch = restFreq > 120 ? 1 : 2;
  const batchCount = Math.max(1, Math.ceil(totalPrompts / segmentsPerBatch));
  totalInputTokens += batchCount * 500; // fixed input per batch
  
  let totalOutputTokens = totalPrompts * 600 * 1.33;
  
  if (settings.useCharacterDescriptions) {
    const userChars = Math.min(10000, totalLength);
    const userWords = Math.round(userChars / 5.5);
    totalInputTokens += (128 + userWords) * 1.33;
    totalOutputTokens += 400;
  }
  
  // Apply safety multipliers
  totalInputTokens *= 1.25; // 25% safety buffer for input
  // No multiplier for output tokens
  
  return Math.round((totalInputTokens * 0.25 + totalOutputTokens) * selectedModel.tokenMultiplier);
};

// 1. PromptModeSelector Component
interface PromptModeSelectorProps {
  selectedMode: 'existing' | 'new' | 'individual';
  onModeChange: (mode: 'existing' | 'new' | 'individual') => void;
  disabled: boolean;
}

export const PromptModeSelector: React.FC<PromptModeSelectorProps> = ({
  selectedMode,
  onModeChange,
  disabled
}) => {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <button
          onClick={() => onModeChange('new')}
          disabled={disabled}
          className={`p-4 rounded-xl border-2 transition-all text-left ${
            selectedMode === 'new'
              ? 'border-red-800/70 bg-red-900/30'
              : 'border-border-card bg-surface-card hover:border-white/20'
          } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        >
          <div className="font-medium text-white text-sm sm:text-base">New Image Prompts</div>
          <div className="text-xs sm:text-sm text-text-muted mt-1">
            Generate new prompts for images
          </div>
        </button>
        
        <button
          onClick={() => onModeChange('existing')}
          disabled={disabled}
          className={`p-4 rounded-xl border-2 transition-all text-left ${
            selectedMode === 'existing'
              ? 'border-red-800/70 bg-red-900/30'
              : 'border-border-card bg-surface-card hover:border-white/20'
          } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        >
          <div className="font-medium text-white text-sm sm:text-base">Use Image Prompts</div>
          <div className="text-xs sm:text-sm text-text-muted mt-1">
            Use existing prompts for generation
          </div>
        </button>

        <button
          onClick={() => onModeChange('individual')}
          disabled={disabled}
          className={`p-4 rounded-xl border-2 transition-all text-left ${
            selectedMode === 'individual'
              ? 'border-red-800/70 bg-red-900/30'
              : 'border-border-card bg-surface-card hover:border-white/20'
          } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        >
          <div className="font-medium text-white text-sm sm:text-base">Individual Prompt</div>
          <div className="text-xs sm:text-sm text-text-muted mt-1">
            Generate a single image from a prompt
          </div>
        </button>
    </div>
  );
};

// 2. Updated NewImagePromptsForm Component (REMOVED DOCUMENT SELECTION)
interface NewImagePromptsFormProps {
  settings: NewPromptsSettings;
  onSettingsChange: (settings: NewPromptsSettings) => void;
  validationErrors: ValidationErrors;
  onValidationErrors: (errors: ValidationErrors) => void;
  estimate: CombinedEstimate | null;
  onEstimateChange: (estimate: CombinedEstimate | null) => void;
  disabled: boolean;
  userTokenBalance: number;
  storageUsed: number | null;
  maxStorageGB: number;
  wordCount: number;
  isGenerating?: boolean; // ADDED THIS NEW PROP
  userId?: string; // ADD userId for audio file handling
  selectedStoryGroupId?: string | null; // ADD for audio mode
  storySource?: 'new' | 'existing' | 'upload'; // ADD for audio mode
}

export const NewImagePromptsForm: React.FC<NewImagePromptsFormProps> = ({
  settings,
  onSettingsChange,
  validationErrors,
  onValidationErrors,
  estimate,
  onEstimateChange,
  disabled,
  userTokenBalance,
  storageUsed,
  maxStorageGB,
  wordCount,
  isGenerating = false, // ADDED THIS
  userId, // ADD userId
  selectedStoryGroupId, // ADD for audio mode
  storySource, // ADD for audio mode
}) => {
  const [showMoreStyles, setShowMoreStyles] = useState(false);

  // Get current styles based on selected model
  const getCurrentStyles = () => {
    switch (settings.imageModel) {
      case 'standard':
        return STANDARD_STYLES;
      case 'plus':
        return PLUS_STYLES;
      case 'premium':
        return PREMIUM_STYLES;
      case 'spark':
        return SPARK_STYLES;
      case 'grok':
        return GROK_STYLES;
      case 'prime':
        return PRIME_STYLES;
      case 'genesis':
        return GENESIS_STYLES;
      default:
        return PLUS_STYLES;
    }
  };

  const currentStyles = getCurrentStyles();

  // Plan-aware shadows. Re-binding the same names lets all existing references
  // below use NEW-plan rates for non-grandfathered users without changes.
  const { isLegacy } = useIsLegacyPlan();
  const modelOptions = useMemo(() => buildModelOptions(isLegacy), [isLegacy]);
  const IMAGE_MODEL_OPTIONS = useMemo(() => buildImageModelOptions(isLegacy), [isLegacy]);
  const imageTokensMap = useMemo(
    () => (isLegacy ? LEGACY_IMAGE_TOKENS_PER_IMAGE : NEW_IMAGE_TOKENS_PER_IMAGE),
    [isLegacy],
  );

  const selectedModel = modelOptions.find(m => m.value === settings.model) || modelOptions[0];

  // Helper function to check if the current style is a custom style
  const isCustomStyle = (style: string) => {
    const allPredefinedStyles = [...STANDARD_STYLES, ...PLUS_STYLES, ...PREMIUM_STYLES, ...SPARK_STYLES, ...GROK_STYLES, ...PRIME_STYLES, ...GENESIS_STYLES];
    return !allPredefinedStyles.some(predefinedStyle => predefinedStyle.style === style);
  };

  // Validate settings - Updated to support audio mode
  const validateSettings = () => {
    const errors: ValidationErrors = {};
    
    if (settings.frequencyMode === 'wordcount') {
      if (settings.frequencyType === 'consistent') {
        // Consistent frequency validation
        if (settings.consistentFrequency && settings.consistentFrequency.trim() !== '') {
          const consistent = parseFloat(settings.consistentFrequency);
          if (isNaN(consistent) || consistent < 5 || consistent > 600) {
            errors.consistentFrequency = 'Consistent frequency must be between 5 and 600 seconds';
          }
        }
      } else {
        // Variable frequency validation
        if (settings.firstPageFrequency && settings.firstPageFrequency.trim() !== '') {
          const firstPage = parseFloat(settings.firstPageFrequency);
          if (isNaN(firstPage) || firstPage < 5 || firstPage > 300) {
            errors.firstPageFrequency = 'First page frequency must be between 5 and 300 seconds';
          }
        }

        if (settings.restFrequency && settings.restFrequency.trim() !== '') {
          const rest = parseFloat(settings.restFrequency);
          if (isNaN(rest) || rest < 5 || rest > 600) {
            errors.restFrequency = 'Rest frequency must be between 5 and 600 seconds';
          }
        }
      }
    } else if (settings.frequencyMode === 'audio') {
      // Audio mode validation
      if (!settings.audioFiles || settings.audioFiles.length === 0) {
        errors.imageAmount = 'Please select or upload audio files first';
      } else if (settings.totalAudioDuration === 0) {
        errors.imageAmount = 'Audio duration calculation pending';
      } else {
        const MAX_FREQUENCY_SECONDS = 900;
        const MIN_FREQUENCY_SECONDS = 5;
        
        if (settings.audioDistributionType === 'consistent') {
          const imageAmtStr = settings.imageAmount || '';
          if (imageAmtStr.trim() !== '') {
            const imageAmt = parseInt(imageAmtStr);
            const maxImages = Math.floor((settings.totalAudioDuration || 0) / MIN_FREQUENCY_SECONDS);
            const minImages = Math.max(1, Math.ceil((settings.totalAudioDuration || 0) / MAX_FREQUENCY_SECONDS));
            
            if (isNaN(imageAmt) || imageAmt < minImages) {
              errors.imageAmount = `Minimum ${minImages} image(s) required (max ${MAX_FREQUENCY_SECONDS / 60} min per image)`;
            } else if (imageAmt > maxImages) {
              errors.imageAmount = `Maximum ${maxImages} images allowed (min ${MIN_FREQUENCY_SECONDS}s per image)`;
            }
          }
        } else if (settings.audioDistributionType === 'variable') {
          const totalDuration = settings.totalAudioDuration || 0;
          const firstPageDuration = Math.min(360, totalDuration);
          const restDuration = Math.max(0, totalDuration - firstPageDuration);
          
          const maxFirstImages = Math.floor(firstPageDuration / MIN_FREQUENCY_SECONDS);
          const maxRestImages = restDuration > 0 ? Math.floor(restDuration / MIN_FREQUENCY_SECONDS) : 0;
          const minFirstImages = Math.max(1, Math.ceil(firstPageDuration / MAX_FREQUENCY_SECONDS));
          const minRestImages = restDuration > 0 ? Math.max(1, Math.ceil(restDuration / MAX_FREQUENCY_SECONDS)) : 0;
          
          const firstPageStr = settings.audioFirstPageImageCount || '';
          const restStr = settings.audioRestImageCount || '';
          
          if (firstPageStr.trim() !== '') {
            const firstPageImages = parseInt(firstPageStr);
            if (isNaN(firstPageImages) || firstPageImages < minFirstImages) {
              errors.imageAmount = `First page: Minimum ${minFirstImages} image(s) required`;
            } else if (firstPageImages > maxFirstImages) {
              errors.imageAmount = `First page: Maximum ${maxFirstImages} images for ${Math.round(firstPageDuration)}s`;
            }
          }
          
          if (restDuration > 0 && restStr.trim() !== '') {
            const restImages = parseInt(restStr);
            if (isNaN(restImages) || restImages < minRestImages) {
              if (!errors.imageAmount) {
                errors.imageAmount = `Rest: Minimum ${minRestImages} image(s) required`;
              }
            } else if (restImages > maxRestImages) {
              if (!errors.imageAmount) {
                errors.imageAmount = `Rest: Maximum ${maxRestImages} images for ${Math.round(restDuration)}s`;
              }
            }
          }
        }
      }
    }

    onValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Auto-calculate totalAudioDuration if audioFiles have durations but totalAudioDuration is not set
  // Only auto-calculate when switching to audio mode or files change, not when user explicitly clears
  React.useEffect(() => {
    if (settings.frequencyMode === 'audio' && 
        settings.audioFiles && 
        settings.audioFiles.length > 0 && 
        settings.totalAudioDuration === 0) {
      // Check if all files have durations
      const allHaveDurations = settings.audioFiles.every(f => f.duration && f.duration > 0);
      if (allHaveDurations) {
        const totalDuration = settings.audioFiles.reduce((sum, f) => sum + f.duration, 0);
        console.log('[NewImagePromptsForm] Auto-calculating totalAudioDuration from files:', totalDuration);
        onSettingsChange({ ...settings, totalAudioDuration: totalDuration });
      }
    } else if (settings.frequencyMode === 'audio' && 
               settings.audioFiles && 
               settings.audioFiles.length === 0 && 
               settings.totalAudioDuration !== 0) {
      // If audio files are cleared, also clear duration
      console.log('[NewImagePromptsForm] Audio files cleared, resetting totalAudioDuration to 0');
      onSettingsChange({ ...settings, totalAudioDuration: 0 });
    }
  }, [settings.audioFiles, settings.frequencyMode]);

  // Update estimate when settings change - Updated for audio mode
  React.useEffect(() => {
    validateSettings();
    
    if (wordCount > 0 || (settings.frequencyMode === 'audio' && settings.totalAudioDuration > 0)) {
      let totalImages = 0;
      
      if (settings.frequencyMode === 'audio') {
        // For audio mode, check distribution type
        if (settings.audioDistributionType === 'variable' && 
            settings.audioFirstPageImageCount && 
            settings.audioRestImageCount) {
          // Variable distribution: sum of first page + rest
          totalImages = parseInt(settings.audioFirstPageImageCount) + parseInt(settings.audioRestImageCount);
        } else {
          // Consistent distribution: use imageAmount
          totalImages = parseInt(settings.imageAmount || '1') || 1;
        }
      } else if (settings.frequencyType === 'consistent') {
        const consistentFreq = parseFloat(settings.consistentFrequency || '10');
        const CHARS_PER_SECOND = 13.67;
        const totalChars = wordCount * 5;
        const charsPerSegment = Math.max(100, Math.floor(consistentFreq * CHARS_PER_SECOND));
        const totalPrompts = Math.ceil(totalChars / charsPerSegment);
        // Apply 18% increase to match backend calculation and ImageFrequencyConfiguration
        totalImages = Math.round(totalPrompts * 1.18);
      } else {
        const firstPageFreq = parseFloat(settings.firstPageFrequency ?? '10');
        const restFreq = parseFloat(settings.restFrequency ?? '30');
        totalImages = calculateEstimatedImageCount(wordCount, firstPageFreq, restFreq);
      }
      
      const promptTokens = calculatePromptTokens(wordCount, settings, modelOptions);
      const imageTokens = calculateEstimatedImageTokens(totalImages, settings.imageModel, imageTokensMap);
      const totalTokens = promptTokens + imageTokens;
      const storageNeeded = totalImages * IMAGE_SIZE_MB;
      
      onEstimateChange({
        totalImages,
        promptTokens,
        imageTokens,
        totalTokens,
        storageNeeded
      });
    } else {
      onEstimateChange(null);
    }
  }, [wordCount, settings]);

  return (
    <div className="space-y-5">
      <div className="relative px-1">
        <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">Image Generation Settings</label>
      </div>

      {/* Image Model Selection */}
      <div>
        <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Image Quality Model</label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {IMAGE_MODEL_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => onSettingsChange({ ...settings, imageModel: option.value as any })}
              className={`relative p-3 rounded-xl border transition-all duration-200 text-left ${
                settings.imageModel === option.value
                  ? `${option.borderColor} ${option.bgColor} ${option.textColor}`
                  : 'border-white/10 bg-surface-input text-text-muted hover:border-white/20 hover:text-white/80'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={disabled}
            >
              {option.recommended && (
                <div className="absolute -top-2 -right-2 bg-accent text-white text-[10px] font-mono tracking-wide px-2 py-0.5 rounded-full">
                  Recommended
                </div>
              )}
              <div className="font-medium text-sm">
                {option.label}
              </div>
              <div className="text-xs opacity-75 mt-0.5">{option.tokensPerImage.toLocaleString()} tokens per image</div>
            </button>
          ))}
        </div>
      </div>

      {/* Image Style Selection */}
      <div>
        <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-4">Image Style</label>
        <div className="p-4 rounded-xl bg-surface-card border border-border-card mb-4">
          <div className="flex items-start space-x-2">
            <Info className="h-5 w-5 text-text-muted mt-0.5 flex-shrink-0" />
            <div className="text-sm text-text-muted">
              <p>The image styles below show how images will look for the {settings.imageModel} model. Each model produces different quality and style variations.</p>
              {isCustomStyle(settings.style) && (
                <p className="mt-2 text-yellow-400">
                  <strong>Note:</strong> Custom styles can use all models.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {currentStyles.slice(0, showMoreStyles ? 16 : 4).map((style) => (
            <div
              key={style.name}
              className={`relative bg-surface-card rounded-xl overflow-hidden transition-all duration-200 border border-border-card ${
                disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
              } ${
                settings.style === style.style ? 'ring-2 ring-accent' : 'hover:ring-2 hover:ring-white/20'
              }`}
              onClick={() => !disabled && onSettingsChange({ ...settings, style: style.style })}
            >
              <div className="aspect-video w-full">
                <img src={style.image} alt={`${style.name} Example`} className="w-full h-full object-cover" />
              </div>
              <div className="p-4">
                <h3 className="text-lg font-medium text-white mb-1">{style.name}</h3>
                <p className="text-sm text-text-muted">{style.description}</p>
              </div>
              {settings.style === style.style && (
                <div className="absolute top-2 right-2 bg-accent text-white rounded-full p-1">
                  <CheckCircle2 className="h-5 w-5" />
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-center mt-4">
          <button
            onClick={() => setShowMoreStyles(!showMoreStyles)}
            className={`px-4 py-2 bg-white/10 text-white rounded-xl hover:bg-white/15 transition-colors ${
              disabled ? 'opacity-50 cursor-not-allowed' : ''
            }`}
            disabled={disabled}
          >
            {showMoreStyles ? 'Show Less' : 'Show More +12'}
          </button>
        </div>

        <div className="mt-6 rounded-xl overflow-hidden border border-border-card">
          <div className="p-4">
            <h3 className="text-lg font-medium text-white mb-2">Custom Style</h3>
            <textarea
              value={settings.style !== currentStyles.find(s => s.style === settings.style)?.style ? settings.style : ''}
              onChange={(e) => onSettingsChange({ ...settings, style: e.target.value.slice(0, 1200) })}
              className={`w-full bg-surface-input border border-white/[0.13] rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 placeholder:text-white/40 ${
                disabled ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              rows={6}
              maxLength={1200}
              placeholder="Describe your custom image style..."
              disabled={disabled}
            />
            <div className="mt-1 text-xs text-text-muted text-right">
              {(settings.style !== currentStyles.find(s => s.style === settings.style)?.style ? settings.style : '').length} / 1200
            </div>
            {isCustomStyle(settings.style) && (
              <div className="mt-1 text-sm text-yellow-400">
                Custom styles can use all image models.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Character Consistency */}
      <div className="space-y-5" style={{ zoom: 1 / 1.1 }}>
      <div className="p-5 rounded-2xl bg-surface-card border border-border-card">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-white font-medium">Character Consistency</h3>
            <p className="text-text-muted text-sm mt-2">Maintain consistent character descriptions across all prompts</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.useCharacterDescriptions}
            aria-label="Toggle character consistency"
            onClick={() => !disabled && onSettingsChange({ ...settings, useCharacterDescriptions: !settings.useCharacterDescriptions })}
            disabled={disabled}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
              settings.useCharacterDescriptions ? 'bg-accent' : 'bg-white/10'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                settings.useCharacterDescriptions ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Custom Characters Section - only visible when Character Consistency is ON */}
      {settings.useCharacterDescriptions && (
        <div className="rounded-2xl bg-surface-card border border-border-card p-5 space-y-4">
          {/* Custom Characters Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-white font-medium">Custom Characters</h3>
              <p className="text-text-muted text-sm mt-1">Define your own character descriptions instead of auto-extracting from the story</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.customCharactersEnabled}
              aria-label="Toggle custom characters"
              onClick={() => {
                  if (disabled) return;
                  const newSettings = { 
                    ...settings, 
                    customCharactersEnabled: !settings.customCharactersEnabled,
                    customCharacters: !settings.customCharactersEnabled && (!settings.customCharacters || settings.customCharacters.length === 0) 
                      ? [{ name: '', description: '' }] 
                      : settings.customCharacters
                  };
                  onSettingsChange(newSettings);
                }}
              disabled={disabled}
              className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                settings.customCharactersEnabled ? 'bg-accent' : 'bg-white/10'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                  settings.customCharactersEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Custom Characters Fields */}
          {settings.customCharactersEnabled && (
            <div className="space-y-4">
              {/* Info Warning Box */}
              <div className="flex items-start gap-2 p-4 bg-status-warning border border-status-warning rounded-xl">
                <AlertCircle className="h-5 w-5 text-status-warning flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-status-warning-text font-medium">Important</p>
                  <p className="text-xs text-status-warning-text mt-1">
                    Custom character descriptions will override automatic character extraction from your story. 
                    Make sure character names exactly match the names used in your story text for proper matching in image prompts.
                  </p>
                </div>
              </div>

              {/* Character Name + Description Fields */}
              <div>
                <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">
                  Character Descriptions
                  <span className="text-white/40 ml-2 normal-case tracking-normal">(Max 10)</span>
                </label>
                <div className="space-y-3">
                  {(settings.customCharacters || []).map((char, index) => (
                    <div key={index} className="flex gap-2 items-start">
                      <div className="flex-1 space-y-2">
                        <input
                          type="text"
                          value={char.name}
                          onChange={(e) => {
                            const newChars = [...(settings.customCharacters || [])];
                            newChars[index] = { ...newChars[index], name: e.target.value };
                            onSettingsChange({ ...settings, customCharacters: newChars });
                          }}
                          placeholder="Character name (must match story text)"
                          className="w-full px-4 py-3 bg-surface-input border border-white/[0.13] rounded-xl text-white text-sm placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50"
                          disabled={disabled}
                        />
                        <textarea
                          value={char.description}
                          onChange={(e) => {
                            const newChars = [...(settings.customCharacters || [])];
                            newChars[index] = { ...newChars[index], description: e.target.value };
                            onSettingsChange({ ...settings, customCharacters: newChars });
                          }}
                          placeholder="Physical appearance, clothing, build, facial features, hair, accessories..."
                          className="w-full px-4 py-3 bg-surface-input border border-white/[0.13] rounded-xl text-white text-sm placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 resize-none"
                          rows={2}
                          disabled={disabled}
                        />
                      </div>
                      {(settings.customCharacters || []).length > 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            const newChars = (settings.customCharacters || []).filter((_, i) => i !== index);
                            onSettingsChange({ ...settings, customCharacters: newChars });
                          }}
                          disabled={disabled}
                          className="mt-1 p-2 text-status-error hover:text-status-error hover:bg-white/[0.08] rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {(settings.customCharacters || []).length < 10 && (
                  <button
                    type="button"
                    onClick={() => {
                      onSettingsChange({
                        ...settings,
                        customCharacters: [...(settings.customCharacters || []), { name: '', description: '' }]
                      });
                    }}
                    disabled={disabled}
                    className="mt-3 w-full py-3 bg-surface-card hover:bg-surface-input border border-border-card rounded-xl text-text-secondary text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Add Character
                  </button>
                )}
              </div>

              {/* AI Enhancement Toggle */}
              <div className="flex items-start justify-between pt-3 border-t border-border-card">
                <div className="flex-1">
                  <label className="flex items-center text-sm font-medium text-white">
                    AI Enhancement
                    <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-status-success text-status-success rounded-full border border-status-success">
                      Recommended
                    </span>
                  </label>
                  <p className="mt-1 text-xs text-text-muted">
                    Let AI expand your basic character descriptions into detailed visual descriptions optimized for image generation. Provide just the essentials—AI fills in the visual details.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => !disabled && onSettingsChange({ ...settings, customCharactersAIEnhance: !settings.customCharactersAIEnhance })}
                  disabled={disabled}
                  className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${
                    settings.customCharactersAIEnhance ? 'bg-accent' : 'bg-white/10'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      settings.customCharactersAIEnhance ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Language Selection */}
      <div>
        <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">Language</label>
        <Listbox
          value={settings.language}
          onChange={(value) => onSettingsChange({ ...settings, language: value })}
          disabled={disabled}
        >
          {({ open }) => (
            <div className="relative">
              <Listbox.Button className={`relative w-full bg-surface-input border border-white/[0.13] rounded-xl px-5 py-4 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-surface-input'}`}>
                <span className="block truncate">
                  {LANGUAGE_OPTIONS.find(option => option.value === settings.language)?.label || 'English'}
                </span>
                <span className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none">
                  <ChevronDown className={`h-5 w-5 text-white/50 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                </span>
              </Listbox.Button>
              <Transition
                show={open}
                enter="transition ease-out duration-100"
                enterFrom="transform opacity-0 scale-95"
                enterTo="transform opacity-100 scale-100"
                leave="transition ease-in duration-75"
                leaveFrom="transform opacity-100 scale-100"
                leaveTo="transform opacity-0 scale-95"
              >
                <Listbox.Options className="absolute z-10 mt-2 w-full bg-surface-dropdown border border-white/[0.11] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                  {LANGUAGE_OPTIONS.map((option) => (
                    <Listbox.Option
                      key={option.value}
                      value={option.value}
                      className={({ active, selected }) =>
                        `relative cursor-pointer select-none py-3 px-4 ${active ? 'bg-white/[0.08] text-white' : 'text-text-secondary'} ${selected ? 'font-medium' : 'font-normal'}`
                      }
                    >
                      {({ selected }) => (
                        <div className="flex justify-between items-center">
                          <span className={selected ? 'font-medium text-white' : 'font-normal'}>{option.label}</span>
                          {selected && (
                            <span className="text-accent-text">
                              <CheckCircle2 className="h-5 w-5" />
                            </span>
                          )}
                        </div>
                      )}
                    </Listbox.Option>
                  ))}
                </Listbox.Options>
              </Transition>
            </div>
          )}
        </Listbox>
      </div>

      {/* AI Model Selection */}
      <div>
        <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">AI Model</label>
        <Listbox
          value={settings.model}
          onChange={(value) => onSettingsChange({ ...settings, model: value })}
          disabled={disabled}
        >
          {({ open }) => (
            <div className="relative">
              <Listbox.Button className={`relative w-full bg-surface-input border border-white/[0.13] rounded-xl px-5 py-4 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-surface-input'}`}>
                <span className="block truncate">
                  {selectedModel.label}
                </span>
                <span className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none">
                  <ChevronDown className={`h-5 w-5 text-white/50 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                </span>
              </Listbox.Button>
              <Transition
                show={open}
                enter="transition ease-out duration-100"
                enterFrom="transform opacity-0 scale-95"
                enterTo="transform opacity-100 scale-100"
                leave="transition ease-in duration-75"
                leaveFrom="transform opacity-100 scale-100"
                leaveTo="transform opacity-0 scale-95"
              >
                <Listbox.Options className="absolute z-10 mt-2 w-full bg-surface-dropdown border border-white/[0.11] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                  {modelOptions.map((option) => (
                    <Listbox.Option
                      key={option.value}
                      value={option.value}
                      className={({ active, selected }) =>
                        `relative cursor-pointer select-none py-3 px-4 ${active ? 'bg-white/[0.08] text-white' : 'text-text-secondary'} ${selected ? 'font-medium' : 'font-normal'}`
                      }
                    >
                      {({ selected }) => (
                        <div className="flex justify-between items-center">
                          <div>
                            <span className={selected ? 'font-medium text-white' : 'font-normal'}>{option.label}</span>
                            <p className="text-xs text-text-muted mt-1">
                              {option.description}
                            </p>
                          </div>
                          {selected && (
                            <span className="text-accent-text">
                              <CheckCircle2 className="h-5 w-5" />
                            </span>
                          )}
                        </div>
                      )}
                    </Listbox.Option>
                  ))}
                </Listbox.Options>
              </Transition>
            </div>
          )}
        </Listbox>
        <p className="mt-2 text-xs text-text-muted">
          Selected: {selectedModel.label} ({selectedModel.description})
        </p>
      </div>
      </div>

      {/* Image Frequency Configuration - Replace simple inputs with full component */}
      <ImageFrequencyConfiguration
        mode={settings.frequencyMode || 'wordcount'}
        onModeChange={(mode) => onSettingsChange(prev => ({ ...prev, frequencyMode: mode }))}
        frequencyType={settings.frequencyType || 'consistent'}
        onFrequencyTypeChange={(type) => onSettingsChange(prev => ({ ...prev, frequencyType: type }))}
        wordCount={wordCount}
        consistentFrequency={settings.consistentFrequency || ''}
        onConsistentFrequencyChange={(value) => onSettingsChange(prev => ({ ...prev, consistentFrequency: value }))}
        firstPageFrequency={settings.firstPageFrequency}
        onFirstPageFrequencyChange={(value) => onSettingsChange(prev => ({ ...prev, firstPageFrequency: value }))}
        restFrequency={settings.restFrequency}
        onRestFrequencyChange={(value) => onSettingsChange(prev => ({ ...prev, restFrequency: value }))}
        selectedStoryGroupId={selectedStoryGroupId || null}
        selectedStoryTitle="" 
        storySource={storySource}
        audioFiles={settings.audioFiles || []}
        onAudioFilesChange={(files) => onSettingsChange(prev => ({ ...prev, audioFiles: files }))}
        totalAudioDuration={settings.totalAudioDuration || 0}
        onTotalAudioDurationChange={(duration) => onSettingsChange(prev => ({ ...prev, totalAudioDuration: duration }))}
        imageAmount={settings.imageAmount || ''}
        onImageAmountChange={(amount) => onSettingsChange(prev => ({ ...prev, imageAmount: amount }))}
        audioDistributionType={settings.audioDistributionType || 'consistent'}
        onAudioDistributionTypeChange={(type) => onSettingsChange(prev => ({ ...prev, audioDistributionType: type }))}
        audioFirstPageImageCount={settings.audioFirstPageImageCount || ''}
        onAudioFirstPageImageCountChange={(count) => onSettingsChange(prev => ({ ...prev, audioFirstPageImageCount: count }))}
        audioRestImageCount={settings.audioRestImageCount || ''}
        onAudioRestImageCountChange={(count) => onSettingsChange(prev => ({ ...prev, audioRestImageCount: count }))}
        userId={userId || ''}
        useCharacterDescriptions={settings.useCharacterDescriptions}
      />

      {/* Validation Errors Display - Moved to be more prominent right after frequency configuration */}
      {Object.keys(validationErrors).length > 0 && (
        <div className="bg-status-warning border border-status-warning rounded-xl p-4 mt-4">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-5 h-5 text-status-warning flex-shrink-0 mt-0.5" />
            <div className="space-y-2">
              <p className="text-sm font-medium text-status-warning-text">Please fix the following issues:</p>
              {validationErrors.consistentFrequency && (
                <p className="text-sm text-status-warning-text">• {validationErrors.consistentFrequency}</p>
              )}
              {validationErrors.firstPageFrequency && (
                <p className="text-sm text-status-warning-text">• {validationErrors.firstPageFrequency}</p>
              )}
              {validationErrors.restFrequency && (
                <p className="text-sm text-status-warning-text">• {validationErrors.restFrequency}</p>
              )}
              {validationErrors.imageAmount && (
                <p className="text-sm text-status-warning-text">• {validationErrors.imageAmount}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Estimated Token Usage Display - MODIFIED TO HIDE DURING GENERATION */}
      {estimate && !isGenerating && (
        <div className="space-y-4">
          <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase">Combined Estimation</label>
          <div className="rounded-xl bg-surface-input p-4">
              <p className="text-sm text-text-secondary">
                Based on your settings, this will generate approximately:
              </p>
              <p className="text-xl font-semibold text-white mt-2">
                {estimate.totalImages} images
              </p>
              <div className="mt-3 space-y-2">
                <p className="text-sm text-text-secondary">
                  Image Prompts: {formatNumber(estimate.promptTokens)} tokens
                </p>
                <p className="text-sm text-text-secondary">
                  Images: {formatNumber(estimate.imageTokens)} tokens
                </p>
                <p className="text-lg font-semibold text-white">
                  Total: {formatNumber(estimate.totalTokens)} tokens
                </p>
                <p className="text-sm text-text-muted">
                  Required Storage: {estimate.storageNeeded} MB
                </p>
              </div>
              
              {estimate.totalTokens > userTokenBalance && (
                <div className="mt-3 bg-[--color-status-error-bg] border border-[--color-status-error-border] text-status-error p-3 rounded-xl">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-5 w-5 text-[--color-status-error-border]" />
                    <p className="text-sm">
                      You don't have enough tokens. Required: {formatNumber(estimate.totalTokens)}, Available: {formatNumber(userTokenBalance)}
                    </p>
                  </div>
                </div>
              )}
              
              {storageUsed !== null && estimate.storageNeeded > ((maxStorageGB * 1024) - storageUsed) && (
                <div className="mt-3 bg-[--color-status-error-bg] border border-[--color-status-error-border] text-status-error p-3 rounded-xl">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-5 w-5 text-[--color-status-error-border]" />
                    <p className="text-sm">
                      You don't have enough storage space. Required: {estimate.storageNeeded} MB, Available: {formatNumber((maxStorageGB * 1024) - storageUsed)} MB
                    </p>
                  </div>
                </div>
              )}
          </div>
        </div>
      )}
    </div>
  );
};

// 3. CombinedProgressDisplay Component
interface CombinedProgressDisplayProps {
  currentPhase: 'prompts' | 'images' | 'complete';
  imagePromptProgress: number;
  imageGenerationProgress: number;
  statusMessage: string;
  timeRemaining: number | null;
  onStop: () => void;
  showStuckWarning?: boolean;
}

export const CombinedProgressDisplay: React.FC<CombinedProgressDisplayProps> = ({
  currentPhase,
  imagePromptProgress,
  imageGenerationProgress,
  statusMessage,
  timeRemaining,
  onStop,
  showStuckWarning = false
}) => {
  return (
    <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-5 space-y-4">
      <div className="flex items-center space-x-3 text-text-secondary">
        <RefreshCw className="h-5 w-5 text-accent animate-pulse" />
        <span>{statusMessage}</span>
      </div>

      {/* Image Prompts Progress */}
      <div>
        <div className="flex justify-between text-sm text-text-secondary mb-2">
          <span>Image Prompts Progress</span>
          <span>{Math.round(imagePromptProgress)}%</span>
        </div>
        <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
          <div
            className="bg-accent h-2 rounded-full transition-all duration-500"
            style={{ width: `${imagePromptProgress}%` }}
          />
        </div>
      </div>

      {/* Image Generation Progress */}
      <div>
        <div className="flex justify-between text-sm text-text-secondary mb-2">
          <span>Image Generation Progress</span>
          <span>{Math.round(imageGenerationProgress)}%</span>
        </div>
        <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
          <div
            className="bg-accent h-2 rounded-full transition-all duration-500"
            style={{ width: `${imageGenerationProgress}%` }}
          />
        </div>
      </div>

      {timeRemaining !== null && (
        <>
          <p className="text-sm text-text-secondary">
            Estimated time remaining: {formatTime(timeRemaining)}
          </p>
          <p className="text-sm text-text-muted">
            If you're returning to the page, give it 30 seconds to correctly show the progress.
          </p>
          {showStuckWarning && (
            <p className="text-sm text-yellow-300/80">
              This part may take a little longer, but the progress is moving forward.
            </p>
          )}
        </>
      )}

      <div className="flex justify-end">
        <button
          onClick={onStop}
          className="flex items-center px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover"
        >
          <X className="h-5 w-5 mr-2" />
          Stop
        </button>
      </div>
    </div>
  );
};



