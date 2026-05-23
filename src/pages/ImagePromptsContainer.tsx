import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import ImagePrompts, { type ImagePromptsRef } from './ImagePrompts';
import { checkIsEnterpriseUser, ensureTabExists, getUserActiveTabs, type TabInfo } from '../utils/tabManager';

/**
 * ImagePromptsContainer - Wrapper component that manages tab state and forces
 * ImagePrompts component remounting when tabs change to ensure complete isolation
 */
export default function ImagePromptsContainer() {
  const { user } = useAuth();
  const [currentTab, setCurrentTab] = useState<number>(1);
  const [isEnterpriseUser, setIsEnterpriseUser] = useState<boolean>(false);
  const [prefetchedTabs, setPrefetchedTabs] = useState<TabInfo[] | undefined>(undefined);
  const [tabConfigs, setTabConfigs] = useState<Record<number, { groupId: string; tab: number }>>({
    1: { groupId: '', tab: 1 }
  });
  const [isInitialized, setIsInitialized] = useState(false);
  const imagePromptsRefs = useRef<Record<number, ImagePromptsRef>>({});

  // Check if user has tabs feature and initialize tabs on mount
  useEffect(() => {
    if (!user?.id) return;

    const initializeContainer = async () => {
      try {
        // Check if user has tabs feature (elite, ultimate, or enterprise)
        const isEnterprise = await checkIsEnterpriseUser(user.id);
        setIsEnterpriseUser(isEnterprise);

        // Ensure Tab 1 exists in database for image page
        if (isEnterprise) {
          await ensureTabExists(user.id, 'image_prompt');
          const tabs = await getUserActiveTabs(user.id, 'image_prompt');
          setPrefetchedTabs(tabs);
        }

        setIsInitialized(true);
      } catch (error) {
        console.error('Error initializing image prompts container:', error);
        setIsInitialized(true); // Initialize anyway to avoid blocking
      }
    };

    initializeContainer();
  }, [user?.id]);

  const handleTabChange = (tab: number, groupId: string) => {
    console.log(`[ImagePromptsContainer] Tab change requested: ${currentTab} -> ${tab}, groupId: ${groupId}`);
    
    // Update tab configs
    setTabConfigs(prev => ({
      ...prev,
      [tab]: { groupId, tab }
    }));
    
    // Switch to new tab (this triggers remount via key prop)
    setCurrentTab(tab);
  };

  const handleTabCreate = (tab: number, groupId: string) => {
    console.log(`[ImagePromptsContainer] Tab create: ${tab}, groupId: ${groupId}`);
    
    // Add new tab config
    setTabConfigs(prev => ({
      ...prev,
      [tab]: { groupId, tab }
    }));
    
    // Switch to new tab immediately
    setCurrentTab(tab);
  };

  const handleTabClose = async (tab: number, groupId: string) => {
    console.log(`[ImagePromptsContainer] Tab close: ${tab}, groupId: ${groupId}`);
    
    // Call cleanup on the ImagePrompts instance if ref exists
    const imagePromptsRef = imagePromptsRefs.current[tab];
    if (imagePromptsRef) {
      try {
        await imagePromptsRef.cleanup();
        console.log(`[ImagePromptsContainer] Successfully cleaned up tab ${tab}`);
      } catch (error) {
        console.error(`[ImagePromptsContainer] Error cleaning up tab ${tab}:`, error);
      }
      
      // Remove ref
      delete imagePromptsRefs.current[tab];
    }
    
    // Remove tab config
    setTabConfigs(prev => {
      const updated = { ...prev };
      delete updated[tab];
      return updated;
    });
    
    // If closing current tab, switch to Tab 1 or first available tab
    if (tab === currentTab) {
      const remainingTabs = Object.keys(tabConfigs)
        .map(Number)
        .filter(t => t !== tab)
        .sort((a, b) => a - b);
      
      const switchTo = remainingTabs.length > 0 ? remainingTabs[0] : 1;
      setCurrentTab(switchTo);
    }
  };

  // Wait for initialization before rendering
  if (!isInitialized) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-300">Loading...</div>
      </div>
    );
  }

  return (
    <>
      {/* 
        KEY PROP IS CRITICAL:
        key={`image-tab-${currentTab}`} forces React to completely unmount
        the old ImagePrompts instance and mount a fresh one when currentTab changes.
        This ensures complete state isolation between tabs with zero contamination.
      */}
      <ImagePrompts
        key={`image-tab-${currentTab}`}
        ref={(ref) => {
          if (ref) {
            imagePromptsRefs.current[currentTab] = ref;
          }
        }}
        initialTab={currentTab}
        initialGroupId={tabConfigs[currentTab]?.groupId || ''}
        isEnterpriseUser={isEnterpriseUser}
        initialTabs={prefetchedTabs}
        onTabChange={handleTabChange}
        onTabCreate={handleTabCreate}
        onTabClose={handleTabClose}
      />
    </>
  );
}
