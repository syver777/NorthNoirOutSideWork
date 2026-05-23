import React, { useEffect, useRef, useState } from 'react';
import { X, Play } from 'lucide-react';

const HOW_TO_VIDEO_URL =
  'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20North%20Noir.mp4';

interface WelcomeModalProps {
  onClose: () => void;
}

export default function WelcomeModal({ onClose }: WelcomeModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleClose = () => {
    setVisible(false);
    setTimeout(onClose, 280);
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) handleClose();
  };

  const handlePlay = () => {
    setPlaying(true);
    videoRef.current?.play();
  };

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6"
      style={{
        backgroundColor: visible ? 'rgba(0,0,0,0.82)' : 'rgba(0,0,0,0)',
        backdropFilter: visible ? 'blur(6px)' : 'blur(0px)',
        transition: 'background-color 0.3s ease, backdrop-filter 0.3s ease',
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to North Noir"
    >
      <div
        className="relative w-full max-w-2xl"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0) scale(1)' : 'translateY(24px) scale(0.97)',
          transition: 'opacity 0.32s cubic-bezier(0.16,1,0.3,1), transform 0.32s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        {/* Card */}
        <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0f] overflow-hidden shadow-2xl">
          {/* Close button */}
          <button
            onClick={handleClose}
            className="absolute top-4 right-4 z-10 p-1.5 rounded-lg bg-black/50 text-white/50 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Close welcome dialog"
          >
            <X className="h-5 w-5" />
          </button>

          {/* Video area */}
          <div className="relative aspect-video bg-black">
            <video
              ref={videoRef}
              src={HOW_TO_VIDEO_URL}
              className="w-full h-full object-cover"
              controls={playing}
              preload="metadata"
              playsInline
            />
            {!playing && (
              <button
                onClick={handlePlay}
                className="absolute inset-0 flex items-center justify-center group"
                aria-label="Play video"
              >
                {/* Subtle gradient overlay */}
                <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0f] via-transparent to-transparent opacity-60" />
                <div className="relative flex items-center justify-center w-16 h-16 rounded-full bg-red-600/90 group-hover:bg-red-600 group-hover:scale-105 transition-all duration-200 shadow-lg shadow-red-900/40">
                  <Play className="h-7 w-7 text-white ml-0.5" fill="currentColor" />
                </div>
              </button>
            )}
          </div>

          {/* Text content */}
          <div className="px-6 py-5 sm:px-8 sm:py-6">
            <h2 className="text-xl sm:text-2xl font-display font-semibold text-white tracking-tight">
              Welcome to North Noir
            </h2>
            <p className="mt-2 text-sm sm:text-[15px] leading-relaxed text-white/60">
              Looks like you just joined — great to have you. This walkthrough covers
              everything you need to get started: from generating your first story to
              producing a complete video. It's the fastest way to learn the platform
              and we highly recommend watching it before diving in.
            </p>
            <div className="mt-5 flex items-center gap-3">
              <button
                onClick={handlePlay}
                className="px-5 py-2.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition-colors"
              >
                Watch the walkthrough
              </button>
              <button
                onClick={handleClose}
                className="px-5 py-2.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white/50 hover:text-white/80 text-sm font-medium transition-colors"
              >
                I'll explore on my own
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
