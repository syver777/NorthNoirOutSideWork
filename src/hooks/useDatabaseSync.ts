import { useEffect, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { calculateVideoProgress } from '../utils/videoProgressCalculator';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

interface DatabaseSyncOptions {
  userId: string | null;
  currentTab: number;
  page: string; // 'video' | 'audio' | 'image'
  generationState: 'idle' | 'analyzing' | 'analyzed' | 'generating' | 'complete' | 'error';
  currentGroupId: string | null;
  progress: number;
  onStateRestored?: (data: any) => void;
}

export function useDatabaseSync({
  userId,
  currentTab,
  page,
  generationState,
  currentGroupId,
  progress,
  onStateRestored,
}: DatabaseSyncOptions) {

  /**
   * Load state from database on mount
   */
  const loadFromDatabase = useCallback(async () => {
    if (!userId || !currentTab) return null;

    console.log(`[useDatabaseSync] Loading state for ${page} Tab ${currentTab}...`);

    try {
      // 1. Query tabs table for this tab's data
      const { data: tabData, error: tabError } = await supabase
        .from('tabs')
        .select('status, group_id, title')
        .eq('user_id', userId)
        .eq('page', page)
        .eq('tab_number', currentTab)
        .maybeSingle();

      if (tabError) {
        console.error(`[useDatabaseSync] Error fetching tab data:`, tabError);
        return null;
      }

      // 2. If we have a group_id, fetch the video_tasks data and calculate accurate progress
      if (tabData?.group_id) {
        const { data: videoTaskData, error: videoTaskError } = await supabase
          .from('video_tasks')
          .select('*')
          .eq('group_id', tabData.group_id)
          .eq('tab', currentTab)
          .in('overall_status', ['pending', 'running', 'completed'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (videoTaskError) {
          console.error(`[useDatabaseSync] Error fetching video_tasks:`, videoTaskError);
          return null;
        }

        if (videoTaskData) {
          console.log(`[useDatabaseSync] Found active video_task for group ${tabData.group_id}`);
          
          // CALCULATE ACCURATE BATCH STATUSES from task tables directly
          // This ensures restored state shows real-time progress, not stale aggregated values
          const calculatedBatchStatuses = await calculateVideoProgress(
            userId,
            tabData.group_id,
            currentTab,
            {
              processStory: videoTaskData.process_story !== false,
              processImages: videoTaskData.process_images !== false,
              processAudio: videoTaskData.process_audio !== false,
              video: videoTaskData.video !== false,
              useExistingStory: videoTaskData.use_existing_story === true,
              useExistingImages: videoTaskData.use_existing_images === true,
              useExistingAudio: videoTaskData.use_existing_audio === true,
              visualType: videoTaskData.visual_type || 'image'
            }
          );
          
          onStateRestored?.({
            tabData,
            videoTaskData,
            calculatedBatchStatuses, // Pass accurate progress to callback
          });
          return { tabData, videoTaskData, calculatedBatchStatuses };
        }
      }

      return { tabData, videoTaskData: null };
    } catch (error) {
      console.error('[useDatabaseSync] Error during database load:', error);
      return null;
    }
  }, [userId, currentTab, page, onStateRestored]);

  /**
   * Save state to database (debounced)
   */
  const saveToDatabase = useCallback(async () => {
    if (!userId || !currentTab) return;

    // Only update if we have meaningful data to save
    if (generationState === 'idle' && !currentGroupId) {
      return;
    }

    console.log(`[useDatabaseSync] Saving state to database: ${generationState}, progress: ${progress}`);

    try {
      const { error } = await supabase
        .from('tabs')
        .upsert({
          user_id: userId,
          page,
          tab_number: currentTab,
          status: generationState,
          group_id: currentGroupId,
          process_image: false, // Default to false for video/story/audio pages
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'user_id,page,tab_number,process_image',
        });

      if (error) {
        console.error('[useDatabaseSync] Error saving state to database:', error);
      }
    } catch (error) {
      console.error('[useDatabaseSync] Exception during save:', error);
    }
  }, [userId, currentTab, page, generationState, currentGroupId, progress]);

  /**
   * Load on mount
   */
  useEffect(() => {
    loadFromDatabase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount

  /**
   * Save to database when state changes (debounced)
   */
  useEffect(() => {
    if (!userId || !currentTab) return;

    const timer = setTimeout(() => {
      saveToDatabase();
    }, 1000); // Debounce 1 second

    return () => clearTimeout(timer);
  }, [userId, currentTab, generationState, currentGroupId, progress, saveToDatabase]);

  return {
    loadFromDatabase,
    saveToDatabase,
  };
}
