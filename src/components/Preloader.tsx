import { useEffect, useRef, useState } from 'react';

interface PreloaderProps {
  onComplete: () => void;
}

const VIDEO_PAUSE_TIME = 3; // seconds — freeze the video here
const ZOOM_DURATION = 8200; // ms — zoom + fade + iris wipe (7.5s iris + 0.5s delay)

export default function Preloader({ onComplete }: PreloaderProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<'playing' | 'zooming' | 'done'>('playing');
  const [videoReady, setVideoReady] = useState(false);
  const hasSignaledReveal = useRef(false);

  // Safari autoplay fix: hide video until playback is confirmed so the user
  // never sees a flash of the native play button or broken state.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = true;
    video.playsInline = true;

    const onPlaying = () => setVideoReady(true);
    video.addEventListener('playing', onPlaying, { once: true });

    const attemptPlay = () => {
      video.play().catch(() => {
        // Autoplay truly blocked — skip preloader gracefully
        setPhase('done');
        onComplete();
      });
    };

    if (video.readyState >= 3) {
      attemptPlay();
    } else {
      video.addEventListener('canplay', attemptPlay, { once: true });
    }

    // If video never loads within 4s, skip preloader
    const timeout = setTimeout(() => {
      if (!video.currentTime) {
        setPhase('done');
        onComplete();
      }
    }, 4000);

    return () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('canplay', attemptPlay);
      clearTimeout(timeout);
    };
  }, [onComplete]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      if (video.currentTime >= VIDEO_PAUSE_TIME && phase === 'playing') {
        video.pause();
        setPhase('zooming');
      }
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    return () => video.removeEventListener('timeupdate', handleTimeUpdate);
  }, [phase]);

  // Signal hero content to start revealing once iris has opened enough (~0.9s in)
  useEffect(() => {
    if (phase !== 'zooming' || hasSignaledReveal.current) return;
    const revealTimer = setTimeout(() => {
      hasSignaledReveal.current = true;
      document.querySelector('.hero-waiting')?.classList.remove('hero-waiting');
    }, 1300);
    return () => clearTimeout(revealTimer);
  }, [phase]);

  // When zooming finishes, unmount the preloader overlay
  useEffect(() => {
    if (phase !== 'zooming') return;
    const timer = setTimeout(() => {
      setPhase('done');
      onComplete();
    }, ZOOM_DURATION);
    return () => clearTimeout(timer);
  }, [phase, onComplete]);

  // Fallback: if video fails to load, skip preloader after a brief pause
  const handleError = () => {
    setPhase('done');
    onComplete();
  };

  if (phase === 'done') return null;

  return (
    <div
      className={`preloader-overlay ${phase === 'zooming' ? 'preloader-zooming' : ''}`}
      aria-hidden="true"
    >
      <div className="preloader-video-wrapper">
        <video
          ref={videoRef}
          className="preloader-video"
          style={{ opacity: videoReady ? 1 : 0 }}
          preload="auto"
          playsInline
          onError={handleError}
        >
          <source src="/bok_reading_red_800.webm" type="video/webm" />
          <source src="/bok_reading_red_800_hevc.mp4" type='video/mp4; codecs="hvc1"' />
        </video>
      </div>
    </div>
  );
}
