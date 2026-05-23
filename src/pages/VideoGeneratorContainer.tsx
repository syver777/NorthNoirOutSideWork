import { useState, useEffect, useRef } from 'react';
import VideoGenerator, { VideoGeneratorRef } from './VideoGenerator';
import { useAuth } from '../contexts/AuthContext';
import { 
  checkIsEnterpriseUser, 
  ensureTabExists, 
  getUserActiveTabs,
  stopVideoGenerationForGroupId, 
  completeVideoCleanupForGroupId,
  type TabInfo 
} from '../utils/tabManager';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

/**
 * VideoGeneratorContainer - Wrapper component that manages tab state and forces
 * VideoGenerator component remounting when tabs change to ensure complete isolation
 */
export default function VideoGeneratorContainer() {
  const { user } = useAuth();
  const [currentTab, setCurrentTab] = useState<number>(1);
  const [isEnterpriseUser, setIsEnterpriseUser] = useState<boolean>(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [prefetchedTabs, setPrefetchedTabs] = useState<TabInfo[] | undefined>(undefined);
  const videoGeneratorRef = useRef<VideoGeneratorRef | null>(null);

  // Check if user has tabs feature and initialize tabs on mount
  useEffect(() => {
    if (!user?.id) return;

    const initializeContainer = async () => {
      try {
        // Check if user has tabs feature (elite, ultimate, or enterprise)
        const isEnterprise = await checkIsEnterpriseUser(user.id);
        setIsEnterpriseUser(isEnterprise);

        // Ensure Tab 1 exists in database for ALL users
        // This is needed for proper state persistence and time calculation
        await ensureTabExists(user.id, 'video');

        if (isEnterprise) {
          const tabs = await getUserActiveTabs(user.id, 'video');
          setPrefetchedTabs(tabs);
        }

        setIsInitialized(true);
      } catch (error) {
        console.error('Error initializing video container:', error);
        setIsInitialized(true); // Initialize anyway to avoid blocking
      }
    };

    initializeContainer();
  }, [user?.id]);

  const handleTabChange = (tab: number, groupId: string) => {
    console.log(`[VideoGeneratorContainer] Tab change requested: ${currentTab} -> ${tab}, groupId: ${groupId}`);
    setCurrentTab(tab);
  };

  const handleTabCreate = (tab: number, groupId: string) => {
    console.log(`[VideoGeneratorContainer] Tab create: ${tab}, groupId: ${groupId}`);
    setCurrentTab(tab);
  };

  const handleTabClose = async (tab: number, groupId: string) => {
    console.log(`[VideoGeneratorContainer] Tab close: ${tab}, groupId: ${groupId}`);
    
    try {
      // Get tab status from database first
      if (user?.id) {
        const { data: tabData } = await supabase
          .from('tabs')
          .select('status, group_id')
          .eq('user_id', user.id)
          .eq('page', 'video')
          .eq('tab_number', tab)
          .maybeSingle();

        if (tabData) {
          console.log(`[VideoGeneratorContainer] Tab ${tab} status: ${tabData.status}`);
          
          // Use the groupId from database if available, fallback to passed groupId
          const effectiveGroupId = tabData.group_id || groupId;
          
          if (tabData.status === 'generating') {
            console.log(`[VideoGeneratorContainer] Stopping generation for tab ${tab}, groupId: ${effectiveGroupId}`);
            await stopVideoGenerationForGroupId(user.id, effectiveGroupId);
          } else if (tabData.status === 'complete') {
            console.log(`[VideoGeneratorContainer] Completing cleanup for tab ${tab}, groupId: ${effectiveGroupId}`);
            await completeVideoCleanupForGroupId(user.id, effectiveGroupId);
          }
        }
      }

      // If closing current tab AND component is mounted, also call component cleanup
      if (tab === currentTab && videoGeneratorRef.current) {
        try {
          await videoGeneratorRef.current.cleanup();
        } catch (error) {
          console.error('[VideoGeneratorContainer] Error during component cleanup:', error);
        }
      }

      // Switch to Tab 1 if closing current tab
      if (tab === currentTab) {
        setCurrentTab(1);
      }
    } catch (error) {
      console.error('[VideoGeneratorContainer] Error during tab close:', error);
      // Still try to switch tabs even if cleanup fails
      if (tab === currentTab) {
        setCurrentTab(1);
      }
    }
  };

  // Show loading state while initializing
  if (!isInitialized || !user?.id) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-red-500"></div>
      </div>
    );
  }

  // For non-premium users (not elite/ultimate/enterprise), always use tab 1
  const effectiveTab = isEnterpriseUser ? currentTab : 1;

  return (
    <VideoGenerator
      ref={videoGeneratorRef}
      key={`video-tab-${effectiveTab}`}
      currentTab={effectiveTab}
      isEnterpriseUser={isEnterpriseUser}
      onTabChange={handleTabChange}
      onTabCreate={handleTabCreate}
      onTabClose={handleTabClose}
      userId={user.id}
      initialTabs={prefetchedTabs}
    />
  );
}
