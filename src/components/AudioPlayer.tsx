import React, { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Play, Pause, Download } from 'lucide-react';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

interface AudioPlayerProps {
  src: string; // Signed URL or file path
  title: string;
  filePath: string; // Original file path in Supabase storage
  onError: (error: string) => void;
}

const AudioPlayer: React.FC<AudioPlayerProps> = ({ src, title, filePath, onError }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [audioSrc, setAudioSrc] = useState(src);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Refresh signed URL if expired
  const refreshSignedUrl = async () => {
    try {
      const { data, error } = await supabase.storage
        .from('stories')
        .createSignedUrl(filePath, 3600, { download: false });
      if (error) {
        throw new Error(`Failed to refresh signed URL: ${error.message}`);
      }
      setAudioSrc(data.signedUrl);
      setIsLoading(false);
    } catch (err: any) {
      onError(`Error refreshing audio URL: ${err.message}`);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
      setIsLoading(false);
    };

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    const handleLoadStart = () => {
      setIsLoading(true);
    };

    const handleCanPlay = () => {
      setIsLoading(false);
    };

    const handleError = (e: Event) => {
      const audioError = (e.target as HTMLAudioElement).error;
      const errorMessage = audioError ? `Audio error: ${audioError.message}` : 'Unknown audio error';
      onError(errorMessage);
      // Attempt to refresh signed URL on error
      refreshSignedUrl();
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('loadstart', handleLoadStart);
    audio.addEventListener('canplay', handleCanPlay);
    audio.addEventListener('error', handleError);

    // Check if the initial URL is still valid
    if (audioSrc) {
      audio.src = audioSrc;
      audio.load();
    }

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('loadstart', handleLoadStart);
      audio.removeEventListener('canplay', handleCanPlay);
      audio.removeEventListener('error', handleError);
    };
  }, [audioSrc]);

  const togglePlayPause = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch((err) => {
        onError(`Failed to play audio: ${err.message}`);
        refreshSignedUrl();
      });
    }
    setIsPlaying(!isPlaying);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const width = rect.width;
    const newTime = (clickX / width) * duration;

    audio.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const handleSeekKeyboard = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const step = duration * 0.02;
    if (e.key === 'ArrowRight') {
      audio.currentTime = Math.min(duration, audio.currentTime + step);
    } else if (e.key === 'ArrowLeft') {
      audio.currentTime = Math.max(0, audio.currentTime - step);
    }
  };

  const formatTime = (time: number) => {
    if (isNaN(time)) return '0:00';
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="rounded-lg p-4 border border-white/[0.08] bg-white/[0.03]">
      <audio ref={audioRef} preload="metadata" />
      <div className="flex items-center space-x-4">
        <button
          onClick={togglePlayPause}
          disabled={isLoading}
          aria-label={isLoading ? 'Loading audio' : isPlaying ? 'Pause audio' : 'Play audio'}
          className="flex-shrink-0 flex items-center justify-center w-12 h-12 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-full transition-colors"
        >
          {isLoading ? (
            <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-white" />
          ) : isPlaying ? (
            <Pause className="h-6 w-6 text-white" />
          ) : (
            <Play className="h-6 w-6 text-white ml-1" />
          )}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-white truncate" title={title}>{title}</span>
            <span
              className="flex-shrink-0 ml-3 text-sm text-white/50 font-mono tabular-nums"
              aria-label={`Current time: ${formatTime(currentTime)}, Total duration: ${formatTime(duration)}`}
            >
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
          <div
            role="slider"
            tabIndex={0}
            aria-label="Seek audio"
            aria-valuenow={Math.round(currentTime)}
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
            className="relative w-full h-6 flex items-center cursor-pointer group"
            onClick={handleSeek}
            onKeyDown={handleSeekKeyboard}
          >
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-white/[0.08]">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-100"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-accent border-2 border-surface-primary shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200"
              style={{ left: `calc(${progressPercent}% - 7px)` }}
              aria-hidden="true"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default AudioPlayer;


