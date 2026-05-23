import React, { useRef, useState, useMemo } from 'react';
import { Play, CheckCircle2 } from 'lucide-react';
import { MG_STYLES, MGStyleConfig } from '../data/mgStyles';

// Storage bucket where the example MP4s live.
const MG_STYLE_BUCKET_URL =
  'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff';

function getMGStyleVideoUrl(path: string): string {
  return `${MG_STYLE_BUCKET_URL}/${path}`;
}

interface MGStyleVideoCardProps {
  style: MGStyleConfig;
  isSelected: boolean;
  onClick: () => void;
  disabled?: boolean;
}

function MGStyleVideoCard({ style, isSelected, onClick, disabled }: MGStyleVideoCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const handleMouseEnter = () => {
    if (disabled) return;
    videoRef.current?.play().then(() => setIsPlaying(true)).catch(() => {});
  };
  const handleMouseLeave = () => {
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
      setIsPlaying(false);
    }
  };

  const videoUrl = getMGStyleVideoUrl(style.example_video_path);

  return (
    <div
      className={`relative bg-surface-elevated rounded-xl overflow-hidden transition-all duration-200 ${
        disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
      } ${
        isSelected ? 'ring-2 ring-accent-text' : 'hover:ring-2 hover:ring-border-subtle'
      }`}
      onClick={() => { if (!disabled) onClick(); }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="aspect-video w-full relative">
        <video
          ref={videoRef}
          src={videoUrl}
          className="w-full h-full object-cover"
          preload="metadata"
          muted
          loop
          playsInline
        />
        <div
          className={`absolute inset-0 flex items-center justify-center transition-opacity duration-200 pointer-events-none ${
            isPlaying ? 'opacity-0' : 'bg-black/25'
          }`}
        >
          <div className="w-10 h-10 bg-black/60 rounded-full flex items-center justify-center">
            <Play className="h-5 w-5 text-white ml-0.5" />
          </div>
        </div>
      </div>
      <div className="p-4">
        <h3 className="text-base font-medium text-white mb-1">{style.display_name}</h3>
        <p className="text-sm text-text-dim">{style.description}</p>
      </div>
      {isSelected && (
        <div className="absolute top-2 right-2 bg-accent text-white rounded-full p-1">
          <CheckCircle2 className="h-5 w-5" />
        </div>
      )}
    </div>
  );
}

interface MGStyleSelectorProps {
  selectedStyleSlug: string;
  onSelect: (slug: string) => void;
  disabled?: boolean;
}

/**
 * Big 16-card visual picker for Motion Graphics styles.
 * Mirrors the TTV `StyleVideoCard` UX: autoplaying preview on hover, ring
 * highlight when selected, "Show More" reveal of the full catalog.
 */
const MGStyleSelector: React.FC<MGStyleSelectorProps> = ({ selectedStyleSlug, onSelect, disabled }) => {
  const [showAll, setShowAll] = useState(false);

  const activeStyles = useMemo(
    () => MG_STYLES.filter(s => s.is_active).sort((a, b) => a.order_index - b.order_index),
    [],
  );
  const visible = showAll ? activeStyles : activeStyles.slice(0, 4);

  return (
    <div>
      <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-4">
        Visual Style
      </label>
      <div className="grid md:grid-cols-2 gap-6">
        {visible.map((s) => (
          <MGStyleVideoCard
            key={s.slug}
            style={s}
            isSelected={selectedStyleSlug === s.slug}
            onClick={() => onSelect(s.slug)}
            disabled={disabled}
          />
        ))}
      </div>
      {activeStyles.length > 4 && (
        <div className="flex justify-center mt-4">
          <button
            onClick={() => setShowAll(prev => !prev)}
            className="px-4 py-2 bg-white/10 text-white rounded-xl hover:bg-white/15 transition-colors"
          >
            {showAll ? 'Show Less' : `Show More +${activeStyles.length - 4}`}
          </button>
        </div>
      )}
    </div>
  );
};

export default MGStyleSelector;
