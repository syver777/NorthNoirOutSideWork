import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Listbox, Transition } from '@headlessui/react';
import { Link, useNavigate } from 'react-router-dom';
import { RefreshCw, X, AlertCircle, CheckCircle2, ChevronDown, Folder, Info, Play, Download, BookOpen, Lock } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import DashboardLayout from '../components/DashboardLayout';
import StatusBanner from '../components/StatusBanner';
import RedoFeedbackModal from '../components/RedoFeedbackModal';
import { DocumentSelector } from '../components/FileUploadComponents';
import TabManager from '../components/TabManager';
import { v4 as uuidv4 } from 'uuid';
import MGStyleSelector from '../components/MGStyleSelector';
import {
  MG_STYLES,
  MG_STYLE_BY_SLUG,
  MG_DEFAULT_STYLE_SLUG,
  MG_DEFAULT_CLIP_SECONDS,
  resolveStyleGuidance,
} from '../data/mgStyles';
import { useTabSessionStorage } from '../hooks/useTabSessionStorage';
import { updateTabStatus, ensureTabExists, deleteTabFromDB } from '../utils/tabManager';
import { getStorageLimitGB } from '../utils/storageHelpers';
import { uploadWithTus } from '../utils/tusUpload';
import { fetchWithFallback } from '../utils/fetchWithFallback';
import { useIsLegacyPlan } from '../hooks/useIsLegacyPlan';
import { getPlanMaxTokens } from '../data/planMaxTokens';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

// ─── Constants ────────────────────────────────────────────────────────────────

const OPERATION_TIMEOUT = 30000;
const POLLING_INTERVAL_P1 = 6000;
const POLLING_INTERVAL_P2 = 10000;

const WORDS_PER_SECOND = 2.08; // ≈125 wpm

// Cost model (per spec): per-clip-second base × margin multiplier, all $-denominated.
const MG_BASE_COST_PER_SECOND = 0.0001507;
const MG_COST_MARGIN = 1.5;

// Per-clip Claude codegen cost. Calibrated from observed SSAITMG runs:
// ~1,000 input / ~6,000 output tokens per clip, +15% buffer for the occasional
// auto-repair call. Charged at the same 40% margin as other AI.
// User can pick Opus (default, best quality) or Sonnet (~1.7× cheaper).
type CodegenModel = 'opus' | 'sonnet';
const MG_CODEGEN_PRICING: Record<CodegenModel, { in: number; out: number }> = {
  opus: { in: 5.0, out: 25.0 },
  sonnet: { in: 3.0, out: 15.0 },
};
const MG_CODEGEN_AVG_IN_TOKENS = 1000;
const MG_CODEGEN_AVG_OUT_TOKENS = 6000;
const MG_CODEGEN_REPAIR_BUFFER = 1.15;
const MG_CODEGEN_MARGIN = 0.4; // user is charged: api_cost / (1 - margin)

function mgCodegenUserChargePerClip(model: CodegenModel): number {
  const p = MG_CODEGEN_PRICING[model];
  const apiCost =
    ((MG_CODEGEN_AVG_IN_TOKENS * p.in) + (MG_CODEGEN_AVG_OUT_TOKENS * p.out)) /
    1_000_000 *
    MG_CODEGEN_REPAIR_BUFFER;
  return apiCost / (1 - MG_CODEGEN_MARGIN);
}
function mgCodegenTokensPerClip(model: CodegenModel): number {
  // Platform tokens billed at $2 / 1M tokens → tokens = USD × 500,000.
  return Math.ceil(mgCodegenUserChargePerClip(model) * 500_000);
}

// Estimated wall-clock seconds per Lambda-rendered MG clip (used for time-remaining display).
const MG_SECONDS_PER_CLIP = 90;

// MG output is rendered at higher fidelity than TTV — rough storage estimate.
const MG_MB_PER_CLIP = 5;

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

const CODEGEN_MODEL_OPTIONS: Array<{ value: CodegenModel; label: string; description: string }> = [
  { value: 'opus',   label: 'Claude Opus 4.6',   description: 'Best quality (default)' },
  { value: 'sonnet', label: 'Claude Sonnet 4.6', description: '~1.7× cheaper, faster' },
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

interface MGEstimate {
  totalClips: number;
  totalAudioDuration: number;
  videoSeconds: number;
  costUSD: number;
  storageNeededMB: number;
}

export interface MotionGraphicsGeneratorRef {
  cleanup: () => Promise<void>;
}

interface MotionGraphicsGeneratorProps {
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

const formatUSD = (n: number): string => {
  if (!isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return `<$0.01`;
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
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

const sanitizeStoryTitleForFolder = (title: string): string =>
  title
    .replace(/^MG Prompt[s]?:\s*/i, '')
    .replace(/[^a-zA-Z0-9\s-]/g, '.')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-');

// ─── Cost estimation ──────────────────────────────────────────────────────────

function computeMGEstimate(
  wordCount: number,
  totalAudioDuration: number,
  videoDuration: number,
  codegenModel: CodegenModel,
): MGEstimate | null {
  if (wordCount <= 0 || totalAudioDuration <= 0 || videoDuration <= 0) return null;
  const totalClips = Math.max(1, Math.floor(totalAudioDuration / videoDuration));
  const videoSeconds = totalClips * videoDuration;
  const costUSD =
    videoSeconds * MG_BASE_COST_PER_SECOND * MG_COST_MARGIN +
    totalClips * mgCodegenUserChargePerClip(codegenModel);
  const storageNeededMB = totalClips * MG_MB_PER_CLIP;
  return { totalClips, totalAudioDuration, videoSeconds, costUSD, storageNeededMB };
}

// ─── Main component ───────────────────────────────────────────────────────────

const MotionGraphicsGenerator = forwardRef<MotionGraphicsGeneratorRef, MotionGraphicsGeneratorProps>(
  function MotionGraphicsGenerator(
    { initialTab = 1, isEnterpriseUser = false, initialTabs, onTabChange, onTabCreate, onTabClose },
    ref,
  ) {
    const navigate = useNavigate();

    const currentTab = initialTab;

    const { isLegacy } = useIsLegacyPlan();

    // ── Document state ────────────────────────────────────────────────────────
    const [documents, setDocuments] = useState<StoryDocument[]>([]);
    const [selectedDoc, setSelectedDoc] = useTabSessionStorage<string>('mg_selectedDoc', '', currentTab);
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
    const [language, setLanguage] = useTabSessionStorage<string>('mg_language', 'english', currentTab);
    const [promptModel, setPromptModel] = useTabSessionStorage<string>('mg_promptModel', 'sonnet', currentTab);
    const [codegenModel, setCodegenModel] = useTabSessionStorage<CodegenModel>('mg_codegenModel', 'opus', currentTab);
    const [customCharsInStory, setCustomCharsInStory] = useTabSessionStorage<boolean>('mg_customCharsInStory', false, currentTab);
    const [customCharacters, setCustomCharacters] = useTabSessionStorage<Array<{ name: string; description: string }>>(
      'mg_customChars',
      [{ name: '', description: '' }],
      currentTab,
    );
    const [customCharactersAIEnhance, setCustomCharactersAIEnhance] = useTabSessionStorage<boolean>('mg_customCharsAIEnhance', false, currentTab);

    // ── Style / duration / audio ──────────────────────────────────────────────
    const [styleSlug, setStyleSlug] = useTabSessionStorage<string>('mg_styleSlug', MG_DEFAULT_STYLE_SLUG, currentTab);
    const [styleDescription, setStyleDescription] = useTabSessionStorage<string>('mg_styleDescription', '', currentTab);
    const [videoDuration, setVideoDuration] = useTabSessionStorage<number>('mg_videoDuration', MG_DEFAULT_CLIP_SECONDS, currentTab);
    const [audioEnabled, setAudioEnabled] = useTabSessionStorage<boolean>('mg_audioEnabled', false, currentTab);

    // Per-clip duration slider display value
    const [sliderInputValue, setSliderInputValue] = useState<string>(String(videoDuration));

    // ── Input mode (existing document vs free-form single-clip prompt) ───────
    const [inputMode, setInputMode] = useTabSessionStorage<'document' | 'prompt'>('mg_inputMode', 'document', currentTab);
    const [singlePrompt, setSinglePrompt] = useTabSessionStorage<string>('mg_singlePrompt', '', currentTab);

    // ── Audio (frequency) ─────────────────────────────────────────────────────
    const [audioFiles, setAudioFiles] = useState<AudioFile[]>([]);
    const [selectedAudioPath, setSelectedAudioPath] = useTabSessionStorage<string>('mg_audioPath', '', currentTab);
    const [totalAudioDuration, setTotalAudioDuration] = useTabSessionStorage<number>('mg_audioDuration', 0, currentTab);
    const [loadingAudioFiles, setLoadingAudioFiles] = useState(false);
    const [calculatingDuration, setCalculatingDuration] = useState(false);
    const [audioDurationError, setAudioDurationError] = useState<string | null>(null);
    const [uploadingAudio, setUploadingAudio] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);

    // ── Estimate ──────────────────────────────────────────────────────────────
    const [estimate, setEstimate] = useState<MGEstimate | null>(null);

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

    // ── Completion screen state ───────────────────────────────────────────────
    const [generatedVideos, setGeneratedVideos] = useState<string[]>([]);
    const [redoingVideo, setRedoingVideo] = useState<number | null>(null);
    const [redoModalBatch, setRedoModalBatch] = useState<number | null>(null);
    const [isDownloadingZip, setIsDownloadingZip] = useState(false);
    const [zipDownloadProgress, setZipDownloadProgress] = useState(0);
    const [showVideos, setShowVideos] = useState(false);

    // ── Single-clip prompt mode state ─────────────────────────────────
    type SingleGenState = 'idle' | 'generating' | 'complete' | 'error';
    const [singleGenState, setSingleGenState] = useState<SingleGenState>('idle');
    const [singleTaskId, setSingleTaskId] = useState<string | null>(null);
    const [singleVideoUrl, setSingleVideoUrl] = useState<string | null>(null);
    const [singleDoneLoading, setSingleDoneLoading] = useState(false);

    // Defensive: migrate any prior 'paste' session value to 'prompt'
    useEffect(() => {
      if ((inputMode as string) === 'paste') setInputMode('prompt');
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const stoppedRef = useRef(false);
    const audioUploadRef = useRef<HTMLInputElement>(null);

    const maxStorageGB = getStorageLimitGB(userPlan);

    // ── Expose cleanup ────────────────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      cleanup: async () => {
        console.log(`[MG Tab ${currentTab}] Cleanup called`);
        if (pollingRef.current) clearInterval(pollingRef.current);
        stoppedRef.current = true;
        try {
          if (!currentUserId) return;

          // Skip deletion if generation already produced completed_final clips.
          const { data: completedTasks } = await supabase
            .from('MG_tasks')
            .select('status')
            .eq('user_id', currentUserId)
            .eq('tab', currentTab)
            .eq('status', 'completed_final')
            .limit(1);

          const hasCompletedFinal = completedTasks && completedTasks.length > 0;

          if (!hasCompletedFinal && groupId) {
            await supabase.from('MG_prompt_tasks').update({ stop_requested: true })
              .eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);
            await supabase.from('MG_tasks').update({ stop_requested: true })
              .eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);

            const { data: mgTasks } = await supabase
              .from('MG_tasks')
              .select('folder_timestamp, story_title')
              .eq('user_id', currentUserId)
              .eq('group_id', groupId)
              .eq('tab', currentTab)
              .limit(1);

            const folderTask = mgTasks?.[0];
            if (folderTask?.folder_timestamp && folderTask?.story_title) {
              const sanitizedTitle = sanitizeStoryTitleForFolder(folderTask.story_title);
              const folderPath = `documents/${currentUserId}/${groupId}/MG-${sanitizedTitle}_${folderTask.folder_timestamp}`;
              console.log(`[MG Tab ${currentTab}] Deleting video folder: ${folderPath}`);
              const { data: files } = await supabase.storage.from('stories').list(folderPath);
              if (files && files.length > 0) {
                await supabase.storage.from('stories').remove(files.map((f: any) => `${folderPath}/${f.name}`));
                console.log(`[MG Tab ${currentTab}] Deleted ${files.length} video file(s)`);
              }
            }
          } else if (hasCompletedFinal) {
            console.log(`[MG Tab ${currentTab}] Generation is complete_final — skipping file deletion`);
          }

          if (groupId) {
            await supabase.from('MG_tasks').delete()
              .eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);
            await supabase.from('MG_prompt_tasks').delete()
              .eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);
            await supabase.from('MG_prompt_context').delete()
              .eq('group_id', groupId).eq('tab', currentTab);
          }

          await deleteTabFromDB(currentUserId, 'mg', currentTab);
          console.log(`[MG Tab ${currentTab}] Cleanup complete`);
        } catch (error) {
          console.error(`[MG Tab ${currentTab}] Error during cleanup:`, error);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Load audio files for the selected document's group ────────────────────
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
      const doc = getSelectedDocument();
      const wc = doc?.word_count ?? 0;
      if (wc <= 0 || videoDuration <= 0) { setEstimate(null); return; }
      const est = computeMGEstimate(wc, totalAudioDuration, videoDuration, codegenModel);
      setEstimate(est);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedDoc, uploadedDoc, videoDuration, totalAudioDuration, documents, codegenModel]);

    // ── Load generated videos when generation completes ───────────────────────
    useEffect(() => {
      if (generationState === 'complete' && groupId && currentUserId) {
        loadGeneratedVideos(groupId);
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [generationState, groupId, currentUserId]);

    // ── Poll for redo completion ──────────────────────────────────────────────
    useEffect(() => {
      if (!redoingVideo || !groupId || !currentUserId) return;

      const interval = setInterval(async () => {
        try {
          const { data: task } = await supabase
            .from('MG_tasks')
            .select('id,batch_number,video_url,status,redo_status')
            .eq('user_id', currentUserId)
            .eq('group_id', groupId)
            .eq('tab', currentTab)
            .eq('batch_number', redoingVideo)
            .maybeSingle();

          if (!task) return;

          if (!task.redo_status && task.status === 'completed_final' && task.video_url) {
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
          console.error('[MG] Redo polling error:', err);
        }
      }, 10_000);

      return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [redoingVideo, groupId, currentUserId, currentTab]);

    // ── Derived helpers ───────────────────────────────────────────────────────
    const getSelectedDocument = (): StoryDocument | undefined => {
      if (selectedDoc) return documents.find(d => d.id === selectedDoc);
      if (uploadedDoc) {
        const name = uploadedDoc.name.replace(/\.txt$/, '');
        return documents.find(d => d.title === name);
      }
      return undefined;
    };

    // ── Load generated video clips (called when generation completes) ─────────
    const loadGeneratedVideos = async (gid: string) => {
      if (!currentUserId || !gid) return;
      try {
        const { data: tasks } = await supabase
          .from('MG_tasks')
          .select('id,batch_number,story_title,folder_timestamp,style_slug,composition_id,video_duration,video_url,status,redo_status,redo_started_at,group_id,user_id,tab,variant,batch')
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
            if (error || !data) {
              console.error(`[MG] Failed to create signed URL for batch ${task.batch_number}:`, error);
              return '';
            }
            return data.signedUrl;
          }),
        );
        setGeneratedVideos(signedUrls);

        const storyTitleFromTask = (tasks[0] as any).story_title;
        if (storyTitleFromTask) setGenerationTitle(storyTitleFromTask);
      } catch (err) {
        console.error('[MG] loadGeneratedVideos error:', err);
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

        // Resolve the task_id for this batch so we can pass it to redo-MG.
        const { data: task } = await supabase
          .from('MG_tasks')
          .select('id')
          .eq('user_id', currentUserId)
          .eq('group_id', groupId)
          .eq('tab', currentTab)
          .eq('batch_number', batchNumber)
          .maybeSingle();
        if (!task) throw new Error('Task not found for redo');

        const response = await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/redo-MG`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            task_id: task.id,
            user_id: currentUserId,
            group_id: groupId,
            batch_number: batchNumber,
            feedback,
          }),
        });

        if (!response.ok && response.status !== 202) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error((errorData as any).error || `HTTP ${response.status}`);
        }
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
        const { data: { session: _mgSession } } = await supabase.auth.getSession();
        const response = await fetchWithFallback('https://calculate-audio-duration.storyscriptai.deno.net', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_mgSession?.access_token || ''}`,
            'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({
            files: [{ path: targetPath, name: fileName }],
          }),
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

        const { error: insErr } = await supabase.from('story_documents').insert({
          id: uuidv4(),
          user_id: currentUserId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          file_path: filePath,
          title: sanitized.replace(/\.(mp3|wav|flac|m4a|aac|ogg|wma)$/i, ''),
          description: 'Uploaded audio file for motion-graphics generation',
          word_count: 0,
          version: 7,
          is_corrected: false,
          is_prompted: false,
          group_id: docGroupId,
          variant: 1,
          file_size: file.size,
        });
        if (insErr) throw insErr;

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

    // ── Story document upload (file) ──────────────────────────────────────────
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
            description: 'Uploaded document for MG generation',
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
            .from('MG_prompt_tasks')
            .select('batch_number,total_batches,status,error,total_clips,story_title,check_stuck')
            .eq('user_id', currentUserId!)
            .eq('group_id', gid)
            .eq('tab', currentTab)
            .eq('variant', variant);
          if (!tasks || tasks.length === 0) return;
          const total = tasks[0].total_batches ?? tasks.length;
          const done = tasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
          const errTask = tasks.find(t => t.status === 'error');
          if (errTask) {
            setError(errTask.error || 'MG prompt generation failed');
            setGenerationState('error');
            if (pollingRef.current) clearInterval(pollingRef.current);
            return;
          }
          const title = (tasks[0] as any).story_title;
          if (title) setGenerationTitle(title);
          setStuckWarning(tasks.some(t => t.status === 'running' && (t as any).check_stuck === true));
          setPhaseOneProgress(total > 0 ? Math.min(100, (done / total) * 100) : 0);
          setStatusMessage(`Generating MG prompts: ${done} / ${total} batches`);
          const remainingPromptBatches = total - done;
          const maxBatchTask = tasks.reduce((max, t) => t.batch_number > max.batch_number ? t : max, tasks[0]);
          const totalClips = (maxBatchTask as any).total_clips ?? 0;
          const videoTimeEstimate = totalClips * MG_SECONDS_PER_CLIP;
          setTimeRemaining(remainingPromptBatches * 60 + videoTimeEstimate);
          if (tasks.every(t => t.status === 'completed' || t.status === 'completed_final')) {
            setCurrentPhase('videos');
            setStatusMessage('MG prompts complete — starting video generation…');
            if (pollingRef.current) clearInterval(pollingRef.current);
            pollingRef.current = setInterval(pollP2, POLLING_INTERVAL_P2);
            pollP2();
          }
        } catch { /* retry */ }
      };

      const pollP2 = async () => {
        if (stoppedRef.current) return;
        try {
          const { data: tasks } = await supabase
            .from('MG_tasks')
            .select('batch_number,total_batches,status,error,check_stuck')
            .eq('user_id', currentUserId!)
            .eq('group_id', gid)
            .eq('tab', currentTab)
            .eq('variant', variant);
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
          setTimeRemaining((total - done) * MG_SECONDS_PER_CLIP);
          if (tasks.length > 0 && tasks.every(t => t.status === 'completed' || t.status === 'completed_final')) {
            setGenerationState('complete');
            setCurrentPhase('complete');
            setPhaseTwoProgress(100);
            setTimeRemaining(0);
            setStatusMessage('All videos generated successfully!');
            if (pollingRef.current) clearInterval(pollingRef.current);
            try {
              await updateTabStatus(currentUserId!, 'mg', currentTab, 'complete', gid);
            } catch (e) { console.error('[MG] Failed to update tab status to complete:', e); }
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
          // First, check for an in-flight or completed single-MG task on this tab.
          const { data: singleTasks } = await supabase
            .from('MG_tasks')
            .select('id,status,video_url,error,group_id')
            .eq('user_id', currentUserId)
            .eq('tab', currentTab)
            .eq('single_mg', true)
            .order('created_at', { ascending: false })
            .limit(1);
          const singleTask = singleTasks?.[0];
          if (singleTask) {
            setInputMode('prompt');
            setSingleTaskId(singleTask.id);
            if ((singleTask.status === 'completed' || singleTask.status === 'completed_final') && singleTask.video_url) {
              const vUrl = singleTask.video_url;
              if (/^https?:\/\//i.test(vUrl)) {
                setSingleVideoUrl(vUrl);
              } else {
                const { data: signed } = await supabase.storage.from('stories').createSignedUrl(vUrl, 3600);
                setSingleVideoUrl(signed?.signedUrl ?? null);
              }
              setSingleGenState('complete');
              return;
            }
            if (singleTask.status === 'error') {
              setError(singleTask.error || 'Single MG generation failed');
              setSingleGenState('error');
              return;
            }
            // queued | processing | rendering → resume polling
            setSingleGenState('generating');
            return;
          }

          const { data: tab } = await supabase
            .from('tabs')
            .select('group_id, status')
            .eq('user_id', currentUserId)
            .eq('page', 'mg')
            .eq('tab_number', currentTab)
            .in('status', ['generating', 'complete'])
            .maybeSingle();

          if (!tab?.group_id) return;

          if (tab.status === 'complete') {
            setGroupId(tab.group_id);
            setCurrentPhase('complete');
            setGenerationState('complete');
            setPhaseTwoProgress(100);
            setStatusMessage('All videos generated successfully!');
            return;
          }

          const { data: promptTasks } = await supabase
            .from('MG_prompt_tasks')
            .select('variant, status')
            .eq('user_id', currentUserId)
            .eq('group_id', tab.group_id)
            .eq('tab', currentTab);

          if (!promptTasks || promptTasks.length === 0) return;

          const variant = promptTasks[0].variant ?? 1;
          const allPromptsComplete = promptTasks.every(
            t => t.status === 'completed' || t.status === 'completed_final',
          );

          setGroupId(tab.group_id);
          setCurrentVariant(variant);

          if (allPromptsComplete) {
            const { data: videoTasks } = await supabase
              .from('MG_tasks')
              .select('status')
              .eq('user_id', currentUserId!)
              .eq('group_id', tab.group_id)
              .eq('tab', currentTab);

            if (videoTasks && videoTasks.length > 0 && videoTasks.every(
              t => t.status === 'completed' || t.status === 'completed_final',
            )) {
              setCurrentPhase('complete');
              setGenerationState('complete');
              setPhaseTwoProgress(100);
              setStatusMessage('All videos generated successfully!');
              try {
                await updateTabStatus(currentUserId!, 'mg', currentTab, 'complete', tab.group_id);
              } catch (e) { console.error('[MG] Failed to update tab status to complete on resume:', e); }
              return;
            }
          }

          setCurrentPhase(allPromptsComplete ? 'videos' : 'prompts');
          setGenerationState('generating');
          setStatusMessage('Resuming generation…');
          startPolling(tab.group_id, variant);
        } catch (err) {
          console.error('[MG] Resume detection error:', err);
        }
      };
      checkForActiveGeneration().finally(() => setResumeChecked(true));
    }, [currentUserId]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Poll for single-MG completion ─────────────────────────────────────────
    useEffect(() => {
      if (singleGenState !== 'generating' || !singleTaskId) return;
      const interval = setInterval(async () => {
        try {
          const { data: task } = await supabase
            .from('MG_tasks')
            .select('id,status,video_url,error')
            .eq('id', singleTaskId)
            .maybeSingle();
          if (!task) return;
          if ((task.status === 'completed' || task.status === 'completed_final') && task.video_url) {
            const vUrl = task.video_url;
            if (/^https?:\/\//i.test(vUrl)) {
              setSingleVideoUrl(vUrl);
            } else {
              const { data: signed } = await supabase.storage.from('stories').createSignedUrl(vUrl, 3600);
              setSingleVideoUrl(signed?.signedUrl ?? null);
            }
            setSingleGenState('complete');
            if (currentUserId) {
              try { await updateTabStatus(currentUserId, 'mg', currentTab, 'complete'); } catch (_) { /* non-fatal */ }
            }
          } else if (task.status === 'error') {
            setError(task.error || 'Single MG generation failed');
            setSingleGenState('error');
          }
        } catch (err) {
          console.error('[MG] Single-MG polling error:', err);
        }
      }, 10_000);
      return () => clearInterval(interval);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [singleGenState, singleTaskId]);

    // ── Stop generation ───────────────────────────────────────────────────────
    const handleStop = async () => {
      if (!groupId || !currentUserId) return;
      setStopRequested(true);
      stoppedRef.current = true;
      if (pollingRef.current) clearInterval(pollingRef.current);

      setGenerationState('idle');
      setCurrentPhase('prompts');
      setPhaseOneProgress(0);
      setPhaseTwoProgress(0);
      setTimeRemaining(null);
      setGroupId(null);
      setCurrentVariant(null);
      setStatusMessage('');
      setStopRequested(false);
      updateTabStatus(currentUserId, 'mg', currentTab, 'idle').catch(() => {});

      try {
        // Use the dedicated stop-MG-processing edge function so in-flight Lambda
        // workers terminate gracefully (and to keep parity with TTV's behavior).
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/stop-MG-processing`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              group_id: groupId,
              user_id: currentUserId,
              tab: currentTab,
              variant: _currentVariant ?? 1,
            }),
          }).catch(() => {});
        }

        await supabase.from('MG_prompt_tasks').update({ stop_requested: true })
          .eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);
        await supabase.from('MG_tasks').update({ stop_requested: true })
          .eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);

        const { data: mgTasks } = await supabase
          .from('MG_tasks')
          .select('folder_timestamp, story_title, video_url')
          .eq('user_id', currentUserId)
          .eq('group_id', groupId)
          .eq('tab', currentTab);

        const folderTask = mgTasks?.find((t: any) => t.folder_timestamp);
        if (folderTask?.folder_timestamp && folderTask?.story_title) {
          const sanitizedTitle = sanitizeStoryTitleForFolder(folderTask.story_title);
          const folderPath = `documents/${currentUserId}/${groupId}/MG-${sanitizedTitle}_${folderTask.folder_timestamp}`;
          console.log(`[MG Stop] Deleting video folder: ${folderPath}`);
          const { data: files } = await supabase.storage.from('stories').list(folderPath);
          if (files && files.length > 0) {
            await supabase.storage.from('stories').remove(files.map((f: any) => `${folderPath}/${f.name}`));
            console.log(`[MG Stop] Deleted ${files.length} video file(s)`);
          }
        }

        await supabase.from('MG_tasks').delete()
          .eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);
        await supabase.from('MG_prompt_tasks').delete()
          .eq('user_id', currentUserId).eq('group_id', groupId).eq('tab', currentTab);
        await supabase.from('MG_prompt_context').delete()
          .eq('group_id', groupId).eq('tab', currentTab);
      } catch (err) {
        console.error('Stop cleanup error:', err);
      }
    };

    // ── Generate ──────────────────────────────────────────────────────────────
    const handleGenerate = async () => {
      const doc = getSelectedDocument();

      if (!doc) { setError('Please select a story document'); return; }
      if (!styleSlug || !MG_STYLE_BY_SLUG[styleSlug]) { setError('Please select a visual style'); return; }
      if (!estimate) { setError('Could not compute estimate — check your settings'); return; }
      if (storageUsed !== null && estimate.storageNeededMB > (maxStorageGB * 1024) - storageUsed) {
        setError(`Insufficient storage. Required: ${formatStorageSize(estimate.storageNeededMB)}, Available: ${formatStorageSize((maxStorageGB * 1024) - storageUsed)}`);
        return;
      }

      const styleCfg = MG_STYLE_BY_SLUG[styleSlug];

      setError(null);
      setGenerationState('generating');
      setCurrentPhase('prompts');
      setPhaseOneProgress(0);
      setPhaseTwoProgress(0);
      setStatusMessage('Preparing MG generation…');
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
        await ensureTabExists(user.id, 'mg');
        await updateTabStatus(user.id, 'mg', currentTab, 'generating', gid, doc.title);
        const effectiveAudioDuration = totalAudioDuration;
        if (effectiveAudioDuration <= 0) throw new Error('Cannot determine story duration.');

        // Build character_descriptions JSONB object { name: description }
        const characterDescriptions = customCharsInStory
          ? Object.fromEntries(
              customCharacters
                .filter(c => c.name.trim())
                .map(c => [c.name.trim(), c.description.trim()]),
            )
          : {};

        const { data: { session: _mgSession } } = await supabase.auth.getSession();
        const response = await withTimeout(
          fetchWithFallback('https://setup-mg-prompts.storyscriptai.deno.net', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${_mgSession?.access_token || ''}`,
              'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
            },
            body: JSON.stringify({
              user_id: user.id,
              group_id: gid,
              file_path: doc.file_path,
              story_title: doc.title,
              description: doc.description || doc.title,
              style_slug: styleCfg.slug,
              composition_id: styleCfg.composition_id,
              style_description: styleDescription.trim() || null,
              video_duration: videoDuration,
              totalAudioDuration: effectiveAudioDuration,
              custom_chars_in_story: customCharsInStory,
              character_descriptions: characterDescriptions,
              customCharactersAIEnhance,
              model: promptModel,
              codegen_model: codegenModel,
              language,
              tab: currentTab,
              variant,
              audio_enabled: audioEnabled,
            }),
          }).then(async res => {
            if (!res.ok) {
              const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
              throw new Error(err.error || `HTTP ${res.status}`);
            }
            return res.json();
          }),
          180000,
          'setupMGPrompts',
        );
        if (response.error) throw new Error(response.error);
        const clipsQueued = response.total_clips ?? response.total_videos ?? 0;
        setStatusMessage(`Setup complete — ${clipsQueued} clip${clipsQueued === 1 ? '' : 's'} queued. Generating prompts…`);
        startPolling(gid, variant);
      } catch (err: any) {
        setError(err.message || 'An error occurred during generation');
        setGenerationState('error');
      }
    };

    // ── Done (complete state — clean up DB rows, keep files, reset state) ──────
    const handleDone = async () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      const doneGroupId = groupId;
      const doneUserId = currentUserId;

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

      if (doneUserId) {
        updateTabStatus(doneUserId, 'mg', currentTab, 'idle').catch(() => {});
      }

      try {
        if (doneUserId && doneGroupId) {
          await supabase.from('MG_tasks').delete()
            .eq('user_id', doneUserId).eq('group_id', doneGroupId).eq('tab', currentTab);
          await supabase.from('MG_prompt_tasks').delete()
            .eq('user_id', doneUserId).eq('group_id', doneGroupId).eq('tab', currentTab);
          await supabase.from('MG_prompt_context').delete()
            .eq('group_id', doneGroupId).eq('tab', currentTab);
          console.log(`[MG] Done cleanup complete for groupId: ${doneGroupId}`);
        }
      } catch (err) {
        console.error('[MG] Done cleanup error:', err);
      }
    };

    // ── Generate (Individual Prompt mode — code-gen pipeline) ────────────────
    // Routes to single-MG, which dispatches to the mg-codegen-worker Lambda
    // that generates a bespoke Clip.tsx per task (no fixed templates).
    const handleGenerateSingle = async () => {
      const prompt = singlePrompt.trim();
      if (!prompt) { setError('Please enter a prompt'); return; }
      if (!currentUserId) { setError('Not authenticated'); return; }

      setError(null);
      setSingleGenState('generating');
      setSingleVideoUrl(null);
      setSingleTaskId(null);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Not authenticated');
        const gid = uuidv4();
        try {
          await updateTabStatus(currentUserId, 'mg', currentTab, 'generating', gid, 'Single Motion Graphics Clip');
        } catch (_) { /* non-fatal */ }
        const response = await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/single-MG`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            user_id: currentUserId,
            group_id: gid,
            story_title: 'single_mg',
            user_prompt: prompt,
            // Use the selected preset's style_guidance, with the freeform
            // styleDescription as an override when the user filled it in.
            // Without this, an empty textarea silently dropped the chosen
            // style (e.g. "Bright Infographic" rendered with no white bg).
            style_guidance: resolveStyleGuidance(styleSlug, styleDescription) || undefined,
            duration_seconds: videoDuration,
            tab: currentTab,
            ai_model: promptModel,
            codegen_model: codegenModel,
          }),
        });
        if (!response.ok && response.status !== 202) {
          const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
          throw new Error((err as any).error || `HTTP ${response.status}`);
        }
        const data = await response.json();
        setSingleTaskId(data.task_id);
      } catch (err: any) {
        setError(err.message || 'Failed to start single MG generation');
        setSingleGenState('error');
      }
    };

    // ── Stop (Individual Prompt) — cancel the in-flight clip, delete row, reset ───────
    const handleStopSingle = async () => {
      const tid = singleTaskId;
      setSingleGenState('idle');
      setSingleVideoUrl(null);
      setSingleTaskId(null);
      setError(null);
      if (currentUserId) {
        updateTabStatus(currentUserId, 'mg', currentTab, 'idle').catch(() => {});
      }
      try {
        if (tid) {
          // Signal any in-flight Lambda poller to bail, then remove the row.
          await supabase.from('MG_tasks')
            .update({ stop_requested: true, status: 'error', error: 'Stopped by user', updated_at: new Date().toISOString() })
            .eq('id', tid);
          await supabase.from('MG_tasks').delete().eq('id', tid);
        }
      } catch (err) {
        console.error('[MG] Single-MG stop cleanup error:', err);
      }
    };

    // ── Done (Individual Prompt — delete file from storage, delete DB row, reset state) ──
    const handleDoneSingle = async () => {
      setSingleGenState('idle');
      if (currentUserId) {
        updateTabStatus(currentUserId, 'mg', currentTab, 'idle').catch(() => {});
      }
      setSingleDoneLoading(true);
      try {
        if (singleTaskId) {
          // Fetch the task to get the storage path before deleting the row
          const { data: task } = await supabase
            .from('MG_tasks')
            .select('video_url')
            .eq('id', singleTaskId)
            .maybeSingle();

          // Delete the video file from Supabase storage. Skip when video_url
          // is still a legacy public S3 URL (starts with http) — those are
          // cleaned up server-side by process-mg-task instead.
          const vUrl = task?.video_url;
          if (vUrl && !/^https?:\/\//i.test(vUrl)) {
            await supabase.storage.from('stories').remove([vUrl]);
          }

          await supabase.from('MG_tasks').delete().eq('id', singleTaskId);
        }
      } catch (err) {
        console.error('[MG] Single-MG done cleanup error:', err);
      } finally {
        setSingleVideoUrl(null);
        setSingleTaskId(null);
        setSingleDoneLoading(false);
      }
    };

    // ── Download all generated video clips as a ZIP ───────────────────────────
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
        const clipShare = 80 / N;

        for (let i = 0; i < N; i++) {
          const { url, clipNum } = validEntries[i];
          const clipBase = i * clipShare;
          try {
            const response = await fetch(url!);
            if (!response.ok) { console.error(`Failed to fetch clip ${clipNum}`); continue; }

            const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);

            if (contentLength > 0 && response.body) {
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
              const blob = await response.blob();
              zip.file(`clip-${clipNum}.mp4`, blob);
            }
            filesAdded++;
          } catch (err) {
            console.error(`Error fetching clip ${clipNum}:`, err);
          }
          setZipDownloadProgress(Math.round(clipBase + clipShare));
        }

        if (filesAdded === 0) throw new Error('No video clips could be downloaded');

        const zipBlob = await zip.generateAsync(
          { type: 'blob' },
          (metadata) => {
            const pct = 80 + Math.round(metadata.percent * 0.2);
            setZipDownloadProgress(Math.min(pct, 100));
          },
        );

        let zipTitle = 'motion-graphics';
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
          } catch { /* ignore */ }
        }
        if (zipTitle === 'motion-graphics' && generationTitle) {
          const cleanTitle = generationTitle
            .replace(/^MG Prompt:\s*/i, '')
            .replace(/^MG Prompts:\s*/i, '')
            .trim();
          zipTitle = `MG Outputs: ${cleanTitle}`;
        }
        saveAs(zipBlob, `${zipTitle}.zip`);
      } catch (err: any) {
        console.error('[MG] Error creating ZIP:', err);
        setError(err.message || 'Failed to download ZIP');
      } finally {
        setIsDownloadingZip(false);
        setZipDownloadProgress(0);
      }
    };

    // ── Derived values ────────────────────────────────────────────────────────
    const selectedDocument = getSelectedDocument();
    const wordCount = selectedDocument?.word_count ?? 0;
    const selectedStyle = MG_STYLE_BY_SLUG[styleSlug];
    const isGenerating = generationState === 'generating';
    const isComplete = generationState === 'complete';

    const singlePromptTrimmed = singlePrompt.trim();
    const singleWordCount = singlePromptTrimmed
      ? singlePromptTrimmed.split(/\s+/).filter(w => w.length > 0).length
      : 0;
    const isGeneratingSingle = singleGenState === 'generating';
    const isSingleComplete = singleGenState === 'complete';
    const singleClipCostUSD =
      videoDuration * MG_BASE_COST_PER_SECOND * MG_COST_MARGIN +
      mgCodegenUserChargePerClip(codegenModel);
    // Platform token pricing: $2 per 1,000,000 tokens → tokens = USD × 500,000.
    const singleClipTokens = Math.ceil(singleClipCostUSD * 500_000);

    const canGenerate =
      inputMode === 'document' &&
      !!selectedDocument &&
      !!styleSlug &&
      videoDuration >= 5 && videoDuration <= 30 &&
      !!estimate &&
      (estimate === null || storageUsed === null ||
        estimate.storageNeededMB <= (maxStorageGB * 1024) - storageUsed) &&
      totalAudioDuration > 0 &&
      !isGenerating;

    const canGenerateSingle =
      inputMode === 'prompt' &&
      singleWordCount > 0 &&
      !!styleSlug &&
      videoDuration >= 5 && videoDuration <= 30 &&
      !isGeneratingSingle &&
      !isSingleComplete;

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
                  <p className="text-sm text-text-muted mb-6 leading-relaxed">Motion Graphics Generator requires a paid plan. Upgrade to unlock motion-graphics generation and all tools.</p>
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
                <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Motion Graphics Generator</h1>
                <div className="mt-2">
                  <p className="text-text-secondary">Transform your story script into a series of AI-generated motion-graphics clips</p>
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
                  The Motion Graphics Generator turns your story document into a sequence of designed, animated motion-graphics clips — one per scene. Pick a visual style from {MG_STYLES.length} preset designs, set the clip length, and the system handles scene splitting, designing each clip's content, and rendering them ready to combine.
                </p>
                <Link
                  to="/learn#motion-graphics"
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
                    Select a story document or write a custom style prompt, choose a visual style, then hit Generate. In document mode the system splits your text into scenes and renders each clip automatically; in custom style mode it renders a single test clip.
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
                  page="mg"
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
                  title={<>Motion Graphics Generated{generationTitle ? ` for ${generationTitle}` : ''}!</>}
                  subtitle="All clips have been generated and saved to your Documents."
                />
              )}

              {/* ── Individual Prompt — generating loader (TTV-style) ── */}
              {isGeneratingSingle && (
                <div className="space-y-6 mb-6">
                  <div className="bg-surface-elevated/50 rounded-xl p-4 space-y-4">
                    <div className="flex items-center justify-center min-h-[100px]">
                      <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent-text"></div>
                    </div>
                    <div className="text-center space-y-2">
                      <p className="text-text-muted">Generating video...</p>
                      <p className="text-sm text-text-dim">Estimated time: ~2 minutes — though it may take longer depending on queue.</p>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Individual Prompt — completion banner ── */}
              {isSingleComplete && (
                <StatusBanner
                  variant="success"
                  title="Clip Generated!"
                  subtitle="Your test clip is ready. Download it or press Done to try another style."
                />
              )}

              {/* ── Configuration ── */}
              <div
                className="dash-collapse-grid"
                data-collapsed={isGenerating || isComplete || isGeneratingSingle || isSingleComplete ? 'true' : 'false'}
              >
              <div key={inputMode} className="space-y-6 dash-stagger">

                  {/* ═══ Mode ═══ */}
                  <div className="dash-animate-in">
                    <h2 className="text-xl font-semibold text-white mb-4">Story Input</h2>
                    <div className="grid grid-cols-2 gap-4">
                      <button
                        onClick={() => setInputMode('document')}
                        disabled={isGenerating || isComplete}
                        className={`p-4 rounded-xl border-2 transition-all text-left ${
                          inputMode === 'document'
                            ? 'border-red-800/70 bg-red-900/30'
                            : 'border-border-card bg-surface-card hover:border-white/20'
                        } ${(isGenerating || isComplete) ? 'cursor-not-allowed opacity-50' : ''}`}
                      >
                        <div className="font-medium text-white text-sm sm:text-base">Existing Document</div>
                        <div className="text-xs sm:text-sm text-text-muted mt-1">Generate from a story you've already saved</div>
                      </button>
                      <button
                        onClick={() => setInputMode('prompt')}
                        disabled={isGenerating || isComplete}
                        className={`p-4 rounded-xl border-2 transition-all text-left ${
                          inputMode === 'prompt'
                            ? 'border-red-800/70 bg-red-900/30'
                            : 'border-border-card bg-surface-card hover:border-white/20'
                        } ${(isGenerating || isComplete) ? 'cursor-not-allowed opacity-50' : ''}`}
                      >
                        <div className="font-medium text-white text-sm sm:text-base">Individual Prompt</div>
                        <div className="text-xs sm:text-sm text-text-muted mt-1">Generate a single clip from a prompt — perfect for testing styles.</div>
                      </button>
                    </div>
                  </div>

                  {/* ═══ Document Mode ═══ */}
                  {inputMode === 'document' && (
                  <div>
                    <h2 className="text-xl font-semibold text-white mb-2">Select or Upload Story Document</h2>
                    <p className="text-text-secondary mb-4">
                      Select one of your Story Documents or upload a .txt file to generate motion graphics.
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

                  {/* ═══ Individual Prompt Mode ═══ */}
                  {inputMode === 'prompt' && (
                  <div className="bg-surface-card rounded-xl p-6">
                    <h2 className="text-xl font-semibold text-white mb-2">Individual Motion Graphics Generation</h2>
                    <p className="text-text-muted mb-6">
                      Generate a single motion-graphics clip from your own prompt. Perfect for quick clips or testing different styles without writing a full story.
                    </p>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">Prompt</label>
                        <textarea
                          value={singlePrompt}
                          onChange={e => setSinglePrompt(e.target.value)}
                          placeholder="e.g. A neon city skyline at night with pulsing geometric overlays and floating data streams…"
                          rows={8}
                          disabled={isGeneratingSingle || isSingleComplete}
                          className="w-full bg-surface-elevated text-white rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-accent-text resize-none"
                        />
                        <div className="flex justify-between text-xs text-text-dim mt-1">
                          <span>{singleWordCount.toLocaleString()} words · {singlePrompt.length.toLocaleString()} characters</span>
                          <span>Renders one clip at the duration set below</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  )}

                  {/* ═══ Visual Style (16-card picker) ═══ */}
                  <MGStyleSelector
                    selectedStyleSlug={styleSlug}
                    onSelect={setStyleSlug}
                    disabled={isGenerating}
                  />

                  {/* ═══ Custom Style (optional) ═══ */}
                  <div className="mt-2 rounded-xl overflow-hidden border border-border-card">
                    <div className="p-4">
                      <h3 className="text-lg font-medium text-white mb-2">Custom Style (optional)</h3>
                      <p className="text-xs text-text-dim mb-3">
                        When filled, fully replaces the selected style. Leave blank to use the selected card's style.
                      </p>
                      <textarea
                        value={styleDescription}
                        onChange={e => setStyleDescription(e.target.value.slice(0, 1200))}
                        placeholder="Describe the visual mood and treatment you want (optional)"
                        rows={6}
                        maxLength={1200}
                        disabled={isGenerating}
                        className="w-full bg-surface-input border border-white/[0.13] rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 placeholder:text-white/40"
                      />
                      <div className="mt-1 flex items-center justify-between">
                        {styleDescription.trim() ? (
                          <span className="text-xs text-yellow-400">Custom style overrides the selected card.</span>
                        ) : <span />}
                        <span className="text-xs text-text-muted">{styleDescription.length} / 1200</span>
                      </div>
                    </div>
                  </div>

                  {/* ═══ Clip Duration ═══ */}
                  <div className="bg-surface-card rounded-xl border border-border-card p-5">
                    <h2 className="text-base font-semibold text-white mb-1">Clip Duration</h2>
                    <p className="text-xs text-text-dim mb-4">
                      Length of each motion-graphics clip. Total clips = audio duration ÷ clip length.
                    </p>
                    {(() => {
                      const minVal = 5;
                      const maxVal = 30;
                      const parsed = parseInt(sliderInputValue);
                      const isOutOfRange =
                        sliderInputValue !== '' && (isNaN(parsed) || parsed < minVal || parsed > maxVal);
                      return (
                        <div className="space-y-2">
                          <div className="flex items-center gap-3">
                            <input
                              type="range"
                              min={minVal}
                              max={maxVal}
                              step={1}
                              value={videoDuration}
                              disabled={isGenerating}
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
                              disabled={isGenerating}
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

                  {/* ═══ Generation Settings ═══ */}
                  <div className="relative z-10" style={{ zoom: 1 / 1.1 }}>
                    <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-4">Generation Settings</label>
                    <div className="space-y-4">

                      {/* Language dropdown — document mode only */}
                      {inputMode === 'document' && (
                      <div>
                        <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">Language</label>
                        <Listbox value={language} onChange={setLanguage} disabled={isGenerating}>
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
                      )}

                      {/* Codegen Model — applies to both document & individual prompt modes */}
                      <div>
                        <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">Codegen Model</label>
                        <Listbox value={codegenModel} onChange={setCodegenModel} disabled={isGenerating || isGeneratingSingle}>
                          {({ open }) => (
                            <div className="relative">
                              <Listbox.Button className="relative w-full bg-surface-input border border-white/[0.13] rounded-xl px-5 py-4 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 cursor-pointer hover:bg-surface-input">
                                <span className="block truncate">
                                  {CODEGEN_MODEL_OPTIONS.find(o => o.value === codegenModel)?.label || 'Claude Opus 4.6'}
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
                                  {CODEGEN_MODEL_OPTIONS.map(opt => (
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
                          Selected: {CODEGEN_MODEL_OPTIONS.find(o => o.value === codegenModel)?.label} · ~{mgCodegenTokensPerClip(codegenModel).toLocaleString()} tokens/clip
                        </p>
                      </div>

                    </div>
                  </div>

                  {/* ═══ Audio (Clip Frequency) — document mode only ═══ */}
                  {inputMode === 'document' && (
                  <div>
                    <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">Clip Frequency</label>
                    <p className="text-xs text-text-dim mb-4">Audio runtime determines how many motion-graphics clips will be generated</p>

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
                            <strong>Audio Runtime Mode:</strong> Total clips = audio duration ÷ clip length. Upload or select audio files that match your selected story.
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
                              disabled={calculatingDuration || uploadingAudio || isGenerating}
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
                              disabled={uploadingAudio || calculatingDuration || isGenerating}
                              onChange={handleAudioUpload}
                            />
                          </label>
                        </div>
                        )}

                        {totalAudioDuration > 0 && videoDuration > 0 && (
                          <div className="space-y-2 border-t border-border pt-3">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-text-dim">Audio duration</span>
                              <span className="text-white">{formatDuration(totalAudioDuration)}</span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-text-dim">Clip durations</span>
                              <span className="text-white">{videoDuration}s per clip</span>
                            </div>
                            <div className="flex items-center justify-between pt-1">
                              <span className="text-text-muted font-medium text-sm">Estimated motion-graphics clips</span>
                              <span className="text-white font-bold text-xl">
                                {Math.max(1, Math.floor(totalAudioDuration / videoDuration))}
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

                  {/* ═══ Cost Estimate ═══ */}
                  {estimate && inputMode === 'document' && selectedDocument && (
                    <div className="bg-surface-card rounded-xl border border-border-card p-5">
                      <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
                        <span>⚡</span>
                        Cost Estimate
                      </h2>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-text-dim">Codegen model</span>
                          <span className="text-text-secondary text-xs">{codegenModel === 'opus' ? 'Claude Opus 4.6' : 'Claude Sonnet 4.6'}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-text-dim">
                            Motion graphics rendering ({selectedStyle?.display_name ?? 'style'} · {videoDuration}s × {estimate.totalClips} clip{estimate.totalClips !== 1 ? 's' : ''})
                          </span>
                          <span className="text-text-secondary">{formatDuration(estimate.videoSeconds)} total</span>
                        </div>
                        <div className="flex items-center justify-between text-xs text-text-dim">
                          <span>Per-clip tokens ({codegenModel === 'opus' ? 'Opus 4.6' : 'Sonnet 4.6'})</span>
                          <span>~{mgCodegenTokensPerClip(codegenModel).toLocaleString()}</span>
                        </div>
                        <div className="border-t border-border pt-2 flex items-center justify-between">
                          <span className="text-white font-semibold">Estimated tokens ({estimate.totalClips} clip{estimate.totalClips !== 1 ? 's' : ''})</span>
                          <span className="font-bold text-lg text-status-success">
                            {Math.ceil(estimate.costUSD * 500_000).toLocaleString()}
                          </span>
                        </div>

                        {/* Estimated generation time */}
                        {(() => {
                          const totalSecs = estimate.totalClips * MG_SECONDS_PER_CLIP;
                          const perClipLabel =
                            MG_SECONDS_PER_CLIP >= 60
                              ? `${Math.round(MG_SECONDS_PER_CLIP / 60)} min/clip`
                              : `${MG_SECONDS_PER_CLIP}s/clip`;
                          return (
                            <div className="mt-3 bg-surface-elevated/60 rounded-xl px-4 py-3 space-y-1">
                              <div className="flex items-center justify-between text-sm">
                                <span className="text-text-dim">Est. generation time</span>
                                <span className="text-status-info font-medium">{formatTime(totalSecs)}</span>
                              </div>
                              <div className="flex items-center justify-between text-xs text-text-dim">
                                <span>Lambda render speed</span>
                                <span>~{perClipLabel}</span>
                              </div>
                            </div>
                          );
                        })()}

                        {/* Storage estimate */}
                        <div className="border-t border-border pt-2 mt-2">
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-text-dim">Est. storage needed ({estimate.totalClips} clips × {MG_MB_PER_CLIP} MB)</span>
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
              {!isGenerating && !isComplete && !isGeneratingSingle && !isSingleComplete && inputMode === 'document' && (
                <div className="flex flex-col items-center gap-2 pb-8 mt-4">
                  {estimate && (
                    <div className="w-full text-center text-sm text-text-muted">
                      Estimated tokens: <span className="font-semibold text-white">{Math.ceil(estimate.costUSD * 500_000).toLocaleString()}</span>
                    </div>
                  )}
                  <button
                    onClick={handleGenerate}
                    disabled={!canGenerate}
                    className={`w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-base font-semibold transition-all ${
                      canGenerate
                        ? 'bg-accent hover:bg-accent text-white shadow-lg hover:shadow-red-600/25'
                        : 'bg-surface-elevated text-text-dim cursor-not-allowed'
                    }`}
                  >
                    🎬 Generate Motion Graphics
                  </button>
                  {!canGenerate && (
                    <div className="text-xs text-text-dim text-center space-y-0.5">
                      {inputMode === 'document' && !selectedDocument && <p>↑ Select a story document</p>}
                      {!styleSlug && <p>↑ Select a visual style</p>}
                      {totalAudioDuration <= 0 && <p>↑ Select an audio file and calculate its duration</p>}
                      {estimate && storageUsed !== null && estimate.storageNeededMB > (maxStorageGB * 1024) - storageUsed && (
                        <p className="text-status-error">↑ Insufficient storage — delete old files or upgrade your plan</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ═══ Bottom action area — Individual Prompt mode ═══ */}
              {!isGeneratingSingle && !isSingleComplete && inputMode === 'prompt' && (
                <div className="flex flex-col items-center gap-2 pb-8 mt-4">
                  <div className="w-full bg-surface-card rounded-xl border border-border-card p-4 mb-4 space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-text-dim">Codegen model</span>
                      <span className="text-text-secondary text-xs">{codegenModel === 'opus' ? 'Claude Opus 4.6' : 'Claude Sonnet 4.6'}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-text-dim">
                      <span>Per-clip tokens ({codegenModel === 'opus' ? 'Opus 4.6' : 'Sonnet 4.6'})</span>
                      <span>~{mgCodegenTokensPerClip(codegenModel).toLocaleString()}</span>
                    </div>
                    <div className="border-t border-border pt-2 flex items-center justify-between">
                      <span className="text-white font-semibold">Estimated tokens (1 clip)</span>
                      <span className="font-bold text-lg text-status-success">{singleClipTokens.toLocaleString()}</span>
                    </div>
                  </div>
                  <button
                    onClick={handleGenerateSingle}
                    disabled={!canGenerateSingle}
                    className={`w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-base font-semibold transition-all ${
                      canGenerateSingle
                        ? 'bg-accent hover:bg-accent text-white shadow-lg hover:shadow-red-600/25'
                        : 'bg-surface-elevated text-text-dim cursor-not-allowed'
                    }`}
                  >
                    ✨ Generate Clip
                  </button>
                  {!canGenerateSingle && (
                    <div className="text-xs text-text-dim text-center space-y-0.5">
                      {singleWordCount === 0 && <p>↑ Enter a prompt</p>}
                      {!styleSlug && <p>↑ Select a visual style</p>}
                    </div>
                  )}
                </div>
              )}

              {/* ═══ Individual Prompt — Completion screen (video + Done) ═══ */}
              {isSingleComplete && singleVideoUrl && (
                <div className="mb-6 bg-surface-card rounded-xl border border-status-success p-6">
                  <div className="flex items-center gap-3 mb-5">
                    <CheckCircle2 className="h-6 w-6 text-status-success shrink-0" />
                    <div>
                      <h2 className="text-lg font-semibold text-status-success">Test Clip Ready</h2>
                      <p className="text-sm text-text-dim mt-0.5">{videoDuration}s · {selectedStyle?.display_name ?? styleSlug}</p>
                    </div>
                  </div>
                  <div className="rounded-xl overflow-hidden bg-black mb-5">
                    <video src={singleVideoUrl} controls className="w-full aspect-video object-contain" preload="metadata" />
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-3 pt-5 border-t border-border">
                    <button
                      onClick={handleDoneSingle}
                      disabled={singleDoneLoading}
                      className="flex items-center gap-2 px-4 py-2 bg-surface-elevated hover:bg-surface-elevated text-text-muted rounded-xl text-sm transition-colors disabled:opacity-50"
                    >
                      {singleDoneLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      Done
                    </button>
                    <a
                      href={singleVideoUrl}
                      download={`mg_test_${styleSlug}.mp4`}
                      className="flex items-center gap-2 px-4 py-2 bg-action-info-hover hover:bg-action-info text-white rounded-xl text-sm transition-colors"
                    >
                      <Download className="h-4 w-4" />
                      Download
                    </a>
                  </div>
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
                      <span className="text-xs text-text-muted">Phase 1 — MG Prompt Generation</span>
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
                      <span className="text-xs text-text-muted">Phase 2 — Motion Graphics Rendering</span>
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
                    <p className="text-xs text-text-dim mt-1">~{MG_SECONDS_PER_CLIP} seconds per clip</p>
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
                      <h2 className="text-lg font-semibold text-status-success">Motion Graphics Generated{generationTitle ? ` for ${generationTitle}` : ''}!</h2>
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
                                  title="Regenerate this motion-graphics clip"
                                  className="flex items-center gap-1 px-2 py-1 bg-surface-elevated hover:bg-accent-hover text-text-muted hover:text-white rounded text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  <RefreshCw className="h-3 w-3" />
                                  Redo
                                </button>
                              </div>
                            </div>
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
                          Show {generatedVideos.length} Motion Graphics Clip{generatedVideos.length !== 1 ? 's' : ''}
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

export default MotionGraphicsGenerator;
