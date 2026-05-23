import React, { useState, useEffect, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { BookOpen, FileText, Loader, Download, RefreshCw, Check, X, Sparkles, Brain, CheckCircle2, AlertCircle, AlertTriangle, Star, Zap, Users, BookOpen as BookOpenIcon, Palette, Info, ChevronDown, ChevronUp, Settings, Plus, Trash2, Lock } from 'lucide-react';
import { saveAs } from 'file-saver';
import { Listbox, Transition } from '@headlessui/react';
import DashboardLayout from '../components/DashboardLayout';
import StatusBanner from '../components/StatusBanner';
import RatingWheel from '../components/RatingWheel';
import TabManager from '../components/TabManager';
import { createClient } from '@supabase/supabase-js';
import { useSessionStorage, useTabSessionStorage, clearAllSessionStorage, clearTabSessionStorage } from '../hooks/useSessionStorage';
import { useIsLegacyPlan } from '../hooks/useIsLegacyPlan';
import { LEGACY_LLM_MULTIPLIERS, NEW_LLM_MULTIPLIERS } from '../data/tokenCosts';
import { checkIsEnterpriseUser, deleteTab, type TabInfo } from '../utils/tabManager';
import {
  generateFeedback,
  generateRewrite,
  compareStories,
  parseComparisonResult,
  createDocument,
  estimateStoryCredits,
  checkCredits,
  type Chapter,
  type ComparisonResult,
} from '../utils/generator';
import {
  StoryTask,
  getTasks,
  saveTasks,
  stopTasks,
  clearTaskError,
  ensureBatchTasks,
} from '../utils/taskManager';
import ErrorBoundary from './ErrorBoundary';
import { v4 as uuidv4 } from 'uuid';
import { Link } from 'react-router-dom';
import MasterPrompt from '../components/MasterPrompt';
import { checkNetworkStatus, withTimeout, formatNumber, getWordCount, isValidNumericInput } from '../utils/shared';
import { fetchWithFallback } from '../utils/fetchWithFallback';

// Initialize Supabase client
const supabaseUrl = import.meta.env.SUPABASE_URL;
const supabaseKey = import.meta.env.SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase URL or Key is missing. Please check your environment variables.');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Generation states
type GenerationState = 'idle' | 'outline' | 'queueing' | 'generating' | 'correctingQueueing' | 'correcting' | 'corrected' | 'comparing' | 'complete' | 'error' | 'stopped';

// States where the form should be locked (not idle, error, or stopped)
const NON_IDLE_STATES: GenerationState[] = ['outline', 'queueing', 'generating', 'correctingQueueing', 'correcting', 'corrected', 'comparing', 'complete'];

// Plan token limits — single source of truth
const PLAN_MAX_TOKENS: Record<string, number> = {
  free: 400000,
  standard: 4000000,
  plus: 6000000,
  premium: 10000000,
  pro: 25000000,
  elite: 50000000,
  ultimate: 75000000,
  enterprise: 250000000,
};

// Interface for story documents
interface StoryDocument {
  id: string;
  title: string;
  is_corrected: boolean;
  created_at: string;
  file_path: string;
  file_url: string;
  content?: string;
  word_count?: number;
  group_id: string;
}

// Runtime calculation constants and utilities
const WORDS_PER_MINUTE_AUDIO = 125; // 7500 words = 60 minutes

// YouTube URL validation
const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[\w-]{11}/;
const validateYoutubeUrl = (url: string): string | null => {
  if (!url.trim()) return null;
  if (!YOUTUBE_URL_REGEX.test(url.trim())) return 'Not a valid YouTube URL';
  return null;
};
const extractYoutubeVideoId = (url: string): string | null => {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
};

const minutesToWordCount = (minutes: number): number => {
  return Math.round(minutes * WORDS_PER_MINUTE_AUDIO);
};

const wordCountToMinutes = (wordCount: number): number => {
  return Math.round(wordCount / WORDS_PER_MINUTE_AUDIO);
};

const getMinuteLimitsForModel = (model: string) => {
  const modelConfig = modelOptions.find(m => m.value === model);
  if (!modelConfig) return { min: 3, max: 285 };
  
  return {
    min: Math.ceil(200 / WORDS_PER_MINUTE_AUDIO),
    max: Math.floor(modelConfig.maxWords / WORDS_PER_MINUTE_AUDIO)
  };
};

// Language options
const languageOptions = [
  { value: 'english', label: 'English' },
  { value: 'german', label: 'German' },
  { value: 'spanish', label: 'Spanish' },
  { value: 'french', label: 'French' },
];

// Model options. Per-model `tokenMultiplier` / `description` come from the
// active plan map (legacy vs new); other fields are plan-independent.
interface ModelOption {
  value: string;
  label: string;
  tokenMultiplier: number;
  maxWords: number;
  maxWordsPerBatch: number;
  description: string;
}

function buildModelOptions(isLegacy: boolean): ModelOption[] {
  const m = isLegacy ? LEGACY_LLM_MULTIPLIERS : NEW_LLM_MULTIPLIERS;
  return [
    {
      value: 'deepseek',
      label: 'Core Model',
      tokenMultiplier: m.deepseek,
      maxWords: 50000,
      maxWordsPerBatch: 1000,
      description: `${m.deepseek}x tokens`,
    },
    {
      value: 'sonnet',
      label: 'Claude Sonnet 4.6',
      tokenMultiplier: m.sonnet,
      maxWords: 150000,
      maxWordsPerBatch: 3000,
      description: `${m.sonnet}x tokens`,
    },
    {
      value: 'opus',
      label: 'Claude Opus 4.6',
      tokenMultiplier: m.opus,
      maxWords: 150000,
      maxWordsPerBatch: 3000,
      description: `${m.opus}x tokens`,
    },
  ];
}

// Module-scope default (legacy rates) for any helper that needs `maxWords` /
// `maxWordsPerBatch` outside the component tree. The plan-aware variant is
// computed inside the component via useMemo.
const modelOptions = buildModelOptions(true);

// Helper function to sanitize file names
const sanitizeFileName = (fileName: string): string => {
  return fileName
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-');
};

// Token estimation constants
const OUTLINE_TOKENS = 1500;
const FEEDBACK_TOKENS = 1200;
const STORY_GENERATION_TOKENS_PER_WORD = 1.33;

// Timeout constants (in milliseconds)
const OPERATION_TIMEOUT = 3600000;
const OUTLINE_TIMEOUT = 4200000;
const TASK_STALL_TIMEOUT = 1800000;
const RETRY_DELAY = 2000;

// Reduce MAX_RETRIES from 100 to 5 to avoid excessive retries on transient errors
const MAX_RETRIES = 10;
const POLLING_INTERVAL = 20000; // Changed from 30000 to 20000

// Increase subscription check interval from 30s to 60s to reduce unnecessary resubscriptions
const SUBSCRIPTION_CHECK_INTERVAL = 60000;
const BATCH_SIZE = 500; // From calculateEstimatedTime

// Utility function to retry a Supabase operation with enhanced error logging
const withRetry = async <T,>(operation: () => Promise<T>, operationName: string, maxRetries: number = MAX_RETRIES): Promise<T> => {
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;

      // Enhanced logging for different error types
      if (error.message.includes('Failed to fetch') || error.message.includes('CORS') || error.message.includes('Load failed')) {
        console.warn(`Network error (attempt ${attempt}/${maxRetries}) for ${operationName}: ${error.message}`);
      } else if (error.status === 500) {
        console.error(`Server error (attempt ${attempt}/${maxRetries}) for ${operationName}: HTTP 500 Internal Server Error`);
      } else if (error.message.includes('timeout')) {
        console.error(`Timeout error (attempt ${attempt}/${maxRetries}) for ${operationName}: ${error.message}`);
      } else {
        console.warn(`Error (attempt ${attempt}/${maxRetries}) for ${operationName}: ${error.message}`);
      }
    
      // Always retry on connection errors
      if (error.message.includes('Failed to fetch') || error.message.includes('CORS') || error.message.includes('Load failed')) {
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt)); // Exponential backoff
        } else {
          // On final attempt for connection errors, return a fallback or continue silently
          console.warn(`Connection issues persist after ${maxRetries} attempts for ${operationName}, continuing with fallback`);
          // Return a reasonable fallback based on the operation type
          if (operationName.includes('fetch') || operationName.includes('poll') || operationName.includes('Tasks')) {
            return [] as T; // Return empty array for fetch operations
          }
          // For other operations, return a default value instead of throwing
          return {} as T;
        }
      } else if ((error.status === 500 || error.message.includes('timeout')) && attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt)); // Exponential backoff
      } else if (attempt >= maxRetries) {
        break;
      }
    }
  }

  // For non-connection errors that exhausted retries, still return fallback instead of throwing
  console.warn(`Operation ${operationName} failed after ${maxRetries} attempts, using fallback`);
  if (operationName.includes('fetch') || operationName.includes('poll') || operationName.includes('Tasks')) {
    return [] as T;
  }
  return {} as T;
};

// Utility function to truncate text to a maximum number of tokens (approximation)
const truncateText = (text: string, maxTokens: number): string => {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars) + '... [Truncated]';
};

// Utility function to check if a task is stalled (no progress for 30 minutes)
const isTaskStalled = (task: StoryTask): boolean => {
  if (!task.updated_at) return false;
  const lastUpdate = new Date(task.updated_at).getTime();
  return Date.now() - lastUpdate > TASK_STALL_TIMEOUT;
};

// Generate a UUID with fallback
const generateUuid = (): string => {
  try {
    return crypto.randomUUID();
  } catch (e) {
    return uuidv4();
  }
};

// Calculate estimated audio time based on word count
const calculateEstimatedAudioTime = (wordCount: number): string => {
  if (!wordCount || isNaN(wordCount) || wordCount <= 0) return '0 minutes';
  
  // 7500 words = 60 minutes
  const totalMinutes = Math.round((wordCount / 7500) * 60);
  
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours} hour${hours !== 1 ? 's' : ''}${minutes > 0 ? ` and ${minutes} minute${minutes !== 1 ? 's' : ''}` : ''}`;
  }
  
  return `${totalMinutes} minute${totalMinutes !== 1 ? 's' : ''}`;
};

// Reusable status message block for the generation pipeline
interface StatusLine {
  icon: React.ElementType;
  text: string;
  animate?: 'spin' | 'pulse';
  iconClass?: string;
}

const GenerationStatusBlock = ({ lines, descriptions, onStop }: {
  lines: StatusLine[];
  descriptions: string[];
  onStop?: () => void;
}) => (
  <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-4 space-y-3">
    {lines.map((line, i) => (
      <div key={i} className="flex items-center space-x-3 text-text-secondary">
        <line.icon className={`h-5 w-5 ${line.iconClass || 'text-accent-text'} ${line.animate === 'spin' ? 'animate-spin' : line.animate === 'pulse' ? 'animate-pulse' : ''}`} />
        <span>{line.text}</span>
      </div>
    ))}
    {descriptions.map((desc, i) => (
      <p key={i} className="text-sm text-text-muted">{desc}</p>
    ))}
    {onStop && (
      <div className="flex justify-end">
        <button
          onClick={onStop}
          className="flex items-center px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover transition duration-150 ease-in-out shadow-sm"
        >
          <X className="h-5 w-5 mr-2" />
          Stop
        </button>
      </div>
    )}
  </div>
);

// Evaluation categories for comparison UI
const evaluationCategories = [
  { key: 'pacing', label: 'Pacing', icon: Zap, color: 'text-eval-pacing' },
  { key: 'consistency', label: 'Consistency', icon: CheckCircle2, color: 'text-eval-consistency' },
  { key: 'characterDevelopment', label: 'Character Development', icon: Users, color: 'text-eval-character' },
  { key: 'plotCoherence', label: 'Plot Coherence', icon: BookOpenIcon, color: 'text-eval-plot' },
  { key: 'toneAndAtmosphere', label: 'Tone & Atmosphere', icon: Palette, color: 'text-eval-tone' },
  { key: 'overallQuality', label: 'Overall Quality', icon: Star, color: 'text-eval-overall' },
];

// Evaluation section component for comparison UI
const EvaluationSection = ({ review, label }: { review: any, label: string }) => (
  <div className="space-y-6">
    <div className="text-center">
      <h3 className="text-lg font-semibold text-white mb-2">{label}</h3>
      <RatingWheel rating={review.rating} label={label} />
      <p className="mt-2 text-text-muted text-sm">{review.wordCount} words</p>
    </div>

    <div className="space-y-4">
      <h4 className="text-sm font-medium text-text-secondary">Evaluation</h4>
      <div className="space-y-3">
        {evaluationCategories.map(({ key, label, icon: Icon, color }) => (
          <div key={key} className="rounded-xl bg-surface-card border border-border-card p-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${color}`} />
                <p className={`text-xs font-medium ${color}`}>{label}</p>
              </div>
              {key !== 'overallQuality' && (
                <span className="text-xs font-semibold text-text-secondary">{review[key].rating}/10</span>
              )}
            </div>
            <p className="text-text-secondary text-sm">
              {key === 'overallQuality' ? review[key] : review[key].text}
            </p>
          </div>
        ))}
      </div>
    </div>
  </div>
);

export interface GeneratorRef {
  cleanup: () => Promise<void>;
}

interface GeneratorProps {
  initialTab: number;
  initialGroupId: string;
  isEnterpriseUser: boolean;
  initialTabs?: TabInfo[];
  userId: string;
  onTabChange: (tab: number, groupId: string) => void;
  onTabCreate: (tab: number, groupId: string) => void;
  onTabClose: (tab: number, groupId: string) => void;
  onRequestRemount?: (tab: number) => void;
}

const Generator = forwardRef<GeneratorRef, GeneratorProps>((props, ref) => {
  const {
    initialTab,
    initialGroupId,
    isEnterpriseUser,
    initialTabs,
    userId,
    onTabChange,
    onTabCreate,
    onTabClose,
    onRequestRemount
  } = props;

  // Tab state comes from props (managed by GeneratorContainer)
  const currentTab = initialTab;

  // Plan-aware LLM multipliers. `modelOptions` shadows the module-scope
  // default with the active plan's rates so all in-component references
  // (display labels, estimator math) reflect what the backend will charge.
  const { isLegacy } = useIsLegacyPlan();
  const modelOptions = useMemo(() => buildModelOptions(isLegacy), [isLegacy]);

  // Replace useSessionStorage with useState for storyInput
  const [storyInput, setStoryInput] = useState({
    title: '',
    description: '',
    wordCount: minutesToWordCount(10).toString(), // Default to 10 min runtime (1250 words)
    language: 'english',
    model: 'deepseek',
  });

  // Runtime vs Word Count toggle
  const [isRuntimeMode, setIsRuntimeMode] = useTabSessionStorage('isRuntimeMode', true, currentTab);
  const [runtimeMinutes, setRuntimeMinutes] = useTabSessionStorage('runtimeMinutes', '10', currentTab);

  // Sync wordCount from runtimeMinutes when in runtime mode (fixes default showing validation error)
  useEffect(() => {
    if (isRuntimeMode && runtimeMinutes) {
      const minutes = parseInt(runtimeMinutes) || 0;
      const calculatedWordCount = minutesToWordCount(minutes);
      if (calculatedWordCount > 0 && storyInput.wordCount !== calculatedWordCount.toString()) {
        setStoryInput(prev => ({ ...prev, wordCount: calculatedWordCount.toString() }));
      }
    }
  }, [isRuntimeMode, runtimeMinutes]);

  // Master Prompt state
  const [masterPromptEnabled, setMasterPromptEnabled] = useTabSessionStorage('masterPromptEnabled', false, currentTab);
  const [masterPromptEnhanceAI, setMasterPromptEnhanceAI] = useTabSessionStorage('masterPromptEnhanceAI', false, currentTab);
  const [masterPromptData, setMasterPromptData] = useTabSessionStorage<{
    visualStyle: string;
    setting: string;
    atmosphere: string;
    environmentOnly: boolean;
    characters: Array<{ name: string; description: string }>;
  } | null>('masterPromptData', null, currentTab);

  // Pause TTS state
  const [pauseTTS, setPauseTTS] = useTabSessionStorage('pauseTTS', false, currentTab);

  // YouTube Inspiration state
  const [youtubeInspirationEnabled, setYoutubeInspirationEnabled] = useTabSessionStorage('youtubeInspirationEnabled', false, currentTab);
  const [youtubeLinks, setYoutubeLinks] = useTabSessionStorage<string[]>('youtubeLinks', [''], currentTab);
  const [youtubeLinkErrors, setYoutubeLinkErrors] = useState<Record<number, string>>({});

  const [generationState, setGenerationState] = useState<GenerationState>('idle');
  const [settingsCollapsed, setSettingsCollapsed] = useState(false);
  const [prevGenState, setPrevGenState] = useState(generationState);

  // Auto-collapse settings when generation starts
  if (generationState !== prevGenState) {
    setPrevGenState(generationState);
    if (prevGenState === 'idle' && generationState !== 'idle') {
      setSettingsCollapsed(true);
    } else if (generationState === 'idle') {
      setSettingsCollapsed(false);
    }
  }
  const [progress, setProgress] = useState(0);
  const [isLoadingTasks, setIsLoadingTasks] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const [outline, setOutline] = useState('');
  const [showOutlineConfirmation, setShowOutlineConfirmation] = useState(false);
  const [generatedContent, setGeneratedContent] = useState({
    story: '',
    correctedStory: '',
    comparison: {} as ComparisonResult,
    imagePrompts: [] as string[],
    storyFileName: '',
    correctedFileName: '',
    storyTitle: '',
    correctedTitle: '',
  });
  const [totalTokens, setTotalTokens] = useState(0);
  const [storyError, setStoryError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [userTokenBalance, setUserTokenBalance] = useSessionStorage('userTokenBalance', 0);
  const [userPlan, setUserPlan] = useSessionStorage('userPlan', 'free');
  const [totalBatches, setTotalBatches] = useState(0);
  const [groupId, setGroupId] = useState<string | null>(initialGroupId || null);
  const [pendingTokenUpdates, setPendingTokenUpdates] = useState<{ tokens: number }[]>([]);
  const [sessionStorageError, setSessionStorageError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [batchStatuses, setBatchStatuses] = useState<{ batchNumber: number; status: string; progress: number }[]>([]);
  const [wordCountError, setWordCountError] = useState<string | null>(null);
  const [renderKey, setRenderKey] = useState(0);
  // Counter to re-trigger mount-only effects (e.g. after handleDone)
  const [reinitTrigger, setReinitTrigger] = useState(0);
  const [documents, setDocuments] = useState<StoryDocument[]>([]);
  const [comparing, setComparing] = useState(false);
  const [doc1Label, setDoc1Label] = useState('Original Story');
  const [doc2Label, setDoc2Label] = useState('Corrected Story');
  const [outlineGenerating, setOutlineGenerating] = useState(false);
  const [hasActiveTasks, setHasActiveTasks] = useState(false); // New state to track active tasks
  const [currentTask, setCurrentTask] = useState<StoryTask | null>(null); // New state for current task
  const [areTasksComplete, setAreTasksComplete] = useState(false); // Track if all tasks are completed based on database status

  // Estimated tokens for each process - compute default from initial wordCount/model
  const [estimatedTokens, setEstimatedTokens] = useState(() => {
    const defaultWordCount = minutesToWordCount(10); // 1250 words
    const defaultModel = modelOptions.find(m => m.value === 'deepseek') || modelOptions[0];
    const multiplier = defaultModel.tokenMultiplier;
    const batchCount = Math.ceil(defaultWordCount / (defaultModel.maxWordsPerBatch || 3000));
    const avgWordsPerBatch = defaultWordCount / batchCount;
    let inputTokens = 0;
    for (let i = 0; i < batchCount; i++) {
      inputTokens += 300 + 200 + (i * avgWordsPerBatch * STORY_GENERATION_TOKENS_PER_WORD);
    }
    const outputTokens = defaultWordCount * STORY_GENERATION_TOKENS_PER_WORD;
    const initialStory = Math.round((inputTokens * 0.25 + outputTokens) * multiplier);
    return { initialStory, correctedStory: 0, comparison: 0 };
  });

  // Track tokens used for each process for the summary
  const [usedTokens, setUsedTokens] = useState({
    initialStory: 0,
    correctedStory: 0,
    comparison: 0,
  });

  const shouldStopRef = useRef(false);
  const generationStartTime = useRef<number | null>(null);
  const lastSubscriptionUpdateRef = useRef<number>(Date.now());
  const saveFormDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Add a ref to track processed task IDs
  const processedTaskIds = useRef<Set<string>>(new Set());
  
  // Ref to prevent auto-save when loading tab data programmatically
  const isLoadingTabData = useRef(false);

  // Expose cleanup method to parent via ref
  useImperativeHandle(ref, () => ({
    cleanup: async () => {
      console.log(`[Generator] Cleanup called for tab ${currentTab}, status: ${generationState}`);
      
      if (generationState === 'generating' || generationState === 'outline' || generationState === 'queueing') {
        // Tab is generating - call stop logic
        console.log(`[Generator] Tab ${currentTab} is generating, stopping generation...`);
        await handleStop();
      } else if (generationState === 'complete' || generationState === 'corrected') {
        // Tab is complete - call done logic
        console.log(`[Generator] Tab ${currentTab} is complete, cleaning up...`);
        await handleDone();
      }
      
      console.log(`[Generator] Cleanup complete for tab ${currentTab}`);
    }
  }));

  // Helper to update tab status in database
  const updateCurrentTabStatus = async (status: 'idle' | 'outline' | 'generating' | 'error' | 'complete', title?: string) => {
    if (!currentUserId) return;
    
    try {
      const { updateTabStatus } = await import('../utils/tabManager');
      await updateTabStatus(currentUserId, 'story', currentTab, status, groupId || undefined, title);
    } catch (error) {
      console.error('Error updating tab status:', error);
    }
  };

  // Get selected model configuration
  const selectedModel = useMemo(() => modelOptions.find(m => m.value === storyInput.model) || modelOptions[0], [storyInput.model]);

  // Force free users to Core Model if they have a paid model selected from a previous session
  useEffect(() => {
    if (userPlan === 'free' && storyInput.model !== 'deepseek') {
      setStoryInput(prev => ({ ...prev, model: 'deepseek' }));
    }
  }, [userPlan, storyInput.model]); // eslint-disable-line react-hooks/exhaustive-deps

  // Add this helper function to detect and recover active group
  async function getActiveGroupId(userId: string, tab: number = 1): Promise<{ groupId: string | null, isCorrected: boolean, tasks: StoryTask[], outlineTask: StoryTask | null, isComplete?: boolean }> {
    try {
      // Query for any non-completed tasks for this user (pending, running, processing)
      // Order by created_at desc to get the most recent group
      // Filter out video_process tasks and filter by tab
      const { data: activeTasks, error } = await supabase
        .from('story_tasks')
        .select('*')
        .eq('user_id', userId)
        .eq('tab', tab)
        .in('status', ['pending', 'running', 'processing', 'completed', 'completed_final']) // Include completed tasks for detection
        .neq('video_process', true) // Exclude video_process tasks
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error querying active tasks:', error);
        return { groupId: null, isCorrected: false, tasks: [], outlineTask: null, isComplete: false };
      }

      if (!activeTasks || activeTasks.length === 0) {
        console.log('No active non-video_process tasks found for user');
        return { groupId: null, isCorrected: false, tasks: [], outlineTask: null, isComplete: false };
      }

      // All tasks in a group share the same group_id, so grab the first one's group_id
      const activeGroupId = activeTasks[0].group_id;

      // Get all tasks for this group
      const groupTasks = activeTasks.filter(t => t.group_id === activeGroupId);

      // Determine if this is a correction (based on is_corrected flag)
      const isCorrected = groupTasks.some(t => t.is_corrected === true);

      // Find outline task for this group (batch_number = 0)
      const outlineTask = groupTasks.find(t => t.batch_number === 0);

      // Check if generation is complete using the unified helper function
      const { areStoryTasksComplete } = await import('../utils/tabManager');
      const isComplete = areStoryTasksComplete(groupTasks);

      console.log(`Found active group: ${activeGroupId}, isCorrected: ${isCorrected}, task count: ${groupTasks.length}, outline task: ${outlineTask ? 'found' : 'not found'}, isComplete: ${isComplete}`);

      return { 
        groupId: activeGroupId, 
        isCorrected, 
        tasks: isComplete ? [] : groupTasks.filter(t => ['pending', 'running', 'processing'].includes(t.status)), // Only return non-completed tasks if not complete
        outlineTask,
        isComplete
      };
    } catch (err: any) {
      console.error('Error in getActiveGroupId:', err);
      return { groupId: null, isCorrected: false, tasks: [], outlineTask: null, isComplete: false };
    }
  }

  // ====================================================================
  // TAB MANAGEMENT - NOW HANDLED BY GeneratorContainer
  // The following handlers are kept for backward compatibility
  // but are now delegated to the container component via props
  // ====================================================================
  
  // Tab management handlers (deprecated - handled by container)
  const handleTabChange = async (newTab: number, newGroupId: string) => {
    console.log(`Switching from tab ${currentTab} to tab ${newTab}`);
    
    // Save current tab's form inputs before switching
    if (currentUserId) {
      const { saveTabFormInputs } = await import('../utils/tabManager');
      await saveTabFormInputs(currentUserId, 'story', currentTab, {
        title: storyInput.title,
        storyDescription: storyInput.description,
        wordCount: storyInput.wordCount ? parseInt(storyInput.wordCount) : undefined,
        language: storyInput.language,
        model: storyInput.model,
      });
    }
    
    // Clear current tab's session storage
    clearTabSessionStorage(currentTab);
    
    // Update current tab
    setCurrentTab(newTab);
    setGroupId(newGroupId);
    
    // Reset UI state
    setIsLoadingTasks(true);
    
    // Explicitly reset all tab-scoped states to new tab's values from session storage
    // This forces hooks to read from the new tab's keys immediately
    const getStorageKey = (key: string, tab: number) => `${key}_tab${tab}`;
    
    try {
      // Read from session storage for the new tab
      const newTabGenerationState = sessionStorage.getItem(getStorageKey('generationState', newTab));
      const newTabProgress = sessionStorage.getItem(getStorageKey('progress', newTab));
      const newTabTimeRemaining = sessionStorage.getItem(getStorageKey('timeRemaining', newTab));
      const newTabOutline = sessionStorage.getItem(getStorageKey('outline', newTab));
      const newTabShowOutlineConfirmation = sessionStorage.getItem(getStorageKey('showOutlineConfirmation', newTab));
      const newTabGeneratedContent = sessionStorage.getItem(getStorageKey('generatedContent', newTab));
      const newTabTotalTokens = sessionStorage.getItem(getStorageKey('totalTokens', newTab));
      const newTabStoryError = sessionStorage.getItem(getStorageKey('storyError', newTab));
      const newTabFeedback = sessionStorage.getItem(getStorageKey('feedback', newTab));
      const newTabErrorMessage = sessionStorage.getItem(getStorageKey('errorMessage', newTab));
      const newTabTotalBatches = sessionStorage.getItem(getStorageKey('totalBatches', newTab));
      const newTabUsedTokens = sessionStorage.getItem(getStorageKey('usedTokens', newTab));
      const newTabDocuments = sessionStorage.getItem(`tab-documents-${newTab}`);
      const newTabComparing = sessionStorage.getItem(`tab-comparing-${newTab}`);
      const newTabDoc1Label = sessionStorage.getItem(`tab-doc1Label-${newTab}`);
      const newTabDoc2Label = sessionStorage.getItem(`tab-doc2Label-${newTab}`);
      const newTabOutlineGenerating = sessionStorage.getItem(`tab-outlineGenerating-${newTab}`);
      
      // Set states to new tab's values (or defaults if not set)
      setGenerationState(newTabGenerationState ? JSON.parse(newTabGenerationState) : 'idle');
      setProgress(newTabProgress ? JSON.parse(newTabProgress) : 0);
      setTimeRemaining(newTabTimeRemaining ? JSON.parse(newTabTimeRemaining) : null);
      setOutline(newTabOutline ? JSON.parse(newTabOutline) : '');
      setShowOutlineConfirmation(newTabShowOutlineConfirmation ? JSON.parse(newTabShowOutlineConfirmation) : false);
      setGeneratedContent(newTabGeneratedContent ? JSON.parse(newTabGeneratedContent) : {
        story: '',
        correctedStory: '',
        comparison: {} as ComparisonResult,
        imagePrompts: [],
        storyFileName: '',
        correctedFileName: '',
        storyTitle: '',
        correctedTitle: '',
      });
      setTotalTokens(newTabTotalTokens ? JSON.parse(newTabTotalTokens) : 0);
      setStoryError(newTabStoryError ? JSON.parse(newTabStoryError) : null);
      setFeedback(newTabFeedback ? JSON.parse(newTabFeedback) : null);
      setErrorMessage(newTabErrorMessage ? JSON.parse(newTabErrorMessage) : null);
      setTotalBatches(newTabTotalBatches ? JSON.parse(newTabTotalBatches) : 0);
      setUsedTokens(newTabUsedTokens ? JSON.parse(newTabUsedTokens) : {
        initialStory: 0,
        correctedStory: 0,
        comparison: 0,
      });
      setDocuments(newTabDocuments ? JSON.parse(newTabDocuments) : []);
      setComparing(newTabComparing ? JSON.parse(newTabComparing) : false);
      setDoc1Label(newTabDoc1Label ? JSON.parse(newTabDoc1Label) : 'Original Story');
      setDoc2Label(newTabDoc2Label ? JSON.parse(newTabDoc2Label) : 'Corrected Story');
      setOutlineGenerating(newTabOutlineGenerating ? JSON.parse(newTabOutlineGenerating) : false);
    } catch (error) {
      console.error('Error reading session storage for new tab:', error);
      // If reading fails, set defaults
      setGenerationState('idle');
      setProgress(0);
      setTimeRemaining(null);
      setOutline('');
      setShowOutlineConfirmation(false);
      setGeneratedContent({
        story: '',
        correctedStory: '',
        comparison: {} as ComparisonResult,
        imagePrompts: [],
        storyFileName: '',
        correctedFileName: '',
        storyTitle: '',
        correctedTitle: '',
      });
      setTotalTokens(0);
      setStoryError(null);
      setFeedback(null);
      setErrorMessage(null);
      setTotalBatches(0);
      setUsedTokens({
        initialStory: 0,
        correctedStory: 0,
        comparison: 0,
      });
      setDocuments([]);
      setComparing(false);
      setDoc1Label('Original Story');
      setDoc2Label('Corrected Story');
      setOutlineGenerating(false);
    }
    
    // Load form inputs for the new tab from database
    if (currentUserId) {
      const { getTabFormInputs } = await import('../utils/tabManager');
      const formInputs = await getTabFormInputs(currentUserId, 'story', newTab);
      
      // Set flag to prevent auto-save during programmatic load
      isLoadingTabData.current = true;
      
      if (formInputs) {
        setStoryInput({
          title: formInputs.title || '',
          description: formInputs.storyDescription || '',
          wordCount: formInputs.wordCount || minutesToWordCount(10).toString(),
          language: formInputs.language || 'english',
          model: formInputs.model || 'deepseek',
        });
        if (formInputs.youtubeInspirationEnabled !== undefined) setYoutubeInspirationEnabled(formInputs.youtubeInspirationEnabled);
        if (formInputs.youtubeLinks) setYoutubeLinks(formInputs.youtubeLinks.length > 0 ? formInputs.youtubeLinks : ['']);
      } else {
        // Reset to defaults if no saved inputs
        setStoryInput({
          title: '',
          description: '',
          wordCount: minutesToWordCount(10).toString(),
          language: 'english',
          model: 'deepseek',
        });
        setYoutubeInspirationEnabled(false);
        setYoutubeLinks(['']);
      }
      
      // Reset flag after load completes
      setTimeout(() => {
        isLoadingTabData.current = false;
      }, 100);
      
      // Load state for the new tab from database
      const { groupId: activeGroupId, tasks, outlineTask } = await getActiveGroupId(currentUserId, newTab);
      if (activeGroupId && tasks.length > 0) {
        // Tab has active generation
        // IMPORTANT: Don't read title/description/wordCount/model from tasks
        // These are already loaded from tabs table via getTabFormInputs()
        // Only use tasks for progress/status tracking
        console.log(`Tab ${newTab} has active generation, form data already loaded from tabs table`);
        
        // Form inputs (title, description, wordCount, model) are already loaded from tabs table
        // Just keep them as-is - no need to read from tasks
        
        // The polling useEffect will handle loading generation progress
      } else {
        // Tab is idle - ensure isLoadingTasks reflects this
        console.log(`Tab ${newTab} is idle`);
        // Don't override generationState here since we already set it from session storage above
        // Only set isLoadingTasks to false since no active tasks
        setIsLoadingTasks(false);
      }
    } else {
      // If no user, just stop loading
      setIsLoadingTasks(false);
    }
  };

  const handleTabCreate = async (newTab: number, newGroupId: string) => {
    console.log(`Creating new tab ${newTab}`);
    
    if (!currentUserId) return;
    
    // Clear any stale session storage for this tab number (from previously deleted tab)
    clearTabSessionStorage(newTab);
    
    // Update tab in database with the new groupId
    const { updateTabStatus } = await import('../utils/tabManager');
    await updateTabStatus(currentUserId, 'story', newTab, 'idle', newGroupId);
    
    // Switch to new tab
    setCurrentTab(newTab);
    setGroupId(newGroupId);
    
    // Set flag to prevent auto-save during initialization
    isLoadingTabData.current = true;
    
    // Initialize with default form inputs
    setStoryInput({
      title: '',
      description: '',
      wordCount: minutesToWordCount(10).toString(),
      language: 'english',
      model: 'deepseek',
    });
    
    // Clear all tab-specific state
    setGenerationState('idle');
    setProgress(0);
    setTimeRemaining(null);
    setOutline('');
    setShowOutlineConfirmation(false);
    setGeneratedContent({
      story: '',
      correctedStory: '',
      comparison: {} as ComparisonResult,
      imagePrompts: [],
      storyFileName: '',
      correctedFileName: '',
      storyTitle: '',
      correctedTitle: '',
    });
    setTotalTokens(0);
    setStoryError(null);
    setFeedback(null);
    setErrorMessage(null);
    setTotalBatches(0);
    setUsedTokens({
      initialStory: 0,
      correctedStory: 0,
      comparison: 0,
    });
    setDocuments([]);
    setIsLoadingTasks(false);
    
    // Reset flag after initialization completes
    setTimeout(() => {
      isLoadingTabData.current = false;
    }, 100);
  };

  const handleTabClose = async (tab: number, groupIdToClose: string) => {
    console.log(`Closing tab ${tab}`);
    
    if (!currentUserId) return;
    
    try {
      // Check if tab has active tasks
      const { tasks } = await getActiveGroupId(currentUserId, tab);
      
      // If active generation, stop it first (same as clicking Stop button)
      if (tasks.length > 0) {
        const hasActive = tasks.some(t => 
          t.status === 'processing' || t.status === 'pending'
        );
        
        if (hasActive) {
          console.log(`Stopping active tasks for tab ${tab}`);
          await supabase
            .from('story_tasks')
            .update({ status: 'stopped', stop_requested: true })
            .eq('user_id', currentUserId)
            .eq('group_id', groupIdToClose)
            .eq('tab', tab);
        }
      }
      
      // Delete all tab data (same as clicking Done button)
      const deleted = await deleteTab(currentUserId, tab, groupIdToClose);
      if (!deleted) {
        console.error(`Failed to delete tab ${tab} data`);
        return;
      }
      
      // Clear session storage for this tab
      clearTabSessionStorage(tab);
      
      console.log(`Successfully closed tab ${tab}`);
    } catch (error) {
      console.error(`Error closing tab ${tab}:`, error);
    }
  };

  // Initialize storyInput from sessionStorage on mount
  useEffect(() => {
    const savedStoryInput = sessionStorage.getItem('storyInput');
    if (savedStoryInput) {
      try {
        const parsed = JSON.parse(savedStoryInput);
        console.log('Loading storyInput from sessionStorage:', parsed);
        // Only set if we have valid data and we're not in a generation state
        if (parsed && typeof parsed === 'object' && parsed.wordCount && !['generating', 'correcting', 'complete', 'corrected'].includes(generationState)) {
          setStoryInput({ 
            ...parsed, 
            language: parsed.language || 'english', // Ensure language has a default value
            model: parsed.model || 'deepseek' // Ensure model has a default value
          });
        }
      } catch (error) {
        console.error('Error parsing storyInput from sessionStorage:', error);
        // Clear corrupted sessionStorage
        sessionStorage.removeItem('storyInput');
      }
    }
  }, [generationState]);

  // Validate word count based on selected model
  const validateWordCount = (input: string, model: string): string | null => {
    if (!isValidNumericInput(input)) {
      return 'Word count must be a number.';
    }
    const num = parseInt(input, 10);
    if (num < 200) {
      return 'Word count must be at least 200.';
    }
    
    const selectedModelConfig = modelOptions.find(m => m.value === model);
    const maxWords = selectedModelConfig?.maxWords || 50000;
    
    if (num > maxWords) {
      return `Word count cannot exceed ${maxWords.toLocaleString()} for ${selectedModelConfig?.label}.`;
    }
    return null;
  };

  // Estimate tokens for each process using unified formula with model multiplier
  const estimateTokens = (wordCount: number, originalWordCount?: number, correctedWordCount?: number, model: string = 'sonnet') => {
    // Return 0 for all estimates if wordCount is 0 or invalid
    if (!wordCount || wordCount <= 0) {
      return {
        initialStory: 0,
        correctedStory: 0,
        comparison: 0,
      };
    }
 
    // Get model configuration
    const modelConfig = modelOptions.find(m => m.value === model) || modelOptions[0];
    const tokenMultiplier = modelConfig.tokenMultiplier;
    
    // Use batch size based on model (DeepSeek: 1100, Claude: 3000)
    const MAX_WORDS_PER_BATCH = modelConfig.maxWordsPerBatch || 1100;
    const batchCount = Math.ceil(wordCount / MAX_WORDS_PER_BATCH);
 
    // Estimate tokens for initial story generation (matching Python logic)
    const estimateStoryGenerationTokens = (wordCount: number, batchCount: number) => {
      const systemPromptTokens = 300; // System prompt tokens per batch
      let inputTokens = 0;
      const avgWordsPerBatch = wordCount / batchCount;
 
      // For each batch, estimate input tokens (matching Python loop)
      for (let i = 0; i < batchCount; i++) {
        const previousContentWords = i * avgWordsPerBatch;
        const previousContentTokens = previousContentWords * STORY_GENERATION_TOKENS_PER_WORD;
        const batchInputTokens = systemPromptTokens + 200 + previousContentTokens; // System prompt + chapter outline + previous content
        inputTokens += batchInputTokens;
      }
 
      const outputTokens = wordCount * STORY_GENERATION_TOKENS_PER_WORD;
      return Math.round((inputTokens * 0.25 + outputTokens) * tokenMultiplier); // Apply model multiplier
    };
 
    // Estimate tokens for story correction (matching Python logic)
    const estimateStoryCorrectionTokens = (wordCount: number, batchCount: number) => {
      const systemPromptTokens = 300; // System prompt tokens per batch
     
      // Feedback generation tokens
      const feedbackInputTokens = Math.min(wordCount * STORY_GENERATION_TOKENS_PER_WORD, 15000) + 300; // System prompt + truncated story
      const feedbackOutputTokens = 700; // Typical feedback length
 
      let inputTokens = 0;
      const avgWordsPerBatch = wordCount / batchCount;
 
      // For each batch, estimate input tokens (matching Python loop)
      for (let i = 0; i < batchCount; i++) {
        const previousContentWords = i * avgWordsPerBatch;
        const previousContentTokens = previousContentWords * STORY_GENERATION_TOKENS_PER_WORD;
        const batchInputTokens = systemPromptTokens + 200 + previousContentTokens; // System prompt + chapter outline + previous content
        inputTokens += batchInputTokens;
      }
 
      const outputTokens = wordCount * STORY_GENERATION_TOKENS_PER_WORD;
      const totalInputTokens = feedbackInputTokens + inputTokens;
      const totalOutputTokens = feedbackOutputTokens + outputTokens;
 
      return Math.round((totalInputTokens * 0.25 + totalOutputTokens) * tokenMultiplier); // Apply model multiplier
    };
 
    // Estimate tokens for story comparison (matching Python logic)
    const estimateComparisonTokens = (originalWordCount: number, correctedWordCount: number) => {
      // Input tokens: system prompt + both stories (truncated to 15000 words each for analysis)
      const originalInputTokens = Math.min(originalWordCount, 15000) * STORY_GENERATION_TOKENS_PER_WORD + 200; // System prompt + original story
      const correctedInputTokens = Math.min(correctedWordCount, 15000) * STORY_GENERATION_TOKENS_PER_WORD + 200; // System prompt + corrected story
      const comparisonInputTokens = Math.min(originalWordCount + correctedWordCount, 15000) * STORY_GENERATION_TOKENS_PER_WORD + 300; // System prompt + both stories (truncated)
 
      // Output tokens: fixed estimates based on typical comparison output length
      const originalOutputTokens = 400; // ~300 words for original story evaluation
      const correctedOutputTokens = 400; // ~300 words for corrected story evaluation
      const comparisonOutputTokens = 530; // ~400 words for comparison section
 
      const totalInputTokens = originalInputTokens + correctedInputTokens + comparisonInputTokens;
      const totalOutputTokens = originalOutputTokens + correctedOutputTokens + comparisonOutputTokens;
 
      return Math.round((totalInputTokens * 0.25 + totalOutputTokens) * tokenMultiplier); // Apply model multiplier
    };
 
    // Use provided word counts if available, otherwise fall back to input wordCount
    const origWordCount = originalWordCount || wordCount;
    const corrWordCount = correctedWordCount || wordCount;
 
    return {
      initialStory: estimateStoryGenerationTokens(wordCount, batchCount),
      correctedStory: estimateStoryCorrectionTokens(wordCount, batchCount),
      comparison: estimateComparisonTokens(origWordCount, corrWordCount),
    };
  };

  // Update word count validation whenever it changes
  useEffect(() => {
    // In runtime mode, validate the derived word count (skip "not a number" since it's calculated)
    if (isRuntimeMode) {
      const minutes = parseInt(runtimeMinutes, 10);
      if (isNaN(minutes) || minutes <= 0) {
        setWordCountError('Runtime must be a valid number of minutes.');
      } else {
        const derivedWordCount = minutesToWordCount(minutes);
        // Validate derived word count against model limits
        const selectedModelConfig = modelOptions.find(m => m.value === storyInput.model);
        const maxWords = selectedModelConfig?.maxWords || 50000;
        if (derivedWordCount < 200) {
          setWordCountError(`Runtime too short — results in ~${derivedWordCount.toLocaleString()} words (minimum 200).`);
        } else if (derivedWordCount > maxWords) {
          setWordCountError(`Runtime too long — results in ~${derivedWordCount.toLocaleString()} words (maximum ${maxWords.toLocaleString()} for ${selectedModelConfig?.label}).`);
        } else {
          setWordCountError(null);
        }
      }
    } else {
      setWordCountError(validateWordCount(storyInput.wordCount, storyInput.model));
    }
    const wordCountNum = parseInt(storyInput.wordCount, 10);
  
    // Fetch actual word counts for comparison if available
    let originalWordCount: number | undefined = undefined;
    let correctedWordCount: number | undefined = undefined;
    if (generatedContent.comparison.doc1WordCount && generatedContent.comparison.doc2WordCount) {
      originalWordCount = generatedContent.comparison.doc1WordCount;
      correctedWordCount = generatedContent.comparison.doc2WordCount;
    } else if (generatedContent.story && generatedContent.correctedStory) {
      originalWordCount = getWordCount(generatedContent.story);
      correctedWordCount = getWordCount(generatedContent.correctedStory);
    }

    // Use wordCountNum for initial estimation, actual word counts for comparison when available
    setEstimatedTokens(estimateTokens(
      isNaN(wordCountNum) ? 0 : wordCountNum,
      originalWordCount,
      correctedWordCount,
      storyInput.model // Add the model parameter
    ));
  }, [storyInput.wordCount, storyInput.model, isRuntimeMode, runtimeMinutes, generatedContent.story, generatedContent.correctedStory, generatedContent.comparison.doc1WordCount, generatedContent.comparison.doc2WordCount]);

  // Debounced save — waits 500ms of inactivity before writing to database
  const saveFormInputsToDatabase = useCallback((updatedInput: typeof storyInput) => {
    if (!currentUserId || !currentTab || isLoadingTabData.current) return;
    if (saveFormDebounceRef.current) clearTimeout(saveFormDebounceRef.current);
    saveFormDebounceRef.current = setTimeout(async () => {
      const { saveTabFormInputs } = await import('../utils/tabManager');
      await saveTabFormInputs(currentUserId, 'story', currentTab, {
        title: updatedInput.title,
        storyDescription: updatedInput.description,
        wordCount: updatedInput.wordCount ? parseInt(updatedInput.wordCount) : undefined,
        language: updatedInput.language,
        model: updatedInput.model,
        isRuntimeMode,
        runtimeMinutes: runtimeMinutes ? parseInt(runtimeMinutes) : undefined,
        masterPromptEnabled,
        masterPromptEnhanceAI,
        masterPromptData,
        pauseTTS,
        youtubeInspirationEnabled,
        youtubeLinks,
      });
    }, 500);
  }, [currentUserId, currentTab, isRuntimeMode, runtimeMinutes, masterPromptEnabled, masterPromptEnhanceAI, masterPromptData, pauseTTS, youtubeInspirationEnabled, youtubeLinks]);

  // Monitor sessionStorage errors
  useEffect(() => {
    const handleSessionStorageError = (event: StorageEvent) => {
      if (event.storageArea === sessionStorage && event.key?.startsWith('error_')) {
        setSessionStorageError('Failed to save form data. Your progress is saved locally but may not persist across sessions.');
      }
    };

    window.addEventListener('storage', handleSessionStorageError);
    return () => window.removeEventListener('storage', handleSessionStorageError);
  }, []);

  // Detect user changes and clear session
  useEffect(() => {
    const checkUser = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        const newUserId = user?.id || null;

        if (newUserId !== currentUserId && currentUserId !== null) {
          console.log('User changed, clearing session data');
          clearAllSessionStorage();
          resetAllStates();
        }

        setCurrentUserId(newUserId);
      } catch (error: any) {
        console.error('Error checking user:', error);
        // Don't show error for connection issues
        if (!error.message.includes('Failed to fetch') && !error.message.includes('CORS') && !error.message.includes('Load failed')) {
          setStoryError(`Failed to verify user: ${error.message}`);
          setGenerationState('error');
          updateCurrentTabStatus('error');
        }
      }
    };

    checkUser();
  }, [currentUserId]);

  // Check for existing tasks on page load with improved completion detection
  useEffect(() => {
    async function checkExistingTasks() {
      setIsLoadingTasks(true);
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          console.error('No user authenticated');
          setIsLoadingTasks(false);
          return;
        }

        setCurrentUserId(user.id);

        // Load saved form inputs from tabs table first (before checking tasks)
        isLoadingTabData.current = true;
        const { getTabFormInputs } = await import('../utils/tabManager');
        const savedFormInputs = await getTabFormInputs(user.id, 'story', currentTab);
        
        if (savedFormInputs) {
          console.log('Loaded saved form inputs from tabs table:', savedFormInputs);
          setStoryInput({
            title: savedFormInputs.title || '',
            description: savedFormInputs.storyDescription || '',
            wordCount: savedFormInputs.wordCount || minutesToWordCount(10).toString(),
            language: savedFormInputs.language || 'english',
            model: savedFormInputs.model || 'deepseek',
          });
          if (savedFormInputs.youtubeInspirationEnabled !== undefined) setYoutubeInspirationEnabled(savedFormInputs.youtubeInspirationEnabled);
          if (savedFormInputs.youtubeLinks) setYoutubeLinks(savedFormInputs.youtubeLinks.length > 0 ? savedFormInputs.youtubeLinks : ['']);
        }
        
        // Release the flag after a short delay
        setTimeout(() => {
          isLoadingTabData.current = false;
        }, 100);

        // Always check for active tasks in the database first (for current tab)
        const { groupId: activeGroupId, isCorrected, tasks: activeTasks, outlineTask, isComplete } = await getActiveGroupId(user.id, currentTab);

        if (activeGroupId) {
          // Recover the groupId and set it
          setGroupId(activeGroupId);
          console.log(`Recovered active groupId: ${activeGroupId}, isComplete: ${isComplete}`);

          // IMPORTANT: Don't read title/description/wordCount/model from tasks
          // Form inputs are already loaded from tabs table via getTabFormInputs()
          // Only use tasks for progress/status tracking
          console.log('Active generation found, form data already loaded from tabs table');
          console.log(`Found ${activeTasks.length} tasks (${outlineTask ? 'with' : 'without'} outline task)`);
          
          // Keep the form inputs as-is - they're already loaded from tabs table
          // No need to override with task data
          
          // Set hasActiveTasks to true to lock form fields
          setHasActiveTasks(true);

          // Check if generation is complete first
          if (isComplete) {
            console.log('Generation is complete, loading documents from database');
            setGenerationState(isCorrected ? 'corrected' : 'complete');
            setSettingsCollapsed(true);
            // Use updateTabStatus directly since currentUserId closure is still null at mount time
            const { updateTabStatus: updateTabDirect } = await import('../utils/tabManager');
            await updateTabDirect(user.id, 'story', currentTab, 'complete', activeGroupId, storyInput.title || undefined);
            setProgress(100);
            setTimeRemaining(0);
            setBatchStatuses([]);
            setHasActiveTasks(false);
            
            // Fetch both original and corrected documents if they exist
            let docsLoaded = false;
            try {
              const { data: docs, error: docsError } = await supabase
                .from('story_documents')
                .select('file_path, title, is_corrected, file_url, word_count')
                .eq('group_id', activeGroupId)
                .eq('user_id', user.id)
                .eq('tab', currentTab)
                .order('created_at', { ascending: false });

              if (docsError) {
                console.error('Error fetching documents:', docsError);
              } else if (docs && docs.length > 0) {
                console.log(`Found ${docs.length} documents for group ${activeGroupId}`);
                
                // Load each document's content
                for (const doc of docs) {
                  try {
                    console.log(`Loading content for document: ${doc.file_path}, is_corrected: ${doc.is_corrected}`);
                    
                    // Try storage download first
                    let content = '';
                    const { data: fileData, error: downloadError } = await supabase
                      .storage
                      .from('stories')
                      .download(doc.file_path);

                    if (downloadError || !fileData) {
                      // Fallback: fetch from public file_url
                      console.warn(`Storage download failed for ${doc.file_path}, trying file_url fallback`);
                      try {
                        const response = await fetch(doc.file_url);
                        if (response.ok) {
                          content = await response.text();
                        } else {
                          console.error(`Fallback fetch failed for ${doc.file_url}: HTTP ${response.status}`);
                          continue;
                        }
                      } catch (fetchErr) {
                        console.error(`Fallback fetch error for ${doc.file_url}:`, fetchErr);
                        continue;
                      }
                    } else {
                      content = await fileData.text();
                    }

                    if (!content) {
                      console.warn(`Empty content for document ${doc.file_path}, skipping`);
                      continue;
                    }

                    console.log(`Loaded ${content.length} characters for ${doc.is_corrected ? 'corrected' : 'original'} document`);
                    docsLoaded = true;
                    
                    setGeneratedContent(prev => ({
                      ...prev,
                      [doc.is_corrected ? 'correctedStory' : 'story']: content,
                      [doc.is_corrected ? 'correctedFileName' : 'storyFileName']: doc.file_url.split('/').pop() || '',
                      [doc.is_corrected ? 'correctedTitle' : 'storyTitle']: doc.title,
                    }));
                  } catch (err) {
                    console.error(`Failed to load document ${doc.file_path}:`, err);
                  }
                }
              } else {
                console.warn(`No documents found for completed group ${activeGroupId}`);
              }
            } catch (err) {
              console.error('Error loading completed documents:', err);
            }
            
            // Only mark tasks complete AFTER documents have been loaded
            setAreTasksComplete(docsLoaded);
            if (!docsLoaded) {
              console.error('Generation complete but no documents could be loaded');
            }
          } else if (activeTasks.length > 0) {
            // Check if the only active task is the outline (batch_number=0, status=processing)
            const onlyOutlineProcessing = activeTasks.length === 1 && activeTasks[0].batch_number === 0 && activeTasks[0].status === 'processing';
            
            if (onlyOutlineProcessing) {
              // Still generating the outline — show only the outline status box
              setGenerationState('outline');
              setSettingsCollapsed(true);
              setOutlineGenerating(true);
              updateCurrentTabStatus('generating', storyInput.title);
            } else {
              // Clear outline generating flag — we're past the outline phase
              setOutlineGenerating(false);
              
              // Set generationState based on isCorrected and task statuses
              const hasRunning = activeTasks.some(t => t.status === 'running' || t.status === 'processing');
              const hasPending = activeTasks.some(t => t.status === 'pending');

              if (hasRunning || hasPending) {
                setGenerationState(isCorrected ? 'correcting' : 'generating');
                updateCurrentTabStatus('generating', storyInput.title);
                // Set up progress tracking
                const totalBatches = activeTasks.length > 0 ? activeTasks[0]?.total_batches || activeTasks.length : 0;
                const totalProgress = activeTasks.reduce((sum, t) => sum + (t.progress || 0), 0);
                const progressPercentage = Math.min(100, totalBatches > 0 ? (totalProgress / (totalBatches * 100)) * 100 : 0);
                const completedBatchTasks = activeTasks.filter(t => t.status === 'completed' || t.status === 'completed_final' || t.progress === 100);
                const remainingTime = (totalBatches - completedBatchTasks.length) * 90;
               
                setProgress(progressPercentage);
                setTimeRemaining(remainingTime);
                setTotalBatches(totalBatches);
                setBatchStatuses(activeTasks.map(t => ({
                  batchNumber: t.batch_number,
                  status: t.status,
                  progress: t.progress || 0,
                })));
               
                generationStartTime.current = Date.now(); // Reset timer
              }
            }
          } else if (isCorrected) {
            // Corrected outline task exists but no active batch tasks yet — correction is starting
            console.log('Correction in progress (corrected outline exists, waiting for batch tasks)');
            setGenerationState('correctingQueueing');
            setProgress(0);
            updateCurrentTabStatus('generating', storyInput.title);
          } else {
            setHasActiveTasks(false); // No active tasks, allow form editing
            setAreTasksComplete(false); // No tasks means nothing is complete
            setGenerationState('idle'); // Reset state to allow new generation
          }
        } else {
          // No active tasks: Keep form inputs loaded from tabs table, don't reset
          console.log('No active tasks found, keeping form inputs from tabs table');
          setHasActiveTasks(false);
          setAreTasksComplete(false); // No tasks means nothing is complete
          setGenerationState('idle'); // Reset state to allow new generation
        }

        setIsLoadingTasks(false);
      } catch (err: any) {
        console.error('Error checking existing tasks:', err);
        // Don't show error for connection issues
        if (!err.message.includes('Failed to fetch') && !err.message.includes('CORS') && !err.message.includes('Load failed')) {
          setStoryError(`Failed to check for existing tasks: ${err.message}`);
          setGenerationState('error');
        }
        setIsLoadingTasks(false);
      }
    }

    checkExistingTasks();
    
    // Safeguard: Ensure isLoadingTasks is false after 2 seconds if still loading
    const safetyTimer = setTimeout(() => {
      if (isLoadingTasks) {
        console.log('[Generator] Safety timeout: forcing isLoadingTasks to false');
        setIsLoadingTasks(false);
      }
    }, 2000);
    
    return () => clearTimeout(safetyTimer);
  }, [reinitTrigger]); // Re-run on mount and after handleDone

  // Detect stalled tasks with improved detection
  useEffect(() => {
    if (generationState !== 'generating' && generationState !== 'correcting' || !groupId || !generationStartTime.current) return;

    const checkStall = async () => {
      const elapsed = Date.now() - generationStartTime.current!;
      if (elapsed > TASK_STALL_TIMEOUT) {
        console.warn(`Task processing stalled after ${TASK_STALL_TIMEOUT / 1000} seconds`);
        try {
          const tasks = await pollTasks(currentUserId!, groupId, currentTab);
          if (!tasks || tasks.length === 0) {
            console.log('No tasks found during stall check');
            return;
          }
        
          const batchTasks = tasks.filter(t => t.batch_number > 0);
          const allStalled = batchTasks.length > 0 && batchTasks.every(task => isTaskStalled(task));
        
          if (allStalled) {
            // Check for partial story
            const { data: doc } = await supabase
              .from('story_documents')
              .select('file_url, title, word_count, is_corrected')
              .eq('group_id', groupId)
              .eq('user_id', currentUserId)
              .eq('tab', currentTab)
              .order('created_at', { ascending: false })
              .limit(1)
              .single();

            if (doc) {
              const response = await fetch(doc.file_url);
              const content = await response.text();

              setGeneratedContent(prev => ({
                ...prev,
                [doc.is_corrected ? 'correctedStory' : 'story']: content,
                [doc.is_corrected ? 'correctedFileName' : 'storyFileName']: doc.file_url.split('/').pop() || '',
                [doc.is_corrected ? 'correctedTitle' : 'storyTitle']: doc.title,
              }));

              setGenerationState('complete');
              await updateCurrentTabStatus('complete', storyInput.title);
              setProgress(100);
              setTimeRemaining(0);
              setBatchStatuses([]);
              setStoryError('Story generation stalled. Saved partial story.');
            } else {
              setStoryError('Story generation stalled. No partial story saved. Please try again.');
              setGenerationState('error');
            }
            generationStartTime.current = null;
          }
        } catch (err: any) {
          console.error('Error checking stalled tasks:', err);
          // Don't show error for connection issues
          if (!err.message.includes('Failed to fetch') && !err.message.includes('CORS') && !err.message.includes('Load failed')) {
            setStoryError(`Failed to check task status: ${err.message}`);
            setGenerationState('error');
            generationStartTime.current = null;
          }
        }
      }
    };

    const stallInterval = setInterval(checkStall, 300000);
    return () => clearInterval(stallInterval);
  }, [generationState, groupId, currentUserId]);

  // Fetch user plan and token balance
  useEffect(() => {
    const fetchUserPlan = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // Enterprise status is now provided via props from GeneratorContainer
      // No need to check here

      try {
        const { data, error } = await withRetry(
          () =>
            supabase
              .from('user_plans')
              .select('plan_type, tokens_allocated, tokens_used, rollover_tokens')
              .eq('user_id', user.id)
              .eq('is_active', true)
              .single(),
          'fetchUserPlan'
        );

        if (error) {
          console.error('Error fetching user plan:', error);
          // Don't show error for connection issues
          if (!error.message.includes('Failed to fetch') && !error.message.includes('CORS') && !error.message.includes('Load failed')) {
            setStoryError('Unable to fetch user plan. Please check your network connection and try again.');
            setGenerationState('error');
          }
          return;
        }

        const tokensUsed = data.tokens_used || 0;
        const planType = data.plan_type || 'free';
        const planMax = PLAN_MAX_TOKENS[planType] || 400000;
        const rolloverTokens = data.rollover_tokens || 0;
      
        setUserPlan(planType);
        setUserTokenBalance(planMax + rolloverTokens - tokensUsed);
        setTotalTokens(tokensUsed);
      } catch (error: any) {
        console.error('Failed to fetch user plan:', error);
        // Don't show error for connection issues
        if (!error.message.includes('Failed to fetch') && !error.message.includes('CORS') && !error.message.includes('Load failed')) {
          setStoryError('Unable to fetch user plan. Please check your network connection and try again.');
          setGenerationState('error');
        }
      }
    };

    fetchUserPlan();
  }, [reinitTrigger]); // Re-run on mount and after handleDone

  // Debug outline content
  useEffect(() => {
    if (outline && showOutlineConfirmation) {
      console.log('Outline content:', outline);
    }
  }, [outline, showOutlineConfirmation]);

  // Timeout for correctingQueueing state
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    if (generationState === 'correctingQueueing') {
      timeoutId = setTimeout(() => {
        console.error('Correction preparation timed out after 3 minutes');
        setStoryError('Correction preparation took too long. Please try again.');
        setGenerationState('error');
      }, OPERATION_TIMEOUT);
    }
    return () => clearTimeout(timeoutId);
  }, [generationState]);

  // Timeout for comparing state
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    if (generationState === 'comparing') {
      timeoutId = setTimeout(() => {
        console.error('Comparison timed out after 5 minutes');
        setStoryError('Comparison took too long. Please try again.');
        setGenerationState('error');
      }, OPERATION_TIMEOUT);
    }
    return () => clearTimeout(timeoutId);
  }, [generationState]);

  // Calculate estimated time
  const calculateEstimatedTime = (wordCount: number) => {
    const batchSize = storyInput.model === 'deepseek' ? 1100 : 3000;
    const timePerBatch = 90;
    const numberOfBatches = Math.ceil(wordCount / batchSize);
    return numberOfBatches * timePerBatch;
  };

  // Function to poll tasks with improved error handling and retry logic
  async function pollTasks(userId: string, groupId: string, tab: number = 1): Promise<StoryTask[]> {
    const MAX_RETRIES = 5; // Increased for better resilience
    const BASE_DELAY = 1000; // Reduced base delay

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const tasks = await getTasks(userId, groupId, tab);
        
        // Filter out tasks where video_process is true
        const filteredTasks = tasks.filter(task => !task.video_process);
        
        console.log(`Polled tasks for group ${groupId}, tab ${tab}:`, filteredTasks.map(t => ({
          batch_number: t.batch_number,
          status: t.status,
          progress: t.progress,
          video_process: t.video_process,
          tab: t.tab,
        })));

        const hasPendingOrRunning = filteredTasks.some(t => t.status === 'pending' || t.status === 'processing');
        const allCompleted = filteredTasks.every(t => t.status === 'completed' || t.status === 'stopped');

        if (!hasPendingOrRunning && !allCompleted) {
          // Check for stalled tasks (only non-video_process tasks)
          const stalledTasks = filteredTasks.filter(t => t.status === 'processing' && new Date().getTime() - new Date(t.updated_at).getTime() > 15 * 60 * 1000);
          if (stalledTasks.length > 0) {
            console.warn(`Found ${stalledTasks.length} stalled tasks, resetting to pending`);
            for (const task of stalledTasks) {
              await supabase
                .from('story_tasks')
                .update({
                  status: 'pending',
                  error: 'Task stalled, reset to pending',
                  updated_at: new Date().toISOString(),
                })
                .eq('id', task.id);
            }

            // Retrigger the first pending batch
            const pendingTask = filteredTasks.find(t => t.status === 'pending');
            if (pendingTask) {
              const { data: { session: _gSession } } = await supabase.auth.getSession();
              await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/trigger-next-batch`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${_gSession?.access_token || ''}`,
                  'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
                },
                body: JSON.stringify({
                  group_id: groupId,
                  user_id: userId,
                  current_batch_number: pendingTask.batch_number - 1,
                }),
              });
            }
          }
        }

        return filteredTasks;
      } catch (error: any) {
        console.error(`Attempt ${attempt} failed in pollTasks: ${error.message}`);
        
        if (error.message.includes('Failed to fetch') || error.message.includes('CORS') || error.message.includes('Load failed')) {
          if (attempt < MAX_RETRIES) {
            const delay = BASE_DELAY * Math.pow(1.5, attempt - 1); // Gentler exponential backoff
            console.warn(`Network error in pollTasks, retrying in ${delay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          } else {
            // On final attempt for connection issues, return empty array silently
            console.warn('Network issues persist, returning empty array');
            return [];
          }
        } else if (attempt < MAX_RETRIES && (error.message.includes('timeout') || error.message.includes('504'))) {
          const delay = BASE_DELAY * Math.pow(1.5, attempt - 1);
          console.warn(`Server error in pollTasks, retrying in ${delay / 1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // For non-network errors, throw after retries
        if (attempt >= MAX_RETRIES) {
          console.error(`Failed to poll tasks after ${MAX_RETRIES} attempts: ${error.message}`);
          return []; // Return empty array instead of throwing
        }
      }
    }

    // Fallback return
    return [];
  }

  // Add a new function to monitor background tasks
  async function monitorBackgroundTasks(userId: string, groupId: string, maxAttempts: number = 20) {
    console.log(`Starting background task monitoring for group ${groupId}`);
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const tasks = await pollTasks(userId, groupId, currentTab);
        
        if (tasks && tasks.length > 0) {
          console.log(`Background tasks detected after ${attempt} attempts:`, tasks.length);
          // Tasks found - the polling effect will take over from here
          return;
        }
        
        // Wait before next attempt, with increasing intervals
        const waitTime = Math.min(10000, 2000 * attempt); // Start at 2s, max 10s
        console.log(`Attempt ${attempt}/${maxAttempts}: No tasks found, waiting ${waitTime/1000}s before retry`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
      } catch (error: any) {
        console.warn(`Background monitoring attempt ${attempt} failed:`, error.message);
        
        if (attempt === maxAttempts && !error.message.includes('Failed to fetch') && !error.message.includes('CORS') && !error.message.includes('Load failed')) {
          // Only show error after all attempts failed and it's not a connection issue
          setStoryError('Unable to detect story generation progress. The process may still be running in the background. Please refresh the page in a few minutes to check status.');
          setGenerationState('error');
          return;
        }
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    console.warn('Background task monitoring completed without finding tasks');
    // Don't set error state - let the user try refreshing or the tasks might still appear
  }

  // Utility function to fix description using Supabase edge function
  const fixDescription = async (description: string, userId: string, groupId: string): Promise<string> => {
    try {
      const { data: { session: fixDescSession } } = await supabase.auth.getSession();
      const response = await fetch(`${supabaseUrl}/functions/v1/fix-description`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${fixDescSession?.access_token || ''}`,
          'apikey': supabaseKey,
        },
        body: JSON.stringify({
          description,
          user_id: userId,
          group_id: groupId,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: Failed to fix description`);
      }

      const { fixedDescription } = await response.json();
      return fixedDescription;
    } catch (error: any) {
      console.error('Error fixing description:', error);
      throw error;
    }
  };

  // Handle form submission - Updated to be more resilient to connection issues
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (generationState !== 'idle') {
      setStoryError('A story is already being generated. Please wait or clear the current process.');
      return;
    }

    setIsSubmitting(true);
    setOutlineGenerating(true);

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      setStoryError('Authentication error. Please sign in again.');
      setGenerationState('error');
      setIsSubmitting(false);
      setOutlineGenerating(false);
      return;
    }

    // Get session access token for secure API calls
    const { data: { session: _authSession } } = await supabase.auth.getSession();
    const _accessToken = _authSession?.access_token;
    if (!_accessToken) {
      setStoryError('Session expired. Please sign in again.');
      setGenerationState('error');
      setIsSubmitting(false);
      setOutlineGenerating(false);
      return;
    }
    
    // Use current storyInput state (already auto-saved to database on every change)
    // Don't load from database here as it might have stale data during tab creation
    const formData = storyInput;
    
    console.log(`[handleSubmit] Using current form data for tab ${currentTab}:`, formData);
    
    // Save the current form inputs to database one final time before generating
    // This ensures tabs table has the latest data before tasks are created
    const { saveTabFormInputs: saveInputs } = await import('../utils/tabManager');
    await saveInputs(user.id, 'story', currentTab, {
      title: formData.title,
      storyDescription: formData.description,
      wordCount: formData.wordCount ? parseInt(formData.wordCount) : undefined,
      language: formData.language,
      model: formData.model,
      masterPromptEnabled,
      masterPromptEnhanceAI,
      masterPromptData,
    });
    
    // Update tab status to outline
    await updateCurrentTabStatus('outline', formData.title);

    const wordCount = parseInt(formData.wordCount, 10) || 200;
    const creditCheck = checkCredits(wordCount, userTokenBalance, false, false, formData.model, masterPromptEnabled, masterPromptEnhanceAI, isLegacy); // Outline + original story

    if (!creditCheck.sufficient) {
      setStoryError(
        `Generating this story requires approximately ${Math.round(creditCheck.requiredCredits).toLocaleString()} tokens, ` +
        `but you only have ${formatNumber(userTokenBalance)} tokens available. ` +
        `Please upgrade your plan to continue.`
      );
      setGenerationState('error');
      setIsSubmitting(false);
      setOutlineGenerating(false);
      return;
    }

    // Hoisted so catch block can reference it for background-task monitoring
    // even if generation throws after the UUID is assigned.
    const newGroupId = generateUuid();

    try {
      setGenerationState('queueing');
      generationStartTime.current = Date.now();

      // Group ID was generated above; sync it to state.
      setGroupId(newGroupId);

      // Update tab status to generating with the NEW group_id
      // We must call updateTabStatus directly since the closure's groupId is still the old one
      const { updateTabStatus: updateTab } = await import('../utils/tabManager');
      await updateTab(user.id, 'story', currentTab, 'generating', newGroupId, formData.title);

      // If master prompt is enabled AND AI enhancement is ON, or YouTube inspiration has valid links,
      // call master-prompt edge function first.
      // It will enhance the prompt with AI and then trigger outline generation automatically
      const validYoutubeLinks = youtubeInspirationEnabled ? youtubeLinks.filter(l => l.trim() && !validateYoutubeUrl(l)) : [];
      const hasYoutubeInspiration = validYoutubeLinks.length > 0;
      if ((masterPromptEnabled && masterPromptEnhanceAI && masterPromptData) || hasYoutubeInspiration) {
        console.log(hasYoutubeInspiration
          ? `YouTube inspiration enabled with ${validYoutubeLinks.length} link(s), calling master-prompt edge function...`
          : 'Master prompt with AI enhancement enabled, calling master-prompt edge function...');
        
        try {
          const masterPromptResponse = await fetchWithFallback('https://master-prompt.storyscriptai.deno.net', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${_accessToken}`,
            },
            body: JSON.stringify({
              user_id: user.id,
              group_id: newGroupId,
              title: formData.title,
              description: formData.description,
              word_count: wordCount,
              language: formData.language,
              model: formData.model,
              tab: currentTab,
              variant: 1,
              master_prompt_data: masterPromptData,
              pauses: pauseTTS,
              youtube_links: youtubeInspirationEnabled ? youtubeLinks.filter(l => l.trim() && !validateYoutubeUrl(l)) : undefined,
            }),
          });

          if (masterPromptResponse.ok) {
            const masterPromptResult = await masterPromptResponse.json();
            console.log('Master prompt enhanced successfully:', masterPromptResult);
            
            // The master-prompt function will trigger outline generation automatically
            // So we can continue to generating state and monitor for tasks
            setGenerationState('generating');
            setProgress(0);
            
            // Set estimated time remaining based on the number of batches
            const batchSize = storyInput.model === 'deepseek' ? 1100 : 3000;
            const estimatedBatches = Math.ceil(wordCount / batchSize);
            setTotalBatches(estimatedBatches);
            setTimeRemaining(estimatedBatches * 90);
            
            setIsSubmitting(false);
            setOutlineGenerating(false);
            
            // Start monitoring for tasks immediately
            setTimeout(() => {
              monitorBackgroundTasks(user.id, newGroupId);
            }, 5000);
            
            return; // Exit early - master-prompt function handles the rest
          } else {
            const errorData = await masterPromptResponse.json().catch(() => ({}));
            console.error('Master prompt enhancement failed:', errorData);
            // Fall through to regular outline generation if master prompt fails
          }
        } catch (masterPromptError: any) {
          console.error('Error calling master-prompt function:', masterPromptError);
          // Fall through to regular outline generation if master prompt fails
        }
      }

      console.log('Calling Deno Deploy outline endpoint...');

      // Attempt to generate outline with retry logic but don't fail completely on connection issues
      let outlineSuccess = false;
      let lastError: any = null;

      // Try the outline generation
      // If master prompt is enabled but AI enhancement is OFF, pass raw master_prompt data
      // If master prompt is disabled or AI enhancement failed, pass null
      try {
        const response = await fetchWithFallback('https://storyscriptai-outline.storyscriptai.deno.net', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_accessToken}`,
          },
          body: JSON.stringify({
            title: formData.title,
            description: formData.description,
            wordCount: wordCount,
            groupId: newGroupId,
            userId: user.id,
            language: formData.language,
            model: formData.model,
            tab: currentTab,
            master_prompt: masterPromptEnabled && !masterPromptEnhanceAI && masterPromptData ? masterPromptData : null,
            is_runtime_mode: isRuntimeMode,
            runtime_minutes: isRuntimeMode ? runtimeMinutes : null,
            pauses: pauseTTS,
          }),
        });

        if (response.ok) {
          const responseData = await response.json();
          console.log('Outline generated successfully:', responseData);
          outlineSuccess = true;
        } else {
          const errorData = await response.json().catch(() => ({}));
          lastError = new Error(errorData.error || `HTTP ${response.status}: Failed to generate outline`);
        }
      } catch (fetchError: any) {
        console.warn('Initial outline fetch failed:', fetchError.message);
        lastError = fetchError;

        // Try with fixed description if it's a connection issue
        if (fetchError.message.includes('Failed to fetch') || fetchError.message.includes('CORS') || fetchError.message.includes('Load failed')) {
          console.log('Attempting to fix description and retry...');
          try {
            const fixedDescription = await fixDescription(formData.description, user.id, newGroupId);
            console.log('Fixed description, retrying outline generation...');
          
            // Update storyInput with fixed description
            setStoryInput(prev => {
              const updated = { ...prev, description: fixedDescription };
              try {
                sessionStorage.setItem('storyInput', JSON.stringify(updated));
              } catch (e) {
                console.error('Error saving fixed storyInput to sessionStorage:', e);
              }
              return updated;
            });

            // Retry the outline generation with fixed description
            const retryResponse = await fetchWithFallback('https://storyscriptai-outline.storyscriptai.deno.net', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${_accessToken}`,
              },
              body: JSON.stringify({
                title: formData.title,
                description: fixedDescription,
                wordCount: wordCount,
                groupId: newGroupId,
                userId: user.id,
                language: formData.language,
                model: formData.model,
                tab: currentTab,
                master_prompt: null, // Master prompt should only come from master-prompt.ts now
                is_runtime_mode: isRuntimeMode,
                runtime_minutes: isRuntimeMode ? runtimeMinutes : null,
                pauses: pauseTTS,
              }),
            });

            if (retryResponse.ok) {
              const responseData = await retryResponse.json();
              console.log('Outline generated successfully on retry:', responseData);
              outlineSuccess = true;
            } else {
              const errorData = await retryResponse.json().catch(() => ({}));
              lastError = new Error(errorData.error || `HTTP ${retryResponse.status}: Failed to generate outline`);
            }
          } catch (retryError: any) {
            console.warn('Retry with fixed description also failed:', retryError.message);
            lastError = retryError;
          }
        }
      }

      // If outline generation failed but it might be a temporary connection issue,
      // continue to the generating state and let the polling detect if tasks start appearing
      if (!outlineSuccess) {
        console.warn('Outline generation failed, but continuing to monitor for background tasks:', lastError?.message);
        
        // Only show error for non-connection issues
        if (lastError && !lastError.message.includes('Failed to fetch') && !lastError.message.includes('CORS') && !lastError.message.includes('Load failed')) {
          setStoryError(lastError.message.includes('No chapter found')
            ? 'Failed to generate outline due to invalid chapter structure. Please try again.'
            : lastError.message || 'Failed to generate outline. Please check your inputs and try again.');
          setGenerationState('error');
          setIsSubmitting(false);
          setOutlineGenerating(false);
          return;
        }
      }

      // Continue to generating state regardless of initial connection issues
      setGenerationState('generating');
      setProgress(0);

      // Set estimated time remaining based on the number of batches
      const batchSize = storyInput.model === 'deepseek' ? 1100 : 3000;
      const estimatedBatches = Math.ceil(wordCount / batchSize);
      setTotalBatches(estimatedBatches);
      setTimeRemaining(estimatedBatches * 90);

      setIsSubmitting(false);
      setOutlineGenerating(false);

      // Start monitoring for tasks immediately
      setTimeout(() => {
        monitorBackgroundTasks(user.id, newGroupId);
      }, 5000); // Give it 5 seconds then start checking

    } catch (error: any) {
      console.error('Error in handleSubmit:', error);
      
      // Only show user-facing errors for non-connection issues
      if (!error.message.includes('Failed to fetch') && !error.message.includes('CORS') && !error.message.includes('Load failed')) {
        const errorMessage = error.message.includes('No chapter found')
          ? 'Failed to generate outline due to invalid chapter structure. Please try again.'
          : error.message || 'Failed to generate outline. Please check your inputs and try again.';

        setStoryError(errorMessage);
        setGenerationState('error');
      } else {
        // For connection issues, continue monitoring
        console.log('Connection issue detected, continuing to monitor for background tasks');
        setGenerationState('generating');
        setProgress(0);
        const batchSize = storyInput.model === 'deepseek' ? 1100 : 3000;
        const estimatedBatches = Math.ceil(wordCount / batchSize);
        setTotalBatches(estimatedBatches);
        setTimeRemaining(estimatedBatches * 90);
        
        setTimeout(() => {
          monitorBackgroundTasks(user.id, newGroupId);
        }, 10000); // Check after 10 seconds for connection issues
      }

      setIsSubmitting(false);
      setOutlineGenerating(false);

      // Clean up tasks only for non-connection errors
      if (groupId && !error.message.includes('Failed to fetch') && !error.message.includes('CORS') && !error.message.includes('Load failed')) {
        await cleanupTasks();
      }
    }
  }

  // Handle correction - Updated to use only the generate-correction-feedback endpoint
  const handleCorrection = async () => {
    try {
      console.log('Starting correction process...', {
        groupId,
        userId: currentUserId,
        originalStoryLength: generatedContent.story.length,
      });

      setGenerationState('correctingQueueing');
      setProgress(0);
      setAreTasksComplete(false); // Hide "I'm Done" button immediately
      await updateCurrentTabStatus('generating', storyInput.title); // Update tab status to generating immediately

      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !groupId) throw new Error('Authentication error');

      const wordCount = parseInt(storyInput.wordCount) || 200;
      const creditCheck = checkCredits(wordCount, userTokenBalance, true, false, storyInput.model, masterPromptEnabled, false, isLegacy); // Original + feedback + corrected

      if (!creditCheck.sufficient) {
        throw new Error(
          `Correcting this story requires approximately ${formatNumber(creditCheck.requiredCredits)} tokens, ` +
          `but you only have ${formatNumber(userTokenBalance)} tokens available. ` +
          `Please upgrade your plan to continue.`
        );
      }

      // Call generate-correction-feedback edge function (which will handle the rest asynchronously)
      console.log('Calling generate-correction-feedback...');
      const { data: { session: correctionSession } } = await supabase.auth.getSession();
      const feedbackResponse = await withRetry(
        () =>
          withTimeout(
            fetch(`${supabaseUrl}/functions/v1/generate-correction-feedback`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${correctionSession?.access_token || ''}`,
                'apikey': supabaseKey,
              },
              body: JSON.stringify({
                group_id: groupId,
                user_id: user.id,
                user_feedback: '',
                model: storyInput.model,
                tab: currentTab,
              }),
            }),
            OPERATION_TIMEOUT,
            'generateCorrectionFeedback'
          ),
        'generateCorrectionFeedback'
      );

      if (!feedbackResponse || typeof feedbackResponse.json !== 'function') {
        throw new Error('Failed to connect to correction feedback service. Please try again.');
      }

      if (!feedbackResponse.ok) {
        const errData = await feedbackResponse.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${feedbackResponse.status}: Failed to generate correction feedback`);
      }

      const { feedback: feedbackText, task_id } = await feedbackResponse.json();
      console.log('Generated correction feedback:', { feedbackLength: feedbackText.length, task_id });
      setFeedback(feedbackText);

      // Fetch the corrected outline task to get tokens
      const { data: correctedOutlineTask, error: outlineTaskError } = await supabase
        .from('story_tasks')
        .select('input_tokens, output_tokens')
        .eq('id', task_id)
        .single();

      if (outlineTaskError || !correctedOutlineTask) {
        throw new Error('Failed to fetch corrected outline task');
      }

      // The SQL trigger will handle token updates
      const calculatedTokens = Math.round((correctedOutlineTask.input_tokens || 1200) * 0.25 + (correctedOutlineTask.output_tokens || 1200));
      setUsedTokens(prev => ({ ...prev, correctedStory: calculatedTokens }));

      // Set estimated time remaining based on the number of batches
      const batchSize = storyInput.model === 'deepseek' ? 1100 : 3000;
      const estimatedBatches = Math.ceil(wordCount / batchSize);
      setTotalBatches(estimatedBatches);
      setTimeRemaining(estimatedBatches * 90);
      setGenerationState('correcting');

      console.log('Correction process initiated successfully');
    } catch (error: any) {
      console.error('Error initiating correction:', {
        message: error.message,
        groupId,
        userId: currentUserId,
        stack: error.stack,
      });

      // Don't show error for connection issues
      if (!error.message.includes('Failed to fetch') && !error.message.includes('CORS') && !error.message.includes('Load failed')) {
        setStoryError(error.message);
        setGenerationState('error');
      }
    
      // Clean up tasks on error
      if (groupId) {
        await cleanupTasks();
      }
    }
  };

  // Handle story comparison - Keeping this exactly the same as before
  const handleComparison = async (proceed: boolean) => {
    if (!proceed) {
      handleDone();
      return;
    }

    try {
      if (!currentUserId || !groupId) {
        throw new Error('Authentication or group error. Please try again.');
      }
    
      console.log('Starting comparison process...');
      setGenerationState('comparing');
      setComparing(true);
      setProgress(0);
      setStoryError(null);
      setAreTasksComplete(false); // Hide completion sections during comparison
      await updateCurrentTabStatus('generating', storyInput.title); // Persist comparing state immediately

      const wordCount = parseInt(storyInput.wordCount) || 200; // Default to 200 if parsing fails
      const creditCheck = checkCredits(wordCount, userTokenBalance, true, true, storyInput.model, masterPromptEnabled, false, isLegacy); // Full process including comparison

      if (!creditCheck.sufficient) {
        throw new Error(
          `Comparing story versions requires approximately ${formatNumber(creditCheck.requiredCredits)} tokens, ` +
          `but you only have ${formatNumber(userTokenBalance)} tokens available. ` +
          `Please upgrade your plan to continue.`
        );
      }

      // Fetch story documents from the database
      const { data: docs, error: docsError } = await supabase
        .from('story_documents')
        .select('*')
        .eq('group_id', groupId)
        .eq('user_id', currentUserId)
        .eq('tab', currentTab)
        .order('created_at', { ascending: false });

      if (docsError) throw new Error(`Failed to fetch story documents: ${docsError.message}`);
      if (!docs || docs.length < 2) throw new Error('Could not find both original and corrected documents');

      // Set documents state
      setDocuments(docs);

      // Find original and corrected documents
      const originalDoc = docs.find(doc => !doc.is_corrected);
      const correctedDoc = docs.find(doc => doc.is_corrected);

      if (!originalDoc || !correctedDoc) {
        throw new Error('Could not find both original and corrected documents');
      }

      // Set document labels
      setDoc1Label(originalDoc.title);
      setDoc2Label(correctedDoc.title);

      // Fetch document content
      const originalContent = await fetchDocContent(originalDoc.file_path);
      const correctedContent = await fetchDocContent(correctedDoc.file_path);

      // Call compareStories function
      const [comparison, inputTokens, outputTokens] = await withTimeout(
        compareStories(originalContent, correctedContent, currentUserId, groupId, () => shouldStopRef.current, storyInput.model, currentTab, isLegacy),
        OPERATION_TIMEOUT,
        'compareStories'
      );

      // Override word counts with StoryDocument values
      if (originalDoc.word_count) comparison.doc1WordCount = originalDoc.word_count;
      if (correctedDoc.word_count) comparison.doc2WordCount = correctedDoc.word_count;

      // The SQL trigger will handle token updates
      const calculatedTokens = Math.round(inputTokens * 0.25 + outputTokens);
      setUsedTokens(prev => ({ ...prev, comparison: calculatedTokens }));

      // Update state with comparison results
      setGeneratedContent(prev => ({ ...prev, comparison }));
      setProgress(100);
      setAreTasksComplete(true); // Re-enable completion sections with comparison results
      setGenerationState('complete');
      setComparing(false);
      await updateCurrentTabStatus('complete', storyInput.title); // Update tab back to complete
    } catch (error: any) {
      console.error('Error comparing versions:', error);
      // Don't show error for connection issues
      if (!error.message.includes('Failed to fetch') && !error.message.includes('CORS') && !error.message.includes('Load failed')) {
        setStoryError(error.message);
        setGenerationState('error');
      }
      setComparing(false);
      await updateCurrentTabStatus('complete', storyInput.title); // Reset tab status back to complete
    
      // Clean up tasks on error
      if (groupId) {
        await cleanupTasks();
      }
    }
  };

  // Clean up tasks in the database
  async function cleanupTasks() {
    if (!groupId || !currentUserId) return;

    try {
      console.log(`Cleaning up tasks for group ${groupId}, user ${currentUserId}, tab ${currentTab}`);
    
      // Delete all tasks for this group_id and tab
      const { error } = await supabase
        .from('story_tasks')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', currentUserId)
        .eq('tab', currentTab);
      
      if (error) {
        console.error('Error cleaning up tasks:', error);
      } else {
        console.log(`Successfully deleted tasks for group ${groupId}, tab ${currentTab}`);
      }
    } catch (err) {
      console.error('Error in cleanupTasks:', err);
    }
  }

  // Handle stop action
  async function handleStop() {
    if (!confirm('Are you sure you want to stop generation? All progress will be lost.')) return;
  
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      console.error('No user authenticated');
      setStoryError('Authentication error');
      setGenerationState('error');
      setGroupId(null);
      return;
    }

    try {
      shouldStopRef.current = true;
      console.log(`Stopping tasks for user ${user.id} with groupId ${groupId || 'none'}, tab ${currentTab}`);
    
      // Unsubscribe from real-time updates if possible
      if (typeof supabase.removeAllChannels === 'function') {
        supabase.removeAllChannels();
      }
    
      // Delete all tasks for this user_id and tab
      await stopTasks(user.id, null, currentTab);
      console.log(`Successfully stopped tasks for user ${user.id}, tab ${currentTab}`);
    
      // Reset tab to defaults in database
      const { resetTabToDefaults } = await import('../utils/tabManager');
      await resetTabToDefaults(user.id, 'story', currentTab);
      console.log(`Reset tab ${currentTab} to defaults`);
    
      clearAllSessionStorage();
      resetAllStates();
      setGenerationState('idle');
      setGroupId(null);
      console.log('Generation stopped, tasks cleared, and session reset');
      generationStartTime.current = null;

      // Re-trigger mount-only effects to re-fetch user plan/tokens and reload tab data
      setReinitTrigger(prev => prev + 1);

      // Ask the container to fully remount this tab's Generator so the page
      // resets exactly as if the user navigated away and came back.
      onRequestRemount?.(currentTab);
    } catch (err: any) {
      console.error('Error stopping generation:', err);
      // Don't show error for connection issues
      if (!err.message.includes('Failed to fetch') && !err.message.includes('CORS') && !err.message.includes('Load failed')) {
        setStoryError(`Failed to stop generation: ${err.message}`);
        setGenerationState('error');
      }
    } finally {
      shouldStopRef.current = false;
    }
  }

  // Handle done action
  async function handleDone() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      console.error('No user authenticated');
      setStoryError('Authentication error');
      setGenerationState('error');
      return;
    }

    try {
      if (groupId) {
        // Use stopTasks instead of directly deleting from the database
        await stopTasks(user.id, groupId, currentTab);
        console.log(`Successfully stopped tasks for groupId ${groupId}, tab ${currentTab}`);
      }

      // Reset tab to defaults in database
      const { resetTabToDefaults } = await import('../utils/tabManager');
      await resetTabToDefaults(user.id, 'story', currentTab);
      console.log(`Reset tab ${currentTab} to defaults`);

      clearAllSessionStorage();
      resetAllStates();
      setGenerationState('idle');
      setGroupId(null);
      console.log('Generation finalized and tasks cleared');
      generationStartTime.current = null;

      // Re-trigger mount-only effects to re-fetch user plan/tokens and reload tab data
      setReinitTrigger(prev => prev + 1);

      // Ask the container to fully remount this tab's Generator so the page
      // resets exactly as if the user navigated away and came back.
      onRequestRemount?.(currentTab);
    } catch (err: any) {
      console.error('Error finalizing generation:', err);
      // Don't show error for connection issues
      if (!err.message.includes('Failed to fetch') && !err.message.includes('CORS') && !err.message.includes('Load failed')) {
        setStoryError(`Failed to finalize generation: ${err.message}`);
        setGenerationState('error');
      }
    }
  }

  // Handle error retry
  async function handleErrorRetry() {
    setStoryError(null);
    setErrorMessage(null);
  
    // Clean up any existing tasks before retrying
    if (groupId) {
      await cleanupTasks();
    }
  
    // Reset to idle state to start over
    setGenerationState('idle');
  }

  // Reset all states
  const resetAllStates = () => {
    console.log('resetAllStates called', new Error().stack);
    setGenerationState('idle');
    // Reset form inputs to defaults
    setStoryInput({
      title: '',
      description: '',
      wordCount: minutesToWordCount(10).toString(),
      language: 'english',
      model: 'deepseek',
    });
    setOutline('');
    setGeneratedContent({
      story: '',
      correctedStory: '',
      comparison: {} as ComparisonResult,
      imagePrompts: [],
      storyFileName: '',
      correctedFileName: '',
      storyTitle: '',
      correctedTitle: '',
    });
    setFeedback(null);
    setProgress(0);
    setTimeRemaining(null);
    setTotalTokens(0);
    setStoryError(null);
    setTotalBatches(0);
    setGroupId(null);
    setPendingTokenUpdates([]);
    setSessionStorageError(null);
    setShowOutlineConfirmation(false);
    setIsLoadingTasks(false);
    setDocuments([]);
    setComparing(false);
    setDoc1Label('Original Story');
    setDoc2Label('Corrected Story');
    setOutlineGenerating(false);
    setHasActiveTasks(false);
    setCurrentTask(null); // Reset current task
    setAreTasksComplete(false); // Reset task completion flag
    setUsedTokens({
      initialStory: 0,
      correctedStory: 0,
      comparison: 0,
    });
    // Reset master prompt state
    setMasterPromptEnabled(false);
    setMasterPromptEnhanceAI(false);
    setMasterPromptData(null);
    // Reset runtime mode to defaults
    setIsRuntimeMode(true);
    setRuntimeMinutes('10');
    // Reset additional states
    setBatchStatuses([]);
    setPauseTTS(false);
    setYoutubeInspirationEnabled(false);
    setYoutubeLinks(['']);
    setYoutubeLinkErrors({});
    setIsSubmitting(false);

    sessionStorage.removeItem('generationStopped');
    generationStartTime.current = null;

    // Reset processed task IDs
    processedTaskIds.current = new Set();
  };

  // Format time for display
  const formatTime = (seconds: number) => {
    const totalSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  // Download story
  const downloadStory = async (corrected: boolean = false) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setStoryError('Authentication error. Please sign in again.');
      setGenerationState('error');
      return;
    }

    try {
      const { data: doc, error: docError } = await supabase
        .from('story_documents')
        .select('file_path, title, is_corrected')
        .eq('group_id', groupId || '')
        .eq('user_id', user.id)
        .eq('is_corrected', corrected)
        .eq('tab', currentTab)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (docError) {
        throw new Error(`Failed to fetch document metadata: ${docError.message}`);
      }

      if (!doc) {
        throw new Error('No document found for download');
      }

      const fileName = doc.file_path.split('/').pop() || `${sanitizeFileName(doc.title)}.txt`;

      const { data: signedUrlData, error: signedUrlError } = await withRetry(
        () => supabase.storage.from('stories').createSignedUrl(doc.file_path, 60),
        'createSignedUrl'
      );

      if (signedUrlError) {
        throw new Error(`Failed to generate signed URL: ${signedUrlError.message}`);
      }

      const response = await fetch(signedUrlData.signedUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch file: HTTP ${response.status}`);
      }

      const text = await response.text();
      const blob = new Blob([text], { type: 'text/plain' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', fileName.endsWith('.txt') ? fileName : `${fileName}.txt`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error: any) {
      console.error('Error downloading file:', error);
      // Don't show error for connection issues
      if (!error.message.includes('Failed to fetch') && !error.message.includes('CORS') && !error.message.includes('Load failed')) {
        setStoryError(`Failed to download the file: ${error.message}. Please try again.`);
        setGenerationState('error');
      }
    }
  }

  // Fetch document content from Supabase Storage
  const fetchDocContent = async (filePath: string): Promise<string> => {
    const { data, error } = await supabase
      .storage
      .from('stories')
      .download(filePath);

    if (error) throw new Error(`Failed to download document: ${error.message}`);

    try {
      const text = await data.text();
      return text;
    } catch (err: any) {
      throw new Error(`Failed to extract text from downloaded file: ${err.message}`);
    }
  };

  // Poll tasks for progress and status with improved subscription handling
  useEffect(() => {
    if (!currentUserId || !groupId || !['outline', 'generating', 'correcting'].includes(generationState)) return;

    let lastUpdate = Date.now();
    let subscriptionActive = false;

    const subscription = supabase
      .channel(`story_tasks:${groupId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'story_tasks',
          filter: `group_id=eq.${groupId}`,
        },
        (payload) => {
          // Skip processing if this is a video_process task
          if (payload.new?.video_process === true || payload.old?.video_process === true) {
            console.log('Skipping video_process task update:', {
              task_id: payload.new?.id || payload.old?.id,
              video_process: payload.new?.video_process || payload.old?.video_process
            });
            return;
          }

          console.log('Realtime task update:', {
            event: payload.eventType,
            task_id: payload.new?.id || payload.old?.id,
            status: payload.new?.status || payload.old?.status,
            progress: payload.new?.progress || payload.old?.progress,
            batch_number: payload.new?.batch_number || payload.old?.batch_number,
            video_process: payload.new?.video_process || payload.old?.video_process,
            timestamp: new Date().toISOString(),
          });

          lastUpdate = Date.now();
          lastSubscriptionUpdateRef.current = Date.now();
          subscriptionActive = true;

          pollTasks(currentUserId, groupId, currentTab)
            .then(tasks => {
              // DEFENSIVE CHECK: Filter tasks to only those matching current tab's groupId
              // This prevents cross-tab contamination if tab switching occurs
              const filteredTasks = tasks.filter(t => t.group_id === groupId);
              
              console.log(
                `Fetched ${tasks.length} tasks (${filteredTasks.length} match current groupId):`,
                filteredTasks.map(t => ({
                  id: t.id,
                  batch_number: t.batch_number,
                  status: t.status,
                  progress: t.progress,
                  video_process: t.video_process,
                  group_id: t.group_id,
                }))
              );
              
              // Only process tasks if they match current groupId
              if (filteredTasks.length > 0) {
                processTasks(filteredTasks);
              }
            })
            .catch(err => {
              console.error('Error fetching tasks:', err);
              // Don't show error for connection issues
              if (!err.message.includes('Failed to fetch') && !err.message.includes('CORS') && !err.message.includes('Load failed')) {
                setStoryError(`Failed to fetch tasks: ${err.message}`);
                setGenerationState('error');
              }
            });
        }
      )
      .subscribe((status, err) => {
        if (err) {
          console.error('Subscription error:', err.message);
          subscriptionActive = false;
        } else {
          console.log('Subscription status:', status);
          subscriptionActive = status === 'SUBSCRIBED';
        }
      });

    const processTasks = async (tasks: StoryTask[]) => {
      // DEFENSIVE CHECK: Verify all tasks belong to current groupId
      const invalidTasks = tasks.filter(t => t.group_id !== groupId);
      if (invalidTasks.length > 0) {
        console.error(`Found ${invalidTasks.length} tasks with mismatched group_id, skipping processing`);
        return;
      }
      
      // Log to confirm video_process filtering is working
      console.log('Processing tasks (should not include video_process=true):', tasks.map(t => ({
        id: t.id,
        batch_number: t.batch_number,
        video_process: t.video_process,
        status: t.status,
        group_id: t.group_id,
      })));

      const outlineTask = tasks.find(t => t.batch_number === 0);
      const batchTasks = tasks.filter(t => t.batch_number > 0 && t.total_batches > 0);

      // Check if generation is complete using the unified helper function
      const { areStoryTasksComplete } = await import('../utils/tabManager');
      const isComplete = areStoryTasksComplete(tasks);

      if (isComplete) {
        console.log('All tasks completed, loading documents from database');
        
        // Derive correction state from task data, NOT from stale generationState closure
        const isCorrected = tasks.some(t => t.is_corrected === true);
        
        try {
          // Fetch ALL documents for this group (both original and corrected)
          const { data: docs, error: docsError } = await supabase
            .from('story_documents')
            .select('file_path, title, word_count, is_corrected, file_url')
            .eq('group_id', groupId)
            .eq('user_id', currentUserId)
            .eq('tab', currentTab)
            .order('created_at', { ascending: false });

          if (docsError || !docs || docs.length === 0) {
            throw new Error(`No documents found: ${docsError?.message || 'Empty result'}`);
          }

          console.log(`Found ${docs.length} documents for completed group`);
          let docsLoaded = false;

          for (const doc of docs) {
            try {
              let content = '';
              const { data: fileData, error: downloadError } = await supabase
                .storage
                .from('stories')
                .download(doc.file_path);

              if (downloadError || !fileData) {
                // Fallback: fetch from public file_url
                console.warn(`Storage download failed for ${doc.file_path}, trying file_url fallback`);
                try {
                  const response = await fetch(doc.file_url);
                  if (response.ok) {
                    content = await response.text();
                  } else {
                    console.error(`Fallback fetch failed: HTTP ${response.status}`);
                    continue;
                  }
                } catch (fetchErr) {
                  console.error(`Fallback fetch error:`, fetchErr);
                  continue;
                }
              } else {
                content = await fileData.text();
              }

              if (!content) continue;

              console.log(`Loaded ${content.length} chars for ${doc.is_corrected ? 'corrected' : 'original'} document`);
              docsLoaded = true;

              setGeneratedContent(prev => ({
                ...prev,
                [doc.is_corrected ? 'correctedStory' : 'story']: content,
                [doc.is_corrected ? 'correctedFileName' : 'storyFileName']: doc.file_url.split('/').pop() || '',
                [doc.is_corrected ? 'correctedTitle' : 'storyTitle']: doc.title,
              }));
            } catch (err) {
              console.error(`Failed to load document ${doc.file_path}:`, err);
            }
          }

          if (!docsLoaded) {
            throw new Error('All document downloads failed');
          }

          // Set completion state AFTER documents are loaded
          setGenerationState(isCorrected ? 'corrected' : 'complete');
          setAreTasksComplete(true);
          await updateCurrentTabStatus('complete', storyInput.title);
          setProgress(100);
          setTimeRemaining(0);
          setBatchStatuses([]);
          setHasActiveTasks(false);
          setSettingsCollapsed(true);
          setCurrentTask(null);

        } catch (error: any) {
          console.error('Error fetching completed document:', error);
          setStoryError(`Failed to load completed story: ${error.message}`);
          setGenerationState('error');
        }
        
        return; // Exit early since generation is complete
      }
  
      if (outlineTask && batchTasks.length < (outlineTask.total_batches || 0)) {
        console.warn(`Mismatch: ${batchTasks.length} batch tasks found, expected ${outlineTask.total_batches}`);
        try {
          await ensureBatchTasks(
            currentUserId,
            groupId,
            storyInput.title,
            storyInput.description,
            currentTab
          );
          const updatedTasks = await pollTasks(currentUserId, groupId, currentTab);
          console.log(`After ensuring batch tasks: ${updatedTasks.length} tasks found`);
          tasks = updatedTasks;
        } catch (err) {
          console.error('Failed to recreate missing tasks:', err);
        }
      }
  
      if (batchTasks.length === 0 && generationState !== 'outline') {
        // Also check task data directly - if the only task is batch_number=0 with no outline yet,
        // we're still in outline phase regardless of what generationState says (stale closure)
        const isStillOutlinePhase = outlineTask && !outlineTask.outline && outlineTask.status === 'processing' && outlineTask.total_batches === null;
        if (isStillOutlinePhase) {
          console.log('No batch tasks yet but outline is still generating — skipping error');
          return;
        }
        console.warn('No batch tasks found, retrying...');
        try {
          const retryTasks = await pollTasks(currentUserId, groupId, currentTab);
          const retryBatchTasks = retryTasks.filter(t => t.batch_number > 0 && t.total_batches > 0);
          if (retryBatchTasks.length === 0) {
            console.error('No batch tasks found after retry');
            setStoryError('No valid story tasks found. Please retry or contact support.');
            setGenerationState('error');
            setGroupId(null);
            return;
          }
          tasks = retryTasks;
        } catch (err) {
          console.error('Retry failed:', err);
          // Don't show error for connection issues
          if (!err.message.includes('Failed to fetch') && !err.message.includes('CORS') && !err.message.includes('Load failed')) {
            setStoryError('Failed to retrieve tasks after retry. Please retry or contact support.');
            setGenerationState('error');
            setGroupId(null);
          }
          return;
        }
      }
  
      if (outlineTask && generationState === 'outline') {
        if (outlineTask.status === 'completed' && outlineTask.outline) {
          setOutline(outlineTask.outline);
          setShowOutlineConfirmation(true);
          setGenerationState('outline');
          setBatchStatuses([{ batchNumber: 0, status: 'completed', progress: 100 }]);
        } else if (outlineTask.status === 'error') {
          setStoryError(outlineTask.error || 'Outline generation failed');
          setGenerationState('error');
          setGroupId(null);
          setBatchStatuses([]);
        } else if (outlineTask.status === 'stopped') {
          setGenerationState('stopped');
          setStoryError('Generation stopped');
          setGroupId(null);
          setBatchStatuses([]);
        }
        return;
      }
  
      const filteredTasks = generationState === 'correcting'
        ? batchTasks.filter(t => t.is_corrected === true)
        : batchTasks.filter(t => !t.is_corrected);
  
      console.log('Filtered tasks for state:', generationState, filteredTasks.map(t => ({
        id: t.id,
        batch_number: t.batch_number,
        status: t.status,
        progress: t.progress,
        is_corrected: t.is_corrected,
        version: t.version
      })));
  
      const totalBatches = filteredTasks.length > 0 ? filteredTasks[0]?.total_batches || filteredTasks.length : 0;
      const totalProgress = filteredTasks.reduce((sum, t) => sum + (t.progress || 0), 0);
      const progressPercentage = Math.min(100, totalBatches > 0 ? (totalProgress / (totalBatches * 100)) * 100 : 0);
  
      const completedBatchTasks = filteredTasks.filter(t => t.status === 'completed' || t.status === 'completed_final' || t.progress === 100);
      const remainingTime = (totalBatches - completedBatchTasks.length) * 90;

      // Find the current task being processed and set it
      const currentTaskNumber = completedBatchTasks.length + 1;
      const runningTask = filteredTasks.find(t => t.batch_number === currentTaskNumber && (t.status === 'running' || t.status === 'processing'));
      setCurrentTask(runningTask || null);
  
      console.log('Progress calculation:', {
        totalBatches,
        totalProgress,
        progressPercentage: progressPercentage.toFixed(2),
        completedBatches: completedBatchTasks.length,
        remainingTime,
        currentTask: runningTask ? { id: runningTask.id, batch_number: runningTask.batch_number, check_stuck: runningTask.check_stuck } : null,
        filteredTasks: filteredTasks.map(t => ({ batch_number: t.batch_number, status: t.status, progress: t.progress })),
      });
  
      setProgress(prev => {
        if (Math.abs(prev - progressPercentage) > 0.01) {
          console.log(`Updating progress from ${prev} to ${progressPercentage}`);
          return progressPercentage;
        }
        return prev;
      });
      setTimeRemaining(remainingTime);
      setTotalBatches(totalBatches);
      setBatchStatuses(filteredTasks.map(t => ({
        batchNumber: t.batch_number,
        status: t.status,
        progress: t.progress || 0,
      })));
  
      // Fetch updated user_plans to reflect token changes from the trigger
      const { data: currentPlan, error: planError } = await withRetry(
        () => withTimeout(
          supabase
            .from('user_plans')
            .select('tokens_used, plan_type, rollover_tokens')
            .eq('user_id', currentUserId)
            .eq('is_active', true)
            .single(),
          OPERATION_TIMEOUT,
          'fetchUserPlanForUpdate'
        ),
        'fetchUserPlanForUpdate'
      );
      if (planError) {
        console.error('Failed to fetch user plan:', planError);
      } else if (currentPlan) {
        const planType = currentPlan.plan_type || 'free';
        const tokenLimit = PLAN_MAX_TOKENS[planType] || 400000;
        const rolloverTokens = currentPlan.rollover_tokens || 0;
        setUserTokenBalance(tokenLimit + rolloverTokens - currentPlan.tokens_used);
        setTotalTokens(currentPlan.tokens_used);
      }
  
      const errorTask = filteredTasks.find(t => t.status === 'error');
      if (errorTask) {
        setStoryError(errorTask.error || 'Task failed. Checking for partial story.');
        setGenerationState('error');
        setGroupId(null);
      }
  
      const stoppedTask = filteredTasks.find(t => t.status === 'stopped');
      if (stoppedTask) {
        setGenerationState('stopped');
        setStoryError('Generation stopped');
        setGroupId(null);
        setBatchStatuses([]);
        return;
      }

      const hasRunningTask = filteredTasks.some(t => t.status === 'running' || t.status === 'processing');
      const hasPendingTask = filteredTasks.some(t => t.status === 'pending');
      const allTasksCompleted = filteredTasks.every(t => t.status === 'completed' || t.status === 'completed_final');
    
      if (!hasRunningTask && hasPendingTask && !allTasksCompleted) {
        console.log('No running tasks found but pending tasks exist. Triggering next batch...');
        try {
          const completedBatches = filteredTasks
            .filter(t => t.status === 'completed' || t.status === 'completed_final')
            .map(t => t.batch_number);
        
          const lastCompletedBatch = completedBatches.length ? Math.max(...completedBatches) : 0;
          
          // Use appropriate trigger endpoint based on generation state
          const triggerEndpoint = generationState === 'correcting' 
            ? 'trigger-next-corrected-batch'
            : 'trigger-next-batch';
        
          const { data: { session: _gSession } } = await supabase.auth.getSession();
          const response = await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/${triggerEndpoint}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${_gSession?.access_token || ''}`,
              'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
            },
            body: JSON.stringify({
              group_id: groupId,
              user_id: currentUserId,
              current_batch_number: lastCompletedBatch,
            }),
          });
          if (!response.ok) {
            console.warn(`Failed to trigger next batch: HTTP ${response.status}`);
          } else {
            console.log('Successfully triggered next batch');
          }
        } catch (err: any) {
          console.error('Error triggering next batch:', err);
        }
      }
    };

    const pollTasksInterval = async () => {
      if (subscriptionActive && Date.now() - lastUpdate < POLLING_INTERVAL) {
        console.log('Skipping poll: Subscription active and recent update received');
        return;
      }

      console.log('Polling tasks due to inactive subscription or no recent updates');
      try {
        const tasks = await pollTasks(currentUserId, groupId, currentTab);
        
        // DEFENSIVE CHECK: Filter tasks to only those matching current groupId
        const filteredTasks = tasks.filter(t => t.group_id === groupId);
        console.log(`Polled ${tasks.length} tasks (${filteredTasks.length} match current groupId)`);
        
        // Only process if tasks match current groupId
        if (filteredTasks.length > 0) {
          await processTasks(filteredTasks);
        }
        lastUpdate = Date.now();
      } catch (err) {
        console.error('Polling error:', err);
      }
    };

    const checkSubscription = () => {
      if (!subscriptionActive && Date.now() - lastSubscriptionUpdateRef.current > SUBSCRIPTION_CHECK_INTERVAL) {
        console.warn('Subscription inactive for 60s, attempting to reconnect');
        subscription.unsubscribe();
        subscription.subscribe((status, err) => {
          if (err) {
            console.error('Re-subscription error:', err.message);
            subscriptionActive = false;
          } else {
            console.log('Re-subscription status:', status);
            subscriptionActive = status === 'SUBSCRIBED';
            lastSubscriptionUpdateRef.current = Date.now();
          }
        });
      }
    };

    const pollInterval = setInterval(pollTasksInterval, POLLING_INTERVAL);
    const subscriptionCheckInterval = setInterval(checkSubscription, SUBSCRIPTION_CHECK_INTERVAL);

    return () => {
      subscription.unsubscribe();
      clearInterval(pollInterval);
      clearInterval(subscriptionCheckInterval);
    };
  }, [
    currentUserId,
    groupId,
    generationState,
    supabase,
    getTasks,
    setStoryError,
    setGenerationState,
    setGroupId,
    setOutline,
    setShowOutlineConfirmation,
    setProgress,
    setTimeRemaining,
    setTotalBatches,
    setBatchStatuses,
    setGeneratedContent,
  ]);

  // Process pending token updates
  useEffect(() => {
    if (generationState !== 'complete' && generationState !== 'error' && generationState !== 'corrected') return;

    const processPendingTokenUpdates = async () => {
      if (pendingTokenUpdates.length === 0) return;

      try {
        // Fetch updated user_plans to reflect token changes from the trigger
        const { data: currentPlan, error: planError } = await withRetry(
          () => withTimeout(
            supabase
              .from('user_plans')
              .select('tokens_used, plan_type, rollover_tokens')
              .eq('user_id', currentUserId)
              .eq('is_active', true)
              .single(),
            OPERATION_TIMEOUT,
            'fetchUserPlanForUpdate'
          ),
          'fetchUserPlanForUpdate'
        );
        if (planError) {
          console.error('Failed to fetch user plan:', planError);
        } else if (currentPlan) {
          const planType = currentPlan.plan_type || 'free';
          const tokenLimit = PLAN_MAX_TOKENS[planType] || 400000;
          const rolloverTokens = currentPlan.rollover_tokens || 0;
          setUserTokenBalance(tokenLimit + rolloverTokens - currentPlan.tokens_used);
          setTotalTokens(currentPlan.tokens_used);
        }
      
        setPendingTokenUpdates([]);
      } catch (error: any) {
        console.error('Error processing pending token updates:', error);
        // Don't show error for connection issues
        if (!error.message.includes('Failed to fetch') && !error.message.includes('CORS') && !error.message.includes('Load failed')) {
          setStoryError(error.message);
          setGenerationState('error');
        }
      }
    };

    processPendingTokenUpdates();
  }, [generationState, pendingTokenUpdates]);

  const fetchTokenUsage = async (userId: string, groupId: string) => {
    try {
      const { data: tasks, error } = await withRetry(
        () =>
          withTimeout(
            supabase
              .from('story_tasks')
              .select('version, input_tokens, output_tokens, status')
              .eq('user_id', userId)
              .eq('group_id', groupId)
              .eq('tab', currentTab)
              .in('status', ['completed', 'completed_final']),
            OPERATION_TIMEOUT,
            'fetchStoryTasksForTokens'
          ),
        'fetchStoryTasksForTokens'
      );

      if (error) {
        console.error('Error fetching tasks for token usage:', error);
        // Don't show error for connection issues
        if (!error.message.includes('Failed to fetch') && !error.message.includes('CORS') && !error.message.includes('Load failed')) {
          setStoryError(`Failed to fetch token usage: ${error.message}`);
          setGenerationState('error');
        }
        return;
      }

      const initialTokens = tasks
        .filter(t => t.version === 1)
        .reduce((sum, t) => {
          const inputTokens = t.input_tokens || 0;
          const outputTokens = t.output_tokens || 0;
          return sum + Math.round(inputTokens * 0.25 + outputTokens);
        }, 0);

      const correctedTokens = tasks
        .filter(t => t.version === 2)
        .reduce((sum, t) => {
          const inputTokens = t.input_tokens || 0;
          const outputTokens = t.output_tokens || 0;
          return sum + Math.round(inputTokens * 0.25 + outputTokens);
        }, 0);

      setUsedTokens(prev => ({
        ...prev,
        initialStory: initialTokens,
        correctedStory: correctedTokens,
      }));
    } catch (error: any) {
      console.error('Error in fetchTokenUsage:', error);
      // Don't show error for connection issues
      if (!error.message.includes('Failed to fetch') && !error.message.includes('CORS') && !error.message.includes('Load failed')) {
        setStoryError(`Failed to fetch token usage: ${error.message}`);
        setGenerationState('error');
      }
    }
  };

  useEffect(() => {
    if (generatedContent.comparison.doc1Review && currentUserId && groupId) {
      fetchTokenUsage(currentUserId, groupId);
    }
  }, [generatedContent.comparison.doc1Review, currentUserId, groupId]);

  const isFormLocked = NON_IDLE_STATES.includes(generationState) || hasActiveTasks;

  return (
    <DashboardLayout>
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8" style={{ zoom: 1.1 }}>
        {/* Atmospheric gradient background */}
        <div className="pointer-events-none absolute inset-0 -top-20 overflow-hidden" aria-hidden="true">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120%] h-[500px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(220,38,38,0.14)_0%,transparent_70%)]" />
          <div className="absolute top-40 left-0 w-[40%] h-[300px] bg-[radial-gradient(ellipse_80%_80%_at_20%_50%,rgba(59,130,246,0.07)_0%,transparent_60%)]" />
          <div className="absolute top-60 right-0 w-[35%] h-[250px] bg-[radial-gradient(ellipse_80%_80%_at_80%_50%,rgba(34,197,94,0.06)_0%,transparent_60%)]" />
        </div>

        <div className="relative mb-8 dash-animate-in">
          <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Story Generator</h1>
          <div className="mt-2">
            <p className="text-text-secondary">Long-form stories up to 150,000 words</p>
            <p className="text-text-muted text-sm mt-1">{formatNumber(userTokenBalance)} tokens remaining</p>
          </div>

          {/* What to Expect info box */}
          <div className="mt-5 p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card dash-animate-in">
            <div>
                <h3 className="text-xl font-semibold mb-2 text-accent">What to Expect</h3>
                <p className="text-[15px] text-white/80 leading-relaxed">
                  Built for long-form YouTube content — generate stories up to 150,000 words (over 20 hours of audio). 
                  Describe your concept and the AI creates a structured outline, then writes the full story in batches. 
                  Generation runs entirely in the background, so you can navigate away and come back anytime.
                </p>
                <Link
                  to="/learn#story-generator"
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
                    Write a short paragraph about what you want the story to be about. Don't mention structure — the AI handles that. Best results when describing a story rather than a script.
                  </p>
                </div>
            </div>
          </div>

          {/* Multi-Tab Manager for Premium Users (Elite, Ultimate, Enterprise) */}
          {isEnterpriseUser && userId && (
            <TabManager
              userId={userId}
              isEnterpriseUser={isEnterpriseUser}
              initialTabs={initialTabs}
              currentTab={currentTab}
              onTabChange={onTabChange}
              onTabCreate={onTabCreate}
              onTabClose={onTabClose}
            />
          )}

          {/* Blue info box when generating */}
          {(['outline', 'queueing', 'generating', 'correctingQueueing', 'correcting', 'comparing'].includes(generationState)) && (
            <StatusBanner
              variant="info"
              className="mt-8"
              icon={<Loader className="h-5 w-5 text-status-info animate-spin" />}
              title={storyInput.title || 'Your story'}
              subtitle={<>{formatNumber(parseInt(storyInput.wordCount) || 0)} words &middot; Generating...</>}
            />
          )}

          {(generationState === 'complete' || generationState === 'corrected') && (
            <StatusBanner
              variant="success"
              className="mt-8"
              title={<>{storyInput.title || 'Your story'} is done generating!</>}
              subtitle="Ready for download or further processing."
            />
          )}
        </div>

        <ErrorBoundary key={renderKey}>
          <div className="relative">
            <div>
              <form
                onSubmit={handleSubmit}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    const form = e.currentTarget;
                    form.requestSubmit();
                  }
                }}
                className="space-y-6 dash-stagger"
              >
                <div
                  className="dash-collapse-grid relative z-20"
                  data-collapsed={NON_IDLE_STATES.includes(generationState) ? 'true' : 'false'}
                >
                  <div>
                <div className="space-y-5">
                  {/* Story Title */}
                  <div className="relative px-1">
                    <label htmlFor="title" className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                      Story Title
                    </label>
                    <input
                      type="text"
                      id="title"
                      value={storyInput.title}
                      onChange={(e) => {
                        const updatedInput = { ...storyInput, title: e.target.value };
                        setStoryInput(updatedInput);
                        saveFormInputsToDatabase(updatedInput);
                      }}
                      className="block w-full px-5 py-4 rounded-xl bg-surface-input border border-white/[0.13] text-white/95 placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out"
                      placeholder="Enter an engaging title for your story"
                      aria-required="true"
                      disabled={isFormLocked}
                    />
                  </div>

                  {/* Brief Description */}
                  <div className="relative px-1">
                    <label htmlFor="description" className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                      Brief Description
                    </label>
                    <textarea
                      id="description"
                      value={storyInput.description}
                      onChange={(e) => {
                        if (e.target.value.length <= 5000) {
                          const updatedInput = { ...storyInput, description: e.target.value };
                          setStoryInput(updatedInput);
                          saveFormInputsToDatabase(updatedInput);
                        }
                      }}
                      rows={4}
                      className="block w-full px-5 py-4 rounded-xl bg-surface-input border border-white/[0.13] text-white/95 placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out resize-none"
                      placeholder="Describe your story concept — write what you want the story to be about. Don't mention structure, the AI handles that. Best results when describing a story rather than a script."
                      aria-required="true"
                      disabled={isFormLocked}
                    />
                    {storyInput.description.length >= 5000 && (
                      <p className="text-xs text-status-warning mt-2">Character limit reached (5,000 / 5,000)</p>
                    )}
                  </div>

                  {/* Word Count / Runtime */}
                  <div className="relative px-1">
                    <div className="flex items-center justify-between mb-2">
                      <label htmlFor="wordCount" className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase">
                        {isRuntimeMode ? 'Runtime in Minutes' : 'Word Count'}
                      </label>
                      <div className="flex items-center gap-3">
                        <span className={`text-sm ${!isRuntimeMode ? 'text-accent-text font-medium' : 'text-text-muted'}`}>
                          Words
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={isRuntimeMode}
                          aria-label="Toggle between runtime and word count mode"
                          onClick={() => {
                            const newMode = !isRuntimeMode;
                            setIsRuntimeMode(newMode);
                            // Convert between modes
                            if (newMode) {
                              // Switching to runtime: convert word count to minutes
                              const wordCountNum = parseInt(storyInput.wordCount) || 200;
                              setRuntimeMinutes(wordCountToMinutes(wordCountNum).toString());
                            } else {
                              // Switching to word count: convert minutes to words
                              const minutesNum = parseInt(runtimeMinutes) || 10;
                              setStoryInput({ ...storyInput, wordCount: minutesToWordCount(minutesNum).toString() });
                            }
                          }}
                          disabled={isFormLocked}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                            isRuntimeMode ? 'bg-accent' : 'bg-border'
                          } ${isFormLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              isRuntimeMode ? 'translate-x-6' : 'translate-x-1'
                            }`}
                          />
                        </button>
                        <span className={`text-sm ${isRuntimeMode ? 'text-accent-text font-medium' : 'text-text-muted'}`}>
                          Runtime
                        </span>
                      </div>
                    </div>

                    {isRuntimeMode ? (
                      <>
                        <input
                          type="text"
                          id="runtimeMinutes"
                          value={runtimeMinutes}
                          onChange={(e) => {
                            setRuntimeMinutes(e.target.value);
                            const minutes = isValidNumericInput(e.target.value) ? parseInt(e.target.value) : 0;
                            const updatedInput = { ...storyInput, wordCount: minutesToWordCount(minutes).toString() };
                            setStoryInput(updatedInput);
                            saveFormInputsToDatabase(updatedInput);
                          }}
                          className="block w-full px-5 py-4 rounded-xl bg-surface-input border border-white/[0.13] text-white/95 placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out"
                          placeholder="Enter runtime in minutes"
                          disabled={isFormLocked}
                        />
                        <p className="text-xs text-text-muted mt-1">
                          {getMinuteLimitsForModel(storyInput.model).min}-{getMinuteLimitsForModel(storyInput.model).max} minutes 
                          {' '}(~{minutesToWordCount(parseInt(runtimeMinutes?.toString() || '0')).toLocaleString()} words)
                        </p>
                      </>
                    ) : (
                      <>
                        <input
                          type="text"
                          id="wordCount"
                          value={storyInput.wordCount}
                          onChange={(e) => {
                            const updatedInput = { ...storyInput, wordCount: e.target.value };
                            setStoryInput(updatedInput);
                            const wordCountNum = isValidNumericInput(e.target.value) ? parseInt(e.target.value) : 0;
                            setRuntimeMinutes(wordCountToMinutes(wordCountNum).toString());
                            saveFormInputsToDatabase(updatedInput);
                          }}
                          className="block w-full px-5 py-4 rounded-xl bg-surface-input border border-white/[0.13] text-white/95 placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out"
                          placeholder="Enter desired word count"
                          disabled={isFormLocked}
                        />
                        <p className="text-xs text-text-muted mt-1">
                          200-{(modelOptions.find(m => m.value === storyInput.model)?.maxWords || 50000).toLocaleString()} words
                          {' '}(~{wordCountToMinutes(parseInt(storyInput.wordCount) || 0)} minutes)
                        </p>
                      </>
                    )}

                    {wordCountError && (
                      <div className="bg-status-warning text-status-warning-text p-4 rounded-xl mt-2">
                        <div className="flex items-center space-x-2 text-status-warning mb-2">
                          <AlertCircle className="h-5 w-5" />
                          <h3 className="text-lg font-medium">Warning</h3>
                        </div>
                        <p>{wordCountError}</p>
                      </div>
                    )}
                  </div>

                  <div className="space-y-5" style={{ zoom: 1 / 1.1 }}>
                  {/* Master Prompt Section */}
                  <MasterPrompt
                    enabled={masterPromptEnabled}
                    setEnabled={setMasterPromptEnabled}
                    enhanceAI={masterPromptEnhanceAI}
                    setEnhanceAI={setMasterPromptEnhanceAI}
                    data={masterPromptData}
                    setData={setMasterPromptData}
                    disabled={isFormLocked}
                  />

                  {/* Pause Text-to-Speech Section */}
                  <div className="p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <h3 className="text-white font-medium">Pause Text-to-Speech</h3>
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-status-success text-status-success border border-status-success">
                          Recommended
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={pauseTTS}
                        aria-label="Toggle pause text-to-speech"
                        onClick={() => setPauseTTS(!pauseTTS)}
                        disabled={isFormLocked}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                          pauseTTS ? 'bg-accent' : 'bg-border'
                        } ${isFormLocked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                            pauseTTS ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                    <p className="text-text-muted text-sm mt-2">
                      Inserts natural pauses between sentences in the generated story. When this story is converted to audio on the <Link to="/text-to-speech" className="text-accent-text hover:text-accent-hover transition-colors duration-200">Text-to-Speech page</Link>, the pauses create more realistic, human-like narration with better pacing and dramatic delivery.
                    </p>
                    {pauseTTS && (
                      <div className="flex items-start space-x-2 bg-status-warning border border-status-warning rounded-xl px-4 py-3 mt-3">
                        <AlertTriangle className="h-5 w-5 text-status-warning flex-shrink-0 mt-0.5" />
                        <p className="text-status-warning-text text-sm">
                          Pauses require <strong>Premium</strong>, <strong>Apex</strong>, or <strong>Clone</strong> voices. Core voices do not support pause functionality and will be unavailable for selection.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* YouTube Inspiration Section */}
                  <div className="p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <h3 className="text-white font-medium">YouTube Inspiration</h3>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={youtubeInspirationEnabled}
                        aria-label="Toggle YouTube inspiration"
                        onClick={() => {
                          const newValue = !youtubeInspirationEnabled;
                          setYoutubeInspirationEnabled(newValue);
                          if (!newValue) {
                            setYoutubeLinks(['']);
                            setYoutubeLinkErrors({});
                          }
                          saveFormInputsToDatabase(storyInput);
                        }}
                        disabled={isFormLocked}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                          youtubeInspirationEnabled ? 'bg-accent' : 'bg-border'
                        } ${isFormLocked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                            youtubeInspirationEnabled ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                    <p className="text-text-muted text-sm mt-2">
                      Add a YouTube video link as creative inspiration. The transcript will be extracted and used to shape the story's tone, themes, and narrative style.
                    </p>
                    {/* YouTube Links Inputs — collapsible */}
                    <div
                      className="grid transition-[grid-template-rows] duration-300 ease-out"
                      style={{ gridTemplateRows: youtubeInspirationEnabled ? '1fr' : '0fr' }}
                    >
                      <div className="overflow-hidden -mx-1 px-1">
                        <div className="pt-4 pb-1 space-y-3">
                          <div className="dash-info-box p-2.5 flex gap-2">
                            <Info className="w-4 h-4 dash-box-icon flex-shrink-0 mt-0.5" />
                            <p className="text-xs dash-box-text">Only the first 20 minutes of a video are used as context.</p>
                          </div>
                          {youtubeLinks.map((link, index) => {
                            const videoId = link.trim() ? extractYoutubeVideoId(link.trim()) : null;
                            const hasError = !!youtubeLinkErrors[index];
                            const showThumbnail = videoId && !hasError;
                            return (
                            <div key={index}>
                              <div className="flex items-center gap-2 min-w-0">
                                <div className="min-w-0 flex-1">
                                  <input
                                    type="url"
                                    value={link}
                                    onChange={(e) => {
                                      const newLinks = [...youtubeLinks];
                                      newLinks[index] = e.target.value;
                                      setYoutubeLinks(newLinks);
                                      // Validate on change
                                      const error = validateYoutubeUrl(e.target.value);
                                      setYoutubeLinkErrors(prev => {
                                        const next = { ...prev };
                                        if (error) next[index] = error;
                                        else delete next[index];
                                        return next;
                                      });
                                      saveFormInputsToDatabase(storyInput);
                                    }}
                                    placeholder={`YouTube video URL${youtubeLinks.length > 1 ? ` #${index + 1}` : ''}`}
                                    disabled={isFormLocked}
                                    className={`w-full rounded-xl bg-surface-input border ${
                                      hasError ? 'border-status-warning' : 'border-white/[0.13]'
                                    } px-4 py-3 text-white/95 text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 ${
                                      isFormLocked ? 'opacity-50 cursor-not-allowed' : ''
                                    }`}
                                  />
                                </div>
                                {youtubeLinks.length > 1 && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const newLinks = youtubeLinks.filter((_, i) => i !== index);
                                      setYoutubeLinks(newLinks);
                                      setYoutubeLinkErrors(prev => {
                                        const next: Record<number, string> = {};
                                        Object.entries(prev).forEach(([k, v]) => {
                                          const ki = parseInt(k);
                                          if (ki < index) next[ki] = v;
                                          else if (ki > index) next[ki - 1] = v;
                                        });
                                        return next;
                                      });
                                      saveFormInputsToDatabase(storyInput);
                                    }}
                                    disabled={isFormLocked}
                                    className="p-2 rounded-lg text-text-muted hover:text-red-400 hover:bg-white/[0.05] transition-colors duration-200 flex-shrink-0"
                                    aria-label={`Remove video ${index + 1}`}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                )}
                              </div>
                              {hasError && (
                                <div className="flex items-center gap-1.5 mt-1.5 ml-1">
                                  <AlertTriangle className="h-3.5 w-3.5 text-status-warning flex-shrink-0" />
                                  <p className="text-status-warning text-xs">{youtubeLinkErrors[index]}</p>
                                </div>
                              )}
                              {showThumbnail && (
                                <div className="mt-2 rounded-lg overflow-hidden border border-white/[0.08] w-fit">
                                  <img
                                    src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
                                    alt="Video thumbnail"
                                    className="block w-48 h-auto rounded-lg"
                                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                  />
                                </div>
                              )}
                            </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="relative px-1">
                    <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                      Language
                    </label>
                    <Listbox
                      value={storyInput.language}
                      onChange={(value) => {
                        const updatedInput = { ...storyInput, language: value };
                        setStoryInput(updatedInput);
                        saveFormInputsToDatabase(updatedInput);
                      }}
                      disabled={isFormLocked}
                    >
                      {({ open }) => (
                        <div className="relative">
                          <Listbox.Button className={`relative w-full rounded-xl bg-surface-input border border-white/[0.13] px-5 py-4 text-left text-white/95 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 shadow-sm transition-all duration-200 ${isFormLocked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-surface-input'}`}>
                            <span className="block truncate">
                              {languageOptions.find(option => option.value === storyInput.language)?.label || 'English'}
                            </span>
                            <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                              <ChevronDown className={`h-5 w-5 text-text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
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
                            <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-dropdown border border-white/[0.08] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                              {languageOptions.map((option) => (
                                <Listbox.Option
                                  key={option.value}
                                  value={option.value}
                                  className={({ active, selected }) =>
                                    `relative cursor-pointer select-none py-3 px-4 ${active ? 'bg-white/[0.08] text-white' : 'text-white/90'} ${selected ? 'font-medium' : 'font-normal'}`
                                  }
                                >
                                  {({ selected }) => (
                                    <div className="flex justify-between items-center">
                                      <span className={selected ? 'font-medium' : 'font-normal'}>{option.label}</span>
                                      {selected && (
                                        <span className="text-accent-text">
                                          <CheckCircle2 className="h-5 w-5" />
                                        </span>
                                      )}
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

                  <div className="relative px-1">
                    <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                      AI Model
                    </label>
                    <Listbox
                      value={storyInput.model}
                      onChange={(value) => {
                        const isPaidModel = value !== 'deepseek';
                        if (isPaidModel && userPlan === 'free') return;
                        const updatedInput = { ...storyInput, model: value };
                        setStoryInput(updatedInput);
                        saveFormInputsToDatabase(updatedInput);
                      }}
                      disabled={isFormLocked}
                    >
                      {({ open }) => (
                        <div className="relative">
                          <Listbox.Button className={`relative w-full rounded-xl bg-surface-input border border-white/[0.13] px-5 py-4 text-left text-white/95 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 shadow-sm transition-all duration-200 ${isFormLocked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-surface-input'}`}>
                            <span className="block truncate">
                              {selectedModel.label}
                            </span>
                            <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                              <ChevronDown className={`h-5 w-5 text-text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
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
                            <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-dropdown border border-white/[0.08] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                              {modelOptions.map((option) => {
                                const isLocked = userPlan === 'free' && option.value !== 'deepseek';
                                return (
                                <Listbox.Option
                                  key={option.value}
                                  value={option.value}
                                  disabled={isLocked}
                                  className={({ active, selected }) =>
                                    `relative select-none py-3 px-4 ${isLocked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${active && !isLocked ? 'bg-white/[0.08] text-white' : 'text-white/90'} ${selected ? 'font-medium' : 'font-normal'}`
                                  }
                                >
                                  {({ selected }) => (
                                    <div className="flex justify-between items-center">
                                      <div>
                                        <span className={`${selected ? 'font-medium' : 'font-normal'} ${isLocked ? 'text-white/40' : ''}`}>{option.label}</span>
                                        <p className="text-xs text-text-muted mt-1">
                                          {option.description} • Max: {option.maxWords.toLocaleString()} words
                                        </p>
                                      </div>
                                      {isLocked ? (
                                        <span className="flex items-center gap-1.5 text-xs text-white/30">
                                          <Lock className="h-3.5 w-3.5" />
                                          Paid
                                        </span>
                                      ) : selected ? (
                                        <span className="text-accent-text">
                                          <CheckCircle2 className="h-5 w-5" />
                                        </span>
                                      ) : null}
                                    </div>
                                  )}
                                </Listbox.Option>
                                );
                              })}
                            </Listbox.Options>
                          </Transition>
                        </div>
                      )}
                    </Listbox>
                    <p className="mt-2 text-xs text-text-muted">
                      Selected: {selectedModel.label} ({selectedModel.description})
                    </p>
                  </div>

                  {generationState === 'idle' && (
                    <div>
                      <p className="text-sm font-medium text-text-secondary mb-2">Estimated Token Usage</p>
                      <ul className="text-sm text-text-muted space-y-1">
                        <li>Initial Story: {formatNumber(estimatedTokens.initialStory)} tokens</li>
                        <li>Estimated Audio Length: {calculateEstimatedAudioTime(parseInt(storyInput.wordCount, 10) || 0)}</li>
                      </ul>
                    </div>
                  )}

                  {generationState === 'idle' && estimatedTokens.initialStory > userTokenBalance && (
                    <div className="bg-status-warning text-status-warning-text p-4 rounded-xl mt-2">
                      <div className="flex items-center space-x-2 text-status-warning mb-2">
                        <AlertCircle className="h-5 w-5" />
                        <h3 className="text-lg font-medium">Warning</h3>
                      </div>
                      <p>
                        The estimated token usage for the Initial Story ({formatNumber(estimatedTokens.initialStory)} tokens) exceeds your remaining balance of {formatNumber(userTokenBalance)} tokens. Please upgrade your plan to proceed.
                      </p>
                    </div>
                  )}
                  </div>
                </div>
                  </div>
                </div>

                {sessionStorageError && (
                  <div className="bg-status-warning text-status-warning-text p-4 rounded-xl mb-6">
                    <div className="flex items-center space-x-2 text-status-warning mb-2">
                      <AlertCircle className="h-5 w-5" />
                      <h3 className="text-lg font-medium">Warning</h3>
                    </div>
                    <p>{sessionStorageError}</p>
                  </div>
                )}

                {errorMessage && (
                  <div className="bg-status-warning text-status-warning-text p-4 rounded-xl mb-6">
                    <div className="flex items-center space-x-2 text-status-warning mb-2">
                      <AlertCircle className="h-5 w-5" />
                      <h3 className="text-lg font-medium">Warning</h3>
                    </div>
                    <p>{errorMessage}</p>
                  </div>
                )}

                {storyError && (
                  <div className="bg-status-error text-status-error p-4 rounded-xl mb-6">
                    <div className="flex items-center space-x-2 text-status-error-muted mb-2">
                      <AlertCircle className="h-5 w-5" />
                      <h3 className="text-lg font-medium">Error</h3>
                    </div>
                    <p>
                      {storyError.includes('Rate limit') ? 'The server is busy. Please wait a moment and try again.' :
                       storyError.includes('Invalid input') ? 'Please check your inputs and try again.' :
                       storyError.includes('Network error') ? 'Unable to connect to the server. Please check your internet connection.' :
                       storyError}
                    </p>
                    <div className="flex space-x-4 mt-4">
                      <button
                        onClick={handleStop}
                        className="px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover"
                      >
                        Clear
                      </button>
                      {generationState === 'error' && (
                        <button
                          onClick={handleErrorRetry}
                          className="px-4 py-2 bg-status-success-muted text-white rounded-xl hover:brightness-110"
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  {generationState !== 'complete' && generationState !== 'corrected' && (
                  <button
                    type="submit"
                    disabled={
                      !storyInput.title.trim() ||
                      !storyInput.description.trim() ||
                      NON_IDLE_STATES.includes(generationState) ||
                      isLoadingTasks ||
                      !!wordCountError ||
                      isSubmitting ||
                      estimatedTokens.initialStory > userTokenBalance ||
                      hasActiveTasks
                    }
                    className="w-full flex justify-center items-center px-6 py-3 border border-transparent text-base font-medium rounded-xl text-white bg-accent hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out shadow-sm"
                  >
                    {isSubmitting || ['outline', 'queueing', 'generating', 'correctingQueueing', 'correcting', 'comparing'].includes(generationState) ? (
                      <>
                        <Loader className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" />
                        {isSubmitting ? 'Generating Outline...' :
                         generationState === 'outline' ? 'Generating Outline...' :
                         generationState === 'queueing' ? 'Preparing Story...' :
                         generationState === 'generating' ? 'Generating Story...' :
                         generationState === 'correctingQueueing' ? 'Preparing Correction...' :
                         generationState === 'correcting' ? 'Correcting Story...' :
                         generationState === 'comparing' ? 'Comparing Versions...' :
                         'Processing...'}
                      </>
                    ) : (
                      'Generate Story'
                    )}
                  </button>
                  )}

                  {outlineGenerating && (
                    <GenerationStatusBlock
                      lines={[{ icon: Brain, text: 'Generating outline for your story...', animate: 'pulse' }]}
                      descriptions={['Analyzing your story requirements and crafting a detailed chapter structure.', 'The story will begin generating automatically once the outline is ready.']}
                      onStop={handleStop}
                    />
                  )}

                  {(isSubmitting || ['outline', 'queueing'].includes(generationState)) && !outlineGenerating && (
                    <GenerationStatusBlock
                      lines={[
                        { icon: Brain, text: 'Analyzing story requirements...', animate: 'pulse' },
                        { icon: Sparkles, text: 'Crafting chapter structure...', animate: 'pulse' },
                      ]}
                      descriptions={['The story will begin generating automatically once the outline is ready.']}
                      onStop={handleStop}
                    />
                  )}

                  {generationState === 'generating' && progress === 0 && (
                    <GenerationStatusBlock
                      lines={[
                        { icon: Loader, text: 'Generating story batches...', animate: 'spin' },
                        { icon: Loader, text: 'Processing story content...', animate: 'spin' },
                      ]}
                      descriptions={['Your story is being generated in the background. You can safely navigate away.']}
                      onStop={handleStop}
                    />
                  )}

                  {generationState === 'correctingQueueing' && (
                    <GenerationStatusBlock
                      lines={[
                        { icon: Loader, text: 'Preparing story correction...', animate: 'spin' },
                        { icon: Loader, text: 'Initializing correction tasks...', animate: 'spin' },
                      ]}
                      descriptions={['The correction will proceed automatically in the background.']}
                      onStop={handleStop}
                    />
                  )}

                  {generationState === 'correcting' && (
                    <GenerationStatusBlock
                      lines={[{ icon: Loader, text: 'Correcting story...', animate: 'spin' }]}
                      descriptions={['The correction is running in the background. You can safely navigate away.']}
                      onStop={handleStop}
                    />
                  )}

                  {generationState === 'comparing' && (
                    <GenerationStatusBlock
                      lines={[{ icon: Loader, text: 'Comparing story versions...', animate: 'spin' }]}
                      descriptions={['The comparison is running in the background.']}
                      onStop={handleStop}
                    />
                  )}

                  {generationState === 'complete' && (
                    <GenerationStatusBlock
                      lines={[{ icon: CheckCircle2, text: 'Story generation complete. Review or finalize below.', iconClass: 'text-status-success' }]}
                      descriptions={['Choose to generate a corrected version, compare versions, or finalize.']}
                    />
                  )}
                
                  {generationState === 'corrected' && (
                    <GenerationStatusBlock
                      lines={[{ icon: CheckCircle2, text: 'Story correction complete. Review or finalize below.', iconClass: 'text-status-success' }]}
                      descriptions={['Choose to compare versions or finalize.']}
                    />
                  )}
                </div>
              </form>
            </div>

            {(generationState === 'generating' || generationState === 'correcting') && totalBatches > 0 && (
              <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-6 mt-6">
                {isLoadingTasks ? (
                  <div className="flex items-center space-x-3 text-text-secondary">
                    <Loader className="h-5 w-5 text-accent-text animate-spin" />
                    <span>Loading story progress...</span>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex justify-between text-sm text-text-secondary">
                      <span>Progress</span>
                      <span>{`${Math.round(progress)}%`}</span>
                    </div>
                    <div
                      className="w-full bg-border rounded-full h-2 overflow-hidden"
                      role="progressbar"
                      aria-valuenow={Math.round(progress)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label="Story generation progress"
                    >
                      <div
                        className="bg-accent h-2 rounded-full transition-all duration-500"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    {timeRemaining !== null && (
                      <>
                        <p className="text-sm text-text-secondary">
                          Estimated time remaining: {formatTime(timeRemaining)}
                        </p>
                        <p className="text-xs text-text-muted">
                          If you're returning to the page, give it 30 seconds to correctly show the progress.
                        </p>
                        {currentTask && currentTask.check_stuck === true && (
                          <p className="text-sm text-status-warning">
                            This part may take a little longer, but the progress is moving forward.
                          </p>
                        )}
                      </>
                    )}
                    <div className="flex justify-end">
                      <button
                        onClick={handleStop}
                        className="flex items-center px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover transition duration-150 ease-in-out shadow-sm"
                      >
                        <X className="h-5 w-5 mr-2" />
                        Stop
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {outline && showOutlineConfirmation && generationState === 'outline' && (
              <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-6 mt-6">
                <h3 className="text-lg font-medium text-white mb-4">Story Outline</h3>
                <div className="rounded-xl bg-surface-card border border-border-card p-4 mb-4 min-h-0 max-h-[min(600px,60vh)] overflow-y-auto overflow-x-auto">
                  <pre className="text-text-secondary whitespace-pre-wrap">{outline ? String(outline) : 'No outline available'}</pre>
                </div>
                <div className="flex space-x-4">
                  <button
                    onClick={() => handleSubmit({ preventDefault: () => {} } as React.FormEvent)}
                    className="flex items-center px-4 py-2 bg-status-success-muted text-white rounded-xl hover:brightness-110 transition duration-150 ease-in-out shadow-sm"
                  >
                    <Check className="h-5 w-5 mr-2" />
                    Continue
                  </button>
                  <button
                    onClick={handleStop}
                    className="flex items-center px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover transition duration-150 ease-in-out shadow-sm"
                  >
                    <X className="h-5 w-5 mr-2" />
                    Stop
                  </button>
                </div>
              </div>
            )}

            {generatedContent.story && (
              <div className="space-y-6 p-6 mt-6">

                {generationState !== 'correctingQueueing' && generationState !== 'correcting' && (
                  <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card overflow-hidden">
                    <div className="p-4 border-b border-border-card">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center">
                          <FileText className="h-6 w-6 text-accent-text" />
                          <h3 className="ml-3 text-lg font-medium text-white">
                            {generatedContent.storyTitle || 'Generated Story'}
                          </h3>
                        </div>
                        <button
                          onClick={() => downloadStory()}
                          className="flex items-center px-3 py-2 min-h-[44px] bg-surface-tertiary text-text-secondary rounded-xl hover:bg-border transition-colors"
                          title="Download as text (.txt)"
                        >
                          <Download className="h-4 w-4 mr-2" />
                          Download
                        </button>
                      </div>
                    </div>
                    <div className="p-4">
                      <p className="text-sm text-text-muted">
                        {getWordCount(generatedContent.story).toLocaleString()} words
                      </p>
                    </div>
                  </div>
                )}

                {generatedContent.correctedStory && (
                  <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card overflow-hidden">
                    <div className="p-4 border-b border-border-card">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center">
                          <FileText className="h-6 w-6 text-accent-text" />
                          <h3 className="ml-3 text-lg font-medium text-white">
                            {generatedContent.correctedTitle || 'Corrected Story'}
                          </h3>
                        </div>
                        <button
                          onClick={() => downloadStory(true)}
                          className="flex items-center px-3 py-2 min-h-[44px] bg-surface-tertiary text-text-secondary rounded-xl hover:bg-border transition-colors"
                          title="Download as text (.txt)"
                        >
                          <Download className="h-4 w-4 mr-2" />
                          Download
                        </button>
                      </div>
                    </div>
                    <div className="p-4">
                      <p className="text-sm text-text-muted">
                        {getWordCount(generatedContent.correctedStory).toLocaleString()} words
                      </p>
                    </div>
                  </div>
                )}

                {areTasksComplete && generationState !== 'comparing' && generationState !== 'correctingQueueing' && generationState !== 'correcting' && (!generatedContent.correctedStory || generatedContent.comparison.doc1Review) && (
                  <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-4">
                    <h3 className="text-lg font-medium text-white mb-2">Story Generated</h3>
                    <p className="text-text-secondary mb-4">
                      Your story "{generatedContent.storyTitle}" is {storyError ? 'partially ' : ''}ready!
                      {generatedContent.correctedStory
                        ? generatedContent.comparison.doc1Review
                          ? ' Comparison complete. Review below or finalize.'
                          : ' A corrected version is available. Would you like to compare versions or finalize?'
                        : ' Would you like to generate a corrected version or finalize?'}
                    </p>
                  
                    {!generatedContent.correctedStory && (
                      <div className="mt-4">
                        <p className="text-sm font-medium text-text-secondary mb-2">Estimated Token Usage</p>
                        <ul className="text-sm text-text-muted space-y-1">
                          <li>Corrected Story: {formatNumber(estimatedTokens.correctedStory)} tokens</li>
                        </ul>
                        {estimatedTokens.correctedStory > userTokenBalance && (
                          <div className="bg-status-warning text-status-warning-text p-4 rounded-xl mt-2">
                            <div className="flex items-center space-x-2 text-status-warning mb-2">
                              <AlertCircle className="h-5 w-5" />
                              <h3 className="text-lg font-medium">Warning</h3>
                            </div>
                            <p>
                              The estimated token usage for the Corrected Story ({formatNumber(estimatedTokens.correctedStory)} tokens) exceeds your remaining balance of {formatNumber(userTokenBalance)} tokens. Please upgrade your plan to proceed.
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  
                    <div className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:space-x-4 mt-4">
                      {!generatedContent.correctedStory && (
                        <button
                          onClick={handleCorrection}
                          disabled={estimatedTokens.correctedStory > userTokenBalance}
                          className="w-full sm:flex-1 flex justify-center items-center py-3 px-6 bg-status-success-muted text-white rounded-xl hover:brightness-110 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <RefreshCw className="h-5 w-5 mr-2" />
                          Generate Corrected Version
                        </button>
                      )}
                      {generatedContent.correctedStory && !generatedContent.comparison.doc1Review && (
                        <button
                          onClick={() => handleComparison(true)}
                          disabled={estimatedTokens.comparison > userTokenBalance}
                          className="w-full sm:flex-1 flex justify-center items-center py-3 px-6 bg-status-info-muted text-white rounded-xl hover:brightness-110 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <BookOpen className="h-5 w-5 mr-2" />
                          Compare Versions
                        </button>
                      )}
                      <button
                        onClick={handleDone}
                        className="w-full sm:flex-1 flex justify-center items-center py-3 px-6 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors"
                      >
                        <Check className="h-5 w-5 mr-2" />
                        I'm Done
                      </button>
                    </div>
                    {storyError && (
                      <div className="mt-4 bg-status-warning text-status-warning-text p-4 rounded-xl">
                        <div className="flex items-center space-x-2 text-status-warning mb-2">
                          <AlertCircle className="h-5 w-5" />
                          <h3 className="text-lg font-medium">Warning</h3>
                        </div>
                        <p>{storyError}</p>
                      </div>
                    )}
                  </div>
                )}

                {areTasksComplete && generationState !== 'comparing' && generatedContent.correctedStory && !generatedContent.comparison.doc1Review && (
                  <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-4">
                    <h3 className="text-lg font-medium text-white mb-2">Corrected Story Ready</h3>
                    <p className="text-text-secondary mb-4">
                      Your corrected story "{generatedContent.correctedTitle}" is {storyError ? 'partially ' : ''}ready!
                      Would you like to compare with the original version or finalize?
                    </p>
                  
                    {areTasksComplete && generatedContent.correctedStory && (
                      <div className="mt-4">
                        <p className="text-sm font-medium text-text-secondary mb-2">Estimated Token Usage</p>
                        <ul className="text-sm text-text-muted space-y-1">
                          <li>Comparison: {formatNumber(estimatedTokens.comparison)} tokens</li>
                        </ul>
                        {estimatedTokens.comparison > userTokenBalance && (
                          <div className="bg-status-warning text-status-warning-text p-4 rounded-xl mt-2">
                            <div className="flex items-center space-x-2 text-status-warning mb-2">
                              <AlertCircle className="h-5 w-5" />
                              <h3 className="text-lg font-medium">Warning</h3>
                            </div>
                            <p>
                              The estimated token usage for Comparison ({formatNumber(estimatedTokens.comparison)} tokens) exceeds your remaining balance of {formatNumber(userTokenBalance)} tokens. Please upgrade your plan to proceed.
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  
                    <div className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:space-x-4 mt-4">
                      <button
                        onClick={() => handleComparison(true)}
                        disabled={estimatedTokens.comparison > userTokenBalance}
                        className="w-full sm:flex-1 flex justify-center items-center py-3 px-6 bg-status-info-muted text-white rounded-xl hover:brightness-110 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <BookOpen className="h-5 w-5 mr-2" />
                        Compare Versions
                      </button>
                      <button
                        onClick={handleDone}
                        className="w-full sm:flex-1 flex justify-center items-center py-3 px-6 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors"
                      >
                        <Check className="h-5 w-5 mr-2" />
                        I'm Done
                      </button>
                    </div>
                    {storyError && (
                      <div className="mt-4 bg-status-warning text-status-warning-text p-4 rounded-xl">
                        <div className="flex items-center space-x-2 text-status-warning mb-2">
                          <AlertCircle className="h-5 w-5" />
                          <h3 className="text-lg font-medium">Warning</h3>
                        </div>
                        <p>{storyError}</p>
                      </div>
                    )}
                  </div>
                )}

                {areTasksComplete && generationState !== 'comparing' && generatedContent.comparison.doc1Review && (
                  <div className="space-y-6">
                    <h3 className="text-lg font-medium text-white">Story Comparison</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <EvaluationSection
                        review={{
                          ...generatedContent.comparison.doc1Review,
                          rating: generatedContent.comparison.doc1Rating,
                          wordCount: generatedContent.comparison.doc1WordCount,
                        }}
                        label={doc1Label}
                      />
                      <EvaluationSection
                        review={{
                          ...generatedContent.comparison.doc2Review,
                          rating: generatedContent.comparison.doc2Rating,
                          wordCount: generatedContent.comparison.doc2WordCount,
                        }}
                        label={doc2Label}
                      />
                    </div>
                    <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-4">
                      <h4 className="text-sm font-medium text-text-secondary mb-2">Summary</h4>
                      <p className="text-text-secondary">{generatedContent.comparison.summary}</p>
                    </div>
                    <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-4 mt-4">
                      <h4 className="text-sm font-medium text-text-secondary mb-2">Token Usage Summary</h4>
                      <ul className="text-text-secondary text-sm space-y-1">
                        <li>Initial Story: {formatNumber(usedTokens.initialStory)} tokens</li>
                        <li>Corrected Story: {formatNumber(usedTokens.correctedStory)} tokens</li>
                        <li>Comparison: {formatNumber(usedTokens.comparison)} tokens</li>
                        <li><strong>Total: {formatNumber(usedTokens.initialStory + usedTokens.correctedStory + usedTokens.comparison)} tokens</strong></li>
                      </ul>
                    </div>
                    <div className="flex justify-end">
                      <button
                        onClick={handleDone}
                        className="flex items-center px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors shadow-sm"
                      >
                        <Check className="h-5 w-5 mr-2" />
                        I'm Done
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </ErrorBoundary>
      </div>
    </DashboardLayout>
  );
});

Generator.displayName = 'Generator';

export default Generator;




