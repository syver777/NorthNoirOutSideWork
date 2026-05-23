import { useEffect, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import ImageToVideoGenerator, { ImageToVideoGeneratorRef } from './ImageToVideoGenerator';
import { ensureTabExists, checkIsEnterpriseUser, getUserActiveTabs, type TabInfo } from '../utils/tabManager';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

export default function ImageToVideoGeneratorContainer() {
  const [userId, setUserId] = useState<string | null>(null);
  const [currentTab, setCurrentTab] = useState(1);
  const [isEnterpriseUser, setIsEnterpriseUser] = useState(false);
  const [prefetchedTabs, setPrefetchedTabs] = useState<TabInfo[] | undefined>(undefined);
  const generatorRef = useRef<ImageToVideoGeneratorRef>(null);

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      await ensureTabExists(user.id, 'itv');

      const isEnterprise = await checkIsEnterpriseUser(user.id);
      setIsEnterpriseUser(isEnterprise);

      if (isEnterprise) {
        const tabs = await getUserActiveTabs(user.id, 'itv');
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
    <ImageToVideoGenerator
      ref={generatorRef}
      key={`itv-tab-${currentTab}`}
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
