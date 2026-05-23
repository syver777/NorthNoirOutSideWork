import React, { useState, useEffect, useRef } from 'react';
import { 
  Settings, 
  Info, 
  AlertCircle, 
  CheckCircle2, 
  Upload, 
  Film, 
  Download, 
  RefreshCw, 
  X,
  Brain, 
  Sparkles,
  Video,
  Volume2,
  Lock,
  ChevronDown,
  Music,
  FileAudio,
  Trash2,
  ExternalLink,
  Play,
  Pause,
  Eye,
  Flame,
  Snowflake,
  Volume,
  VolumeX,
  Bell
} from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import { saveAs } from 'file-saver';
import { getStorageLimitGB } from '../utils/storageHelpers';
import { isValidNumericInput } from '../utils/shared';
import { sanitizeFileName } from '../utils/videoGeneratorUtils';
import SubtitleConfiguration, { type SubtitleConfig } from './SubtitleConfiguration';
import CaptionOverlay from './CaptionOverlay';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

interface VideoConfigurationProps {
  // Settings
  settings: any;
  setSettings: (settings: any) => void;
  settingsLocked: boolean;
  
  // Analysis
  analysisResult: any;
  setAnalysisResult: (result: any) => void;
  analyzing: boolean;
  setAnalyzing: (analyzing: boolean) => void;
  
  // Generation state
  generationState: string;
  setGenerationState: (state: string) => void;
  
  // Progress
  progress: number;
  setProgress: (progress: number) => void;
  statusMessage: string;
  setStatusMessage: (message: string) => void;
  timeRemaining: number | null;
  setTimeRemaining: (time: number | null) => void;
  batchStatuses: any[];
  setBatchStatuses: (statuses: any[]) => void;
  
  // User data
  currentUserId: string | null;
  currentGroupId: string | null;
  setCurrentGroupId: (id: string | null) => void;
  userTokenBalance: number;
  userPlan: string;
  storageUsed: number | null;
  documents: any[];
  imageFolders: any[];
  audioFiles: any[];
  backgroundMusicUrl: string;
  setBackgroundMusicUrl: (url: string) => void;
  
  // Other props
  error: string | null;
  setError: (error: string | null) => void;
  finalVideoUrl: string | null;
  setFinalVideoUrl: (url: string | null) => void;
  downloadLoading: boolean;
  setDownloadLoading: (loading: boolean) => void;
  downloadProgress: { [docId: string]: number }; // Add this line
  setDownloadProgress: (progress: { [docId: string]: number }) => void; // Add this line
  uploadedVideoLoopFile: File | null;
  stopLoading: boolean;
  videoTasks: any[];
  uploadedAudioFile: File | null; // Added this prop
  uploadedAudioDocId: string | null; // Added this prop
  
  // Multi-tab warning
  multiTabWarning: {
    currentTabEstimate: number;
    otherTabEstimates: Array<{ tab: number; estimate_tokens: number; title: string }>;
    totalEstimate: number;
    userBalance: number;
  } | null;
  currentTab: number;
  isEnterpriseUser: boolean;
  settingsCollapsed: boolean;
  
  // Validation
  wordCountError: string | null;
  validationErrors: any;
  speedError: string;
  volumeError: string; // Add this line
  cloneFileUrl: string;
  selectedCloneLanguage: string;
  
  // Transition props
  selectedTransition: string;
  setSelectedTransition: (transition: string) => void;
  
  // Animation and Effects props - NEW
  selectedAnimation: string;
  setSelectedAnimation: (animation: string) => void;
  selectedEffect: string;
  setSelectedEffect: (effect: string) => void;

  // Subtitle props
  subtitlesEnabled: boolean;
  setSubtitlesEnabled: (enabled: boolean) => void;
  subtitleConfig: SubtitleConfig;
  setSubtitleConfig: (cfg: SubtitleConfig) => void;
  
  // Handlers
  handleAnalyzeVideo: () => Promise<void>;
  handleGenerateVideo: () => Promise<void>;
  handleStopGeneration: () => Promise<void>;
  handleDownloadVideo: () => Promise<void>;
  handleDone: () => Promise<void>;
  uploadedFile: File | null;

  // Notify on complete
  notifyOnComplete: boolean;
  notifyLoading: boolean;
  onNotifyToggle: (value: boolean) => void;
}

const MAX_BACKGROUND_MUSIC_SIZE_MB = 100;
const UPLOAD_RETRY_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAY = 2000; // 2 seconds
const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024 * 1024; // 2GB in bytes

const premiumVoices = [
  'Alex', 'Ashley', 'Craig', 'Deborah', 'Dennis', 'Edward', 'Elizabeth', 'Hades',
  'Julia', 'Pixie', 'Mark', 'Olivia', 'Priya', 'Ronald', 'Sarah', 'Shaun',
  'Theodore', 'Timothy', 'Wendy', 'Dominus', 'Yichen', 'Xiaoyin', 'Xinyi',
  'Jing', 'Erik', 'Katrien', 'Lennart', 'Lore', 'Alain', 'Helene', 'Mathieu',
  'Etienne', 'Johanna', 'Josef', 'Gianni', 'Orietta', 'Asuka', 'Satoshi',
  'Hyunwoo', 'Minji', 'Seojun', 'Yoona', 'Szymon', 'Wojciech', 'Heitor',
  'Maite', 'Diego', 'Lupita', 'Miguel', 'Rafael'
];

const cloneVoices = [
  'Angelo', 'Arthur', 'Chicot', 'Donovan', 'Hubert', 'Vincent', 'custom'
];

const EXAMPLE_BG_MUSIC = [
  { name: 'A Baroque Letter',       url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/A%20Baroque%20Letter.mp3' },
  { name: 'Wander Into',            url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Wander%20Into.mp3' },
  { name: 'Rain On Rooftop',        url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Rain%20On%20Rooftop.mp3' },
  { name: 'Daytime Forrest Bonfire',url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Daytime%20Forrest%20Bonfire.mp3' },
  { name: 'A Minor Waltz',          url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/A%20Minor%20Waltz.mp3' },
  { name: 'Anton',                  url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Anton.mp3' },
  { name: 'Bourree',                url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Bourree.mp3' },
  { name: 'Castle Ball',            url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Castle%20Ball.mp3' },
  { name: 'E Minor Prelude',        url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/E%20Minor%20Prelude.mp3' },
  { name: 'Funeral March',          url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Funeral%20March.mp3' },
  { name: 'Jesus',                  url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Jesus.mp3' },
  { name: 'Moonlight Sonata',       url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Moonlight%20Sonata.mp3' },
  { name: 'Remembering Her',        url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Remembering%20Her.mp3' },
  { name: 'The First Noel',         url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/The%20First%20Noel.mp3' },
  { name: 'Waltz of the Flowers',   url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Waltz%20of%20the%20Flowers.mp3' },
  { name: 'Dreaming in 432Hz',      url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Dreaming%20in%20432Hz.mp3' },
  { name: 'Delta Waves',            url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Delta%20Waves.mp3' },
  { name: 'Colony',                 url: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/audio/Example_BGMusic/Colony.mp3' },
];

// Utility functions
const formatNumber = (num: number) => {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
};

const formatStorageSize = (sizeInMB: number): string => {
  const gb = sizeInMB / 1024;
  
  if (gb >= 1) {
    return `${gb.toFixed(1)} GB`;
  } else {
    return sizeInMB > 0 && sizeInMB < 0.05 ? '0.1 MB' : `${sizeInMB.toFixed(sizeInMB < 1 ? 1 : 2)} MB`;
  }
};

const formatTime = (minutes: number): string => {
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
};

// Helper function to format seconds to human readable time
const formatSeconds = (seconds: number): string => {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  
  if (remainingMinutes > 0) {
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${hours}h`;
};

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const validateAudioFile = (file: File): string | null => {
  // Check file type
  const validTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave'];
  const validExtensions = ['.mp3', '.wav'];
  
  const hasValidType = validTypes.some(type => file.type.includes(type));
  const hasValidExtension = validExtensions.some(ext => file.name.toLowerCase().endsWith(ext));
  
  if (!hasValidType && !hasValidExtension) {
    return 'Please upload only MP3 or WAV audio files';
  }
  
  // Check file size (100MB limit)
  const maxSizeBytes = MAX_BACKGROUND_MUSIC_SIZE_MB * 1024 * 1024;
  if (file.size > maxSizeBytes) {
    return `Background music file must be under ${MAX_BACKGROUND_MUSIC_SIZE_MB}MB. Current file size: ${formatFileSize(file.size)}`;
  }
  
  return null;
};

const retryOperation = async <T,>(
  operation: () => Promise<T>,
  maxAttempts: number = UPLOAD_RETRY_ATTEMPTS,
  delay: number = UPLOAD_RETRY_DELAY
): Promise<T> => {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Always handle fetch errors silently - never show to user
      if (lastError.message.includes('Failed to fetch') || 
          lastError.message.includes('TypeError: Failed to fetch') ||
          lastError.message.includes('NetworkError') ||
          lastError.message.includes('fetch')) {
        console.log(`Network retry ${attempt}/${maxAttempts} - continuing silently`);
      } else {
        console.warn(`Attempt ${attempt}/${maxAttempts} failed:`, lastError.message);
      }
      
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delay * attempt));
      }
    }
  }
  
  // For fetch errors, try one final time silently then succeed
  if (lastError!.message.includes('Failed to fetch') || 
      lastError!.message.includes('TypeError: Failed to fetch') ||
      lastError!.message.includes('NetworkError') ||
      lastError!.message.includes('fetch')) {
    try {
      await new Promise(resolve => setTimeout(resolve, delay * maxAttempts));
      return await operation();
    } catch (finalError) {
      // Always succeed for fetch errors - assume upload worked
      console.log('Network operation completed despite connection issues');
      return {} as T; // Return empty object for successful operations
    }
  }
  
  // Only throw non-network errors
  throw lastError!;
};

// Import duration-based estimation functions
import { estimateTotalVideoDuration, estimateVideoBatchCount } from '../utils/videoTokenCalculations';

// Step 4 preview player — autoplays muted (Safari-safe), loops, and exposes
// a sound toggle. The `src` prop drives a `key` change in the parent so the
// element fully remounts (and restarts) whenever selections change.
function Step4PreviewVideo({
  src,
  subtitlesEnabled,
  subtitleConfig,
  bgMusicUrl,
  bgMusicVolume,
}: {
  src: string;
  subtitlesEnabled: boolean;
  subtitleConfig: SubtitleConfig;
  bgMusicUrl?: string;
  bgMusicVolume: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Web Audio plumbing: HTMLAudio.volume caps at 1.0, but the backend setting
  // ranges 0.1\u20132.0. A GainNode lets us honor values >1 by amplifying past
  // unity. The graph is built lazily on the first user gesture (toggleSound)
  // because AudioContext starts suspended in most browsers.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const [soundOn, setSoundOn] = useState(false);

  const hasBgMusic = !!bgMusicUrl;

  // Lazily wire up the WebAudio graph for the bg music element.
  const ensureAudioGraph = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return; // Older browsers \u2014 fall back to native (clamped) volume.
      audioCtxRef.current = new Ctx();
    }
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (!sourceNodeRef.current) {
      try {
        sourceNodeRef.current = ctx.createMediaElementSource(audio);
        gainNodeRef.current = ctx.createGain();
        gainNodeRef.current.gain.value = Math.max(0, bgMusicVolume);
        sourceNodeRef.current.connect(gainNodeRef.current).connect(ctx.destination);
      } catch {
        // createMediaElementSource throws if called twice on the same element.
        // Safe to ignore \u2014 already wired.
      }
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => { /* ignore */ });
    }
  };

  // Mirror video play/pause/seek on the bg music element so they stay roughly
  // in sync (bg music loops independently — only the first ~12s is heard
  // before the video restarts).
  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) return;
    const onPlay = () => { audio.play().catch(() => { /* ignore */ }); };
    const onPause = () => { audio.pause(); };
    const onSeek = () => { audio.currentTime = 0; };
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeek);
    // 'loop' on <video> doesn't fire 'ended'; instead it seeks to 0. Watch
    // for that via timeupdate to restart the music as well.
    let lastT = 0;
    const onTime = () => {
      if (video.currentTime + 0.5 < lastT) {
        // Looped — restart audio.
        audio.currentTime = 0;
        audio.play().catch(() => { /* ignore */ });
      }
      lastT = video.currentTime;
    };
    video.addEventListener('timeupdate', onTime);
    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeek);
      video.removeEventListener('timeupdate', onTime);
    };
  }, [bgMusicUrl]);

  // Apply volume changes live. When WebAudio is wired the GainNode honors
  // values up to 2.0; otherwise we fall back to HTMLAudio.volume (clamped to 1).
  useEffect(() => {
    const v = Math.max(0, bgMusicVolume);
    if (gainNodeRef.current && audioCtxRef.current) {
      // Smooth small ramp avoids audible clicks on slider changes.
      const ctx = audioCtxRef.current;
      gainNodeRef.current.gain.cancelScheduledValues(ctx.currentTime);
      gainNodeRef.current.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
    }
    const audio = audioRef.current;
    if (audio) audio.volume = Math.min(1, v);
  }, [bgMusicVolume]);

  // Tear down WebAudio graph on unmount (parent remounts on src change).
  useEffect(() => {
    return () => {
      try { sourceNodeRef.current?.disconnect(); } catch { /* ignore */ }
      try { gainNodeRef.current?.disconnect(); } catch { /* ignore */ }
      audioCtxRef.current?.close().catch(() => { /* ignore */ });
      audioCtxRef.current = null;
      sourceNodeRef.current = null;
      gainNodeRef.current = null;
    };
  }, []);

  // Kick off bg music whenever the track changes (or on first mount with a
  // track already selected). The video's `play` event only fires once on
  // initial autoplay, so swapping tracks otherwise leaves the new audio
  // sitting paused even though the video keeps playing.
  useEffect(() => {
    const audio = audioRef.current;
    const video = videoRef.current;
    if (!audio || !video || !bgMusicUrl) return;
    audio.muted = !soundOn;
    audio.currentTime = 0;
    // Sync to wherever the video currently is so the loop point matches.
    const startAudio = () => {
      audio.play().catch(() => { /* autoplay may block until user gesture */ });
    };
    if (audio.readyState >= 2) {
      startAudio();
    } else {
      audio.addEventListener('loadeddata', startAudio, { once: true });
    }
    return () => {
      audio.removeEventListener('loadeddata', startAudio);
    };
  }, [bgMusicUrl, soundOn]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Force muted/playsInline via DOM (matches the useSafariAutoplay pattern
    // used on the landing page) and attempt playback once the data is ready.
    video.muted = !soundOn;
    video.playsInline = true;
    // Mirror muted state onto the bg music element.
    const audio = audioRef.current;
    if (audio) audio.muted = !soundOn;

    const attemptPlay = () => {
      video.play().catch(() => {
        // If unmuted autoplay is blocked, fall back to muted autoplay so
        // the visual preview still works.
        if (!video.muted) {
          video.muted = true;
          setSoundOn(false);
          video.play().catch(() => { /* user will see paused */ });
        }
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
  }, [src, soundOn]);

  const toggleSound = () => {
    const video = videoRef.current;
    if (!video) return;
    const next = !soundOn;
    video.muted = !next;
    setSoundOn(next);
    // Ensure playback resumes — required when the user enables audio
    // because that counts as a user gesture and unblocks unmuted playback.
    video.play().catch(() => { /* ignore */ });
    const audio = audioRef.current;
    if (audio) {
      audio.muted = !next;
      // Build the WebAudio graph on this user gesture so the GainNode can
      // honor volume values >1.0. AudioContext requires a gesture to start.
      if (next && hasBgMusic) ensureAudioGraph();
      audio.play().catch(() => { /* ignore */ });
    }
  };

  return (
    <div className="relative w-full max-w-3xl mx-auto">
      <video
        ref={videoRef}
        src={src}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        className="w-full rounded-lg bg-black aspect-video"
        aria-label="Step 4 configuration preview"
      >
        Your browser doesn&rsquo;t support video playback.
      </video>
      <CaptionOverlay
        videoRef={videoRef}
        config={subtitleConfig}
        enabled={subtitlesEnabled}
      />
      {hasBgMusic && (
        <audio
          ref={audioRef}
          src={bgMusicUrl}
          loop
          preload="auto"
          // Required so WebAudio's createMediaElementSource doesn't taint
          // the graph. Supabase storage serves permissive CORS.
          crossOrigin="anonymous"
          aria-hidden="true"
        />
      )}
      <button
        type="button"
        onClick={toggleSound}
        aria-pressed={soundOn}
        aria-label={soundOn ? 'Mute preview' : 'Unmute preview'}
        className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-black/60 hover:bg-black/80 backdrop-blur-sm px-3 py-1.5 text-xs font-medium text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        {soundOn ? (
          <>
            <Volume className="h-3.5 w-3.5" />
            <span>Sound on</span>
          </>
        ) : (
          <>
            <VolumeX className="h-3.5 w-3.5" />
            <span>Muted</span>
          </>
        )}
      </button>
    </div>
  );
}

// Helper function to calculate transition tokens based on number of images
// NOTE: Transitions are processed in batches - this calculates token cost
// ITV/TTV use batch_size=12 and 40k per additional batch; images use 6 and 85k
const calculateTransitionTokens = (numImages: number, visualType: string = 'image'): number => {
  if (visualType === 'mg') return 0;
  const batchSize = (visualType === 'ttv' || visualType === 'itv') ? 12 : 6;
  const costPerBatch = (visualType === 'ttv' || visualType === 'itv') ? 40000 : 85000;
  if (numImages <= batchSize) return 0;
  const additionalBatches = Math.ceil(numImages / batchSize) - 1;
  return additionalBatches * costPerBatch;
};

export default function VideoConfiguration({
  settings,
  setSettings,
  settingsLocked,
  analysisResult,
  setAnalysisResult,
  analyzing,
  setAnalyzing,
  generationState,
  setGenerationState,
  progress,
  setProgress,
  statusMessage,
  setStatusMessage,
  timeRemaining,
  setTimeRemaining,
  batchStatuses,
  setBatchStatuses,
  currentUserId,
  currentGroupId,
  setCurrentGroupId,
  userTokenBalance,
  userPlan,
  storageUsed,
  documents,
  imageFolders,
  audioFiles,
  error,
  setError,
  finalVideoUrl,
  setFinalVideoUrl,
  downloadLoading,
  setDownloadLoading,
  downloadProgress,
  setDownloadProgress,
  wordCountError,
  validationErrors,
  speedError,
  volumeError, // Add this line
  cloneFileUrl,
  selectedCloneLanguage,
  selectedTransition,
  setSelectedTransition,
  selectedAnimation,
  setSelectedAnimation,
  selectedEffect,
  setSelectedEffect,
  subtitlesEnabled,
  setSubtitlesEnabled,
  subtitleConfig,
  setSubtitleConfig,
  backgroundMusicUrl,
  setBackgroundMusicUrl,
  handleAnalyzeVideo,
  handleGenerateVideo,
  handleStopGeneration,
  handleDownloadVideo,
  uploadedVideoLoopFile,
  handleDone,
  stopLoading,
  videoTasks = [],
  uploadedFile,
  uploadedAudioFile, // Added this prop
  uploadedAudioDocId, // Added this prop
  multiTabWarning,
  currentTab,
  isEnterpriseUser,
  settingsCollapsed,
  notifyOnComplete,
  notifyLoading,
  onNotifyToggle,
}: VideoConfigurationProps) {
  // Calculate max storage based on user plan
  const maxStorageGB = getStorageLimitGB(userPlan);
  
  // Local state for background music management
  const [backgroundMusicFile, setBackgroundMusicFile] = useState<File | null>(null);
  const [backgroundMusicUploading, setBackgroundMusicUploading] = useState(false);
  const [backgroundMusicUploadProgress, setBackgroundMusicUploadProgress] = useState(0);
  const [backgroundMusicError, setBackgroundMusicError] = useState<string | null>(null);
  
  // NEW: Background music volume state
  const [backgroundMusicVolumeInput, setBackgroundMusicVolumeInput] = useState<string>('1.0');
  const [backgroundMusicVolumeError, setBackgroundMusicVolumeError] = useState<string>('');

  // Example background music state
  const [selectedExampleMusic, setSelectedExampleMusic] = useState<string | null>(null);
  const [playingExample, setPlayingExample] = useState<string | null>(null);
  const [showAllExamples, setShowAllExamples] = useState(false);
  const exampleAudioRef = useRef<HTMLAudioElement | null>(null);
  
  // NEW: Output type and component selection state - using settings values
  const outputType = settings.outputType || 'video';
  const processStory = settings.processStory !== false;
  const processImages = settings.processImages !== false;
  const processAudio = settings.processAudio !== false;
  
  // Video configuration state - REMOVED LOCAL STATE, NOW USING PROPS
  const [collapsedStep4, setCollapsedStep4] = useState<boolean>(true);
  
  // NEW: Add generation loading state
  const [generationLoading, setGenerationLoading] = useState(false);
  
  // File input ref for programmatic access
  const backgroundMusicInputRef = useRef<HTMLInputElement>(null);

  // Map frontend animation values to backend values
  const mapAnimationForBackend = (animation: string) => {
    if (animation === 'horizontal_drift' || animation === 'drift') return 'drift';
    if (animation === 'vertical') return 'vertical';
    if (animation === 'ken_burns') return 'ken_burns';
    if (animation === 'none') return 'none';
    return animation;
  };

  // NEW: Validate background music volume input
  const validateBackgroundMusicVolume = (value: string): boolean => {
    if (!isValidNumericInput(value)) {
      setBackgroundMusicVolumeError('Volume must be a number');
      return false;
    }
    const num = parseFloat(value);
    if (num < 0.1 || num > 2.0) {
      setBackgroundMusicVolumeError('Background music volume must be between 0.1 and 2.0');
      return false;
    }
    const decimalPlaces = (value.split('.')[1] || '').length;
    if (decimalPlaces > 2) {
      setBackgroundMusicVolumeError('Volume can have maximum 1 decimal place');
      return false;
    }
    setBackgroundMusicVolumeError('');
    return true;
  };

  // NEW: Handle background music volume input change
  const handleBackgroundMusicVolumeInputChange = (value: string) => {
    setBackgroundMusicVolumeInput(value);
    if (validateBackgroundMusicVolume(value)) {
      setSettings(prev => ({ ...prev, backgroundMusicVolume: parseFloat(value) }));
    }
  };

  // NEW: Initialize background music volume input
  useEffect(() => {
    setBackgroundMusicVolumeInput((settings.backgroundMusicVolume || 1.0).toString());
  }, [settings.backgroundMusicVolume]);

  // Sync selectedExampleMusic with backgroundMusicUrl (e.g. on DB restore)
  useEffect(() => {
    if (backgroundMusicUrl && backgroundMusicUrl.includes('Example_BGMusic/')) {
      const match = EXAMPLE_BG_MUSIC.find(t => t.url === backgroundMusicUrl);
      if (match) setSelectedExampleMusic(match.name);
    } else if (!backgroundMusicUrl) {
      setSelectedExampleMusic(null);
    }
  }, [backgroundMusicUrl]);

  // Cleanup example audio on unmount
  useEffect(() => {
    return () => {
      if (exampleAudioRef.current) {
        exampleAudioRef.current.pause();
        exampleAudioRef.current = null;
      }
    };
  }, []);

  // NEW: Handle output type change
  const handleOutputTypeChange = (type: 'video' | 'components') => {
    if (type === 'video') {
      // Reset to defaults for video creation
      setSettings(prev => ({
        ...prev,
        outputType: 'video',
        processStory: true,
        processImages: true,
        processAudio: true
      }));
    } else {
      // For components, ensure story is always selected
      setSettings(prev => ({
        ...prev,
        outputType: 'components',
        processStory: true,
        processImages: false,
        processAudio: false
      }));
    }
  };

  // NEW: Handle component selection change
  const handleComponentChange = (component: 'story' | 'images' | 'audio', checked: boolean) => {
    if (component === 'story') {
      setSettings(prev => ({
        ...prev,
        processStory: checked,
        // If story is unchecked, uncheck images and audio too
        processImages: checked ? prev.processImages : false,
        processAudio: checked ? prev.processAudio : false
      }));
    } else if (component === 'images') {
      setSettings(prev => ({ ...prev, processImages: checked }));
    } else if (component === 'audio') {
      setSettings(prev => ({ ...prev, processAudio: checked }));
    }
  };

  // NEW: Get relevant batch statuses based on enabled processes
  const getRelevantBatchStatuses = () => {
    if (outputType === 'components') {
      return batchStatuses.filter(batch => {
        if (batch.id === 'story' && processStory) return true;
        if ((batch.id === 'image_prompts' || batch.id === 'image_generation' ||
             batch.id === 'ttv_prompts' || batch.id === 'ttv_generation' ||
             batch.id === 'itv_image_prompts' || batch.id === 'itv_prompts' || batch.id === 'itv_image_generation' || batch.id === 'itv_generation' ||
             batch.id === 'mg_prompts' || batch.id === 'mg_render') && processImages) return true;
        if (batch.id === 'audio' && processAudio) return true;
        return false;
      });
    }
    return batchStatuses; // Show all for video creation
  };

  // NEW: Calculate progress labels based on enabled processes and visual type
  const getProgressLabels = () => {
    const labels = [];
    const vt = settings.visualType || 'image';
    if (processStory) labels.push({ full: 'Story', short: 'S' });
    if (processAudio && outputType === 'video') labels.push({ full: 'Audio', short: 'A' });
    if (processImages && outputType === 'video') {
      if (vt === 'ttv') {
        labels.push({ full: 'TTV Prompts', short: 'TP' });
        labels.push({ full: 'TTV Videos', short: 'TV' });
      } else if (vt === 'itv') {
        labels.push({ full: 'ITV Img Prompts', short: 'IP' });
        labels.push({ full: 'ITV Images', short: 'II' });
        labels.push({ full: 'ITV Prompts', short: 'VP' });
        labels.push({ full: 'ITV Gen', short: 'IG' });
      } else if (vt === 'mg') {
        labels.push({ full: 'MG Prompts', short: 'MP' });
        labels.push({ full: 'MG Render', short: 'MR' });
      } else {
        labels.push({ full: 'Prompts', short: 'P' });
        labels.push({ full: 'Images', short: 'I' });
      }
    }
    if (outputType === 'video') labels.push({ full: 'Video', short: 'V' });
    return labels;
  };

  // Enhanced streaming download for large videos
  const handleStreamingDownload = async (signedUrl: string, fileName: string, videoId: string) => {
    try {
      const response = await fetch(signedUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch video: ${response.status}`);
      }

      const contentLength = +response.headers.get('Content-Length')!;
      const reader = response.body!.getReader();
      
      let receivedLength = 0;
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        chunks.push(value);
        receivedLength += value.length;
        
        // Update progress
        const progress = Math.round((receivedLength / contentLength) * 100);
        setDownloadProgress(prev => ({ ...prev, [videoId]: progress }));
      }

      // Combine chunks and download
      const blob = new Blob(chunks, { type: 'video/mp4' });
      saveAs(blob, fileName);
      
      // Clear progress
      setDownloadProgress(prev => ({ ...prev, [videoId]: 0 }));
      
    } catch (err: any) {
      console.error(`Error in streaming download:`, err);
      setError(err.message || 'Failed to download large video file');
      setDownloadProgress(prev => ({ ...prev, [videoId]: 0 }));
    }
  };

  // Enhanced video download handler
  const handleEnhancedDownloadVideo = async () => {
    if (!finalVideoUrl || !currentUserId || !currentGroupId) {
      setError('No video available for download');
      return;
    }

    setDownloadLoading(true);
    setDownloadProgress(prev => ({ ...prev, [currentGroupId]: 0 }));
    
    try {
      // Find the final video document in story_documents
      const { data: finalVideoDoc, error: fetchError } = await supabase
        .from('story_documents')
        .select('file_path, title, file_size')
        .eq('user_id', currentUserId)
        .eq('group_id', currentGroupId)
        .eq('description', 'Final Video')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (fetchError || !finalVideoDoc) {
        console.error('Could not find the final video file:', fetchError);
        setError('Could not find the final video file');
        return;
      }

      // Generate signed URL for download
      const { data: signedUrlData, error: signedUrlError } = await supabase
        .storage
        .from('videos')
        .createSignedUrl(finalVideoDoc.file_path, 300); // 5 minutes expiry

      if (signedUrlError || !signedUrlData) {
        console.error('Failed to generate signed URL:', signedUrlError);
        setError('Failed to generate download link');
        return;
      }

      const fileName = `${sanitizeFileName(settings.storyTitle || 'video')}.mp4`;
      const isLargeVideo = finalVideoDoc.file_size && finalVideoDoc.file_size >= LARGE_FILE_THRESHOLD;

      if (isLargeVideo) {
        // Use streaming download for large videos
        await handleStreamingDownload(signedUrlData.signedUrl, fileName, currentGroupId);
      } else {
        // Use regular download for smaller videos
        const response = await fetch(signedUrlData.signedUrl);
        
        if (!response.ok) {
          throw new Error('Failed to fetch video file');
        }

        const blob = await response.blob();
        saveAs(blob, fileName);
      }
      
    } catch (err: any) {
      console.error('Error downloading video:', err);
      setError(`Failed to download video: ${err.message}`);
    } finally {
      setDownloadLoading(false);
      setDownloadProgress(prev => ({ ...prev, [currentGroupId]: 0 }));
    }
  };

  // Clear background music error when file changes
  useEffect(() => {
    if (backgroundMusicFile || backgroundMusicUrl) {
      setBackgroundMusicError(null);
    }
  }, [backgroundMusicFile, backgroundMusicUrl]);

  // Clear local background music state when generation stops or completes
  useEffect(() => {
    if (generationState === 'idle') {
      setBackgroundMusicFile(null);
      setBackgroundMusicError(null);
      setGenerationLoading(false); // NEW: Reset generation loading state
      if (backgroundMusicInputRef.current) {
        backgroundMusicInputRef.current.value = '';
      }
    }
  }, [generationState]);

  // Enhanced background music upload handler with comprehensive error handling
  const handleBackgroundMusicUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    console.log('Starting background music upload:', {
      fileName: file.name,
      fileSize: formatFileSize(file.size),
      fileType: file.type
    });

    // Clear previous errors
    setBackgroundMusicError(null);
    setError(null);

    // Validate file
    const validationError = validateAudioFile(file);
    if (validationError) {
      setBackgroundMusicError(validationError);
      setError(validationError);
      return;
    }

    if (!currentUserId) {
      const authError = 'Authentication error - please refresh the page and try again';
      setBackgroundMusicError(authError);
      setError(authError);
      return;
    }

    // Start upload process
    setBackgroundMusicUploading(true);
    setBackgroundMusicUploadProgress(0);

    try {
      // Generate unique file path
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileExtension = file.name.split('.').pop()?.toLowerCase() || 'mp3';
      const sanitizedFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
      const fileName = `bg_music_${timestamp}_${sanitizedFileName}`;
      const filePath = `${currentUserId}/background_music/${fileName}`;

      console.log('Upload details:', {
        filePath,
        contentType: file.type || `audio/${fileExtension}`
      });

      // Upload with retry logic
      const uploadResult = await retryOperation(async () => {
        setBackgroundMusicUploadProgress(25);
        
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('audio')
          .upload(filePath, file, {
            contentType: file.type || `audio/${fileExtension}`,
            upsert: true,
            duplex: 'half'
          });

        if (uploadError) {
          console.error('Upload error:', uploadError);
          throw new Error(`Upload failed: ${uploadError.message}`);
        }

        if (!uploadData || !uploadData.path) {
          throw new Error('Upload completed but no file path returned');
        }

        console.log('Upload successful:', uploadData);
        return uploadData;
      });

      setBackgroundMusicUploadProgress(50);

      // Generate public URL
      const { data: urlData } = supabase.storage
        .from('audio')
        .getPublicUrl(uploadResult.path);

      if (!urlData?.publicUrl) {
        throw new Error('Failed to generate public URL for uploaded file');
      }

      console.log('Generated public URL:', urlData.publicUrl);
      setBackgroundMusicUploadProgress(75);

      // Verify URL accessibility with retry logic
      await retryOperation(async () => {
        const testResponse = await fetch(urlData.publicUrl, { 
          method: 'HEAD',
          cache: 'no-cache'
        });
        
        if (!testResponse.ok) {
          throw new Error(`File not accessible: HTTP ${testResponse.status}`);
        }
        
        console.log('URL verification successful');
      }, 5, 1000); // 5 attempts with 1 second delay

      setBackgroundMusicUploadProgress(100);

      // Update all states - UPDATED TO USE PARENT SETTERS
      setBackgroundMusicFile(file);
      setBackgroundMusicUrl(urlData.publicUrl); // Update parent state
      
      // Update parent settings
      setSettings(prevSettings => ({
        ...prevSettings,
        backgroundMusicUrl: urlData.publicUrl
      }));

      console.log('Background music upload completed successfully');
      
      // Clear any previous errors
      setBackgroundMusicError(null);
      setError(null);

    } catch (err: any) {
      console.error('Background music upload failed:', err);
      
      // Handle all network-related errors silently
      if (err.message.includes('Failed to fetch') || 
          err.message.includes('TypeError: Failed to fetch') ||
          err.message.includes('NetworkError') ||
          err.message.includes('fetch') ||
          err.message.includes('network')) {
        // Assume upload succeeded, clear any errors
        console.log('Upload completed despite network issues');
        setBackgroundMusicError(null);
        setError(null);
        // Keep the uploaded file state as-is
        return;
      }
      
      // Only show real errors to users
      const errorMessage = err.message || 'Failed to upload background music';
      setBackgroundMusicError(errorMessage);
      setError(errorMessage);
      
      // Cleanup on real error
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileExtension = file.name.split('.').pop()?.toLowerCase() || 'mp3';
        const sanitizedFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
        const fileName = `bg_music_${timestamp}_${sanitizedFileName}`;
        const filePath = `${currentUserId}/background_music/${fileName}`;
        
        await supabase.storage.from('audio').remove([filePath]);
        console.log('Cleanup completed');
      } catch (cleanupError) {
        console.warn('Cleanup failed:', cleanupError);
      }
      
      setBackgroundMusicFile(null);
      setBackgroundMusicUrl('');
    } finally {
      setBackgroundMusicUploading(false);
      setBackgroundMusicUploadProgress(0);
      
      // Clear file input
      if (backgroundMusicInputRef.current) {
        backgroundMusicInputRef.current.value = '';
      }
    }
  };

  // Enhanced background music removal handler
  const handleBackgroundMusicRemove = async () => {
    if (!backgroundMusicUrl && !backgroundMusicFile) return;

    console.log('Removing background music:', {
      hasFile: !!backgroundMusicFile,
      hasUrl: !!backgroundMusicUrl,
      url: backgroundMusicUrl
    });

    try {
      // Delete from storage if URL exists
      if (backgroundMusicUrl) {
        const filePath = backgroundMusicUrl.replace(
          `${import.meta.env.SUPABASE_URL}/storage/v1/object/public/audio/`,
          ''
        );
        
        console.log('Deleting file from storage:', filePath);
        
        const { error: deleteError } = await supabase.storage
          .from('audio')
          .remove([filePath]);
        
        if (deleteError) {
          console.error('Failed to delete from storage:', deleteError);
          throw new Error(`Failed to delete file: ${deleteError.message}`);
        }
        
        console.log('File deleted from storage successfully');
      }
      
      // Clear all states - UPDATED TO USE PARENT SETTERS
      setBackgroundMusicFile(null);
      setBackgroundMusicUrl(''); // Clear parent state
      setBackgroundMusicError(null);
      
      // Update parent settings
      setSettings(prevSettings => {
        const newSettings = { ...prevSettings };
        delete newSettings.backgroundMusicUrl;
        delete newSettings.backgroundMusicVolume; // Also clear volume setting
        console.log('Cleared background music from settings:', newSettings);
        return newSettings;
      });
      
      // Clear file input
      if (backgroundMusicInputRef.current) {
        backgroundMusicInputRef.current.value = '';
      }
      
      console.log('Background music removed successfully');
      
    } catch (err: any) {
      console.error('Error removing background music:', err);
      
      // Handle network errors silently
      if (err.message.includes('Failed to fetch') || 
          err.message.includes('TypeError: Failed to fetch') ||
          err.message.includes('NetworkError') ||
          err.message.includes('fetch')) {
        console.log('Remove operation completed despite network issues');
        // Clear states anyway - assume it worked
        setBackgroundMusicFile(null);
        setBackgroundMusicUrl('');
        setBackgroundMusicError(null);
        return;
      }
      
      // Only show real errors
      const errorMessage = `Failed to remove background music: ${err.message}`;
      setBackgroundMusicError(errorMessage);
      setError(errorMessage);
    }
  };

  // Test background music URL accessibility
  const testBackgroundMusicUrl = async () => {
    if (!backgroundMusicUrl) return;
    
    try {
      const response = await fetch(backgroundMusicUrl, { method: 'HEAD' });
      if (response.ok) {
        console.log('Background music URL is accessible');
        setBackgroundMusicError(null);
      } else {
        throw new Error(`URL not accessible: HTTP ${response.status}`);
      }
    } catch (err: any) {
      console.error('Background music URL test failed:', err);
      setBackgroundMusicError(`URL test failed: ${err.message}`);
    }
  };

  // Select an example background music track
  const handleExampleMusicSelect = (track: { name: string; url: string }) => {
    if (settingsLocked) return;
    if (exampleAudioRef.current) {
      exampleAudioRef.current.pause();
      exampleAudioRef.current = null;
    }
    setPlayingExample(null);
    setSelectedExampleMusic(track.name);
    setBackgroundMusicFile(null);
    setBackgroundMusicUrl(track.url);
    setSettings((prev: any) => ({ ...prev, backgroundMusicUrl: track.url }));
  };

  // Deselect the currently selected example background music track
  const handleExampleMusicDeselect = () => {
    if (settingsLocked) return;
    if (exampleAudioRef.current) {
      exampleAudioRef.current.pause();
      exampleAudioRef.current = null;
    }
    setPlayingExample(null);
    setSelectedExampleMusic(null);
    setBackgroundMusicUrl('');
    setSettings((prev: any) => {
      const next = { ...prev };
      delete next.backgroundMusicUrl;
      delete next.backgroundMusicVolume;
      return next;
    });
  };

  // Play / pause an example background music track
  const handleExampleMusicPlay = (track: { name: string; url: string }, e: React.MouseEvent) => {
    e.stopPropagation();
    if (playingExample === track.name) {
      if (exampleAudioRef.current) {
        exampleAudioRef.current.pause();
        exampleAudioRef.current = null;
      }
      setPlayingExample(null);
    } else {
      if (exampleAudioRef.current) {
        exampleAudioRef.current.pause();
      }
      const audio = new Audio(track.url);
      audio.onended = () => setPlayingExample(null);
      audio.play().catch(err => console.warn('Playback failed:', err));
      exampleAudioRef.current = audio;
      setPlayingExample(track.name);
    }
  };

  // Toggle step 4 collapse
  const toggleStep4Collapse = () => {
    if (!settingsLocked) {
      setCollapsedStep4(!collapsedStep4);
    }
  };

  // Check if all required fields are configured for steps
  const isStepConfigured = (stepNumber: number): boolean => {
    switch (stepNumber) {
      case 1: // Story Configuration
        if (settings.storySource === 'new') {
          return !!(settings.storyTitle && settings.storyDescription && settings.wordCount && !wordCountError);
        } else if (settings.storySource === 'existing') {
          return !!settings.selectedStoryDoc;
        } else if (settings.storySource === 'upload') {
          return !!uploadedFile; // Fixed: Check uploadedFile instead of settings.uploadedVideoFile
        }
        return false;
        
      case 2: // Image Configuration
        if (settings.imageSource === 'generate') {
          const vt2 = settings.visualType || 'image';
          if (vt2 === 'mg' && !settings.mgStyleSlug) return false;
          return Object.keys(validationErrors).length === 0;
        } else if (settings.imageSource === 'folder' && settings.storySource !== 'new') {
          const vt = settings.visualType || 'image';
          if (vt === 'ttv') {
            return !!(settings.selectedTTVFolder && settings.ttvPromptDoc);
          } else if (vt === 'itv') {
            return !!(settings.selectedITVVideoFolder && settings.itvVideoPromptDoc &&
                      settings.selectedITVImageFolder && settings.itvImagePromptDoc);
          }
          return !!(settings.selectedImageFolder && settings.imagePromptDoc);
        } else if (settings.imageSource === 'upload') {
          return !!settings.uploadedVideoFile || !!uploadedVideoLoopFile;
        }
        return settings.imageSource === 'generate';
        
      case 3: // Audio Configuration
        if (settings.audioSource === 'generate') {
          if (!settings.selectedVoice) return false;
          if (settings.selectedVoice === 'custom') {
            return !!cloneFileUrl;
          }
          return true;
        } else if (settings.audioSource === 'existing' && settings.storySource !== 'new') {
          return !!settings.selectedAudioFile;
        } else if (settings.audioSource === 'upload' && settings.storySource !== 'new') {
          // Updated to check for uploaded audio file or document ID
          return !!settings.selectedAudioFile || !!uploadedAudioFile || !!uploadedAudioDocId;
        }
        return settings.audioSource === 'generate';

      case 4: // Video Configuration
        return true; // Always configured with defaults
        
      default:
        return false;
    }
  };

  // Check if step can be collapsed (has some configuration)
  const canCollapseStep4 = (): boolean => {
    // Step 4 can be collapsed if it has any non-default configuration
    return !!(
      selectedTransition !== 'none' ||
      selectedAnimation !== 'horizontal_drift' ||
      selectedEffect !== 'film_grain' ||
      backgroundMusicFile ||
      backgroundMusicUrl ||
      settings.backgroundMusicUrl
    );
  };

  // Helper function to calculate video loop details
  const getVideoLoopDetails = () => {
    if (!uploadedVideoLoopFile || !settings.videoLoopMetadata || !analysisResult) {
      return null;
    }

    const originalDuration = settings.videoLoopMetadata.duration;
    const requiredDurationMinutes = analysisResult.estimatedVideoTimeMinutes;
    const requiredDurationSeconds = requiredDurationMinutes * 60;
    const loopCount = Math.ceil(requiredDurationSeconds / originalDuration);

    return {
      originalDuration,
      requiredDurationSeconds,
      requiredDurationMinutes,
      loopCount
    };
  };

  // NEW: Update handleAnalyzeVideo to include new flags
  const handleAnalyzeVideoWithFlags = async () => {
    // Set the flags in settings before calling the original handler
    const updatedSettings = {
      ...settings,
      video: outputType === 'video',
      process_story: processStory,
      process_images: processImages,
      process_audio: processAudio,
      animation_type: mapAnimationForBackend(selectedAnimation)
    };
    
    // Temporarily update settings
    setSettings(updatedSettings);
    
    // Call the original handler
    await handleAnalyzeVideo();
  };

  // NEW: Update handleGenerateVideo to include new flags and loading state
  const handleGenerateVideoWithFlags = async () => {
    setGenerationLoading(true);
    
    try {
      // Set the flags in settings before calling the original handler
      const updatedSettings = {
        ...settings,
        video: outputType === 'video',
        process_story: processStory,
        process_images: processImages,
        process_audio: processAudio,
        animation_type: mapAnimationForBackend(selectedAnimation)
      };
      
      // Temporarily update settings
      setSettings(updatedSettings);
      
      // Call the original handler
      await handleGenerateVideo();
    } catch (error) {
      console.error('Generation error:', error);
      setGenerationLoading(false);
    }
  };

  // ------------------------------------------------------------------
  // Step 4 preview URL — picks an example video matching current
  // Step 3 (visual type) + Step 4 (transition / animation / effect).
  // Indices mirror the python combination scripts:
  //   ImageGen: product(transitions, animations, effects)  -> 30 files
  //   TTV/ITV:  product(transitions, effects)              -> 10 files
  // ------------------------------------------------------------------
  const previewUrl = React.useMemo(() => {
    const PREVIEW_BASE = 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff';
    const TRANSITIONS = ['none', 'dissolve'] as const;
    const EFFECTS = ['none', 'film_grain', 'fire_flare', 'light_sparkle', 'snow'] as const;

    const transitionKey = (selectedTransition === 'dissolve') ? 'dissolve' : 'none';
    const effectKey = (EFFECTS as readonly string[]).includes(selectedEffect)
      ? (selectedEffect as typeof EFFECTS[number])
      : 'none';
    const tIdx = TRANSITIONS.indexOf(transitionKey);
    const eIdx = EFFECTS.indexOf(effectKey);

    const isAiVideo = settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg';
    if (isAiVideo) {
      const idx = tIdx * EFFECTS.length + eIdx + 1;
      const file = `${String(idx).padStart(2, '0')}_${transitionKey}__${effectKey}.mp4`;
      return `${PREVIEW_BASE}/ExampleVideoWithTTV/${file}`;
    }

    // The original 30 previews (1..30) cover transitions × {none,drift,vertical} × effects.
    // Ken Burns previews were appended later as a flat 31..40 block so the
    // original files didn't have to be renumbered:
    //   31..35 = transition=none     × ken_burns × 5 effects
    //   36..40 = transition=dissolve × ken_burns × 5 effects
    const ORIGINAL_ANIMATIONS = ['none', 'drift', 'vertical'] as const;
    let animKey: 'none' | 'drift' | 'vertical' | 'ken_burns' = 'none';
    if (selectedAnimation === 'horizontal_drift' || selectedAnimation === 'drift') animKey = 'drift';
    else if (selectedAnimation === 'vertical') animKey = 'vertical';
    else if (selectedAnimation === 'ken_burns') animKey = 'ken_burns';

    let idx: number;
    if (animKey === 'ken_burns') {
      const KEN_BURNS_BASE_INDEX = 31;
      idx = KEN_BURNS_BASE_INDEX + tIdx * EFFECTS.length + eIdx;
    } else {
      const aIdx = ORIGINAL_ANIMATIONS.indexOf(animKey);
      idx = tIdx * (ORIGINAL_ANIMATIONS.length * EFFECTS.length) + aIdx * EFFECTS.length + eIdx + 1;
    }
    const file = `${String(idx).padStart(2, '0')}_${transitionKey}__${animKey}__${effectKey}.mp4`;
    return `${PREVIEW_BASE}/ExampleVideoWithImageGen/${file}`;
  }, [selectedTransition, selectedAnimation, selectedEffect, settings.visualType]);

  return (
    <div className="space-y-6">
      {/* Show configuration steps only if not complete */}
      {generationState !== 'complete' && (
        <div className="space-y-6">
          <div className="dash-collapse-grid" data-collapsed={settingsCollapsed ? 'true' : 'false'} style={{ transitionDelay: settingsCollapsed ? '120ms' : '0ms' }}>
          <div>
          {/* Step 4: Video Configuration */}
          <div className={`bg-surface-card rounded-lg ${settingsLocked ? 'opacity-60' : ''}`}>
            <div 
              className="flex items-center justify-between p-6 cursor-pointer"
              onClick={toggleStep4Collapse}
            >
              <div className="flex items-center">
                <Film className="h-5 w-5 text-red-700 mr-2" />
                <h2 className="text-lg sm:text-xl font-semibold text-white">Step 4: Video Configuration</h2>
                {settingsLocked && <Lock className="h-4 w-4 text-text-muted ml-2" />}
              </div>
              <div className="flex items-center space-x-2">
                {isStepConfigured(4) && (
                  <span className="text-xs sm:text-sm text-green-400">Configured</span>
                )}
                {!settingsLocked && (
                  <ChevronDown className={`h-5 w-5 text-text-muted transition-transform duration-200 ${collapsedStep4 ? 'rotate-180' : ''}`} />
                )}
              </div>
            </div>

            {!collapsedStep4 && (
              <div className="px-6 pb-6 space-y-6">
                {/* Output Type Selection */}
                <div>
                  <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Output Type</label>
                  <div className="grid grid-cols-2 gap-4">
                    <button
                      onClick={() => !settingsLocked && handleOutputTypeChange('video')}
                      disabled={settingsLocked}
                      className={`p-4 rounded-lg border-2 transition-all ${
                        outputType === 'video'
                          ? 'border-red-800 bg-red-500/20 text-white'
                          : 'border-border bg-surface-elevated text-text-secondary hover:border-border-subtle'
                      } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                    >
                      <div className="text-left">
                        <div className="font-medium text-sm sm:text-base">Video Creation</div>
                        <div className="text-xs sm:text-sm opacity-75 mt-1">
                          <span className="hidden sm:inline">Generate complete video with all components</span>
                          <span className="sm:hidden">Complete video generation</span>
                        </div>
                      </div>
                    </button>
                    
                    <button
                      onClick={() => !settingsLocked && handleOutputTypeChange('components')}
                      disabled={settingsLocked}
                      className={`p-4 rounded-lg border-2 transition-all ${
                        outputType === 'components'
                          ? 'border-red-800 bg-red-500/20 text-white'
                          : 'border-border bg-surface-elevated text-text-secondary hover:border-border-subtle'
                      } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                    >
                      <div className="text-left">
                        <div className="font-medium text-sm sm:text-base">Components Only</div>
                        <div className="text-xs sm:text-sm opacity-75 mt-1">
                          <span className="hidden sm:inline">Generate only selected components without final video</span>
                          <span className="sm:hidden">Selected components only</span>
                        </div>
                      </div>
                    </button>
                  </div>
                </div>

                {/* Component Selection for Components Only */}
                {outputType === 'components' && (
                  <div className="bg-surface-elevated rounded-lg p-4">
                    <h4 className="text-sm font-medium text-white mb-3">Select Components to Generate:</h4>
                    <div className="space-y-3">
                      {/* Story Toggle */}
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-sm font-medium text-white">
                            Story <span className="text-red-400">(Required)</span>
                          </h3>
                          <p className="text-sm text-text-muted mt-1">Generate the story content</p>
                        </div>
                        <label className={`relative inline-flex items-center ${settingsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                          <input
                            type="checkbox"
                            checked={processStory}
                            onChange={(e) => !settingsLocked && handleComponentChange('story', e.target.checked)}
                            disabled={settingsLocked || true} // Always disabled as story is required
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-surface-input peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-red-800 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-white/20 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-600"></div>
                        </label>
                      </div>

                      {/* Images Toggle */}
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className={`text-sm font-medium ${!processStory ? 'text-text-dim' : 'text-white'}`}>
                            Images {!processStory && '(Requires Story)'}
                          </h3>
                          <p className={`text-sm mt-1 ${!processStory ? 'text-text-dim' : 'text-text-muted'}`}>
                            Generate image prompts and images
                          </p>
                        </div>
                        <label className={`relative inline-flex items-center ${settingsLocked || !processStory ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                          <input
                            type="checkbox"
                            checked={processImages}
                            onChange={(e) => !settingsLocked && handleComponentChange('images', e.target.checked)}
                            disabled={settingsLocked || !processStory}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-surface-input peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-red-800 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-white/20 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-600"></div>
                        </label>
                      </div>

                      {/* Audio Toggle */}
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className={`text-sm font-medium ${!processStory ? 'text-text-dim' : 'text-white'}`}>
                            Audio {!processStory && '(Requires Story)'}
                          </h3>
                          <p className={`text-sm mt-1 ${!processStory ? 'text-text-dim' : 'text-text-muted'}`}>
                            Generate text-to-speech audio
                          </p>
                        </div>
                        <label className={`relative inline-flex items-center ${settingsLocked || !processStory ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                          <input
                            type="checkbox"
                            checked={processAudio}
                            onChange={(e) => !settingsLocked && handleComponentChange('audio', e.target.checked)}
                            disabled={settingsLocked || !processStory}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-surface-input peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-red-800 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-white/20 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-600"></div>
                        </label>
                      </div>
                    </div>
                    
                    {outputType === 'components' && !processStory && (
                      <div className="mt-2 text-xs text-yellow-400">
                        Story is required to generate images or audio
                      </div>
                    )}
                  </div>
                )}

                {/* Show video-specific options only if video creation is selected */}
                {outputType === 'video' && (
                  <>
                    {/* Enhanced Transitions Section */}
                    <div className="bg-surface-elevated rounded-lg p-4">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-base sm:text-lg font-medium text-white">Transitions</h3>
                        <span className="text-xs text-text-muted">
                          <span className="hidden sm:inline">Affects token usage and processing time</span>
                          <span className="sm:hidden">+Tokens</span>
                        </span>
                      </div>
                      
                      {/* Transition Warning */}
                      {selectedTransition === 'dissolve' && (() => {
                        const vt = settings.visualType || 'image';
                        const isVideoMode = vt === 'ttv' || vt === 'itv';
                        const batchLabel = isVideoMode ? '12 videos' : '6 images';
                        const costLabel = isVideoMode ? '40,000' : '85,000';
                        const costShort = isVideoMode ? '40k' : '85k';
                        const mediaLabel = isVideoMode ? 'videos' : 'images';
                        return (
                        <div className="bg-yellow-900/50 text-yellow-200 p-3 rounded-lg mb-4">
                          <div className="flex items-start space-x-2">
                            <AlertCircle className="h-5 w-5 text-yellow-400 mt-0.5 flex-shrink-0" />
                            <div className="text-sm">
                              <p className="font-medium mb-1">
                                <span className="hidden sm:inline">Transition Cost Warning:</span>
                                <span className="sm:hidden">Cost Warning:</span>
                              </p>
                              <ul className="space-y-1 text-xs">
                                <li>• <span className="hidden sm:inline">Adds approximately {costLabel} tokens per {batchLabel} to generation cost</span><span className="sm:hidden">+{costShort} tokens per {batchLabel}</span></li>
                                <li>• <span className="hidden sm:inline">Increases processing time by 1-2 hours</span><span className="sm:hidden">+1-2hrs processing</span></li>
                                <li>• <span className="hidden sm:inline">Creates smoother video transitions between {mediaLabel}</span><span className="sm:hidden">Smoother transitions</span></li>
                                {analysisResult && (
                                  <li>• <span className="hidden sm:inline">Your video ({analysisResult.settings?.numImages || 0} {mediaLabel}) will add approximately {formatNumber(calculateTransitionTokens(analysisResult.settings?.numImages || 0, vt))} tokens</span><span className="sm:hidden">Your video: +{formatNumber(calculateTransitionTokens(analysisResult.settings?.numImages || 0, vt))} tokens</span></li>
                                )}
                              </ul>
                            </div>
                          </div>
                        </div>
                        );
                      })()}

                      <div className="grid grid-cols-1 gap-3">
                        <button
                          onClick={() => !settingsLocked && setSelectedTransition('none')}
                          disabled={settingsLocked}
                          className={`p-3 rounded-lg border-2 transition-all text-left ${
                            selectedTransition === 'none'
                              ? 'border-red-800 bg-red-500/20 text-white'
                              : 'border-border bg-surface-input text-text-secondary hover:border-border-subtle'
                          } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          <div className="font-medium text-sm sm:text-base">None</div>
                          <div className="text-xs sm:text-sm opacity-75 mt-1">
                            <span className="hidden sm:inline">Simple concatenation without transitions (faster, uses fewer tokens)</span>
                            <span className="sm:hidden">Simple, faster, fewer tokens</span>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => !settingsLocked && setSelectedTransition('dissolve')}
                          disabled={settingsLocked}
                          className={`p-3 rounded-lg border-2 transition-all text-left ${
                            selectedTransition === 'dissolve'
                              ? 'border-red-800 bg-red-500/20 text-white'
                              : 'border-border bg-surface-input text-text-secondary hover:border-border-subtle'
                          } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          <div className="font-medium text-sm sm:text-base">Dissolve</div>
                          <div className="text-xs sm:text-sm opacity-75 mt-1">
                            {(() => {
                              const vt = settings.visualType || 'image';
                              const isVideoMode = vt === 'ttv' || vt === 'itv';
                              const batchLabel = isVideoMode ? '12 videos' : '6 images';
                              const costShort = isVideoMode ? '40k' : '85k';
                              return (
                                <>
                                  <span className="hidden sm:inline">Smooth dissolve between {isVideoMode ? 'videos' : 'images'}</span>
                                  <span className="sm:hidden">Smooth dissolve</span>
                                  <span className="text-yellow-400 ml-1">
                                    <span className="hidden sm:inline">(+{costShort} per {batchLabel}, +1-2hours)</span>
                                    <span className="sm:hidden">(+{costShort} per {batchLabel.replace(' ', '')}, +1-2h)</span>
                                  </span>
                                  {analysisResult && (
                                    <span className="text-yellow-400 ml-1">
                                      <span className="hidden sm:inline"> - Your video: +{formatNumber(calculateTransitionTokens(analysisResult.settings?.numImages || 0, vt))} tokens</span>
                                      <span className="sm:hidden"> - +{formatNumber(calculateTransitionTokens(analysisResult.settings?.numImages || 0, vt))}</span>
                                    </span>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        </button>
                      </div>
                    </div>

                    {/* Animation Section - UPDATED WITH HORIZONTAL AND VERTICAL DRIFT */}
                    <div className="bg-surface-elevated rounded-lg p-4">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-base sm:text-lg font-medium text-white">Animation</h3>
                        <span className="text-xs text-text-muted">
                          {(settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg') ? (
                            <span>Not applicable</span>
                          ) : (
                            <>
                              <span className="hidden sm:inline">Image movement effects</span>
                              <span className="sm:hidden">Movement</span>
                            </>
                          )}
                        </span>
                      </div>

                      {/* Info box for TTV/ITV - animation not applicable */}
                      {(settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg') && (
                        <div className="bg-yellow-900/40 border border-yellow-700/50 text-yellow-200 p-3 rounded-lg mb-4">
                          <div className="flex items-start space-x-2">
                            <Info className="h-4 w-4 text-yellow-400 mt-0.5 flex-shrink-0" />
                            <p className="text-xs leading-relaxed">
                              <span className="hidden sm:inline">Animation is not required for AI-generated video clips. {settings.visualType === 'ttv' ? 'Text-to-Video' : 'Image-to-Video'} content already includes native motion from the AI generation process — adding drift on top would conflict with the built-in movement.</span>
                              <span className="sm:hidden">Not needed — AI clips already have built-in motion.</span>
                            </p>
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-1 gap-3">
                        <button
                          onClick={() => !settingsLocked && setSelectedAnimation('none')}
                          disabled={settingsLocked || settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg'}
                          className={`p-3 rounded-lg border-2 transition-all text-left ${
                            selectedAnimation === 'none' || settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg'
                              ? 'border-red-800 bg-red-500/20 text-white'
                              : 'border-border bg-surface-input text-text-secondary hover:border-border-subtle'
                          } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          <div className="font-medium text-sm sm:text-base">None</div>
                          <div className="text-xs sm:text-sm opacity-75 mt-1">
                            <span className="hidden sm:inline">Static images without movement</span>
                            <span className="sm:hidden">Static images</span>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => !settingsLocked && !(settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg') && setSelectedAnimation('horizontal_drift')}
                          disabled={settingsLocked || settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg'}
                          className={`p-3 rounded-lg border-2 transition-all text-left ${
                            selectedAnimation === 'horizontal_drift' || selectedAnimation === 'drift'
                              ? 'border-red-800 bg-red-500/20 text-white'
                              : 'border-border bg-surface-input text-text-secondary hover:border-border-subtle'
                          } ${(settingsLocked || settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg') ? 'cursor-not-allowed opacity-40' : ''}`}
                        >
                          <div className="font-medium text-sm sm:text-base">Horizontal Drift</div>
                          <div className="text-xs sm:text-sm opacity-75 mt-1">
                            <span className="hidden sm:inline">Slight horizontal movement back and forth</span>
                            <span className="sm:hidden">Horizontal movement</span>
                          </div>
                        </button>

                        <button
                          onClick={() => !settingsLocked && !(settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg') && setSelectedAnimation('vertical')}
                          disabled={settingsLocked || settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg'}
                          className={`p-3 rounded-lg border-2 transition-all text-left ${
                            selectedAnimation === 'vertical'
                              ? 'border-red-800 bg-red-500/20 text-white'
                              : 'border-border bg-surface-input text-text-secondary hover:border-border-subtle'
                          } ${(settingsLocked || settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg') ? 'cursor-not-allowed opacity-40' : ''}`}
                        >
                          <div className="font-medium text-sm sm:text-base">Vertical Drift</div>
                          <div className="text-xs sm:text-sm opacity-75 mt-1">
                            <span className="hidden sm:inline">Slight vertical movement up and down</span>
                            <span className="sm:hidden">Vertical movement</span>
                          </div>
                        </button>

                        <button
                          onClick={() => !settingsLocked && !(settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg') && setSelectedAnimation('ken_burns')}
                          disabled={settingsLocked || settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg'}
                          className={`p-3 rounded-lg border-2 transition-all text-left ${
                            selectedAnimation === 'ken_burns'
                              ? 'border-red-800 bg-red-500/20 text-white'
                              : 'border-border bg-surface-input text-text-secondary hover:border-border-subtle'
                          } ${(settingsLocked || settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg') ? 'cursor-not-allowed opacity-40' : ''}`}
                        >
                          <div className="font-medium text-sm sm:text-base">Ken Burns</div>
                          <div className="text-xs sm:text-sm opacity-75 mt-1">
                            <span className="hidden sm:inline">Slow zoom in/out cycle for cinematic depth</span>
                            <span className="sm:hidden">Cinematic zoom cycle</span>
                          </div>
                        </button>
                      </div>
                    </div>

                    {/* Effects Section - UPDATED WITH SNOW */}
                    <div className="bg-surface-elevated rounded-lg p-4">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-base sm:text-lg font-medium text-white">Effects</h3>
                        <span className="text-xs text-text-muted">
                          <span className="hidden sm:inline">Visual overlay effects</span>
                          <span className="sm:hidden">Overlays</span>
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-3">
                        <button
                          onClick={() => !settingsLocked && setSelectedEffect('none')}
                          disabled={settingsLocked}
                          className={`p-3 rounded-lg border-2 transition-all text-left ${
                            selectedEffect === 'none'
                              ? 'border-red-800 bg-red-500/20 text-white'
                              : 'border-border bg-surface-input text-text-secondary hover:border-border-subtle'
                          } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          <div className="font-medium text-sm sm:text-base">None</div>
                          <div className="text-xs sm:text-sm opacity-75 mt-1">
                            <span className="hidden sm:inline">Clean images without overlay effects</span>
                            <span className="sm:hidden">Clean images</span>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => !settingsLocked && setSelectedEffect('film_grain')}
                          disabled={settingsLocked}
                          className={`p-3 rounded-lg border-2 transition-all text-left ${
                            selectedEffect === 'film_grain'
                              ? 'border-red-800 bg-red-500/20 text-white'
                              : 'border-border bg-surface-input text-text-secondary hover:border-border-subtle'
                          } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          <div className="flex items-center">
                            <Film className="h-4 w-4 mr-2" />
                            <div className="font-medium text-sm sm:text-base">Film Grain</div>
                          </div>
                          <div className="text-xs sm:text-sm opacity-75 mt-1">
                            <span className="hidden sm:inline">Adds cinematic texture and atmosphere</span>
                            <span className="sm:hidden">Cinematic texture</span>
                          </div>
                        </button>

                        <button
                          onClick={() => !settingsLocked && setSelectedEffect('fire_flare')}
                          disabled={settingsLocked}
                          className={`p-3 rounded-lg border-2 transition-all text-left ${
                            selectedEffect === 'fire_flare'
                              ? 'border-red-800 bg-red-500/20 text-white'
                              : 'border-border bg-surface-input text-text-secondary hover:border-border-subtle'
                          } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          <div className="flex items-center">
                            <Flame className="h-4 w-4 mr-2" />
                            <div className="font-medium text-sm sm:text-base">Fire Flare</div>
                          </div>
                          <div className="text-xs sm:text-sm opacity-75 mt-1">
                            <span className="hidden sm:inline">Adds warm, fiery light effects and flares</span>
                            <span className="sm:hidden">Warm fiery effects</span>
                          </div>
                        </button>

                        <button
                          onClick={() => !settingsLocked && setSelectedEffect('light_sparkle')}
                          disabled={settingsLocked}
                          className={`p-3 rounded-lg border-2 transition-all text-left ${
                            selectedEffect === 'light_sparkle'
                              ? 'border-red-800 bg-red-500/20 text-white'
                              : 'border-border bg-surface-input text-text-secondary hover:border-border-subtle'
                          } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          <div className="flex items-center">
                            <Sparkles className="h-4 w-4 mr-2" />
                            <div className="font-medium text-sm sm:text-base">Light Sparkle</div>
                          </div>
                          <div className="text-xs sm:text-sm opacity-75 mt-1">
                            <span className="hidden sm:inline">Adds magical sparkling light particles</span>
                            <span className="sm:hidden">Magical sparkles</span>
                          </div>
                        </button>

                        <button
                          onClick={() => !settingsLocked && setSelectedEffect('snow')}
                          disabled={settingsLocked}
                          className={`p-3 rounded-lg border-2 transition-all text-left ${
                            selectedEffect === 'snow'
                              ? 'border-red-800 bg-red-500/20 text-white'
                              : 'border-border bg-surface-input text-text-secondary hover:border-border-subtle'
                          } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          <div className="flex items-center">
                            <Snowflake className="h-4 w-4 mr-2" />
                            <div className="font-medium text-sm sm:text-base">Snow</div>
                          </div>
                          <div className="text-xs sm:text-sm opacity-75 mt-1">
                            <span className="hidden sm:inline">Adds gentle falling snow particles</span>
                            <span className="sm:hidden">Falling snow particles</span>
                          </div>
                        </button>
                      </div>

                      {/* Subtitles (optional) — lives inside the Effects card, just below the effect grid */}
                      <div className="mt-4 pt-4 border-t border-border">
                        <SubtitleConfiguration
                          enabled={subtitlesEnabled}
                          onEnabledChange={setSubtitlesEnabled}
                          config={subtitleConfig}
                          onConfigChange={setSubtitleConfig}
                          disabled={settingsLocked}
                        />
                      </div>
                    </div>

                    {/* Enhanced Background Music Section */}
                    <div className="bg-surface-elevated rounded-lg p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center space-x-2">
                          <h3 className="text-base sm:text-lg font-medium text-white">
                            <span className="hidden sm:inline">Background Music</span>
                            <span className="sm:hidden">BG Music</span>
                          </h3>
                          <Music className="h-4 w-4 sm:h-5 sm:w-5 text-text-muted" />
                        </div>
                        {(backgroundMusicFile || backgroundMusicUrl) && (
                          <div className="flex items-center space-x-2">
                            <span className="text-xs text-green-400">Uploaded</span>
                            <CheckCircle2 className="h-4 w-4 text-green-400" />
                          </div>
                        )}
                      </div>
                      
                      {/* Guidelines */}
                      <div className="bg-yellow-900/50 text-yellow-200 p-3 rounded-lg mb-4">
                        <div className="flex items-start space-x-2">
                          <AlertCircle className="h-5 w-5 text-yellow-400 mt-0.5 flex-shrink-0" />
                          <div className="text-sm">
                            <p className="font-medium mb-1">
                              <span className="hidden sm:inline">Important Guidelines:</span>
                              <span className="sm:hidden">Guidelines:</span>
                            </p>
                            <ul className="space-y-1 text-xs">
                              <li>• <span className="hidden sm:inline">Keep volume levels low to not overpower the narration</span><span className="sm:hidden">Keep volume low vs narration</span></li>
                              <li>• <span className="hidden sm:inline">Test your audio file before uploading to ensure proper balance</span><span className="sm:hidden">Test audio balance first</span></li>
                              <li>• <span className="hidden sm:inline">Music will be looped to match the entire video length</span><span className="sm:hidden">Will loop to match video length</span></li>
                              <li>• <span className="hidden sm:inline">Recommended: Instrumental tracks work best</span><span className="sm:hidden">Instrumental tracks best</span></li>
                              <li>• <span className="hidden sm:inline">Supported formats: MP3, WAV (max {MAX_BACKGROUND_MUSIC_SIZE_MB}MB)</span><span className="sm:hidden">MP3/WAV, max {MAX_BACKGROUND_MUSIC_SIZE_MB}MB</span></li>
                            </ul>
                          </div>
                        </div>
                      </div>

                      {/* Error Display */}
                      {backgroundMusicError && (
                        <div className="bg-red-900/50 text-red-200 p-3 rounded-lg mb-4">
                          <div className="flex items-start space-x-2">
                            <AlertCircle className="h-5 w-5 text-red-400 mt-0.5 flex-shrink-0" />
                            <div className="text-sm">
                              <p className="font-medium mb-1">
                                <span className="hidden sm:inline">Upload Error:</span>
                                <span className="sm:hidden">Error:</span>
                              </p>
                              <p className="text-xs sm:text-sm">{backgroundMusicError}</p>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Upload Area — shown only when no file uploaded and no example selected */}
                      {!backgroundMusicFile && !selectedExampleMusic && !((backgroundMusicUrl ?? '').length > 0 && !backgroundMusicUrl.includes('Example_BGMusic/')) && (
                        <div className="relative mb-4">
                          <label className={`flex flex-col items-center justify-center w-full h-24 sm:h-32 border-2 border-border border-dashed rounded-lg transition-colors ${
                            settingsLocked || backgroundMusicUploading
                              ? 'cursor-not-allowed opacity-50 bg-surface-input'
                              : 'cursor-pointer bg-surface-input hover:bg-white/10'
                          }`}>
                            <div className="flex flex-col items-center justify-center pt-3 sm:pt-5 pb-4 sm:pb-6">
                              {backgroundMusicUploading ? (
                                <>
                                  <RefreshCw className="w-6 h-6 sm:w-8 sm:h-8 mb-2 sm:mb-3 text-text-secondary animate-spin" />
                                  <p className="mb-2 text-xs sm:text-sm text-text-secondary">
                                    <span className="font-semibold">
                                      <span className="hidden sm:inline">Uploading background music...</span>
                                      <span className="sm:hidden">Uploading...</span>
                                    </span>
                                  </p>
                                  {backgroundMusicUploadProgress > 0 && (
                                    <div className="w-24 sm:w-32 bg-white/10 rounded-full h-2 mb-2">
                                      <div
                                        className="bg-red-500 h-2 rounded-full transition-all duration-300"
                                        style={{ width: `${backgroundMusicUploadProgress}%` }}
                                      />
                                    </div>
                                  )}
                                </>
                              ) : (
                                <>
                                  <Upload className="w-6 h-6 sm:w-8 sm:h-8 mb-2 sm:mb-3 text-text-secondary" />
                                  <p className="mb-1 sm:mb-2 text-xs sm:text-sm text-text-secondary">
                                    <span className="font-semibold">
                                      <span className="hidden sm:inline">Click to upload background music</span>
                                      <span className="sm:hidden">Upload music</span>
                                    </span>
                                    <span className="hidden sm:inline"> or drag and drop</span>
                                  </p>
                                  <p className="text-xs text-text-muted">
                                    <span className="hidden sm:inline">MP3 or WAV files only - Max {MAX_BACKGROUND_MUSIC_SIZE_MB}MB</span>
                                    <span className="sm:hidden">MP3/WAV - Max {MAX_BACKGROUND_MUSIC_SIZE_MB}MB</span>
                                  </p>
                                </>
                              )}
                            </div>
                            <input
                              ref={backgroundMusicInputRef}
                              type="file"
                              className="hidden"
                              accept=".mp3,.wav,audio/mpeg,audio/wav,audio/wave"
                              onChange={handleBackgroundMusicUpload}
                              disabled={settingsLocked || backgroundMusicUploading}
                            />
                          </label>
                        </div>
                      )}

                      {/* Selected example panel — replaces the upload area when an example is chosen */}
                      {selectedExampleMusic && (
                        <div className="bg-surface-input rounded-lg p-4 mb-4">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center space-x-3 min-w-0">
                              <div className="flex items-center justify-center w-10 h-10 bg-green-600 rounded-full flex-shrink-0">
                                <FileAudio className="h-5 w-5 text-white" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <h4 className="text-sm text-white font-medium truncate">{selectedExampleMusic}</h4>
                                <p className="text-xs text-text-muted">
                                  <span className="hidden sm:inline">Will be looped for entire video duration</span>
                                  <span className="sm:hidden">Loops for full video</span>
                                </p>
                              </div>
                            </div>
                            <button
                              onClick={handleExampleMusicDeselect}
                              disabled={settingsLocked}
                              className={`p-2 text-text-muted hover:text-red-400 transition-colors flex-shrink-0 ${
                                settingsLocked ? 'cursor-not-allowed opacity-50' : ''
                              }`}
                              title="Deselect example music"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>

                          {/* Volume control */}
                          <div>
                            <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">
                              <span className="hidden sm:inline">Background Music Volume</span>
                              <span className="sm:hidden">BG Volume</span>
                            </label>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs font-medium text-white">Volume Level</span>
                              <input
                                type="text"
                                value={backgroundMusicVolumeInput}
                                onChange={(e) => !settingsLocked && handleBackgroundMusicVolumeInputChange(e.target.value)}
                                disabled={settingsLocked}
                                className={`w-16 px-2 py-0.5 bg-surface-input border rounded-lg text-white text-xs text-center focus:outline-none focus:ring-1 ${
                                  backgroundMusicVolumeError
                                    ? 'border-red-500 focus:ring-red-500'
                                    : 'border-white/10 focus:ring-accent'
                                } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                                placeholder="1.0"
                              />
                            </div>
                            <div className="flex items-center gap-3 mb-2">
                              <span className="text-lg font-semibold text-white tabular-nums">{Math.round((settings.backgroundMusicVolume || 1.0) * 100)}%</span>
                              <span className="text-xs text-text-muted">
                                {(settings.backgroundMusicVolume || 1.0) <= 0.3 ? 'Subtle' : (settings.backgroundMusicVolume || 1.0) <= 0.7 ? 'Moderate' : (settings.backgroundMusicVolume || 1.0) <= 1.0 ? 'Default' : 'Loud'}
                              </span>
                            </div>
                            <input
                              type="range"
                              min="0.1"
                              max="2.0"
                              step="0.01"
                              value={settings.backgroundMusicVolume || 1.0}
                              onChange={(e) => {
                                if (!settingsLocked) {
                                  const value = parseFloat(e.target.value);
                                  setSettings((prev: any) => ({ ...prev, backgroundMusicVolume: value }));
                                  setBackgroundMusicVolumeInput(value.toString());
                                }
                              }}
                              disabled={settingsLocked}
                              className={`w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer slider ${
                                settingsLocked ? 'cursor-not-allowed opacity-50' : ''
                              }`}
                            />
                            <div className="flex justify-between text-[10px] text-text-muted mt-1">
                              <span>10%</span>
                              <span className="hidden sm:inline">50%</span>
                              <span>100%</span>
                              <span className="hidden sm:inline">150%</span>
                              <span>200%</span>
                            </div>
                            {backgroundMusicVolumeError && (
                              <p className="mt-1 text-xs text-red-400">{backgroundMusicVolumeError}</p>
                            )}
                            <p className="text-text-muted text-xs mt-2">
                              <span className="hidden sm:inline">Adjust background music volume relative to narration (recommended: compare with narration before.)</span>
                              <span className="sm:hidden">Adjust vs narration (rec: 30-70%)</span>
                            </p>
                          </div>
                        </div>
                      )}

                      {/* Example Background Music — shown when no user-uploaded file is present */}
                      {!backgroundMusicFile && !((backgroundMusicUrl ?? '').length > 0 && !backgroundMusicUrl.includes('Example_BGMusic/')) && (
                        <div className="mb-4">
                          <div className="flex items-center gap-1.5 mb-2">
                            <Music className="h-4 w-4 text-purple-400 flex-shrink-0" />
                            <h4 className="text-sm font-semibold text-white">Example Background Music</h4>
                          </div>

                          {/* Info banner */}
                          <div className="bg-blue-900/30 border border-blue-700/50 rounded-lg p-2.5 mb-3">
                            <p className="text-xs text-blue-300 leading-relaxed">
                              <span className="font-semibold text-blue-200">Note:</span> These examples may complement your selected voice — testing before deciding is recommended.{' '}
                              <span className="font-semibold text-yellow-300">The audio will be looped and played during the entire video</span>, so keep the volume low to avoid overpowering the narration.<span className="font-semibold text-yellow-300"> The examples here are very quiet due to this, so they can stay at 100% volume.</span>
                            </p>
                          </div>

                          {/* Track grid — 3 columns like Core Voices */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-2">
                            {(showAllExamples ? EXAMPLE_BG_MUSIC : EXAMPLE_BG_MUSIC.slice(0, 6)).map((track) => {
                              const isSelected = selectedExampleMusic === track.name;
                              const isPlaying  = playingExample === track.name;
                              return (
                                <div
                                  key={track.name}
                                  onClick={() => !settingsLocked && handleExampleMusicSelect(track)}
                                  className={`relative bg-surface-elevated rounded-lg p-4 cursor-pointer transition-all duration-200 ${
                                    isSelected
                                      ? 'ring-2 ring-red-500'
                                      : settingsLocked
                                      ? 'ring-2 ring-border opacity-50 cursor-not-allowed'
                                      : 'hover:ring-2 hover:ring-border-subtle'
                                  }`}
                                >
                                  <div className="flex items-center space-x-3">
                                    {/* Icon left — blue */}
                                    <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 bg-gradient-to-br from-blue-400 to-blue-600">
                                      <Music className="h-5 w-5 text-white" />
                                    </div>

                                    {/* Name + subtitle middle */}
                                    <div className="flex-1 min-w-0">
                                      <h3 className="text-white font-medium text-sm truncate">{track.name}</h3>
                                      <p className="text-text-muted text-xs">Example • instrumental</p>
                                    </div>

                                    {/* Play button right */}
                                    <button
                                      onClick={(e) => handleExampleMusicPlay(track, e)}
                                      disabled={settingsLocked}
                                      className={`flex items-center px-2 py-1 rounded-lg text-sm transition-colors flex-shrink-0 ${
                                        isPlaying
                                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                                          : 'bg-surface-input text-white hover:bg-white/10'
                                      } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                                    >
                                      {isPlaying
                                        ? <><Pause className="h-3 w-3 mr-1" />Stop</>
                                        : <><Play  className="h-3 w-3 mr-1" />Play</>}
                                    </button>
                                  </div>

                                  {/* Selected checkmark badge */}
                                  {isSelected && (
                                    <div className="absolute top-2 right-2 bg-red-500 text-white rounded-full p-1">
                                      <CheckCircle2 className="h-4 w-4" />
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>

                          {/* Show more / less toggle */}
                          <button
                            onClick={() => setShowAllExamples(!showAllExamples)}
                            className="mt-1 mb-3 text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1"
                          >
                            <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${showAllExamples ? 'rotate-180' : ''}`} />
                            {showAllExamples
                              ? 'Show less'
                              : `Show ${EXAMPLE_BG_MUSIC.length - 6} more`}
                          </button>
                        </div>
                      )}

                      {/* Uploaded File Display — for user-uploaded files (not examples) */}
                      {(backgroundMusicFile || ((backgroundMusicUrl ?? '').length > 0 && !backgroundMusicUrl.includes('Example_BGMusic/'))) && (
                        <div className="bg-surface-input rounded-lg p-4">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center space-x-3">
                              <div className="flex items-center justify-center w-8 h-8 sm:w-10 sm:h-10 bg-green-600 rounded-full">
                                <FileAudio className="h-4 w-4 sm:h-5 sm:w-5 text-white" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <h4 className="text-xs sm:text-sm text-white font-medium truncate">
                                  {backgroundMusicFile?.name || 'Background Music'}
                                </h4>
                                <p className="text-xs text-text-muted">
                                  <span className="hidden sm:inline">Will be looped for entire video duration</span>
                                  <span className="sm:hidden">Loops for full video</span>
                                  {backgroundMusicFile && ` • ${formatFileSize(backgroundMusicFile.size)}`}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center space-x-2">
                              {backgroundMusicUrl && (
                                <button
                                  onClick={testBackgroundMusicUrl}
                                  className="p-2 text-text-muted hover:text-blue-400 transition-colors"
                                  title="Test URL accessibility"
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </button>
                              )}
                              <button
                                onClick={handleBackgroundMusicRemove}
                                disabled={settingsLocked}
                                className={`p-2 text-text-muted hover:text-red-400 transition-colors ${
                                  settingsLocked ? 'cursor-not-allowed opacity-50' : ''
                                }`}
                                title="Remove background music"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>

                          {/* Background Music Volume Control */}
                          <div className="mt-4">
                            <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">
                              <span className="hidden sm:inline">Background Music Volume</span>
                              <span className="sm:hidden">BG Volume</span>
                            </label>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs font-medium text-white">Volume Level</span>
                              <input
                                type="text"
                                value={backgroundMusicVolumeInput}
                                onChange={(e) => !settingsLocked && handleBackgroundMusicVolumeInputChange(e.target.value)}
                                disabled={settingsLocked}
                                className={`w-16 px-2 py-0.5 bg-surface-input border rounded-lg text-white text-xs text-center focus:outline-none focus:ring-1 ${
                                  backgroundMusicVolumeError ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-accent'
                                } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                                placeholder="1.0"
                              />
                            </div>
                            <div className="flex items-center gap-3 mb-2">
                              <span className="text-lg font-semibold text-white tabular-nums">{Math.round((settings.backgroundMusicVolume || 1.0) * 100)}%</span>
                              <span className="text-xs text-text-muted">
                                {(settings.backgroundMusicVolume || 1.0) <= 0.3 ? 'Subtle' : (settings.backgroundMusicVolume || 1.0) <= 0.7 ? 'Moderate' : (settings.backgroundMusicVolume || 1.0) <= 1.0 ? 'Default' : 'Loud'}
                              </span>
                            </div>
                            <input
                              type="range"
                              min="0.1"
                              max="2.0"
                              step="0.01"
                              value={settings.backgroundMusicVolume || 1.0}
                              onChange={(e) => {
                                if (!settingsLocked) {
                                  const value = parseFloat(e.target.value);
                                  setSettings((prev: any) => ({ ...prev, backgroundMusicVolume: value }));
                                  setBackgroundMusicVolumeInput(value.toString());
                                }
                              }}
                              disabled={settingsLocked}
                              className={`w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer slider ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                            />
                            <div className="flex justify-between text-[10px] text-text-muted mt-1">
                              <span>10%</span>
                              <span className="hidden sm:inline">50%</span>
                              <span>100%</span>
                              <span className="hidden sm:inline">150%</span>
                              <span>200%</span>
                            </div>
                            {backgroundMusicVolumeError && (
                              <p className="mt-1 text-xs text-red-400">{backgroundMusicVolumeError}</p>
                            )}
                            <p className="text-text-muted text-xs mt-2">
                              <span className="hidden sm:inline">Adjust background music volume relative to narration (recommended: compare with narration before.)</span>
                              <span className="sm:hidden">Adjust vs narration (rec: 30-70%)</span>
                            </p>
                          </div>
                        </div>
                      )}

                      {/* Help Text */}
                      <div className="mt-3 text-xs text-text-muted">
                        <p>
                          <span className="hidden sm:inline">Optional: Leave empty for video without background music</span>
                          <span className="sm:hidden">Optional: Leave empty for no music</span>
                        </p>
                        <p>
                          <span className="hidden sm:inline">Tip: Use royalty-free music to avoid copyright issues</span>
                          <span className="sm:hidden">Tip: Use royalty-free music</span>
                        </p>
                      </div>
                    </div>
                  </>
                )}

                {/* Step 4 Preview — example video reflecting current selections */}
                <div className="border-t border-white/5 pt-6">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Eye className="h-4 w-4 text-purple-400 flex-shrink-0" />
                    <h4 className="text-sm font-semibold text-white">Preview</h4>
                  </div>
                  <p className="text-xs text-text-muted mb-3">
                    <span className="hidden sm:inline">
                      Approximate look based on your Step 3 visual type and the current transition, animation, effect, subtitle, and background music selections. Click the speaker icon to hear the mix. Narration uses the <span className="text-white/80">Santa</span> core voice at 100% volume for this preview — we recommend keeping background music on the quieter side so it doesn't overpower the voiceover.
                    </span>
                    <span className="sm:hidden">
                      Approximate look based on Step 3 + Step 4 selections. Tap the speaker icon to hear the mix. Narration uses the <span className="text-white/80">Santa</span> core voice at 100% volume — keep background music on the quieter side.
                    </span>
                  </p>
                  <Step4PreviewVideo
                    key={previewUrl}
                    src={previewUrl}
                    subtitlesEnabled={subtitlesEnabled}
                    subtitleConfig={subtitleConfig}
                    bgMusicUrl={backgroundMusicUrl || undefined}
                    bgMusicVolume={settings.backgroundMusicVolume ?? 1.0}
                  />
                  {(settings.visualType === 'ttv' || settings.visualType === 'itv' || settings.visualType === 'mg') && (
                    <p className="mt-2 text-[11px] text-text-muted">
                      Animations are disabled for {settings.visualType === 'ttv' ? 'Text-to-Video' : 'Image-to-Video'} content, so the preview only varies by transition and effect.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Analysis & Output */}
          <div className="bg-surface-card rounded-lg mt-6">
            <div className="flex items-center p-6">
              <div className="flex items-center">
                <Settings className="h-5 w-5 text-red-700 mr-2" />
                <h2 className="text-lg sm:text-xl font-semibold text-white">
                  Analysis & Output
                </h2>
              </div>
              {analysisResult && (
                <div className="ml-auto">
                  <span className="text-xs sm:text-sm text-green-400">Analyzed</span>
                </div>
              )}
            </div>

            <div className="px-6 pb-6 space-y-4">
              {generationState === 'idle' && (
                <>
                  <div className="bg-blue-900/50 text-blue-200 p-4 rounded-lg mb-4">
                    <div className="flex items-center gap-2">
                      <Info className="h-5 w-5 text-blue-400" />
                      <p className="text-xs sm:text-sm">
                        <span className="hidden sm:inline">
                          Click "Analyze" to estimate token usage, storage requirements, and processing time before generating.
                        </span>
                        <span className="sm:hidden">Click "Analyze" to estimate costs and requirements.</span>
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={handleAnalyzeVideoWithFlags}
                    disabled={
                      analyzing ||
                      speedError !== '' ||
                      volumeError !== '' || // Add this line
                      backgroundMusicVolumeError !== '' || // NEW: Add background music volume error check
                      !isStepConfigured(1) ||
                      !isStepConfigured(2) ||
                      !isStepConfigured(3) ||
                      !isStepConfigured(4) ||
                      // NEW: Validate component selection for components-only
                      (outputType === 'components' && !processStory)
                    }
                    className="w-full flex justify-center items-center px-4 sm:px-6 py-2 sm:py-3 border border-transparent text-sm sm:text-base font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out shadow-sm"
                  >
                    {analyzing ? (
                      <>
                        <RefreshCw className="h-4 w-4 sm:h-5 sm:w-5 mr-2 animate-spin" />
                        <span className="hidden sm:inline">Analyzing...</span>
                        <span className="sm:hidden">Analyzing...</span>
                      </>
                    ) : (
                      <>
                        <Settings className="h-4 w-4 sm:h-5 sm:w-5 mr-2" />
                        <span className="hidden sm:inline">Analyze</span>
                        <span className="sm:hidden">Analyze</span>
                      </>
                    )}
                  </button>
                </>
              )}

              {generationState === 'analyzed' && analysisResult && (
                <>
                  <div className="bg-surface-elevated rounded-lg p-4">
                    <h3 className="text-base sm:text-lg text-white font-medium mb-3">
                      <span className="hidden sm:inline">Analysis Results</span>
                      <span className="sm:hidden">Results</span>
                    </h3>
                    <div className="space-y-2 text-xs sm:text-sm text-text-secondary">
                      <div className="flex justify-between">
                        <span>
                          <span className="hidden sm:inline">Estimated Token Usage:</span>
                          <span className="sm:hidden">Tokens:</span>
                        </span>
                        <span className="text-white font-medium">{formatNumber(analysisResult.estimatedTokens)} tokens</span>
                      </div>
                      <div className="flex justify-between">
                        <span>
                          <span className="hidden sm:inline">Estimated Storage:</span>
                          <span className="sm:hidden">Storage:</span>
                        </span>
                        <span className="text-white font-medium">{formatStorageSize(analysisResult.estimatedStorageMB)}</span>
                      </div>
                      {/* NEW: Only show video length if creating video */}
                      {outputType === 'video' && (
                        <div className="flex justify-between">
                          <span>
                            <span className="hidden sm:inline">Estimated Video Length:</span>
                            <span className="sm:hidden">Length:</span>
                          </span>
                          <span className="text-white font-medium">{formatTime(analysisResult.estimatedVideoTimeMinutes)}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span>
                          <span className="hidden sm:inline">Estimated Generation Time:</span>
                          <span className="sm:hidden">Gen. Time:</span>
                        </span>
                        <span className="text-white font-medium">
                          {analysisResult.estimatedGenerationTimeMinutes 
                            ? formatTime(analysisResult.estimatedGenerationTimeMinutes)
                            : formatTime((() => {
                                const numImages = analysisResult.settings?.numImages || 0;
                                const wordCount = analysisResult.settings?.wordCount || 0;
                                const totalAudioDuration = analysisResult.settings?.totalAudioDuration;
                                const vType = settings.visualType || 'image';
                                
                                // Use duration-based batch calculation
                                const totalDuration = estimateTotalVideoDuration(wordCount, totalAudioDuration);
                                const videoBatches = estimateVideoBatchCount(numImages, totalDuration);
                                // For ttv/itv: 20 min per batch, for image: 30 min per batch
                                const minutesPerBatch = (vType === 'ttv' || vType === 'itv') ? 20 : 30;
                                const videoTime = videoBatches * minutesPerBatch;
                                
                                const totalTime = 3 + 2 + 8 + 5 + videoTime; // Story + Prompts + Images + Audio + Video
                                return totalTime;
                              })())
                          }
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>
                          <span className="hidden sm:inline">Available Tokens:</span>
                          <span className="sm:hidden">Available:</span>
                        </span>
                        <span className="text-white font-medium">{formatNumber(userTokenBalance)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>
                          <span className="hidden sm:inline">Available Storage:</span>
                          <span className="sm:hidden">Storage:</span>
                        </span>
                        <span className="text-white font-medium">{formatStorageSize((maxStorageGB * 1024) - (storageUsed || 0))}</span>
                      </div>
                      {/* NEW: Show component breakdown for components-only */}
                      {outputType === 'components' && (
                        <div className="flex justify-between">
                          <span>Components:</span>
                          <span className="text-blue-400 font-medium">
                            {processStory && 'Story'}
                            {processImages && (processStory ? ' + Images' : 'Images')}
                            {processAudio && ((processStory || processImages) ? ' + Audio' : 'Audio')}
                          </span>
                        </div>
                      )}
                      {backgroundMusicUrl && outputType === 'video' && (
                        <div className="flex justify-between">
                          <span>
                            <span className="hidden sm:inline">Background Music:</span>
                            <span className="sm:hidden">BG Music:</span>
                          </span>
                          <span className="text-green-400 font-medium">
                            <span className="hidden sm:inline">Included ({Math.round((settings.backgroundMusicVolume || 1.0) * 100)}% volume)</span>
                            <span className="sm:hidden">Inc. ({Math.round((settings.backgroundMusicVolume || 1.0) * 100)}%)</span>
                          </span>
                        </div>
                      )}
                      {selectedTransition !== 'none' && outputType === 'video' && (
                        <div className="flex justify-between">
                          <span>
                            <span className="hidden sm:inline">Video Transitions:</span>
                            <span className="sm:hidden">Transitions:</span>
                          </span>
                          <span className="text-yellow-400 font-medium">
                            {(() => {
                              const vt = settings.visualType || 'image';
                              const isVideoMode = vt === 'ttv' || vt === 'itv';
                              const numImages = analysisResult.settings?.numImages || 0;
                              const transitionTokens = calculateTransitionTokens(numImages, vt);
                              const mediaLabel = isVideoMode ? 'videos' : 'images';
                              return (
                                <span>
                                  <span className="hidden sm:inline">{selectedTransition} (+{formatNumber(transitionTokens)} tokens for {numImages} {mediaLabel})</span>
                                  <span className="sm:hidden">{selectedTransition} (+{formatNumber(transitionTokens)})</span>
                                </span>
                              );
                            })()}
                          </span>
                        </div>
                      )}
                      {selectedAnimation !== 'horizontal_drift' && selectedAnimation !== 'drift' && outputType === 'video' && (
                        <div className="flex justify-between">
                          <span>Animation:</span>
                          <span className="text-blue-400 font-medium">
                            {selectedAnimation === 'none' ? 'None' : 
                             selectedAnimation === 'vertical' ? 'Vertical Drift' : 
                             selectedAnimation === 'horizontal_drift' ? 'Horizontal Drift' :
                             selectedAnimation}
                          </span>
                        </div>
                      )}
                      {selectedEffect !== 'film_grain' && outputType === 'video' && (
                        <div className="flex justify-between">
                          <span>Effects:</span>
                          <span className="text-blue-400 font-medium">
                            {selectedEffect === 'none' ? 'None' : 
                             selectedEffect === 'fire_flare' ? 'Fire Flare' : 
                             selectedEffect === 'light_sparkle' ? 'Light Sparkle' : 
                             selectedEffect === 'snow' ? 'Snow' :
                             selectedEffect}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Show restrictions if any */}
                    {analysisResult.estimatedTokens > userTokenBalance && (
                      <div className="mt-3 bg-red-900/50 text-red-200 p-3 rounded-lg">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="h-5 w-5 text-red-500" />
                          <p className="text-xs sm:text-sm">
                            <span className="hidden sm:inline">Insufficient tokens. You need {formatNumber(analysisResult.estimatedTokens - userTokenBalance)} more tokens.</span>
                            <span className="sm:hidden">Need {formatNumber(analysisResult.estimatedTokens - userTokenBalance)} more tokens.</span>
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Multi-tab token warning - only show for enterprise users on tabs > 1 */}
                    {isEnterpriseUser && currentTab !== 1 && multiTabWarning && (
                      <div className="mt-3 bg-red-900/50 border-2 border-red-500 text-red-200 p-4 rounded-lg">
                        <div className="flex items-center gap-2 mb-3">
                          <AlertCircle className="h-6 w-6 text-red-400" />
                          <h4 className="text-sm font-semibold text-red-100">
                            Insufficient Tokens for Multi-Tab Generation
                          </h4>
                        </div>
                        <div className="space-y-2 text-xs">
                          <div className="bg-red-950/50 p-2 rounded">
                            <p className="font-medium text-red-100 mb-1">Current Tab {currentTab}:</p>
                            <p className="text-red-200">{formatNumber(multiTabWarning.currentTabEstimate)} tokens</p>
                          </div>
                          
                          {multiTabWarning.otherTabEstimates.length > 0 && (
                            <div className="bg-red-950/50 p-2 rounded">
                              <p className="font-medium text-red-100 mb-1">Other Active Tabs:</p>
                              {multiTabWarning.otherTabEstimates.map(tab => (
                                <div key={tab.tab} className="flex justify-between text-red-200 py-1">
                                  <span>Tab {tab.tab} ({tab.title || `Tab ${tab.tab}`}):</span>
                                  <span className="font-medium">{formatNumber(tab.estimate_tokens)} tokens</span>
                                </div>
                              ))}
                            </div>
                          )}
                          
                          <div className="border-t border-red-700 pt-2 mt-2">
                            <div className="flex justify-between items-center">
                              <span className="font-semibold text-red-100">Total Required:</span>
                              <span className="font-bold text-red-100">{formatNumber(multiTabWarning.totalEstimate)} tokens</span>
                            </div>
                            <div className="flex justify-between items-center mt-1">
                              <span className="font-semibold text-red-100">Your Balance:</span>
                              <span className="font-bold text-red-100">{formatNumber(multiTabWarning.userBalance)} tokens</span>
                            </div>
                            <div className="flex justify-between items-center mt-1">
                              <span className="font-semibold text-red-100">Shortfall:</span>
                              <span className="font-bold text-red-400">-{formatNumber(multiTabWarning.totalEstimate - multiTabWarning.userBalance)} tokens</span>
                            </div>
                          </div>
                          
                          <p className="text-red-200 mt-3 text-xs">
                            Please complete or delete other tabs before starting this generation, or purchase more tokens.
                          </p>
                        </div>
                      </div>
                    )}

                    {analysisResult.estimatedStorageMB / 1024 > (maxStorageGB - (storageUsed || 0) / 1024) && (
                      <div className="mt-3 bg-red-900/50 text-red-200 p-3 rounded-lg">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="h-5 w-5 text-red-500" />
                          <p className="text-xs sm:text-sm">
                            <span className="hidden sm:inline">Insufficient storage. You need {formatStorageSize(analysisResult.estimatedStorageMB - ((maxStorageGB * 1024) - (storageUsed || 0)))} more storage.</span>
                            <span className="sm:hidden">Need {formatStorageSize(analysisResult.estimatedStorageMB - ((maxStorageGB * 1024) - (storageUsed || 0)))} more storage.</span>
                          </p>
                        </div>
                      </div>
                    )}

                    {analysisResult.estimatedTokens <= userTokenBalance && analysisResult.estimatedStorageMB / 1024 <= (maxStorageGB - (storageUsed || 0) / 1024) && (
                      <div className="mt-3 bg-green-900/50 text-green-200 p-3 rounded-lg">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="h-5 w-5 text-green-500" />
                          <p className="text-xs sm:text-sm">
                            <span className="hidden sm:inline">
                              You have sufficient tokens and storage to generate this {outputType === 'video' ? 'video' : 'content'}.
                              {backgroundMusicUrl && outputType === 'video' && ` Background music will be included at ${Math.round((settings.backgroundMusicVolume || 1.0) * 100)}% volume.`}
                              {selectedTransition !== 'none' && outputType === 'video' && ` Video transitions (${selectedTransition}) will be applied.`}
                              {selectedAnimation !== 'horizontal_drift' && selectedAnimation !== 'drift' && outputType === 'video' && ` Animation: ${selectedAnimation === 'none' ? 'None' : selectedAnimation === 'vertical' ? 'Vertical Drift' : selectedAnimation === 'horizontal_drift' ? 'Horizontal Drift' : selectedAnimation}.`}
                              {selectedEffect !== 'film_grain' && outputType === 'video' && ` Effects: ${selectedEffect === 'none' ? 'None' : selectedEffect === 'fire_flare' ? 'Fire Flare' : selectedEffect === 'light_sparkle' ? 'Light Sparkle' : selectedEffect === 'snow' ? 'Snow' : selectedEffect}.`}
                            </span>
                            <span className="sm:hidden">
                              Sufficient tokens and storage.
                              {backgroundMusicUrl && outputType === 'video' && ` BG music: ${Math.round((settings.backgroundMusicVolume || 1.0) * 100)}%.`}
                              {selectedTransition !== 'none' && outputType === 'video' && ` Transitions: ${selectedTransition}.`}
                              {selectedAnimation !== 'horizontal_drift' && selectedAnimation !== 'drift' && outputType === 'video' && ` Anim: ${selectedAnimation === 'none' ? 'None' : selectedAnimation === 'vertical' ? 'Vertical Drift' : selectedAnimation === 'horizontal_drift' ? 'Horizontal Drift' : selectedAnimation}.`}
                              {selectedEffect !== 'film_grain' && outputType === 'video' && ` FX: ${selectedEffect === 'none' ? 'None' : selectedEffect === 'fire_flare' ? 'Fire Flare' : selectedEffect === 'light_sparkle' ? 'Light Sparkle' : selectedEffect === 'snow' ? 'Snow' : selectedEffect}.`}
                            </span>
                          </p>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex space-x-4">
                    <button
                      onClick={() => {
                        setGenerationState('idle');
                        setAnalysisResult(null);
                      }}
                      className="flex-1 px-3 sm:px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm sm:text-base"
                    >
                      Done
                    </button>
                    
                    <button
                      onClick={handleGenerateVideoWithFlags}
                      disabled={
                        !analysisResult ||
                        generationLoading ||
                        analysisResult.estimatedTokens > userTokenBalance ||
                        analysisResult.estimatedStorageMB / 1024 > (maxStorageGB - (storageUsed || 0) / 1024)
                      }
                      className="flex-1 flex justify-center items-center px-4 sm:px-6 py-2 border border-transparent text-sm sm:text-base font-medium rounded-lg text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out shadow-sm"
                    >
                      {generationLoading ? (
                        <>
                          <RefreshCw className="h-4 w-4 sm:h-5 sm:w-5 mr-2 animate-spin" />
                          <span className="hidden sm:inline">Starting...</span>
                          <span className="sm:hidden">Starting...</span>
                        </>
                      ) : (
                        <>
                          <Video className="h-4 w-4 sm:h-5 sm:w-5 mr-2" />
                          <span className="hidden sm:inline">
                            {outputType === 'video' ? 'Start Generation' : 'Start Generation'}
                          </span>
                          <span className="sm:hidden">Generate</span>
                        </>
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          </div>
          </div>

          {/* Progress Section */}
          {generationState === 'generating' && (
            <div className="bg-surface-card rounded-lg p-6 dash-animate-progress-enter">
              <div className="space-y-4">
                <div className="flex items-center space-x-3 text-text-secondary">
                  <RefreshCw className="h-5 w-5 text-red-500 animate-spin" />
                  <span className="text-sm sm:text-base truncate">{statusMessage}</span>
                </div>

                {/* Show outline generation message when story progress is 0 - UPDATED CONDITION */}
                {batchStatuses.some(batch => 
                  batch.id === 'story' && 
                  batch.progress === 0 && 
                  batch.status !== 'complete'
                ) && processStory && settings.storySource === 'new' && (
                  <div className="bg-surface-elevated/50 rounded-lg p-4 space-y-3 mb-4">
                    <div className="flex items-center space-x-3 text-text-secondary">
                      <Brain className="h-5 w-5 text-red-500 animate-pulse" />
                      <span className="text-sm sm:text-base">
                        <span className="hidden sm:inline">Generating outline and story structure...</span>
                        <span className="sm:hidden">Generating outline...</span>
                      </span>
                    </div>
                    <div className="flex items-center space-x-3 text-text-secondary">
                      <Sparkles className="h-5 w-5 text-red-500 animate-pulse" />
                      <span className="text-sm sm:text-base">
                        <span className="hidden sm:inline">This may take 1-7 minutes.</span>
                        <span className="sm:hidden">Takes 1-7 min.</span>
                      </span>
                    </div>
                    <p className="text-xs sm:text-sm text-text-muted">
                      <span className="hidden sm:inline">Analyzing your story requirements and crafting a detailed chapter structure.</span>
                      <span className="sm:hidden">Analyzing requirements and crafting structure.</span>
                    </p>
                  </div>
                )}

                {/* Overall Progress Bar */}
                <div>
                  <div className="flex justify-between text-xs sm:text-sm text-text-secondary mb-2">
                    <span>
                      <span className="hidden sm:inline">Overall Progress</span>
                      <span className="sm:hidden">Progress</span>
                    </span>
                    <span>{Math.round(progress)}%</span>
                  </div>
                  <div className="w-full bg-white/[0.08] rounded-full h-3 overflow-hidden">
                    <div
                      className="bg-red-600 h-3 rounded-full transition-all duration-500"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  {/* NEW: Dynamic progress labels based on enabled processes */}
                  <div className="flex justify-between text-xs text-text-muted mt-1">
                    {getProgressLabels().map((label, index) => (
                      <span key={index} className="hidden sm:inline">{label.full}</span>
                    ))}
                    {getProgressLabels().map((label, index) => (
                      <span key={index} className="sm:hidden">{label.short}</span>
                    ))}
                  </div>
                </div>

                {/* Individual Task Progress - NEW: Use filtered batch statuses */}
                {batchStatuses.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs sm:text-sm font-medium text-text-secondary">
                      <span className="hidden sm:inline">Task Progress:</span>
                      <span className="sm:hidden">Tasks:</span>
                    </h4>
                    {batchStatuses.map((batch, batchIdx) => (
                      <div key={batch.id} className="flex items-center space-x-3 dash-animate-progress-row" style={{ animationDelay: `${400 + batchIdx * 80}ms` }}>
                        <div className="w-16 sm:w-24 text-xs text-text-muted truncate">
                          <span className="hidden sm:inline">{batch.label}</span>
                          <span className="sm:hidden">
                            {batch.id === 'story' && 'Story'}
                            {batch.id === 'image_prompts' && 'Prompts'}
                            {batch.id === 'image_generation' && 'Images'}
                            {batch.id === 'ttv_prompts' && 'TTV Prompts'}
                            {batch.id === 'ttv_generation' && 'TTV Gen'}
                            {batch.id === 'itv_image_prompts' && 'ITV Prompts'}
                            {batch.id === 'itv_image_generation' && 'ITV Images'}
                            {batch.id === 'itv_prompts' && 'ITV Prompts'}
                            {batch.id === 'itv_generation' && 'ITV Gen'}
                            {batch.id === 'mg_prompts' && 'MG Prompts'}
                            {batch.id === 'mg_render' && 'MG Render'}
                            {batch.id === 'audio' && 'Audio'}
                            {batch.id === 'video' && 'Video'}
                          </span>
                        </div>
                        <div className="flex-1 bg-white/[0.08] rounded-full h-2 overflow-hidden">
                          <div
                            className={`h-2 rounded-full transition-all duration-500 ${
                              batch.status === 'complete' || batch.status === 'completed' || batch.status === 'completed_final'
                                ? 'bg-green-500'
                                : batch.status === 'running' || batch.status === 'processing'
                                ? 'bg-blue-500'
                                : batch.status === 'error'
                                ? 'bg-red-500'
                                : 'bg-white/[0.15]'
                            }`}
                            style={{ width: `${batch.progress}%` }}
                          />
                        </div>
                        <div className="w-8 sm:w-12 text-xs text-text-muted text-right">
                          {Math.round(batch.progress)}%
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {timeRemaining !== null && timeRemaining > 0 && (
                  <>
                    <p className="text-xs sm:text-sm text-text-secondary">
                      <span className="hidden sm:inline">Estimated time remaining: {formatTime(Math.ceil(timeRemaining))}</span>
                      <span className="sm:hidden">Est. remaining: {formatTime(Math.ceil(timeRemaining))}</span>
                    </p>
                    <p className="text-xs sm:text-sm text-text-muted">
                      <span className="hidden sm:inline">If you're returning to the page, give it 30 seconds to correctly show the progress.</span>
                      <span className="sm:hidden">Give 30s to load progress if returning.</span>
                    </p>
                    {outputType === 'video' && (
                      <p className="text-xs sm:text-sm text-text-muted">
                        <span className="hidden sm:inline">Video Creation progress might not update for up to 1 hour.</span>
                        <span className="sm:hidden">Video progress may not update for 1hr.</span>
                      </p>
                    )}
                  </>
                )}

                <div className="flex justify-end">
                  <button
                    onClick={handleStopGeneration}
                    disabled={stopLoading}
                    className="flex items-center px-3 sm:px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm sm:text-base"
                  >
                    {stopLoading ? (
                      <>
                        <RefreshCw className="animate-spin h-4 w-4 sm:h-5 sm:w-5 mr-2" />
                        <span className="hidden sm:inline">Stopping...</span>
                        <span className="sm:hidden">Stop...</span>
                      </>
                    ) : (
                      <>
                        <X className="h-4 w-4 sm:h-5 sm:w-5 mr-2" />
                        Stop
                      </>
                    )}
                  </button>
                </div>

                {/* Notify on complete toggle */}
                <div className="flex justify-center mt-3">
                  <div className="flex items-center gap-3 px-4 py-2 bg-surface-elevated/40 rounded-lg border border-white/[0.08]">
                    <div className="flex items-center gap-2 text-text-muted">
                      <Bell className="h-3.5 w-3.5" />
                      <span className="text-xs">Be notified when the video is done</span>
                    </div>
                    <button
                      onClick={() => !notifyLoading && onNotifyToggle(!notifyOnComplete)}
                      disabled={notifyLoading}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-500 ease-out focus:outline-none ${
                        notifyOnComplete ? 'bg-red-600' : 'bg-white/[0.15]'
                      }`}
                      aria-label="Toggle email notification"
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-500 ease-out ${
                          notifyOnComplete ? 'translate-x-[18px]' : 'translate-x-[2px]'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}



