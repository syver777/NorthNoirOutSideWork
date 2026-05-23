/**
 * Video Progress Calculator
 * 
 * This module calculates accurate real-time progress for video generation phases
 * by querying individual task tables directly (story_tasks, image_prompt_tasks, etc.)
 * instead of relying on aggregated progress fields in video_tasks table.
 * 
 * WHY: The video_tasks table stores aggregated progress values that can become stale
 * because pollers update React state but don't always update the database. By querying
 * the source task tables and calculating progress client-side using the same logic as
 * the pollers, we ensure the displayed progress is always accurate and up-to-date.
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

export interface BatchStatus {
  id: string;
  label: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
  progress: number;
}

export interface ProcessFlags {
  processStory?: boolean;
  processImages?: boolean;
  processAudio?: boolean;
  video?: boolean;
  useExistingStory?: boolean;
  useExistingImages?: boolean;
  useExistingAudio?: boolean;
  visualType?: 'image' | 'ttv' | 'itv' | 'mg';
}

interface ProgressResult {
  status: 'pending' | 'processing' | 'complete' | 'error';
  progress: number;
}

/**
 * Query story_tasks table and calculate progress
 * Formula: (completedCount + runningProgress/100) / totalBatches * 100
 */
async function queryStoryProgress(userId: string, groupId: string, tab: number, phaseStatus?: string): Promise<ProgressResult> {
  try {
    const { data: tasks, error } = await supabase
      .from('story_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('video_process', true)
      .order('batch_number', { ascending: true });

    if (error) {
      console.error('[queryStoryProgress] Error:', error);
      return { status: 'pending', progress: 0 };
    }

    if (!tasks || tasks.length === 0) {
      // If no tasks but phase status is completed, return 100%
      if (phaseStatus === 'completed') {
        return { status: 'complete', progress: 100 };
      }
      return { status: 'pending', progress: 0 };
    }

    const batchTasks = tasks.filter(t => t.batch_number > 0);
    const totalBatches = batchTasks[0]?.total_batches || batchTasks.length;

    // Count completed batches
    const completedCount = batchTasks.filter(t => 
      t.status === 'completed' || t.status === 'completed_final'
    ).length;

    // Find running task and get fractional progress
    const runningTask = batchTasks.find(t => 
      t.status === 'running' || t.status === 'processing'
    );
    const runningProgress = runningTask ? (runningTask.progress || 0) / 100 : 0;

    // Calculate total progress
    const progressPercentage = Math.min(100, 
      totalBatches > 0 ? ((completedCount + runningProgress) / totalBatches) * 100 : 0
    );

    // Determine status
    const errorTask = batchTasks.find(t => t.status === 'error');
    if (errorTask) {
      return { status: 'error', progress: Math.round(progressPercentage) };
    }

    if (completedCount === totalBatches) {
      return { status: 'complete', progress: 100 };
    }

    if (runningTask || completedCount > 0) {
      return { status: 'processing', progress: Math.round(progressPercentage) };
    }

    return { status: 'pending', progress: 0 };
  } catch (error) {
    console.error('[queryStoryProgress] Exception:', error);
    return { status: 'pending', progress: 0 };
  }
}

/**
 * Query image_prompt_tasks table and calculate progress
 * Formula: (completedCount + runningProgress/100) / totalBatches * 100
 */
async function queryImagePromptProgress(userId: string, groupId: string, tab: number, phaseStatus?: string): Promise<ProgressResult> {
  try {
    const { data: tasks, error } = await supabase
      .from('image_prompt_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('video_process', true)
      .order('batch_number', { ascending: true });

    if (error) {
      console.error('[queryImagePromptProgress] Error:', error);
      return { status: 'pending', progress: 0 };
    }

    if (!tasks || tasks.length === 0) {
      // If no tasks but phase status is completed, return 100%
      if (phaseStatus === 'completed') {
        return { status: 'complete', progress: 100 };
      }
      return { status: 'pending', progress: 0 };
    }

    const batchTasks = tasks.filter(t => t.batch_number > 0);
    const totalBatches = batchTasks[0]?.total_batches || batchTasks.length;

    // Count completed batches
    const completedCount = batchTasks.filter(t => 
      t.status === 'completed' || t.status === 'completed_final'
    ).length;

    // Find running task and get fractional progress
    const runningTask = batchTasks.find(t => 
      t.status === 'running' || t.status === 'processing'
    );
    const runningProgress = runningTask ? (runningTask.progress || 0) / 100 : 0;

    // Calculate total progress
    const progressPercentage = Math.min(100, 
      totalBatches > 0 ? ((completedCount + runningProgress) / totalBatches) * 100 : 0
    );

    console.log(`[queryImagePromptProgress] Progress calculation:`, {
      completedCount,
      runningProgress: runningProgress * 100,
      totalBatches,
      progressPercentage: Math.round(progressPercentage)
    });

    // Determine status
    const errorTask = batchTasks.find(t => t.status === 'error');
    if (errorTask) {
      return { status: 'error', progress: Math.round(progressPercentage) };
    }

    if (completedCount === totalBatches) {
      return { status: 'complete', progress: 100 };
    }

    if (runningTask || completedCount > 0) {
      return { status: 'processing', progress: Math.round(progressPercentage) };
    }

    return { status: 'pending', progress: 0 };
  } catch (error) {
    console.error('[queryImagePromptProgress] Exception:', error);
    return { status: 'pending', progress: 0 };
  }
}

/**
 * Query image_tasks table and calculate progress
 * Images use: (totalProgress / (totalBatches * 100)) * 100
 */
async function queryImageGenerationProgress(userId: string, groupId: string, tab: number, phaseStatus?: string): Promise<ProgressResult> {
  try {
    const { data: tasks, error } = await supabase
      .from('image_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('video_process', true)
      .order('batch_number', { ascending: true });

    if (error) {
      console.error('[queryImageGenerationProgress] Error:', error);
      return { status: 'pending', progress: 0 };
    }

    if (!tasks || tasks.length === 0) {
      // If no tasks but phase status is completed, return 100%
      if (phaseStatus === 'completed') {
        return { status: 'complete', progress: 100 };
      }
      return { status: 'pending', progress: 0 };
    }

    const batchTasks = tasks.filter(t => !t.single_image && t.batch_number > 0);
    const totalBatches = batchTasks[0]?.total_batches || batchTasks.length;
    
    // Sum up all progress values
    const totalProgress = batchTasks.reduce((sum, t) => sum + (t.progress || 0), 0);
    const progressPercent = Math.min(100, 
      totalBatches > 0 ? (totalProgress / (totalBatches * 100)) * 100 : 0
    );

    console.log(`[queryImageGenerationProgress] Progress: ${Math.round(progressPercent)}%`);

    // Determine status
    const errorTask = batchTasks.find(t => t.status === 'error');
    if (errorTask) {
      return { status: 'error', progress: Math.round(progressPercent) };
    }

    if (batchTasks.every(t => t.status === 'completed' || t.status === 'completed_final')) {
      return { status: 'complete', progress: 100 };
    }

    if (batchTasks.some(t => t.status === 'running' || t.status === 'processing') || totalProgress > 0) {
      return { status: 'processing', progress: Math.round(progressPercent) };
    }

    return { status: 'pending', progress: 0 };
  } catch (error) {
    console.error('[queryImageGenerationProgress] Exception:', error);
    return { status: 'pending', progress: 0 };
  }
}

/**
 * Query audio_tasks table and calculate progress
 * Formula: (completedCount + runningProgress/100) / totalBatches * 100
 */
async function queryAudioProgress(userId: string, groupId: string, tab: number, phaseStatus?: string): Promise<ProgressResult> {
  try {
    const { data: tasks, error } = await supabase
      .from('audio_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('video_process', true)
      .order('batch_number', { ascending: true });

    if (error) {
      console.error('[queryAudioProgress] Error:', error);
      return { status: 'pending', progress: 0 };
    }

    if (!tasks || tasks.length === 0) {
      // If no tasks but phase status is completed, return 100%
      if (phaseStatus === 'completed') {
        return { status: 'complete', progress: 100 };
      }
      return { status: 'pending', progress: 0 };
    }

    const batchTasks = tasks.filter(t => !t.single_audio);
    const totalBatches = batchTasks.length;

    // Count completed batches
    const completedCount = batchTasks.filter(t => 
      t.status === 'completed' || t.status === 'completed_final'
    ).length;

    // Find running task and get fractional progress
    const runningTask = batchTasks.find(t => 
      t.status === 'running' || t.status === 'processing'
    );
    const runningProgress = runningTask ? (runningTask.progress || 0) / 100 : 0;

    // Calculate total progress
    const progressPercent = Math.min(100, 
      totalBatches > 0 ? ((completedCount + runningProgress) / totalBatches) * 100 : 0
    );

    console.log(`[queryAudioProgress] Progress:`, {
      completedCount,
      runningProgress: runningProgress * 100,
      totalBatches,
      progressPercent: Math.round(progressPercent)
    });

    // Determine status
    const errorTask = batchTasks.find(t => t.status === 'error');
    if (errorTask) {
      return { status: 'error', progress: Math.round(progressPercent) };
    }

    if (batchTasks.every(t => t.status === 'completed' || t.status === 'completed_final')) {
      return { status: 'complete', progress: 100 };
    }

    if (runningTask || completedCount > 0) {
      return { status: 'processing', progress: Math.round(progressPercent) };
    }

    return { status: 'pending', progress: 0 };
  } catch (error) {
    console.error('[queryAudioProgress] Exception:', error);
    return { status: 'pending', progress: 0 };
  }
}

/**
 * Query video_tasks table for video creation + transitions and calculate progress
 * Handles both regular video processing and transition batch processing
 * 
 * STRATEGY: Count individual video batch rows (not aggregated progress fields)
 * - Query all video_tasks rows for this user/group
 * - Separate into: main task (no doc_id), video batches (with doc_id), transition batches
 * - Calculate progress: completed_batches / total_batches * 100
 * - Never show 100% until overall_status = 'completed_final'
 */
async function queryVideoProgress(userId: string, groupId: string, phaseStatus?: string): Promise<ProgressResult> {
  try {
    const { data: tasks, error } = await supabase
      .from('video_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[queryVideoProgress] Error:', error);
      return { status: 'pending', progress: 0 };
    }

    if (!tasks || tasks.length === 0) {
      // If no tasks but phase status is completed, return 100%
      if (phaseStatus === 'completed') {
        return { status: 'complete', progress: 100 };
      }
      return { status: 'pending', progress: 0 };
    }

    // Separate tasks into categories
    // NOTE: All rows with doc_id are video creation batch rows. transition_type is a SETTING
    // field inherited from the main task, NOT a batch type indicator.
    // Transition progress is tracked via transition_batch_progress JSON on the main task.
    const mainTask = tasks.find(t => t.is_main) || tasks.find(t => !t.doc_id);
    const videoBatches = tasks.filter(t => t.doc_id);

    // Parse transition_batch_progress from main task
    let transitionBatchProgress: any = mainTask?.transition_batch_progress;
    if (typeof transitionBatchProgress === 'string') {
      try { transitionBatchProgress = JSON.parse(transitionBatchProgress); } catch(e) { transitionBatchProgress = null; }
    }
    if (transitionBatchProgress && typeof transitionBatchProgress === 'object' && Object.keys(transitionBatchProgress).length === 0) {
      transitionBatchProgress = null;
    }

    // If we have a final completion status, return 100%
    if (mainTask?.overall_status === 'completed_final') {
      console.log('[queryVideoProgress] Final completion detected');
      return { status: 'complete', progress: 100 };
    }

    // Check for error status
    if (mainTask?.overall_status === 'error') {
      return { status: 'error', progress: 0 };
    }

    // Async subtitle burn step: video is uploaded, awaiting/burning subtitles.
    // Sit between 95% (handoff) and 99% (almost done) based on subtitles_status.
    // For chunked burns, map chunk completion linearly into 95→99%.
    if (mainTask?.overall_status === 'burning_subtitles') {
      const subStatus = mainTask?.subtitles_status;
      const burnState = (mainTask as { subtitle_burn_state?: { total?: number; completed?: number } } | undefined)?.subtitle_burn_state;
      let subProgress: number;
      if (burnState && typeof burnState.total === 'number' && burnState.total > 0) {
        const completed = Math.max(0, Math.min(burnState.total, Number(burnState.completed) || 0));
        // 95% on dispatch (0/N), 99% on last chunk burned (N/N), concat then promotes to 100%.
        subProgress = 95 + Math.round((4 * completed) / burnState.total);
      } else {
        subProgress = subStatus === 'processing' ? 98
          : subStatus === 'failed' ? 99
          : 96; // pending / unknown
      }
      console.log(`[queryVideoProgress] Burning subtitles (subtitles_status=${subStatus}, chunks=${burnState?.completed ?? '-'}/${burnState?.total ?? '-'}) -> ${subProgress}%`);
      return { status: 'processing', progress: subProgress };
    }

    // STRATEGY: Calculate progress based on batch completion
    let progress = 0;
    let totalBatches = 0;
    let completedBatches = 0;
    const hasTransitions = mainTask?.transition_type === 'dissolve' &&
      transitionBatchProgress && transitionBatchProgress.total_batches > 0;

    // Phase 1: Video Creation Batches
    if (videoBatches.length > 0) {
      totalBatches = videoBatches.length;
      completedBatches = videoBatches.filter(b => 
        b.video_creation_status === 'completed' || b.overall_status === 'completed'
      ).length;

      // Reserve one synthetic "step" for the final concat/render that runs after
      // all per-image batches complete. Without it, finishing the last batch
      // jumps progress to 95% before the final stitched video is actually
      // produced. Denominator becomes (batches + 1) so e.g. 2/4 displays as
      // 2/5 = 40% instead of 50%.
      const denominator = totalBatches + 1;

      console.log(`[queryVideoProgress] Video batches: ${completedBatches}/${totalBatches} completed (denominator ${denominator} incl. final render)`);

      // If no transitions, calculate progress based on video batches only
      if (!hasTransitions) {
        // Cap at 95% until final completion (never show 100% during processing)
        progress = denominator > 0
          ? Math.min(95, (completedBatches / denominator) * 100)
          : 0;
      } else {
        // If transitions exist, video creation is 70% of total progress
        const videoProgress = denominator > 0
          ? (completedBatches / denominator) * 70
          : 0;
        progress = videoProgress;
      }
    }

    // Phase 2: Transition Batches (from main task's transition_batch_progress)
    if (hasTransitions) {
      const totalTransitions = transitionBatchProgress.total_batches;
      const completedTransitions = transitionBatchProgress.completed_batches || 0;

      console.log(`[queryVideoProgress] Transition batches: ${completedTransitions}/${totalTransitions} completed (from transition_batch_progress)`);

      // Add transition progress (30% of total)
      const transitionProgress = totalTransitions > 0 
        ? (completedTransitions / totalTransitions) * 30 
        : 0;
      progress += transitionProgress;

      // Cap at 95% until final completion
      progress = Math.min(95, progress);
    }

    // Determine status
    if (progress > 0) {
      console.log(`[queryVideoProgress] Calculated progress: ${Math.round(progress)}%`);
      return { status: 'processing', progress: Math.round(progress) };
    }

    // No measurable progress yet, but if the main task is actively running
    // (GCF picked it up but hasn't created batch sub-rows yet) we must still
    // surface 'processing' so the UI computes/shows the time estimate.
    const mainStatus = mainTask?.video_creation_status || mainTask?.overall_status;
    if (mainStatus === 'running' || mainStatus === 'processing') {
      console.log(`[queryVideoProgress] Main task ${mainStatus}, no batches yet -> processing 0%`);
      return { status: 'processing', progress: 0 };
    }

    return { status: 'pending', progress: 0 };
  } catch (error) {
    console.error('[queryVideoProgress] Exception:', error);
    return { status: 'pending', progress: 0 };
  }
}

/**
 * Query TTV_prompt_tasks table and calculate progress
 */
async function queryTTVPromptProgress(userId: string, groupId: string, tab: number, phaseStatus?: string): Promise<ProgressResult> {
  try {
    // First try with video_process filter, fall back without it
    let tasks: any[] | null = null;
    const { data: filteredTasks, error: filteredError } = await supabase
      .from('TTV_prompt_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('video_process', true)
      .order('batch_number', { ascending: true });

    if (!filteredError && filteredTasks && filteredTasks.length > 0) {
      tasks = filteredTasks;
    } else {
      // Fallback: query without video_process filter (column may not exist or may be unset)
      const { data: allTasks, error: allError } = await supabase
        .from('TTV_prompt_tasks')
        .select('*')
        .eq('user_id', userId)
        .eq('group_id', groupId)
        .eq('tab', tab)
        .order('batch_number', { ascending: true });
      if (!allError) tasks = allTasks;
    }

    if (!tasks || tasks.length === 0) {
      return phaseStatus === 'completed' ? { status: 'complete', progress: 100 } : { status: 'pending', progress: 0 };
    }

    const batchTasks = tasks.filter(t => t.batch_number > 0);
    const totalBatches = batchTasks[0]?.total_batches || batchTasks.length;
    const completedCount = batchTasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
    const runningTask = batchTasks.find(t => t.status === 'running' || t.status === 'processing');
    const runningProgress = runningTask ? (runningTask.progress || 0) / 100 : 0;
    const progressPercentage = Math.min(100, totalBatches > 0 ? ((completedCount + runningProgress) / totalBatches) * 100 : 0);

    if (batchTasks.find(t => t.status === 'error')) return { status: 'error', progress: Math.round(progressPercentage) };
    if (completedCount === totalBatches) return { status: 'complete', progress: 100 };
    if (runningTask || completedCount > 0) return { status: 'processing', progress: Math.round(progressPercentage) };
    return { status: 'pending', progress: 0 };
  } catch {
    return { status: 'pending', progress: 0 };
  }
}

/**
 * Query TTV_tasks table and calculate progress
 */
async function queryTTVGenerationProgress(userId: string, groupId: string, tab: number, phaseStatus?: string): Promise<ProgressResult> {
  try {
    // First try with video_process filter, fall back without it
    let tasks: any[] | null = null;
    const { data: filteredTasks, error: filteredError } = await supabase
      .from('TTV_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('video_process', true)
      .order('batch_number', { ascending: true });

    if (!filteredError && filteredTasks && filteredTasks.length > 0) {
      tasks = filteredTasks;
    } else {
      // Fallback: query without video_process filter (column may not exist or may be unset)
      const { data: allTasks, error: allError } = await supabase
        .from('TTV_tasks')
        .select('*')
        .eq('user_id', userId)
        .eq('group_id', groupId)
        .eq('tab', tab)
        .order('batch_number', { ascending: true });
      if (!allError) tasks = allTasks;
    }

    if (!tasks || tasks.length === 0) {
      return phaseStatus === 'completed' ? { status: 'complete', progress: 100 } : { status: 'pending', progress: 0 };
    }

    const batchTasks = tasks.filter(t => t.batch_number > 0);
    const totalBatches = batchTasks[0]?.total_batches || batchTasks.length;
    const totalProgress = batchTasks.reduce((sum, t) => sum + (t.progress || 0), 0);
    const progressPercent = Math.min(100, totalBatches > 0 ? (totalProgress / (totalBatches * 100)) * 100 : 0);

    if (batchTasks.find(t => t.status === 'error')) return { status: 'error', progress: Math.round(progressPercent) };
    if (batchTasks.every(t => t.status === 'completed' || t.status === 'completed_final')) return { status: 'complete', progress: 100 };
    if (batchTasks.some(t => t.status === 'running' || t.status === 'processing') || totalProgress > 0) return { status: 'processing', progress: Math.round(progressPercent) };
    return { status: 'pending', progress: 0 };
  } catch {
    return { status: 'pending', progress: 0 };
  }
}

/**
 * Query MG_prompt_tasks table and calculate progress.
 * Mirrors queryTTVPromptProgress but on the MG_prompt_tasks table.
 */
async function queryMGPromptProgress(userId: string, groupId: string, tab: number, phaseStatus?: string): Promise<ProgressResult> {
  try {
    const { data: tasks, error } = await supabase
      .from('MG_prompt_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .order('batch_number', { ascending: true });

    if (error || !tasks || tasks.length === 0) {
      return phaseStatus === 'completed' ? { status: 'complete', progress: 100 } : { status: 'pending', progress: 0 };
    }

    const batchTasks = tasks.filter(t => t.batch_number > 0);
    const totalBatches = batchTasks[0]?.total_batches || batchTasks.length;
    const completedCount = batchTasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
    const runningTask = batchTasks.find(t => t.status === 'running' || t.status === 'processing');
    const runningProgress = runningTask ? (runningTask.progress || 0) / 100 : 0;
    const progressPercentage = Math.min(100, totalBatches > 0 ? ((completedCount + runningProgress) / totalBatches) * 100 : 0);

    if (batchTasks.find(t => t.status === 'error')) return { status: 'error', progress: Math.round(progressPercentage) };
    if (completedCount === totalBatches) return { status: 'complete', progress: 100 };
    if (runningTask || completedCount > 0) return { status: 'processing', progress: Math.round(progressPercentage) };
    return { status: 'pending', progress: 0 };
  } catch {
    return { status: 'pending', progress: 0 };
  }
}

/**
 * Query MG_tasks table and calculate render progress.
 */
async function queryMGRenderProgress(userId: string, groupId: string, tab: number, phaseStatus?: string): Promise<ProgressResult> {
  try {
    const { data: tasks, error } = await supabase
      .from('MG_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .order('batch_number', { ascending: true });

    if (error || !tasks || tasks.length === 0) {
      return phaseStatus === 'completed' ? { status: 'complete', progress: 100 } : { status: 'pending', progress: 0 };
    }

    const batchTasks = tasks.filter(t => t.batch_number > 0);
    const totalBatches = batchTasks[0]?.total_batches || batchTasks.length;
    const totalProgress = batchTasks.reduce((sum, t) => sum + (t.progress || 0), 0);
    const progressPercent = Math.min(100, totalBatches > 0 ? (totalProgress / (totalBatches * 100)) * 100 : 0);

    if (batchTasks.find(t => t.status === 'error')) return { status: 'error', progress: Math.round(progressPercent) };
    if (batchTasks.every(t => t.status === 'completed' || t.status === 'completed_final')) return { status: 'complete', progress: 100 };
    if (batchTasks.some(t => t.status === 'running' || t.status === 'processing') || totalProgress > 0) return { status: 'processing', progress: Math.round(progressPercent) };
    return { status: 'pending', progress: 0 };
  } catch {
    return { status: 'pending', progress: 0 };
  }
}

/**
 * Query ITV_prompt_tasks table for Phase 1 (image keyframe prompts, itv=false)
 */
async function queryITVImagePromptProgress(userId: string, groupId: string, tab: number, phaseStatus?: string): Promise<ProgressResult> {
  try {
    // First try with video_process filter, fall back without it
    let tasks: any[] | null = null;
    const { data: filteredTasks, error: filteredError } = await supabase
      .from('ITV_prompt_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('itv', false)
      .eq('video_process', true)
      .order('batch_number', { ascending: true });

    if (!filteredError && filteredTasks && filteredTasks.length > 0) {
      tasks = filteredTasks;
    } else {
      // Fallback: query without video_process filter (column may not exist or may be unset)
      const { data: allTasks, error: allError } = await supabase
        .from('ITV_prompt_tasks')
        .select('*')
        .eq('user_id', userId)
        .eq('group_id', groupId)
        .eq('tab', tab)
        .eq('itv', false)
        .order('batch_number', { ascending: true });
      if (!allError) tasks = allTasks;
    }

    if (!tasks || tasks.length === 0) {
      return phaseStatus === 'completed' ? { status: 'complete', progress: 100 } : { status: 'pending', progress: 0 };
    }

    const batchTasks = tasks.filter(t => t.batch_number > 0);
    const totalBatches = batchTasks[0]?.total_batches || batchTasks.length;
    const completedCount = batchTasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
    const runningTask = batchTasks.find(t => t.status === 'running' || t.status === 'processing');
    const runningProgress = runningTask ? (runningTask.progress || 0) / 100 : 0;
    const progressPercentage = Math.min(100, totalBatches > 0 ? ((completedCount + runningProgress) / totalBatches) * 100 : 0);

    if (batchTasks.find(t => t.status === 'error')) return { status: 'error', progress: Math.round(progressPercentage) };
    if (completedCount === totalBatches) return { status: 'complete', progress: 100 };
    if (runningTask || completedCount > 0) return { status: 'processing', progress: Math.round(progressPercentage) };
    return { status: 'pending', progress: 0 };
  } catch {
    return { status: 'pending', progress: 0 };
  }
}

/**
 * Query ITV_prompt_tasks table and calculate progress (ITV image prompts)
 */
async function queryITVPromptProgress(userId: string, groupId: string, tab: number, phaseStatus?: string): Promise<ProgressResult> {
  try {
    // First try with video_process filter, fall back without it
    let tasks: any[] | null = null;
    const { data: filteredTasks, error: filteredError } = await supabase
      .from('ITV_prompt_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('itv', true)
      .eq('video_process', true)
      .order('batch_number', { ascending: true });

    if (!filteredError && filteredTasks && filteredTasks.length > 0) {
      tasks = filteredTasks;
    } else {
      // Fallback: query without video_process filter
      const { data: allTasks, error: allError } = await supabase
        .from('ITV_prompt_tasks')
        .select('*')
        .eq('user_id', userId)
        .eq('group_id', groupId)
        .eq('tab', tab)
        .eq('itv', true)
        .order('batch_number', { ascending: true });
      if (!allError) tasks = allTasks;
    }

    if (!tasks || tasks.length === 0) {
      return phaseStatus === 'completed' ? { status: 'complete', progress: 100 } : { status: 'pending', progress: 0 };
    }

    const batchTasks = tasks.filter(t => t.batch_number > 0);
    const totalBatches = batchTasks[0]?.total_batches || batchTasks.length;
    const completedCount = batchTasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
    const runningTask = batchTasks.find(t => t.status === 'running' || t.status === 'processing');
    const runningProgress = runningTask ? (runningTask.progress || 0) / 100 : 0;
    const progressPercentage = Math.min(100, totalBatches > 0 ? ((completedCount + runningProgress) / totalBatches) * 100 : 0);

    if (batchTasks.find(t => t.status === 'error')) return { status: 'error', progress: Math.round(progressPercentage) };
    if (completedCount === totalBatches) return { status: 'complete', progress: 100 };
    if (runningTask || completedCount > 0) return { status: 'processing', progress: Math.round(progressPercentage) };
    return { status: 'pending', progress: 0 };
  } catch {
    return { status: 'pending', progress: 0 };
  }
}

/**
 * Query ITV_tasks table and calculate progress (ITV video generation)
 */
async function queryITVGenerationProgress(userId: string, groupId: string, tab: number, phaseStatus?: string): Promise<ProgressResult> {
  try {
    // First try with video_process filter, fall back without it
    // ITV_tasks may not have video_process column, or it may be unset
    let tasks: any[] | null = null;
    const { data: filteredTasks, error: filteredError } = await supabase
      .from('ITV_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('video_process', true)
      .order('batch_number', { ascending: true });

    if (!filteredError && filteredTasks && filteredTasks.length > 0) {
      tasks = filteredTasks;
    } else {
      // Fallback: query without video_process filter (column may not exist or unset)
      console.log('[queryITVGenerationProgress] Fallback: querying ITV_tasks without video_process filter');
      const { data: allTasks, error: allError } = await supabase
        .from('ITV_tasks')
        .select('*')
        .eq('user_id', userId)
        .eq('group_id', groupId)
        .eq('tab', tab)
        .order('batch_number', { ascending: true });
      if (!allError) tasks = allTasks;
    }

    if (!tasks || tasks.length === 0) {
      return phaseStatus === 'completed' ? { status: 'complete', progress: 100 } : { status: 'pending', progress: 0 };
    }

    const batchTasks = tasks.filter(t => t.batch_number > 0);
    const totalBatches = batchTasks[0]?.total_batches || batchTasks.length;
    const totalProgress = batchTasks.reduce((sum, t) => sum + (t.progress || 0), 0);
    const progressPercent = Math.min(100, totalBatches > 0 ? (totalProgress / (totalBatches * 100)) * 100 : 0);

    if (batchTasks.find(t => t.status === 'error')) return { status: 'error', progress: Math.round(progressPercent) };
    if (batchTasks.every(t => t.status === 'completed' || t.status === 'completed_final')) return { status: 'complete', progress: 100 };
    if (batchTasks.some(t => t.status === 'running' || t.status === 'processing') || totalProgress > 0) return { status: 'processing', progress: Math.round(progressPercent) };
    return { status: 'pending', progress: 0 };
  } catch {
    return { status: 'pending', progress: 0 };
  }
}

/**
 * Main function: Calculate accurate video generation progress for all phases
 * by querying individual task tables directly (NOT video_tasks aggregated fields)
 * 
 * @param userId - User ID
 * @param groupId - Video generation group ID
 * @param processFlags - Flags indicating which phases are enabled and which use existing assets
 * @returns Array of BatchStatus objects with accurate real-time progress
 */
export async function calculateVideoProgress(
  userId: string,
  groupId: string,
  tab: number,
  processFlags: ProcessFlags
): Promise<BatchStatus[]> {
  const batchStatuses: BatchStatus[] = [];

  console.log('[calculateVideoProgress] Querying task tables for accurate progress', {
    userId,
    groupId,
    processFlags
  });

  // First, query video_tasks to get phase statuses
  // This helps handle cases where tasks are cleaned up but phase is marked complete
  // 
  // STRATEGY: Query all rows for this user/group, then intelligently find the main task:
  // - If 1 row exists: it's the main task (early stages before video creation)
  // - If multiple rows exist: find the one with doc_id IS NULL (main task during video creation)
  let phaseStatuses = {
    story_status: 'pending',
    image_prompt_status: 'pending',
    image_generation_status: 'pending',
    audio_status: 'pending',
    video_creation_status: 'pending',
    itv_prompt_status: 'pending',
    itv_status: 'pending',
    ttv_prompt_status: 'pending',
    ttv_status: 'pending',
    mg_prompt_status: 'pending',
    mg_status: 'pending'
  };

  try {
    const { data: videoTasks, error } = await supabase
      .from('video_tasks')
      .select('doc_id, story_status, image_prompt_status, image_generation_status, audio_status, video_creation_status, itv_prompt_status, itv_status, ttv_prompt_status, ttv_status, mg_prompt_status, mg_status')
      .eq('user_id', userId)
      .eq('group_id', groupId);

    if (error) {
      console.warn('[calculateVideoProgress] Error querying video_tasks:', error);
    } else if (videoTasks && videoTasks.length > 0) {
      console.log(`[calculateVideoProgress] Found ${videoTasks.length} video_tasks row(s) for group ${groupId}`);
      
      // If single row: use it (it's the main task)
      // If multiple rows: find the one with doc_id IS NULL (main task)
      const mainTask = videoTasks.length === 1 
        ? videoTasks[0] 
        : (videoTasks.find(t => t.is_main) || videoTasks.find(t => t.doc_id === null || t.doc_id === undefined));
      
      if (mainTask) {
        console.log('[calculateVideoProgress] Using main task statuses:', {
          story_status: mainTask.story_status,
          image_prompt_status: mainTask.image_prompt_status,
          image_generation_status: mainTask.image_generation_status,
          audio_status: mainTask.audio_status,
          video_creation_status: mainTask.video_creation_status
        });
        phaseStatuses = {
          story_status: mainTask.story_status,
          image_prompt_status: mainTask.image_prompt_status,
          image_generation_status: mainTask.image_generation_status,
          audio_status: mainTask.audio_status,
          video_creation_status: mainTask.video_creation_status,
          itv_prompt_status: mainTask.itv_prompt_status || 'pending',
          itv_status: mainTask.itv_status || 'pending',
          ttv_prompt_status: mainTask.ttv_prompt_status || 'pending',
          ttv_status: mainTask.ttv_status || 'pending',
          mg_prompt_status: mainTask.mg_prompt_status || 'pending',
          mg_status: mainTask.mg_status || 'pending'
        };
      } else {
        console.warn('[calculateVideoProgress] Could not find main task in multiple rows');
      }
    } else {
      console.log('[calculateVideoProgress] No video_tasks rows found, using default pending statuses');
    }
  } catch (error) {
    console.warn('[calculateVideoProgress] Exception querying video_tasks statuses:', error);
  }

  // Story Generation Phase
  if (processFlags.processStory !== false) {
    if (processFlags.useExistingStory) {
      // Using existing story - mark as complete
      batchStatuses.push({
        id: 'story',
        label: 'Story Generation',
        status: 'complete',
        progress: 100
      });
    } else {
      // Query story_tasks table for real progress
      const result = await queryStoryProgress(userId, groupId, tab, phaseStatuses.story_status);
      batchStatuses.push({
        id: 'story',
        label: 'Story Generation',
        status: result.status,
        progress: result.progress
      });
    }
  }

  // Audio Generation Phase (moved to position 2)
  if (processFlags.processAudio !== false) {
    if (processFlags.useExistingAudio) {
      // Using existing audio - mark as complete
      batchStatuses.push({
        id: 'audio',
        label: 'Audio Generation',
        status: 'complete',
        progress: 100
      });
    } else {
      // Query audio_tasks table for real progress
      const result = await queryAudioProgress(userId, groupId, tab, phaseStatuses.audio_status);
      batchStatuses.push({
        id: 'audio',
        label: 'Audio Generation',
        status: result.status,
        progress: result.progress
      });
    }
  }

  // Visual Generation Phases (position 3+4) - varies by visual type
  const visualType = processFlags.visualType || 'image';

  if (visualType === 'ttv') {
    // TTV Pipeline: TTV Prompts → TTV Generation
    if (processFlags.processImages !== false) {
      if (processFlags.useExistingImages) {
        batchStatuses.push(
          { id: 'ttv_prompts', label: 'TTV Prompts', status: 'complete', progress: 100 },
          { id: 'ttv_generation', label: 'TTV Generation', status: 'complete', progress: 100 }
        );
      } else {
        const promptResult = await queryTTVPromptProgress(userId, groupId, tab, phaseStatuses.ttv_prompt_status);
        batchStatuses.push({
          id: 'ttv_prompts',
          label: 'TTV Prompts',
          status: promptResult.status,
          progress: promptResult.progress
        });

        const genResult = await queryTTVGenerationProgress(userId, groupId, tab, phaseStatuses.ttv_status);
        batchStatuses.push({
          id: 'ttv_generation',
          label: 'TTV Generation',
          status: genResult.status,
          progress: genResult.progress
        });
      }
    }
  } else if (visualType === 'itv') {
    // ITV Pipeline: Image Prompts → Image Generation → ITV Prompts → ITV Generation
    if (processFlags.processImages !== false) {
      if (processFlags.useExistingImages) {
        batchStatuses.push(
          { id: 'itv_image_prompts', label: 'ITV Image Prompts', status: 'complete', progress: 100 },
          { id: 'itv_image_generation', label: 'ITV Image Generation', status: 'complete', progress: 100 },
          { id: 'itv_prompts', label: 'ITV Prompts', status: 'complete', progress: 100 },
          { id: 'itv_generation', label: 'ITV Generation', status: 'complete', progress: 100 }
        );
      } else {
        // Phase 1: ITV image prompts (ITV_prompt_tasks WHERE itv=false)
        const imagePromptResult = await queryITVImagePromptProgress(userId, groupId, tab, phaseStatuses.image_prompt_status);
        batchStatuses.push({
          id: 'itv_image_prompts',
          label: 'ITV Image Prompts',
          status: imagePromptResult.status,
          progress: imagePromptResult.progress
        });

        // Phase 2: Image generation (uses image_tasks table, same as standard pipeline)
        const imgResult = await queryImageGenerationProgress(userId, groupId, tab, phaseStatuses.image_generation_status);
        batchStatuses.push({
          id: 'itv_image_generation',
          label: 'ITV Image Generation',
          status: imgResult.status,
          progress: imgResult.progress
        });

        // Phase 3: ITV prompts (uses ITV_prompt_tasks table)
        const itvPromptResult = await queryITVPromptProgress(userId, groupId, tab, phaseStatuses.itv_prompt_status);
        batchStatuses.push({
          id: 'itv_prompts',
          label: 'ITV Prompts',
          status: itvPromptResult.status,
          progress: itvPromptResult.progress
        });

        // Phase 4: ITV generation (uses ITV_tasks table)
        const vidResult = await queryITVGenerationProgress(userId, groupId, tab, phaseStatuses.itv_status);
        batchStatuses.push({
          id: 'itv_generation',
          label: 'ITV Generation',
          status: vidResult.status,
          progress: vidResult.progress
        });
      }
    }
  } else if (visualType === 'mg') {
    // MG Pipeline: MG Prompts → MG Render (mirrors TTV: prompts then clip render).
    if (processFlags.processImages !== false) {
      if (processFlags.useExistingImages) {
        batchStatuses.push(
          { id: 'mg_prompts', label: 'MG Prompts', status: 'complete', progress: 100 },
          { id: 'mg_render', label: 'MG Render', status: 'complete', progress: 100 }
        );
      } else {
        const promptResult = await queryMGPromptProgress(userId, groupId, tab, phaseStatuses.mg_prompt_status);
        batchStatuses.push({
          id: 'mg_prompts',
          label: 'MG Prompts',
          status: promptResult.status,
          progress: promptResult.progress
        });

        const genResult = await queryMGRenderProgress(userId, groupId, tab, phaseStatuses.mg_status);
        batchStatuses.push({
          id: 'mg_render',
          label: 'MG Render',
          status: genResult.status,
          progress: genResult.progress
        });
      }
    }
  } else {
    // Standard Image Pipeline: Image Prompts → Image Generation
    if (processFlags.processImages !== false) {
      if (processFlags.useExistingImages) {
        batchStatuses.push(
          { id: 'image_prompts', label: 'Image Prompts', status: 'complete', progress: 100 },
          { id: 'image_generation', label: 'Image Generation', status: 'complete', progress: 100 }
        );
      } else {
        const promptResult = await queryImagePromptProgress(userId, groupId, tab, phaseStatuses.image_prompt_status);
        batchStatuses.push({
          id: 'image_prompts',
          label: 'Image Prompts',
          status: promptResult.status,
          progress: promptResult.progress
        });

        const genResult = await queryImageGenerationProgress(userId, groupId, tab, phaseStatuses.image_generation_status);
        batchStatuses.push({
          id: 'image_generation',
          label: 'Image Generation',
          status: genResult.status,
          progress: genResult.progress
        });
      }
    }
  }

  // Video Creation Phase (only if not components-only mode)
  if (processFlags.video !== false) {
    // Video always needs to be created - can't use existing
    const result = await queryVideoProgress(userId, groupId, phaseStatuses.video_creation_status);
    batchStatuses.push({
      id: 'video',
      label: 'Video Creation',
      status: result.status,
      progress: result.progress
    });
  }

  console.log('[calculateVideoProgress] Calculated batch statuses:', batchStatuses);

  return batchStatuses;
}
