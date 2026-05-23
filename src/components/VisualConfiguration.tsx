import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { Listbox, Transition } from '@headlessui/react';
import { 
  Image, Film, Video, Info, Upload, ChevronDown, X, 
  RefreshCw, CheckCircle2, Calendar, Play, AlertCircle, Wand2
} from 'lucide-react';
import { VIDEO_MODEL_OPTIONS, TTV_STYLES, getStyleVideoUrl, buildVideoModelOptions } from './VideoModelSelector';
import ITVVideoModelSelector, { 
  ITV_VIDEO_MODEL_OPTIONS,
  ITV_AUDIO_SUPPORTED_MODELS,
  buildITVVideoModelOptions,
} from './ITVVideoModelSelector';
import ImageModelSelector from './ImageModelSelector';
import ImageFrequencyConfiguration from './ImageFrequencyConfiguration';
import MGStyleSelector from './MGStyleSelector';
import { MG_DEFAULT_STYLE_SLUG, MG_DEFAULT_CLIP_SECONDS, resolveStyleGuidance } from '../data/mgStyles';
import {
  MG_MIN_CLIP_SECONDS,
  MG_MAX_CLIP_SECONDS,
  MG_SECONDS_PER_CLIP_RENDER,
  MG_MB_PER_CLIP,
  MG_LAMBDA_TOKENS_PER_SECOND,
  MG_LANGUAGE_OPTIONS,
  MG_CODEGEN_MODEL_OPTIONS,
  mgCodegenTokensPerClip,
  type MGCodegenModel,
} from '../utils/mgCostConstants';
import { useIsLegacyPlan } from '../hooks/useIsLegacyPlan';
import {
  LEGACY_LLM_MULTIPLIERS,
  NEW_LLM_MULTIPLIERS,
  LEGACY_IMAGE_TOKENS_PER_IMAGE,
  NEW_IMAGE_TOKENS_PER_IMAGE,
  LEGACY_TTV_TOKENS_PER_SECOND,
  NEW_TTV_TOKENS_PER_SECOND,
  LEGACY_TTV_TOKENS_PER_SECOND_AUDIO,
  NEW_TTV_TOKENS_PER_SECOND_AUDIO,
} from '../data/tokenCosts';

// ─── Constants ────────────────────────────────────────────────────────────────

const IMAGE_MODEL_OPTIONS = [
  {
    value: 'imagen-4-fast',
    label: 'Lite Model',
    tokensPerImage: 14000,
    borderColor: 'border-blue-500',
    bgColor: 'bg-blue-500/20',
    textColor: 'text-blue-300',
    hoverBorder: 'hover:border-blue-400'
  },
  {
    value: 'grok-imagine-image',
    label: 'Grok Model',
    tokensPerImage: 16000,
    borderColor: 'border-orange-500',
    bgColor: 'bg-orange-500/20',
    textColor: 'text-orange-300',
    hoverBorder: 'hover:border-orange-400'
  },
  {
    value: 'gpt-image-1-mini',
    label: 'Core Model',
    tokensPerImage: 30000,
    borderColor: 'border-green-500',
    bgColor: 'bg-green-500/20',
    textColor: 'text-green-300',
    hoverBorder: 'hover:border-green-400'
  },
  {
    value: 'seedream-4.5',
    label: 'Prime Model',
    tokensPerImage: 35000,
    recommended: true,
    borderColor: 'border-teal-500',
    bgColor: 'bg-teal-500/20',
    textColor: 'text-teal-300',
    hoverBorder: 'hover:border-teal-400'
  },
  {
    value: 'imagen-4-ultra',
    label: 'Heavy Model',
    tokensPerImage: 42000,
    borderColor: 'border-purple-500',
    bgColor: 'bg-purple-500/20',
    textColor: 'text-purple-300',
    hoverBorder: 'hover:border-purple-400'
  },
  {
    value: 'nano-banana-pro',
    label: 'Genesis Model',
    tokensPerImage: 100000,
    borderColor: 'border-yellow-500',
    bgColor: 'bg-yellow-500/20',
    textColor: 'text-yellow-300',
    hoverBorder: 'hover:border-yellow-400'
  }
];

const IMAGE_MODEL_TOKENS: Record<string, number> = {
  'flux-2-dev': 7000,
  'imagen-4-fast': 14000,
  'grok-imagine-image': 16000,
  'gpt-image-1-mini': 30000,
  'seedream-4.5': 35000,
  'imagen-4-ultra': 42000,
  'nano-banana-pro': 100000,
};

const MODEL_OPTIONS = [
  { value: 'deepseek', label: 'Core Model', tokenMultiplier: 1, description: '1x tokens' },
  { value: 'sonnet', label: 'Claude Sonnet 4.6', tokenMultiplier: 11, description: '11x tokens' },
  { value: 'opus', label: 'Claude Opus 4.6', tokenMultiplier: 19, description: '19x tokens' },
];

// TTV-specific constants (matching TextToVideoGenerator)
const HIGH_RES_SUPPORTED_MODELS = new Set(['grok', 'sora2pro']);
const TTV_AUDIO_CLIP_SUPPORTED_MODELS = new Set(['ltx23_fast', 'ltx23_pro', 'seedance15_pro', 'grok', 'veo31fast', 'veo31', 'sora2pro', 'sora2pro_highres']);
const TTV_SECONDS_PER_VIDEO: Record<string, number> = {
  wan22: 360,
  sora2pro: 300,
  sora2pro_highres: 480,
  grok_highres: 120,
  seedance15_pro: 120,
  ltx23_pro: 120,
};
const TTV_DEFAULT_SECONDS_PER_VIDEO = 90;

// ITV timing constants for generation-time estimation
const ITV_SECONDS_PER_CLIP: Record<string, number> = {
  wan22: 90,
  seedance1fast: 90,
  hailuo23fast: 150,
  seedance15: 180,
  ltx23fast: 90,
  veo31fast: 180,
  ltx23pro: 120,
  veo31: 360,
  ltx23pro4k: 180,
};
const ITV_DEFAULT_SECONDS_PER_CLIP = 180;

// ITV image-generation seconds per image (keyed by backend image-model value)
const ITV_IMAGE_GEN_SECONDS: Record<string, number> = {
  'flux-2-dev': 15,
  'imagen-4-fast': 20,
  'grok-imagine-image': 22,
  'gpt-image-1-mini': 25,
  'seedream-4.5': 25,
  'imagen-4-ultra': 45,
  'nano-banana-pro': 60,
};
const ITV_DEFAULT_IMAGE_GEN_SECONDS = 25;

// Image-model backend-value → short display name
const IMAGE_MODEL_DISPLAY_NAMES: Record<string, string> = {
  'flux-2-dev': 'Spark',
  'imagen-4-fast': 'Lite',
  'grok-imagine-image': 'Grok',
  'gpt-image-1-mini': 'Core',
  'seedream-4.5': 'Prime',
  'imagen-4-ultra': 'Heavy',
  'nano-banana-pro': 'Genesis',
};

// Module-scope constants below mirror the LEGACY plan rates (matching the
// canonical values in src/data/tokenCosts.ts). In-component shadows below
// flip them to NEW rates for non-grandfathered users.
function buildImageOptionList(isLegacy: boolean) {
  const m = isLegacy ? LEGACY_IMAGE_TOKENS_PER_IMAGE : NEW_IMAGE_TOKENS_PER_IMAGE;
  return IMAGE_MODEL_OPTIONS.map(opt => ({
    ...opt,
    tokensPerImage: m[opt.value] ?? opt.tokensPerImage,
  }));
}
function buildImageModelTokens(isLegacy: boolean): Record<string, number> {
  const m = isLegacy ? LEGACY_IMAGE_TOKENS_PER_IMAGE : NEW_IMAGE_TOKENS_PER_IMAGE;
  return { ...m };
}
function buildModelOptionsList(isLegacy: boolean) {
  const m = isLegacy ? LEGACY_LLM_MULTIPLIERS : NEW_LLM_MULTIPLIERS;
  return [
    { value: 'deepseek', label: 'Core Model',        tokenMultiplier: m.deepseek, description: `${m.deepseek}x tokens` },
    { value: 'sonnet',   label: 'Claude Sonnet 4.6', tokenMultiplier: m.sonnet,   description: `${m.sonnet}x tokens` },
    { value: 'opus',     label: 'Claude Opus 4.6',   tokenMultiplier: m.opus,     description: `${m.opus}x tokens` },
  ];
}

const AUDIO_TOKENS_PER_SECOND: Record<string, number> = LEGACY_TTV_TOKENS_PER_SECOND_AUDIO;
const TTV_TOKENS_PER_SECOND: Record<string, number> = LEGACY_TTV_TOKENS_PER_SECOND;

type VisualType = 'image' | 'ttv' | 'itv' | 'mg';
type SourceType = 'generate' | 'folder' | 'upload';

// ─── Info box content per visual type ─────────────────────────────────────────

const VISUAL_TYPE_INFO: Record<VisualType, { title: string; description: string; bullets: string[] }> = {
  image: {
    title: 'Image Generation Pipeline',
    description: 'AI generates images from your story, which are displayed with subtle pan/zoom effects.',
    bullets: [
      'Most affordable option — great for long-form content',
      'Images shown with gentle movement (drift, zoom, pan)',
      'Supports 6 quality tiers from Spark to Genesis',
      'Best for story-driven, narration-heavy videos',
    ],
  },
  ttv: {
    title: 'Text-to-Video Pipeline',
    description: 'AI generates video clips directly from text prompts — the most cinematic option.',
    bullets: [
      'Produces fully animated video clips from descriptions',
      'Choose from 9 TTV models with varying quality & cost',
      '16 visual styles to match your story aesthetic',
      'Most expensive but highest visual impact',
    ],
  },
  itv: {
    title: 'Image-to-Video Pipeline',
    description: 'AI generates keyframe images, then animates them into video clips.',
    bullets: [
      'Two-stage process: image generation → video animation',
      'Lower-cost ITV models can produce great motion',
      'Brings static images to life with natural movement',
      'Good balance between cost and visual quality',
    ],
  },
  mg: {
    title: 'Motion Graphics Pipeline',
    description: 'Code-rendered animated clips — Claude programs each scene and Remotion renders the motion.',
    bullets: [
      'Typography, shapes, and abstract motion designed per scene',
      'Pre-animated clips — no Ken Burns or transitions needed',
      'Pick a style preset (cinematic, kinetic, minimal, etc.)',
      'Great for explainers, intros, and stylized storytelling',
    ],
  },
};

// ─── Utility functions ────────────────────────────────────────────────────────

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}

function fmtKps(n: number): string {
  const k = n / 1000;
  return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function estimateTimeRemaining(loaded: number, total: number, startTime: number): string | null {
  if (loaded <= 0 || total <= 0) return null;
  const elapsed = (Date.now() - startTime) / 1000;
  if (elapsed <= 0) return null;
  const rate = loaded / elapsed;
  const remaining = (total - loaded) / rate;
  if (remaining < 60) return `~${Math.ceil(remaining)}s remaining`;
  return `~${Math.ceil(remaining / 60)}m remaining`;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface VisualConfigurationProps {
  // Core settings
  settings: any;
  setSettings: (fn: any) => void;
  settingsLocked: boolean;

  // Visual type state (lifted to parent)
  visualType: VisualType;
  onVisualTypeChange: (type: VisualType) => void;

  // TTV state
  ttvModel: string;
  ttvStyle: string;
  ttvDuration: number;
  ttvAudioClip: boolean;
  onTTVModelChange: (model: string) => void;
  onTTVStyleChange: (style: string) => void;
  onTTVDurationChange: (duration: number) => void;
  onTTVAudioClipChange: (enabled: boolean) => void;

  // ITV state
  itvModel: string;
  itvDuration: number;
  itvAudioClip: boolean;
  onITVModelChange: (model: string) => void;
  onITVDurationChange: (duration: number) => void;
  onITVAudioClipChange: (enabled: boolean) => void;

  // Image configuration (existing)
  imageFolders: any[];
  documents: any[];
  uploadedFile: File | null;
  showMoreStyles: boolean;
  setShowMoreStyles: (val: boolean) => void;
  currentStyles: any[];
  isCustomStyle: (style: string) => boolean;
  validationErrors: any;
  languageOptions: any[];
  modelOptions: any[];

  // Folder selection helpers
  getImageFoldersForSelectedStory: () => any[];
  getImagePromptDocsForSelectedStory: () => any[];
  getTTVFoldersForSelectedStory: () => any[];
  getTTVPromptDocsForSelectedStory: () => any[];
  getITVVideoFoldersForSelectedStory: () => any[];
  getITVVideoPromptDocsForSelectedStory: () => any[];
  getITVImageFoldersForSelectedStory: () => any[];
  getITVImagePromptDocsForSelectedStory: () => any[];
  getMGPromptDocsForSelectedStory: () => any[];
  getMGVideoFoldersForSelectedStory: () => any[];

  // Video upload
  handleVideoFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => void;
  uploadingVideoLoop: boolean;
  uploadedVideoLoopFile: File | null;
  setUploadedVideoLoopFile: (file: File | null) => void;
  setVideoLoopUrl?: (url: string) => void;
  uploadedVideoMetadata: any;
  setUploadedVideoMetadata: (meta: any) => void;
  videoUploadProgress: number;
  videoUploadStartTime: number;

  // Frequency configuration
  frequencyMode: any;
  setFrequencyMode: any;
  frequencyType: any;
  setFrequencyType: any;
  consistentFrequency: string;
  setConsistentFrequency: (val: string) => void;
  audioDistributionType: any;
  setAudioDistributionType: any;
  firstPageImageAmount: string;
  setFirstPageImageAmount: (val: string) => void;
  restImageAmount: string;
  setRestImageAmount: (val: string) => void;
  totalAudioDuration: string;
  setTotalAudioDuration: (val: string) => void;
  imageAmount: string;
  setImageAmount: (val: string) => void;
  uploadedAudioFiles: any[];
  setUploadedAudioFiles: (files: any[]) => void;

  // Story context
  selectedStoryGroupId: string;
  selectedStoryTitle: string;
  storySource: string;
  currentUserId: string | null;
  useCharacterDescriptions: boolean;

  // Custom Characters
  customCharactersEnabled: boolean;
  setCustomCharactersEnabled: (enabled: boolean) => void;
  customCharacters: Array<{ name: string; description: string }>;
  setCustomCharacters: (characters: Array<{ name: string; description: string }>) => void;
  customCharactersAIEnhance: boolean;
  setCustomCharactersAIEnhance: (enabled: boolean) => void;

  // Audio duration
  getAudioFilesForSelectedStory: () => any[];
  calculatedAudioDuration?: number;
  setCalculatedAudioDuration?: (val: number) => void;
  audioDurationLoading?: boolean;
  audioDurationError?: string | null;
  isCalculatingDuration?: boolean;
  handleCalculateAudioDuration?: (...args: any[]) => any;

  // Formatting helpers
  formatDate: (date: string) => string;

  // Step configuration  
  isStepConfigured: (step: number) => boolean;

  // Token balance and storage for estimates
  userTokenBalance?: number;
  storageUsed?: number | null;
  maxStorageGB?: number;
}

// ─── Main Component ───────────────────────────────────────────────────────────

const VisualConfiguration: React.FC<VisualConfigurationProps> = (props) => {
  const {
    settings, setSettings, settingsLocked,
    visualType, onVisualTypeChange,
    ttvModel, ttvStyle, ttvDuration, ttvAudioClip,
    onTTVModelChange, onTTVStyleChange, onTTVDurationChange, onTTVAudioClipChange,
    itvModel, itvDuration, itvAudioClip, onITVModelChange, onITVDurationChange, onITVAudioClipChange,
    imageFolders, documents, uploadedFile,
    showMoreStyles, setShowMoreStyles, currentStyles, isCustomStyle,
    validationErrors, languageOptions, modelOptions,
    getImageFoldersForSelectedStory, getImagePromptDocsForSelectedStory,
    getTTVFoldersForSelectedStory, getTTVPromptDocsForSelectedStory,
    getITVVideoFoldersForSelectedStory, getITVVideoPromptDocsForSelectedStory,
    getITVImageFoldersForSelectedStory, getITVImagePromptDocsForSelectedStory,
    getMGPromptDocsForSelectedStory, getMGVideoFoldersForSelectedStory,
    handleVideoFileUpload, uploadingVideoLoop,
    uploadedVideoLoopFile, setUploadedVideoLoopFile,
    setVideoLoopUrl, uploadedVideoMetadata, setUploadedVideoMetadata,
    videoUploadProgress, videoUploadStartTime,
    frequencyMode, setFrequencyMode, frequencyType, setFrequencyType,
    consistentFrequency, setConsistentFrequency,
    audioDistributionType, setAudioDistributionType,
    firstPageImageAmount, setFirstPageImageAmount,
    restImageAmount, setRestImageAmount,
    totalAudioDuration, setTotalAudioDuration,
    imageAmount, setImageAmount,
    uploadedAudioFiles, setUploadedAudioFiles,
    selectedStoryGroupId, selectedStoryTitle, storySource,
    currentUserId, useCharacterDescriptions,
    customCharactersEnabled, setCustomCharactersEnabled,
    customCharacters, setCustomCharacters,
    customCharactersAIEnhance, setCustomCharactersAIEnhance,
    getAudioFilesForSelectedStory,
    calculatedAudioDuration, setCalculatedAudioDuration,
    audioDurationLoading, audioDurationError, isCalculatingDuration,
    handleCalculateAudioDuration,
    formatDate, isStepConfigured,
    userTokenBalance,
    storageUsed,
    maxStorageGB,
  } = props;

  // Current image source maps to the sub-option for the active visual type
  const imageSource = settings.imageSource as SourceType;

  // Determine the source label per visual type
  const getSourceLabels = (vt: VisualType) => {
    switch (vt) {
      case 'image':
        return { generate: 'Generate Images', folder: 'Use Existing Folder', upload: 'Upload Video to Loop' };
      case 'ttv':
        return { generate: 'Generate TTV', folder: 'Use Existing Folder', upload: 'Upload Video to Loop' };
      case 'itv':
        return { generate: 'Generate ITV', folder: 'Use Existing Folder', upload: 'Upload Video to Loop' };
      case 'mg':
        return { generate: 'Generate MG', folder: 'Use Existing Folder', upload: 'Upload Video to Loop' };
    }
  };
  const sourceLabels = getSourceLabels(visualType);

  // Check if Step 2 is configured (for frequency component)
  const isStep2Configured = isStepConfigured(2);

  // ── Token estimation helpers ──────────────────────────────────────────────

  const getWordCount = (): number => {
    if (settings.storySource === 'new' && settings.wordCount) {
      const c = parseInt(settings.wordCount, 10);
      if (!isNaN(c) && c > 0) return c;
    }
    if (settings.storySource === 'existing' && settings.selectedStoryDoc) {
      const doc = documents.find((d: any) => d.id === settings.selectedStoryDoc);
      if (doc?.word_count) return doc.word_count;
    }
    if (settings.storySource === 'upload' && uploadedFile) {
      const name = uploadedFile.name.replace(/\.txt$/, '');
      const doc = documents.find((d: any) => d.title === name);
      if (doc?.word_count) return doc.word_count;
    }
    return 0;
  };

  const wordCount = getWordCount();

  const getEstimatedImages = (): number => {
    if (frequencyMode === 'audio') {
      if (audioDistributionType === 'consistent') return parseInt(imageAmount) || 0;
      return (parseInt(firstPageImageAmount) || 0) + (parseInt(restImageAmount) || 0);
    }
    if (frequencyType === 'consistent') {
      const freq = parseFloat(consistentFrequency) || 10;
      const totalChars = wordCount * 5;
      const charsPerSegment = Math.max(100, Math.round(freq * 13.67));
      return Math.round(Math.ceil(totalChars / charsPerSegment) * 1.18);
    }
    const firstPageFreq = parseFloat(settings.firstPageFrequency ?? '10');
    const restFreq = parseFloat(settings.restFrequency ?? '30');
    const totalChars = wordCount * 5;
    // freq 0 = skip that section's images
    let firstSegs = 0;
    if (firstPageFreq > 0) {
      const firstCharsPerSeg = Math.max(100, Math.min(3000, Math.round(firstPageFreq * 13.67)));
      firstSegs = Math.ceil(3000 / firstCharsPerSeg);
    }
    let restSegs = 0;
    if (restFreq > 0) {
      const remaining = Math.max(0, totalChars - 3000);
      const restCharsPerSeg = Math.max(100, Math.round(restFreq * 13.67));
      restSegs = remaining > 0 ? Math.ceil(remaining / restCharsPerSeg) : 0;
    }
    return Math.round((firstSegs + restSegs) * 1.18);
  };

  const estimatedImages = getEstimatedImages();

  // Plan-aware token-cost shadows. These intentionally re-bind the same names
  // used by the module-scope LEGACY defaults so existing call sites below
  // automatically pick up NEW-plan rates for non-grandfathered users.
  const { isLegacy } = useIsLegacyPlan();
  const IMAGE_MODEL_OPTIONS = useMemo(() => buildImageOptionList(isLegacy), [isLegacy]);
  const IMAGE_MODEL_TOKENS = useMemo(() => buildImageModelTokens(isLegacy), [isLegacy]);
  const MODEL_OPTIONS = useMemo(() => buildModelOptionsList(isLegacy), [isLegacy]);
  const VIDEO_MODEL_OPTIONS = useMemo(() => buildVideoModelOptions(isLegacy), [isLegacy]);
  const ITV_VIDEO_MODEL_OPTIONS = useMemo(() => buildITVVideoModelOptions(isLegacy), [isLegacy]);
  const TTV_TOKENS_PER_SECOND = useMemo(
    () => (isLegacy ? LEGACY_TTV_TOKENS_PER_SECOND : NEW_TTV_TOKENS_PER_SECOND),
    [isLegacy],
  );
  const AUDIO_TOKENS_PER_SECOND = useMemo(
    () => (isLegacy ? LEGACY_TTV_TOKENS_PER_SECOND_AUDIO : NEW_TTV_TOKENS_PER_SECOND_AUDIO),
    [isLegacy],
  );

  // Image token estimation
  const imageTokens = estimatedImages * (IMAGE_MODEL_TOKENS[settings.imageModel] || 14000);
  const promptModelConfig = MODEL_OPTIONS.find(m => m.value === (settings.imagePromptModel || 'sonnet'));
  const promptMultiplier = promptModelConfig?.tokenMultiplier || 1;
  const imagePromptTokens = Math.round(800 * estimatedImages * promptMultiplier);
  const totalImageTokens = imageTokens + imagePromptTokens;

  // TTV token estimation — clip count = audio duration ÷ clip duration (matching standalone TTV page)
  const ttvModelConfig = VIDEO_MODEL_OPTIONS.find(m => m.value === ttvModel);
  const ttvTokensPerSecond = ttvModelConfig?.tokensPerSecond || 7900;
  const ttvEffectiveDuration = ttvModelConfig?.durationType === 'fixed'
    ? (ttvModelConfig.defaultDuration ?? ttvDuration) : ttvDuration;
  const ttvAutoClips = (calculatedAudioDuration ?? 0) > 0 && ttvEffectiveDuration > 0
    ? Math.max(1, Math.floor((calculatedAudioDuration ?? 0) / ttvEffectiveDuration))
    : 0;
  const estimatedClips = ttvAutoClips > 0 ? ttvAutoClips : 10;
  const ttvClipTokens = ttvTokensPerSecond * ttvEffectiveDuration;
  const ttvTotalVideoTokens = estimatedClips * ttvClipTokens;
  const ttvPromptTokens = Math.round(800 * estimatedClips * promptMultiplier);
  const totalTTVTokens = ttvTotalVideoTokens + ttvPromptTokens;

  // ITV token estimation — clip count = audio duration ÷ clip duration (matching standalone ITV page)
  const itvModelConfig = ITV_VIDEO_MODEL_OPTIONS.find(m => m.value === itvModel);
  const itvTokensPerSecond = itvModelConfig?.tokensPerSecond || 6000;
  const itvEffectiveDuration = itvModelConfig?.durationType === 'fixed'
    ? (itvModelConfig.defaultDuration ?? itvDuration) : itvDuration;
  const itvAutoClips = (calculatedAudioDuration ?? 0) > 0 && itvEffectiveDuration > 0
    ? Math.max(1, Math.floor((calculatedAudioDuration ?? 0) / itvEffectiveDuration))
    : 0;
  const itvClipCount = itvAutoClips > 0 ? itvAutoClips : 10;
  const itvVideoTokens = itvClipCount * itvTokensPerSecond * itvEffectiveDuration;
  const itvImageTokens = itvClipCount * (IMAGE_MODEL_TOKENS[settings.imageModel] || 14000);
  const itvPromptTokens = Math.round(800 * itvClipCount * promptMultiplier * 2);
  const totalITVTokens = itvVideoTokens + itvImageTokens + itvPromptTokens;

  const getModelDisplayName = (model: string) => {
    switch (model) {
      case 'flux-2-dev': return 'Spark';
      case 'imagen-4-fast': return 'Lite';
      case 'grok-imagine-image': return 'Grok';
      case 'gpt-image-1-mini': return 'Core';
      case 'seedream-4.5': return 'Prime';
      case 'imagen-4-ultra': return 'Heavy';
      case 'nano-banana-pro': return 'Genesis';
      default: return 'Lite';
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 overflow-visible">
      {/* ── Visual Type Tabs ───────────────────────────────────────────── */}
      <div>
        <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Visual Type</label>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {([
            { type: 'image' as VisualType, icon: Image, label: 'Image Generation', comingSoon: false },
            { type: 'ttv' as VisualType, icon: Film, label: 'Text-to-Video', comingSoon: false },
            { type: 'itv' as VisualType, icon: Video, label: 'Image-to-Video', comingSoon: false },
            { type: 'mg' as VisualType, icon: Wand2, label: 'Motion Graphics', comingSoon: true },
          ]).map(({ type, icon: Icon, label, comingSoon }) => (
            <button
              key={type}
              onClick={() => !settingsLocked && !comingSoon && onVisualTypeChange(type)}
              disabled={settingsLocked || comingSoon}
              title={comingSoon ? 'Coming soon' : undefined}
              className={`relative p-3 rounded-lg border-2 transition-all ${
                visualType === type
                  ? 'border-red-800 bg-red-500/20 text-white'
                  : 'border-border bg-surface-elevated text-text-secondary hover:border-border-subtle'
              } ${(settingsLocked || comingSoon) ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              {comingSoon && (
                <span className="absolute top-1 right-1 px-1.5 py-0.5 rounded-full text-[8px] font-mono tracking-wider uppercase bg-yellow-500/20 text-yellow-300 border border-yellow-500/40">
                  Coming Soon
                </span>
              )}
              <div className="flex flex-col items-center text-center gap-1">
                <Icon className={`h-5 w-5 ${visualType === type ? 'text-red-400' : 'text-text-muted'}`} />
                <div className="font-medium text-sm">{label}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Info Box ───────────────────────────────────────────────────── */}
      <div className="bg-surface-elevated rounded-lg p-4">
        <div className="flex items-start space-x-2">
          <Info className="h-5 w-5 text-text-muted mt-0.5 flex-shrink-0" />
          <div className="text-sm text-text-secondary">
            <p className="font-medium text-white mb-1">{VISUAL_TYPE_INFO[visualType].title}</p>
            <p className="mb-2">{VISUAL_TYPE_INFO[visualType].description}</p>
            <ul className="space-y-0.5 text-xs text-text-muted">
              {VISUAL_TYPE_INFO[visualType].bullets.map((b, i) => (
                <li key={i}>• {b}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* ── Source Sub-Options (Generate / Folder / Upload) ─────────── */}
      <div>
        <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">
          {visualType === 'image' ? 'Image Source' : visualType === 'ttv' ? 'TTV Source' : visualType === 'itv' ? 'ITV Source' : 'MG Source'}
        </label>
        <div className="grid grid-cols-3 gap-4">
          <button
            onClick={() => !settingsLocked && setSettings((prev: any) => ({ ...prev, imageSource: 'generate' }))}
            disabled={settingsLocked}
            className={`p-3 rounded-lg border-2 transition-all ${
              imageSource === 'generate'
                ? 'border-red-800/70 bg-red-900/30 text-white'
                : 'border-border bg-surface-elevated text-text-secondary hover:border-border-subtle'
            } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            <div className="text-center">
              <div className="font-medium text-sm sm:text-base">{sourceLabels.generate}</div>
              <div className="text-xs sm:text-sm opacity-75">
                {visualType === 'image' ? 'Generated Images' : visualType === 'ttv' ? 'AI Video Clips' : visualType === 'itv' ? 'Animated Images' : 'Motion Graphics Clips'}
              </div>
            </div>
          </button>
          <button
            onClick={() => !settingsLocked && settings.storySource !== 'new' && setSettings((prev: any) => ({ ...prev, imageSource: 'folder' }))}
            disabled={settingsLocked || settings.storySource === 'new'}
            className={`p-3 rounded-lg border-2 transition-all ${
              settings.storySource === 'new' || settingsLocked
                ? 'opacity-50 cursor-not-allowed border-border bg-surface-elevated text-text-dim'
                : imageSource === 'folder'
                ? 'border-red-800/70 bg-red-900/30 text-white'
                : 'border-border bg-surface-elevated text-text-secondary hover:border-border-subtle'
            }`}
          >
            <div className="text-center">
              <div className="font-medium text-sm sm:text-base">{sourceLabels.folder}</div>
              <div className="text-xs sm:text-sm opacity-75">
                {visualType === 'image' ? 'Existing image folder' : visualType === 'ttv' ? 'Existing TTV folder' : visualType === 'itv' ? 'Existing ITV folders' : 'Existing MG folder'}
              </div>
            </div>
          </button>
          <button
            onClick={() => !settingsLocked && setSettings((prev: any) => ({ ...prev, imageSource: 'upload' }))}
            disabled={settingsLocked}
            className={`p-3 rounded-lg border-2 transition-all ${
              imageSource === 'upload'
                ? 'border-red-800/70 bg-red-900/30 text-white'
                : 'border-border bg-surface-elevated text-text-secondary hover:border-border-subtle'
            } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            <div className="text-center">
              <div className="font-medium text-sm sm:text-base">
                <span className="hidden sm:inline">{sourceLabels.upload}</span>
                <span className="sm:hidden">Upload Video</span>
              </div>
              <div className="text-xs sm:text-sm opacity-75">MP4 video file</div>
            </div>
          </button>
        </div>
      </div>

      {/* Warning for new story + folder/upload */}
      {settings.storySource === 'new' && imageSource !== 'generate' && (
        <div className="bg-yellow-900/50 text-yellow-200 p-4 rounded-lg">
          <p className="text-sm">Folder and upload options are not available when creating a new story. Only Generate is available.</p>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* ── GENERATE sections ─────────────────────────────────────────── */}
      {/* ═══════════════════════════════════════════════════════════════════ */}

      {imageSource === 'generate' && visualType === 'image' && (
        <ImageGenerateSection
          settings={settings}
          setSettings={setSettings}
          settingsLocked={settingsLocked}
          showMoreStyles={showMoreStyles}
          setShowMoreStyles={setShowMoreStyles}
          currentStyles={currentStyles}
          isCustomStyle={isCustomStyle}
          languageOptions={languageOptions}
          modelOptions={modelOptions}
          getModelDisplayName={getModelDisplayName}
          frequencyMode={frequencyMode}
          setFrequencyMode={setFrequencyMode}
          frequencyType={frequencyType}
          setFrequencyType={setFrequencyType}
          consistentFrequency={consistentFrequency}
          setConsistentFrequency={setConsistentFrequency}
          audioDistributionType={audioDistributionType}
          setAudioDistributionType={setAudioDistributionType}
          firstPageImageAmount={firstPageImageAmount}
          setFirstPageImageAmount={setFirstPageImageAmount}
          restImageAmount={restImageAmount}
          setRestImageAmount={setRestImageAmount}
          totalAudioDuration={totalAudioDuration}
          setTotalAudioDuration={setTotalAudioDuration}
          imageAmount={imageAmount}
          setImageAmount={setImageAmount}
          uploadedAudioFiles={uploadedAudioFiles}
          setUploadedAudioFiles={setUploadedAudioFiles}
          selectedStoryGroupId={selectedStoryGroupId}
          selectedStoryTitle={selectedStoryTitle}
          storySource={storySource}
          currentUserId={currentUserId}
          useCharacterDescriptions={useCharacterDescriptions}
          customCharactersEnabled={customCharactersEnabled}
          setCustomCharactersEnabled={setCustomCharactersEnabled}
          customCharacters={customCharacters}
          setCustomCharacters={setCustomCharacters}
          customCharactersAIEnhance={customCharactersAIEnhance}
          setCustomCharactersAIEnhance={setCustomCharactersAIEnhance}
          getAudioFilesForSelectedStory={getAudioFilesForSelectedStory}
          calculatedAudioDuration={calculatedAudioDuration}
          setCalculatedAudioDuration={setCalculatedAudioDuration}
          audioDurationLoading={audioDurationLoading}
          audioDurationError={audioDurationError}
          isCalculatingDuration={isCalculatingDuration}
          handleCalculateAudioDuration={handleCalculateAudioDuration}
          isStep2Configured={isStep2Configured}
          wordCount={wordCount}
          documents={documents}
          uploadedFile={uploadedFile}
          estimatedImages={estimatedImages}
          imagePromptTokens={imagePromptTokens}
          imageTokens={imageTokens}
          totalImageTokens={totalImageTokens}
        />
      )}

      {imageSource === 'generate' && visualType === 'ttv' && (
        <TTVGenerateSection
          settings={settings}
          setSettings={setSettings}
          settingsLocked={settingsLocked}
          ttvModel={ttvModel}
          ttvStyle={ttvStyle}
          ttvDuration={ttvDuration}
          ttvAudioClip={ttvAudioClip}
          onTTVModelChange={onTTVModelChange}
          onTTVStyleChange={onTTVStyleChange}
          onTTVDurationChange={onTTVDurationChange}
          onTTVAudioClipChange={onTTVAudioClipChange}
          languageOptions={languageOptions}
          modelOptions={modelOptions}
          frequencyMode={frequencyMode}
          setFrequencyMode={setFrequencyMode}
          frequencyType={frequencyType}
          setFrequencyType={setFrequencyType}
          consistentFrequency={consistentFrequency}
          setConsistentFrequency={setConsistentFrequency}
          audioDistributionType={audioDistributionType}
          setAudioDistributionType={setAudioDistributionType}
          firstPageImageAmount={firstPageImageAmount}
          setFirstPageImageAmount={setFirstPageImageAmount}
          restImageAmount={restImageAmount}
          setRestImageAmount={setRestImageAmount}
          totalAudioDuration={totalAudioDuration}
          setTotalAudioDuration={setTotalAudioDuration}
          imageAmount={imageAmount}
          setImageAmount={setImageAmount}
          uploadedAudioFiles={uploadedAudioFiles}
          setUploadedAudioFiles={setUploadedAudioFiles}
          selectedStoryGroupId={selectedStoryGroupId}
          selectedStoryTitle={selectedStoryTitle}
          storySource={storySource}
          currentUserId={currentUserId}
          useCharacterDescriptions={useCharacterDescriptions}
          customCharactersEnabled={customCharactersEnabled}
          setCustomCharactersEnabled={setCustomCharactersEnabled}
          customCharacters={customCharacters}
          setCustomCharacters={setCustomCharacters}
          customCharactersAIEnhance={customCharactersAIEnhance}
          setCustomCharactersAIEnhance={setCustomCharactersAIEnhance}
          getAudioFilesForSelectedStory={getAudioFilesForSelectedStory}
          calculatedAudioDuration={calculatedAudioDuration}
          setCalculatedAudioDuration={setCalculatedAudioDuration}
          audioDurationLoading={audioDurationLoading}
          audioDurationError={audioDurationError}
          isCalculatingDuration={isCalculatingDuration}
          handleCalculateAudioDuration={handleCalculateAudioDuration}
          isStep2Configured={isStep2Configured}
          wordCount={wordCount}
          estimatedClips={estimatedClips}
          ttvPromptTokens={ttvPromptTokens}
          ttvTotalVideoTokens={ttvTotalVideoTokens}
          totalTTVTokens={totalTTVTokens}
          ttvTokensPerSecond={ttvTokensPerSecond}
          userTokenBalance={userTokenBalance}
          storageUsed={storageUsed}
          maxStorageGB={maxStorageGB}
        />
      )}

      {imageSource === 'generate' && visualType === 'itv' && (
        <ITVGenerateSection
          settings={settings}
          setSettings={setSettings}
          settingsLocked={settingsLocked}
          itvModel={itvModel}
          itvDuration={itvDuration}
          itvAudioClip={itvAudioClip}
          onITVModelChange={onITVModelChange}
          onITVDurationChange={onITVDurationChange}
          onITVAudioClipChange={onITVAudioClipChange}
          languageOptions={languageOptions}
          modelOptions={modelOptions}
          frequencyMode={frequencyMode}
          setFrequencyMode={setFrequencyMode}
          frequencyType={frequencyType}
          setFrequencyType={setFrequencyType}
          consistentFrequency={consistentFrequency}
          setConsistentFrequency={setConsistentFrequency}
          audioDistributionType={audioDistributionType}
          setAudioDistributionType={setAudioDistributionType}
          firstPageImageAmount={firstPageImageAmount}
          setFirstPageImageAmount={setFirstPageImageAmount}
          restImageAmount={restImageAmount}
          setRestImageAmount={setRestImageAmount}
          totalAudioDuration={totalAudioDuration}
          setTotalAudioDuration={setTotalAudioDuration}
          imageAmount={imageAmount}
          setImageAmount={setImageAmount}
          uploadedAudioFiles={uploadedAudioFiles}
          setUploadedAudioFiles={setUploadedAudioFiles}
          selectedStoryGroupId={selectedStoryGroupId}
          selectedStoryTitle={selectedStoryTitle}
          storySource={storySource}
          currentUserId={currentUserId}
          useCharacterDescriptions={useCharacterDescriptions}
          customCharactersEnabled={customCharactersEnabled}
          setCustomCharactersEnabled={setCustomCharactersEnabled}
          customCharacters={customCharacters}
          setCustomCharacters={setCustomCharacters}
          customCharactersAIEnhance={customCharactersAIEnhance}
          setCustomCharactersAIEnhance={setCustomCharactersAIEnhance}
          getAudioFilesForSelectedStory={getAudioFilesForSelectedStory}
          calculatedAudioDuration={calculatedAudioDuration}
          setCalculatedAudioDuration={setCalculatedAudioDuration}
          audioDurationLoading={audioDurationLoading}
          audioDurationError={audioDurationError}
          isCalculatingDuration={isCalculatingDuration}
          handleCalculateAudioDuration={handleCalculateAudioDuration}
          isStep2Configured={isStep2Configured}
          wordCount={wordCount}
          itvClipCount={itvClipCount}
          itvImageTokens={itvImageTokens}
          itvVideoTokens={itvVideoTokens}
          itvPromptTokens={itvPromptTokens}
          totalITVTokens={totalITVTokens}
          userTokenBalance={userTokenBalance}
          storageUsed={storageUsed}
          maxStorageGB={maxStorageGB}
        />
      )}

      {imageSource === 'generate' && visualType === 'mg' && (() => {
        const styleSlug = settings.mgStyleSlug || MG_DEFAULT_STYLE_SLUG;
        const customStyle: string = settings.mgCustomStyle || '';
        const codegenModel: MGCodegenModel = (settings.mgCodegenModel as MGCodegenModel) || 'opus';
        const mgLanguage: string = settings.language || 'english';
        const clipDuration = Number(settings.mgClipDuration) || MG_DEFAULT_CLIP_SECONDS;
        const audioSecs = calculatedAudioDuration && calculatedAudioDuration > 0 ? calculatedAudioDuration : 0;
        const mgClips = audioSecs > 0 ? Math.floor(audioSecs / Math.max(1, clipDuration)) : 0;
        const tokensPerClip = mgCodegenTokensPerClip(codegenModel);
        const totalCodegenTokens = mgClips * tokensPerClip;
        const totalRenderTokens = mgClips * clipDuration * MG_LAMBDA_TOKENS_PER_SECOND;
        const totalMgTokens = totalCodegenTokens + totalRenderTokens;
        const mgStorageMB = mgClips * MG_MB_PER_CLIP;
        const mgEstMinutes = Math.round((mgClips * MG_SECONDS_PER_CLIP_RENDER) / 60);
        const availableStorageMB = maxStorageGB != null && storageUsed != null ? (maxStorageGB * 1024) - storageUsed : undefined;
        const codegenModelLabel = MG_CODEGEN_MODEL_OPTIONS.find(o => o.value === codegenModel)?.label || 'Claude Opus 4.6';
        return (
          <div className="space-y-4 bg-surface-elevated rounded-lg p-4 border border-border">
            <div>
              <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">
                Motion Graphics Style
              </label>
              <MGStyleSelector
                selectedStyleSlug={styleSlug}
                onSelect={(slug: string) => !settingsLocked && setSettings((prev: any) => ({
                  ...prev,
                  mgStyleSlug: slug,
                  mgStyleGuidance: resolveStyleGuidance(slug),
                }))}
                disabled={settingsLocked}
              />
            </div>

            {/* Custom Style (optional) — overrides selected card when filled */}
            <div>
              <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">
                Custom Style (optional)
              </label>
              <p className="text-xs text-text-dim mb-2">
                When filled, fully replaces the selected style. Leave blank to use the selected card's style.
              </p>
              <textarea
                value={customStyle}
                onChange={(e) => !settingsLocked && setSettings((prev: any) => ({ ...prev, mgCustomStyle: e.target.value.slice(0, 1200) }))}
                disabled={settingsLocked}
                rows={4}
                maxLength={1200}
                className="w-full bg-surface-elevated border border-border rounded-lg p-3 text-sm text-text-primary placeholder-text-muted resize-y disabled:opacity-50"
                placeholder="Describe the visual mood and treatment you want (optional)"
              />
              <div className="mt-1 flex items-center justify-between">
                {customStyle.trim() ? (
                  <span className="text-xs text-yellow-400">Custom style overrides the selected card.</span>
                ) : <span />}
                <span className="text-xs text-text-muted">{customStyle.length} / 1200</span>
              </div>
            </div>

            {/* Clip Duration */}
            <div>
              <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">
                Clip Duration
              </label>
              <p className="text-xs text-text-dim mb-3">
                Length of each motion-graphics clip. Total clips = audio duration ÷ clip length.
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={MG_MIN_CLIP_SECONDS}
                  max={MG_MAX_CLIP_SECONDS}
                  step={1}
                  value={clipDuration}
                  disabled={settingsLocked}
                  onChange={(e) => {
                    const v = parseInt(e.target.value);
                    setSettings((prev: any) => ({ ...prev, mgClipDuration: v }));
                  }}
                  className="flex-1 accent-indigo-500"
                />
                <input
                  type="number"
                  min={MG_MIN_CLIP_SECONDS}
                  max={MG_MAX_CLIP_SECONDS}
                  value={clipDuration}
                  disabled={settingsLocked}
                  onChange={(e) => {
                    const v = parseInt(e.target.value);
                    if (!isNaN(v) && v >= MG_MIN_CLIP_SECONDS && v <= MG_MAX_CLIP_SECONDS) {
                      setSettings((prev: any) => ({ ...prev, mgClipDuration: v }));
                    }
                  }}
                  className="w-16 bg-surface-elevated border border-border rounded-lg px-2 py-1 text-sm text-center text-text-primary focus:outline-none focus:border-status-paused [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="text-sm text-text-dim">s</span>
              </div>
            </div>

            {/* Generation Settings: Language + Codegen Model */}
            <div>
              <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">
                Generation Settings
              </label>
              <div className="space-y-4">
                <div>
                  <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">Language</label>
                  <Listbox
                    value={mgLanguage}
                    onChange={(val: string) => !settingsLocked && setSettings((prev: any) => ({ ...prev, language: val }))}
                    disabled={settingsLocked}
                  >
                    {({ open }) => (
                      <div className="relative">
                        <Listbox.Button className="relative w-full bg-surface-input border border-white/[0.13] rounded-xl px-5 py-4 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 cursor-pointer hover:bg-surface-input">
                          <span className="block truncate">
                            {MG_LANGUAGE_OPTIONS.find(o => o.value === mgLanguage)?.label || 'English'}
                          </span>
                          <span className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none">
                            <ChevronDown className={`h-5 w-5 text-white/50 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                          </span>
                        </Listbox.Button>
                        <Transition
                          show={open}
                          enter="transition ease-out duration-100"
                          enterFrom="transform opacity-0 scale-95"
                          enterTo="transform opacity-100 scale-100"
                          leave="transition ease-in duration-75"
                          leaveFrom="transform opacity-100 scale-100"
                          leaveTo="transform opacity-0 scale-95"
                        >
                          <Listbox.Options className="absolute z-10 mt-2 w-full bg-surface-dropdown border border-white/[0.11] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                            {MG_LANGUAGE_OPTIONS.map(opt => (
                              <Listbox.Option
                                key={opt.value}
                                value={opt.value}
                                className={({ active, selected }) =>
                                  `relative cursor-pointer select-none py-3 px-4 ${active ? 'bg-white/[0.08] text-white' : 'text-text-secondary'} ${selected ? 'font-medium' : 'font-normal'}`
                                }
                              >
                                {({ selected }) => (
                                  <div className="flex justify-between items-center">
                                    <span className={selected ? 'font-medium text-white' : 'font-normal'}>{opt.label}</span>
                                    {selected && <span className="text-accent-text"><CheckCircle2 className="h-5 w-5" /></span>}
                                  </div>
                                )}
                              </Listbox.Option>
                            ))}
                          </Listbox.Options>
                        </Transition>
                      </div>
                    )}
                  </Listbox>
                </div>

                <div>
                  <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">Codegen Model</label>
                  <Listbox
                    value={codegenModel}
                    onChange={(val: MGCodegenModel) => !settingsLocked && setSettings((prev: any) => ({ ...prev, mgCodegenModel: val }))}
                    disabled={settingsLocked}
                  >
                    {({ open }) => (
                      <div className="relative">
                        <Listbox.Button className="relative w-full bg-surface-input border border-white/[0.13] rounded-xl px-5 py-4 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 cursor-pointer hover:bg-surface-input">
                          <span className="block truncate">{codegenModelLabel}</span>
                          <span className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none">
                            <ChevronDown className={`h-5 w-5 text-white/50 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                          </span>
                        </Listbox.Button>
                        <Transition
                          show={open}
                          enter="transition ease-out duration-100"
                          enterFrom="transform opacity-0 scale-95"
                          enterTo="transform opacity-100 scale-100"
                          leave="transition ease-in duration-75"
                          leaveFrom="transform opacity-100 scale-100"
                          leaveTo="transform opacity-0 scale-95"
                        >
                          <Listbox.Options className="absolute z-10 mt-2 w-full bg-surface-dropdown border border-white/[0.11] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                            {MG_CODEGEN_MODEL_OPTIONS.map(opt => (
                              <Listbox.Option
                                key={opt.value}
                                value={opt.value}
                                className={({ active, selected }) =>
                                  `relative cursor-pointer select-none py-3 px-4 ${active ? 'bg-white/[0.08] text-white' : 'text-text-secondary'} ${selected ? 'font-medium' : 'font-normal'}`
                                }
                              >
                                {({ selected }) => (
                                  <div className="flex justify-between items-center">
                                    <div>
                                      <span className={selected ? 'font-medium text-white' : 'font-normal'}>{opt.label}</span>
                                      <p className="text-xs text-text-dim mt-1">{opt.description}</p>
                                    </div>
                                    {selected && <span className="text-accent-text"><CheckCircle2 className="h-5 w-5" /></span>}
                                  </div>
                                )}
                              </Listbox.Option>
                            ))}
                          </Listbox.Options>
                        </Transition>
                      </div>
                    )}
                  </Listbox>
                  <p className="mt-2 text-xs text-text-muted">
                    Selected: {codegenModelLabel} · ~{tokensPerClip.toLocaleString()} tokens/clip
                  </p>
                </div>
              </div>
            </div>

            {/* MG cost estimate */}
            {mgClips > 0 && (
              <TokenEstimateBox
                rows={[
                  { label: `Codegen prompts (${mgClips} clips · ${codegenModelLabel})`, value: `${formatNumber(totalCodegenTokens)} tokens` },
                  { label: `Lambda render (${mgClips} clips × ${clipDuration}s)`, value: `${formatNumber(totalRenderTokens)} tokens` },
                ]}
                total={totalMgTokens}
                userTokenBalance={userTokenBalance}
                estimatedTimeMinutes={mgEstMinutes}
                timeLabel="Est. MG generation time"
                processingSpeedModelName={codegenModelLabel}
                processingSpeedValue={`~${MG_SECONDS_PER_CLIP_RENDER}s/clip`}
                storage={mgStorageMB}
                storageLabel={`Est. storage needed (${mgClips} clips × ${MG_MB_PER_CLIP} MB)`}
                storageAvailableMB={availableStorageMB}
              />
            )}
          </div>
        );
      })()}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* ── USE EXISTING FOLDER sections ─────────────────────────────── */}
      {/* ═══════════════════════════════════════════════════════════════════ */}

      {imageSource === 'folder' && settings.storySource !== 'new' && visualType === 'image' && (
        <ImageFolderSection
          settings={settings}
          setSettings={setSettings}
          settingsLocked={settingsLocked}
          getImageFoldersForSelectedStory={getImageFoldersForSelectedStory}
          getImagePromptDocsForSelectedStory={getImagePromptDocsForSelectedStory}
          formatDate={formatDate}
        />
      )}

      {imageSource === 'folder' && settings.storySource !== 'new' && visualType === 'ttv' && (
        <TTVFolderSection
          settings={settings}
          setSettings={setSettings}
          settingsLocked={settingsLocked}
          getTTVFoldersForSelectedStory={getTTVFoldersForSelectedStory}
          getTTVPromptDocsForSelectedStory={getTTVPromptDocsForSelectedStory}
          formatDate={formatDate}
        />
      )}

      {imageSource === 'folder' && settings.storySource !== 'new' && visualType === 'itv' && (
        <ITVFolderSection
          settings={settings}
          setSettings={setSettings}
          settingsLocked={settingsLocked}
          getITVVideoFoldersForSelectedStory={getITVVideoFoldersForSelectedStory}
          getITVVideoPromptDocsForSelectedStory={getITVVideoPromptDocsForSelectedStory}
          getITVImageFoldersForSelectedStory={getITVImageFoldersForSelectedStory}
          getITVImagePromptDocsForSelectedStory={getITVImagePromptDocsForSelectedStory}
          formatDate={formatDate}
        />
      )}

      {imageSource === 'folder' && settings.storySource !== 'new' && visualType === 'mg' && (
        <MGFolderSection
          settings={settings}
          setSettings={setSettings}
          settingsLocked={settingsLocked}
          getMGPromptDocsForSelectedStory={getMGPromptDocsForSelectedStory}
          getMGVideoFoldersForSelectedStory={getMGVideoFoldersForSelectedStory}
          formatDate={formatDate}
        />
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* ── UPLOAD VIDEO TO LOOP section (shared) ────────────────────── */}
      {/* ═══════════════════════════════════════════════════════════════════ */}

      {imageSource === 'upload' && (
        <UploadVideoLoopSection
          settings={settings}
          setSettings={setSettings}
          settingsLocked={settingsLocked}
          handleVideoFileUpload={handleVideoFileUpload}
          uploadingVideoLoop={uploadingVideoLoop}
          uploadedVideoLoopFile={uploadedVideoLoopFile}
          setUploadedVideoLoopFile={setUploadedVideoLoopFile}
          setVideoLoopUrl={setVideoLoopUrl}
          uploadedVideoMetadata={uploadedVideoMetadata}
          setUploadedVideoMetadata={setUploadedVideoMetadata}
          videoUploadProgress={videoUploadProgress}
          videoUploadStartTime={videoUploadStartTime}
        />
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// ── IMAGE GENERATE SECTION ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function ImageGenerateSection(props: any) {
  const { isLegacy } = useIsLegacyPlan();
  const IMAGE_MODEL_OPTIONS = useMemo(() => buildImageOptionList(isLegacy), [isLegacy]);
  const {
    settings, setSettings, settingsLocked,
    showMoreStyles, setShowMoreStyles, currentStyles, isCustomStyle,
    languageOptions, modelOptions, getModelDisplayName,
    frequencyMode, setFrequencyMode, frequencyType, setFrequencyType,
    consistentFrequency, setConsistentFrequency,
    audioDistributionType, setAudioDistributionType,
    firstPageImageAmount, setFirstPageImageAmount,
    restImageAmount, setRestImageAmount,
    totalAudioDuration, setTotalAudioDuration,
    imageAmount, setImageAmount,
    uploadedAudioFiles, setUploadedAudioFiles,
    selectedStoryGroupId, selectedStoryTitle, storySource,
    currentUserId, useCharacterDescriptions,
    getAudioFilesForSelectedStory,
    calculatedAudioDuration,
    audioDurationLoading, audioDurationError, isCalculatingDuration,
    handleCalculateAudioDuration, isStep2Configured,
    wordCount,
    estimatedImages, imagePromptTokens, imageTokens, totalImageTokens,
  } = props;

  return (
    <>
      {/* Tip box */}
      <div className="bg-surface-elevated rounded-lg p-4 mb-4">
        <div className="flex items-start space-x-2">
          <Info className="h-5 w-5 text-text-muted mt-0.5 flex-shrink-0" />
          <div className="text-sm text-text-muted">
            <p>Before deciding to create an entire video, try the model and style out with a short video or test the different image models in the Image Generator in Single Features to see which style works best for your content.</p>
          </div>
        </div>
      </div>

      {/* Image Quality Model */}
      <div>
        <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Image Quality Model</label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          {IMAGE_MODEL_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={settingsLocked}
              onClick={() => setSettings((prev: any) => ({ ...prev, imageModel: option.value }))}
              className={`relative p-3 rounded-xl border transition-all duration-200 text-left ${
                settings.imageModel === option.value
                  ? `${option.borderColor} ${option.bgColor} ${option.textColor}`
                  : `border-white/10 bg-surface-input text-text-muted hover:border-white/20 hover:text-white/80`
              } ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {option.recommended && (
                <div className="absolute -top-2 -right-2 bg-accent text-white text-[10px] font-mono tracking-wide px-2 py-0.5 rounded-full">
                  Recommended
                </div>
              )}
              <div className="font-medium text-sm">{option.label}</div>
              <div className="text-xs opacity-75 mt-0.5">{option.tokensPerImage.toLocaleString()} tokens per image</div>
              {option.description && <div className="text-xs opacity-60 mt-0.5">{option.description}</div>}
            </button>
          ))}
        </div>

        {/* Style info */}
        <div className="bg-surface-elevated rounded-lg p-4 mb-4">
          <div className="flex items-start space-x-2">
            <Info className="h-5 w-5 text-text-muted mt-0.5 flex-shrink-0" />
            <div className="text-sm text-text-muted">
              <p>The image styles below show how images will look for the {getModelDisplayName(settings.imageModel)}. Each model produces different quality and style variations.</p>
              {isCustomStyle(settings.imageStyle) && (
                <p className="mt-2 text-yellow-400"><strong>Note:</strong> Custom style will use the Core image model.</p>
              )}
            </div>
          </div>
        </div>

        {/* Style grid */}
        <div className="grid md:grid-cols-2 gap-6">
          {currentStyles.slice(0, showMoreStyles ? 16 : 4).map((style: any) => (
            <div
              key={style.name}
              className={`relative bg-surface-elevated rounded-lg overflow-hidden transition-all duration-200 ${
                settingsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
              } ${settings.imageStyle === style.style ? 'ring-2 ring-accent-text' : 'hover:ring-2 hover:ring-border-subtle'}`}
              onClick={() => !settingsLocked && setSettings((prev: any) => ({ ...prev, imageStyle: style.style }))}
            >
              <div className="aspect-video w-full">
                <img src={style.image} alt={`${style.name} Example`} className="w-full h-full object-cover" />
              </div>
              <div className="p-4">
                <h3 className="text-base sm:text-lg font-medium text-white mb-1">{style.name}</h3>
                <p className="text-sm text-text-muted">{style.description}</p>
              </div>
              {settings.imageStyle === style.style && (
                <div className="absolute top-2 right-2 bg-accent text-white rounded-full p-1">
                  <CheckCircle2 className="h-5 w-5" />
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-center mt-4">
          <button
            onClick={() => !settingsLocked && setShowMoreStyles(!showMoreStyles)}
            disabled={settingsLocked}
            className={`px-4 py-2 bg-surface-input text-white rounded-lg hover:bg-surface-card transition-colors ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            {showMoreStyles ? 'Show Less' : 'Show More +12'}
          </button>
        </div>

        {/* Custom style */}
        <div className="mt-6 bg-surface-elevated rounded-lg overflow-hidden">
          <div className="p-4">
            <h3 className="text-base sm:text-lg font-medium text-white mb-2">Custom Style</h3>
            <textarea
              value={settings.imageStyle !== currentStyles.find((s: any) => s.style === settings.imageStyle)?.style ? settings.imageStyle : ''}
              onChange={(e) => !settingsLocked && setSettings((prev: any) => ({ ...prev, imageStyle: e.target.value.slice(0, 1200) }))}
              disabled={settingsLocked}
              className={`w-full bg-surface-input border border-border-subtle rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 placeholder-text-muted ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
              rows={6}
              maxLength={1200}
              placeholder="Describe your custom image style..."
            />
            <div className="mt-1 text-xs text-text-muted text-right">
              {(settings.imageStyle !== currentStyles.find((s: any) => s.style === settings.imageStyle)?.style ? settings.imageStyle : '').length} / 1200
            </div>
            {isCustomStyle(settings.imageStyle) && (
              <div className="mt-1 text-sm text-yellow-400">Custom style will use the Core image model.</div>
            )}
          </div>
        </div>
      </div>

      {/* Character Consistency toggle */}
      <div className="flex items-center justify-between bg-surface-elevated px-4 py-3 rounded-lg">
        <div>
          <h3 className="text-sm font-medium text-white">
            <span className="hidden sm:inline">Character Consistency</span>
            <span className="sm:hidden">Char. Consistency</span>
          </h3>
          <p className="text-sm text-text-muted mt-1">
            <span className="hidden sm:inline">Maintain consistent character descriptions across all prompts</span>
            <span className="sm:hidden">Consistent character descriptions</span>
          </p>
        </div>
        <label className={`relative inline-flex items-center ${settingsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
          <input
            type="checkbox"
            checked={settings.useCharacterDescriptions}
            onChange={(e) => !settingsLocked && setSettings((prev: any) => ({ ...prev, useCharacterDescriptions: e.target.checked }))}
            disabled={settingsLocked}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-surface-input peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-red-800 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-white/20 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-600"></div>
        </label>
      </div>

      {/* Custom Characters Section - only visible when Character Consistency is ON */}
      {settings.useCharacterDescriptions && (
        <div className="bg-surface-elevated px-4 py-4 rounded-lg space-y-4">
          {/* Custom Characters Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-white">Custom Characters</h3>
              <p className="text-sm text-text-muted mt-1">Define your own character descriptions instead of auto-extracting from the story</p>
            </div>
            <label className={`relative inline-flex items-center ${settingsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={props.customCharactersEnabled}
                onChange={(e) => {
                  if (settingsLocked) return;
                  props.setCustomCharactersEnabled(e.target.checked);
                  if (e.target.checked && props.customCharacters.length === 0) {
                    props.setCustomCharacters([{ name: '', description: '' }]);
                  }
                }}
                disabled={settingsLocked}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-surface-input peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-red-800 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-white/20 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-600"></div>
            </label>
          </div>

          {/* Custom Characters Fields */}
          {props.customCharactersEnabled && (
            <div className="space-y-4">
              {/* Info Warning Box */}
              <div className="flex items-start gap-2 p-3 bg-amber-900/30 border border-amber-500/40 rounded-lg">
                <AlertCircle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-amber-200 font-medium">Important</p>
                  <p className="text-xs text-amber-300/80 mt-1">
                    Custom character descriptions will override automatic character extraction from your story. 
                    Make sure character names exactly match the names used in your story text for proper matching in image prompts.
                  </p>
                </div>
              </div>

              {/* Character Name + Description Fields */}
              <div>
                <label className="block text-sm font-medium text-white mb-2">
                  Character Descriptions
                  <span className="text-xs text-text-muted ml-2">(Max 10)</span>
                </label>
                <div className="space-y-3">
                  {props.customCharacters.map((char, index) => (
                    <div key={index} className="flex gap-2 items-start">
                      <div className="flex-1 space-y-2">
                        <input
                          type="text"
                          value={char.name}
                          onChange={(e) => {
                            const newChars = [...props.customCharacters];
                            newChars[index] = { ...newChars[index], name: e.target.value };
                            props.setCustomCharacters(newChars);
                          }}
                          disabled={settingsLocked}
                          placeholder="Character name (must match story text)"
                          className={`w-full px-3 py-2 bg-surface-input border border-border-subtle rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-900/60 ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                        />
                        <textarea
                          value={char.description}
                          onChange={(e) => {
                            const newChars = [...props.customCharacters];
                            newChars[index] = { ...newChars[index], description: e.target.value };
                            props.setCustomCharacters(newChars);
                          }}
                          disabled={settingsLocked}
                          placeholder="Physical appearance, clothing, build, facial features, hair, accessories..."
                          className={`w-full px-3 py-2 bg-surface-input border border-border-subtle rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-900/60 resize-none ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                          rows={2}
                        />
                      </div>
                      {props.customCharacters.length > 1 && !settingsLocked && (
                        <button
                          type="button"
                          onClick={() => {
                            const newChars = props.customCharacters.filter((_, i) => i !== index);
                            props.setCustomCharacters(newChars);
                          }}
                          className="mt-1 p-2 text-red-400 hover:text-red-300 hover:bg-surface-elevated rounded"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {props.customCharacters.length < 10 && !settingsLocked && (
                  <button
                    type="button"
                    onClick={() => {
                      props.setCustomCharacters([...props.customCharacters, { name: '', description: '' }]);
                    }}
                    className="mt-3 w-full py-2 bg-surface-input hover:bg-white/10 border border-border-subtle rounded-lg text-red-400 text-sm font-medium flex items-center justify-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Add Character
                  </button>
                )}
              </div>

              {/* AI Enhancement Toggle */}
              <div className="flex items-start justify-between pt-3 border-t border-border">
                <div className="flex-1">
                  <label className="flex items-center text-sm font-medium text-white">
                    AI Enhancement
                    <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-green-500/10 text-green-400 rounded-full border border-green-500/20">
                      Recommended
                    </span>
                  </label>
                  <p className="mt-1 text-xs text-text-muted">
                    Let AI expand your basic character descriptions into detailed visual descriptions optimized for image generation. Provide just the essentials—AI fills in the visual details.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => !settingsLocked && props.setCustomCharactersAIEnhance(!props.customCharactersAIEnhance)}
                  disabled={settingsLocked}
                  className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:ring-offset-2 focus:ring-offset-surface-elevated ${
                    props.customCharactersAIEnhance ? 'bg-red-600' : 'bg-surface-input'
                  } ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      props.customCharactersAIEnhance ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Language selector */}
      <div>
        <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Language</label>
        <LanguageSelector settings={settings} setSettings={setSettings} settingsLocked={settingsLocked} languageOptions={languageOptions} />
      </div>

      {/* AI Model for prompts */}
      <div>
        <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">
          <span className="hidden sm:inline">AI Model for Image Prompts</span>
          <span className="sm:hidden">Prompt AI Model</span>
        </label>
        <PromptModelSelector settings={settings} setSettings={setSettings} settingsLocked={settingsLocked} modelOptions={modelOptions} />
      </div>

      {/* Frequency info */}
      <div className="flex items-start mt-2">
        <div className="bg-surface-elevated border border-border rounded-lg p-3 flex items-start space-x-2">
          <Info className="h-5 w-5 text-text-muted mt-0.5" />
          <div className="text-sm text-text-muted">
            <p>Image Frequency determines how often images appear in your video, e.g., a frequency of 5 seconds means an image roughly every 5 seconds.</p>
            <p>First Page Frequency applies to the first 3000 characters, approximately the first 3–5 minutes of your video.</p>
            <p>Rest of Story Frequency sets how often images appear in the remaining document content.</p>
          </div>
        </div>
      </div>
      <div className="mt-4"></div>

      {/* Image Frequency Configuration */}
      <ImageFrequencyConfiguration
        mode={frequencyMode}
        onModeChange={setFrequencyMode}
        frequencyType={frequencyType}
        onFrequencyTypeChange={setFrequencyType}
        wordCount={wordCount}
        consistentFrequency={consistentFrequency}
        onConsistentFrequencyChange={setConsistentFrequency}
        firstPageFrequency={settings.firstPageFrequency}
        onFirstPageFrequencyChange={(value: string) => setSettings((prev: any) => ({ ...prev, firstPageFrequency: value }))}
        restFrequency={settings.restFrequency}
        onRestFrequencyChange={(value: string) => setSettings((prev: any) => ({ ...prev, restFrequency: value }))}
        selectedStoryGroupId={selectedStoryGroupId}
        selectedStoryTitle={selectedStoryTitle}
        storySource={storySource}
        audioSource={settings.audioSource}
        selectedAudioFile={settings.selectedAudioFile}
        selectedAudioFileDetails={settings.selectedAudioFile ? getAudioFilesForSelectedStory().find((f: any) => f.id === settings.selectedAudioFile) : undefined}
        audioFiles={uploadedAudioFiles}
        onAudioFilesChange={setUploadedAudioFiles}
        totalAudioDuration={parseFloat(totalAudioDuration)}
        onTotalAudioDurationChange={(duration: number) => setTotalAudioDuration(duration.toString())}
        imageAmount={imageAmount}
        onImageAmountChange={setImageAmount}
        audioDistributionType={audioDistributionType}
        onAudioDistributionTypeChange={setAudioDistributionType}
        audioFirstPageImageCount={firstPageImageAmount}
        onAudioFirstPageImageCountChange={setFirstPageImageAmount}
        audioRestImageCount={restImageAmount}
        onAudioRestImageCountChange={setRestImageAmount}
        userId={currentUserId}
        useCharacterDescriptions={useCharacterDescriptions}
        isVideoGenerator={true}
        calculatedAudioDuration={calculatedAudioDuration}
        audioDurationLoading={audioDurationLoading}
        audioDurationError={audioDurationError}
        isCalculatingDuration={isCalculatingDuration}
        handleCalculateAudioDuration={handleCalculateAudioDuration}
        isStep2Configured={isStep2Configured}
      />

      {/* Token estimation */}
      {estimatedImages > 0 && (
        <TokenEstimateBox
          rows={[
            { label: 'Estimated Images', value: `${estimatedImages} images` },
            { label: 'Image Prompt Tokens', value: `${formatNumber(imagePromptTokens)} tokens` },
            { label: 'Image Generation Tokens', value: `${formatNumber(imageTokens)} tokens` },
          ]}
          total={totalImageTokens}
          storage={estimatedImages * 1}
        />
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── STYLE VIDEO CARD (for TTV Visual Style section) ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function StyleVideoCard({
  name, description, videoUrl, isSelected, onClick,
}: {
  name: string; description: string; videoUrl: string; isSelected: boolean; onClick: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  return (
    <div
      className={`relative bg-surface-elevated rounded-lg overflow-hidden cursor-pointer transition-all duration-200 ${
        isSelected ? 'ring-2 ring-red-500' : 'hover:ring-2 hover:ring-border-subtle'
      }`}
      onClick={onClick}
      onMouseEnter={() => { videoRef.current?.play().then(() => setIsPlaying(true)).catch(() => {}); }}
      onMouseLeave={() => { if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = 0; setIsPlaying(false); } }}
    >
      <div className="aspect-video w-full relative">
        <video ref={videoRef} src={videoUrl} className="w-full h-full object-cover" preload="metadata" muted loop playsInline />
        <div className={`absolute inset-0 flex items-center justify-center transition-opacity duration-200 pointer-events-none ${isPlaying ? 'opacity-0' : 'bg-black/25'}`}>
          <div className="w-10 h-10 bg-black/60 rounded-full flex items-center justify-center">
            <Play className="h-5 w-5 text-white ml-0.5" />
          </div>
        </div>
      </div>
      <div className="p-4">
        <h3 className="text-base font-medium text-white mb-1">{name}</h3>
        <p className="text-sm text-text-muted">{description}</p>
      </div>
      {isSelected && (
        <div className="absolute top-2 right-2 bg-red-500 text-white rounded-full p-1">
          <CheckCircle2 className="h-5 w-5" />
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── TTV GENERATE SECTION ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function TTVGenerateSection(props: any) {
  const { isLegacy } = useIsLegacyPlan();
  const VIDEO_MODEL_OPTIONS = useMemo(() => buildVideoModelOptions(isLegacy), [isLegacy]);
  const {
    settings, setSettings, settingsLocked,
    ttvModel, ttvStyle, ttvDuration, ttvAudioClip,
    onTTVModelChange, onTTVStyleChange, onTTVDurationChange, onTTVAudioClipChange,
    languageOptions, modelOptions,
    calculatedAudioDuration,
    audioDurationLoading, audioDurationError, isCalculatingDuration,
    isStep2Configured,
    estimatedClips, ttvPromptTokens, ttvTotalVideoTokens, totalTTVTokens,
    userTokenBalance, storageUsed, maxStorageGB,
  } = props;

  const [showAllStyles, setShowAllStyles] = useState(false);
  const [isCustomStyle, setIsCustomStyle] = useState(false);
  const [customStyleText, setCustomStyleText] = useState('');
  const [useHighRes, setUseHighRes] = useState(false);
  const useAudioClip = ttvAudioClip;
  const setUseAudioClip = onTTVAudioClipChange;
  const [sliderInputValue, setSliderInputValue] = useState(String(ttvDuration));

  const selectedModelCfg = VIDEO_MODEL_OPTIONS.find(m => m.value === ttvModel);

  // Sync slider input when model changes
  useEffect(() => { setSliderInputValue(String(ttvDuration)); }, [ttvDuration]);

  // Reset high-res when switching to a model that doesn't support it
  useEffect(() => { if (!HIGH_RES_SUPPORTED_MODELS.has(ttvModel)) setUseHighRes(false); }, [ttvModel]);

  // Reset audio clip when switching to a model that doesn't support it
  useEffect(() => { if (!TTV_AUDIO_CLIP_SUPPORTED_MODELS.has(ttvModel)) onTTVAudioClipChange(false); }, [ttvModel]);

  // Propagate style changes (custom or preset)
  useEffect(() => {
    if (isCustomStyle && customStyleText) onTTVStyleChange(customStyleText);
  }, [isCustomStyle, customStyleText]);

  return (
    <>
      {/* ═══ Video Model ═══ */}
      <div className="bg-surface-card rounded-xl border border-border-card p-5">
        <h2 className="text-base font-semibold text-white mb-1">Video Model</h2>
        <p className="text-xs text-text-dim mb-4">Select the AI model to generate your video clips</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          {VIDEO_MODEL_OPTIONS.map((opt) => {
            const isSelected = ttvModel === opt.value;
            const durationLabel =
              opt.durationType === 'fixed'
                ? `${opt.defaultDuration}s fixed`
                : opt.durationType === 'slider'
                ? `${opt.durationMin}–${opt.durationMax}s`
                : (opt.durationOptions ?? []).map(d => `${d}s`).join(' · ');
            const secsPerClip = TTV_SECONDS_PER_VIDEO[opt.value] ?? TTV_DEFAULT_SECONDS_PER_VIDEO;
            const timePerClipLabel = secsPerClip >= 60 ? `~${Math.round(secsPerClip / 60)} min/clip` : `~${secsPerClip}s/clip`;
            return (
              <button
                key={opt.value}
                disabled={settingsLocked}
                onClick={() => {
                  onTTVModelChange(opt.value);
                  if (opt.durationType === 'slider') setSliderInputValue(String(opt.defaultDuration));
                  onTTVDurationChange(opt.defaultDuration);
                  if (!HIGH_RES_SUPPORTED_MODELS.has(opt.value)) setUseHighRes(false);
                }}
                className={`relative p-3 rounded-lg border text-left transition-colors ${
                  isSelected
                    ? `${opt.borderColor} ${opt.bgColor} ${opt.textColor}`
                    : 'border-border bg-surface-elevated text-text-secondary hover:border-border-subtle'
                } ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {opt.recommended && (
                  <div className="absolute -top-2 -right-2 bg-green-500 text-white text-xs px-2 py-1 rounded-full">Recommended</div>
                )}
                <div className="flex items-start mb-1">
                  <span className="font-medium text-sm leading-tight">{opt.label}</span>
                </div>
                <div className="text-xs opacity-75">{opt.tokensPerSecond.toLocaleString()} tokens/s</div>
                <div className="text-xs opacity-75 mt-0.5">Clip durations: {durationLabel}</div>
                <div className="text-xs opacity-60 mt-0.5">{opt.resolution}</div>
                <div className="text-xs opacity-60 mt-0.5">Creation time: {timePerClipLabel}</div>
              </button>
            );
          })}
        </div>

        {/* Duration selector */}
        {ttvModel && selectedModelCfg && selectedModelCfg.durationType !== 'fixed' && (
          <div className="mt-5">
            <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Clip Durations</label>
            {selectedModelCfg.durationType === 'options' && selectedModelCfg.durationOptions && (
              <div className="flex flex-wrap gap-2">
                {selectedModelCfg.durationOptions.map((d: number) => (
                  <button
                    key={d}
                    disabled={settingsLocked}
                    onClick={() => onTTVDurationChange(d)}
                    className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      ttvDuration === d
                        ? `${selectedModelCfg.borderColor} ${selectedModelCfg.bgColor} ${selectedModelCfg.textColor}`
                        : 'border-border bg-surface-elevated text-text-secondary hover:border-border-subtle'
                    } ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {d}s
                  </button>
                ))}
              </div>
            )}
            {selectedModelCfg.durationType === 'slider' && (() => {
              const minVal = selectedModelCfg.durationMin ?? 2;
              const maxVal = selectedModelCfg.durationMax ?? 30;
              const parsed = parseInt(sliderInputValue);
              const isOutOfRange = sliderInputValue !== '' && (isNaN(parsed) || parsed < minVal || parsed > maxVal);
              return (
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <input
                      type="range" min={minVal} max={maxVal} step={1} value={ttvDuration}
                      disabled={settingsLocked}
                      onChange={e => { const v = parseInt(e.target.value); onTTVDurationChange(v); setSliderInputValue(String(v)); }}
                      className="flex-1 accent-indigo-500"
                    />
                    <input
                      type="number" min={minVal} max={maxVal} value={sliderInputValue}
                      disabled={settingsLocked}
                      onChange={e => { setSliderInputValue(e.target.value); const v = parseInt(e.target.value); if (!isNaN(v) && v >= minVal && v <= maxVal) onTTVDurationChange(v); }}
                      className="w-16 bg-surface-elevated border border-border rounded-lg px-2 py-1 text-sm text-center text-white focus:outline-none focus:border-indigo-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <span className="text-sm text-text-muted">s</span>
                  </div>
                  {isOutOfRange && (
                    <div className="flex items-center gap-2 text-xs text-amber-400">
                      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                      <span>Enter a value between {minVal} and {maxVal} seconds.</span>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
        {ttvModel && selectedModelCfg && selectedModelCfg.durationType === 'fixed' && (
          <div className="mt-4 flex items-center gap-2 text-sm text-text-muted">
            <span>Clip durations:</span>
            <span className={`font-medium ${selectedModelCfg.textColor}`}>{selectedModelCfg.defaultDuration}s (fixed)</span>
          </div>
        )}

        {/* High Resolution toggle */}
        {HIGH_RES_SUPPORTED_MODELS.has(ttvModel) && (
          <div className="mt-5 pt-5 border-t border-border-card">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <label className="flex items-center text-sm font-medium text-text-secondary">High Resolution</label>
                <p className="mt-1 text-xs text-text-muted">
                  {ttvModel === 'grok' ? 'Upgrade from 480p to 720p output.' : 'Upgrade from 1080p to 4K (3840×2160) output.'}
                </p>
                {useHighRes && (
                  <p className="mt-2 text-xs text-amber-400 flex items-center gap-1">
                    <AlertCircle className="h-3 w-3 flex-shrink-0" />
                    {ttvModel === 'grok'
                      ? `Higher resolution costs more: ${fmtKps(TTV_TOKENS_PER_SECOND.grok_highres ?? 0)} tokens/s (vs ${fmtKps(TTV_TOKENS_PER_SECOND.grok ?? 0)} at 480p)`
                      : `Higher resolution costs significantly more: ${fmtKps(TTV_TOKENS_PER_SECOND.sora2pro_highres ?? 0)} tokens/s (vs ${fmtKps(TTV_TOKENS_PER_SECOND.sora2pro ?? 0)} at 1080p)`}
                  </p>
                )}
              </div>
              <button type="button" onClick={() => !settingsLocked && setUseHighRes(!useHighRes)} disabled={settingsLocked}
                className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${useHighRes ? 'bg-red-600' : 'bg-surface-input'} ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${useHighRes ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          </div>
        )}

        {/* Audio Clip toggle */}
        {TTV_AUDIO_CLIP_SUPPORTED_MODELS.has(ttvModel) && (
          <div className="mt-5 pt-5 border-t border-border-card">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <label className="flex items-center text-sm font-medium text-text-secondary">Audio Clips</label>
                <p className="mt-1 text-xs text-text-muted">Embed audio atmosphere descriptions inside each video prompt so the model generates clips with matching sound design.</p>
                {useAudioClip && (
                  <p className="mt-2 text-xs text-amber-400 flex items-center gap-1">
                    <AlertCircle className="h-3 w-3 flex-shrink-0" />
                    Audio clips can sound strange with text-to-speech audio overlay on a final video.
                  </p>
                )}
                {useAudioClip && (ttvModel === 'veo31fast' || ttvModel === 'veo31') && (
                  <p className="mt-1 text-xs text-orange-400">
                    ⚡ Veo audio mode: {fmtKps(AUDIO_TOKENS_PER_SECOND[ttvModel] ?? 0)} tokens/s
                    &nbsp;(vs {fmtKps(TTV_TOKENS_PER_SECOND[ttvModel] ?? 0)} without audio)
                  </p>
                )}
                {useAudioClip && ttvModel === 'ltx' && (
                  <p className="mt-1 text-xs text-orange-400">🔊 LTX-2-Pro generates native AI audio.</p>
                )}
                {useAudioClip && (ttvModel === 'ltx23_fast' || ttvModel === 'ltx23_pro') && (
                  <p className="mt-1 text-xs text-orange-400">🔊 LTX-2.3 generates native AI audio.</p>
                )}
                {useAudioClip && ttvModel === 'seedance15_pro' && (
                  <p className="mt-1 text-xs text-orange-400">
                    ⚡ Seedance 1.5 Pro audio mode: {fmtKps(AUDIO_TOKENS_PER_SECOND.seedance15_pro ?? 0)} tokens/s (vs {fmtKps(TTV_TOKENS_PER_SECOND.seedance15_pro ?? 0)} without audio)
                  </p>
                )}
                {(ttvModel === 'grok' || ttvModel === 'sora2pro' || ttvModel === 'sora2pro_highres') && (
                  <p className="mt-1 text-xs text-text-dim">
                    {useAudioClip
                      ? `🔊 ${ttvModel.startsWith('sora') ? 'Sora' : 'Grok'} always generates audio — clip will include AI sound design.`
                      : `🔇 ${ttvModel.startsWith('sora') ? 'Sora' : 'Grok'} always generates audio — audio track will be stripped in post-processing.`}
                  </p>
                )}
              </div>
              <button type="button" onClick={() => !settingsLocked && setUseAudioClip(!useAudioClip)} disabled={settingsLocked}
                className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${useAudioClip ? 'bg-red-600' : 'bg-surface-input'} ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${useAudioClip ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ═══ Visual Style ═══ */}
      <div className="bg-surface-card rounded-xl border border-border-card p-5">
        <h2 className="text-base font-semibold text-white mb-1">Visual Style</h2>
        <p className="text-xs text-text-dim mb-4">Choose the artistic look for your video clips</p>

        <div className="grid md:grid-cols-2 gap-6">
          {TTV_STYLES.slice(0, showAllStyles ? TTV_STYLES.length : 4).map((s) => (
            <StyleVideoCard
              key={s.name}
              name={s.name}
              description={s.description}
              videoUrl={getStyleVideoUrl(ttvModel, s.videoFileName)}
              isSelected={!isCustomStyle && ttvStyle === s.style}
              onClick={() => { onTTVStyleChange(s.style); setIsCustomStyle(false); }}
            />
          ))}
        </div>

        {TTV_STYLES.length > 4 && (
          <div className="flex justify-center mt-4">
            <button
              onClick={() => setShowAllStyles(prev => !prev)}
              disabled={settingsLocked}
              className={`px-4 py-2 bg-surface-input text-white rounded-lg hover:bg-surface-card transition-colors ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              {showAllStyles ? 'Show Less' : `Show More +${TTV_STYLES.length - 4}`}
            </button>
          </div>
        )}

        {/* Custom style */}
        <div className="mt-6 bg-surface-elevated rounded-lg overflow-hidden">
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3 cursor-pointer" onClick={() => setIsCustomStyle(true)}>
              <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${isCustomStyle ? 'border-red-500' : 'border-border-subtle'}`}>
                {isCustomStyle && <div className="w-2 h-2 rounded-full bg-red-500" />}
              </div>
              <h3 className="text-base font-medium text-white">Custom Style</h3>
            </div>
            <textarea
              value={isCustomStyle ? customStyleText : ''}
              onChange={e => { setCustomStyleText(e.target.value.slice(0, 1200)); setIsCustomStyle(true); }}
              onClick={() => setIsCustomStyle(true)}
              disabled={settingsLocked}
              placeholder="Describe your custom video style in detail, e.g. 'Watercolor painting with warm earth tones, impressionist brushwork, soft natural lighting...'"
              rows={6}
              maxLength={1200}
              className={`w-full bg-surface-input border border-border-subtle rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-red-500 placeholder-text-muted ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
            />
            <div className="mt-1 text-xs text-text-muted text-right">
              {(isCustomStyle ? customStyleText : '').length} / 1200
            </div>
            {isCustomStyle && (
              <div className="mt-1 text-sm text-yellow-400">Custom styles can use all video models.</div>
            )}
          </div>
        </div>
      </div>

      {/* ═══ Generation Settings ═══ */}
      <div className="bg-surface-card rounded-xl border border-border-card p-5">
        <h2 className="text-base font-semibold text-white mb-4">Generation Settings</h2>
        <div className="space-y-4">
          {/* Character consistency */}
          <div className="flex items-center justify-between bg-surface-elevated px-4 py-3 rounded-lg">
            <div>
              <h3 className="text-sm font-medium text-white">Character Consistency</h3>
              <p className="text-sm text-text-muted mt-1">Maintain consistent character descriptions across all clips</p>
            </div>
            <label className={`relative inline-flex items-center ${settingsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
              <input type="checkbox" checked={settings.useCharacterDescriptions}
                onChange={e => !settingsLocked && setSettings((prev: any) => ({ ...prev, useCharacterDescriptions: e.target.checked }))}
                disabled={settingsLocked} className="sr-only peer" />
              <div className="w-11 h-6 bg-surface-input peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-red-800 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-white/20 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-600"></div>
            </label>
          </div>

          {/* Custom Characters Section - only visible when Character Consistency is ON */}
          {settings.useCharacterDescriptions && (
            <div className="bg-surface-elevated px-4 py-4 rounded-lg space-y-4">
              {/* Custom Characters Toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-white">Custom Characters</h3>
                  <p className="text-sm text-text-muted mt-1">Define your own character descriptions instead of auto-extracting from the story</p>
                </div>
                <label className={`relative inline-flex items-center ${settingsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={props.customCharactersEnabled}
                    onChange={(e) => {
                      if (settingsLocked) return;
                      props.setCustomCharactersEnabled(e.target.checked);
                      if (e.target.checked && props.customCharacters.length === 0) {
                        props.setCustomCharacters([{ name: '', description: '' }]);
                      }
                    }}
                    disabled={settingsLocked}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-surface-input peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-red-800 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-white/20 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-600"></div>
                </label>
              </div>

              {/* Custom Characters Fields */}
              {props.customCharactersEnabled && (
                <div className="space-y-4">
                  {/* Info Warning Box */}
                  <div className="flex items-start gap-2 p-3 bg-amber-900/30 border border-amber-500/40 rounded-lg">
                    <AlertCircle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm text-amber-200 font-medium">Important</p>
                      <p className="text-xs text-amber-300/80 mt-1">
                        Custom character descriptions will override automatic character extraction from your story. 
                        Make sure character names exactly match the names used in your story text for proper matching in video prompts.
                      </p>
                    </div>
                  </div>

                  {/* Character Name + Description Fields */}
                  <div>
                    <label className="block text-sm font-medium text-white mb-2">
                      Character Descriptions
                      <span className="text-xs text-text-muted ml-2">(Max 10)</span>
                    </label>
                    <div className="space-y-3">
                      {props.customCharacters.map((char, index) => (
                        <div key={index} className="flex gap-2 items-start">
                          <div className="flex-1 space-y-2">
                            <input
                              type="text"
                              value={char.name}
                              onChange={(e) => {
                                const newChars = [...props.customCharacters];
                                newChars[index] = { ...newChars[index], name: e.target.value };
                                props.setCustomCharacters(newChars);
                              }}
                              disabled={settingsLocked}
                              placeholder="Character name (must match story text)"
                              className={`w-full px-3 py-2 bg-surface-input border border-border-subtle rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-900/60 ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                            />
                            <textarea
                              value={char.description}
                              onChange={(e) => {
                                const newChars = [...props.customCharacters];
                                newChars[index] = { ...newChars[index], description: e.target.value };
                                props.setCustomCharacters(newChars);
                              }}
                              disabled={settingsLocked}
                              placeholder="Physical appearance, clothing, build, facial features, hair, accessories..."
                              className={`w-full px-3 py-2 bg-surface-input border border-border-subtle rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-900/60 resize-none ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                              rows={2}
                            />
                          </div>
                          {props.customCharacters.length > 1 && !settingsLocked && (
                            <button
                              type="button"
                              onClick={() => {
                                const newChars = props.customCharacters.filter((_, i) => i !== index);
                                props.setCustomCharacters(newChars);
                              }}
                              className="mt-1 p-2 text-red-400 hover:text-red-300 hover:bg-surface-elevated rounded"
                            >
                              <X className="w-5 h-5" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>

                    {props.customCharacters.length < 10 && !settingsLocked && (
                      <button
                        type="button"
                        onClick={() => {
                          props.setCustomCharacters([...props.customCharacters, { name: '', description: '' }]);
                        }}
                        className="mt-3 w-full py-2 bg-surface-input hover:bg-white/10 border border-border-subtle rounded-lg text-red-400 text-sm font-medium flex items-center justify-center gap-2"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        Add Character
                      </button>
                    )}
                  </div>

                  {/* AI Enhancement Toggle */}
                  <div className="flex items-start justify-between pt-3 border-t border-border">
                    <div className="flex-1">
                      <label className="flex items-center text-sm font-medium text-white">
                        AI Enhancement
                        <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-green-500/10 text-green-400 rounded-full border border-green-500/20">
                          Recommended
                        </span>
                      </label>
                      <p className="mt-1 text-xs text-text-muted">
                        Let AI expand your basic character descriptions into detailed visual descriptions optimized for video generation. Provide just the essentials—AI fills in the visual details.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => !settingsLocked && props.setCustomCharactersAIEnhance(!props.customCharactersAIEnhance)}
                      disabled={settingsLocked}
                      className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:ring-offset-2 focus:ring-offset-surface-elevated ${
                        props.customCharactersAIEnhance ? 'bg-red-600' : 'bg-surface-input'
                      } ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          props.customCharactersAIEnhance ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Language */}
          <div>
            <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Language</label>
            <LanguageSelector settings={settings} setSettings={setSettings} settingsLocked={settingsLocked} languageOptions={languageOptions} />
          </div>

          {/* AI Writing Model */}
          <div>
            <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">AI Writing Model</label>
            <PromptModelSelector settings={settings} setSettings={setSettings} settingsLocked={settingsLocked} modelOptions={modelOptions} />
          </div>
        </div>
      </div>

      {/* ═══ Video Frequency ═══ */}
      <div className="bg-surface-card rounded-xl border border-border-card p-5">
        <h2 className="text-base font-semibold text-white mb-1">Video Frequency</h2>
        <p className="text-xs text-text-dim mb-4">Determines how many video clips will be generated based on audio duration</p>

        {!isStep2Configured && !isCalculatingDuration && !audioDurationLoading ? (
          <div className="bg-yellow-900/20 border border-yellow-500/50 rounded-lg p-3 flex gap-2">
            <AlertCircle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-yellow-200">
              <strong>Audio Configuration Required:</strong> Please configure audio in Step 2 (Audio Configuration) first. The number of video clips is calculated from the audio duration.
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Audio Runtime */}
            <div className="bg-surface-elevated rounded-lg p-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-text-secondary">Audio Runtime:</span>
                {isCalculatingDuration || audioDurationLoading ? (
                  <div className="flex items-center space-x-2">
                    <RefreshCw className="h-4 w-4 text-red-500 animate-spin" />
                    <span className="text-sm text-red-400">Calculating...</span>
                  </div>
                ) : calculatedAudioDuration && calculatedAudioDuration > 0 ? (
                  <span className="text-lg font-semibold text-white">{formatDuration(calculatedAudioDuration)}</span>
                ) : (
                  <span className="text-sm text-text-muted">Waiting for audio duration...</span>
                )}
              </div>

              {/* Estimate note for Generate Audio */}
              {settings.audioSource === 'generate' && !isCalculatingDuration && !audioDurationLoading && calculatedAudioDuration && calculatedAudioDuration > 0 && (
                <div className="dash-info-box p-2 mt-3 flex gap-2">
                  <Info className="h-4 w-4 dash-box-icon flex-shrink-0 mt-0.5" />
                  <p className="text-xs dash-box-text">
                    <strong>Estimate:</strong> This is an estimated runtime based on your story word count. The actual runtime will be calculated after audio generation and used for the final video.
                  </p>
                </div>
              )}

              {/* Confirmed duration for existing/upload audio */}
              {(settings.audioSource === 'existing' || settings.audioSource === 'upload') && !isCalculatingDuration && calculatedAudioDuration && calculatedAudioDuration > 0 && (
                <p className="text-xs text-green-400 mt-2 flex items-center">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Runtime calculated from audio file
                </p>
              )}

              {audioDurationError && (
                <p className="text-xs text-red-400 mt-2 flex items-center">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  {audioDurationError}
                </p>
              )}
            </div>

            {/* Clip estimation display */}
            {calculatedAudioDuration && calculatedAudioDuration > 0 && !isCalculatingDuration && !audioDurationLoading && (() => {
              const clipDuration = selectedModelCfg?.durationType === 'fixed'
                ? (selectedModelCfg.defaultDuration ?? ttvDuration) : ttvDuration;
              const autoClips = Math.max(1, Math.floor(calculatedAudioDuration / clipDuration));
              return (
                <div className="bg-surface-elevated rounded-lg p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-text-muted">Clip Duration:</span>
                    <span className="text-white font-medium">{clipDuration}s per clip</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-text-muted">Estimated Video Clips:</span>
                    <span className="text-white font-bold text-xl">{autoClips}</span>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Token estimation */}
      {estimatedClips > 0 && calculatedAudioDuration && calculatedAudioDuration > 0 && (() => {
        const ttvSelectedModelCfg = VIDEO_MODEL_OPTIONS.find(m => m.value === ttvModel);
        const ttvModelLabel = ttvSelectedModelCfg?.label || ttvModel;
        const ttvEffDuration = ttvSelectedModelCfg?.durationType === 'fixed'
          ? (ttvSelectedModelCfg.defaultDuration ?? ttvDuration) : ttvDuration;
        const promptModelLabel = modelOptions?.find((m: any) => m.value === (settings.imagePromptModel || 'sonnet'))?.label || 'Claude Sonnet 4.6';
        const secsPerClip = TTV_SECONDS_PER_VIDEO[ttvModel] ?? TTV_DEFAULT_SECONDS_PER_VIDEO;
        const speedLabel = secsPerClip >= 60 ? `~${Math.round(secsPerClip / 60)} min/clip` : `~${secsPerClip}s/clip`;
        const estGenTimeMinutes = Math.round(estimatedClips * secsPerClip / 60);
        const ttvStorageMB = estimatedClips * 4;
        const availableStorageMB = maxStorageGB != null && storageUsed != null ? (maxStorageGB * 1024) - storageUsed : undefined;
        return (
          <TokenEstimateBox
            rows={[
              { label: `Prompt generation (${estimatedClips} clips · ${promptModelLabel})`, value: `${formatNumber(ttvPromptTokens)} tokens` },
              { label: `Video generation (${ttvModelLabel} · ${ttvEffDuration}s × ${estimatedClips} clips)`, value: `${formatNumber(ttvTotalVideoTokens)} tokens` },
            ]}
            total={totalTTVTokens}
            userTokenBalance={userTokenBalance}
            estimatedTimeMinutes={estGenTimeMinutes}
            timeLabel="Est. video generation time"
            processingSpeedModelName={ttvModelLabel}
            processingSpeedValue={speedLabel}
            storage={ttvStorageMB}
            storageLabel={`Est. storage needed (${estimatedClips} clips × 4 MB)`}
            storageAvailableMB={availableStorageMB}
          />
        );
      })()}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── ITV GENERATE SECTION ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function ITVGenerateSection(props: any) {
  const { isLegacy } = useIsLegacyPlan();
  const ITV_VIDEO_MODEL_OPTIONS = useMemo(() => buildITVVideoModelOptions(isLegacy), [isLegacy]);
  const {
    settings, setSettings, settingsLocked,
    itvModel, itvDuration, itvAudioClip, onITVModelChange, onITVDurationChange, onITVAudioClipChange,
    languageOptions, modelOptions,
    calculatedAudioDuration,
    audioDurationLoading, audioDurationError, isCalculatingDuration,
    isStep2Configured,
    itvClipCount,
    itvImageTokens, itvVideoTokens, itvPromptTokens, totalITVTokens,
    userTokenBalance, storageUsed, maxStorageGB,
  } = props;

  const itvModelConfig = ITV_VIDEO_MODEL_OPTIONS.find(m => m.value === itvModel);
  const itvEffectiveDuration = itvModelConfig?.durationType === 'fixed'
    ? (itvModelConfig.defaultDuration ?? itvDuration) : itvDuration;
  const useAudioClip = itvAudioClip;
  const setUseAudioClip = onITVAudioClipChange;
  const [itvSliderInputValue, setItvSliderInputValue] = useState(String(itvDuration));

  // Reset audio clip when model doesn't support it
  useEffect(() => { if (!ITV_AUDIO_SUPPORTED_MODELS.has(itvModel)) onITVAudioClipChange(false); }, [itvModel]);

  return (
    <>
      {/* ═══ Image Model & Style ═══ */}
      <div className="bg-surface-card rounded-xl border border-border-card p-5">
        <h2 className="text-base font-semibold text-white mb-1">Image Model &amp; Style</h2>
        <p className="text-xs text-text-dim mb-4">Choose the AI model and artistic style for your keyframe images</p>
        <ImageModelSelector
          selectedModel={settings.imageModel}
          selectedStyle={settings.imageStyle}
          onModelChange={(model: string) => setSettings((prev: any) => ({ ...prev, imageModel: model }))}
          onStyleChange={(style: string) => setSettings((prev: any) => ({ ...prev, imageStyle: style }))}
          disabled={settingsLocked}
          isLegacy={isLegacy}
        />
      </div>

      {/* ═══ Video Model ═══ */}
      <div className="bg-surface-card rounded-xl border border-border-card p-5">
        <h2 className="text-base font-semibold text-white mb-1">Video Model</h2>
        <p className="text-xs text-text-dim mb-4">Select the AI model to animate your keyframe images into video clips</p>

        <ITVVideoModelSelector
          selectedModel={itvModel}
          isLegacy={isLegacy}
          onModelChange={(model: string) => {
            onITVModelChange(model);
            const cfg = ITV_VIDEO_MODEL_OPTIONS.find(m => m.value === model);
            if (cfg) {
              onITVDurationChange(cfg.defaultDuration);
              if (cfg.durationType === 'slider') setItvSliderInputValue(String(cfg.defaultDuration));
            }
            if (!ITV_AUDIO_SUPPORTED_MODELS.has(model)) setUseAudioClip(false);
          }}
          disabled={settingsLocked}
        />

        {/* Duration selector */}
        {itvModel && itvModelConfig && itvModelConfig.durationType !== 'fixed' && itvModelConfig.selectable && (
          <div className="mt-5">
            <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Clip Duration</label>
            {itvModelConfig.durationType === 'options' && (
              <div className="flex flex-wrap gap-2">
                {itvModelConfig.durationOptions.map((d: number) => (
                  <button
                    key={d}
                    disabled={settingsLocked}
                    onClick={() => onITVDurationChange(d)}
                    className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      itvDuration === d
                        ? `${itvModelConfig.borderColor} ${itvModelConfig.bgColor} ${itvModelConfig.textColor}`
                        : 'border-border bg-surface-elevated text-text-secondary hover:border-border-subtle'
                    } ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {d}s
                  </button>
                ))}
              </div>
            )}
            {itvModelConfig.durationType === 'slider' && (() => {
              const minVal = itvModelConfig.durationMin ?? 2;
              const maxVal = itvModelConfig.durationMax ?? 12;
              const parsed = parseInt(itvSliderInputValue);
              const isOutOfRange = itvSliderInputValue !== '' && (isNaN(parsed) || parsed < minVal || parsed > maxVal);
              return (
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <input
                      type="range" min={minVal} max={maxVal} step={1} value={itvDuration}
                      disabled={settingsLocked}
                      onChange={e => { const v = parseInt(e.target.value); onITVDurationChange(v); setItvSliderInputValue(String(v)); }}
                      className="flex-1 accent-indigo-500"
                    />
                    <input
                      type="number" min={minVal} max={maxVal} value={itvSliderInputValue}
                      disabled={settingsLocked}
                      onChange={e => { setItvSliderInputValue(e.target.value); const v = parseInt(e.target.value); if (!isNaN(v) && v >= minVal && v <= maxVal) onITVDurationChange(v); }}
                      className="w-16 bg-surface-elevated border border-border rounded-lg px-2 py-1 text-sm text-center text-white focus:outline-none focus:border-indigo-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <span className="text-sm text-text-muted">s</span>
                  </div>
                  {isOutOfRange && (
                    <div className="flex items-center gap-2 text-xs text-amber-400">
                      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                      <span>Enter a value between {minVal} and {maxVal} seconds.</span>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
        {itvModel && itvModelConfig && itvModelConfig.durationType === 'fixed' && (
          <div className="mt-4 flex items-center gap-2 text-sm text-text-muted">
            <span>Clip duration:</span>
            <span className={`font-medium ${itvModelConfig.textColor}`}>{itvModelConfig.defaultDuration}s (fixed)</span>
          </div>
        )}

        {/* Audio Clip toggle */}
        {ITV_AUDIO_SUPPORTED_MODELS.has(itvModel) && (
          <div className="mt-5 pt-5 border-t border-border-card">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <label className="flex items-center text-sm font-medium text-text-secondary">Audio Clips</label>
                <p className="mt-1 text-xs text-text-muted">Generate video clips with matching AI sound design embedded.</p>
                {useAudioClip && (
                  <p className="mt-2 text-xs text-amber-400 flex items-center gap-1">
                    <AlertCircle className="h-3 w-3 flex-shrink-0" />
                    Audio clips can sound strange with text-to-speech audio overlay on a final video.
                  </p>
                )}
                {useAudioClip && (itvModel === 'veo31fast' || itvModel === 'veo31') && (
                  <p className="mt-1 text-xs text-orange-400">
                    ⚡ Veo audio mode: {itvModel === 'veo31fast' ? '90K' : '240K'} tokens/s
                    &nbsp;(vs {itvModel === 'veo31fast' ? '60K' : '120K'} without audio)
                  </p>
                )}
                {useAudioClip && (itvModel === 'ltx23fast' || itvModel === 'ltx23pro' || itvModel === 'ltx23pro4k') && (
                  <p className="mt-1 text-xs text-orange-400">🔊 LTX 2.3 generates native AI audio.</p>
                )}
                {useAudioClip && itvModel === 'seedance15' && (
                  <p className="mt-1 text-xs text-orange-400">
                    ⚡ Seedance 1.5 audio mode: 70.2K tokens/s (vs 34.8K without audio)
                  </p>
                )}
              </div>
              <button type="button" onClick={() => !settingsLocked && setUseAudioClip(!useAudioClip)} disabled={settingsLocked}
                className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${useAudioClip ? 'bg-red-600' : 'bg-surface-input'} ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${useAudioClip ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ═══ Generation Settings ═══ */}
      <div className="bg-surface-card rounded-xl border border-border-card p-5">
        <h2 className="text-base font-semibold text-white mb-4">Generation Settings</h2>
        <div className="space-y-4">
          {/* Character consistency */}
          <div className="flex items-center justify-between bg-surface-elevated px-4 py-3 rounded-lg">
            <div>
              <h3 className="text-sm font-medium text-white">Character Consistency</h3>
              <p className="text-sm text-text-muted mt-1">Maintain consistent character descriptions across all clips</p>
            </div>
            <label className={`relative inline-flex items-center ${settingsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
              <input type="checkbox" checked={settings.useCharacterDescriptions}
                onChange={e => !settingsLocked && setSettings((prev: any) => ({ ...prev, useCharacterDescriptions: e.target.checked }))}
                disabled={settingsLocked} className="sr-only peer" />
              <div className="w-11 h-6 bg-surface-input peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-red-800 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-white/20 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-600"></div>
            </label>
          </div>

          {/* Custom Characters Section - only visible when Character Consistency is ON */}
          {settings.useCharacterDescriptions && (
            <div className="bg-surface-elevated px-4 py-4 rounded-lg space-y-4">
              {/* Custom Characters Toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-white">Custom Characters</h3>
                  <p className="text-sm text-text-muted mt-1">Define your own character descriptions instead of auto-extracting from the story</p>
                </div>
                <label className={`relative inline-flex items-center ${settingsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={props.customCharactersEnabled}
                    onChange={(e) => {
                      if (settingsLocked) return;
                      props.setCustomCharactersEnabled(e.target.checked);
                      if (e.target.checked && props.customCharacters.length === 0) {
                        props.setCustomCharacters([{ name: '', description: '' }]);
                      }
                    }}
                    disabled={settingsLocked}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-surface-input peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-red-800 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-white/20 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-600"></div>
                </label>
              </div>

              {/* Custom Characters Fields */}
              {props.customCharactersEnabled && (
                <div className="space-y-4">
                  {/* Info Warning Box */}
                  <div className="flex items-start gap-2 p-3 bg-amber-900/30 border border-amber-500/40 rounded-lg">
                    <AlertCircle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm text-amber-200 font-medium">Important</p>
                      <p className="text-xs text-amber-300/80 mt-1">
                        Custom character descriptions will override automatic character extraction from your story. 
                        Make sure character names exactly match the names used in your story text for proper matching in video prompts.
                      </p>
                    </div>
                  </div>

                  {/* Character Name + Description Fields */}
                  <div>
                    <label className="block text-sm font-medium text-white mb-2">
                      Character Descriptions
                      <span className="text-xs text-text-muted ml-2">(Max 10)</span>
                    </label>
                    <div className="space-y-3">
                      {props.customCharacters.map((char, index) => (
                        <div key={index} className="flex gap-2 items-start">
                          <div className="flex-1 space-y-2">
                            <input
                              type="text"
                              value={char.name}
                              onChange={(e) => {
                                const newChars = [...props.customCharacters];
                                newChars[index] = { ...newChars[index], name: e.target.value };
                                props.setCustomCharacters(newChars);
                              }}
                              disabled={settingsLocked}
                              placeholder="Character name (must match story text)"
                              className={`w-full px-3 py-2 bg-surface-input border border-border-subtle rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-900/60 ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                            />
                            <textarea
                              value={char.description}
                              onChange={(e) => {
                                const newChars = [...props.customCharacters];
                                newChars[index] = { ...newChars[index], description: e.target.value };
                                props.setCustomCharacters(newChars);
                              }}
                              disabled={settingsLocked}
                              placeholder="Physical appearance, clothing, build, facial features, hair, accessories..."
                              className={`w-full px-3 py-2 bg-surface-input border border-border-subtle rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-900/60 resize-none ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                              rows={2}
                            />
                          </div>
                          {props.customCharacters.length > 1 && !settingsLocked && (
                            <button
                              type="button"
                              onClick={() => {
                                const newChars = props.customCharacters.filter((_, i) => i !== index);
                                props.setCustomCharacters(newChars);
                              }}
                              className="mt-1 p-2 text-red-400 hover:text-red-300 hover:bg-surface-elevated rounded"
                            >
                              <X className="w-5 h-5" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>

                    {props.customCharacters.length < 10 && !settingsLocked && (
                      <button
                        type="button"
                        onClick={() => {
                          props.setCustomCharacters([...props.customCharacters, { name: '', description: '' }]);
                        }}
                        className="mt-3 w-full py-2 bg-surface-input hover:bg-white/10 border border-border-subtle rounded-lg text-red-400 text-sm font-medium flex items-center justify-center gap-2"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        Add Character
                      </button>
                    )}
                  </div>

                  {/* AI Enhancement Toggle */}
                  <div className="flex items-start justify-between pt-3 border-t border-border">
                    <div className="flex-1">
                      <label className="flex items-center text-sm font-medium text-white">
                        AI Enhancement
                        <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-green-500/10 text-green-400 rounded-full border border-green-500/20">
                          Recommended
                        </span>
                      </label>
                      <p className="mt-1 text-xs text-text-muted">
                        Let AI expand your basic character descriptions into detailed visual descriptions optimized for video generation. Provide just the essentials—AI fills in the visual details.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => !settingsLocked && props.setCustomCharactersAIEnhance(!props.customCharactersAIEnhance)}
                      disabled={settingsLocked}
                      className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:ring-offset-2 focus:ring-offset-surface-elevated ${
                        props.customCharactersAIEnhance ? 'bg-red-600' : 'bg-surface-input'
                      } ${settingsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          props.customCharactersAIEnhance ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Language */}
          <div>
            <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Language</label>
            <LanguageSelector settings={settings} setSettings={setSettings} settingsLocked={settingsLocked} languageOptions={languageOptions} />
          </div>

          {/* AI Writing Model */}
          <div>
            <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">AI Writing Model</label>
            <PromptModelSelector settings={settings} setSettings={setSettings} settingsLocked={settingsLocked} modelOptions={modelOptions} />
          </div>
        </div>
      </div>

      {/* ═══ Video Frequency ═══ */}
      <div className="bg-surface-card rounded-xl border border-border-card p-5">
        <h2 className="text-base font-semibold text-white mb-1">Video Frequency</h2>
        <p className="text-xs text-text-dim mb-4">Determines how many video clips will be generated based on audio duration</p>

        {!isStep2Configured && !isCalculatingDuration && !audioDurationLoading ? (
          <div className="bg-yellow-900/20 border border-yellow-500/50 rounded-lg p-3 flex gap-2">
            <AlertCircle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-yellow-200">
              <strong>Audio Configuration Required:</strong> Please configure audio in Step 2 (Audio Configuration) first. The number of video clips is calculated from the audio duration.
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Audio Runtime */}
            <div className="bg-surface-elevated rounded-lg p-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-text-secondary">Audio Runtime:</span>
                {isCalculatingDuration || audioDurationLoading ? (
                  <div className="flex items-center space-x-2">
                    <RefreshCw className="h-4 w-4 text-red-500 animate-spin" />
                    <span className="text-sm text-red-400">Calculating...</span>
                  </div>
                ) : calculatedAudioDuration && calculatedAudioDuration > 0 ? (
                  <span className="text-lg font-semibold text-white">{formatDuration(calculatedAudioDuration)}</span>
                ) : (
                  <span className="text-sm text-text-muted">Waiting for audio duration...</span>
                )}
              </div>

              {/* Estimate note for Generate Audio */}
              {settings.audioSource === 'generate' && !isCalculatingDuration && !audioDurationLoading && calculatedAudioDuration && calculatedAudioDuration > 0 && (
                <div className="dash-info-box p-2 mt-3 flex gap-2">
                  <Info className="h-4 w-4 dash-box-icon flex-shrink-0 mt-0.5" />
                  <p className="text-xs dash-box-text">
                    <strong>Estimate:</strong> This is an estimated runtime based on your story word count. The actual runtime will be calculated after audio generation and used for the final video.
                  </p>
                </div>
              )}

              {/* Confirmed duration for existing/upload audio */}
              {(settings.audioSource === 'existing' || settings.audioSource === 'upload') && !isCalculatingDuration && calculatedAudioDuration && calculatedAudioDuration > 0 && (
                <p className="text-xs text-green-400 mt-2 flex items-center">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Runtime calculated from audio file
                </p>
              )}

              {audioDurationError && (
                <p className="text-xs text-red-400 mt-2 flex items-center">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  {audioDurationError}
                </p>
              )}
            </div>

            {/* Clip estimation display */}
            {calculatedAudioDuration && calculatedAudioDuration > 0 && !isCalculatingDuration && !audioDurationLoading && (
              <div className="bg-surface-elevated rounded-lg p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">Clip Duration:</span>
                  <span className="text-white font-medium">{itvEffectiveDuration}s per clip</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-text-muted">Estimated Video Clips:</span>
                  <span className="text-white font-bold text-xl">
                    {Math.max(1, Math.floor(calculatedAudioDuration / itvEffectiveDuration))}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Token estimation */}
      {itvClipCount > 0 && calculatedAudioDuration && calculatedAudioDuration > 0 && (() => {
        const itvModelLabel = itvModelConfig?.label || itvModel;
        const promptModelLabel = modelOptions?.find((m: any) => m.value === (settings.imagePromptModel || 'sonnet'))?.label || 'Claude Sonnet 4.6';
        const imageModelDisplayName = IMAGE_MODEL_DISPLAY_NAMES[settings.imageModel] || settings.imageModel;
        const itvImageSecsPerImage = ITV_IMAGE_GEN_SECONDS[settings.imageModel] ?? ITV_DEFAULT_IMAGE_GEN_SECONDS;
        const itvVideoSecsPerClip = ITV_SECONDS_PER_CLIP[itvModel] ?? ITV_DEFAULT_SECONDS_PER_CLIP;
        const itvEstGenTimeMinutes = Math.round(itvClipCount * (itvImageSecsPerImage + itvVideoSecsPerClip) / 60);
        const itvImageStorageMB = itvClipCount * 1;
        const itvVideoStorageMB = itvClipCount * 6;
        const availableStorageMB = maxStorageGB != null && storageUsed != null ? (maxStorageGB * 1024) - storageUsed : undefined;
        return (
          <TokenEstimateBox
            rows={[
              { label: `Prompt generation (${itvClipCount} clips · ${promptModelLabel})`, value: `${formatNumber(itvPromptTokens)} tokens` },
              { label: `Image generation (${itvClipCount} images · ${imageModelDisplayName})`, value: `${formatNumber(itvImageTokens)} tokens` },
              { label: `Video generation (${itvModelLabel} · ${itvEffectiveDuration}s × ${itvClipCount})`, value: `${formatNumber(itvVideoTokens)} tokens` },
            ]}
            total={totalITVTokens}
            userTokenBalance={userTokenBalance}
            estimatedTimeMinutes={itvEstGenTimeMinutes}
            timeLabel="Est. total generation time"
            storageBreakdown={[
              { label: `Image storage (${itvClipCount} images × 1 MB)`, valueMB: itvImageStorageMB },
              { label: `Video storage (${itvClipCount} clips × 6 MB)`, valueMB: itvVideoStorageMB },
            ]}
            storageAvailableMB={availableStorageMB}
          />
        );
      })()}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── FOLDER SECTIONS ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function ImageFolderSection({ settings, setSettings, settingsLocked, getImageFoldersForSelectedStory, getImagePromptDocsForSelectedStory, formatDate }: any) {
  // Auto-select prompt doc if only one exists
  useEffect(() => {
    if (settings.selectedImageFolder) {
      const prompts = getImagePromptDocsForSelectedStory();
      if (prompts.length === 1 && settings.imagePromptDoc !== prompts[0].id) {
        setSettings((prev: any) => ({ ...prev, imagePromptDoc: prompts[0].id }));
      }
    }
  }, [settings.selectedImageFolder]);

  return (
    <>
      <FolderSelector
        label="Select Image Folder"
        value={settings.selectedImageFolder}
        onChange={(val: string) => setSettings((prev: any) => ({ ...prev, selectedImageFolder: val, imagePromptDoc: '' }))}
        options={getImageFoldersForSelectedStory()}
        settingsLocked={settingsLocked}
        formatDate={formatDate}
        typeLabel="Folder"
        zIndex="z-30"
      />
      {settings.selectedImageFolder && (
        <FolderSelector
          label="Select Image Prompt Document"
          value={settings.imagePromptDoc}
          onChange={(val: string) => setSettings((prev: any) => ({ ...prev, imagePromptDoc: val }))}
          options={getImagePromptDocsForSelectedStory()}
          settingsLocked={settingsLocked}
          formatDate={formatDate}
          typeLabel="Image Prompts"
          zIndex="z-20"
        />
      )}
    </>
  );
}

function TTVFolderSection({ settings, setSettings, settingsLocked, getTTVFoldersForSelectedStory, getTTVPromptDocsForSelectedStory, formatDate }: any) {
  // Auto-select prompt doc if only one exists
  useEffect(() => {
    if (settings.selectedTTVFolder) {
      const prompts = getTTVPromptDocsForSelectedStory();
      if (prompts.length === 1 && settings.ttvPromptDoc !== prompts[0].id) {
        setSettings((prev: any) => ({ ...prev, ttvPromptDoc: prompts[0].id }));
      }
    }
  }, [settings.selectedTTVFolder]);

  return (
    <>
      <FolderSelector
        label="Select TTV Folder"
        value={settings.selectedTTVFolder || ''}
        onChange={(val: string) => setSettings((prev: any) => ({ ...prev, selectedTTVFolder: val, ttvPromptDoc: '' }))}
        options={getTTVFoldersForSelectedStory()}
        settingsLocked={settingsLocked}
        formatDate={formatDate}
        typeLabel="TTV Folder"
        zIndex="z-30"
      />
      {settings.selectedTTVFolder && (
        <FolderSelector
          label="Select TTV Prompt Document"
          value={settings.ttvPromptDoc || ''}
          onChange={(val: string) => setSettings((prev: any) => ({ ...prev, ttvPromptDoc: val }))}
          options={getTTVPromptDocsForSelectedStory()}
          settingsLocked={settingsLocked}
          formatDate={formatDate}
          typeLabel="TTV Prompts"
          zIndex="z-20"
        />
      )}
    </>
  );
}

function ITVFolderSection({
  settings, setSettings, settingsLocked,
  getITVVideoFoldersForSelectedStory, getITVVideoPromptDocsForSelectedStory,
  getITVImageFoldersForSelectedStory, getITVImagePromptDocsForSelectedStory,
  formatDate,
}: any) {
  // Auto-select docs when only one variant exists
  useEffect(() => {
    const videoFolders = getITVVideoFoldersForSelectedStory();
    if (videoFolders.length === 1 && settings.selectedITVVideoFolder !== videoFolders[0].id) {
      setSettings((prev: any) => ({ ...prev, selectedITVVideoFolder: videoFolders[0].id }));
    }
  }, []);

  useEffect(() => {
    if (settings.selectedITVVideoFolder) {
      const prompts = getITVVideoPromptDocsForSelectedStory();
      if (prompts.length === 1 && settings.itvVideoPromptDoc !== prompts[0].id) {
        setSettings((prev: any) => ({ ...prev, itvVideoPromptDoc: prompts[0].id }));
      }
    }
  }, [settings.selectedITVVideoFolder]);

  useEffect(() => {
    const imageFolders = getITVImageFoldersForSelectedStory();
    if (imageFolders.length === 1 && settings.selectedITVImageFolder !== imageFolders[0].id) {
      setSettings((prev: any) => ({ ...prev, selectedITVImageFolder: imageFolders[0].id }));
    }
  }, []);

  useEffect(() => {
    if (settings.selectedITVImageFolder) {
      const prompts = getITVImagePromptDocsForSelectedStory();
      if (prompts.length === 1 && settings.itvImagePromptDoc !== prompts[0].id) {
        setSettings((prev: any) => ({ ...prev, itvImagePromptDoc: prompts[0].id }));
      }
    }
  }, [settings.selectedITVImageFolder]);

  return (
    <>
      <div className="bg-surface-elevated rounded-lg p-3 mb-2">
        <p className="text-sm text-text-secondary">Select the existing ITV assets for your video. The ITV pipeline requires both keyframe images and animated video clips.</p>
      </div>

      {/* ITV Image Prompt Doc */}
      <FolderSelector
        label="ITV Image Prompt Document"
        value={settings.itvImagePromptDoc || ''}
        onChange={(val: string) => setSettings((prev: any) => ({ ...prev, itvImagePromptDoc: val }))}
        options={getITVImagePromptDocsForSelectedStory()}
        settingsLocked={settingsLocked}
        formatDate={formatDate}
        typeLabel="ITV Image Prompts"
        zIndex="z-40"
      />

      {/* ITV Image Folder */}
      <FolderSelector
        label="ITV Image Folder"
        value={settings.selectedITVImageFolder || ''}
        onChange={(val: string) => setSettings((prev: any) => ({ ...prev, selectedITVImageFolder: val }))}
        options={getITVImageFoldersForSelectedStory()}
        settingsLocked={settingsLocked}
        formatDate={formatDate}
        typeLabel="ITV Images"
        zIndex="z-30"
      />

      {/* ITV Video Prompt Doc */}
      <FolderSelector
        label="ITV Video Prompt Document"
        value={settings.itvVideoPromptDoc || ''}
        onChange={(val: string) => setSettings((prev: any) => ({ ...prev, itvVideoPromptDoc: val }))}
        options={getITVVideoPromptDocsForSelectedStory()}
        settingsLocked={settingsLocked}
        formatDate={formatDate}
        typeLabel="ITV Video Prompts"
        zIndex="z-20"
      />

      {/* ITV Video Folder */}
      <FolderSelector
        label="ITV Video Folder"
        value={settings.selectedITVVideoFolder || ''}
        onChange={(val: string) => setSettings((prev: any) => ({ ...prev, selectedITVVideoFolder: val }))}
        options={getITVVideoFoldersForSelectedStory()}
        settingsLocked={settingsLocked}
        formatDate={formatDate}
        typeLabel="ITV Video Folder"
        zIndex="z-10"
      />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── MG FOLDER SECTION ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function MGFolderSection({
  settings, setSettings, settingsLocked,
  getMGPromptDocsForSelectedStory, getMGVideoFoldersForSelectedStory,
  formatDate,
}: any) {
  const getPrompts = getMGPromptDocsForSelectedStory || (() => []);
  const getFolders = getMGVideoFoldersForSelectedStory || (() => []);

  useEffect(() => {
    const folders = getFolders();
    if (folders.length === 1 && settings.selectedMGFolder !== folders[0].id) {
      setSettings((prev: any) => ({ ...prev, selectedMGFolder: folders[0].id }));
    }
  }, []);

  useEffect(() => {
    const prompts = getPrompts();
    if (prompts.length === 1 && settings.mgPromptDoc !== prompts[0].id) {
      setSettings((prev: any) => ({ ...prev, mgPromptDoc: prompts[0].id }));
    }
  }, []);

  return (
    <>
      <div className="bg-surface-elevated rounded-lg p-3 mb-2">
        <p className="text-sm text-text-secondary">
          Select an existing MG prompt document and/or rendered MG output folder for this story.
        </p>
      </div>

      <FolderSelector
        label="MG Prompt Document"
        value={settings.mgPromptDoc || ''}
        onChange={(val: string) => setSettings((prev: any) => ({ ...prev, mgPromptDoc: val }))}
        options={getPrompts()}
        settingsLocked={settingsLocked}
        formatDate={formatDate}
        typeLabel="MG Prompts"
        zIndex="z-20"
      />

      <FolderSelector
        label="MG Video Folder"
        value={settings.selectedMGFolder || ''}
        onChange={(val: string) => setSettings((prev: any) => ({ ...prev, selectedMGFolder: val }))}
        options={getFolders()}
        settingsLocked={settingsLocked}
        formatDate={formatDate}
        typeLabel="MG Output Folder"
        zIndex="z-10"
      />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── UPLOAD VIDEO TO LOOP SECTION ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function UploadVideoLoopSection({
  settings, setSettings, settingsLocked,
  handleVideoFileUpload, uploadingVideoLoop,
  uploadedVideoLoopFile, setUploadedVideoLoopFile,
  setVideoLoopUrl, uploadedVideoMetadata, setUploadedVideoMetadata,
  videoUploadProgress, videoUploadStartTime,
}: any) {
  return (
    <div>
      <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">
        <span className="hidden sm:inline">Upload Video to Loop</span>
        <span className="sm:hidden">Upload Video</span>
      </label>

      {/* Info box */}
      <div className="bg-yellow-900/30 text-yellow-200 p-4 rounded-lg mb-4">
        <div className="flex items-start space-x-2">
          <Info className="h-5 w-5 text-yellow-400 mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <p className="font-medium mb-2">Video Loop Information:</p>
            <ul className="space-y-1 text-xs">
              <li>• You can loop the video up to 20 hours or match the audio length</li>
              <li>• The video will repeat seamlessly throughout the entire audio duration</li>
              <li>• Best results with videos that have smooth start/end transitions</li>
              <li>• Recommended: Keep videos under 20 minutes for better performance</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Upload area */}
      <div className="relative">
        <div className="flex items-center justify-center w-full">
          <label
            className={`flex flex-col items-center justify-center w-full h-32 border-2 border-border border-dashed rounded-lg transition-colors ${
              settingsLocked || uploadingVideoLoop
                ? 'cursor-not-allowed opacity-50 bg-surface-elevated'
                : 'cursor-pointer bg-surface-elevated hover:bg-surface-elevated'
            }`}
          >
            <div className="flex flex-col items-center justify-center pt-5 pb-6">
              {uploadingVideoLoop ? (
                <>
                  <RefreshCw className="w-8 h-8 mb-3 text-text-secondary animate-spin" />
                  <p className="mb-2 text-sm text-text-secondary">
                    <span className="font-semibold">Uploading video loop...</span>
                  </p>
                  {videoUploadProgress > 0 && (
                    <>
                      <div className="w-48 bg-surface-input rounded-full h-2 mb-2">
                        <div
                          className="bg-red-500 h-2 rounded-full transition-all duration-300"
                          style={{ width: `${videoUploadProgress}%` }}
                        />
                      </div>
                      <p className="text-xs text-text-muted">
                        {videoUploadProgress}% - {estimateTimeRemaining(
                          videoUploadProgress * 1024 * 1024,
                          100 * 1024 * 1024,
                          videoUploadStartTime,
                        ) || 'Calculating...'}
                      </p>
                    </>
                  )}
                </>
              ) : (
                <>
                  <Upload className="w-8 h-8 mb-3 text-text-muted" />
                  <p className="mb-2 text-sm text-text-muted">
                    <span className="font-semibold">Click to upload</span> or drag and drop
                  </p>
                  <p className="text-xs text-text-muted">MP4 files only (max 3GB)</p>
                </>
              )}
            </div>
            <input
              type="file"
              className="hidden"
              accept=".mp4,video/mp4"
              onChange={handleVideoFileUpload}
              disabled={settingsLocked || uploadingVideoLoop}
            />
          </label>
        </div>

        {uploadedVideoLoopFile && (
          <div className="mt-2 flex items-center justify-between bg-surface-elevated p-2 rounded-lg">
            <span className="text-sm text-text-secondary">{uploadedVideoLoopFile.name}</span>
            <button
              onClick={() => {
                if (!settingsLocked) {
                  setUploadedVideoLoopFile(null);
                  setUploadedVideoMetadata(null);
                  setSettings((prev: any) => ({ ...prev, videoLoopUrl: undefined, videoLoopMetadata: undefined }));
                  if (setVideoLoopUrl) setVideoLoopUrl('');
                }
              }}
              disabled={settingsLocked}
              className={`text-text-muted hover:text-white ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Video metadata */}
        {uploadedVideoMetadata && (
          <div className="mt-3 bg-surface-elevated rounded-lg p-3">
            <h4 className="text-sm font-medium text-white mb-2">Video Information:</h4>
            <div className="grid grid-cols-2 gap-2 text-xs text-text-secondary">
              <div>
                <span className="text-text-muted">Duration:</span>
                <span className="ml-1 text-white">{formatDuration(uploadedVideoMetadata.duration)}</span>
              </div>
              <div>
                <span className="text-text-muted">Size:</span>
                <span className="ml-1 text-white">{(uploadedVideoMetadata.size / (1024 * 1024)).toFixed(1)} MB</span>
              </div>
              {uploadedVideoMetadata.width && uploadedVideoMetadata.height && (
                <div>
                  <span className="text-text-muted">Resolution:</span>
                  <span className="ml-1 text-white">{uploadedVideoMetadata.width}×{uploadedVideoMetadata.height}</span>
                </div>
              )}
              {uploadedVideoMetadata.bitrate && (
                <div>
                  <span className="text-text-muted">Bitrate:</span>
                  <span className="ml-1 text-white">{(uploadedVideoMetadata.bitrate / 1000000).toFixed(1)} Mbps</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Loop Time Configuration */}
      {uploadedVideoLoopFile && (
        <div className="mt-4 p-4 bg-surface-elevated rounded-lg">
          <h3 className="text-white font-medium mb-3">Loop Duration</h3>

          <div className="flex items-center justify-between mb-4">
            <div>
              <h4 className="text-sm font-medium text-white">Same as Audio Length</h4>
              <p className="text-sm text-text-muted mt-1">Loop video for the entire audio duration</p>
            </div>
            <label className={`relative inline-flex items-center ${settingsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={settings.sameAsAudioLength}
                onChange={(e) => !settingsLocked && setSettings((prev: any) => ({ ...prev, sameAsAudioLength: e.target.checked }))}
                disabled={settingsLocked}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-surface-input peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-red-800 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-white/20 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-600"></div>
            </label>
          </div>

          {!settings.sameAsAudioLength && (
            <div>
              <h4 className="text-sm font-medium text-white mb-3">Custom Loop Duration (Max 20 hours)</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Hours</label>
                  <input
                    type="text"
                    value={settings.loopTimeHours}
                    onChange={(e) => {
                      if (!settingsLocked) {
                        const value = e.target.value;
                        if (value === '' || (/^\d+$/.test(value) && parseInt(value) >= 0 && parseInt(value) <= 20)) {
                          setSettings((prev: any) => ({ ...prev, loopTimeHours: value === '' ? 0 : parseInt(value) }));
                        }
                      }
                    }}
                    disabled={settingsLocked}
                    className={`w-full px-3 py-2 bg-surface-input border rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 ${
                      (settings.loopTimeHours < 0 || settings.loopTimeHours > 20) ? 'border-red-500' : 'border-border-subtle'
                    } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Minutes</label>
                  <input
                    type="text"
                    value={settings.loopTimeMinutes}
                    onChange={(e) => {
                      if (!settingsLocked) {
                        const value = e.target.value;
                        if (value === '' || (/^\d+$/.test(value) && parseInt(value) >= 0 && parseInt(value) <= 59)) {
                          setSettings((prev: any) => ({ ...prev, loopTimeMinutes: value === '' ? 0 : parseInt(value) }));
                        }
                      }
                    }}
                    disabled={settingsLocked}
                    className={`w-full px-3 py-2 bg-surface-input border rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 ${
                      (settings.loopTimeMinutes < 0 || settings.loopTimeMinutes > 59) ? 'border-red-500' : 'border-border-subtle'
                    } ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}
                    placeholder="30"
                  />
                </div>
              </div>
              <p className="text-xs text-text-muted mt-2">
                Total duration: {settings.loopTimeHours}h {settings.loopTimeMinutes}m
                {settings.loopTimeHours === 0 && settings.loopTimeMinutes === 0 && (
                  <span className="text-yellow-400 ml-2">Please set a duration greater than 0</span>
                )}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── SHARED SUB-COMPONENTS ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function FolderSelector({ label, value, onChange, options, settingsLocked, formatDate, typeLabel, zIndex }: any) {
  return (
    <div className={`relative ${zIndex}`}>
      <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">{label}</label>
      <Listbox value={value} onChange={(val: string) => !settingsLocked && onChange(val)} disabled={settingsLocked}>
        {({ open }) => (
          <div className="relative">
            <Listbox.Button className={`relative w-full bg-surface-elevated border border-border rounded-lg px-4 py-2.5 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}>
              <span className="block truncate">
                {value ? options.find((o: any) => o.id === value)?.title || 'Select...' : `Select ${typeLabel.toLowerCase()}...`}
              </span>
              <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                <ChevronDown className={`h-5 w-5 text-text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
              </span>
            </Listbox.Button>
            {!settingsLocked && (
              <Transition
                show={open}
                enter="transition ease-out duration-100"
                enterFrom="transform opacity-0 scale-95"
                enterTo="transform opacity-100 scale-100"
                leave="transition ease-in duration-75"
                leaveFrom="transform opacity-100 scale-100"
                leaveTo="transform opacity-0 scale-95"
              >
                <Listbox.Options className="absolute z-50 mt-1 w-full bg-surface-dropdown border border-white/[0.08] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                  {options.length === 0 ? (
                    <div className="py-3 px-4 text-sm text-text-dim">No {typeLabel.toLowerCase()} found for this story</div>
                  ) : (
                    options.map((item: any) => (
                      <Listbox.Option
                        key={item.id}
                        value={item.id}
                        className={({ active }: any) =>
                          `relative cursor-pointer select-none py-2 px-4 ${active ? 'bg-white/[0.08] text-white' : 'text-text-secondary'}`
                        }
                      >
                        <div className="flex flex-col">
                          <span className="font-medium">{item.title}</span>
                          <span className="text-sm text-text-muted flex items-center">
                            <Calendar className="h-3 w-3 mr-1" />
                            {formatDate(item.created_at)} • {typeLabel}
                          </span>
                        </div>
                      </Listbox.Option>
                    ))
                  )}
                </Listbox.Options>
              </Transition>
            )}
          </div>
        )}
      </Listbox>
    </div>
  );
}

function LanguageSelector({ settings, setSettings, settingsLocked, languageOptions }: any) {
  return (
    <Listbox
      value={settings.language}
      onChange={(value: string) => !settingsLocked && setSettings((prev: any) => ({ ...prev, language: value }))}
      disabled={settingsLocked}
    >
      {({ open }) => (
        <div className="relative">
          <Listbox.Button className={`relative w-full bg-surface-elevated border border-border rounded-lg px-4 py-2.5 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}>
            <span className="block truncate">
              {languageOptions.find((o: any) => o.value === settings.language)?.label || 'English'}
            </span>
            <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
              <ChevronDown className={`h-5 w-5 text-text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
            </span>
          </Listbox.Button>
          {!settingsLocked && (
            <Transition
              show={open}
              enter="transition ease-out duration-100"
              enterFrom="transform opacity-0 scale-95"
              enterTo="transform opacity-100 scale-100"
              leave="transition ease-in duration-75"
              leaveFrom="transform opacity-100 scale-100"
              leaveTo="transform opacity-0 scale-95"
            >
              <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-dropdown border border-white/[0.08] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                {languageOptions.map((option: any) => (
                  <Listbox.Option
                    key={option.value}
                    value={option.value}
                    className={({ active, selected }: any) =>
                      `relative cursor-pointer select-none py-3 px-4 ${active ? 'bg-white/[0.08] text-white' : 'text-text-secondary'} ${selected ? 'font-medium' : 'font-normal'}`
                    }
                  >
                    {({ selected }: any) => (
                      <div className="flex justify-between items-center">
                        <span className={selected ? 'font-medium' : 'font-normal'}>{option.label}</span>
                        {selected && <CheckCircle2 className="h-5 w-5 text-accent-text" />}
                      </div>
                    )}
                  </Listbox.Option>
                ))}
              </Listbox.Options>
            </Transition>
          )}
        </div>
      )}
    </Listbox>
  );
}

function PromptModelSelector({ settings, setSettings, settingsLocked, modelOptions }: any) {
  return (
    <>
      <Listbox
        value={settings.imagePromptModel || 'sonnet'}
        onChange={(value: string) => !settingsLocked && setSettings((prev: any) => ({ ...prev, imagePromptModel: value }))}
        disabled={settingsLocked}
      >
        {({ open }) => (
          <div className="relative">
            <Listbox.Button className={`relative w-full bg-surface-elevated border border-border rounded-lg px-4 py-2.5 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 ${settingsLocked ? 'cursor-not-allowed opacity-50' : ''}`}>
              <span className="block truncate">
                {modelOptions.find((o: any) => o.value === (settings.imagePromptModel || 'sonnet'))?.label || 'Claude Sonnet 4.6'}
              </span>
              <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                <ChevronDown className={`h-5 w-5 text-text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
              </span>
            </Listbox.Button>
            {!settingsLocked && (
              <Transition
                show={open}
                enter="transition ease-out duration-100"
                enterFrom="transform opacity-0 scale-95"
                enterTo="transform opacity-100 scale-100"
                leave="transition ease-in duration-75"
                leaveFrom="transform opacity-100 scale-100"
                leaveTo="transform opacity-0 scale-95"
              >
                <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-dropdown border border-white/[0.08] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                  {modelOptions.map((option: any) => (
                    <Listbox.Option
                      key={option.value}
                      value={option.value}
                      className={({ active, selected }: any) =>
                        `relative cursor-pointer select-none py-3 px-4 ${active ? 'bg-white/[0.08] text-white' : 'text-text-secondary'} ${selected ? 'font-medium' : 'font-normal'}`
                      }
                    >
                      {({ selected }: any) => (
                        <div className="flex justify-between items-center">
                          <div>
                            <span className={selected ? 'font-medium' : 'font-normal'}>{option.label}</span>
                            <p className="text-xs text-text-muted mt-1">{option.description}</p>
                          </div>
                          {selected && <CheckCircle2 className="h-5 w-5 text-accent-text" />}
                        </div>
                      )}
                    </Listbox.Option>
                  ))}
                </Listbox.Options>
              </Transition>
            )}
          </div>
        )}
      </Listbox>
      <p className="mt-2 text-xs text-text-muted">
        {modelOptions.find((m: any) => m.value === (settings.imagePromptModel || 'sonnet'))?.description || '11x tokens'}
      </p>
    </>
  );
}

interface StorageBreakdownRow {
  label: string;
  valueMB: number;
}

function formatStorageMBLocal(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(2)} MB`;
}

function formatEstTime(minutes: number): string {
  if (minutes <= 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function TokenEstimateBox({
  rows,
  total,
  storage,
  storageLabel,
  storageBreakdown,
  storageAvailableMB,
  userTokenBalance,
  estimatedTimeMinutes,
  timeLabel,
  processingSpeedModelName,
  processingSpeedValue,
}: {
  rows: { label: string; value: string }[];
  total: number;
  storage?: number;
  storageLabel?: string;
  storageBreakdown?: StorageBreakdownRow[];
  storageAvailableMB?: number;
  userTokenBalance?: number;
  estimatedTimeMinutes?: number;
  timeLabel?: string;
  processingSpeedModelName?: string;
  processingSpeedValue?: string;
}) {
  const totalStorageMB = storage ?? (storageBreakdown ? storageBreakdown.reduce((s, r) => s + r.valueMB, 0) : 0);
  return (
    <div className="dash-info-box mt-4 p-4">
      <h3 className="text-sm font-semibold dash-box-text mb-3 flex items-center gap-1">
        <span>⚡</span> Generation Estimate
      </h3>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex justify-between items-center gap-2">
            <span className="text-sm dash-box-text">{row.label}</span>
            <span className="text-sm font-semibold text-white whitespace-nowrap">{row.value}</span>
          </div>
        ))}
        <div className="border-t border-[--color-status-info-border] my-2"></div>
        <div className="flex justify-between items-center">
          <span className="text-sm font-semibold dash-box-text">Total required</span>
          <span className="text-base font-bold text-status-info">{formatNumber(total)} tokens</span>
        </div>
        {userTokenBalance !== undefined && (
          <div className="flex justify-between items-center">
            <span className="text-sm dash-box-text">Your available balance</span>
            <span className={`text-sm font-semibold ${userTokenBalance < total ? 'text-red-400' : 'text-green-400'}`}>
              {formatNumber(userTokenBalance)} tokens
            </span>
          </div>
        )}
        {estimatedTimeMinutes !== undefined && estimatedTimeMinutes > 0 && (
          <div className="flex justify-between items-center">
            <span className="text-sm dash-box-text">{timeLabel ?? 'Est. generation time'}</span>
            <span className="text-sm font-semibold text-white">{formatEstTime(estimatedTimeMinutes)}</span>
          </div>
        )}
        {processingSpeedModelName && processingSpeedValue && (
          <div className="flex justify-between items-center">
            <span className="text-sm dash-box-text">{processingSpeedModelName} processing speed</span>
            <span className="text-sm font-semibold text-white">{processingSpeedValue}</span>
          </div>
        )}
        {/* Storage section */}
        {storageBreakdown ? (
          <>
            <div className="border-t border-[--color-status-info-border] my-2"></div>
            {storageBreakdown.map((row, i) => (
              <div key={i} className="flex justify-between items-center">
                <span className="text-sm dash-box-text">{row.label}</span>
                <span className="text-sm font-semibold text-white">{formatStorageMBLocal(row.valueMB)}</span>
              </div>
            ))}
            <div className="flex justify-between items-center">
              <span className="text-sm font-semibold dash-box-text">Total storage needed</span>
              <span className="text-sm font-bold text-white">{formatStorageMBLocal(totalStorageMB)}</span>
            </div>
          </>
        ) : storage !== undefined ? (
          <>
            <div className="border-t border-[--color-status-info-border] my-2"></div>
            <div className="flex justify-between items-center">
              <span className="text-sm dash-box-text">{storageLabel ?? 'Est. storage needed'}</span>
              <span className="text-sm font-semibold text-white">{formatStorageMBLocal(storage)}</span>
            </div>
          </>
        ) : null}
        {storageAvailableMB !== undefined && (
          <div className="flex justify-between items-center">
            <span className="text-sm dash-box-text">Available storage</span>
            <span className={`text-sm font-semibold ${storageAvailableMB < totalStorageMB ? 'text-red-400' : 'text-white'}`}>
              {formatStorageMBLocal(storageAvailableMB)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default VisualConfiguration;
