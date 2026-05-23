import { useState, useCallback } from 'react';

export type GenerationState = 'idle' | 'analyzing' | 'analyzed' | 'generating' | 'complete' | 'error';

export interface BatchStatus {
  id: string;
  label: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
  progress: number;
}

export function useVideoGenerationState() {
  const [generationState, setGenerationState] = useState<GenerationState>('idle');
  const [progress, setProgress] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const [batchStatuses, setBatchStatuses] = useState<BatchStatus[]>([]);
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Story data
  const [story, setStory] = useState<string>('');
  const [storyTaskId, setStoryTaskId] = useState<string | null>(null);
  
  // Image prompts data
  const [imagePrompts, setImagePrompts] = useState<any[]>([]);
  const [imagePromptTaskId, setImagePromptTaskId] = useState<string | null>(null);
  
  // Audio data
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioTaskId, setAudioTaskId] = useState<string | null>(null);
  
  // Final video
  const [finalVideoUrl, setFinalVideoUrl] = useState<string | null>(null);

  /**
   * Reset all state to defaults
   */
  const resetState = useCallback(() => {
    setGenerationState('idle');
    setProgress(0);
    setStatusMessage('');
    setTimeRemaining(null);
    setBatchStatuses([]);
    setCurrentGroupId(null);
    setError(null);
    setStory('');
    setStoryTaskId(null);
    setImagePrompts([]);
    setImagePromptTaskId(null);
    setAudioUrl(null);
    setAudioTaskId(null);
    setFinalVideoUrl(null);
  }, []);

  /**
   * Start a new generation
   */
  const startGeneration = useCallback((groupId: string) => {
    setGenerationState('generating');
    setCurrentGroupId(groupId);
    setProgress(0);
    setError(null);
  }, []);

  /**
   * Complete generation
   */
  const completeGeneration = useCallback(() => {
    setGenerationState('complete');
    setProgress(100);
    setStatusMessage('Generation complete');
    setTimeRemaining(null);
  }, []);

  /**
   * Set error state
   */
  const setErrorState = useCallback((errorMessage: string) => {
    setGenerationState('error');
    setError(errorMessage);
    setStatusMessage('Generation failed');
  }, []);

  /**
   * Update batch status
   */
  const updateBatchStatus = useCallback((batchId: string, updates: Partial<BatchStatus>) => {
    setBatchStatuses(prev => 
      prev.map(batch => 
        batch.id === batchId ? { ...batch, ...updates } : batch
      )
    );
  }, []);

  /**
   * Initialize batch statuses based on settings
   */
  const initializeBatchStatuses = useCallback((phases: Array<{
    id: string;
    label: string;
    status: 'pending' | 'processing' | 'complete';
    progress: number;
  }>) => {
    setBatchStatuses(phases);
  }, []);

  return {
    // State
    generationState,
    progress,
    statusMessage,
    timeRemaining,
    batchStatuses,
    currentGroupId,
    error,
    story,
    storyTaskId,
    imagePrompts,
    imagePromptTaskId,
    audioUrl,
    audioTaskId,
    finalVideoUrl,

    // Setters
    setGenerationState,
    setProgress,
    setStatusMessage,
    setTimeRemaining,
    setBatchStatuses,
    setCurrentGroupId,
    setError,
    setStory,
    setStoryTaskId,
    setImagePrompts,
    setImagePromptTaskId,
    setAudioUrl,
    setAudioTaskId,
    setFinalVideoUrl,

    // Actions
    resetState,
    startGeneration,
    completeGeneration,
    setErrorState,
    updateBatchStatus,
    initializeBatchStatuses,
  };
}
