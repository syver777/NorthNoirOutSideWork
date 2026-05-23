import React, { useState, useRef, useMemo } from 'react';
import { Play, X, CheckCircle2 } from 'lucide-react';
import {
  LEGACY_ITV_TOKENS_PER_SECOND,
  NEW_ITV_TOKENS_PER_SECOND,
  LEGACY_ITV_TOKENS_PER_SECOND_AUDIO,
  NEW_ITV_TOKENS_PER_SECOND_AUDIO,
} from '../data/tokenCosts';

// ─── ITV Model configuration ─────────────────────────────────────────────────

export interface ITVVideoModelConfig {
  value: string;
  label: string;
  tier: string;
  description: string;
  longDescription: string;
  tokensPerSecond: number;
  tokensPerSecondAudio?: number;
  supportsAudio: boolean;
  durationType: 'fixed' | 'options' | 'slider';
  defaultDuration: number;
  durationOptions: number[];
  durationMin?: number;
  durationMax?: number;
  selectable: boolean;
  resolution: string;
  exampleVideoUrl: string;
  borderColor: string;
  bgColor: string;
  textColor: string;
  badgeBg: string;
  badgeText: string;
  tierOrder: number;
  recommended?: boolean;
}

// Ordered by token cost (cheapest → most expensive)
export const ITV_VIDEO_MODEL_OPTIONS: ITVVideoModelConfig[] = [
  {
    value: 'wan22',
    label: 'Wan 2.2 ITV',
    tier: 'Entry',
    description: 'Cheapest ITV option',
    longDescription: 'Budget-friendly image-to-video generation. Fixed 5s clips at 480p.',
    tokensPerSecond: 6000,
    supportsAudio: false,
    durationType: 'fixed',
    defaultDuration: 5.06,
    durationOptions: [5],
    selectable: false,
    resolution: '480p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Wan22ITV/man_watching_battlefield.mp4',
    borderColor: 'border-orange-500',
    bgColor: 'bg-orange-900/40',
    textColor: 'text-orange-300',
    badgeBg: 'bg-orange-600',
    badgeText: 'text-white',
    tierOrder: 1,
  },
  {
    value: 'seedance1fast',
    label: 'Seedance 1.0 Fast ITV',
    tier: 'Entry',
    description: 'Fast & flexible',
    longDescription: 'Seedance 1.0 Pro Fast image-to-video. Quick turnaround at 720p with flexible 2–12s durations.',
    tokensPerSecond: 12960,
    supportsAudio: false,
    durationType: 'slider',
    defaultDuration: 5,
    durationOptions: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    durationMin: 2,
    durationMax: 12,
    selectable: true,
    resolution: '720p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Seedance1ITV/man_watching_battlefield.mp4',
    borderColor: 'border-cyan-500',
    bgColor: 'bg-cyan-900/40',
    textColor: 'text-cyan-300',
    badgeBg: 'bg-cyan-600',
    badgeText: 'text-white',
    tierOrder: 2,
  },
  {
    value: 'hailuo23fast',
    label: 'Hailuo 2.3 Fast ITV',
    tier: 'Standard',
    description: 'Best value for quality',
    longDescription: 'Excellent cinematic quality at an affordable price point. Choose between 6s and 10s clips.',
    tokensPerSecond: 19200,
    supportsAudio: false,
    durationType: 'options',
    defaultDuration: 6,
    durationOptions: [6, 10],
    selectable: true,
    resolution: '720p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Hailuo23ITV/man_watching_battlefield.mp4',
    borderColor: 'border-blue-500',
    bgColor: 'bg-blue-900/40',
    textColor: 'text-blue-300',
    badgeBg: 'bg-blue-600',
    badgeText: 'text-white',
    tierOrder: 3,
  },
  {
    value: 'seedance15',
    label: 'Seedance 1.5 Pro ITV',
    tier: 'Standard',
    description: 'High-quality motion with optional audio',
    longDescription: 'Seedance 1.5 Pro delivers premium motion fidelity at 1080p with flexible 4–12s durations and optional audio.',
    tokensPerSecond: 34800,
    tokensPerSecondAudio: 70200,
    supportsAudio: true,
    durationType: 'slider',
    defaultDuration: 5,
    durationOptions: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    durationMin: 4,
    durationMax: 12,
    selectable: true,
    resolution: '1080p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Seedance15ITV/man_watching_battlefield.mp4',
    borderColor: 'border-indigo-500',
    bgColor: 'bg-indigo-900/40',
    textColor: 'text-indigo-300',
    badgeBg: 'bg-indigo-600',
    badgeText: 'text-white',
    tierOrder: 4,
    recommended: true,
  },
  {
    value: 'ltx23fast',
    label: 'LTX 2.3 Fast ITV',
    tier: 'Plus',
    description: '1440p with audio',
    longDescription: 'LTX 2.3 Fast image-to-video at 1440p resolution with optional native audio generation.',
    tokensPerSecond: 48000,
    supportsAudio: true,
    durationType: 'options',
    defaultDuration: 6,
    durationOptions: [6, 8, 10],
    selectable: true,
    resolution: '1440p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/LTX23FastITV/warrior_battlefield_ltx23fast.mp4',
    borderColor: 'border-purple-500',
    bgColor: 'bg-purple-900/40',
    textColor: 'text-purple-300',
    badgeBg: 'bg-purple-600',
    badgeText: 'text-white',
    tierOrder: 5,
  },
  {
    value: 'veo31fast',
    label: 'Veo 3.1 Fast ITV',
    tier: 'Pro',
    description: 'Google Veo, fast mode',
    longDescription: 'Google\'s Veo 3.1 in fast mode with optional audio. High-quality 1080p output.',
    tokensPerSecond: 60000,
    tokensPerSecondAudio: 90000,
    supportsAudio: true,
    durationType: 'options',
    defaultDuration: 4,
    durationOptions: [4, 6, 8],
    selectable: true,
    resolution: '1080p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Veo31FastITV/warrior_battlefield_veo31_fast.mp4',
    borderColor: 'border-teal-500',
    bgColor: 'bg-teal-900/40',
    textColor: 'text-teal-300',
    badgeBg: 'bg-teal-600',
    badgeText: 'text-white',
    tierOrder: 6,
  },
  {
    value: 'ltx23pro',
    label: 'LTX 2.3 Pro ITV',
    tier: 'Pro',
    description: '1440p premium with audio',
    longDescription: 'LTX 2.3 Pro image-to-video at 1440p resolution with optional native audio. Premium quality.',
    tokensPerSecond: 72000,
    supportsAudio: true,
    durationType: 'options',
    defaultDuration: 6,
    durationOptions: [6, 8, 10],
    selectable: true,
    resolution: '1440p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/LTX23ProITV/warrior_battlefield_ltx23pro.mp4',
    borderColor: 'border-rose-500',
    bgColor: 'bg-rose-900/40',
    textColor: 'text-rose-300',
    badgeBg: 'bg-rose-600',
    badgeText: 'text-white',
    tierOrder: 7,
  },
  {
    value: 'veo31',
    label: 'Veo 3.1 ITV',
    tier: 'Elite',
    description: 'Google\'s top video AI',
    longDescription: 'Google\'s premium Veo 3.1 model with optional audio. State-of-the-art realism at 1080p.',
    tokensPerSecond: 120000,
    tokensPerSecondAudio: 240000,
    supportsAudio: true,
    durationType: 'options',
    defaultDuration: 4,
    durationOptions: [4, 6, 8],
    selectable: true,
    resolution: '1080p',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Veo31ITV/warrior_battlefield_veo31.mp4',
    borderColor: 'border-emerald-500',
    bgColor: 'bg-emerald-900/40',
    textColor: 'text-emerald-300',
    badgeBg: 'bg-emerald-600',
    badgeText: 'text-white',
    tierOrder: 8,
  },
  {
    value: 'ltx23pro4k',
    label: 'LTX 2.3 Pro 4K ITV',
    tier: 'Ultimate',
    description: 'Ultra HD 4K with audio',
    longDescription: 'Full 4K (2160p) image-to-video with optional native audio. The ultimate ITV quality.',
    tokensPerSecond: 144000,
    supportsAudio: true,
    durationType: 'options',
    defaultDuration: 6,
    durationOptions: [6, 8, 10],
    selectable: true,
    resolution: '4K (2160p)',
    exampleVideoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/LTX23Pro4KITV/warrior_battlefield_ltx23pro4k.mp4',
    borderColor: 'border-amber-400',
    bgColor: 'bg-amber-900/40',
    textColor: 'text-amber-300',
    badgeBg: 'bg-gradient-to-r from-amber-500 to-yellow-400',
    badgeText: 'text-gray-900',
    tierOrder: 9,
  },
];

// Token lookup maps (LEGACY — module-scope default mirrors the data layer).
export const ITV_TOKENS_PER_SECOND: Record<string, number> = LEGACY_ITV_TOKENS_PER_SECOND;

export const ITV_AUDIO_TOKENS_PER_SECOND: Record<string, number> = LEGACY_ITV_TOKENS_PER_SECOND_AUDIO;

// Returns a plan-aware copy of ITV_VIDEO_MODEL_OPTIONS with per-second token
// rates swapped in from the active plan map.
export function buildITVVideoModelOptions(isLegacy: boolean): ITVVideoModelConfig[] {
  const tps = isLegacy ? LEGACY_ITV_TOKENS_PER_SECOND : NEW_ITV_TOKENS_PER_SECOND;
  const aps = isLegacy ? LEGACY_ITV_TOKENS_PER_SECOND_AUDIO : NEW_ITV_TOKENS_PER_SECOND_AUDIO;
  return ITV_VIDEO_MODEL_OPTIONS.map(m => ({
    ...m,
    tokensPerSecond: tps[m.value] ?? m.tokensPerSecond,
    tokensPerSecondAudio: m.tokensPerSecondAudio !== undefined ? (aps[m.value] ?? m.tokensPerSecondAudio) : undefined,
  }));
}

export const ITV_AUDIO_SUPPORTED_MODELS = new Set(
  ITV_VIDEO_MODEL_OPTIONS.filter(m => m.supportsAudio).map(m => m.value)
);

// Estimated seconds per video clip for time-remaining display
export const ITV_SECONDS_PER_VIDEO: Record<string, number> = {
  wan22: 90,
  seedance1fast: 90,
  hailuo23fast: 150,
  seedance15: 120,
  ltx23fast: 90,
  veo31fast: 120,
  ltx23pro: 120,
  veo31: 180,
  ltx23pro4k: 180,
};
export const ITV_DEFAULT_SECONDS_PER_VIDEO = 120;

// ─── Video preview card ───────────────────────────────────────────────────────

interface ITVModelCardProps {
  model: ITVVideoModelConfig;
  isSelected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}

function ITVModelCard({ model, isSelected, onSelect, disabled }: ITVModelCardProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!model.exampleVideoUrl) return;
    setIsPlaying(true);
    setTimeout(() => videoRef.current?.play(), 50);
  };

  const handleVideoClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsPlaying(false);
    videoRef.current?.pause();
    if (videoRef.current) videoRef.current.currentTime = 0;
  };

  const durationLabel =
    model.durationType === 'fixed'
      ? `${model.defaultDuration}s fixed`
      : model.durationType === 'slider'
      ? `${model.durationMin}–${model.durationMax}s`
      : model.durationOptions.map(d => `${d}s`).join(' · ');

  const secsPerClip = ITV_SECONDS_PER_VIDEO[model.value] ?? ITV_DEFAULT_SECONDS_PER_VIDEO;
  const timePerClipLabel =
    secsPerClip >= 60
      ? `~${Math.round(secsPerClip / 60)} min/clip`
      : `~${secsPerClip}s/clip`;

  return (
    <div
      onClick={() => !disabled && onSelect()}
      className={`relative rounded-xl border-2 transition-all cursor-pointer ${
        isSelected
          ? `${model.borderColor} ${model.bgColor} ring-1 ring-white/10`
          : 'border-border-card bg-surface-card hover:border-white/20'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      {/* Recommended badge – card corner */}
      {model.recommended && (
        <div className="absolute -top-2 -right-2 bg-green-500 text-white text-xs px-2 py-1 rounded-full z-10">
          Recommended
        </div>
      )}

      {/* Video preview area */}
      <div className="relative aspect-video bg-gray-900 overflow-hidden">
        {isPlaying ? (
          <>
            <video
              ref={videoRef}
              src={model.exampleVideoUrl}
              className="w-full h-full object-cover"
              controls
              autoPlay
              preload="metadata"
              onEnded={() => setIsPlaying(false)}
            />
            <button
              onClick={handleVideoClose}
              className="absolute top-2 right-2 bg-black/70 hover:bg-black/90 text-white rounded-full p-1 z-10"
            >
              <X className="h-4 w-4" />
            </button>
          </>
        ) : (
          <>
            <video
              src={model.exampleVideoUrl}
              className="w-full h-full object-cover"
              preload="metadata"
              muted
              playsInline
            />
            <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
              <button
                onClick={handlePlay}
                className="bg-white/20 hover:bg-white/30 backdrop-blur-sm rounded-full p-3 transition-colors"
              >
                <Play className="h-6 w-6 text-white fill-white" />
              </button>
            </div>
          </>
        )}
        {model.supportsAudio && (
          <div className="absolute bottom-2 left-2 bg-black/60 text-white text-xs px-2 py-0.5 rounded-full">
            🔊 Audio
          </div>
        )}
        {isSelected && (
          <div className="absolute top-2 right-2 bg-white rounded-full p-0.5">
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-3">
        <div className="mb-1">
          <h3 className={`font-medium text-sm ${isSelected ? model.textColor : 'text-white'}`}>{model.label}</h3>
        </div>
        <p className="text-xs text-gray-400 mb-2">{model.description}</p>
        <div className="space-y-0.5">
          <div className="text-sm font-bold text-white">
            {model.tokensPerSecond.toLocaleString()} <span className="text-xs font-normal text-gray-400">tokens/s</span>
          </div>
          <div className="text-xs text-gray-500">Durations: {durationLabel}</div>
          <div className="text-xs text-gray-500">{model.resolution}</div>
          <div className="text-xs text-gray-500">Creation time: {timePerClipLabel}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface ITVVideoModelSelectorProps {
  selectedModel: string;
  onModelChange: (model: string) => void;
  disabled?: boolean;
  /** Defaults to true (legacy plan rates) so unspecified callers stay safe. */
  isLegacy?: boolean;
}

const ITVVideoModelSelector: React.FC<ITVVideoModelSelectorProps> = ({
  selectedModel,
  onModelChange,
  disabled,
  isLegacy = true,
}) => {
  const options = useMemo(() => buildITVVideoModelOptions(isLegacy), [isLegacy]);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {options.map((model) => (
          <ITVModelCard
            key={model.value}
            model={model}
            isSelected={selectedModel === model.value}
            onSelect={() => onModelChange(model.value)}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
};

export default ITVVideoModelSelector;
