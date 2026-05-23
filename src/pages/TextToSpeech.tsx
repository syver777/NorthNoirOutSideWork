import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { RefreshCw, X, AlertCircle, CheckCircle2, Calendar, ChevronDown, Upload, Play, Pause, User, Settings as SettingsIcon, Download, Volume2, BookOpen, Info, Lock } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { createClient } from '@supabase/supabase-js';
import { Listbox, Transition } from '@headlessui/react';
import { useTabSessionStorage } from '../hooks/useTabSessionStorage';
import DashboardLayout from '../components/DashboardLayout';
import VoiceSelector from '../components/VoiceSelector';
import { type SelectedElevenLabsVoice } from '../components/ElevenLabsVoiceBrowser';
import { DEFAULT_ELEVENLABS_MODEL_ID } from '../data/elevenlabsModels';
import { v4 as uuidv4 } from 'uuid';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import AudioPlayer from '../components/AudioPlayer';
import TabManager from '../components/TabManager';
import { type TabInfo, updateTabStatus } from '../utils/tabManager';
import { getStorageLimitGB } from '../utils/storageHelpers';
import { useIsLegacyPlan } from '../hooks/useIsLegacyPlan';
import { getPlanMaxTokens } from '../data/planMaxTokens';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

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
  pauses?: boolean;
}

interface AudioTask {
  id: string;
  user_id: string;
  story_title: string;
  text_part: string;
  progress?: number;
  error?: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'completed_final' | 'error';
  group_id: string;
  doc_id?: string;
  file_path: string;
  updated_at?: string;
  batch_output?: string;
  model_version?: string;
  total_batches?: number;
  batch_number?: number;
  single_audio?: boolean;
  check_stuck?: boolean;
}

interface AnalysisResult {
  totalCharacters: number;
  wordCount: number;
  estimatedTokens: number;
  estimatedFileSizeMB: number;
  isPremiumVoice: boolean;
  costPerChar: number;
  volumeBoost?: number;
}

const OPERATION_TIMEOUT = 3600000;
const POLLING_INTERVAL = 5000;
const SUBSCRIPTION_CHECK_INTERVAL = 60000;
const TASK_STALL_TIMEOUT = 1800000;

// Line ~76: Add constants and validateFileName
const MAX_WORD_COUNT = 100000;
const MAX_FILE_SIZE_MB = 1;
const RETRY_DELAY = 2000;
const MAX_RETRIES = 10;

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

const planMaxTokens: Record<string, number> = {
  // Kept only for legacy display fallbacks; always prefer getPlanMaxTokens(plan, isLegacy).
  free: 400000,
  standard: 4000000,
  plus: 6000000,
  premium: 10000000,
  pro: 25000000,
  elite: 50000000,
  ultimate: 75000000,
  enterprise: 250000000,
};
void planMaxTokens; // satisfy unused-var lint while keeping the table for reference

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

const isTaskStalled = (task: AudioTask): boolean => {
  if (!task.updated_at) return false;
  const lastUpdate = new Date(task.updated_at).getTime();
  return Date.now() - lastUpdate > TASK_STALL_TIMEOUT;
};

const formatNumber = (num: number) => {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

const calculateWordCount = (content: string): number => {
  return content.trim().split(/\s+/).filter(word => word.length > 0).length;
};

const calculateCharacterCount = (content: string): number => {
  return content.length;
};

const formatStorageSize = (sizeInMB: number): string => {
  const gb = sizeInMB / 1024;
  
  if (gb >= 1) {
    return `${gb.toFixed(1)} GB`;
  } else {
    return sizeInMB > 0 && sizeInMB < 0.05 ? '0.1 MB' : `${sizeInMB.toFixed(sizeInMB < 1 ? 1 : 2)} MB`;
  }
};

// Utility function to safely check if file exists
const checkFileExists = async (filePath: string): Promise<boolean> => {
  try {
    const pathParts = filePath.split('/');
    const fileName = pathParts.pop();
    const folderPath = pathParts.join('/');
    
    const { data, error } = await supabase.storage
      .from('stories')
      .list(folderPath, { limit: 1000 });
    
    if (error) return false;
    
    return data?.some(file => file.name === fileName) || false;
  } catch (error) {
    console.warn('Error checking file existence:', error);
    return false;
  }
};

// Utility function to safely delete storage files
const safeDeleteStorageFiles = async (filePaths: string[]): Promise<void> => {
  try {
    if (filePaths.length === 0) return;
    
    const { error } = await withRetry(
      () => withTimeout(
        supabase.storage.from('stories').remove(filePaths),
        OPERATION_TIMEOUT,
        'deleteStorageFiles'
      ),
      'deleteStorageFiles'
    );

    if (error) {
      console.warn(`Failed to delete storage files: ${error.message}`);
    }
  } catch (error: any) {
    console.warn(`Error during storage cleanup: ${error.message}`);
  }
};

export interface TextToSpeechRef {
  cleanup: () => Promise<void>;
}

interface TextToSpeechProps {
  currentTab: number;
  isEnterpriseUser: boolean;
  initialTabs?: TabInfo[];
  userId: string;
  onTabUpdate: () => void;
  onTabChange: (tab: number, groupId: string) => void;
  onTabCreate: (tab: number, groupId: string) => void;
  onTabClose: (tab: number, groupId: string) => void;
}

const TextToSpeech = forwardRef<TextToSpeechRef, TextToSpeechProps>((props, ref) => {
  const {
    currentTab,
    isEnterpriseUser,
    initialTabs,
    userId,
    onTabUpdate,
    onTabChange,
    onTabCreate,
    onTabClose
  } = props;

  const navigate = useNavigate();
  const { user } = useAuth();
  const { isLegacy } = useIsLegacyPlan();
  const [mode, setMode] = useTabSessionStorage<'document' | 'individual'>('textToSpeechMode', 'document', currentTab);
  const [documents, setDocuments] = useTabSessionStorage<StoryDocument[]>('textToSpeechDocuments', [], currentTab);
  const [selectedDoc, setSelectedDoc] = useTabSessionStorage<string>('textToSpeechSelectedDoc', '', currentTab);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [generationState, setGenerationState] = useTabSessionStorage<'idle' | 'analyzing' | 'analyzed' | 'generating' | 'complete' | 'error'>('textToSpeechState', 'idle', currentTab);
  const [tabRefreshTrigger, setTabRefreshTrigger] = useState(0);
  const [settingsCollapsed, setSettingsCollapsed] = useState(() => {
    const stored = sessionStorage.getItem(`tab${currentTab}_textToSpeechState`);
    const storedSingle = sessionStorage.getItem(`tab${currentTab}_singleAudioState`);
    try {
      const val = stored ? JSON.parse(stored) : 'idle';
      const singleVal = storedSingle ? JSON.parse(storedSingle) : 'idle';
      return (val !== 'idle' && val !== 'analyzed' && val !== 'analyzing') || singleVal !== 'idle';
    } catch { return false; }
  });
  const [prevGenState, setPrevGenState] = useState(generationState);
  const [prevSingleState, setPrevSingleState] = useState<string>(() => {
    try {
      const stored = sessionStorage.getItem(`tab${currentTab}_singleAudioState`);
      return stored ? JSON.parse(stored) : 'idle';
    } catch { return 'idle'; }
  });
  const [error, setError] = useTabSessionStorage<string | null>('textToSpeechError', null, currentTab);
  const [analysisResult, setAnalysisResult] = useTabSessionStorage<AnalysisResult | null>('textToSpeechAnalysisResult', null, currentTab);
  const [progress, setProgress] = useTabSessionStorage('textToSpeechProgress', 0, currentTab);
  const [statusMessage, setStatusMessage] = useTabSessionStorage<string>('textToSpeechStatusMessage', '', currentTab);
  const [timeRemaining, setTimeRemaining] = useTabSessionStorage<number | null>('textToSpeechTimeRemaining', null, currentTab);
  const [generatedFileName, setGeneratedFileName] = useTabSessionStorage<string>('textToSpeechGeneratedFileName', '', currentTab);
  const [generatedDocTitle, setGeneratedDocTitle] = useTabSessionStorage<string>('textToSpeechGeneratedDocTitle', '', currentTab);
  const [generatedGroupId, setGeneratedGroupId] = useTabSessionStorage<string | null>('textToSpeechGeneratedGroupId', null, currentTab);
  const [currentGroupId, setCurrentGroupId] = useTabSessionStorage<string | null>('textToSpeechCurrentGroupId', null, currentTab);
  const [currentUserId, setCurrentUserId] = useTabSessionStorage<string | null>('textToSpeechCurrentUserId', null, currentTab);
  const [currentVariant, setCurrentVariant] = useTabSessionStorage<number | null>('textToSpeechCurrentVariant', null, currentTab);
  const [userTokenBalance, setUserTokenBalance] = useTabSessionStorage('textToSpeechUserTokenBalance', 400000, currentTab);
  const [userPlan, setUserPlan] = useTabSessionStorage<string>('textToSpeechUserPlan', 'free', currentTab);
  const [networkRetrying, setNetworkRetrying] = useState<boolean>(false);
  const [generatedAudio, setGeneratedAudio] = useTabSessionStorage<string | null>('textToSpeechGeneratedAudio', null, currentTab);
  const [audioTasks, setAudioTasks] = useState<AudioTask[]>([]);
  const [storageUsed, setStorageUsed] = useState<number | null>(null);
  const [selectedVoice, setSelectedVoice] = useTabSessionStorage<string>('textToSpeechSelectedVoice', '', currentTab);

  // ElevenLabs voice browser state
  const [elevenLabsVoice, setElevenLabsVoice] = useTabSessionStorage<SelectedElevenLabsVoice | null>(
    'textToSpeechElevenLabsVoice',
    null,
    currentTab,
  );
  const [elevenLabsModelId, setElevenLabsModelId] = useTabSessionStorage<string>(
    'textToSpeechElevenLabsModelId',
    DEFAULT_ELEVENLABS_MODEL_ID,
    currentTab,
  );

  // Calculate max storage based on user plan
  const maxStorageGB = getStorageLimitGB(userPlan);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [audioFilePath, setAudioFilePath] = useState<string>('');
  const [currentTask, setCurrentTask] = useState<AudioTask | null>(null);

  // New session clone voice tracking
  const [sessionCloneVoiceId, setSessionCloneVoiceId] = useTabSessionStorage<string | null>('currentSessionCloneVoice', null, currentTab);
  const [sessionCloneVoiceFilePath, setSessionCloneVoiceFilePath] = useTabSessionStorage<string | null>('currentSessionCloneVoiceFilePath', null, currentTab);

  // New settings state
  const [speed, setSpeed] = useTabSessionStorage<number>('textToSpeechSpeed', 0.8, currentTab);
  const [speedInput, setSpeedInput] = useState<string>('0.8');
  const [speedError, setSpeedError] = useState<string>('');
  const [volume, setVolume] = useTabSessionStorage<number>('textToSpeechVolume', 1.0, currentTab);
  const [volumeInput, setVolumeInput] = useState<string>('1.0');
  const [volumeError, setVolumeError] = useState<string>('');
  const [preference, setPreference] = useTabSessionStorage<'merged' | 'separate'>('textToSpeechPreference', 'separate', currentTab);
  const [removeTitleChapters, setRemoveTitleChapters] = useTabSessionStorage<boolean>('textToSpeechRemoveTitleChapters', true, currentTab);

  // New state for output type
  const [outputType, setOutputType] = useState<'single' | 'folder'>('single');

  // Individual Audio Generation states
  const [singleAudioText, setSingleAudioText] = useState<string>('');
  const [singleAudioState, setSingleAudioState] = useTabSessionStorage<'idle' | 'generating' | 'complete' | 'error'>('singleAudioState', 'idle', currentTab);
  const [singleAudioUrl, setSingleAudioUrl] = useTabSessionStorage<string | null>('singleAudioUrl', null, currentTab);
  const [singleAudioError, setSingleAudioError] = useTabSessionStorage<string | null>('singleAudioError', null, currentTab);
  const [singleAudioGroupId, setSingleAudioGroupId] = useTabSessionStorage<string | null>('singleAudioGroupId', null, currentTab);
  const [singleAudioSpeed, setSingleAudioSpeed] = useState<number>(0.8);
  const [singleAudioSpeedInput, setSingleAudioSpeedInput] = useState<string>('0.8');
  const [singleAudioSpeedError, setSingleAudioSpeedError] = useState<string>('');
  
  // New single audio volume states
  const [singleAudioVolume, setSingleAudioVolume] = useState<number>(1.0);
  const [singleAudioVolumeInput, setSingleAudioVolumeInput] = useState<string>('1.0');
  const [singleAudioVolumeError, setSingleAudioVolumeError] = useState<string>('');

  // Auto-collapse settings when generation starts or completes (document or individual mode)
  if (generationState !== prevGenState) {
    setPrevGenState(generationState);
    if (generationState === 'generating' || generationState === 'complete') {
      setSettingsCollapsed(true);
    } else if (generationState === 'idle' || generationState === 'analyzing') {
      setSettingsCollapsed(false);
    }
  }
  if (singleAudioState !== prevSingleState) {
    setPrevSingleState(singleAudioState);
    if (singleAudioState === 'generating' || singleAudioState === 'complete') {
      setSettingsCollapsed(true);
    } else if (singleAudioState === 'idle') {
      setSettingsCollapsed(false);
    }
  }

  // Expose cleanup method to parent via ref
  useImperativeHandle(ref, () => ({
    cleanup: async () => {
      console.log(`[TextToSpeech Tab ${currentTab}] Cleanup called from tab closure`);
      
      if (!currentUserId) {
        console.error('No user authenticated during cleanup');
        return;
      }

      try {
        // If generating or analyzing, stop like handleDone with file deletion
        if (generationState === 'analyzing' || generationState === 'generating') {
          console.log(`[TextToSpeech Tab ${currentTab}] Stopping active generation and deleting files`);
          
          if (currentGroupId) {
            // Get all tasks to find story_title and folder_timestamp for file deletion (exclude video_process=true)
            let cleanupQuery = supabase
              .from('audio_tasks')
              .select('story_title, folder_timestamp, batch_output')
              .eq('user_id', currentUserId)
              .eq('group_id', currentGroupId)
              .eq('tab', currentTab)
              .or('video_process.is.null,video_process.eq.false');

            if (currentVariant !== null) {
              cleanupQuery = cleanupQuery.eq('variant', currentVariant);
            }

            const { data: tasks } = await cleanupQuery;

            if (tasks && tasks.length > 0) {
              // Use story_title and folder_timestamp to construct correct folder path
              const taskWithTimestamp = tasks.find(task => task.story_title && task.folder_timestamp);
              
              if (taskWithTimestamp && taskWithTimestamp.story_title && taskWithTimestamp.folder_timestamp) {
                // Sanitize title using same pattern as edge functions
                const sanitizedTitle = sanitizeTitle(taskWithTimestamp.story_title);
                // Construct folder path: documents/userId/groupId/sanitizedTitle_folderTimestamp
                const folderPath = `documents/${currentUserId}/${currentGroupId}/${sanitizedTitle}_${taskWithTimestamp.folder_timestamp}`;
                console.log(`[TextToSpeech Tab ${currentTab}] Attempting to delete folder: ${folderPath}`);

                try {
                  const { data: files } = await supabase.storage.from('stories').list(folderPath, { recursive: true });
                  
                  if (files && files.length > 0) {
                    const filePaths = files
                      .filter(file => file.name.endsWith('.wav') || file.name.endsWith('.mp3'))
                      .map(file => `${folderPath}/${file.name}`);

                    if (filePaths.length > 0) {
                      await safeDeleteStorageFiles(filePaths);
                      console.log(`[TextToSpeech Tab ${currentTab}] Deleted ${filePaths.length} audio files from folder: ${folderPath}`);
                    }
                  }
                } catch (error: any) {
                  console.warn(`[TextToSpeech Tab ${currentTab}] Error during file cleanup:`, error.message);
                }
              }
            }
          }
        }
        // If complete, just delete audio_tasks (keep files)
        else if (generationState === 'complete') {
          console.log(`[TextToSpeech Tab ${currentTab}] Cleaning up completed generation (keeping files)`);
        }

        // Delete all audio tasks for this tab and variant (exclude video_process=true)
        let deleteQuery = supabase
          .from('audio_tasks')
          .delete()
          .eq('user_id', currentUserId)
          .eq('tab', currentTab)
          .eq('single_audio', false)
          .or('video_process.is.null,video_process.eq.false');

        if (currentVariant !== null) {
          deleteQuery = deleteQuery.eq('variant', currentVariant);
        }

        await deleteQuery;
        
        console.log(`[TextToSpeech Tab ${currentTab}] Successfully deleted audio_tasks for tab ${currentTab}, variant ${currentVariant}`);

        // Clean up session clone voice if exists
        await cleanupSessionCloneVoice();
      } catch (err: any) {
        console.error(`[TextToSpeech Tab ${currentTab}] Error during cleanup:`, err);
      }
    }
  }), [currentTab, generationState, currentUserId, currentGroupId, currentVariant]);

  // Loading states for downloads
  const [downloadingAudio, setDownloadingAudio] = useState<boolean>(false);
  const [downloadingSingleAudio, setDownloadingSingleAudio] = useState<boolean>(false);
  // True while handleSingleAudioDone is deleting db rows + storage files
  const [completingSingleAudio, setCompletingSingleAudio] = useState<boolean>(false);
  // UPDATED: Ref for VoiceSelector to call clearUploadSection
  const voiceSelectorRef = useRef<{ clearUploadSection: () => void } | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastUpdateRef = useRef<number>(Date.now());
  const lastSubscriptionUpdateRef = useRef<number>(Date.now());
  const generationStartTime = useRef<number | null>(null);

  // Helper function to sanitize title (matches process-audio edge function pattern)
  const sanitizeTitle = (title: string) => {
    // Remove "Audio Prompt: " prefix if present (matches edge function)
    const cleanedTitle = title.replace('Audio Prompt: ', '');
    return cleanedTitle.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
  };

  // CHANGED: Add free user check
  const isFreeUser = userPlan === 'free';
  const isPremiumPlan = ['premium', 'pro', 'elite', 'ultimate', 'enterprise'].includes(userPlan);
  const isStandardPlan = ['standard', 'plus'].includes(userPlan);
  
  const isPremiumVoice = (voice: string) => {
    if (voice.includes(':')) {
      const [type, name] = voice.split(':');
      return type === 'premium';
    }
    return false; // Only accept prefixed format
  };
  
  const isCoreVoice = (voice: string) => {
    if (voice.includes(':')) {
      const [type, name] = voice.split(':');
      return type === 'core';
    }
    return false; // Only accept prefixed format
  };

  const isApexVoice = (voice: string) => {
    if (voice.includes(':')) {
      const [type, name] = voice.split(':');
      return type === 'apex';
    }
    return false; // Only accept prefixed format
  };

  const isCloneVoice = (voice: string) => {
    if (voice.includes(':')) {
      const [type, name] = voice.split(':');
      return type === 'clone';
    }
    return false; // Only accept prefixed format
  };

  const isElevenLabsVoice = (voice: string) => {
    if (voice.includes(':')) {
      const [type] = voice.split(':');
      return type === 'elevenlabs';
    }
    return false;
  };

  /**
   * Returns tokens-per-character for the currently selected voice.
   * Mirrors the backend cost map.
   */
  const tokensPerCharForSelectedVoice = (voice: string) => {
    if (isElevenLabsVoice(voice)) {
      return elevenLabsModelId === 'eleven_multilingual_v2' ? 200 : 100;
    }
    if (isApexVoice(voice)) return 8;
    if (isPremiumVoice(voice) || isCloneVoice(voice)) return 4;
    if (isCoreVoice(voice)) return 2;
    return 2;
  };

  // Get voice display info for sticky bar
  const getVoiceDisplayInfo = (voiceKey: string): { name: string; tier: string; tierColor: string; dotColor: string } | null => {
    if (!voiceKey || !voiceKey.includes(':')) return null;
    const [type, name] = voiceKey.split(':');
    if (type === 'elevenlabs') {
      return {
        name: elevenLabsVoice?.name || 'ElevenLabs voice',
        tier: 'ElevenLabs',
        tierColor: 'text-zinc-200',
        dotColor: 'bg-white',
      };
    }
    const displayName = type === 'apex' 
      ? name.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ')
      : name;
    const tierMap: Record<string, { tier: string; tierColor: string; dotColor: string }> = {
      core: { tier: 'Core', tierColor: 'text-emerald-400', dotColor: 'bg-emerald-400' },
      premium: { tier: 'Premium', tierColor: 'text-yellow-400', dotColor: 'bg-yellow-400' },
      clone: { tier: 'Clone', tierColor: 'text-purple-400', dotColor: 'bg-purple-400' },
      apex: { tier: 'Apex', tierColor: 'text-orange-400', dotColor: 'bg-orange-400' },
    };
    const info = tierMap[type];
    if (!info) return null;
    return { name: displayName, ...info };
  };

  // Determine if sticky bar should be visible
  const showStickyBar = selectedVoice && (
    mode === 'document'
      ? (generationState === 'idle' || generationState === 'analyzed') && singleAudioState === 'idle'
      : singleAudioState === 'idle' && generationState === 'idle'
  );

  // Predefined clone voices list (matching backend)
  const predefinedCloneVoices = [
    { name: "Declan", voice_id: "default-ujsa1wysgyitfqg3ixpqka__declan" },
    { name: "Adrian", voice_id: "default-ujsa1wysgyitfqg3ixpqka__adrian" },
    { name: "Alfred", voice_id: "default-ujsa1wysgyitfqg3ixpqka__alfred" },
    { name: "Conrad", voice_id: "default-ujsa1wysgyitfqg3ixpqka__conrad" },
    { name: "Hugo", voice_id: "default-ujsa1wysgyitfqg3ixpqka__hugo" },
    { name: "Ryder", voice_id: "default-ujsa1wysgyitfqg3ixpqka__ryder" },
    { name: "Victor", voice_id: "default-ujsa1wysgyitfqg3ixpqka__victor" }
  ];

  // Check if Remove Title and Chapter Headings should be disabled
  const isRemoveTitleChaptersDisabled = () => {
    if (uploadedFile) return true; // Always disable for uploaded files
    if (selectedDoc) {
      const doc = documents.find(d => d.id === selectedDoc);
      if (doc) {
        return doc.description === 'Uploaded document for image prompt generation' ||
               doc.description === 'Uploaded document for comparison' ||
               doc.description === 'Uploaded document for text-to-speech conversion';
      }
    }
    return false;
  };

  // Validate speed input
  const validateSpeed = (value: string): boolean => {
    const num = parseFloat(value);
    if (isNaN(num)) {
      setSpeedError('Speed must be a number');
      return false;
    }
    if (num < 0.5 || num > 2.0) {
      setSpeedError('Speed must be between 0.5 and 2.0');
      return false;
    }
    const decimalPlaces = (value.split('.')[1] || '').length;
    if (decimalPlaces > 2) {
      setSpeedError('Speed can have maximum 2 decimal places');
      return false;
    }
    setSpeedError('');
    return true;
  };

  // Validate volume input
  const validateVolume = (value: string): boolean => {
    const num = parseFloat(value);
    if (isNaN(num)) {
      setVolumeError('Volume must be a number');
      return false;
    }
    if (num < 1.0 || num > 8.0) {
      setVolumeError('Volume must be between 1.0 and 8.0');
      return false;
    }
    const decimalPlaces = (value.split('.')[1] || '').length;
    if (decimalPlaces > 1) {
      setVolumeError('Volume can have maximum 1 decimal place');
      return false;
    }
    setVolumeError('');
    return true;
  };

  // Validate single audio speed input
  const validateSingleAudioSpeed = (value: string): boolean => {
    const num = parseFloat(value);
    if (isNaN(num)) {
      setSingleAudioSpeedError('Speed must be a number');
      return false;
    }
    if (num < 0.5 || num > 2.0) {
      setSingleAudioSpeedError('Speed must be between 0.5 and 2.0');
      return false;
    }
    const decimalPlaces = (value.split('.')[1] || '').length;
    if (decimalPlaces > 2) {
      setSingleAudioSpeedError('Speed can have maximum 2 decimal places');
      return false;
    }
    setSingleAudioSpeedError('');
    return true;
  };

  // Validate single audio volume input
  const validateSingleAudioVolume = (value: string): boolean => {
    const num = parseFloat(value);
    if (isNaN(num)) {
      setSingleAudioVolumeError('Volume must be a number');
      return false;
    }
    if (num < 1.0 || num > 8.0) {
      setSingleAudioVolumeError('Volume must be between 1.0 and 8.0');
      return false;
    }
    const decimalPlaces = (value.split('.')[1] || '').length;
    if (decimalPlaces > 1) {
      setSingleAudioVolumeError('Volume can have maximum 1 decimal place');
      return false;
    }
    setSingleAudioVolumeError('');
    return true;
  };

  // Handle speed input change
  const handleSpeedInputChange = (value: string) => {
    setSpeedInput(value);
    if (validateSpeed(value)) {
      setSpeed(parseFloat(value));
    }
  };

  // Handle volume input change
  const handleVolumeInputChange = (value: string) => {
    setVolumeInput(value);
    if (validateVolume(value)) {
      setVolume(parseFloat(value));
    }
  };

  // Handle single audio speed input change
  const handleSingleAudioSpeedInputChange = (value: string) => {
    setSingleAudioSpeedInput(value);
    if (validateSingleAudioSpeed(value)) {
      setSingleAudioSpeed(parseFloat(value));
    }
  };

  // Handle single audio volume input change
  const handleSingleAudioVolumeInputChange = (value: string) => {
    setSingleAudioVolumeInput(value);
    if (validateSingleAudioVolume(value)) {
      setSingleAudioVolume(parseFloat(value));
    }
  };

  // Initialize speed and volume inputs
  useEffect(() => {
    setSpeedInput(speed.toString());
    setVolumeInput(volume.toString());
    setSingleAudioSpeedInput(singleAudioSpeed.toString());
    setSingleAudioVolumeInput(singleAudioVolume.toString());
  }, [speed, volume, singleAudioSpeed, singleAudioVolume]);

  // Load tab settings from database on mount or tab change
  useEffect(() => {
    const loadTabSettings = async () => {
      if (!currentUserId) return;
      
      try {
        const { data: tabData, error } = await supabase
          .from('tabs')
          .select('selected_voice, speed, volume, preference, mode')
          .eq('user_id', currentUserId)
          .eq('page', 'audio')
          .eq('tab_number', currentTab)
          .maybeSingle();
        
        if (error) throw error;
        
        // Load settings from database if they exist
        if (tabData) {
          if (tabData.selected_voice) setSelectedVoice(tabData.selected_voice);
          if (tabData.speed !== null && tabData.speed !== undefined) {
            setSpeed(tabData.speed);
            setSpeedInput(tabData.speed.toString());
          }
          if (tabData.volume !== null && tabData.volume !== undefined) {
            setVolume(tabData.volume);
            setVolumeInput(tabData.volume.toString());
          }
          if (tabData.preference) setPreference(tabData.preference as 'merged' | 'separate');
          if (tabData.mode) setMode(tabData.mode as 'document' | 'individual');
        }
      } catch (err: any) {
        console.warn(`Failed to load tab settings: ${err.message}`);
      }
    };
    
    loadTabSettings();
  }, [currentTab, currentUserId]);

  // Save tab settings to database when they change
  useEffect(() => {
    const saveTabSettings = async () => {
      if (!currentUserId) return;
      
      try {
        await supabase
          .from('tabs')
          .update({
            selected_voice: selectedVoice,
            speed: speed,
            volume: volume,
            preference: preference,
            mode: mode,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', currentUserId)
          .eq('page', 'audio')
          .eq('tab_number', currentTab);
      } catch (err: any) {
        console.warn(`Failed to save tab settings: ${err.message}`);
      }
    };
    
    // Only save if we have a valid voice selection (indicates settings have been initialized)
    if (selectedVoice && currentUserId) {
      saveTabSettings();
    }
  }, [selectedVoice, speed, volume, preference, mode, currentTab, currentUserId]);

  // Track generation state changes and update tab status
  useEffect(() => {
    const mapGenerationStateToTabStatus = (state: 'idle' | 'analyzing' | 'analyzed' | 'generating' | 'complete' | 'error'): 'idle' | 'outline' | 'generating' | 'error' | 'complete' => {
      switch (state) {
        case 'analyzing':
        case 'analyzed':
        case 'generating':
          return 'generating';
        case 'complete':
          return 'complete';
        case 'error':
          return 'error';
        default:
          return 'idle';
      }
    };
    
    const tabStatus = mapGenerationStateToTabStatus(generationState);
    updateTabStatus(tabStatus);
  }, [generationState, currentUserId, currentTab]);

  // Helper function to clean up session clone voice
  const cleanupSessionCloneVoice = async () => {
    if (sessionCloneVoiceId && currentUserId) {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/manage-clone-voice`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              action: 'delete',
              voice_id: sessionCloneVoiceId,
              audio_file_path: sessionCloneVoiceFilePath
            }),
          });
          
          console.log(`Cleaned up session clone voice: ${sessionCloneVoiceId}`);
        }
      } catch (error: any) {
        console.warn(`Failed to cleanup session clone voice: ${error.message}`);
      }
      
      // Clear session storage
      setSessionCloneVoiceId(null);
      setSessionCloneVoiceFilePath(null);
    }
  };

  // Helper function to update tab status in database
  const updateTabStatus = async (status: 'idle' | 'outline' | 'generating' | 'error' | 'complete') => {
    if (!currentUserId) return;
    
    try {
      await supabase
        .from('tabs')
        .update({
          status: status,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', currentUserId)
        .eq('page', 'audio')
        .eq('tab_number', currentTab);
      
      // Notify container to refresh tabs
      onTabUpdate();
    } catch (err: any) {
      console.warn(`Failed to update tab status: ${err.message}`);
    }
  };

  // UPDATED: Helper function to clear VoiceSelector upload section
  const clearVoiceSelectorUploadSection = () => {
    if (voiceSelectorRef.current?.clearUploadSection) {
      voiceSelectorRef.current.clearUploadSection();
    }
  };

  const fetchDocumentsAndUser = async () => {
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

      const { data, error } = await withRetry(
        () => withTimeout(
          supabase
            .from('story_documents')
            .select('*')
            .eq('user_id', user.id)
            .in('version', [1, 2])
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
   
      if (storageError) throw storageError;

      let totalSize = 0;
      if (storageData && storageData.length > 0) {
        for (const doc of storageData) {
          if (doc.file_size == null || doc.file_size === 0) {
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
                console.error(`Failed to fetch size for ${doc.file_path}: ${fileError.message}`);
                continue;
              }

              const size = (await fileData.arrayBuffer()).byteLength;
              const { error: updateError } = await withRetry(
                () => withTimeout(
                  supabase
                    .from('story_documents')
                    .update({ file_size: size })
                    .eq('id', doc.id),
                  OPERATION_TIMEOUT,
                  `updateFileSize_${doc.id}`
                ),
                `updateFileSize_${doc.id}`
              );

              if (updateError) {
                console.error(`Failed to update file_size for ${doc.id}: ${updateError.message}`);
              } else {
                doc.file_size = size;
              }
            } catch (err: any) {
              console.error(`Error processing ${doc.file_path}: ${err}`);
            }
          }
          totalSize += doc.file_size || (doc.word_count ? doc.word_count * 1.5 : 0);
        }
      }

      const totalSizeMB = totalSize / (1024 * 1024);
      const formattedSize = totalSizeMB > 0 && totalSizeMB < 0.05 ? 0.1 : Number(totalSizeMB.toFixed(totalSizeMB < 1 ? 1 : 2));
      setStorageUsed(formattedSize);

      let tasksQuery = supabase
        .from('audio_tasks')
        .select('id,user_id,story_title,text_part,progress,error,status,group_id,doc_id,file_path,updated_at,batch_output,model_version,total_batches,batch_number,single_audio,check_stuck,variant,folder_timestamp')
        .eq('user_id', user.id)
        .eq('tab', currentTab)
        .or('video_process.is.null,video_process.eq.false')
        .in('status', ['pending', 'queued', 'running', 'completed', 'completed_final']);
      
      if (currentVariant !== null) {
        tasksQuery = tasksQuery.eq('variant', currentVariant);
      }
      
      const { data: tasks, error: taskError } = await withRetry(
        () => withTimeout(
          tasksQuery,
          OPERATION_TIMEOUT,
          'checkExistingTasks'
        ),
        'checkExistingTasks'
      );

      if (taskError) throw taskError;

      if (tasks && tasks.length > 0) {
        const task = tasks[0];
        setAudioTasks(tasks);

        // Check if video processing is complete for all tasks with the current group_id FIRST
        const groupTasks = tasks.filter(t => t.group_id === task.group_id);
        
        // Check if all tasks with the same group_id have video_process set to true
        let videoProcessQuery = supabase
          .from('audio_tasks')
          .select('video_process')
          .eq('group_id', task.group_id)
          .eq('tab', currentTab);
        
        if (currentVariant !== null) {
          videoProcessQuery = videoProcessQuery.eq('variant', currentVariant);
        }
        
        const { data: imagePromptTasks, error: imagePromptError } = await withRetry(
          () => withTimeout(
            videoProcessQuery,  // Add tab filter
            OPERATION_TIMEOUT,
            'checkVideoProcessStatus'
          ),
          'checkVideoProcessStatus'
        );

        let allVideoProcessed = false;
        if (!imagePromptError && imagePromptTasks && imagePromptTasks.length > 0) {
          allVideoProcessed = imagePromptTasks.every(t => t.video_process === true);
        }

        if (allVideoProcessed) {
          console.log('All image prompt tasks have video_process set to true, not showing any completion state');
          // Don't set any completion state or show any UI when video processing is complete
          setGenerationState('idle');
          setLoading(false);
          return;
        }

        const singleAudioTasks = tasks.filter(t => t.single_audio);
        if (singleAudioTasks.length > 0) {
          setMode('individual'); // Auto-switch to individual mode
          setSingleAudioGroupId(singleAudioTasks[0].group_id);
          
          // Check if this is single task or multiple tasks
          if (singleAudioTasks.length === 1) {
            // Single task - use simple UI
            const singleTask = singleAudioTasks[0];
            if (singleTask.status === 'completed_final') {
              setSingleAudioState('complete');
              if (singleTask.batch_output) {
                const audioPath = singleTask.batch_output.match(/https:\/\/[^\s]+/)?.[0];
                if (audioPath) {
                  const { data, error } = await supabase.storage
                    .from('stories')
                    .createSignedUrl(audioPath.replace(`${import.meta.env.SUPABASE_URL}/storage/v1/object/public/stories/`, ''), 3600, { download: false });
                  if (!error && data) {
                    setSingleAudioUrl(data.signedUrl);
                  } else {
                    setSingleAudioError(error?.message || 'Failed to generate signed URL');
                    setSingleAudioState('error');
                  }
                }
              }
            } else if (singleTask.status === 'error') {
              setSingleAudioError(singleTask.error || 'Single audio generation failed');
              setSingleAudioState('error');
            } else {
              setSingleAudioState('generating');
              setProgress(singleTask.progress || 0);
              setStatusMessage('Generating single audio...');
            }
          } else {
            // Multiple tasks - use document-style UI but keep in single audio state
            setSingleAudioState('generating');
            setCurrentGroupId(singleAudioTasks[0].group_id);
            setGeneratedGroupId(singleAudioTasks[0].group_id);
            setGeneratedDocTitle('Audio Outputs: Individual Audio Text');

            const allCompleted = singleAudioTasks.every(t => t.status === 'completed' || t.status === 'completed_final');
            
            if (allCompleted && !allVideoProcessed) {
              setSingleAudioState('complete');
              setProgress(100);
              setStatusMessage('Audio generation complete!');
              await refreshAudioOutput();
            } else if (singleAudioTasks.some(t => t.status === 'pending' || t.status === 'queued' || t.status === 'running')) {
              const completedTasks = singleAudioTasks.filter(t => t.status === 'completed' || t.status === 'completed_final');
              const totalProgress = singleAudioTasks.reduce((sum, t) => sum + (t.progress || 0), 0);
              const progressPercent = Math.min(100, singleAudioTasks.length > 0 ? (totalProgress / (singleAudioTasks.length * 100)) * 100 : 0);

              setProgress(progressPercent);
              setStatusMessage(`Processing part ${completedTasks.length + 1} of ${singleAudioTasks.length}`);
         
              const modelVersion = singleAudioTasks[0].model_version || 'lemonfox';
              const timePerBatch = modelVersion === 'v7' ? 10 : modelVersion === 'lemonfox' ? 30 : modelVersion === 'speechify' ? 5 : 30;
              const remainingBatches = singleAudioTasks.filter(t => t.status === 'pending' || t.status === 'queued' || t.status === 'running').length;
              setTimeRemaining(remainingBatches * timePerBatch);
            }
          }
        } else {
          // Handle regular tasks
          const regularTasks = tasks.filter(t => !t.single_audio);
          if (regularTasks.length > 0) {
            setCurrentGroupId(task.group_id);
            setGeneratedGroupId(task.group_id);
            setGeneratedDocTitle(task.story_title);

            // Check if all regular tasks are completed
            const allCompleted = regularTasks.every(t => t.status === 'completed' || t.status === 'completed_final');
            
            if (allCompleted && !allVideoProcessed) {
              // All tasks are completed and video processing is not complete, show the complete state
              setGenerationState('complete');
              setProgress(100);
              setStatusMessage('Audio generation complete!');
              await refreshAudioOutput();
            } else if (regularTasks.some(t => t.status === 'pending' || t.status === 'queued' || t.status === 'running')) {
              // Some tasks are still in progress
              setGenerationState('generating');
              setProgress(task.progress || 0);
              setStatusMessage(`Processing audio generation...`);
         
              // Calculate time remaining based on model version
              const modelVersion = task.model_version || 'lemonfox';
              const timePerBatch = modelVersion === 'v7' ? 10 : modelVersion === 'lemonfox' ? 30 : modelVersion === 'speechify' ? 5 : 30; // 5 seconds for speechify
              const remainingBatches = regularTasks.filter(t => t.status === 'pending' || t.status === 'queued' || t.status === 'running').length;
              setTimeRemaining(remainingBatches * timePerBatch);
            }
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

  useEffect(() => {
    fetchDocumentsAndUser();
  }, []);

  const refreshAudioOutput = async () => {
    try {
      if (!generatedGroupId || !currentUserId) return;

      let audioDoc = null;
      let attempts = 0;
      const maxAttempts = 10;
      const retryDelay = 2000; // 2 seconds

      while (!audioDoc && attempts < maxAttempts) {
        let docQuery = supabase
          .from('story_documents')
          .select('file_path, title, version')
          .eq('group_id', generatedGroupId)
          .eq('user_id', currentUserId)
          .in('version', [7, 8, 9, 10]);

        if (currentVariant !== null) {
          docQuery = docQuery.eq('variant', currentVariant);
        }

        const { data, error: docError } = await docQuery
          .order('created_at', { ascending: false })
          .limit(1);

        if (docError) {
          if (docError.code === 'PGRST116' && docError.details && docError.details.includes('0 rows')) {
            attempts++;
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            continue;
          }
          console.error('Error finding audio output document:', docError);
          setError(`Failed to find audio output document: ${docError?.message || 'No audio output document found'}`);
          setGenerationState('error');
          return;
        }
        
        if (data && data.length > 0) {
          audioDoc = data[0];
        } else {
          attempts++;
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }
      }

      if (!audioDoc) {
        console.log('Audio output document not ready yet, will retry...');
        return; // Just return instead of throwing error
      }

      setGeneratedDocTitle(audioDoc.title);
      setAudioFilePath(audioDoc.file_path);

      const isSingleFile = [7, 8].includes(audioDoc.version);
      setOutputType(isSingleFile ? 'single' : 'folder');

      if (isSingleFile) {
        // Check if file exists before creating signed URL
        const fileExists = await checkFileExists(audioDoc.file_path);
        if (!fileExists) {
          console.warn(`Audio file not found: ${audioDoc.file_path}`);
          // Don't set error, just log and return - file might still be processing
          return;
        }

        try {
          const { data, error: signedUrlError } = await supabase.storage
            .from('stories')
            .createSignedUrl(audioDoc.file_path, 3600, { download: false });

          if (signedUrlError) {
            console.warn('Error creating signed URL for audio:', signedUrlError);
            // Don't set error state, just log the warning
            return;
          }

          setGeneratedAudio(data.signedUrl);
          setSingleAudioUrl(data.signedUrl); // Also set for single audio
        } catch (error: any) {
          console.warn('Error during signed URL creation:', error);
          // Don't set error state, just log the warning
        }
      } else {
        setGeneratedAudio(audioDoc.file_path);
      }
    } catch (error: any) {
      console.warn('Error refreshing audio output:', error);
      // Don't set error state, just log the warning
    }
  };

  const fetchTasksForPolling = async () => {
    // Hoisted so the catch block below can disambiguate between single-audio
    // and document-mode errors even if the try throws before assignment.
    let groupId: string | null | undefined;
    try {
      if (!checkNetworkStatus()) {
        setNetworkRetrying(true);
        setStatusMessage('Waiting for network connection...');
        return;
      }

      if (!currentUserId) return;

      // Check if user has any single_audio tasks first
      let singleAudioQuery = supabase
        .from('audio_tasks')
        .select('group_id, story_title')
        .eq('user_id', currentUserId)
        .eq('tab', currentTab)
        .eq('single_audio', true)
        .or('video_process.is.null,video_process.eq.false')
        .in('status', ['pending', 'queued', 'running', 'completed', 'completed_final']);

      if (currentVariant !== null) {
        singleAudioQuery = singleAudioQuery.eq('variant', currentVariant);
      }

      const { data: singleAudioCheck, error: singleAudioCheckError } = await withRetry(
        () => withTimeout(
          singleAudioQuery,
          OPERATION_TIMEOUT,
          'checkSingleAudioTasks'
        ),
        'checkSingleAudioTasks'
      );

      if (!singleAudioCheckError && singleAudioCheck && singleAudioCheck.length > 0) {
        setMode('individual');
        setSingleAudioGroupId(singleAudioCheck[0].group_id);
        setGeneratedDocTitle('Audio Outputs: Individual Audio Text');
        
        // Set appropriate state based on task count
        if (singleAudioCheck.length === 1) {
          // Single task - use simple UI (existing logic continues below)
        } else {
          // Multiple tasks - use document-style UI but in individual mode
          setCurrentGroupId(singleAudioCheck[0].group_id);
          setGeneratedGroupId(singleAudioCheck[0].group_id);
        }
      }
   
      groupId = currentGroupId || singleAudioGroupId;
      if (!groupId) return;

      const { data: tasks, error } = await withRetry(
        () => withTimeout(
          supabase
            .from('audio_tasks')
            .select('id,story_title,progress,error,status,group_id,updated_at,batch_output,model_version,total_batches,batch_number,single_audio,check_stuck')
            .eq('user_id', currentUserId)
            .eq('group_id', groupId)
            .eq('tab', currentTab)
            .or('video_process.is.null,video_process.eq.false')
            .order('created_at', { ascending: true }),
          OPERATION_TIMEOUT,
          'fetchTasks'
        ),
        'fetchTasks'
      );

      if (error) throw new Error(`Failed to fetch tasks: ${error.message}`);

      if (!tasks || tasks.length === 0) {
        if (singleAudioGroupId === groupId) {
          if (Date.now() - generationStartTime.current! < 30000) {
            return;
          }
          setSingleAudioError('No tasks found for this group after retry');
          setSingleAudioState('error');
          return;
        } else {
          // Tasks were deleted externally (e.g. from Documents page) — reset to idle silently
          setGenerationState('idle');
          setError(null);
          setCurrentGroupId(null);
          setGeneratedGroupId(null);
          return;
        }
      }

      setAudioTasks(tasks);

      // Check if video processing is complete for all tasks with the current group_id FIRST
      const { data: imagePromptTasks, error: imagePromptError } = await withRetry(
        () => withTimeout(
          supabase
            .from('audio_tasks')
            .select('video_process')
            .eq('group_id', groupId)
            .eq('tab', currentTab),  // Add tab filter
          OPERATION_TIMEOUT,
          'checkVideoProcessStatus'
        ),
        'checkVideoProcessStatus'
      );

      let allVideoProcessed = false;
      if (!imagePromptError && imagePromptTasks && imagePromptTasks.length > 0) {
        allVideoProcessed = imagePromptTasks.every(t => t.video_process === true);
      }

      if (allVideoProcessed) {
        // Video processing is complete, stop showing progress and reset to idle
        console.log('All image prompt tasks have video_process set to true, resetting to idle state');
        setProgress(0);
        setTimeRemaining(null);
        setStatusMessage('');
        setGenerationState('idle');
        setSingleAudioState('idle');
        return; // Exit early to stop polling
      }

      const singleAudioTasks = tasks.filter(t => t.single_audio);
      if (singleAudioTasks.length > 0 && singleAudioGroupId === groupId) {
        // Check if this is single task or multiple tasks
        if (singleAudioTasks.length === 1) {
          // Single task processing
          const singleTask = singleAudioTasks[0];
          if (singleTask.status === 'completed_final') {
            setSingleAudioState('complete');
            setProgress(100);
            setStatusMessage('Single audio generation complete!');
            if (singleTask.batch_output) {
              const audioPath = singleTask.batch_output.match(/https:\/\/[^\s]+/)?.[0];
              if (audioPath) {
                try {
                  const filePath = audioPath.replace(`${import.meta.env.SUPABASE_URL}/storage/v1/object/public/stories/`, '');
                  
                  // Check if file exists before creating signed URL
                  const fileExists = await checkFileExists(filePath);
                  if (!fileExists) {
                    console.warn(`Single audio file not found: ${filePath}`);
                    return;
                  }

                  const { data, error } = await withRetry(
                    () => withTimeout(
                      supabase.storage
                        .from('stories')
                        .createSignedUrl(filePath, 3600, { download: false }),
                      OPERATION_TIMEOUT,
                      'createSignedUrl_single_audio'
                    ),
                    'createSignedUrl_single_audio'
                  );
                  if (!error && data) {
                    setSingleAudioUrl(data.signedUrl);
                  } else {
                    console.warn('Failed to generate signed URL for single audio:', error?.message);
                  }
                } catch (error: any) {
                  console.warn('Error processing single audio URL:', error.message);
                }
              }
            }
          } else if (singleTask.status === 'error') {
            setSingleAudioError(singleTask.error || 'Single audio generation failed');
            setSingleAudioState('error');
          } else {
            setProgress(singleTask.progress || 0);
            setStatusMessage('Generating single audio...');
            setSingleAudioState('generating');
          }
        } else {
          // Multiple tasks processing - use document-style progress
          const completedTasks = singleAudioTasks.filter(t => t.status === 'completed' || t.status === 'completed_final');
          const totalProgress = singleAudioTasks.reduce((sum, t) => sum + (t.progress || 0), 0);
          const progressPercent = Math.min(100, singleAudioTasks.length > 0 ? (totalProgress / (singleAudioTasks.length * 100)) * 100 : 0);

          setProgress(progressPercent);
          setStatusMessage(singleAudioTasks.length > 0 ? `Processing part ${completedTasks.length + 1} of ${singleAudioTasks.length}` : 'Preparing audio generation...');

          // Find the current task being processed
          const currentTaskNumber = completedTasks.length + 1;
          const currentTask = singleAudioTasks.find(t => t.batch_number === currentTaskNumber);
          setCurrentTask(currentTask || null);
     
          // Calculate time remaining based on model version
          const modelVersion = singleAudioTasks[0]?.model_version || 'lemonfox';
          const timePerBatch = modelVersion === 'v7' ? 10 : modelVersion === 'lemonfox' ? 30 : modelVersion === 'speechify' ? 5 : 30;
          setTimeRemaining((singleAudioTasks.length - completedTasks.length) * timePerBatch);

          const errorTask = singleAudioTasks.find(t => t.status === 'error');
          if (errorTask) {
            setSingleAudioError(errorTask.error || 'An error occurred during processing');
            setSingleAudioState('error');
            return;
          }

          if (singleAudioTasks.every(t => t.status === 'completed' || t.status === 'completed_final') && !allVideoProcessed) {
            setSingleAudioState('complete');
            setProgress(100);
            setTimeRemaining(0);
            setStatusMessage('Audio generation complete!');
            await refreshAudioOutput();
          }
        }
      } else {
        const filteredTasks = tasks.filter(t => !t.single_audio);
        const completedTasks = filteredTasks.filter(t => t.status === 'completed' || t.status === 'completed_final');
        const totalProgress = filteredTasks.reduce((sum, t) => sum + (t.progress || 0), 0);
        const progressPercent = Math.min(100, filteredTasks.length > 0 ? (totalProgress / (filteredTasks.length * 100)) * 100 : 0);

        setProgress(progressPercent);
        setStatusMessage(filteredTasks.length > 0 ? `Processing part ${completedTasks.length + 1} of ${filteredTasks.length}` : 'Preparing audio generation...');

        // Find the current task being processed
        const currentTaskNumber = completedTasks.length + 1;
        const currentTask = filteredTasks.find(t => t.batch_number === currentTaskNumber);
        setCurrentTask(currentTask || null);
     
        // Calculate time remaining based on model version
        const modelVersion = filteredTasks[0]?.model_version || 'lemonfox';
        const timePerBatch = modelVersion === 'v7' ? 10 : modelVersion === 'lemonfox' ? 30 : modelVersion === 'speechify' ? 5 : 30; // 5 seconds for speechify
        setTimeRemaining((filteredTasks.length - completedTasks.length) * timePerBatch);

        const errorTask = filteredTasks.find(t => t.status === 'error');
        if (errorTask) {
          setError(errorTask.error || 'An error occurred during processing');
          setGenerationState('error');
          return;
        }

        if (filteredTasks.every(t => t.status === 'completed' || t.status === 'completed_final') && !allVideoProcessed) {
          setGenerationState('complete');
          setProgress(100);
          setTimeRemaining(0);
          setStatusMessage('Audio generation complete!');
          await refreshAudioOutput();
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
        if (singleAudioGroupId === groupId) {
          setSingleAudioError(err.message);
          setSingleAudioState('error');
        } else {
          setError(err.message);
          setGenerationState('error');
        }
      }
    }
  };

  useEffect(() => {
    if ((generationState !== 'generating' && generationState !== 'complete' && singleAudioState !== 'generating' && singleAudioState !== 'complete') || (!currentGroupId && !singleAudioGroupId) || !currentUserId) return;

    let subscriptionActive = false;
    const groupId = currentGroupId || singleAudioGroupId;

    const subscription = supabase
      .channel(`audio_tasks:${groupId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'audio_tasks',
          filter: `group_id=eq.${groupId}`,
        },
        async (payload) => {
          lastUpdateRef.current = Date.now();
          lastSubscriptionUpdateRef.current = Date.now();
          subscriptionActive = true;

          const updatedTask = payload.new as AudioTask;

          // Filter by variant to avoid mixing data from different variants
          if (currentVariant !== null && updatedTask.variant !== undefined && updatedTask.variant !== currentVariant) {
            return;
          }

          setAudioTasks((prevTasks) => {
            const taskExists = prevTasks.some(task => task.id === updatedTask.id);
            if (taskExists) {
              return prevTasks.map((task) =>
                task.id === updatedTask.id ? { ...task, ...updatedTask } : task
              );
            } else {
              return [...prevTasks, updatedTask];
            }
          });

          // Check if video processing is complete for all tasks with the current group_id
          const { data: imagePromptTasks, error: imagePromptError } = await withRetry(
            () => withTimeout(
              supabase
                .from('audio_tasks')
                .select('video_process')
                .eq('group_id', groupId)
                .eq('tab', currentTab),  // Add tab filter
              OPERATION_TIMEOUT,
              'checkVideoProcessStatus'
            ),
            'checkVideoProcessStatus'
          );

          let allVideoProcessed = false;
          if (!imagePromptError && imagePromptTasks && imagePromptTasks.length > 0) {
            allVideoProcessed = imagePromptTasks.every(t => t.video_process === true);
          }

          if (allVideoProcessed) {
            // Video processing is complete, stop showing progress and reset to idle
            console.log('All image prompt tasks have video_process set to true, resetting to idle state');
            setProgress(0);
            setTimeRemaining(null);
            setStatusMessage('');
            setGenerationState('idle');
            setSingleAudioState('idle');
            return; // Exit early to stop processing
          }

          if (updatedTask.single_audio) {
            if (updatedTask.status === 'completed_final' && updatedTask.batch_output) {
              try {
                const audioPath = updatedTask.batch_output.match(/https:\/\/[^\s]+/)?.[0];
                if (!audioPath) throw new Error('No valid audio URL in batch_output');

                const filePath = audioPath.replace(`${import.meta.env.SUPABASE_URL}/storage/v1/object/public/stories/`, '');
                
                // Check if file exists before creating signed URL
                const fileExists = await checkFileExists(filePath);
                if (!fileExists) {
                  console.warn(`Single audio file not found: ${filePath}`);
                  return;
                }

                const { data, error } = await withRetry(
                  () => withTimeout(
                    supabase.storage
                      .from('stories')
                      .createSignedUrl(filePath, 3600, { download: false }),
                    OPERATION_TIMEOUT,
                    'createSignedUrl_single_audio'
                  ),
                  'createSignedUrl_single_audio'
                );

                if (error) throw error;

                setSingleAudioUrl(data.signedUrl);
                setSingleAudioState('complete');
                setStatusMessage('Single audio generation complete!');
                setProgress(100);
              } catch (error: any) {
                console.warn('Error updating single audio:', error);
                // Don't set error state, just log the warning
              }
            } else if (updatedTask.status === 'error') {
              setSingleAudioError(updatedTask.error || 'Single audio generation failed');
              setSingleAudioState('error');
            } else {
              setProgress(updatedTask.progress || 0);
              setSingleAudioState('generating');
              setStatusMessage('Generating single audio...');
            }
          } else if (updatedTask.status === 'completed_final') {
            try {
              await refreshAudioOutput();
              setGenerationState('complete');
              setStatusMessage('Audio generation complete!');
              setProgress(100);
            } catch (error: any) {
              console.warn('Error updating audio:', error);
              // Don't set error state, just log the warning
            }
          } else if (updatedTask.status === 'error') {
            setError(updatedTask.error || 'Audio generation failed');
            setGenerationState('error');
          } else {
            setProgress(updatedTask.progress || 0);
            setGenerationState('generating');
            setStatusMessage('Generating audio...');
          }
        }
      )
      .subscribe((status, err) => {
        if (err) {
          console.error('Subscription error:', err.message);
          subscriptionActive = false;
        } else {
          subscriptionActive = status === 'SUBSCRIBED';
          lastSubscriptionUpdateRef.current = Date.now();
        }
      });

    const pollTasksInterval = async () => {
      if (subscriptionActive && Date.now() - lastUpdateRef.current < POLLING_INTERVAL) return;
      await fetchTasksForPolling();
    };

    const checkSubscription = () => {
      if (!subscriptionActive && Date.now() - lastSubscriptionUpdateRef.current > SUBSCRIPTION_CHECK_INTERVAL) {
        subscription.unsubscribe();
        subscription.subscribe((status, err) => {
          if (err) {
            console.error('Re-subscription error:', err.message);
            subscriptionActive = false;
          } else {
            subscriptionActive = status === 'SUBSCRIBED';
            lastSubscriptionUpdateRef.current = Date.now();
          }
        });
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
      subscription.unsubscribe();
      clearInterval(pollInterval);
      clearInterval(subscriptionCheckInterval);
      window.removeEventListener('online', handleNetworkChange);
      window.removeEventListener('offline', handleNetworkChange);
    };
  }, [generationState, currentGroupId, singleAudioGroupId, currentUserId, singleAudioState, currentVariant]);

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

      const { data: { session } } = await withRetry(
        () => withTimeout(supabase.auth.getSession(), OPERATION_TIMEOUT, 'getSession'),
        'getSession'
      );

      if (!session) throw new Error('No active session found');

      let requestBody: any = {
        user_id: user.id,
        voice: selectedVoice,
        remove_title_chapters: removeTitleChapters,
        volume: volume,
      };

      // ElevenLabs cost depends on the selected ElevenLabs model.
      if (isElevenLabsVoice(selectedVoice)) {
        requestBody.elevenlabs_model_id = elevenLabsModelId;
      }

      if (uploadedFile) {
        const content = await uploadedFile.text();
        requestBody.content = content;
        requestBody.story_title = uploadedFile.name.replace(/\.txt$/, '');
        requestBody.description = '';
      } else {
        const doc = documents.find(doc => doc.id === selectedDoc);
        if (!doc) throw new Error('Selected document not found');
     
        requestBody.file_path = doc.file_path;
        requestBody.doc_id = doc.id;
        requestBody.story_title = doc.title;
        requestBody.description = doc.description || '';
      }

      const response = await withRetry(
        () => withTimeout(
          fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/audio-analyze`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify(requestBody),
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

      setAnalysisResult({
        totalCharacters: response.totalCharacters,
        wordCount: response.wordCount,
        estimatedTokens: response.estimatedTokens,
        estimatedFileSizeMB: response.estimatedFileSizeMB,
        isPremiumVoice: response.isPremiumVoice,
        costPerChar: response.costPerChar,
        volumeBoost: response.volumeBoost,
      });

      setGeneratedDocTitle(uploadedFile ? uploadedFile.name : documents.find(doc => doc.id === selectedDoc)?.title || 'Audio Output');
      setGeneratedGroupId(uuidv4());
      setGenerationState('analyzed');
      setStatusMessage('Analysis complete.');
    } catch (err: any) {
      setError(err.message || 'An error occurred during analysis');
      setGenerationState('error');
    }
  };

  const handleContinue = async () => {
    setGenerationState('generating');
    setStatusMessage('Preparing audio generation...');
    setProgress(0);
    setTimeRemaining(null);

    try {
      if (!checkNetworkStatus()) throw new Error('No internet connection');

      const { data: { user } } = await withRetry(
        () => withTimeout(supabase.auth.getUser(), OPERATION_TIMEOUT, 'getUser'),
        'getUser'
      );

      if (!user) throw new Error('User not authenticated');

      if (!selectedVoice) throw new Error('Please select a voice');

      if (analysisResult && analysisResult.estimatedTokens > userTokenBalance) {
        throw new Error(
          `Insufficient tokens to generate audio. Required: ${formatNumber(analysisResult.estimatedTokens)} tokens, Available: ${formatNumber(userTokenBalance)}`
        );
      }

      if (storageUsed !== null && analysisResult) {
        const requiredStorage = analysisResult.estimatedFileSizeMB;
        const availableStorage = (maxStorageGB * 1024) - storageUsed;
        if (requiredStorage > availableStorage) {
          throw new Error(
            `Insufficient storage space. Required: ${formatStorageSize(requiredStorage)}, Available: ${formatStorageSize(availableStorage)}`
          );
        }
      }

      const { data: { session } } = await withRetry(
        () => withTimeout(supabase.auth.getSession(), OPERATION_TIMEOUT, 'getSession'),
        'getSession'
      );

      if (!session) throw new Error('No active session found');

      // Line ~480: Update the file upload logic in handleContinue
      let filePath: string;
      let docId: string | undefined;
      let storyTitle: string;
      let description: string;

      if (uploadedFile) {
        // Find the document in story_documents that matches the uploaded file
        const doc = documents.find(doc => doc.title === uploadedFile.name.replace(/\.txt$/, '') && doc.file_size === uploadedFile.size);
        if (!doc) {
          throw new Error('Uploaded document not found in story_documents');
        }
        filePath = doc.file_path;
        docId = doc.id;
        storyTitle = doc.title;
        description = doc.description || '';
      } else {
        const doc = documents.find(doc => doc.id === selectedDoc);
        if (!doc) throw new Error('Selected document not found');
        filePath = doc.file_path;
        docId = doc.id;
        storyTitle = doc.title;
        description = doc.description || '';
      }

      const doc = uploadedFile
        ? documents.find(doc => doc.title === uploadedFile.name.replace(/\.txt$/, '') && doc.file_size === uploadedFile.size)
        : documents.find(doc => doc.id === selectedDoc);

      const groupId = doc?.group_id || generatedGroupId || uuidv4();

      // Check for existing variants
      let variant = 1;
      if (docId) {
        const doc = documents.find(d => d.id === docId);
        if (doc && doc.group_id) {
          const { data: existingDocs, error: fetchVariantError } = await supabase
            .from('story_documents')
            .select('variant')
            .eq('group_id', doc.group_id)
            .eq('user_id', user.id)
            .in('version', [7, 8, 9, 10]) // Audio output versions
            .order('variant', { ascending: false });
       
          if (fetchVariantError) {
            throw new Error(`Failed to fetch existing variants: ${fetchVariantError.message}`);
          }
       
          if (existingDocs && existingDocs.length > 0) {
            const highestVariant = Math.max(...existingDocs.map(doc => doc.variant || 0));
            variant = highestVariant + 1;
          }
        }
      }

      // Determine model version and voice ID - use type-aware voice checking
      let modelVersion: 'v7' | 'clone' | 'lemonfox' | 'speechify' | 'elevenlabs';
      let language: string;
      let voiceName: string;
      let cloneVoiceName: string | undefined;
      let cloneVoiceUrl: string | undefined;
      let cloneLanguage: string | undefined;
      
      if (isElevenLabsVoice(selectedVoice)) {
        modelVersion = 'elevenlabs';
        language = elevenLabsVoice?.language || 'en';
        voiceName = elevenLabsVoice?.voice_id || selectedVoice.split(':')[1] || '';
      } else if (isCoreVoice(selectedVoice)) {
        modelVersion = 'lemonfox';
        language = 'en-us';
        voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
      } else if (isPremiumVoice(selectedVoice)) {
        modelVersion = 'v7';
        // Find the voice object to get language - this is already in the VoiceSelector component
        language = 'american english'; // Default fallback
        voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
      } else if (isApexVoice(selectedVoice)) {
        modelVersion = 'speechify';
        // Find the voice object to get language - this is already in the VoiceSelector component
        language = 'american english'; // Default fallback
        voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
      } else if (isCloneVoice(selectedVoice)) {
        modelVersion = 'clone';
        language = 'english'; // Default for clone voices
        voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
        cloneVoiceName = voiceName;
        
        // Check if it's a predefined clone voice
        const predefinedVoice = predefinedCloneVoices.find(v => v.name === voiceName);
        if (predefinedVoice) {
          cloneVoiceUrl = predefinedVoice.voice_id;
        } else {
          // Custom voice - use the workspace format
          cloneVoiceUrl = `default-ujsa1wysgyitfqg3ixpqka__${voiceName}`;
          
          // Track this as a session clone voice for cleanup
          if (sessionCloneVoiceId && sessionCloneVoiceId.endsWith(`__${voiceName}`)) {
            // This is the session clone voice we created
            console.log(`Using session clone voice: ${voiceName} -> ${sessionCloneVoiceId}`);
          }
        }
        cloneLanguage = language;
      } else {
        modelVersion = 'lemonfox';
        language = 'en-us';
        voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
      }

      let requestBody: any = {
        user_id: user.id,
        group_id: groupId,
        file_path: filePath,
        story_title: storyTitle,
        description: description,
        doc_id: docId,
        variant,
        voice: voiceName,
        language: language,
        model_version: modelVersion,
        speed: speed,
        volume: volume,
        preference: preference,
        remove_title_chapters: isRemoveTitleChaptersDisabled() ? false : removeTitleChapters,
        tab: currentTab,  // Add tab parameter
      };

      // Add clone voice fields if model_version is 'clone'
      if (modelVersion === 'clone') {
        requestBody.clone_voice_name = cloneVoiceName;
        requestBody.clone_voice_url = cloneVoiceUrl;
        requestBody.clone_language = cloneLanguage;
      }

      // Add ElevenLabs model id if applicable
      if (modelVersion === 'elevenlabs') {
        requestBody.elevenlabs_model_id = elevenLabsModelId;
      }

      const response = await withRetry(
        () => withTimeout(
          fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/setup-audio-tasks`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify(requestBody),
          }).then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to setup tasks`);
            return res.json();
          }),
          OPERATION_TIMEOUT,
          'setupAudioTasks'
        ),
        'setupAudioTasks'
      );

      setCurrentGroupId(response.group_id || groupId);
      setGeneratedGroupId(response.group_id || groupId);
      setCurrentVariant(variant);
   
      // Calculate time remaining based on model version
      const timePerBatch = modelVersion === 'v7' ? 10 : modelVersion === 'lemonfox' ? 30 : modelVersion === 'speechify' ? 5 : modelVersion === 'clone' ? 10 : 30;
      setTimeRemaining(response.total_batches ? response.total_batches * timePerBatch : timePerBatch);
      setStatusMessage('Preparing audio generation...');
    } catch (err: any) {
      setError(err.message || 'An error occurred during generation');
      setGenerationState('error');
    }
  };

  const handleSingleAudioGenerate = async () => {
    if (!singleAudioText || singleAudioText.trim() === '') {
      setSingleAudioError('Please enter text to convert to speech');
      return;
    }

    if (singleAudioText.length > 700000) {
      setSingleAudioError('Text exceeds the maximum limit of 700,000 characters');
      return;
    }

    if (!selectedVoice) {
      setSingleAudioError('Please select a voice');
      return;
    }

    if (singleAudioSpeedError !== '') {
      setSingleAudioError('Please fix the speed value');
      return;
    }

    if (singleAudioVolumeError !== '') {
      setSingleAudioError('Please fix the volume value');
      return;
    }

    // Determine if this is a large text that needs document processing
    const isLargeText = singleAudioText.length > 1200;

    if (isLargeText) {
      // Use document pipeline for large text
      setSingleAudioError(null);
      setSingleAudioState('generating');
      setStatusMessage('Processing large text...');
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

        // Determine model version and language - use type-aware voice checking
        let modelVersion: 'v7' | 'clone' | 'lemonfox' | 'speechify' | 'elevenlabs';
        let language: string;
        let voiceName: string;
        let cloneVoiceName: string | undefined;
        let cloneVoiceUrl: string | undefined;
        let cloneLanguage: string | undefined;
        
        if (isElevenLabsVoice(selectedVoice)) {
          modelVersion = 'elevenlabs';
          language = elevenLabsVoice?.language || 'en';
          voiceName = elevenLabsVoice?.voice_id || selectedVoice.split(':')[1] || '';
        } else if (isCoreVoice(selectedVoice)) {
          modelVersion = 'lemonfox';
          language = 'en-us';
          voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
        } else if (isPremiumVoice(selectedVoice)) {
          modelVersion = 'v7';
          language = 'american english'; // Default fallback
          voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
        } else if (isApexVoice(selectedVoice)) {
          modelVersion = 'speechify';
          language = 'american english'; // Default fallback
          voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
        } else if (isCloneVoice(selectedVoice)) {
          modelVersion = 'clone';
          language = 'english'; // Default for clone voices
          voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
          cloneVoiceName = voiceName;
          
          // Check if it's a predefined clone voice
          const predefinedVoice = predefinedCloneVoices.find(v => v.name === voiceName);
          if (predefinedVoice) {
            cloneVoiceUrl = predefinedVoice.voice_id;
          } else {
            // Custom voice - use the workspace format
            cloneVoiceUrl = `default-ujsa1wysgyitfqg3ixpqka__${voiceName}`;
            
            // Track this as a session clone voice for cleanup
            if (sessionCloneVoiceId && sessionCloneVoiceId.endsWith(`__${voiceName}`)) {
              // This is the session clone voice we created
              console.log(`Using session clone voice: ${voiceName} -> ${sessionCloneVoiceId}`);
            }
          }
          cloneLanguage = language;
        } else {
          modelVersion = 'lemonfox';
          language = 'en-us';
          voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
        }

        // Calculate required tokens
        const baseTokens = singleAudioText.length * (modelVersion === 'lemonfox' ? 2 : modelVersion === 'speechify' ? 8 : modelVersion === 'elevenlabs' ? (elevenLabsModelId === 'eleven_multilingual_v2' ? 200 : 100) : modelVersion === 'clone' ? 4 : 4);
        const volumeTokens = singleAudioVolume > 1.0 ? 100 : 0;
        const requiredTokens = baseTokens + volumeTokens;

        if (userTokenBalance < requiredTokens) {
          setSingleAudioError(`Insufficient tokens. Required: ${formatNumber(requiredTokens)}, Available: ${formatNumber(userTokenBalance)}`);
          setSingleAudioState('idle');
          return;
        }

        const groupId = uuidv4();
        setSingleAudioGroupId(groupId);
        setCurrentGroupId(groupId); // Also set currentGroupId for polling

        let requestBody: any = {
          user_id: user.id,
          text_content: singleAudioText,
          voice: voiceName,
          language: language,
          model_version: modelVersion,
          speed: singleAudioSpeed,
          volume: singleAudioVolume,
          group_id: groupId,
        };

        // Add clone voice fields if model_version is 'clone'
        if (modelVersion === 'clone') {
          requestBody.clone_voice_name = cloneVoiceName;
          requestBody.clone_voice_url = cloneVoiceUrl;
          requestBody.clone_language = cloneLanguage;
        }

        if (modelVersion === 'elevenlabs') {
          requestBody.elevenlabs_model_id = elevenLabsModelId;
        }

        // Call create-text-document edge function
        const response = await withRetry(
          () => withTimeout(
            fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/create-text-document`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`,
              },
              body: JSON.stringify(requestBody),
            }).then(res => {
              if (!res.ok) return res.json().then(errorData => { throw new Error(`Failed to create text document: ${errorData.error || 'Unknown error'}`); });
              return res.json();
            }),
            OPERATION_TIMEOUT,
            'createTextDocument'
          ),
          'createTextDocument'
        );

        if (response.error) throw new Error(`Document creation error: ${response.error}`);

        setGeneratedGroupId(groupId);
        setGeneratedDocTitle('Audio Outputs: Individual Audio Text');

        // Calculate time remaining based on model version and total batches
        const timePerBatch = modelVersion === 'v7' ? 10 : modelVersion === 'lemonfox' ? 30 : modelVersion === 'speechify' ? 5 : modelVersion === 'clone' ? 10 : modelVersion === 'elevenlabs' ? 5 : 30;
        setTimeRemaining(response.total_batches ? response.total_batches * timePerBatch : timePerBatch);
        setStatusMessage('Processing large text...');

        await fetchTasksForPolling();
      } catch (err: any) {
        setSingleAudioError(err.message || 'An error occurred during large text processing');
        setSingleAudioState('error');
      }
    } else {
      // Use existing single audio flow for small text
      // Calculate required tokens - use type-aware voice checking
      let modelVersion: 'v7' | 'clone' | 'lemonfox' | 'speechify' | 'elevenlabs';
      if (isElevenLabsVoice(selectedVoice)) {
        modelVersion = 'elevenlabs';
      } else if (isCoreVoice(selectedVoice)) {
        modelVersion = 'lemonfox';
      } else if (isPremiumVoice(selectedVoice)) {
        modelVersion = 'v7';
      } else if (isApexVoice(selectedVoice)) {
        modelVersion = 'speechify';
      } else if (isCloneVoice(selectedVoice)) {
        modelVersion = 'clone';
      } else {
        modelVersion = 'lemonfox';
      }
      
      const baseTokens = singleAudioText.length * (modelVersion === 'lemonfox' ? 2 : modelVersion === 'speechify' ? 8 : modelVersion === 'elevenlabs' ? (elevenLabsModelId === 'eleven_multilingual_v2' ? 200 : 100) : modelVersion === 'clone' ? 4 : 4);
      const volumeTokens = singleAudioVolume > 1.0 ? 100 : 0;
      const requiredTokens = baseTokens + volumeTokens;
   
      if (userTokenBalance < requiredTokens) {
        setSingleAudioError(`Insufficient tokens. Required: ${formatNumber(requiredTokens)}, Available: ${formatNumber(userTokenBalance)}`);
        return;
      }

      setSingleAudioError(null);
      setSingleAudioState('generating');
      setStatusMessage('Generating single audio...');
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
        setSingleAudioGroupId(groupId);

        // Determine language and voice name - use type-aware voice checking
        let language: string;
        let voiceName: string;
        let cloneVoiceName: string | undefined;
        let cloneVoiceUrl: string | undefined;
        let cloneLanguage: string | undefined;
        
        if (isCoreVoice(selectedVoice)) {
          language = 'en-us';
          voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
        } else if (isPremiumVoice(selectedVoice)) {
          language = 'american english'; // Default fallback
          voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
        } else if (isApexVoice(selectedVoice)) {
          language = 'american english'; // Default fallback
          voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
        } else if (isElevenLabsVoice(selectedVoice)) {
          language = elevenLabsVoice?.language || 'en';
          voiceName = elevenLabsVoice?.voice_id || selectedVoice.split(':')[1] || '';
        } else if (isCloneVoice(selectedVoice)) {
          language = 'english'; // Default for clone voices
          voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
          cloneVoiceName = voiceName;
          
          // Check if it's a predefined clone voice
          const predefinedVoice = predefinedCloneVoices.find(v => v.name === voiceName);
          if (predefinedVoice) {
            cloneVoiceUrl = predefinedVoice.voice_id;
          } else {
            // Custom voice - use the workspace format
            cloneVoiceUrl = `default-ujsa1wysgyitfqg3ixpqka__${voiceName}`;
            
            // Track this as a session clone voice for cleanup
            if (sessionCloneVoiceId && sessionCloneVoiceId.endsWith(`__${voiceName}`)) {
              // This is the session clone voice we created
              console.log(`Using session clone voice: ${voiceName} -> ${sessionCloneVoiceId}`);
            }
          }
          cloneLanguage = language;
        } else {
          language = 'american english';
          voiceName = selectedVoice.includes(':') ? selectedVoice.split(':')[1] : selectedVoice;
        }

        let requestBody: any = {
          user_id: user.id,
          prompt: singleAudioText,
          group_id: groupId,
          story_title: 'Single Audio',
          voice: voiceName,
          language: language,
          model_version: modelVersion,
          speed: singleAudioSpeed,
          preference: 'merged',
          remove_title_chapters: false,
          volume: singleAudioVolume,
          tab: currentTab,  // Add tab parameter
        };

        // Add clone voice fields if model_version is 'clone'
        if (modelVersion === 'clone') {
          requestBody.clone_voice_name = cloneVoiceName;
          requestBody.clone_voice_url = cloneVoiceUrl;
          requestBody.clone_language = cloneLanguage;
        }

        if (modelVersion === 'elevenlabs') {
          requestBody.elevenlabs_model_id = elevenLabsModelId;
        }

        const response = await withRetry(
          () => withTimeout(
            fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/single-audio`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`,
              },
              body: JSON.stringify(requestBody),
            }).then(res => {
              if (!res.ok) return res.json().then(errorData => { throw new Error(`Failed to generate single audio: ${errorData.error || 'Unknown error'}`); });
              return res.json();
            }),
            OPERATION_TIMEOUT,
            'generateSingleAudio'
          ),
          'generateSingleAudio'
        );

        if (response.error) throw new Error(`Generation error: ${response.error}`);

        await fetchTasksForPolling();
      } catch (err: any) {
        setSingleAudioError(err.message || 'An error occurred during single audio generation');
        setSingleAudioState('error');
      }
    }
  };

  const handleSingleAudioDone = async () => {
    if (completingSingleAudio) return;
    setCompletingSingleAudio(true);
    try {
      if (!currentUserId) throw new Error('Authentication error');

      // Look up the task row(s) so we can also delete the audio file from
      // storage (db delete alone leaves the mp3 behind).
      if (singleAudioGroupId) {
        let storyTitle: string | null = null;
        let folderTimestamp: string | null = null;
        try {
          const { data: tasks } = await withRetry(
            () => withTimeout(
              supabase
                .from('audio_tasks')
                .select('story_title, folder_timestamp')
                .eq('user_id', currentUserId)
                .eq('group_id', singleAudioGroupId)
                .eq('tab', currentTab)
                .eq('single_audio', true)
                .limit(1),
              OPERATION_TIMEOUT,
              'lookupSingleAudioTask'
            ),
            'lookupSingleAudioTask'
          );
          if (tasks && tasks.length > 0) {
            storyTitle = tasks[0].story_title ?? null;
            folderTimestamp = tasks[0].folder_timestamp ?? null;
          }
        } catch (lookupErr: any) {
          console.warn(`Failed to look up single audio task for cleanup: ${lookupErr.message}`);
        }

        // Delete storage files for the single audio folder
        if (storyTitle && folderTimestamp) {
          const sanitizedTitle = sanitizeTitle(storyTitle);
          const folderPath = `documents/${currentUserId}/${singleAudioGroupId}/${sanitizedTitle}_${folderTimestamp}`;
          try {
            const { data: files, error: listError } = await withRetry(
              () => withTimeout(
                supabase.storage.from('stories').list(folderPath, { recursive: true }),
                OPERATION_TIMEOUT,
                'listSingleAudioFolder'
              ),
              'listSingleAudioFolder'
            );
            if (listError) {
              console.warn(`Failed to list single audio folder ${folderPath}: ${listError.message}`);
            } else if (files && files.length > 0) {
              const filePaths = files
                .filter((f) => f.name.endsWith('.mp3') || f.name.endsWith('.wav'))
                .map((f) => `${folderPath}/${f.name}`);
              if (filePaths.length > 0) {
                await safeDeleteStorageFiles(filePaths);
              }
            }
          } catch (storageErr: any) {
            console.warn(`Single audio storage cleanup failed: ${storageErr.message}`);
          }
        }

        // Delete the database record(s)
        await withRetry(
          () => withTimeout(
            supabase
              .from('audio_tasks')
              .delete()
              .eq('user_id', currentUserId)
              .eq('group_id', singleAudioGroupId)
              .eq('tab', currentTab)
              .eq('single_audio', true),
            OPERATION_TIMEOUT,
            'deleteSingleAudioTask'
          ),
          'deleteSingleAudioTask'
        );
      }

      // Clean up session clone voice if exists
      await cleanupSessionCloneVoice();

      // UPDATED: Clear VoiceSelector upload section
      clearVoiceSelectorUploadSection();

      // Update tab status to idle in DB and trigger TabManager refresh
      if (isEnterpriseUser && userId) {
        updateTabStatus(userId, 'audio', currentTab, 'idle').catch(() => {});
      }

      setSingleAudioState('idle');
      setSingleAudioText('');
      setSingleAudioUrl(null);
      setSingleAudioError(null);
      setSingleAudioGroupId(null);
      setCurrentGroupId(null); // Also clear currentGroupId
      setSelectedVoice(''); // Clear shared voice selection
      setSingleAudioVolume(1.0);
      setSingleAudioVolumeInput('1.0');
      setSingleAudioVolumeError('');
      setGeneratedGroupId(null);
      setGeneratedDocTitle('');
      setGeneratedAudio(null);
      setStatusMessage('');
      setProgress(0);
      setTimeRemaining(null);
      setOutputType('single');
      setAudioFilePath('');
      setCurrentTask(null);
      setTabRefreshTrigger(prev => prev + 1);
    } catch (err: any) {
      console.warn(`Failed to complete single audio cleanup: ${err.message}`);
      // Don't set error state, just reset to idle
      // Update tab status to idle in DB and trigger TabManager refresh
      if (isEnterpriseUser && userId) {
        updateTabStatus(userId, 'audio', currentTab, 'idle').catch(() => {});
      }
      setSingleAudioState('idle');
      setSingleAudioText('');
      setSingleAudioUrl(null);
      setSingleAudioError(null);
      setSingleAudioGroupId(null);
      setCurrentGroupId(null);
      setSelectedVoice('');
      setSingleAudioVolume(1.0);
      setSingleAudioVolumeInput('1.0');
      setSingleAudioVolumeError('');
      setGeneratedGroupId(null);
      setGeneratedDocTitle('');
      setGeneratedAudio(null);
      setStatusMessage('');
      setProgress(0);
      setTimeRemaining(null);
      setOutputType('single');
      setAudioFilePath('');
      setCurrentTask(null);
      setTabRefreshTrigger(prev => prev + 1);
    } finally {
      setCompletingSingleAudio(false);
    }
  };

  const handleDownloadSingleAudio = async () => {
    if (!singleAudioUrl && !generatedAudio) return;

    const audioUrl = singleAudioUrl || generatedAudio;
    if (!audioUrl) return;

    try {
      setDownloadingSingleAudio(true);

      if (outputType === 'single') {
        // Single file download
        const response = await fetch(audioUrl);
        if (!response.ok) throw new Error('Failed to fetch audio');
        const blob = await response.blob();
     
        // Determine file extension based on voice type - use type-aware voice checking
        let modelVersion: 'v7' | 'clone' | 'lemonfox' | 'speechify';
        if (isCoreVoice(selectedVoice)) {
          modelVersion = 'lemonfox';
        } else if (isPremiumVoice(selectedVoice)) {
          modelVersion = 'v7';
        } else if (isApexVoice(selectedVoice)) {
          modelVersion = 'speechify';
        } else if (isCloneVoice(selectedVoice)) {
          modelVersion = 'clone';
        } else {
          modelVersion = 'lemonfox';
        }
        const fileExtension = 'mp3';
     
        saveAs(blob, `single_audio.${fileExtension}`);
      } else {
        // Folder download - create ZIP (for multi-task single audio)
        await handleDownloadAudio();
      }
    } catch (err: any) {
      setSingleAudioError(`Failed to download audio: ${err.message}`);
      setSingleAudioState('error');
    } finally {
      setDownloadingSingleAudio(false);
    }
  };

  const handleDone = async () => {
    try {
      if (!currentUserId) throw new Error('Authentication error');

      // Only delete folder when stopping during generation (analyzing or generating states)
      if (generationState === 'analyzing' || generationState === 'generating') {
        if (currentGroupId) {
          // Get all tasks for this group to check for story_title and folder_timestamp (exclude video_process=true)
          let handleDoneQuery = supabase
            .from('audio_tasks')
            .select('story_title, folder_timestamp, batch_output')
            .eq('user_id', currentUserId)
            .eq('group_id', currentGroupId)
            .eq('tab', currentTab)
            .or('video_process.is.null,video_process.eq.false');

          if (currentVariant !== null) {
            handleDoneQuery = handleDoneQuery.eq('variant', currentVariant);
          }

          const { data: tasks, error: taskError } = await withRetry(
            () => withTimeout(
              handleDoneQuery,
              OPERATION_TIMEOUT,
              'fetchAudioTasksForDeletion'
            ),
            'fetchAudioTasksForDeletion'
          );

          if (tasks && tasks.length > 0 && !taskError) {
            // Use story_title and folder_timestamp to construct correct folder path
            const taskWithTimestamp = tasks.find(task => task.story_title && task.folder_timestamp);
          
            if (taskWithTimestamp && taskWithTimestamp.story_title && taskWithTimestamp.folder_timestamp) {
              // Sanitize title using same pattern as edge functions
              const sanitizedTitle = sanitizeTitle(taskWithTimestamp.story_title);
              // Construct folder path: documents/userId/groupId/sanitizedTitle_folderTimestamp
              const folderPath = `documents/${currentUserId}/${currentGroupId}/${sanitizedTitle}_${taskWithTimestamp.folder_timestamp}`;
              console.log(`[TextToSpeech] Attempting to delete folder: ${folderPath}`);

              try {
                // List all files in the folder
                const { data: files, error: listError } = await withRetry(
                  () => withTimeout(
                    supabase.storage.from('stories').list(folderPath, { recursive: true }),
                    OPERATION_TIMEOUT,
                    'listAudioFolderForDeletion'
                  ),
                  'listAudioFolderForDeletion'
                );

                if (listError) {
                  console.warn(`Failed to list audio folder for deletion: ${folderPath}: ${listError.message}`);
                } else if (files && files.length > 0) {
                  // Filter for audio files and create full paths
                  const filePaths = files
                    .filter(file => file.name.endsWith('.wav') || file.name.endsWith('.mp3'))
                    .map(file => `${folderPath}/${file.name}`);

                  if (filePaths.length > 0) {
                    await safeDeleteStorageFiles(filePaths);
                    console.log(`Deleted ${filePaths.length} audio files from folder: ${folderPath}`);
                  }
                }
              } catch (error: any) {
                console.warn(`Error during audio folder cleanup: ${error.message}`);
              }
            }
          }
        }
      }

      // Delete all audio tasks for the user and variant (non-single audio, exclude video_process=true)
      let handleDoneDeleteQuery = supabase
        .from('audio_tasks')
        .delete()
        .eq('user_id', currentUserId)
        .eq('tab', currentTab)
        .eq('single_audio', false)
        .or('video_process.is.null,video_process.eq.false');

      if (currentVariant !== null) {
        handleDoneDeleteQuery = handleDoneDeleteQuery.eq('variant', currentVariant);
      }

      await withRetry(
        () => withTimeout(
          handleDoneDeleteQuery,
          OPERATION_TIMEOUT,
          'deleteUserTasks'
        ),
        'deleteUserTasks'
      );

      // Clean up session clone voice if exists
      await cleanupSessionCloneVoice();

      // UPDATED: Clear VoiceSelector upload section
      clearVoiceSelectorUploadSection();

      // Update tab status to idle in DB and trigger TabManager refresh
      if (isEnterpriseUser && userId) {
        updateTabStatus(userId, 'audio', currentTab, 'idle').catch(() => {});
      }

      setGenerationState('idle');
      setError(null);
      setAnalysisResult(null);
      setProgress(0);
      setTimeRemaining(null);
      setStatusMessage('');
      setGeneratedFileName('');
      setGeneratedDocTitle('');
      setGeneratedGroupId(null);
      setCurrentGroupId(null);
      setCurrentVariant(null);
      setSelectedDoc('');
      setUploadedFile(null);
      setGeneratedAudio(null);
      setAudioTasks([]);
      setSelectedVoice('');
      setOutputType('single');
      setAudioFilePath('');
      setCurrentTask(null);
      setTabRefreshTrigger(prev => prev + 1);
    } catch (err: any) {
      console.warn(`Failed to complete cleanup: ${err.message}`);
      // Don't set error state, just reset to idle
      // Update tab status to idle in DB and trigger TabManager refresh
      if (isEnterpriseUser && userId) {
        updateTabStatus(userId, 'audio', currentTab, 'idle').catch(() => {});
      }
      setGenerationState('idle');
      setError(null);
      setAnalysisResult(null);
      setProgress(0);
      setTimeRemaining(null);
      setStatusMessage('');
      setGeneratedFileName('');
      setGeneratedDocTitle('');
      setGeneratedGroupId(null);
      setCurrentGroupId(null);
      setCurrentVariant(null);
      setSelectedDoc('');
      setUploadedFile(null);
      setGeneratedAudio(null);
      setAudioTasks([]);
      setSelectedVoice('');
      setOutputType('single');
      setAudioFilePath('');
      setCurrentTask(null);
      setTabRefreshTrigger(prev => prev + 1);
    }
  };

  const handleDownloadAudio = async () => {
    if (!generatedAudio) return;

    try {
      setDownloadingAudio(true);
   
      if (outputType === 'single') {
        // Single file download
        const response = await fetch(generatedAudio);
        if (!response.ok) throw new Error('Failed to fetch audio');
        const blob = await response.blob();
     
        const fileExtension = audioFilePath.split('.').pop()?.toLowerCase() || 'mp3';
        let fileName = generatedDocTitle;
     
        if (fileName.includes('.')) {
          fileName = fileName.substring(0, fileName.lastIndexOf('.'));
        }
        fileName = `${fileName}.${fileExtension}`;
     
        saveAs(blob, fileName);
      } else {
        // Folder download - create ZIP
        const folderPath = generatedAudio; // This is the folder path
     
        // List all files in the folder
        const { data: fileList, error: listError } = await supabase.storage
          .from('stories')
          .list(folderPath, {
            limit: 100,
            offset: 0
          });

        if (listError || !fileList) {
          throw new Error(`Failed to list files in folder: ${listError?.message || 'Unknown error'}`);
        }

        // Filter for audio files
        const audioFiles = fileList.filter(file =>
          file.name.endsWith('.mp3') || file.name.endsWith('.wav')
        );

        if (audioFiles.length === 0) {
          throw new Error('No audio files found in the folder');
        }

        // Create ZIP file
        const zip = new JSZip();
     
        // Download each file and add to ZIP
        for (const file of audioFiles) {
          const filePath = `${folderPath}/${file.name}`;
          const { data: fileData, error: downloadError } = await supabase.storage
            .from('stories')
            .download(filePath);

          if (downloadError) {
            console.error(`Failed to download ${file.name}:`, downloadError);
            continue; // Skip this file and continue with others
          }

          const arrayBuffer = await fileData.arrayBuffer();
          zip.file(file.name, arrayBuffer);
        }

        // Generate and download ZIP
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const zipFileName = `${generatedDocTitle.replace(/[^a-zA-Z0-9\s-]/g, '')}_audio_files.zip`;
        saveAs(zipBlob, zipFileName);
      }
    } catch (err: any) {
      console.error('Download error:', err);
      setError(`Failed to download audio: ${err.message}`);
    } finally {
      setDownloadingAudio(false);
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Clear previous analysis data
    setGenerationState('idle');
    setAnalysisResult(null);
    setProgress(0);
    setStatusMessage('');
    setTimeRemaining(null);
    setGeneratedFileName('');
    setGeneratedDocTitle('');
    setGeneratedGroupId(null);
    setCurrentGroupId(null);
    setGeneratedAudio(null);
    setAudioTasks([]);
    setError(null);

    // Validate file type
    if (file.type !== 'text/plain' && !file.name.endsWith('.txt')) {
      setError('Please upload a valid .txt file');
      return;
    }

    // Validate file name for invalid characters
    const fileNameError = validateFileName(file.name);
    if (fileNameError) {
      setError(fileNameError);
      return;
    }

    // Validate file size
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
    const uniqueGroupId = uuidv4();

    // Generate file path with unique group_id
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${file.name.replace(/\s+/g, '-')}_${timestamp}.txt`;
    const filePath = `documents/${currentUserId}/${uniqueGroupId}/${fileName}`;

    try {
      // Upload file to Supabase storage with retry
      const { error: uploadError } = await withRetry(
        () => withTimeout(
          supabase.storage
            .from('stories')
            .upload(filePath, file, {
              contentType: 'text/plain',
              upsert: true,
            }),
          OPERATION_TIMEOUT,
          'uploadFile'
        ),
        'uploadFile'
      );

      if (uploadError) {
        throw new Error(`Failed to upload file: ${uploadError.message}`);
      }

      // Insert document metadata into story_documents with retry
      const { data, error: insertError } = await withRetry(
        () => withTimeout(
          supabase
            .from('story_documents')
            .insert({
              id: uuidv4(),
              user_id: currentUserId,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              file_path: filePath,
              title: file.name.replace(/\.txt$/, ''),
              description: 'Uploaded document for text-to-speech conversion',
              word_count: wordCount,
              version: 1,
              is_corrected: false,
              is_prompted: false,
              group_id: uniqueGroupId,
              variant: 1,
              file_size: file.size,
            })
            .select()
            .single(),
          OPERATION_TIMEOUT,
          'insertDocument'
        ),
        'insertDocument'
      );

      if (insertError) {
        // Cleanup: remove uploaded file if metadata insertion fails
        await withRetry(
          () => withTimeout(
            supabase.storage.from('stories').remove([filePath]),
            OPERATION_TIMEOUT,
            'removeFile'
          ),
          'removeFile'
        );
        throw new Error(`Failed to save document metadata: ${insertError.message}`);
      }

      // Update state
      setUploadedFile(file);
      setSelectedDoc('');

      // Refresh documents list with retry
      const { data: updatedDocs, error: fetchError } = await withRetry(
        () => withTimeout(
          supabase
            .from('story_documents')
            .select('*')
            .eq('user_id', currentUserId)
            .in('version', [1, 2])
            .order('created_at', { ascending: false }),
          OPERATION_TIMEOUT,
          'fetchDocuments'
        ),
        'fetchDocuments'
      );

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

  const handlePlayVoiceSample = (voice: string) => {
    if (playingVoice === voice) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      setPlayingVoice(null);
      return;
    }

    // This would need to be updated to work with VoiceSelector's sample URLs
    // For now, we'll pass this through to VoiceSelector
    setPlayingVoice(voice);
  };

  // CHANGED: Handle voice selection without validation (VoiceSelector handles it)
  const handleVoiceSelect = (voice: string) => {
    setSelectedVoice(voice);
    
    // Clear any previous voice-related errors
    setError(null);
    
    // Track session clone voice when selected
    if (voice.includes('clone:') && voice !== selectedVoice) {
      const voiceName = voice.split(':')[1];
      const predefinedVoice = predefinedCloneVoices.find(v => v.name === voiceName);
      if (!predefinedVoice && sessionCloneVoiceId && sessionCloneVoiceId.endsWith(`__${voiceName}`)) {
        console.log(`Selected session clone voice: ${voiceName}`);
      }
    }
  };

  // Check if analyze button should be disabled
  const isAnalyzeDisabled = () => {
    return (
      generationState !== 'idle' ||
      (!selectedDoc && !uploadedFile) ||
      !selectedVoice ||
      speedError !== '' ||
      volumeError !== '' ||
      singleAudioState !== 'idle'
    );
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent"></div>
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
          {userPlan === 'free' && (
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-12 z-50">
              <div className="rounded-2xl bg-surface-card border border-border-card p-8 max-w-md w-full shadow-[0_0_40px_rgba(220,38,38,0.08)]">
                <div className="flex items-center gap-3 mb-3">
                  <div className="pipeline-icon-circle inline-flex items-center justify-center w-10 h-10 rounded-full bg-accent/5">
                    <Lock className="h-5 w-5 text-accent-text" />
                  </div>
                  <h2 className="text-lg sm:text-xl font-display font-semibold text-white">Paid Feature</h2>
                </div>
                <p className="text-sm text-text-muted mb-6 leading-relaxed">Text-to-Speech requires a paid plan. Upgrade to unlock audio generation, voice cloning, and more.</p>
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
          <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Text-to-Speech</h1>
          <div className="mt-2">
            <p className="text-text-secondary">Convert your story scripts into professional audio</p>
            <p className="text-text-muted text-sm mt-1">{formatNumber(userTokenBalance)} tokens remaining</p>
            <p className="text-text-muted text-sm mt-0.5">Storage: {storageUsed !== null ? `${formatStorageSize(storageUsed)} / ${maxStorageGB} GB` : 'Calculating...'}</p>
          </div>

          {/* What to Expect info box */}
          <div className="mt-5 p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card dash-animate-in">
            <div>
              <h3 className="text-xl font-semibold mb-2 text-accent">What to Expect</h3>
              <p className="text-[15px] text-white/80 leading-relaxed">
                Convert your story scripts into high-quality audio, integrating seamlessly with the video production process.
                Select a voice and in about 2–4 hours you'll have an audio track ready for a video up to 20 hours long — ideal for effortless YouTube uploads.
              </p>
              <Link
                to="/learn#text-to-speech"
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
                  Choose a voice tier below — <strong className="text-white/70">Core</strong> for budget-friendly generation, <strong className="text-white/70">Premium &amp; Apex</strong> for ultra-realistic narration, or <strong className="text-white/70">Clone</strong> to use your own voice.
                </p>
              </div>
            </div>
          </div>

          {/* Tab Manager for Premium Users (Elite, Ultimate, Enterprise) */}
          {isEnterpriseUser && userId && (
            <TabManager
              userId={userId}
              isEnterpriseUser={isEnterpriseUser}
              currentTab={currentTab}
              page="audio"
              initialTabs={initialTabs}
              refreshTrigger={tabRefreshTrigger}
              onTabChange={onTabChange}
              onTabCreate={onTabCreate}
              onTabClose={onTabClose}
            />
          )}
        </div>

        {/* Blue progress box while generating */}
        {(generationState === 'analyzing' || generationState === 'generating') && (
          <div className="mt-4 p-5 rounded-2xl bg-[--color-status-info-bg] border border-[--color-status-info-border] mb-6 dash-animate-in">
            <div className="flex items-center space-x-3">
              <div className="flex-shrink-0 h-10 w-10 rounded-full bg-[--color-status-info-bg] flex items-center justify-center">
                <RefreshCw className="h-5 w-5 text-status-info animate-spin" />
              </div>
              <div>
                <h3 className="text-lg font-display font-semibold text-status-info">
                  {generatedDocTitle || 'Your audio'}
                </h3>
                <p className="text-sm mt-0.5" style={{ color: 'rgba(96, 165, 250, 0.7)' }}>
                  {statusMessage} &middot; {Math.round(progress)}% complete
                  {timeRemaining !== null && ` · ${formatTime(timeRemaining)} remaining`}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Completion Notice */}
        {(generationState === 'complete' || singleAudioState === 'complete') && (
          <div className="mt-4 p-5 rounded-2xl bg-[--color-status-success-bg] border border-[--color-status-success-border] mb-6 dash-animate-in">
            <div className="flex items-center space-x-3">
              <div className="flex-shrink-0 h-10 w-10 rounded-full bg-[--color-status-success-bg] flex items-center justify-center">
                <CheckCircle2 className="h-6 w-6 text-status-success" />
              </div>
              <div>
                <h3 className="text-lg font-display font-semibold text-status-success">
                  {generatedDocTitle || 'Your audio'} is done generating!
                </h3>
                <p className="text-sm mt-0.5" style={{ color: 'rgba(74, 222, 128, 0.7)' }}>
                  Ready for download or further processing.
                </p>
              </div>
            </div>
          </div>
        )}

        <div
          className="dash-collapse-grid"
          data-collapsed={settingsCollapsed ? 'true' : 'false'}
        >
          <div>
        {/* Mode Selection */}
        <div className="mt-8 mb-6 dash-animate-in">
          <h2 className="text-xl font-semibold text-white mb-4">Mode</h2>
          <div className="grid grid-cols-2 gap-4">
            <button
              onClick={() => setMode('document')}
              disabled={generationState !== 'idle' || singleAudioState !== 'idle'}
              className={`p-4 rounded-xl border-2 transition-all text-left ${
                mode === 'document'
                  ? 'border-red-800/70 bg-red-900/30'
                  : 'border-border-card bg-surface-card hover:border-white/20'
              } ${(generationState !== 'idle' || singleAudioState !== 'idle') ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <div className="font-medium text-white text-sm sm:text-base">Existing Document</div>
              <div className="text-xs sm:text-sm text-text-muted mt-1">
                Convert story documents to audio
              </div>
            </button>

            <button
              onClick={() => setMode('individual')}
              disabled={generationState !== 'idle' || singleAudioState !== 'idle'}
              className={`p-4 rounded-xl border-2 transition-all text-left ${
                mode === 'individual'
                  ? 'border-red-800/70 bg-red-900/30'
                  : 'border-border-card bg-surface-card hover:border-white/20'
              } ${(generationState !== 'idle' || singleAudioState !== 'idle') ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <div className="font-medium text-white text-sm sm:text-base">Individual Audio</div>
              <div className="text-xs sm:text-sm text-text-muted mt-1">
                Generate audio from text input
              </div>
            </button>
          </div>
        </div>

        {mode === 'document' && (
          <>
            {/* Select or Upload Story Document */}
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-white mb-2">Select or Upload Story Document</h2>
              <p className="text-text-secondary mb-4">
                Select one of your Story Documents or upload a .txt file to convert to speech.
              </p>

              {documents.length === 0 ? (
                <p className="text-text-muted">You Have No Story Documents</p>
              ) : (
                <Listbox
                  value={selectedDoc}
                  onChange={(value) => {
                    setSelectedDoc(value);
                    setUploadedFile(null);
                    setAnalysisResult(null);
                    setGenerationState('idle');
                  }}
                  disabled={generationState !== 'idle' || uploadedFile !== null || singleAudioState !== 'idle'}
                >
                  {({ open }) => (
                    <div className="relative">
                      <Listbox.Button className={`relative w-full rounded-xl bg-surface-input border border-white/[0.13] px-5 py-4 text-left text-white/95 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 shadow-sm transition-all duration-200 ${generationState !== 'idle' || uploadedFile !== null || singleAudioState !== 'idle' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
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
                              `relative cursor-pointer select-none py-3 px-4 flex justify-between items-center ${active ? 'bg-white/[0.08] text-white' : 'text-white/90'} ${selected ? 'font-medium' : 'font-normal'}`
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

                          {documents.map((doc) => (
                            <Listbox.Option
                              key={doc.id}
                              value={doc.id}
                              className={({ active, selected }) =>
                                `relative cursor-pointer select-none py-3 px-4 flex justify-between items-center ${active ? 'bg-white/[0.08] text-white' : 'text-white/90'} ${selected ? 'font-medium' : 'font-normal'}`
                              }
                            >
                              {({ selected }) => (
                                <>
                                  <div className="flex flex-col">
                                    <span className={selected ? 'font-medium' : 'font-normal'}>{doc.title}</span>
                                    <span className="text-sm text-text-muted flex items-center mt-0.5">
                                      <Calendar className="h-4 w-4 mr-1" />
                                      {formatDate(doc.created_at)} &bull; {doc.word_count || 0} words
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

              <div className="relative mt-4">
                <div className="flex items-center justify-center w-full">
                  <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-white/10 border-dashed rounded-xl cursor-pointer bg-surface-input hover:bg-white/5 transition-colors">
                    <div className="flex flex-col items-center justify-center pt-5 pb-6">
                      <Upload className="w-8 h-8 mb-3 text-text-muted" />
                      <p className="mb-2 text-sm text-text-secondary">
                        <span className="font-semibold">Click to upload</span> or drag and drop
                      </p>
                      <p className="text-xs text-text-muted">TXT files only (max 1MB)</p>
                    </div>
                    <input
                      type="file"
                      className="hidden"
                      accept=".txt"
                      onChange={handleFileUpload}
                      disabled={generationState !== 'idle' || selectedDoc !== '' || singleAudioState !== 'idle'}
                    />
                  </label>
                </div>
                {uploadedFile && (
                  <div className="mt-2 flex items-center justify-between bg-surface-input border border-white/10 p-3 rounded-xl">
                    <span className="text-sm text-text-secondary">{uploadedFile.name}</span>
                    <button
                      onClick={() => setUploadedFile(null)}
                      className={`text-text-muted hover:text-white ${generationState !== 'idle' || singleAudioState !== 'idle' ? 'opacity-50 cursor-not-allowed' : ''}`}
                      disabled={generationState !== 'idle' || singleAudioState !== 'idle'}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Voice Selection */}
            <VoiceSelector
              ref={voiceSelectorRef}
              selectedVoice={selectedVoice}
              onVoiceSelect={handleVoiceSelect}
              playingVoice={playingVoice}
              onPlaySample={handlePlayVoiceSample}
              disabled={generationState !== 'idle' || singleAudioState !== 'idle'}
              userPlan={userPlan}
              userId={currentUserId || ''}
              onCloneVoiceCreated={(voiceId, filePath) => {
                setSessionCloneVoiceId(voiceId);
                setSessionCloneVoiceFilePath(filePath);
              }}
              pauseRestricted={documents.find(d => d.id === selectedDoc)?.pauses === true}
              elevenLabsCurrentVoiceId={elevenLabsVoice?.voice_id}
              elevenLabsModelId={elevenLabsModelId}
              elevenLabsSelectedLabel={
                selectedVoice.startsWith('elevenlabs:') && elevenLabsVoice
                  ? elevenLabsVoice.name
                  : null
              }
              onSelectElevenLabsVoice={(v) => {
                setElevenLabsVoice(v);
                setElevenLabsModelId(v.model_id);
                setSelectedVoice(`elevenlabs:${v.voice_id}`);
              }}
              onElevenLabsModelChange={setElevenLabsModelId}
            />

            {/* Settings */}
            <div className="mt-8 mb-6 rounded-2xl border border-border-card bg-surface-card/40 p-5">
              <h3 className="text-[10px] font-mono tracking-[0.15em] uppercase text-text-muted mb-4">Audio Settings</h3>

              <div className="space-y-5">
                {/* Speed Control */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-white">Speech Speed</label>
                    <input
                      type="text"
                      value={speedInput}
                      onChange={(e) => handleSpeedInputChange(e.target.value)}
                      className={`w-16 px-2 py-0.5 bg-surface-input border rounded-lg text-white text-xs text-center focus:outline-none focus:ring-1 ${
                        speedError ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-accent'
                      }`}
                      placeholder="0.8"
                    />
                  </div>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-lg font-semibold text-white tabular-nums">{speed.toFixed(2)}x</span>
                    <span className="text-xs text-text-muted">
                      {speed < 0.5 ? 'Very Slow' : speed < 0.75 ? 'Slow' : speed < 1.1 ? 'Normal' : speed < 1.4 ? 'Fast' : 'Very Fast'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.01"
                    value={speed}
                    onChange={(e) => {
                      const value = parseFloat(e.target.value);
                      setSpeed(value);
                      setSpeedInput(value.toString());
                      setSpeedError('');
                    }}
                    className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer slider"
                  />
                  <div className="flex justify-between text-[10px] text-text-muted mt-1">
                    <span>0.5x</span>
                    <span>1.0x</span>
                    <span>1.5x</span>
                    <span>2.0x</span>
                  </div>
                  {speedError && (
                    <p className="mt-1 text-xs text-red-400">{speedError}</p>
                  )}
                </div>

                {/* Volume Control */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-white">Audio Volume</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={volumeInput}
                        onChange={(e) => handleVolumeInputChange(e.target.value)}
                        className={`w-16 px-2 py-0.5 bg-surface-input border rounded-lg text-white text-xs text-center focus:outline-none focus:ring-1 ${
                          volumeError ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-accent'
                        }`}
                        placeholder="1.0"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-lg font-semibold text-white tabular-nums">{Math.round(volume * 100)}%</span>
                    <span className="text-xs text-text-muted">
                      {volume <= 1.0 ? 'Default' : volume <= 2.0 ? 'Boosted' : volume <= 4.0 ? 'Loud' : 'Max Boost'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1.0"
                    max="8.0"
                    step="0.01"
                    value={volume}
                    onChange={(e) => {
                      const value = parseFloat(e.target.value);
                      setVolume(value);
                      setVolumeInput(value.toString());
                      setVolumeError('');
                    }}
                    className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer slider"
                  />
                  <div className="flex justify-between text-[10px] text-text-muted mt-1">
                    <span>100%</span>
                    <span>300%</span>
                    <span>500%</span>
                    <span>800%</span>
                  </div>
                  {volumeError && (
                    <p className="mt-1 text-xs text-red-400">{volumeError}</p>
                  )}
                </div>
              </div>

              {/* Volume cost note */}
              <p className="mt-3 text-sm text-text-muted">
                Volume above 100% costs 100 extra tokens for audio enhancement.
              </p>

              {/* File splitting info box */}
              <div className="mt-3 flex items-start gap-2.5 rounded-xl bg-black/60 border border-white/10 px-4 py-3">
                <Info className="h-4 w-4 text-text-muted shrink-0 mt-0.5" />
                <p className="text-sm text-text-muted">
                  Audio files are split into segments (max 70MB) for compatibility with platforms like Canva.
                </p>
              </div>
            </div>

            {/* Analyze Button and Results */}
            {(generationState === 'idle' || generationState === 'analyzed') && (
              <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-5 mb-6">
                <button
                  onClick={handleAnalyze}
                  disabled={isAnalyzeDisabled()}
                  className="w-full flex justify-center items-center px-4 py-3 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
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
              </div>
            )}

            {(generationState === 'analyzed' && analysisResult) && (
              <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-5 mb-6">
                <h2 className="text-xl font-semibold text-white mb-4">Analysis Estimate</h2>
                <div className="space-y-4">
                  <div className="rounded-xl bg-surface-input p-4 space-y-1">
                    <p className="text-sm text-text-secondary">Total Characters: {formatNumber(analysisResult.totalCharacters)}</p>
                    <p className="text-sm text-text-secondary">Word Count: {formatNumber(analysisResult.wordCount)}</p>
                    <p className="text-sm text-text-secondary">Base Token Usage: {formatNumber(analysisResult.estimatedTokens - (analysisResult.volumeBoost || 0))} tokens</p>
                    {analysisResult.volumeBoost && analysisResult.volumeBoost > 0 && (
                      <p className="text-sm text-text-secondary">Volume Boost: {formatNumber(analysisResult.volumeBoost)} tokens</p>
                    )}
                    <p className="text-sm text-text-secondary">Total Token Usage: {formatNumber(analysisResult.estimatedTokens)} tokens</p>
                    <p className="text-sm text-text-secondary">Estimated Audio Duration: {Math.ceil(analysisResult.totalCharacters / 1000)} minutes</p>
                    <p className="text-sm text-text-secondary">Required Storage: {formatStorageSize(analysisResult.estimatedFileSizeMB)}</p>
              
                    {analysisResult.estimatedTokens > userTokenBalance && (
                      <div className="mt-3 bg-[--color-status-error-bg] border border-[--color-status-error-border] text-status-error p-3 rounded-xl">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="h-5 w-5" />
                          <p className="text-sm">
                            You don't have enough tokens. Required: {formatNumber(analysisResult.estimatedTokens)} tokens, Available: {formatNumber(userTokenBalance)}
                          </p>
                        </div>
                      </div>
                    )}
              
                    {storageUsed !== null && analysisResult.estimatedFileSizeMB > ((maxStorageGB * 1024) - storageUsed) && (
                      <div className="mt-3 bg-[--color-status-error-bg] border border-[--color-status-error-border] text-status-error p-3 rounded-xl">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="h-5 w-5" />
                          <p className="text-sm">
                            You don't have enough storage space. Required: {formatStorageSize(analysisResult.estimatedFileSizeMB)}, Available: {formatStorageSize((maxStorageGB * 1024) - storageUsed)}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex justify-end space-x-4">
                    <button
                      onClick={handleDone}
                      className="flex items-center px-4 py-2.5 bg-white/10 text-white rounded-xl hover:bg-white/15 transition-colors"
                    >
                      <X className="h-5 w-5 mr-2" />
                      Cancel
                    </button>
                    <button
                      onClick={handleContinue}
                      className="flex items-center px-4 py-2.5 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                      disabled={
                        analysisResult.estimatedTokens > userTokenBalance ||
                        (storageUsed !== null && analysisResult.estimatedFileSizeMB > ((maxStorageGB * 1024) - storageUsed))
                      }
                    >
                      <CheckCircle2 className="h-5 w-5 mr-2" />
                      Continue
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {mode === 'individual' && (
          <div className="space-y-6">
            <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-5">
              <h2 className="text-xl font-semibold text-white mb-4">Individual Audio Generation</h2>
              <p className="text-text-secondary mb-6">
                Generate audio from your own text input. Perfect for quick audio snippets or testing different voices. Text under 1,200 characters processes in 1-3 minutes, while larger text (up to 700,000 characters) uses the full document processing pipeline.
              </p>

              {/* Text Input */}
              <div className="mb-6">
                <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                  Text to Speech
                </label>
                <textarea
                  value={singleAudioText}
                  onChange={(e) => {
                    setSingleAudioText(e.target.value.slice(0, 700000));
                    setSingleAudioError(null);
                  }}
                  placeholder="Enter your text here... (up to 700,000 characters)"
                  className="w-full bg-surface-input text-white rounded-xl p-3 mb-2 focus:outline-none focus:ring-2 focus:ring-accent resize-none border border-white/[0.13]"
                  rows={10}
                  disabled={singleAudioState !== 'idle'}
                />
                <div className="flex justify-between text-xs text-text-muted">
                  <span>{singleAudioText.length}/700,000 characters</span>
                  <div className="flex space-x-4">
                    {singleAudioText.length > 0 && (
                      <span>~{Math.ceil(singleAudioText.length / 1000)} minutes</span>
                    )}
                    {singleAudioText.length > 1200 && (
                      <span className="text-orange-400">Large text - document processing (2-4 hours)</span>
                    )}
                    {singleAudioText.length <= 1200 && singleAudioText.length > 0 && (
                      <span className="text-green-400">Fast processing (1-3 minutes)</span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Voice Selection for Individual Audio */}
            <VoiceSelector
              ref={voiceSelectorRef}
              selectedVoice={selectedVoice}
              onVoiceSelect={handleVoiceSelect}
              playingVoice={playingVoice}
              onPlaySample={handlePlayVoiceSample}
              disabled={singleAudioState !== 'idle'}
              userPlan={userPlan}
              userId={currentUserId || ''}
              onCloneVoiceCreated={(voiceId, filePath) => {
                setSessionCloneVoiceId(voiceId);
                setSessionCloneVoiceFilePath(filePath);
              }}
              elevenLabsCurrentVoiceId={elevenLabsVoice?.voice_id}
              elevenLabsModelId={elevenLabsModelId}
              elevenLabsSelectedLabel={
                selectedVoice.startsWith('elevenlabs:') && elevenLabsVoice
                  ? elevenLabsVoice.name
                  : null
              }
              onSelectElevenLabsVoice={(v) => {
                setElevenLabsVoice(v);
                setElevenLabsModelId(v.model_id);
                setSelectedVoice(`elevenlabs:${v.voice_id}`);
              }}
              onElevenLabsModelChange={setElevenLabsModelId}
            />

            {/* Settings for Individual Audio */}
            <div className="mt-8 mb-6 rounded-2xl border border-border-card bg-surface-card/40 p-5">
              <h3 className="text-[10px] font-mono tracking-[0.15em] uppercase text-text-muted mb-4">Audio Settings</h3>

              <div className="space-y-5">
                {/* Speed Control */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-white">Speech Speed</label>
                    <input
                      type="text"
                      value={singleAudioSpeedInput}
                      onChange={(e) => handleSingleAudioSpeedInputChange(e.target.value)}
                      className={`w-16 px-2 py-0.5 bg-surface-input border rounded-lg text-white text-xs text-center focus:outline-none focus:ring-1 ${
                        singleAudioSpeedError ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-accent'
                      }`}
                      placeholder="0.8"
                      disabled={singleAudioState !== 'idle'}
                    />
                  </div>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-lg font-semibold text-white tabular-nums">{singleAudioSpeed.toFixed(2)}x</span>
                    <span className="text-xs text-text-muted">
                      {singleAudioSpeed < 0.5 ? 'Very Slow' : singleAudioSpeed < 0.75 ? 'Slow' : singleAudioSpeed < 1.1 ? 'Normal' : singleAudioSpeed < 1.4 ? 'Fast' : 'Very Fast'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.01"
                    value={singleAudioSpeed}
                    onChange={(e) => {
                      const value = parseFloat(e.target.value);
                      setSingleAudioSpeed(value);
                      setSingleAudioSpeedInput(value.toString());
                      setSingleAudioSpeedError('');
                    }}
                    className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer slider"
                    disabled={singleAudioState !== 'idle'}
                  />
                  <div className="flex justify-between text-[10px] text-text-muted mt-1">
                    <span>0.5x</span>
                    <span>1.0x</span>
                    <span>1.5x</span>
                    <span>2.0x</span>
                  </div>
                  {singleAudioSpeedError && (
                    <p className="mt-1 text-xs text-red-400">{singleAudioSpeedError}</p>
                  )}
                </div>

                {/* Volume Control */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-white">Audio Volume</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={singleAudioVolumeInput}
                        onChange={(e) => handleSingleAudioVolumeInputChange(e.target.value)}
                        className={`w-16 px-2 py-0.5 bg-surface-input border rounded-lg text-white text-xs text-center focus:outline-none focus:ring-1 ${
                          singleAudioVolumeError ? 'border-red-500 focus:ring-red-500' : 'border-white/10 focus:ring-accent'
                        }`}
                        placeholder="1.0"
                        disabled={singleAudioState !== 'idle'}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-lg font-semibold text-white tabular-nums">{Math.round(singleAudioVolume * 100)}%</span>
                    <span className="text-xs text-text-muted">
                      {singleAudioVolume <= 1.0 ? 'Default' : singleAudioVolume <= 2.0 ? 'Boosted' : singleAudioVolume <= 4.0 ? 'Loud' : 'Max Boost'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1.0"
                    max="8.0"
                    step="0.01"
                    value={singleAudioVolume}
                    onChange={(e) => {
                      const value = parseFloat(e.target.value);
                      setSingleAudioVolume(value);
                      setSingleAudioVolumeInput(value.toString());
                      setSingleAudioVolumeError('');
                    }}
                    className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer slider"
                    disabled={singleAudioState !== 'idle'}
                  />
                  <div className="flex justify-between text-[10px] text-text-muted mt-1">
                    <span>100%</span>
                    <span>300%</span>
                    <span>500%</span>
                    <span>800%</span>
                  </div>
                  {singleAudioVolumeError && (
                    <p className="mt-1 text-xs text-red-400">{singleAudioVolumeError}</p>
                  )}
                </div>
              </div>

              <p className="mt-4 text-[11px] text-text-muted">
                Volume above 100% costs 100 extra tokens for audio enhancement.
              </p>
            </div>

            {/* Token Estimate */}
            {singleAudioText.length > 0 && selectedVoice && (
              <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-5">
                <h3 className="text-white font-medium mb-2">Estimate</h3>
                <div className="text-sm text-text-secondary space-y-1">
                  <p>Characters: {singleAudioText.length}</p>
                  <p>Base Tokens: {formatNumber(singleAudioText.length * tokensPerCharForSelectedVoice(selectedVoice))}</p>
                  {singleAudioVolume > 1.0 && (
                    <p>Volume Boost: 100 tokens</p>
                  )}
                  <p className="font-medium text-white">Total Required: {formatNumber(
                    singleAudioText.length * tokensPerCharForSelectedVoice(selectedVoice) + 
                    (singleAudioVolume > 1.0 ? 100 : 0)
                  )} tokens</p>
                  <p>Available Tokens: {formatNumber(userTokenBalance)}</p>
                </div>
              </div>
            )}

            {/* Error Messages */}
            {singleAudioText.length > 0 && selectedVoice && (
              <>
                {(singleAudioText.length * tokensPerCharForSelectedVoice(selectedVoice) + (singleAudioVolume > 1.0 ? 100 : 0)) > userTokenBalance && (
                  <div className="bg-[--color-status-error-bg] border border-[--color-status-error-border] text-status-error p-3 rounded-xl">
                    <div className="flex items-center gap-2">
                      <AlertCircle className="h-5 w-5" />
                      <p className="text-sm">
                        Insufficient tokens. Required: {formatNumber(singleAudioText.length * tokensPerCharForSelectedVoice(selectedVoice) + (singleAudioVolume > 1.0 ? 100 : 0))}, Available: {formatNumber(userTokenBalance)}
                      </p>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Generate Button */}
            <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-5">
              <div className="flex justify-end">
                <button
                  onClick={handleSingleAudioGenerate}
                  className="flex items-center px-5 py-2.5 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                  disabled={
                    !singleAudioText ||
                    singleAudioText.trim() === '' ||
                    !selectedVoice ||
                    singleAudioState !== 'idle' ||
                    singleAudioSpeedError !== '' ||
                    singleAudioVolumeError !== '' ||
                    (singleAudioText.length > 0 && selectedVoice && (singleAudioText.length * tokensPerCharForSelectedVoice(selectedVoice) + (singleAudioVolume > 1.0 ? 100 : 0)) > userTokenBalance)
                  }
                >
                  <Volume2 className="h-5 w-5 mr-2" />
                  Generate
                </button>
              </div>
            </div>
          </div>
        )}
          </div>
        </div>

        {mode === 'individual' && (
          <div className="space-y-6">
            {/* Individual Audio Generation States */}
            {(singleAudioState === 'generating' || singleAudioState === 'complete' || singleAudioState === 'error') && (
              <div className="space-y-6">
                {singleAudioState === 'generating' && (
                  <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-5 space-y-4">
                    {singleAudioText.length > 1200 ? (
                      // Large text processing - show document-style progress
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
                          <p className="text-sm text-text-muted">
                            Estimated time remaining: {formatTime(timeRemaining)}
                          </p>
                        )}
                        {currentTask && currentTask.check_stuck === true && (
                          <p className="text-sm text-yellow-400">
                            This part may take a little longer, but the progress is moving forward.
                          </p>
                        )}
                      </>
                    ) : (
                      // Small text processing - show simple spinner
                      <>
                        <div className="flex items-center justify-center min-h-[100px]">
                          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent"></div>
                        </div>
                        <div className="text-center space-y-2">
                          <p className="text-text-secondary">Generating audio...</p>
                          <p className="text-sm text-text-muted">This could take 1–3 minutes.</p>
                        </div>
                      </>
                    )}
                    <div className="flex justify-end">
                      <button
                        onClick={handleSingleAudioDone}
                        disabled={completingSingleAudio}
                        className={`flex items-center px-4 py-2.5 rounded-xl transition-colors ${
                          completingSingleAudio
                            ? 'bg-accent/60 text-white/70 cursor-not-allowed'
                            : 'bg-accent text-white hover:bg-accent-hover'
                        }`}
                      >
                        {completingSingleAudio ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white/70 mr-2"></div>
                            Stopping...
                          </>
                        ) : (
                          <>
                            <X className="h-5 w-5 mr-2" />
                            Stop
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {singleAudioState === 'complete' && (singleAudioUrl || generatedAudio) && (
                  <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-[--color-status-success-border] p-5">
                    <div className="flex justify-between items-center mb-3">
                      <h3 className="text-lg font-medium text-status-success">{generatedDocTitle || 'Audio Outputs: Individual Audio Text'}</h3>
                      <div className="flex space-x-4">
                        <button
                          onClick={handleDownloadSingleAudio}
                          className={`flex items-center px-3 py-1.5 rounded-xl transition-colors ${
                            downloadingSingleAudio
                              ? 'bg-white/10 text-white/40 cursor-not-allowed'
                              : 'bg-status-success text-white hover:opacity-90'
                          }`}
                          disabled={downloadingSingleAudio}
                        >
                          {downloadingSingleAudio ? (
                            <>
                              <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white/50 mr-2"></div>
                              Downloading...
                            </>
                          ) : (
                            <>
                              <Download className="h-4 w-4 mr-2" />
                              Download {outputType === 'folder' ? 'ZIP' : ''}
                            </>
                          )}
                        </button>
                        <button
                          onClick={handleSingleAudioDone}
                          disabled={completingSingleAudio}
                          className={`flex items-center px-3 py-1.5 rounded-xl transition-colors ${
                            completingSingleAudio
                              ? 'bg-status-success/60 text-white/70 cursor-not-allowed'
                              : 'bg-status-success text-white hover:opacity-90'
                          }`}
                        >
                          {completingSingleAudio ? (
                            <>
                              <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white/70 mr-2"></div>
                              Cleaning up...
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="h-4 w-4 mr-2" />
                              Done
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                    {outputType === 'single' && (singleAudioUrl || generatedAudio) ? (
                      <AudioPlayer
                        src={singleAudioUrl || generatedAudio!}
                        title={generatedDocTitle || 'Audio Outputs: Individual Audio Text'}
                        filePath=""
                        onError={() => {}} // Suppress audio player errors
                      />
                    ) : outputType === 'folder' ? (
                      <div className="rounded-xl bg-surface-input p-4 text-center">
                        <p className="text-text-secondary mb-2">Multiple audio files ready for download</p>
                        <p className="text-sm text-text-muted">Click Download ZIP to get all files</p>
                      </div>
                    ) : (
                      <div className="flex justify-center items-center h-20">
                        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-accent"></div>
                      </div>
                    )}
                  </div>
                )}

                {singleAudioState === 'error' && singleAudioError && (
                  <div className="rounded-2xl bg-status-error border border-status-error-border p-5">
                    <div className="flex items-center space-x-2 text-status-error mb-2">
                      <AlertCircle className="h-5 w-5" />
                      <h3 className="text-lg font-medium">Error</h3>
                    </div>
                    <p className="text-status-error-muted">{singleAudioError}</p>
                    <div className="flex justify-end mt-4">
                      <button
                        onClick={handleSingleAudioDone}
                        disabled={completingSingleAudio}
                        className={`flex items-center px-4 py-2.5 rounded-xl transition-colors ${
                          completingSingleAudio
                            ? 'bg-accent/60 text-white/70 cursor-not-allowed'
                            : 'bg-accent text-white hover:bg-accent-hover'
                        }`}
                      >
                        {completingSingleAudio ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white/70 mr-2"></div>
                            Clearing...
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
              </div>
            )}
          </div>
        )}

        {networkRetrying && (
          <div className="rounded-2xl bg-[rgba(161,98,7,0.15)] border border-[rgba(234,179,8,0.3)] text-yellow-200 p-5 mb-6">
            <div className="flex items-center space-x-2 text-yellow-400 mb-2">
              <RefreshCw className="h-5 w-5 animate-spin" />
              <h3 className="text-lg font-medium">Network Issue</h3>
            </div>
            <p className="text-yellow-200/80">Attempting to reconnect to the server. Your generation is still processing in the background. Reload page to see progress.</p>
          </div>
        )}

        {(error || singleAudioError) && !error?.includes('Failed to fetch') && (
          <div className="rounded-2xl bg-status-error border border-status-error-border p-5 mb-6">
            <div className="flex items-center space-x-2 text-status-error mb-2">
              <AlertCircle className="h-5 w-5" />
              <h3 className="text-lg font-medium">Error</h3>
            </div>
            <p className="text-status-error-muted">{error || singleAudioError}</p>
            <div className="flex space-x-4 mt-4">
              <button
                onClick={singleAudioState !== 'idle' ? handleSingleAudioDone : handleDone}
                className="flex items-center px-4 py-2.5 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors"
              >
                <RefreshCw className="h-5 w-5 mr-2" />
                Clear
              </button>
            </div>
          </div>
        )}

        <div className="space-y-6">
          {(generationState === 'analyzing' || generationState === 'generating') && (
            <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-5 space-y-4">
              {generationState === 'analyzing' ? (
                <>
                  <div className="flex items-center space-x-3 text-text-secondary">
                    <RefreshCw className="h-5 w-5 text-accent animate-pulse" />
                    <span>{statusMessage}</span>
                  </div>
                  <p className="text-sm text-text-muted">
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
                      {currentTask && currentTask.check_stuck === true && (
                        <p className="text-sm text-yellow-400">
                          This part may take a little longer, but the progress is moving forward.
                        </p>
                      )}
                    </>
                  )}
                  <div className="flex justify-end">
                    <button
                      onClick={handleDone}
                      className="flex items-center px-4 py-2.5 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors"
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
            <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-[--color-status-success-border] p-5 space-y-6">
              <div className="flex items-center space-x-3 text-status-success">
                <CheckCircle2 className="h-5 w-5" />
                <span>Audio generation complete!</span>
              </div>

              <div className="rounded-xl bg-surface-input border border-[--color-status-success-border] p-4">
                <div className="flex justify-between items-center mb-3">
                  <h3 className="text-lg font-medium text-status-success">{generatedDocTitle}</h3>
                  <div className="flex space-x-4">
                    <button
                      onClick={handleDownloadAudio}
                      className={`flex items-center px-3 py-1.5 rounded-xl transition-colors ${
                        downloadingAudio
                          ? 'bg-white/10 text-white/40 cursor-not-allowed'
                          : 'bg-status-success text-white hover:opacity-90'
                      }`}
                      disabled={downloadingAudio}
                    >
                      {downloadingAudio ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white/50 mr-2"></div>
                          Downloading...
                        </>
                      ) : (
                        <>
                          <Download className="h-4 w-4 mr-2" />
                          Download {outputType === 'folder' ? 'ZIP' : ''}
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {outputType === 'single' && generatedAudio ? (
                  <AudioPlayer
                    src={generatedAudio}
                    title={generatedDocTitle}
                    filePath={audioFilePath}
                    onError={() => {}} // Suppress audio player errors
                  />
                ) : outputType === 'folder' ? (
                  <div className="rounded-xl bg-white/5 p-4 text-center">
                    <p className="text-text-secondary mb-2">Multiple audio files ready for download</p>
                    <p className="text-sm text-text-muted">Click Download ZIP to get all files</p>
                  </div>
                ) : (
                  <div className="flex justify-center items-center h-20">
                    <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-accent"></div>
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <button
                  onClick={handleDone}
                  className="flex items-center px-4 py-2.5 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors font-medium"
                >
                  <CheckCircle2 className="h-5 w-5 mr-2" />
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sticky Action Bar — offset to clear the sidebar (w-16 sm:w-48) */}
      <div
        className={`fixed bottom-0 left-16 sm:left-48 right-0 z-40 transition-all duration-300 ${
          showStickyBar ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0 pointer-events-none'
        }`}
      >
        <div className="bg-[#0a0f1a]/95 backdrop-blur-xl border-t border-white/10 shadow-[0_-4px_30px_rgba(0,0,0,0.4)]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5">
            <div className="flex items-center justify-between gap-4">
              {/* Voice indicator */}
              <div className="flex items-center gap-3 min-w-0">
                {(() => {
                  const voiceInfo = getVoiceDisplayInfo(selectedVoice);
                  if (!voiceInfo) return null;
                  return (
                    <div className="flex items-center gap-2.5 bg-white/[0.06] rounded-xl px-3.5 py-2 border border-white/[0.08]">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${voiceInfo.dotColor}`} />
                      <span className={`text-xs font-mono uppercase tracking-wider ${voiceInfo.tierColor} flex-shrink-0`}>
                        {voiceInfo.tier}
                      </span>
                      <span className="text-white/50 text-xs">·</span>
                      <span className="text-white text-sm font-medium truncate">
                        {voiceInfo.name}
                      </span>
                    </div>
                  );
                })()}
                {/* Speed/Volume summary */}
                <div className="hidden sm:flex items-center gap-2 text-xs text-text-muted">
                  <span>{mode === 'document' ? speed : singleAudioSpeed}x speed</span>
                  <span className="text-white/20">·</span>
                  <span>{Math.round((mode === 'document' ? volume : singleAudioVolume) * 100)}% vol</span>
                </div>
              </div>

              {/* Action button */}
              <div className="flex-shrink-0">
                {mode === 'document' ? (
                  generationState === 'analyzed' ? (
                    <button
                      onClick={handleContinue}
                      className="flex items-center px-5 py-2.5 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium text-sm"
                      disabled={
                        !analysisResult || 
                        analysisResult.estimatedTokens > userTokenBalance ||
                        (storageUsed !== null && analysisResult.estimatedFileSizeMB > ((maxStorageGB * 1024) - storageUsed))
                      }
                    >
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                      Continue
                    </button>
                  ) : (
                    <button
                      onClick={handleAnalyze}
                      disabled={isAnalyzeDisabled()}
                      className="flex items-center px-5 py-2.5 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium text-sm"
                    >
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                      Analyze
                    </button>
                  )
                ) : (
                  <button
                    onClick={handleSingleAudioGenerate}
                    className="flex items-center px-5 py-2.5 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium text-sm"
                    disabled={
                      !singleAudioText ||
                      singleAudioText.trim() === '' ||
                      !selectedVoice ||
                      singleAudioState !== 'idle' ||
                      singleAudioSpeedError !== '' ||
                      singleAudioVolumeError !== '' ||
                      (singleAudioText.length > 0 && selectedVoice && (singleAudioText.length * tokensPerCharForSelectedVoice(selectedVoice) + (singleAudioVolume > 1.0 ? 100 : 0)) > userTokenBalance)
                    }
                  >
                    <Volume2 className="h-4 w-4 mr-2" />
                    Generate
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom padding to prevent sticky bar from overlapping content */}
      {showStickyBar && <div className="h-20" />}

      <style>{`
        .slider::-webkit-slider-thumb {
          appearance: none;
          height: 20px;
          width: 20px;
          border-radius: 50%;
          background: #dc2626;
          cursor: pointer;
          border: 2px solid #ffffff;
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.1);
        }
     
        .slider::-moz-range-thumb {
          height: 20px;
          width: 20px;
          border-radius: 50%;
          background: #dc2626;
          cursor: pointer;
          border: 2px solid #ffffff;
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.1);
        }
     
        .slider::-webkit-slider-track {
          height: 8px;
          background: linear-gradient(to right, #dc2626 0%, #dc2626 var(--value, 0%), #374151 var(--value, 0%), #374151 100%);
          border-radius: 4px;
        }
     
        .slider::-moz-range-track {
          height: 8px;
          background: #374151;
          border-radius: 4px;
        }
     
        .slider::-moz-range-progress {
          height: 8px;
          background: #dc2626;
          border-radius: 4px;
        }
      `}</style>
          </div>{/* end opacity wrapper */}
        </div>{/* end relative wrapper */}
    </DashboardLayout>
  );
});

TextToSpeech.displayName = 'TextToSpeech';

export default TextToSpeech;

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




