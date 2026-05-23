import React, { useState, useRef, useMemo } from 'react';
import { Play } from 'lucide-react';

interface VideoPlayerProps {
  videoUrl: string;
  thumbnailUrl: string;
  thumbnailAlt: string;
}

const isSafari = () => {
  const ua = navigator.userAgent;
  return /Safari/.test(ua) && !/Chrome/.test(ua) && !/Chromium/.test(ua);
};

const VideoPlayer: React.FC<VideoPlayerProps> = ({ videoUrl, thumbnailUrl, thumbnailAlt }) => {
  const [hasStarted, setHasStarted] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const useThumbnailFallback = useMemo(() => isSafari(), []);

  const handlePlay = () => {
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play();
      setHasStarted(true);
    }
  };

  const handleVideoPlay = () => {
    setHasStarted(true);
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current && !hasStarted && !useThumbnailFallback) {
      videoRef.current.currentTime = 1;
    }
  };

  return (
    <div className="relative aspect-video w-full">
      {!hasStarted && (
        <button 
          type="button"
          className="absolute inset-0 flex items-center justify-center cursor-pointer z-10 bg-transparent border-0 p-0"
          onClick={handlePlay}
          aria-label={`Play video: ${thumbnailAlt}`}
        >
          {useThumbnailFallback && (
            <img 
              src={thumbnailUrl} 
              alt={thumbnailAlt} 
              className="absolute inset-0 w-full h-full object-cover rounded-xl"
            />
          )}
          <div className="absolute inset-0 bg-black/40 rounded-xl" />
          <div className="relative z-10 bg-[#ff0000] text-white p-6 rounded-full transform transition-transform hover:scale-110">
            <Play size={32} />
          </div>
        </button>
      )}
      <video
        ref={videoRef}
        className="w-full h-full rounded-xl"
        src={videoUrl}
        controls={hasStarted}
        preload={useThumbnailFallback ? 'none' : 'metadata'}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={handleVideoPlay}
      >
        <div className="flex items-center justify-center w-full h-full min-h-[200px] rounded-xl bg-surface-secondary text-text-muted text-sm">
          Your browser doesn't support HTML video.
        </div>
      </video>
    </div>
  );
}

export default VideoPlayer;



