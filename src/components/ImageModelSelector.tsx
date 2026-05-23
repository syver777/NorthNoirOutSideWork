import React, { useState, useMemo } from 'react';
import { CheckCircle2, ChevronDown, Info } from 'lucide-react';
import { Listbox, Transition } from '@headlessui/react';
import {
  LEGACY_IMAGE_TOKENS_PER_IMAGE,
  NEW_IMAGE_TOKENS_PER_IMAGE,
} from '../data/tokenCosts';

interface ImageModelSelectorProps {
  selectedModel: string;
  selectedStyle: string;
  onModelChange: (model: string) => void;
  onStyleChange: (style: string) => void;
  disabled: boolean;
  /** Defaults to true (legacy plan rates) so unspecified callers stay safe. */
  isLegacy?: boolean;
}

// Style arrays for all models
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

// Model configuration - Reordered by price from cheapest to most expensive
const IMAGE_MODEL_OPTIONS = [
  {
    value: 'standard',
    label: 'Lite',
    backendValue: 'imagen-4-fast',
    tokensPerImage: 14000,
    description: 'Cheapest option',
    borderColor: 'border-blue-500',
    bgColor: 'bg-blue-900/40',
    textColor: 'text-blue-300'
  },
  {
    value: 'grok',
    label: 'Grok',
    backendValue: 'grok-imagine-image',
    tokensPerImage: 16000,
    description: 'Fast & affordable',
    borderColor: 'border-orange-500',
    bgColor: 'bg-orange-900/40',
    textColor: 'text-orange-300'
  },
  {
    value: 'plus',
    label: 'Core',
    backendValue: 'gpt-image-1-mini',
    tokensPerImage: 30000,
    description: 'Better quality',
    borderColor: 'border-green-500',
    bgColor: 'bg-green-900/40',
    textColor: 'text-green-300'
  },
  {
    value: 'prime',
    label: 'Prime',
    backendValue: 'seedream-4.5',
    tokensPerImage: 35000,
    description: 'High quality',
    recommended: true,
    borderColor: 'border-teal-500',
    bgColor: 'bg-teal-900/40',
    textColor: 'text-teal-300'
  },
  {
    value: 'premium',
    label: 'Heavy',
    backendValue: 'imagen-4-ultra',
    tokensPerImage: 42000,
    description: 'Highest quality',
    borderColor: 'border-purple-500',
    bgColor: 'bg-purple-900/40',
    textColor: 'text-purple-300'
  },
  {
    value: 'genesis',
    label: 'Genesis',
    backendValue: 'nano-banana-pro',
    tokensPerImage: 100000,
    description: 'Premium quality',
    borderColor: 'border-yellow-500',
    bgColor: 'bg-yellow-900/40',
    textColor: 'text-yellow-300'
  }
];

// Returns a plan-aware copy of IMAGE_MODEL_OPTIONS with tokensPerImage swapped
// in from the active plan map.
function buildImageModelOptions(isLegacy: boolean) {
  const m = isLegacy ? LEGACY_IMAGE_TOKENS_PER_IMAGE : NEW_IMAGE_TOKENS_PER_IMAGE;
  return IMAGE_MODEL_OPTIONS.map(opt => ({
    ...opt,
    tokensPerImage: m[opt.backendValue] ?? opt.tokensPerImage,
  }));
}

const ImageModelSelector: React.FC<ImageModelSelectorProps> = ({
  selectedModel,
  selectedStyle,
  onModelChange,
  onStyleChange,
  disabled,
  isLegacy = true,
}) => {
  const [showMoreStyles, setShowMoreStyles] = useState(false);
  // Plan-aware option list shadows the module-scope LEGACY default so the
  // displayed tokens/image matches what the backend will charge.
  const IMAGE_MODEL_OPTIONS = useMemo(() => buildImageModelOptions(isLegacy), [isLegacy]);

  // Get the current styles based on selected model
  const getCurrentStyles = () => {
    switch (selectedModel) {
      case 'flux-2-dev':
      case 'spark':
        return SPARK_STYLES;
      case 'grok-imagine-image':
      case 'grok':
        return GROK_STYLES;
      case 'imagen-4-fast':
      case 'standard':
        return STANDARD_STYLES;
      case 'gpt-image-1-mini':
      case 'plus':
        return PLUS_STYLES;
      case 'seedream-4.5':
      case 'prime':
        return PRIME_STYLES;
      case 'imagen-4-ultra':
      case 'premium':
        return PREMIUM_STYLES;
      case 'nano-banana-pro':
      case 'genesis':
        return GENESIS_STYLES;
      default:
        return PLUS_STYLES;
    }
  };

  const currentStyles = getCurrentStyles();

  // Helper function to check if the current style is a custom style
  const isCustomStyle = (style: string) => {
    const allPredefinedStyles = [...STANDARD_STYLES, ...PLUS_STYLES, ...PREMIUM_STYLES, ...SPARK_STYLES, ...GROK_STYLES, ...PRIME_STYLES, ...GENESIS_STYLES];
    return !allPredefinedStyles.some(predefinedStyle => predefinedStyle.style === style);
  };

  return (
    <div className="space-y-6">
      <div>
        <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3 block">Image Quality Model</label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          {IMAGE_MODEL_OPTIONS.map((model) => {
            const isSelected = selectedModel === model.backendValue || selectedModel === model.value;
            return (
            <button
              key={model.value}
              onClick={() => onModelChange(model.backendValue)}
              className={`relative p-3 rounded-xl border transition-all duration-200 text-left ${
                isSelected
                  ? `${model.borderColor} ${model.bgColor} ${model.textColor}`
                  : 'border-white/10 bg-surface-input text-text-muted hover:border-white/20 hover:text-white/80'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={disabled}
            >
              {model.recommended && (
                <div className="absolute -top-2 -right-2 bg-accent text-white text-[10px] font-mono tracking-wide px-2 py-0.5 rounded-full">
                  Recommended
                </div>
              )}
              <div className="font-medium text-sm">{model.label}</div>
              <div className="text-xs opacity-75 mt-0.5">{model.tokensPerImage.toLocaleString()} tokens / image</div>
              <div className="text-xs opacity-60 mt-0.5">{model.description}</div>
            </button>
            );
          })}
        </div>
        <div className="rounded-xl bg-surface-card border border-border-card p-4 mb-4">
          <div className="flex items-start space-x-2">
            <Info className="h-5 w-5 text-text-muted mt-0.5 flex-shrink-0" />
            <div className="text-sm text-text-muted">
              <p>The image styles below show how images will look for the {IMAGE_MODEL_OPTIONS.find(m => m.backendValue === selectedModel || m.value === selectedModel)?.label || selectedModel} model. Each model produces different quality and style variations.</p>
              {isCustomStyle(selectedStyle) && (
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
              className={`relative bg-surface-card rounded-xl overflow-hidden transition-all duration-200 border-2 ${
                disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
              } ${
                selectedStyle === style.style ? 'border-red-500' : 'border-border-card hover:border-white/20'
              }`}
              onClick={() => !disabled && onStyleChange(style.style)}
            >
              <div className="aspect-video w-full">
                <img src={style.image} alt={`${style.name} Example`} className="w-full h-full object-cover" />
              </div>
              <div className="p-4">
                <h3 className="text-lg font-medium text-white mb-1">{style.name}</h3>
                <p className="text-sm text-text-muted">{style.description}</p>
              </div>
              {selectedStyle === style.style && (
                <div className="absolute top-2 right-2 bg-red-500 text-white rounded-full p-1">
                  <CheckCircle2 className="h-5 w-5" />
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-center mt-4">
          <button
            onClick={() => setShowMoreStyles(!showMoreStyles)}
            className={`px-4 py-2 bg-surface-card text-text-secondary rounded-xl hover:bg-surface-input border border-border-card transition-colors ${
              disabled ? 'opacity-50 cursor-not-allowed' : ''
            }`}
            disabled={disabled}
          >
            {showMoreStyles ? 'Show Less' : 'Show More +12'}
          </button>
        </div>

        <div className="mt-6">
          <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">Custom Style</label>
            <textarea
              value={selectedStyle !== currentStyles.find(s => s.style === selectedStyle)?.style ? selectedStyle : ''}
              onChange={(e) => onStyleChange(e.target.value.slice(0, 1200))}
              className={`block w-full px-5 py-4 rounded-xl bg-surface-input border border-white/[0.13] text-white/90 placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out resize-none ${
                disabled ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              rows={6}
              maxLength={1200}
              placeholder="Describe your custom image style..."
              disabled={disabled}
            />
            <div className="mt-1 text-xs text-text-muted text-right">
              {(selectedStyle !== currentStyles.find(s => s.style === selectedStyle)?.style ? selectedStyle : '').length} / 1200
            </div>
            {isCustomStyle(selectedStyle) && (
              <div className="mt-1 text-sm text-yellow-400">
                Custom styles can use all image models.
              </div>
            )}
        </div>
      </div>
    </div>
  );
};

export default ImageModelSelector;



