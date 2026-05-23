import { BookOpen, Image, Video, Brain, Sparkles, GitMerge, Palette, Users, CheckCircle2, Mic } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface Feature {
  icon: LucideIcon;
  title: string;
  description: string;
  color: string;
  bgColor: string;
  comingSoon?: boolean;
}

export const features: Feature[] = [
  {
    icon: Video,
    title: 'Complete Video Production',
    description: 'Generate complete 20-hour YouTube videos with 150,000-word scripts, images, and audio from just a prompt and settings. Everything you need for professional video content creation in one streamlined process.',
    color: 'text-indigo-500',
    bgColor: 'bg-indigo-500/10',
  },
  {
    icon: BookOpen,
    title: 'Ultra Long-Form Generation',
    description: 'Craft stories up to 150,000 words, perfect for creating scripts for extended YouTube videos lasting up to 20 hours. Ideal for niches where long-form content drives engagement.',
    color: 'text-red-500',
    bgColor: 'bg-red-500/10',
  },
  {
    icon: Brain,
    title: 'Intelligent Story Structure',
    description: 'Our AI organizes your story into coherent chapters and scenes, ensuring consistent narrative flow and character development for compelling long-form content.',
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
  },
  {
    icon: Sparkles,
    title: 'Advanced Story Enhancement',
    description: 'Receive smart suggestions for plot twists, character arcs, and pacing to keep your audience engaged throughout your entire story.',
    color: 'text-green-500',
    bgColor: 'bg-green-500/10',
  },
  {
    icon: GitMerge,
    title: 'Style & Voice Testing',
    description: 'Preview different visual style models and text-to-speech voices before committing to a full video. Find the perfect combination for your content.',
    color: 'text-purple-500',
    bgColor: 'bg-purple-500/10',
  },
  {
    icon: Users,
    title: 'Character Development',
    description: 'Build deep, consistent characters with AI-powered tracking to maintain their personalities, relationships, and arcs across your story.',
    color: 'text-yellow-500',
    bgColor: 'bg-yellow-500/10',
  },
  {
    icon: Palette,
    title: 'Image Prompt Generation',
    description: 'Generate detailed image prompts with consistent styles and character descriptions, perfectly aligned with your story for seamless integration into video production.',
    color: 'text-pink-500',
    bgColor: 'bg-pink-500/10',
  },
  {
    icon: Image,
    title: 'Image Generation',
    description: 'Automatically convert your image prompts into stunning visuals with your chosen style, ready for video production without extra effort.',
    color: 'text-teal-500',
    bgColor: 'bg-teal-500/10',
  },
  {
    icon: Mic,
    title: 'Text-to-Speech Integration',
    description: 'Generate high-quality AI-powered narration for your entire 150,000-word script, creating professional audio for videos up to 20 hours long.',
    color: 'text-orange-500',
    bgColor: 'bg-orange-500/10',
  },
  {
    icon: CheckCircle2,
    title: 'Quality Assurance',
    description: 'Built-in checks ensure your story maintains consistency, proper pacing, and professional-quality storytelling for maximum impact.',
    color: 'text-emerald-500',
    bgColor: 'bg-emerald-500/10',
  },
];
