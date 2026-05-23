import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileText, RefreshCw, X, CheckCircle2, AlertCircle, Calendar, ChevronDown, ArrowUpDown, Download, Square, Lock } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import DashboardLayout from '../components/DashboardLayout';
import { sanitizeFileName } from '../utils/videoGeneratorUtils';
import { Listbox, Transition } from '@headlessui/react';
import { useStorageCalculation } from '../hooks/useStorageCalculation';
import { getStorageLimitGB } from '../utils/storageHelpers';
import { useIsLegacyPlan } from '../hooks/useIsLegacyPlan';
import { getPlanMaxTokens } from '../data/planMaxTokens';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

interface VideoDocument {
  id: string;
  title: string;
  created_at: string;
  file_path: string;
  file_size?: number | null;
  group_id: string;
  description?: string;
  word_count?: number;
  version?: number;
  variant?: number;
  is_corrected?: boolean;
  is_prompted?: boolean;
}

interface UploadProgress {
  totalFiles: number;
  completedFiles: number;
  currentFile: string;
  isUploading: boolean;
  errors: string[];
}

interface CombiningProgress {
  percentage: number;
  isActive: boolean;
  startTime: number;
}

const MAX_FILE_SIZE_GB = 5;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_GB * 1024 * 1024 * 1024;
const OPERATION_TIMEOUT = 3600000;
const RETRY_DELAY = 2000;
const MAX_RETRIES = 10;
const COMBINING_DURATION = 10 * 60 * 1000; // 10 minutes in milliseconds

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
void planMaxTokens;

// Utility functions
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

const validateVideoFileName = (fileName: string): string | null => {
  // Remove .mp4 extension for validation
  const nameWithoutExtension = fileName.replace(/\.mp4$/i, '');
  
  // Check for invalid characters that would cause issues with MP4 files
  const validFileNameRegex = /^[a-zA-Z0-9\s\-_.]+$/;
  if (!validFileNameRegex.test(nameWithoutExtension)) {
    const invalidChars = nameWithoutExtension
      .split('')
      .filter(char => !/[a-zA-Z0-9\s\-_.]/.test(char))
      .join(', ');
    return `Video name contains invalid characters: ${invalidChars}. Only alphanumeric characters, spaces, hyphens, underscores, and dots are allowed.`;
  }
  
  // Check for reserved names and problematic patterns
  const reservedNames = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];
  if (reservedNames.includes(nameWithoutExtension.toUpperCase())) {
    return `"${nameWithoutExtension}" is a reserved name and cannot be used for video files.`;
  }
  
  // Check length
  if (nameWithoutExtension.length === 0) {
    return 'Video name cannot be empty.';
  }
  
  if (nameWithoutExtension.length > 100) {
    return 'Video name is too long. Maximum 100 characters allowed.';
  }
  
  return null;
};

const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Operation "${operation}" timed out after ${timeoutMs / 1000} seconds`)), timeoutMs);
    }),
  ]);
};

const withRetry = async <T extends unknown>(operation: () => Promise<T>, operationName: string, maxRetries: number = MAX_RETRIES): Promise<T> => {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      if ((error.message.includes('Failed to fetch') || error.status === 500 || error.message.includes('timeout') || error.message.includes('429') || error.message.includes('503')) && attempt < maxRetries) {
        const delay = RETRY_DELAY * Math.pow(1.5, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error(`Failed to complete ${operationName} after ${maxRetries} attempts: ${lastError.message}`);
};

// Silent retry function specifically for downloads
const withSilentRetry = async <T extends unknown>(operation: () => Promise<T>, operationName: string, maxRetries: number = MAX_RETRIES): Promise<T> => {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      console.log(`${operationName} attempt ${attempt} failed:`, error.message);
      
      if ((error.message.includes('Failed to fetch') || error.status === 500 || error.message.includes('timeout') || error.message.includes('429') || error.message.includes('503')) && attempt < maxRetries) {
        const delay = RETRY_DELAY * Math.pow(1.5, attempt - 1);
        console.log(`Retrying ${operationName} in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error(`Failed to complete ${operationName} after ${maxRetries} attempts: ${lastError.message}`);
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

export default function CombineVideo() {
  const navigate = useNavigate();
  const { isLegacy } = useIsLegacyPlan();
  const [documents, setDocuments] = useState<VideoDocument[]>([]);
  const [selectedVideos, setSelectedVideos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [combining, setCombining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [videoOrder, setVideoOrder] = useState<string[]>([]);
  const [userTokenBalance, setUserTokenBalance] = useState(400000);
  const [userPlan, setUserPlan] = useState<string>('free');
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [combiningProgress, setCombiningProgress] = useState<CombiningProgress>({
    percentage: 0,
    isActive: false,
    startTime: 0
  });
  const [combiningInterval, setCombiningInterval] = useState<NodeJS.Timeout | null>(null);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  
  // Video naming workflow
  const [showNamingStep, setShowNamingStep] = useState(false);
  const [videoName, setVideoName] = useState('');
  const [videoNameError, setVideoNameError] = useState<string | null>(null);
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(null);
  const [combiningComplete, setCombiningComplete] = useState(false);

  // Simplified upload state
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({
    totalFiles: 0,
    completedFiles: 0,
    currentFile: '',
    isUploading: false,
    errors: []
  });

  const { storageUsed, calculateStorageUsed } = useStorageCalculation();
  
  // Calculate max storage based on user plan
  const maxStorageGB = getStorageLimitGB(userPlan);

  useEffect(() => {
    const fetchUserAndDocuments = async () => {
      try {
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
          // Silent authentication error - only log to console
          console.error('Authentication error:', authError);
          setLoading(false);
          return;
        }

        setUserId(user.id);

        // Fetch plan and documents in parallel
        const [planResult, docsResult] = await Promise.all([
          supabase
            .from('user_plans')
            .select('plan_type, tokens_used, rollover_tokens')
            .eq('user_id', user.id)
            .eq('is_active', true)
            .single(),
          supabase
            .from('story_documents')
            .select('id, title, created_at, file_path, file_size, group_id, description, word_count, version, variant, is_corrected, is_prompted')
            .eq('user_id', user.id)
            .like('file_path', '%videos/%')
            .order('created_at', { ascending: false }),
          calculateStorageUsed(user.id),
        ]);

        const { data: planData, error: planError } = planResult;
        if (planError) console.warn('Could not fetch plan:', planError);
        if (planData) {
          const planType = planData.plan_type || 'free';
          setUserPlan(planType);
          setUserTokenBalance(getPlanMaxTokens(planType, isLegacy) - (planData.tokens_used || 0) + (planData.rollover_tokens || 0));
        }

        const { data, error: fetchError } = docsResult;
        if (fetchError) throw fetchError;
        setDocuments(data || []);

      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchUserAndDocuments();
  }, [calculateStorageUsed]);

  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      if (combiningInterval) {
        clearInterval(combiningInterval);
      }
    };
  }, [combiningInterval]);

  const handleCombineVideosClick = () => {
    setShowNamingStep(true);
    setVideoName('');
    setVideoNameError(null);
  };

  const validateVideoName = (name: string): string | null => {
    if (!name.trim()) {
      return 'Video name is required';
    }
    
    return validateVideoFileName(name);
  };

  const handleVideoNameSubmit = () => {
    const error = validateVideoName(videoName);
    if (error) {
      setVideoNameError(error);
      return;
    }
    
    // Generate unique group_id for this combination
    const uniqueGroupId = crypto.randomUUID();
    setCurrentGroupId(uniqueGroupId);
    setVideoNameError(null);
    setShowNamingStep(false);
  };

  const validateFilesForUpload = (files: File[]): { valid: File[], errors: string[] } => {
    const valid: File[] = [];
    const errors: string[] = [];

    const maxStorageBytes = maxStorageGB * 1024 * 1024 * 1024;
    // Check current storage
    const currentStorageBytes = (storageUsed || 0) * 1024 * 1024; // Convert MB to bytes
    let totalNewSize = 0;
    
    for (const file of files) {
      // Validate file type
      if (file.type !== 'video/mp4' && !file.name.endsWith('.mp4')) {
        errors.push(`${file.name}: Must be a valid .mp4 file`);
        continue;
      }

      // Validate file name
      const fileNameError = validateFileName(file.name);
      if (fileNameError) {
        errors.push(`${file.name}: ${fileNameError}`);
        continue;
      }

      // Validate individual file size
      if (file.size > MAX_FILE_SIZE_BYTES) {
        errors.push(`${file.name}: File size exceeds limit. Maximum allowed: ${MAX_FILE_SIZE_GB} GB`);
        continue;
      }

      // Check if adding this file would exceed storage limit
      if (currentStorageBytes + totalNewSize + file.size > maxStorageBytes) {
        const remainingStorage = maxStorageBytes - currentStorageBytes - totalNewSize;
        const remainingGB = (remainingStorage / (1024 * 1024 * 1024)).toFixed(2);
        errors.push(`${file.name}: Would exceed storage limit. Only ${remainingGB} GB remaining`);
        continue;
      }

      totalNewSize += file.size;
      valid.push(file);
    }
    
    return { valid, errors };
  };

  // SIMPLIFIED: Handle multiple file upload
  const handleMultipleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    if (!currentGroupId) {
      setError('Please set a video name first by clicking "Combine Videos"');
      return;
    }

    if (!userId) {
      setError('User not authenticated. Please refresh the page and try again.');
      return;
    }

    const fileArray = Array.from(files);
    const { valid, errors } = validateFilesForUpload(fileArray);

    if (errors.length > 0) {
      setError(`Upload validation errors:\n${errors.join('\n')}`);
      return;
    }

    if (valid.length === 0) {
      setError('No valid files to upload');
      return;
    }

    // Start upload process
    setUploadProgress({
      totalFiles: valid.length,
      completedFiles: 0,
      currentFile: valid[0].name,
      isUploading: true,
      errors: []
    });
    setError(null);

    // Upload all files
    for (let i = 0; i < valid.length; i++) {
      const file = valid[i];
      
      try {
        setUploadProgress(prev => ({
          ...prev,
          currentFile: file.name,
          completedFiles: i
        }));

        await uploadSingleFile(file);
        
        setUploadProgress(prev => ({
          ...prev,
          completedFiles: i + 1
        }));

      } catch (error: any) {
        console.error(`Failed to upload ${file.name}:`, error);
        setUploadProgress(prev => ({
          ...prev,
          errors: [...prev.errors, `${file.name}: ${error.message}`]
        }));
      }
    }

    // Finish upload process
    setUploadProgress(prev => ({
      ...prev,
      isUploading: false,
      currentFile: ''
    }));

    // Refresh documents list
    await refreshDocuments();

    // Clear progress after a delay
    setTimeout(() => {
      setUploadProgress({
        totalFiles: 0,
        completedFiles: 0,
        currentFile: '',
        isUploading: false,
        errors: []
      });
    }, 3000);
  };

  const uploadSingleFile = async (file: File) => {
    if (!userId || !currentGroupId) {
      throw new Error('Missing user ID or group ID');
    }

    // Generate file path
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${file.name.replace(/\s+/g, '-')}_${timestamp}.mp4`;
    const filePath = `videos/${userId}/${currentGroupId}/${fileName}`;

    // Upload file to storage
    const { error: uploadError } = await supabase.storage
      .from('videos')
      .upload(filePath, file, {
        contentType: 'video/mp4',
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Failed to upload file: ${uploadError.message}`);
    }

    // Insert into story_documents table
    const { error: insertError } = await supabase
      .from('story_documents')
      .insert({
        id: crypto.randomUUID(),
        user_id: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        file_path: filePath,
        title: videoName,
        description: file.name,
        file_size: file.size,
        group_id: currentGroupId,
        version: 11,
        variant: 1,
        is_corrected: false,
        is_prompted: false,
        word_count: 0,
      });

    if (insertError) {
      // Cleanup on failure
      await supabase.storage.from('videos').remove([filePath]);
      throw new Error(`Failed to save document metadata: ${insertError.message}`);
    }
  };

  const refreshDocuments = async () => {
    if (!userId) return;

    try {
      const { data, error } = await supabase
        .from('story_documents')
        .select('id, title, created_at, file_path, file_size, group_id, description, word_count, version, variant, is_corrected, is_prompted')
        .eq('user_id', userId)
        .like('file_path', '%videos/%')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setDocuments(data || []);
      await calculateStorageUsed(userId);
    } catch (err: any) {
      console.error('Error refreshing documents:', err);
    }
  };

  const handleAddVideo = (id: string) => {
    if (!selectedVideos.includes(id)) {
      setSelectedVideos(prev => [...prev, id]);
      setVideoOrder(prev => [...prev, id]);
    }
  };

  const moveVideo = (fromIndex: number, toIndex: number) => {
    const newOrder = [...videoOrder];
    const [moved] = newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, moved);
    setVideoOrder(newOrder);
  };

  const removeVideo = (id: string) => {
    setSelectedVideos(prev => prev.filter(v => v !== id));
    setVideoOrder(prev => prev.filter(v => v !== id));
  };

  const startCombiningProgress = () => {
    const startTime = Date.now();
    setCombiningProgress({
      percentage: 0,
      isActive: true,
      startTime
    });

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const percentage = Math.min((elapsed / COMBINING_DURATION) * 100, 100);
      
      setCombiningProgress(prev => ({
        ...prev,
        percentage: Math.round(percentage)
      }));

      if (percentage >= 100) {
        clearInterval(interval);
        setCombiningInterval(null);
      }
    }, 1000);

    setCombiningInterval(interval);
  };

  const stopCombining = () => {
    if (abortController) {
      abortController.abort();
    }
    
    if (combiningInterval) {
      clearInterval(combiningInterval);
      setCombiningInterval(null);
    }
    
    setCombining(false);
    setCombiningProgress({
      percentage: 0,
      isActive: false,
      startTime: 0
    });
    setCombiningComplete(false);
    setError('Video combining was stopped by user');
  };

  const handleCombine = async () => {
    if (videoOrder.length < 2) {
      setError('Select at least two videos to combine');
      return;
    }
    
    setCombining(true);
    setCombiningComplete(false);
    setError(null);
    setOutputUrl(null);
    
    const controller = new AbortController();
    setAbortController(controller);
    startCombiningProgress();
    
    try {
      const orderedPaths = videoOrder
        .map(id => {
          const doc = documents.find(d => d.id === id);
          return doc ? doc.file_path : '';
        })
        .filter(path => path);

      const { data: { session: _cvSession } } = await supabase.auth.getSession();
      const response = await withSilentRetry(
        () => fetch('https://us-central1-story-script-ai.cloudfunctions.net/video-concat', {
          method: 'POST',
          mode: 'cors',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_cvSession?.access_token || ''}`,
            'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ 
            files: orderedPaths, 
            user_id: userId,
            video_name: videoName
          }),
          signal: controller.signal
        }),
        'video combining'
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`API error: ${errorData.error || response.statusText}`);
      }
      
      const data = await response.json();
      
      if (combiningInterval) {
        clearInterval(combiningInterval);
        setCombiningInterval(null);
      }
      
      setCombiningProgress(prev => ({
        ...prev,
        percentage: 100,
        isActive: false
      }));
      
      setOutputUrl(data.url);
      setCombiningComplete(true);
      
    } catch (err: any) {
      if (combiningInterval) {
        clearInterval(combiningInterval);
        setCombiningInterval(null);
      }
      
      setCombiningProgress({
        percentage: 0,
        isActive: false,
        startTime: 0
      });

      if (err.name === 'AbortError') {
        setError('Video combining was cancelled');
      } else if (err.message.includes('CORS') || err.message.includes('Failed to fetch')) {
        setError('Network error: Unable to connect to video processing service. This may be a temporary issue - please try again.');
      } else {
        setError(err.message || 'Failed to combine videos');
      }
    } finally {
      setCombining(false);
      setAbortController(null);
    }
  };

  const handleDownload = async () => {
    if (!outputUrl) return;
    
    setDownloadLoading(true);
    
    try {
      if (!currentGroupId || !userId) {
        console.error('Missing required information for download');
        return;
      }
  
      const { data: recentDocs, error: fetchError } = await withSilentRetry(
        () => supabase
          .from('story_documents')
          .select('file_path, title, description')
          .eq('user_id', userId)
          .eq('group_id', currentGroupId)
          .eq('description', 'Final Video')
          .order('created_at', { ascending: false })
          .limit(1),
        'fetch combined video document'
      );
  
      if (fetchError || !recentDocs || recentDocs.length === 0) {
        console.error('Could not find the combined video file:', fetchError);
        return;
      }
  
      const combinedVideoDoc = recentDocs[0];
  
      const { data: signedUrlData, error: signedUrlError } = await withSilentRetry(
        () => supabase
          .storage
          .from('videos')
          .createSignedUrl(combinedVideoDoc.file_path, 60),
        'generate signed URL'
      );
  
      if (signedUrlError) {
        console.error('Failed to generate signed URL:', signedUrlError);
        return;
      }
  
      const response = await withSilentRetry(
        () => fetch(signedUrlData.signedUrl),
        'fetch video file'
      );
      
      if (!response.ok) {
        console.error('Failed to fetch video file, response not ok');
        return;
      }
  
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = `${sanitizeFileName(videoName)}.mp4`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error('Error downloading video:', err);
      // No user-facing error, just console logging
    } finally {
      setDownloadLoading(false);
    }
  };

  const reset = () => {
    if (combining) {
      stopCombining();
    }
    
    setSelectedVideos([]);
    setVideoOrder([]);
    setOutputUrl(null);
    setShowNamingStep(false);
    setVideoName('');
    setVideoNameError(null);
    setCurrentGroupId(null);
    setCombiningComplete(false);
    setCombiningProgress({
      percentage: 0,
      isActive: false,
      startTime: 0
    });
    setDownloadLoading(false);
    setUploadProgress({
      totalFiles: 0,
      completedFiles: 0,
      currentFile: '',
      isUploading: false,
      errors: []
    });
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const formatSize = (size: number) => {
    const gb = size / (1024 * 1024 * 1024);
    return gb.toFixed(2) + ' GB';
  };

  const canCombineVideos = !uploadProgress.isUploading && videoOrder.length >= 2;

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
                <p className="text-sm text-text-muted mb-6 leading-relaxed">Combine Videos requires a Standard plan or higher. Upgrade to unlock video tools and more.</p>
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
              <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Combine Videos</h1>
              <div className="mt-2">
                <p className="text-text-secondary">Select or upload MP4 videos and concatenate them</p>
                <p className="text-text-muted text-sm mt-1">{formatNumber(userTokenBalance)} tokens remaining</p>
                <p className="text-text-muted text-sm mt-0.5">
                  Storage: {storageUsed !== null ? `${formatStorageSize(storageUsed)} / ${maxStorageGB} GB` : 'Calculating...'}
                </p>
              </div>

              {/* What to Expect info box */}
              <div className="mt-5 p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card dash-animate-in">
                <h3 className="text-xl font-semibold mb-2 text-accent">What to Expect</h3>
                <p className="text-[15px] text-white/80 leading-relaxed">
                  The Combine Videos feature allows you to concatenate multiple MP4 videos into a single file. First, click "Combine Videos" and choose a name for your final video. Then select existing videos from your library or upload new ones, arrange them in your desired order, and create a seamless combined video.
                </p>
                <div className="mt-4 pt-4 border-t border-white/10">
                  <div className="flex items-start gap-2 p-3 bg-[var(--color-status-warning-bg)] border border-[var(--color-status-warning-border)] rounded-xl">
                    <AlertCircle className="h-5 w-5 text-status-warning flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm text-status-warning-text font-medium">Note</p>
                      <p className="text-xs text-status-warning-text mt-1 opacity-80">
                        Combining videos costs 50,000 tokens per operation.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {error && (
              <div className="p-5 rounded-2xl bg-[var(--color-status-error-bg)] border border-[var(--color-status-error-border)] mb-6 dash-animate-in">
                <div className="flex items-center space-x-3">
                  <div className="flex-shrink-0 h-10 w-10 rounded-full bg-status-error/20 flex items-center justify-center">
                    <AlertCircle className="h-5 w-5 text-status-error" />
                  </div>
                  <div>
                    <h3 className="text-lg font-display font-semibold text-status-error">Error</h3>
                    <p className="text-sm mt-0.5 text-white/80 whitespace-pre-line">{error}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Video Naming Step */}
            {showNamingStep && (
              <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-6 mb-6 dash-animate-in">
                <h2 className="text-xl font-display font-semibold text-white mb-4">Name Your Combined Video</h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-text-muted mb-2">
                      Video Name (without .mp4 extension)
                    </label>
                    <input
                      type="text"
                      value={videoName}
                      onChange={(e) => {
                        setVideoName(e.target.value);
                        if (videoNameError) {
                          const error = validateVideoName(e.target.value);
                          setVideoNameError(error);
                        }
                      }}
                      onBlur={() => {
                        const error = validateVideoName(videoName);
                        setVideoNameError(error);
                      }}
                      className={`w-full bg-surface-input border rounded-xl px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                        videoNameError ? 'border-accent-text' : 'border-border-card'
                      }`}
                      placeholder="Enter video name (e.g., My Combined Video)"
                    />
                    {videoNameError && (
                      <div className="mt-1 flex items-center gap-1 text-status-error text-sm">
                        <AlertCircle className="h-4 w-4" />
                        <span>{videoNameError}</span>
                      </div>
                    )}
                    <p className="mt-1 text-sm text-text-dim">
                      This will be the title of your final combined video. Only alphanumeric characters, spaces, hyphens, underscores, and dots are allowed.
                    </p>
                  </div>
                  <div className="flex space-x-4">
                    <button
                      onClick={() => {
                        setShowNamingStep(false);
                        setVideoName('');
                        setVideoNameError(null);
                      }}
                      className="px-4 py-2.5 bg-surface-elevated text-white rounded-xl hover:bg-surface-elevated/80 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleVideoNameSubmit}
                      disabled={!videoName.trim() || !!videoNameError}
                      className="px-4 py-2.5 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      Continue
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Upload Progress Display */}
            {uploadProgress.isUploading && (
              <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-4 mb-6 dash-animate-in">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-white">
                    Uploading: {uploadProgress.currentFile}
                  </span>
                  <span className="text-sm text-text-dim">
                    {uploadProgress.completedFiles} of {uploadProgress.totalFiles} completed
                  </span>
                </div>
                <div className="w-full bg-surface-elevated rounded-full h-2">
                  <div 
                    className="h-2 rounded-full bg-accent transition-all duration-300"
                    style={{ 
                      width: `${uploadProgress.totalFiles > 0 ? (uploadProgress.completedFiles / uploadProgress.totalFiles) * 100 : 0}%` 
                    }}
                  ></div>
                </div>
                <p className="text-xs text-text-dim mt-1">
                  Uploading files to storage...
                </p>
              </div>
            )}

            {/* Show upload completion */}
            {!uploadProgress.isUploading && uploadProgress.totalFiles > 0 && (
              <div className="rounded-2xl bg-[var(--color-status-success-bg)] border border-[var(--color-status-success-border)] p-4 mb-6 dash-animate-in">
                <div className="flex items-center mb-2">
                  <CheckCircle2 className="h-5 w-5 text-status-success mr-2" />
                  <span className="text-sm font-medium text-white">
                    Upload Complete: {uploadProgress.completedFiles} of {uploadProgress.totalFiles} files uploaded
                  </span>
                </div>
                {uploadProgress.errors.length > 0 && (
                  <div className="mt-2">
                    <p className="text-sm text-status-error mb-1">Errors:</p>
                    {uploadProgress.errors.map((error, index) => (
                      <p key={index} className="text-xs text-status-error">• {error}</p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!outputUrl ? (
              <div className="space-y-6">
                {/* Combine Videos Button */}
                {!showNamingStep && !currentGroupId && (
                  <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-6 dash-animate-in">
                    <h2 className="text-xl font-display font-semibold text-white mb-4">Start Video Combination</h2>
                    <p className="text-text-secondary mb-4">
                      Click the button below to start combining videos. You'll first choose a name for your final video.
                    </p>
                    <button
                      onClick={handleCombineVideosClick}
                      className="flex items-center px-6 py-3 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors"
                    >
                      <ArrowUpDown className="h-5 w-5 mr-2" />
                      Combine Videos
                    </button>
                  </div>
                )}

                {/* Video Selection and Upload */}
                {currentGroupId && (
                  <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-6 dash-animate-in">
                    <h2 className="text-xl font-display font-semibold text-white mb-4">
                      Select Videos for: "{videoName}"
                    </h2>
                    
                    <div className="space-y-4">
                      <label className="block text-sm font-medium text-text-muted mb-2">
                        Available Videos
                      </label>
                      <div className="space-y-2">
                        {documents.map(doc => (
                          <div key={doc.id} className="flex items-center justify-between bg-surface-elevated p-3 rounded-xl">
                            <div className="flex flex-col">
                              <span className="text-sm text-white">{doc.description || doc.title}</span>
                              <span className="text-xs text-text-dim flex items-center">
                                <Calendar className="h-4 w-4 mr-1" />
                                {formatDate(doc.created_at)} • {doc.file_size ? formatSize(doc.file_size) : 'Unknown'}
                              </span>
                            </div>
                            <button
                              onClick={() => handleAddVideo(doc.id)}
                              disabled={selectedVideos.includes(doc.id)}
                              className="px-2 py-1 bg-accent text-white rounded text-xs disabled:opacity-50"
                            >
                              Add
                            </button>
                          </div>
                        ))}
                        {documents.length === 0 && <p className="text-text-dim">No videos available</p>}
                      </div>

                      <div className="relative mt-4">
                        <label className={`flex flex-col items-center justify-center w-full h-32 border-2 border-border-card border-dashed rounded-2xl cursor-pointer bg-surface-elevated hover:bg-surface-elevated/80 transition-colors ${uploadProgress.isUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                          <Upload className="w-8 h-8 mb-3 text-text-dim" />
                          <p className="mb-2 text-sm text-text-dim">
                            <span className="font-semibold">Click to upload</span> or drag and drop
                          </p>
                          <p className="text-xs text-text-dim">
                            MP4 files only (max {MAX_FILE_SIZE_GB} GB each)
                          </p>
                          <p className="text-xs text-text-muted mt-1">
                            Select multiple files to upload them all at once
                          </p>
                          <input
                            type="file"
                            className="hidden"
                            accept=".mp4"
                            multiple
                            disabled={uploadProgress.isUploading}
                            onChange={(e) => handleMultipleFileUpload(e.target.files)}
                          />
                        </label>
                      </div>
                    </div>

                    {selectedVideos.length > 0 && (
                      <div className="mt-6">
                        <h3 className="text-lg font-display font-semibold text-white mb-2">Selected Videos (Drag to reorder)</h3>
                        <div className="space-y-2">
                          {videoOrder.map((id, index) => {
                            const doc = documents.find(d => d.id === id);
                            return doc ? (
                              <div key={id} className="flex items-center justify-between bg-surface-elevated p-3 rounded-xl">
                                <div className="flex items-center gap-2">
                                  <div className="flex items-center justify-center w-6 h-6 bg-accent text-white text-sm font-bold rounded-full">
                                    {index + 1}
                                  </div>
                                  <span className="text-sm text-white">{doc.description || doc.title}</span>
                                </div>
                                <div className="flex gap-2">
                                  <button onClick={() => moveVideo(index, index - 1)} disabled={index === 0} className="text-text-dim disabled:opacity-50">
                                    ↑
                                  </button>
                                  <button onClick={() => moveVideo(index, index + 1)} disabled={index === videoOrder.length - 1} className="text-text-dim disabled:opacity-50">
                                    ↓
                                  </button>
                                  <button onClick={() => removeVideo(id)} className="text-status-error">
                                    <X className="h-4 w-4" />
                                  </button>
                                </div>
                              </div>
                            ) : null;
                          })}
                        </div>
                      </div>
                    )}

                    <div className="flex space-x-4 mt-6">
                      <button
                        onClick={reset}
                        className="flex items-center px-4 py-2.5 bg-surface-elevated text-white rounded-xl hover:bg-surface-elevated/80 transition-colors"
                      >
                        <X className="h-5 w-5 mr-2" />
                        Cancel
                      </button>
                      <button
                        onClick={handleCombine}
                        disabled={combining || !canCombineVideos}
                        className="flex-1 flex justify-center items-center px-4 py-2.5 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 transition-colors"
                      >
                        {combining ? (
                          <>
                            <RefreshCw className="animate-spin h-5 w-5 mr-2" />
                            Combining...
                          </>
                        ) : (
                          'Combine Videos'
                        )}
                      </button>
                    </div>

                    {/* Status message for combine button */}
                    {!canCombineVideos && videoOrder.length < 2 && !uploadProgress.isUploading && (
                      <p className="text-sm text-text-dim mt-2">
                        Select at least two videos to enable combining
                      </p>
                    )}
                    {!canCombineVideos && uploadProgress.isUploading && (
                      <p className="text-sm text-text-dim mt-2">
                        Wait for uploads to complete before combining
                      </p>
                    )}

                    {/* Combining Progress Display */}
                    {combiningProgress.isActive && (
                      <div className="rounded-2xl bg-surface-elevated border border-border-card p-4 mt-4 dash-animate-in">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-medium text-white">
                            Combining Videos...
                          </span>
                          <span className="text-sm text-text-dim">{combiningProgress.percentage}%</span>
                        </div>
                        <div className="w-full bg-surface-elevated rounded-full h-3">
                          <div 
                            className="h-3 rounded-full bg-accent transition-all duration-1000"
                            style={{ width: `${combiningProgress.percentage}%` }}
                          ></div>
                        </div>
                        <div className="flex justify-between items-center mt-3">
                          <p className="text-xs text-text-dim">
                            This process may take up to 10 minutes...
                          </p>
                          <button
                            onClick={stopCombining}
                            className="flex items-center px-3 py-1.5 bg-accent text-white text-sm rounded-xl hover:bg-accent-hover transition-colors"
                          >
                            <Square className="h-3 w-3 mr-1" />
                            Stop
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-6">
                {/* Success Message */}
                {combiningComplete && (
                  <div className="p-5 rounded-2xl bg-[var(--color-status-success-bg)] border border-[var(--color-status-success-border)] dash-animate-in">
                    <div className="flex items-center space-x-3">
                      <div className="flex-shrink-0 h-10 w-10 rounded-full bg-status-success/20 flex items-center justify-center">
                        <CheckCircle2 className="h-5 w-5 text-status-success" />
                      </div>
                      <div>
                        <h3 className="text-lg font-display font-semibold text-status-success">Video Combined Successfully!</h3>
                        <p className="text-sm mt-0.5 text-white/80">Your videos have been combined into a single file.</p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-6 dash-animate-in">
                  <h3 className="text-lg font-display font-semibold text-white mb-4">Combined Video: "{videoName}"</h3>
                  <video controls src={outputUrl} className="w-full rounded-xl mb-4" />
                  
                  <div className="flex space-x-4">
                    <button
                      onClick={handleDownload}
                      disabled={downloadLoading}
                      className="flex items-center px-6 py-3 bg-action-success text-white rounded-xl hover:bg-action-success-hover disabled:opacity-50 transition-colors"
                    >
                      {downloadLoading ? (
                        <>
                          <RefreshCw className="animate-spin h-5 w-5 mr-2" />
                          Downloading...
                        </>
                      ) : (
                        <>
                          <Download className="h-5 w-5 mr-2" />
                          Download
                        </>
                      )}
                    </button>
                    
                    <button
                      onClick={reset}
                      className="flex items-center px-6 py-3 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors"
                    >
                      <RefreshCw className="h-5 w-5 mr-2" />
                      Combine More Videos
                    </button>
                    
                    <button
                      onClick={reset}
                      className="flex items-center px-6 py-3 bg-surface-elevated text-white rounded-xl hover:bg-surface-elevated/80 transition-colors"
                    >
                      <CheckCircle2 className="h-5 w-5 mr-2" />
                      Done
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}



