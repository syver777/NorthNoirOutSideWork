import React, { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Video, BookOpen, Mic, Image, Film, Play, Sparkles, Type } from 'lucide-react';
import DashboardLayout from '../components/DashboardLayout';
import VideoPlayer from '../components/VideoPlayer';

const THUMBNAIL_URL = 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ThumbnailTest.jpg';

interface Tutorial {
  id: string;
  title: string;
  description: string;
  videoUrl: string;
  icon: React.ElementType;
  duration: string;
}

const tutorials: Tutorial[] = [
  {
    id: 'north-noir',
    title: 'How to Use North Noir',
    description: 'A full walkthrough of how to use North Noir for creating long-form YouTube content.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20North%20Noir.mp4',
    icon: BookOpen,
    duration: '15 min',
  },
  {
    id: 'video-generator',
    title: 'Video Generator',
    description: 'Learn how the Video Generator combines all features to create complete videos up to 20 hours long.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20the%20Video%20Generator.mp4',
    icon: Film,
    duration: '8 min',
  },
  {
    id: 'story-generator',
    title: 'Story Generator',
    description: 'Learn how to use the Story Generator to craft compelling scripts and narratives for your videos.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20the%20Story%20Generator.mp4',
    icon: Type,
    duration: '10 min',
  },
  {
    id: 'text-to-speech',
    title: 'Text-to-Speech',
    description: 'How to use the Text-to-Speech feature to create high-quality narration for your videos.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20the%20Text-To-Speech.mp4',
    icon: Mic,
    duration: '6 min',
  },
  {
    id: 'image-generator',
    title: 'Image Generator',
    description: 'How to generate consistent, story-aligned visuals and integrate them with other features.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20the%20Image%20Generator.mp4',
    icon: Image,
    duration: '7 min',
  },
  {
    id: 'text-to-video',
    title: 'Text-to-Video Generator',
    description: 'Convert your story into AI-generated video clips ready to combine into a complete video.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20the%20Text-To-Video%20Generator.mp4',
    icon: Video,
    duration: '9 min',
  },
  {
    id: 'image-to-video',
    title: 'Image-to-Video Generator',
    description: 'Take your story through a 4-phase pipeline — image prompts, keyframes, video prompts, and final clips.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20the%20Image-To-Video%20Generator.mp4',
    icon: Film,
    duration: '11 min',
  },
  {
    id: 'image-prompt-generator',
    title: 'Image Prompt Generator',
    description: 'Create detailed, optimized prompts for generating consistent visuals for your videos.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20the%20Image%20Prompt%20Generator.mp4',
    icon: Sparkles,
    duration: '7 min',
  },
];

export default function Learn() {
  const [activeTutorial, setActiveTutorial] = useState<Tutorial>(tutorials[0]);
  const location = useLocation();

  // Auto-select tutorial from URL hash (e.g. /learn#text-to-speech)
  useEffect(() => {
    if (location.hash) {
      const id = location.hash.slice(1);
      const match = tutorials.find(t => t.id === id);
      if (match) setActiveTutorial(match);
    }
  }, [location.hash]);

  return (
    <DashboardLayout>
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Atmospheric gradient background */}
        <div className="pointer-events-none absolute inset-0 -top-20 overflow-hidden" aria-hidden="true">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120%] h-[500px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(220,38,38,0.14)_0%,transparent_70%)]" />
          <div className="absolute top-40 left-0 w-[40%] h-[300px] bg-[radial-gradient(ellipse_80%_80%_at_20%_50%,rgba(59,130,246,0.07)_0%,transparent_60%)]" />
          <div className="absolute top-60 right-0 w-[35%] h-[250px] bg-[radial-gradient(ellipse_80%_80%_at_80%_50%,rgba(34,197,94,0.06)_0%,transparent_60%)]" />
        </div>

        {/* Header */}
        <div className="relative mb-10 dash-animate-in">
          <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Learn</h1>
          <p className="mt-2 text-text-secondary">
            Video guides for every feature in North Noir
          </p>
        </div>

        {/* Main layout: video + selector */}
        <div className="relative grid lg:grid-cols-[1fr_320px] gap-8">
          {/* Video player area */}
          <div className="dash-animate-in" style={{ animationDelay: '80ms' }}>
            <div className="rounded-xl overflow-hidden">
              <VideoPlayer
                key={activeTutorial.id}
                videoUrl={activeTutorial.videoUrl}
                thumbnailUrl={THUMBNAIL_URL}
                thumbnailAlt={activeTutorial.title}
              />
            </div>
            <div className="mt-5">
              <h2 className="text-xl font-display font-semibold tracking-tight text-white">
                {activeTutorial.title}
              </h2>
              <p className="mt-2 text-text-secondary text-sm">
                {activeTutorial.description}
              </p>
            </div>
          </div>

          {/* Tutorial selector */}
          <nav className="space-y-2 dash-animate-in" style={{ animationDelay: '160ms' }}>
            {tutorials.map((tutorial) => {
              const isActive = tutorial.id === activeTutorial.id;
              const Icon = tutorial.icon;
              return (
                <button
                  key={tutorial.id}
                  onClick={() => setActiveTutorial(tutorial)}
                  className={`w-full text-left px-3 py-3 rounded-xl transition-all duration-200 group ${
                    isActive
                      ? 'bg-red-900/40 border border-red-600'
                      : 'hover:bg-surface-tertiary/50 border border-transparent'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 p-1.5 rounded-md transition-colors ${
                      isActive ? 'bg-accent/20 text-accent' : 'bg-surface-tertiary/50 text-text-muted group-hover:text-text-secondary'
                    }`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className={`text-sm font-medium truncate ${
                          isActive ? 'text-white' : 'text-text-secondary'
                        }`}>
                          {tutorial.title}
                        </p>
                        <span className="shrink-0 text-xs text-text-muted tabular-nums">{tutorial.duration}</span>
                      </div>
                      <p className="text-xs text-text-muted mt-0.5 line-clamp-2">
                        {tutorial.description}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </nav>
        </div>
      </div>
    </DashboardLayout>
  );
}
