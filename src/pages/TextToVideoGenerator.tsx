import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Listbox, Transition } from '@headlessui/react';
import { Link, useNavigate } from 'react-router-dom';
import { RefreshCw, X, AlertCircle, CheckCircle2, ChevronDown, Folder, Info, Play, Download, BookOpen, Lock } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import { sanitizeFileName } from '../utils/videoGeneratorUtils';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import DashboardLayout from '../components/DashboardLayout';
import StatusBanner from '../components/StatusBanner';
import RedoFeedbackModal from '../components/RedoFeedbackModal';
import { DocumentSelector } from '../components/FileUploadComponents';
import TabManager from '../components/TabManager';
import { v4 as uuidv4 } from 'uuid';
import { VIDEO_MODEL_OPTIONS, TTV_STYLES, getStyleVideoUrl, buildVideoModelOptions } from '../components/VideoModelSelector';
import { useTabSessionStorage } from '../hooks/useTabSessionStorage';
import { updateTabStatus, ensureTabExists, deleteTabFromDB } from '../utils/tabManager';
import { getStorageLimitGB } from '../utils/storageHelpers';
import { uploadWithTus } from '../utils/tusUpload';
import { fetchWithFallback } from '../utils/fetchWithFallback';
import { useIsLegacyPlan } from '../hooks/useIsLegacyPlan';
import { getPlanMaxTokens } from '../data/planMaxTokens';
import {
  LEGACY_TTV_TOKENS_PER_SECOND,
  NEW_TTV_TOKENS_PER_SECOND,
  LEGACY_TTV_TOKENS_PER_SECOND_AUDIO,
  NEW_TTV_TOKENS_PER_SECOND_AUDIO,
  llmMultiplier,
} from '../data/tokenCosts';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

// ─── Constants ────────────────────────────────────────────────────────────────

const OPERATION_TIMEOUT = 30000;
const POLLING_INTERVAL_P1 = 6000;
const POLLING_INTERVAL_P2 = 10000;

const WORDS_PER_SECOND = 2.08; // ≈125 wpm

const TOKEN_PER_WORD = 1.33;

// Per-second token rates come from the active plan map (legacy vs new).
// Module-scope binding mirrors LEGACY; in-component code shadows via useMemo.
const TTV_TOKENS_PER_SECOND: Record<string, number> = LEGACY_TTV_TOKENS_PER_SECOND;

// Audio-mode token rates (when audio_clip = true) — only models that pay extra.
const AUDIO_TOKENS_PER_SECOND: Record<string, number> = LEGACY_TTV_TOKENS_PER_SECOND_AUDIO;

// Models that support high-resolution output
const HIGH_RES_SUPPORTED_MODELS = new Set(['grok', 'sora2pro']);

// Models that support audio clip generation
const AUDIO_CLIP_SUPPORTED_MODELS = new Set(['ltx23_fast', 'ltx23_pro', 'seedance15_pro', 'grok', 'veo31fast', 'veo31', 'sora2pro', 'sora2pro_highres']);

// Estimated seconds per video batch for time-remaining display
const TTV_SECONDS_PER_VIDEO: Record<string, number> = {
  wan22: 360,           // 6 minutes
  veo31: 360,           // 6 minutes
  sora2pro: 300,        // 5 minutes
  sora2pro_highres: 480, // 8 minutes
  grok_highres: 120,    // ~2 minutes (720p takes slightly longer than 480p)
  veo31fast: 180,       // 3 minutes
};
const TTV_DEFAULT_SECONDS_PER_VIDEO = 90; // 90 seconds for all other models

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

const MODEL_OPTIONS = [
  { value: 'deepseek', label: 'Core Model', description: '1× tokens' },
  { value: 'sonnet', label: 'Claude Sonnet 4.6', description: '11× tokens' },
  { value: 'opus', label: 'Claude Opus 4.6', description: '19× tokens' },
];

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

const TTV_MB_PER_VIDEO = 4;

interface TTVEstimate {
  totalVideos: number;
  totalAudioDuration: number;
  promptTokens: number;
  videoTokens: number;
  totalTokens: number;
  storageNeededMB: number;
}

export interface TextToVideoGeneratorRef {
  cleanup: () => Promise<void>;
}

interface TextToVideoGeneratorProps {
  initialTab?: number;
  isEnterpriseUser?: boolean;
  initialTabs?: import('../utils/tabManager').TabInfo[];
  onTabChange?: (tab: number, groupId: string) => void;
  onTabCreate?: (tab: number, groupId: string) => void;
  onTabClose?: (tab: number, groupId: string) => void;
  userId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const formatNumber = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
};

const formatDuration = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

const formatTime = (seconds: number): string => {
  if (seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

const formatStorageSize = (sizeInMB: number): string => {
  const gb = sizeInMB / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return sizeInMB > 0 && sizeInMB < 0.05 ? '0.1 MB' : `${sizeInMB.toFixed(sizeInMB < 1 ? 1 : 2)} MB`;
};

const validateFileName = (name: string): string | null => {
  if (!/^[a-zA-Z0-9\s\-_.]+$/.test(name)) {
    const bad = name.split('').filter(c => !/[a-zA-Z0-9\s\-_.]/.test(c)).join(', ');
    return `Invalid characters: ${bad}`;
  }
  return null;
};

const withTimeout = <T,>(promise: Promise<T>, ms: number, op: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${op} timed out`)), ms)),
  ]);

// ─── Token estimation ─────────────────────────────────────────────────────────

function estimateTTVPromptTokens(
  wordCount: number,
  totalVideos: number,
  hasCharacters: boolean,
  model: string,
  isLegacy: boolean = true,
): number {
  if (wordCount <= 0 || totalVideos <= 0) return 0;
  // Each API call handles BATCH_SIZE=2 segments; only those segments (not the full story) are sent
  const numBatches = Math.ceil(totalVideos / 2);
  const multiplier = llmMultiplier(model, isLegacy);

  // Input per batch: fixed system-prompt overhead + the 2 actual text segments for that batch
  const segmentTokensPerBatch = (wordCount / totalVideos) * 2 * TOKEN_PER_WORD;
  const batchOverhead = hasCharacters ? 700 : 500; // system prompt + context (+ char descriptions if present)
  let rawInput = numBatches * (batchOverhead + segmentTokensPerBatch);

  // Output per batch: ~150 words per generated video prompt × 2 prompts per batch
  let rawOutput = totalVideos * 150 * TOKEN_PER_WORD;

  // One-time character extraction pass (happens once before batches)
  if (hasCharacters) {
    rawInput += (wordCount + 150) * TOKEN_PER_WORD;
    rawOutput += 1000; // ~1 k tokens for the character extraction response
  }

  return Math.round(rawInput * 1.1 * multiplier + rawOutput * multiplier);
}

function computeTTVEstimate(
  wordCount: number,
  totalAudioDuration: number,
  videoDuration: number,
  videoModel: string,
  promptModel: string,
  useCharacterDescriptions: boolean,
  useAudioClip: boolean = false,
  isLegacy: boolean = true,
  ttvRates: Record<string, number> = TTV_TOKENS_PER_SECOND,
  audioRates: Record<string, number> = AUDIO_TOKENS_PER_SECOND,
): TTVEstimate | null {
  if (wordCount <= 0 || totalAudioDuration <= 0 || videoDuration <= 0 || !videoModel) return null;
  const totalVideos = Math.max(1, Math.floor(totalAudioDuration / videoDuration));
  const promptTokens = estimateTTVPromptTokens(wordCount, totalVideos, useCharacterDescriptions, promptModel, isLegacy);
  const baseTokensPerSecond = ttvRates[videoModel] ?? 6000;
  const tokensPerSecond =
    useAudioClip && audioRates[videoModel]
      ? audioRates[videoModel]
      : baseTokensPerSecond;
  const videoTokens = totalVideos * videoDuration * tokensPerSecond;
  const storageNeededMB = totalVideos * TTV_MB_PER_VIDEO;
  return { totalVideos, totalAudioDuration, promptTokens, videoTokens, totalTokens: promptTokens + videoTokens, storageNeededMB };
}

// ─── Style video thumbnail card ───────────────────────────────────────────────

function StyleVideoCard({
  name,
  description,
  videoUrl,
  isSelected,
  onClick,
}: {
  name: string;
  description: string;
  videoUrl: string;
  isSelected: boolean;
  onClick: () => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = React.useState(false);

  const handleMouseEnter = () => {
    videoRef.current?.play().then(() => setIsPlaying(true)).catch(() => {});
  };
  const handleMouseLeave = () => {
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
      setIsPlaying(false);
    }
  };

  return (
    <div
      className={`relative bg-surface-elevated rounded-xl overflow-hidden cursor-pointer transition-all duration-200 ${
        isSelected ? 'ring-2 ring-accent-text' : 'hover:ring-2 hover:ring-border-subtle'
      }`}
      onClick={onClick}
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
        <h3 className="text-base font-medium text-white mb-1">{name}</h3>
        <p className="text-sm text-text-dim">{description}</p>
      </div>
      {isSelected && (
        <div className="absolute top-2 right-2 bg-accent text-white rounded-full p-1">
          <CheckCircle2 className="h-5 w-5" />
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

const TextToVideoGenerator = forwardRef<TextToVideoGeneratorRef, TextToVideoGeneratorProps>(
  function TextToVideoGenerator(
    { initialTab = 1, isEnterpriseUser = false, initialTabs, onTabChange, onTabCreate, onTabClose },
    ref,
  ) {
    const navigate = useNavigate();

    const currentTab = initialTab;

    // Plan-aware per-second token rates. Shadow the module-scope LEGACY maps
    // so every in-component reference (estimates, display strings, button
    // gating) reflects what the backend will charge under the active plan.
    const { isLegacy } = useIsLegacyPlan();
    const TTV_TOKENS_PER_SECOND = React.useMemo(
      () => (isLegacy ? LEGACY_TTV_TOKENS_PER_SECOND : NEW_TTV_TOKENS_PER_SECOND),
      [isLegacy],
    );
    const AUDIO_TOKENS_PER_SECOND = React.useMemo(
      () => (isLegacy ? LEGACY_TTV_TOKENS_PER_SECOND_AUDIO : NEW_TTV_TOKENS_PER_SECOND_AUDIO),
      [isLegacy],
    );
    // Plan-aware video-model option list — used by the inline model picker so
    // its tokens/sec display reflects what the backend will charge.
    const VIDEO_MODEL_OPTIONS = React.useMemo(() => buildVideoModelOptions(isLegacy), [isLegacy]);
    // Format token-per-second values consistently (e.g. 42000 → "42K", 69600 → "69.6K").
    const fmtKps = React.useCallback((n: number) => {
      const k = n / 1000;
      return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
    }, []);

    // ── Document state ────────────────────────────────────────────────────────
    const [documents, setDocuments] = useState<StoryDocument[]>([]);
    const [selectedDoc, setSelectedDoc] = useTabSessionStorage<string>('ttv_selectedDoc', '', currentTab);
    const [uploadedDoc, setUploadedDoc] = useState<File | null>(null);
    const [uploadedDocId, setUploadedDocId] = useState<string | null>(null);
    const [uploadingFile, setUploadingFile] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);

    // ── User / tokens / storage ───────────────────────────────────────────────
    const [userTokenBalance, setUserTokenBalance] = useState(0);
    const [userPlan, setUserPlan] = useState<string>('free');
    const [planLoaded, setPlanLoaded] = useState(false);
    const [storageUsed, setStorageUsed] = useState<number | null>(null);
    const [currentUserId, setCurrentUserId] = useState<string | null>(null);

    // ── Generation settings ───────────────────────────────────────────────────
    const [language, setLanguage] = useTabSessionStorage<string>('ttv_language', 'english', currentTab);
    const [promptModel, setPromptModel] = useTabSessionStorage<string>('ttv_promptModel', 'sonnet', currentTab);
    const [useCharacterDescriptions, setUseCharacterDescriptions] = useTabSessionStorage<boolean>('ttv_charDesc', true, currentTab);
    const [customCharactersEnabled, setCustomCharactersEnabled] = useTabSessionStorage<boolean>('ttv_customCharsEnabled', false, currentTab);
    const [customCharacters, setCustomCharacters] = useTabSessionStorage<Array<{ name: string; description: string }>>('ttv_customChars', [{ name: '', description: '' }], currentTab);
    const [customCharactersAIEnhance, setCustomCharactersAIEnhance] = useTabSessionStorage<boolean>('ttv_customCharsAIEnhance', false, currentTab);

    // ── Video model / style / duration ────────────────────────────────────────
    const [videoModel, setVideoModel] = useTabSessionStorage<string>('ttv_videoModel', 'grok', currentTab);
    const [videoStyle, setVideoStyle] = useTabSessionStorage<string>('ttv_videoStyle', TTV_STYLES[0].style, currentTab);
    const [videoDuration, setVideoDuration] = useTabSessionStorage<number>('ttv_videoDuration', 5, currentTab);
    const [useAudioClip, setUseAudioClip] = useTabSessionStorage<boolean>('ttv_audioClip', false, currentTab);
    const [useHighRes, setUseHighRes] = useTabSessionStorage<boolean>('ttv_highRes', false, currentTab);

    // Style grid UI state
    const [showAllStyles, setShowAllStyles] = useState(false);
    const [isCustomStyle, setIsCustomStyle] = useState(false);
    const [customStyleText, setCustomStyleText] = useState('');

    // Grok slider display value
    const [sliderInputValue, setSliderInputValue] = useState<string>(String(videoDuration));

    // ── Frequency / audio ─────────────────────────────────────────────────────
    const [audioFiles, setAudioFiles] = useState<AudioFile[]>([]);
    const [selectedAudioPath, setSelectedAudioPath] = useTabSessionStorage<string>('ttv_audioPath', '', currentTab);
    const [totalAudioDuration, setTotalAudioDuration] = useTabSessionStorage<number>('ttv_audioDuration', 0, currentTab);
    const [loadingAudioFiles, setLoadingAudioFiles] = useState(false);
    const [calculatingDuration, setCalculatingDuration] = useState(false);
    const [audioDurationError, setAudioDurationError] = useState<string | null>(null);
    const [uploadingAudio, setUploadingAudio] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);

    // ── Estimate ──────────────────────────────────────────────────────────────
    const [estimate, setEstimate] = useState<TTVEstimate | null>(null);

    // ── Generation state ──────────────────────────────────────────────────────
    type GenState = 'idle' | 'generating' | 'complete' | 'error';
    type Phase = 'prompts' | 'videos' | 'complete';
    const [resumeChecked, setResumeChecked] = useState(false);
    const [generationState, setGenerationState] = useState<GenState>('idle');
    const [currentPhase, setCurrentPhase] = useState<Phase>('prompts');
    const [phaseOneProgress, setPhaseOneProgress] = useState(0);
    const [phaseTwoProgress, setPhaseTwoProgress] = useState(0);
    const [statusMessage, setStatusMessage] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [stopRequested, setStopRequested] = useState(false);
    const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
    const [groupId, setGroupId] = useState<string | null>(null);
    const [_currentVariant, setCurrentVariant] = useState<number | null>(null);
    const [generationTitle, setGenerationTitle] = useState<string | null>(null);
    const [stuckWarning, setStuckWarning] = useState(false);

    // ── Completion screen state ────────────────────────────────────────────────
    const [generatedVideos, setGeneratedVideos] = useState<string[]>([]);
    const [redoingVideo, setRedoingVideo] = useState<number | null>(null);
    const [redoModalBatch, setRedoModalBatch] = useState<number | null>(null);
    const [isDownloadingZip, setIsDownloadingZip] = useState(false);
    const [zipDownloadProgress, setZipDownloadProgress] = useState(0); // 0-100
    const [showVideos, setShowVideos] = useState(false);

    // ── Individual Prompt (single-TTV) state ──────────────────────────────────
    const [inputMode, setInputMode] = useTabSessionStorage<'document' | 'prompt'>('ttv_inputMode', 'document', currentTab);
    const [singlePrompt, setSinglePrompt] = useTabSessionStorage<string>('ttv_singlePrompt', '', currentTab);
    const [singleVideoTitle] = useTabSessionStorage<string>('ttv_singleTitle', '', currentTab);
    const [singleGenState, setSingleGenState] = useState<GenState>('idle');
    const [singleVideoUrl, setSingleVideoUrl] = useState<string | null>(null);
    const [singleTaskId, setSingleTaskId] = useState<string | null>(null);
    const [singleDoneLoading, setSingleDoneLoading] = useState(false);

    const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const stoppedRef = useRef(false);
    const audioUploadRef = useRef<HTMLInputElement>(null);

    const maxStorageGB = getStorageLimitGB(userPlan);

    // ── Expose cleanup ────────────────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      cleanup: async () => {
        console.log(`[TTV Tab ${currentTab}] Cleanup called`);
        if (pollingRef.current) clearInterval(pollingRef.current);
        stoppedRef.current = true;
        try {
          if (!currentUserId) return;

          // Check if generation is completed_final (don't delete videos if so)
          const { data: completedTasks } = await supabase
            .from('TTV_tasks')
            .select('status')
            .eq('user_id', currentUserId)
            .eq('tab', currentTab)
            .eq('status', 'completed_final')
            .or('video_process.is.null,video_process.eq.false')
            .limit(1);

          const hasCompletedFinal = completedTasks && completedTasks.length > 0;

          if (!hasCompletedFinal && groupId) {
            // Signal stop then delete video files (filter video_process=false/null to avoid affecting Video Generator tasks)
            await supabase.from('TTV_prompt_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab).or('video_process.is.null,video_process.eq.false');
            await supabase.from('TTV_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab).or('video_process.is.null,video_process.eq.false');

            const { data: ttvTasks } = await supabase
              .from('TTV_tasks')
              .select('folder_timestamp, story_title')
              .eq('user_id', currentUserId)
              .eq('group_id', groupId)
              .eq('tab', currentTab)
              .or('video_process.is.null,video_process.eq.false')
              .limit(1);

            const folderTask = ttvTasks?.[0];
            if (folderTask?.folder_timestamp && folderTask?.story_title) {
              const sanitizedTitle = folderTask.story_title
                .replace(/^TTV Prompt[s]?:\s*/i, '')
                .replace(/[^a-zA-Z0-9\s-]/g, '.')
                .toLowerCase()
                .trim()
                .replace(/\s+/g, '-');
              const folderPath = `documents/${currentUserId}/${groupId}/TTV-${sanitizedTitle}_${folderTask.folder_timestamp}`;
              console.log(`[TTV Tab ${currentTab}] Deleting video folder: ${folderPath}`);
              const { data: files } = await supabase.storage.from('stories').list(folderPath);
              if (files && files.length > 0) {
                await supabase.storage.from('stories').remove(files.map((f: any) => `${folderPath}/${f.name}`));
                console.log(`[TTV Tab ${currentTab}] Deleted ${files.length} video file(s)`);
              }
            }
          } else if (hasCompletedFinal) {
            console.log(`[TTV Tab ${currentTab}] Generation is complete_final — skipping file deletion`);
          }

          // Always delete DB rows (filter video_process=false/null to avoid affecting Video Generator tasks)
          if (groupId) {
            await supabase.from('TTV_tasks').delete().eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab).or('video_process.is.null,video_process.eq.false');
            await supabase.from('TTV_prompt_tasks').delete().eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab).or('video_process.is.null,video_process.eq.false');
            await supabase.from('TTV_prompt_context').delete().eq('group_id', groupId).eq('tab', currentTab);
          }

          // Delete the tab row from the DB
          await deleteTabFromDB(currentUserId, 'ttv', currentTab);
          console.log(`[TTV Tab ${currentTab}] Cleanup complete`);
        } catch (error) {
          console.error(`[TTV Tab ${currentTab}] Error during cleanup:`, error);
        }
      },
    }), [currentTab, currentUserId, groupId]);

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
          const rolloverTokens = planData.rollover_tokens ?? 0;
          setUserTokenBalance(Math.max(0, max - (planData.tokens_used ?? 0) + rolloverTokens));
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
          setStorageUsed(
            totalSizeMB > 0 && totalSizeMB < 0.05 ? 0.1 : Number(totalSizeMB.toFixed(totalSizeMB < 1 ? 1 : 2)),
          );
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
          // Audio files are stored as story_documents rows with version 7-10
          // (same as ImageFrequencyConfiguration.loadExistingAudioFiles)
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
      const doc = getSelectedDocument();
      const wc = doc?.word_count ?? 0;
      if (wc <= 0) { setEstimate(null); return; }

      const modelCfg = VIDEO_MODEL_OPTIONS.find(m => m.value === videoModel);
      const effectiveDuration =
        !modelCfg ? videoDuration :
        modelCfg.durationType === 'fixed' ? modelCfg.defaultDuration :
        videoDuration;
      if (effectiveDuration <= 0 || !videoModel) { setEstimate(null); return; }

      const audioDur = totalAudioDuration;

      const effectiveModel = useHighRes && videoModel === 'grok' ? 'grok_highres'
        : useHighRes && videoModel === 'sora2pro' ? 'sora2pro_highres'
        : videoModel;
      const est = computeTTVEstimate(
        wc, audioDur, effectiveDuration, effectiveModel, promptModel, useCharacterDescriptions, useAudioClip, isLegacy, TTV_TOKENS_PER_SECOND, AUDIO_TOKENS_PER_SECOND,
      );
      setEstimate(est);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedDoc, uploadedDoc, videoModel, videoDuration, promptModel, useCharacterDescriptions, totalAudioDuration, documents, useAudioClip, useHighRes]);

    // ── Load generated videos when generation completes ───────────────────────
    useEffect(() => {
      if (generationState === 'complete' && groupId && currentUserId) {
        loadGeneratedVideos(groupId);
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [generationState, groupId, currentUserId]);

    // ── Poll for redo completion ───────────────────────────────────────────────
    useEffect(() => {
      if (!redoingVideo || !groupId || !currentUserId) return;

      const interval = setInterval(async () => {
        try {
          const { data: task } = await supabase
            .from('TTV_tasks')
            .select('id,batch_number,video_url,status,redo_status')
            .eq('user_id', currentUserId)
            .eq('group_id', groupId)
            .eq('tab', currentTab)
            .eq('batch_number', redoingVideo)
            .maybeSingle();

          if (!task) return;

          if (!task.redo_status && task.status === 'completed_final' && task.video_url) {
            // Redo complete — refresh signed URL for this clip
            const { data: urlData } = await supabase.storage
              .from('stories')
              .createSignedUrl(task.video_url, 3600);
            if (urlData) {
              setGeneratedVideos(prev => {
                const next = [...prev];
                next[redoingVideo - 1] = urlData.signedUrl;
                return next;
              });
            }
            setRedoingVideo(null);
            setStatusMessage('');
          } else if (task.redo_status === 'failed') {
            setError(`Redo failed for video clip ${redoingVideo}`);
            setRedoingVideo(null);
            setStatusMessage('');
          }
        } catch (err) {
          console.error('[TTV] Redo polling error:', err);
        }
      }, 10_000);

      return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [redoingVideo, groupId, currentUserId, currentTab]);

    // ── Poll for single-TTV completion ────────────────────────────────────────
    useEffect(() => {
      if (singleGenState !== 'generating' || !singleTaskId) return;
      const interval = setInterval(async () => {
        try {
          const { data: task } = await supabase
            .from('TTV_tasks')
            .select('id,status,video_url,error')
            .eq('id', singleTaskId)
            .maybeSingle();
          if (!task) return;
          if (task.status === 'completed_final' && task.video_url) {
            const { data: urlData } = await supabase.storage
              .from('stories')
              .createSignedUrl(task.video_url, 3600);
            if (urlData) setSingleVideoUrl(urlData.signedUrl);
            setSingleGenState('complete');
            if (currentUserId) await updateTabStatus(currentUserId, 'ttv', currentTab, 'complete').catch(() => {});
          } else if (task.status === 'error') {
            setError(task.error || 'Single TTV generation failed');
            setSingleGenState('error');
          }
        } catch (err) {
          console.error('[TTV] Single-TTV polling error:', err);
        }
      }, 10_000);
      return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [singleGenState, singleTaskId]);

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
      const modelCfg = VIDEO_MODEL_OPTIONS.find(m => m.value === videoModel);
      if (!modelCfg) return videoDuration;
      if (modelCfg.durationType === 'fixed') return modelCfg.defaultDuration;
      return videoDuration;
    };

    // ── Load generated video clips (called when generation completes) ─────────
    const loadGeneratedVideos = async (gid: string) => {
      if (!currentUserId || !gid) return;
      try {
        const { data: tasks } = await supabase
          .from('TTV_tasks')
          .select('id,batch_number,story_title,folder_timestamp,video_model,video_duration,video_url,status,redo_status,redo_started_at,group_id,user_id,tab,variant,batch')
          .eq('user_id', currentUserId)
          .eq('group_id', gid)
          .eq('tab', currentTab)
          .in('status', ['completed', 'completed_final'])
          .order('batch_number', { ascending: true });

        if (!tasks || tasks.length === 0) return;

        // Create signed URLs (1 hour) for each clip's storage path
        const signedUrls = await Promise.all(
          tasks.map(async (task) => {
            if (!task.video_url) return '';
            const { data, error } = await supabase.storage
              .from('stories')
              .createSignedUrl(task.video_url, 3600);
            if (error || !data) {
              console.error(`[TTV] Failed to create signed URL for batch ${task.batch_number}:`, error);
              return '';
            }
            return data.signedUrl;
          }),
        );
        setGeneratedVideos(signedUrls);

        // Set story title from tasks if not already known
        const storyTitleFromTask = (tasks[0] as any).story_title;
        if (storyTitleFromTask) setGenerationTitle(storyTitleFromTask);
      } catch (err) {
        console.error('[TTV] loadGeneratedVideos error:', err);
      }
    };

    // ── Trigger redo for a single video clip ──────────────────────────────────
    const handleRedoVideo = async (batchNumber: number, feedback = '') => {
      if (!currentUserId || !groupId) return;
      setRedoingVideo(batchNumber);
      setStatusMessage(`Redoing video clip ${batchNumber}…`);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('No active session');

        const response = await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/redo-TTV`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ group_id: groupId, batch_number: batchNumber, feedback }),
        });

        if (!response.ok && response.status !== 202) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error((errorData as any).error || `HTTP ${response.status}`);
        }
        // 202 → redo is processing; the polling useEffect will detect completion
      } catch (err: any) {
        setError(`Failed to redo video clip ${batchNumber}: ${err.message}`);
        setRedoingVideo(null);
        setStatusMessage('');
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
        const { data: { session: _ttvSession } } = await supabase.auth.getSession();
        const response = await fetchWithFallback('https://calculate-audio-duration.storyscriptai.deno.net', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_ttvSession?.access_token || ''}`,
            'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({
            files: [{ path: targetPath, name: fileName }],
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        // Edge function returns { totalDuration, filesWithDurations }
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

      // Validate file type
      const audioExtensions = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.wma'];
      const fileExt = '.' + (file.name.split('.').pop()?.toLowerCase() ?? '');
      if (!audioExtensions.includes(fileExt)) {
        setAudioDurationError(`Unsupported format "${fileExt}". Accepted: ${audioExtensions.join(', ')}`);
        if (audioUploadRef.current) audioUploadRef.current.value = '';
        return;
      }

      // Validate file size (500 MB)
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

        // Use TUS resumable upload (falls back to regular upload for small files)
        const result = await uploadWithTus({
          file,
          bucket: 'stories',
          path: filePath,
          onProgress: (bytesUploaded, bytesTotal) => {
            setUploadProgress(Math.round((bytesUploaded / bytesTotal) * 100));
          },
          contentType: file.type || 'audio/mpeg',
        });

        if (!result.success) {
          throw new Error(result.error || 'Upload failed');
        }

        // Insert metadata into story_documents (version 7 = audio file)
        const { error: insErr } = await supabase.from('story_documents').insert({
          id: uuidv4(),
          user_id: currentUserId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          file_path: filePath,
          title: sanitized.replace(/\.(mp3|wav|flac|m4a|aac|ogg|wma)$/i, ''),
          description: 'Uploaded audio file for video generation',
          word_count: 0,
          version: 7,
          is_corrected: false,
          is_prompted: false,
          group_id: docGroupId,
          variant: 1,
          file_size: file.size,
        });
        if (insErr) throw insErr;

        // Reload audio list from story_documents to reflect the new entry
        const { data: audioDocs } = await supabase
          .from('story_documents')
          .select('id,title,file_path,audio_duration')
          .eq('user_id', currentUserId)
          .eq('group_id', docGroupId)
          .in('version', [7, 8, 9, 10])
          .order('created_at', { ascending: false });
        if (audioDocs) {
          setAudioFiles(audioDocs.map(ad => ({
            path: ad.file_path,
            name: ad.title || ad.file_path.split('/').pop() || 'Audio File',
            duration: ad.audio_duration || 0,
          })));
        }

        // Select the new file and calculate its duration
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

    // ── File upload ───────────────────────────────────────────────────────────
    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !currentUserId) return;
      setSelectedDoc('');
      setUploadError(null);
      if (file.type !== 'text/plain' && !file.name.endsWith('.txt')) {
        setUploadError('Please upload a .txt file'); return;
      }
      const nameErr = validateFileName(file.name);
      if (nameErr) { setUploadError(nameErr); return; }
      if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        setUploadError(`Max file size is ${MAX_FILE_SIZE_MB} MB`); return;
      }
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
            description: 'Uploaded document for TTV generation',
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

    // ── Polling ───────────────────────────────────────────────────────────────
    const startPolling = (gid: string, variant: number) => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      stoppedRef.current = false;

      const pollP1 = async () => {
        if (stoppedRef.current) return;
        try {
          const { data: tasks } = await supabase
            .from('TTV_prompt_tasks')
            .select('batch_number,total_batches,status,error,total_prompts,story_title,check_stuck')
            .eq('user_id', currentUserId!)
            .eq('group_id', gid)
            .eq('tab', currentTab)
            .eq('variant', variant)
            .or('video_process.is.null,video_process.eq.false');
          if (!tasks || tasks.length === 0) return;
          const total = tasks[0].total_batches ?? tasks.length;
          const done = tasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
          const errTask = tasks.find(t => t.status === 'error');
          if (errTask) {
            setError(errTask.error || 'TTV prompt generation failed');
            setGenerationState('error');
            if (pollingRef.current) clearInterval(pollingRef.current);
            return;
          }
          const title = (tasks[0] as any).story_title;
          if (title) setGenerationTitle(title);
          setStuckWarning(tasks.some(t => t.status === 'running' && (t as any).check_stuck === true));
          setPhaseOneProgress(total > 0 ? Math.min(100, (done / total) * 100) : 0);
          setStatusMessage(`Generating TTV prompts: ${done} / ${total} batches`);
          const remainingPromptBatches = total - done;
          const maxBatchTask = tasks.reduce((max, t) => t.batch_number > max.batch_number ? t : max, tasks[0]);
          const totalVideos = (maxBatchTask as any).total_prompts ?? 0;
          const secsPerVideo = TTV_SECONDS_PER_VIDEO[videoModel] ?? TTV_DEFAULT_SECONDS_PER_VIDEO;
          const videoTimeEstimate = totalVideos * secsPerVideo;
          setTimeRemaining(remainingPromptBatches * 60 + videoTimeEstimate);
          if (tasks.every(t => t.status === 'completed' || t.status === 'completed_final')) {
            setCurrentPhase('videos');
            setStatusMessage('TTV prompts complete — starting video generation…');
            if (pollingRef.current) clearInterval(pollingRef.current);
            pollingRef.current = setInterval(pollP2, POLLING_INTERVAL_P2);
            // Run one immediate check so we don't wait a full interval before first video status update
            pollP2();
          }
        } catch { /* retry */ }
      };

      const pollP2 = async () => {
        if (stoppedRef.current) return;
        try {
          const { data: tasks } = await supabase
            .from('TTV_tasks')
            .select('batch_number,total_batches,status,error,check_stuck')
            .eq('user_id', currentUserId!)
            .eq('group_id', gid)
            .eq('tab', currentTab)
            .eq('variant', variant)
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
          setPhaseTwoProgress(total > 0 ? Math.min(100, (done / total) * 100) : 0);
          setStatusMessage(`Generating videos: ${done} / ${total} complete`);
          const secsPerVideo = TTV_SECONDS_PER_VIDEO[videoModel] ?? TTV_DEFAULT_SECONDS_PER_VIDEO;
          setTimeRemaining((total - done) * secsPerVideo);
          if (tasks.length > 0 && tasks.every(t => t.status === 'completed' || t.status === 'completed_final')) {
            setGenerationState('complete');
            setCurrentPhase('complete');
            setPhaseTwoProgress(100);
            setTimeRemaining(0);
            setStatusMessage('All videos generated successfully!');
            if (pollingRef.current) clearInterval(pollingRef.current);
            // Mark the tab as complete in the DB so the tabs table reflects reality
            try {
              await updateTabStatus(currentUserId!, 'ttv', currentTab, 'complete', gid);
            } catch (e) { console.error('[TTV] Failed to update tab status to complete:', e); }
          }
        } catch { /* retry */ }
      };

      pollingRef.current = setInterval(pollP1, POLLING_INTERVAL_P1);
    };

    // ── Resume detection on re-mount ──────────────────────────────────────────
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => {
      if (!currentUserId) return;
      const checkForActiveGeneration = async () => {
        try {
          // ── Check for in-flight or completed single-TTV task ─────────────────
          const { data: singleTask } = await supabase
            .from('TTV_tasks')
            .select('id, status, video_url')
            .eq('user_id', currentUserId)
            .eq('tab', currentTab)
            .eq('single_ttv', true)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (singleTask?.status === 'running') {
            setInputMode('prompt');
            setSingleGenState('generating');
            setSingleTaskId(singleTask.id);
            return; // polling effect will take over
          }
          if (singleTask?.status === 'completed_final' && singleTask.video_url) {
            const { data: urlData } = await supabase.storage
              .from('stories')
              .createSignedUrl(singleTask.video_url, 3600);
            if (urlData?.signedUrl) {
              setInputMode('prompt');
              setSingleGenState('complete');
              setSingleTaskId(singleTask.id);
              setSingleVideoUrl(urlData.signedUrl);
              await updateTabStatus(currentUserId, 'ttv', currentTab, 'complete').catch(() => {});
            }
            return; // nothing more to restore
          }

          // Include both 'generating' and 'complete' so we can restore the completion
          // screen even after navigating away once all tasks finished.
          const { data: tab } = await supabase
            .from('tabs')
            .select('group_id, status')
            .eq('user_id', currentUserId)
            .eq('page', 'ttv')
            .eq('tab_number', currentTab)
            .in('status', ['generating', 'complete'])
            .maybeSingle();

          if (!tab?.group_id) return;

          // Tab already marked complete — restore the completion screen directly.
          // The useEffect watching generationState will call loadGeneratedVideos.
          if (tab.status === 'complete') {
            setGroupId(tab.group_id);
            setCurrentPhase('complete');
            setGenerationState('complete');
            setPhaseTwoProgress(100);
            setStatusMessage('All videos generated successfully!');
            return;
          }

          // Tab is still 'generating' — check tasks to determine phase
          const { data: promptTasks } = await supabase
            .from('TTV_prompt_tasks')
            .select('variant, status')
            .eq('user_id', currentUserId)
            .eq('group_id', tab.group_id)
            .eq('tab', currentTab)
            .or('video_process.is.null,video_process.eq.false');

          if (!promptTasks || promptTasks.length === 0) return;

          const variant = promptTasks[0].variant ?? 1;
          const allPromptsComplete = promptTasks.every(
            t => t.status === 'completed' || t.status === 'completed_final',
          );

          setGroupId(tab.group_id);
          setCurrentVariant(variant);

          // If prompts are already done, also check whether all video tasks are done
          if (allPromptsComplete) {
            const { data: videoTasks } = await supabase
              .from('TTV_tasks')
              .select('status')
              .eq('user_id', currentUserId!)
              .eq('group_id', tab.group_id)
              .eq('tab', currentTab)
              .or('video_process.is.null,video_process.eq.false');

            if (videoTasks && videoTasks.length > 0 && videoTasks.every(
              t => t.status === 'completed' || t.status === 'completed_final',
            )) {
              // Everything is already complete — go straight to done without starting a poller
              setCurrentPhase('complete');
              setGenerationState('complete');
              setPhaseTwoProgress(100);
              setStatusMessage('All videos generated successfully!');
              try {
                await updateTabStatus(currentUserId!, 'ttv', currentTab, 'complete', tab.group_id);
              } catch (e) { console.error('[TTV] Failed to update tab status to complete on resume:', e); }
              return;
            }
          }

          setCurrentPhase(allPromptsComplete ? 'videos' : 'prompts');
          setGenerationState('generating');
          setStatusMessage('Resuming generation…');
          startPolling(tab.group_id, variant);
        } catch (err) {
          console.error('[TTV] Resume detection error:', err);
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

      // Immediately update UI and tab to idle — tab color changes without waiting for cleanup
      setGenerationState('idle');
      setCurrentPhase('prompts');
      setPhaseOneProgress(0);
      setPhaseTwoProgress(0);
      setTimeRemaining(null);
      setGroupId(null);
      setCurrentVariant(null);
      setStatusMessage('');
      setStopRequested(false);
      updateTabStatus(currentUserId, 'ttv', currentTab, 'idle').catch(() => {});

      try {
        // Signal tasks to stop processing (filter video_process=false/null to avoid affecting Video Generator tasks)
        await supabase.from('TTV_prompt_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab).or('video_process.is.null,video_process.eq.false');
        await supabase.from('TTV_tasks').update({ stop_requested: true }).eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab).or('video_process.is.null,video_process.eq.false');

        // Find TTV_tasks folder_timestamp + story_title for storage cleanup
        const { data: ttvTasks } = await supabase
          .from('TTV_tasks')
          .select('folder_timestamp, story_title, video_url')
          .eq('user_id', currentUserId)
          .eq('group_id', groupId)
          .eq('tab', currentTab)
          .or('video_process.is.null,video_process.eq.false');

        // Delete generated video files from storage
        const folderTask = ttvTasks?.find((t: any) => t.folder_timestamp);
        if (folderTask?.folder_timestamp && folderTask?.story_title) {
          // Mirror the sanitizeTitle + TTV- prefix logic used in the process-TTV edge function
          const sanitizedTitle = folderTask.story_title
            .replace(/^TTV Prompt[s]?:\s*/i, '')
            .replace(/[^a-zA-Z0-9\s-]/g, '.')
            .toLowerCase()
            .trim()
            .replace(/\s+/g, '-');
          const folderPath = `documents/${currentUserId}/${groupId}/TTV-${sanitizedTitle}_${folderTask.folder_timestamp}`;
          console.log(`[TTV Stop] Deleting video folder: ${folderPath}`);
          const { data: files } = await supabase.storage.from('stories').list(folderPath);
          if (files && files.length > 0) {
            await supabase.storage.from('stories').remove(files.map((f: any) => `${folderPath}/${f.name}`));
            console.log(`[TTV Stop] Deleted ${files.length} video file(s)`);
          }
        }

        // Delete task rows (filter video_process=false/null to avoid affecting Video Generator tasks)
        await supabase.from('TTV_tasks').delete().eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab).or('video_process.is.null,video_process.eq.false');
        await supabase.from('TTV_prompt_tasks').delete().eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab).or('video_process.is.null,video_process.eq.false');
        await supabase.from('TTV_prompt_context').delete().eq('group_id', groupId).eq('tab', currentTab);

      } catch (err) {
        console.error('Stop cleanup error:', err);
      }
    };

    // ── Generate ──────────────────────────────────────────────────────────────
    const handleGenerate = async () => {
      const doc = getSelectedDocument();
      if (!doc) { setError('Please select a document'); return; }
      if (!videoModel) { setError('Please select a video model'); return; }
      const activeStyle = isCustomStyle ? customStyleText : videoStyle;
      if (!activeStyle) { setError('Please select a visual style'); return; }
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
      setCurrentPhase('prompts');
      setPhaseOneProgress(0);
      setPhaseTwoProgress(0);
      setStatusMessage('Preparing TTV generation…');
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
        await ensureTabExists(user.id, 'ttv');
        await updateTabStatus(user.id, 'ttv', currentTab, 'generating', gid, doc.title);
        const effectiveDuration = getEffectiveDuration();
        const effectiveAudioDuration = totalAudioDuration;
        if (effectiveAudioDuration <= 0) throw new Error('Cannot determine story duration.');
        const { data: { session: _ttvSession } } = await supabase.auth.getSession();
        const response = await withTimeout(
          fetchWithFallback('https://setup-ttv-prompts.storyscriptai.deno.net', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${_ttvSession?.access_token || ''}`,
              'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
            },
            body: JSON.stringify({
              user_id: user.id,
              group_id: gid,
              file_path: doc.file_path,
              story_title: doc.title,
              description: doc.description || doc.title,
              style: activeStyle,
              video_model: useHighRes && videoModel === 'grok' ? 'grok_highres'
                : useHighRes && videoModel === 'sora2pro' ? 'sora2pro_highres'
                : videoModel,
              video_duration: effectiveDuration,
              totalAudioDuration: effectiveAudioDuration,
              useCharacterDescriptions,
              customCharactersEnabled,
              customCharacters: customCharactersEnabled ? customCharacters.filter(c => c.name.trim()) : [],
              customCharactersAIEnhance,
              model: promptModel,
              language,
              tab: currentTab,
              variant,
              userTokenBalance,
              masterPromptData: null,
              environmentOnlyMode: false,
              audio_clip: useAudioClip,
            }),
          }).then(async res => {
            if (!res.ok) {
              const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
              throw new Error(err.error || `HTTP ${res.status}`);
            }
            return res.json();
          }),
          180000,
          'setupTTVPrompts',
        );
        if (response.error) throw new Error(response.error);
        setStatusMessage(`Setup complete — ${response.total_videos} videos queued. Generating prompts…`);
        startPolling(gid, variant);
      } catch (err: any) {
        setError(err.message || 'An error occurred during generation');
        setGenerationState('error');
      }
    };

    // ── Generate (Individual Prompt mode) ────────────────────────────────────
    const handleGenerateSingle = async () => {
      if (!singlePrompt.trim()) { setError('Please enter a video prompt'); return; }
      if (!videoModel) { setError('Please select a video model'); return; }
      const effectiveModel = useHighRes && videoModel === 'grok' ? 'grok_highres'
        : useHighRes && videoModel === 'sora2pro' ? 'sora2pro_highres'
        : videoModel;
      const tps = TTV_TOKENS_PER_SECOND[effectiveModel] ?? 6000;
      const reqTokens = Math.round(getEffectiveDuration() * tps);
      if (reqTokens > userTokenBalance) {
        setError(`Insufficient tokens. Required: ${formatNumber(reqTokens)}, Available: ${formatNumber(userTokenBalance)}`);
        return;
      }
      setError(null);
      setSingleGenState('generating');
      setSingleVideoUrl(null);
      setSingleTaskId(null);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Not authenticated');
        const gid = uuidv4();
        if (currentUserId) await updateTabStatus(currentUserId, 'ttv', currentTab, 'generating', gid, 'Single Video Clip');
        const response = await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/single-TTV`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            group_id: gid,
            story_title: 'single_ttv',
            prompt: singlePrompt.trim(),
            style_prompt: isCustomStyle ? customStyleText : videoStyle,
            video_model: effectiveModel,
            video_duration: getEffectiveDuration(),
            audio_clip: useAudioClip,
            tab: currentTab,
          }),
        });
        if (!response.ok && response.status !== 202) {
          const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
          throw new Error((err as any).error || `HTTP ${response.status}`);
        }
        const data = await response.json();
        setSingleTaskId(data.task_id);
      } catch (err: any) {
        setError(err.message || 'Failed to start single TTV generation');
        setSingleGenState('error');
      }
    };

    // ── Done (Individual Prompt — delete file, delete DB row, reset state) ─────
    const handleDoneSingle = async () => {
      // Immediately update UI and tab to idle
      setSingleGenState('idle');
      if (currentUserId) {
        updateTabStatus(currentUserId, 'ttv', currentTab, 'idle').catch(() => {});
      }
      setSingleDoneLoading(true);
      try {
        if (singleTaskId) {
          // Fetch the task to get the storage path before deleting the row
          const { data: task } = await supabase
            .from('TTV_tasks')
            .select('video_url')
            .eq('id', singleTaskId)
            .maybeSingle();

          // Delete the video file (and its virtual folder) from storage
          if (task?.video_url) {
            await supabase.storage.from('stories').remove([task.video_url]);
          }

          // Delete the TTV_tasks row
          await supabase.from('TTV_tasks').delete().eq('id', singleTaskId);
        }

      } catch (err) {
        console.error('[TTV] Single-TTV done cleanup error:', err);
      } finally {
        setSingleVideoUrl(null);
        setSingleTaskId(null);
        setSingleDoneLoading(false);
      }
    };

    // ── Done (complete state — clean up DB rows, keep files, reset state) ──────
    const handleDone = async () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      const doneGroupId = groupId;
      const doneUserId = currentUserId;

      // Reset local state immediately so UI responds
      setGenerationState('idle');
      setCurrentPhase('prompts');
      setPhaseOneProgress(0);
      setPhaseTwoProgress(0);
      setTimeRemaining(null);
      setStatusMessage('');
      setError(null);
      setGroupId(null);
      setCurrentVariant(null);
      setGeneratedVideos([]);
      setRedoingVideo(null);
      setShowVideos(false);

      // Fire-and-forget tab update immediately so tab color changes without waiting for cleanup
      if (doneUserId) {
        updateTabStatus(doneUserId, 'ttv', currentTab, 'idle').catch(() => {});
      }

      // Clean up DB rows (no file deletion — generation is complete, documents are saved)
      try {
        if (doneUserId && doneGroupId) {
          await supabase.from('TTV_tasks').delete().eq('user_id', doneUserId).eq('group_id', doneGroupId).eq('tab', currentTab).or('video_process.is.null,video_process.eq.false');
          await supabase.from('TTV_prompt_tasks').delete().eq('user_id', doneUserId).eq('group_id', doneGroupId).eq('tab', currentTab).or('video_process.is.null,video_process.eq.false');
          await supabase.from('TTV_prompt_context').delete().eq('group_id', doneGroupId).eq('tab', currentTab);
          console.log(`[TTV] Done cleanup complete for groupId: ${doneGroupId}`);
        }
      } catch (err) {
        console.error('[TTV] Done cleanup error:', err);
      }
    };

    // ── Download all generated video clips as a ZIP ─────────────────────────
    const handleDownloadAll = async () => {
      if (generatedVideos.every(v => !v)) return;
      setIsDownloadingZip(true);
      setZipDownloadProgress(0);
      try {
        const validEntries = generatedVideos
          .map((url, i) => ({ url, clipNum: i + 1 }))
          .filter(e => !!e.url);
        if (validEntries.length === 0) throw new Error('No video clips could be downloaded');

        const zip = new JSZip();
        let filesAdded = 0;
        const N = validEntries.length;
        const clipShare = 80 / N; // each clip owns an equal slice of the 0-80% range

        // Phase 1: stream each clip, tracking bytes for smooth progress
        for (let i = 0; i < N; i++) {
          const { url, clipNum } = validEntries[i];
          const clipBase = i * clipShare;
          try {
            const response = await fetch(url!);
            if (!response.ok) { console.error(`Failed to fetch clip ${clipNum}`); continue; }

            const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);

            if (contentLength > 0 && response.body) {
              // Stream with per-byte progress within this clip's share
              const reader = response.body.getReader();
              const chunks: Uint8Array[] = [];
              let received = 0;
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                const pct = Math.min(
                  Math.round(clipBase + (received / contentLength) * clipShare),
                  79,
                );
                setZipDownloadProgress(pct);
              }
              const blob = new Blob(chunks as BlobPart[], { type: 'video/mp4' });
              zip.file(`clip-${clipNum}.mp4`, blob);
            } else {
              // No Content-Length — grab as blob then jump to end of this clip's share
              const blob = await response.blob();
              zip.file(`clip-${clipNum}.mp4`, blob);
            }
            filesAdded++;
          } catch (err) {
            console.error(`Error fetching clip ${clipNum}:`, err);
          }
          // Always advance to the end of this clip's share
          setZipDownloadProgress(Math.round(clipBase + clipShare));
        }

        if (filesAdded === 0) throw new Error('No video clips could be downloaded');

        // Phase 2: generate ZIP (80% → 100%), using JSZip's onUpdate callback
        const zipBlob = await zip.generateAsync(
          { type: 'blob' },
          (metadata) => {
            const pct = 80 + Math.round(metadata.percent * 0.2);
            setZipDownloadProgress(Math.min(pct, 100));
          },
        );

        // Match the zip filename to the title shown in the Documents page (doc.title from story_documents)
        let zipTitle = 'videos';
        if (groupId) {
          try {
            const { data: docRow } = await supabase
              .from('story_documents')
              .select('title')
              .eq('group_id', groupId)
              .in('version', [14, 15])
              .limit(1)
              .maybeSingle();
            if (docRow?.title) zipTitle = docRow.title;
          } catch { /* ignore, fall back below */ }
        }
        // Fallback: reconstruct using the same logic as process-TTV edge function
        if (zipTitle === 'videos' && generationTitle) {
          const cleanTitle = generationTitle
            .replace(/^TTV Prompt:\s*/i, '')
            .replace(/^TTV Prompts:\s*/i, '')
            .trim();
          zipTitle = `TTV Outputs: ${cleanTitle}`;
        }
        saveAs(zipBlob, `${zipTitle}.zip`);
      } catch (err: any) {
        console.error('[TTV] Error creating ZIP:', err);
        setError(err.message || 'Failed to download ZIP');
      } finally {
        setIsDownloadingZip(false);
        setZipDownloadProgress(0);
      }
    };

    // ── Derived values ────────────────────────────────────────────────────────
    const selectedDocument = getSelectedDocument();
    const wordCount = selectedDocument?.word_count ?? 0;
    const effectiveDuration = getEffectiveDuration();
    const selectedModelCfg = VIDEO_MODEL_OPTIONS.find(m => m.value === videoModel);
    const isGenerating = generationState === 'generating';
    const isComplete = generationState === 'complete';
    const activeStyle = isCustomStyle ? customStyleText : videoStyle;

    const canGenerate =
      !!selectedDocument &&
      !!videoModel &&
      !!activeStyle &&
      !!estimate &&
      estimate.totalTokens <= userTokenBalance &&
      (storageUsed === null || estimate.storageNeededMB <= (maxStorageGB * 1024) - storageUsed) &&
      totalAudioDuration > 0 &&
      !isGenerating;

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

          <div className={userPlan === 'free' ? 'relative' : ''}>

            {/* ── Free plan gate ── */}
            {userPlan === 'free' && (
              <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-12 z-50">
                <div className="rounded-2xl bg-surface-card border border-border-card p-8 max-w-md w-full shadow-[0_0_40px_rgba(220,38,38,0.08)]">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="pipeline-icon-circle inline-flex items-center justify-center w-10 h-10 rounded-full bg-accent/5">
                      <Lock className="h-5 w-5 text-accent-text" />
                    </div>
                    <h2 className="text-lg sm:text-xl font-display font-semibold text-white">Paid Feature</h2>
                  </div>
                  <p className="text-sm text-text-muted mb-6 leading-relaxed">Text-To-Video Generator requires a paid plan. Upgrade to unlock video generation and all tools.</p>
                  <button
                    onClick={() => navigate('/pricing')}
                    className="w-full flex justify-center items-center gap-2 px-6 py-3 bg-accent text-white rounded-xl hover:bg-accent-hover transition-all duration-200 text-sm font-medium hover:scale-[1.01] active:scale-[0.99]"
                  >
                    View Plans
                  </button>
                </div>
              </div>
            )}

            <div className={userPlan === 'free' ? 'opacity-50 pointer-events-none' : ''}>

              {/* ── Header ── */}
              <div className="relative mb-8 dash-animate-in">
                <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Text-To-Video Generator</h1>
                <div className="mt-2">
                  <p className="text-text-secondary">Transform your story script into a series of AI-generated video clips</p>
                  <p className="text-text-muted text-sm mt-1">{formatNumber(userTokenBalance)} tokens remaining</p>
                  <p className="text-text-muted text-sm mt-0.5">
                    Storage: {storageUsed !== null
                      ? `${formatStorageSize(storageUsed)} / ${maxStorageGB} GB`
                      : 'Calculating...'}
                  </p>
                </div>

              {/* ── What to Expect ── */}
              <div className="mt-5 p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card dash-animate-in">
                <h3 className="text-xl font-semibold mb-2 text-accent">What to Expect</h3>
                <p className="text-[15px] text-white/80 leading-relaxed">
                  The Text-To-Video Generator takes your story document and turns it into a full series of AI-generated video clips, one per scene. Choose from 9 state-of-the-art video models, pick a visual style, and the system handles everything — generating detailed video prompts, queueing clips, and returning finished videos ready to combine in the Video Combiner.
                </p>
                <Link
                  to="/learn#text-to-video"
                  className="group relative inline-flex items-center gap-1.5 px-5 py-2.5 mt-3 rounded-lg text-sm font-medium text-white bg-accent transition-all duration-300 hover:bg-accent-hover hover:scale-[1.02] active:scale-[0.98]"
                  style={{
                    boxShadow: '0 0 20px rgba(220,38,38,0.2), 0 0 40px rgba(220,38,38,0.06)',
                  }}
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  Watch tutorial
                </Link>
                <div className="mt-4 pt-4 border-t border-white/10">
                  <p className="text-sm text-text-muted leading-relaxed">
                    Select a story document, choose a video model and visual style, then hit Generate. The system splits your text into scenes, writes optimized video prompts, and queues each clip automatically.
                  </p>
                </div>
              </div>

              {/* ── Tab Manager (enterprise) ── */}
              {isEnterpriseUser && currentUserId && (
                <TabManager
                  userId={currentUserId}
                  isEnterpriseUser={isEnterpriseUser}
                  initialTabs={initialTabs}
                  currentTab={currentTab}
                  page="ttv"
                  onTabChange={(tab) => onTabChange?.(tab, groupId ?? '')}
                  onTabCreate={(tab) => onTabCreate?.(tab, groupId ?? '')}
                  onTabClose={(tab) => onTabClose?.(tab, groupId ?? '')}
                />
              )}
              </div>

              {/* ── Error banner ── */}
              {error && (
                <div className="p-5 rounded-2xl bg-[--color-status-error-bg] border border-[--color-status-error-border] mb-6 dash-animate-in">
                  <div className="flex items-center space-x-3">
                    <div className="flex-shrink-0 h-10 w-10 rounded-full bg-[--color-status-error-bg] flex items-center justify-center">
                      <AlertCircle className="h-5 w-5 text-status-error" />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-lg font-display font-semibold text-status-error">Error</h3>
                      <p className="text-sm mt-0.5 text-status-error/80">{error}</p>
                    </div>
                    <button onClick={() => setError(null)} className="text-status-error hover:text-status-error/80 shrink-0">
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                </div>
              )}

              {/* ── Generating banner ── */}
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

              {/* ── Completion banner ── */}
              {isComplete && (
                <StatusBanner
                  variant="success"
                  title={<>Videos Generated{generationTitle ? ` for ${generationTitle}` : ''}!</>}
                  subtitle="All video clips have been generated and saved to your Documents."
                />
              )}

              {/* ── Individual Prompt — generating banner ── */}
              {singleGenState === 'generating' && (
                <StatusBanner
                  variant="info"
                  title="Generating Video…"
                  subtitle="Your individual video clip is being generated. This may take a few minutes."
                />
              )}

              {/* ── Individual Prompt — completion banner ── */}
              {singleGenState === 'complete' && (
                <StatusBanner
                  variant="success"
                  title="Video Generated!"
                  subtitle="Your individual video clip is ready. Download it or press Done to generate another."
                />
              )}

              {/* ── Configuration ── */}
              <div
                className="dash-collapse-grid"
                data-collapsed={isGenerating || isComplete || singleGenState === 'generating' || singleGenState === 'complete' ? 'true' : 'false'}
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
                        <div className="text-xs sm:text-sm text-text-muted mt-1">Generate videos from a story document</div>
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
                        <div className="text-xs sm:text-sm text-text-muted mt-1">Generate a single video from a prompt</div>
                      </button>
                    </div>
                  </div>

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
                        {wordCount > 0 && (
                          <>
                            <span>·</span>
                            <span>~{formatDuration(wordCount / WORDS_PER_SECOND)} estimated audio</span>
                          </>
                        )}
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

                  {/* ═══ Individual Prompt Input ═══ */}
                  {inputMode === 'prompt' && (
                  <div className="bg-surface-card rounded-xl p-6">
                    <h2 className="text-xl font-semibold text-white mb-4">Individual Video Generation</h2>
                    <p className="text-text-muted mb-6">
                      Generate a single video clip from your own prompt. Perfect for quick clips or testing different models and styles.
                    </p>
                    <div>
                      <label className="block text-sm font-medium text-white mb-3">Video Prompt</label>
                      <textarea
                        value={singlePrompt}
                        onChange={e => setSinglePrompt(e.target.value)}
                        placeholder="Describe the scene in detail — setting, action, lighting, mood, camera movement…"
                        rows={10}
                        disabled={singleGenState !== 'idle'}
                        className="w-full bg-surface-elevated text-white rounded-md p-3 mb-2 focus:outline-none focus:ring-2 focus:ring-accent-text resize-none"
                      />
                      <div className="flex justify-between text-xs text-text-dim">
                        <span>{singlePrompt.length} characters</span>
                      </div>
                    </div>
                  </div>
                  )}

                  {/* ═══ Video Model ═══ */}
                  <div className="mb-4">
                    <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">
                      Video Quality Model
                    </label>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      {VIDEO_MODEL_OPTIONS.map((opt) => {
                        const isSelected = videoModel === opt.value;
                        const durationLabel =
                          opt.durationType === 'fixed'
                            ? `${opt.defaultDuration}s`
                            : opt.durationType === 'slider'
                            ? `${opt.durationMin}–${opt.durationMax}s`
                            : (opt.durationOptions ?? []).map(d => `${d}s`).join('/');
                        return (
                          <button
                            key={opt.value}
                            onClick={() => {
                              setVideoModel(opt.value);
                              if (opt.durationType === 'slider') setSliderInputValue(String(opt.defaultDuration));
                              setVideoDuration(opt.defaultDuration);
                              if (!HIGH_RES_SUPPORTED_MODELS.has(opt.value)) setUseHighRes(false);
                            }}
                            className={`relative p-3 rounded-xl border transition-all duration-200 text-left ${
                              isSelected
                                ? `${opt.borderColor} ${opt.bgColor} ${opt.textColor}`
                                : 'border-white/10 bg-surface-input text-text-muted hover:border-white/20 hover:text-white/80'
                            }`}
                          >
                            {opt.recommended && (
                              <div className="absolute -top-2 -right-2 bg-accent text-white text-[10px] font-mono tracking-wide px-2 py-0.5 rounded-full">
                                Recommended
                              </div>
                            )}
                            <div className="font-medium text-sm">{opt.label}</div>
                            <div className="text-xs opacity-75 mt-0.5">{opt.resolution} · {durationLabel}</div>
                            <div className="text-xs opacity-60 mt-0.5">{(opt.tokensPerSecond / 1000).toFixed(0)}K tokens/s · {opt.description}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* ═══ Video Model Options ═══ */}
                  {videoModel && selectedModelCfg && (
                  <div className="bg-surface-card rounded-xl border border-border-card p-5">
                    <h2 className="text-base font-semibold text-white mb-1">Model Settings</h2>
                    <p className="text-xs text-text-dim mb-4">{selectedModelCfg.label} — {selectedModelCfg.description}</p>

                    {/* Duration selector */}
                    {selectedModelCfg.durationType !== 'fixed' && (
                      <div>
                        <label className="block text-sm text-text-dim mb-2">Clip Durations</label>
                        {selectedModelCfg.durationType === 'options' && selectedModelCfg.durationOptions && (
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
                          const maxVal = selectedModelCfg.durationMax ?? 30;
                          const parsed = parseInt(sliderInputValue);
                          const isOutOfRange = sliderInputValue !== '' && (isNaN(parsed) || parsed < minVal || parsed > maxVal);
                          return (
                            <div className="space-y-2">
                              <div className="flex items-center gap-3">
                                <input
                                  type="range"
                                  min={minVal}
                                  max={maxVal}
                                  step={1}
                                  value={videoDuration}
                                  onChange={e => {
                                    const v = parseInt(e.target.value);
                                    setVideoDuration(v);
                                    setSliderInputValue(String(v));
                                  }}
                                  className="flex-1 accent-indigo-500"
                                />
                                <input
                                  type="number"
                                  min={minVal}
                                  max={maxVal}
                                  value={sliderInputValue}
                                  onChange={e => {
                                    setSliderInputValue(e.target.value);
                                    const v = parseInt(e.target.value);
                                    if (!isNaN(v) && v >= minVal && v <= maxVal) {
                                      setVideoDuration(v);
                                    }
                                  }}
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
                        <span>Clip durations:</span>
                        <span className={`font-medium ${selectedModelCfg.textColor}`}>{selectedModelCfg.defaultDuration}s (fixed)</span>
                      </div>
                    )}

                    {/* ── High Resolution toggle (Grok + LTX only) ── */}
                    {HIGH_RES_SUPPORTED_MODELS.has(videoModel) && (
                      <div className="mt-5 pt-5 border-t border-border">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <label className="flex items-center text-sm font-medium text-text-muted">
                              High Resolution
                            </label>
                            <p className="mt-1 text-xs text-text-dim">
                              {videoModel === 'grok'
                                ? 'Upgrade from 480p to 720p output.'
                                : 'Upgrade from 1080p to 4K (3840×2160) output.'}
                            </p>
                            {useHighRes && (
                              <p className="mt-2 text-xs text-status-warning flex items-center gap-1">
                                <AlertCircle className="h-3 w-3 flex-shrink-0" />
                                {videoModel === 'grok'
                                  ? `Higher resolution costs more: ${fmtKps(TTV_TOKENS_PER_SECOND.grok_highres ?? 0)} tokens/s (vs ${fmtKps(TTV_TOKENS_PER_SECOND.grok ?? 0)} at 480p)`
                                  : `Higher resolution costs significantly more: ${fmtKps(TTV_TOKENS_PER_SECOND.sora2pro_highres ?? 0)} tokens/s (vs ${fmtKps(TTV_TOKENS_PER_SECOND.sora2pro ?? 0)} at 1080p)`}
                              </p>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => setUseHighRes(!useHighRes)}
                            className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${useHighRes ? 'bg-accent' : 'bg-surface-elevated'}`}
                          >
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${useHighRes ? 'translate-x-6' : 'translate-x-1'}`} />
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ── Audio Clip toggle ── */}
                    {AUDIO_CLIP_SUPPORTED_MODELS.has(videoModel) && (
                    <div className="mt-5 pt-5 border-t border-border">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <label className="flex items-center text-sm font-medium text-text-muted">
                            Audio Clips
                          </label>
                          <p className="mt-1 text-xs text-text-dim">
                            Embed audio atmosphere descriptions inside each video prompt so the model generates clips with matching sound design.
                          </p>
                          {useAudioClip && (
                            <p className="mt-2 text-xs text-status-warning flex items-center gap-1">
                              <AlertCircle className="h-3 w-3 flex-shrink-0" />
                              Audio clips can sound strange with text-to-speech audio overlay on a final video.
                            </p>
                          )}
                          {useAudioClip && (videoModel === 'veo31fast' || videoModel === 'veo31') && (
                            <p className="mt-1 text-xs text-action-orange">
                              ⚡ Veo audio mode: {fmtKps(AUDIO_TOKENS_PER_SECOND[videoModel] ?? 0)} tokens/s
                              &nbsp;(vs {fmtKps(TTV_TOKENS_PER_SECOND[videoModel] ?? 0)} without audio)
                            </p>
                          )}
                          {useAudioClip && (videoModel === 'ltx23_fast' || videoModel === 'ltx23_pro') && (
                            <p className="mt-1 text-xs text-action-orange">
                              🔊 LTX-2.3 generates native AI audio.
                            </p>
                          )}
                          {useAudioClip && videoModel === 'seedance15_pro' && (
                            <p className="mt-1 text-xs text-action-orange">
                              ⚡ Seedance 1.5 Pro audio mode: {fmtKps(AUDIO_TOKENS_PER_SECOND.seedance15_pro ?? 0)} tokens/s (vs {fmtKps(TTV_TOKENS_PER_SECOND.seedance15_pro ?? 0)} without audio)
                            </p>
                          )}
                          {(videoModel === 'grok' || videoModel === 'sora2pro' || videoModel === 'sora2pro_highres') && (
                            <p className="mt-1 text-xs text-text-dim">
                              {useAudioClip
                                ? `🔊 ${videoModel.startsWith('sora') ? 'Sora' : 'Grok'} always generates audio — clip will include AI sound design.`
                                : `🔇 ${videoModel.startsWith('sora') ? 'Sora' : 'Grok'} always generates audio — audio track will be stripped in post-processing.`}
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

                  {/* ═══ Visual Style ═══ */}
                  <div>
                    <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-4">Visual Style</label>

                    <div className="grid md:grid-cols-2 gap-6">
                      {TTV_STYLES.slice(0, showAllStyles ? TTV_STYLES.length : 4).map((s) => (
                        <StyleVideoCard
                          key={s.name}
                          name={s.name}
                          description={s.description}
                          videoUrl={getStyleVideoUrl(videoModel, s.videoFileName)}
                          isSelected={!isCustomStyle && videoStyle === s.style}
                          onClick={() => { setVideoStyle(s.style); setIsCustomStyle(false); }}
                        />
                      ))}
                    </div>

                    {TTV_STYLES.length > 4 && (
                      <div className="flex justify-center mt-4">
                        <button
                          onClick={() => setShowAllStyles(prev => !prev)}
                          className="px-4 py-2 bg-white/10 text-white rounded-xl hover:bg-white/15 transition-colors"
                        >
                          {showAllStyles ? 'Show Less' : `Show More +${TTV_STYLES.length - 4}`}
                        </button>
                      </div>
                    )}

                    {/* Custom style */}
                    <div className="mt-6 rounded-xl overflow-hidden border border-border-card">
                      <div className="p-4">
                        <h3 className="text-lg font-medium text-white mb-2">Custom Style</h3>
                        <textarea
                          value={isCustomStyle ? customStyleText : ''}
                          onChange={e => { setCustomStyleText(e.target.value.slice(0, 1200)); setIsCustomStyle(true); }}
                          onClick={() => setIsCustomStyle(true)}
                          placeholder="Describe your custom video style in detail, e.g. 'Watercolor painting with warm earth tones, impressionist brushwork, soft natural lighting...'"
                          rows={6}
                          maxLength={1200}
                          className="w-full bg-surface-input border border-white/[0.13] rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 placeholder:text-white/40"
                        />
                        <div className="mt-1 text-xs text-text-muted text-right">
                          {(isCustomStyle ? customStyleText : '').length} / 1200
                        </div>
                        {isCustomStyle && (
                          <div className="mt-1 text-sm text-status-warning">
                            Custom styles can use all video models.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* ═══ Generation Settings ═══ */}
                  {inputMode === 'document' && (
                  <div className="relative z-10" style={{ zoom: 1 / 1.1 }}>
                    <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-4">Generation Settings</label>
                    <div className="space-y-4">

                      {/* Character consistency toggle */}
                      <div className="p-5 rounded-2xl bg-surface-card border border-border-card">
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="text-white font-medium">Character Consistency</h3>
                            <p className="text-text-muted text-sm mt-2">Maintain consistent character descriptions across all clips</p>
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
                      </div>

                      {/* Custom Characters Section - only visible when Character Consistency is ON */}
                      {useCharacterDescriptions && (
                        <div className="rounded-2xl bg-surface-card border border-border-card p-5 space-y-4">
                          {/* Custom Characters Toggle */}
                          <div className="flex items-center justify-between">
                            <div>
                              <h3 className="text-white font-medium">Custom Characters</h3>
                              <p className="text-text-muted text-sm mt-1">Define your own character descriptions instead of auto-extracting from the story</p>
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
                                <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">
                                  Character Descriptions
                                  <span className="text-white/40 ml-2 normal-case tracking-normal">(Max 10)</span>
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
                                          className="mt-1 p-2 text-status-error hover:text-status-error hover:bg-white/[0.08] rounded-lg"
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
                              <div className="flex items-start justify-between pt-3 border-t border-border-card">
                                <div className="flex-1">
                                  <label className="flex items-center text-sm font-medium text-white">
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

                      {/* Language dropdown */}
                      <div>
                        <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">Language</label>
                        <Listbox value={language} onChange={setLanguage}>
                          {({ open }) => (
                            <div className="relative">
                              <Listbox.Button className="relative w-full bg-surface-input border border-white/[0.13] rounded-xl px-5 py-4 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 cursor-pointer hover:bg-surface-input">
                                <span className="block truncate">
                                  {LANGUAGE_OPTIONS.find(o => o.value === language)?.label || 'English'}
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
                                  {LANGUAGE_OPTIONS.map(opt => (
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

                      {/* AI Writing Model dropdown */}
                      <div>
                        <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">AI Writing Model</label>
                        <Listbox value={promptModel} onChange={setPromptModel}>
                          {({ open }) => (
                            <div className="relative">
                              <Listbox.Button className="relative w-full bg-surface-input border border-white/[0.13] rounded-xl px-5 py-4 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 cursor-pointer hover:bg-surface-input">
                                <span className="block truncate">
                                  {MODEL_OPTIONS.find(o => o.value === promptModel)?.label || 'Core Model'}
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
                                  {MODEL_OPTIONS.map(opt => (
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
                          Selected: {MODEL_OPTIONS.find(o => o.value === promptModel)?.label || 'Core Model'} ({MODEL_OPTIONS.find(o => o.value === promptModel)?.description})
                        </p>
                      </div>

                    </div>
                  </div>
                  )}

                  {/* ═══ Video Frequency ═══ */}
                  {inputMode === 'document' && (
                  <div>
                    <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Video Frequency</label>
                    <p className="text-xs text-text-dim mb-4">Determines how many video clips will be generated</p>

                    {/* Info box */}
                    <div className="bg-[--color-status-info-bg] border border-[--color-status-info-border] rounded-xl p-3 mb-4 flex gap-2">
                      {calculatingDuration ? (
                        <>
                          <RefreshCw className="w-5 h-5 text-status-info flex-shrink-0 mt-0.5 animate-spin" />
                          <div className="text-sm text-status-info">
                            <strong>Calculating Audio Duration…</strong> This may take a moment. Please wait.
                          </div>
                        </>
                      ) : (
                        <>
                          <Info className="w-5 h-5 text-status-info flex-shrink-0 mt-0.5" />
                          <div className="text-sm text-status-info">
                            <strong>Audio Runtime Mode:</strong> Specify exactly how many video clips you want for your audio duration. Upload or select audio files that match your selected story.
                          </div>
                        </>
                      )}
                    </div>

                    {!selectedDocument ? (
                      <div className="bg-status-warning border border-status-warning rounded-xl p-3 flex gap-2">
                        <AlertCircle className="w-5 h-5 text-status-warning flex-shrink-0 mt-0.5" />
                        <div className="text-sm text-status-warning-text">
                          <strong>Story Required:</strong> Please select or upload a story document first.
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {/* Select Existing Audio */}
                        <div className="space-y-2">
                          <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-1">Select Existing Audio</label>
                          {loadingAudioFiles ? (
                            <div className="flex items-center gap-2 text-sm text-text-dim p-3 bg-surface-elevated rounded-xl">
                              <RefreshCw className="h-4 w-4 animate-spin" />
                              Loading audio files…
                            </div>
                          ) : (
                            <Listbox
                              value={selectedAudioPath}
                              onChange={(value) => {
                                setSelectedAudioPath(value);
                                setAudioDurationError(null);
                                if (!value) {
                                  setTotalAudioDuration(0);
                                  return;
                                }
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
                                  <Listbox.Button className={`relative w-full bg-surface-input border border-white/[0.13] rounded-xl px-5 py-4 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 ${calculatingDuration ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-surface-input'}`}>
                                    <span className="block truncate">
                                      {selectedAudioPath
                                        ? audioFiles.find(f => f.path === selectedAudioPath)?.name
                                        : <span className="italic text-text-dim">None – Upload New Audio</span>}
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
                                      <Listbox.Option
                                        value=""
                                        className={({ active, selected }) =>
                                          `relative cursor-pointer select-none py-3 px-4 flex justify-between items-center ${
                                            active ? 'bg-white/[0.08] text-white' : 'text-text-secondary'
                                          } ${selected ? 'font-medium' : 'font-normal'}`
                                        }
                                      >
                                        {({ selected }) => (
                                          <>
                                            <span className={`italic text-sm ${selected ? 'text-text-secondary font-medium' : 'text-text-dim'}`}>
                                              None – Upload New Audio
                                            </span>
                                            {selected && <span className="text-accent-text"><CheckCircle2 className="h-5 w-5" /></span>}
                                          </>
                                        )}
                                      </Listbox.Option>
                                      {audioFiles.map((af) => (
                                        <Listbox.Option
                                          key={af.path}
                                          value={af.path}
                                          className={({ active, selected }) =>
                                            `relative cursor-pointer select-none py-3 px-4 flex justify-between items-center ${
                                              active ? 'bg-white/[0.08] text-white' : 'text-text-secondary'
                                            } ${selected ? 'font-medium' : 'font-normal'}`
                                          }
                                        >
                                          {({ selected }) => (
                                            <>
                                              <span className={selected ? 'font-medium text-white' : 'font-normal'}>
                                                {af.name}
                                              </span>
                                              {selected && <span className="text-accent-text"><CheckCircle2 className="h-5 w-5" /></span>}
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
                          {calculatingDuration && (
                            <div className="flex items-center gap-2 text-sm text-text-dim">
                              <RefreshCw className="h-3 w-3 animate-spin" />
                              Calculating duration…
                            </div>
                          )}
                          {audioDurationError && (
                            <p className="text-xs text-status-error">{audioDurationError}</p>
                          )}
                        </div>

                        {/* Upload New Audio — hidden once an existing audio file is selected */}
                        {!selectedAudioPath && (
                        <div className="space-y-2">
                          <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-1">Upload New Audio</label>
                          <label className={`flex flex-col items-center justify-center w-full h-28 border-2 border-dashed rounded-xl transition-colors ${uploadingAudio || calculatingDuration ? 'border-white/[0.13] bg-surface-input cursor-not-allowed opacity-60' : 'border-white/[0.13] bg-surface-input hover:bg-surface-input/80 hover:border-white/[0.2] cursor-pointer'}`}>
                            <div className="flex flex-col items-center justify-center py-4 text-center w-full px-4">
                              {uploadingAudio ? (
                                <>
                                  <RefreshCw className="h-5 w-5 text-status-info animate-spin mb-2" />
                                  <p className="text-sm text-text-dim mb-2">Uploading… {uploadProgress > 0 ? `${uploadProgress}%` : ''}</p>
                                  {uploadProgress > 0 && (
                                    <div className="w-full bg-surface-elevated rounded-full h-1.5">
                                      <div
                                        className="bg-status-info-muted h-1.5 rounded-full transition-all duration-300"
                                        style={{ width: `${uploadProgress}%` }}
                                      />
                                    </div>
                                  )}
                                </>
                              ) : (
                                <>
                                  <p className="text-sm text-text-dim">
                                    <span className="font-medium text-text-muted">Click to upload</span> or drag &amp; drop
                                  </p>
                                  <p className="text-xs text-text-dim mt-1">MP3, WAV, M4A, FLAC, AAC, OGG (Max 500 MB)</p>
                                </>
                              )}
                            </div>
                            <input
                              ref={audioUploadRef}
                              type="file"
                              accept=".mp3,.wav,.flac,.m4a,.aac,.ogg,.wma,audio/*"
                              className="hidden"
                              disabled={uploadingAudio || calculatingDuration}
                              onChange={handleAudioUpload}
                            />
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
                              <span className="text-text-dim">Clip durations</span>
                              <span className="text-white">{effectiveDuration}s per clip</span>
                            </div>
                            <div className="flex items-center justify-between pt-1">
                              <span className="text-text-muted font-medium text-sm">Estimated video clips</span>
                              <span className="text-white font-bold text-xl">
                                {Math.max(1, Math.floor(totalAudioDuration / effectiveDuration))}
                              </span>
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
                  )}

                  {/* ═══ Token Estimate ═══ */}
                  {inputMode === 'prompt' && videoModel && singlePrompt.trim() && (() => {
                    const _effMdl = useHighRes && videoModel === 'grok' ? 'grok_highres'
                      : useHighRes && videoModel === 'sora2pro' ? 'sora2pro_highres'
                      : videoModel;
                    const _tps = TTV_TOKENS_PER_SECOND[_effMdl] ?? 6000;
                    const _reqTk = Math.round(getEffectiveDuration() * _tps);
                    const _secsPerClip = TTV_SECONDS_PER_VIDEO[_effMdl] ?? TTV_DEFAULT_SECONDS_PER_VIDEO;
                    return (
                      <>
                        <div className="bg-surface-card rounded-xl p-6">
                          <h3 className="text-white font-medium mb-2">Estimate</h3>
                          <div className="text-sm text-text-muted space-y-1">
                            <p>Duration: {getEffectiveDuration()}s × 1 clip</p>
                            <p>Model: {VIDEO_MODEL_OPTIONS.find(m => m.value === _effMdl)?.label ?? _effMdl}</p>
                            <p className="font-medium">Total Required: {formatNumber(_reqTk)} tokens</p>
                            <p>Available Tokens: {formatNumber(userTokenBalance)}</p>
                            <p>Est. generation time: ~{_secsPerClip >= 60 ? `${Math.round(_secsPerClip / 60)} min` : `${_secsPerClip}s`}</p>
                          </div>
                        </div>
                        {_reqTk > userTokenBalance && (
                          <div className="bg-status-error text-status-error p-3 rounded-xl">
                            <div className="flex items-center gap-2">
                              <AlertCircle className="h-5 w-5 text-status-error" />
                              <p className="text-sm">
                                Insufficient tokens. Required: {formatNumber(_reqTk)}, Available: {formatNumber(userTokenBalance)}
                              </p>
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                  {inputMode === 'document' && estimate && selectedDocument && (
                    <div className="bg-surface-card rounded-xl border border-border-card p-5">
                      <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
                        <span>⚡</span>
                        Token Cost Estimate
                      </h2>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-text-dim">
                            Prompt generation ({estimate.totalVideos} clips · {MODEL_OPTIONS.find(m => m.value === promptModel)?.label})
                          </span>
                          <span className="text-text-secondary">{formatNumber(estimate.promptTokens)} tokens</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-text-dim">
                            Video generation ({selectedModelCfg?.label}{useAudioClip && AUDIO_CLIP_SUPPORTED_MODELS.has(videoModel) ? ' · 🔊 Audio' : ''}{useHighRes && HIGH_RES_SUPPORTED_MODELS.has(videoModel) ? ' · 🔍 High Res' : ''} · {effectiveDuration}s × {estimate.totalVideos} clips)
                          </span>
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
                          <span className={estimate.totalTokens > userTokenBalance ? 'text-status-error' : 'text-text-muted'}>
                            {formatNumber(userTokenBalance)} tokens
                          </span>
                        </div>
                        <div className="h-2 bg-surface-elevated rounded-full overflow-hidden mt-1">
                          <div
                            className={`h-full rounded-full transition-all ${estimate.totalTokens > userTokenBalance ? 'bg-accent' : 'bg-status-success-muted'}`}
                            style={{ width: `${Math.min(100, (estimate.totalTokens / Math.max(estimate.totalTokens, userTokenBalance)) * 100)}%` }}
                          />
                        </div>
                        {/* ── Estimated generation time ── */}
                        {(() => {
                          const secsPerClip = TTV_SECONDS_PER_VIDEO[videoModel] ?? TTV_DEFAULT_SECONDS_PER_VIDEO;
                          const totalSecs = estimate.totalVideos * secsPerClip;
                          const perClipLabel =
                            secsPerClip >= 60
                              ? `${Math.round(secsPerClip / 60)} min/clip`
                              : `${secsPerClip}s/clip`;
                          return (
                            <div className="mt-3 bg-surface-elevated/60 rounded-xl px-4 py-3 space-y-1">
                              <div className="flex items-center justify-between text-sm">
                                <span className="text-text-dim">Est. video generation time</span>
                                <span className="text-status-info font-medium">{formatTime(totalSecs)}</span>
                              </div>
                              <div className="flex items-center justify-between text-xs text-text-dim">
                                <span>{selectedModelCfg?.label ?? videoModel} processing speed</span>
                                <span>~{perClipLabel}</span>
                              </div>
                            </div>
                          );
                        })()}
                        {estimate.totalTokens > userTokenBalance && (
                          <div className="flex items-start gap-2 bg-[--color-status-error-bg] border border-[--color-status-error-border] rounded-xl p-3 mt-2">
                            <AlertCircle className="h-4 w-4 text-status-error mt-0.5 shrink-0" />
                            <div className="text-xs text-status-error">
                              <p className="font-medium">Insufficient tokens</p>
                              <p className="mt-0.5 text-status-error">
                                You need {formatNumber(estimate.totalTokens - userTokenBalance)} more tokens. Try a cheaper model or get more tokens.
                              </p>
                            </div>
                          </div>
                        )}
                        {/* Storage estimate */}
                        <div className="border-t border-border pt-2 mt-2">
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-text-dim">Est. storage needed ({estimate.totalVideos} clips × {TTV_MB_PER_VIDEO} MB)</span>
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
                          <div className="flex items-start gap-2 bg-[--color-status-error-bg] border border-[--color-status-error-border] rounded-xl p-3 mt-2">
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

                </div>
              </div>
              {/* ═══ Bottom action area ═══ */}
              {inputMode === 'document' && !isGenerating && !isComplete && (
                <div className="flex flex-col items-center gap-2 pb-8 mt-4">
                  <button
                    onClick={handleGenerate}
                    disabled={!canGenerate}
                    className={`w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-base font-semibold transition-all ${
                      canGenerate
                        ? 'bg-accent hover:bg-accent text-white shadow-lg hover:shadow-red-600/25'
                        : 'bg-surface-elevated text-text-dim cursor-not-allowed'
                    }`}
                  >
                    🎬 Generate Videos
                  </button>
                  {!canGenerate && (
                    <div className="text-xs text-text-dim text-center space-y-0.5">
                      {!selectedDocument && <p>↑ Select a story document</p>}
                      {!videoModel && <p>↑ Select a video model</p>}
                      {!activeStyle && <p>↑ Select a visual style</p>}
                      {totalAudioDuration <= 0 && <p>↑ Select an audio file and calculate its duration</p>}
                      {estimate && estimate.totalTokens > userTokenBalance && (
                        <p className="text-status-error">↑ Insufficient tokens — choose a cheaper model or upgrade your plan</p>
                      )}
                      {estimate && storageUsed !== null && estimate.storageNeededMB > (maxStorageGB * 1024) - storageUsed && (
                        <p className="text-status-error">↑ Insufficient storage — delete old files or upgrade your plan</p>
                      )}
                    </div>
                  )}
                </div>
              )}
              {inputMode === 'prompt' && singleGenState !== 'generating' && singleGenState !== 'complete' && (
                <div className="bg-surface-card rounded-xl p-6 mt-6">
                  <button
                    onClick={handleGenerateSingle}
                    disabled={(() => {
                      const _effMdl3 = useHighRes && videoModel === 'grok' ? 'grok_highres'
                        : useHighRes && videoModel === 'sora2pro' ? 'sora2pro_highres' : videoModel;
                      const _tps3 = TTV_TOKENS_PER_SECOND[_effMdl3] ?? 6000;
                      const _reqTk3 = Math.round(getEffectiveDuration() * _tps3);
                      return !singlePrompt.trim() || !videoModel || _reqTk3 > userTokenBalance;
                    })()}
                    className="w-full flex justify-center items-center px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    🎬 Generate
                  </button>
                </div>
              )}

              {isGenerating && (
                <div className="mb-6 bg-surface-elevated/50 rounded-xl p-6 space-y-4">
                  <div className="flex items-center space-x-3 text-text-muted">
                    <RefreshCw className="h-5 w-5 text-status-error animate-pulse" />
                    <span>{statusMessage}</span>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-text-muted">Phase 1 — TTV Prompt Generation</span>
                      <span className={`text-xs ${currentPhase !== 'prompts' ? 'text-status-success' : 'text-status-info'}`}>
                        {currentPhase !== 'prompts' ? 'Complete ✓' : `${Math.round(phaseOneProgress)}%`}
                      </span>
                    </div>
                    <div className="h-2 bg-surface-elevated rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${currentPhase !== 'prompts' ? 'bg-status-success-muted' : 'bg-status-info-muted'}`}
                        style={{ width: `${currentPhase !== 'prompts' ? 100 : phaseOneProgress}%` }}
                      />
                    </div>
                    <p className="text-xs text-text-dim mt-1">~60 seconds per batch</p>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-text-muted">Phase 2 — Video Generation</span>
                      <span className={`text-xs ${currentPhase === 'complete' ? 'text-status-success' : currentPhase === 'videos' ? 'text-status-pending' : 'text-text-dim'}`}>
                        {currentPhase === 'complete' ? 'Complete ✓' : currentPhase === 'videos' ? `${Math.round(phaseTwoProgress)}%` : 'Waiting…'}
                      </span>
                    </div>
                    <div className="h-2 bg-surface-elevated rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${currentPhase === 'complete' ? 'bg-status-success-muted' : currentPhase === 'videos' ? 'bg-action-purple' : 'bg-surface-elevated'}`}
                        style={{ width: `${currentPhase === 'complete' ? 100 : currentPhase === 'videos' ? phaseTwoProgress : 0}%` }}
                      />
                    </div>
                    <p className="text-xs text-text-dim mt-1">~90 seconds per video batch</p>
                  </div>
                  {timeRemaining !== null && timeRemaining > 0 && (
                    <>
                      <p className="text-sm text-text-muted">Estimated time remaining: {formatTime(timeRemaining)}</p>
                      <p className="text-sm text-text-dim">If you're returning to the page, give it 30 seconds to correctly show the progress.</p>
                      {stuckWarning && (
                        <p className="text-sm text-status-warning">This part may take a little longer, but the progress is moving forward.</p>
                      )}
                    </>
                  )}
                  <div className="flex justify-end">
                    <button
                      onClick={handleStop}
                      disabled={stopRequested}
                      className="flex items-center px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-xl transition-colors disabled:opacity-50"
                    >
                      {stopRequested ? <RefreshCw className="h-5 w-5 mr-2 animate-spin" /> : <X className="h-5 w-5 mr-2" />}
                      {stopRequested ? 'Stopping…' : 'Stop'}
                    </button>
                  </div>
                </div>
              )}

              {isComplete && (
                <div className="mb-6 bg-surface-card rounded-xl border border-status-success p-6">

                  {/* ── Header ── */}
                  <div className="flex items-center gap-3 mb-5">
                    <CheckCircle2 className="h-6 w-6 text-status-success shrink-0" />
                    <div>
                      <h2 className="text-lg font-semibold text-status-success">Videos Generated{generationTitle ? ` for ${generationTitle}` : ''}!</h2>
                      <p className="text-sm text-text-dim mt-0.5">
                        {generatedVideos.length} clip{generatedVideos.length !== 1 ? 's' : ''} saved to your Documents
                      </p>
                    </div>
                  </div>

                  {/* ── Top action bar ── */}
                  <div className="flex flex-wrap items-center justify-end gap-3 mb-6 pb-5 border-b border-border">
                    <button
                      onClick={handleDone}
                      className="flex items-center gap-2 px-4 py-2 bg-surface-elevated hover:bg-surface-elevated text-text-muted rounded-xl text-sm transition-colors"
                    >
                      <RefreshCw className="h-4 w-4" />
                      Done
                    </button>
                    <button
                      onClick={handleDownloadAll}
                      disabled={isDownloadingZip || generatedVideos.every(v => !v)}
                      className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm transition-colors ${
                        isDownloadingZip
                          ? 'bg-status-info text-status-info cursor-not-allowed'
                          : 'bg-action-info-hover hover:bg-action-info text-white'
                      } disabled:opacity-40 disabled:cursor-not-allowed`}
                    >
                      {isDownloadingZip ? (
                        zipDownloadProgress > 0 ? (
                          <div className="flex items-center gap-2">
                            <div className="w-24 bg-status-info rounded-full h-2">
                              <div
                                className="bg-status-info h-2 rounded-full transition-all duration-300"
                                style={{ width: `${zipDownloadProgress}%` }}
                              />
                            </div>
                            <span className="text-xs tabular-nums">{zipDownloadProgress}%</span>
                          </div>
                        ) : (
                          <>
                            <div className="h-4 w-4 border-2 border-status-info border-t-transparent rounded-full animate-spin" />
                            Preparing…
                          </>
                        )
                      ) : (
                        <>
                          <Download className="h-4 w-4" />
                          Download ZIP
                        </>
                      )}
                    </button>
                    <a
                      href="/documents"
                      className="flex items-center gap-2 px-4 py-2 bg-action-success-hover hover:bg-action-success text-white rounded-xl text-sm transition-colors"
                    >
                      <Folder className="h-4 w-4" />
                      View in Documents
                    </a>
                  </div>

                  {redoingVideo && statusMessage && (
                    <p className="text-sm text-status-warning-text mb-4">{statusMessage}</p>
                  )}

                  {/* ── Video clips — vertical stack ── */}
                  {generatedVideos.length > 0 && (
                    showVideos || redoingVideo !== null ? (
                    <div className="flex flex-col gap-6">
                      {generatedVideos.map((videoUrl, index) => {
                        const batchNum = index + 1;
                        const isRedoing = redoingVideo === batchNum;
                        return (
                          <div key={batchNum} className="bg-surface-elevated rounded-xl overflow-hidden border border-border">
                            {/* Clip header */}
                            <div className="px-4 py-2 flex items-center justify-between border-b border-border">
                              <span className="text-sm font-medium text-text-muted">Clip {batchNum}</span>
                              <div className="flex items-center gap-2">
                                {videoUrl && (
                                  <a
                                    href={videoUrl}
                                    download={`clip-${batchNum}.mp4`}
                                    onClick={async (e) => {
                                      e.preventDefault();
                                      try {
                                        const res = await fetch(videoUrl);
                                        const blob = await res.blob();
                                        const objUrl = URL.createObjectURL(blob);
                                        const a = document.createElement('a');
                                        a.href = objUrl;
                                        a.download = `clip-${batchNum}.mp4`;
                                        document.body.appendChild(a);
                                        a.click();
                                        document.body.removeChild(a);
                                        URL.revokeObjectURL(objUrl);
                                      } catch {
                                        window.open(videoUrl, '_blank');
                                      }
                                    }}
                                    className="flex items-center gap-1 px-2 py-1 bg-surface-elevated hover:bg-action-info-hover text-text-muted hover:text-white rounded text-xs transition-colors"
                                    title="Download this clip"
                                  >
                                    <Download className="h-3 w-3" />
                                    Download
                                  </a>
                                )}
                                <button
                                  onClick={() => setRedoModalBatch(batchNum)}
                                  disabled={redoingVideo !== null}
                                  title="Regenerate this video clip"
                                  className="flex items-center gap-1 px-2 py-1 bg-surface-elevated hover:bg-accent-hover text-text-muted hover:text-white rounded text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  <RefreshCw className="h-3 w-3" />
                                  Redo
                                </button>
                              </div>
                            </div>
                            {/* Video */}
                            <div className="aspect-video relative bg-surface-primary">
                              {videoUrl ? (
                                <video
                                  src={videoUrl}
                                  controls
                                  className="w-full h-full object-contain"
                                  preload="metadata"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  <RefreshCw className="h-6 w-6 text-text-dim animate-spin" />
                                </div>
                              )}
                              {isRedoing && (
                                <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2">
                                  <RefreshCw className="h-8 w-8 text-status-error animate-spin" />
                                  <span className="text-white text-sm font-medium">Regenerating…</span>
                                  <span className="text-text-dim text-xs">This may take several minutes</span>
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

                  {/* ── Bottom action bar ── */}
                  <div className="flex flex-wrap items-center justify-end gap-3 mt-6 pt-5 border-t border-border">
                    <button
                      onClick={handleDone}
                      className="flex items-center gap-2 px-4 py-2 bg-surface-elevated hover:bg-surface-elevated text-text-muted rounded-xl text-sm transition-colors"
                    >
                      <RefreshCw className="h-4 w-4" />
                      Done
                    </button>
                    <button
                      onClick={handleDownloadAll}
                      disabled={isDownloadingZip || generatedVideos.every(v => !v)}
                      className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm transition-colors ${
                        isDownloadingZip
                          ? 'bg-status-info text-status-info cursor-not-allowed'
                          : 'bg-action-info-hover hover:bg-action-info text-white'
                      } disabled:opacity-40 disabled:cursor-not-allowed`}
                    >
                      {isDownloadingZip ? (
                        zipDownloadProgress > 0 ? (
                          <div className="flex items-center gap-2">
                            <div className="w-24 bg-status-info rounded-full h-2">
                              <div
                                className="bg-status-info h-2 rounded-full transition-all duration-300"
                                style={{ width: `${zipDownloadProgress}%` }}
                              />
                            </div>
                            <span className="text-xs tabular-nums">{zipDownloadProgress}%</span>
                          </div>
                        ) : (
                          <>
                            <div className="h-4 w-4 border-2 border-status-info border-t-transparent rounded-full animate-spin" />
                            Preparing…
                          </>
                        )
                      ) : (
                        <>
                          <Download className="h-4 w-4" />
                          Download ZIP
                        </>
                      )}
                    </button>
                    <a
                      href="/documents"
                      className="flex items-center gap-2 px-4 py-2 bg-action-success-hover hover:bg-action-success text-white rounded-xl text-sm transition-colors"
                    >
                      <Folder className="h-4 w-4" />
                      View in Documents
                    </a>
                  </div>
                </div>
              )}

              {/* ── Single-TTV generating ── */}
              {inputMode === 'prompt' && singleGenState === 'generating' && (() => {
                const _secs = TTV_SECONDS_PER_VIDEO[(() => {
                  const effM = useHighRes && videoModel === 'grok' ? 'grok_highres'
                    : useHighRes && videoModel === 'sora2pro' ? 'sora2pro_highres' : videoModel;
                  return effM;
                })()] ?? TTV_DEFAULT_SECONDS_PER_VIDEO;
                const _timeLabel = _secs >= 60 ? `~${Math.round(_secs / 60)} minute${Math.round(_secs / 60) !== 1 ? 's' : ''}` : `~${_secs} seconds`;
                return (
                <div className="space-y-6">
                  <div className="bg-surface-elevated/50 rounded-xl p-4 space-y-4">
                    <div className="flex items-center justify-center min-h-[100px]">
                      <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent-text"></div>
                    </div>
                    <div className="text-center space-y-2">
                      <p className="text-text-muted">Generating video...</p>
                      <p className="text-sm text-text-dim">Estimated time: {_timeLabel} — though it may take longer depending on queue.</p>
                    </div>
                  </div>
                </div>
                );
              })()}

              {/* ── Single-TTV completion ── */}
              {inputMode === 'prompt' && singleGenState === 'complete' && singleVideoUrl && (
                <div className="space-y-6">
                  <div className="bg-surface-card rounded-xl p-4 border border-status-success">
                    <div className="flex justify-between items-center mb-3">
                      <h3 className="text-lg font-medium text-status-success">{singleVideoTitle || 'Single Video Clip'}</h3>
                      <div className="flex space-x-4">
                        <button
                          onClick={async () => {
                            try {
                              const res = await fetch(singleVideoUrl!);
                              const blob = await res.blob();
                              const objUrl = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = objUrl;
                              a.download = `${sanitizeFileName(singleVideoTitle || 'clip')}.mp4`;
                              document.body.appendChild(a);
                              a.click();
                              document.body.removeChild(a);
                              URL.revokeObjectURL(objUrl);
                            } catch { window.open(singleVideoUrl!, '_blank'); }
                          }}
                          className="flex items-center px-3 py-1 bg-action-success text-white rounded-xl hover:bg-action-success-hover transition-colors"
                        >
                          <Download className="h-4 w-4 mr-2" />
                          Download
                        </button>
                        <button
                          onClick={handleDoneSingle}
                          disabled={singleDoneLoading}
                          className="flex items-center px-3 py-1 bg-action-success text-white rounded-xl hover:bg-action-success-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          {singleDoneLoading ? (
                            <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-4 w-4 mr-2" />
                          )}
                          {singleDoneLoading ? 'Cleaning up…' : 'Done'}
                        </button>
                      </div>
                    </div>
                    <video src={singleVideoUrl} controls className="w-full rounded-xl" preload="metadata" />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        <RedoFeedbackModal
          open={redoModalBatch != null}
          title={`Redo Clip ${redoModalBatch ?? ''}`}
          onCancel={() => setRedoModalBatch(null)}
          onConfirm={(fb) => {
            const b = redoModalBatch;
            setRedoModalBatch(null);
            if (b != null) handleRedoVideo(b, fb);
          }}
        />
      </DashboardLayout>
    );
  },
);

export default TextToVideoGenerator;
