import { useEffect, useRef } from 'react';

/**
 * Returns a ref to attach to a <video> element.
 * Works around Safari's autoplay policy by setting muted/playsInline
 * via the DOM (bypassing React's attribute timing issue) and calling
 * .play() programmatically once the video has enough data.
 */
export function useSafariAutoplay<T extends HTMLVideoElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    video.muted = true;
    video.playsInline = true;

    const attemptPlay = () => {
      video.play().catch(() => {
        // Silently fail — user will see a paused video, which is acceptable
      });
    };

    if (video.readyState >= 3) {
      attemptPlay();
    } else {
      video.addEventListener('canplay', attemptPlay, { once: true });
    }

    return () => {
      video.removeEventListener('canplay', attemptPlay);
    };
  }, []);

  return ref;
}
