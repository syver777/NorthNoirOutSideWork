// ImagePrompts.tsx
import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Upload, FileText, RefreshCw, X, Brain, Image, AlertCircle, CheckCircle2, Download, Calendar, ChevronDown, Info, Edit, BookOpen, Lock } from 'lucide-react';
import { saveAs } from 'file-saver';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import DashboardLayout from '../components/DashboardLayout';
import TabManager from '../components/TabManager';
import ImageModelSelector from '../components/ImageModelSelector';
import ImageFrequencyConfiguration from '../components/ImageFrequencyConfiguration';
import * as mammoth from 'mammoth';
import { splitTextIfLarge, segmentText, determineBatchCount, assignBatches, countWords, estimateTokens, fetchTasks, updateTaskStatus, triggerNextBatch, setupImagePromptTasks, calculateEstimatedImageCountFromWordCount, calculateEstimatedImageCountConsistent, estimateTotalTokensAudioBased } from '../utils/imagePromptsGenerator';
import { saveImageTabFormInputs, getImageTabFormInputs, resetImageTabToDefaults, updateTabStatus, updateTabGroupAndDoc, type TabInfo } from '../utils/tabManager';
import { Listbox, Transition } from '@headlessui/react';
import { useAuth } from '../contexts/AuthContext';
import { useIsLegacyPlan } from '../hooks/useIsLegacyPlan';
import { getPlanMaxTokens } from '../data/planMaxTokens';
import { LEGACY_LLM_MULTIPLIERS, NEW_LLM_MULTIPLIERS, LEGACY_IMAGE_TOKENS_PER_IMAGE, NEW_IMAGE_TOKENS_PER_IMAGE } from '../data/tokenCosts';
import { Link, useNavigate } from 'react-router-dom';
import { checkNetworkStatus, withTimeout, formatNumber, getWordCount } from '../utils/shared';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

const LANGUAGE_OPTIONS = [
  { value: 'english', label: 'English' },
  { value: 'german', label: 'German' },
  { value: 'spanish', label: 'Spanish' },
  { value: 'french', label: 'French' },
];

// Per-model LLM multipliers come from the active plan map (legacy vs new).
// Module-scope default mirrors LEGACY for any helper outside the component;
// in-component code shadows this via useMemo and the active `isLegacy` flag.
function buildModelOptions(isLegacy: boolean) {
  const m = isLegacy ? LEGACY_LLM_MULTIPLIERS : NEW_LLM_MULTIPLIERS;
  return [
    { value: 'deepseek', label: 'Core Model',        tokenMultiplier: m.deepseek, description: `${m.deepseek}x tokens` },
    { value: 'sonnet',   label: 'Claude Sonnet 4.6', tokenMultiplier: m.sonnet,   description: `${m.sonnet}x tokens` },
    { value: 'opus',     label: 'Claude Opus 4.6',   tokenMultiplier: m.opus,     description: `${m.opus}x tokens` },
  ];
}
const modelOptions = buildModelOptions(true);

interface StoryDocument {
  id: string;
  title: string;
  description?: string;
  is_corrected: boolean;
  is_prompted?: boolean;
  version?: number;
  variant?: number;
  group_id?: string;
  created_at: string;
  file_path: string;
  file_url?: string;
  word_count?: number;
  file_size?: number | null;
}

interface AudioFile {
  path: string;
  name: string;
  duration: number;
  url?: string;
}

interface GenerationSettings {
  style: string;
  useCharacterDescriptions: boolean;
  customCharactersEnabled: boolean;
  customCharacters: Array<{ name: string; description: string }>;
  customCharactersAIEnhance: boolean;
  firstPageFrequency: string;
  restFrequency: string;
  imageModel: 'standard' | 'plus' | 'premium' | 'spark' | 'grok' | 'prime' | 'genesis' | 'imagen-4-fast' | 'gpt-image-1-mini' | 'imagen-4-ultra' | 'flux-2-dev' | 'grok-imagine-image' | 'seedream-4.5' | 'nano-banana-pro';
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
  consistentFrequency?: string;
  imageAmount?: string;
}

type GenerationState = 'idle' | 'generating' | 'writing' | 'saving' | 'complete' | 'error';

// Constants for task management
const RETRY_DELAY = 2000;
const MAX_RETRIES = 10; // Increased from 5 to 10
const POLLING_INTERVAL = 30000;
const SUBSCRIPTION_CHECK_INTERVAL = 60000;
const TASK_STALL_TIMEOUT = 1800000;
const OPERATION_TIMEOUT = 3600000;
const STALL_DETECTION_TIMEOUT = 30000;
const MAX_WORD_COUNT = 70000;
const MAX_FILE_SIZE_MB = 1;

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
  settings: GenerationSettings;
  group_id: string;
  variant: number;
  doc_id?: string;
  file_path: string;
  input_tokens?: number;
  output_tokens?: number;
  updated_at?: string;
  token_updated?: boolean;
  video_process?: boolean;
  process_image?: boolean;
  check_stuck?: boolean;
}

interface BatchStatus {
  batchNumber: number;
  status: string;
  progress: number;
}

// Updated withRetry function with exponential backoff for network errors
const withRetry = async <T extends unknown>(operation: () => Promise<T>, operationName: string, maxRetries: number = MAX_RETRIES): Promise<T> => {
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;

      if (error.message.includes('Failed to fetch')) {
        console.warn(`Network error (attempt ${attempt}/${maxRetries}) for ${operationName}: ${error.message}`);
      } else if (error.status === 500) {
        console.error(`Server error (attempt ${attempt}/${maxRetries}) for ${operationName}: HTTP 500 Internal Server Error`);
      } else if (error.message.includes('timeout')) {
        console.error(`Timeout error (attempt ${attempt}/${maxRetries}) for ${operationName}: ${error.message}`);
      } else {
        console.warn(`Error (attempt ${attempt}/${maxRetries}) for ${operationName}: ${error.message}`);
      }
     
      // Check if this is a retryable error and not the last attempt
      if ((error.message.includes('Failed to fetch') || error.status === 500 || error.message.includes('timeout') || error.message.includes('429') || error.message.includes('503')) && attempt < maxRetries) {
        // Use exponential backoff with a base of RETRY_DELAY
        const delay = RETRY_DELAY * Math.pow(1.5, attempt - 1); // 2s, 3s, 4.5s, 6.75s, etc.
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }

  throw new Error(`Failed to complete ${operationName} after ${maxRetries} attempts: ${lastError.message}`);
};

const isTaskStalled = (task: ImagePromptTask): boolean => {
  if (!task.updated_at) return false;
  const lastUpdate = new Date(task.updated_at).getTime();
  return Date.now() - lastUpdate > TASK_STALL_TIMEOUT;
};

const clearSupabaseSession = async (userId: string | null) => {
  if (!userId) return;

  try {
    console.log(`Clearing session data for user ${userId}`);
  } catch (err) {
    console.error('Error clearing Supabase session:', err);
  }
};

// Calculate word count from text
const calculateWordCount = (text: string): number => {
  return getWordCount(text);
};

// Updated calculate estimated image count based on Python logic
const calculateEstimatedImageCount = (wordCount: number, settings: GenerationSettings): number => {
  if (!wordCount || wordCount <= 0) return 0;
  
  if (settings.frequencyMode === 'audio') {
    return parseInt(settings.imageAmount || '1') || 1;
  }
  
  if (settings.frequencyType === 'consistent') {
    const consistentFreq = parseFloat(settings.consistentFrequency || '10');
    return calculateEstimatedImageCountConsistent(wordCount, consistentFreq);
  } else {
    // Variable frequency
    const firstPageFreq = parseFloat(settings.firstPageFrequency);
    const restFreq = parseFloat(settings.restFrequency);
    return calculateEstimatedImageCountFromWordCount(wordCount, firstPageFreq, restFreq);
  }
};

// Calculate estimated token cost for images. Branches LEGACY vs NEW based on
// the active plan; tier-name aliases are mapped to canonical backend ids.
const TIER_TO_BACKEND_IMAGE: Record<string, string> = {
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
  const canonical = TIER_TO_BACKEND_IMAGE[imageModel] ?? imageModel;
  return imageCount * (map[canonical] ?? 30000);
};

// Map frontend model values to backend values (includes identity mappings for backend values)
const getBackendImageModel = (frontendModel: string): string => {
  const modelMap: Record<string, string> = {
    'standard': 'imagen-4-fast', 'imagen-4-fast': 'imagen-4-fast',
    'plus': 'gpt-image-1-mini', 'gpt-image-1-mini': 'gpt-image-1-mini',
    'premium': 'imagen-4-ultra', 'imagen-4-ultra': 'imagen-4-ultra',
    'spark': 'flux-2-dev', 'flux-2-dev': 'flux-2-dev',
    'grok': 'grok-imagine-image', 'grok-imagine-image': 'grok-imagine-image',
    'prime': 'seedream-4.5', 'seedream-4.5': 'seedream-4.5',
    'genesis': 'nano-banana-pro', 'nano-banana-pro': 'nano-banana-pro',
  };
  return modelMap[frontendModel] || 'gpt-image-1-mini';
};

// Get word count from various sources
const getWordCountFromSettings = (documents: any[], uploadedDoc: File | null, selectedDoc: string): number => {
  // From selected document
  if (selectedDoc) {
    const doc = documents.find(d => d.id === selectedDoc);
    if (doc && doc.word_count) return doc.word_count;
  }
  
  // From uploaded file (assuming it's been processed and added to documents)
  if (uploadedDoc && uploadedDoc.name) { // Add null check for uploadedDoc.name
    // Try to find the uploaded document in the documents array
    const uploadedDocName = uploadedDoc.name.replace(/\.txt$/, '');
    const doc = documents.find(d => d.title === uploadedDocName);
    if (doc && doc.word_count) return doc.word_count;
  }
  
  return 0;
};

// Updated checkExistingTasks function to only use main database
const checkExistingTasks = async (userId: string, groupId?: string, tab: number = 1): Promise<ImagePromptTask[]> => {
  try {
    console.log(`Checking existing tasks for user ${userId}${groupId ? `, group ${groupId}` : ''}, tab ${tab}`);
    
    let query = supabase
      .from('image_prompt_tasks')
      .select('id,user_id,story_title,batch,text_part,total_batches,batch_number,progress,error,status,settings,group_id,variant,doc_id,file_path,input_tokens,output_tokens,updated_at,token_updated,video_process,process_image,check_stuck')
      .eq('user_id', userId)
      .eq('tab', tab)
      .in('status', ['pending', 'queued', 'running', 'completed_final']);
    
    if (groupId) {
      query = query.eq('group_id', groupId);
    }
    
    const { data: tasks, error } = await withRetry(
      () => withTimeout(
        query.order('created_at', { ascending: false }),
        OPERATION_TIMEOUT,
        'checkExistingTasks'
      ),
      'checkExistingTasks'
    );

    if (error) {
      console.error('Error checking existing tasks:', error);
      throw error;
    }

    if (tasks && tasks.length > 0) {
      console.log(`Found ${tasks.length} existing tasks`);
      return tasks as ImagePromptTask[];
    }

    console.log('No existing tasks found');
    return [];

  } catch (error: any) {
    console.error('Error checking existing tasks:', error);
    throw error;
  }
};

export interface ImagePromptsRef {
  cleanup: () => Promise<void>;
}

interface ImagePromptsProps {
  initialTab: number;
  initialGroupId: string;
  isEnterpriseUser: boolean;
  initialTabs?: TabInfo[];
  onTabChange: (tab: number, groupId: string) => void;
  onTabCreate: (tab: number, groupId: string) => void;
  onTabClose: (tab: number, groupId: string) => void;
}

const ImagePrompts = forwardRef<ImagePromptsRef, ImagePromptsProps>((props, ref) => {
  const {
    initialTab,
    initialGroupId,
    isEnterpriseUser,
    initialTabs,
    onTabChange,
    onTabCreate,
    onTabClose
  } = props;

  // Tab state comes from props (managed by ImagePromptsContainer)
  const currentTab = initialTab;

  // Plan-aware LLM model options. Shadowing the module-scope `modelOptions`
  // keeps every existing in-component reference in sync with the active plan.
  const { isLegacy } = useIsLegacyPlan();
  const modelOptions = React.useMemo(() => buildModelOptions(isLegacy), [isLegacy]);

  const { user } = useAuth();
  const navigate = useNavigate();
  const [documents, setDocuments] = useState<StoryDocument[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<string>('');
  const [uploadedDoc, setUploadedDoc] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [generationState, setGenerationState] = useState<GenerationState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<GenerationSettings>({
    style: `A painterly, hand-drawn animation style in the tradition of classic Japanese feature animation, evoking the visual sensibility of landmark studios such as Studio Ghibli. Wide format with gentle, organic linework and subtle textures that mimic traditional cel animation. The palette is lush and nature-inspired—rich greens, soft pastels, golden sunlight, and warm earth tones—evoking emotional warmth and whimsical realism. Characters are expressive with large, emotive eyes and understated facial details. Backgrounds are intricately detailed yet softly rendered, often featuring idyllic countryside, cozy interiors, or magical environments with a nostalgic glow. Lighting is natural and dynamic, shifting gently across scenes to mirror time and mood. The overall aesthetic is warm, soulful, and immersive, blending everyday simplicity with quiet enchantment.`,
    useCharacterDescriptions: true,
    customCharactersEnabled: false,
    customCharacters: [{ name: '', description: '' }],
    customCharactersAIEnhance: false,
    firstPageFrequency: '10',
    restFrequency: '30',
    imageModel: 'prime',
    language: 'english',
    model: 'deepseek',
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
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});
  const [totalInputTokens, setTotalInputTokens] = useState(0);
  const [totalOutputTokens, setTotalOutputTokens] = useState(0);
  const [progress, setProgress] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [generatedFileName, setGeneratedFileName] = useState<string>('');
  const [generatedDocTitle, setGeneratedDocTitle] = useState<string>('');
  const [isCorrected, setIsCorrected] = useState<boolean>(false);
  const [userTokenBalance, setUserTokenBalance] = useState(400000);
  const [generatedGroupId, setGeneratedGroupId] = useState<string | null>(null);
  const [generatedVariant, setGeneratedVariant] = useState<number | null>(null);
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(initialGroupId || null);
  const [sessionStorageError, setSessionStorageError] = useState<string | null>(null);
  const [batchStatuses, setBatchStatuses] = useState<BatchStatus[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [stallDetected, setStallDetected] = useState<boolean>(false);
  const [storageUsed, setStorageUsed] = useState<number | null>(null);
  const [userPlan, setUserPlan] = useState<string>('free');
  const [totalTokens, setTotalTokens] = useState<number>(0);
  const [networkRetrying, setNetworkRetrying] = useState<boolean>(false);
  const [currentTasks, setCurrentTasks] = useState<ImagePromptTask[]>([]);
  const [currentVariant, setCurrentVariant] = useState<number | null>(null);
  
  // UI state

  // Edit functionality state
  const [isEditing, setIsEditing] = useState(false);
  const [editableContent, setEditableContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
 
  // Add a ref to track processed task IDs to prevent duplicate token updates
  const processedTaskIds = useRef<Set<string>>(new Set());
 
  const lastUpdateRef = useRef<number>(Date.now());
  const lastSubscriptionUpdateRef = useRef<number>(Date.now());
  const totalBatchesRef = useRef<number>(0);
  const generationStartTime = useRef<number | null>(null);
  const fetchFailuresRef = useRef<number>(0);
  const realtimeChannelRef = useRef<any>(null);

  // Expose cleanup function via ref
  useImperativeHandle(ref, () => ({
    cleanup: async () => {
      console.log(`[ImagePrompts] Cleanup called for tab ${currentTab}`);
      
      try {
        // Check if user is authenticated
        if (!user?.id) {
          console.warn('[ImagePrompts] No user authenticated during cleanup');
          return;
        }

        // Get tab status from database
        const { data: tabData, error: tabError } = await supabase
          .from('tabs')
          .select('status')
          .eq('user_id', user.id)
          .eq('page', 'image_prompt')
          .eq('tab_number', currentTab)
          .single();

        if (tabError) {
          console.error('[ImagePrompts] Error fetching tab status during cleanup:', tabError);
        }

        // Note: We do NOT delete image_prompt_tasks here. The variant system will handle
        // multiple concurrent generations. Tasks are only deleted when clicking Done or Stop.
        console.log(`[ImagePrompts] Tab ${currentTab} cleanup - keeping existing tasks for variant system`);
      } catch (error) {
        console.error('[ImagePrompts] Error during cleanup:', error);
      }
      
      // Cancel realtime subscriptions
      if (realtimeChannelRef.current) {
        await supabase.removeChannel(realtimeChannelRef.current);
        realtimeChannelRef.current = null;
      }
      
      // Reset currentVariant after cleanup
      setCurrentVariant(null);
      
      // Clear intervals (if any are stored in refs)
      // Add any other cleanup needed
    }
  }));

  // Load saved form inputs on mount
  useEffect(() => {
    if (!user?.id) return;
    
    const loadSavedInputs = async () => {
      try {
        const saved = await getImageTabFormInputs(user.id, currentTab);
        if (saved) {
          console.log(`[ImagePrompts] Loading saved inputs for tab ${currentTab}:`, saved);
          setSettings(prev => ({
            ...prev,
            style: saved.style || prev.style,
            useCharacterDescriptions: saved.useCharacterDescriptions,
            customCharactersEnabled: saved.customCharactersEnabled ?? false,
            customCharacters: saved.customCharacters?.length ? saved.customCharacters : [{ name: '', description: '' }],
            customCharactersAIEnhance: saved.customCharactersAIEnhance ?? false,
            firstPageFrequency: saved.firstPageFrequency?.toString() || '30',
            restFrequency: saved.restFrequency?.toString() || '60',
            imageModel: saved.imageModel as any || 'prime',
            language: saved.language || 'english',
            model: saved.model || 'sonnet',
            frequencyMode: saved.frequencyMode || 'wordcount',
            frequencyType: saved.frequencyType || 'consistent',
            consistentFrequency: saved.consistentFrequency?.toString() || '',
            audioDistributionType: saved.audioDistributionType as any || 'consistent',
            audioFiles: [],
            totalAudioDuration: saved.totalAudioDuration || 0,
            imageAmount: saved.imageAmount?.toString() || '',
            audioFirstPageImageCount: saved.firstPageImageAmount?.toString() || '',
            audioRestImageCount: saved.restImageAmount?.toString() || '',
          }));
        }
      } catch (error) {
        console.error('[ImagePrompts] Error loading saved inputs:', error);
      }
    };
    
    loadSavedInputs();
  }, [user?.id, currentTab]);

  // Save form inputs when settings change (debounced)
  useEffect(() => {
    if (!user?.id) return;
    
    const timeoutId = setTimeout(async () => {
      try {
        await saveImageTabFormInputs(user.id, currentTab, {
          style: settings.style,
          useCharacterDescriptions: settings.useCharacterDescriptions,
          customCharactersEnabled: settings.customCharactersEnabled,
          customCharacters: settings.customCharacters,
          customCharactersAIEnhance: settings.customCharactersAIEnhance,
          firstPageFrequency: parseInt(settings.firstPageFrequency) || 30,
          restFrequency: parseInt(settings.restFrequency) || 60,
          imageModel: settings.imageModel,
          language: settings.language,
          model: settings.model,
          frequencyMode: settings.frequencyMode,
          frequencyType: settings.frequencyType,
          consistentFrequency: settings.consistentFrequency ? parseInt(settings.consistentFrequency) || 10 : 10,
          audioDistributionType: settings.audioDistributionType,
          firstPageImageAmount: settings.audioFirstPageImageCount ? parseInt(settings.audioFirstPageImageCount) : undefined,
          restImageAmount: settings.audioRestImageCount ? parseInt(settings.audioRestImageCount) : undefined,
          totalAudioDuration: settings.totalAudioDuration,
          imageAmount: settings.imageAmount ? parseInt(settings.imageAmount) : undefined,
        } as any);
        console.log(`[ImagePrompts] Saved form inputs for tab ${currentTab}`);
      } catch (error) {
        console.error('[ImagePrompts] Error saving form inputs:', error);
      }
    }, 1000); // Debounce 1 second
    
    return () => clearTimeout(timeoutId);
  }, [user?.id, currentTab, settings]);

  // Define plan maximum tokens based on plan_type
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

  // Get selected model configuration
  const selectedModel = modelOptions.find(m => m.value === settings.model) || modelOptions[0];

  // Force free users to Core Model if they have a paid model selected from a previous session
  useEffect(() => {
    if (userPlan === 'free' && settings.model !== 'deepseek') {
      setSettings(prev => ({ ...prev, model: 'deepseek' }));
    }
  }, [userPlan]); // eslint-disable-line react-hooks/exhaustive-deps

  // Add error boundary effect
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      console.error('Global error caught:', event.error);
      if (event.error?.message?.includes('Cannot read properties of undefined')) {
        setError('A data loading error occurred. Please refresh the page and try again.');
        setGenerationState('error');
      }
    };

    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  // Function to clear analysis data when selecting a new document
  const clearAnalysisData = () => {
    console.log('Clearing analysis data');
    setGeneratedGroupId(null);
    setGeneratedVariant(null);
    setGeneratedDocTitle('');
    setGeneratedFileName('');
    // Explicitly remove from session storage
    window.sessionStorage.removeItem('promptGeneratedGroupId');
    window.sessionStorage.removeItem('promptGeneratedVariant');
    window.sessionStorage.removeItem('promptGeneratedDocTitle');
    window.sessionStorage.removeItem('promptGeneratedFileName');
  };

  useEffect(() => {
    const handleSessionStorageError = (event: StorageEvent) => {
      if (event.storageArea === sessionStorage && event.key?.startsWith('error_')) {
        setSessionStorageError('Failed to save form data. Your progress is saved locally but may not persist across sessions.');
      }
    };

    window.addEventListener('storage', handleSessionStorageError);
    return () => window.removeEventListener('storage', handleSessionStorageError);
  }, []);

  useEffect(() => {
    const checkUser = async () => {
      try {
        const { data: { user } } = await withRetry(
          () => withTimeout(supabase.auth.getUser(), OPERATION_TIMEOUT, 'checkUser'),
          'checkUser'
        );

        const newUserId = user?.id || null;
        if (newUserId !== currentUserId && currentUserId !== null) {
          console.log('User changed, clearing session data');
          await clearSupabaseSession(currentUserId);
          sessionStorage.clear();
          setDocuments([]);
          setSelectedDoc('');
          setUploadedDoc(null);
          setGenerationState('idle');
          setError(null);
          setSettings({
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
          });
          setValidationErrors({});
          setTotalInputTokens(0);
          setTotalOutputTokens(0);
          setProgress(0);
          setTimeRemaining(null);
          setStatusMessage('');
          setGeneratedFileName('');
          setGeneratedDocTitle('');
          setIsCorrected(false);
          setGeneratedGroupId(null);
          setGeneratedVariant(null);
          setSelectedDoc(''); // Explicitly clear selected document
          setUploadedDoc(null); // Explicitly clear uploaded document
          totalBatchesRef.current = 0;
          setCurrentGroupId(null);
          setSessionStorageError(null);
          setBatchStatuses([]);
          generationStartTime.current = null;
          // Reset processed task IDs
          processedTaskIds.current = new Set();
        }
        setCurrentUserId(newUserId);
      } catch (err: any) {
        console.error('Error checking user:', err);
        setError(`Failed to verify user: ${err.message}`);
        setLoading(false);
      }
    };

    checkUser();
  }, [currentUserId]);

  const validateSettings = (): boolean => {
    const errors: ValidationErrors = {};
    
    if (settings.frequencyMode === 'wordcount') {
      if (settings.frequencyType === 'consistent') {
        // Only validate if user has entered a value
        if (settings.consistentFrequency && settings.consistentFrequency.trim() !== '') {
          const consistent = parseFloat(settings.consistentFrequency);
          if (isNaN(consistent) || consistent < 5 || consistent > 600) {
            errors.consistentFrequency = 'Consistent frequency must be between 5 and 600 seconds';
          }
        }
      } else {
        // Variable frequency - only validate if user has entered values
        if (settings.firstPageFrequency && settings.firstPageFrequency.trim() !== '') {
          const firstPage = parseFloat(settings.firstPageFrequency);
          if (isNaN(firstPage) || firstPage < 5 || firstPage > 300) {
            errors.firstPageFrequency = 'First page frequency must be between 5 and 300 seconds';
          }
        }

        if (settings.restFrequency && settings.restFrequency.trim() !== '') {
          const rest = parseFloat(settings.restFrequency);
          if (isNaN(rest) || rest < 5 || rest > 600) {
            errors.restFrequency = 'Rest frequency must be between 5 and 600 seconds';
          }
        }
      }
    } else if (settings.frequencyMode === 'audio') {
      // Audio mode validation
      if (!settings.audioFiles || settings.audioFiles.length === 0) {
        errors.imageAmount = 'Please select or upload audio files first';
      } else if (settings.totalAudioDuration === 0) {
        errors.imageAmount = 'Audio duration calculation pending';
      } else {
        const MAX_FREQUENCY_SECONDS = 900; // Maximum 900 seconds (15 minutes) per image
        const MIN_FREQUENCY_SECONDS = 5; // Minimum 5 seconds per image
        
        // Validate based on distribution type
        if (settings.audioDistributionType === 'consistent') {
          const imageAmtStr = settings.imageAmount || '';
          if (imageAmtStr.trim() === '') {
            // Empty is allowed, no error
          } else {
            const imageAmt = parseInt(imageAmtStr);
            const maxImages = Math.floor((settings.totalAudioDuration || 0) / MIN_FREQUENCY_SECONDS);
            const minImages = Math.max(1, Math.ceil((settings.totalAudioDuration || 0) / MAX_FREQUENCY_SECONDS));
            
            if (isNaN(imageAmt) || imageAmt < minImages) {
              errors.imageAmount = `Minimum ${minImages} image(s) required (max ${MAX_FREQUENCY_SECONDS / 60} min per image)`;
            } else if (imageAmt > maxImages) {
              errors.imageAmount = `Maximum ${maxImages} images allowed (min ${MIN_FREQUENCY_SECONDS}s per image)`;
            }
          }
        } else if (settings.audioDistributionType === 'variable') {
          // Variable distribution validation
          const totalDuration = settings.totalAudioDuration || 0;
          const firstPageDuration = Math.min(360, totalDuration);
          const restDuration = Math.max(0, totalDuration - firstPageDuration);
          
          const maxFirstImages = Math.floor(firstPageDuration / MIN_FREQUENCY_SECONDS);
          const maxRestImages = restDuration > 0 ? Math.floor(restDuration / MIN_FREQUENCY_SECONDS) : 0;
          const minFirstImages = Math.max(1, Math.ceil(firstPageDuration / MAX_FREQUENCY_SECONDS));
          const minRestImages = restDuration > 0 ? Math.max(1, Math.ceil(restDuration / MAX_FREQUENCY_SECONDS)) : 0;
          
          const firstPageStr = settings.audioFirstPageImageCount || '';
          const restStr = settings.audioRestImageCount || '';
          
          if (firstPageStr.trim() === '') {
            // Empty is allowed, no error
          } else {
            const firstPageImages = parseInt(firstPageStr);
            if (isNaN(firstPageImages) || firstPageImages < minFirstImages) {
              errors.imageAmount = `First page: Minimum ${minFirstImages} image(s) required (max ${MAX_FREQUENCY_SECONDS / 60} min per image)`;
            } else if (firstPageImages > maxFirstImages) {
              errors.imageAmount = `First page: Maximum ${maxFirstImages} images for ${Math.round(firstPageDuration)}s`;
            }
          }
          
          if (restDuration > 0 && restStr.trim() === '') {
            // Empty is allowed, no error
          } else if (restDuration > 0) {
            const restImages = parseInt(restStr);
            if (isNaN(restImages) || restImages < minRestImages) {
              if (!errors.imageAmount) {
                errors.imageAmount = `Rest of story: Minimum ${minRestImages} image(s) required (max ${MAX_FREQUENCY_SECONDS / 60} min per image)`;
              }
            } else if (restImages > maxRestImages) {
              if (!errors.imageAmount) {
                errors.imageAmount = `Rest of story: Maximum ${maxRestImages} images for ${Math.round(restDuration)}s`;
              }
            }
          }
        }
      }
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  useEffect(() => {
    validateSettings();
  }, [
    settings.firstPageFrequency, 
    settings.restFrequency, 
    settings.consistentFrequency, 
    settings.frequencyType, 
    settings.frequencyMode,
    settings.audioFiles,
    settings.totalAudioDuration,
    settings.imageAmount,
    settings.audioDistributionType,
    settings.audioFirstPageImageCount,
    settings.audioRestImageCount
  ]);

  useEffect(() => {
    const checkExistingTasksOnLoad = async () => {
      try {
        if (!checkNetworkStatus()) {
          throw new Error('No internet connection');
        }
        const { data: { user } } = await withRetry(
          () => withTimeout(supabase.auth.getUser(), OPERATION_TIMEOUT, 'getUser'),
          'checkUser'
        );
       
        if (!user) {
          setError('Authentication error');
          setLoading(false);
          return;
        }
       
        setCurrentUserId(user.id);
        
        console.log('Checking for existing tasks...');
        const tasks = await checkExistingTasks(user.id, undefined, currentTab);
        console.log('Found tasks:', tasks.length, tasks.map(t => ({ id: t.id, status: t.status, group_id: t.group_id, video_process: t.video_process, process_image: t.process_image })));
        
        if (tasks && tasks.length > 0) {
          const task = tasks[0]; // Get the most recent task
          console.log('Processing most recent task:', { id: task.id, status: task.status, group_id: task.group_id, video_process: task.video_process, process_image: task.process_image });
          
          // Check if all tasks with the same group_id have video_process or process_image set to true
          const groupTasks = tasks.filter(t => t.group_id === task.group_id);
          const allVideoProcessed = groupTasks.every(t => t.video_process === true);
          const allImageProcessed = groupTasks.every(t => t.process_image === true);
          
          if (allVideoProcessed || allImageProcessed) {
            console.log('All tasks have video_process or process_image set to true, not showing any completion state');
            // Don't set any completion state or show any UI when video processing or image processing is complete
            setGenerationState('idle');
            setLoading(false);
            return;
          }
          
          if (task.status === 'completed_final' && !allVideoProcessed && !allImageProcessed) {
            // Handle completed tasks only if video processing and image processing are not complete
            const filteredTasks = tasks.filter(t => t.status === 'completed_final' && t.group_id === task.group_id);
            const totalInputTokens = filteredTasks.reduce((sum, t) => sum + (t.input_tokens || 0), 0);
            const totalOutputTokens = filteredTasks.reduce((sum, t) => sum + (t.output_tokens || 0), 0);
            // Fetch the generated document
            const { data: doc, error: docError } = await withRetry(
              () => withTimeout(
                supabase
                  .from('story_documents')
                  .select('file_url, title, is_corrected')
                  .eq('group_id', task.group_id)
                  .eq('user_id', user.id)
                  .eq('is_prompted', true)
                  .order('created_at', { ascending: false })
                  .limit(1)
                  .single(),
                OPERATION_TIMEOUT,
                'fetchGeneratedDocument'
              ),
              'fetchGeneratedDocument'
            );
            if (docError || !doc) {
              throw new Error('Failed to fetch generated document');
            }
            setCurrentGroupId(task.group_id);
            setGenerationState('complete');
            setSettings(task.settings);
            setGeneratedGroupId(task.group_id);
            setGeneratedVariant(task.variant);
            setGeneratedDocTitle(doc.title);
            setIsCorrected(doc.is_corrected);
            setGeneratedFileName(doc.file_url.split('/').pop() || '');
            setTotalInputTokens(totalInputTokens);
            setTotalOutputTokens(totalOutputTokens);
            setProgress(100);
            setTimeRemaining(0);
            setStatusMessage('Generation complete!');
            setBatchStatuses([]);

            // Update tab status to 'complete'
            await updateTabStatus(user.id, 'image_prompt', currentTab, 'complete', task.group_id, doc.title);
          } else if (['pending', 'queued', 'running'].includes(task.status)) {
            // Handle in-progress tasks
            if (task.status === 'running' && isTaskStalled(task)) {
              console.warn(`Found stalled task, resetting to pending`);
              await updateTaskStatus(task.id, 'pending');
              await triggerNextBatch(task.group_id, user.id, task.batch_number - 1);
            }
           
            setCurrentGroupId(task.group_id);
            setGenerationState('generating');
            setSettings(task.settings);
            setGeneratedGroupId(task.group_id);
            setGeneratedVariant(task.variant);
            setGeneratedDocTitle(task.story_title);
            setIsCorrected(task.doc_id ? documents.find(doc => doc.id === task.doc_id)?.is_corrected || false : false);
            setProgress(task.progress || 0);
            setTotalInputTokens(task.input_tokens || 0);
            setTotalOutputTokens(task.output_tokens || 0);
            setStatusMessage(`Processing batch ${task.batch_number} of ${task.total_batches}`);
            totalBatchesRef.current = task.total_batches;
            setTimeRemaining((task.total_batches - task.batch_number + 1) * 90);
            setBatchStatuses([{ batchNumber: task.batch_number, status: task.status, progress: task.progress || 0 }]);
            generationStartTime.current = Date.now();
          }
        }
      } catch (err: any) {
        console.error('Error checking existing tasks:', err);
        setError(`Failed to check for existing tasks: ${err.message}`);
      } finally {
        setLoading(false);
      }
    };
    checkExistingTasksOnLoad();
  }, []);

  useEffect(() => {
    const fetchDocuments = async () => {
      try {
        if (!checkNetworkStatus()) {
          throw new Error('No internet connection');
        }
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
        const { data, error } = await withRetry(
          () => withTimeout(
            supabase
              .from('story_documents')
              .select('*')
              .eq('user_id', user.id)
              .order('created_at', { ascending: false }),
            OPERATION_TIMEOUT,
            'fetchDocuments'
          ),
          'fetchDocuments'
        );
        if (error) throw error;
        setDocuments(data || []);
        // Calculate storage usage
        let totalSize = 0;
        if (data && data.length > 0) {
          for (const doc of data) {
            if (doc.file_size == null || doc.file_size === 0) {
              try {
                const { data: fileData, error: storageError } = await supabase.storage
                  .from('stories')
                  .download(doc.file_path);
                if (storageError) {
                  console.error(`Failed to fetch size for ${doc.file_path}:`, storageError);
                  continue;
                }
                const size = (await fileData.arrayBuffer()).byteLength;
                const { error: updateError } = await supabase
                  .from('story_documents')
                  .update({ file_size: size })
                  .eq('id', doc.id);
                if (updateError) {
                  console.error(`Failed to update file_size for ${doc.id}:`, updateError);
                } else {
                  doc.file_size = size;
                }
              } catch (err: any) {
                console.error(`Error processing ${doc.file_path}:`, err);
              }
            }
            totalSize += doc.file_size || (doc.word_count ? doc.word_count * 1.5 : 0);
          }
        }
        const totalSizeMB = totalSize / (1024 * 1024);
        const formattedSize = totalSizeMB > 0 && totalSizeMB < 0.05 ? 0.1 : Number(totalSizeMB.toFixed(totalSizeMB < 1 ? 1 : 2));
        setStorageUsed(formattedSize);
      } catch (err: any) {
        setError(err.message);
      }
    };
    const fetchUserPlan = async () => {
      try {
        if (!checkNetworkStatus()) {
          throw new Error('No internet connection');
        }
       
        if (!currentUserId) return;
        const { data, error } = await withRetry(
          () => withTimeout(
            supabase
              .from('user_plans')
              .select('plan_type, tokens_allocated, tokens_used, rollover_tokens')
              .eq('user_id', currentUserId)
              .eq('is_active', true)
              .single(),
            OPERATION_TIMEOUT,
            'fetchUserPlan'
          ),
          'fetchUserPlan'
        );
        if (error) throw error;
       
        if (data) {
          const planType = data.plan_type || 'free';
          const tokensUsed = data.tokens_used || 0;
          const rolloverTokens = data.rollover_tokens || 0;
         
          setUserPlan(planType);
          setUserTokenBalance(getPlanMaxTokens(planType, isLegacy) - tokensUsed + rolloverTokens);
          setTotalTokens(tokensUsed);
        }
      } catch (error: any) {
        console.error('Failed to fetch user token usage:', error);
        setError('Unable to fetch user token usage.');
        setGenerationState('error');
      }
    };
    fetchDocuments();
    fetchUserPlan();
  }, [currentUserId]);

  // Helper function to validate file names
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
 
  // Updated handleFileUpload function
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
 
    // Clear previous analysis data when uploading a new file
    clearAnalysisData();
 
    // Validate file type
    if (file.type !== 'text/plain' && !file.name.endsWith('.txt')) {
      setError('Please upload a valid .txt file');
      return;
    }

    // Add null check for file.name
    if (!file.name) {
      setError('File name is missing');
      return;
    }
 
    // Validate file name for invalid characters
    const fileNameError = validateFileName(file.name);
    if (fileNameError) {
      setError(fileNameError);
      return;
    }
 
    // Validate file size (1MB or remaining storage)
    const maxStorageMB = 300;
    const maxFileSizeBytes = MAX_FILE_SIZE_MB * 1024 * 1024;
    if (file.size > maxFileSizeBytes) {
      setError(`File size exceeds limit. Maximum allowed: ${Math.round(maxFileSizeBytes / 1024)} KB`);
      return;
    }
 
    if (!currentUserId) {
      setError('Authentication error');
      return;
    }
 
    // Read file content for word count
    let fileContent: string;
    try {
      fileContent = await file.text();
    } catch (err: any) {
      setError('Failed to read file content');
      return;
    }
 
    const wordCount = calculateWordCount(fileContent);
 
    // Check word count limit
    if (wordCount > MAX_WORD_COUNT) {
      setError(`File exceeds the maximum word count limit of ${MAX_WORD_COUNT} words. Your file has ${wordCount} words.`);
      return;
    }
 
    // Generate unique group_id for this upload
    const uniqueGroupId = crypto.randomUUID();
 
    // Generate file path with unique group_id
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${file.name.replace(/\s+/g, '-')}_${timestamp}.txt`;
    const filePath = `documents/${currentUserId}/${uniqueGroupId}/${fileName}`;
 
    try {
      // Upload file to Supabase storage
      const { error: uploadError } = await supabase.storage
        .from('stories')
        .upload(filePath, file, {
          contentType: 'text/plain',
          upsert: true,
        });
 
      if (uploadError) {
        throw new Error(`Failed to upload file: ${uploadError.message}`);
      }
 
      // Insert document metadata into story_documents
      const { data, error: insertError } = await supabase
        .from('story_documents')
        .insert({
          id: crypto.randomUUID(),
          user_id: currentUserId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          file_path: filePath,
          title: file.name.replace(/\.txt$/, ''),
          description: 'Uploaded document for image prompt generation',
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
      setSelectedDoc('');
 
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
      setError(err.message || 'Failed to upload file');
    }
  };

  // Extract text from .txt file
  const extractTextFromTxt = async (file: File): Promise<string> => {
    try {
      return await file.text();
    } catch (err: any) {
      throw new Error(`Failed to extract text from uploaded file: ${err.message}`);
    }
  };

  const extractTextFromDocx = async (file: File | Blob): Promise<string> => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      return result.value;
    } catch (err: any) {
      throw new Error(`Failed to extract text from uploaded file: ${err.message}`);
    }
  };

  const fetchDocContent = async (filePath: string): Promise<string> => {
    if (!checkNetworkStatus()) {
      throw new Error('No internet connection');
    }
    const { data, error } = await withRetry(
      () => withTimeout(
        supabase.storage.from('stories').download(filePath),
        OPERATION_TIMEOUT,
        'downloadDocument'
      ),
      'downloadDocument'
    );
    if (error) throw new Error(`Failed to download document: ${error.message}`);
    try {
      if (filePath.toLowerCase().endsWith('.txt')) {
        const content = await data.text();
        console.log(`Downloaded text content, length: ${content.length}, words: ${calculateWordCount(content)}`);
        return content;
      } else if (filePath.toLowerCase().endsWith('.docx')) {
        const arrayBuffer = await data.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        return result.value;
      } else {
        throw new Error('Unsupported file type. Only .txt and .docx files are supported.');
      }
    } catch (err: any) {
      throw new Error(`Failed to extract text from downloaded file: ${err.message}`);
    }
  };

  const calculateEstimatedTime = (totalBatches: number): number => {
    const timePerBatch = 90;
    return totalBatches * timePerBatch;
  };

  const estimateActionTokens = (totalPrompts: number): number => {
    return totalPrompts * 500;
  };

  // Updated fetchTasksForPolling function with improved error handling for network issues
  const fetchTasksForPolling = async () => {
    try {
      if (!checkNetworkStatus()) {
        console.warn('Network offline, will retry when connection is restored');
        setNetworkRetrying(true);
        setStatusMessage('Waiting for network connection...');
        return; // Exit without setting error state
      }
      let tasks;
      try {
        tasks = await fetchTasks(currentUserId!, currentGroupId!, currentTab, currentVariant);
        setCurrentTasks(tasks);
        // Reset the failure counter on success
        fetchFailuresRef.current = 0;
        // If we were in network retry mode, clear it
        if (networkRetrying) {
          setNetworkRetrying(false);
          setStatusMessage('Network connection restored, continuing...');
        }
      } catch (fetchError: any) {
        // Increment the failure counter
        fetchFailuresRef.current++;
       
        // If it's a network error, handle it gracefully without setting error state
        if (fetchError.message.includes('Failed to fetch')) {
          console.warn(`Network error fetching tasks (attempt ${fetchFailuresRef.current}): ${fetchError.message}`);
          setNetworkRetrying(true);
          setStatusMessage(`Network connection issue. Retrying... (${fetchFailuresRef.current})`);
         
          // Only show the error after many consecutive failures (but still don't stop the process)
          if (fetchFailuresRef.current > 10) {
            console.error('Multiple consecutive network failures:', fetchError);
          }
         
          // Continue polling despite the error
          return;
        }
       
        // For non-network errors, rethrow to be caught by the outer catch
        throw fetchError;
      }
      
      if (!tasks || tasks.length === 0) {
        console.warn('No tasks found, but this might be normal during processing');
        // Don't immediately error out - just set a status message and return
        setStatusMessage('Checking for tasks...');
        return; // Just return without erroring
      }
      
      // Check if image processing is complete for all tasks with the current group_id FIRST
      const allImageProcessed = tasks.every(t => t.process_image === true);
      if (allImageProcessed) {
        // Image processing is complete, stop showing progress and reset to idle
        console.log('All tasks have process_image set to true, resetting to idle state');
        setProgress(0);
        setTimeRemaining(null);
        setStatusMessage('');
        setGenerationState('idle');
        setBatchStatuses([]);
        return; // Exit early to stop polling
      }
      
      // Check if video processing is complete for all tasks with the current group_id
      const allVideoProcessed = tasks.every(t => t.video_process === true);
      if (allVideoProcessed) {
        // Video processing is complete, stop showing progress and reset to idle
        console.log('All tasks have video_process set to true, resetting to idle state');
        setProgress(0);
        setTimeRemaining(null);
        setStatusMessage('');
        setGenerationState('idle');
        setBatchStatuses([]);
        return; // Exit early to stop polling
      }
      
      if (tasks.some(t => t.status === 'running' && isTaskStalled(t))) {
        console.warn(`Found stalled tasks, resetting to pending`);
        for (const task of tasks.filter(t => t.status === 'running' && isTaskStalled(t))) {
          await updateTaskStatus(task.id, 'pending');
        }
        const pendingTask = tasks.find(t => t.status === 'pending');
        if (pendingTask) {
          await triggerNextBatch(currentGroupId!, currentUserId!, pendingTask.batch_number - 1);
        }
      }
      
      const filteredTasks = tasks.filter(t => t.batch_number > 0 && t.process_image !== true);
      const totalBatches = filteredTasks.length > 0 ? filteredTasks[0].total_batches : 0;
      const completedTasks = filteredTasks.filter(t => t.status === 'completed' || t.status === 'completed_final');
      const totalProgress = filteredTasks.reduce((sum, t) => sum + (t.progress || 0), 0);
      const progressPercent = Math.min(100, totalBatches > 0 ? (totalProgress / (totalBatches * 100)) * 100 : 0);
      
      // Stall detection: Check if no tasks are running or queued but we have fewer completed tasks than total batches
      const hasRunningOrQueued = tasks.some(t => t.status === 'running' || t.status === 'queued');
      if (!hasRunningOrQueued && completedTasks.length < totalBatches && !stallDetected) {
        console.log('No active batches detected, checking for stalled tasks...');
        setStatusMessage('No active batches detected. Checking for stalled tasks...');
       
        // Wait 30 seconds to confirm it's not a transient state
        setTimeout(async () => {
          try {
            // Recheck to confirm the stall persists
            const recheckTasks = await fetchTasks(currentUserId!, currentGroupId!, currentTab, currentVariant);
            const stillNoActive = !recheckTasks.some(t => t.status === 'running' || t.status === 'queued');
            const completedTasksCount = recheckTasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
           
            if (stillNoActive && completedTasksCount < totalBatches) {
              // Confirmed stall - attempt recovery
              setStallDetected(true);
              setStatusMessage('Stalled batch detected. Attempting to recover...');
              console.log('Stalled batch confirmed. Attempting recovery...');
              await recoverStalledBatch(recheckTasks);
            } else {
              // Stall resolved on its own
              setStatusMessage(`Processing batch ${completedTasksCount + 1} of ${totalBatches}`);
            }
          } catch (err) {
            console.error('Error during stall detection:', err);
          }
        }, STALL_DETECTION_TIMEOUT);
      } else {
        // Show progress only if image processing and video processing are not complete
        if (!allImageProcessed && !allVideoProcessed) {
          setProgress(progressPercent);
          setTotalInputTokens(tasks.reduce((sum, t) => sum + (t.input_tokens || 0), 0));
          setTotalOutputTokens(tasks.reduce((sum, t) => sum + (t.output_tokens || 0), 0));
          setStatusMessage(`Processing batch ${completedTasks.length + 1} of ${totalBatches}`);
          setBatchStatuses(filteredTasks.map(t => ({
            batchNumber: t.batch_number,
            status: t.status,
            progress: t.progress || 0,
          })));
          totalBatchesRef.current = totalBatches;
          setTimeRemaining((totalBatches - completedTasks.length) * 90);
        }
      }
      
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
        const tokenLimit = getPlanMaxTokens(planType, isLegacy);
        const rolloverTokens = currentPlan.rollover_tokens || 0;
        setUserTokenBalance(tokenLimit + rolloverTokens - currentPlan.tokens_used);
        setTotalTokens(currentPlan.tokens_used);
      }
      
      const errorTask = tasks.find(t => t.status === 'error');
      if (errorTask) {
        setError(errorTask.error || 'An error occurred during processing');
        setGenerationState('error');
        return;
      }
      
      const allCompleted = filteredTasks.every(t => t.status === 'completed_final');
      if (allCompleted && !allVideoProcessed && !allImageProcessed) {
        setGenerationState('writing');
        setStatusMessage('Generating Image Prompt Document...');
        setProgress(80);
        const { data: doc, error: docError } = await withRetry(
          () => withTimeout(
            supabase
              .from('story_documents')
              .select('file_url, title, is_corrected')
              .eq('group_id', currentGroupId)
              .eq('user_id', currentUserId)
              .eq('is_prompted', true)
              .order('created_at', { ascending: false })
              .limit(1)
              .single(),
            OPERATION_TIMEOUT,
            'fetchGeneratedDocument'
          ),
          'fetchGeneratedDocument'
        );
        if (docError || !doc) {
          throw new Error('Failed to fetch generated document');
        }
        // Fetch final user_plans state after all tasks are completed
        const { data: finalPlan, error: finalPlanError } = await withRetry(
          () => withTimeout(
            supabase
              .from('user_plans')
              .select('tokens_used, plan_type, rollover_tokens')
              .eq('user_id', currentUserId)
              .eq('is_active', true)
              .single(),
            OPERATION_TIMEOUT,
            'fetchFinalUserPlan'
          ),
          'fetchFinalUserPlan'
        );
        if (finalPlanError) {
          console.error('Failed to fetch final user plan:', finalPlanError);
        } else if (finalPlan) {
          const planType = finalPlan.plan_type || 'free';
          const tokenLimit = getPlanMaxTokens(planType, isLegacy);
          const rolloverTokens = finalPlan.rollover_tokens || 0;
          setUserTokenBalance(tokenLimit + rolloverTokens - finalPlan.tokens_used);
          setTotalTokens(finalPlan.tokens_used);
        }
        setGeneratedFileName(doc.file_url.split('/').pop() || '');
        setGeneratedDocTitle(doc.title);
        setIsCorrected(doc.is_corrected);
        setProgress(100);
        setTimeRemaining(0);
        setGenerationState('complete');
        setBatchStatuses([]);
        const { data: updatedDocs, error: fetchDocsError } = await withRetry(
          () => withTimeout(
            supabase
              .from('story_documents')
              .select('*')
              .eq('user_id', currentUserId)
              .order('created_at', { ascending: false }),
            OPERATION_TIMEOUT,
            'fetchUpdatedDocuments'
          ),
          'fetchUpdatedDocuments'
        );
        if (fetchDocsError) throw fetchDocsError;
        setDocuments(updatedDocs || []);
      }
    } catch (err: any) {
      console.error('Error polling tasks:', err);
     
      // For network errors, don't set error state, just update status
      if (err.message.includes('Failed to fetch')) {
        console.warn('Network error during polling, will retry:', err.message);
        setNetworkRetrying(true);
        setStatusMessage('Network connection issue. Retrying...');
      } else {
        // For other errors, set error state
        setError(err.message);
        setGenerationState('error');
      }
    }
  };

  const recoverStalledBatch = async (tasks: ImagePromptTask[]) => {
    try {
      // Find the last completed batch number
      const completedBatches = tasks
        .filter(t => t.status === 'completed' || t.status === 'completed_final')
        .map(t => t.batch_number);
     
      const lastCompletedBatch = completedBatches.length ? Math.max(...completedBatches) : 0;
     
      // Find the first pending task with batch_number >= lastCompletedBatch
      const pendingTasks = tasks
        .filter(t => t.status === 'pending' && t.batch_number >= lastCompletedBatch)
        .sort((a, b) => a.batch_number - b.batch_number);
     
      if (pendingTasks.length === 0) {
        console.log('No pending tasks found to recover');
        setStatusMessage('No pending tasks found to recover.');
        setStallDetected(false);
        return;
      }
     
      const pendingTask = pendingTasks[0];
      console.log(`Recovering batch ${pendingTask.batch_number}...`);
     
      // Update the task status to queued
      await updateTaskStatus(pendingTask.id, 'queued');
     
      // Trigger the next batch processing
      await triggerNextBatch(currentGroupId!, currentUserId!, pendingTask.batch_number);
     
      console.log(`Recovery successful for batch ${pendingTask.batch_number}`);
      setStatusMessage(`Recovered batch ${pendingTask.batch_number}. Processing resumed.`);
    } catch (err) {
      console.error('Error recovering stalled batch:', err);
      setStatusMessage('Failed to recover stalled batch. Retrying on next poll...');
    } finally {
      // Reset the stall detection flag after a brief delay
      setTimeout(() => setStallDetected(false), 1000);
    }
  };

  useEffect(() => {
    if (generationState !== 'generating' || !currentGroupId || !currentUserId) return;

    let subscriptionActive = false;
    
    console.log(`Setting up subscription for main database`);

    const subscription = supabase
      .channel(`image_prompt_tasks:${currentGroupId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'image_prompt_tasks',
          filter: `group_id=eq.${currentGroupId}`,
        },
        (payload) => {
          console.log(`Realtime task update:`, {
            event: payload.eventType,
            task_id: payload.new?.id || payload.old?.id,
            status: payload.new?.status || payload.old?.status,
            progress: payload.new?.progress || payload.old?.progress,
            batch_number: payload.new?.batch_number || payload.old?.batch_number,
            timestamp: new Date().toISOString(),
          });
          lastUpdateRef.current = Date.now();
          lastSubscriptionUpdateRef.current = Date.now();
          subscriptionActive = true;
          fetchTasksForPolling();
        }
      )
      .subscribe((status, err) => {
        if (err) {
          console.error(`Subscription error:`, err.message);
          subscriptionActive = false;
        } else {
          console.log(`Subscription status:`, status);
          subscriptionActive = status === 'SUBSCRIBED';
          lastSubscriptionUpdateRef.current = Date.now();
        }
      });

    const pollTasksInterval = async () => {
      if (subscriptionActive && Date.now() - lastUpdateRef.current < POLLING_INTERVAL) {
        console.log('Skipping poll: Subscription active and recent update received');
        return;
      }
      console.log('Polling tasks due to inactive subscription or no recent updates');
      await fetchTasksForPolling();
    };

    const checkSubscription = () => {
      if (!subscriptionActive && Date.now() - lastSubscriptionUpdateRef.current > SUBSCRIPTION_CHECK_INTERVAL) {
        console.warn('Subscription inactive for 60s, attempting to reconnect');
        if (subscription) {
          subscription.unsubscribe();
          // Recreate subscription
          const newSubscription = supabase
            .channel(`image_prompt_tasks:${currentGroupId}`)
            .on(
              'postgres_changes',
              {
                event: '*',
                schema: 'public',
                table: 'image_prompt_tasks',
                filter: `group_id=eq.${currentGroupId}`,
              },
              (payload) => {
                console.log(`Realtime task update (reconnected):`, {
                  event: payload.eventType,
                  task_id: payload.new?.id || payload.old?.id,
                  status: payload.new?.status || payload.old?.status,
                  progress: payload.new?.progress || payload.old?.progress,
                  batch_number: payload.new?.batch_number || payload.old?.batch_number,
                  timestamp: new Date().toISOString(),
                });
                lastUpdateRef.current = Date.now();
                lastSubscriptionUpdateRef.current = Date.now();
                subscriptionActive = true;
                fetchTasksForPolling();
              }
            )
            .subscribe((status, err) => {
              if (err) {
                console.error(`Reconnected subscription error:`, err.message);
                subscriptionActive = false;
              } else {
                console.log(`Reconnected subscription status:`, status);
                subscriptionActive = status === 'SUBSCRIBED';
                lastSubscriptionUpdateRef.current = Date.now();
              }
            });
        }
      }
    };

    // Add network status listener
    const handleNetworkChange = () => {
      if (navigator.onLine) {
        console.log('Network restored, resuming polling');
        setNetworkRetrying(false);
        setStatusMessage('Network connection restored. Resuming...');
        fetchTasksForPolling(); // Trigger immediate poll
      } else {
        console.warn('Network lost, will retry when connection is restored');
        setNetworkRetrying(true);
        setStatusMessage('Network connection lost. Waiting to reconnect...');
      }
    };

    window.addEventListener('online', handleNetworkChange);
    window.addEventListener('offline', handleNetworkChange);

    const pollInterval = setInterval(pollTasksInterval, POLLING_INTERVAL);
    const subscriptionCheckInterval = setInterval(checkSubscription, SUBSCRIPTION_CHECK_INTERVAL);

    // Initial fetch to populate data
    fetchTasksForPolling();

    return () => {
      if (subscription) {
        subscription.unsubscribe();
      }
      clearInterval(pollInterval);
      clearInterval(subscriptionCheckInterval);
      window.removeEventListener('online', handleNetworkChange);
      window.removeEventListener('offline', handleNetworkChange);
    };
  }, [generationState, currentGroupId, currentUserId, stallDetected]);

  useEffect(() => {
    if (generationState !== 'generating' || !currentGroupId || !generationStartTime.current || !currentUserId) return;

    const checkStall = async () => {
      const elapsed = Date.now() - generationStartTime.current!;
      if (elapsed > TASK_STALL_TIMEOUT) {
        console.warn(`Task processing stalled after ${TASK_STALL_TIMEOUT / 1000} seconds`);
        try {
          if (!checkNetworkStatus()) {
            throw new Error('No internet connection');
          }
          
          const tasks = await fetchTasks(currentUserId, currentGroupId, currentTab, currentVariant);
         
          if (!tasks || tasks.length === 0) {
            console.log('No tasks found during stall check');
            setError('No tasks found. Please try again.');
            setGenerationState('error');
            return;
          }
          const allStalled = tasks.every(t => isTaskStalled(t));
          if (allStalled) {
            const { data: doc } = await withRetry(
              () => withTimeout(
                supabase
                  .from('story_documents')
                  .select('file_url, title, word_count, is_corrected')
                  .eq('group_id', currentGroupId)
                  .eq('user_id', currentUserId)
                  .order('created_at', { ascending: false })
                  .limit(1)
                  .single(),
                OPERATION_TIMEOUT,
                'fetchStalledDocument'
              ),
              'fetchStalledDocument'
            );
           
            if (doc) {
              const response = await withRetry(
                () => withTimeout(
                  fetch(doc.file_url).then(res => {
                    if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch document content`);
                    return res;
                  }),
                  OPERATION_TIMEOUT,
                  'fetchDocumentContent'
                ),
                'fetchDocumentContent'
              );
             
              const content = await response.text();
              setGeneratedFileName(doc.file_url.split('/').pop() || '');
              setGeneratedDocTitle(doc.title);
              setProgress(100);
              setTimeRemaining(0);
              setGenerationState('complete');
              setError('Prompt generation stalled. Saved partial document.');
            } else {
              setError('Prompt generation stalled. No partial document saved.');
              setGenerationState('error');
            }
            generationStartTime.current = null;
          }
        } catch (err: any) {
          console.error('Error checking stalled tasks:', err);
          setError(`Failed to check task status: ${err.message}`);
          setGenerationState('error');
          generationStartTime.current = null;
        }
      }
    };

    const stallInterval = setInterval(checkStall, 300000);
    return () => clearInterval(stallInterval);
  }, [generationState, currentGroupId, currentUserId]);

  const handleGeneratePrompts = async () => {
    if (!validateSettings()) {
      setError('Please fix the validation errors before generating');
      return;
    }

    setGenerationState('generating');
    setProgress(0);
    setStatusMessage('Preparing prompt generation...');
    setTimeRemaining(null);
    setBatchStatuses([]);
    generationStartTime.current = Date.now();
    processedTaskIds.current = new Set();

    try {
      if (!checkNetworkStatus()) {
        throw new Error('No internet connection');
      }

      const { data: { user } } = await withRetry(
        () => withTimeout(supabase.auth.getUser(), OPERATION_TIMEOUT, 'getUser'),
        'getUser'
      );

      if (!user) throw new Error('User not authenticated');
      setCurrentUserId(user.id);

      // Note: We do NOT delete image_prompt_tasks here. The variant system in 
      // storyscriptai-setup-prompt will handle detecting existing variants and assigning
      // the next available variant number. This allows multiple concurrent generations
      // to coexist without interference.
      console.log(`[ImagePrompts] Starting generation for tab ${currentTab} - keeping existing tasks for variant system`);

      let content: string;
      let docTitle: string | null = null;
      let docIsCorrected: boolean = false;
      let docDescription: string = '';
      let filePath: string | null = null;
      let docId: string | null = null;
      let groupId: string | null = null;

      // Get document content
      if (selectedDoc) {
        const doc = documents.find(doc => doc.id === selectedDoc);
        console.log(`Fetching content for selectedDoc: ${selectedDoc}, title: ${doc?.title}, file_path: ${doc?.file_path}`);
        if (!doc) throw new Error('Selected document not found');

        setStatusMessage('Downloading document...');
        content = await fetchDocContent(doc.file_path);

        docTitle = doc.title;
        docIsCorrected = doc.is_corrected;
        docDescription = doc.description || '';
        filePath = doc.file_path;
        docId = doc.id;
        groupId = doc.group_id || uuidv4();
      } else if (uploadedDoc) {
        // For uploaded documents, we've already validated and saved them to the story_documents table
        // Find the document in the documents array by matching the file name
        if (!uploadedDoc.name) {
          throw new Error('Uploaded document name is missing');
        }
        
        const uploadedDocName = uploadedDoc.name.replace(/\.txt$/, '');
        const doc = documents.find(d => d.title === uploadedDocName);
        console.log(`Fetching content for uploadedDoc: ${uploadedDocName}, found title: ${doc?.title}, file_path: ${doc?.file_path}`);

        if (!doc) {
          throw new Error('Uploaded document not found in saved documents');
        }

        setStatusMessage('Downloading document...');
        content = await fetchDocContent(doc.file_path);

        docTitle = doc.title;
        docIsCorrected = doc.is_corrected;
        docDescription = doc.description || '';
        filePath = doc.file_path;
        docId = doc.id;
        groupId = doc.group_id || uuidv4();
      } else {
        throw new Error('Please select a document or upload a file');
      }

      // Initial word count
      const wordCount = calculateWordCount(content);
      console.log(`Document word count: ${wordCount}, content length: ${content.length}`);

      if (wordCount > MAX_WORD_COUNT) {
        throw new Error(`Document exceeds the maximum word count limit of ${MAX_WORD_COUNT} words. Your document has ${wordCount} words.`);
      }

      // Calculate estimated token usage for validation using Python logic
      const totalLength = wordCount * 5; // Use 5 chars per word as in Python
      const firstPageFreq = parseFloat(settings.firstPageFrequency);
      const restFreq = parseFloat(settings.restFrequency);

      // Calculate number of prompts using Python logic
      const firstPageCharsPerSegment = Math.max(100, Math.min(3000, Math.round(firstPageFreq * 13.67)));
      const firstPageSegments = Math.ceil(3000 / firstPageCharsPerSegment);

      const remainingChars = Math.max(0, totalLength - 3000);
      const restCharsPerSegment = Math.max(100, Math.round(restFreq * 13.67));
      const restSegments = remainingChars > 0 ? Math.ceil(remainingChars / restCharsPerSegment) : 0;

      let totalPrompts = firstPageSegments + restSegments;
      // Apply 18% increase as per Python logic
      totalPrompts = Math.round(totalPrompts * 1.18);

      // Calculate token usage using Python logic
      let totalInputTokens = wordCount * 1.33;
      const segmentsPerBatch = restFreq > 120 ? 1 : 2;
      const batchCount = Math.max(1, Math.ceil(totalPrompts / segmentsPerBatch));
      totalInputTokens += batchCount * 500; // fixed input per batch

      let totalOutputTokens = totalPrompts * 600 * 1.33;

      if (settings.useCharacterDescriptions) {
        const userChars = Math.min(10000, totalLength);
        const userWords = Math.round(userChars / 5.5);
        totalInputTokens += (128 + userWords) * 1.33;
        totalOutputTokens += 400;
      }

      // Add token cost for custom character AI enhancement
      if (settings.customCharactersEnabled && settings.customCharactersAIEnhance) {
        const validChars = settings.customCharacters.filter(c => c.name.trim());
        if (validChars.length > 0) {
          totalInputTokens += 500 * 1.33; // System prompt + character descriptions
          totalOutputTokens += validChars.length * 150 * 1.33; // ~150 words per enhanced description
        }
      }

      // Apply safety multipliers
      totalInputTokens *= 1.25; // 25% safety buffer for input
      // No multiplier for output tokens

      const estimatedTokenUsage = Math.round((totalInputTokens * 0.25 + totalOutputTokens) * selectedModel.tokenMultiplier);

      setStatusMessage('Validating token balance...');
      if (userTokenBalance < estimatedTokenUsage) {
        throw new Error(
          `Insufficient tokens to generate image prompts. ` +
          `Required: ${estimatedTokenUsage.toLocaleString()} tokens, ` +
          `Available: ${userTokenBalance.toLocaleString()}`
        );
      }

      let variant = 1;
      const { data: existingDocs, error: fetchVariantError } = await supabase
        .from('story_documents')
        .select('variant')
        .eq('group_id', groupId)
        .eq('is_prompted', true)
        .order('variant', { ascending: false });

      if (fetchVariantError) {
        throw new Error(`Failed to fetch existing variants: ${fetchVariantError.message}`);
      }

      if (existingDocs && existingDocs.length > 0) {
        const highestVariant = Math.max(...existingDocs.map(doc => doc.variant || 0));
        variant = highestVariant + 1;
      }

      setStatusMessage('Setting up tasks in the cloud...');
      const result = await setupImagePromptTasks({
        user_id: user.id,
        group_id: groupId,
        file_path: filePath,
        story_title: docTitle,
        description: docDescription,
        style: settings.style,
        useCharacterDescriptions: settings.useCharacterDescriptions,
        // For consistent mode, send null for firstPageFrequency to ensure all segments are treated equally
        firstPageFrequency: (settings.frequencyType === 'consistent') ? null : parseFloat(settings.firstPageFrequency),
        // For consistent mode, use consistentFrequency value as restFrequency
        restFrequency: (settings.frequencyType === 'consistent' && settings.consistentFrequency) 
          ? parseFloat(settings.consistentFrequency) 
          : parseFloat(settings.restFrequency),
        variant,
        doc_id: docId,
        userTokenBalance,
        imageModel: settings.imageModel,
        language: settings.language,
        model: settings.model,
        tab: currentTab,
        // Audio mode fields
        frequencyMode: settings.frequencyMode || 'wordcount',
        frequencyType: settings.frequencyType || 'consistent',
        consistentFrequency: settings.consistentFrequency ? parseFloat(settings.consistentFrequency) : undefined,
        audioFiles: settings.audioFiles,
        totalAudioDuration: settings.totalAudioDuration,
        imageAmount: settings.imageAmount ? parseInt(settings.imageAmount) : undefined,
        audioDistributionType: settings.audioDistributionType,
        audioFirstPageImageCount: settings.audioFirstPageImageCount ? parseInt(settings.audioFirstPageImageCount) : undefined,
        audioRestImageCount: settings.audioRestImageCount ? parseInt(settings.audioRestImageCount) : undefined,
        // V2 format fields - Enable V2 by default with basic Master Prompt
        promptFormatVersion: 2,
        masterPromptData: {
          fullPrompt: '', // No master prompt by default
          environmentOnly: false,
          characters: [], // Character extraction handled by backend
          styleData: {
            style: settings.style,
            description: docDescription
          }
        },
        // Custom character fields
        customCharactersEnabled: settings.customCharactersEnabled,
        customCharacters: settings.customCharactersEnabled 
          ? settings.customCharacters.filter(c => c.name.trim()) 
          : [],
        customCharactersAIEnhance: settings.customCharactersEnabled && settings.customCharactersAIEnhance,
      });

      setCurrentGroupId(groupId);
      setGeneratedGroupId(groupId);
      setGeneratedVariant(variant);
      setCurrentVariant(variant);
      setTimeRemaining(calculateEstimatedTime(result.total_batches || 1));
      setStatusMessage('Generating prompts...');

      // Update tab status to 'generating' and save group_id + selected_doc_id
      await updateTabStatus(user.id, 'image_prompt', currentTab, 'generating', groupId, docTitle);
      await updateTabGroupAndDoc(user.id, 'image_prompt', currentTab, groupId, docId || undefined);
    } catch (err: any) {
      console.error('Error in handleGeneratePrompts:', err);
      setError(err.message || 'An error occurred during generation');
      setGenerationState('error');
    }
  };

  const handleDone = async () => {
    if (!currentUserId) {
      console.error('No user authenticated');
      setError('Authentication error');
      setGenerationState('error');
      return;
    }
 
    try {
      // Delete all tasks for the user in this tab
      try {
        let deleteQuery = supabase
          .from('image_prompt_tasks')
          .delete()
          .eq('user_id', currentUserId)
          .eq('tab', currentTab)
          .or('video_process.is.null,video_process.eq.false')
          .eq('process_image', false);

        // Add variant filter if we have a current variant
        if (currentVariant !== null) {
          deleteQuery = deleteQuery.eq('variant', currentVariant);
        }

        await withRetry(
          () => withTimeout(
            deleteQuery,
            OPERATION_TIMEOUT,
            'deleteUserTasks'
          ),
          'deleteUserTasks'
        );
        console.log(`Successfully deleted all tasks for user ${currentUserId} tab ${currentTab} variant ${currentVariant}`);

        // Delete image_prompt_context for the same group
        if (currentGroupId) {
          await withRetry(
            () => withTimeout(
              supabase
                .from('image_prompt_context')
                .delete()
                .eq('group_id', currentGroupId),
              OPERATION_TIMEOUT,
              'deleteImagePromptContext'
            ),
            'deleteImagePromptContext'
          );
          console.log(`Successfully deleted image_prompt_context for group ${currentGroupId}`);
        }
      } catch (deleteError) {
        console.log('Failed to delete tasks:', deleteError);
      }

      // Reset tab to defaults
      await resetImageTabToDefaults(currentUserId, currentTab);
 
      await clearSupabaseSession(currentUserId);
      // Clear session storage to prevent state rehydration
      sessionStorage.clear();
    } catch (err: any) {
      console.error('Error stopping generation:', err);
      setError(`Failed to stop generation: ${err.message}`);
      setGenerationState('error');
      return;
    }
 
    // Reset all relevant state to initial values
    setGenerationState('idle');
    setError(null);
    setTotalInputTokens(0);
    setTotalOutputTokens(0);
    setProgress(0);
    setTimeRemaining(null);
    setStatusMessage('');
    setGeneratedFileName('');
    setGeneratedDocTitle('');
    setIsCorrected(false);
    setGeneratedGroupId(null);
    setGeneratedVariant(null);
    setSelectedDoc(''); // Explicitly clear selected document
    setUploadedDoc(null); // Explicitly clear uploaded document
    totalBatchesRef.current = 0;
    setCurrentGroupId(null);
    setSessionStorageError(null);
    setBatchStatuses([]);
    generationStartTime.current = null;
    // Reset processed task IDs
    processedTaskIds.current = new Set();
    setCurrentVariant(null);
  };

  const formatTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const fetchFileContent = async () => {
    if (!checkNetworkStatus()) {
      setError('No internet connection. Please check your connection and try again.');
      return;
    }
    
    if (!currentUserId) {
      setError('Authentication error. Please sign in again.');
      return;
    }
    
    setIsLoadingContent(true);
    try {
      if (!generatedFileName || !generatedGroupId) {
        throw new Error('No file available to edit');
      }
      
      const filePath = `documents/${currentUserId}/${generatedGroupId}/${generatedFileName}`;
      const { data, error } = await withRetry(
        () => withTimeout(
          supabase.storage
            .from('stories')
            .download(filePath),
          OPERATION_TIMEOUT,
          'fetchFileContent'
        ),
        'fetchFileContent'
      );
      
      if (error) throw error;
      if (!data) throw new Error('No file data received');
      
      const text = await data.text();
      setEditableContent(text);
      setIsEditing(true);
    } catch (err: any) {
      setError(`Failed to load content: ${err.message || 'Please try again.'}`);
    } finally {
      setIsLoadingContent(false);
    }
  };

  const saveEditedContent = async () => {
    if (!checkNetworkStatus()) {
      setError('No internet connection. Please check your connection and try again.');
      return;
    }
    
    if (!currentUserId) {
      setError('Authentication error. Please sign in again.');
      return;
    }
    
    setIsSaving(true);
    try {
      if (!generatedFileName || !generatedGroupId) {
        throw new Error('No file available to save');
      }
      
      const filePath = `documents/${currentUserId}/${generatedGroupId}/${generatedFileName}`;
      const blob = new Blob([editableContent], { type: 'text/plain' });
      
      const { error: uploadError } = await withRetry(
        () => withTimeout(
          supabase.storage
            .from('stories')
            .update(filePath, blob, {
              contentType: 'text/plain',
              upsert: true
            }),
          OPERATION_TIMEOUT,
          'saveEditedContent'
        ),
        'saveEditedContent'
      );
      
      if (uploadError) throw uploadError;
      
      // Update story_documents updated_at timestamp
      const { error: dbError } = await withRetry(
        () => withTimeout(
          supabase
            .from('story_documents')
            .update({ updated_at: new Date().toISOString() })
            .eq('group_id', generatedGroupId)
            .eq('user_id', currentUserId)
            .eq('is_prompted', true),
          OPERATION_TIMEOUT,
          'updateDocumentTimestamp'
        ),
        'updateDocumentTimestamp'
      );
      
      if (dbError) console.warn('Failed to update timestamp:', dbError);
      
      setIsEditing(false);
      setEditableContent('');
      // Clear any previous errors on successful save
      setError(null);
    } catch (err: any) {
      setError(`Failed to save: ${err.message || 'Please try again.'}`);
    } finally {
      setIsSaving(false);
    }
  };

  const downloadDocument = async () => {
    if (!checkNetworkStatus()) {
      setError('No internet connection. Please check your connection and try again.');
      return;
    }
   
    if (!currentUserId) {
      setError('Authentication error. Please sign in again.');
      return;
    }
    try {
      if (!generatedFileName || !generatedGroupId) {
        throw new Error('No file available for download');
      }
      const filePath = `documents/${currentUserId}/${generatedGroupId}/${generatedFileName}`;
      const { data, error } = await withRetry(
        () => withTimeout(
          supabase.storage
            .from('stories')
            .download(filePath),
          OPERATION_TIMEOUT,
          'downloadDocument'
        ),
        'downloadDocument'
      );
      if (error) throw error;
      if (!data) throw new Error('No file data received');
      saveAs(data, generatedFileName);
    } catch (err: any) {
      setError(err.message || 'Error downloading the file. Please try again.');
    }
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent-text"></div>
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
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120%] h-[500px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(220,38,38,0.10)_0%,transparent_70%)]" />
          <div className="absolute top-40 left-0 w-[40%] h-[300px] bg-[radial-gradient(ellipse_80%_80%_at_20%_50%,rgba(59,130,246,0.05)_0%,transparent_60%)]" />
        </div>

        <div>
          
          <div>
            <div className="relative mb-8 dash-animate-in">
              <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Image Prompt Generator</h1>
              <div className="mt-2">
                <p className="text-text-secondary">Create detailed image prompts from your stories</p>
                <p className="text-text-muted text-sm mt-1">{formatNumber(userTokenBalance)} tokens remaining</p>
              </div>

              {/* What to Expect info box */}
              <div className="mt-5 p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card dash-animate-in">
                <h3 className="text-xl font-semibold mb-2 text-accent">What to Expect</h3>
                <p className="text-[15px] text-white/80 leading-relaxed">
                  Select a story document or upload one, choose an image style, and configure how frequently images should appear.
                  The AI analyzes your story's narrative structure — characters, settings, and key scenes — to generate
                  detailed, context-aware image prompts.
                </p>
                <Link
                  to="/learn#image-prompt-generator"
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
                    Use word-count or audio-based frequency to control how many images are generated. Character consistency keeps descriptions uniform across all prompts.
                  </p>
                </div>
              </div>

              {/* Multi-Tab Manager for Premium Users (Elite, Ultimate, Enterprise) */}
              {isEnterpriseUser && user && (
                <TabManager
                  userId={user.id}
                  isEnterpriseUser={isEnterpriseUser}
                  currentTab={currentTab}
                  page="image_prompt"
                  initialTabs={initialTabs}
                  onTabChange={onTabChange}
                  onTabCreate={onTabCreate}
                  onTabClose={onTabClose}
                />
              )}

              {generationState === 'generating' && (
                <div className="mt-8 p-5 rounded-2xl bg-[--color-status-info-bg] border border-[--color-status-info-border] mb-6 dash-animate-in">
                  <div className="flex items-center space-x-3">
                    <div className="flex-shrink-0 h-10 w-10 rounded-full bg-[--color-status-info-bg] flex items-center justify-center">
                      <RefreshCw className="h-5 w-5 text-status-info animate-spin" />
                    </div>
                    <div>
                      <h3 className="text-lg font-display font-semibold text-status-info">
                        Generating Image Prompts...
                      </h3>
                      <p className="text-sm mt-0.5" style={{ color: 'rgba(96, 165, 250, 0.7)' }}>
                        {statusMessage} ({Math.round(progress)}% complete)
                        {timeRemaining !== null && ` · ${formatTime(timeRemaining)} remaining`}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {generationState === 'complete' && generatedDocTitle && (
                <div className="mt-8 p-5 rounded-2xl bg-[--color-status-success-bg] border border-[--color-status-success-border] mb-6 dash-animate-in">
                  <div className="flex items-center space-x-3">
                    <div className="flex-shrink-0 h-10 w-10 rounded-full bg-[--color-status-success-bg] flex items-center justify-center">
                      <CheckCircle2 className="h-6 w-6 text-status-success" />
                    </div>
                    <div>
                      <h3 className="text-lg font-display font-semibold text-status-success">
                        {generatedDocTitle} Image Prompts are done generating!
                      </h3>
                      <p className="text-sm mt-0.5" style={{ color: 'rgba(74, 222, 128, 0.7)' }}>
                        Ready for download or use with the Image Generator.
                      </p>
                    </div>
                  </div>
                </div>
              )}
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

            {networkRetrying && (
              <div className="bg-status-warning text-status-warning-text p-4 rounded-xl mb-6">
                <div className="flex items-center space-x-2 text-status-warning mb-2">
                  <RefreshCw className="h-5 w-5 animate-spin" />
                  <h3 className="text-lg font-medium">Network Issue</h3>
                </div>
                <p>Attempting to reconnect to the server. Your generation is still processing in the background. Reload page to see progress.</p>
              </div>
            )}

            {error && !error.includes('Failed to fetch') && (
              <div className="bg-status-error text-status-error p-4 rounded-xl mb-6">
                <div className="flex items-center space-x-2 text-status-error mb-2">
                  <AlertCircle className="h-5 w-5" />
                  <h3 className="text-lg font-medium">Error</h3>
                </div>
                <p>
                  {error.includes('Rate limit') ? 'The server is busy. Please wait a moment and try again.' :
                   error.includes('Invalid input') ? 'Please check your inputs and try again.' :
                   error}
                </p>
                <div className="flex space-x-4 mt-4">
                  <button
                    onClick={handleDone}
                    className="px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover transition duration-150 ease-in-out"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-6 dash-stagger">
              <div
                className="dash-collapse-grid"
                data-collapsed={generationState !== 'idle' ? 'true' : 'false'}
              >
                <div>
              <div className="space-y-5">
              <div className="relative px-1">
                <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">Select Document</label>
                <div className="space-y-4">
                  <div>
                    <Listbox
                      value={selectedDoc}
                      onChange={(value) => {
                        if (value !== selectedDoc) {
                          clearAnalysisData();
                        }
                        console.log(`Changing selected document from ${selectedDoc} to ${value}`);
                        setSelectedDoc(value);
                        setUploadedDoc(null);
                      }}
                      disabled={uploadedDoc !== null || generationState !== 'idle'}
                    >
                      {({ open }) => (
                        <div className="relative">
                          <Listbox.Button className={`relative w-full rounded-xl bg-surface-input border border-white/[0.13] px-5 py-4 text-left text-white/90 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 shadow-sm transition-all duration-200 ${uploadedDoc !== null || generationState !== 'idle' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-surface-input'}`}>
                            <span className="block truncate">
                              {selectedDoc
                                ? documents.find(doc => doc.id === selectedDoc)?.title
                                : <span className="italic text-white/40">None - Select a document</span>}
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
                            <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-dropdown border border-white/[0.11] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                              <Listbox.Option
                                value=""
                                className={({ active, selected }) =>
                                  `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${
                                    active ? 'bg-white/[0.08] text-white' : 'text-white/75'
                                  } ${selected ? 'font-medium' : 'font-normal'}`
                                }
                              >
                                {({ selected }) => (
                                  <>
                                    <div className="flex flex-col">
                                      <span className={`text-sm italic ${selected ? 'font-medium text-white/75' : 'text-white/50'}`}>
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
                                .filter(doc => !doc.is_prompted && (doc.version === 1 || doc.version === 2))
                                .map((doc) => (
                                  <Listbox.Option
                                    key={doc.id}
                                    value={doc.id}
                                    className={({ active, selected }) =>
                                      `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${
                                        active ? 'bg-white/[0.08] text-white' : 'text-white/75'
                                      } ${selected ? 'font-medium' : 'font-normal'}`
                                    }
                                  >
                                    {({ selected }) => (
                                      <>
                                        <div className="flex flex-col">
                                          <span className={selected ? 'font-medium' : 'font-normal'}>
                                            {doc.title}
                                          </span>
                                          <span className="text-sm text-text-muted flex items-center">
                                            <Calendar className="h-4 w-4 mr-1" />
                                            {formatDate(doc.created_at)} • {doc.word_count || 'Unknown'} words
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
                              {documents.filter(doc => !doc.is_prompted).length === 0 && (
                                <div className="py-2 px-4 text-text-muted text-sm">
                                  No documents available
                                </div>
                              )}
                            </Listbox.Options>
                          </Transition>
                        </div>
                      )}
                    </Listbox>
                  </div>

                  <div className="relative">
                    <div className="flex items-center justify-center w-full">
                      <label
                        className={`flex flex-col items-center justify-center w-full h-32 border-2 border-white/[0.13] border-dashed rounded-xl ${
                          generationState !== 'idle' ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-white/[0.08]'
                        } bg-surface-card transition-colors`}
                      >
                        <div className="flex flex-col items-center justify-center pt-5 pb-6">
                          <Upload className="w-8 h-8 mb-3 text-text-muted" />
                          <p className="mb-2 text-sm text-text-muted">
                            <span className="font-semibold">Click to upload</span> or drag and drop
                          </p>
                          <p className="text-xs text-white/40">TXT files only (max 1024 KB)</p>
                        </div>
                        <input
                          type="file"
                          className="hidden"
                          accept=".txt"
                          onChange={handleFileUpload}
                          disabled={selectedDoc !== '' || generationState !== 'idle'}
                        />
                      </label>
                    </div>
                    {uploadedDoc && (
                      <div className="mt-2 flex items-center justify-between bg-surface-card p-2 rounded-xl">
                        <span className="text-sm text-text-secondary">{uploadedDoc.name}</span>
                        <button
                          onClick={() => setUploadedDoc(null)}
                          className="text-text-muted hover:text-white"
                          disabled={generationState !== 'idle'}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="relative px-1 mt-6">
                <label className="text-[11px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">Generation Settings</label>
              </div>
                <div className="space-y-5">
                  <ImageModelSelector
                    selectedModel={settings.imageModel}
                    selectedStyle={settings.style}
                    onModelChange={(model) => setSettings({...settings, imageModel: model as any})}
                    onStyleChange={(style) => setSettings({...settings, style})}
                    disabled={generationState !== 'idle'}
                    isLegacy={isLegacy}
                  />

                  <div className="space-y-5" style={{ zoom: 1 / 1.1 }}>
                  <div className="p-5 rounded-2xl bg-surface-card border border-border-card">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-white font-medium">Character Consistency</h3>
                        <p className="text-text-muted text-sm mt-2">Maintain consistent character descriptions across all prompts</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={settings.useCharacterDescriptions}
                        aria-label="Toggle character consistency"
                        onClick={() => generationState === 'idle' && setSettings({ ...settings, useCharacterDescriptions: !settings.useCharacterDescriptions })}
                        disabled={generationState !== 'idle'}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                          settings.useCharacterDescriptions ? 'bg-accent' : 'bg-white/10'
                        } ${generationState !== 'idle' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                            settings.useCharacterDescriptions ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  </div>

                  {/* Custom Characters Section - only visible when Character Consistency is ON */}
                  {settings.useCharacterDescriptions && (
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
                          aria-checked={settings.customCharactersEnabled}
                          aria-label="Toggle custom characters"
                          onClick={() => generationState === 'idle' && setSettings({ 
                            ...settings, 
                            customCharactersEnabled: !settings.customCharactersEnabled,
                            customCharacters: !settings.customCharactersEnabled && settings.customCharacters.length === 0 
                              ? [{ name: '', description: '' }] 
                              : settings.customCharacters
                          })}
                          disabled={generationState !== 'idle'}
                          className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
settings.customCharactersEnabled ? 'bg-accent' : 'bg-white/10'
                          } ${generationState !== 'idle' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                              settings.customCharactersEnabled ? 'translate-x-6' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      </div>

                      {/* Custom Characters Fields */}
                      {settings.customCharactersEnabled && (
                        <div className="space-y-4">
                          {/* Info Warning Box */}
                          <div className="flex items-start gap-2 p-4 bg-status-warning border border-status-warning rounded-xl">
                            <AlertCircle className="h-5 w-5 text-status-warning flex-shrink-0 mt-0.5" />
                            <div>
                              <p className="text-sm text-status-warning-text font-medium">Important</p>
                              <p className="text-xs text-status-warning-text mt-1">
                                Custom character descriptions will override automatic character extraction from your story. 
                                Make sure character names exactly match the names used in your story text for proper matching in image prompts.
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
                              {settings.customCharacters.map((char, index) => (
                                <div key={index} className="flex gap-2 items-start">
                                  <div className="flex-1 space-y-2">
                                    <input
                                      type="text"
                                      value={char.name}
                                      onChange={(e) => {
                                        const newChars = [...settings.customCharacters];
                                        newChars[index] = { ...newChars[index], name: e.target.value };
                                        setSettings({ ...settings, customCharacters: newChars });
                                      }}
                                      placeholder="Character name (must match story text)"
                                      className="w-full px-4 py-3 bg-surface-input border border-white/[0.13] rounded-xl text-white text-sm placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50"
                                      disabled={generationState !== 'idle'}
                                    />
                                    <textarea
                                      value={char.description}
                                      onChange={(e) => {
                                        const newChars = [...settings.customCharacters];
                                        newChars[index] = { ...newChars[index], description: e.target.value };
                                        setSettings({ ...settings, customCharacters: newChars });
                                      }}
                                      placeholder="Physical appearance, clothing, build, facial features, hair, accessories..."
                                      className="w-full px-4 py-3 bg-surface-input border border-white/[0.13] rounded-xl text-white text-sm placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 resize-none"
                                      rows={2}
                                      disabled={generationState !== 'idle'}
                                    />
                                  </div>
                                  {settings.customCharacters.length > 1 && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const newChars = settings.customCharacters.filter((_, i) => i !== index);
                                        setSettings({ ...settings, customCharacters: newChars });
                                      }}
                                      disabled={generationState !== 'idle'}
                                      className="mt-1 p-2 text-status-error hover:text-status-error hover:bg-white/[0.08] rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                      <X className="w-5 h-5" />
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>

                            {settings.customCharacters.length < 10 && (
                              <button
                                type="button"
                                onClick={() => {
                                  setSettings({
                                    ...settings,
                                    customCharacters: [...settings.customCharacters, { name: '', description: '' }]
                                  });
                                }}
                                disabled={generationState !== 'idle'}
                                className="mt-3 w-full py-3 bg-surface-card hover:bg-surface-input border border-border-card rounded-xl text-text-secondary text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
                              <p className="mt-1 text-xs text-text-muted">
                                Let AI expand your basic character descriptions into detailed visual descriptions optimized for image generation. Provide just the essentials—AI fills in the visual details.
                              </p>
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={settings.customCharactersAIEnhance}
                              aria-label="Toggle AI enhancement"
                              onClick={() => generationState === 'idle' && setSettings({ ...settings, customCharactersAIEnhance: !settings.customCharactersAIEnhance })}
                              disabled={generationState !== 'idle'}
                              className={`ml-4 flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                                settings.customCharactersAIEnhance ? 'bg-accent' : 'bg-white/10'
                              } ${generationState !== 'idle' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                            >
                              <span
                                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                                  settings.customCharactersAIEnhance ? 'translate-x-6' : 'translate-x-1'
                                }`}
                              />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  <div>
                    <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">Language</label>
                    <Listbox
                      value={settings.language}
                      onChange={(value) => setSettings({ ...settings, language: value })}
                      disabled={generationState !== 'idle'}
                    >
                      {({ open }) => (
                        <div className="relative">
                          <Listbox.Button className={`relative w-full bg-surface-input border border-white/[0.13] rounded-xl px-5 py-4 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 ${generationState !== 'idle' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-surface-input'}`}>
                            <span className="block truncate">
                              {LANGUAGE_OPTIONS.find(option => option.value === settings.language)?.label || 'English'}
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
                              {LANGUAGE_OPTIONS.map((option) => (
                                <Listbox.Option
                                  key={option.value}
                                  value={option.value}
                                  className={({ active, selected }) =>
                                    `relative cursor-pointer select-none py-3 px-4 ${active ? 'bg-white/[0.08] text-white' : 'text-text-secondary'} ${selected ? 'font-medium' : 'font-normal'}`
                                  }
                                >
                                  {({ selected }) => (
                                    <div className="flex justify-between items-center">
                                      <span className={selected ? 'font-medium text-white' : 'font-normal'}>{option.label}</span>
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

                  <div>
                    <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">AI Model</label>
                    <Listbox
                      value={settings.model}
                      onChange={(value) => {
                        const isPaidModel = value !== 'deepseek';
                        if (isPaidModel && userPlan === 'free') return;
                        setSettings({ ...settings, model: value });
                      }}
                      disabled={generationState !== 'idle'}
                    >
                      {({ open }) => (
                        <div className="relative">
                          <Listbox.Button className={`relative w-full bg-surface-input border border-white/[0.13] rounded-xl px-5 py-4 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition-all duration-200 ${generationState !== 'idle' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-surface-input'}`}>
                            <span className="block truncate">
                              {selectedModel.label}
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
                              {modelOptions.map((option) => {
                                const isLocked = userPlan === 'free' && option.value !== 'deepseek';
                                return (
                                <Listbox.Option
                                  key={option.value}
                                  value={option.value}
                                  disabled={isLocked}
                                  className={({ active, selected }) =>
                                    `relative select-none py-3 px-4 ${isLocked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${active && !isLocked ? 'bg-white/[0.08] text-white' : 'text-text-secondary'} ${selected ? 'font-medium' : 'font-normal'}`
                                  }
                                >
                                  {({ selected }) => (
                                    <div className="flex justify-between items-center">
                                      <div>
                                        <span className={`${selected ? 'font-medium text-white' : 'font-normal'} ${isLocked ? 'text-white/40' : ''}`}>{option.label}</span>
                                        <p className="text-xs text-text-muted mt-1">
                                          {option.description}
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
                  </div>

                  {/* Image Frequency Configuration Component */}
                  <ImageFrequencyConfiguration
                    mode={settings.frequencyMode || 'wordcount'}
                    onModeChange={(mode) => setSettings(prev => ({ ...prev, frequencyMode: mode }))}
                    frequencyType={settings.frequencyType || 'consistent'}
                    onFrequencyTypeChange={(type) => setSettings(prev => ({ ...prev, frequencyType: type }))}
                    wordCount={getWordCountFromSettings(documents, uploadedDoc, selectedDoc)}
                    consistentFrequency={settings.consistentFrequency || ''}
                    onConsistentFrequencyChange={(value) => setSettings(prev => ({ ...prev, consistentFrequency: value }))}
                    firstPageFrequency={settings.firstPageFrequency}
                    onFirstPageFrequencyChange={(value) => setSettings(prev => ({ ...prev, firstPageFrequency: value }))}
                    restFrequency={settings.restFrequency}
                    onRestFrequencyChange={(value) => setSettings(prev => ({ ...prev, restFrequency: value }))}
                    selectedStoryGroupId={
                      selectedDoc 
                        ? (documents.find(d => d.id === selectedDoc)?.group_id || null)
                        : uploadedDoc 
                          ? (documents.find(d => d.title === uploadedDoc.name.replace(/\.txt$/, ''))?.group_id || null)
                          : null
                    }
                    selectedStoryTitle={
                      selectedDoc 
                        ? (documents.find(d => d.id === selectedDoc)?.title || '')
                        : uploadedDoc
                          ? uploadedDoc.name.replace(/\.txt$/, '')
                          : ''
                    }
                    storySource={uploadedDoc ? 'upload' : selectedDoc ? 'existing' : 'new'}
                    audioFiles={settings.audioFiles || []}
                    onAudioFilesChange={(files) => setSettings(prev => ({ ...prev, audioFiles: files }))}
                    totalAudioDuration={settings.totalAudioDuration || 0}
                    onTotalAudioDurationChange={(duration) => setSettings(prev => ({ ...prev, totalAudioDuration: duration }))}
                    imageAmount={settings.imageAmount || ''}
                    onImageAmountChange={(amount) => setSettings(prev => ({ ...prev, imageAmount: amount }))}
                    audioDistributionType={settings.audioDistributionType || 'consistent'}
                    onAudioDistributionTypeChange={(type) => setSettings(prev => ({ ...prev, audioDistributionType: type }))}
                    audioFirstPageImageCount={settings.audioFirstPageImageCount || ''}
                    onAudioFirstPageImageCountChange={(count) => setSettings(prev => ({ ...prev, audioFirstPageImageCount: count }))}
                    audioRestImageCount={settings.audioRestImageCount || ''}
                    onAudioRestImageCountChange={(count) => setSettings(prev => ({ ...prev, audioRestImageCount: count }))}
                    userId={user?.id || ''}
                    useCharacterDescriptions={settings.useCharacterDescriptions}
                  />

                  {/* Validation Errors Display */}
                  {Object.keys(validationErrors).length > 0 && (
                    <div className="bg-status-warning border border-status-warning rounded-xl p-4">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-5 h-5 text-status-warning flex-shrink-0 mt-0.5" />
                        <div className="space-y-1">
                          {validationErrors.consistentFrequency && (
                            <p className="text-sm text-status-warning-text">{validationErrors.consistentFrequency}</p>
                          )}
                          {validationErrors.firstPageFrequency && (
                            <p className="text-sm text-status-warning-text">{validationErrors.firstPageFrequency}</p>
                          )}
                          {validationErrors.restFrequency && (
                            <p className="text-sm text-status-warning-text">{validationErrors.restFrequency}</p>
                          )}
                          {validationErrors.imageAmount && (
                            <p className="text-sm text-status-warning-text">{validationErrors.imageAmount}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Estimated Token Usage Display */}
                  {(selectedDoc || uploadedDoc) && (
                    <div className="rounded-2xl bg-surface-card border border-border-card p-6 dash-animate-in">
                      <h2 className="text-xl font-display font-semibold tracking-tight text-white mb-4">Estimated Token Usage</h2>
                      <div className="space-y-4">
                        <div className="bg-surface-card rounded-xl p-4">
                          {(() => {
                            try {
                              const wordCount = getWordCountFromSettings(documents, uploadedDoc, selectedDoc);
                              if (wordCount === 0 && settings.frequencyMode === 'wordcount') {
                                return (
                                  <p className="text-sm text-text-muted">
                                    Unable to calculate token usage. Please ensure your document is properly loaded.
                                  </p>
                                );
                              }
                              
                              let estimatedImages = calculateEstimatedImageCount(wordCount, settings);
                              
                              // Calculate prompt generation token cost
                              let estimatedTokenUsage: number;
                              
                              if (settings.frequencyMode === 'audio') {
                                // Use audio-based calculation
                                // For variable distribution, calculate total images from first + rest
                                if (settings.audioDistributionType === 'variable' && 
                                    settings.audioFirstPageImageCount && 
                                    settings.audioRestImageCount) {
                                  estimatedImages = parseInt(settings.audioFirstPageImageCount) + parseInt(settings.audioRestImageCount);
                                }
                                
                                const tokenData = estimateTotalTokensAudioBased(
                                  wordCount,
                                  estimatedImages,
                                  settings.useCharacterDescriptions
                                );
                                estimatedTokenUsage = Math.round(
                                  (tokenData.inputTokens * 0.25 + tokenData.outputTokens) * selectedModel.tokenMultiplier
                                );
                              } else {
                                // Use word count based calculation
                                const totalLength = wordCount * 5; // Use 5 chars per word as in Python
                                
                                let totalInputTokens = wordCount * 1.33;
                                const restFreq = settings.frequencyType === 'consistent' 
                                  ? parseFloat(settings.consistentFrequency || '0')
                                  : parseFloat(settings.restFrequency || '0');
                                const segmentsPerBatch = restFreq > 120 ? 1 : 2;
                                const batchCount = Math.max(1, Math.ceil(estimatedImages / segmentsPerBatch));
                                totalInputTokens += batchCount * 500; // fixed input per batch
                                
                                let totalOutputTokens = estimatedImages * 600 * 1.33;
                                
                                if (settings.useCharacterDescriptions) {
                                  const userChars = Math.min(10000, totalLength);
                                  const userWords = Math.round(userChars / 5.5);
                                  totalInputTokens += (128 + userWords) * 1.33;
                                  totalOutputTokens += 400;
                                }
                                
                                // Apply safety multipliers
                                totalInputTokens *= 1.25; // 25% safety buffer for input
                                // No multiplier for output tokens
                                
                                estimatedTokenUsage = Math.round((totalInputTokens * 0.25 + totalOutputTokens) * selectedModel.tokenMultiplier);
                              }
                              
                              // Calculate image tokens after potentially updating estimatedImages for audio variable distribution
                              const estimatedImageTokens = calculateEstimatedImageTokens(estimatedImages, settings.imageModel, isLegacy);
                              
                              return (
                                <>
                                  <p className="text-sm text-text-secondary">
                                    Based on your {settings.frequencyMode === 'audio' ? 'audio duration and image amount' : 'frequency settings'}, generating image prompts will use approximately:
                                  </p>
                                  <p className="text-xl font-semibold text-white mt-2">
                                    {formatNumber(estimatedTokenUsage)} tokens
                                  </p>
                                  <p className="text-sm text-text-muted mt-1">
                                    This will generate approximately {estimatedImages} image prompts.
                                  </p>
                                  <p className="text-sm text-text-muted mt-1">
                                    With the Image Generator, it would cost {formatNumber(estimatedImageTokens)} tokens to generate {estimatedImages} images.
                                  </p>
                                  
                                  {estimatedTokenUsage > userTokenBalance && (
                                    <div className="mt-3 bg-status-error text-status-error p-3 rounded-xl">
                                      <div className="flex items-center gap-2">
                                        <AlertCircle className="h-5 w-5 text-status-error" />
                                        <p className="text-sm">
                                          You don't have enough tokens. Please reduce frequency or upgrade your plan.
                                        </p>
                                      </div>
                                    </div>
                                  )}
                                </>
                              );
                            } catch (error) {
                              console.error('Error calculating token usage:', error);
                              return (
                                <p className="text-sm text-status-error">
                                  Error calculating token usage. Please try refreshing the page.
                                </p>
                              );
                            }
                          })()}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              </div>
              </div>

              {generationState !== 'complete' && (
              <div>
              <button
                onClick={handleGeneratePrompts}
                disabled={
                  generationState !== 'idle' || 
                  (!selectedDoc && !uploadedDoc) || 
                  Object.keys(validationErrors).length > 0 ||
                  // Disable if frequency fields are empty (like wordCount in Generator)
                  (settings.frequencyMode === 'wordcount' && settings.frequencyType === 'consistent' && (!settings.consistentFrequency || settings.consistentFrequency.trim() === '')) ||
                  (settings.frequencyMode === 'wordcount' && settings.frequencyType === 'variable' && ((!settings.firstPageFrequency || settings.firstPageFrequency.trim() === '') || (!settings.restFrequency || settings.restFrequency.trim() === '')))
                }
                className="w-full flex justify-center items-center px-6 py-3 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium dash-animate-in"
              >
                {generationState === 'idle' || generationState === 'complete' ? (
                  <>
                    <Image className="h-5 w-5 mr-2" />
                    Generate Image Prompts
                  </>
                ) : (
                  <>
                    <RefreshCw className="animate-spin h-5 w-5 mr-2" />
                    {generationState === 'writing' || generationState === 'saving' ? 'Generating Image Prompt Document...' : 'Generating Image Prompt Document...'}
                  </>
                )}
              </button>
              </div>
              )}

              {generationState === 'generating' && (
                <div className="rounded-2xl bg-surface-card border border-border-card p-6 space-y-4 dash-animate-in">
                  <div className="flex items-center space-x-3 text-text-secondary">
                    <Image className="h-5 w-5 text-accent animate-pulse" />
                    <span>{statusMessage}</span>
                  </div>
                  <div className="flex justify-between text-sm text-text-secondary">
                    <span>Progress</span>
                    <span>{Math.round(progress)}%</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-valuenow={Math.round(progress)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Image prompt generation progress"
                    className="w-full bg-border rounded-full h-2 overflow-hidden"
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
                      <p className="text-sm text-text-muted">
                        If you're returning to the page, give it 30 seconds to correctly show the progress.
                      </p>
                      {currentTasks.some(task => task.check_stuck === true) && (
                        <p className="text-sm text-status-warning">
                          This part may take a little longer, but the progress is moving forward.
                        </p>
                      )}
                    </>
                  )}
                  <div className="flex justify-end">
                    <button
                      onClick={handleDone}
                      className="flex items-center px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors"
                    >
                      <X className="h-5 w-5 mr-2" />
                      Stop
                    </button>
                  </div>
                </div>
              )}

              {generationState === 'complete' && (
                <div className="space-y-6 dash-animate-in">
                  {/* Generation Details */}
                  <div className="rounded-2xl bg-surface-card border border-border-card overflow-hidden">
                    <div className="p-4 bg-surface-card border-b border-border-card">
                      <h3 className="text-lg font-display font-semibold tracking-tight text-white">Generation Details</h3>
                    </div>
                    <div className="p-6">
                      <div className="space-y-2 text-text-secondary">
                        <p>Tokens Used: {Math.round(totalInputTokens * 0.25 + totalOutputTokens).toLocaleString()}</p>
                        <p>Tokens Remaining: {formatNumber(userTokenBalance)}</p>
                      </div>
                    </div>
                  </div>

                  {/* File Box with Edit Capability */}
                  <div className="rounded-2xl bg-surface-card border border-border-card overflow-hidden">
                    <div className="p-4 bg-surface-card border-b border-border-card">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center">
                          <FileText className="h-6 w-6 text-accent" />
                          <h3 className="ml-3 text-lg font-display font-semibold tracking-tight text-white">
                            {generatedDocTitle}
                          </h3>
                        </div>
                        <div className="flex space-x-2">
                          {!isEditing && (
                            <>
                              <button
                                onClick={fetchFileContent}
                                disabled={isLoadingContent}
                                className="flex items-center px-3 py-2 bg-surface-input text-white rounded-xl hover:bg-surface-input disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                              >
                                {isLoadingContent ? (
                                  <>
                                    <RefreshCw className="animate-spin h-4 w-4 mr-2" />
                                    Loading...
                                  </>
                                ) : (
                                  <>
                                    <Edit className="h-4 w-4 mr-2" />
                                    Edit
                                  </>
                                )}
                              </button>
                              <button
                                onClick={downloadDocument}
                                className="flex items-center px-3 py-2 text-text-secondary hover:text-white hover:bg-white/[0.08] rounded-xl transition-colors"
                                title="Download file"
                              >
                                <Download className="h-5 w-5" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    {/* Content Area */}
                    {isEditing ? (
                      <div className="p-4">
                        {/* Warning Info Box - Only shown when editing */}
                        <div className="bg-status-warning text-status-warning-text p-4 rounded-xl border border-status-warning mb-4">
                          <div className="flex items-start space-x-3">
                            <AlertCircle className="h-5 w-5 text-status-warning flex-shrink-0 mt-0.5" />
                            <div>
                              <p className="text-sm font-medium mb-1">Warning: Editing Not Recommended</p>
                              <p className="text-sm text-status-warning-text">
                                Editing image prompts is not recommended as it may affect the quality and consistency of generated images. 
                                If you must edit, please only modify the image prompt sections and avoid changing the structure or formatting: [Image Prompt: ...]
                              </p>
                            </div>
                          </div>
                        </div>
                        
                        <div className="mb-2">
                          <label className="text-sm text-text-muted block mb-2">
                            Edit your image prompts below. The content is scrollable.
                          </label>
                        </div>
                        <textarea
                          value={editableContent}
                          onChange={(e) => setEditableContent(e.target.value)}
                          className="w-full h-96 p-4 bg-surface-input text-text-secondary font-mono text-sm rounded-xl border border-white/[0.13] focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none resize-none overflow-y-auto"
                          placeholder="Edit your image prompts..."
                          spellCheck={false}
                        />
                        <div className="flex justify-end space-x-3 mt-4">
                          <button
                            onClick={() => {
                              setIsEditing(false);
                              setEditableContent('');
                              setError(null);
                            }}
                            disabled={isSaving}
                            className="px-4 py-2 bg-surface-input text-white rounded-xl hover:bg-surface-input disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={saveEditedContent}
                            disabled={isSaving || !editableContent.trim()}
                            className="flex items-center px-4 py-2 bg-action-success text-white rounded-xl hover:bg-action-success-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {isSaving ? (
                              <>
                                <RefreshCw className="animate-spin h-4 w-4 mr-2" />
                                Saving...
                              </>
                            ) : (
                              <>
                                <CheckCircle2 className="h-4 w-4 mr-2" />
                                Save
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="p-6 text-text-muted text-center">
                        <p className="mb-2">Click <strong className="text-text-secondary">Edit</strong> to modify the image prompts</p>
                        <p className="text-sm">or <strong className="text-white">Download</strong> to save the file locally</p>
                      </div>
                    )}
                  </div>

                  {/* Done Button */}
                  <div className="flex justify-end">
                    <button
                      onClick={handleDone}
                      disabled={isEditing}
                      className="flex items-center px-4 py-2 text-white rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      style={{ backgroundColor: isEditing ? undefined : '#2E7D32' }}
                      onMouseEnter={(e) => { if (!isEditing) e.currentTarget.style.backgroundColor = '#1B5E20'; }}
                      onMouseLeave={(e) => { if (!isEditing) e.currentTarget.style.backgroundColor = '#2E7D32'; }}
                    >
                      <CheckCircle2 className="h-5 w-5 mr-2" />
                      Done
                    </button>
                  </div>
                </div>
              )}
              </div>
            </div>
          </div>
        </div>
    </DashboardLayout>
  );
});

ImagePrompts.displayName = 'ImagePrompts';

export default ImagePrompts;
