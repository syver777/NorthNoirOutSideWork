import React, { useState, useRef, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Info, Upload, File, Loader2, AlertCircle, CheckCircle, X, CheckCircle2, ChevronDown } from 'lucide-react';
import { Listbox, Transition } from '@headlessui/react';
import { uploadWithTus, formatUploadProgress } from '../utils/tusUpload';
import { isValidNumericInput } from '../utils/shared';
import { fetchWithFallback } from '../utils/fetchWithFallback';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

// Constants from Python file
const CHARS_PER_SECOND = 13.67;
const WORDS_PER_MINUTE = 125;
const MIN_FREQUENCY_SECONDS = 5; // Minimum 5 seconds per image
const MAX_FREQUENCY_SECONDS = 900; // Maximum 900 seconds per image (15 minutes)
const MAX_AUDIO_FILE_SIZE_MB = 500; // Max audio file size

interface AudioFile {
  path: string;
  name: string;
  duration: number;
  url?: string;
}

interface ImageFrequencyConfigurationProps {
  mode: 'wordcount' | 'audio';
  onModeChange: (mode: 'wordcount' | 'audio') => void;
  frequencyType: 'consistent' | 'variable';
  onFrequencyTypeChange: (type: 'consistent' | 'variable') => void;
  audioOnly?: boolean; // Force audio runtime flow and hide mode selector
  
  // Word count mode props
  wordCount: number;
  consistentFrequency: string;
  onConsistentFrequencyChange: (value: string) => void;
  firstPageFrequency: string;
  onFirstPageFrequencyChange: (value: string) => void;
  restFrequency: string;
  onRestFrequencyChange: (value: string) => void;
  
  // Audio mode props
  selectedStoryGroupId: string | null;
  selectedStoryTitle?: string;
  storySource?: 'new' | 'existing' | 'upload'; // NEW: To disable existing audio for uploaded stories
  audioSource?: 'generate' | 'existing' | 'upload'; // Audio source type
  selectedAudioFile?: string | null; // Selected audio file ID from existing files
  selectedAudioFileDetails?: any; // Full audio file object from Step 2
  audioFiles: AudioFile[];
  onAudioFilesChange: (files: AudioFile[]) => void;
  totalAudioDuration: number;
  onTotalAudioDurationChange: (duration: number) => void;
  imageAmount: string;
  onImageAmountChange: (amount: string) => void;
  audioDistributionType: 'consistent' | 'variable';
  onAudioDistributionTypeChange: (type: 'consistent' | 'variable') => void;
  audioFirstPageImageCount: string;
  onAudioFirstPageImageCountChange: (count: string) => void;
  audioRestImageCount: string;
  onAudioRestImageCountChange: (count: string) => void;
  
  // Common props
  userId: string;
  useCharacterDescriptions: boolean;
  
  // Video Generator specific props
  isVideoGenerator?: boolean; // Differentiates Video Generator from Image Generator/Prompts
  calculatedAudioDuration?: number; // Duration from Step 2 (for video generator)
  audioDurationLoading?: boolean; // Loading state for audio duration calculation
  audioDurationError?: string | null; // Error message from audio duration calculation
  isCalculatingDuration?: boolean; // Flag indicating duration calculation in progress
  handleCalculateAudioDuration?: (audioDocId?: string, audioSource?: 'generate' | 'existing' | 'upload', wordCount?: number) => Promise<any>; // Handler for calculating audio duration
  isStep2Configured?: boolean; // Whether Step 2 (Audio Configuration) is fully configured
}

export default function ImageFrequencyConfiguration({
  mode,
  onModeChange,
  frequencyType,
  onFrequencyTypeChange,
  audioOnly = false,
  wordCount,
  consistentFrequency,
  onConsistentFrequencyChange,
  firstPageFrequency,
  onFirstPageFrequencyChange,
  restFrequency,
  onRestFrequencyChange,
  selectedStoryGroupId,
  selectedStoryTitle,
  storySource,
  audioSource,
  selectedAudioFile,
  selectedAudioFileDetails,
  audioFiles,
  onAudioFilesChange,
  totalAudioDuration,
  onTotalAudioDurationChange,
  imageAmount,
  onImageAmountChange,
  audioDistributionType,
  onAudioDistributionTypeChange,
  audioFirstPageImageCount,
  onAudioFirstPageImageCountChange,
  audioRestImageCount,
  onAudioRestImageCountChange,
  userId,
  useCharacterDescriptions,
  isVideoGenerator = false,
  calculatedAudioDuration,
  audioDurationLoading,
  audioDurationError,
  isCalculatingDuration,
  handleCalculateAudioDuration,
  isStep2Configured = true, // Default to true for Image Generator mode
}: ImageFrequencyConfigurationProps) {
  const [internalCalculatingDuration, setInternalCalculatingDuration] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);
  const [existingAudioFiles, setExistingAudioFiles] = useState<AudioFile[]>([]);
  const [loadingExistingAudio, setLoadingExistingAudio] = useState(false);
  const [selectedExistingAudio, setSelectedExistingAudio] = useState<string>('');
  
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const audioFolderInputRef = useRef<HTMLInputElement>(null);
  const effectiveMode: 'wordcount' | 'audio' = audioOnly ? 'audio' : mode;

  // In audio-only mode, keep mode synchronized to audio for parent state consistency
  useEffect(() => {
    if (audioOnly && mode !== 'audio') {
      onModeChange('audio');
    }
  }, [audioOnly, mode, onModeChange]);

  // NEW: Trigger audio duration calculation when switching to Audio Runtime mode in Video Generator
  useEffect(() => {
    if (isVideoGenerator && mode === 'audio' && handleCalculateAudioDuration) {
      // Only calculate if we haven't already calculated or if we don't have a duration
      if (!calculatedAudioDuration || calculatedAudioDuration === 0) {
        console.log('[ImageFrequencyConfiguration] Switched to Audio Runtime mode, triggering duration calculation');
        
        // Determine how to calculate based on audio source
        if (audioSource === 'generate') {
          // Generate audio: estimate from word count
          console.log('[ImageFrequencyConfiguration] Audio source: generate, using word count estimate');
          handleCalculateAudioDuration(undefined, 'generate', wordCount);
        } else if ((audioSource === 'existing' || audioSource === 'upload') && selectedAudioFile) {
          // Existing or uploaded audio: call edge function
          console.log('[ImageFrequencyConfiguration] Audio source:', audioSource, ', calculating from file:', selectedAudioFile);
          handleCalculateAudioDuration(selectedAudioFile, audioSource);
        } else {
          console.log('[ImageFrequencyConfiguration] No audio file selected yet');
        }
      }
    }
  }, [mode, isVideoGenerator]); // Only trigger when mode changes or component mounts

  // Load existing audio files when story is selected (but not for uploaded stories)
  useEffect(() => {
    if (mode === 'audio' && selectedStoryGroupId && storySource !== 'upload') {
      loadExistingAudioFiles();
    } else if (storySource === 'upload') {
      // Clear existing audio files when story is uploaded
      setExistingAudioFiles([]);
      setSelectedExistingAudio('');
    } else if (mode === 'audio' && selectedAudioFileDetails && !selectedStoryGroupId && audioFiles.length === 0) {
      // Use pre-selected audio from Step 2 when Step 1 was skipped
      const preSelectedFile = {
        path: selectedAudioFileDetails.file_path || '',
        name: selectedAudioFileDetails.title || 'Selected Audio',
        duration: selectedAudioFileDetails.audio_duration || 0
      };
      setExistingAudioFiles([preSelectedFile]);
      setSelectedExistingAudio(selectedAudioFileDetails.id || '');
      // Automatically select the file for calculations
      handleSelectExistingAudio([preSelectedFile]);
    }
  }, [mode, selectedStoryGroupId, storySource, selectedAudioFile, selectedAudioFileDetails]);

  // Calculate min/max image limits for audio mode (consistent distribution)
  const getAudioImageLimits = () => {
    // For video generator, use calculatedAudioDuration from Step 2
    const duration = isVideoGenerator && calculatedAudioDuration 
      ? calculatedAudioDuration 
      : audioFiles.reduce((sum, f) => sum + (f.duration || 0), 0);
    
    if (duration === 0) return { min: 1, max: 1 };
    
    // Maximum images based on minimum time per image (5 seconds)
    const maxImages = Math.floor(duration / MIN_FREQUENCY_SECONDS);
    // Minimum images based on maximum time per image (900 seconds)
    const minImages = Math.max(1, Math.ceil(duration / MAX_FREQUENCY_SECONDS));
    
    return {
      min: minImages,
      max: Math.max(minImages, maxImages)
    };
  };

  // Calculate min/max image limits for audio variable distribution
  const getAudioVariableDistributionLimits = () => {
    // For video generator, use calculatedAudioDuration from Step 2
    const totalDuration = isVideoGenerator && calculatedAudioDuration
      ? calculatedAudioDuration
      : audioFiles.reduce((sum, f) => sum + f.duration, 0);
    
    if (totalDuration === 0) return { 
      firstPageDuration: 0, 
      restDuration: 0, 
      maxFirstImages: 1, 
      maxRestImages: 0,
      minFirstImages: 1,
      minRestImages: 0
    };
    
    // First page duration is minimum of 360 seconds (6 minutes) or total duration
    const firstPageDuration = Math.min(360, totalDuration);
    const restDuration = Math.max(0, totalDuration - firstPageDuration);
    
    // Maximum images based on minimum time per image (5 seconds)
    const maxFirstImages = Math.floor(firstPageDuration / MIN_FREQUENCY_SECONDS);
    const maxRestImages = restDuration > 0 ? Math.floor(restDuration / MIN_FREQUENCY_SECONDS) : 0;
    
    // Minimum images based on maximum time per image (900 seconds)
    const minFirstImages = Math.max(1, Math.ceil(firstPageDuration / MAX_FREQUENCY_SECONDS));
    const minRestImages = restDuration > 0 ? Math.max(1, Math.ceil(restDuration / MAX_FREQUENCY_SECONDS)) : 0;
    
    return {
      firstPageDuration,
      restDuration,
      maxFirstImages,
      maxRestImages,
      minFirstImages,
      minRestImages
    };
  };

  // Validate audio variable distribution
  const validateAudioVariableDistribution = (): { first?: string; rest?: string } => {
    const limits = getAudioVariableDistributionLimits();
    const errors: { first?: string; rest?: string } = {};
    
    if (audioFirstPageImageCount.trim() !== '') {
      if (!isValidNumericInput(audioFirstPageImageCount)) {
        errors.first = 'Must be a valid number';
      } else {
        const firstCount = parseInt(audioFirstPageImageCount);
        if (firstCount < limits.minFirstImages) {
          errors.first = `Minimum ${limits.minFirstImages} image(s) required (max ${MAX_FREQUENCY_SECONDS / 60} min per image)`;
        } else if (firstCount > limits.maxFirstImages) {
          errors.first = `Maximum ${limits.maxFirstImages} images for first ${Math.round(limits.firstPageDuration)}s`;
        }
      }
    }
    
    if (limits.restDuration > 0 && audioRestImageCount.trim() !== '') {
      if (!isValidNumericInput(audioRestImageCount)) {
        errors.rest = 'Must be a valid number';
      } else {
        const restCount = parseInt(audioRestImageCount);
        if (restCount < limits.minRestImages) {
          errors.rest = `Minimum ${limits.minRestImages} image(s) required (max ${MAX_FREQUENCY_SECONDS / 60} min per image)`;
        } else if (restCount > limits.maxRestImages) {
          errors.rest = `Maximum ${limits.maxRestImages} images for rest ${Math.round(limits.restDuration)}s`;
        }
      }
    }
    
    return errors;
  };

  // Calculate estimated image count for word count mode
  const calculateEstimatedImageCount = (): number => {
    if (wordCount === 0) return 0;
    
    const totalChars = wordCount * 5; // Assume 5 characters per word
    
    if (frequencyType === 'consistent') {
      const freq = parseFloat(consistentFrequency || '0');
      if (freq === 0) return 0;
      const charsPerSegment = Math.max(100, Math.floor(freq * CHARS_PER_SECOND));
      const totalPrompts = Math.ceil(totalChars / charsPerSegment);
      // Apply 18% increase to match backend calculation
      return Math.round(totalPrompts * 1.18);
    } else {
      // Variable frequency (first page + rest pages)
      const firstPageFreq = parseFloat(firstPageFrequency || '0');
      const restFreq = parseFloat(restFrequency || '0');
      
      // freq 0 = skip that section's images (not all images)
      let firstPageSegments = 0;
      if (firstPageFreq > 0) {
        const firstPageChars = 3000; // First page is ~3000 chars
        const firstPageCharsPerSegment = Math.max(100, Math.min(3000, Math.floor(firstPageFreq * CHARS_PER_SECOND)));
        firstPageSegments = Math.ceil(firstPageChars / firstPageCharsPerSegment);
      }
      
      let restSegments = 0;
      if (restFreq > 0) {
        const remainingChars = Math.max(0, totalChars - 3000);
        const restCharsPerSegment = Math.max(100, Math.floor(restFreq * CHARS_PER_SECOND));
        restSegments = remainingChars > 0 ? Math.ceil(remainingChars / restCharsPerSegment) : 0;
      }
      
      const totalPrompts = firstPageSegments + restSegments;
      if (totalPrompts === 0) return 0;
      // Apply 18% increase to match backend calculation
      return Math.round(totalPrompts * 1.18);
    }
  };

  // Load existing audio files from story_documents table
  const loadExistingAudioFiles = async () => {
    if (!selectedStoryGroupId || !userId) return;
    
    setLoadingExistingAudio(true);
    setAudioError(null);
    
    try {
      // Query story_documents table for audio files
      // Version 7: Audio file (is_corrected=FALSE)
      // Version 8: Audio file (is_corrected=TRUE)
      // Version 9: Audio folder (is_corrected=FALSE)
      // Version 10: Audio folder (is_corrected=TRUE)
      const { data: audioDocuments, error } = await supabase
        .from('story_documents')
        .select('*')
        .eq('user_id', userId)
        .eq('group_id', selectedStoryGroupId)
        .in('version', [7, 8, 9, 10])
        .order('created_at', { ascending: false });

      if (error) throw error;

      if (audioDocuments && audioDocuments.length > 0) {
        // Map database records to AudioFile format
        const audioFilesFromDB: AudioFile[] = audioDocuments.map((doc) => {
          // Get public URL from file_path (files are in 'stories' bucket)
          const { data: urlData } = supabase.storage
            .from('stories')
            .getPublicUrl(doc.file_path);
          
          return {
            path: doc.file_path,
            name: doc.title || 'Audio File',
            duration: doc.audio_duration || 0, // Use stored duration from database
            url: urlData.publicUrl
          };
        });
        
        setExistingAudioFiles(audioFilesFromDB);
      } else {
        setExistingAudioFiles([]);
      }
    } catch (error: any) {
      console.error('Error loading existing audio files:', error);
      setAudioError(`Failed to load existing audio files: ${error.message}`);
      setExistingAudioFiles([]);
    } finally {
      setLoadingExistingAudio(false);
    }
  };

  // Calculate audio duration using edge function
  const calculateAudioDuration = async (files: AudioFile[]) => {
    setInternalCalculatingDuration(true);
    setAudioError(null);
    
    console.log('Calculating audio duration for files:', files.map(f => f.name));
    
    try {
      const { data: { session: _ifSession } } = await supabase.auth.getSession();
      const response = await fetchWithFallback(
        'https://calculate-audio-duration.storyscriptai.deno.net',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_ifSession?.access_token || ''}`,
            'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({
            files: files.map(f => ({ path: f.path, url: f.url, name: f.name }))
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to calculate audio duration: HTTP ${response.status}`);
      }

      const result = await response.json();
      
      if (result.error) {
        throw new Error(result.error);
      }

      const { totalDuration, filesWithDurations } = result;
      
      onTotalAudioDurationChange(totalDuration);
      onAudioFilesChange(filesWithDurations);
      
      // NOTE: Database updates are handled by the backend functions
      // (calculate-audio-duration.ts and calculate-audio-duration.py)
      // No need to update here to avoid race conditions and duplicate updates
      
      // Calculate max images based on duration
      const limits = getAudioImageLimits();
      if (imageAmount.trim() !== '' && isValidNumericInput(imageAmount)) {
        const parsedAmount = parseInt(imageAmount);
        if (parsedAmount > limits.max) {
          onImageAmountChange('');
        }
      }
    } catch (error: any) {
      console.error('Error calculating audio duration:', error);
      setAudioError(`Failed to calculate audio duration: ${error.message}`);
    } finally {
      setInternalCalculatingDuration(false);
    }
  };

  // Handle audio file upload
  const handleAudioFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!selectedStoryGroupId || !userId) {
      setAudioError('Please select or upload a story first');
      return;
    }

    setIsUploading(true);
    setAudioError(null);
    setUploadProgress(0);

    try {
      const uploadedFiles: AudioFile[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        // Validate file size
        if (file.size > MAX_AUDIO_FILE_SIZE_MB * 1024 * 1024) {
          throw new Error(`File ${file.name} exceeds ${MAX_AUDIO_FILE_SIZE_MB}MB limit`);
        }

        // Validate file type
        const audioExtensions = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.wma'];
        const fileExt = '.' + file.name.split('.').pop()?.toLowerCase();
        if (!audioExtensions.includes(fileExt)) {
          throw new Error(`File ${file.name} is not a supported audio format`);
        }

        // Generate file path in stories bucket matching VideoGenerator pattern
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
        const fileName = `audio_${timestamp}_${sanitizedName}`;
        const filePath = `documents/${userId}/${selectedStoryGroupId}/${fileName}`;

        // Upload file to stories bucket
        const result = await uploadWithTus({
          file,
          bucket: 'stories',
          path: filePath,
          onProgress: (bytesUploaded, bytesTotal) => {
            const progress = Math.round((bytesUploaded / bytesTotal) * 100);
            setUploadProgress(progress);
          },
          contentType: file.type || 'audio/mpeg'
        });

        if (!result.success) {
          throw new Error(result.error || 'Upload failed');
        }

        // Insert document metadata into story_documents with version 7 (audio file)
        const { data, error: insertError } = await supabase
          .from('story_documents')
          .insert({
            id: crypto.randomUUID(),
            user_id: userId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            file_path: filePath,
            title: sanitizedName.replace(/\.(mp3|wav|flac|m4a|aac|ogg|wma)$/i, ''),
            description: 'Uploaded audio file for image prompt generation',
            word_count: 0,
            version: 7, // Audio file version
            is_corrected: false,
            is_prompted: false,
            group_id: selectedStoryGroupId,
            variant: 1,
            file_size: file.size,
          })
          .select()
          .single();

        if (insertError) {
          throw new Error(`Failed to save audio metadata: ${insertError.message}`);
        }

        uploadedFiles.push({
          path: filePath,
          name: file.name,
          duration: 0,
          url: result.publicUrl
        });
      }

      // Calculate duration for uploaded files
      await calculateAudioDuration(uploadedFiles);
      
      // Reload existing audio files to show newly uploaded files
      await loadExistingAudioFiles();
      
      // Clear file input
      if (audioFileInputRef.current) {
        audioFileInputRef.current.value = '';
      }
      if (audioFolderInputRef.current) {
        audioFolderInputRef.current.value = '';
      }
    } catch (error: any) {
      console.error('Error uploading audio files:', error);
      setAudioError(`Upload failed: ${error.message}`);
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  // Handle selecting existing audio files
  const handleSelectExistingAudio = async (selectedFiles: AudioFile[]) => {
    console.log('handleSelectExistingAudio called with files:', selectedFiles.map(f => ({
      name: f.name,
      duration: f.duration,
      path: f.path
    })));
    
    // Check if duration is already stored in database
    const filesNeedingCalculation = selectedFiles.filter(f => !f.duration || f.duration === 0);
    
    if (filesNeedingCalculation.length > 0) {
      // Files missing duration - trigger calculation
      console.log('Files need calculation:', filesNeedingCalculation.map(f => f.name));
      await calculateAudioDuration(selectedFiles);
    } else {
      // Use stored durations directly
      console.log('Using stored durations directly');
      const totalDuration = selectedFiles.reduce((sum, f) => sum + f.duration, 0);
      console.log('Total duration:', totalDuration);
      
      onTotalAudioDurationChange(totalDuration);
      onAudioFilesChange(selectedFiles);
      
      // Calculate max images based on duration
      const maxImages = Math.floor(totalDuration / MIN_FREQUENCY_SECONDS);
      if (isValidNumericInput(imageAmount)) {
        const parsedImageAmount = parseInt(imageAmount, 10);
        if (parsedImageAmount > maxImages) {
          onImageAmountChange(String(Math.max(1, maxImages)));
        }
      }
    }
  };

  // Clear selected audio and delete duration from database
  const handleClearAudio = async () => {
    console.log('handleClearAudio called, current audioFiles:', audioFiles);
    
    // Delete audio_duration from database for currently selected files
    if (audioFiles.length > 0) {
      try {
        const filePaths = audioFiles.map(f => f.path);
        
        // Update story_documents table - set audio_duration to NULL
        const { error } = await supabase
          .from('story_documents')
          .update({ audio_duration: null })
          .in('file_path', filePaths)
          .eq('user_id', userId);
        
        if (error) {
          console.error('Error deleting audio durations from database:', error);
          setAudioError('Failed to clear audio duration from database');
        } else {
          console.log('Successfully cleared audio durations for:', filePaths);
        }
      } catch (error: any) {
        console.error('Exception clearing audio durations:', error);
        setAudioError('Failed to clear audio duration');
      }
    }
    
    console.log('Clearing UI state...');
    // Clear UI state
    onAudioFilesChange([]);
    onTotalAudioDurationChange(0);
    onImageAmountChange('');
    setSelectedExistingAudio('');
    setAudioError(null);
    
    console.log('After calling clear callbacks, audioFiles is still:', audioFiles);
    console.log('UI state cleared, reloading existing audio files...');
    // Reload existing audio files to reflect the updated database state (NULL durations)
    await loadExistingAudioFiles();
    console.log('Existing audio files reloaded');
  };

  // Format duration to HH:MM:SS
  const formatDuration = (seconds: number): string => {
    // Return placeholder for 0 or invalid values
    if (!seconds || seconds <= 0) {
      return '—';
    }
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="space-y-6">
      {/* Mode Selector */}
      {!audioOnly && (
        <div>
          <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3 block">
            Image Frequency Mode
          </label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => onModeChange('wordcount')}
              className={`p-4 rounded-xl border-2 transition-all text-left ${
                effectiveMode === 'wordcount'
                  ? 'border-green-800/70 bg-green-900/30'
                  : 'border-border-card bg-surface-card hover:border-white/20'
              }`}
            >
              <div className="font-medium text-white mb-1">Word Count Image Frequency</div>
              <div className="text-xs text-text-muted">
                Generate images based on text length
              </div>
            </button>
            <button
              type="button"
              onClick={() => onModeChange('audio')}
              className={`p-4 rounded-xl border-2 transition-all text-left ${
                effectiveMode === 'audio'
                  ? 'border-green-800/70 bg-green-900/30'
                  : 'border-border-card bg-surface-card hover:border-white/20'
              }`}
            >
              <div className="font-medium text-white mb-1">Audio Runtime + Image Amount</div>
              <div className="text-xs text-text-muted">
                Specify exact number of images for audio duration
              </div>
            </button>
          </div>
        </div>
      )}

      {/* Word Count Mode */}
      {effectiveMode === 'wordcount' && (
        <div className="space-y-4">
          {/* Info Box */}
          <div className="dash-info-box p-3 flex gap-2">
            <Info className="w-5 h-5 dash-box-icon flex-shrink-0 mt-0.5" />
            <div className="text-sm dash-box-text">
              <strong>Word Count Mode:</strong> Images are generated at specific intervals based on your text length. 
              Choose consistent frequency for even spacing, or variable frequency for different intervals on the first page vs. rest of pages.
            </div>
          </div>

          {/* Frequency Type Toggle */}
          <div>
            <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3 block">
              Frequency Type
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  onFrequencyTypeChange('consistent');
                  // Also sync audio distribution type when in audio mode
                  onAudioDistributionTypeChange('consistent');
                }}
                className={`p-3 rounded-xl border-2 transition-all ${
                  frequencyType === 'consistent'
                    ? 'border-green-800/70 bg-green-900/30'
                    : 'border-border-card bg-surface-card hover:border-white/20'
                }`}
              >
                <div className="font-medium text-white text-sm">Consistent Frequency</div>
                <div className="text-xs text-text-muted mt-1">Same interval throughout</div>
              </button>
              <button
                type="button"
                onClick={() => {
                  onFrequencyTypeChange('variable');
                  // Also sync audio distribution type when in audio mode
                  onAudioDistributionTypeChange('variable');
                }}
                className={`p-3 rounded-xl border-2 transition-all ${
                  frequencyType === 'variable'
                    ? 'border-green-800/70 bg-green-900/30'
                    : 'border-border-card bg-surface-card hover:border-white/20'
                }`}
              >
                <div className="font-medium text-white text-sm">Variable Frequency</div>
                <div className="text-xs text-text-muted mt-1">Different for first/rest pages</div>
              </button>
            </div>
          </div>

          {/* Consistent Frequency Input */}
          {frequencyType === 'consistent' && (
            <div>
              <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                Image Every (seconds)
              </label>
              <div className="dash-info-box p-2 mb-3 flex gap-2">
                <Info className="w-4 h-4 dash-box-icon flex-shrink-0 mt-0.5" />
                <div className="text-xs dash-box-text">
                  Enter how often you want images to appear in seconds. For example, enter <strong>10</strong> to get an image every 10 seconds of reading time.
                  Range: 5-600 seconds per image.
                </div>
              </div>
              <input
                type="text"
                value={consistentFrequency}
                onChange={(e) => onConsistentFrequencyChange(e.target.value)}
                placeholder="Enter frequency in seconds"
                className="w-full px-4 py-2 bg-surface-input border border-white/[0.13] rounded-xl text-white/90 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <div className="text-xs text-text-muted mt-2">
                Estimated images: <strong className="text-white">{calculateEstimatedImageCount()}</strong>
              </div>
            </div>
          )}

          {/* Variable Frequency Inputs */}
          {frequencyType === 'variable' && (
            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                  First Page Frequency (seconds)
                </label>
                <div className="dash-info-box p-2 mb-3 flex gap-2">
                  <Info className="w-4 h-4 dash-box-icon flex-shrink-0 mt-0.5" />
                  <div className="text-xs dash-box-text">
                    The first ~3000 characters (about 1 page) can have a different image frequency than the rest of the story. 
                    Lower values = more images on the first page. Range: 5-300 seconds.
                  </div>
                </div>
                <input
                  type="text"
                  value={firstPageFrequency}
                  onChange={(e) => onFirstPageFrequencyChange(e.target.value)}
                  placeholder="Enter frequency in seconds"
                  className="w-full px-4 py-2 bg-surface-input border border-white/[0.13] rounded-xl text-white/90 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
              </div>

              <div>
                <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                  Rest Pages Frequency (seconds)
                </label>
                <div className="dash-info-box p-2 mb-3 flex gap-2">
                  <Info className="w-4 h-4 dash-box-icon flex-shrink-0 mt-0.5" />
                  <div className="text-xs dash-box-text">
                    Image frequency for all pages after the first page. Higher values = fewer images overall. Range: 5-600 seconds.
                  </div>
                </div>
                <input
                  type="text"
                  value={restFrequency}
                  onChange={(e) => onRestFrequencyChange(e.target.value)}
                  placeholder="Enter frequency in seconds"
                  className="w-full px-4 py-2 bg-surface-input border border-white/[0.13] rounded-xl text-white/90 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
              </div>

              <div className="text-xs text-text-muted">
                Estimated images: <strong className="text-white">{calculateEstimatedImageCount()}</strong>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Audio Runtime Mode */}
      {effectiveMode === 'audio' && (
        <div className="space-y-4">
          {/* Video Generator Mode - Show audio runtime info from Step 2 */}
          {isVideoGenerator ? (
            <>
              {/* Check if Step 2 is configured first - but show loading if duration is being calculated */}
              {!isStep2Configured && !isCalculatingDuration && !audioDurationLoading ? (
                <div className="dash-info-box p-3 flex gap-2">
                  <Info className="w-5 h-5 dash-box-icon flex-shrink-0 mt-0.5" />
                  <div className="text-sm dash-box-text">
                    <strong>Audio Configuration Required:</strong> Please configure audio in Step 2 (Audio Configuration) before setting image distribution.
                  </div>
                </div>
              ) : (
                <>
                  {/* Audio Runtime Display */}
                  <div className="bg-surface-card rounded-xl p-4">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-sm text-text-secondary">Audio Runtime:</span>
                      {isCalculatingDuration || audioDurationLoading ? (
                        <div className="flex items-center space-x-2">
                          <Loader2 className="h-4 w-4 dash-box-icon animate-spin" />
                          <span className="text-sm text-status-warning">Calculating...</span>
                        </div>
                      ) : !isCalculatingDuration && !audioDurationLoading && calculatedAudioDuration && calculatedAudioDuration > 0 ? (
                        <span className="text-lg font-semibold text-white">{formatDuration(calculatedAudioDuration)}</span>
                      ) : (
                        <span className="text-sm text-text-muted">Waiting for audio duration...</span>
                      )}
                    </div>

                    {/* Show selected audio file name for existing audio */}
                    {audioSource === 'existing' && selectedAudioFileDetails && !isCalculatingDuration && !audioDurationLoading && (
                      <div className="mt-2 pt-2 border-t border-white/[0.13]">
                        <span className="text-xs text-text-muted">Selected Audio:</span>
                        <p className="text-sm text-white/80 mt-1 truncate" title={selectedAudioFileDetails.title}>
                          {selectedAudioFileDetails.title}
                        </p>
                      </div>
                    )}

                {/* Show loading info message when calculating */}
                {(isCalculatingDuration || audioDurationLoading) && (
                  <div className="dash-info-box p-2 mt-2 flex gap-2">
                    <Info className="h-4 w-4 dash-box-icon flex-shrink-0 mt-0.5" />
                    <p className="text-xs dash-box-text">
                      <strong>Calculating duration...</strong> This may take a moment. The image distribution options will appear once the audio duration is calculated.
                    </p>
                  </div>
                )}

                {/* Show different messages based on audio source */}
                {audioSource === 'generate' && !isCalculatingDuration && !audioDurationLoading && calculatedAudioDuration && calculatedAudioDuration > 0 && (
                  <div className="dash-info-box p-2 mt-2 flex gap-2">
                    <Info className="h-4 w-4 dash-box-icon flex-shrink-0 mt-0.5" />
                    <p className="text-xs dash-box-text">
                      <span className="hidden sm:inline">
                        <strong>Estimate:</strong> This is an estimated runtime based on your story word count. The actual runtime will be calculated after audio generation and used for the final video.
                      </span>
                      <span className="sm:hidden">
                        <strong>Estimate:</strong> Actual runtime calculated after audio generation.
                      </span>
                    </p>
                  </div>
                )}

                {(audioSource === 'existing' || audioSource === 'upload') && !isCalculatingDuration && calculatedAudioDuration && calculatedAudioDuration > 0 && (
                  <p className="text-xs text-green-400 mt-2 flex items-center">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    <span className="hidden sm:inline">Runtime calculated from audio file</span>
                    <span className="sm:hidden">From audio file</span>
                  </p>
                )}

                {audioDurationError && (
                  <p className="text-xs text-red-400 mt-2 flex items-center">
                    <AlertCircle className="h-3 w-3 mr-1" />
                    {audioDurationError}
                  </p>
                )}
              </div>

              {/* Distribution Type Selector - Show when audio duration is available and not calculating */}
              {calculatedAudioDuration && calculatedAudioDuration > 0 && !isCalculatingDuration && !audioDurationLoading && (
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3 block">
                      Distribution Type
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => onAudioDistributionTypeChange('consistent')}
                        className={`p-3 rounded-xl border-2 transition-all ${
                          audioDistributionType === 'consistent'
                            ? 'border-green-800/70 bg-green-900/30'
                            : 'border-border-card bg-surface-card hover:border-white/20'
                        }`}
                      >
                        <div className="font-medium text-white text-sm">Consistent Distribution</div>
                        <div className="text-xs text-text-muted mt-1">Even throughout</div>
                      </button>
                      <button
                        type="button"
                        onClick={() => onAudioDistributionTypeChange('variable')}
                        className={`p-3 rounded-xl border-2 transition-all ${
                          audioDistributionType === 'variable'
                            ? 'border-green-800/70 bg-green-900/30'
                            : 'border-border-card bg-surface-card hover:border-white/20'
                        }`}
                      >
                        <div className="font-medium text-white text-sm">Variable Distribution</div>
                        <div className="text-xs text-text-muted mt-1">Different for first/rest</div>
                      </button>
                    </div>
                  </div>

                  {/* Consistent Distribution - Single Image Amount Input */}
                  {audioDistributionType === 'consistent' && (
                    <div>
                      <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                        Number of Images
                      </label>
                      <div className="dash-info-box p-2 mb-3 flex gap-2">
                        <Info className="w-4 h-4 dash-box-icon flex-shrink-0 mt-0.5" />
                        <div className="text-xs dash-box-text">
                          Specify exactly how many images you want generated for this audio duration. 
                          Range: {getAudioImageLimits().min}-{getAudioImageLimits().max} images 
                          (min {MIN_FREQUENCY_SECONDS}s per image, max {MAX_FREQUENCY_SECONDS / 60} min per image).
                        </div>
                      </div>
                      <input
                        type="text"
                        value={imageAmount}
                        onChange={(e) => onImageAmountChange(e.target.value)}
                        placeholder={`Enter number of images (${getAudioImageLimits().min}-${getAudioImageLimits().max})`}
                        className="w-full px-4 py-2 bg-surface-input border border-white/[0.13] rounded-xl text-white/90 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      
                      {/* Validation and frequency display */}
                      {(() => {
                        const limits = getAudioImageLimits();
                        
                        // Show error if not a valid number
                        if (imageAmount.trim() !== '' && !isValidNumericInput(imageAmount)) {
                          return (
                            <div className="text-xs text-red-400 mt-2">
                              Must be a valid number
                            </div>
                          );
                        }
                        
                        const parsedAmount = parseInt(imageAmount);
                        
                        // Show error if outside limits
                        if (imageAmount.trim() !== '' && !isNaN(parsedAmount)) {
                          if (parsedAmount < limits.min || parsedAmount > limits.max) {
                            return (
                              <div className="text-xs text-red-400 mt-2">
                                Must be between {limits.min} and {limits.max} images
                              </div>
                            );
                          }
                          
                          // Show frequency if valid
                          return (
                            <div className="text-xs text-text-muted mt-2">
                              Average time per image: <strong className="text-white">
                                {(calculatedAudioDuration / parsedAmount).toFixed(1)}s
                              </strong>
                            </div>
                          );
                        }
                        return null;
                      })()}
                    </div>
                  )}

                  {/* Variable Distribution - First Page & Rest Images */}
                  {audioDistributionType === 'variable' && (
                    <div className="space-y-4">
                      {(() => {
                        const limits = getAudioVariableDistributionLimits();
                        const firstCount = isValidNumericInput(audioFirstPageImageCount) ? parseInt(audioFirstPageImageCount) : 0;
                        const restCount = isValidNumericInput(audioRestImageCount) ? parseInt(audioRestImageCount) : 0;
                        const firstAvg = limits.firstPageDuration / (firstCount || 1);
                        const restAvg = limits.restDuration > 0 ? limits.restDuration / (restCount || 1) : 0;
                        
                        return (
                          <>
                            {/* Info Box */}
                            <div className="dash-info-box p-2 flex gap-2">
                              <Info className="w-4 h-4 dash-box-icon flex-shrink-0 mt-0.5" />
                              <div className="text-xs dash-box-text">
                                The first ~{Math.round(limits.firstPageDuration)}s can have a different image density than the rest of the audio.
                                Rest duration: {Math.round(limits.restDuration)}s
                              </div>
                            </div>

                            {/* First Page Images */}
                            <div>
                              <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                                First Page Images
                              </label>
                              <input
                                type="text"
                                value={audioFirstPageImageCount}
                                onChange={(e) => onAudioFirstPageImageCountChange(e.target.value)}
                                placeholder="Enter number of images"
                                className="w-full px-4 py-2 bg-surface-input border border-white/[0.13] rounded-xl text-white/90 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                              />
                              
                              {/* Validation and frequency display */}
                              {(() => {
                                if (audioFirstPageImageCount.trim() !== '' && !isValidNumericInput(audioFirstPageImageCount)) {
                                  return (
                                    <div className="text-xs text-red-400 mt-2">
                                      Must be a valid number
                                    </div>
                                  );
                                }
                                const parsed = parseInt(audioFirstPageImageCount);
                                if (audioFirstPageImageCount.trim() !== '' && !isNaN(parsed)) {
                                  if (parsed < limits.minFirstImages) {
                                    return (
                                      <div className="text-xs text-red-400 mt-2">
                                        Minimum {limits.minFirstImages} image(s) required (max {MAX_FREQUENCY_SECONDS / 60} min per image)
                                      </div>
                                    );
                                  }
                                  if (parsed > limits.maxFirstImages) {
                                    return (
                                      <div className="text-xs text-red-400 mt-2">
                                        Maximum {limits.maxFirstImages} images for first {Math.round(limits.firstPageDuration)}s
                                      </div>
                                    );
                                  }
                                  return (
                                    <div className="text-xs text-text-muted mt-2">
                                      Average time per image: <strong className="text-white">{firstAvg.toFixed(1)}s</strong>
                                    </div>
                                  );
                                }
                                return null;
                              })()}
                            </div>

                            {/* Rest Images */}
                            {limits.restDuration > 0 && (
                              <div>
                                <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                                  Rest of Story Images
                                </label>
                                <input
                                  type="text"
                                  value={audioRestImageCount}
                                  onChange={(e) => onAudioRestImageCountChange(e.target.value)}
                                  placeholder="Enter number of images"
                                  className="w-full px-4 py-2 bg-surface-input border border-white/[0.13] rounded-xl text-white/90 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                />
                                
                                {/* Validation and frequency display */}
                                {(() => {
                                  if (audioRestImageCount.trim() !== '' && !isValidNumericInput(audioRestImageCount)) {
                                    return (
                                      <div className="text-xs text-red-400 mt-2">
                                        Must be a valid number
                                      </div>
                                    );
                                  }
                                  const parsed = parseInt(audioRestImageCount);
                                  if (audioRestImageCount.trim() !== '' && !isNaN(parsed)) {
                                    if (parsed < limits.minRestImages) {
                                      return (
                                        <div className="text-xs text-red-400 mt-2">
                                          Minimum {limits.minRestImages} image(s) required (max {MAX_FREQUENCY_SECONDS / 60} min per image)
                                        </div>
                                      );
                                    }
                                    if (parsed > limits.maxRestImages) {
                                      return (
                                        <div className="text-xs text-red-400 mt-2">
                                          Maximum {limits.maxRestImages} images for rest {Math.round(limits.restDuration)}s
                                        </div>
                                      );
                                    }
                                    return (
                                      <div className="text-xs text-text-muted mt-2">
                                        Average time per image: <strong className="text-white">{restAvg.toFixed(1)}s</strong>
                                      </div>
                                    );
                                  }
                                  return null;
                                })()}
                              </div>
                            )}

                            {/* Total images display - only if both are valid */}
                            {firstCount > 0 && restCount > 0 && 
                             firstCount >= limits.minFirstImages && firstCount <= limits.maxFirstImages &&
                             restCount >= limits.minRestImages && restCount <= limits.maxRestImages && (
                              <div className="text-xs text-text-muted">
                                Total images: <strong className="text-white">{firstCount + restCount}</strong>
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
                </>
              )}
            </>
          ) : (
            <>
              {/* Image Generator/Prompts Mode - Original behavior with upload/selection */}
              {/* Info Box */}
              <div className="dash-info-box p-3 flex gap-2">
                {internalCalculatingDuration ? (
                  <>
                    <Loader2 className="w-5 h-5 dash-box-icon flex-shrink-0 mt-0.5 animate-spin" />
                    <div className="text-sm dash-box-text">
                      <strong>Calculating Audio Duration...</strong> This may take 1-3 minutes for large audio files. 
                      Please wait while we analyze your audio.
                    </div>
                  </>
                ) : (
                  <>
                    <Info className="w-5 h-5 dash-box-icon flex-shrink-0 mt-0.5" />
                    <div className="text-sm dash-box-text">
                      <strong>Audio Runtime Mode:</strong> Specify exactly how many images you want for your audio duration. 
                      Upload or select audio files that match your selected story.
                    </div>
                  </>
                )}
              </div>

              {/* Story Selection Check - Only show if Step 2 audio is NOT configured */}
              {!selectedStoryGroupId && !selectedAudioFile && audioFiles.length === 0 && (
                <div className="dash-info-box p-3 flex gap-2">
                  <AlertCircle className="w-5 h-5 dash-box-icon flex-shrink-0 mt-0.5" />
                  <div className="text-sm dash-box-text">
                    <strong>Story Required:</strong> Please select or upload a story document first.
                  </div>
                </div>
              )}
            </>
          )}

          {/* Audio Selection/Upload - Only show for Image Generator/Prompts mode */}
          {!isVideoGenerator && (selectedStoryGroupId || selectedAudioFile || audioFiles.length > 0) && (
            <>
              {(() => {
                console.log('Rendering audio section, audioFiles.length:', audioFiles.length, 'audioFiles:', audioFiles);
                return audioFiles.length === 0;
              })() ? (
                <div className="space-y-3">
                  <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase block">
                    Audio Source
                    {selectedStoryTitle && (
                      <span className="text-xs text-text-muted ml-2">
                        (for: {selectedStoryTitle})
                      </span>
                    )}
                  </label>

                  {/* Existing Audio Files - Always show this section */}
                  <div className="space-y-2">
                    <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase block">Select Existing Audio</label>
                    
                    {storySource === 'upload' ? (
                      <div className="dash-info-box p-3 flex gap-2">
                        <Info className="w-5 h-5 dash-box-icon flex-shrink-0 mt-0.5" />
                        <div className="text-sm dash-box-text">
                          <strong>Note:</strong> Existing audio selection is only available when using a saved story document. For uploaded stories, please upload a new audio file below.
                        </div>
                      </div>
                    ) : loadingExistingAudio ? (
                      <div className="flex items-center gap-2 text-text-muted text-sm p-3 bg-surface-card rounded-xl">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading existing audio files...
                      </div>
                    ) : (
                      <Listbox
                        value={selectedExistingAudio}
                        onChange={(value) => {
                          setSelectedExistingAudio(value);
                          if (value === '') {
                            handleClearAudio();
                          } else {
                            const file = existingAudioFiles.find(f => f.path === value);
                            if (file) {
                              handleSelectExistingAudio([file]);
                            }
                          }
                        }}
                        disabled={internalCalculatingDuration}
                      >
                        {({ open }) => (
                          <div className="relative">
                            <Listbox.Button className={`relative w-full bg-surface-input border border-white/[0.13] rounded-xl px-4 py-2.5 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 shadow-sm transition-all duration-200 ${internalCalculatingDuration ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                              <span className="block truncate">
                                {selectedExistingAudio
                                  ? existingAudioFiles.find(f => f.path === selectedExistingAudio)?.name
                                  : <span className="italic text-text-muted">None - Upload New Audio</span>}
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
                              <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-card border border-white/[0.13] rounded-xl shadow-lg max-h-60 overflow-auto focus:outline-none">
                                {/* None option - allows user to upload without selecting existing audio */}
                                <Listbox.Option
                                  value=""
                                  className={({ active, selected }) =>
                                    `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${
                                      active ? 'bg-surface-card text-white' : 'text-text-secondary'
                                    } ${selected ? 'font-medium' : 'font-normal'}`
                                  }
                                >
                                  {({ selected }) => (
                                    <>
                                      <div className="flex flex-col">
                                        <span className={`text-sm italic ${selected ? 'font-medium text-text-secondary' : 'text-text-muted'}`}>
                                          None - Upload New Audio
                                        </span>
                                      </div>
                                      {selected && (
                                        <CheckCircle2 className="h-5 w-5 text-status-warning" />
                                      )}
                                    </>
                                  )}
                                </Listbox.Option>
                                
                                {existingAudioFiles.map((file) => (
                                  <Listbox.Option
                                    key={file.path}
                                    value={file.path}
                                    className={({ active, selected }) =>
                                      `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${
                                        active ? 'bg-surface-card text-white' : 'text-text-secondary'
                                      } ${selected ? 'font-medium' : 'font-normal'}`
                                    }
                                  >
                                    {({ selected }) => (
                                      <>
                                        <div className="flex flex-col">
                                          <span className={selected ? 'font-medium' : 'font-normal'}>
                                            {file.name}
                                          </span>
                                          {file.duration > 0 && (
                                            <span className="text-xs text-text-muted mt-0.5">
                                              {formatDuration(file.duration)}
                                            </span>
                                          )}
                                        </div>
                                        {selected && (
                                          <span className="text-status-warning">
                                            <CheckCircle2 className="h-5 w-5" />
                                          </span>
                                        )}
                                      </>
                                    )}
                                  </Listbox.Option>
                                ))}
                                {existingAudioFiles.length === 0 && (
                                  <div className="py-2 px-4 text-text-muted text-sm">
                                    No audio files available
                                  </div>
                                )}
                              </Listbox.Options>
                            </Transition>
                          </div>
                        )}
                      </Listbox>
                    )}
                  </div>

                  {/* Upload Single Audio File */}
                  <div className="space-y-2">
                    <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase block">Upload New Audio</label>
                    <button
                      type="button"
                      onClick={() => audioFileInputRef.current?.click()}
                      disabled={isUploading || internalCalculatingDuration}
                      className="w-full p-4 bg-surface-card hover:bg-surface-card border-2 border-white/[0.13] hover:border-accent rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Upload className="w-6 h-6 text-status-warning mx-auto mb-2" />
                      <div className="text-sm font-medium text-white">Upload Audio File</div>
                      <div className="text-xs text-text-muted mt-1">
                        Supported: MP3, WAV (Max {MAX_AUDIO_FILE_SIZE_MB}MB)
                      </div>
                    </button>
                  </div>

                  <input
                    ref={audioFileInputRef}
                    type="file"
                    accept=".mp3,.wav"
                    onChange={(e) => handleAudioFileUpload(e.target.files)}
                    className="hidden"
                  />

                  {isUploading && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-status-warning text-sm">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Uploading audio files... {uploadProgress}%
                      </div>
                      <div className="w-full bg-surface-card rounded-full h-2">
                        <div
                          className="bg-accent h-2 rounded-full transition-all"
                          style={{ width: `${uploadProgress}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {/* Selected Audio Display */}
                  <div className="bg-surface-card rounded-xl p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-5 h-5 text-green-400" />
                        <span className="text-sm font-medium text-white">
                          Audio Selected ({audioFiles.length} file{audioFiles.length !== 1 ? 's' : ''})
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={handleClearAudio}
                        className="text-text-muted hover:text-red-400 transition-colors"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>

                    {internalCalculatingDuration ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-status-warning text-sm">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Calculating audio duration...
                        </div>
                        <div className="text-xs text-text-muted">
                          This may take 1-3 minutes for large files
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="text-2xl font-bold text-white mb-2">
                          {formatDuration(audioFiles.reduce((sum, f) => sum + f.duration, 0))}
                        </div>
                        <div className="text-xs text-text-muted">
                          Total duration: {Math.round(audioFiles.reduce((sum, f) => sum + f.duration, 0))} seconds
                        </div>

                        {/* Audio Files List */}
                        <div className="mt-3 space-y-1 max-h-32 overflow-y-auto">
                          {audioFiles.map((file, index) => (
                            <div key={index} className="text-xs text-text-muted flex justify-between">
                              <span className="truncate">{file.name}</span>
                              <span className="ml-2">{formatDuration(file.duration)}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Distribution Type Selector - Show for both Image Generator and Video Generator */}
                  {((audioFiles.length > 0 && !internalCalculatingDuration) || (isVideoGenerator && calculatedAudioDuration && calculatedAudioDuration > 0)) && (
                    <div className="space-y-4">
                      <div>
                        <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-3 block">
                          Distribution Type
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                          <button
                            type="button"
                            onClick={() => onAudioDistributionTypeChange('consistent')}
                            className={`p-3 rounded-xl border-2 transition-all ${
                              audioDistributionType === 'consistent'
                                ? 'border-green-800/70 bg-green-900/30'
                                : 'border-border-card bg-surface-card hover:border-white/20'
                            }`}
                          >
                            <div className="font-medium text-white text-sm">Consistent Distribution</div>
                            <div className="text-xs text-text-muted mt-1">Even throughout</div>
                          </button>
                          <button
                            type="button"
                            onClick={() => onAudioDistributionTypeChange('variable')}
                            className={`p-3 rounded-xl border-2 transition-all ${
                              audioDistributionType === 'variable'
                                ? 'border-green-800/70 bg-green-900/30'
                                : 'border-border-card bg-surface-card hover:border-white/20'
                            }`}
                          >
                            <div className="font-medium text-white text-sm">Variable Distribution</div>
                            <div className="text-xs text-text-muted mt-1">Different for first/rest</div>
                          </button>
                        </div>
                      </div>

                      {/* Consistent Distribution - Single Image Amount Input */}
                      {audioDistributionType === 'consistent' && (
                        <div>
                          <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                            Number of Images
                          </label>
                          <div className="dash-info-box p-2 mb-3 flex gap-2">
                            <Info className="w-4 h-4 dash-box-icon flex-shrink-0 mt-0.5" />
                            <div className="text-xs dash-box-text">
                              Specify exactly how many images you want generated for this audio duration. 
                              Range: {getAudioImageLimits().min}-{getAudioImageLimits().max} images 
                              (min {MIN_FREQUENCY_SECONDS}s per image, max {MAX_FREQUENCY_SECONDS / 60} min per image).
                            </div>
                          </div>
                          <input
                            type="text"
                            value={imageAmount}
                            onChange={(e) => onImageAmountChange(e.target.value)}
                            placeholder={`Enter number of images (${getAudioImageLimits().min}-${getAudioImageLimits().max})`}
                            className="w-full px-4 py-2 bg-surface-input border border-white/[0.13] rounded-xl text-white/90 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                          {(() => {
                            const limits = getAudioImageLimits();
                            if (imageAmount.trim() !== '' && !isValidNumericInput(imageAmount)) {
                              return null;
                            }
                            const parsedAmount = parseInt(imageAmount);
                            if (imageAmount.trim() !== '' && !isNaN(parsedAmount) && parsedAmount >= limits.min && parsedAmount <= limits.max) {
                              return (
                                <div className="text-xs text-text-muted mt-2">
                                  Average time per image: <strong className="text-white">
                                    {(audioFiles.reduce((sum, f) => sum + f.duration, 0) / parsedAmount).toFixed(1)}s
                                  </strong>
                                </div>
                              );
                            }
                            return null;
                          })()}
                        </div>
                      )}

                      {/* Variable Distribution - Separate First Page & Rest Inputs */}
                      {audioDistributionType === 'variable' && (
                        <div className="space-y-4">
                          {(() => {
                            const limits = getAudioVariableDistributionLimits();
                            const errors = validateAudioVariableDistribution();
                            const firstCount = isValidNumericInput(audioFirstPageImageCount) ? parseInt(audioFirstPageImageCount) : 0;
                            const restCount = isValidNumericInput(audioRestImageCount) ? parseInt(audioRestImageCount) : 0;
                            const totalImages = firstCount + restCount;
                            const firstAvg = limits.firstPageDuration / (firstCount || 1);
                            const restAvg = limits.restDuration > 0 ? limits.restDuration / (restCount || 1) : 0;
                            
                            return (
                              <>
                                {/* Info Box */}
                                <div className="dash-info-box p-2 flex gap-2">
                                  <Info className="w-4 h-4 dash-box-icon flex-shrink-0 mt-0.5" />
                                  <div className="text-xs dash-box-text">
                                    The first ~{Math.round(limits.firstPageDuration)}s (about 6 minutes) can have a different image density than the rest of the audio.
                                    Rest duration: {Math.round(limits.restDuration)}s
                                  </div>
                                </div>

                                {/* First Page Image Count */}
                                <div>
                                  <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                                    First Page Images
                                  </label>
                                  <input
                                    type="text"
                                    value={audioFirstPageImageCount}
                                    onChange={(e) => onAudioFirstPageImageCountChange(e.target.value)}
                                    placeholder="Enter number of images"
                                    className="w-full px-4 py-2 bg-surface-input border border-white/[0.13] rounded-xl text-white/90 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                  />
                                  {audioFirstPageImageCount.trim() !== '' && isValidNumericInput(audioFirstPageImageCount) && parseInt(audioFirstPageImageCount) > 0 && !errors.first ? (
                                    <div className="text-xs text-text-muted mt-2">
                                      Average time per image: <strong className="text-white">{firstAvg.toFixed(1)}s</strong>
                                    </div>
                                  ) : null}
                                </div>

                                {/* Rest Images Count */}
                                {limits.restDuration > 0 && (
                                  <div>
                                    <label className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2 block">
                                      Rest of Story Images
                                    </label>
                                    <input
                                      type="text"
                                      value={audioRestImageCount}
                                      onChange={(e) => onAudioRestImageCountChange(e.target.value)}
                                      placeholder="Enter number of images"
                                      className="w-full px-4 py-2 bg-surface-input border border-white/[0.13] rounded-xl text-white/90 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 transition duration-150 ease-in-out [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                    />
                                    {audioRestImageCount.trim() !== '' && isValidNumericInput(audioRestImageCount) && parseInt(audioRestImageCount) > 0 && !errors.rest ? (
                                      <div className="text-xs text-text-muted mt-2">
                                        Average time per image: <strong className="text-white">{restAvg.toFixed(1)}s</strong>
                                      </div>
                                    ) : null}
                                  </div>
                                )}

                                {/* Total Summary */}
                                {audioFirstPageImageCount.trim() !== '' && audioRestImageCount.trim() !== '' && 
                                 isValidNumericInput(audioFirstPageImageCount) && parseInt(audioFirstPageImageCount) > 0 && isValidNumericInput(audioRestImageCount) && parseInt(audioRestImageCount) > 0 && !errors.first && !errors.rest && (
                                  <div className="bg-surface-card rounded-xl p-3">
                                    <div className="text-sm font-medium text-white mb-2">Calculated Distribution</div>
                                    <div className="text-xs text-text-secondary space-y-1">
                                      <div>First page: <strong>{parseInt(audioFirstPageImageCount)}</strong> images (avg <strong>{firstAvg.toFixed(1)}s</strong> per image)</div>
                                      <div>Rest: <strong>{parseInt(audioRestImageCount)}</strong> images (avg <strong>{restAvg.toFixed(1)}s</strong> per image)</div>
                                      <div className="pt-1 border-t border-white/[0.13] mt-2">
                                        Total images: <strong className="text-white">{totalImages}</strong>
                                      </div>
                                    </div>
                                  </div>
                                )}

                              </>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* Error Display */}
          {audioError && (
            <div className="bg-yellow-900/20 border border-yellow-500/50 rounded-xl p-3 flex gap-2">
              <AlertCircle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-yellow-200">{audioError}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


