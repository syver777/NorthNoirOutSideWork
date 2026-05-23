import React, { useState } from 'react';
import { 
  FileText, 
  Volume2, 
  Info, 
  AlertCircle,
  AlertTriangle,
  ChevronDown, 
  Calendar, 
  CheckCircle2, 
  Upload,
  RefreshCw, 
  X, 
  Lock,
  Film,
  Trash2
} from 'lucide-react';
import { Listbox, Transition } from '@headlessui/react';
import { estimateTimeRemaining } from '../utils/tusUpload';
import { isValidNumericInput } from '../utils/shared';
import MasterPrompt from './MasterPrompt';
import VoiceSelector from '../components/VoiceSelector';
import VisualConfiguration from './VisualConfiguration';

// Model options
const modelOptions = [
  { 
    value: 'deepseek', 
    label: 'Core Model', 
    tokenMultiplier: 1,
    maxWords: 50000,
    maxWordsPerBatch: 1100,
    description: '1x tokens'
  },
  { 
    value: 'sonnet', 
    label: 'Claude Sonnet 4.6', 
    tokenMultiplier: 11,
    maxWords: 150000,
    maxWordsPerBatch: 3000,
    description: '11x tokens'
  },
  { 
    value: 'opus', 
    label: 'Claude Opus 4.6', 
    tokenMultiplier: 19,
    maxWords: 150000,
    maxWordsPerBatch: 3000,
    description: '19x tokens'
  },
];

interface VideoMetadata {
  duration: number; // in seconds
  size: number; // in bytes
  bitrate?: number;
  width?: number;
  height?: number;
}

// Spark styles (flux-2-dev - lowest tier)
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

// Grok styles (grok-imagine-image)
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

// Premium styles (Heavy Model)
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
    image: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/gptMini/Ink_&_Wash.jpg',
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

interface ConfigurationStepsProps {
  settings: any;
  setSettings: (settings: any) => void;
  settingsLocked: boolean;
  collapsedSteps: Record<number, boolean>;
  setCollapsedSteps: (steps: Record<number, boolean>) => void;
  documents: any[];
  imageFolders: any[];
  audioFiles: any[];
  validationErrors: any;
  wordCountError: string | null;
  speedError: string;
  volumeError: string;
  selectedCloneLanguage: string;
  setSelectedCloneLanguage: (lang: string) => void;
  speedInput: string;
  volumeInput: string;
  setSpeedInput: (input: string) => void;
  setVolumeInput: (input: string) => void;
  showMoreStyles: boolean;
  setShowMoreStyles: (show: boolean) => void;
  showMorePremiumVoices: boolean;
  setShowMorePremiumVoices: (show: boolean) => void;
  showMoreCoreVoices: boolean;
  setShowMoreCoreVoices: (show: boolean) => void;
  showMoreApexVoices: boolean;
  setShowMoreApexVoices: (show: boolean) => void;
  playingVoice: string | null;
  userPlan: string;
  currentStyles: any[];
  premiumVoices: any[];
  coreVoices: any[];
  apexVoices: any[];
  handleFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handleVideoFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handleAudioFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handlePlayVoiceSample: (voice: string) => void;
  handleSpeedInputChange: (value: string) => void;
  handleVolumeInputChange: (value: string) => void;
  validateSpeed: (value: string) => boolean;
  validateVolume: (value: string) => boolean;
  isCustomStyle: (style: string) => boolean;
  formatDate: (dateString: string) => string;
  getImageFoldersForSelectedStory: () => any[];
  getImagePromptDocsForSelectedStory: () => any[];
  getAudioFilesForSelectedStory: () => any[];
  isStepConfigured: (stepNumber: number) => boolean;
  canCollapseStep: (stepNumber: number) => boolean;
  toggleStepCollapse: (stepNumber: number) => void;
  uploadedVideoLoopFile: File | null;
  setUploadedVideoLoopFile: (file: File | null) => void;
  uploadingVideoLoop: boolean;
  uploadedFile: File | null;
  setUploadedFile: (file: File | null) => void;
  uploadedDocId: string | null;
  uploadedAudioFile: File | null;
  setUploadedAudioFile: (file: File | null) => void;
  uploadedAudioDocId: string | null;
  languageOptions: any[];
  selectedApexLanguage: string;
  setSelectedApexLanguage: (lang: string) => void;
  apexLanguages: string[];
  getFilteredApexVoices: () => any[];
  isApexVoice: (voice: string) => boolean;
  setVideoLoopUrl?: (url: string) => void;
  // NEW: Add progress tracking props
  videoUploadProgress: number;
  audioUploadProgress: number;
  videoUploadStartTime: number;
  audioUploadStartTime: number;
  // NEW: Add upload language props
  uploadLanguage: string;
  setUploadLanguage: (lang: string) => void;
  uploadLanguageError?: string | null;
  // NEW: Add existing audio volume props
  existingAudioVolumeInput: string;
  setExistingAudioVolumeInput: (input: string) => void;
  existingAudioVolumeError: string;
  handleExistingAudioVolumeInputChange: (value: string) => void;
  validateExistingAudioVolume: (value: string) => boolean;
  // NEW: Add background music volume props
  backgroundMusicVolumeInput: string;
  setBackgroundMusicVolumeInput: (input: string) => void;
  backgroundMusicVolumeError: string;
  handleBackgroundMusicVolumeInputChange: (value: string) => void;
  validateBackgroundMusicVolume: (value: string) => boolean;
  modelOptions: any[];
  selectedModel: any;
  // NEW: Add voiceSamples prop
  voiceSamples: Record<string, string>;
  // NEW: Voice selector props
  voiceSelectorRef: React.RefObject<{ clearUploadSection: () => void } | null>;
  onCloneVoiceCreated: (voiceId: string, filePath: string) => void;
  onVoiceSelect: (voice: string) => void;
  currentUserId: string | null;
  // ElevenLabs voice support (optional — when omitted, the ElevenLabs tier is hidden)
  elevenLabsSelectedLabel?: string | null;
  elevenLabsCurrentVoiceId?: string;
  elevenLabsModelId?: string;
  onSelectElevenLabsVoice?: (voice: import('./ElevenLabsVoiceBrowser').SelectedElevenLabsVoice) => void;
  onElevenLabsModelChange?: (modelId: string) => void;
  // NEW: Runtime mode props
  isRuntimeMode: boolean;
  setIsRuntimeMode: (mode: boolean) => void;
  runtimeMinutes: string;
  setRuntimeMinutes: (minutes: string) => void;
  minutesToWordCount: (minutes: number) => number;
  wordCountToMinutes: (wordCount: number) => number;
  getMinuteLimitsForModel: (model: string) => { min: number; max: number };
  // NEW: Master prompt props
  masterPromptEnabled: boolean;
  setMasterPromptEnabled: (enabled: boolean) => void;
  masterPromptEnhanceAI: boolean;
  setMasterPromptEnhanceAI: (enabled: boolean) => void;
  masterPromptData: {
    visualStyle: string;
    setting: string;
    atmosphere: string;
    environmentOnly: boolean;
    characters: Array<{ name: string; description: string }>;
  } | null;
  setMasterPromptData: (data: any) => void;
  // NEW: Pause TTS props
  pauseTTS: boolean;
  setPauseTTS: (enabled: boolean) => void;
  // NEW: Audio duration calculation props
  calculatedAudioDuration?: number;
  setCalculatedAudioDuration?: (duration: number) => void;
  audioDurationLoading?: boolean;
  audioDurationError?: string | null;
  isCalculatingDuration?: boolean;
  handleCalculateAudioDuration?: (audioDocId?: string, audioSource?: 'generate' | 'existing' | 'upload', wordCount?: number) => Promise<number | undefined>;
  // NEW: Frequency configuration props
  frequencyMode: 'wordcount' | 'audio';
  setFrequencyMode: (mode: 'wordcount' | 'audio') => void;
  frequencyType: 'consistent' | 'variable';
  setFrequencyType: (type: 'consistent' | 'variable') => void;
  consistentFrequency: string;
  setConsistentFrequency: (value: string) => void;
  audioDistributionType: 'consistent' | 'variable';
  setAudioDistributionType: (type: 'consistent' | 'variable') => void;
  firstPageImageAmount: string;
  setFirstPageImageAmount: (amount: string) => void;
  restImageAmount: string;
  setRestImageAmount: (amount: string) => void;
  totalAudioDuration: string;
  setTotalAudioDuration: (duration: string) => void;
  imageAmount: string;
  setImageAmount: (amount: string) => void;
  uploadedAudioFiles: any[];
  setUploadedAudioFiles: (files: any[]) => void;
  selectedStoryGroupId: string;
  setSelectedStoryGroupId: (groupId: string) => void;
  selectedStoryTitle: string;
  setSelectedStoryTitle: (title: string) => void;
  storySource: 'new' | 'existing' | 'upload';
  setStorySource: (source: 'new' | 'existing' | 'upload') => void;
  // NEW: Visual Configuration props
  visualType?: string;
  onVisualTypeChange?: (type: string) => void;
  ttvModel?: string;
  ttvStyle?: string;
  ttvDuration?: number;
  ttvAudioClip?: boolean;
  onTTVModelChange?: (model: string) => void;
  onTTVStyleChange?: (style: string) => void;
  onTTVDurationChange?: (duration: number) => void;
  onTTVAudioClipChange?: (enabled: boolean) => void;
  itvModel?: string;
  itvDuration?: number;
  itvAudioClip?: boolean;
  onITVModelChange?: (model: string) => void;
  onITVDurationChange?: (duration: number) => void;
  onITVAudioClipChange?: (enabled: boolean) => void;
  getTTVFoldersForSelectedStory?: () => any[];
  getTTVPromptDocsForSelectedStory?: () => any[];
  getITVVideoFoldersForSelectedStory?: () => any[];
  getITVVideoPromptDocsForSelectedStory?: () => any[];
  getITVImageFoldersForSelectedStory?: () => any[];
  getITVImagePromptDocsForSelectedStory?: () => any[];
  getMGPromptDocsForSelectedStory?: () => any[];
  getMGVideoFoldersForSelectedStory?: () => any[];
  // Custom Characters props
  customCharactersEnabled: boolean;
  setCustomCharactersEnabled: (enabled: boolean) => void;
  customCharacters: Array<{ name: string; description: string }>;
  setCustomCharacters: (characters: Array<{ name: string; description: string }>) => void;
  customCharactersAIEnhance: boolean;
  setCustomCharactersAIEnhance: (enabled: boolean) => void;
  // YouTube Inspiration props
  youtubeInspirationEnabled: boolean;
  setYoutubeInspirationEnabled: (enabled: boolean) => void;
  youtubeLinks: string[];
  setYoutubeLinks: (links: string[]) => void;
  youtubeLinkErrors: Record<number, string>;
  setYoutubeLinkErrors: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  validateYoutubeUrl: (url: string) => string | null;
  extractYoutubeVideoId: (url: string) => string | null;
  // Token balance and storage for estimates
  userTokenBalance?: number;
  storageUsed?: number | null;
  maxStorageGB?: number;
}

// Utility function to extract video metadata
const getVideoMetadata = (file: File): Promise<VideoMetadata> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    
    video.onloadedmetadata = () => {
      resolve({
        duration: video.duration,
        size: file.size,
        width: video.videoWidth,
        height: video.videoHeight,
        // Estimate bitrate: file_size_bits / duration
        bitrate: video.duration > 0 ? (file.size * 8) / video.duration : undefined
      });
      
      // Clean up
      URL.revokeObjectURL(video.src);
    };
    
    video.onerror = () => {
      URL.revokeObjectURL(video.src);
      reject(new Error('Failed to load video metadata'));
    };
    
    video.src = URL.createObjectURL(file);
  });
};

// Format duration in seconds to readable format
const formatDuration = (seconds: number): string => {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
};

// Get current styles based on selected model
const getCurrentStyles = (imageModel: string) => {
  switch (imageModel) {
    case 'flux-2-dev':
      return SPARK_STYLES;
    case 'imagen-4-fast':
      return STANDARD_STYLES;
    case 'grok-imagine-image':
      return GROK_STYLES;
    case 'gpt-image-1-mini':
      return PLUS_STYLES;
    case 'seedream-4.5':
      return PRIME_STYLES;
    case 'imagen-4-ultra':
      return PREMIUM_STYLES;
    case 'nano-banana-pro':
      return GENESIS_STYLES;
    default:
      return STANDARD_STYLES;
  }
};

export default function ConfigurationSteps({
  settings,
  setSettings,
  settingsLocked,
  collapsedSteps,
  setCollapsedSteps,
  documents,
  imageFolders,
  audioFiles,
  validationErrors,
  wordCountError,
  speedError,
  volumeError,
  selectedCloneLanguage,
  setSelectedCloneLanguage,
  speedInput,
  volumeInput,
  setSpeedInput,
  setVolumeInput,
  showMoreStyles,
  setShowMoreStyles,
  showMorePremiumVoices,
  setShowMorePremiumVoices,
  showMoreCoreVoices,
  setShowMoreCoreVoices,
  showMoreApexVoices,
  setShowMoreApexVoices,
  playingVoice,
  userPlan,
  handleFileUpload,
  handleVideoFileUpload,
  handleAudioFileUpload,
  handlePlayVoiceSample,
  handleSpeedInputChange,
  handleVolumeInputChange,
  validateSpeed,
  validateVolume,
  isCustomStyle,
  formatDate,
  getImageFoldersForSelectedStory,
  getImagePromptDocsForSelectedStory,
  getAudioFilesForSelectedStory,
  isStepConfigured,
  canCollapseStep,
  toggleStepCollapse,
  uploadedVideoLoopFile,
  setUploadedVideoLoopFile,
  uploadingVideoLoop,
  uploadedFile,
  setUploadedFile,
  uploadedDocId,
  uploadedAudioFile,
  setUploadedAudioFile,
  uploadedAudioDocId,
  languageOptions,
  selectedApexLanguage,
  setSelectedApexLanguage,
  apexLanguages,
  isApexVoice,
  setVideoLoopUrl,
  videoUploadProgress,
  audioUploadProgress,
  videoUploadStartTime,
  audioUploadStartTime,
  uploadLanguage,
  setUploadLanguage,
  uploadLanguageError,
  existingAudioVolumeInput,
  setExistingAudioVolumeInput,
  existingAudioVolumeError,
  handleExistingAudioVolumeInputChange,
  validateExistingAudioVolume,
  backgroundMusicVolumeInput,
  setBackgroundMusicVolumeInput,
  backgroundMusicVolumeError,
  handleBackgroundMusicVolumeInputChange,
  validateBackgroundMusicVolume,
  modelOptions,
  selectedModel,
  voiceSamples,
  voiceSelectorRef,
  onCloneVoiceCreated,
  onVoiceSelect,
  currentUserId,
  elevenLabsSelectedLabel,
  elevenLabsCurrentVoiceId,
  elevenLabsModelId,
  onSelectElevenLabsVoice,
  onElevenLabsModelChange,
  isRuntimeMode,
  setIsRuntimeMode,
  runtimeMinutes,
  setRuntimeMinutes,
  minutesToWordCount,
  wordCountToMinutes,
  getMinuteLimitsForModel,
  masterPromptEnabled,
  setMasterPromptEnabled,
  masterPromptEnhanceAI,
  setMasterPromptEnhanceAI,
  masterPromptData,
  setMasterPromptData,
  // NEW: Pause TTS props
  pauseTTS,
  setPauseTTS,
  // NEW: Frequency configuration props
  frequencyMode,
  setFrequencyMode,
  frequencyType,
  setFrequencyType,
  consistentFrequency,
  setConsistentFrequency,
  audioDistributionType,
  setAudioDistributionType,
  firstPageImageAmount,
  setFirstPageImageAmount,
  restImageAmount,
  setRestImageAmount,
  totalAudioDuration,
  setTotalAudioDuration,
  imageAmount,
  setImageAmount,
  uploadedAudioFiles,
  setUploadedAudioFiles,
  selectedStoryGroupId,
  setSelectedStoryGroupId,
  selectedStoryTitle,
  setSelectedStoryTitle,
  storySource,
  setStorySource,
  // NEW: Audio duration calculation props
  calculatedAudioDuration,
  setCalculatedAudioDuration,
  audioDurationLoading,
  audioDurationError,
  isCalculatingDuration,
  handleCalculateAudioDuration,
  // NEW: Visual Configuration props
  visualType,
  onVisualTypeChange,
  ttvModel,
  ttvStyle,
  ttvDuration,
  ttvAudioClip,
  onTTVModelChange,
  onTTVStyleChange,
  onTTVDurationChange,
  onTTVAudioClipChange,
  itvModel,
  itvDuration,
  itvAudioClip,
  onITVModelChange,
  onITVDurationChange,
  onITVAudioClipChange,
  getTTVFoldersForSelectedStory,
  getTTVPromptDocsForSelectedStory,
  getITVVideoFoldersForSelectedStory,
  getITVVideoPromptDocsForSelectedStory,
  getITVImageFoldersForSelectedStory,
  getITVImagePromptDocsForSelectedStory,
  getMGPromptDocsForSelectedStory,
  getMGVideoFoldersForSelectedStory,
  // Custom Characters props
  customCharactersEnabled,
  setCustomCharactersEnabled,
  customCharacters,
  setCustomCharacters,
  customCharactersAIEnhance,
  setCustomCharactersAIEnhance,
  // YouTube Inspiration props
  youtubeInspirationEnabled,
  setYoutubeInspirationEnabled,
  youtubeLinks,
  setYoutubeLinks,
  youtubeLinkErrors,
  setYoutubeLinkErrors,
  validateYoutubeUrl,
  extractYoutubeVideoId,
  userTokenBalance,
  storageUsed,
  maxStorageGB,
}: ConfigurationStepsProps) {
  const isPremiumPlan = ['premium', 'pro', 'elite', 'ultimate', 'enterprise'].includes(userPlan);
  const isStandardPlan = ['standard', 'plus'].includes(userPlan);

  // Audio upload loading state
  const [uploadingAudio, setUploadingAudio] = useState(false);

  // NEW: Video metadata state
  const [uploadedVideoMetadata, setUploadedVideoMetadata] = useState<VideoMetadata | null>(null);

  // Enhanced audio file upload handler with loading states
  const handleAudioFileUploadWithLoading = async (event: React.ChangeEvent<HTMLInputElement>) => {
    setUploadingAudio(true);
    try {
      await handleAudioFileUpload(event);
    } finally {
      setUploadingAudio(false);
    }
  };

  // NEW: Enhanced video file upload handler with metadata extraction
  const handleVideoFileUploadWithMetadata = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      // Extract video metadata before upload
      console.log('Extracting video metadata...');
      const metadata = await getVideoMetadata(file);
      console.log('Video metadata extracted:', metadata);

      // Store metadata
      setUploadedVideoMetadata(metadata);

      // Call the original handler which handles the upload
      await handleVideoFileUpload(event);

      // Update settings with metadata after successful upload
      setSettings(prev => ({
        ...prev,
        videoLoopMetadata: metadata
      }));

    } catch (error: any) {
      console.error('Error processing video file:', error);
      // If metadata extraction fails, still try to upload
      // but warn the user that estimates might be less accurate
      console.warn('Proceeding with upload without metadata - estimates may be less accurate');
      await handleVideoFileUpload(event);
    }
  };

  // Get current styles based on image model
  const currentStyles = getCurrentStyles(settings.imageModel);

  return (
    <div className="space-y-6 dash-stagger">
      {/* Step 1: Story Configuration */}
      <StoryConfigurationStep
        settings={settings}
        setSettings={setSettings}
        settingsLocked={settingsLocked}
        collapsedSteps={collapsedSteps}
        documents={documents}
        wordCountError={wordCountError}
        handleFileUpload={handleFileUpload}
        formatDate={formatDate}
        isStepConfigured={isStepConfigured}
        toggleStepCollapse={toggleStepCollapse}
        uploadedFile={uploadedFile}
        setUploadedFile={setUploadedFile}
        uploadedDocId={uploadedDocId}
        languageOptions={languageOptions}
        modelOptions={modelOptions}
        selectedModel={selectedModel}
        uploadLanguage={uploadLanguage}
        setUploadLanguage={setUploadLanguage}
        uploadLanguageError={uploadLanguageError}
        isRuntimeMode={isRuntimeMode}
        setIsRuntimeMode={setIsRuntimeMode}
        runtimeMinutes={runtimeMinutes}
        setRuntimeMinutes={setRuntimeMinutes}
        minutesToWordCount={minutesToWordCount}
        wordCountToMinutes={wordCountToMinutes}
        getMinuteLimitsForModel={getMinuteLimitsForModel}
        masterPromptEnabled={masterPromptEnabled}
        setMasterPromptEnabled={setMasterPromptEnabled}
        masterPromptEnhanceAI={masterPromptEnhanceAI}
        setMasterPromptEnhanceAI={setMasterPromptEnhanceAI}
        masterPromptData={masterPromptData}
        setMasterPromptData={setMasterPromptData}
        pauseTTS={pauseTTS}
        setPauseTTS={setPauseTTS}
        youtubeInspirationEnabled={youtubeInspirationEnabled}
        setYoutubeInspirationEnabled={setYoutubeInspirationEnabled}
        youtubeLinks={youtubeLinks}
        setYoutubeLinks={setYoutubeLinks}
        youtubeLinkErrors={youtubeLinkErrors}
        setYoutubeLinkErrors={setYoutubeLinkErrors}
        validateYoutubeUrl={validateYoutubeUrl}
        extractYoutubeVideoId={extractYoutubeVideoId}
      />

      {/* Step 2: Audio Configuration */}
      <AudioConfigurationStep
        settings={settings}
        setSettings={setSettings}
        settingsLocked={settingsLocked}
        collapsedSteps={collapsedSteps}
        audioFiles={audioFiles}
        speedError={speedError}
        volumeError={volumeError}
        speedInput={speedInput}
        volumeInput={volumeInput}
        setVolumeInput={setVolumeInput}
        setSpeedInput={setSpeedInput}
        playingVoice={playingVoice}
        isPremiumPlan={isPremiumPlan}
        isStandardPlan={isStandardPlan}
        handleAudioFileUpload={handleAudioFileUploadWithLoading}
        handlePlayVoiceSample={handlePlayVoiceSample}
        handleSpeedInputChange={handleSpeedInputChange}
        handleVolumeInputChange={handleVolumeInputChange}
        formatDate={formatDate}
        getAudioFilesForSelectedStory={getAudioFilesForSelectedStory}
        isStepConfigured={isStepConfigured}
        toggleStepCollapse={toggleStepCollapse}
        uploadedAudioFile={uploadedAudioFile}
        setUploadedAudioFile={setUploadedAudioFile}
        uploadedAudioDocId={uploadedAudioDocId}
        uploadingAudio={uploadingAudio}
        documents={documents}
        existingAudioVolumeInput={existingAudioVolumeInput}
        existingAudioVolumeError={existingAudioVolumeError}
        handleExistingAudioVolumeInputChange={handleExistingAudioVolumeInputChange}
        validateExistingAudioVolume={validateExistingAudioVolume}
        backgroundMusicVolumeInput={backgroundMusicVolumeInput}
        backgroundMusicVolumeError={backgroundMusicVolumeError}
        handleBackgroundMusicVolumeInputChange={handleBackgroundMusicVolumeInputChange}
        validateBackgroundMusicVolume={validateBackgroundMusicVolume}
        validateSpeed={validateSpeed}
        validateVolume={validateVolume}
        audioUploadProgress={audioUploadProgress}
        audioUploadStartTime={audioUploadStartTime}
        voiceSamples={voiceSamples}
        voiceSelectorRef={voiceSelectorRef}
        onCloneVoiceCreated={onCloneVoiceCreated}
        onVoiceSelect={onVoiceSelect}
        currentUserId={currentUserId}
        elevenLabsSelectedLabel={elevenLabsSelectedLabel}
        elevenLabsCurrentVoiceId={elevenLabsCurrentVoiceId}
        elevenLabsModelId={elevenLabsModelId}
        onSelectElevenLabsVoice={onSelectElevenLabsVoice}
        onElevenLabsModelChange={onElevenLabsModelChange}
        userPlan={userPlan}
        selectedApexLanguage={selectedApexLanguage}
        setSelectedApexLanguage={setSelectedApexLanguage}
        languageOptions={languageOptions}
        calculatedAudioDuration={calculatedAudioDuration}
        setCalculatedAudioDuration={setCalculatedAudioDuration}
        audioDurationLoading={audioDurationLoading}
        audioDurationError={audioDurationError}
        isCalculatingDuration={isCalculatingDuration}
        handleCalculateAudioDuration={handleCalculateAudioDuration}
        pauseTTS={pauseTTS}
      />

      {/* Step 3: Visual Configuration */}
      <div className={`bg-surface-card rounded-lg overflow-visible relative z-10 ${settingsLocked ? 'opacity-60' : ''}`}>
        <div 
          className="flex items-center justify-between p-6 cursor-pointer"
          onClick={() => !settingsLocked && toggleStepCollapse(3)}
        >
          <div className="flex items-center">
            <Film className="h-5 w-5 text-red-700 mr-2" />
            <h2 className="text-lg sm:text-xl font-semibold text-white">Step 3: Visual Configuration</h2>
            {settingsLocked && <Lock className="h-4 w-4 text-text-dim ml-2" />}
          </div>
          <div className="flex items-center space-x-2">
            {isStepConfigured(3) && (
              <span className="text-sm text-status-success">Configured</span>
            )}
            {!settingsLocked && (
              <ChevronDown className={`h-5 w-5 text-text-dim transition-transform duration-200 ${collapsedSteps[3] ? 'rotate-180' : ''}`} />
            )}
          </div>
        </div>

        {!collapsedSteps[3] && (
          <div className="px-6 pb-6 space-y-4 overflow-visible">
            <VisualConfiguration
              settings={settings}
              setSettings={setSettings}
              settingsLocked={settingsLocked}
              visualType={visualType}
              onVisualTypeChange={onVisualTypeChange}
              ttvModel={ttvModel}
              ttvStyle={ttvStyle}
              ttvDuration={ttvDuration}
              ttvAudioClip={ttvAudioClip}
              onTTVModelChange={onTTVModelChange}
              onTTVStyleChange={onTTVStyleChange}
              onTTVDurationChange={onTTVDurationChange}
              onTTVAudioClipChange={onTTVAudioClipChange}
              itvModel={itvModel}
              itvDuration={itvDuration}
              itvAudioClip={itvAudioClip}
              onITVModelChange={onITVModelChange}
              onITVDurationChange={onITVDurationChange}
              onITVAudioClipChange={onITVAudioClipChange}
              imageFolders={imageFolders}
              documents={documents}
              uploadedFile={uploadedFile}
              showMoreStyles={showMoreStyles}
              setShowMoreStyles={setShowMoreStyles}
              currentStyles={currentStyles}
              isCustomStyle={isCustomStyle}
              validationErrors={validationErrors}
              languageOptions={languageOptions}
              modelOptions={modelOptions}
              getImageFoldersForSelectedStory={getImageFoldersForSelectedStory}
              getImagePromptDocsForSelectedStory={getImagePromptDocsForSelectedStory}
              getTTVFoldersForSelectedStory={getTTVFoldersForSelectedStory}
              getTTVPromptDocsForSelectedStory={getTTVPromptDocsForSelectedStory}
              getITVVideoFoldersForSelectedStory={getITVVideoFoldersForSelectedStory}
              getITVVideoPromptDocsForSelectedStory={getITVVideoPromptDocsForSelectedStory}
              getITVImageFoldersForSelectedStory={getITVImageFoldersForSelectedStory}
              getITVImagePromptDocsForSelectedStory={getITVImagePromptDocsForSelectedStory}
              getMGPromptDocsForSelectedStory={getMGPromptDocsForSelectedStory}
              getMGVideoFoldersForSelectedStory={getMGVideoFoldersForSelectedStory}
              handleVideoFileUpload={handleVideoFileUploadWithMetadata}
              uploadingVideoLoop={uploadingVideoLoop}
              uploadedVideoLoopFile={uploadedVideoLoopFile}
              setUploadedVideoLoopFile={setUploadedVideoLoopFile}
              setVideoLoopUrl={setVideoLoopUrl}
              uploadedVideoMetadata={uploadedVideoMetadata}
              setUploadedVideoMetadata={setUploadedVideoMetadata}
              videoUploadProgress={videoUploadProgress}
              videoUploadStartTime={videoUploadStartTime}
              frequencyMode={frequencyMode}
              setFrequencyMode={setFrequencyMode}
              frequencyType={frequencyType}
              setFrequencyType={setFrequencyType}
              consistentFrequency={consistentFrequency}
              setConsistentFrequency={setConsistentFrequency}
              audioDistributionType={audioDistributionType}
              setAudioDistributionType={setAudioDistributionType}
              firstPageImageAmount={firstPageImageAmount}
              setFirstPageImageAmount={setFirstPageImageAmount}
              restImageAmount={restImageAmount}
              setRestImageAmount={setRestImageAmount}
              totalAudioDuration={totalAudioDuration}
              setTotalAudioDuration={setTotalAudioDuration}
              imageAmount={imageAmount}
              setImageAmount={setImageAmount}
              uploadedAudioFiles={uploadedAudioFiles}
              setUploadedAudioFiles={setUploadedAudioFiles}
              selectedStoryGroupId={selectedStoryGroupId}
              selectedStoryTitle={selectedStoryTitle}
              storySource={storySource}
              currentUserId={currentUserId}
              useCharacterDescriptions={settings.useCharacterDescriptions}
              customCharactersEnabled={customCharactersEnabled}
              setCustomCharactersEnabled={setCustomCharactersEnabled}
              customCharacters={customCharacters}
              setCustomCharacters={setCustomCharacters}
              customCharactersAIEnhance={customCharactersAIEnhance}
              setCustomCharactersAIEnhance={setCustomCharactersAIEnhance}
              getAudioFilesForSelectedStory={getAudioFilesForSelectedStory}
              calculatedAudioDuration={calculatedAudioDuration}
              setCalculatedAudioDuration={setCalculatedAudioDuration}
              audioDurationLoading={audioDurationLoading}
              audioDurationError={audioDurationError}
              isCalculatingDuration={isCalculatingDuration}
              handleCalculateAudioDuration={handleCalculateAudioDuration}
              formatDate={formatDate}
              isStepConfigured={isStepConfigured}
              userTokenBalance={userTokenBalance}
              storageUsed={storageUsed}
              maxStorageGB={maxStorageGB}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// Story Configuration Step Component
function StoryConfigurationStep({
  settings,
  setSettings,
  settingsLocked,
  collapsedSteps,
  documents,
  wordCountError,
  handleFileUpload,
  formatDate,
  isStepConfigured,
  toggleStepCollapse,
  uploadedFile,
  setUploadedFile,
  uploadedDocId,
  languageOptions,
  modelOptions,
  selectedModel,
  uploadLanguage,
  setUploadLanguage,
  uploadLanguageError,
  isRuntimeMode,
  setIsRuntimeMode,
  runtimeMinutes,
  setRuntimeMinutes,
  minutesToWordCount,
  wordCountToMinutes,
  getMinuteLimitsForModel,
  masterPromptEnabled,
  setMasterPromptEnabled,
  masterPromptEnhanceAI,
  setMasterPromptEnhanceAI,
  masterPromptData,
  setMasterPromptData,
  pauseTTS,
  setPauseTTS,
  youtubeInspirationEnabled,
  setYoutubeInspirationEnabled,
  youtubeLinks,
  setYoutubeLinks,
  youtubeLinkErrors,
  setYoutubeLinkErrors,
  validateYoutubeUrl,
  extractYoutubeVideoId,
}: any) {
  return (
    <div className={`bg-surface-card rounded-lg overflow-visible relative z-20 ${settingsLocked ? 'opacity-60' : ''}`}>
      <div 
        className="flex items-center justify-between p-6 cursor-pointer"
        onClick={() => !settingsLocked && toggleStepCollapse(1)}
      >
        <div className="flex items-center">
          <FileText className="h-5 w-5 text-red-700 mr-2" />
          <h2 className="text-lg sm:text-xl font-semibold text-white">Step 1: Story Configuration</h2>
          {settingsLocked && <Lock className="h-4 w-4 text-text-dim ml-2" />}
        </div>
        <div className="flex items-center space-x-2">
          {isStepConfigured(1) && (
            <span className="text-sm text-status-success">Configured</span>
          )}
          {!settingsLocked && (
            <ChevronDown className={`h-5 w-5 text-text-dim transition-transform duration-200 ${collapsedSteps[1] ? 'rotate-180' : ''}`} />
          )}
        </div>
      </div>

      {!collapsedSteps[1] && (
        <div className="px-6 pb-6 space-y-4 overflow-visible">
          <div>
            <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Story Source</label>
            <div className="grid grid-cols-3 gap-4">
              <button
                onClick={() => !settingsLocked && setSettings({...settings, storySource: 'new', uploadedFile: null, selectedStoryDoc: '', audioSource: 'generate'})}
                disabled={settingsLocked}
                className={`p-4 rounded-lg border-2 transition-all ${
                  settings.storySource === 'new' 
                    ? 'border-red-800/70 bg-red-900/30 text-white' 
                    : 'border-border bg-surface-elevated text-text-muted hover:border-border-subtle'
                } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                <div className="text-left">
                  <div className="font-medium text-sm sm:text-base">Create New Story</div>
                  <div className="text-xs sm:text-sm opacity-75 mt-1">Generate a new story from scratch</div>
                </div>
              </button>
              <button
                onClick={() => !settingsLocked && setSettings({...settings, storySource: 'existing', uploadedFile: null, ...(settings.audioSource === 'upload' ? { audioSource: 'generate' } : {})})}
                disabled={settingsLocked}
                className={`p-4 rounded-lg border-2 transition-all ${
                  settings.storySource === 'existing' 
                    ? 'border-red-800/70 bg-red-900/30 text-white' 
                    : 'border-border bg-surface-elevated text-text-muted hover:border-border-subtle'
                } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                <div className="text-left">
                  <div className="font-medium text-sm sm:text-base">Use Existing Story</div>
                  <div className="text-[10px] sm:text-sm opacity-75 mt-1">Select from your documents</div>
                </div>
              </button>
              <button
                onClick={() => !settingsLocked && setSettings({...settings, storySource: 'upload', selectedStoryDoc: '', ...(settings.audioSource === 'existing' ? { audioSource: 'generate' } : {})})}
                disabled={settingsLocked}
                className={`p-4 rounded-lg border-2 transition-all ${
                  settings.storySource === 'upload' 
                    ? 'border-red-800/70 bg-red-900/30 text-white' 
                    : 'border-border bg-surface-elevated text-text-muted hover:border-border-subtle'
                } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                <div className="text-left">
                  <div className="font-medium text-sm sm:text-base">Upload File</div>
                  <div className="text-xs sm:text-sm opacity-75 mt-1">Upload your own .txt file</div>
                </div>
              </button>
            </div>
          </div>

          {settings.storySource === 'new' ? (
            <>
              <div>
                <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Story Title</label>
                <input
                  type="text"
                  value={settings.storyTitle}
                  onChange={(e) => !settingsLocked && setSettings({...settings, storyTitle: e.target.value})}
                  disabled={settingsLocked}
                  className={`w-full px-4 py-2 bg-surface-elevated border border-border rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                  placeholder="Enter story title"
                />
              </div>

              <div>
                <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Brief Description</label>
                <div className="flex items-start mt-2">
                  <div className="bg-surface-elevated border border-border rounded-lg p-3 flex items-start space-x-2">
                    <Info className="h-5 w-5 text-text-dim mt-0.5" />
                    <div className="text-sm text-text-dim">
                      <p>Write a short paragraph about what you want the story to be about.</p>
                      <p>It's recommended to not mention the structure as the AI handles that.</p>
                      <p>Best results when writing that you want a story instead of asking for a script.</p>
                    </div>
                  </div>
                </div>
                <div className="mt-4"></div>
                <textarea
                  value={settings.storyDescription}
                  onChange={(e) => !settingsLocked && e.target.value.length <= 5000 && setSettings({...settings, storyDescription: e.target.value})}
                  disabled={settingsLocked}
                  className={`w-full px-4 py-2 bg-surface-elevated border border-border rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                  rows={3}
                  placeholder="Describe your story"
                />
                {settings.storyDescription?.length >= 5000 && (
                  <p className="text-xs text-status-warning mt-2">Character limit reached (5,000 / 5,000)</p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-text-muted">
                    {isRuntimeMode ? 'Runtime in Minutes' : 'Word Count'}
                  </label>
                  <div className="flex items-center gap-3">
                    <span className={`text-sm ${!isRuntimeMode ? 'text-status-error font-medium' : 'text-text-dim'}`}>
                      Words
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (settingsLocked) return;
                        const newMode = !isRuntimeMode;
                        setIsRuntimeMode(newMode);
                        // Convert between modes
                        if (newMode) {
                          // Switching to runtime: convert word count to minutes
                          const wordCountNum = parseInt(settings.wordCount) || 200;
                          setRuntimeMinutes(wordCountToMinutes(wordCountNum).toString());
                        } else {
                          // Switching to word count: convert minutes to words
                          const minutesNum = parseInt(runtimeMinutes) || 10;
                          setSettings({ ...settings, wordCount: minutesToWordCount(minutesNum).toString() });
                        }
                      }}
                      disabled={settingsLocked}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        isRuntimeMode ? 'bg-accent' : 'bg-surface-elevated'
                      } ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          isRuntimeMode ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                    <span className={`text-sm ${isRuntimeMode ? 'text-status-error font-medium' : 'text-text-dim'}`}>
                      Runtime
                    </span>
                  </div>
                </div>

                {isRuntimeMode ? (
                  <>
                    <input
                      type="text"
                      value={runtimeMinutes}
                      onChange={(e) => {
                        if (settingsLocked) return;
                        setRuntimeMinutes(e.target.value);
                        const minutes = isValidNumericInput(e.target.value) ? parseInt(e.target.value) : 0;
                        setSettings({ ...settings, wordCount: minutesToWordCount(minutes).toString() });
                      }}
                      disabled={settingsLocked}
                      className={`w-full px-4 py-2 bg-surface-elevated border rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 ${
                        wordCountError ? 'border-accent-text' : 'border-border'
                      } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                      placeholder="Enter runtime in minutes"
                    />
                    <p className="mt-1 text-sm text-text-dim">
                      {getMinuteLimitsForModel(settings.model).min}-{getMinuteLimitsForModel(settings.model).max} minutes
                      {' '}(~{minutesToWordCount(parseInt(runtimeMinutes?.toString() || '0')).toLocaleString()} words)
                    </p>
                  </>
                ) : (
                  <>
                    <input
                      type="text"
                      value={settings.wordCount}
                      onChange={(e) => {
                        if (settingsLocked) return;
                        setSettings({...settings, wordCount: e.target.value});
                        const wordCountNum = isValidNumericInput(e.target.value) ? parseInt(e.target.value) : 0;
                        setRuntimeMinutes(wordCountToMinutes(wordCountNum).toString());
                      }}
                      disabled={settingsLocked}
                      className={`w-full px-4 py-2 bg-surface-elevated border rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 ${
                        wordCountError ? 'border-accent-text' : 'border-border'
                      } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                      placeholder={`Enter word count (200-${selectedModel.maxWords.toLocaleString()})`}
                    />
                    <p className="mt-1 text-sm text-text-dim">
                      200-{selectedModel.maxWords.toLocaleString()} words
                      {' '}(~{wordCountToMinutes(parseInt(settings.wordCount) || 0)} minutes)
                    </p>
                  </>
                )}

                {wordCountError && (
                  <div className="bg-status-warning text-status-warning-text p-4 rounded-lg mt-2">
                    <div className="flex items-center space-x-2 text-status-warning mb-2">
                      <AlertCircle className="h-5 w-5" />
                      <h3 className="text-lg font-medium">Warning</h3>
                    </div>
                    <p>{wordCountError}</p>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Language</label>
                <Listbox
                  value={settings.language}
                  onChange={(value) => !settingsLocked && setSettings({...settings, language: value})}
                  disabled={settingsLocked}
                >
                  {({ open }) => (
                    <div className="relative">
                      <Listbox.Button className={`relative w-full bg-surface-elevated border border-border rounded-lg px-4 py-2.5 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}>
                        <span className="block truncate">
                          {languageOptions.find(option => option.value === settings.language)?.label || 'English'}
                        </span>
                        <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                          <ChevronDown className={`h-5 w-5 text-text-dim transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                        </span>
                      </Listbox.Button>
                      {!settingsLocked && (
                        <Transition
                          show={open}
                          enter="transition ease-out duration-100"
                          enterFrom="transform opacity-0 scale-95"
                          enterTo="transform opacity-100 scale-100"
                          leave="transition ease-in duration-75"
                          leaveFrom="transform opacity-100 scale-100"
                          leaveTo="transform opacity-0 scale-95"
                        >
                          <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-dropdown border border-white/[0.08] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                            {languageOptions.map((option) => (
                              <Listbox.Option
                                key={option.value}
                                value={option.value}
                                className={({ active, selected }) =>
                                  `relative cursor-pointer select-none py-3 px-4 ${active ? 'bg-white/[0.08] text-white' : 'text-text-muted'} ${selected ? 'font-medium' : 'font-normal'}`
                                }
                              >
                                {({ selected }) => (
                                  <div className="flex justify-between items-center">
                                    <span className={selected ? 'font-medium' : 'font-normal'}>{option.label}</span>
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
                      )}
                    </div>
                  )}
                </Listbox>
              </div>

              {/* Master Prompt Section */}
              <MasterPrompt
                enabled={masterPromptEnabled}
                setEnabled={setMasterPromptEnabled}
                enhanceAI={masterPromptEnhanceAI}
                setEnhanceAI={setMasterPromptEnhanceAI}
                data={masterPromptData}
                setData={setMasterPromptData}
                disabled={settingsLocked}
              />

              {/* YouTube Inspiration Section */}
              <div className="bg-surface-card rounded-xl p-4 border border-border">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <h3 className="text-white font-medium">YouTube Inspiration</h3>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={youtubeInspirationEnabled}
                    aria-label="Toggle YouTube inspiration"
                    onClick={() => {
                      const newValue = !youtubeInspirationEnabled;
                      setYoutubeInspirationEnabled(newValue);
                      if (!newValue) {
                        setYoutubeLinks(['']);
                        setYoutubeLinkErrors({});
                      }
                    }}
                    disabled={settingsLocked}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                      youtubeInspirationEnabled ? 'bg-accent' : 'bg-surface-elevated'
                    } ${settingsLocked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                        youtubeInspirationEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
                <p className="text-text-dim text-sm mt-2">
                  Add a YouTube video link as creative inspiration. The transcript will be extracted and used to shape the story's tone, themes, and narrative style.
                </p>
                <div
                  className="grid transition-[grid-template-rows] duration-300 ease-out"
                  style={{ gridTemplateRows: youtubeInspirationEnabled ? '1fr' : '0fr' }}
                >
                  <div className="overflow-hidden -mx-1 px-1">
                    <div className="pt-4 pb-1 space-y-3">
                      <div className="dash-info-box p-2.5 flex gap-2">
                        <Info className="w-4 h-4 dash-box-icon flex-shrink-0 mt-0.5" />
                        <p className="text-xs dash-box-text">Only the first 20 minutes of a video are used as context.</p>
                      </div>
                      {youtubeLinks.map((link, index) => {
                        const videoId = link.trim() ? extractYoutubeVideoId(link.trim()) : null;
                        const hasError = !!youtubeLinkErrors[index];
                        const showThumbnail = videoId && !hasError;
                        return (
                        <div key={index}>
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="min-w-0 flex-1">
                              <input
                                type="url"
                                value={link}
                                onChange={(e) => {
                                  const newLinks = [...youtubeLinks];
                                  newLinks[index] = e.target.value;
                                  setYoutubeLinks(newLinks);
                                  const error = validateYoutubeUrl(e.target.value);
                                  setYoutubeLinkErrors(prev => {
                                    const next = { ...prev };
                                    if (error) next[index] = error;
                                    else delete next[index];
                                    return next;
                                  });
                                }}
                                placeholder={`YouTube video URL${youtubeLinks.length > 1 ? ` #${index + 1}` : ''}`}
                                disabled={settingsLocked}
                                className={`w-full rounded-xl bg-surface-input border ${
                                  hasError ? 'border-status-warning' : 'border-white/[0.13]'
                                } px-4 py-3 text-white/95 text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 ${
                                  settingsLocked ? 'opacity-50 cursor-not-allowed' : ''
                                }`}
                              />
                            </div>
                            {youtubeLinks.length > 1 && (
                              <button
                                type="button"
                                onClick={() => {
                                  const newLinks = youtubeLinks.filter((_, i) => i !== index);
                                  setYoutubeLinks(newLinks);
                                  setYoutubeLinkErrors(prev => {
                                    const next: Record<number, string> = {};
                                    Object.entries(prev).forEach(([k, v]) => {
                                      const ki = parseInt(k);
                                      if (ki < index) next[ki] = v;
                                      else if (ki > index) next[ki - 1] = v;
                                    });
                                    return next;
                                  });
                                }}
                                disabled={settingsLocked}
                                className="p-2 rounded-lg text-text-muted hover:text-red-400 hover:bg-white/[0.05] transition-colors duration-200 flex-shrink-0"
                                aria-label={`Remove video ${index + 1}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                          {hasError && (
                            <div className="flex items-center gap-1.5 mt-1.5 ml-1">
                              <AlertTriangle className="h-3.5 w-3.5 text-status-warning flex-shrink-0" />
                              <p className="text-status-warning text-xs">{youtubeLinkErrors[index]}</p>
                            </div>
                          )}
                          {showThumbnail && (
                            <div className="mt-2 rounded-lg overflow-hidden border border-white/[0.08] w-fit">
                              <img
                                src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
                                alt="Video thumbnail"
                                className="block w-48 h-auto rounded-lg"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                              />
                            </div>
                          )}
                        </div>
                        );
                      })}

                    </div>
                  </div>
                </div>
              </div>

              {/* Pause Text-to-Speech Section */}
              <div className="bg-surface-card rounded-xl p-4 border border-border">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <h3 className="text-white font-medium">Pause Text-to-Speech</h3>
                    <span className="ml-2 px-2.5 py-0.5 text-xs font-medium bg-status-success text-status-success rounded-full border border-status-success">
                      Recommended
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPauseTTS(!pauseTTS)}
                    disabled={settingsLocked}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                      pauseTTS ? 'bg-accent' : 'bg-surface-elevated'
                    } ${settingsLocked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                        pauseTTS ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
                <p className="text-text-dim text-sm mt-2">
                  Inserts natural pauses between sentences in the generated story. When audio is generated in Step 2, these pauses create more realistic, human-like narration with better pacing and dramatic delivery.
                </p>
                {pauseTTS && (
                  <div className="flex items-start space-x-2 bg-status-warning border border-status-warning rounded-xl px-4 py-3 mt-3">
                    <AlertTriangle className="h-5 w-5 text-status-warning flex-shrink-0 mt-0.5" />
                    <p className="text-status-warning-text text-sm">
                      Pauses require <strong>Premium</strong>, <strong>Apex</strong>, or <strong>Clone</strong> voices. Core voices do not support pause functionality and will be unavailable for selection.
                    </p>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">AI Model</label>
                <Listbox
                  value={settings.model}
                  onChange={(value) => !settingsLocked && setSettings({...settings, model: value})}
                  disabled={settingsLocked}
                >
                  {({ open }) => (
                    <div className="relative">
                      <Listbox.Button className={`relative w-full bg-surface-elevated border border-border rounded-lg px-4 py-2.5 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}>
                        <span className="block truncate">
                          {selectedModel.label}
                        </span>
                        <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                          <ChevronDown className={`h-5 w-5 text-text-dim transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                        </span>
                      </Listbox.Button>
                      {!settingsLocked && (
                        <Transition
                          show={open}
                          enter="transition ease-out duration-100"
                          enterFrom="transform opacity-0 scale-95"
                          enterTo="transform opacity-100 scale-100"
                          leave="transition ease-in duration-75"
                          leaveFrom="transform opacity-100 scale-100"
                          leaveTo="transform opacity-0 scale-95"
                        >
                          <Listbox.Options className="absolute z-50 mt-1 w-full bg-surface-dropdown border border-white/[0.08] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                            {modelOptions.map((option) => (
                              <Listbox.Option
                                key={option.value}
                                value={option.value}
                                className={({ active, selected }) =>
                                  `relative cursor-pointer select-none py-3 px-4 ${active ? 'bg-white/[0.08] text-white' : 'text-text-muted'} ${selected ? 'font-medium' : 'font-normal'}`
                                }
                              >
                                {({ selected }) => (
                                  <div className="flex justify-between items-center">
                                    <div>
                                      <span className={selected ? 'font-medium' : 'font-normal'}>{option.label}</span>
                                      <p className="text-xs text-text-dim mt-1">
                                        {option.description} • Max: {option.maxWords.toLocaleString()} words
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
                      )}
                    </div>
                  )}
                </Listbox>
                <p className="mt-2 text-xs text-text-dim">
                  Selected: {selectedModel.label} ({selectedModel.description})
                </p>
              </div>
            </>
          ) : settings.storySource === 'existing' ? (
            <div>
              <label className="block text-xs sm:text-sm font-medium text-text-muted mb-2">Select from your Documents</label>
              <Listbox
                value={settings.selectedStoryDoc}
                onChange={(value) => !settingsLocked && setSettings({...settings, selectedStoryDoc: value})}
                disabled={settingsLocked}
              >
                {({ open }) => (
                  <div className="relative">
                    <Listbox.Button className={`relative w-full bg-surface-elevated border border-border rounded-lg px-4 py-2.5 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}>
                      <span className="block truncate">
                        {settings.selectedStoryDoc 
                          ? documents.find(doc => doc.id === settings.selectedStoryDoc)?.title 
                          : 'Select a document'}
                      </span>
                      <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                        <ChevronDown className={`h-5 w-5 text-text-dim transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                      </span>
                    </Listbox.Button>
                    {!settingsLocked && (
                      <Transition
                        show={open}
                        enter="transition ease-out duration-100"
                        enterFrom="transform opacity-0 scale-95"
                        enterTo="transform opacity-100 scale-100"
                        leave="transition ease-in duration-75"
                        leaveFrom="transform opacity-100 scale-100"
                        leaveTo="transform opacity-0 scale-95"
                      >
                        <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-dropdown border border-white/[0.08] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                          {/* None option - allows user to not select a document */}
                          <Listbox.Option
                            value=""
                            className={({ active, selected }) =>
                              `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${
                                active ? 'bg-white/[0.08] text-white' : 'text-text-muted'
                              } ${selected ? 'font-medium' : 'font-normal'}`
                            }
                          >
                            {({ selected }) => (
                              <>
                                <div className="flex flex-col">
                                  <span className={`text-sm italic ${selected ? 'font-medium text-text-muted' : 'text-text-dim'}`}>
                                    None - Select a document
                                  </span>
                                </div>
                                {selected && (
                                  <CheckCircle2 className="h-5 w-5 text-accent-text" />
                                )}
                              </>
                            )}
                          </Listbox.Option>
                          
                          {documents.filter(doc => doc.version === 1 || doc.version === 2).map((doc) => (
                            <Listbox.Option
                              key={doc.id}
                              value={doc.id}
                              className={({ active }) =>
                                `relative cursor-pointer select-none py-2 px-4 ${active ? 'bg-white/[0.08] text-white' : 'text-text-muted'}`
                              }
                            >
                              <div className="flex flex-col">
                                <span className="font-medium">{doc.title}</span>
                                <span className="text-sm text-text-dim flex items-center">
                                  <Calendar className="h-3 w-3 mr-1" />
                                  {formatDate(doc.created_at)} • {doc.word_count || 0} words
                                </span>
                              </div>
                            </Listbox.Option>
                          ))}
                        </Listbox.Options>
                      </Transition>
                    )}
                  </div>
                )}
              </Listbox>
            </div>
          ) : (
            <div>
              <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Upload Your File</label>
              
              {/* Language Selection Dropdown */}
              <div className="mb-4">
                <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Select Language</label>
                <Listbox
                  value={uploadLanguage}
                  onChange={(value) => !settingsLocked && setUploadLanguage(value)}
                  disabled={settingsLocked}
                >
                  {({ open }) => (
                    <div className="relative">
                      <Listbox.Button className={`relative w-full bg-surface-elevated border border-border rounded-lg px-4 py-2.5 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}>
                        <span className="block truncate">
                          {uploadLanguage 
                            ? languageOptions.find(option => option.value === uploadLanguage)?.label 
                            : 'Select Language'}
                        </span>
                        <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                          <ChevronDown className={`h-5 w-5 text-text-dim transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                        </span>
                      </Listbox.Button>
                      {!settingsLocked && (
                        <Transition
                          show={open}
                          enter="transition ease-out duration-100"
                          enterFrom="transform opacity-0 scale-95"
                          enterTo="transform opacity-100 scale-100"
                          leave="transition ease-in duration-75"
                          leaveFrom="transform opacity-100 scale-100"
                          leaveTo="transform opacity-0 scale-95"
                        >
                          <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-dropdown border border-white/[0.08] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                            {languageOptions.map((option) => (
                              <Listbox.Option
                                key={option.value}
                                value={option.value}
                                className={({ active, selected }) =>
                                  `relative cursor-pointer select-none py-3 px-4 ${active ? 'bg-white/[0.08] text-white' : 'text-text-muted'} ${selected ? 'font-medium' : 'font-normal'}`
                                }
                              >
                                {({ selected }) => (
                                  <div className="flex justify-between items-center">
                                    <span className={selected ? 'font-medium' : 'font-normal'}>{option.label}</span>
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
                      )}
                    </div>
                  )}
                </Listbox>
                {uploadLanguageError && (
                  <p className="mt-1 text-sm text-status-error">{uploadLanguageError}</p>
                )}
              </div>

              <div className="relative">
                <div className="flex items-center justify-center w-full">
                  <label
                    className={`flex flex-col items-center justify-center w-full h-32 border-2 border-border border-dashed rounded-lg transition-colors ${
                      settingsLocked || !uploadLanguage
                        ? 'cursor-not-allowed opacity-50 bg-surface-elevated' 
                        : 'cursor-pointer hover:bg-surface-elevated bg-surface-elevated'
                    }`}
                  >
                    <div className="flex flex-col items-center justify-center pt-5 pb-6">
                      <Upload className="w-8 h-8 mb-3 text-text-dim" />
                      <p className="mb-2 text-sm text-text-dim">
                        <span className="font-semibold">
                          {!uploadLanguage ? 'Select language first' : 'Click to upload'}
                        </span> 
                        {uploadLanguage && ' or drag and drop'}
                      </p>
                      <p className="text-xs text-text-dim">TXT files only (max 1 MB, under 160,000 words)</p>
                    </div>
                    <input
                      type="file"
                      className="hidden"
                      accept=".txt"
                      onChange={handleFileUpload}
                      disabled={settingsLocked || !uploadLanguage}
                    />
                  </label>
                </div>
                {uploadedFile && (
                  <div className="mt-3 p-3 bg-surface-elevated rounded-lg">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <FileText className="h-4 w-4 text-status-success" />
                        <span className="text-sm text-white">{uploadedFile.name}</span>
                        <span className="text-xs text-text-dim">
                          ({Math.round(uploadedFile.size / 1024)} KB)
                        </span>
                        {uploadedDocId && (
                          <span className="text-xs text-status-success">✓ Uploaded</span>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          setUploadedFile(null);
                          setSettings(prev => ({ ...prev, storySource: 'new', audioSource: 'generate' }));
                        }}
                        disabled={settingsLocked}
                        className={`p-1 text-text-dim hover:text-status-error transition-colors ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// OLD ImageConfigurationStep removed - replaced by VisualConfiguration component

// Audio Configuration Step Component
function AudioConfigurationStep({
  settings,
  setSettings,
  settingsLocked,
  collapsedSteps,
  audioFiles,
  speedError,
  volumeError,
  speedInput,
  volumeInput,
  setVolumeInput,
  setSpeedInput,
  playingVoice,
  isPremiumPlan,
  isStandardPlan,
  handleAudioFileUpload,
  handlePlayVoiceSample,
  handleSpeedInputChange,
  handleVolumeInputChange,
  formatDate,
  getAudioFilesForSelectedStory,
  isStepConfigured,
  toggleStepCollapse,
  uploadingAudio,
  uploadedAudioFile,
  setUploadedAudioFile,
  uploadedAudioDocId,
  audioUploadProgress,
  audioUploadStartTime,
  existingAudioVolumeInput,
  setExistingAudioVolumeInput,
  existingAudioVolumeError,
  handleExistingAudioVolumeInputChange,
  validateExistingAudioVolume,
  voiceSamples,
  voiceSelectorRef,
  onCloneVoiceCreated,
  onVoiceSelect,
  currentUserId,
  elevenLabsSelectedLabel,
  elevenLabsCurrentVoiceId,
  elevenLabsModelId,
  onSelectElevenLabsVoice,
  onElevenLabsModelChange,
  calculatedAudioDuration,
  setCalculatedAudioDuration,
  audioDurationLoading,
  audioDurationError,
  isCalculatingDuration,
  handleCalculateAudioDuration,
  pauseTTS,
}: any) {
  // Format duration to HH:MM:SS or MM:SS
  const formatDuration = (seconds: number): string => {
    // Return placeholder for 0 or invalid values
    if (!seconds || seconds <= 0) {
      return '—';
    }
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  // Check if Step 1 is configured
  const isStep1Configured = isStepConfigured(1);

  // FIXED: Enhanced existing audio volume input change handler
  const enhancedHandleExistingAudioVolumeInputChange = (value: string) => {
    setExistingAudioVolumeInput(value);
    if (validateExistingAudioVolume(value)) {
      setSettings(prev => ({ 
        ...prev, 
        existingAudioVolume: value,
        // FIXED: Also update the main audioVolume field for consistency
        audioVolume: parseFloat(value)
      }));
    }
  };

  return (
    <div className={`bg-surface-card rounded-lg ${settingsLocked ? 'opacity-60' : ''}`}>
      <div 
        className="flex items-center justify-between p-6 cursor-pointer"
        onClick={() => !settingsLocked && toggleStepCollapse(2)}
      >
        <div className="flex items-center">
          <Volume2 className="h-5 w-5 text-red-700 mr-2" />
          <h2 className="text-lg sm:text-xl font-semibold text-white">Step 2: Audio Configuration</h2>
          {settingsLocked && <Lock className="h-4 w-4 text-text-dim ml-2" />}
        </div>
        <div className="flex items-center space-x-2">
          {isStepConfigured(2) && (
            <span className="text-sm text-status-success">Configured</span>
          )}
          {!settingsLocked && (
            <ChevronDown className={`h-5 w-5 text-text-dim transition-transform duration-200 ${collapsedSteps[2] ? 'rotate-180' : ''}`} />
          )}
        </div>
      </div>

      {!collapsedSteps[2] && (
        <div className="px-6 pb-6 space-y-4">
          {/* Warning for Step 1 requirement - only for Generate Audio */}
          {!isStep1Configured && settings.audioSource === 'generate' && (
            <div className="bg-status-warning text-status-warning-text p-4 rounded-lg mb-4">
              <p className="text-sm">Complete Step 1 (Story Configuration) to generate audio.</p>
            </div>
          )}

          <div>
            <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Audio Source</label>
            <div className="grid grid-cols-3 gap-4">
              <button
                onClick={() => !settingsLocked && setSettings({...settings, audioSource: 'generate'})}
                disabled={settingsLocked}
                className={`p-3 rounded-lg border-2 transition-all ${
                  settings.audioSource === 'generate'
                    ? 'border-red-800/70 bg-red-900/30 text-white'
                    : 'border-border bg-surface-elevated text-text-muted hover:border-border-subtle'
                } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                <div className="text-center">
                  <div className="font-medium text-sm sm:text-base">Generate Audio</div>
                  <div className="text-xs sm:text-sm opacity-75">Text-to-speech</div>
                </div>
              </button>
              <button
                onClick={() => !settingsLocked && settings.storySource !== 'new' && settings.storySource !== 'upload' && setSettings({...settings, audioSource: 'existing'})}
                disabled={settingsLocked || settings.storySource === 'new' || settings.storySource === 'upload'}
                className={`p-3 rounded-lg border-2 transition-all ${
                  settings.storySource === 'new' || settings.storySource === 'upload' || settingsLocked
                    ? 'opacity-50 cursor-not-allowed border-border bg-surface-elevated text-text-dim'
                    : settings.audioSource === 'existing'
                    ? 'border-red-800/70 bg-red-900/30 text-white'
                    : 'border-border bg-surface-elevated text-text-muted hover:border-border-subtle'
                }`}
              >
                <div className="text-center">
                  <div className="font-medium text-sm sm:text-base">Use Existing Audio</div>
                  <div className="text-xs sm:text-sm opacity-75">
                    <span className="hidden sm:inline">Single file or folder</span>
                    <span className="sm:hidden">File/folder</span>
                  </div>
                </div>
              </button>
              <button
                onClick={() => !settingsLocked && settings.storySource !== 'new' && settings.storySource !== 'existing' && setSettings({...settings, audioSource: 'upload'})}
                disabled={settingsLocked || settings.storySource === 'new' || settings.storySource === 'existing'}
                className={`p-3 rounded-lg border-2 transition-all ${
                  settings.storySource === 'new' || settings.storySource === 'existing' || settingsLocked
                    ? 'opacity-50 cursor-not-allowed border-border bg-surface-elevated text-text-dim'
                    : settings.audioSource === 'upload'
                    ? 'border-red-800/70 bg-red-900/30 text-white'
                    : 'border-border bg-surface-elevated text-text-muted hover:border-border-subtle'
                }`}
              >
                <div className="text-center">
                  <div className="font-medium text-sm sm:text-base">Upload Audio</div>
                  <div className="text-xs sm:text-sm opacity-75">MP3 or WAV file</div>
                </div>
              </button>
            </div>
          </div>

          {/* Warning for story source + incompatible audio source */}
          {settings.storySource === 'new' && settings.audioSource !== 'generate' && (
            <div className="bg-yellow-900/50 text-yellow-200 p-4 rounded-lg">
              <p className="text-sm">Existing audio and upload options are not available when creating a new story. Only Generate Audio is available.</p>
            </div>
          )}

          {settings.audioSource === 'generate' && (
            <>
              {/* Voice Selection */}
              <VoiceSelector
                ref={voiceSelectorRef}
                selectedVoice={settings.selectedVoice}
                onVoiceSelect={onVoiceSelect}
                playingVoice={playingVoice}
                onPlaySample={handlePlayVoiceSample}
                disabled={settingsLocked}
                userPlan={isStandardPlan || isPremiumPlan ? (isPremiumPlan ? 'premium' : 'standard') : 'free'}
                userId={currentUserId || ''}
                onCloneVoiceCreated={onCloneVoiceCreated}
                pauseRestricted={pauseTTS}
                elevenLabsSelectedLabel={elevenLabsSelectedLabel}
                elevenLabsCurrentVoiceId={elevenLabsCurrentVoiceId}
                elevenLabsModelId={elevenLabsModelId}
                onSelectElevenLabsVoice={onSelectElevenLabsVoice}
                onElevenLabsModelChange={onElevenLabsModelChange}
                hideElevenLabs={!onSelectElevenLabsVoice}
              />

              {/* Audio Settings Card */}
              <div className="rounded-2xl border border-border-card bg-surface-card/40 p-5">
                <h3 className="text-[10px] font-mono tracking-[0.15em] uppercase text-text-muted mb-4">Audio Settings</h3>

                <div className="space-y-5">
                  {/* Speed Control */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs font-medium text-white">Speech Speed</label>
                      <input
                        type="text"
                        value={speedInput}
                        onChange={(e) => !settingsLocked && handleSpeedInputChange(e.target.value)}
                        disabled={settingsLocked}
                        className={`w-16 px-2 py-0.5 bg-surface-input border rounded-lg text-white text-xs text-center focus:outline-none focus:ring-1 ${
                          speedError ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-accent'
                        } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                        placeholder="0.8"
                      />
                    </div>
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-lg font-semibold text-white tabular-nums">{(settings.audioSpeed || 1.0).toFixed(2)}x</span>
                      <span className="text-xs text-text-muted">
                        {settings.audioSpeed < 0.5 ? 'Very Slow' : settings.audioSpeed < 0.75 ? 'Slow' : settings.audioSpeed < 1.1 ? 'Normal' : settings.audioSpeed < 1.4 ? 'Fast' : 'Very Fast'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="2.0"
                      step="0.01"
                      value={settings.audioSpeed}
                      onChange={(e) => {
                        if (!settingsLocked) {
                          const value = parseFloat(e.target.value);
                          setSettings(prev => ({ ...prev, audioSpeed: value }));
                          setSpeedInput(value.toString());
                        }
                      }}
                      disabled={settingsLocked}
                      className={`w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer slider ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                    />
                    <div className="flex justify-between text-[10px] text-text-muted mt-1">
                      <span>0.5x</span>
                      <span>1.0x</span>
                      <span>1.5x</span>
                      <span>2.0x</span>
                    </div>
                    {speedError && (
                      <p className="mt-1 text-xs text-red-400">{speedError}</p>
                    )}
                  </div>

                  {/* Volume Control */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs font-medium text-white">Audio Volume</label>
                      <input
                        type="text"
                        value={volumeInput}
                        onChange={(e) => !settingsLocked && handleVolumeInputChange(e.target.value)}
                        disabled={settingsLocked}
                        className={`w-16 px-2 py-0.5 bg-surface-input border rounded-lg text-white text-xs text-center focus:outline-none focus:ring-1 ${
                          volumeError ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-accent'
                        } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                        placeholder="1.0"
                      />
                    </div>
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-lg font-semibold text-white tabular-nums">{Math.round((settings.audioVolume || 1.0) * 100)}%</span>
                      <span className="text-xs text-text-muted">
                        {(settings.audioVolume || 1.0) <= 1.0 ? 'Default' : (settings.audioVolume || 1.0) <= 2.0 ? 'Boosted' : (settings.audioVolume || 1.0) <= 4.0 ? 'Loud' : 'Max Boost'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="1.0"
                      max="8.0"
                      step="0.01"
                      value={settings.audioVolume || 1.0}
                      onChange={(e) => {
                        if (!settingsLocked) {
                          const value = parseFloat(e.target.value);
                          setSettings(prev => ({ ...prev, audioVolume: value }));
                          setVolumeInput(value.toString());
                        }
                      }}
                      disabled={settingsLocked}
                      className={`w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer slider ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                    />
                    <div className="flex justify-between text-[10px] text-text-muted mt-1">
                      <span>100%</span>
                      <span>300%</span>
                      <span>500%</span>
                      <span>800%</span>
                    </div>
                    {volumeError && (
                      <p className="mt-1 text-xs text-red-400">{volumeError}</p>
                    )}
                    <p className="text-text-dim text-xs mt-2">
                      <span className="hidden sm:inline">Volume boost above 100% costs 100 additional tokens for professional audio enhancement.</span>
                      <span className="sm:hidden">Volume boost above 100% costs 100 extra tokens.</span>
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between bg-surface-elevated px-4 py-3 rounded-lg">
                <div>
                  <h3 className="text-sm font-medium text-white">
                    <span className="hidden sm:inline">Remove Title & Chapters</span>
                    <span className="sm:hidden">Remove Title/Chapters</span>
                  </h3>
                  <p className="text-sm text-text-dim mt-1">Clean audio output</p>
                </div>
                <label className={`relative inline-flex items-center ${settingsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={settings.removeTitleChapters}
                    onChange={(e) => !settingsLocked && setSettings({...settings, removeTitleChapters: e.target.checked})}
                    disabled={settingsLocked}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-surface-elevated peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-accent-hover rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border-subtle after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                </label>
              </div>
            </>
          )}

          {settings.audioSource === 'existing' && (
            <>
              <div>
                <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">
                  <span className="hidden sm:inline">Select Audio File or Folder</span>
                  <span className="sm:hidden">Select Audio</span>
                </label>
                <Listbox
                  value={settings.selectedAudioFile}
                  onChange={async (value) => {
                    if (!settingsLocked) {
                      setSettings({...settings, selectedAudioFile: value});
                      
                      // Automatically update audio duration when selection changes
                      if (value && setCalculatedAudioDuration && handleCalculateAudioDuration) {
                        const selectedFile = getAudioFilesForSelectedStory().find(file => file.id === value);
                        
                        if (selectedFile?.audio_duration && selectedFile.audio_duration > 0) {
                          // If file has cached duration, use it immediately
                          console.log(`[AudioConfigurationStep] Using cached duration: ${selectedFile.audio_duration}s`);
                          setCalculatedAudioDuration(selectedFile.audio_duration);
                        } else {
                          // If no cached duration, calculate it
                          console.log(`[AudioConfigurationStep] Calculating duration for audio file: ${value}`);
                          await handleCalculateAudioDuration(value, 'existing');
                        }
                      } else if (!value && setCalculatedAudioDuration) {
                        // Reset duration when "None" is selected
                        setCalculatedAudioDuration(0);
                      }
                    }
                  }}
                  disabled={settingsLocked}
                >
                  {({ open }) => (
                    <div className="relative">
                      <Listbox.Button className={`relative w-full bg-surface-elevated border border-border rounded-lg px-4 py-2.5 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}>
                        <span className="block truncate">
                          {settings.selectedAudioFile 
                            ? getAudioFilesForSelectedStory().find(file => file.id === settings.selectedAudioFile)?.title 
                            : 'Select an audio file or folder'}
                        </span>
                        <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                          <ChevronDown className={`h-5 w-5 text-text-dim transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                        </span>
                      </Listbox.Button>
                      {!settingsLocked && (
                        <Transition
                          show={open}
                          enter="transition ease-out duration-100"
                          enterFrom="transform opacity-0 scale-95"
                          enterTo="transform opacity-100 scale-100"
                          leave="transition ease-in duration-75"
                          leaveFrom="transform opacity-100 scale-100"
                          leaveTo="transform opacity-0 scale-95"
                        >
                          <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-dropdown border border-white/[0.08] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                            {/* None option - allows user to not select audio */}
                            <Listbox.Option
                              value=""
                              className={({ active, selected }) =>
                                `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${
                                  active ? 'bg-white/[0.08] text-white' : 'text-text-muted'
                                } ${selected ? 'font-medium' : 'font-normal'}`
                              }
                            >
                              {({ selected }) => (
                                <>
                                  <div className="flex flex-col">
                                    <span className={`text-sm italic ${selected ? 'font-medium text-text-muted' : 'text-text-dim'}`}>
                                      None - Select audio
                                    </span>
                                  </div>
                                  {selected && (
                                    <CheckCircle2 className="h-5 w-5 text-accent-text" />
                                  )}
                                </>
                              )}
                            </Listbox.Option>
                            
                            {getAudioFilesForSelectedStory().map((file) => (
                              <Listbox.Option
                                key={file.id}
                                value={file.id}
                                className={({ active, selected }) =>
                                  `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${
                                    active ? 'bg-white/[0.08] text-white' : 'text-text-muted'
                                  } ${selected ? 'font-medium' : 'font-normal'}`
                                }
                              >
                                {({ selected }) => (
                                  <>
                                    <div className="flex flex-col">
                                      <span className={`${selected ? 'font-medium' : 'font-normal'}`}>{file.title}</span>
                                      <span className="text-sm text-text-dim flex items-center gap-2">
                                        <span className="flex items-center">
                                          <Calendar className="h-3 w-3 mr-1" />
                                          {formatDate(file.created_at)}
                                        </span>
                                        <span>•</span>
                                        <span>{[9, 10].includes(file.version || 0) ? 'Folder' : 'File'}</span>
                                        {file.audio_duration && file.audio_duration > 0 && (
                                          <>
                                            <span>•</span>
                                            <span className="text-status-info">{formatDuration(file.audio_duration)}</span>
                                          </>
                                        )}
                                      </span>
                                    </div>
                                    {selected && (
                                      <CheckCircle2 className="h-5 w-5 text-accent-text" />
                                    )}
                                  </>
                                )}
                              </Listbox.Option>
                            ))}
                          </Listbox.Options>
                        </Transition>
                      )}
                    </div>
                  )}
                </Listbox>
              </div>

              {/* Audio Volume Control for Existing Audio */}
              <div className="rounded-2xl border border-border-card bg-surface-card/40 p-5">
                <h3 className="text-[10px] font-mono tracking-[0.15em] uppercase text-text-muted mb-4">Audio Settings</h3>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-white">Audio Volume</label>
                    <input
                      type="text"
                      value={existingAudioVolumeInput}
                      onChange={(e) => !settingsLocked && enhancedHandleExistingAudioVolumeInputChange(e.target.value)}
                      disabled={settingsLocked}
                      className={`w-16 px-2 py-0.5 bg-surface-input border rounded-lg text-white text-xs text-center focus:outline-none focus:ring-1 ${
                        existingAudioVolumeError ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-accent'
                      } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                      placeholder="1.0"
                    />
                  </div>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-lg font-semibold text-white tabular-nums">{Math.round((settings.existingAudioVolume || 1.0) * 100)}%</span>
                    <span className="text-xs text-text-muted">
                      {(settings.existingAudioVolume || 1.0) <= 1.0 ? 'Default' : (settings.existingAudioVolume || 1.0) <= 2.0 ? 'Boosted' : (settings.existingAudioVolume || 1.0) <= 4.0 ? 'Loud' : 'Max Boost'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1.0"
                    max="8.0"
                    step="0.01"
                    value={settings.existingAudioVolume || 1.0}
                    onChange={(e) => {
                      if (!settingsLocked) {
                        const value = parseFloat(e.target.value);
                        setSettings(prev => ({ ...prev, existingAudioVolume: value }));
                        setExistingAudioVolumeInput(value.toString());
                      }
                    }}
                    disabled={settingsLocked}
                    className={`w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer slider ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                  />
                  <div className="flex justify-between text-[10px] text-text-muted mt-1">
                    <span>100%</span>
                    <span>300%</span>
                    <span>500%</span>
                    <span>800%</span>
                  </div>
                  {existingAudioVolumeError && (
                    <p className="mt-1 text-xs text-red-400">{existingAudioVolumeError}</p>
                  )}
                  <p className="text-text-dim text-xs mt-2">
                    <span className="hidden sm:inline">Volume boost above 100% costs 100 additional tokens for professional audio enhancement.</span>
                    <span className="sm:hidden">Volume boost above 100% costs 100 extra tokens.</span>
                  </p>
                </div>
              </div>
            </>
          )}
           
          {settings.audioSource === 'upload' && (
            <>
              <div>
                <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Upload Audio File</label>
                <div className="relative">
                  <div className="flex items-center justify-center w-full">
                    <label className={`flex flex-col items-center justify-center w-full h-32 border-2 border-border border-dashed rounded-lg transition-colors ${
                      settingsLocked || uploadingAudio
                        ? 'cursor-not-allowed opacity-50 bg-surface-elevated' 
                        : 'cursor-pointer bg-surface-elevated hover:bg-surface-elevated'
                    }`}>
                      <div className="flex flex-col items-center justify-center pt-5 pb-6">
                        {uploadingAudio ? (
                          <>
                            <RefreshCw className="w-8 h-8 mb-3 text-text-muted animate-spin" />
                            <p className="mb-2 text-sm text-text-muted">
                              <span className="font-semibold">
                                <span className="hidden sm:inline">Uploading audio file...</span>
                                <span className="sm:hidden">Uploading...</span>
                              </span>
                            </p>
                            {audioUploadProgress > 0 && (
                              <>
                                <div className="w-48 bg-surface-elevated rounded-full h-2 mb-2">
                                  <div 
                                    className="bg-status-success-muted h-2 rounded-full transition-all duration-300" 
                                    style={{width: `${audioUploadProgress}%`}}
                                  />
                                </div>
                                <p className="text-xs text-text-dim">
                                  {audioUploadProgress}% - {estimateTimeRemaining(
                                    audioUploadProgress * 1024 * 1024, // Convert percentage to bytes for calculation
                                    100 * 1024 * 1024, 
                                    audioUploadStartTime
                                  ) || 'Calculating...'}
                                </p>
                              </>
                            )}
                          </>
                        ) : (
                          <>
                            <Upload className="w-8 h-8 mb-3 text-text-dim" />
                            <p className="mb-2 text-sm text-text-dim">
                              <span className="font-semibold">Click to upload</span> or drag and drop
                            </p>
                            <p className="text-xs text-text-dim">MP3 or WAV files only (max 3GB)</p>
                          </>
                        )}
                      </div>
                      <input
                        type="file"
                        className="hidden"
                        accept=".mp3,.wav,audio/*"
                        onChange={handleAudioFileUpload}
                        disabled={settingsLocked || uploadingAudio}
                      />
                    </label>
                  </div>
                  {uploadedAudioFile && (
                    <div className="mt-3 p-3 bg-surface-elevated rounded-lg">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <Volume2 className="h-4 w-4 text-status-success" />
                          <span className="text-sm text-white">{uploadedAudioFile.name}</span>
                          <span className="text-xs text-text-dim">
                            ({Math.round(uploadedAudioFile.size / (1024 * 1024))} MB)
                          </span>
                          {uploadedAudioDocId && (
                            <span className="text-xs text-status-success">✓ Uploaded</span>
                          )}
                        </div>
                        <button
                          onClick={() => {
                            if (!settingsLocked) {
                              setUploadedAudioFile(null);
                              setSettings(prev => ({ ...prev, selectedAudioFile: '' }));
                            }
                          }}
                          disabled={settingsLocked}
                          className={`p-1 text-text-dim hover:text-status-error transition-colors ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Audio Volume Control for Uploaded Audio */}
              <div className="rounded-2xl border border-border-card bg-surface-card/40 p-5">
                <h3 className="text-[10px] font-mono tracking-[0.15em] uppercase text-text-muted mb-4">Audio Settings</h3>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-white">Audio Volume</label>
                    <input
                      type="text"
                      value={existingAudioVolumeInput}
                      onChange={(e) => !settingsLocked && enhancedHandleExistingAudioVolumeInputChange(e.target.value)}
                      disabled={settingsLocked}
                      className={`w-16 px-2 py-0.5 bg-surface-input border rounded-lg text-white text-xs text-center focus:outline-none focus:ring-1 ${
                        existingAudioVolumeError ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-accent'
                      } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                      placeholder="1.0"
                    />
                  </div>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-lg font-semibold text-white tabular-nums">{Math.round((settings.existingAudioVolume || 1.0) * 100)}%</span>
                    <span className="text-xs text-text-muted">
                      {(settings.existingAudioVolume || 1.0) <= 1.0 ? 'Default' : (settings.existingAudioVolume || 1.0) <= 2.0 ? 'Boosted' : (settings.existingAudioVolume || 1.0) <= 4.0 ? 'Loud' : 'Max Boost'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1.0"
                    max="8.0"
                    step="0.01"
                    value={settings.existingAudioVolume || 1.0}
                    onChange={(e) => {
                      if (!settingsLocked) {
                        const value = parseFloat(e.target.value);
                        setSettings(prev => ({ ...prev, existingAudioVolume: value }));
                        setExistingAudioVolumeInput(value.toString());
                      }
                    }}
                    disabled={settingsLocked}
                    className={`w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer slider ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                  />
                  <div className="flex justify-between text-[10px] text-text-muted mt-1">
                    <span>100%</span>
                    <span>300%</span>
                    <span>500%</span>
                    <span>800%</span>
                  </div>
                  {existingAudioVolumeError && (
                    <p className="mt-1 text-xs text-red-400">{existingAudioVolumeError}</p>
                  )}
                  <p className="text-text-dim text-xs mt-2">
                    <span className="hidden sm:inline">Volume boost above 100% costs 100 additional tokens for professional audio enhancement.</span>
                    <span className="sm:hidden">Volume boost above 100% costs 100 extra tokens.</span>
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}




