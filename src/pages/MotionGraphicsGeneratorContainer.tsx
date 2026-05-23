import { useEffect, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import MotionGraphicsGenerator, { MotionGraphicsGeneratorRef } from './MotionGraphicsGenerator';
import { ensureTabExists, checkIsEnterpriseUser, getUserActiveTabs, type TabInfo } from '../utils/tabManager';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

export default function MotionGraphicsGeneratorContainer() {
  const [userId, setUserId] = useState<string | null>(null);
  const [currentTab, setCurrentTab] = useState(1);
  const [isEnterpriseUser, setIsEnterpriseUser] = useState(false);
  const [prefetchedTabs, setPrefetchedTabs] = useState<TabInfo[] | undefined>(undefined);
  const generatorRef = useRef<MotionGraphicsGeneratorRef>(null);

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      await ensureTabExists(user.id, 'mg');

      const isEnterprise = await checkIsEnterpriseUser(user.id);
      setIsEnterpriseUser(isEnterprise);

      if (isEnterprise) {
        const tabs = await getUserActiveTabs(user.id, 'mg');
        setPrefetchedTabs(tabs);
      }

      // Set userId LAST so the generator doesn't render until prefetchedTabs is ready
      setUserId(user.id);
    };
    init();
  }, []);

  const handleTabChange = (tab: number) => {
    setCurrentTab(tab);
  };

  const handleTabCreate = (tab: number) => {
    setCurrentTab(tab);
  };

  const handleTabClose = async (tab: number) => {
    // Only run cleanup on the currently-rendered instance if it is the tab being closed.
    // If a different (inactive) tab is being closed, generatorRef.current points to the
    // active tab — calling cleanup() on it would stop an unrelated generation.
    if (tab === currentTab && generatorRef.current) {
      await generatorRef.current.cleanup();
    }
    if (currentTab === tab && tab > 1) setCurrentTab(tab - 1);
    else if (currentTab === tab) setCurrentTab(1);
  };

  if (!userId) {
    return (
      <div className="min-h-screen bg-surface-primary flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <MotionGraphicsGenerator
      ref={generatorRef}
      key={`mg-tab-${currentTab}`}
      initialTab={currentTab}
      isEnterpriseUser={isEnterpriseUser}
      initialTabs={prefetchedTabs}
      onTabChange={handleTabChange}
      onTabCreate={handleTabCreate}
      onTabClose={handleTabClose}
      userId={userId}
    />
  );
}
