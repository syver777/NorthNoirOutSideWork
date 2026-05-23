import React, { useState, useEffect } from 'react';
import { Plus, X, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { TabInfo, getUserActiveTabs, canCreateNewTab, formatTokenCount, createTab, getNextAvailableTab, ensureTabExists, deleteTabFromDB } from '../utils/tabManager';

interface TabManagerProps {
  userId: string;
  isEnterpriseUser: boolean;
  currentTab: number;
  page?: string;  // 'story' or 'audio'
  initialTabs?: TabInfo[];
  refreshTrigger?: number;
  activeTabStatus?: string;  // Override status for current tab (immediate feedback)
  onTabChange: (tab: number, groupId: string) => void;
  onTabCreate: (tab: number, groupId: string) => void;
  onTabClose: (tab: number, groupId: string) => void;
}

export default function TabManager({ 
  userId, 
  isEnterpriseUser, 
  currentTab,
  page = 'story',  // Default to 'story' for backwards compatibility
  initialTabs,
  refreshTrigger,
  activeTabStatus,
  onTabChange, 
  onTabCreate,
  onTabClose 
}: TabManagerProps) {
  const [tabs, setTabs] = useState<TabInfo[]>(initialTabs || []);
  const [loading, setLoading] = useState(!initialTabs);
  const [totalEstimatedTokens, setTotalEstimatedTokens] = useState(0);
  const [creating, setCreating] = useState(false);

  // Initialize and fetch tabs on mount
  useEffect(() => {
    if (!isEnterpriseUser) return;
    
    const initTabs = async () => {
      if (!initialTabs) {
        // Ensure user has at least Tab 1
        await ensureTabExists(userId, page);
      }
      fetchTabs();
    };
    
    initTabs();
    const interval = setInterval(fetchTabs, 5000); // Poll every 5 seconds
    return () => clearInterval(interval);
  }, [userId, isEnterpriseUser]);

  // Immediately refetch when refreshTrigger changes (e.g. after clicking Done)
  useEffect(() => {
    if (refreshTrigger && refreshTrigger > 0) {
      fetchTabs();
    }
  }, [refreshTrigger]);

  const fetchTabs = async () => {
    try {
      // Get tabs from database (tabs table + enriched with task data)
      const dbTabs = await getUserActiveTabs(userId, page);
      
      setTabs(dbTabs);
      const totalTokens = dbTabs.reduce((sum, tab) => sum + tab.estimatedTokens, 0);
      setTotalEstimatedTokens(totalTokens);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching tabs:', error);
      setLoading(false);
    }
  };

  const handleCreateTab = async () => {
    setCreating(true);
    try {
      // Check if user has tabs feature (elite, ultimate, or enterprise)
      const { canCreate, reason } = await canCreateNewTab(userId, page);
      if (!canCreate) {
        alert(reason);
        setCreating(false);
        return;
      }

      // Find next available tab from database
      const nextTab = await getNextAvailableTab(userId, page);
      if (!nextTab) {
        alert('Maximum 10 tabs allowed');
        setCreating(false);
        return;
      }

      // Create groupId first
      const newGroupId = crypto.randomUUID();
      
      // Create tab in database with the groupId
      const created = await createTab(userId, page, nextTab, newGroupId);
      if (!created) {
        alert('Failed to create tab');
        setCreating(false);
        return;
      }

      // Notify parent
      onTabCreate(nextTab, newGroupId);
      
      setCreating(false);
      
      // Refresh after short delay
      setTimeout(fetchTabs, 300);
    } catch (error) {
      console.error('Error creating tab:', error);
      alert('Error creating new tab');
      setCreating(false);
    }
  };

  const handleCloseTab = async (tab: number, groupId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    
    // Tab 1 cannot be closed
    if (tab === 1) {
      alert('Cannot close Tab 1');
      return;
    }
    
    const tabInfo = tabs.find(t => t.tab === tab);
    
    // If has active or completed generation, confirm first
    if (tabInfo && (tabInfo.status === 'generating' || tabInfo.status === 'outline' || tabInfo.status === 'complete')) {
      const message = tabInfo.status === 'generating' || tabInfo.status === 'outline'
        ? `Tab ${tab} is currently generating. Closing it will stop the generation. Are you sure?`
        : `Close Tab ${tab}? This will delete all associated data.`;
      
      if (!confirm(message)) {
        return;
      }
    }
    
    // Always call parent cleanup handler (it will check status and handle appropriately)
    await onTabClose(tab, groupId);
    
    // Delete tab from database after cleanup is complete
    await deleteTabFromDB(userId, page, tab);
    
    // If closing current tab, switch to another tab
    if (tab === currentTab) {
      const remainingTabs = tabs.filter(t => t.tab !== tab);
      const switchTo = remainingTabs.length > 0 ? remainingTabs[0].tab : 1;
      const switchTab = remainingTabs.find(t => t.tab === switchTo);
      const switchGroupId = switchTab?.groupId || '';
      onTabChange(switchTo, switchGroupId);
    }
    
    // Refresh after cleanup
    setTimeout(fetchTabs, 300);
  };

  // Helper function to get spinning border class based on status
  const getTabSpinClass = (status: string) => {
    switch(status) {
      case 'generating':
      case 'outline':
        return 'tab-spin-border tab-spin-blue';
      case 'complete':
        return 'tab-spin-border tab-spin-green';
      case 'error':
        return 'tab-spin-border tab-spin-red';
      default:
        return '';
    }
  };

  if (!isEnterpriseUser) {
    return null;
  }

  if (loading) {
    // Skeleton placeholder matching real tab + info bar dimensions to prevent layout shift
    return (
      <div className="mt-5 mb-6">
        <div className="flex items-center gap-2 pt-1 pb-2 px-1">
          <div className="h-[36px] w-[88px] rounded-full bg-white/[0.03] border border-white/[0.06] animate-pulse" />
          <div className="h-[36px] w-[88px] rounded-full bg-white/[0.03] border border-white/[0.06] animate-pulse opacity-50" />
        </div>
        <div className="mt-3 flex items-center justify-between text-xs">
          <div className="text-text-muted">
            Active tabs: <span className="font-semibold text-white">—/10</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-5 mb-6">
      {/* Tab List */}
      <div className="flex items-center gap-2 overflow-x-auto pt-1 pb-2 px-1">
        {/* Tabs Container - wraps on smaller screens */}
        <div className="flex gap-2 flex-wrap max-w-full">
          {tabs.length === 0 ? (
            <div className="text-sm text-text-muted py-2">No active tabs</div>
          ) : (
            tabs.map((tab) => {
              const effectiveStatus = (tab.tab === currentTab && activeTabStatus) ? activeTabStatus : tab.status;
              return (
              <button
                key={`${tab.tab}-${tab.groupId || `empty-${tab.tab}`}`}
                onClick={() => onTabChange(tab.tab, tab.groupId)}
                className={`
                  relative group px-4 py-2 rounded-full text-sm font-medium transition-all duration-200
                  min-w-[80px] backdrop-blur-sm
                  ${getTabSpinClass(effectiveStatus)}
                  ${effectiveStatus === 'generating' || effectiveStatus === 'outline'
                    ? currentTab === tab.tab
                      ? 'bg-blue-500/[0.15] text-blue-300 border border-blue-500/[0.35] shadow-lg shadow-blue-500/10'
                      : 'bg-blue-500/[0.08] text-blue-300/80 border border-blue-500/[0.25] hover:bg-blue-500/[0.12] hover:text-blue-300'
                    : currentTab === tab.tab 
                      ? 'bg-white/[0.08] text-white border border-white/[0.12] shadow-lg' 
                      : 'bg-white/[0.03] text-text-muted hover:bg-white/[0.06] hover:text-text-secondary border border-white/[0.06]'}
                `}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className="truncate">Tab {tab.tab}</span>
                    
                    {/* Status indicator */}
                    {effectiveStatus === 'generating' && (
                      <Loader2 className="w-3 h-3 animate-spin text-blue-300 flex-shrink-0" />
                    )}
                    {effectiveStatus === 'complete' && (
                      <CheckCircle2 className="w-3 h-3 text-status-success flex-shrink-0" />
                    )}
                    {effectiveStatus === 'error' && (
                      <AlertCircle className="w-3 h-3 text-status-error flex-shrink-0" />
                    )}
                  </div>
                  
                  {/* Close button - hide for Tab 1 */}
                  {tab.tab !== 1 && (
                    <div
                      onClick={(e) => handleCloseTab(tab.tab, tab.groupId, e)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-white/[0.1] rounded-full flex-shrink-0 cursor-pointer"
                      aria-label={`Close Tab ${tab.tab}`}
                      role="button"
                    >
                      <X className="w-3 h-3" />
                    </div>
                  )}
                </div>
                
                {/* Tooltip with story title and details */}
                <div className="absolute hidden group-hover:block bottom-full left-0 mb-2 w-64 p-3 bg-surface-primary rounded-xl shadow-xl text-xs z-50 border border-white/[0.08]">
                  <p className="font-semibold truncate text-white mb-1">{tab.storyTitle}</p>
                  
                  <div className="space-y-1 text-text-muted">
                    {effectiveStatus === 'generating' && (
                      <>
                        <p>Progress: {tab.progress}%</p>
                        {tab.totalBatches > 0 && (
                          <p>Batches: {tab.completedBatches}/{tab.totalBatches}</p>
                        )}
                      </>
                    )}
                    {effectiveStatus === 'complete' && (
                      <p className="text-status-success">✓ Completed</p>
                    )}
                    {effectiveStatus === 'error' && (
                      <p className="text-status-error">✗ Error occurred</p>
                    )}
                    {effectiveStatus === 'idle' && (
                      <p>Not started</p>
                    )}
                    
                    {tab.estimatedTokens > 0 && (
                      <p className="text-text-muted pt-1 border-t border-white/[0.06]">
                        Est. tokens: {formatTokenCount(tab.estimatedTokens)}
                      </p>
                    )}
                    
                    {tab.tokensUsed > 0 && (
                      <p className="text-text-muted">
                        Used: {formatTokenCount(tab.tokensUsed)} tokens
                      </p>
                    )}
                  </div>
                </div>
              </button>
            );
            })
          )}
        </div>

        {/* Add Tab Button */}
        {tabs.length < 10 && (
          <button
            onClick={handleCreateTab}
            disabled={creating}
            className={`
              px-3 py-2 rounded-full text-white text-sm font-medium 
              flex items-center gap-1 transition-all duration-200 flex-shrink-0 backdrop-blur-sm
              ${creating 
                ? 'bg-white/[0.03] border border-white/[0.06] cursor-not-allowed opacity-50' 
                : 'bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.08] hover:border-white/[0.12]'}
            `}
            title="Create new tab (Elite, Ultimate, and Enterprise only)"
          >
            {creating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">
              {creating ? 'Creating...' : 'New Tab'}
            </span>
          </button>
        )}
      </div>

      {/* Total Token Estimate - Premium Users Info Bar */}
      {tabs.length > 0 && (
        <div className="mt-3 flex items-center justify-between text-xs">
          <div className="text-text-muted">
            Active tabs: <span className="font-semibold text-white">{tabs.length}/10</span>
          </div>
          
          {totalEstimatedTokens > 0 && (
            <div className="text-text-muted">
              Total estimated: <span className="font-semibold text-accent-text">{formatTokenCount(totalEstimatedTokens)}</span> tokens
            </div>
          )}
        </div>
      )}
    </div>
  );
}
