import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import Generator, { type GeneratorRef } from './Generator';
import { checkIsEnterpriseUser, ensureTabExists, getUserActiveTabs, type TabInfo } from '../utils/tabManager';

/**
 * GeneratorContainer - Wrapper component that manages tab state and forces
 * Generator component remounting when tabs change to ensure complete isolation
 */
export default function GeneratorContainer() {
  const { user } = useAuth();
  const [currentTab, setCurrentTab] = useState<number>(1);
  const [isEnterpriseUser, setIsEnterpriseUser] = useState<boolean>(false);
  const [tabConfigs, setTabConfigs] = useState<Record<number, { groupId: string; tab: number }>>({
    1: { groupId: '', tab: 1 }
  });
  const [tabRemountCounters, setTabRemountCounters] = useState<Record<number, number>>({});
  const [isInitialized, setIsInitialized] = useState(false);
  const [prefetchedTabs, setPrefetchedTabs] = useState<TabInfo[] | undefined>(undefined);
  const generatorRefs = useRef<Record<number, GeneratorRef>>({});

  // Check if user has tabs feature and initialize tabs on mount
  useEffect(() => {
    if (!user?.id) return;

    const initializeContainer = async () => {
      try {
        // Check if user has tabs feature (elite, ultimate, or enterprise)
        const isEnterprise = await checkIsEnterpriseUser(user.id);
        setIsEnterpriseUser(isEnterprise);

        // Ensure Tab 1 exists in database for ALL users (used as state storage)
        await ensureTabExists(user.id, 'story');
        
        if (isEnterprise) {
          const tabs = await getUserActiveTabs(user.id, 'story');
          setPrefetchedTabs(tabs);
        }

        setIsInitialized(true);
      } catch (error) {
        console.error('Error initializing generator container:', error);
        setIsInitialized(true); // Initialize anyway to avoid blocking
      }
    };

    initializeContainer();
  }, [user?.id]);

  const handleTabChange = (tab: number, groupId: string) => {
    console.log(`[GeneratorContainer] Tab change requested: ${currentTab} -> ${tab}, groupId: ${groupId}`);
    
    // Update tab configs
    setTabConfigs(prev => ({
      ...prev,
      [tab]: { groupId, tab }
    }));
    
    // Switch to new tab (this triggers remount via key prop)
    setCurrentTab(tab);
  };

  const handleTabCreate = (tab: number, groupId: string) => {
    console.log(`[GeneratorContainer] Tab create: ${tab}, groupId: ${groupId}`);
    
    // Add new tab config
    setTabConfigs(prev => ({
      ...prev,
      [tab]: { groupId, tab }
    }));
    
    // Switch to new tab immediately
    setCurrentTab(tab);
  };

  const handleTabClose = async (tab: number, groupId: string) => {
    console.log(`[GeneratorContainer] Tab close: ${tab}, groupId: ${groupId}`);
    
    // Call cleanup on the Generator instance if ref exists
    const generatorRef = generatorRefs.current[tab];
    if (generatorRef) {
      try {
        await generatorRef.cleanup();
        console.log(`[GeneratorContainer] Successfully cleaned up tab ${tab}`);
      } catch (error) {
        console.error(`[GeneratorContainer] Error cleaning up tab ${tab}:`, error);
      }
      
      // Remove ref
      delete generatorRefs.current[tab];
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

  // Force a full remount of the Generator for the given tab. This mimics
  // navigating away from the page and back, ensuring all internal state,
  // refs, and mount-only effects are re-initialised from scratch.
  const handleRequestRemount = (tab: number) => {
    console.log(`[GeneratorContainer] Remount requested for tab ${tab}`);
    // Clear stored groupId for the tab so the fresh Generator starts clean.
    setTabConfigs(prev => ({
      ...prev,
      [tab]: { groupId: '', tab }
    }));
    // Drop the cached ref for the about-to-be-unmounted instance.
    delete generatorRefs.current[tab];
    // Bump the per-tab counter, which feeds into the Generator's `key`.
    setTabRemountCounters(prev => ({
      ...prev,
      [tab]: (prev[tab] || 0) + 1
    }));
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
        key={`generator-tab-${currentTab}`} forces React to completely unmount
        the old Generator instance and mount a fresh one when currentTab changes.
        This ensures complete state isolation between tabs with zero contamination.
      */}
      <Generator
        key={`generator-tab-${currentTab}-${tabRemountCounters[currentTab] || 0}`}
        ref={(ref) => {
          if (ref) {
            generatorRefs.current[currentTab] = ref;
          }
        }}
        initialTab={currentTab}
        initialGroupId={tabConfigs[currentTab]?.groupId || ''}
        isEnterpriseUser={isEnterpriseUser}
        initialTabs={prefetchedTabs}
        userId={user.id}
        onTabChange={handleTabChange}
        onTabCreate={handleTabCreate}
        onTabClose={handleTabClose}
        onRequestRemount={handleRequestRemount}
      />
    </>
  );
}
