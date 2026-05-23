import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import TextToSpeech, { type TextToSpeechRef } from './TextToSpeech';
import { checkIsEnterpriseUser, ensureTabExists, getUserActiveTabs, type TabInfo } from '../utils/tabManager';

/**
 * TextToSpeechContainer - Wrapper component that manages tab state and forces
 * TextToSpeech component remounting when tabs change to ensure complete isolation
 */
export default function TextToSpeechContainer() {
  const { user } = useAuth();
  const [currentTab, setCurrentTab] = useState<number>(1);
  const [isEnterpriseUser, setIsEnterpriseUser] = useState<boolean>(false);
  const [tabConfigs, setTabConfigs] = useState<Record<number, { groupId: string; tab: number }>>({
    1: { groupId: '', tab: 1 }
  });
  const [isInitialized, setIsInitialized] = useState(false);
  const [prefetchedTabs, setPrefetchedTabs] = useState<TabInfo[] | undefined>(undefined);
  const textToSpeechRefs = useRef<Record<number, TextToSpeechRef>>({});

  // Check if user has tabs feature and initialize tabs on mount
  useEffect(() => {
    if (!user?.id) return;

    const initializeContainer = async () => {
      try {
        // Check if user has tabs feature (elite, ultimate, or enterprise)
        const isEnterprise = await checkIsEnterpriseUser(user.id);
        setIsEnterpriseUser(isEnterprise);

        // Ensure Tab 1 exists in database
        if (isEnterprise) {
          await ensureTabExists(user.id, 'audio');
          const tabs = await getUserActiveTabs(user.id, 'audio');
          setPrefetchedTabs(tabs);
        }

        setIsInitialized(true);
      } catch (error) {
        console.error('Error initializing audio container:', error);
        setIsInitialized(true); // Initialize anyway to avoid blocking
      }
    };

    initializeContainer();
  }, [user?.id]);

  const handleTabChange = (tab: number, groupId: string) => {
    console.log(`[TextToSpeechContainer] Tab change requested: ${currentTab} -> ${tab}, groupId: ${groupId}`);
    
    // Update tab configs
    setTabConfigs(prev => ({
      ...prev,
      [tab]: { groupId, tab }
    }));
    
    // Switch to new tab (this triggers remount via key prop)
    setCurrentTab(tab);
  };

  const handleTabCreate = (tab: number, groupId: string) => {
    console.log(`[TextToSpeechContainer] Tab create: ${tab}, groupId: ${groupId}`);
    
    // Add new tab config
    setTabConfigs(prev => ({
      ...prev,
      [tab]: { groupId, tab }
    }));
    
    // Switch to new tab immediately
    setCurrentTab(tab);
  };

  const handleTabClose = async (tab: number, groupId: string) => {
    console.log(`[TextToSpeechContainer] Tab close: ${tab}, groupId: ${groupId}`);
    
    // Call cleanup on the TextToSpeech instance if ref exists
    const textToSpeechRef = textToSpeechRefs.current[tab];
    if (textToSpeechRef) {
      try {
        await textToSpeechRef.cleanup();
        console.log(`[TextToSpeechContainer] Successfully cleaned up tab ${tab}`);
      } catch (error) {
        console.error(`[TextToSpeechContainer] Error cleaning up tab ${tab}:`, error);
      }
      
      // Remove ref
      delete textToSpeechRefs.current[tab];
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

  const handleRefresh = () => {
    // Trigger re-render by updating state
    setTabConfigs(prev => ({ ...prev }));
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
        key={`audio-tab-${currentTab}`} forces React to completely unmount
        the old TextToSpeech instance and mount a fresh one when currentTab changes.
        This ensures complete state isolation between tabs with zero contamination.
      */}
      <TextToSpeech
        key={`audio-tab-${currentTab}`}
        ref={(ref: TextToSpeechRef | null) => {
          if (ref) {
            textToSpeechRefs.current[currentTab] = ref;
          }
        }}
        currentTab={currentTab}
        isEnterpriseUser={isEnterpriseUser}
        initialTabs={prefetchedTabs}
        userId={user.id}
        onTabUpdate={handleRefresh}
        onTabChange={handleTabChange}
        onTabCreate={handleTabCreate}
        onTabClose={handleTabClose}
      />
    </>
  );
}
