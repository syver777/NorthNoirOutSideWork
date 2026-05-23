import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Listbox, Transition } from '@headlessui/react';
import { Link, useNavigate } from 'react-router-dom';
import { RefreshCw, RotateCcw, X, AlertCircle, CheckCircle2, ChevronDown, Folder, Info, Download, Play, BookOpen, Lock } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import DashboardLayout from '../components/DashboardLayout';
import StatusBanner from '../components/StatusBanner';
import { DocumentSelector } from '../components/FileUploadComponents';
import ImageModelSelector from '../components/ImageModelSelector';
import ITVVideoModelSelector, {
  ITV_VIDEO_MODEL_OPTIONS,
  ITV_TOKENS_PER_SECOND,
  ITV_AUDIO_TOKENS_PER_SECOND,
  ITV_AUDIO_SUPPORTED_MODELS,
  ITV_SECONDS_PER_VIDEO,
  ITV_DEFAULT_SECONDS_PER_VIDEO,
  buildITVVideoModelOptions,
} from '../components/ITVVideoModelSelector';
import TabManager from '../components/TabManager';
import { v4 as uuidv4 } from 'uuid';
import { useTabSessionStorage } from '../hooks/useTabSessionStorage';
import { updateTabStatus, ensureTabExists, deleteTabFromDB } from '../utils/tabManager';
import { getStorageLimitGB } from '../utils/storageHelpers';
import { uploadWithTus } from '../utils/tusUpload';
import { fetchWithFallback } from '../utils/fetchWithFallback';
import { useIsLegacyPlan } from '../hooks/useIsLegacyPlan';
import { getPlanMaxTokens } from '../data/planMaxTokens';
import {
  LEGACY_LLM_MULTIPLIERS,
  NEW_LLM_MULTIPLIERS,
  LEGACY_IMAGE_TOKENS_PER_IMAGE,
  NEW_IMAGE_TOKENS_PER_IMAGE,
  LEGACY_ITV_TOKENS_PER_SECOND,
  NEW_ITV_TOKENS_PER_SECOND,
  LEGACY_ITV_TOKENS_PER_SECOND_AUDIO,
  NEW_ITV_TOKENS_PER_SECOND_AUDIO,
} from '../data/tokenCosts';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

// ─── Constants ────────────────────────────────────────────────────────────────

const OPERATION_TIMEOUT = 30000;
const POLLING_INTERVAL_P1 = 6000;
const POLLING_INTERVAL_P2 = 8000;
const POLLING_INTERVAL_P3 = 6000;
const POLLING_INTERVAL_P4 = 10000;

// Estimated seconds per image for time-remaining display
// Includes both frontend tier names and backend model names for compatibility
const IMAGE_SECONDS_PER_IMAGE: Record<string, number> = {
  spark: 15, 'flux-2-dev': 15,
  standard: 20, 'imagen-4-fast': 20,
  grok: 22, 'grok-imagine-image': 22,
  plus: 25, 'gpt-image-1-mini': 25,
  prime: 25, 'seedream-4.5': 25,
  premium: 45, 'imagen-4-ultra': 45,
  genesis: 60, 'nano-banana-pro': 60,
};
const IMAGE_DEFAULT_SECONDS_PER_IMAGE = 25;

// Each prompt batch (image prompt or video prompt) takes ~60 seconds
const SECONDS_PER_PROMPT_BATCH = 60;

// Image model tokens-per-image (LEGACY default; in-component shadow is plan-aware).
// Includes both frontend tier names and backend model names for compatibility.
const IMAGE_TOKENS_PER_IMAGE: Record<string, number> = {
  spark: LEGACY_IMAGE_TOKENS_PER_IMAGE['flux-2-dev'], 'flux-2-dev': LEGACY_IMAGE_TOKENS_PER_IMAGE['flux-2-dev'],
  standard: LEGACY_IMAGE_TOKENS_PER_IMAGE['imagen-4-fast'], 'imagen-4-fast': LEGACY_IMAGE_TOKENS_PER_IMAGE['imagen-4-fast'],
  grok: LEGACY_IMAGE_TOKENS_PER_IMAGE['grok-imagine-image'], 'grok-imagine-image': LEGACY_IMAGE_TOKENS_PER_IMAGE['grok-imagine-image'],
  plus: LEGACY_IMAGE_TOKENS_PER_IMAGE['gpt-image-1-mini'], 'gpt-image-1-mini': LEGACY_IMAGE_TOKENS_PER_IMAGE['gpt-image-1-mini'],
  prime: LEGACY_IMAGE_TOKENS_PER_IMAGE['seedream-4.5'], 'seedream-4.5': LEGACY_IMAGE_TOKENS_PER_IMAGE['seedream-4.5'],
  premium: LEGACY_IMAGE_TOKENS_PER_IMAGE['imagen-4-ultra'], 'imagen-4-ultra': LEGACY_IMAGE_TOKENS_PER_IMAGE['imagen-4-ultra'],
  genesis: LEGACY_IMAGE_TOKENS_PER_IMAGE['nano-banana-pro'], 'nano-banana-pro': LEGACY_IMAGE_TOKENS_PER_IMAGE['nano-banana-pro'],
};

function buildImageTokensPerImage(isLegacy: boolean): Record<string, number> {
  const m = isLegacy ? LEGACY_IMAGE_TOKENS_PER_IMAGE : NEW_IMAGE_TOKENS_PER_IMAGE;
  return {
    spark: m['flux-2-dev'], 'flux-2-dev': m['flux-2-dev'],
    standard: m['imagen-4-fast'], 'imagen-4-fast': m['imagen-4-fast'],
    grok: m['grok-imagine-image'], 'grok-imagine-image': m['grok-imagine-image'],
    plus: m['gpt-image-1-mini'], 'gpt-image-1-mini': m['gpt-image-1-mini'],
    prime: m['seedream-4.5'], 'seedream-4.5': m['seedream-4.5'],
    premium: m['imagen-4-ultra'], 'imagen-4-ultra': m['imagen-4-ultra'],
    genesis: m['nano-banana-pro'], 'nano-banana-pro': m['nano-banana-pro'],
  };
}

// Image model value → backend value mapping
// Includes identity mappings for backend values (ImageModelSelector sends backend values)
const IMAGE_MODEL_BACKEND: Record<string, string> = {
  spark: 'flux-2-dev', 'flux-2-dev': 'flux-2-dev',
  standard: 'imagen-4-fast', 'imagen-4-fast': 'imagen-4-fast',
  grok: 'grok-imagine-image', 'grok-imagine-image': 'grok-imagine-image',
  plus: 'gpt-image-1-mini', 'gpt-image-1-mini': 'gpt-image-1-mini',
  prime: 'seedream-4.5', 'seedream-4.5': 'seedream-4.5',
  premium: 'imagen-4-ultra', 'imagen-4-ultra': 'imagen-4-ultra',
  genesis: 'nano-banana-pro', 'nano-banana-pro': 'nano-banana-pro',
};

// Token cost for one redo per backend model name (mirrors redo-image required tokens).
// LEGACY default; in-component shadow flips to NEW for non-grandfathered users.
const IMAGE_BACKEND_TOKENS: Record<string, number> = {
  'flux-2-dev': 3000,
  'imagen-4-fast': LEGACY_IMAGE_TOKENS_PER_IMAGE['imagen-4-fast'],
  'grok-imagine-image': LEGACY_IMAGE_TOKENS_PER_IMAGE['grok-imagine-image'],
  'gpt-image-1-mini': LEGACY_IMAGE_TOKENS_PER_IMAGE['gpt-image-1-mini'],
  'seedream-4.5': LEGACY_IMAGE_TOKENS_PER_IMAGE['seedream-4.5'],
  'imagen-4-ultra': LEGACY_IMAGE_TOKENS_PER_IMAGE['imagen-4-ultra'],
  'nano-banana-pro': LEGACY_IMAGE_TOKENS_PER_IMAGE['nano-banana-pro'],
};

function buildImageBackendTokens(isLegacy: boolean): Record<string, number> {
  const m = isLegacy ? LEGACY_IMAGE_TOKENS_PER_IMAGE : NEW_IMAGE_TOKENS_PER_IMAGE;
  return {
    'flux-2-dev': 3000,
    'imagen-4-fast': m['imagen-4-fast'],
    'grok-imagine-image': m['grok-imagine-image'],
    'gpt-image-1-mini': m['gpt-image-1-mini'],
    'seedream-4.5': m['seedream-4.5'],
    'imagen-4-ultra': m['imagen-4-ultra'],
    'nano-banana-pro': m['nano-banana-pro'],
  };
}

// Estimated generation seconds per image model (backend value)
const IMAGE_GEN_SECONDS: Record<string, number> = {
  'flux-2-dev': 30,
  'imagen-4-fast': 25,
  'grok-imagine-image': 30,
  'gpt-image-1-mini': 45,
  'seedream-4.5': 60,
  'imagen-4-ultra': 90,
  'nano-banana-pro': 120,
};

const planMaxTokens: Record<string, number> = {
  free: 400000,
  standard: 4000000,
  plus: 6000000,
  premium: 10000000,
  pro: 25000000,
  elite: 50000000,
  ultimate: 75000000,
  enterprise: 250000000,
};

const MAX_FILE_SIZE_MB = 1;
const MAX_WORD_COUNT = 70000;

const LANGUAGE_OPTIONS = [
  { value: 'english', label: 'English' },
  { value: 'german', label: 'German' },
  { value: 'spanish', label: 'Spanish' },
  { value: 'french', label: 'French' },
];

// Per-model LLM multipliers come from the active plan map.
function buildModelOptions(isLegacy: boolean) {
  const m = isLegacy ? LEGACY_LLM_MULTIPLIERS : NEW_LLM_MULTIPLIERS;
  return [
    { value: 'deepseek', label: 'Core Model',        description: `${m.deepseek}× tokens` },
    { value: 'sonnet',   label: 'Claude Sonnet 4.6', description: `${m.sonnet}× tokens` },
    { value: 'opus',     label: 'Claude Opus 4.6',   description: `${m.opus}× tokens` },
  ];
}
const MODEL_OPTIONS = buildModelOptions(true);

function buildPromptModelMultiplier(isLegacy: boolean): Record<string, number> {
  const m = isLegacy ? LEGACY_LLM_MULTIPLIERS : NEW_LLM_MULTIPLIERS;
  return { deepseek: m.deepseek, sonnet: m.sonnet, opus: m.opus };
}
const PROMPT_MODEL_MULTIPLIER: Record<string, number> = buildPromptModelMultiplier(true);

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface StoryDocument {
  id: string;
  title: string;
  description?: string;
  is_corrected: boolean;
  version?: number;
  group_id?: string;
  created_at: string;
  file_path: string;
  word_count?: number;
  file_size?: number;
}

interface AudioFile {
  path: string;
  name: string;
  duration: number;
}

const ITV_MB_PER_VIDEO = 6;
const ITV_MB_PER_IMAGE = 1;

interface ITVEstimate {
  totalVideos: number;
  totalAudioDuration: number;
  promptTokens: number;
  imageTokens: number;
  videoTokens: number;
  totalTokens: number;
  storageNeededMB: number;
}

interface ITVTaskInfo {
  id: string;
  batchNumber: number;
  videoModel: string;
  videoDuration: number;
  audioClip: boolean;
  imageModel: string;
  imageNumber: number | null;
}

type GenerationPhase = 'imagePrompts' | 'keyframeImages' | 'videoPrompts' | 'videoGeneration' | 'complete';

export interface ImageToVideoGeneratorRef {
  cleanup: () => Promise<void>;
}

interface ImageToVideoGeneratorProps {
  initialTab?: number;
  isEnterpriseUser?: boolean;
  initialTabs?: import('../utils/tabManager').TabInfo[];
  onTabChange?: (tab: number, groupId: string) => void;
  onTabCreate?: (tab: number, groupId: string) => void;
  onTabClose?: (tab: number, groupId: string) => void;
  userId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const formatNumber = (n: number): string => n.toLocaleString();

const formatDuration = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

const formatStorageSize = (mb: number): string => {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb < 1 ? 1 : 2)} MB`;
};

const validateFileName = (name: string): string | null => {
  if (/[<>:"|?*\\]/.test(name)) return 'File name contains invalid characters';
  if (name.length > 200) return 'File name is too long';
  return null;
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); }).catch(e => { clearTimeout(timer); reject(e); });
  });
}

function computeITVEstimate(
  audioDuration: number,
  videoDuration: number,
  videoModel: string,
  imageModel: string,
  promptModel: string,
  useCharacterDescriptions: boolean,
  useAudioClip: boolean,
  promptMultMap: Record<string, number> = PROMPT_MODEL_MULTIPLIER,
  imgTokMap: Record<string, number> = IMAGE_TOKENS_PER_IMAGE,
  itvRates: Record<string, number> = ITV_TOKENS_PER_SECOND,
  itvAudioRates: Record<string, number> = ITV_AUDIO_TOKENS_PER_SECOND,
): ITVEstimate | null {
  if (audioDuration <= 0 || videoDuration <= 0) return null;

  const totalVideos = Math.max(1, Math.floor(audioDuration / videoDuration));

  // Prompt tokens: ~2000 tokens per prompt batch for image+video prompts combined
  const multiplier = promptMultMap[promptModel] ?? 1;
  const charDescMultiplier = useCharacterDescriptions ? 1.15 : 1;
  const promptTokens = Math.round(totalVideos * 2000 * multiplier * charDescMultiplier);

  // Image tokens
  const imgTPI = imgTokMap[imageModel] ?? 14000;
  const imageTokens = totalVideos * imgTPI;

  // Video tokens
  const tps = useAudioClip && itvAudioRates[videoModel]
    ? itvAudioRates[videoModel]
    : itvRates[videoModel] ?? 6000;
  const videoTokens = Math.round(totalVideos * tps * videoDuration);

  const storageNeededMB = totalVideos * (ITV_MB_PER_IMAGE + ITV_MB_PER_VIDEO);
  return {
    totalVideos,
    totalAudioDuration: audioDuration,
    promptTokens,
    imageTokens,
    videoTokens,
    totalTokens: promptTokens + imageTokens + videoTokens,
    storageNeededMB,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

const ImageToVideoGenerator = forwardRef<ImageToVideoGeneratorRef, ImageToVideoGeneratorProps>(
  (
    { initialTab = 1, isEnterpriseUser = false, initialTabs, onTabChange, onTabCreate, onTabClose, userId },
    ref,
  ) => {
    const navigate = useNavigate();
    const currentTab = initialTab;

    // Plan-aware token-cost maps. Shadow the module-scope LEGACY defaults so
    // every in-component reference (estimate math, display labels, gating)
    // reflects what the backend will charge under the active plan.
    const { isLegacy } = useIsLegacyPlan();
    const MODEL_OPTIONS = React.useMemo(() => buildModelOptions(isLegacy), [isLegacy]);
    const PROMPT_MODEL_MULTIPLIER = React.useMemo(() => buildPromptModelMultiplier(isLegacy), [isLegacy]);
    const IMAGE_TOKENS_PER_IMAGE = React.useMemo(() => buildImageTokensPerImage(isLegacy), [isLegacy]);
    const IMAGE_BACKEND_TOKENS = React.useMemo(() => buildImageBackendTokens(isLegacy), [isLegacy]);
    const ITV_TOKENS_PER_SECOND = React.useMemo(
      () => (isLegacy ? LEGACY_ITV_TOKENS_PER_SECOND : NEW_ITV_TOKENS_PER_SECOND),
      [isLegacy],
    );
    const ITV_AUDIO_TOKENS_PER_SECOND = React.useMemo(
      () => (isLegacy ? LEGACY_ITV_TOKENS_PER_SECOND_AUDIO : NEW_ITV_TOKENS_PER_SECOND_AUDIO),
      [isLegacy],
    );
    // Format token-per-second values consistently (e.g. 70200 → "70.2K").
    const fmtKps = React.useCallback((n: number) => {
      const k = n / 1000;
      return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
    }, []);

    // ── User & plan state ─────────────────────────────────────────────────────
    const [currentUserId, setCurrentUserId] = useState<string | null>(userId ?? null);
    const [userTokenBalance, setUserTokenBalance] = useState(0);
    const [userPlan, setUserPlan] = useState('free');
    const [planLoaded, setPlanLoaded] = useState(false);
    const [storageUsed, setStorageUsed] = useState<number | null>(null);
    const maxStorageGB = getStorageLimitGB(userPlan);

    // ── Document state ────────────────────────────────────────────────────────
    const [documents, setDocuments] = useState<StoryDocument[]>([]);
    const [selectedDoc, setSelectedDoc] = useTabSessionStorage<string>('itv_selectedDoc', '', currentTab);
    const [uploadedDoc, setUploadedDoc] = useState<File | null>(null);
    const [uploadedDocId, setUploadedDocId] = useState<string | null>(null);
    const [uploadingFile, setUploadingFile] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);

    // ── Image model state ─────────────────────────────────────────────────────
    const [imageModel, setImageModel] = useTabSessionStorage<string>('itv_imageModel', 'prime', currentTab);
    const [imageStyle, setImageStyle] = useTabSessionStorage<string>('itv_imageStyle', '', currentTab);

    // ── ITV video model state ─────────────────────────────────────────────────
    const [videoModel, setVideoModel] = useTabSessionStorage<string>('itv_videoModel', 'hailuo23fast', currentTab);
    const [videoDuration, setVideoDuration] = useTabSessionStorage<number>('itv_videoDuration', 6, currentTab);
    const [useAudioClip, setUseAudioClip] = useTabSessionStorage<boolean>('itv_audioClip', false, currentTab);
    const [itvSliderInputValue, setItvSliderInputValue] = useState(String(6));

    // ── Generation settings ───────────────────────────────────────────────────
    const [useCharacterDescriptions, setUseCharacterDescriptions] = useTabSessionStorage<boolean>('itv_charDesc', true, currentTab);
    const [customCharactersEnabled, setCustomCharactersEnabled] = useTabSessionStorage<boolean>('itv_customCharsEnabled', false, currentTab);
    const [customCharacters, setCustomCharacters] = useTabSessionStorage<Array<{ name: string; description: string }>>('itv_customChars', [{ name: '', description: '' }], currentTab);
    const [customCharactersAIEnhance, setCustomCharactersAIEnhance] = useTabSessionStorage<boolean>('itv_customCharsAIEnhance', false, currentTab);
    const [language, setLanguage] = useTabSessionStorage<string>('itv_language', 'english', currentTab);
    const [promptModel, setPromptModel] = useTabSessionStorage<string>('itv_promptModel', 'sonnet', currentTab);

    // ── Audio / frequency state ───────────────────────────────────────────────
    const [audioFiles, setAudioFiles] = useState<AudioFile[]>([]);
    const [loadingAudioFiles, setLoadingAudioFiles] = useState(false);
    const [selectedAudioPath, setSelectedAudioPath] = useTabSessionStorage<string>('itv_audioPath', '', currentTab);
    const [totalAudioDuration, setTotalAudioDuration] = useTabSessionStorage<number>('itv_audioDuration', 0, currentTab);
    const [calculatingDuration, setCalculatingDuration] = useState(false);
    const [audioDurationError, setAudioDurationError] = useState<string | null>(null);
    const [uploadingAudio, setUploadingAudio] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const audioUploadRef = useRef<HTMLInputElement>(null);

    // ── Generation state ──────────────────────────────────────────────────────
    const [resumeChecked, setResumeChecked] = useState(false);
    const [generationState, setGenerationState] = useState<'idle' | 'generating' | 'complete' | 'error'>('idle');
    const [currentPhase, setCurrentPhase] = useState<GenerationPhase>('imagePrompts');
    const [phaseOneProgress, setPhaseOneProgress] = useState(0);
    const [phaseTwoProgress, setPhaseTwoProgress] = useState(0);
    const [phaseThreeProgress, setPhaseThreeProgress] = useState(0);
    const [phaseFourProgress, setPhaseFourProgress] = useState(0);
    const [statusMessage, setStatusMessage] = useState('');
    const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
    const [stuckWarning, setStuckWarning] = useState(false);
    const [generationTitle, setGenerationTitle] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [groupId, setGroupId] = useState<string | null>(null);
    const [, setCurrentVariant] = useState<number | null>(null);
    const [stopRequested, setStopRequested] = useState(false);
    const [estimate, setEstimate] = useState<ITVEstimate | null>(null);

    // ── Completion state ──────────────────────────────────────────────────────
    const [generatedVideos, setGeneratedVideos] = useState<string[]>([]);
    const [generatedVideoTasks, setGeneratedVideoTasks] = useState<ITVTaskInfo[]>([]);
    const [redoingVideo, setRedoingVideo] = useState<number | null>(null);
    const [redoingMode, setRedoingMode] = useState<'image_and_video' | 'video_only' | null>(null);
    const [redoModalOpen, setRedoModalOpen] = useState(false);
    const [redoModalBatchNum, setRedoModalBatchNum] = useState<number | null>(null);
    const [redoModalFeedback, setRedoModalFeedback] = useState('');
    const [isDownloadingZip, setIsDownloadingZip] = useState(false);
    const [zipDownloadProgress, setZipDownloadProgress] = useState(0);
    const [showVideos, setShowVideos] = useState(false);

    // ── Individual Prompt (single ITV) state ──────────────────────────────────
    const [inputMode, setInputMode] = useTabSessionStorage<'document' | 'prompt'>('itv_inputMode', 'document', currentTab);
    const [singlePrompt, setSinglePrompt] = useTabSessionStorage<string>('itv_singlePrompt', '', currentTab);
    const [singleGenState, setSingleGenState] = useState<'idle' | 'generating' | 'complete' | 'error'>('idle');
    const [singleGenPhase, setSingleGenPhase] = useState<'image' | 'video' | null>(null);
    const [singleVideoUrl, setSingleVideoUrl] = useState<string | null>(null);
    const [singleITVTaskId, setSingleITVTaskId] = useState<string | null>(null);
    const [singleImageTaskId, setSingleImageTaskId] = useState<string | null>(null);
    const [singleDoneLoading, setSingleDoneLoading] = useState(false);
    const [singleError, setSingleError] = useState<string | null>(null);

    // ── Refs ──────────────────────────────────────────────────────────────────
    const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const stoppedRef = useRef(false);
    const redoPhaseRef = useRef<'waiting' | 'running'>('waiting');

    // ── Expose cleanup ────────────────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      cleanup: async () => {
        console.log(`[ITV Tab ${currentTab}] Cleanup called`);
        if (pollingRef.current) clearInterval(pollingRef.current);
        stoppedRef.current = true;
        try {
          if (!currentUserId) return;
          const { data: completedTasks } = await supabase
            .from('ITV_tasks')
            .select('status')
            .eq('user_id', currentUserId)
            .eq('tab', currentTab)
            .eq('status', 'completed_final')
            .limit(1);

          const hasCompletedFinal = completedTasks && completedTasks.length > 0;

          if (!hasCompletedFinal && groupId) {
            await supabase.from('ITV_prompt_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);
            await supabase.from('ITV_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);
            await supabase.from('image_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab).eq('itv', true);
          }

          if (groupId) {
            await supabase.from('ITV_tasks').delete().eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);
            await supabase.from('ITV_prompt_tasks').delete().eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);
            await supabase.from('ITV_prompt_context').delete().eq('group_id', groupId).eq('tab', currentTab);
            await supabase.from('image_tasks').delete().eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab).eq('itv', true);
          }
          // Cleanup any in-progress single-ITV tasks for this tab
          await supabase.from('ITV_tasks').update({ stop_requested: true })
            .eq('user_id', currentUserId).eq('tab', currentTab).eq('single_itv', true)
            .neq('status', 'completed_final');
          await supabase.from('ITV_tasks').delete()
            .eq('user_id', currentUserId).eq('tab', currentTab).eq('single_itv', true)
            .neq('status', 'completed_final');
          if (singleImageTaskId) {
            await supabase.from('image_tasks').delete().eq('id', singleImageTaskId);
          }
          await deleteTabFromDB(currentUserId, 'itv', currentTab);
          console.log(`[ITV Tab ${currentTab}] Cleanup complete`);
        } catch (error) {
          console.error(`[ITV Tab ${currentTab}] Error during cleanup:`, error);
        }
      },
    }), [currentTab, currentUserId, groupId, singleImageTaskId]);

    // ── Load user / docs / storage ────────────────────────────────────────────
    useEffect(() => {
      const loadUser = async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        setCurrentUserId(user.id);

        const { data: planData } = await supabase
          .from('user_plans')
          .select('tokens_used, plan_type, rollover_tokens')
          .eq('user_id', user.id)
          .maybeSingle();

        if (planData) {
          const planType = planData.plan_type ?? 'free';
          const max = getPlanMaxTokens(planType, isLegacy);
          setUserTokenBalance(Math.max(0, max - (planData.tokens_used ?? 0) + (planData.rollover_tokens ?? 0)));
          setUserPlan(planType);
        }
        setPlanLoaded(true);

        const { data: docs } = await supabase
          .from('story_documents')
          .select('id,title,description,is_corrected,version,group_id,created_at,file_path,word_count,file_size')
          .eq('user_id', user.id)
          .in('version', [1, 2])
          .order('created_at', { ascending: false });
        setDocuments(docs ?? []);

        const { data: storageData } = await supabase
          .from('story_documents')
          .select('file_size, word_count')
          .eq('user_id', user.id);
        if (storageData) {
          const totalBytes = storageData.reduce((sum, d) => {
            if (d.file_size != null && d.file_size > 0) return sum + d.file_size;
            return sum + (d.word_count ?? 0) * 1.5;
          }, 0);
          const totalSizeMB = totalBytes / (1024 * 1024);
          setStorageUsed(totalSizeMB > 0 && totalSizeMB < 0.05 ? 0.1 : Number(totalSizeMB.toFixed(totalSizeMB < 1 ? 1 : 2)));
        }
      };
      loadUser();
    }, []);

    // ── Load audio files ──────────────────────────────────────────────────────
    useEffect(() => {
      const doc = documents.find(d => d.id === selectedDoc);
      const docGroupId = doc?.group_id;
      if (!currentUserId || !docGroupId) {
        setAudioFiles([]);
        setLoadingAudioFiles(false);
        return;
      }
      setLoadingAudioFiles(true);
      const load = async () => {
        try {
          const { data: audioDocs, error } = await supabase
            .from('story_documents')
            .select('id,title,file_path,audio_duration')
            .eq('user_id', currentUserId)
            .eq('group_id', docGroupId)
            .in('version', [7, 8, 9, 10])
            .order('created_at', { ascending: false });
          if (!error && audioDocs) {
            const files: AudioFile[] = audioDocs.map(ad => ({
              path: ad.file_path,
              name: ad.title || ad.file_path.split('/').pop() || 'Audio File',
              duration: ad.audio_duration || 0,
            }));
            setAudioFiles(files);
          } else {
            setAudioFiles([]);
          }
        } catch { /* silent */ }
        finally { setLoadingAudioFiles(false); }
      };
      load();
    }, [currentUserId, selectedDoc, documents]);

    // ── Recompute estimate ────────────────────────────────────────────────────
    useEffect(() => {
      const audioDur = totalAudioDuration;
      if (audioDur <= 0 || !videoModel) { setEstimate(null); return; }
      const modelCfg = ITV_VIDEO_MODEL_OPTIONS.find(m => m.value === videoModel);
      const effectiveDuration =
        !modelCfg ? videoDuration :
        modelCfg.durationType === 'fixed' ? modelCfg.defaultDuration :
        videoDuration;
      if (effectiveDuration <= 0) { setEstimate(null); return; }
      const est = computeITVEstimate(
        audioDur, effectiveDuration, videoModel, imageModel, promptModel, useCharacterDescriptions, useAudioClip,
        PROMPT_MODEL_MULTIPLIER, IMAGE_TOKENS_PER_IMAGE, ITV_TOKENS_PER_SECOND, ITV_AUDIO_TOKENS_PER_SECOND,
      );
      setEstimate(est);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedDoc, uploadedDoc, videoModel, videoDuration, imageModel, promptModel, useCharacterDescriptions, totalAudioDuration, useAudioClip]);

    // ── Load generated videos on complete ─────────────────────────────────────
    useEffect(() => {
      if (generationState === 'complete' && groupId && currentUserId) {
        loadGeneratedVideos(groupId);
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [generationState, groupId, currentUserId]);

    // Redo polling: watches redoingVideo, polls ITV_tasks.redo_status every 8s
    useEffect(() => {
      if (!redoingVideo || !groupId || !currentUserId) return;
      // Local flag: tracks whether we've seen redo_status='redoing' in this polling session.
      // More robust than the shared ref — handles edge cases where the first poll fires before
      // the backend sets 'redoing', or where JSONB is returned as a string.
      let hasSeenRedoing = false;
      const poll = async () => {
        try {
          const { data: task } = await supabase
            .from('ITV_tasks')
            .select('redo_status, video_url')
            .eq('user_id', currentUserId)
            .eq('group_id', groupId)
            .eq('tab', currentTab)
            .eq('batch_number', redoingVideo)
            .maybeSingle();
          if (!task) return;
          // Parse redo_status: JSONB can come back as an object or, in edge cases, as a string
          let redoStatus: { status: string; mode: string } | null = null;
          const rawStatus = task.redo_status;
          if (rawStatus != null) {
            redoStatus = typeof rawStatus === 'string'
              ? (() => { try { return JSON.parse(rawStatus); } catch { return null; } })()
              : (rawStatus as { status: string; mode: string });
          }
          if (redoStatus?.status === 'redoing') {
            hasSeenRedoing = true;
            redoPhaseRef.current = 'running';
            if (redoStatus.mode) setRedoingMode(redoStatus.mode as 'image_and_video' | 'video_only');
          } else if (redoStatus?.status === 'failed') {
            setRedoingVideo(null);
            setRedoingMode(null);
          } else if (!redoStatus && (hasSeenRedoing || redoPhaseRef.current === 'running')) {
            // redo_status cleared → redo completed
            if (task.video_url) {
              const { data } = await supabase.storage.from('stories').createSignedUrl(task.video_url, 3600);
              if (data?.signedUrl) {
                setGeneratedVideos(prev => {
                  const next = [...prev];
                  next[redoingVideo - 1] = data.signedUrl;
                  return next;
                });
              }
            }
            setRedoingVideo(null);
            setRedoingMode(null);
          }
        } catch { /* retry */ }
      };
      poll();
      const interval = setInterval(poll, 8000);
      return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [redoingVideo, groupId, currentUserId]);

    // ── Single-ITV polling ────────────────────────────────────────────────────
    useEffect(() => {
      if (!singleITVTaskId || !currentUserId || singleGenState === 'complete' || singleGenState === 'error') return;

      const poll = async () => {
        try {
          const { data: task } = await supabase
            .from('ITV_tasks')
            .select('id, status, video_url, image_url, error')
            .eq('id', singleITVTaskId)
            .maybeSingle();

          if (!task) return;

          if (task.status === 'completed_final') {
            if (task.video_url) {
              const { data } = await supabase.storage
                .from('stories')
                .createSignedUrl(task.video_url, 3600);
              if (data?.signedUrl) setSingleVideoUrl(data.signedUrl);
            }
            setSingleGenState('complete');
            setSingleGenPhase(null);
            try {
              await updateTabStatus(currentUserId, 'itv', currentTab, 'complete', singleITVTaskId);
            } catch (_) { /* non-fatal */ }
            return;
          }

          if (task.status === 'error') {
            setSingleGenState('error');
            setSingleError((task as any).error || 'Video generation failed. Please try again.');
            setSingleGenPhase(null);
            return;
          }

          // Update phase indicator
          setSingleGenPhase(!task.image_url ? 'image' : 'video');
        } catch { /* retry next tick */ }
      };

      poll();
      const interval = setInterval(poll, 10_000);
      return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [singleITVTaskId, currentUserId, singleGenState]);

    // ── Derived helpers ───────────────────────────────────────────────────────
    const getSelectedDocument = (): StoryDocument | undefined => {
      if (selectedDoc) return documents.find(d => d.id === selectedDoc);
      if (uploadedDoc) {
        const name = uploadedDoc.name.replace(/\.txt$/, '');
        return documents.find(d => d.title === name);
      }
      return undefined;
    };

    const getEffectiveDuration = (): number => {
      const modelCfg = ITV_VIDEO_MODEL_OPTIONS.find(m => m.value === videoModel);
      if (!modelCfg) return videoDuration;
      if (modelCfg.durationType === 'fixed') return modelCfg.defaultDuration;
      return videoDuration;
    };

    // ── Load generated video clips ────────────────────────────────────────────
    const loadGeneratedVideos = async (gid: string) => {
      if (!currentUserId || !gid) return;
      try {
        const { data: tasks } = await supabase
          .from('ITV_tasks')
          .select('id,batch_number,story_title,folder_timestamp,video_model,video_duration,video_url,status,group_id,user_id,tab,image_model,image_number,audio_clip,redo_status,redo_started_at')
          .eq('user_id', currentUserId)
          .eq('group_id', gid)
          .eq('tab', currentTab)
          .in('status', ['completed', 'completed_final'])
          .order('batch_number', { ascending: true });

        if (!tasks || tasks.length === 0) return;

        const signedUrls = await Promise.all(
          tasks.map(async (task) => {
            if (!task.video_url) return '';
            const { data, error } = await supabase.storage
              .from('stories')
              .createSignedUrl(task.video_url, 3600);
            if (error || !data) return '';
            return data.signedUrl;
          }),
        );
        setGeneratedVideos(signedUrls);
        setGeneratedVideoTasks(tasks.map(task => ({
          id: task.id,
          batchNumber: task.batch_number,
          videoModel: task.video_model ?? '',
          videoDuration: task.video_duration ?? 5,
          audioClip: task.audio_clip ?? false,
          imageModel: task.image_model ?? '',
          imageNumber: task.image_number ?? null,
        })));

        // Set story title from tasks if not already known
        const storyTitleFromTask = (tasks[0] as any).story_title;
        if (storyTitleFromTask) setGenerationTitle(storyTitleFromTask);

        // Resume detection: if any task is mid-redo, restore the redo state
        // Parse redo_status safely (JSONB may arrive as object or string)
        const parseRedoStatus = (raw: any): { status: string; mode: string } | null => {
          if (raw == null) return null;
          if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
          return raw as { status: string; mode: string };
        };
        const redoingTask = tasks.find(t => parseRedoStatus(t.redo_status)?.status === 'redoing');
        if (redoingTask) {
          setRedoingVideo(redoingTask.batch_number);
          const parsedMode = parseRedoStatus(redoingTask.redo_status)?.mode;
          setRedoingMode((parsedMode === 'image_and_video' ? 'image_and_video' : 'video_only'));
          setShowVideos(true);
          redoPhaseRef.current = 'running';
        }
      } catch (err) {
        console.error('[ITV] loadGeneratedVideos error:', err);
      }
    };

    // ── Audio duration calculation ────────────────────────────────────────────
    const handleCalculateAudioDuration = async (path?: string) => {
      const targetPath = path ?? selectedAudioPath;
      if (!targetPath) return;
      setCalculatingDuration(true);
      setAudioDurationError(null);
      try {
        const fileName = targetPath.split('/').pop() || 'audio';
        const { data: { session: _itvSession } } = await supabase.auth.getSession();
        const response = await fetchWithFallback('https://calculate-audio-duration.storyscriptai.deno.net', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_itvSession?.access_token || ''}`,
            'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ files: [{ path: targetPath, name: fileName }] }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        const duration = result.totalDuration ?? result.duration_seconds;
        if (typeof duration === 'number' && duration > 0) {
          setTotalAudioDuration(duration);
        } else {
          throw new Error('Could not determine audio duration');
        }
      } catch (err: any) {
        setAudioDurationError(err.message || 'Failed to calculate duration');
      } finally {
        setCalculatingDuration(false);
      }
    };

    // ── Audio file upload ─────────────────────────────────────────────────────
    const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !currentUserId) return;
      const docId = selectedDoc || uploadedDocId;
      const doc = documents.find(d => d.id === docId);
      const docGroupId = doc?.group_id;
      if (!docGroupId) return;

      const audioExtensions = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.wma'];
      const fileExt = '.' + (file.name.split('.').pop()?.toLowerCase() ?? '');
      if (!audioExtensions.includes(fileExt)) {
        setAudioDurationError(`Unsupported format "${fileExt}". Accepted: ${audioExtensions.join(', ')}`);
        if (audioUploadRef.current) audioUploadRef.current.value = '';
        return;
      }
      if (file.size > 500 * 1024 * 1024) {
        setAudioDurationError('File exceeds the 500 MB limit');
        if (audioUploadRef.current) audioUploadRef.current.value = '';
        return;
      }

      setUploadingAudio(true);
      setUploadProgress(0);
      setAudioDurationError(null);

      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const sanitized = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const filePath = `documents/${currentUserId}/${docGroupId}/audio_${timestamp}_${sanitized}`;

        const result = await uploadWithTus({
          file, bucket: 'stories', path: filePath,
          onProgress: (bytesUploaded, bytesTotal) => { setUploadProgress(Math.round((bytesUploaded / bytesTotal) * 100)); },
          contentType: file.type || 'audio/mpeg',
        });
        if (!result.success) throw new Error(result.error || 'Upload failed');

        await supabase.from('story_documents').insert({
          id: uuidv4(), user_id: currentUserId, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          file_path: filePath, title: sanitized.replace(/\.(mp3|wav|flac|m4a|aac|ogg|wma)$/i, ''),
          description: 'Uploaded audio file for ITV generation', word_count: 0, version: 7, is_corrected: false,
          is_prompted: false, group_id: docGroupId, variant: 1, file_size: file.size,
        });

        const { data: audioDocs } = await supabase
          .from('story_documents')
          .select('id,title,file_path,audio_duration')
          .eq('user_id', currentUserId)
          .eq('group_id', docGroupId)
          .in('version', [7, 8, 9, 10])
          .order('created_at', { ascending: false });
        if (audioDocs) {
          setAudioFiles(audioDocs.map(ad => ({
            path: ad.file_path, name: ad.title || ad.file_path.split('/').pop() || 'Audio File', duration: ad.audio_duration || 0,
          })));
        }
        setSelectedAudioPath(filePath);
        setTotalAudioDuration(0);
        await handleCalculateAudioDuration(filePath);
      } catch (err: any) {
        setAudioDurationError(err.message || 'Upload failed');
      } finally {
        setUploadingAudio(false);
        setUploadProgress(0);
        if (audioUploadRef.current) audioUploadRef.current.value = '';
      }
    };

    // ── Document file upload ──────────────────────────────────────────────────
    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !currentUserId) return;
      setSelectedDoc('');
      setUploadError(null);
      if (file.type !== 'text/plain' && !file.name.endsWith('.txt')) { setUploadError('Please upload a .txt file'); return; }
      const nameErr = validateFileName(file.name);
      if (nameErr) { setUploadError(nameErr); return; }
      if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) { setUploadError(`Max file size is ${MAX_FILE_SIZE_MB} MB`); return; }
      setUploadingFile(true);
      try {
        const content = await file.text();
        const wc = content.trim().split(/\s+/).filter(w => w.length > 0).length;
        if (wc > MAX_WORD_COUNT) throw new Error(`Exceeds ${MAX_WORD_COUNT} word limit (${wc} words)`);
        const gid = uuidv4();
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const fname = `${file.name.replace(/\s+/g, '-')}_${ts}.txt`;
        const fpath = `documents/${currentUserId}/${gid}/${fname}`;
        const { error: upErr } = await supabase.storage.from('stories').upload(fpath, file, { contentType: 'text/plain', upsert: true });
        if (upErr) throw upErr;
        const { data: doc, error: insErr } = await supabase
          .from('story_documents')
          .insert({
            id: uuidv4(), user_id: currentUserId, file_path: fpath,
            title: file.name.replace(/\.txt$/, ''),
            description: 'Uploaded document for ITV generation',
            word_count: wc, version: 1, is_corrected: false,
            is_prompted: false, group_id: gid, variant: 1, file_size: file.size,
          })
          .select().single();
        if (insErr) { await supabase.storage.from('stories').remove([fpath]); throw insErr; }
        setUploadedDoc(file);
        setUploadedDocId(doc!.id);
        setDocuments(prev => [doc!, ...prev]);
      } catch (err: any) {
        setUploadError(err.message || 'Upload failed');
      } finally {
        setUploadingFile(false);
      }
    };

    // ── Polling (4-phase) ─────────────────────────────────────────────────────
    const startPolling = (gid: string, variant: number) => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      stoppedRef.current = false;

      // Phase 1: Image prompts (ITV_prompt_tasks WHERE itv = false)
      const pollPhase1 = async () => {
        if (stoppedRef.current) return;
        try {
          const { data: tasks } = await supabase
            .from('ITV_prompt_tasks')
            .select('batch_number,total_batches,status,error,total_prompts,story_title,check_stuck')
            .eq('user_id', currentUserId!)
            .eq('group_id', gid)
            .eq('tab', currentTab)
            .eq('variant', variant)
            .eq('itv', false)
            .or('video_process.is.null,video_process.eq.false');
          if (!tasks || tasks.length === 0) return;
          const total = tasks[0].total_batches ?? tasks.length;
          const done = tasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
          const errTask = tasks.find(t => t.status === 'error');
          if (errTask) {
            setError(errTask.error || 'Image prompt generation failed');
            setGenerationState('error');
            if (pollingRef.current) clearInterval(pollingRef.current);
            return;
          }
          const title = (tasks[0] as any).story_title;
          if (title) setGenerationTitle(title);
          setStuckWarning(tasks.some(t => t.status === 'running' && (t as any).check_stuck === true));
          setPhaseOneProgress(total > 0 ? Math.min(100, (done / total) * 100) : 0);
          setStatusMessage(`Phase 1 — Generating image prompts: ${done} / ${total} batches`);

          // Time estimate: remaining P1 batches + max(P2 images, P3 video prompts) + P4 videos
          // P2 and P3 run concurrently in the backend, so only the slower one adds to total time.
          const remainingP1 = (total - done) * SECONDS_PER_PROMPT_BATCH;
          const totalClips = (tasks[0] as any).total_prompts ?? 0;
          const imgSecs = IMAGE_SECONDS_PER_IMAGE[imageModel] ?? IMAGE_DEFAULT_SECONDS_PER_IMAGE;
          const futureP2 = totalClips * imgSecs;
          const futureP3Batches = Math.ceil(totalClips / 2);
          const futureP3 = futureP3Batches * SECONDS_PER_PROMPT_BATCH;
          const secsPerVid = ITV_SECONDS_PER_VIDEO[videoModel] ?? ITV_DEFAULT_SECONDS_PER_VIDEO;
          const futureP4 = totalClips * secsPerVid;
          setTimeRemaining(remainingP1 + Math.max(futureP2, futureP3) + futureP4);

          if (tasks.every(t => t.status === 'completed' || t.status === 'completed_final')) {
            setCurrentPhase('keyframeImages');
            setStatusMessage('Image prompts complete — generating keyframe images…');
            if (pollingRef.current) clearInterval(pollingRef.current);
            pollingRef.current = setInterval(pollPhase2, POLLING_INTERVAL_P2);
            pollPhase2();
          }
        } catch { /* retry */ }
      };

      // Phase 2: Keyframe images (image_tasks WHERE itv = true)
      // Phase 3 (video prompts) runs concurrently — poll both and show progress simultaneously.
      const pollPhase2 = async () => {
        if (stoppedRef.current) return;
        try {
          const [{ data: tasks }, { data: p3Tasks }] = await Promise.all([
            supabase
              .from('image_tasks')
              .select('batch_number,total_batches,total_prompts,status,error,check_stuck')
              .eq('user_id', currentUserId!)
              .eq('group_id', gid)
              .eq('tab', currentTab)
              .eq('itv', true)
              .or('video_process.is.null,video_process.eq.false'),
            supabase
              .from('ITV_prompt_tasks')
              .select('batch_number,total_batches,status')
              .eq('user_id', currentUserId!)
              .eq('group_id', gid)
              .eq('tab', currentTab)
              .eq('variant', variant)
              .eq('itv', true)
              .or('video_process.is.null,video_process.eq.false'),
          ]);
          if (!tasks || tasks.length === 0) { setStatusMessage('Keyframe image generation queued — waiting…'); return; }
          const total = tasks[0].total_batches ?? tasks.length;
          const done = tasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
          const errTask = tasks.find(t => t.status === 'error');
          if (errTask) {
            setError(errTask.error || 'Keyframe image generation failed');
            setGenerationState('error');
            if (pollingRef.current) clearInterval(pollingRef.current);
            return;
          }
          setStuckWarning(tasks.some(t => t.status === 'running' && (t as any).check_stuck === true));
          setPhaseTwoProgress(total > 0 ? Math.min(100, (done / total) * 100) : 0);
          setStatusMessage(`Phase 2 — Generating keyframe images: ${done} / ${total} complete`);

          // Update Phase 3 progress concurrently
          const p3Total = p3Tasks && p3Tasks.length > 0 ? (p3Tasks[0].total_batches ?? p3Tasks.length) : 0;
          const p3Done = p3Tasks ? p3Tasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length : 0;
          if (p3Total > 0) setPhaseThreeProgress(Math.min(100, (p3Done / p3Total) * 100));

          // Time estimate: max(remaining images, remaining video prompts) + P4 videos
          const totalClips = (tasks[0] as any).total_prompts ?? total;
          const imgSecs = IMAGE_SECONDS_PER_IMAGE[imageModel] ?? IMAGE_DEFAULT_SECONDS_PER_IMAGE;
          const remainingP2 = (total - done) * imgSecs;
          const remainingP3 = p3Total > 0
            ? (p3Total - p3Done) * SECONDS_PER_PROMPT_BATCH
            : Math.ceil(totalClips / 2) * SECONDS_PER_PROMPT_BATCH;
          const secsPerVid = ITV_SECONDS_PER_VIDEO[videoModel] ?? ITV_DEFAULT_SECONDS_PER_VIDEO;
          const futureP4 = totalClips * secsPerVid;
          setTimeRemaining(Math.max(remainingP2, remainingP3) + futureP4);

          if (tasks.every(t => t.status === 'completed' || t.status === 'completed_final')) {
            const p3AllDone = p3Tasks && p3Tasks.length > 0 &&
              p3Tasks.every(t => t.status === 'completed' || t.status === 'completed_final');
            if (p3AllDone) {
              setPhaseThreeProgress(100);
              setCurrentPhase('videoGeneration');
              setStatusMessage('Keyframe images & video prompts complete — generating videos…');
              if (pollingRef.current) clearInterval(pollingRef.current);
              pollingRef.current = setInterval(pollPhase4, POLLING_INTERVAL_P4);
              pollPhase4();
            } else {
              setCurrentPhase('videoPrompts');
              setStatusMessage('Keyframe images complete — finishing video prompts…');
              if (pollingRef.current) clearInterval(pollingRef.current);
              pollingRef.current = setInterval(pollPhase3, POLLING_INTERVAL_P3);
              pollPhase3();
            }
          }
        } catch { /* retry */ }
      };

      // Phase 3: Video prompts (ITV_prompt_tasks WHERE itv = true)
      const pollPhase3 = async () => {
        if (stoppedRef.current) return;
        try {
          const { data: tasks } = await supabase
            .from('ITV_prompt_tasks')
            .select('batch_number,total_batches,total_prompts,status,error,check_stuck')
            .eq('user_id', currentUserId!)
            .eq('group_id', gid)
            .eq('tab', currentTab)
            .eq('variant', variant)
            .eq('itv', true)
            .or('video_process.is.null,video_process.eq.false');
          if (!tasks || tasks.length === 0) { setStatusMessage('Video prompt generation queued — waiting…'); return; }
          const total = tasks[0].total_batches ?? tasks.length;
          const done = tasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
          const errTask = tasks.find(t => t.status === 'error');
          if (errTask) {
            setError(errTask.error || 'Video prompt generation failed');
            setGenerationState('error');
            if (pollingRef.current) clearInterval(pollingRef.current);
            return;
          }
          setStuckWarning(tasks.some(t => t.status === 'running' && (t as any).check_stuck === true));
          setPhaseThreeProgress(total > 0 ? Math.min(100, (done / total) * 100) : 0);
          setStatusMessage(`Phase 3 — Generating video prompts: ${done} / ${total} batches`);

          // Time estimate: remaining P3 batches + future P4 videos
          const totalClips = (tasks[0] as any).total_prompts ?? 0;
          const remainingP3 = (total - done) * SECONDS_PER_PROMPT_BATCH;
          const secsPerVid = ITV_SECONDS_PER_VIDEO[videoModel] ?? ITV_DEFAULT_SECONDS_PER_VIDEO;
          const futureP4 = totalClips * secsPerVid;
          setTimeRemaining(remainingP3 + futureP4);

          if (tasks.every(t => t.status === 'completed' || t.status === 'completed_final')) {
            setCurrentPhase('videoGeneration');
            setStatusMessage('Video prompts complete — generating videos…');
            if (pollingRef.current) clearInterval(pollingRef.current);
            pollingRef.current = setInterval(pollPhase4, POLLING_INTERVAL_P4);
            pollPhase4();
          }
        } catch { /* retry */ }
      };

      // Phase 4: Video generation (ITV_tasks)
      const pollPhase4 = async () => {
        if (stoppedRef.current) return;
        try {
          const { data: tasks } = await supabase
            .from('ITV_tasks')
            .select('batch_number,total_batches,status,error,check_stuck')
            .eq('user_id', currentUserId!)
            .eq('group_id', gid)
            .eq('tab', currentTab)
            .or('video_process.is.null,video_process.eq.false');
          if (!tasks || tasks.length === 0) { setStatusMessage('Video generation queued — waiting…'); return; }
          const total = tasks[0].total_batches ?? tasks.length;
          const done = tasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
          const errTask = tasks.find(t => t.status === 'error');
          if (errTask) {
            setError(errTask.error || 'Video generation failed');
            setGenerationState('error');
            if (pollingRef.current) clearInterval(pollingRef.current);
            return;
          }
          setStuckWarning(tasks.some(t => t.status === 'running' && (t as any).check_stuck === true));
          setPhaseFourProgress(total > 0 ? Math.min(100, (done / total) * 100) : 0);
          setStatusMessage(`Phase 4 — Generating videos: ${done} / ${total} complete`);
          const secsPerVideo = ITV_SECONDS_PER_VIDEO[videoModel] ?? ITV_DEFAULT_SECONDS_PER_VIDEO;
          setTimeRemaining((total - done) * secsPerVideo);

          if (tasks.length > 0 && tasks.every(t => t.status === 'completed_final')) {
            setGenerationState('complete');
            setCurrentPhase('complete');
            setPhaseFourProgress(100);
            setTimeRemaining(0);
            setStatusMessage('All videos generated successfully!');
            if (pollingRef.current) clearInterval(pollingRef.current);
            try {
              await updateTabStatus(currentUserId!, 'itv', currentTab, 'complete', gid);
            } catch (e) { console.error('[ITV] Failed to update tab status to complete:', e); }
          }
        } catch { /* retry */ }
      };

      pollingRef.current = setInterval(pollPhase1, POLLING_INTERVAL_P1);
    };

    // ── Resume detection on re-mount ──────────────────────────────────────────
    useEffect(() => {
      if (!currentUserId) return;
      const checkForActiveGeneration = async () => {
        try {
          // ── Check for an in-progress / completed single-ITV task ─────────────
          const { data: singleITVTask } = await supabase
            .from('ITV_tasks')
            .select('id, status, video_url, image_url, settings')
            .eq('user_id', currentUserId)
            .eq('tab', currentTab)
            .eq('single_itv', true)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (singleITVTask) {
            const settings = singleITVTask.settings as any;
            if (singleITVTask.status === 'completed_final') {
              setSingleITVTaskId(singleITVTask.id);
              if (settings?.image_task_id) setSingleImageTaskId(settings.image_task_id);
              if (singleITVTask.video_url) {
                const { data } = await supabase.storage
                  .from('stories')
                  .createSignedUrl(singleITVTask.video_url, 3600);
                if (data?.signedUrl) setSingleVideoUrl(data.signedUrl);
              }
              setSingleGenState('complete');
              setInputMode('prompt');
              return; // no need to check document-generation tasks
            } else if (singleITVTask.status === 'pending' || singleITVTask.status === 'running') {
              setSingleITVTaskId(singleITVTask.id);
              if (settings?.image_task_id) setSingleImageTaskId(settings.image_task_id);
              setSingleGenState('generating');
              setSingleGenPhase(!singleITVTask.image_url ? 'image' : 'video');
              setInputMode('prompt');
              return; // polling useEffect will take over
            }
          }

          // ── Check for regular document-based generation ───────────────────────
          const { data: tab } = await supabase
            .from('tabs')
            .select('group_id, status, title')
            .eq('user_id', currentUserId)
            .eq('page', 'itv')
            .eq('tab_number', currentTab)
            .in('status', ['generating', 'complete'])
            .maybeSingle();

          if (!tab?.group_id) return;

          // Restore the generation title from the tabs row
          if (tab.title) setGenerationTitle(tab.title);

          if (tab.status === 'complete') {
            setGroupId(tab.group_id);
            setCurrentPhase('complete');
            setGenerationState('complete');
            setPhaseFourProgress(100);
            setStatusMessage('All videos generated successfully!');
            return;
          }

          // Tab is 'generating' — determine which phase we're in
          const { data: promptTasksP1 } = await supabase
            .from('ITV_prompt_tasks')
            .select('variant, status')
            .eq('user_id', currentUserId)
            .eq('group_id', tab.group_id)
            .eq('tab', currentTab)
            .eq('itv', false)
            .or('video_process.is.null,video_process.eq.false');

          if (!promptTasksP1 || promptTasksP1.length === 0) return;
          const variant = promptTasksP1[0].variant ?? 1;
          setGroupId(tab.group_id);
          setCurrentVariant(variant);

          const allP1Done = promptTasksP1.every(t => t.status === 'completed' || t.status === 'completed_final');

          if (!allP1Done) {
            setCurrentPhase('imagePrompts');
            setGenerationState('generating');
            setStatusMessage('Resuming — generating image prompts…');
            startPolling(tab.group_id, variant);
            return;
          }

          // Check phase 2 (image_tasks)
          const { data: imageTasks } = await supabase
            .from('image_tasks')
            .select('status')
            .eq('user_id', currentUserId)
            .eq('group_id', tab.group_id)
            .eq('tab', currentTab)
            .eq('itv', true)
            .or('video_process.is.null,video_process.eq.false');

          const allP2Done = imageTasks && imageTasks.length > 0 && imageTasks.every(t => t.status === 'completed' || t.status === 'completed_final');

          if (!allP2Done) {
            setCurrentPhase('keyframeImages');
            setGenerationState('generating');
            setStatusMessage('Resuming — generating keyframe images…');
            startPolling(tab.group_id, variant);
            return;
          }

          // Check phase 3 (ITV_prompt_tasks itv=true)
          const { data: promptTasksP3 } = await supabase
            .from('ITV_prompt_tasks')
            .select('status')
            .eq('user_id', currentUserId)
            .eq('group_id', tab.group_id)
            .eq('tab', currentTab)
            .eq('itv', true)
            .or('video_process.is.null,video_process.eq.false');

          const allP3Done = promptTasksP3 && promptTasksP3.length > 0 && promptTasksP3.every(t => t.status === 'completed' || t.status === 'completed_final');

          if (!allP3Done) {
            setCurrentPhase('videoPrompts');
            setGenerationState('generating');
            setStatusMessage('Resuming — generating video prompts…');
            startPolling(tab.group_id, variant);
            return;
          }

          // Check phase 4 (ITV_tasks)
          const { data: videoTasks } = await supabase
            .from('ITV_tasks')
            .select('status')
            .eq('user_id', currentUserId)
            .eq('group_id', tab.group_id)
            .eq('tab', currentTab)
            .or('video_process.is.null,video_process.eq.false');

          if (videoTasks && videoTasks.length > 0 && videoTasks.every(t => t.status === 'completed_final')) {
            setCurrentPhase('complete');
            setGenerationState('complete');
            setPhaseFourProgress(100);
            setStatusMessage('All videos generated successfully!');
            try {
              await updateTabStatus(currentUserId!, 'itv', currentTab, 'complete', tab.group_id);
            } catch (e) { console.error('[ITV] Failed to update tab status to complete on resume:', e); }
            return;
          }

          setCurrentPhase('videoGeneration');
          setGenerationState('generating');
          setStatusMessage('Resuming — generating videos…');
          startPolling(tab.group_id, variant);
        } catch (err) {
          console.error('[ITV] Resume detection error:', err);
        }
      };
      checkForActiveGeneration().finally(() => setResumeChecked(true));
    }, [currentUserId]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Stop generation ───────────────────────────────────────────────────────
    const handleStop = async () => {
      if (!groupId || !currentUserId) return;
      setStopRequested(true);
      stoppedRef.current = true;
      if (pollingRef.current) clearInterval(pollingRef.current);
      try {
        await supabase.from('ITV_prompt_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);
        await supabase.from('ITV_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);
        await supabase.from('image_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab).eq('itv', true);

        await supabase.from('ITV_tasks').delete().eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);
        await supabase.from('ITV_prompt_tasks').delete().eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);
        await supabase.from('ITV_prompt_context').delete().eq('group_id', groupId).eq('tab', currentTab);
        await supabase.from('image_tasks').delete().eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab).eq('itv', true);

        await supabase.from('tabs').update({ status: 'idle', updated_at: new Date().toISOString() })
          .eq('user_id', currentUserId).eq('page', 'itv').eq('tab_number', currentTab);
      } catch (err) { console.error('Stop cleanup error:', err); }

      setGenerationState('idle');
      setCurrentPhase('imagePrompts');
      setPhaseOneProgress(0);
      setPhaseTwoProgress(0);
      setPhaseThreeProgress(0);
      setPhaseFourProgress(0);
      setTimeRemaining(null);
      setGroupId(null);
      setCurrentVariant(null);
      setStatusMessage('');
      setStopRequested(false);
    };

    // ── Generate ──────────────────────────────────────────────────────────────
    const handleGenerate = async () => {
      const doc = getSelectedDocument();
      if (!doc) { setError('Please select a document'); return; }
      if (!videoModel) { setError('Please select a video model'); return; }
      if (!imageModel) { setError('Please select an image model'); return; }
      if (!imageStyle) { setError('Please select an image style'); return; }
      if (!estimate) { setError('Could not compute estimate — check your settings'); return; }
      if (estimate.totalTokens > userTokenBalance) {
        setError(`Insufficient tokens. Required: ${formatNumber(estimate.totalTokens)}, Available: ${formatNumber(userTokenBalance)}`);
        return;
      }
      if (storageUsed !== null && estimate.storageNeededMB > (maxStorageGB * 1024) - storageUsed) {
        setError(`Insufficient storage. Required: ${formatStorageSize(estimate.storageNeededMB)}, Available: ${formatStorageSize((maxStorageGB * 1024) - storageUsed)}`);
        return;
      }
      setError(null);
      setGenerationState('generating');
      setCurrentPhase('imagePrompts');
      setPhaseOneProgress(0);
      setPhaseTwoProgress(0);
      setPhaseThreeProgress(0);
      setPhaseFourProgress(0);
      setStatusMessage('Preparing ITV generation…');
      try {
        const { data: { user } } = await withTimeout(supabase.auth.getUser(), OPERATION_TIMEOUT, 'getUser');
        if (!user) throw new Error('Not authenticated');
        const gid = doc.group_id || uuidv4();
        setGroupId(gid);
        let variant = 1;
        const { data: existingDocs } = await supabase
          .from('story_documents')
          .select('variant')
          .eq('group_id', gid)
          .eq('user_id', user.id)
          .in('version', [12, 13, 14, 15])
          .order('variant', { ascending: false });
        if (existingDocs && existingDocs.length > 0) {
          variant = Math.max(...existingDocs.map(d => d.variant || 0)) + 1;
        }
        setCurrentVariant(variant);
        await ensureTabExists(user.id, 'itv');
        await updateTabStatus(user.id, 'itv', currentTab, 'generating', gid, doc.title);
        const effectiveAudioDuration = totalAudioDuration;
        if (effectiveAudioDuration <= 0) throw new Error('Cannot determine story duration.');

        // Append ITV keyframe hint to style
        const itvStyle = imageStyle.includes('keyframe')
          ? imageStyle
          : `${imageStyle} Each image is a keyframe for an image-to-video clip, so compose each scene to suggest natural motion potential and cinematic depth.`;

        const { data: { session: _itvSession } } = await supabase.auth.getSession();
        const response = await withTimeout(
          fetchWithFallback('https://setup-itv-prompts.storyscriptai.deno.net', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${_itvSession?.access_token || ''}`,
              'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
            },
            body: JSON.stringify({
              user_id: user.id,
              group_id: gid,
              file_path: doc.file_path,
              story_title: doc.title,
              description: doc.description || doc.title,
              video_model: videoModel,
              totalAudioDuration: effectiveAudioDuration,
              image_model: IMAGE_MODEL_BACKEND[imageModel] ?? imageModel,
              model: promptModel,
              language,
              tab: currentTab,
              variant,
              audio_clip: useAudioClip,
              useCharacterDescriptions,
              customCharactersEnabled,
              customCharacters: customCharactersEnabled ? customCharacters.filter(c => c.name.trim()) : [],
              customCharactersAIEnhance,
              userTokenBalance,
              style: itvStyle,
            }),
          }).then(async res => {
            if (!res.ok) {
              const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
              throw new Error(err.error || `HTTP ${res.status}`);
            }
            return res.json();
          }),
          180000,
          'setupITVPrompts',
        );
        if (response.error) throw new Error(response.error);
        setStatusMessage(`Setup complete — generating image prompts…`);
        startPolling(gid, variant);
      } catch (err: any) {
        setError(err.message || 'An error occurred during generation');
        setGenerationState('error');
      }
    };

    // ── Done (clean up DB rows, keep files, reset state) ──────────────────────
    const handleDone = async () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      const doneGroupId = groupId;
      const doneUserId = currentUserId;

      setGenerationState('idle');
      setCurrentPhase('imagePrompts');
      setPhaseOneProgress(0);
      setPhaseTwoProgress(0);
      setPhaseThreeProgress(0);
      setPhaseFourProgress(0);
      setTimeRemaining(null);
      setStatusMessage('');
      setError(null);
      setGroupId(null);
      setCurrentVariant(null);
      setGeneratedVideos([]);
      setGeneratedVideoTasks([]);
      setRedoingVideo(null);
      setRedoingMode(null);
      setRedoModalOpen(false);
      setRedoModalBatchNum(null);
      setShowVideos(false);

      try {
        if (doneUserId && doneGroupId) {
          await supabase.from('ITV_tasks').delete().eq('user_id', doneUserId).eq('group_id', doneGroupId).eq('tab', currentTab);
          await supabase.from('ITV_prompt_tasks').delete().eq('user_id', doneUserId).eq('group_id', doneGroupId).eq('tab', currentTab);
          await supabase.from('ITV_prompt_context').delete().eq('group_id', doneGroupId).eq('tab', currentTab);
          await supabase.from('image_tasks').delete().eq('user_id', doneUserId).eq('group_id', doneGroupId).eq('tab', currentTab).eq('itv', true);
          await supabase.from('tabs').update({ status: 'idle', updated_at: new Date().toISOString() })
            .eq('user_id', doneUserId).eq('page', 'itv').eq('tab_number', currentTab);
        }
      } catch (err) { console.error('[ITV] Done cleanup error:', err); }
    };

    // ── Generate single ITV clip ──────────────────────────────────────────────
    const handleGenerateSingle = async () => {
      if (!singlePrompt.trim()) { setSingleError('Please enter a prompt'); return; }
      if (!imageModel) { setSingleError('Please select an image model'); return; }
      if (!videoModel) { setSingleError('Please select a video model'); return; }

      const imgTokens = IMAGE_TOKENS_PER_IMAGE[imageModel] ?? 14000;
      const effectiveDur = getEffectiveDuration();
      const tps = (useAudioClip && ITV_AUDIO_TOKENS_PER_SECOND[videoModel])
        ? ITV_AUDIO_TOKENS_PER_SECOND[videoModel]
        : (ITV_TOKENS_PER_SECOND[videoModel] ?? 6000);
      const videoTokens = Math.round(effectiveDur * tps);
      const totalTokens = imgTokens + videoTokens;

      if (totalTokens > userTokenBalance) {
        setSingleError(`Insufficient tokens. Required: ${formatNumber(totalTokens)}, Available: ${formatNumber(userTokenBalance)}`);
        return;
      }

      setSingleError(null);
      setSingleGenState('generating');
      setSingleGenPhase('image');

      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Not authenticated');

        const gid = uuidv4();
        await ensureTabExists(user.id, 'itv');
        await updateTabStatus(user.id, 'itv', currentTab, 'generating', gid, 'Single ITV Clip');

        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) throw new Error('Not authenticated');

        const response = await fetch(
          `${import.meta.env.SUPABASE_URL}/functions/v1/single-image`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
              user_id: user.id,
              prompt: singlePrompt.trim(),
              image_style: imageStyle || undefined,
              group_id: gid,
              story_title: singlePrompt.trim().slice(0, 60),
              image_model: IMAGE_MODEL_BACKEND[imageModel] ?? imageModel,
              tab: currentTab,
              itv: true,
              video_model: videoModel,
              video_duration: effectiveDur,
              audio_clip: useAudioClip,
            }),
          },
        );

        if (!response.ok) {
          const errData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
          throw new Error(errData.error || `HTTP ${response.status}`);
        }

        const result = await response.json();
        setSingleITVTaskId(result.task_id);
        setSingleImageTaskId(result.image_task_id ?? null);
        // Phase tracking is handled by the polling useEffect
      } catch (err: any) {
        setSingleError(err.message || 'Generation failed');
        setSingleGenState('error');
        setSingleGenPhase(null);
      }
    };

    // ── Done single ITV (cleanup DB rows + storage files) ────────────────────
    const handleDoneSingle = async () => {
      if (singleDoneLoading) return;
      setSingleDoneLoading(true);

      // Capture current IDs before resetting
      const doneITVTaskId = singleITVTaskId;
      const doneImageTaskId = singleImageTaskId;
      const doneUserId = currentUserId;

      // Reset all single-ITV state immediately
      setSingleGenState('idle');
      setSingleGenPhase(null);
      setSingleVideoUrl(null);
      setSingleITVTaskId(null);
      setSingleImageTaskId(null);
      setSingleError(null);

      try {
        if (!doneUserId) return;

        // Delete video file + ITV_tasks row
        if (doneITVTaskId) {
          const { data: itvTask } = await supabase
            .from('ITV_tasks')
            .select('video_url')
            .eq('id', doneITVTaskId)
            .maybeSingle();
          if (itvTask?.video_url) {
            await supabase.storage.from('stories').remove([itvTask.video_url]).catch(() => {});
          }
          await supabase.from('ITV_tasks').delete().eq('id', doneITVTaskId);
        }

        // Delete image file + image_tasks row
        if (doneImageTaskId) {
          const { data: imgTask } = await supabase
            .from('image_tasks')
            .select('batch_output')
            .eq('id', doneImageTaskId)
            .maybeSingle();
          if (imgTask?.batch_output) {
            // batch_output is like "Image 1 saved to: https://.../documents/<path>"
            const match = (imgTask.batch_output as string).match(/documents\/[^\s"']+/);
            if (match) {
              await supabase.storage.from('stories').remove([match[0]]).catch(() => {});
            }
          }
          await supabase.from('image_tasks').delete().eq('id', doneImageTaskId);
        }

        await updateTabStatus(doneUserId, 'itv', currentTab, 'idle');
      } catch (err) {
        console.error('[ITV] handleDoneSingle error:', err);
      } finally {
        setSingleDoneLoading(false);
      }
    };

    // ── Download all as ZIP ───────────────────────────────────────────────────
    const handleRedoClick = (batchNum: number) => {
      setRedoModalBatchNum(batchNum);
      setRedoModalFeedback('');
      setRedoModalOpen(true);
    };

    const handleRedoConfirm = async (option: 'image_and_video' | 'video_only', feedback = '') => {
      if (!redoModalBatchNum || !groupId || !currentUserId) return;
      setRedoModalOpen(false);
      setRedoingVideo(redoModalBatchNum);
      setRedoingMode(option);
      setShowVideos(true);
      redoPhaseRef.current = 'waiting';
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) throw new Error('Not authenticated');
        if (option === 'video_only') {
          await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/redo-ITV`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ group_id: groupId, batch_number: redoModalBatchNum, feedback }),
          });
          redoPhaseRef.current = 'running';
        } else {
          const taskInfo = generatedVideoTasks.find(t => t.batchNumber === redoModalBatchNum);
          if (taskInfo?.imageNumber != null) {
            await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/redo-image`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ user_id: currentUserId, group_id: groupId, batch_number: taskInfo.imageNumber, feedback }),
            });
          } else {
            await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/redo-ITV`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ group_id: groupId, batch_number: redoModalBatchNum, feedback }),
            });
            redoPhaseRef.current = 'running';
          }
        }
      } catch (err: any) {
        console.error('[ITV] Redo request failed:', err.message);
        setRedoingVideo(null);
      }
    };

    const handleDownloadAll = async () => {
      if (generatedVideos.every(v => !v)) return;
      setIsDownloadingZip(true);
      setZipDownloadProgress(0);
      try {
        const validEntries = generatedVideos.map((url, i) => ({ url, clipNum: i + 1 })).filter(e => !!e.url);
        if (validEntries.length === 0) throw new Error('No video clips could be downloaded');
        const zip = new JSZip();
        let filesAdded = 0;
        const N = validEntries.length;
        const clipShare = 80 / N;

        for (let i = 0; i < N; i++) {
          const { url, clipNum } = validEntries[i];
          const clipBase = i * clipShare;
          try {
            const response = await fetch(url!);
            if (!response.ok) continue;
            const blob = await response.blob();
            zip.file(`clip-${clipNum}.mp4`, blob);
            filesAdded++;
          } catch (err) { console.error(`Error fetching clip ${clipNum}:`, err); }
          setZipDownloadProgress(Math.round(clipBase + clipShare));
        }
        if (filesAdded === 0) throw new Error('No video clips could be downloaded');
        const zipBlob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
          setZipDownloadProgress(80 + Math.round(metadata.percent * 0.2));
        });
        let zipTitle = 'itv-videos';
        if (generationTitle) {
          const cleanTitle = generationTitle.replace(/^ITV Prompt[s]?:\s*/i, '').trim();
          zipTitle = `ITV Outputs: ${cleanTitle}`;
        }
        saveAs(zipBlob, `${zipTitle}.zip`);
      } catch (err: any) {
        console.error('[ITV] Error creating ZIP:', err);
        setError(err.message || 'Failed to download ZIP');
      } finally {
        setIsDownloadingZip(false);
        setZipDownloadProgress(0);
      }
    };

    // ── Derived values ────────────────────────────────────────────────────────
    const selectedDocument = getSelectedDocument();
    const effectiveDuration = getEffectiveDuration();
    const selectedModelCfg = ITV_VIDEO_MODEL_OPTIONS.find(m => m.value === videoModel);
    const isGenerating = generationState === 'generating';
    const isComplete = generationState === 'complete';
    const isSingleGenerating = singleGenState === 'generating';
    const isSingleComplete = singleGenState === 'complete';

    const canGenerate =
      !!selectedDocument &&
      !!videoModel &&
      !!imageModel &&
      !!imageStyle &&
      !!estimate &&
      estimate.totalTokens <= userTokenBalance &&
      (storageUsed === null || estimate.storageNeededMB <= (maxStorageGB * 1024) - storageUsed) &&
      totalAudioDuration > 0 &&
      !isGenerating;

    // Token cost estimate for the single-ITV prompt mode
    const singleEffectiveDuration = getEffectiveDuration();
    const singleImgTokens = IMAGE_TOKENS_PER_IMAGE[imageModel] ?? 14000;
    const singleVideoTPS = (useAudioClip && ITV_AUDIO_TOKENS_PER_SECOND[videoModel])
      ? ITV_AUDIO_TOKENS_PER_SECOND[videoModel]
      : (ITV_TOKENS_PER_SECOND[videoModel] ?? 6000);
    const singleVideoTokens = Math.round(singleEffectiveDuration * singleVideoTPS);
    const singleTotalTokens = singleImgTokens + singleVideoTokens;

    const canGenerateSingle =
      !!singlePrompt.trim() &&
      !!imageModel &&
      !!videoModel &&
      singleTotalTokens <= userTokenBalance &&
      singleGenState === 'idle';

    // ── Render ────────────────────────────────────────────────────────────────
    if (!planLoaded || !resumeChecked) {
      return (
        <DashboardLayout>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-center min-h-[400px]">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-red-500"></div>
            </div>
          </div>
        </DashboardLayout>
      );
    }

    return (
      <DashboardLayout>
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8" style={{ zoom: 1.1 }}>
          {/* Atmospheric gradient background */}
          <div className="pointer-events-none absolute inset-0 -top-20 overflow-hidden" aria-hidden="true">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120%] h-[500px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(220,38,38,0.14)_0%,transparent_70%)]" />
            <div className="absolute top-40 left-0 w-[40%] h-[300px] bg-[radial-gradient(ellipse_80%_80%_at_20%_50%,rgba(59,130,246,0.07)_0%,transparent_60%)]" />
            <div className="absolute top-60 right-0 w-[35%] h-[250px] bg-[radial-gradient(ellipse_80%_80%_at_80%_50%,rgba(34,197,94,0.06)_0%,transparent_60%)]" />
          </div>

          <div className={planLoaded && userPlan === 'free' ? 'relative' : ''}>

            {/* Free plan gate */}
            {planLoaded && userPlan === 'free' && (
              <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-12 z-50">
                <div className="rounded-2xl bg-surface-card border border-border-card p-8 max-w-md w-full shadow-[0_0_40px_rgba(220,38,38,0.08)]">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="pipeline-icon-circle inline-flex items-center justify-center w-10 h-10 rounded-full bg-accent/5">
                      <Lock className="h-5 w-5 text-accent-text" />
                    </div>
                    <h2 className="text-lg sm:text-xl font-display font-semibold text-white">Paid Feature</h2>
                  </div>
                  <p className="text-sm text-text-muted mb-6 leading-relaxed">Image-To-Video Generator requires a paid plan. Upgrade to unlock ITV generation and all tools.</p>
                  <button
                    onClick={() => navigate('/pricing')}
                    className="w-full flex justify-center items-center gap-2 px-6 py-3 bg-accent text-white rounded-xl hover:bg-accent-hover transition-all duration-200 text-sm font-medium hover:scale-[1.01] active:scale-[0.99]"
                  >
                    View Plans
                  </button>
                </div>
              </div>
            )}

            <div className={planLoaded && userPlan === 'free' ? 'opacity-50 pointer-events-none' : ''}>

              {/* Header */}
              <div className="relative mb-8 dash-animate-in">
                <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Image-To-Video Generator</h1>
                <div className="mt-2">
                  <p className="text-text-secondary">Transform your story into AI-generated keyframe images and animate them into video clips</p>
                  <p className="text-text-muted text-sm mt-1">{formatNumber(userTokenBalance)} tokens remaining</p>
                  <p className="text-text-muted text-sm mt-0.5">
                    Storage: {storageUsed !== null ? `${formatStorageSize(storageUsed)} / ${maxStorageGB} GB` : 'Calculating...'}
                  </p>
                </div>
              </div>

              {/* What to Expect */}
              <div className="mt-5 p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card mb-6 dash-animate-in">
                <h3 className="text-xl font-semibold mb-2 text-accent">What to Expect</h3>
                <p className="text-[15px] text-white/80 leading-relaxed">
                  The Image-To-Video Generator is a 4-phase pipeline: (1) Generate image prompts from your story, (2) Create keyframe images using your chosen image model & style, (3) Generate video prompts describing how each image should animate, (4) Produce the final video clips using your chosen ITV video model. Each clip is one scene from your story, ready to combine in the Video Combiner.
                </p>
                <Link
                  to="/learn#image-to-video"
                  className="group relative inline-flex items-center gap-1.5 px-5 py-2.5 mt-3 rounded-xl text-sm font-medium text-white bg-accent transition-all duration-300 hover:bg-accent-hover hover:scale-[1.02] active:scale-[0.98]"
                  style={{
                    boxShadow: '0 0 20px rgba(220,38,38,0.2), 0 0 40px rgba(220,38,38,0.06)',
                  }}
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  Watch tutorial
                </Link>
              </div>

              {/* Tab Manager (enterprise) */}
              {isEnterpriseUser && currentUserId && (
                <div className="mb-6 dash-animate-in">
                  <TabManager
                    userId={currentUserId}
                    isEnterpriseUser={isEnterpriseUser}
                    initialTabs={initialTabs}
                    currentTab={currentTab}
                    page="itv"
                    onTabChange={(tab) => onTabChange?.(tab, groupId ?? '')}
                    onTabCreate={(tab) => onTabCreate?.(tab, groupId ?? '')}
                    onTabClose={(tab) => onTabClose?.(tab, groupId ?? '')}
                  />
                </div>
              )}

              {/* Error banner (document mode) */}
              {error && (
                <div className="mb-4 flex items-start gap-2 bg-status-error/30 border border-status-error rounded-xl p-3 dash-animate-in">
                  <AlertCircle className="h-4 w-4 text-status-error mt-0.5 shrink-0" />
                  <p className="text-sm text-status-error flex-1">{error}</p>
                  <button onClick={() => setError(null)} className="text-status-error hover:text-status-error shrink-0"><X className="h-4 w-4" /></button>
                </div>
              )}

              {/* Error banner (single-ITV mode) */}
              {singleError && (
                <div className="mb-4 flex items-start gap-2 bg-status-error/30 border border-status-error rounded-xl p-3 dash-animate-in">
                  <AlertCircle className="h-4 w-4 text-status-error mt-0.5 shrink-0" />
                  <p className="text-sm text-status-error flex-1">{singleError}</p>
                  <button onClick={() => setSingleError(null)} className="text-status-error hover:text-status-error shrink-0"><X className="h-4 w-4" /></button>
                </div>
              )}

              {/* Generating banner (document mode) */}
              {isGenerating && (
                <StatusBanner
                  variant="info"
                  title={<>Generation in Progress{generationTitle ? ` — ${generationTitle}` : ''}</>}
                  subtitle={<>
                    {statusMessage}
                    {timeRemaining !== null && timeRemaining > 0 && ` · ${formatTime(timeRemaining)} remaining`}
                  </>}
                />
              )}

              {/* Completion banner (document mode) */}
              {isComplete && (
                <StatusBanner
                  variant="success"
                  title={<>Videos Generated{generationTitle ? ` for ${generationTitle}` : ''}!</>}
                  subtitle="All video clips have been generated and saved to your Documents."
                />
              )}

              {/* Generating banner (single-ITV mode) */}
              {isSingleGenerating && (
                <StatusBanner
                  variant="info"
                  title={singleGenPhase === 'image' ? 'Generating Keyframe Image…' : 'Animating Video…'}
                  subtitle={singleGenPhase === 'image'
                    ? 'Step 1 of 2 — Creating keyframe image from your prompt.'
                    : 'Step 2 of 2 — Animating the keyframe into a video clip.'}
                />
              )}

              {/* Completion banner (single-ITV mode) */}
              {isSingleComplete && (
                <StatusBanner
                  variant="success"
                  title="Video Generated!"
                  subtitle="Your individual video clip is ready. Download it or press Done to generate another."
                />
              )}

              {/* Configuration */}
              <div
                className="dash-collapse-grid"
                data-collapsed={isGenerating || isComplete || isSingleGenerating || isSingleComplete ? 'true' : 'false'}
              >
              <div key={inputMode} className="space-y-6 dash-stagger">

                {/* ═══ Mode ═══ */}
                <div className="dash-animate-in">
                  <h2 className="text-xl font-semibold text-white mb-4">Mode</h2>
                  <div className="grid grid-cols-2 gap-4">
                    <button
                      onClick={() => setInputMode('document')}
                      disabled={isGenerating || isComplete || singleGenState !== 'idle'}
                      className={`p-4 rounded-xl border-2 transition-all text-left ${
                        inputMode === 'document'
                          ? 'border-red-800/70 bg-red-900/30'
                          : 'border-border-card bg-surface-card hover:border-white/20'
                      } ${(isGenerating || isComplete || singleGenState !== 'idle') ? 'cursor-not-allowed opacity-50' : ''}`}
                    >
                      <div className="font-medium text-white text-sm sm:text-base">Existing Document</div>
                      <div className="text-xs sm:text-sm text-text-muted mt-1">Generate clips from a story document</div>
                    </button>
                    <button
                      onClick={() => setInputMode('prompt')}
                      disabled={isGenerating || isComplete || singleGenState !== 'idle'}
                      className={`p-4 rounded-xl border-2 transition-all text-left ${
                        inputMode === 'prompt'
                          ? 'border-red-800/70 bg-red-900/30'
                          : 'border-border-card bg-surface-card hover:border-white/20'
                      } ${(isGenerating || isComplete || singleGenState !== 'idle') ? 'cursor-not-allowed opacity-50' : ''}`}
                    >
                      <div className="font-medium text-white text-sm sm:text-base">Individual Prompt</div>
                      <div className="text-xs sm:text-sm text-text-muted mt-1">Generate a single clip from a prompt</div>
                    </button>
                  </div>
                </div>

                {/* ═══ Individual Prompt Input ═══ */}
                {inputMode === 'prompt' && (
                  <div className="bg-surface-card rounded-xl p-6">
                    <h2 className="text-xl font-semibold text-white mb-2">Individual ITV Generation</h2>
                    <p className="text-text-muted mb-6 text-sm">
                      Generate a single image-to-video clip from your own prompt. The same prompt is used for
                      both keyframe image generation and video animation.
                    </p>
                    <div>
                      <label className="block text-sm font-medium text-white mb-3">Prompt</label>
                      <textarea
                        value={singlePrompt}
                        onChange={e => setSinglePrompt(e.target.value)}
                        placeholder="Describe the scene in detail — setting, action, lighting, mood, camera movement…"
                        rows={8}
                        disabled={singleGenState !== 'idle'}
                        className="w-full bg-surface-elevated text-white rounded-md p-3 mb-2 focus:outline-none focus:ring-2 focus:ring-accent-text resize-none"
                      />
                      <div className="flex justify-between text-xs text-text-dim">
                        <span>{singlePrompt.length} characters</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* ═══ Document ═══ */}
                {inputMode === 'document' && (
                <div>
                  <h2 className="text-xl font-semibold text-white mb-2">Select or Upload Story Document</h2>
                  <p className="text-text-secondary mb-4">
                    Select one of your Story Documents or upload a .txt file to generate videos.
                  </p>
                  <DocumentSelector
                    documents={documents}
                    selectedDoc={selectedDoc}
                    onDocChange={(id) => { setSelectedDoc(id); setUploadedDoc(null); setUploadedDocId(null); setSelectedAudioPath(''); setTotalAudioDuration(0); }}
                    uploadedDoc={uploadedDoc}
                    onUploadedDocChange={(f) => { setUploadedDoc(f); if (!f) setUploadedDocId(null); }}
                    onFileUpload={handleFileUpload}
                    uploadingFile={uploadingFile}
                    disabled={isGenerating}
                    error={uploadError}
                  />
                  {selectedDocument && (
                    <div className="mt-2 px-1 flex flex-wrap items-center gap-3 text-xs text-text-dim">
                      <span>{selectedDocument.word_count?.toLocaleString() ?? '?'} words</span>
                      {selectedDocument.is_corrected && (
                        <>
                          <span>·</span>
                          <span className="text-status-success">Corrected version</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
                )}

                {/* ═══ Image Model & Style ═══ */}
                <div>
                  <ImageModelSelector
                    selectedModel={imageModel}
                    selectedStyle={imageStyle}
                    onModelChange={setImageModel}
                    onStyleChange={setImageStyle}
                    disabled={isGenerating}
                    isLegacy={isLegacy}
                  />
                </div>

                {/* ═══ ITV Video Model ═══ */}
                <div>
                  <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Video Quality Model</label>

                  <ITVVideoModelSelector
                    selectedModel={videoModel}
                    isLegacy={isLegacy}
                    onModelChange={(model) => {
                      setVideoModel(model);
                      const cfg = ITV_VIDEO_MODEL_OPTIONS.find(m => m.value === model);
                      if (cfg) {
                        setVideoDuration(cfg.defaultDuration);
                        if (cfg.durationType === 'slider') setItvSliderInputValue(String(cfg.defaultDuration));
                      }
                      if (!ITV_AUDIO_SUPPORTED_MODELS.has(model)) setUseAudioClip(false);
                    }}
                    disabled={isGenerating}
                  />
                </div>

                {/* ═══ Model Settings ═══ */}
                {videoModel && selectedModelCfg && (
                <div className="bg-surface-card rounded-xl border border-border-card p-5">
                  <h2 className="text-base font-semibold text-white mb-1">Model Settings</h2>
                  <p className="text-xs text-text-dim mb-4">{selectedModelCfg.label} — {selectedModelCfg.description}</p>

                  {/* Duration selector */}
                  {selectedModelCfg.durationType !== 'fixed' && (
                    <div>
                      <label className="block text-sm text-text-dim mb-2">Clip Duration</label>
                      {selectedModelCfg.durationType === 'options' && (
                        <div className="flex flex-wrap gap-2">
                          {selectedModelCfg.durationOptions.map(d => (
                            <button
                              key={d}
                              onClick={() => setVideoDuration(d)}
                              className={`px-4 py-2 rounded-xl border text-sm font-medium transition-colors ${
                                videoDuration === d
                                  ? `${selectedModelCfg.borderColor} ${selectedModelCfg.bgColor} ${selectedModelCfg.textColor}`
                                  : 'border-border bg-surface-elevated text-text-muted hover:border-border-subtle'
                              }`}
                            >
                              {d}s
                            </button>
                          ))}
                        </div>
                      )}
                      {selectedModelCfg.durationType === 'slider' && (() => {
                        const minVal = selectedModelCfg.durationMin ?? 2;
                        const maxVal = selectedModelCfg.durationMax ?? 12;
                        const parsed = parseInt(itvSliderInputValue);
                        const isOutOfRange = itvSliderInputValue !== '' && (isNaN(parsed) || parsed < minVal || parsed > maxVal);
                        return (
                          <div className="space-y-2">
                            <div className="flex items-center gap-3">
                              <input
                                type="range" min={minVal} max={maxVal} step={1} value={videoDuration}
                                onChange={e => { const v = parseInt(e.target.value); setVideoDuration(v); setItvSliderInputValue(String(v)); }}
                                className="flex-1 accent-indigo-500"
                              />
                              <input
                                type="number" min={minVal} max={maxVal} value={itvSliderInputValue}
                                onChange={e => { setItvSliderInputValue(e.target.value); const v = parseInt(e.target.value); if (!isNaN(v) && v >= minVal && v <= maxVal) setVideoDuration(v); }}
                                className="w-16 bg-surface-elevated border border-border-card rounded-xl px-2 py-1 text-sm text-center text-white focus:outline-none focus:border-status-paused [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                              />
                              <span className="text-sm text-text-dim">s</span>
                            </div>
                            {isOutOfRange && (
                              <div className="flex items-center gap-2 text-xs text-status-warning">
                                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                                <span>Enter a value between {minVal} and {maxVal} seconds.</span>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                  {selectedModelCfg.durationType === 'fixed' && (
                    <div className="flex items-center gap-2 text-sm text-text-dim">
                      <span>Clip duration:</span>
                      <span className={`font-medium ${selectedModelCfg.textColor}`}>{selectedModelCfg.defaultDuration}s (fixed)</span>
                    </div>
                  )}

                  {/* Audio Clip toggle */}
                  {ITV_AUDIO_SUPPORTED_MODELS.has(videoModel) && (
                    <div className="mt-5 pt-5 border-t border-border">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <label className="flex items-center text-sm font-medium text-text-muted">Audio Clips</label>
                          <p className="mt-1 text-xs text-text-dim">
                            Generate video clips with matching AI sound design embedded.
                          </p>
                          {useAudioClip && (
                            <p className="mt-2 text-xs text-status-warning flex items-center gap-1">
                              <AlertCircle className="h-3 w-3 flex-shrink-0" />
                              Audio clips can sound strange with text-to-speech audio overlay on a final video.
                            </p>
                          )}
                          {useAudioClip && (videoModel === 'veo31fast' || videoModel === 'veo31') && (
                            <p className="mt-1 text-xs text-action-orange">
                              ⚡ Veo audio mode: {fmtKps(ITV_AUDIO_TOKENS_PER_SECOND[videoModel] ?? 0)} tokens/s
                              &nbsp;(vs {fmtKps(ITV_TOKENS_PER_SECOND[videoModel] ?? 0)} without audio)
                            </p>
                          )}
                          {useAudioClip && (videoModel === 'ltx23fast' || videoModel === 'ltx23pro' || videoModel === 'ltx23pro4k') && (
                            <p className="mt-1 text-xs text-action-orange">
                              🔊 LTX 2.3 generates native AI audio.
                            </p>
                          )}
                          {useAudioClip && videoModel === 'seedance15' && (
                            <p className="mt-1 text-xs text-action-orange">
                              ⚡ Seedance 1.5 audio mode: {fmtKps(ITV_AUDIO_TOKENS_PER_SECOND.seedance15 ?? 0)} tokens/s
                              &nbsp;(vs {fmtKps(ITV_TOKENS_PER_SECOND.seedance15 ?? 0)} without audio)
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setUseAudioClip(!useAudioClip)}
                          className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${useAudioClip ? 'bg-accent' : 'bg-surface-elevated'}`}
                        >
                          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${useAudioClip ? 'translate-x-6' : 'translate-x-1'}`} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                )}

                {inputMode === 'document' && (<>
                {/* ═══ Generation Settings ═══ */}
                <div className="relative z-10">
                  <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-4">Generation Settings</label>
                  <div className="space-y-4">
                    {/* Character consistency */}
                    <div className="flex items-center justify-between bg-surface-elevated px-4 py-3 rounded-xl">
                      <div>
                        <h3 className="text-sm font-medium text-white">Character Consistency</h3>
                        <p className="text-sm text-text-dim mt-1">Maintain consistent character descriptions across all clips</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={useCharacterDescriptions}
                        aria-label="Toggle character consistency"
                        onClick={() => setUseCharacterDescriptions(!useCharacterDescriptions)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                          useCharacterDescriptions ? 'bg-accent' : 'bg-white/10'
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                          useCharacterDescriptions ? 'translate-x-6' : 'translate-x-1'
                        }`} />
                      </button>
                    </div>

                    {/* Custom Characters Section - only visible when Character Consistency is ON */}
                    {useCharacterDescriptions && (
                      <div className="bg-surface-elevated px-4 py-4 rounded-xl space-y-4">
                        {/* Custom Characters Toggle */}
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="text-sm font-medium text-white">Custom Characters</h3>
                            <p className="text-sm text-text-dim mt-1">Define your own character descriptions instead of auto-extracting from the story</p>
                          </div>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={customCharactersEnabled}
                            aria-label="Toggle custom characters"
                            onClick={() => {
                              setCustomCharactersEnabled(!customCharactersEnabled);
                              if (!customCharactersEnabled && customCharacters.length === 0) {
                                setCustomCharacters([{ name: '', description: '' }]);
                              }
                            }}
                            className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                              customCharactersEnabled ? 'bg-accent' : 'bg-white/10'
                            }`}
                          >
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                              customCharactersEnabled ? 'translate-x-6' : 'translate-x-1'
                            }`} />
                          </button>
                        </div>

                        {/* Custom Characters Fields */}
                        {customCharactersEnabled && (
                          <div className="space-y-4">
                            {/* Info Warning Box */}
                            <div className="flex items-start gap-2 p-4 bg-status-warning border border-status-warning rounded-xl">
                              <AlertCircle className="h-5 w-5 text-status-warning flex-shrink-0 mt-0.5" />
                              <div>
                                <p className="text-sm text-status-warning-text font-medium">Important</p>
                                <p className="text-xs text-status-warning-text mt-1">
                                  Custom character descriptions will override automatic character extraction from your story. 
                                  Make sure character names exactly match the names used in your story text for proper matching in video prompts.
                                </p>
                              </div>
                            </div>

                            {/* Character Name + Description Fields */}
                            <div>
                              <label className="block text-sm font-medium text-text-secondary mb-2">
                                Character Descriptions
                                <span className="text-xs text-text-dim ml-2">(Max 10)</span>
                              </label>
                              <div className="space-y-3">
                                {customCharacters.map((char, index) => (
                                  <div key={index} className="flex gap-2 items-start">
                                    <div className="flex-1 space-y-2">
                                      <input
                                        type="text"
                                        value={char.name}
                                        onChange={(e) => {
                                          const newChars = [...customCharacters];
                                          newChars[index] = { ...newChars[index], name: e.target.value };
                                          setCustomCharacters(newChars);
                                        }}
                                        placeholder="Character name (must match story text)"
                                        className="w-full px-4 py-3 bg-surface-input border border-white/[0.13] rounded-xl text-white text-sm placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50"
                                      />
                                      <textarea
                                        value={char.description}
                                        onChange={(e) => {
                                          const newChars = [...customCharacters];
                                          newChars[index] = { ...newChars[index], description: e.target.value };
                                          setCustomCharacters(newChars);
                                        }}
                                        placeholder="Physical appearance, clothing, build, facial features, hair, accessories..."
                                        className="w-full px-4 py-3 bg-surface-input border border-white/[0.13] rounded-xl text-white text-sm placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 resize-none"
                                        rows={2}
                                      />
                                    </div>
                                    {customCharacters.length > 1 && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const newChars = customCharacters.filter((_, i) => i !== index);
                                          setCustomCharacters(newChars);
                                        }}
                                        className="mt-1 p-2 text-status-error hover:text-status-error hover:bg-surface-elevated rounded"
                                      >
                                        <X className="w-5 h-5" />
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>

                              {customCharacters.length < 10 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCustomCharacters([...customCharacters, { name: '', description: '' }]);
                                  }}
                                  className="mt-3 w-full py-3 bg-surface-card hover:bg-surface-input border border-border-card rounded-xl text-text-secondary text-sm font-medium flex items-center justify-center gap-2 transition-colors"
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
                                <label className="flex items-center text-sm font-medium text-text-secondary">
                                  AI Enhancement
                                  <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-status-success text-status-success rounded-full border border-status-success">
                                    Recommended
                                  </span>
                                </label>
                                <p className="mt-1 text-xs text-text-dim">
                                  Let AI expand your basic character descriptions into detailed visual descriptions optimized for video generation. Provide just the essentials—AI fills in the visual details.
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => setCustomCharactersAIEnhance(!customCharactersAIEnhance)}
                                className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                                  customCharactersAIEnhance ? 'bg-accent' : 'bg-white/10'
                                }`}
                              >
                                <span
                                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                    customCharactersAIEnhance ? 'translate-x-6' : 'translate-x-1'
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
                      <label className="block text-sm font-medium text-text-muted mb-2">Language</label>
                      <Listbox value={language} onChange={setLanguage}>
                        {({ open }) => (
                          <div className="relative">
                            <Listbox.Button className="relative w-full bg-surface-elevated border border-border-card rounded-xl px-4 py-3 text-left text-text-muted focus:outline-none focus:ring-2 focus:ring-accent-text focus:border-transparent shadow-sm transition-all duration-200 cursor-pointer hover:bg-surface-elevated">
                              <span className="block truncate">{LANGUAGE_OPTIONS.find(o => o.value === language)?.label || 'English'}</span>
                              <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                                <ChevronDown className={`h-5 w-5 text-text-dim transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                              </span>
                            </Listbox.Button>
                            <Transition show={open} enter="transition ease-out duration-100" enterFrom="transform opacity-0 scale-95" enterTo="transform opacity-100 scale-100" leave="transition ease-in duration-75" leaveFrom="transform opacity-100 scale-100" leaveTo="transform opacity-0 scale-95">
                              <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-card border border-border-card rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                                {LANGUAGE_OPTIONS.map(opt => (
                                  <Listbox.Option key={opt.value} value={opt.value} className={({ active, selected }) => `relative cursor-pointer select-none py-3 px-4 ${active ? 'bg-surface-elevated text-white' : 'text-text-muted'} ${selected ? 'font-medium' : 'font-normal'}`}>
                                    {({ selected }) => (
                                      <div className="flex justify-between items-center">
                                        <span>{opt.label}</span>
                                        {selected && <CheckCircle2 className="h-5 w-5 text-status-error" />}
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

                    {/* AI Writing Model */}
                    <div>
                      <label className="block text-sm font-medium text-text-muted mb-2">AI Writing Model</label>
                      <Listbox value={promptModel} onChange={setPromptModel}>
                        {({ open }) => (
                          <div className="relative">
                            <Listbox.Button className="relative w-full bg-surface-elevated border border-border-card rounded-xl px-4 py-3 text-left text-text-muted focus:outline-none focus:ring-2 focus:ring-accent-text focus:border-transparent shadow-sm transition-all duration-200 cursor-pointer hover:bg-surface-elevated">
                              <span className="block truncate">{MODEL_OPTIONS.find(o => o.value === promptModel)?.label || 'Core Model'}</span>
                              <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                                <ChevronDown className={`h-5 w-5 text-text-dim transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                              </span>
                            </Listbox.Button>
                            <Transition show={open} enter="transition ease-out duration-100" enterFrom="transform opacity-0 scale-95" enterTo="transform opacity-100 scale-100" leave="transition ease-in duration-75" leaveFrom="transform opacity-100 scale-100" leaveTo="transform opacity-0 scale-95">
                              <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-card border border-border-card rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                                {MODEL_OPTIONS.map(opt => (
                                  <Listbox.Option key={opt.value} value={opt.value} className={({ active, selected }) => `relative cursor-pointer select-none py-3 px-4 ${active ? 'bg-surface-elevated text-white' : 'text-text-muted'} ${selected ? 'font-medium' : 'font-normal'}`}>
                                    {({ selected }) => (
                                      <div className="flex justify-between items-center">
                                        <div>
                                          <span>{opt.label}</span>
                                          <p className="text-xs text-text-dim mt-1">{opt.description}</p>
                                        </div>
                                        {selected && <CheckCircle2 className="h-5 w-5 text-status-error" />}
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
                  </div>
                </div>

                {/* ═══ Video Frequency ═══ */}
                <div>
                  <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Video Frequency</label>
                  <p className="text-xs text-text-dim mb-4">Determines how many video clips will be generated</p>

                  <div className="dash-info-box p-3 mb-4 flex gap-2">
                    {calculatingDuration ? (
                      <>
                        <RefreshCw className="w-5 h-5 dash-box-icon flex-shrink-0 mt-0.5 animate-spin" />
                        <div className="text-sm dash-box-text"><strong>Calculating Audio Duration…</strong> This may take a moment.</div>
                      </>
                    ) : (
                      <>
                        <Info className="w-5 h-5 dash-box-icon flex-shrink-0 mt-0.5" />
                        <div className="text-sm dash-box-text"><strong>Audio Runtime Mode:</strong> Upload or select audio files that match your selected story to determine the number of video clips.</div>
                      </>
                    )}
                  </div>

                  {!selectedDocument ? (
                    <div className="dash-warning-box p-3 flex gap-2">
                      <AlertCircle className="w-5 h-5 dash-warning-icon flex-shrink-0 mt-0.5" />
                      <div className="text-sm dash-warning-text"><strong>Story Required:</strong> Please select or upload a story document first.</div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {/* Select existing audio */}
                      <div className="space-y-2">
                        <label className="block text-sm font-medium text-text-muted">Select Existing Audio</label>
                        {loadingAudioFiles ? (
                          <div className="flex items-center gap-2 text-sm text-text-dim p-3 bg-surface-elevated rounded-xl">
                            <RefreshCw className="h-4 w-4 animate-spin" /> Loading audio files…
                          </div>
                        ) : (
                          <Listbox
                            value={selectedAudioPath}
                            onChange={(value) => {
                              setSelectedAudioPath(value);
                              setAudioDurationError(null);
                              if (!value) { setTotalAudioDuration(0); return; }
                              const picked = audioFiles.find(f => f.path === value);
                              if (picked?.duration && picked.duration > 0) {
                                setTotalAudioDuration(picked.duration);
                              } else {
                                setTotalAudioDuration(0);
                                handleCalculateAudioDuration(value);
                              }
                            }}
                            disabled={calculatingDuration || uploadingAudio}
                          >
                            {({ open }) => (
                              <div className="relative">
                                <Listbox.Button className={`relative w-full bg-surface-elevated border border-border-card rounded-xl px-4 py-2.5 text-left text-white focus:outline-none focus:ring-2 focus:ring-status-info ${calculatingDuration ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                                  <span className="block truncate">
                                    {selectedAudioPath ? audioFiles.find(f => f.path === selectedAudioPath)?.name : <span className="italic text-text-dim">None – Upload New Audio</span>}
                                  </span>
                                  <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                                    <ChevronDown className={`h-5 w-5 text-text-dim transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                                  </span>
                                </Listbox.Button>
                                <Transition show={open} enter="transition ease-out duration-100" enterFrom="transform opacity-0 scale-95" enterTo="transform opacity-100 scale-100" leave="transition ease-in duration-75" leaveFrom="transform opacity-100 scale-100" leaveTo="transform opacity-0 scale-95">
                                  <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-card border border-border-card rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                                    <Listbox.Option value="" className={({ active, selected }) => `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${active ? 'bg-surface-elevated text-white' : 'text-text-muted'} ${selected ? 'font-medium' : 'font-normal'}`}>
                                      {({ selected }) => (
                                        <>
                                          <span className={`italic text-sm ${selected ? 'text-text-muted font-medium' : 'text-text-dim'}`}>None – Upload New Audio</span>
                                          {selected && <CheckCircle2 className="h-5 w-5 text-status-info" />}
                                        </>
                                      )}
                                    </Listbox.Option>
                                    {audioFiles.map((af) => (
                                      <Listbox.Option key={af.path} value={af.path} className={({ active, selected }) => `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${active ? 'bg-surface-elevated text-white' : 'text-text-muted'} ${selected ? 'font-medium' : 'font-normal'}`}>
                                        {({ selected }) => (
                                          <>
                                            <span className={selected ? 'font-medium text-white' : 'font-normal'}>{af.name}</span>
                                            {selected && <CheckCircle2 className="h-5 w-5 text-status-info" />}
                                          </>
                                        )}
                                      </Listbox.Option>
                                    ))}
                                  </Listbox.Options>
                                </Transition>
                              </div>
                            )}
                          </Listbox>
                        )}
                        {calculatingDuration && <div className="flex items-center gap-2 text-sm text-text-dim"><RefreshCw className="h-3 w-3 animate-spin" /> Calculating duration…</div>}
                        {audioDurationError && <p className="text-xs text-status-error">{audioDurationError}</p>}
                      </div>

                      {/* Upload new audio — hidden once an existing audio file is selected */}
                      {!selectedAudioPath && (
                      <div className="space-y-2">
                        <label className="block text-sm font-medium text-text-muted">Upload New Audio</label>
                        <label className={`flex flex-col items-center justify-center w-full h-28 border-2 border-dashed rounded-xl transition-colors ${uploadingAudio || calculatingDuration ? 'border-border bg-surface-elevated cursor-not-allowed opacity-60' : 'border-border bg-surface-elevated hover:bg-surface-elevated/50 hover:border-border-subtle cursor-pointer'}`}>
                          <div className="flex flex-col items-center justify-center py-4 text-center w-full px-4">
                            {uploadingAudio ? (
                              <>
                                <RefreshCw className="h-5 w-5 text-status-info animate-spin mb-2" />
                                <p className="text-sm text-text-dim mb-2">Uploading… {uploadProgress > 0 ? `${uploadProgress}%` : ''}</p>
                                {uploadProgress > 0 && (
                                  <div className="w-full bg-surface-elevated rounded-full h-1.5">
                                    <div className="bg-status-info-muted h-1.5 rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
                                  </div>
                                )}
                              </>
                            ) : (
                              <>
                                <p className="text-sm text-text-dim"><span className="font-medium text-text-muted">Click to upload</span> or drag &amp; drop</p>
                                <p className="text-xs text-text-dim mt-1">MP3, WAV, M4A, FLAC, AAC, OGG (Max 500 MB)</p>
                              </>
                            )}
                          </div>
                          <input ref={audioUploadRef} type="file" accept=".mp3,.wav,.flac,.m4a,.aac,.ogg,.wma,audio/*" className="hidden" disabled={uploadingAudio || calculatingDuration} onChange={handleAudioUpload} />
                        </label>
                      </div>
                      )}

                      {totalAudioDuration > 0 && effectiveDuration > 0 && (
                        <div className="space-y-2 border-t border-border pt-3">
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-text-dim">Audio duration</span>
                            <span className="text-white">{formatDuration(totalAudioDuration)}</span>
                          </div>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-text-dim">Clip duration</span>
                            <span className="text-white">{effectiveDuration}s per clip</span>
                          </div>
                          <div className="flex items-center justify-between pt-1">
                            <span className="text-text-muted font-medium text-sm">Estimated video clips</span>
                            <span className="text-white font-bold text-xl">{Math.max(1, Math.floor(totalAudioDuration / effectiveDuration))}</span>
                          </div>
                        </div>
                      )}

                      {totalAudioDuration <= 0 && (
                        <div className="dash-info-box p-3 flex gap-2">
                          <Info className="h-4 w-4 dash-box-icon flex-shrink-0 mt-0.5" />
                          <div>
                            <p className="text-xs dash-box-text">
                              ↑ Please select or upload an audio file and calculate its duration
                            </p>
                            <p className="mt-2 text-xs dash-box-text">
                              Don't have a voiceover yet?{' '}
                              <a href="/text-to-speech" className="text-status-info hover:text-blue-300 underline underline-offset-2">
                                Create one on the Text-To-Speech page
                              </a>
                              .
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                </>)}

                {/* ═══ Token Estimate ═══ */}
                {inputMode === 'document' && estimate && selectedDocument && (
                  <div className="bg-surface-card rounded-xl border border-border-card p-5">
                    <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
                      <span>⚡</span> Token Cost Estimate
                    </h2>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-text-dim">Prompt generation ({estimate.totalVideos} clips · {MODEL_OPTIONS.find(m => m.value === promptModel)?.label})</span>
                        <span className="text-text-secondary">{formatNumber(estimate.promptTokens)} tokens</span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-text-dim">Image generation ({estimate.totalVideos} images · {imageModel})</span>
                        <span className="text-text-secondary">{formatNumber(estimate.imageTokens)} tokens</span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-text-dim">Video generation ({selectedModelCfg?.label}{useAudioClip && ITV_AUDIO_SUPPORTED_MODELS.has(videoModel) ? ' · 🔊' : ''} · {effectiveDuration}s × {estimate.totalVideos})</span>
                        <span className="text-text-secondary">{formatNumber(estimate.videoTokens)} tokens</span>
                      </div>
                      <div className="border-t border-border pt-2 flex items-center justify-between">
                        <span className="text-white font-semibold">Total required</span>
                        <span className={`font-bold text-lg ${estimate.totalTokens > userTokenBalance ? 'text-status-error' : 'text-status-success'}`}>
                          {formatNumber(estimate.totalTokens)} tokens
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-text-dim">Your available balance</span>
                        <span className={estimate.totalTokens > userTokenBalance ? 'text-status-error' : 'text-text-muted'}>{formatNumber(userTokenBalance)} tokens</span>
                      </div>
                      <div className="h-2 bg-surface-elevated rounded-full overflow-hidden mt-1">
                        <div className={`h-full rounded-full transition-all ${estimate.totalTokens > userTokenBalance ? 'bg-accent' : 'bg-status-success-muted'}`}
                          style={{ width: `${Math.min(100, (estimate.totalTokens / Math.max(estimate.totalTokens, userTokenBalance)) * 100)}%` }} />
                      </div>
                      {/* Generation time estimate */}
                      {(() => {
                        const secsPerClip = ITV_SECONDS_PER_VIDEO[videoModel] ?? ITV_DEFAULT_SECONDS_PER_VIDEO;
                        const totalSecs = estimate.totalVideos * secsPerClip;
                        return (
                          <div className="mt-3 bg-surface-elevated/60 rounded-xl px-4 py-3 space-y-1">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-text-dim">Est. total generation time</span>
                              <span className="text-status-info font-medium">{formatTime(totalSecs)}</span>
                            </div>
                          </div>
                        );
                      })()}
                      {estimate.totalTokens > userTokenBalance && (
                        <div className="flex items-start gap-2 bg-status-error/20 border border-status-error rounded-xl p-3 mt-2">
                          <AlertCircle className="h-4 w-4 text-status-error mt-0.5 shrink-0" />
                          <div className="text-xs text-status-error">
                            <p className="font-medium">Insufficient tokens</p>
                            <p className="mt-0.5 text-status-error">You need {formatNumber(estimate.totalTokens - userTokenBalance)} more tokens.</p>
                          </div>
                        </div>
                      )}
                      {/* Storage estimate */}
                      <div className="border-t border-border pt-2 mt-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-text-dim">Image storage ({estimate.totalVideos} images × {ITV_MB_PER_IMAGE} MB)</span>
                          <span className="text-text-secondary">{formatStorageSize(estimate.totalVideos * ITV_MB_PER_IMAGE)}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm mt-1">
                          <span className="text-text-dim">Video storage ({estimate.totalVideos} clips × {ITV_MB_PER_VIDEO} MB)</span>
                          <span className="text-text-secondary">{formatStorageSize(estimate.totalVideos * ITV_MB_PER_VIDEO)}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm font-medium mt-1">
                          <span className="text-text-muted">Total storage needed</span>
                          <span className={storageUsed !== null && estimate.storageNeededMB > (maxStorageGB * 1024) - storageUsed ? 'text-status-error' : 'text-text-secondary'}>
                            {formatStorageSize(estimate.storageNeededMB)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm mt-1">
                          <span className="text-text-dim">Available storage</span>
                          <span className={storageUsed !== null && estimate.storageNeededMB > (maxStorageGB * 1024) - storageUsed ? 'text-status-error' : 'text-text-muted'}>
                            {storageUsed !== null ? formatStorageSize((maxStorageGB * 1024) - storageUsed) : '…'}
                          </span>
                        </div>
                      </div>
                      {storageUsed !== null && estimate.storageNeededMB > (maxStorageGB * 1024) - storageUsed && (
                        <div className="flex items-start gap-2 bg-status-error/20 border border-status-error rounded-xl p-3 mt-2">
                          <AlertCircle className="h-4 w-4 text-status-error mt-0.5 shrink-0" />
                          <div className="text-xs text-status-error">
                            <p className="font-medium">Insufficient storage</p>
                            <p className="mt-0.5 text-status-error">
                              You need {formatStorageSize(estimate.storageNeededMB - ((maxStorageGB * 1024) - storageUsed))} more space. Delete old files or upgrade your plan.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {inputMode === 'prompt' && imageModel && videoModel && (
                  <div className="bg-surface-card rounded-xl border border-border-card p-5">
                    <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2"><span>⚡</span> Token Cost Estimate</h2>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-text-dim">Image generation ({imageModel})</span>
                        <span className="text-text-secondary">{formatNumber(singleImgTokens)} tokens</span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-text-dim">Video generation ({selectedModelCfg?.label} · {singleEffectiveDuration}s)</span>
                        <span className="text-text-secondary">{formatNumber(singleVideoTokens)} tokens</span>
                      </div>
                      <div className="border-t border-border pt-2 flex items-center justify-between">
                        <span className="text-white font-semibold">Total required</span>
                        <span className={`font-bold text-lg ${singleTotalTokens > userTokenBalance ? 'text-status-error' : 'text-status-success'}`}>
                          {formatNumber(singleTotalTokens)} tokens
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-text-dim">Your available balance</span>
                        <span className={singleTotalTokens > userTokenBalance ? 'text-status-error' : 'text-text-muted'}>{formatNumber(userTokenBalance)} tokens</span>
                      </div>
                      <div className="h-2 bg-surface-elevated rounded-full overflow-hidden mt-1">
                        <div className={`h-full rounded-full transition-all ${singleTotalTokens > userTokenBalance ? 'bg-accent' : 'bg-status-success-muted'}`}
                          style={{ width: `${Math.min(100, (singleTotalTokens / Math.max(singleTotalTokens, userTokenBalance)) * 100)}%` }} />
                      </div>
                      {singleTotalTokens > userTokenBalance && (
                        <div className="flex items-start gap-2 bg-status-error/20 border border-status-error rounded-xl p-3 mt-2">
                          <AlertCircle className="h-4 w-4 text-status-error mt-0.5 shrink-0" />
                          <div className="text-xs text-status-error">
                            <p className="font-medium">Insufficient tokens</p>
                            <p className="mt-0.5 text-status-error">You need {formatNumber(singleTotalTokens - userTokenBalance)} more tokens.</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              </div>

              {/* ═══ Generate button ═══ */}
              {inputMode === 'document' && !isGenerating && !isComplete && (
                <div className="flex flex-col items-center gap-2 pb-8 mt-6">
                  <button
                    onClick={handleGenerate}
                    disabled={!canGenerate}
                    className={`w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-base font-semibold transition-all ${
                      canGenerate ? 'bg-accent hover:bg-accent text-white shadow-lg hover:shadow-red-600/25' : 'bg-surface-elevated text-text-dim cursor-not-allowed'
                    }`}
                  >
                    🎬 Generate Image-To-Video
                  </button>
                  {!canGenerate && (
                    <div className="text-xs text-text-dim text-center space-y-0.5">
                      {!selectedDocument && <p>↑ Select a story document</p>}
                      {!imageModel && <p>↑ Select an image model</p>}
                      {!imageStyle && <p>↑ Select an image style</p>}
                      {!videoModel && <p>↑ Select a video model</p>}
                      {totalAudioDuration <= 0 && <p>↑ Select an audio file and calculate its duration</p>}
                      {estimate && estimate.totalTokens > userTokenBalance && (
                        <p className="text-status-error">↑ Insufficient tokens — choose cheaper models or upgrade your plan</p>
                      )}
                      {estimate && storageUsed !== null && estimate.storageNeededMB > (maxStorageGB * 1024) - storageUsed && (
                        <p className="text-status-error">↑ Insufficient storage — delete old files or upgrade your plan</p>
                      )}
                    </div>
                  )}
                </div>
              )}
              {inputMode === 'prompt' && !isSingleGenerating && !isSingleComplete && (
                <div className="flex flex-col items-center gap-2 pb-8 mt-6">
                  <button
                    onClick={handleGenerateSingle}
                    disabled={!canGenerateSingle}
                    className={`w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-base font-semibold transition-all ${
                      canGenerateSingle ? 'bg-accent hover:bg-accent text-white shadow-lg hover:shadow-red-600/25' : 'bg-surface-elevated text-text-dim cursor-not-allowed'
                    }`}
                  >
                    🎬 Generate Image-To-Video Clip
                  </button>
                  {!canGenerateSingle && (
                    <div className="text-xs text-text-dim text-center space-y-0.5">
                      {!singlePrompt.trim() && <p>↑ Enter a prompt</p>}
                      {!imageModel && <p>↑ Select an image model</p>}
                      {!videoModel && <p>↑ Select a video model</p>}
                      {singleTotalTokens > userTokenBalance && (
                        <p className="text-status-error">↑ Insufficient tokens — choose cheaper models or upgrade your plan</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ═══ Single-ITV progress display ═══ */}
              {inputMode === 'prompt' && isSingleGenerating && (() => {
                const imageGenSecs = IMAGE_GEN_SECONDS[imageModel] ?? 45;
                const videoGenSecs = ITV_SECONDS_PER_VIDEO[videoModel] ?? ITV_DEFAULT_SECONDS_PER_VIDEO;
                return (
                  <div className="mb-6 bg-surface-card rounded-xl border border-border-card p-6">
                    <div className="flex items-center gap-3 mb-5">
                      <RefreshCw className="h-5 w-5 text-status-error animate-spin" />
                      <div>
                        <h2 className="text-base font-semibold text-white">Generating Your Clip…</h2>
                        <p className="text-sm text-text-dim mt-0.5">
                          {singleGenPhase === 'image' ? 'Step 1 of 2 — Creating keyframe image' : 'Step 2 of 2 — Animating into video'}
                        </p>
                      </div>
                    </div>

                    {/* Step 1 — Image */}
                    <div className="mb-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-text-muted flex items-center gap-1.5">
                          {singleGenPhase !== 'image'
                            ? <CheckCircle2 className="h-3.5 w-3.5 text-status-success" />
                            : <RefreshCw className="h-3.5 w-3.5 text-status-info animate-spin" />}
                          Step 1 — Keyframe Image Generation
                        </span>
                        <span className={`text-xs ${singleGenPhase !== 'image' ? 'text-status-success' : 'text-status-info'}`}>
                          {singleGenPhase !== 'image' ? 'Complete ✓' : `~${formatTime(imageGenSecs)}`}
                        </span>
                      </div>
                      <div className="h-1.5 bg-surface-elevated rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all duration-500 ${
                          singleGenPhase !== 'image' ? 'bg-status-success-muted w-full' : 'bg-status-info-muted w-1/2 animate-pulse'
                        }`} />
                      </div>
                    </div>

                    {/* Step 2 — Video */}
                    <div className="mb-5">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-text-muted flex items-center gap-1.5">
                          {singleGenPhase === 'video'
                            ? <RefreshCw className="h-3.5 w-3.5 text-status-error animate-spin" />
                            : <div className="h-3.5 w-3.5 rounded-full border border-border-card flex-shrink-0" />}
                          Step 2 — Video Generation
                        </span>
                        <span className={`text-xs ${singleGenPhase === 'video' ? 'text-status-error' : 'text-text-dim'}`}>
                          {singleGenPhase === 'video' ? `~${formatTime(videoGenSecs)}` : 'Waiting…'}
                        </span>
                      </div>
                      <div className="h-1.5 bg-surface-elevated rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all duration-500 ${
                          singleGenPhase === 'video' ? 'bg-accent w-1/2 animate-pulse' : 'bg-surface-elevated w-0'
                        }`} />
                      </div>
                    </div>

                    {/* Total estimate */}
                    <div className="bg-surface-elevated/50 rounded-xl px-4 py-3">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-text-dim">Estimated total time</span>
                        <span className="text-status-info font-medium">~{formatTime(imageGenSecs + videoGenSecs)}</span>
                      </div>
                      <p className="text-xs text-text-dim mt-1">Time may vary depending on server queue</p>
                    </div>
                  </div>
                );
              })()}

              {/* ═══ Progress display ═══ */}
              {isGenerating && (
                <div className="mb-6 bg-surface-elevated/50 rounded-xl p-6 space-y-4">
                  <div className="flex items-center space-x-3 text-text-muted">
                    <RefreshCw className="h-5 w-5 text-status-error animate-pulse" />
                    <span>{statusMessage}</span>
                  </div>

                  {/* Phase 1 */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-text-muted">Phase 1 — Image Prompt Generation</span>
                      <span className={`text-xs ${currentPhase !== 'imagePrompts' ? 'text-status-success' : 'text-status-info'}`}>
                        {currentPhase !== 'imagePrompts' ? 'Complete ✓' : `${Math.round(phaseOneProgress)}%`}
                      </span>
                    </div>
                    <div className="h-2 bg-surface-elevated rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-500 ${currentPhase !== 'imagePrompts' ? 'bg-status-success-muted' : 'bg-status-info-muted'}`}
                        style={{ width: `${currentPhase !== 'imagePrompts' ? 100 : phaseOneProgress}%` }} />
                    </div>
                  </div>

                  {/* Phase 2 */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-text-muted">Phase 2 — Keyframe Image Generation</span>
                      <span className={`text-xs ${['videoPrompts', 'videoGeneration', 'complete'].includes(currentPhase) ? 'text-status-success' : currentPhase === 'keyframeImages' ? 'text-status-pending' : 'text-text-dim'}`}>
                        {['videoPrompts', 'videoGeneration', 'complete'].includes(currentPhase) ? 'Complete ✓' : currentPhase === 'keyframeImages' ? `${Math.round(phaseTwoProgress)}%` : 'Waiting…'}
                      </span>
                    </div>
                    <div className="h-2 bg-surface-elevated rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-500 ${['videoPrompts', 'videoGeneration', 'complete'].includes(currentPhase) ? 'bg-status-success-muted' : currentPhase === 'keyframeImages' ? 'bg-action-purple' : 'bg-surface-elevated'}`}
                        style={{ width: `${['videoPrompts', 'videoGeneration', 'complete'].includes(currentPhase) ? 100 : currentPhase === 'keyframeImages' ? phaseTwoProgress : 0}%` }} />
                    </div>
                  </div>

                  {/* Phase 3 */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-text-muted">Phase 3 — Video Prompt Generation</span>
                      <span className={`text-xs ${
                        ['videoGeneration', 'complete'].includes(currentPhase) ? 'text-status-success'
                        : (currentPhase === 'videoPrompts' || currentPhase === 'keyframeImages') && phaseThreeProgress > 0 ? 'text-status-info'
                        : 'text-text-dim'
                      }`}>
                        {['videoGeneration', 'complete'].includes(currentPhase) ? 'Complete ✓'
                          : (currentPhase === 'videoPrompts' || currentPhase === 'keyframeImages') && phaseThreeProgress > 0 ? `${Math.round(phaseThreeProgress)}%`
                          : 'Waiting…'}
                      </span>
                    </div>
                    <div className="h-2 bg-surface-elevated rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-500 ${
                        ['videoGeneration', 'complete'].includes(currentPhase) ? 'bg-status-success-muted'
                        : (currentPhase === 'videoPrompts' || currentPhase === 'keyframeImages') && phaseThreeProgress > 0 ? 'bg-status-info-muted'
                        : 'bg-surface-elevated'
                      }`}
                        style={{ width: `${['videoGeneration', 'complete'].includes(currentPhase) ? 100 : (currentPhase === 'videoPrompts' || currentPhase === 'keyframeImages') ? phaseThreeProgress : 0}%` }} />
                    </div>
                  </div>

                  {/* Phase 4 */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-text-muted">Phase 4 — Video Generation</span>
                      <span className={`text-xs ${currentPhase === 'complete' ? 'text-status-success' : currentPhase === 'videoGeneration' ? 'text-status-error' : 'text-text-dim'}`}>
                        {currentPhase === 'complete' ? 'Complete ✓' : currentPhase === 'videoGeneration' ? `${Math.round(phaseFourProgress)}%` : 'Waiting…'}
                      </span>
                    </div>
                    <div className="h-2 bg-surface-elevated rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-500 ${currentPhase === 'complete' ? 'bg-status-success-muted' : currentPhase === 'videoGeneration' ? 'bg-accent' : 'bg-surface-elevated'}`}
                        style={{ width: `${currentPhase === 'complete' ? 100 : currentPhase === 'videoGeneration' ? phaseFourProgress : 0}%` }} />
                    </div>
                  </div>

                  {timeRemaining !== null && timeRemaining > 0 && (
                    <>
                      <p className="text-sm text-text-muted">Estimated time remaining: {formatTime(timeRemaining)}</p>
                      <p className="text-sm text-text-dim">If you're returning to the page, give it 30 seconds to correctly show the progress.</p>
                      {stuckWarning && <p className="text-sm text-status-warning">This part may take a little longer, but the progress is moving forward.</p>}
                    </>
                  )}
                  <div className="flex justify-end">
                    <button onClick={handleStop} disabled={stopRequested}
                      className="flex items-center px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-xl transition-colors disabled:opacity-50">
                      {stopRequested ? <RefreshCw className="h-5 w-5 mr-2 animate-spin" /> : <X className="h-5 w-5 mr-2" />}
                      {stopRequested ? 'Stopping…' : 'Stop'}
                    </button>
                  </div>
                </div>
              )}

              {/* ═══ Redo modal ═══ */}
              {redoModalOpen && redoModalBatchNum != null && (() => {
                const modalTask = generatedVideoTasks.find(t => t.batchNumber === redoModalBatchNum);
                const videoTps = modalTask
                  ? (modalTask.audioClip && ITV_AUDIO_TOKENS_PER_SECOND[modalTask.videoModel]
                    ? ITV_AUDIO_TOKENS_PER_SECOND[modalTask.videoModel]
                    : ITV_TOKENS_PER_SECOND[modalTask.videoModel] ?? 6000)
                  : 6000;
                const videoRedoCost = modalTask ? Math.round(videoTps * modalTask.videoDuration) : 0;
                const imageRedoCost = modalTask ? (IMAGE_BACKEND_TOKENS[modalTask.imageModel] ?? 14000) : 0;
                return (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60 backdrop-blur-sm">
                    <div className="bg-surface-card border border-border-card rounded-xl p-6 w-full max-w-md shadow-2xl mx-4">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-lg font-semibold text-white">Redo Clip {redoModalBatchNum}</h3>
                        <button onClick={() => setRedoModalOpen(false)} className="text-text-dim hover:text-white transition-colors">
                          <X className="h-5 w-5" />
                        </button>
                      </div>
                      <p className="text-sm text-text-dim mb-3">Choose what to regenerate for this clip:</p>
                      <div className="mb-4">
                        <textarea
                          value={redoModalFeedback}
                          onChange={(e) => setRedoModalFeedback(e.target.value.slice(0, 250))}
                          maxLength={250}
                          rows={4}
                          placeholder="Optional: what's wrong? (max 250 chars)"
                          className="w-full px-3 py-2 bg-surface-elevated border border-border-card rounded-lg text-sm text-white placeholder:text-text-dim focus:outline-none focus:border-status-info resize-none"
                        />
                        <div className="flex justify-end text-xs text-text-dim mt-1">
                          {redoModalFeedback.length}/250
                        </div>
                      </div>
                      <div className="flex flex-col gap-3">
                        {modalTask?.imageNumber != null && (
                          <button
                            onClick={() => handleRedoConfirm('image_and_video', redoModalFeedback.trim())}
                            className="flex items-start gap-3 p-4 bg-surface-elevated hover:bg-status-paused border border-border-card hover:border-status-paused rounded-xl text-left transition-colors">
                            <RotateCcw className="h-5 w-5 text-status-paused mt-0.5 shrink-0" />
                            <div>
                              <p className="text-sm font-medium text-white">Redo Image + Video</p>
                              <p className="text-xs text-text-dim mt-0.5">Generate a new keyframe image, then regenerate the video clip from it</p>
                              <p className="text-xs text-status-paused mt-1.5 font-semibold">{formatNumber(imageRedoCost + videoRedoCost)} tokens</p>
                            </div>
                          </button>
                        )}
                        <button
                          onClick={() => handleRedoConfirm('video_only', redoModalFeedback.trim())}
                          className="flex items-start gap-3 p-4 bg-surface-elevated hover:bg-status-info border border-border-card hover:border-status-info rounded-xl text-left transition-colors">
                          <RotateCcw className="h-5 w-5 text-status-info mt-0.5 shrink-0" />
                          <div>
                            <p className="text-sm font-medium text-white">Redo Video Only</p>
                            <p className="text-xs text-text-dim mt-0.5">Keep the existing keyframe image but regenerate the video clip</p>
                            <p className="text-xs text-status-info mt-1.5 font-semibold">{formatNumber(videoRedoCost)} tokens</p>
                          </div>
                        </button>
                      </div>
                      <div className="mt-4 pt-4 border-t border-border">
                        <button onClick={() => setRedoModalOpen(false)} className="w-full py-2 text-sm text-text-dim hover:text-white transition-colors">
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* ═══ Single-ITV completion screen ═══ */}
              {isSingleComplete && singleVideoUrl && (
                <div className="mb-6 bg-surface-card rounded-xl border border-status-success p-6">
                  <div className="flex items-center gap-3 mb-5">
                    <CheckCircle2 className="h-6 w-6 text-status-success shrink-0" />
                    <div>
                      <h2 className="text-lg font-semibold text-status-success">Video Clip Generated</h2>
                      <p className="text-sm text-text-dim mt-0.5">Your clip is ready — download or continue</p>
                    </div>
                  </div>
                  <video src={singleVideoUrl} controls className="w-full rounded-xl mb-4" />
                  <div className="flex flex-wrap items-center justify-end gap-3">
                    <a
                      href={singleVideoUrl}
                      download="itv-clip.mp4"
                      onClick={async (e) => {
                        e.preventDefault();
                        const url = singleVideoUrl;
                        try {
                          const res = await fetch(url); const blob = await res.blob();
                          const objUrl = URL.createObjectURL(blob);
                          const a = document.createElement('a'); a.href = objUrl; a.download = 'itv-clip.mp4';
                          document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(objUrl);
                        } catch { window.open(url, '_blank'); }
                      }}
                      className="flex items-center gap-2 px-4 py-2 bg-action-info-hover hover:bg-action-info text-white rounded-xl text-sm transition-colors">
                      <Download className="h-4 w-4" /> Download
                    </a>
                    <button
                      onClick={handleDoneSingle}
                      disabled={singleDoneLoading}
                      className="flex items-center gap-2 px-4 py-2 bg-surface-elevated hover:bg-surface-elevated text-text-muted rounded-xl text-sm transition-colors disabled:opacity-50">
                      {singleDoneLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      Done
                    </button>
                  </div>
                </div>
              )}

              {/* ═══ Completion screen ═══ */}
              {isComplete && (
                <div className="mb-6 bg-surface-card rounded-xl border border-status-success p-6">
                  <div className="flex items-center gap-3 mb-5">
                    <CheckCircle2 className="h-6 w-6 text-status-success shrink-0" />
                    <div>
                      <h2 className="text-lg font-semibold text-status-success">Videos Generated{generationTitle ? ` for ${generationTitle}` : ''}</h2>
                      <p className="text-sm text-text-dim mt-0.5">{generatedVideos.length} clip{generatedVideos.length !== 1 ? 's' : ''} saved to your Documents</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-3 mb-6 pb-5 border-b border-border">
                    <button onClick={handleDone} className="flex items-center gap-2 px-4 py-2 bg-surface-elevated hover:bg-surface-elevated text-text-muted rounded-xl text-sm transition-colors">
                      <RefreshCw className="h-4 w-4" /> Done
                    </button>
                    <button onClick={handleDownloadAll} disabled={isDownloadingZip || generatedVideos.every(v => !v)}
                      className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm transition-colors ${isDownloadingZip ? 'bg-status-info text-status-info cursor-not-allowed' : 'bg-action-info-hover hover:bg-action-info text-white'} disabled:opacity-40 disabled:cursor-not-allowed`}>
                      {isDownloadingZip ? (
                        zipDownloadProgress > 0 ? (
                          <div className="flex items-center gap-2">
                            <div className="w-24 bg-status-info rounded-full h-2"><div className="bg-status-info h-2 rounded-full transition-all duration-300" style={{ width: `${zipDownloadProgress}%` }} /></div>
                            <span className="text-xs tabular-nums">{zipDownloadProgress}%</span>
                          </div>
                        ) : (<><div className="h-4 w-4 border-2 border-status-info border-t-transparent rounded-full animate-spin" /> Preparing…</>)
                      ) : (<><Download className="h-4 w-4" /> Download ZIP</>)}
                    </button>
                    <a href="/documents" className="flex items-center gap-2 px-4 py-2 bg-action-success-hover hover:bg-action-success text-white rounded-xl text-sm transition-colors">
                      <Folder className="h-4 w-4" /> View in Documents
                    </a>
                  </div>

                  {generatedVideos.length > 0 && (
                    showVideos || redoingVideo !== null ? (
                    <div className="flex flex-col gap-6">
                      {generatedVideos.map((videoUrl, index) => {
                        const batchNum = index + 1;
                        const isRedoing = redoingVideo === batchNum;
                        return (
                          <div key={batchNum} className="bg-surface-elevated rounded-xl overflow-hidden border border-border">
                            <div className="px-4 py-2 flex items-center justify-between border-b border-border">
                              <span className="text-sm font-medium text-text-muted">
                                Clip {batchNum}
                                {isRedoing && <span className="ml-2 text-xs text-status-paused">Regenerating…</span>}
                              </span>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => handleRedoClick(batchNum)}
                                  disabled={redoingVideo !== null}
                                  title="Redo this clip"
                                  className="flex items-center gap-1 px-2 py-1 bg-surface-elevated hover:bg-action-indigo-hover text-text-muted hover:text-white rounded text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                                  <RotateCcw className="h-3 w-3" /> Redo
                                </button>
                                {videoUrl && (
                                  <a href={videoUrl} download={`clip-${batchNum}.mp4`}
                                    onClick={async (e) => {
                                      e.preventDefault();
                                      try {
                                        const res = await fetch(videoUrl); const blob = await res.blob();
                                        const objUrl = URL.createObjectURL(blob);
                                        const a = document.createElement('a'); a.href = objUrl; a.download = `clip-${batchNum}.mp4`;
                                        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(objUrl);
                                      } catch { window.open(videoUrl, '_blank'); }
                                    }}
                                    className="flex items-center gap-1 px-2 py-1 bg-surface-elevated hover:bg-action-info-hover text-text-muted hover:text-white rounded text-xs transition-colors">
                                    <Download className="h-3 w-3" /> Download
                                  </a>
                                )}
                              </div>
                            </div>
                            <div className="aspect-video relative bg-surface-primary">
                              {isRedoing && (() => {
                                const taskInfo = generatedVideoTasks[index];
                                const videoRedoSecs = ITV_SECONDS_PER_VIDEO[taskInfo?.videoModel ?? ''] ?? 120;
                                const imageRedoSecs = redoingMode === 'image_and_video'
                                  ? (IMAGE_GEN_SECONDS[taskInfo?.imageModel ?? ''] ?? 45)
                                  : 0;
                                const redoSecs = videoRedoSecs + imageRedoSecs;
                                const redoMins = Math.round(redoSecs / 60);
                                const redoTimeLabel = redoSecs >= 60
                                  ? `~${redoMins} minute${redoMins !== 1 ? 's' : ''}`
                                  : `~${redoSecs} seconds`;
                                const redoLabel = redoingMode === 'image_and_video'
                                  ? 'Regenerating image + video…'
                                  : 'Regenerating video…';
                                return (
                                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black bg-opacity-70 z-10 gap-2">
                                    <div className="h-8 w-8 border-2 border-status-paused border-t-transparent rounded-full animate-spin" />
                                    <p className="text-sm font-medium text-status-paused">{redoLabel}</p>
                                    <p className="text-xs text-text-dim">{redoTimeLabel} — may take longer depending on queue</p>
                                  </div>
                                );
                              })()}
                              {videoUrl ? (
                                <video src={videoUrl} controls className="w-full h-full object-contain" preload="metadata" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  <RefreshCw className="h-6 w-6 text-text-dim animate-spin" />
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-8 gap-3">
                        <button
                          onClick={() => setShowVideos(true)}
                          className="flex items-center gap-2 px-6 py-3 bg-action-indigo-hover hover:bg-action-indigo text-white rounded-xl transition-colors font-medium">
                          <Play className="h-5 w-5" />
                          Show {generatedVideos.length} Video Clip{generatedVideos.length !== 1 ? 's' : ''}
                        </button>
                        <p className="text-xs text-text-dim">Click to load video clips in the browser</p>
                      </div>
                    )
                  )}

                  <div className="flex flex-wrap items-center justify-end gap-3 mt-6 pt-5 border-t border-border">
                    <button onClick={handleDone} className="flex items-center gap-2 px-4 py-2 bg-surface-elevated hover:bg-surface-elevated text-text-muted rounded-xl text-sm transition-colors">
                      <RefreshCw className="h-4 w-4" /> Done
                    </button>
                    <button onClick={handleDownloadAll} disabled={isDownloadingZip || generatedVideos.every(v => !v)}
                      className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm transition-colors ${isDownloadingZip ? 'bg-status-info text-status-info cursor-not-allowed' : 'bg-action-info-hover hover:bg-action-info text-white'} disabled:opacity-40 disabled:cursor-not-allowed`}>
                      {isDownloadingZip ? (<><div className="h-4 w-4 border-2 border-status-info border-t-transparent rounded-full animate-spin" /> Preparing…</>) : (<><Download className="h-4 w-4" /> Download ZIP</>)}
                    </button>
                    <a href="/documents" className="flex items-center gap-2 px-4 py-2 bg-action-success-hover hover:bg-action-success text-white rounded-xl text-sm transition-colors">
                      <Folder className="h-4 w-4" /> View in Documents
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </DashboardLayout>
    );
  },
);

export default ImageToVideoGenerator;
