import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, X, AlertCircle, CheckCircle2, Calendar, ChevronDown, Download, Image, Folder, BookOpen, Lock } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import { Listbox, Transition } from '@headlessui/react';
import DashboardLayout from '../components/DashboardLayout';
import RedoFeedbackModal from '../components/RedoFeedbackModal';
import StatusBanner from '../components/StatusBanner';
import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { Link } from 'react-router-dom';
import { PromptModeSelector, NewImagePromptsForm, CombinedProgressDisplay } from '../components/ImageGeneratorComponents';
import { DocumentSelector } from '../components/FileUploadComponents';
import ImageFrequencyConfiguration from '../components/ImageFrequencyConfiguration';
import TabManager from '../components/TabManager';
import ImageModelSelector from '../components/ImageModelSelector';
import { useTabSessionStorage } from '../hooks/useTabSessionStorage';
import { 
  saveImageGeneratorTabInputs, 
  getImageGeneratorTabInputs, 
  resetImageGeneratorTabToDefaults,
  createTab,
  updateTabStatus,
  updateTabGroupAndDoc,
  saveImageTabFormInputs,
  deleteTabFromDB
} from '../utils/tabManager';
import { 
  calculateEstimatedImageCountFromWordCount,
  calculateEstimatedImageCountConsistent,
  estimateTotalTokensAudioBased,
  estimateTokens
} from '../utils/imagePromptsGenerator';
import { getStorageLimitGB } from '../utils/storageHelpers';
import { fetchWithFallback } from '../utils/fetchWithFallback';
import { useIsLegacyPlan } from '../hooks/useIsLegacyPlan';
import { getPlanMaxTokens } from '../data/planMaxTokens';
import { LEGACY_LLM_MULTIPLIERS, NEW_LLM_MULTIPLIERS, LEGACY_IMAGE_TOKENS_PER_IMAGE, NEW_IMAGE_TOKENS_PER_IMAGE } from '../data/tokenCosts';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

interface StoryDocument {
  id: string;
  title: string;
  description?: string;
  is_corrected: boolean;
  is_prompted?: boolean;
  version?: number;
  group_id?: string;
  created_at: string;
  file_path: string;
  word_count?: number;
  image_model?: string;
  file_size?: number;
}

interface AnalysisResult {
  totalImages: number;
  estimatedTokens: number;
}

interface ImageTask {
  id: string;
  user_id: string;
  story_title: string;
  batch: any[];
  text_part: string;
  total_batches: number;
  batch_number: number;
  progress?: number;
  error?: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'completed_final' | 'error';
  group_id: string;
  doc_id?: string;
  file_path: string;
  updated_at?: string;
  batch_output?: string;
  single_image: boolean;
  video_process?: boolean;
  itv?: boolean;
  check_stuck?: boolean;
  redo_status?: string | null;
  redo_started_at?: string | null;
}

interface ImagePromptTask {
  id: string;
  user_id: string;
  story_title: string;
  batch: any[];
  text_part: string;
  total_batches: number;
  batch_number: number;
  progress?: number;
  error?: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'completed_final' | 'error';
  settings: any;
  group_id: string;
  variant: number;
  doc_id?: string;
  file_path: string;
  input_tokens?: number;
  output_tokens?: number;
  updated_at?: string;
  token_updated?: boolean;
  video_process?: boolean;
  itv?: boolean;
  check_stuck?: boolean;
  process_image?: boolean;
  total_prompts?: number;
}

interface AudioFile {
  path: string;
  name: string;
  duration: number;
  url?: string;
}

interface NewPromptsSettings {
  style: string;
  useCharacterDescriptions: boolean;
  customCharactersEnabled: boolean;
  customCharacters: Array<{ name: string; description: string }>;
  customCharactersAIEnhance: boolean;
  firstPageFrequency: string;
  restFrequency: string;
  imageModel: 'standard' | 'plus' | 'premium' | 'grok' | 'prime' | 'genesis';
  language: string;
  model: string;
  frequencyMode?: 'wordcount' | 'audio';
  frequencyType?: 'consistent' | 'variable';
  consistentFrequency?: string;
  audioFiles?: AudioFile[];
  totalAudioDuration?: number;
  imageAmount?: string;
  audioDistributionType?: 'consistent' | 'variable';
  audioFirstPageImageCount?: string;
  audioRestImageCount?: string;
}

interface ValidationErrors {
  firstPageFrequency?: string;
  restFrequency?: string;
}

interface CombinedEstimate {
  totalImages: number;
  promptTokens: number;
  imageTokens: number;
  totalTokens: number;
  storageNeeded: number;
}

interface BatchStatus {
  batchNumber: number;
  status: string;
  progress: number;
}

const OPERATION_TIMEOUT = 3600000;
const POLLING_INTERVAL = 5000;
const SUBSCRIPTION_CHECK_INTERVAL = 60000;
const TASK_STALL_TIMEOUT = 1800000;

const planMaxTokens: Record<string, number> = {
  // Kept for legacy display fallbacks; always prefer getPlanMaxTokens(plan, isLegacy).
  free: 400000,
  standard: 4000000,
  plus: 6000000,
  premium: 10000000,
  pro: 25000000,
  elite: 50000000,
  ultimate: 75000000,
  enterprise: 250000000,
};

const IMAGE_SIZE_MB = 1;

// Constants for file upload
const MAX_WORD_COUNT = 70000;
const MAX_FILE_SIZE_MB = 1;

const LANGUAGE_OPTIONS = [
  { value: 'english', label: 'English' },
  { value: 'german', label: 'German' },
  { value: 'spanish', label: 'Spanish' },
  { value: 'french', label: 'French' },
];

// Per-model LLM multipliers come from the active plan map. Module-scope
// default mirrors LEGACY; in-component code shadows this via useMemo.
function buildModelOptions(isLegacy: boolean) {
  const m = isLegacy ? LEGACY_LLM_MULTIPLIERS : NEW_LLM_MULTIPLIERS;
  return [
    { value: 'deepseek', label: 'Core Model',        tokenMultiplier: m.deepseek, description: `${m.deepseek}x tokens` },
    { value: 'sonnet',   label: 'Claude Sonnet 4.6', tokenMultiplier: m.sonnet,   description: `${m.sonnet}x tokens` },
    { value: 'opus',     label: 'Claude Opus 4.6',   tokenMultiplier: m.opus,     description: `${m.opus}x tokens` },
  ];
}
const modelOptions = buildModelOptions(true);

// Image model display options. The per-image `tokens` value comes from the
// active plan (legacy vs new); display metadata is plan-independent.
const IMAGE_MODEL_DISPLAY: Array<{
  value: string;
  label: string;
  description: string;
  recommended?: boolean;
  borderColor: string;
  bgColor: string;
  textColor: string;
}> = [
  { value: 'imagen-4-fast',     label: 'Lite',    description: 'Cheapest option',  borderColor: 'border-blue-500',   bgColor: 'bg-blue-900/20',   textColor: 'text-blue-300' },
  { value: 'grok-imagine-image',label: 'Grok',    description: 'Fast & affordable',borderColor: 'border-orange-500', bgColor: 'bg-orange-900/20', textColor: 'text-orange-300' },
  { value: 'gpt-image-1-mini',  label: 'Core',    description: 'Better quality',   borderColor: 'border-green-500',  bgColor: 'bg-green-900/20',  textColor: 'text-green-300' },
  { value: 'seedream-4.5',      label: 'Prime',   description: 'High quality',     recommended: true, borderColor: 'border-teal-500', bgColor: 'bg-teal-900/20', textColor: 'text-teal-300' },
  { value: 'imagen-4-ultra',    label: 'Heavy',   description: 'Highest quality',  borderColor: 'border-purple-500', bgColor: 'bg-purple-900/20', textColor: 'text-purple-300' },
  { value: 'nano-banana-pro',   label: 'Genesis', description: 'Premium quality',  borderColor: 'border-yellow-500', bgColor: 'bg-yellow-900/20', textColor: 'text-yellow-300' },
];

function buildImageModelOptions(isLegacy: boolean) {
  const map = isLegacy ? LEGACY_IMAGE_TOKENS_PER_IMAGE : NEW_IMAGE_TOKENS_PER_IMAGE;
  return IMAGE_MODEL_DISPLAY.map(o => ({ ...o, tokens: map[o.value] ?? 30000 }));
}
const IMAGE_MODEL_OPTIONS = buildImageModelOptions(true);

type ImageModel = 'imagen-4-fast' | 'gpt-image-1-mini' | 'imagen-4-ultra' | 'flux-2-dev' | 'grok-imagine-image' | 'seedream-4.5' | 'nano-banana-pro';

// Helper function to get tokens for a model. Resolves against whichever
// IMAGE_MODEL_OPTIONS is in scope (the in-component shadow is plan-aware).
const getTokensForModel = (model: ImageModel, options: typeof IMAGE_MODEL_OPTIONS = IMAGE_MODEL_OPTIONS): number => {
  const modelConfig = options.find(option => option.value === model);
  return modelConfig?.tokens || 30000;
};

// Helper function to get time per image in seconds based on model
const getTimePerImageInSeconds = (model: string): number => {
  // All models including flux-2-dev take ~30 seconds per image
  return 30;
};

const checkNetworkStatus = (): boolean => navigator.onLine;

const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Operation "${operation}" timed out after ${timeoutMs / 1000} seconds`)), timeoutMs)),
  ]);
};

const withRetry = async <T,>(operation: () => Promise<T>, operationName: string, maxRetries: number = 10): Promise<T> => {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      if (error.message.includes('Failed to fetch') || error.status === 500 || error.message.includes('timeout') || error.message.includes('429') || error.message.includes('503')) {
        const delay = 2000 * Math.pow(1.5, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error(`Failed to complete ${operationName} after ${maxRetries} attempts: ${lastError.message}`);
};

const isTaskStalled = (task: ImageTask | ImagePromptTask): boolean => {
  if (!task.updated_at) return false;
  const lastUpdate = new Date(task.updated_at).getTime();
  return Date.now() - lastUpdate > TASK_STALL_TIMEOUT;
};

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

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

const calculateWordCount = (content: string): number => {
  return content.trim().split(/\s+/).filter(word => word.length > 0).length;
};

// Calculate estimated image count based on frequency settings
const calculateEstimatedImageCount = (wordCount: number, settings: NewPromptsSettings): number => {
  if (!wordCount || wordCount <= 0) return 0;
  
  if (settings.frequencyMode === 'audio') {
    return parseInt(settings.imageAmount || '1') || 1;
  }
  
  if (settings.frequencyType === 'consistent') {
    const consistentFreq = parseFloat(settings.consistentFrequency || '10');
    // Use imported function from imagePromptsGenerator
    return calculateEstimatedImageCountConsistent(wordCount, consistentFreq);
  } else {
    // Variable frequency
    const firstPageFreq = parseFloat(settings.firstPageFrequency);
    const restFreq = parseFloat(settings.restFrequency);
    // Use imported function from imagePromptsGenerator
    return calculateEstimatedImageCountFromWordCount(wordCount, firstPageFreq, restFreq);
  }
};

// Calculate estimated token cost for image generation. Branches LEGACY vs NEW
// based on the active plan; tier-name aliases map to canonical backend ids.
const TIER_TO_BACKEND_IMAGE_GEN: Record<string, string> = {
  spark: 'flux-2-dev',
  standard: 'imagen-4-fast',
  grok: 'grok-imagine-image',
  plus: 'gpt-image-1-mini',
  prime: 'seedream-4.5',
  premium: 'imagen-4-ultra',
  genesis: 'nano-banana-pro',
};
const calculateEstimatedImageTokens = (
  imageCount: number,
  imageModel: string,
  isLegacy: boolean = true,
): number => {
  if (imageCount <= 0) return 0;
  const map = isLegacy ? LEGACY_IMAGE_TOKENS_PER_IMAGE : NEW_IMAGE_TOKENS_PER_IMAGE;
  const canonical = TIER_TO_BACKEND_IMAGE_GEN[imageModel] ?? imageModel;
  return imageCount * (map[canonical] ?? 30000);
};

// Map frontend model values to backend values (includes identity mappings for backend values)
const getBackendImageModel = (frontendModel: string): string => {
  const modelMap: Record<string, string> = {
    'standard': 'imagen-4-fast', 'imagen-4-fast': 'imagen-4-fast',
    'grok': 'grok-imagine-image', 'grok-imagine-image': 'grok-imagine-image',
    'plus': 'gpt-image-1-mini', 'gpt-image-1-mini': 'gpt-image-1-mini',
    'premium': 'imagen-4-ultra', 'imagen-4-ultra': 'imagen-4-ultra',
    'spark': 'flux-2-dev', 'flux-2-dev': 'flux-2-dev',
    'prime': 'seedream-4.5', 'seedream-4.5': 'seedream-4.5',
    'genesis': 'nano-banana-pro', 'nano-banana-pro': 'nano-banana-pro',
  };
  return modelMap[frontendModel] || 'gpt-image-1-mini';
};

// Get word count from various sources
const getWordCountFromSettings = (documents: StoryDocument[], uploadedDoc: File | null, selectedDoc: string): number => {
  // From selected document
  if (selectedDoc) {
    const doc = documents.find(d => d.id === selectedDoc);
    if (doc && doc.word_count) return doc.word_count;
  }
  
  // From uploaded file (assuming it's been processed and added to documents)
  if (uploadedDoc && uploadedDoc.name) {
    const uploadedDocName = uploadedDoc.name.replace(/\.txt$/, '');
    const doc = documents.find(d => d.title === uploadedDocName);
    if (doc && doc.word_count) return doc.word_count;
  }
  
  return 0;
};

const numberToOrdinal = (n: number): string => {
  const ordinals = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];
  return n <= 10 ? ordinals[n - 1] : `${n}th`;
};

// File upload validation function
const validateFileName = (fileName: string): string | null => {
  const validFileNameRegex = /^[a-zA-Z0-9\s\-_.]+$/;
  if (!validFileNameRegex.test(fileName)) {
    const invalidChars = fileName
      .split('')
      .filter(char => !/[a-zA-Z0-9\s\-_.]/.test(char))
      .join(', ');
    return `File name contains invalid characters: ${invalidChars}. Only alphanumeric characters, spaces, hyphens, underscores, and dots are allowed.`;
  }
  return null;
};

// Model selector component
const ModelSelector = ({ selectedModel, onModelChange, disabled, type }: {
  selectedModel: ImageModel;
  onModelChange: (model: ImageModel) => void;
  disabled: boolean;
  type: string;
}) => (
  <div className="mb-4">
    <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3">
      Image Quality Model
    </label>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {IMAGE_MODEL_OPTIONS.map((option) => (
        <button
          key={option.value}
          onClick={() => onModelChange(option.value as ImageModel)}
          className={`relative p-3 rounded-xl border transition-all duration-200 text-left ${
            selectedModel === option.value
              ? `${option.borderColor} ${option.bgColor} ${option.textColor}`
              : 'border-white/10 bg-surface-input text-text-muted hover:border-white/20 hover:text-white/80'
          }`}
          disabled={disabled}
        >
          {option.recommended && (
            <div className="absolute -top-2 -right-2 bg-accent text-white text-[10px] font-mono tracking-wide px-2 py-0.5 rounded-full">
              Recommended
            </div>
          )}
          <div className="font-medium text-sm">
            {option.label}
          </div>
          <div className="text-xs opacity-75 mt-0.5">{option.tokens.toLocaleString()} tokens / image</div>
          <div className="text-xs opacity-60 mt-0.5">{option.description}</div>
        </button>
      ))}
    </div>
  </div>
);

function formatTime(seconds: number) {
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  } else {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
}

// Export ImageGeneratorRef interface for container
export interface ImageGeneratorRef {
  cleanup: () => Promise<void>;
}

// Props interface for ImageGenerator when used in multi-tab container
interface ImageGeneratorProps {
  initialTab?: number;
  initialGroupId?: string;
  isEnterpriseUser?: boolean;
  initialTabs?: import('../utils/tabManager').TabInfo[];
  onTabChange?: (tab: number, groupId: string) => void;
  onTabCreate?: (tab: number, groupId: string) => void;
  onTabClose?: (tab: number, groupId: string) => void;
}

const ImageGenerator = forwardRef<ImageGeneratorRef, ImageGeneratorProps>(({
  initialTab = 1,
  initialGroupId = '',
  isEnterpriseUser = false,
  initialTabs,
  onTabChange,
  onTabCreate,
  onTabClose
}, ref) => {
  const navigate = useNavigate();
  // Plan-aware model option arrays. Shadowing the module-scope defaults keeps
  // every existing in-component reference (display labels, token estimators)
  // aligned with what the backend will actually charge under the user's plan.
  const { isLegacy } = useIsLegacyPlan();
  const modelOptions = React.useMemo(() => buildModelOptions(isLegacy), [isLegacy]);
  const IMAGE_MODEL_OPTIONS = React.useMemo(() => buildImageModelOptions(isLegacy), [isLegacy]);
  const [documents, setDocuments] = useState<StoryDocument[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [generationState, setGenerationState] = useState<'idle' | 'analyzing' | 'analyzed' | 'generating' | 'complete' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const [generatedFileName, setGeneratedFileName] = useState<string>('');
  const [generatedDocTitle, setGeneratedDocTitle] = useState<string>('');
  const [generatedGroupId, setGeneratedGroupId] = useState<string | null>(null);
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(initialGroupId || null);
  const [batchStatuses, setBatchStatuses] = useState<BatchStatus[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [userTokenBalance, setUserTokenBalance] = useState(400000);
  const [userPlan, setUserPlan] = useState<string>('free');
  const [planLoaded, setPlanLoaded] = useState(false);
  const [networkRetrying, setNetworkRetrying] = useState<boolean>(false);
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [redoingImage, setRedoingImage] = useState<number | null>(null);
  const [redoModalIndex, setRedoModalIndex] = useState<number | null>(null);
  const [isInitializingTasks, setIsInitializingTasks] = useState<boolean>(false);
  const [imageTasks, setImageTasks] = useState<ImageTask[]>([]);
  const [isDownloadingZip, setIsDownloadingZip] = useState<boolean>(false);
  const [singleImagePrompt, setSingleImagePrompt] = useState<string>('');
  const [singleImageState, setSingleImageState] = useState<'idle' | 'generating' | 'complete' | 'error'>('idle');
  const [singleImageUrl, setSingleImageUrl] = useState<string | null>(null);
  const [singleImageError, setSingleImageError] = useState<string | null>(null);
  const [singleImageGroupId, setSingleImageGroupId] = useTabSessionStorage<string | null>('singleImageGroupId', null, initialTab);
  const [storageUsed, setStorageUsed] = useState<number | null>(null);
  const [settings, setSettings] = useState<any>(null);
  
  // Calculate max storage based on user plan
  const maxStorageGB = getStorageLimitGB(userPlan);
  
  // Updated model selection state with all 6 models
  const [selectedDocumentModel, setSelectedDocumentModel] = useState<ImageModel>('seedream-4.5');
  const [selectedSingleImageModel, setSelectedSingleImageModel] = useState<ImageModel>('seedream-4.5');
  const [selectedSingleImageStyle, setSelectedSingleImageStyle] = useState<string>(`A painterly, hand-drawn animation style in the tradition of classic Japanese feature animation, evoking the visual sensibility of landmark studios such as Studio Ghibli. Wide format with gentle, organic linework and subtle textures that mimic traditional cel animation. The palette is lush and nature-inspired—rich greens, soft pastels, golden sunlight, and warm earth tones—evoking emotional warmth and whimsical realism. Characters are expressive with large, emotive eyes and understated facial details. Backgrounds are intricately detailed yet softly rendered, often featuring idyllic countryside, cozy interiors, or magical environments with a nostalgic glow. Lighting is natural and dynamic, shifting gently across scenes to mirror time and mood. The overall aesthetic is warm, soulful, and immersive, blending everyday simplicity with quiet enchantment.`);

  // Add loading states for images to prevent layout shift
  const [imageLoadingStates, setImageLoadingStates] = useState<boolean[]>([]);

  // NEW STATE FOR COMBINED WORKFLOW
  const [selectedMode, setSelectedMode] = useState<'existing' | 'new' | 'individual'>('new');
  const [newPromptsDoc, setNewPromptsDoc] = useState<string>('');
  const [newPromptsSettings, setNewPromptsSettings] = useState<NewPromptsSettings>({
    style: `A painterly, hand-drawn animation style in the tradition of classic Japanese feature animation, evoking the visual sensibility of landmark studios such as Studio Ghibli. Wide format with gentle, organic linework and subtle textures that mimic traditional cel animation. The palette is lush and nature-inspired—rich greens, soft pastels, golden sunlight, and warm earth tones—evoking emotional warmth and whimsical realism. Characters are expressive with large, emotive eyes and understated facial details. Backgrounds are intricately detailed yet softly rendered, often featuring idyllic countryside, cozy interiors, or magical environments with a nostalgic glow. Lighting is natural and dynamic, shifting gently across scenes to mirror time and mood. The overall aesthetic is warm, soulful, and immersive, blending everyday simplicity with quiet enchantment.`,
    useCharacterDescriptions: true,
    customCharactersEnabled: false,
    customCharacters: [{ name: '', description: '' }],
    customCharactersAIEnhance: false,
    firstPageFrequency: '10',
    restFrequency: '30',
    imageModel: 'prime',
    language: 'english',
    model: 'sonnet',
    frequencyMode: 'wordcount',
    frequencyType: 'consistent',
    consistentFrequency: '',
    audioFiles: [],
    totalAudioDuration: 0,
    imageAmount: '',
    audioDistributionType: 'consistent',
    audioFirstPageImageCount: '',
    audioRestImageCount: '',
  });
  const [newPromptsValidationErrors, setNewPromptsValidationErrors] = useState<ValidationErrors>({});
  const [combinedEstimate, setCombinedEstimate] = useState<CombinedEstimate | null>(null);
  const [currentPhase, setCurrentPhase] = useState<'prompts' | 'images' | 'complete'>('prompts');
  const [imagePromptProgress, setImagePromptProgress] = useState(0);
  const [imageGenerationProgress, setImageGenerationProgress] = useState(0);
  const [combinedGroupId, setCombinedGroupId] = useState<string | null>(null);
  const [imagePromptTasks, setImagePromptTasks] = useState<ImagePromptTask[]>([]);

  // NEW FILE UPLOAD STATE
  const [uploadedDoc, setUploadedDoc] = useState<File | null>(null);
  const [uploadingFile, setUploadingFile] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Tab support - use initialTab from props
  const [currentTab] = useState<number>(initialTab);
  const [currentVariant, setCurrentVariant] = useState<number | null>(null);
  const [isDeletingImages, setIsDeletingImages] = useState<boolean>(false);

  const lastUpdateRef = useRef<number>(Date.now());
  const lastSubscriptionUpdateRef = useRef<number>(Date.now());
  const totalBatchesRef = useRef<number>(0);
  const generationStartTime = useRef<number | null>(null);

  // Helper function to sanitize title (matches edge function pattern)
  const sanitizeTitle = (title: string) => {
    return title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
  };

  // Helper function to get word count for estimation
  const getWordCountForEstimation = (): number => {
    if (newPromptsDoc) {
      const doc = documents.find(d => d.id === newPromptsDoc);
      return doc?.word_count || 0;
    }
    
    if (uploadedDoc && uploadedDoc.name) {
      const uploadedDocName = uploadedDoc.name.replace(/\.txt$/, '');
      const doc = documents.find(d => d.title === uploadedDocName);
      return doc?.word_count || 0;
    }
    
    return 0;
  };

  // File upload handler
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Clear previous selections
    setNewPromptsDoc('');
    setCombinedEstimate(null);
    setUploadError(null);
    
    // Validation
    if (file.type !== 'text/plain' && !file.name.endsWith('.txt')) {
      setUploadError('Please upload a valid .txt file');
      return;
    }

    if (!file.name) {
      setUploadError('File name is missing');
      return;
    }

    // File name validation
    const fileNameError = validateFileName(file.name);
    if (fileNameError) {
      setUploadError(fileNameError);
      return;
    }

    // File size validation
    const maxFileSizeBytes = MAX_FILE_SIZE_MB * 1024 * 1024;
    if (file.size > maxFileSizeBytes) {
      setUploadError(`File size exceeds limit. Maximum allowed: ${Math.round(maxFileSizeBytes / 1024)} KB`);
      return;
    }

    if (!currentUserId) {
      setUploadError('Authentication error');
      return;
    }

    setUploadingFile(true);
    
    try {
      // Read and validate file content
      const fileContent = await file.text();
      const wordCount = calculateWordCount(fileContent);
      
      if (wordCount > MAX_WORD_COUNT) {
        throw new Error(`File exceeds the maximum word count limit of ${MAX_WORD_COUNT} words. Your file has ${wordCount} words.`);
      }

      // Upload logic
      const uniqueGroupId = uuidv4();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `${file.name.replace(/\s+/g, '-')}_${timestamp}.txt`;
      const filePath = `documents/${currentUserId}/${uniqueGroupId}/${fileName}`;

      // Upload to Supabase storage
      const { error: uploadError } = await supabase.storage
        .from('stories')
        .upload(filePath, file, {
          contentType: 'text/plain',
          upsert: true,
        });

      if (uploadError) {
        throw new Error(`Failed to upload file: ${uploadError.message}`);
      }

      // Insert document metadata
      const { data, error: insertError } = await supabase
        .from('story_documents')
        .insert({
          id: uuidv4(),
          user_id: currentUserId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          file_path: filePath,
          title: file.name.replace(/\.txt$/, ''),
          description: 'Uploaded document for combined image generation',
          word_count: wordCount,
          version: 1,
          is_corrected: false,
          is_prompted: false,
          group_id: uniqueGroupId,
          variant: 1,
          file_size: file.size,
        })
        .select()
        .single();

      if (insertError) {
        // Cleanup: remove uploaded file if metadata insertion fails
        await supabase.storage.from('stories').remove([filePath]);
        throw new Error(`Failed to save document metadata: ${insertError.message}`);
      }

      // Update state
      setUploadedDoc(file);
      setNewPromptsDoc('');

      // Refresh documents list
      const { data: updatedDocs, error: fetchError } = await supabase
        .from('story_documents')
        .select('*')
        .eq('user_id', currentUserId)
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;
      setDocuments(updatedDocs || []);

      // Update storage usage
      const totalSize = (updatedDocs || []).reduce((sum, doc) => sum + (doc.file_size || (doc.word_count ? doc.word_count * 1.5 : 0)), 0);
      const totalSizeMB = totalSize / (1024 * 1024);
      const formattedSize = totalSizeMB > 0 && totalSizeMB < 0.05 ? 0.1 : Number(totalSizeMB.toFixed(totalSizeMB < 1 ? 1 : 2));
      setStorageUsed(formattedSize);
    } catch (err: any) {
      setUploadError(err.message || 'Failed to upload file');
    } finally {
      setUploadingFile(false);
    }
  };

  // Helper function to validate file name
  const validateFileName = (fileName: string): string | null => {
    // Define allowed characters: alphanumeric, spaces, hyphens, underscores, and dots
    const validFileNameRegex = /^[a-zA-Z0-9\s\-_.]+$/;
    // Check for invalid characters
    if (!validFileNameRegex.test(fileName)) {
      // Identify specific invalid characters for a more informative message
      const invalidChars = fileName
        .split('')
        .filter(char => !/[a-zA-Z0-9\s\-_.]/.test(char))
        .join(', ');
      return `File name contains invalid characters: ${invalidChars}. Only alphanumeric characters, spaces, hyphens, underscores, and dots are allowed.`;
    }
    return null;
  };

  const fetchTasksForPolling = async (forcedGroupId?: string) => {
    // Hoisted so the catch block can reference it for the
    // singleImageGroupId === groupId branch even if the try throws early.
    let groupId: string | null | undefined;
    try {
      if (!checkNetworkStatus()) {
        setNetworkRetrying(true);
        setStatusMessage('Waiting for network connection...');
        return;
      }
      
      // Handle combined workflow
      if (selectedMode === 'new' && combinedGroupId) {
        await fetchCombinedTasks();
        return;
      }
      
      groupId = forcedGroupId || currentGroupId || singleImageGroupId;
      if (!groupId || !currentUserId) return;

      let query = supabase
        .from('image_tasks')
        .select('id,story_title,total_batches,batch_number,progress,error,status,group_id,updated_at,batch_output,single_image,video_process,itv,check_stuck,redo_status,redo_started_at,image_model,variant,folder_timestamp')
        .eq('user_id', currentUserId)
        .eq('group_id', groupId)
        .eq('tab', currentTab)
        .or('video_process.is.null,video_process.eq.false')
        .or('itv.is.null,itv.eq.false')
        .order('batch_number', { ascending: true });

      // Add variant filter if we have a current variant
      if (currentVariant !== null) {
        query = query.eq('variant', currentVariant);
      }

      const { data: tasks, error } = await withRetry(
        () => withTimeout(
          query,
          OPERATION_TIMEOUT,
          'fetchTasks'
        ),
        'fetchTasks'
      );
      if (error) throw new Error(`Failed to fetch tasks: ${error.message}`);

      if (!tasks || tasks.length === 0) {
        // Silently return and continue polling - don't throw errors
        return;
      }

      setImageTasks(tasks);
      
      // Check if video processing is complete for all tasks with the current group_id FIRST
      const allVideoProcessed = tasks.every(t => t.video_process === true) || tasks.every(t => t.itv === true);
      if (allVideoProcessed) {
        // Video processing is complete, stop showing progress and reset to idle
        console.log('All tasks have video_process or itv set to true, resetting to idle state');
        setProgress(0);
        setTimeRemaining(null);
        setStatusMessage('');
        setGenerationState('idle');
        setBatchStatuses([]);
        if (singleImageGroupId === groupId) {
          setSingleImageState('idle');
        }
        return; // Exit early to stop polling
      }
      
      const singleImageTask = tasks.find(t => t.single_image);
      if (singleImageTask && (singleImageGroupId === groupId || forcedGroupId === groupId)) {
        if (singleImageTask.status === 'completed_final') {
          setSingleImageState('complete');
          setProgress(100);
          setStatusMessage('Single image generation complete!');
          if (singleImageTask.batch_output) {
            const imagePath = singleImageTask.batch_output.match(/https:\/\/[^\s]+/)?.[0];
            if (imagePath) {
              const { data, error } = await withRetry(
                () => withTimeout(
                  supabase.storage
                    .from('stories')
                    .createSignedUrl(imagePath.replace(`${import.meta.env.SUPABASE_URL}/storage/v1/object/public/stories/`, ''), 60),
                  OPERATION_TIMEOUT,
                  'createSignedUrl_single_image'
                ),
                'createSignedUrl_single_image'
              );
              if (!error && data) {
                setSingleImageUrl(data.signedUrl);
              } else {
                setSingleImageError(error?.message || 'Failed to generate signed URL');
                setSingleImageState('error');
              }
            }
          }
        } else if (singleImageTask.status === 'error') {
          setSingleImageError(singleImageTask.error || 'Single image generation failed');
          setSingleImageState('error');
        } else {
          setProgress(singleImageTask.progress || 0);
          setStatusMessage('Generating single image...');
          setSingleImageState('generating');
        }
      } else {
        const filteredTasks = tasks.filter(t => !t.single_image && t.batch_number > 0);
        
        // Separate active generation tasks from redo-only tasks
        const activeTasks = filteredTasks.filter(t => 
          (t.status === 'pending' || t.status === 'queued' || t.status === 'running') &&
          !t.redo_status
        );
        
        // Check if any tasks are being redone
        const redoingTasks = filteredTasks.filter(t => t.redo_status === 'redoing');
        
        const totalBatches = filteredTasks.length > 0 ? filteredTasks[0].total_batches : 0;
        const completedTasks = filteredTasks.filter(t => t.status === 'completed' || t.status === 'completed_final');
        
        // Check if all tasks are complete (main generation is done)
        const allComplete = filteredTasks.every(t => 
          t.status === 'completed' || t.status === 'completed_final'
        );
        
        // Only show generation progress if there are active tasks
        if (activeTasks.length > 0 && !allVideoProcessed) {
          // Set phase to 'images' for standalone image generation (not combined workflow)
          setCurrentPhase('images');
          setImageGenerationProgress(totalBatches > 0 ? Math.min(100, (completedTasks.length / totalBatches) * 100) : 0);
          
          const totalProgress = filteredTasks.reduce((sum, t) => sum + (t.progress || 0), 0);
          const progressPercent = Math.min(100, totalBatches > 0 ? (totalProgress / (totalBatches * 100)) * 100 : 0);
          
          setProgress(progressPercent);
          setStatusMessage(totalBatches > 0 ? `Processing batch ${completedTasks.length + 1} of ${totalBatches}` : 'Preparing image generation...');
          setBatchStatuses(filteredTasks.map(t => ({
            batchNumber: t.batch_number,
            status: t.status,
            progress: t.progress || 0,
          })));
          totalBatchesRef.current = totalBatches;
          const imageModel = filteredTasks[0]?.image_model || selectedDocumentModel;
          const timePerImage = getTimePerImageInSeconds(imageModel);
          setTimeRemaining((totalBatches - completedTasks.length) * timePerImage);
        }

        const errorTask = filteredTasks.find(t => t.status === 'error');
        if (errorTask) {
          setError(errorTask.error || 'An error occurred during processing');
          setGenerationState('error');
          return;
        }

        if (allComplete && activeTasks.length === 0 && !allVideoProcessed) {
          setGenerationState('complete');
          setCurrentPhase('complete');
          setProgress(100);
          setTimeRemaining(0);
          
          // Show appropriate message based on redo status
          if (redoingTasks.length > 0) {
            setStatusMessage('Image generation complete! Redoing selected images...');
          } else {
            setStatusMessage('Image generation tasks complete!');
          }
          
          setBatchStatuses([]);
          if (!redoingImage) {
            await refreshSignedUrls(filteredTasks);
          }
          
          // Update tab status to complete for standalone image generation
          if (currentUserId && currentGroupId) {
            await updateTabStatus(currentUserId, 'image', currentTab, 'complete', currentGroupId, `Tab ${currentTab}`, false);
          }
        }
      }

      const { data: planData, error: planError } = await withRetry(
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
      } else if (planData) {
        const planType = planData.plan_type || 'free';
        setUserTokenBalance(getPlanMaxTokens(planType, isLegacy) - (planData.tokens_used || 0) + (planData.rollover_tokens || 0));
      }
    } catch (err: any) {
      if (err.message.includes('Failed to fetch')) {
        setNetworkRetrying(true);
        setStatusMessage('Network connection issue. Retrying...');
      } else {
        setError(err.message);
        if (singleImageGroupId === groupId) {
          setSingleImageError(err.message);
          setSingleImageState('error');
        } else {
          setGenerationState('error');
        }
      }
    }
  };

  // NEW FUNCTION: Fetch combined tasks (both image prompts and image generation)
  const fetchCombinedTasks = async () => {
    try {
      if (!combinedGroupId || !currentUserId) return;

      // Fetch image prompt tasks
      const { data: promptTasks, error: promptError } = await withRetry(
        () => withTimeout(
          supabase
            .from('image_prompt_tasks')
            .select('id,story_title,total_batches,batch_number,progress,error,status,group_id,updated_at,process_image,check_stuck,total_prompts')
            .eq('user_id', currentUserId)
            .eq('group_id', combinedGroupId)
            .eq('process_image', true)
            .eq('tab', currentTab)
            .order('batch_number', { ascending: true }),
          OPERATION_TIMEOUT,
          'fetchPromptTasks'
        ),
        'fetchPromptTasks'
      );

      // Fetch image generation tasks
      const { data: imageTasks, error: imageError } = await withRetry(
        () => withTimeout(
          supabase
            .from('image_tasks')
            .select('id,story_title,total_batches,batch_number,progress,error,status,group_id,updated_at,batch_output,single_image,check_stuck,image_model')
            .eq('user_id', currentUserId)
            .eq('group_id', combinedGroupId)
            .eq('single_image', false)
            .eq('tab', currentTab)
            .order('batch_number', { ascending: true }),
          OPERATION_TIMEOUT,
          'fetchImageTasks'
        ),
        'fetchImageTasks'
      );

      if (promptError) throw new Error(`Failed to fetch prompt tasks: ${promptError.message}`);
      if (imageError) throw new Error(`Failed to fetch image tasks: ${imageError.message}`);

      if (promptTasks) setImagePromptTasks(promptTasks);
      if (imageTasks) setImageTasks(imageTasks);

      // Clear initializing state once tasks are detected
      if (isInitializingTasks && (promptTasks && promptTasks.length > 0)) {
        setIsInitializingTasks(false);
      }

      // Determine current phase and progress
      const promptTasksFiltered = promptTasks?.filter(t => t.batch_number > 0) || [];
      const imageTasksFiltered = imageTasks?.filter(t => t.batch_number > 0) || [];

      const promptsCompleted = promptTasksFiltered.every(t => t.status === 'completed' || t.status === 'completed_final');
      const imagesCompleted = imageTasksFiltered.every(t => t.status === 'completed' || t.status === 'completed_final');

      // If there are NO prompt tasks but there ARE image tasks, treat it as image generation only
      // This handles cases where image generation is running without prompt generation (e.g., from video generator)
      if (promptTasksFiltered.length === 0 && imageTasksFiltered.length > 0) {
        // Skip to image generation phase directly
        setCurrentPhase('images');
        setImagePromptProgress(100); // Mark prompts as complete since they don't exist
        
        const imageTotalProgress = imageTasksFiltered.reduce((sum, t) => sum + (t.progress || 0), 0);
        const imageProgressPercent = imageTasksFiltered.length > 0 ? 
          Math.min(100, (imageTotalProgress / (imageTasksFiltered.length * 100)) * 100) : 0;
        
        setImageGenerationProgress(imageProgressPercent);
        
        // Check if image generation is complete
        if (imagesCompleted) {
          setCurrentPhase('complete');
          setImageGenerationProgress(100);
          setGenerationState('complete');
          setProgress(100);
          setTimeRemaining(0);
          setStatusMessage('Image generation tasks complete!');
          if (!redoingImage) {
            await refreshSignedUrls(imageTasksFiltered);
          }
          
          // Update tab status to complete for image tab only (no prompt tab)
          if (currentUserId && combinedGroupId) {
            await updateTabStatus(currentUserId, 'image', currentTab, 'complete', combinedGroupId, `Tab ${currentTab}`, false);
          }
        } else {
          // Image generation in progress
          setGenerationState('generating');
          
          // Update image tab status to generating
          if (currentUserId && combinedGroupId) {
            await updateTabStatus(currentUserId, 'image', currentTab, 'generating', combinedGroupId, `Tab ${currentTab}`, false);
          }
          
          const completedImageTasks = imageTasksFiltered.filter(t => t.status === 'completed' || t.status === 'completed_final');
          const imageModel = imageTasksFiltered[0]?.image_model || newPromptsSettings.imageModel;
          const timePerImage = getTimePerImageInSeconds(imageModel);
          const remainingImageTime = (imageTasksFiltered.length - completedImageTasks.length) * timePerImage;
          
          setTimeRemaining(remainingImageTime);
          setStatusMessage(`Generating images: batch ${completedImageTasks.length + 1} of ${imageTasksFiltered.length}`);
        }
      } else if (imagesCompleted && imageTasksFiltered.length > 0) {
        // Both phases complete
        setCurrentPhase('complete');
        setImagePromptProgress(100);
        setImageGenerationProgress(100);
        setGenerationState('complete');
        setProgress(100);
        setTimeRemaining(0);
        setStatusMessage('Image generation tasks complete!');
        if (!redoingImage) {
          await refreshSignedUrls(imageTasksFiltered);
        }
        
        // Update tab status to complete for combined workflow (both tabs)
        if (currentUserId && combinedGroupId) {
          await updateTabStatus(currentUserId, 'image_prompt', currentTab, 'complete', combinedGroupId, `Tab ${currentTab}`, true);
          await updateTabStatus(currentUserId, 'image', currentTab, 'complete', combinedGroupId, `Tab ${currentTab}`, false);
        }
      } else if (promptsCompleted && promptTasksFiltered.length > 0) {
        // Prompts complete, images in progress
        setCurrentPhase('images');
        setImagePromptProgress(100);
        
        // Update image tab status to generating when image generation phase starts
        if (currentUserId && combinedGroupId) {
          await updateTabStatus(currentUserId, 'image', currentTab, 'generating', combinedGroupId, `Tab ${currentTab}`, false);
        }
        
        const imageTotalProgress = imageTasksFiltered.reduce((sum, t) => sum + (t.progress || 0), 0);
        const imageProgressPercent = imageTasksFiltered.length > 0 ? 
          Math.min(100, (imageTotalProgress / (imageTasksFiltered.length * 100)) * 100) : 0;
        
        setImageGenerationProgress(imageProgressPercent);
        setGenerationState('generating');
        
        const completedImageTasks = imageTasksFiltered.filter(t => t.status === 'completed' || t.status === 'completed_final');
        const imageModel = imageTasksFiltered[0]?.image_model || newPromptsSettings.imageModel;
        const timePerImage = getTimePerImageInSeconds(imageModel);
        const remainingImageTime = (imageTasksFiltered.length - completedImageTasks.length) * timePerImage;
        
        setTimeRemaining(remainingImageTime);
        setStatusMessage(`Generating images: batch ${completedImageTasks.length + 1} of ${imageTasksFiltered.length}`);
      } else if (promptTasksFiltered.length > 0) {
        // Prompts in progress
        setCurrentPhase('prompts');
        
        const promptTotalProgress = promptTasksFiltered.reduce((sum, t) => sum + (t.progress || 0), 0);
        const promptProgressPercent = promptTasksFiltered.length > 0 ? 
          Math.min(100, (promptTotalProgress / (promptTasksFiltered.length * 100)) * 100) : 0;
        
        setImagePromptProgress(promptProgressPercent);
        setImageGenerationProgress(0);
        setGenerationState('generating');
        
        const completedPromptTasks = promptTasksFiltered.filter(t => t.status === 'completed' || t.status === 'completed_final');
        const remainingPromptTime = (promptTasksFiltered.length - completedPromptTasks.length) * 90;
        const imageModel = newPromptsSettings.imageModel;
        const timePerImage = getTimePerImageInSeconds(imageModel);

        // Derive total image count from the task with the highest batch_number's total_prompts field.
        // This reflects the actual number of prompts (images) queued in the pipeline.
        const highestBatchPromptTask = promptTasksFiltered.reduce(
          (prev, curr) => (curr.batch_number > prev.batch_number ? curr : prev),
          promptTasksFiltered[0]
        );
        const totalImagesFromTasks = highestBatchPromptTask?.total_prompts ?? (combinedEstimate ? combinedEstimate.totalImages : 0);
        const estimatedImageTime = totalImagesFromTasks * timePerImage;
        
        setTimeRemaining(remainingPromptTime + estimatedImageTime);
        setStatusMessage(`Generating image prompts: batch ${completedPromptTasks.length + 1} of ${promptTasksFiltered.length}`);
      } else if (isInitializingTasks) {
        // Tasks not created yet but initializing - show loading state
        setCurrentPhase('prompts');
        setGenerationState('generating');
        setImagePromptProgress(0);
        setImageGenerationProgress(0);
        setStatusMessage('Initializing image prompt generation...');
      }

      // Check for errors
      const promptErrorTask = promptTasksFiltered.find(t => t.status === 'error');
      const imageErrorTask = imageTasksFiltered.find(t => t.status === 'error');
      
      if (promptErrorTask || imageErrorTask) {
        const errorMessage = promptErrorTask?.error || imageErrorTask?.error || 'An error occurred during processing';
        setError(errorMessage);
        setGenerationState('error');
        return;
      }

      // Update token balance
      const { data: planData, error: planError } = await withRetry(
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
      if (!planError && planData) {
        const planType = planData.plan_type || 'free';
        setUserTokenBalance(getPlanMaxTokens(planType, isLegacy) - (planData.tokens_used || 0) + (planData.rollover_tokens || 0));
      }

    } catch (err: any) {
      console.error('Error fetching combined tasks:', err);
      if (err.message.includes('Failed to fetch')) {
        setNetworkRetrying(true);
        setStatusMessage('Network connection issue. Retrying...');
      } else {
        setError(err.message);
        setGenerationState('error');
      }
    }
  };

  useEffect(() => {
    const checkUser = async () => {
      try {
        if (!checkNetworkStatus()) throw new Error('No internet connection');
        const { data: { user }, error: authError } = await withRetry(
          () => withTimeout(supabase.auth.getUser(), OPERATION_TIMEOUT, 'getUser'),
          'getUser'
        );
        if (authError || !user) {
          setError('Authentication error');
          setLoading(false);
          return;
        }
        setCurrentUserId(user.id);

        // Fetch user plan first (like in ImagePrompts.tsx)
        const { data: planData, error: planError } = await withRetry(
          () => withTimeout(
            supabase
              .from('user_plans')
              .select('plan_type, tokens_used, rollover_tokens')
              .eq('user_id', user.id)
              .eq('is_active', true)
              .single(),
            OPERATION_TIMEOUT,
            'fetchUserPlan'
          ),
          'fetchUserPlan'
        );
        if (planError) throw planError;
        if (planData) {
          const planType = planData.plan_type || 'free';
          setUserPlan(planType);
          setUserTokenBalance(getPlanMaxTokens(planType, isLegacy) - (planData.tokens_used || 0) + (planData.rollover_tokens || 0));
        }
        setPlanLoaded(true);

        // Quick precheck: skip slow document fetching if there's an active generation
        const { data: activeTaskCheck } = await supabase
          .from('image_tasks')
          .select('id')
          .eq('user_id', user.id)
          .eq('tab', currentTab)
          .in('status', ['pending', 'queued', 'running'])
          .or('itv.is.null,itv.eq.false')
          .limit(1);
        const { data: activePromptCheck } = await supabase
          .from('image_prompt_tasks')
          .select('id')
          .eq('user_id', user.id)
          .eq('process_image', true)
          .eq('tab', currentTab)
          .in('status', ['pending', 'queued', 'running'])
          .limit(1);
        const skipDocFetch = (activeTaskCheck && activeTaskCheck.length > 0) || (activePromptCheck && activePromptCheck.length > 0);

        if (!skipDocFetch) {
        const { data, error } = await withRetry(
          () => withTimeout(
            supabase
              .from('story_documents')
              .select('*')
              .eq('user_id', user.id)
              .in('version', [3, 4])
              .order('created_at', { ascending: false }),
            OPERATION_TIMEOUT,
            'fetchDocuments'
          ),
          'fetchDocuments'
        );
        if (error) throw error;

        const documentsWithWordCount = await Promise.all(
          (data || []).map(async (doc: StoryDocument) => {
            try {
              const { data: fileData, error: fileError } = await withRetry(
                () => withTimeout(
                  supabase.storage.from('stories').download(doc.file_path),
                  OPERATION_TIMEOUT,
                  `downloadDocument_${doc.id}`
                ),
                `downloadDocument_${doc.id}`
              );
              if (fileError) {
                console.error(`Failed to download document ${doc.id}: ${fileError.message}`);
                return { ...doc, word_count: 0 };
              }
              const content = await fileData.text();
              const wordCount = calculateWordCount(content);
              return { ...doc, word_count: wordCount };
            } catch (err) {
              console.error(`Error processing document ${doc.id}: ${err}`);
              return { ...doc, word_count: 0 };
            }
          })
        );
        setDocuments(documentsWithWordCount);

        // Add all story documents for New Image Prompts mode
        const { data: allStoryDocs, error: allStoryError } = await withRetry(
          () => withTimeout(
            supabase
              .from('story_documents')
              .select('*')
              .eq('user_id', user.id)
              .in('version', [1, 2])
              .eq('is_prompted', false)
              .order('created_at', { ascending: false }),
            OPERATION_TIMEOUT,
            'fetchAllStoryDocuments'
          ),
          'fetchAllStoryDocuments'
        );

        if (!allStoryError && allStoryDocs) {
          const storyDocsWithWordCount = await Promise.all(
            allStoryDocs.map(async (doc: StoryDocument) => {
              try {
                const { data: fileData, error: fileError } = await withRetry(
                  () => withTimeout(
                    supabase.storage.from('stories').download(doc.file_path),
                    OPERATION_TIMEOUT,
                    `downloadStoryDocument_${doc.id}`
                  ),
                  `downloadStoryDocument_${doc.id}`
                );
                if (fileError) {
                  console.error(`Failed to download story document ${doc.id}: ${fileError.message}`);
                  return { ...doc, word_count: 0 };
                }
                const content = await fileData.text();
                const wordCount = calculateWordCount(content);
                return { ...doc, word_count: wordCount };
              } catch (err) {
                console.error(`Error processing story document ${doc.id}: ${err}`);
                return { ...doc, word_count: 0 };
              }
            })
          );
          // Merge both document sets
          setDocuments([...documentsWithWordCount, ...storyDocsWithWordCount]);
        }

        // Fetch user's storage usage
        const { data: storageData, error: storageError } = await withRetry(
          () => withTimeout(
            supabase
              .from('story_documents')
              .select('*, file_size')
              .eq('user_id', user.id)
              .order('created_at', { ascending: false }),
            OPERATION_TIMEOUT,
            'fetchStorageData'
          ),
          'fetchStorageData'
        );
        
        if (!storageError && storageData) {
          let totalSize = 0;
          if (storageData.length > 0) {
            totalSize = storageData.reduce((sum, doc) => {
              if (doc.file_size != null && doc.file_size > 0) {
                return sum + doc.file_size;
              }
              const estimatedSize = (doc.word_count ?? 0) * 1.5;
              return sum + estimatedSize;
            }, 0);
          }
          const totalSizeMB = totalSize / (1024 * 1024);
          const formattedSize = totalSizeMB > 0 && totalSizeMB < 0.05 ? 0.1 : Number(totalSizeMB.toFixed(totalSizeMB < 1 ? 1 : 2));
          setStorageUsed(formattedSize);
        }
        } // end skipDocFetch

        // Check for existing tasks (both regular image tasks and combined workflow)
        const { data: tasks, error: taskError } = await withRetry(
          () => withTimeout(
            supabase
              .from('image_tasks')
              .select('id,user_id,story_title,batch,total_batches,batch_number,progress,error,status,group_id,doc_id,file_path,updated_at,batch_output,single_image,video_process,itv,check_stuck')
              .eq('user_id', user.id)
              .eq('tab', currentTab)
              .in('status', ['pending', 'queued', 'running', 'completed', 'completed_final']),
            OPERATION_TIMEOUT,
            'checkExistingTasks'
          ),
          'checkExistingTasks'
        );
        
        // Check for existing image prompt tasks with process_image = true
        const { data: promptTasks, error: promptTaskError } = await withRetry(
          () => withTimeout(
            supabase
              .from('image_prompt_tasks')
              .select('id,user_id,story_title,total_batches,batch_number,progress,error,status,group_id,updated_at,process_image,check_stuck')
              .eq('user_id', user.id)
              .eq('process_image', true)
              .eq('tab', currentTab)
              .in('status', ['pending', 'queued', 'running', 'completed', 'completed_final']),
            OPERATION_TIMEOUT,
            'checkExistingPromptTasks'
          ),
          'checkExistingPromptTasks'
        );

        if (taskError) throw taskError;
        
        // Don't restore selected document from tabs table - let user select fresh each time
        // This matches the behavior of "Use Image Prompt" section
        
        // Check for combined workflow document selection (image_prompt page)
        const { data: promptTabData } = await withRetry(
          () => withTimeout(
            supabase
              .from('tabs')
              .select('selected_doc_id')
              .eq('user_id', user.id)
              .eq('page', 'image_prompt')
              .eq('tab_number', currentTab)
              .single(),
            OPERATION_TIMEOUT,
            'fetchPromptTabDocInfo'
          ),
          'fetchPromptTabDocInfo'
        );
        
        if (promptTabData?.selected_doc_id) {
          setNewPromptsDoc(promptTabData.selected_doc_id);
        }
        
        // Handle combined workflow tasks first
        if (promptTasks && promptTasks.length > 0) {
          const promptTask = promptTasks[0];
          
          // Check if video processing is complete
          const allVideoProcessed = promptTasks.every(t => t.video_process === true) || promptTasks.every(t => t.itv === true);
          if (allVideoProcessed) {
            console.log('All prompt tasks have video_process or itv set to true, not showing any completion state');
            setGenerationState('idle');
            setLoading(false);
            return;
          }
          
          setSelectedMode('new');
          setCombinedGroupId(promptTask.group_id);
          setGeneratedGroupId(promptTask.group_id);
          setGeneratedDocTitle(promptTask.story_title);
          
          // Set state based on current status
          if (promptTasks.some(t => ['pending', 'queued', 'running'].includes(t.status)) || 
              (tasks && tasks.some(t => t.group_id === promptTask.group_id && ['pending', 'queued', 'running'].includes(t.status)))) {
            setGenerationState('generating');
            setCurrentPhase('prompts');
            generationStartTime.current = Date.now();
          } else if (promptTasks.every(t => t.status === 'completed_final') && 
                     tasks && tasks.some(t => t.group_id === promptTask.group_id && t.status === 'completed_final')) {
            setGenerationState('complete');
            setCurrentPhase('complete');
            setImagePromptProgress(100);
            setImageGenerationProgress(100);
            
            // Update tab status to complete for combined workflow (both tabs)
            if (currentUserId && promptTask.group_id) {
              await updateTabStatus(currentUserId, 'image_prompt', currentTab, 'complete', promptTask.group_id, `Tab ${currentTab}`, true);
              await updateTabStatus(currentUserId, 'image', currentTab, 'complete', promptTask.group_id, `Tab ${currentTab}`, false);
            }
          }
        }
        // Handle regular image generation tasks
        else if (tasks && tasks.length > 0) {
          const task = tasks[0];
          
          // Check if video processing is complete for all tasks with the same group_id FIRST
          const groupTasks = tasks.filter(t => t.group_id === task.group_id);
          const allVideoProcessed = groupTasks.every(t => t.video_process === true) || groupTasks.every(t => t.itv === true);
          
          if (allVideoProcessed) {
            console.log('All tasks have video_process or itv set to true, not showing any completion state');
            // Don't set any completion state or show any UI when video processing is complete
            setGenerationState('idle');
            setLoading(false);
            return;
          }
          
          // Set mode to 'existing' for standalone image generation (not combined workflow)
          setSelectedMode('existing');
          
          setImageTasks(tasks);
          setCurrentGroupId(task.group_id);
          setGeneratedGroupId(task.group_id);
          setGeneratedDocTitle(task.story_title);
          if (task.single_image) {
            setSelectedMode('individual');
            setSingleImageGroupId(task.group_id);
            if (task.status === 'completed_final') {
              setSingleImageState('complete');
              setSingleImageUrl(task.batch_output?.match(/https:\/\/[^\s]+/)?.[0] || null);
            } else if (task.status === 'error') {
              setSingleImageState('error');
              setSingleImageError(task.error || 'Single image generation failed');
            } else {
              setSingleImageState('generating');
              setProgress(task.progress || 0);
            }
          } else if (tasks.some(t => t.status === 'pending' || t.status === 'queued' || t.status === 'running')) {
            setGenerationState('generating');
            setProgress(task.progress || 0);
            setStatusMessage(`Processing batch ${task.batch_number} of ${task.total_batches}`);
            totalBatchesRef.current = task.total_batches;
            const imageModel = task.image_model || selectedDocumentModel;
            const timePerImage = getTimePerImageInSeconds(imageModel);
            setTimeRemaining((task.total_batches - task.batch_number + 1) * timePerImage);
            setBatchStatuses(tasks.map(t => ({
              batchNumber: t.batch_number,
              status: t.status,
              progress: t.progress || 0,
            })));
            generationStartTime.current = Date.now();
          } else if (generationState === 'complete' && generatedGroupId) {
            setGenerationState('complete');
            await refreshSignedUrls(tasks);
          }
        } else if (generationState === 'complete' && generatedGroupId) {
          const { data: imageDoc, error: docError } = await supabase
            .from('story_documents')
            .select('file_path, title')
            .eq('group_id', generatedGroupId)
            .eq('user_id', user.id)
            .in('version', [5, 6])
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
          if (docError || !imageDoc) {
            setError(`Failed to find image output document: ${docError?.message || 'No image output document found'}`);
            setGenerationState('error');
            setLoading(false);
            return;
          }
          const folderPath = imageDoc.file_path;
          setGeneratedDocTitle(imageDoc.title);

          let imagesValid = false;
          if (generatedImages.length > 0) {
            try {
              const response = await fetch(generatedImages[0], { method: 'HEAD' });
              imagesValid = response.ok;
            } catch (err) {
              console.error('Existing image URLs are invalid:', err);
            }
          }

          if (!imagesValid) {
            const { data: files, error: listError } = await supabase.storage
              .from('stories')
              .list(folderPath);
            if (listError) {
              setError(`Failed to list images: ${listError.message}`);
              setGenerationState('error');
              setLoading(false);
              return;
            }
            const imageFiles = files
              .filter(file => file.name.endsWith('.png'))
              .sort((a, b) => {
                const aNum = parseInt(a.name.split('.')[0]);
                const bNum = parseInt(b.name.split('.')[0]);
                return aNum - bNum;
              });
            if (imageFiles.length > 0) {
              const signedUrls = await Promise.all(
                imageFiles.map(async (file) => {
                  const { data: signedUrlData, error: signedUrlError } = await supabase.storage
                    .from('stories')
                    .createSignedUrl(`${folderPath}/${file.name}`, 60);
                  if (signedUrlError) {
                    console.error(`Failed to generate signed URL for ${file.name}:`, signedUrlError);
                    return null;
                  }
                  return signedUrlData.signedUrl;
                })
              );
              setGeneratedImages(signedUrls.filter((url): url is string => url !== null));
              // Initialize loading states for all images
              setImageLoadingStates(new Array(signedUrls.length).fill(false));
            } else {
              setGeneratedImages([]);
              setImageLoadingStates([]);
            }
          }
        }
      } catch (err: any) {
        setError(`Failed to initialize: ${err.message}`);
        setGenerationState('error');
      } finally {
        setLoading(false);
      }
    };
    checkUser();
  }, []);

  // Load tab form inputs from database on mount
  useEffect(() => {
    const loadTabInputs = async () => {
      if (!currentUserId || !currentTab) return;

      try {
        console.log(`[ImageGenerator Tab ${currentTab}] Loading form inputs from database`);
        const tabInputs = await getImageGeneratorTabInputs(currentUserId, currentTab);
        
        if (tabInputs) {
          setSelectedDocumentModel(tabInputs.selectedDocumentModel as ImageModel);
          // Note: selectedDoc is intentionally NOT restored from DB so the page always
          // starts at "None - Select a document" on load (matches Image-to-Video page).
          console.log(`[ImageGenerator Tab ${currentTab}] Loaded form inputs:`, tabInputs);
        }
      } catch (error) {
        console.error(`[ImageGenerator Tab ${currentTab}] Error loading form inputs:`, error);
      }
    };

    loadTabInputs();
  }, [currentUserId, currentTab]);

  // Debounced form persistence - save to database when form inputs change
  useEffect(() => {
    if (!currentUserId || !currentTab) return;

    const debounceTimer = setTimeout(async () => {
      try {
        await saveImageGeneratorTabInputs(currentUserId, currentTab, {
          selectedDocumentModel,
        });
        console.log(`[ImageGenerator Tab ${currentTab}] Saved form inputs`);
      } catch (error) {
        console.error(`[ImageGenerator Tab ${currentTab}] Error saving form inputs:`, error);
      }
    }, 1000); // 1 second debounce

    return () => clearTimeout(debounceTimer);
  }, [selectedDocumentModel, currentUserId, currentTab]);

  // Updated useEffect hook with fallback logic removed
  useEffect(() => {
    const checkExistingTasks = async () => {
      try {
        if (!checkNetworkStatus()) {
          throw new Error('No internet connection');
        }
        const { data: { user }, error: authError } = await withRetry(
          () => withTimeout(supabase.auth.getUser(), OPERATION_TIMEOUT, 'getUser'),
          'checkUser'
        );

        if (authError || !user) {
          setError('Authentication error');
          setLoading(false);
          return;
        }

        setCurrentUserId(user.id);
        const { data: tasks, error } = await withRetry(
          () => withTimeout(
            supabase
              .from('image_tasks')
              .select('id, user_id, story_title, batch_output, total_batches, batch_number, status, settings, group_id, updated_at, single_image, video_process, itv, check_stuck')
              .eq('user_id', user.id)
              .eq('status', 'completed_final')
              .eq('single_image', false)
              .eq('tab', currentTab)
              .order('created_at', { ascending: false }),
            OPERATION_TIMEOUT,
            'checkExistingTasks'
          ),
          'checkExistingTasks'
        );
        if (error) throw new Error(`Failed to fetch tasks: ${error.message}`);

        if (tasks && tasks.length > 0) {
          const task = tasks[0];
          const filteredTasks = tasks.filter(t => t.status === 'completed_final' && t.group_id === task.group_id && !t.single_image);
          
          // Check if video processing is complete for all tasks with the current group_id FIRST
          const allVideoProcessed = filteredTasks.every(t => t.video_process === true) || filteredTasks.every(t => t.itv === true);
          if (allVideoProcessed) {
            console.log('All tasks have video_process or itv set to true, not showing any completion state');
            // Don't set any completion state or show any UI when video processing is complete
            setGenerationState('idle');
            setLoading(false);
            return;
          }

          // Generate signed URLs for valid batch_output
          const generatedImages = await Promise.all(
            filteredTasks
              .sort((a, b) => a.batch_number - b.batch_number)
              .map(async (t) => {
                if (!t.batch_output) {
                  console.warn(`No batch_output for task ${t.id}, batch ${t.batch_number}`);
                  return null;
                }
                const imagePath = t.batch_output.match(/https:\/\/[^\s]+/)?.[0];
                if (!imagePath) {
                  console.warn(`No valid image URL in batch_output for task ${t.id}, batch ${t.batch_number}`);
                  return null;
                }
                const relativePath = imagePath.replace(`${import.meta.env.SUPABASE_URL}/storage/v1/object/public/stories/`, '');
                try {
                  const { data, error } = await withRetry(
                    () => withTimeout(
                      supabase.storage.from('stories').createSignedUrl(relativePath, 60),
                      OPERATION_TIMEOUT,
                      `createSignedUrl_${t.batch_number}`
                    ),
                    `createSignedUrl_${t.batch_number}`
                  );
                  if (error) {
                    console.error(`Failed to generate signed URL for batch ${t.batch_number}:`, error);
                    return null;
                  }
                  // Validate URL accessibility
                  try {
                    const response = await fetch(data.signedUrl, { method: 'HEAD' });
                    if (!response.ok) {
                      console.warn(`Signed URL for batch ${t.batch_number} is inaccessible: ${response.status}`);
                      return null;
                    }
                    return data.signedUrl;
                  } catch (fetchError) {
                    console.warn(`Failed to validate signed URL for batch ${t.batch_number}:`, fetchError);
                    return null;
                  }
                } catch (error) {
                  console.error(`Error creating signed URL for batch ${t.batch_number}:`, error);
                  return null;
                }
              })
          );

          const validImages = generatedImages.filter((url): url is string => url !== null);
          if (validImages.length === 0 && filteredTasks.length > 0) {
            console.warn('No valid images found for completed tasks');
            setError('No accessible images found for completed tasks');
            setGenerationState('error');
            setLoading(false);
            return;
          }

          setCurrentGroupId(task.group_id);
          setGenerationState('complete');
          setSettings(task.settings || null);
          setGeneratedGroupId(task.group_id);
          setGeneratedDocTitle(task.story_title);
          setGeneratedImages(validImages);
          setImageTasks(filteredTasks);
          setProgress(100);
          setTimeRemaining(0);
          setStatusMessage('Image generation complete!');
          // Initialize loading states for all images
          setImageLoadingStates(new Array(validImages.length).fill(false));
        }
        // Removed the fallback logic that checked story_documents table
        
        setLoading(false);
      } catch (err: any) {
        console.error('Error checking existing tasks:', err);
        setError(`Failed to check for existing tasks: ${err.message}`);
        setGenerationState('error');
        setLoading(false);
      }
    };

    checkExistingTasks();
  }, []);
  

  const refreshSignedUrls = async (tasks: ImageTask[]) => {
    const newSignedUrls: string[] = [];
    for (const task of tasks.filter(t => t.status === 'completed' || t.status === 'completed_final' && !t.single_image)) {
      if (task.batch_output) {
        const imagePath = task.batch_output.match(/https:\/\/[^\s]+/)?.[0];
        if (imagePath) {
          try {
            const { data, error } = await supabase.storage
              .from('stories')
              .createSignedUrl(imagePath.replace(`${import.meta.env.SUPABASE_URL}/storage/v1/object/public/stories/`, ''), 60);
            if (error) throw error;
            newSignedUrls[task.batch_number - 1] = data.signedUrl;
          } catch (error) {
            console.error(`Error creating signed URL for batch ${task.batch_number}:`, error);
          }
        }
      }
    }
    setGeneratedImages(newSignedUrls.filter((url): url is string => url !== null));
    // Initialize loading states for refreshed images
    setImageLoadingStates(new Array(newSignedUrls.filter((url): url is string => url !== null).length).fill(false));
  };

  useEffect(() => {
    if ((generationState !== 'generating' && generationState !== 'complete' && singleImageState !== 'generating' && singleImageState !== 'complete') || (!currentGroupId && !singleImageGroupId && !combinedGroupId) || !currentUserId) return;
    let subscriptionActive = false;
    
    // Determine which group ID to use for subscription
    const groupId = combinedGroupId || currentGroupId || singleImageGroupId;
    
    // Set up subscription for both image_tasks and image_prompt_tasks if using combined workflow
    const imageTasksSubscription = supabase
      .channel(`image_tasks:${groupId}:${currentTab}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'image_tasks',
          filter: `group_id=eq.${groupId},tab=eq.${currentTab}`,
        },
        async (payload) => {
          lastUpdateRef.current = Date.now();
          lastSubscriptionUpdateRef.current = Date.now();
          subscriptionActive = true;
          const updatedTask = payload.new as ImageTask;
          setImageTasks((prevTasks) => {
            const taskExists = prevTasks.some(task => task.id === updatedTask.id);
            if (taskExists) {
              return prevTasks.map((task) =>
                task.id === updatedTask.id ? { ...task, ...updatedTask } : task
              );
            } else {
              return [...prevTasks, updatedTask];
            }
          });

          if (updatedTask.single_image) {
            if (updatedTask.status === 'completed_final' && updatedTask.batch_output) {
              try {
                const imagePath = updatedTask.batch_output.match(/https:\/\/[^\s]+/)?.[0];
                if (!imagePath) throw new Error('No valid image URL in batch_output');
                const { data, error } = await withRetry(
                  () => withTimeout(
                    supabase.storage
                      .from('stories')
                      .createSignedUrl(imagePath.replace(`${import.meta.env.SUPABASE_URL}/storage/v1/object/public/stories/`, ''), 60),
                    OPERATION_TIMEOUT,
                    'createSignedUrl_single_image'
                  ),
                  'createSignedUrl_single_image'
                );
                if (error) throw error;
                setSingleImageUrl(data.signedUrl);
                setSingleImageState('complete');
                setStatusMessage('Single image generation complete!');
                setProgress(100);
              } catch (error: any) {
                console.error('Error updating single image:', error);
                setSingleImageError(`Failed to load single image: ${error.message}`);
                setSingleImageState('error');
              }
            } else if (updatedTask.status === 'error') {
              setSingleImageError(updatedTask.error || 'Single image generation failed');
              setSingleImageState('error');
            } else {
              setProgress(updatedTask.progress || 0);
              setSingleImageState('generating');
              setStatusMessage('Generating single image...');
            }
          } else if (updatedTask.status === 'completed_final' && updatedTask.batch_number === redoingImage && updatedTask.batch_output) {
            try {
              const imagePath = updatedTask.batch_output.match(/https:\/\/[^\s]+/)?.[0];
              if (!imagePath) throw new Error('No valid image URL in batch_output');
              const { data, error } = await withRetry(
                () => withTimeout(
                  supabase.storage
                    .from('stories')
                    .createSignedUrl(imagePath.replace(`${import.meta.env.SUPABASE_URL}/storage/v1/object/public/stories/`, ''), 60),
                  OPERATION_TIMEOUT,
                  `createSignedUrl_redo_${updatedTask.batch_number}`
                ),
                `createSignedUrl_redo_${updatedTask.batch_number}`
              );
              if (error) throw error;
              setGeneratedImages((prev) => {
                const newImages = [...prev];
                newImages[updatedTask.batch_number - 1] = data.signedUrl;
                return newImages;
              });
              setRedoingImage(null);
              setStatusMessage('Image generation tasks complete!');
            } catch (error: any) {
              console.error(`Error updating redone image ${updatedTask.batch_number}:`, error);
              setError(`Failed to load redone image ${updatedTask.batch_number}: ${error.message}`);
              setRedoingImage(null);
            }
          }
        }
      )
      .subscribe((status, err) => {
        if (err) {
          console.error('Image tasks subscription error:', err.message);
          subscriptionActive = false;
        } else {
          subscriptionActive = status === 'SUBSCRIBED';
          lastSubscriptionUpdateRef.current = Date.now();
        }
      });

    // Set up subscription for image_prompt_tasks if using combined workflow
    let promptTasksSubscription;
    if (selectedMode === 'new' && combinedGroupId) {
      promptTasksSubscription = supabase
        .channel(`image_prompt_tasks:${groupId}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'image_prompt_tasks',
            filter: `group_id=eq.${groupId}`,
          },
          (payload) => {
            lastUpdateRef.current = Date.now();
            lastSubscriptionUpdateRef.current = Date.now();
            subscriptionActive = true;
            const updatedTask = payload.new as ImagePromptTask;
            setImagePromptTasks((prevTasks) => {
              const taskExists = prevTasks.some(task => task.id === updatedTask.id);
              if (taskExists) {
                return prevTasks.map((task) =>
                  task.id === updatedTask.id ? { ...task, ...updatedTask } : task
                );
              } else {
                return [...prevTasks, updatedTask];
              }
            });
          }
        )
        .subscribe((status, err) => {
          if (err) {
            console.error('Image prompt tasks subscription error:', err.message);
            subscriptionActive = false;
          } else {
            subscriptionActive = status === 'SUBSCRIBED';
            lastSubscriptionUpdateRef.current = Date.now();
          }
        });
    }

    const pollTasksInterval = async () => {
      if (subscriptionActive && Date.now() - lastUpdateRef.current < POLLING_INTERVAL) return;
      await fetchTasksForPolling();
    };

    const checkSubscription = () => {
      if (!subscriptionActive && Date.now() - lastSubscriptionUpdateRef.current > SUBSCRIPTION_CHECK_INTERVAL) {
        imageTasksSubscription.unsubscribe();
        if (promptTasksSubscription) promptTasksSubscription.unsubscribe();
        
        // Recreate subscriptions
        imageTasksSubscription.subscribe((status, err) => {
          if (err) {
            console.error('Re-subscription error for image tasks:', err.message);
            subscriptionActive = false;
          } else {
            subscriptionActive = status === 'SUBSCRIBED';
            lastSubscriptionUpdateRef.current = Date.now();
          }
        });
        
        if (promptTasksSubscription) {
          promptTasksSubscription.subscribe((status, err) => {
            if (err) {
              console.error('Re-subscription error for prompt tasks:', err.message);
              subscriptionActive = false;
            } else {
              subscriptionActive = status === 'SUBSCRIBED';
              lastSubscriptionUpdateRef.current = Date.now();
            }
          });
        }
      }
    };

    const handleNetworkChange = () => {
      if (navigator.onLine) {
        setNetworkRetrying(false);
        setStatusMessage('Network connection restored. Resuming...');
        fetchTasksForPolling();
      } else {
        setNetworkRetrying(true);
        setStatusMessage('Network connection lost. Waiting to reconnect...');
      }
    };

    window.addEventListener('online', handleNetworkChange);
    window.addEventListener('offline', handleNetworkChange);
    const pollInterval = setInterval(pollTasksInterval, POLLING_INTERVAL);
    const subscriptionCheckInterval = setInterval(checkSubscription, SUBSCRIPTION_CHECK_INTERVAL);
    fetchTasksForPolling();

    return () => {
      imageTasksSubscription.unsubscribe();
      if (promptTasksSubscription) promptTasksSubscription.unsubscribe();
      clearInterval(pollInterval);
      clearInterval(subscriptionCheckInterval);
      window.removeEventListener('online', handleNetworkChange);
      window.removeEventListener('offline', handleNetworkChange);
    };
  }, [generationState, currentGroupId, singleImageGroupId, combinedGroupId, currentUserId, redoingImage, singleImageState, selectedMode]);

  const handleAnalyze = async () => {
    setError(null);
    setGenerationState('analyzing');
    setStatusMessage('Analyzing document...');
    setProgress(0);
    setTimeRemaining(null);
    try {
      if (!checkNetworkStatus()) throw new Error('No internet connection');
      const { data: { user } } = await withRetry(
        () => withTimeout(supabase.auth.getUser(), OPERATION_TIMEOUT, 'getUser'),
        'getUser'
      );
      if (!user) throw new Error('User not authenticated');
      setCurrentUserId(user.id);
      const doc = documents.find(doc => doc.id === selectedDoc);
      if (!doc) throw new Error('Selected document not found');
      const { data, error } = await withRetry(
        () => withTimeout(
          supabase.storage.from('stories').download(doc.file_path),
          OPERATION_TIMEOUT,
          'downloadDocument'
        ),
        'downloadDocument'
      );
      if (error) throw new Error(`Failed to download document: ${error.message}`);
      const content = await data.text();
      if (!content) throw new Error('Document content is empty');
      const { data: { session } } = await withRetry(
        () => withTimeout(supabase.auth.getSession(), OPERATION_TIMEOUT, 'getSession'),
        'getSession'
      );
      if (!session) throw new Error('No active session found');
      const response = await withRetry(
        () => withTimeout(
          fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/image-analyze`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              user_id: user.id,
              file_path: doc.file_path,
              doc_id: doc.id,
              story_title: doc.title,
              description: doc.description || '',
            }),
          }).then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to analyze document`);
            return res.json();
          }),
          OPERATION_TIMEOUT,
          'analyzeDocument'
        ),
        'analyzeDocument'
      );
      if (response.error) throw new Error(`Analysis error: ${response.error}`);
      setAnalysisResult({ totalImages: response.totalImages, estimatedTokens: response.estimatedTokens });
      setGeneratedDocTitle(doc.title);
      setGeneratedGroupId(doc.group_id || uuidv4());
      setGenerationState('analyzed');
      setStatusMessage('Analysis complete.');
    } catch (err: any) {
      setError(err.message || 'An error occurred during analysis');
      setGenerationState('error');
    }
  };

  const handleContinue = async () => {
    setGenerationState('generating');
    setStatusMessage('Preparing image generation...');
    setProgress(0);
    setTimeRemaining(null);
    setBatchStatuses([]);
    generationStartTime.current = Date.now();
    try {
      if (!checkNetworkStatus()) throw new Error('No internet connection');
      const { data: { user } } = await withRetry(
        () => withTimeout(supabase.auth.getUser(), OPERATION_TIMEOUT, 'getUser'),
        'getUser'
      );
      if (!user) throw new Error('User not authenticated');
      const doc = documents.find(doc => doc.id === selectedDoc);
      if (!doc) throw new Error('Selected document not found');
      
      // Save document info and settings to tab
      const groupId = doc.group_id || uuidv4();
      await updateTabGroupAndDoc(
        user.id,
        'image',
        currentTab,
        groupId,
        doc.id,
        doc.title,
        doc.description || ''
      );
      // Save settings
      await saveImageTabFormInputs(
        user.id,
        currentTab,
        {
          style: newPromptsSettings.style,
          useCharacterDescriptions: newPromptsSettings.useCharacterDescriptions,
          firstPageFrequency: parseFloat(newPromptsSettings.firstPageFrequency),
          restFrequency: parseFloat(newPromptsSettings.restFrequency),
          imageModel: selectedDocumentModel,
          language: newPromptsSettings.language,
          model: newPromptsSettings.model,
          frequencyMode: newPromptsSettings.frequencyMode,
          frequencyType: newPromptsSettings.frequencyType,
          consistentFrequency: newPromptsSettings.consistentFrequency ? parseInt(newPromptsSettings.consistentFrequency) : undefined,
          audioDistributionType: newPromptsSettings.audioDistributionType,
          firstPageImageAmount: newPromptsSettings.audioFirstPageImageCount ? parseInt(newPromptsSettings.audioFirstPageImageCount) : undefined,
          restImageAmount: newPromptsSettings.audioRestImageCount ? parseInt(newPromptsSettings.audioRestImageCount) : undefined,
          totalAudioDuration: newPromptsSettings.totalAudioDuration,
          imageAmount: newPromptsSettings.imageAmount ? parseInt(newPromptsSettings.imageAmount) : undefined,
        }
      );
      
      // Update tab status to generating
      await updateTabStatus(user.id, 'image', currentTab, 'generating', groupId, doc.title, false);
      
      if (analysisResult) {
        const requiredTokens = analysisResult.totalImages * getTokensForModel(selectedDocumentModel, IMAGE_MODEL_OPTIONS);
        if (requiredTokens > userTokenBalance) {
          throw new Error(
            `Insufficient tokens to generate images. Required: ${formatNumber(requiredTokens)} tokens, Available: ${formatNumber(userTokenBalance)}`
          );
        }
      }
      
      // Check storage limits
      if (storageUsed !== null && analysisResult) {
        const requiredStorage = analysisResult.totalImages * IMAGE_SIZE_MB;
        const availableStorageMB = (maxStorageGB * 1024) - storageUsed;
        
        if (requiredStorage > availableStorageMB) {
          throw new Error(
            `Insufficient storage space. Required: ${requiredStorage} MB, Available: ${formatStorageSize(availableStorageMB)}`
          );
        }
      }
      
      const { data: { session } } = await withRetry(
        () => withTimeout(supabase.auth.getSession(), OPERATION_TIMEOUT, 'getSession'),
        'getSession'
      );
      if (!session) throw new Error('No active session found');

      let variant = 1;
      const { data: existingDocs, error: fetchVariantError } = await supabase
        .from('story_documents')
        .select('variant')
        .eq('group_id', doc.group_id || uuidv4())
        .eq('user_id', user.id)
        .in('version', [5, 6])
        .order('variant', { ascending: false });
      if (fetchVariantError) {
        throw new Error(`Failed to fetch existing variants: ${fetchVariantError.message}`);
      }
      if (existingDocs && existingDocs.length > 0) {
        const highestVariant = Math.max(...existingDocs.map(doc => doc.variant || 0));
        variant = highestVariant + 1;
      }

      const response = await withRetry(
        () => withTimeout(
          fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/setup-image-tasks`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              user_id: user.id,
              group_id: doc.group_id || uuidv4(),
              file_path: doc.file_path,
              story_title: doc.title,
              description: doc.description || '',
              doc_id: doc.id,
              variant,
              image_model: selectedDocumentModel,
              tab: currentTab,
            }),
          }).then(res => {
            setCurrentVariant(variant);
            if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to setup tasks`);
            return res.json();
          }),
          OPERATION_TIMEOUT,
          'setupImageTasks'
        ),
        'setupImageTasks'
      );
      setCurrentGroupId(response.group_id || doc.group_id);
      setGeneratedGroupId(response.group_id || doc.group_id);
      const timePerImage = getTimePerImageInSeconds(selectedDocumentModel);
      setTimeRemaining((response.total_batches || 1) * timePerImage);
      setStatusMessage('Preparing image generation...');
    } catch (err: any) {
      setError(err.message || 'An error occurred during generation');
      setGenerationState('error');
    }
  };

  // NEW FUNCTION: Handle combined workflow generation
  const handleNewPromptsGenerate = async () => {
    if (!combinedEstimate) {
      setError('Please select a document to generate estimate');
      return;
    }

    if (Object.keys(newPromptsValidationErrors).length > 0) {
      setError('Please fix the validation errors before generating');
      return;
    }

    if (combinedEstimate.totalTokens > userTokenBalance) {
      setError(`Insufficient tokens. Required: ${formatNumber(combinedEstimate.totalTokens)}, Available: ${formatNumber(userTokenBalance)}`);
      return;
    }

    if (storageUsed !== null && combinedEstimate.storageNeeded > ((maxStorageGB * 1024) - storageUsed)) {
      setError(`Insufficient storage space. Required: ${combinedEstimate.storageNeeded} MB, Available: ${formatStorageSize((maxStorageGB * 1024) - storageUsed)}`);
      return;
    }

    setGenerationState('generating');
    setCurrentPhase('prompts');
    setImagePromptProgress(0);
    setImageGenerationProgress(0);
    setStatusMessage('Preparing image prompts generation...');
    setProgress(0);
    setTimeRemaining(null);
    generationStartTime.current = Date.now();

    try {
      if (!checkNetworkStatus()) throw new Error('No internet connection');
      const { data: { user } } = await withRetry(
        () => withTimeout(supabase.auth.getUser(), OPERATION_TIMEOUT, 'getUser'),
        'getUser'
      );
      if (!user) throw new Error('User not authenticated');
      setCurrentUserId(user.id);

      // Get session access token for secure API calls
      const { data: { session: _authSession } } = await supabase.auth.getSession();
      const _accessToken = _authSession?.access_token;
      if (!_accessToken) throw new Error('Session expired. Please sign in again.');

      // Determine which document to use
      let doc: StoryDocument | undefined;
      if (newPromptsDoc) {
        doc = documents.find(doc => doc.id === newPromptsDoc);
      } else if (uploadedDoc) {
        const uploadedDocName = uploadedDoc.name.replace(/\.txt$/, '');
        doc = documents.find(doc => doc.title === uploadedDocName);
      }
      
      if (!doc) throw new Error('Selected document not found');

      // Use the document's existing group_id instead of generating a new one
      const groupId = doc.group_id || uuidv4();
      setCombinedGroupId(groupId);
      setGeneratedGroupId(groupId);
      setGeneratedDocTitle(doc.title);

      // Create both tab rows for combined workflow tracking
      // 1. image_prompt tab with process_image=TRUE (tracks prompt generation)
      await createTab(
        user.id,
        'image_prompt',
        currentTab,
        groupId,
        `Tab ${currentTab}`,
        undefined,
        true  // process_image=TRUE
      );

      // 2. image tab with process_image=FALSE (tracks image generation - starts idle)
      await createTab(
        user.id,
        'image',
        currentTab,
        groupId,
        `Tab ${currentTab}`,
        undefined,
        false  // process_image=FALSE
      );

      // Save document info to both tabs
      await updateTabGroupAndDoc(
        user.id,
        'image_prompt',
        currentTab,
        groupId,
        doc.id,
        doc.title,
        doc.description || ''
      );
      await updateTabGroupAndDoc(
        user.id,
        'image',
        currentTab,
        groupId,
        doc.id,
        doc.title,
        doc.description || ''
      );

      // Update image_prompt tab status to generating (with process_image=TRUE for combined workflow)
      await updateTabStatus(user.id, 'image_prompt', currentTab, 'generating', groupId, `Tab ${currentTab}`, true);

      // Check for existing variants across all image-related versions (3, 4, 5, 6)
      let variant = 1;
      const { data: existingDocs, error: fetchVariantError } = await supabase
        .from('story_documents')
        .select('variant')
        .eq('group_id', groupId)
        .eq('user_id', user.id)
        .in('version', [3, 4, 5, 6])
        .order('variant', { ascending: false });
      
      if (fetchVariantError) {
        throw new Error(`Failed to fetch existing variants: ${fetchVariantError.message}`);
      }
      
      if (existingDocs && existingDocs.length > 0) {
        const highestVariant = Math.max(...existingDocs.map(doc => doc.variant || 0));
        variant = highestVariant + 1;
      }

      // Set initializing state to show loading during task creation
      setIsInitializingTasks(true);

      // Call setupImagePromptTasks with processImage: true
      const response = await withRetry(
        () => withTimeout(
          fetchWithFallback('https://storyscriptai-setup-prompt.storyscriptai.deno.net', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${_accessToken}`,
            },
            body: JSON.stringify({
              user_id: user.id,
              group_id: groupId,
              file_path: doc.file_path,
              story_title: doc.title,
              description: doc.description || '',
              style: newPromptsSettings.style,
              useCharacterDescriptions: newPromptsSettings.useCharacterDescriptions,
              customCharactersEnabled: newPromptsSettings.customCharactersEnabled,
              customCharacters: newPromptsSettings.customCharactersEnabled 
                ? newPromptsSettings.customCharacters.filter(c => c.name.trim()) 
                : [],
              customCharactersAIEnhance: newPromptsSettings.customCharactersAIEnhance,
              // For consistent mode, send null for firstPageFrequency to ensure all segments are treated equally
              firstPageFrequency: (newPromptsSettings.frequencyType === 'consistent') ? null : parseFloat(newPromptsSettings.firstPageFrequency),
              // For consistent mode, use consistentFrequency value as restFrequency
              restFrequency: (newPromptsSettings.frequencyType === 'consistent' && newPromptsSettings.consistentFrequency) 
                ? parseFloat(newPromptsSettings.consistentFrequency) 
                : parseFloat(newPromptsSettings.restFrequency),
              variant,
              doc_id: doc.id,
              userTokenBalance,
              imageModel: newPromptsSettings.imageModel,
              language: newPromptsSettings.language,
              model: newPromptsSettings.model,
              processImage: true, // This triggers the combined workflow
              tab: currentTab, // Pass current tab to ensure correct tab column in image_prompt_tasks
              // Audio mode fields - CRITICAL for correct backend processing
              frequencyMode: newPromptsSettings.frequencyMode || 'wordcount',
              frequencyType: newPromptsSettings.frequencyType || 'consistent',
              consistentFrequency: newPromptsSettings.consistentFrequency ? parseFloat(newPromptsSettings.consistentFrequency) : undefined,
              audioFiles: newPromptsSettings.audioFiles,
              totalAudioDuration: newPromptsSettings.totalAudioDuration,
              imageAmount: newPromptsSettings.imageAmount ? parseInt(newPromptsSettings.imageAmount) : undefined,
              audioDistributionType: newPromptsSettings.audioDistributionType,
              audioFirstPageImageCount: newPromptsSettings.audioFirstPageImageCount ? parseInt(newPromptsSettings.audioFirstPageImageCount) : undefined,
              audioRestImageCount: newPromptsSettings.audioRestImageCount ? parseInt(newPromptsSettings.audioRestImageCount) : undefined,
              // V2 format fields - Enable V2 by default with basic Master Prompt
              promptFormatVersion: 2,
              masterPromptData: {
                fullPrompt: '', // No master prompt by default
                environmentOnly: false,
                characters: [], // Character extraction handled by backend
                styleData: {
                  style: newPromptsSettings.style,
                  description: doc.description || ''
                }
              }
            }),
          }).then(res => {
            setCurrentVariant(variant);
            if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to setup combined tasks`);
            return res.json();
          }),
          OPERATION_TIMEOUT,
          'setupCombinedTasks'
        ),
        'setupCombinedTasks'
      );

      if (response.error) throw new Error(`Setup error: ${response.error}`);

      // Set initial time estimate (prompt generation time + image generation time)
      const promptTime = (response.total_batches || 1) * 90;
      const timePerImage = getTimePerImageInSeconds(newPromptsSettings.imageModel);
      const imageTime = combinedEstimate.totalImages * timePerImage;
      setTimeRemaining(promptTime + imageTime);
      
      setStatusMessage('Generating image prompts...');

    } catch (err: any) {
      setError(err.message || 'An error occurred during combined generation');
      setGenerationState('error');
    }
  };

  const handleSingleImageGenerate = async () => {
    if (!singleImagePrompt || singleImagePrompt.trim() === '') {
      setSingleImageError('Please enter an image prompt');
      return;
    }
    
    const requiredTokens = getTokensForModel(selectedSingleImageModel, IMAGE_MODEL_OPTIONS);
    if (userTokenBalance < requiredTokens) {
      setSingleImageError(`Insufficient tokens. Required: ${formatNumber(requiredTokens)}, Available: ${formatNumber(userTokenBalance)}`);
      return;
    }
    
    // Check storage limits for single image
    if (storageUsed !== null) {
      const availableStorageMB = (maxStorageGB * 1024) - storageUsed;
      if (IMAGE_SIZE_MB > availableStorageMB) {
        setSingleImageError(`Insufficient storage space. Required: ${IMAGE_SIZE_MB} MB, Available: ${formatStorageSize(availableStorageMB)}`);
        return;
      }
    }
    
    setSingleImageError(null);
    setSingleImageState('generating');
    setStatusMessage('Generating single image...');
    setProgress(0);
    generationStartTime.current = Date.now();
    try {
      if (!checkNetworkStatus()) throw new Error('No internet connection');
      const { data: { user } } = await withRetry(
        () => withTimeout(supabase.auth.getUser(), OPERATION_TIMEOUT, 'getUser'),
        'getUser'
      );
      if (!user) throw new Error('User not authenticated');
      setCurrentUserId(user.id);
      const { data: { session } } = await withRetry(
        () => withTimeout(supabase.auth.getSession(), OPERATION_TIMEOUT, 'getSession'),
        'getSession'
      );
      if (!session) throw new Error('No active session found');
      const groupId = uuidv4();
      setSingleImageGroupId(groupId);
      const response = await withRetry(
        () => withTimeout(
          fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/single-image`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              user_id: user.id,
              prompt: singleImagePrompt,
              image_style: selectedSingleImageStyle,
              group_id: groupId,
              story_title: 'Single Image',
              image_model: selectedSingleImageModel,
              tab: currentTab,
            }),
          }).then(async res => {
            // Handle Flux background processing with 202 response
            if (res.status === 202) {
              const data = await res.json();
              if (selectedSingleImageModel === 'spark') {
                setStatusMessage('Flux processing in background (4-5 minutes). You can continue working, the image will appear when ready.');
              }
              return { status: 202, message: data.message || 'Processing in background' };
            }
            if (!res.ok) return res.json().then(errorData => { throw new Error(`Failed to generate single image: ${errorData.error || 'Unknown error'}`); });
            return res.json();
          }),
          OPERATION_TIMEOUT,
          'generateSingleImage'
        ),
        'generateSingleImage'
      );
      if (response.error) throw new Error(`Generation error: ${response.error}`);
      // For 202 responses, polling will detect completion automatically
      if (response.status === 202) {
        // Polling already started via fetchTasksForPolling below
      }
      await fetchTasksForPolling(groupId); // Pass groupId directly to avoid state update delay
    } catch (err: any) {
      setSingleImageError(err.message || 'An error occurred during single image generation');
      setSingleImageState('error');
    }
  };

  const handleSingleImageDone = async () => {
    try {
      if (!currentUserId) throw new Error('Authentication error');
      if (singleImageGroupId) {
        const { data: task, error: taskError } = await withRetry(
          () => withTimeout(
            supabase
              .from('image_tasks')
              .select('batch_output')
              .eq('user_id', currentUserId)
              .eq('group_id', singleImageGroupId)
              .eq('single_image', true)
              .eq('tab', currentTab)
              .single(),
            OPERATION_TIMEOUT,
            'fetchSingleImageTaskForDeletion'
          ),
          'fetchSingleImageTaskForDeletion'
        );

        if (task && task.batch_output && !taskError) {
          const imagePath = task.batch_output.match(/https:\/\/[^\s]+/)?.[0];
          if (imagePath) {
            const folderPath = imagePath
              .replace(`${import.meta.env.SUPABASE_URL}/storage/v1/object/public/stories/`, '')
              .replace(/\/[^/]+\.png$/, '');
            const { data: files, error: listError } = await withRetry(
              () => withTimeout(
                supabase.storage.from('stories').list(folderPath, { recursive: true }),
                OPERATION_TIMEOUT,
                'listSingleImageFolderForDeletion'
              ),
              'listSingleImageFolderForDeletion'
            );

            if (listError) {
              console.error(`Failed to list single image folder for deletion: ${folderPath}: ${listError.message}`);
            } else {
              const filePaths = files.map(file => `${folderPath}/${file.name}`);
              if (filePaths.length > 0) {
                const { error: storageDeleteError } = await withRetry(
                  () => withTimeout(
                    supabase.storage.from('stories').remove(filePaths),
                    OPERATION_TIMEOUT,
                    'deleteSingleImageFolderFiles'
                  ),
                  'deleteSingleImageFolderFiles'
                );
                if (storageDeleteError) {
                  console.error(`Failed to delete single image folder: ${folderPath}: ${storageDeleteError.message}`);
                }
              }
            }
          }
        }

        await withRetry(
          () => withTimeout(
            supabase
              .from('image_tasks')
              .delete()
              .eq('user_id', currentUserId)
              .eq('group_id', singleImageGroupId)
              .eq('single_image', true)
              .eq('tab', currentTab),
            OPERATION_TIMEOUT,
            'deleteSingleImageTask'
          ),
          'deleteSingleImageTask'
        );
      }

      setSingleImageState('idle');
      setSingleImagePrompt('');
      setSingleImageUrl(null);
      setSingleImageError(null);
      setSingleImageGroupId(null);
      setStatusMessage('');
      setProgress(0);
    } catch (err: any) {
      setSingleImageError(`Failed to complete operation: ${err.message}`);
      setSingleImageState('error');
    }
  };

  const handleDownloadSingleImage = async () => {
    if (!singleImageUrl) return;
    try {
      const response = await fetch(singleImageUrl);
      if (!response.ok) throw new Error('Failed to fetch image');
      const blob = await response.blob();
      saveAs(blob, 'single_image.png');
    } catch (err: any) {
      setSingleImageError(`Failed to download image: ${err.message}`);
      setSingleImageState('error');
    }
  };

  const handleDone = async () => {
    try {
      if (!currentUserId) throw new Error('Authentication error');

      // Immediately update UI to idle state before cleanup
      // (React state setters don't change the current closure's variables,
      // so the generationState check below still reads the old value)
      setGenerationState('idle');

      // Update tab status immediately (fire-and-forget like TTS page)
      if (currentUserId) {
        resetImageGeneratorTabToDefaults(currentUserId, currentTab).catch(() => {});
        updateTabStatus(currentUserId, 'image', currentTab, 'idle', null, `Tab ${currentTab}`).catch(() => {});
        updateTabStatus(currentUserId, 'image_prompt', currentTab, 'idle', null, `Tab ${currentTab}`, false).catch(() => {});
        updateTabStatus(currentUserId, 'image_prompt', currentTab, 'idle', null, `Tab ${currentTab}`, true).catch(() => {});
      }

      if (generationState === 'analyzing' || generationState === 'generating') {
        // Handle regular workflow cleanup
        if (currentGroupId) {
          setIsDeletingImages(true);
          try {
            // Get story_title and folder_timestamp from tasks to delete images
            let taskQuery = supabase
              .from('image_tasks')
              .select('story_title, folder_timestamp')
              .eq('user_id', currentUserId)
              .eq('group_id', currentGroupId)
              .eq('tab', currentTab)
              .eq('single_image', false)
              .or('video_process.is.null,video_process.eq.false')
              .or('itv.is.null,itv.eq.false')
              .limit(1);

            if (currentVariant !== null) {
              taskQuery = taskQuery.eq('variant', currentVariant);
            }

            const { data: task, error: taskError } = await withRetry(
              () => withTimeout(
                taskQuery.maybeSingle(),
                OPERATION_TIMEOUT,
                'fetchImageTaskForDeletion'
              ),
              'fetchImageTaskForDeletion'
            );

            if (task && task.story_title && task.folder_timestamp && !taskError) {
              // Sanitize title using same pattern as edge functions
              const sanitizedTitle = sanitizeTitle(task.story_title);
              // Construct folder path using title + folder_timestamp
              const folderPath = `documents/${currentUserId}/${currentGroupId}/${sanitizedTitle}_${task.folder_timestamp}`;
              
              console.log(`[ImageGenerator] Attempting to delete folder: ${folderPath}`);
              
              const { data: files, error: listError } = await withRetry(
                () => withTimeout(
                  supabase.storage.from('stories').list(folderPath, { recursive: true }),
                  OPERATION_TIMEOUT,
                  'listFolderForDeletion'
                ),
                'listFolderForDeletion'
              );

              if (listError) {
                console.error(`Failed to list folder for deletion: ${folderPath}: ${listError.message}`);
              } else if (files && files.length > 0) {
                // Storage API limit: 1000 objects at a time
                const filesToDelete = files.slice(0, 1000);
                const filePaths = filesToDelete.map(file => `${folderPath}/${file.name}`);
                console.log(`[ImageGenerator] Deleting ${filePaths.length} files from ${folderPath}`);
                
                const { error: storageDeleteError } = await withRetry(
                  () => withTimeout(
                    supabase.storage.from('stories').remove(filePaths),
                    OPERATION_TIMEOUT,
                    'deleteFolderFiles'
                  ),
                  'deleteFolderFiles'
                );
                if (storageDeleteError) {
                  console.error(`Failed to delete folder: ${folderPath}: ${storageDeleteError.message}`);
                } else {
                  console.log(`[ImageGenerator] Successfully deleted images from ${folderPath}`);
                }
              } else {
                console.log(`[ImageGenerator] No files found in folder: ${folderPath}`);
              }
            }
          } finally {
            setIsDeletingImages(false);
          }
        }

        // Handle combined workflow cleanup
        if (combinedGroupId) {
          // First, delete images from storage (same as currentGroupId path)
          try {
            // Get story_title and folder_timestamp from image_tasks to delete images
            let taskQuery = supabase
              .from('image_tasks')
              .select('story_title, folder_timestamp')
              .eq('user_id', currentUserId)
              .eq('group_id', combinedGroupId)
              .eq('tab', currentTab)
              .eq('single_image', false)
              .or('video_process.is.null,video_process.eq.false')
              .or('itv.is.null,itv.eq.false')
              .limit(1);

            if (currentVariant !== null) {
              taskQuery = taskQuery.eq('variant', currentVariant);
            }

            const { data: task, error: taskError } = await withRetry(
              () => withTimeout(
                taskQuery.maybeSingle(),
                OPERATION_TIMEOUT,
                'fetchImageTaskForDeletion'
              ),
              'fetchImageTaskForDeletion'
            );

            if (task && task.story_title && task.folder_timestamp && !taskError) {
              // Sanitize title using same pattern as edge functions
              const sanitizedTitle = sanitizeTitle(task.story_title);
              // Construct folder path using title + folder_timestamp
              const folderPath = `documents/${currentUserId}/${combinedGroupId}/${sanitizedTitle}_${task.folder_timestamp}`;
              
              console.log(`[ImageGenerator] Attempting to delete combined folder: ${folderPath}`);
              
              const { data: files, error: listError } = await withRetry(
                () => withTimeout(
                  supabase.storage.from('stories').list(folderPath, { recursive: true }),
                  OPERATION_TIMEOUT,
                  'listFolderForDeletion'
                ),
                'listFolderForDeletion'
              );

              if (listError) {
                console.error(`Failed to list folder for deletion: ${folderPath}: ${listError.message}`);
              } else if (files && files.length > 0) {
                // Storage API limit: 1000 objects at a time
                const filesToDelete = files.slice(0, 1000);
                const filePaths = filesToDelete.map(file => `${folderPath}/${file.name}`);
                console.log(`[ImageGenerator] Deleting ${filePaths.length} files from ${folderPath}`);
                
                const { error: storageDeleteError } = await withRetry(
                  () => withTimeout(
                    supabase.storage.from('stories').remove(filePaths),
                    OPERATION_TIMEOUT,
                    'deleteFolderFiles'
                  ),
                  'deleteFolderFiles'
                );
                if (storageDeleteError) {
                  console.error(`Failed to delete folder: ${folderPath}: ${storageDeleteError.message}`);
                } else {
                  console.log(`[ImageGenerator] Successfully deleted images from ${folderPath}`);
                }
              } else {
                console.log(`[ImageGenerator] No files found in folder: ${folderPath}`);
              }
            }
          } catch (err: any) {
            console.error(`Error deleting images for combinedGroupId: ${err.message}`);
          }

          // Then delete the database tasks
          let deletePromptQuery = supabase
            .from('image_prompt_tasks')
            .delete()
            .eq('user_id', currentUserId)
            .eq('group_id', combinedGroupId)
            .eq('process_image', true)
            .eq('tab', currentTab)
            .or('video_process.is.null,video_process.eq.false')
            .or('itv.is.null,itv.eq.false');

          if (currentVariant !== null) {
            deletePromptQuery = deletePromptQuery.eq('variant', currentVariant);
          }

          await withRetry(
            () => withTimeout(
              deletePromptQuery,
              OPERATION_TIMEOUT,
              'deleteImagePromptTasks'
            ),
            'deleteImagePromptTasks'
          );
        }
      }

      // Delete image_prompt_tasks and image_prompt_context
      // Use combinedGroupId for combined workflow, or currentGroupId for regular workflow
      const promptGroupId = combinedGroupId || currentGroupId;
      if (promptGroupId) {
        let deletePromptQuery = supabase
          .from('image_prompt_tasks')
          .delete()
          .eq('user_id', currentUserId)
          .eq('group_id', promptGroupId)
          .eq('process_image', true)
          .eq('tab', currentTab)
          .or('video_process.is.null,video_process.eq.false');

        if (currentVariant !== null) {
          deletePromptQuery = deletePromptQuery.eq('variant', currentVariant);
        }

        await withRetry(
          () => withTimeout(
            deletePromptQuery,
            OPERATION_TIMEOUT,
            'deleteProcessImagePromptTasks'
          ),
          'deleteProcessImagePromptTasks'
        );

        // Delete image_prompt_context directly using promptGroupId
        // (must NOT re-query image_prompt_tasks after deleting them above)
        await withRetry(
          () => withTimeout(
            supabase
              .from('image_prompt_context')
              .delete()
              .eq('group_id', promptGroupId),
            OPERATION_TIMEOUT,
            'deleteImagePromptContext'
          ),
          'deleteImagePromptContext'
        );
      }

      // Delete image_tasks
      let deleteTaskQuery = supabase
        .from('image_tasks')
        .delete()
        .eq('user_id', currentUserId)
        .eq('single_image', false)
        .eq('tab', currentTab)
        .or('video_process.is.null,video_process.eq.false')
        .or('itv.is.null,itv.eq.false');

      if (currentVariant !== null) {
        deleteTaskQuery = deleteTaskQuery.eq('variant', currentVariant);
      }

      await withRetry(
        () => withTimeout(
          deleteTaskQuery,
          OPERATION_TIMEOUT,
          'deleteUserTasks'
        ),
        'deleteUserTasks'
      );

      // Reset all state
      setError(null);
      setAnalysisResult(null);
      setProgress(0);
      setTimeRemaining(null);
      setStatusMessage('');
      setGeneratedFileName('');
      setGeneratedDocTitle('');
      setGeneratedGroupId(null);
      setCurrentGroupId(null);
      setBatchStatuses([]);
      setSelectedDoc('');
      setGeneratedImages([]);
      setImageTasks([]);
      setRedoingImage(null);
      setImageLoadingStates([]);
      setCurrentVariant(null);
      setIsDeletingImages(false);
      
      // Reset combined workflow state
      setSelectedMode('new');
      setNewPromptsDoc('');
      setCombinedEstimate(null);
      setCurrentPhase('prompts');
      setImagePromptProgress(0);
      setImageGenerationProgress(0);
      setCombinedGroupId(null);

      setImagePromptTasks([]);
      
      // Reset file upload state
      setUploadedDoc(null);
      setUploadError(null);
      
      // Clear session storage
      window.sessionStorage.removeItem('imageGenUploadedDoc');
      
      generationStartTime.current = null;
    } catch (err: any) {
      setError(`Failed to complete operation: ${err.message}`);
      setGenerationState('error');
    }
  };

  const handleDownloadFolderAsZip = async () => {
    try {
      setIsDownloadingZip(true);
      const { data: imageDoc, error: docError } = await supabase
        .from('story_documents')
        .select('file_path, title')
        .eq('group_id', currentGroupId || combinedGroupId)
        .eq('user_id', currentUserId)
        .in('version', [5, 6])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (docError || !imageDoc) {
        throw new Error(`Failed to find image output document: ${docError?.message || 'No image output document found'}`);
      }
      const folderPath = imageDoc.file_path;
      let allFiles: any[] = [];
      const LIST_LIMIT = 100;
      let offset = 0;
      let hasMore = true;
  
      // Fetch all files with pagination
      while (hasMore) {
        const { data: files, error: listError } = await supabase.storage
          .from('stories')
          .list(folderPath, { limit: LIST_LIMIT, offset });
        if (listError) {
          throw new Error(`Failed to list files in folder: ${listError.message}`);
        }
        allFiles = allFiles.concat(files);
        if (files.length < LIST_LIMIT) {
          hasMore = false;
        } else {
          offset += LIST_LIMIT;
        }
      }
  
      const imageFiles = allFiles.filter(file => file.name.endsWith('.png'));
      console.log(`Total .png files found in folder ${folderPath}: ${imageFiles.length}`);
      if (imageFiles.length === 0) {
        setError('No images found in this folder');
        return;
      }
  
      const zip = new JSZip();
      let filesAdded = 0;
      const BATCH_SIZE = 50;
      for (let i = 0; i < imageFiles.length; i += BATCH_SIZE) {
        const batch = imageFiles.slice(i, i + BATCH_SIZE);
        const signedUrls = await Promise.all(
          batch.map(async (file) => {
            const { data: signedUrlData, error: signedUrlError } = await supabase.storage
              .from('stories')
              .createSignedUrl(`${folderPath}/${file.name}`, 60);
            if (signedUrlError) {
              console.error(`Failed to generate signed URL for ${file.name}:`, signedUrlError);
              return null;
            }
            return { fileName: file.name, signedUrl: signedUrlData.signedUrl };
          })
        );
        const validSignedUrls = signedUrls.filter((item): item is { fileName: string; signedUrl: string } => item !== null);
        for (const { fileName, signedUrl } of validSignedUrls) {
          const response = await fetch(signedUrl);
          if (!response.ok) {
            console.error(`Failed to fetch file ${fileName}`);
            continue;
          }
          const blob = await response.blob();
          zip.file(fileName, blob);
          filesAdded++;
        }
      }
      console.log(`Total files added to ZIP: ${filesAdded} out of ${imageFiles.length}`);
      if (filesAdded !== imageFiles.length) {
        console.warn(`Warning: Not all files were added to the ZIP. Expected ${imageFiles.length}, but added ${filesAdded}`);
        setError(`Failed to include all files in the ZIP. Added ${filesAdded} out of ${imageFiles.length} files.`);
      } else {
        console.log('All files successfully added to the ZIP.');
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      saveAs(zipBlob, `${imageDoc.title}.zip`);
    } catch (err: any) {
      console.error('Error in handleDownloadFolderAsZip:', err);
      setError(err.message || 'Failed to download folder as ZIP');
    } finally {
      setIsDownloadingZip(false);
    }
  };

  const handleRedo = async (index: number, feedback = '') => {
    if (!currentUserId || userTokenBalance < 42000 || !currentGroupId) return;
    const batchNumber = index + 1;
    setRedoingImage(batchNumber);
    setStatusMessage(`Redoing image ${batchNumber}. This could take 1–3 minutes.`);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No active session found');
      const response = await withRetry(
        () => withTimeout(
          fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/redo-image`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              user_id: currentUserId,
              group_id: currentGroupId,
              batch_number: batchNumber,
              feedback,
            }),
          }).then(async res => {
            // Handle Flux background processing with 202 response
            if (res.status === 202) {
              const data = await res.json();
              return { status: 202, message: data.message || 'Processing in background' };
            }
            if (!res.ok) return res.json().then(errorData => { throw new Error(`Failed to trigger redo: ${errorData.error || 'Unknown error'}`); });
            return res.json();
          }),
          OPERATION_TIMEOUT,
          `redoImage_${batchNumber}`
        ),
        `redoImage_${batchNumber}`
      );

      // For Flux 202 responses, update message and let polling detect completion
      if (response.status === 202) {
        setStatusMessage(`Redoing image ${batchNumber} with Flux in background (4-5 minutes). You can continue working.`);
        // Existing polling loop below will automatically detect completion
      }

      const maxWaitTime = 180000;
      const pollInterval = 5000;
      const startTime = Date.now();
      let taskCompleted = false;

      while (Date.now() - startTime < maxWaitTime && !taskCompleted) {
        const { data: tasks, error } = await withRetry(
          () => withTimeout(
            supabase
              .from('image_tasks')
              .select('id,story_title,total_batches,batch_number,progress,error,status,group_id,updated_at,batch_output,single_image,check_stuck,redo_status,redo_started_at')
              .eq('user_id', currentUserId)
              .eq('group_id', currentGroupId)
              .eq('batch_number', batchNumber)
              .eq('tab', currentTab)
              .eq('single_image', false)
              .single(),
            OPERATION_TIMEOUT,
            `pollRedoTask_${batchNumber}`
          ),
          `pollRedoTask_${batchNumber}`
        );

        if (error || !tasks) {
          throw new Error(`Failed to fetch task status: ${error?.message || 'No task found'}`);
        }

        setImageTasks((prevTasks) =>
          prevTasks.map((task) =>
            task.id === tasks.id ? { ...task, ...tasks } : task
          )
        );

        // Check if redo is complete (redo_status is null and batch_output is updated)
        if (!tasks.redo_status && tasks.status === 'completed_final' && tasks.batch_output) {
          taskCompleted = true;
          const imagePath = tasks.batch_output.match(/https:\/\/[^\s]+/)?.[0];
          if (!imagePath) throw new Error('No valid image URL in batch_output');
          const { data: signedUrlData, error: signedUrlError } = await withRetry(
            () => withTimeout(
              supabase.storage
                .from('stories')
                .createSignedUrl(imagePath.replace(`${import.meta.env.SUPABASE_URL}/storage/v1/object/public/stories/`, ''), 60),
              OPERATION_TIMEOUT,
              `createSignedUrl_redo_${batchNumber}`
            ),
            `createSignedUrl_redo_${batchNumber}`
          );
          if (signedUrlError) throw signedUrlError;
          setGeneratedImages((prev) => {
            const newImages = [...prev];
            newImages[batchNumber - 1] = signedUrlData.signedUrl;
            return newImages;
          });
          setRedoingImage(null);
          setStatusMessage('Image generation tasks complete!');
        } else if (tasks.status === 'error') {
          throw new Error(tasks.error || 'Redo task failed');
        } else {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
      }

      if (!taskCompleted) {
        throw new Error('Redo operation timed out after 3 minutes');
      }
    } catch (error: any) {
      console.error('Error triggering redo:', error);
      setError(`Failed to redo image ${batchNumber}: ${error.message}`);
      setRedoingImage(null);
      setStatusMessage('Image generation tasks complete!');
    }
  };

  // Expose cleanup method to parent container via ref
  useImperativeHandle(ref, () => ({
    cleanup: async () => {
      console.log(`[ImageGenerator Tab ${currentTab}] Cleanup called`);
      try {
        if (!currentUserId) return;

        // Check if any images are completed_final (don't delete those)
        const { data: completedTasks } = await supabase
          .from('image_tasks')
          .select('status')
          .eq('user_id', currentUserId)
          .eq('tab', currentTab)
          .eq('single_image', false)
          .eq('status', 'completed_final')
          .limit(1);

        const hasCompletedFinal = completedTasks && completedTasks.length > 0;

        if (!hasCompletedFinal) {
          // Act like Stop button: delete tasks and images if not completed_final
          
          // Delete generated images from storage using story_title + folder_timestamp
          if (currentGroupId) {
            let taskQuery = supabase
              .from('image_tasks')
              .select('story_title, folder_timestamp')
              .eq('user_id', currentUserId)
              .eq('group_id', currentGroupId)
              .eq('tab', currentTab)
              .eq('single_image', false)
              .or('video_process.is.null,video_process.eq.false')
              .or('itv.is.null,itv.eq.false')
              .limit(1);

            if (currentVariant !== null) {
              taskQuery = taskQuery.eq('variant', currentVariant);
            }

            const { data: task } = await taskQuery.maybeSingle();

            if (task && task.story_title && task.folder_timestamp) {
              // Sanitize title using same pattern as edge functions
              const sanitizedTitle = sanitizeTitle(task.story_title);
              // Construct folder path using title + folder_timestamp
              const folderPath = `documents/${currentUserId}/${currentGroupId}/${sanitizedTitle}_${task.folder_timestamp}`;
              
              console.log(`[ImageGenerator Tab ${currentTab}] Attempting to delete folder: ${folderPath}`);
              
              const { data: files } = await supabase.storage.from('stories').list(folderPath, { recursive: true });
              if (files && files.length > 0) {
                // Storage API limit: 1000 objects at a time
                const filesToDelete = files.slice(0, 1000);
                const filePaths = filesToDelete.map(file => `${folderPath}/${file.name}`);
                console.log(`[ImageGenerator Tab ${currentTab}] Deleting ${filePaths.length} files`);
                await supabase.storage.from('stories').remove(filePaths);
                console.log(`[ImageGenerator Tab ${currentTab}] Deleted images from storage: ${folderPath}`);
              } else {
                console.log(`[ImageGenerator Tab ${currentTab}] No files found in folder: ${folderPath}`);
              }
            }
          }

          // Delete image_prompt_tasks
          if (combinedGroupId) {
            let deletePromptQuery = supabase
              .from('image_prompt_tasks')
              .delete()
              .eq('user_id', currentUserId)
              .eq('group_id', combinedGroupId)
              .eq('process_image', true)
              .eq('tab', currentTab)
              .or('video_process.is.null,video_process.eq.false')
              .or('itv.is.null,itv.eq.false');

            if (currentVariant !== null) {
              deletePromptQuery = deletePromptQuery.eq('variant', currentVariant);
            }

            await deletePromptQuery;
            console.log(`[ImageGenerator Tab ${currentTab}] Deleted image_prompt_tasks`);

            // Delete image_prompt_context for the same group
            await supabase
              .from('image_prompt_context')
              .delete()
              .eq('group_id', combinedGroupId);
            console.log(`[ImageGenerator Tab ${currentTab}] Deleted image_prompt_context`);
          }

          // Delete image_tasks
          let deleteTaskQuery = supabase
            .from('image_tasks')
            .delete()
            .eq('user_id', currentUserId)
            .eq('single_image', false)
            .eq('tab', currentTab)
            .or('video_process.is.null,video_process.eq.false')
            .or('itv.is.null,itv.eq.false');

          if (currentVariant !== null) {
            deleteTaskQuery = deleteTaskQuery.eq('variant', currentVariant);
          }

          await deleteTaskQuery;
          console.log(`[ImageGenerator Tab ${currentTab}] Deleted image_tasks`);
        } else {
          console.log(`[ImageGenerator Tab ${currentTab}] Images are completed_final, keeping them`);
        }

        // Delete tabs table entries
        await deleteTabFromDB(currentUserId, 'image', currentTab);
        await deleteTabFromDB(currentUserId, 'image_prompt', currentTab);
        console.log(`[ImageGenerator Tab ${currentTab}] Deleted tabs table entries`);

        // Reset currentVariant after cleanup
        setCurrentVariant(null);

        console.log(`[ImageGenerator Tab ${currentTab}] Cleanup complete`);
      } catch (error) {
        console.error(`[ImageGenerator Tab ${currentTab}] Error during cleanup:`, error);
      }
    },
  }), [currentTab, currentUserId, currentGroupId, combinedGroupId]);

  if (loading || !planLoaded) {
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
          <div className="absolute top-60 right-0 w-[35%] h-[250px] bg-[radial-gradient(ellipse_80%_80%_at_80%_50%,rgba(168,85,247,0.06)_0%,transparent_60%)]" />
        </div>

        <div className={userPlan === 'free' ? 'relative' : ''}>
          {userPlan === 'free' && (
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-12 z-50">
              <div className="rounded-2xl bg-surface-card border border-border-card p-8 max-w-md w-full shadow-[0_0_40px_rgba(220,38,38,0.08)]">
                <div className="flex items-center gap-3 mb-3">
                  <div className="pipeline-icon-circle inline-flex items-center justify-center w-10 h-10 rounded-full bg-accent/5">
                    <Lock className="h-5 w-5 text-accent-text" />
                  </div>
                  <h2 className="text-lg sm:text-xl font-display font-semibold text-white">Paid Feature</h2>
                </div>
                <p className="text-sm text-text-muted mb-6 leading-relaxed">Image Generator requires a paid plan. Upgrade to unlock image generation, video tools, and more.</p>
                <button
                  onClick={() => navigate('../Pricing')}
                  className="w-full flex justify-center items-center gap-2 px-6 py-3 bg-accent text-white rounded-xl hover:bg-accent-hover transition-all duration-200 text-sm font-medium hover:scale-[1.01] active:scale-[0.99]"
                >
                  View Plans
                </button>
              </div>
            </div>
          )}
          <div className={userPlan === 'free' ? 'opacity-50 pointer-events-none' : ''}>
            <div className="relative mb-8 dash-animate-in">
              <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Image Generator</h1>
              <div className="mt-2">
                <p className="text-text-secondary">Transform your image prompts into visuals</p>
                <p className="text-text-muted text-sm mt-1">{formatNumber(userTokenBalance)} tokens remaining</p>
                <p className="text-text-muted text-sm mt-0.5">Storage: {storageUsed !== null ? `${formatStorageSize(storageUsed)} / ${maxStorageGB} GB` : 'Calculating...'}</p>
              </div>

              {/* What to Expect info box */}
              <div className="mt-5 p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card dash-animate-in">
                <h3 className="text-xl font-semibold mb-2 text-accent">What to Expect</h3>
                <p className="text-[15px] text-white/80 leading-relaxed">
                  The Image Generator transforms your image prompt documents into visuals tailored to your style. With no manual effort required, it automatically creates consistent images that enhance your stories — perfect for YouTube videos up to 20 hours.
                </p>
                <Link
                  to="/learn#image-generator"
                  className="group relative inline-flex items-center gap-1.5 px-5 py-2.5 mt-3 rounded-xl text-sm font-medium text-white bg-accent transition-all duration-300 hover:bg-accent-hover hover:scale-[1.02] active:scale-[0.98]"
                  style={{
                    boxShadow: '0 0 20px rgba(220,38,38,0.2), 0 0 40px rgba(220,38,38,0.06)',
                  }}
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  Watch tutorial
                </Link>
                <div className="mt-4 pt-4 border-t border-white/10">
                  <p className="text-sm text-text-muted leading-relaxed">
                    Choose an image quality tier — <strong className="text-white/70">Lite &amp; Grok</strong> for budget generation, <strong className="text-white/70">Core &amp; Prime</strong> for balanced quality, or <strong className="text-white/70">Heavy &amp; Genesis</strong> for the highest visual fidelity.
                  </p>
                </div>
              </div>

              {/* Multi-Tab Manager for Premium Users (Elite, Ultimate, Enterprise) */}
              {isEnterpriseUser && currentUserId && (
                <TabManager
                  userId={currentUserId}
                  isEnterpriseUser={isEnterpriseUser}
                  initialTabs={initialTabs}
                  currentTab={currentTab}
                  page="image"
                  onTabChange={onTabChange}
                  onTabCreate={onTabCreate}
                  onTabClose={onTabClose}
                  activeTabStatus={generationState === 'generating' || generationState === 'analyzing' ? 'generating' : undefined}
                />
              )}

              {/* Blue info box when generating (new workflow) */}
              {(selectedMode === 'new' && (generationState === 'analyzing' || generationState === 'generating')) && (
                <StatusBanner
                  variant="info"
                  className="mt-8"
                  title={
                    generationState === 'analyzing' 
                      ? 'Preparing Generation...' 
                      : currentPhase === 'prompts' 
                        ? 'Generating Image Prompts...' 
                        : 'Generating Images...'
                  }
                  subtitle={<>
                    {statusMessage} ({Math.round(
                      currentPhase === 'prompts' ? imagePromptProgress : imageGenerationProgress
                    )}% complete)
                    {timeRemaining !== null && ` · ${formatTime(timeRemaining)} remaining`}
                  </>}
                />
              )}

              {/* Blue info box when generating (existing workflow) */}
              {(selectedMode === 'existing' && (generationState === 'analyzing' || generationState === 'generating')) && (
                <StatusBanner
                  variant="info"
                  className="mt-8"
                  title={
                    generationState === 'analyzing' 
                      ? 'Analyzing Document...' 
                      : 'Generating Images...'
                  }
                  subtitle={<>
                    {statusMessage} ({Math.round(progress)}% complete)
                    {timeRemaining !== null && ` · ${formatTime(timeRemaining)} remaining`}
                  </>}
                />
              )}

              {generationState === 'complete' && generatedDocTitle && (
                <StatusBanner
                  variant="success"
                  className="mt-8"
                  title={<>{generatedDocTitle} Images are done generating!</>}
                  subtitle="Your images have been successfully generated and are ready for download or use."
                />
              )}
            </div>

            {networkRetrying && (
              <div className="p-5 rounded-2xl border mb-6" style={{ backgroundColor: 'rgba(120,53,15,0.3)', borderColor: 'rgba(180,83,9,0.4)' }}>
                <div className="flex items-center space-x-2 mb-2" style={{ color: 'rgb(251,191,36)' }}>
                  <RefreshCw className="h-5 w-5 animate-spin" />
                  <h3 className="text-lg font-medium">Network Issue</h3>
                </div>
                <p style={{ color: 'rgba(253,230,138,0.8)' }}>Attempting to reconnect to the server. Your generation is still processing in the background. Reload page to see progress.</p>
              </div>
            )}

            {(error || singleImageError) && !error?.includes('Failed to fetch') && (
              <div className="p-5 rounded-2xl bg-[--color-status-error-bg] border border-[--color-status-error-border] mb-6">
                <div className="flex items-center space-x-2 text-status-error mb-2">
                  <AlertCircle className="h-5 w-5" />
                  <h3 className="text-lg font-medium">Error</h3>
                </div>
                <p className="text-status-error/80">{error || singleImageError}</p>
                <div className="flex space-x-4 mt-4">
                  <button
                    onClick={singleImageState !== 'idle' ? handleSingleImageDone : handleDone}
                    disabled={isDeletingImages}
                    className="flex items-center px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isDeletingImages ? (
                      <>
                        <RefreshCw className="h-5 w-5 mr-2 animate-spin" />
                        Deleting...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-5 w-5 mr-2" />
                        Clear
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-6 dash-stagger">
              <div
                className="dash-collapse-grid"
                data-collapsed={(generationState !== 'idle' && generationState !== 'analyzed') || singleImageState !== 'idle' ? 'true' : 'false'}
              >
                <div>
              {/* Mode Selection */}
              <div className="mt-8 mb-6 dash-animate-in">
                <h2 className="text-xl font-semibold text-white mb-4">Mode</h2>
                <PromptModeSelector
                  selectedMode={selectedMode}
                  onModeChange={(mode) => {
                    setSelectedMode(mode);
                    // Reset relevant state when changing modes
                    setError(null);
                    setAnalysisResult(null);
                    setCombinedEstimate(null);
                    setGenerationState('idle');
                    setSelectedDoc('');
                    setNewPromptsDoc('');
                    setUploadedDoc(null);
                    setUploadError(null);
                    // Reset single image state when switching away from individual
                    setSingleImagePrompt('');
                    setSingleImageState('idle');
                    setSingleImageUrl(null);
                    setSingleImageError(null);
                  }}
                  disabled={generationState !== 'idle' || singleImageState !== 'idle'}
                />
              </div>

              {/* Document Selection & Settings — hidden when Individual mode */}
              {selectedMode !== 'individual' && (
              <div>
                <h2 className="text-xl font-semibold text-white mb-2">
                  {selectedMode === 'new' ? 'Select or Upload Story Document' : 'Select Image Prompt Document'}
                </h2>
                <p className="text-text-secondary mb-4">
                  {selectedMode === 'new'
                    ? 'Select one of your Story Documents or upload a .txt file to generate image prompts and images.'
                    : 'Select one of your Image Prompt Documents to generate images.'}
                </p>

                {selectedMode === 'new' ? (
                  <div className="space-y-6">
                    {/* Document Selector Component */}
                    <DocumentSelector
                      documents={documents.filter(doc => !doc.is_prompted && (doc.version === 1 || doc.version === 2))}
                      selectedDoc={newPromptsDoc}
                      onDocChange={async (docId) => {
                        setNewPromptsDoc(docId);
                        setUploadedDoc(null);
                        setUploadError(null);
                        
                        // Save selected document and settings to tabs table for combined workflow
                        if (currentUserId && docId) {
                          const doc = documents.find(d => d.id === docId);
                          if (doc) {
                            await updateTabGroupAndDoc(
                              currentUserId,
                              'image_prompt',
                              currentTab,
                              doc.group_id || '',
                              doc.id,
                              doc.title,
                              doc.description || ''
                            );
                            await updateTabGroupAndDoc(
                              currentUserId,
                              'image',
                              currentTab,
                              doc.group_id || '',
                              doc.id,
                              doc.title,
                              doc.description || ''
                            );
                            // Save settings to both tabs
                            await saveImageTabFormInputs(
                              currentUserId,
                              currentTab,
                              {
                                style: newPromptsSettings.style,
                                useCharacterDescriptions: newPromptsSettings.useCharacterDescriptions,
                                firstPageFrequency: parseFloat(newPromptsSettings.firstPageFrequency),
                                restFrequency: parseFloat(newPromptsSettings.restFrequency),
                                imageModel: newPromptsSettings.imageModel,
                                language: newPromptsSettings.language,
                                model: newPromptsSettings.model,
                                frequencyMode: newPromptsSettings.frequencyMode,
                                frequencyType: newPromptsSettings.frequencyType,
                                consistentFrequency: newPromptsSettings.consistentFrequency ? parseInt(newPromptsSettings.consistentFrequency) : undefined,
                                audioDistributionType: newPromptsSettings.audioDistributionType,
                                firstPageImageAmount: newPromptsSettings.audioFirstPageImageCount ? parseInt(newPromptsSettings.audioFirstPageImageCount) : undefined,
                                restImageAmount: newPromptsSettings.audioRestImageCount ? parseInt(newPromptsSettings.audioRestImageCount) : undefined,
                                totalAudioDuration: newPromptsSettings.totalAudioDuration,
                                imageAmount: newPromptsSettings.imageAmount ? parseInt(newPromptsSettings.imageAmount) : undefined,
                              }
                            );
                          }
                        }
                      }}
                      uploadedDoc={uploadedDoc}
                      onUploadedDocChange={setUploadedDoc}
                      onFileUpload={handleFileUpload}
                      uploadingFile={uploadingFile}
                      disabled={generationState !== 'idle' || singleImageState !== 'idle'}
                      error={uploadError}
                    />

                    {/* Updated NewImagePromptsForm */}
                    <NewImagePromptsForm
                      settings={newPromptsSettings}
                      onSettingsChange={setNewPromptsSettings}
                      validationErrors={newPromptsValidationErrors}
                      onValidationErrors={setNewPromptsValidationErrors}
                      estimate={combinedEstimate}
                      onEstimateChange={setCombinedEstimate}
                      disabled={generationState !== 'idle' || singleImageState !== 'idle'}
                      userTokenBalance={userTokenBalance}
                      storageUsed={storageUsed}
                      maxStorageGB={maxStorageGB}
                      wordCount={getWordCountForEstimation()}
                      isGenerating={generationState === 'generating' || generationState === 'analyzing'}
                      userId={currentUserId || ''}
                      selectedStoryGroupId={
                        newPromptsDoc 
                          ? (documents.find(d => d.id === newPromptsDoc)?.group_id || null)
                          : uploadedDoc 
                            ? (documents.find(d => d.title === uploadedDoc.name.replace(/\.txt$/, ''))?.group_id || null)
                            : null
                      }
                      storySource={uploadedDoc ? 'upload' : newPromptsDoc ? 'existing' : 'new'}
                    />
                  </div>
                ) : (
                  <>
                    {/* Model Selection for Document Generation */}
                    <ModelSelector
                      selectedModel={selectedDocumentModel}
                      onModelChange={setSelectedDocumentModel}
                      disabled={generationState !== 'idle' || singleImageState !== 'idle'}
                      type="Document Generation"
                    />
                    
                    {documents.filter(doc => doc.version === 3 || doc.version === 4).length === 0 ? (
                      <p className="text-text-muted">You Have No Image Prompt Documents</p>
                    ) : (
                      <Listbox
                        value={selectedDoc}
                        onChange={async (value) => {
                          setSelectedDoc(value);
                          setAnalysisResult(null);
                          setGenerationState('idle');
                          
                          // Save selected document and settings to tabs table
                          if (currentUserId && value) {
                            const doc = documents.find(d => d.id === value);
                            if (doc) {
                              // Set combinedGroupId so ImageFrequencyConfiguration knows a story is selected
                              setCombinedGroupId(doc.group_id || '');
                              
                              await updateTabGroupAndDoc(
                                currentUserId,
                                'image',
                                currentTab,
                                doc.group_id || '',
                                doc.id,
                                doc.title,
                                doc.description || ''
                              );
                              // Save settings
                              await saveImageTabFormInputs(
                                currentUserId,
                                currentTab,
                                {
                                  style: newPromptsSettings.style,
                                  useCharacterDescriptions: newPromptsSettings.useCharacterDescriptions,
                                  firstPageFrequency: parseFloat(newPromptsSettings.firstPageFrequency),
                                  restFrequency: parseFloat(newPromptsSettings.restFrequency),
                                  imageModel: newPromptsSettings.imageModel,
                                  language: newPromptsSettings.language,
                                  model: newPromptsSettings.model,
                                  frequencyMode: newPromptsSettings.frequencyMode,
                                  frequencyType: newPromptsSettings.frequencyType,
                                  consistentFrequency: newPromptsSettings.consistentFrequency ? parseInt(newPromptsSettings.consistentFrequency) : undefined,
                                  audioDistributionType: newPromptsSettings.audioDistributionType,
                                  firstPageImageAmount: newPromptsSettings.audioFirstPageImageCount ? parseInt(newPromptsSettings.audioFirstPageImageCount) : undefined,
                                  restImageAmount: newPromptsSettings.audioRestImageCount ? parseInt(newPromptsSettings.audioRestImageCount) : undefined,
                                  totalAudioDuration: newPromptsSettings.totalAudioDuration,
                                  imageAmount: newPromptsSettings.imageAmount ? parseInt(newPromptsSettings.imageAmount) : undefined,
                                }
                              );
                            }
                          }
                        }}
                        disabled={generationState !== 'idle' || singleImageState !== 'idle'}
                      >
                        {({ open }) => (
                          <div className="relative">
                            <Listbox.Button className={`relative w-full bg-surface-input border border-white/[0.13] rounded-xl px-5 py-4 text-left text-white/95 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-all duration-200 ${generationState !== 'idle' || singleImageState !== 'idle' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                              <span className="block truncate">
                                {selectedDoc
                                  ? documents.find(doc => doc.id === selectedDoc)?.title
                                  : <span className="italic text-text-muted">None - Select a document</span>}
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
                                {/* None option - allows user to clear selection */}
                                <Listbox.Option
                                  value=""
                                  className={({ active, selected }) =>
                                    `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${
                                      active ? 'bg-white/[0.08] text-white' : 'text-white/80'
                                    } ${selected ? 'font-medium' : 'font-normal'}`
                                  }
                                >
                                  {({ selected }) => (
                                    <>
                                      <div className="flex flex-col">
                                        <span className={`text-sm italic ${selected ? 'font-medium text-white/80' : 'text-text-muted'}`}>
                                          None - Select a document
                                        </span>
                                      </div>
                                      {selected && (
                                        <CheckCircle2 className="h-5 w-5 text-accent-text" />
                                      )}
                                    </>
                                  )}
                                </Listbox.Option>
                                
                                {documents
                                  .filter(doc => doc.version === 3 || doc.version === 4)
                                  .map((doc) => (
                                    <Listbox.Option
                                      key={doc.id}
                                      value={doc.id}
                                      className={({ active, selected }) =>
                                        `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${active ? 'bg-white/[0.08] text-white' : 'text-white/80'} ${selected ? 'font-medium' : 'font-normal'}`
                                      }
                                    >
                                      {({ selected }) => (
                                        <>
                                          <div className="flex flex-col">
                                            <span className={selected ? 'font-medium' : 'font-normal'}>{doc.title}</span>
                                            <span className="text-sm text-text-muted flex items-center">
                                              <Calendar className="h-4 w-4 mr-1" />
                                              {formatDate(doc.created_at)} • {doc.word_count || 0} words
                                            </span>
                                          </div>
                                          {selected && (
                                            <span className="text-accent-text">
                                              <CheckCircle2 className="h-5 w-5" />
                                            </span>
                                          )}
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
                  </>
                )}

                {/* Generate button */}
                {selectedMode === 'new' ? (
                  <button
                    onClick={handleNewPromptsGenerate}
                    disabled={
                      generationState !== 'idle' || 
                      (!newPromptsDoc && !uploadedDoc) || 
                      singleImageState !== 'idle' || 
                      Object.keys(newPromptsValidationErrors).length > 0 ||
                      (combinedEstimate && combinedEstimate.totalTokens > userTokenBalance) ||
                      (storageUsed !== null && combinedEstimate && combinedEstimate.storageNeeded > ((maxStorageGB * 1024) - storageUsed))
                    }
                    className="mt-4 w-full flex justify-center items-center px-4 py-2.5 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <Image className="h-5 w-5 mr-2" />
                    Generate Image Prompts & Images
                  </button>
                ) : (
                  (generationState === 'idle' || generationState === 'analyzed') && (
                    <button
                      onClick={handleAnalyze}
                      disabled={generationState !== 'idle' || !selectedDoc || singleImageState !== 'idle'}
                      className="mt-4 w-full flex justify-center items-center px-4 py-2.5 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {generationState === 'idle' ? (
                        <>
                          <CheckCircle2 className="h-5 w-5 mr-2" />
                          Analyze
                        </>
                      ) : (
                        <>
                          <RefreshCw className="animate-spin h-5 w-5 mr-2" />
                          Analyzing...
                        </>
                      )}
                    </button>
                  )
                )}
              </div>
              )}

              {/* ═══ Individual Prompt Mode ═══ */}
              {selectedMode === 'individual' && (
              <>
              <div className="bg-surface-card rounded-xl p-6">
                <h2 className="text-xl font-semibold text-white mb-4">Individual Image Generation</h2>
                <p className="text-text-muted mb-6">
                  Generate a single image from your own prompt. Perfect for testing different models and styles, or creating one-off images.
                </p>
                <div>
                  <label className="block text-sm font-medium text-white mb-3">Image Prompt</label>
                  <textarea
                    value={singleImagePrompt}
                    onChange={(e) => {
                      setSingleImagePrompt(e.target.value.slice(0, 3000));
                    }}
                    placeholder="Describe the image in detail — subject, setting, lighting, mood, composition…"
                    rows={6}
                    disabled={singleImageState !== 'idle'}
                    className="w-full bg-surface-elevated text-white rounded-md p-3 mb-2 focus:outline-none focus:ring-2 focus:ring-accent-text resize-none"
                  />
                  <div className="flex justify-between text-xs text-text-dim">
                    <span>{singleImagePrompt.length} / 3,000 characters</span>
                  </div>
                </div>
              </div>

              <ImageModelSelector
                selectedModel={selectedSingleImageModel}
                selectedStyle={selectedSingleImageStyle}
                onModelChange={(model) => setSelectedSingleImageModel(model as ImageModel)}
                onStyleChange={setSelectedSingleImageStyle}
                disabled={singleImageState !== 'idle'}
                isLegacy={isLegacy}
              />
                    
              {userTokenBalance < getTokensForModel(selectedSingleImageModel, IMAGE_MODEL_OPTIONS) && singleImagePrompt && (
                <div className="bg-[--color-status-error-bg] border border-[--color-status-error-border] text-status-error p-3 rounded-xl">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-5 w-5 text-[--color-status-error-border]" />
                    <p className="text-sm">
                      You don't have enough tokens. Required: {formatNumber(getTokensForModel(selectedSingleImageModel, IMAGE_MODEL_OPTIONS))} tokens, Available: {formatNumber(userTokenBalance)}
                    </p>
                  </div>
                </div>
              )}
                    
              {storageUsed !== null && (IMAGE_SIZE_MB > ((maxStorageGB * 1024) - storageUsed)) && singleImagePrompt && (
                <div className="bg-[--color-status-error-bg] border border-[--color-status-error-border] text-status-error p-3 rounded-xl">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-5 w-5 text-[--color-status-error-border]" />
                    <p className="text-sm">
                      You don't have enough storage space. Required: {IMAGE_SIZE_MB} MB, Available: {formatStorageSize((maxStorageGB * 1024) - storageUsed)}
                    </p>
                  </div>
                </div>
              )}
                    
              {singleImagePrompt.length >= 3000 && (
                <div className="bg-[--color-status-error-bg] border border-[--color-status-error-border] text-status-error p-3 rounded-xl">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-5 w-5 text-[--color-status-error-border]" />
                    <p className="text-sm">
                      Prompt has reached the character limit of 3,000. Current length: {singleImagePrompt.length}. Please shorten the prompt to continue.
                    </p>
                  </div>
                </div>
              )}

              <button
                onClick={handleSingleImageGenerate}
                className="w-full flex justify-center items-center px-4 py-2.5 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                disabled={
                  !singleImagePrompt ||
                  singleImagePrompt.trim() === '' ||
                  singleImageState !== 'idle' ||
                  userTokenBalance < getTokensForModel(selectedSingleImageModel, IMAGE_MODEL_OPTIONS) ||
                  (storageUsed !== null && IMAGE_SIZE_MB > ((maxStorageGB * 1024) - storageUsed)) ||
                  singleImagePrompt.length >= 3000
                }
              >
                <Image className="h-5 w-5 mr-2" />
                Generate Image
              </button>
              </>
              )}

                </div>
              </div>

              {(generationState === 'analyzed' && analysisResult) && (
                <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-5">
                  <h2 className="text-xl font-semibold text-white mb-4">Analysis Estimate</h2>
                  <div className="space-y-4">
                    <div className="rounded-xl bg-surface-input p-4">
                      <p className="text-sm text-text-secondary">Total Images to Generate: {analysisResult.totalImages}</p>
                      <p className="text-sm text-text-secondary">
                        Estimated Token Usage: {formatNumber(
                          analysisResult.totalImages * getTokensForModel(selectedDocumentModel, IMAGE_MODEL_OPTIONS)
                        )} tokens
                      </p>
                      <p className="text-sm text-text-secondary">Required Storage: {analysisResult.totalImages * IMAGE_SIZE_MB} MB</p>
                      
                      {analysisResult && (
                        analysisResult.totalImages * getTokensForModel(selectedDocumentModel, IMAGE_MODEL_OPTIONS)
                      ) > userTokenBalance && (
                        <div className="mt-3 bg-[--color-status-error-bg] border border-[--color-status-error-border] text-status-error p-3 rounded-xl">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="h-5 w-5 text-[--color-status-error-border]" />
                            <p className="text-sm">
                              You don't have enough tokens. Required: {formatNumber(
                                analysisResult.totalImages * getTokensForModel(selectedDocumentModel, IMAGE_MODEL_OPTIONS)
                              )} tokens, Available: {formatNumber(userTokenBalance)}
                            </p>
                          </div>
                        </div>
                      )}
                      
                      {storageUsed !== null && analysisResult.totalImages * IMAGE_SIZE_MB > ((maxStorageGB * 1024) - storageUsed) && (
                        <div className="mt-3 bg-[--color-status-error-bg] border border-[--color-status-error-border] text-status-error p-3 rounded-xl">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="h-5 w-5 text-[--color-status-error-border]" />
                            <p className="text-sm">
                              You don't have enough storage space. Required: {analysisResult.totalImages * IMAGE_SIZE_MB} MB, Available: {formatStorageSize((maxStorageGB * 1024) - storageUsed)}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex justify-end space-x-4">
                      <button
                        onClick={handleDone}
                        className="flex items-center px-4 py-2 bg-white/10 text-white rounded-xl hover:bg-white/15"
                      >
                        <X className="h-5 w-5 mr-2" />
                        Cancel
                      </button>
                      <button
                        onClick={handleContinue}
                        className="flex items-center px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={
                          (analysisResult.totalImages * getTokensForModel(selectedDocumentModel, IMAGE_MODEL_OPTIONS)) > userTokenBalance || 
                          (storageUsed !== null && analysisResult.totalImages * IMAGE_SIZE_MB > ((maxStorageGB * 1024) - storageUsed))
                        }
                      >
                        <CheckCircle2 className="h-5 w-5 mr-2" />
                        Continue
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Combined progress display for new workflow */}
              {selectedMode === 'new' && (generationState === 'analyzing' || generationState === 'generating') && (
                <CombinedProgressDisplay
                  currentPhase={currentPhase}
                  imagePromptProgress={imagePromptProgress}
                  imageGenerationProgress={imageGenerationProgress}
                  statusMessage={statusMessage}
                  timeRemaining={timeRemaining}
                  onStop={handleDone}
                  showStuckWarning={
                    currentPhase === 'prompts' 
                      ? imagePromptTasks.find(task => task.status === 'running')?.check_stuck === true
                      : imageTasks.find(task => task.status === 'running')?.check_stuck === true
                  }
                />
              )}

              {/* Original progress display for existing workflow */}
              {selectedMode === 'existing' && (generationState === 'analyzing' || generationState === 'generating') && (
                <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-5 space-y-4">
                  {generationState === 'analyzing' || (generationState === 'generating' && batchStatuses.length === 0) ? (
                    <>
                      <div className="flex items-center space-x-3 text-text-secondary">
                        <RefreshCw className="h-5 w-5 text-accent animate-pulse" />
                        <span>{statusMessage}</span>
                      </div>
                      <p className="text-sm text-text-secondary">
                        This could take 2–5 minutes.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center space-x-3 text-text-secondary">
                        <RefreshCw className="h-5 w-5 text-accent animate-pulse" />
                        <span>{statusMessage}</span>
                      </div>
                      <div className="flex justify-between text-sm text-text-secondary">
                        <span>Progress</span>
                        <span>{Math.round(progress)}%</span>
                      </div>
                      <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
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
                          <p className="text-sm text-text-muted">
                            If you're returning to the page, give it 30 seconds to correctly show the progress.
                          </p>
                          {imageTasks.some(task => task.status === 'running' && task.check_stuck === true) && (
                            <p className="text-sm text-yellow-300/80">
                              This part may take a little longer, but the progress is moving forward.
                            </p>
                          )}
                        </>
                      )}
                      <div className="flex justify-end">
                        <button
                          onClick={handleDone}
                          className="flex items-center px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover"
                        >
                          <X className="h-5 w-5 mr-2" />
                          Stop
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {generationState === 'complete' && (
                <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-5 space-y-6">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3 text-green-500">
                      <CheckCircle2 className="h-5 w-5 text-green-500" />
                      <span>Image generation tasks complete!</span>
                    </div>
                    <button
                      onClick={handleDone}
                      className="flex items-center px-4 py-2 bg-dark-green-600 text-white rounded-xl hover:bg-dark-green-700"
                    >
                      <CheckCircle2 className="h-5 w-5 mr-2" />
                      Done
                    </button>
                  </div>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between rounded-xl bg-surface-input p-4">
                      <div className="flex items-center space-x-3">
                        <Folder className="h-5 w-5 text-dark-green-600" />
                        <span className="text-white">{generatedDocTitle}</span>
                      </div>
                      <button
                        onClick={handleDownloadFolderAsZip}
                        className={`flex items-center px-3 py-2 rounded-xl transition-colors ${
                          isDownloadingZip
                            ? 'bg-dark-green-700 text-white/40 cursor-not-allowed'
                            : 'bg-dark-green-600 text-white hover:bg-dark-green-700'
                        }`}
                        disabled={isDownloadingZip}
                      >
                        {isDownloadingZip ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-gray-300 mr-2"></div>
                            Downloading...
                          </>
                        ) : (
                          <>
                            <Download className="h-4 w-4 mr-2" />
                            Download ZIP
                          </>
                        )}
                      </button>
                    </div>
                    <div className="rounded-xl bg-surface-card p-4 border border-dark-green-700">
                      <p className="text-lg font-semibold text-white mb-2">
                        Review Your Images
                      </p>
                      <p className="text-text-secondary mb-2">
                        Before finalizing with the Done button, please review all generated images. If any image doesn't meet your expectations, use the Redo button to regenerate it. You can redo one image at a time.
                      </p>
                      <p className="text-text-secondary mb-2">
                        Take a look at the Image Prompt Document to see if the images fit. You can always edit or generate your own image if you're not satisfied, even after retrying.
                      </p>
                      <p className="text-text-secondary mb-2">
                        Once you click Done, the images will be saved to Your Documents in their current state.
                      </p>
                      {userTokenBalance < 42000 && (
                        <p className="text-red-500 font-semibold">
                          Warning: You have {formatNumber(userTokenBalance)} tokens, which is below the required 42,000 to redo images. Please acquire more tokens to proceed with redos.
                        </p>
                      )}
                    </div>
                    {loading ? (
                      <div className="flex flex-col justify-center items-center h-48">
                        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-red-500"></div>
                        <p className="text-text-muted mt-2">Loading images...</p>
                      </div>
                    ) : generatedImages.length > 0 ? (
                      generatedImages.map((url, index) => {
                        const task = imageTasks.find(t => t.batch_number === index + 1 && !t.single_image);
                        const isRedoing = task?.redo_status === 'redoing' || redoingImage === index + 1;
                        return (
                          <div key={index} className="rounded-xl bg-surface-card p-4 border border-dark-green-700">
                            <div className="flex justify-between items-center mb-3">
                              <h3 className="text-lg font-medium text-dark-green-300">
                                {`${index + 1}. ${numberToOrdinal(index + 1)} Image`}
                              </h3>
                              <button
                                onClick={() => setRedoModalIndex(index)}
                                className={`flex items-center px-3 py-1 rounded-xl transition-colors ${
                                  userTokenBalance >= 42000 && !isRedoing && !isDownloadingZip
                                    ? 'bg-white/10 text-white hover:bg-white/15'
                                    : 'bg-white/5 text-white/40 cursor-not-allowed'
                                }`}
                                disabled={userTokenBalance < 42000 || isRedoing || isDownloadingZip}
                              >
                                <RefreshCw className={`h-4 w-4 mr-2 ${isRedoing ? 'animate-spin' : ''}`} />
                                {isRedoing ? 'Redoing...' : 'Redo'}
                              </button>
                            </div>
                            <div className="aspect-video rounded-xl bg-surface-input overflow-hidden">
                              {(() => {
                                const task = imageTasks.find(t => t.batch_number === index + 1 && !t.single_image);
                                const isRedoing = task?.redo_status === 'redoing' || redoingImage === index + 1;
                                return isRedoing || imageLoadingStates[index] ? (
                                  <div className="flex flex-col justify-center items-center h-full">
                                    <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-red-500"></div>
                                    {isRedoing && (
                                      <p className="text-text-muted mt-2">This could take 1–3 minutes.</p>
                                    )}
                                  </div>
                                ) : (
                                <img
                                  src={url}
                                  alt={`${numberToOrdinal(index + 1)} Image`}
                                  className="w-full h-full object-cover"
                                  onLoadStart={() => {
                                    setImageLoadingStates(prev => {
                                      const newStates = [...prev];
                                      newStates[index] = true;
                                      return newStates;
                                    });
                                  }}
                                  onLoad={() => {
                                    setImageLoadingStates(prev => {
                                      const newStates = [...prev];
                                      newStates[index] = false;
                                      return newStates;
                                    });
                                  }}
                                  onError={() => {
                                    setImageLoadingStates(prev => {
                                      const newStates = [...prev];
                                      newStates[index] = false;
                                      return newStates;
                                    });
                                  }}
                                />
                              );
                              })()}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="flex flex-col justify-center items-center h-48">
                        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-red-500"></div>
                        <p className="text-text-muted mt-2">Loading images...</p>
                      </div>
                    )}
                  </div>
                  <div className="flex justify-end">
                    <button
                      onClick={handleDone}
                      className="flex items-center px-4 py-2 bg-dark-green-600 text-white rounded-xl hover:bg-dark-green-700"
                    >
                      <CheckCircle2 className="h-5 w-5 mr-2" />
                      Done
                    </button>
                  </div>
                </div>
              )}

              {/* Individual Prompt — generating/complete/error states */}
              {selectedMode === 'individual' && (singleImageState === 'generating' || singleImageState === 'complete' || singleImageState === 'error') && (
                <div>
                  {singleImageState === 'generating' && (
                    <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-4 space-y-8">
                      <div className="flex items-center justify-center min-h-[100px]">
                        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-red-500"></div>
                      </div>
                      <div className="text-center space-y-2">
                        <p className="text-text-secondary">Crafting a beautiful image...</p>
                        <p className="text-sm text-text-secondary">This could take 1–3 minutes.</p>
                      </div>
                      <div className="flex justify-end">
                        <button
                          onClick={handleSingleImageDone}
                          className="flex items-center px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover"
                        >
                          <X className="h-5 w-5 mr-2" />
                          Stop
                        </button>
                      </div>
                    </div>
                  )}
                  {singleImageState === 'complete' && singleImageUrl && (
                    <div className="rounded-xl bg-surface-card p-4 border border-dark-green-700">
                      <div className="flex justify-between items-center mb-3">
                        <h3 className="text-lg font-medium text-dark-green-300">Generated Image</h3>
                        <div className="flex space-x-4">
                          <button
                            onClick={handleDownloadSingleImage}
                            className="flex items-center px-3 py-1 bg-dark-green-600 text-white rounded-xl hover:bg-dark-green-700"
                          >
                            <Download className="h-4 w-4 mr-2" />
                            Download
                          </button>
                          <button
                            onClick={handleSingleImageDone}
                            className="flex items-center px-3 py-1 bg-accent text-white rounded-xl hover:bg-accent-hover"
                          >
                            <CheckCircle2 className="h-4 w-4 mr-2" />
                            Done
                          </button>
                        </div>
                      </div>
                      <img
                        src={singleImageUrl}
                        alt="Generated Single Image"
                        className="max-w-full h-auto rounded-xl"
                      />
                    </div>
                  )}
                  {singleImageState === 'error' && singleImageError && (
                    <div className="bg-[--color-status-error-bg] border border-[--color-status-error-border] text-status-error p-4 rounded-2xl">
                      <div className="flex items-center space-x-2 text-[--color-status-error-border] mb-2">
                        <AlertCircle className="h-5 w-5" />
                        <h3 className="text-lg font-medium">Error</h3>
                      </div>
                      <p>{singleImageError}</p>
                      <div className="flex justify-end mt-4">
                        <button
                          onClick={handleSingleImageDone}
                          className="flex items-center px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover"
                        >
                          <RefreshCw className="h-5 w-5 mr-2" />
                          Clear
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .text-dark-green-300 {
          color: #4CAF50;
        }
        .text-dark-green-600 {
          color: #2E7D32;
        }
        .bg-dark-green-600 {
          background-color: #2E7D32;
        }
        .bg-dark-green-700 {
          background-color: #1B5E20;
        }
        .border-dark-green-700 {
          border-color: #1B5E20;
        }
      `}</style>
      <RedoFeedbackModal
        open={redoModalIndex != null}
        title={`Redo Image ${redoModalIndex != null ? redoModalIndex + 1 : ''}`}
        onCancel={() => setRedoModalIndex(null)}
        onConfirm={(fb) => {
          const i = redoModalIndex;
          setRedoModalIndex(null);
          if (i != null) handleRedo(i, fb);
        }}
      />
    </DashboardLayout>
  );
});

// Set display name for debugging
ImageGenerator.displayName = 'ImageGenerator';

export default ImageGenerator;




