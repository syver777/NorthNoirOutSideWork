// Utility functions for multi-tab story generation (Enterprise users)
// Handles token estimation, tab management, and active tab tracking

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

export interface TokenEstimate {
  outlineTokens: number;
  storyGenerationTokens: number;
  correctionTokens: number;
  totalTokens: number;
}

export interface TabInfo {
  tab: number;
  groupId: string;
  storyTitle: string;
  status: 'idle' | 'outline' | 'generating' | 'error' | 'complete';
  progress: number;
  estimatedTokens: number;
  tokensUsed: number;
  createdAt: string;
  lastActivity: string;
  totalBatches: number;
  completedBatches: number;
  // Form input fields (story)
  storyDescription?: string;
  wordCount?: number;
  language?: string;
  model?: string;
  // Form input fields (image)
  style?: string;
  useCharacterDescriptions?: boolean;
  firstPageFrequency?: number;
  restFrequency?: number;
  imageModel?: string;
  selectedDocId?: string;
  // Pre-generation estimate (for multi-tab validation)
  estimate_tokens?: number;
}

export interface TabEstimate {
  tab: number;
  estimate_tokens: number;
  title: string;
}

export interface UserPlan {
  planType: 'free' | 'standard' | 'plus' | 'premium' | 'pro' | 'elite' | 'ultimate' | 'enterprise';
  tokensAllocated: number;
  tokensUsed: number;
  isEnterprise: boolean;
}

// Model configurations matching backend
const MODEL_CONFIGS = {
  deepseek: { multiplier: 1, maxWordsPerBatch: 1100 },
  sonnet: { multiplier: 10, maxWordsPerBatch: 3000 },
  opus: { multiplier: 48, maxWordsPerBatch: 3000 },
};

const OUTLINE_TOKENS = 1500;
const FEEDBACK_TOKENS = 1200;
const STORY_GENERATION_TOKENS_PER_WORD = 1.33;

/**
 * Calculate estimated tokens for a story generation
 */
export function calculateEstimatedTokens(
  wordCount: number,
  model: 'deepseek' | 'sonnet' | 'opus',
  includeCorrectedVersion: boolean = false
): TokenEstimate {
  const config = MODEL_CONFIGS[model];
  
  // Outline generation (fixed cost)
  const outlineTokens = Math.round(OUTLINE_TOKENS * config.multiplier);
  
  // Story generation (based on word count and model)
  const storyGenerationTokens = Math.round(
    wordCount * STORY_GENERATION_TOKENS_PER_WORD * config.multiplier
  );
  
  // Correction (if enabled, includes feedback + regeneration)
  const correctionTokens = includeCorrectedVersion 
    ? Math.round((FEEDBACK_TOKENS + wordCount * STORY_GENERATION_TOKENS_PER_WORD) * config.multiplier)
    : 0;
  
  return {
    outlineTokens,
    storyGenerationTokens,
    correctionTokens,
    totalTokens: outlineTokens + storyGenerationTokens + correctionTokens,
  };
}

/**
 * Check if user has tabs feature (elite, ultimate, or enterprise plan)
 */
export async function checkIsEnterpriseUser(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('user_plans')
      .select('plan_type')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();
    
    if (error || !data) return false;
    return ['elite', 'ultimate', 'enterprise'].includes(data.plan_type);
  } catch (error) {
    console.error('Error checking tabs feature status:', error);
    return false;
  }
}

/**
 * Get user's plan information
 */
export async function getUserPlan(userId: string): Promise<UserPlan | null> {
  try {
    const { data, error } = await supabase
      .from('user_plans')
      .select('plan_type, tokens_allocated, tokens_used')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();
    
    if (error || !data) return null;
    
    return {
      planType: data.plan_type,
      tokensAllocated: data.tokens_allocated,
      tokensUsed: data.tokens_used,
      isEnterprise: ['elite', 'ultimate', 'enterprise'].includes(data.plan_type),
    };
  } catch (error) {
    console.error('Error fetching user plan:', error);
    return null;
  }
}

/**
 * Create a new tab in the database
 */
export async function createTab(
  userId: string,
  page: string = 'story',
  tabNumber: number,
  groupId?: string,
  title?: string,
  formInputs?: {
    storyDescription?: string;
    wordCount?: number;
    language?: string;
    model?: string;
  },
  processImage?: boolean
): Promise<boolean> {
  try {
    // Use insert - let the unique index handle conflicts
    // The unique index on (user_id, page, tab_number, COALESCE(process_image, false))
    // allows separate tab systems for standalone vs combined workflows
    const { error } = await supabase
      .from('tabs')
      .insert({
        user_id: userId,
        page,
        tab_number: tabNumber,
        status: 'idle',
        group_id: groupId || null,
        title: title || '',
        story_description: formInputs?.storyDescription || '',
        word_count: formInputs?.wordCount || null,
        language: formInputs?.language || 'english',
        model: formInputs?.model || 'sonnet',
        process_image: processImage || false,
        estimate_tokens: 0,
      });
    
    // Ignore duplicate key errors (tab already exists with same process_image value)
    if (error && error.code !== '23505') {
      throw error;
    }
    
    return true;
  } catch (error) {
    console.error('Error creating/updating tab:', error);
    return false;
  }
}

/**
 * Get all tabs for a specific page
 */
export async function getTabsForPage(userId: string, page: string = 'story'): Promise<TabInfo[]> {
  try {
    // For image_prompt page, only get standalone tabs (process_image=false or null)
    // This separates ImagePrompts standalone tabs from ImageGenerator combined workflow tabs
    let query = supabase
      .from('tabs')
      .select('*')
      .eq('user_id', userId)
      .eq('page', page);
    
    if (page === 'image_prompt') {
      query = query.or('process_image.is.null,process_image.eq.false');
    }
    
    const { data: tabs, error } = await query.order('tab_number', { ascending: true });
    
    if (error) throw error;
    if (!tabs || tabs.length === 0) return [];
    
    // Convert database tabs to TabInfo format
    return tabs.map(tab => ({
        tab: tab.tab_number,
        groupId: tab.group_id || '',
        storyTitle: tab.title || `Tab ${tab.tab_number}`,
        status: tab.status as 'idle' | 'outline' | 'generating' | 'error' | 'complete',
      progress: 0,
      estimatedTokens: 0,
      tokensUsed: 0,
      createdAt: tab.created_at,
      lastActivity: tab.updated_at,
      totalBatches: 0,
      completedBatches: 0,
      // Form input fields
      storyDescription: tab.story_description || '',
      wordCount: tab.word_count || undefined,
      language: tab.language || 'english',
      model: tab.model || 'deepseek',
    }));
  } catch (error) {
    console.error('Error fetching tabs:', error);
    return [];
  }
}

/**
 * Update tab status and metadata
 */
export async function updateTabStatus(
  userId: string,
  page: string = 'story',
  tabNumber: number,
  status: 'idle' | 'outline' | 'generating' | 'error' | 'complete',
  groupId?: string | null,
  title?: string,
  processImage?: boolean
): Promise<boolean> {
  try {
    const updates: any = { status };
    if (groupId !== undefined) updates.group_id = groupId;
    if (title !== undefined) updates.title = title;
    
    let query = supabase
      .from('tabs')
      .update(updates)
      .eq('user_id', userId)
      .eq('page', page)
      .eq('tab_number', tabNumber);
    
    // For image_prompt page, filter by process_image if specified
    // This prevents updating standalone tabs when updating combined workflow tabs
    if (page === 'image_prompt' && processImage !== undefined) {
      query = query.eq('process_image', processImage);
    }
    
    const { error } = await query;
    
    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error updating tab status:', error);
    return false;
  }
}

/**
 * Update tab group_id and selected_doc_id
 */
export async function updateTabGroupAndDoc(
  userId: string,
  page: string = 'story',
  tabNumber: number,
  groupId: string,
  selectedDocId?: string,
  title?: string,
  description?: string
): Promise<boolean> {
  try {
    const updates: any = { group_id: groupId };
    if (selectedDocId !== undefined) updates.selected_doc_id = selectedDocId;
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.story_description = description;
    
    const { error } = await supabase
      .from('tabs')
      .update(updates)
      .eq('user_id', userId)
      .eq('page', page)
      .eq('tab_number', tabNumber);
    
    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error updating tab group and doc:', error);
    return false;
  }
}

/**
 * Save tab form inputs to database
 */
export async function saveTabFormInputs(
  userId: string,
  page: string = 'story',
  tabNumber: number,
  formInputs: {
    title?: string;
    storyDescription?: string;
    wordCount?: number;
    language?: string;
    model?: string;
    isRuntimeMode?: boolean;
    runtimeMinutes?: number;
    masterPromptEnabled?: boolean;
    masterPromptEnhanceAI?: boolean;
    masterPromptData?: any;
    pauseTTS?: boolean;
    youtubeInspirationEnabled?: boolean;
    youtubeLinks?: string[];
  }
): Promise<boolean> {
  try {
    const updates: any = {};
    if (formInputs.title !== undefined) updates.title = formInputs.title;
    if (formInputs.storyDescription !== undefined) updates.story_description = formInputs.storyDescription;
    if (formInputs.wordCount !== undefined) updates.word_count = formInputs.wordCount;
    if (formInputs.language !== undefined) updates.language = formInputs.language;
    if (formInputs.model !== undefined) updates.model = formInputs.model;
    if (formInputs.isRuntimeMode !== undefined) updates.is_runtime_mode = formInputs.isRuntimeMode;
    if (formInputs.runtimeMinutes !== undefined) updates.runtime_minutes = formInputs.runtimeMinutes;
    if (formInputs.masterPromptEnabled !== undefined) {
      updates.master_prompt = formInputs.masterPromptEnabled ? formInputs.masterPromptData : null;
    }
    if (formInputs.masterPromptEnhanceAI !== undefined) {
      updates.master_prompt_enhance_ai = formInputs.masterPromptEnhanceAI;
    }
    if (formInputs.pauseTTS !== undefined) {
      updates.pause_tts = formInputs.pauseTTS;
    }
    if (formInputs.youtubeInspirationEnabled !== undefined) {
      updates.youtube_inspiration_enabled = formInputs.youtubeInspirationEnabled;
    }
    if (formInputs.youtubeLinks !== undefined) {
      updates.youtube_links = formInputs.youtubeLinks;
    }
    
    const { error } = await supabase
      .from('tabs')
      .update(updates)
      .eq('user_id', userId)
      .eq('page', page)
      .eq('tab_number', tabNumber);
    
    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error saving tab form inputs:', error);
    return false;
  }
}

/**
 * Save image tab form inputs to database
 */
export async function saveImageTabFormInputs(
  userId: string,
  tabNumber: number,
  formInputs: {
    style?: string;
    useCharacterDescriptions?: boolean;
    customCharactersEnabled?: boolean;
    customCharacters?: Array<{ name: string; description: string }>;
    customCharactersAIEnhance?: boolean;
    firstPageFrequency?: number;
    restFrequency?: number;
    imageModel?: string;
    language?: string;
    model?: string;
    frequencyMode?: string;
    frequencyType?: string;
    consistentFrequency?: number;
    audioDistributionType?: string;
    firstPageImageAmount?: number;
    restImageAmount?: number;
    totalAudioDuration?: number;
    imageAmount?: number;
  }
): Promise<boolean> {
  try {
    // For consistent frequency, store NULL in first_page_frequency and value in rest_frequency
    // For variable frequency, store values in both fields
    const firstPageFreq = formInputs.frequencyType === 'consistent' 
      ? null 
      : formInputs.firstPageFrequency;
    const restFreq = formInputs.frequencyType === 'consistent'
      ? formInputs.consistentFrequency
      : formInputs.restFrequency;
    
    const { error } = await supabase
      .from('tabs')
      .update({
        style: formInputs.style,
        use_character_descriptions: formInputs.useCharacterDescriptions,
        first_page_frequency: firstPageFreq,
        rest_frequency: restFreq,
        image_model: formInputs.imageModel,
        language: formInputs.language,
        model: formInputs.model,
        frequency_mode: formInputs.frequencyMode,
        frequency_type: formInputs.frequencyType,
        consistent_frequency: formInputs.consistentFrequency,
        audio_distribution_type: formInputs.audioDistributionType,
        first_page_image_amount: formInputs.firstPageImageAmount,
        rest_image_amount: formInputs.restImageAmount,
        total_audio_duration: formInputs.totalAudioDuration,
        image_amount: formInputs.imageAmount,
        // Store custom character settings in the master_prompt JSONB column
        master_prompt: {
          customCharactersEnabled: formInputs.customCharactersEnabled ?? false,
          customCharacters: formInputs.customCharacters ?? [],
          customCharactersAIEnhance: formInputs.customCharactersAIEnhance ?? false,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('page', 'image_prompt')
      .eq('tab_number', tabNumber);

    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error saving image tab form inputs:', error);
    return false;
  }
}

/**
 * Reset tab to default values (for Done/Stop actions)
 */
export async function resetTabToDefaults(
  userId: string,
  page: string = 'story',
  tabNumber: number
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('tabs')
      .update({
        title: '',
        story_description: '',
        word_count: null,
        language: 'english',
        model: 'sonnet',
        status: 'idle',
        estimate_tokens: 0,
      })
      .eq('user_id', userId)
      .eq('page', page)
      .eq('tab_number', tabNumber);
    
    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error resetting tab to defaults:', error);
    return false;
  }
}

/**
 * Save estimate_tokens to a specific tab (called when user clicks Start Generation)
 */
export async function saveTabEstimateTokens(
  userId: string,
  page: string = 'video',
  tabNumber: number,
  estimateTokens: number
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('tabs')
      .update({
        estimate_tokens: estimateTokens,
      })
      .eq('user_id', userId)
      .eq('page', page)
      .eq('tab_number', tabNumber);
    
    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error saving tab estimate tokens:', error);
    return false;
  }
}

/**
 * Get total estimate_tokens across all tabs for a given page
 * Used for multi-tab token validation
 */
export async function getTotalEstimateTokensForPage(
  userId: string,
  page: string = 'video'
): Promise<{ total: number; tabEstimates: TabEstimate[] }> {
  try {
    const { data, error } = await supabase
      .from('tabs')
      .select('tab_number, estimate_tokens, title')
      .eq('user_id', userId)
      .eq('page', page)
      .gt('estimate_tokens', 0);
    
    if (error) throw error;
    
    const tabEstimates: TabEstimate[] = (data || []).map(row => ({
      tab: row.tab_number,
      estimate_tokens: row.estimate_tokens || 0,
      title: row.title || `Tab ${row.tab_number}`
    }));
    
    const total = tabEstimates.reduce((sum, tab) => sum + tab.estimate_tokens, 0);
    
    return { total, tabEstimates };
  } catch (error) {
    console.error('Error getting total estimate tokens:', error);
    return { total: 0, tabEstimates: [] };
  }
}

/**
 * Reset image tab to default values (for Done/Stop actions)
 */
export async function resetImageTabToDefaults(
  userId: string,
  tabNumber: number
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('tabs')
      .update({
        status: 'idle',
        group_id: null,
        title: null,
        style: '',
        use_character_descriptions: true,
        first_page_frequency: 30,
        rest_frequency: 60,
        image_model: 'gpt-image-1-mini',
        language: 'english',
        model: 'sonnet',
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('page', 'image_prompt')
      .eq('tab_number', tabNumber);

    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error resetting image tab to defaults:', error);
    return false;
  }
}

/**
 * Get tab form inputs from database
 */
export async function getTabFormInputs(
  userId: string,
  page: string = 'story',
  tabNumber: number
): Promise<{
  title: string;
  storyDescription: string;
  wordCount: string;
  language: string;
  model: string;
  youtubeInspirationEnabled?: boolean;
  youtubeLinks?: string[];
} | null> {
  try {
    const { data, error } = await supabase
      .from('tabs')
      .select('title, story_description, word_count, language, model, youtube_inspiration_enabled, youtube_links')
      .eq('user_id', userId)
      .eq('page', page)
      .eq('tab_number', tabNumber)
      .maybeSingle();
    
    if (error) throw error;
    if (!data) return null;
    
    return {
      title: data.title || '',
      storyDescription: data.story_description || '',
      wordCount: data.word_count ? String(data.word_count) : '',
      language: data.language || 'english',
      model: data.model || 'sonnet',
      youtubeInspirationEnabled: data.youtube_inspiration_enabled || false,
      youtubeLinks: data.youtube_links || undefined,
    };
  } catch (error) {
    console.error('Error getting tab form inputs:', error);
    return null;
  }
}

/**
 * Get image tab form inputs from database
 */
export async function getImageTabFormInputs(
  userId: string,
  tabNumber: number
): Promise<{
  style: string;
  useCharacterDescriptions: boolean;
  customCharactersEnabled?: boolean;
  customCharacters?: Array<{ name: string; description: string }>;
  customCharactersAIEnhance?: boolean;
  firstPageFrequency: number;
  restFrequency: number;
  imageModel: string;
  language: string;
  model: string;
  frequencyMode?: string;
  frequencyType?: string;
  consistentFrequency?: number;
  audioDistributionType?: string;
  firstPageImageAmount?: number;
  restImageAmount?: number;
  totalAudioDuration?: number;
  imageAmount?: number;
} | null> {
  try {
    const { data, error } = await supabase
      .from('tabs')
      .select('style, use_character_descriptions, first_page_frequency, rest_frequency, image_model, language, model, frequency_mode, frequency_type, consistent_frequency, audio_distribution_type, first_page_image_amount, rest_image_amount, total_audio_duration, image_amount, master_prompt')
      .eq('user_id', userId)
      .eq('page', 'image_prompt')
      .eq('tab_number', tabNumber)
      .maybeSingle();

    if (error || !data) return null;

    // Extract custom character settings from master_prompt JSONB
    const masterPrompt = data.master_prompt as any;

    return {
      style: data.style || '',
      useCharacterDescriptions: data.use_character_descriptions ?? true,
      customCharactersEnabled: masterPrompt?.customCharactersEnabled ?? false,
      customCharacters: masterPrompt?.customCharacters ?? [],
      customCharactersAIEnhance: masterPrompt?.customCharactersAIEnhance ?? false,
      firstPageFrequency: data.first_page_frequency || 30,
      restFrequency: data.rest_frequency || 60,
      imageModel: data.image_model || 'gpt-image-1-mini',
      language: data.language || 'english',
      model: data.model || 'sonnet',
      frequencyMode: data.frequency_mode || 'wordcount',
      frequencyType: data.frequency_type || 'consistent',
      consistentFrequency: data.consistent_frequency,
      audioDistributionType: data.audio_distribution_type || 'consistent',
      firstPageImageAmount: data.first_page_image_amount,
      restImageAmount: data.rest_image_amount,
      totalAudioDuration: data.total_audio_duration,
      imageAmount: data.image_amount,
    };
  } catch (error) {
    console.error('Error getting image tab form inputs:', error);
    return null;
  }
}

/**
 * Save image generator tab form inputs (for pure image generation page)
 */
export async function saveImageGeneratorTabInputs(
  userId: string,
  tabNumber: number,
  formInputs: {
    selectedDocumentModel?: string;
  }
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('tabs')
      .update({
        image_model: formInputs.selectedDocumentModel,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('page', 'image')
      .eq('tab_number', tabNumber);

    if (error) {
      console.error('Error saving image generator tab inputs:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error in saveImageGeneratorTabInputs:', error);
    return false;
  }
}

/**
 * Get image generator tab form inputs
 */
export async function getImageGeneratorTabInputs(
  userId: string,
  tabNumber: number
): Promise<{
  selectedDocumentModel: string;
  selectedDocId?: string;
} | null> {
  try {
    const { data: tab, error } = await supabase
      .from('tabs')
      .select('image_model, selected_doc_id')
      .eq('user_id', userId)
      .eq('page', 'image')
      .eq('tab_number', tabNumber)
      .maybeSingle();

    if (error || !tab) {
      console.error('Error fetching image generator tab inputs:', error);
      return null;
    }

    return {
      selectedDocumentModel: tab.image_model || 'gpt-image-1-mini',
      selectedDocId: tab.selected_doc_id || undefined,
    };
  } catch (error) {
    console.error('Error in getImageGeneratorTabInputs:', error);
    return null;
  }
}

/**
 * Reset image generator tab to default values (as if freshly created)
 */
export async function resetImageGeneratorTabToDefaults(
  userId: string,
  tabNumber: number
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('tabs')
      .update({
        status: 'idle',
        group_id: null,
        title: `Tab ${tabNumber}`,
        selected_doc_id: null,
        image_model: 'gpt-image-1-mini',
        style: null,
        use_character_descriptions: true,
        first_page_frequency: 30,
        rest_frequency: 60,
        language: 'english',
        model: 'sonnet',
        estimate_tokens: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('page', 'image')
      .eq('tab_number', tabNumber);

    if (error) {
      console.error('Error resetting image generator tab:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error in resetImageGeneratorTabToDefaults:', error);
    return false;
  }
}

/**
 * Reset audio tab to default values (for Done/Stop actions in TextToSpeech)
 */
export async function resetAudioTabToDefaults(
  userId: string,
  tabNumber: number
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('tabs')
      .update({
        status: 'idle',
        group_id: null,
        title: null,
        selected_doc_id: null,
        estimate_tokens: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('page', 'audio')
      .eq('tab_number', tabNumber);

    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error resetting audio tab to defaults:', error);
    return false;
  }
}

/**
 * Delete a tab from the database
 */
export async function deleteTabFromDB(
  userId: string,
  page: string = 'story',
  tabNumber: number
): Promise<boolean> {
  try {
    // For image_prompt page, only delete standalone tabs (process_image=false or null)
    let deleteQuery = supabase
      .from('tabs')
      .delete()
      .eq('user_id', userId)
      .eq('page', page)
      .eq('tab_number', tabNumber);
    
    if (page === 'image_prompt') {
      // Only delete standalone tabs, not combined workflow tabs
      deleteQuery = deleteQuery.or('process_image.is.null,process_image.eq.false');
    }
    
    const { error } = await deleteQuery;
    
    if (error) throw error;

    // If deleting image page tab, also delete matching image_prompt tab with process_image=TRUE
    if (page === 'image') {
      const { error: promptTabError } = await supabase
        .from('tabs')
        .delete()
        .eq('user_id', userId)
        .eq('page', 'image_prompt')
        .eq('tab_number', tabNumber)
        .eq('process_image', true);
      
      if (promptTabError) {
        console.error('Error deleting matching image_prompt tab:', promptTabError);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error deleting tab from database:', error);
    return false;
  }
}

/**
 * Get combined status for image page tabs (checks both image and image_prompt rows)
 */
function getCombinedImageStatus(
  imageTab: any | null,
  imagePromptTab: any | null
): 'idle' | 'generating' | 'complete' | 'error' {
  console.log(`[getCombinedImageStatus] imageTab status: ${imageTab?.status}, imagePromptTab status: ${imagePromptTab?.status}`);
  
  // If no image_prompt tab exists, this is standalone image generation
  // Return the status from the tabs table directly (complete, idle, etc.)
  if (!imagePromptTab) {
    const status = imageTab?.status || 'idle';
    console.log(`[getCombinedImageStatus] No prompt tab, returning imageTab status: ${status}`);
    return status;
  }

  // If either tab has error status
  if (imageTab?.status === 'error' || imagePromptTab?.status === 'error') {
    return 'error';
  }

  // If either is generating, show blue (generating)
  if (imageTab?.status === 'generating' || imagePromptTab?.status === 'generating') {
    return 'generating';
  }

  // If both complete, show green
  if (imageTab?.status === 'complete' && imagePromptTab?.status === 'complete') {
    return 'complete';
  }

  // If both idle, show gray
  if (imageTab?.status === 'idle' && imagePromptTab?.status === 'idle') {
    return 'idle';
  }

  // Mixed state - default to generating
  return 'generating';
}

/**
 * Get next available tab number for a page
 */
export async function getNextAvailableTab(userId: string, page: string = 'story'): Promise<number | null> {
  try {
    // For image_prompt page, only check standalone tabs (process_image=false or null)
    // This allows independent tab numbering for standalone vs combined workflows
    let query = supabase
      .from('tabs')
      .select('tab_number')
      .eq('user_id', userId)
      .eq('page', page);
    
    if (page === 'image_prompt') {
      query = query.or('process_image.is.null,process_image.eq.false');
    }
    
    const { error, data: tabs } = await query;
    
    if (error) throw error;
    
    const usedTabs = new Set(tabs?.map(t => t.tab_number) || []);
    
    // Find first available tab (1-10)
    for (let i = 1; i <= 10; i++) {
      if (!usedTabs.has(i)) {
        return i;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error getting next available tab:', error);
    return null;
  }
}

/**
 * Get all active image tabs for a user with enriched data from image_prompt_tasks
 */
async function getUserActiveImageTabs(userId: string, page: 'image_prompt' | 'image' = 'image_prompt'): Promise<TabInfo[]> {
  try {
    // For image page, check image_prompt_tasks with process_image=TRUE to determine status
    if (page === 'image') {
      console.log(`[getUserActiveImageTabs] Fetching image tabs for user ${userId}`);
      
      // Get image tabs from database
      const { data: imageTabs, error: imageTabsError } = await supabase
        .from('tabs')
        .select('*')
        .eq('user_id', userId)
        .eq('page', 'image')
        .order('tab_number', { ascending: true });

      if (imageTabsError) {
        console.error('[getUserActiveImageTabs] Error fetching image tabs:', imageTabsError);
        return [];
      }

      if (!imageTabs || imageTabs.length === 0) {
        console.log('[getUserActiveImageTabs] No image tabs found');
        return [];
      }

      console.log(`[getUserActiveImageTabs] Found ${imageTabs.length} image tabs`);

      // Fetch image_prompt_tasks with process_image=TRUE to determine actual status
      const { data: imageTasks, error: imageTasksError } = await supabase
        .from('image_prompt_tasks')
        .select('*')
        .eq('user_id', userId)
        .eq('process_image', true)
        .or('video_process.is.null,video_process.eq.false')
        .or('itv.is.null,itv.eq.false');

      if (imageTasksError) {
        console.error('[getUserActiveImageTabs] Error fetching image_prompt_tasks:', imageTasksError);
      }

      console.log(`[getUserActiveImageTabs] Found ${imageTasks?.length || 0} image_prompt_tasks with process_image=TRUE`);

      // Fetch image_prompt tab rows with process_image=TRUE from tabs table
      // These represent combined workflow status and are used when no tasks exist yet
      const { data: imagePromptTabRows, error: imagePromptTabRowsError } = await supabase
        .from('tabs')
        .select('tab_number, status')
        .eq('user_id', userId)
        .eq('page', 'image_prompt')
        .eq('process_image', true);

      if (imagePromptTabRowsError) {
        console.error('[getUserActiveImageTabs] Error fetching image_prompt tab rows:', imagePromptTabRowsError);
      }

      const imagePromptTabsByTabNumber = new Map<number, any>();
      if (imagePromptTabRows && imagePromptTabRows.length > 0) {
        imagePromptTabRows.forEach(row => {
          imagePromptTabsByTabNumber.set(row.tab_number, row);
        });
      }

      // Fetch image_tasks for actual image generation status
      const { data: imageGenTasks, error: imageGenTasksError } = await supabase
        .from('image_tasks')
        .select('*')
        .eq('user_id', userId)
        .or('video_process.is.null,video_process.eq.false')
        .or('itv.is.null,itv.eq.false');

      if (imageGenTasksError) {
        console.error('[getUserActiveImageTabs] Error fetching image_tasks:', imageGenTasksError);
      }

      console.log(`[getUserActiveImageTabs] Found ${imageGenTasks?.length || 0} image_tasks`);

      // Create maps of tab -> tasks for quick lookup
      const promptTasksByTab = new Map<number, any[]>();
      if (imageTasks && imageTasks.length > 0) {
        imageTasks.forEach(task => {
          if (!promptTasksByTab.has(task.tab)) {
            promptTasksByTab.set(task.tab, []);
          }
          promptTasksByTab.get(task.tab)!.push(task);
        });
      }

      const imageGenTasksByTab = new Map<number, any[]>();
      if (imageGenTasks && imageGenTasks.length > 0) {
        imageGenTasks.forEach(task => {
          if (!imageGenTasksByTab.has(task.tab)) {
            imageGenTasksByTab.set(task.tab, []);
          }
          imageGenTasksByTab.get(task.tab)!.push(task);
        });
      }

      // Return tabs with status determined from both image_prompt_tasks and image_tasks
      return imageTabs.map(tab => {
        const promptTasks = promptTasksByTab.get(tab.tab_number) || [];
        const imageGenTasksForTab = imageGenTasksByTab.get(tab.tab_number) || [];
        
        // Determine status based on BOTH phases
        let status: 'idle' | 'outline' | 'generating' | 'error' | 'complete' = tab.status || 'idle';
        let progress = 0;
        let totalBatches = 0;
        let completedBatches = 0;

        // Phase 1: Image Prompt Generation (if exists)
        let promptPhaseComplete = promptTasks.length === 0; // If no prompt tasks, phase is "complete" (skipped)
        let promptPhaseRunning = false;
        let promptPhaseError = false;

        if (promptTasks.length > 0) {
          const allPromptsCompleted = promptTasks.every(t => 
            t.status === 'completed' || t.status === 'completed_final'
          );
          const hasPromptRunning = promptTasks.some(t => t.status === 'running' || t.status === 'queued');
          const hasPromptError = promptTasks.some(t => t.status === 'error');

          promptPhaseComplete = allPromptsCompleted;
          promptPhaseRunning = hasPromptRunning;
          promptPhaseError = hasPromptError;
          
          totalBatches += Math.max(...promptTasks.map(t => t.total_batches || 0));
          completedBatches += promptTasks.filter(t => 
            t.status === 'completed' || t.status === 'completed_final'
          ).length;
        }

        // Phase 2: Image Generation (if exists)
        let imagePhaseComplete = imageGenTasksForTab.length === 0; // If no image tasks, phase is "complete" (not started)
        let imagePhaseRunning = false;
        let imagePhaseError = false;

        if (imageGenTasksForTab.length > 0) {
          const allImagesCompleted = imageGenTasksForTab.every(t => 
            t.status === 'completed' || t.status === 'completed_final'
          );
          const hasImageRunning = imageGenTasksForTab.some(t => t.status === 'running' || t.status === 'queued');
          const hasImageError = imageGenTasksForTab.some(t => t.status === 'error');

          imagePhaseComplete = allImagesCompleted;
          imagePhaseRunning = hasImageRunning;
          imagePhaseError = hasImageError;

          totalBatches += Math.max(...imageGenTasksForTab.map(t => t.total_batches || 0));
          completedBatches += imageGenTasksForTab.filter(t => 
            t.status === 'completed' || t.status === 'completed_final'
          ).length;
        }

        // Determine overall status
        if (promptPhaseError || imagePhaseError) {
          status = 'error';
        } else if (promptPhaseComplete && imagePhaseComplete && (promptTasks.length > 0 || imageGenTasksForTab.length > 0)) {
          // Only mark complete if at least one phase has tasks and both are complete
          status = 'complete';
          progress = 100;
        } else if (promptPhaseRunning || imagePhaseRunning) {
          status = 'generating';
          progress = totalBatches > 0 ? Math.round((completedBatches / totalBatches) * 100) : 0;
        } else if (promptTasks.length === 0 && imageGenTasksForTab.length === 0) {
          // No tasks created yet — use getCombinedImageStatus to check the tabs table
          // This handles the window between clicking Generate and tasks being created,
          // as well as the case where image_prompt (process_image=TRUE) tab is generating
          const imagePromptTabRow = imagePromptTabsByTabNumber.get(tab.tab_number) || null;
          status = getCombinedImageStatus(tab, imagePromptTabRow);
          progress = 0;
        }
        
        console.log(`[getUserActiveImageTabs] Tab ${tab.tab_number}: status=${status}, promptTasks=${promptTasks.length}, imageTasks=${imageGenTasksForTab.length}, promptComplete=${promptPhaseComplete}, imageComplete=${imagePhaseComplete}`);
        
        return {
          tab: tab.tab_number,
          groupId: tab.group_id || '',
          storyTitle: tab.title || `Tab ${tab.tab_number}`,
          status,
          progress,
          estimatedTokens: 0,
          tokensUsed: 0,
          createdAt: tab.created_at,
          lastActivity: tab.updated_at,
          totalBatches,
          completedBatches,
          // Image-specific fields from tabs table
          style: tab.style || '',
          useCharacterDescriptions: tab.use_character_descriptions ?? true,
          firstPageFrequency: tab.first_page_frequency || 30,
          restFrequency: tab.rest_frequency || 60,
          imageModel: tab.image_model || 'gpt-image-1-mini',
          language: tab.language || 'english',
          model: tab.model || 'sonnet',
        };
      });
    }

    // For image_prompt page, fetch tabs excluding combined workflow tabs
    const { data: tabs, error: tabsError } = await supabase
      .from('tabs')
      .select('*')
      .eq('user_id', userId)
      .eq('page', 'image_prompt')
      .or('process_image.is.null,process_image.eq.false')
      .order('tab_number', { ascending: true });

    if (tabsError) throw tabsError;
    if (!tabs || tabs.length === 0) return [];

    // Fetch all image_prompt_tasks for this user
    // We'll filter out video workflow tasks in memory
    const { data: allTasks, error: tasksError } = await supabase
      .from('image_prompt_tasks')
      .select('*')
      .eq('user_id', userId);

    if (tasksError) {
      console.error('[getUserActiveImageTabs] Error fetching tasks:', tasksError);
      throw tasksError;
    }

    // Filter tasks to exclude combined workflow (process_image=TRUE), video workflow (video_process=TRUE) and ITV workflow (itv=TRUE)
    const tasks = (allTasks || []).filter(t => 
      (t.process_image === null || t.process_image === false) &&
      (t.video_process === null || t.video_process === false) &&
      (t.itv === null || t.itv === undefined || t.itv === false)
    );

    // Build TabInfo array
    const tabInfos: TabInfo[] = tabs.map(tab => {
      // Filter tasks for this tab
      const tabTasks = (tasks || []).filter(t => t.tab === tab.tab_number);
      
      // Determine status and progress
      let status: 'idle' | 'outline' | 'generating' | 'error' | 'complete' = 'idle';
      let progress = 0;
      let totalBatches = 0;
      let completedBatches = 0;
      let estimatedTokens = 0;
      let tokensUsed = 0;

      if (tabTasks.length > 0) {
        // Find max total_batches
        totalBatches = Math.max(...tabTasks.map(t => t.total_batches || 0));
        
        // Count completed batches
        completedBatches = tabTasks.filter(t => 
          t.status === 'completed' || t.status === 'completed_final'
        ).length;

        // Check for running tasks
        const hasRunning = tabTasks.some(t => t.status === 'running' || t.status === 'queued');
        const hasError = tabTasks.some(t => t.status === 'error');
        const allCompleted = tabTasks.every(t => 
          t.status === 'completed' || t.status === 'completed_final'
        );

        if (hasError) {
          status = 'error';
        } else if (allCompleted && tabTasks.length > 0) {
          status = 'complete';
          progress = 100;
        } else if (hasRunning) {
          status = 'generating';
          progress = totalBatches > 0 ? Math.round((completedBatches / totalBatches) * 100) : 0;
        }

        // Sum tokens
        tokensUsed = tabTasks.reduce((sum, t) => sum + (t.input_tokens || 0) + (t.output_tokens || 0), 0);
        
        // Estimate remaining tokens (rough approximation)
        const avgTokensPerTask = tabTasks.length > 0 ? tokensUsed / tabTasks.length : 0;
        const remainingTasks = Math.max(0, totalBatches - completedBatches);
        estimatedTokens = tokensUsed + Math.round(avgTokensPerTask * remainingTasks);
      }

      return {
        tab: tab.tab_number,
        groupId: tab.group_id || '',
        storyTitle: tab.title || `Tab ${tab.tab_number}`,
        status,
        progress,
        estimatedTokens,
        tokensUsed,
        createdAt: tab.created_at,
        lastActivity: tab.updated_at,
        totalBatches,
        completedBatches,
        // Image-specific fields from tabs table
        style: tab.style || '',
        useCharacterDescriptions: tab.use_character_descriptions ?? true,
        firstPageFrequency: tab.first_page_frequency || 30,
        restFrequency: tab.rest_frequency || 60,
        imageModel: tab.image_model || 'gpt-image-1-mini',
        language: tab.language || 'english',
        model: tab.model || 'sonnet',
      };
    });

    return tabInfos;
  } catch (error) {
    console.error('Error fetching active image tabs:', error);
    return [];
  }
}

/**
 * Get all active video tabs for a user with status determined by video_tasks.overall_status
 * IMPORTANT: For video generation, completion is determined by video_tasks.overall_status = 'completed_final'
 * NOT by story_tasks completion alone, since video generation has multiple phases
 */
async function getUserActiveVideoTabs(userId: string): Promise<TabInfo[]> {
  try {
    console.log(`[getUserActiveVideoTabs] Fetching video tabs for user ${userId}`);
    
    // Get tabs from tabs table
    const tabs = await getTabsForPage(userId, 'video');
    console.log(`[getUserActiveVideoTabs] Found ${tabs.length} tabs from database`);
    
    if (tabs.length === 0) return [];
    
    // Get video_tasks to determine actual completion status
    const { data: videoTasks, error: videoTasksError } = await supabase
      .from('video_tasks')
      .select('tab, group_id, overall_status, overall_progress, story_status, image_prompt_status, audio_status, video_creation_status')
      .eq('user_id', userId)
      .in('overall_status', ['planning', 'pending', 'running', 'completed', 'completed_final']);
    
    if (videoTasksError) {
      console.error('[getUserActiveVideoTabs] Error fetching video_tasks:', videoTasksError);
    }
    
    console.log(`[getUserActiveVideoTabs] Found ${videoTasks?.length || 0} active video_tasks`);
    
    // Create a map of "group_id_tab" -> video_task for quick lookup.
    // Keying by composite (group_id + tab) prevents Tab 1 from inheriting Tab 2's
    // video_task when both tabs share the same group_id.
    const videoTaskMap = new Map<string, any>();
    if (videoTasks && videoTasks.length > 0) {
      videoTasks.forEach(task => {
        videoTaskMap.set(`${task.group_id}_${task.tab}`, task);
      });
    }
    
    // Enrich tabs with video_tasks data
    const enrichedTabs = tabs.map(tab => {
      console.log(`[getUserActiveVideoTabs] Processing tab ${tab.tab}: groupId=${tab.groupId}, status=${tab.status}`);
      
      // If tab has no group_id, return with original status
      if (!tab.groupId) {
        console.log(`[getUserActiveVideoTabs] Tab ${tab.tab} has no group_id, keeping database status: ${tab.status}`);
        return {
          ...tab,
          progress: 0,
          estimatedTokens: tab.estimateTokens || 0,
          tokensUsed: 0,
          totalBatches: 0,
          completedBatches: 0,
        };
      }
      
      // Get corresponding video_task using composite key (group_id + tab number)
      // to correctly handle tabs that share the same group_id
      const videoTask = videoTaskMap.get(`${tab.groupId}_${tab.tab}`);
      
      // Determine status based on video_tasks.overall_status
      let status: 'idle' | 'outline' | 'generating' | 'error' | 'complete';
      let progress = 0;
      
      if (videoTask) {
        console.log(`[getUserActiveVideoTabs] Tab ${tab.tab} has video_task with overall_status: ${videoTask.overall_status}`);
        
        // CRITICAL: Only mark complete when overall_status = 'completed_final'
        // 'completed' means story phase is done, but other phases continue
        if (videoTask.overall_status === 'completed_final') {
          status = 'complete';
          progress = 100;
        } else if (videoTask.overall_status === 'planning' || videoTask.overall_status === 'running' || videoTask.overall_status === 'completed' || videoTask.overall_status === 'pending') {
          status = 'generating';
          progress = videoTask.overall_progress || 0;
        } else if (videoTask.overall_status === 'error') {
          status = 'error';
          progress = videoTask.overall_progress || 0;
        } else {
          status = 'idle';
          progress = 0;
        }
      } else {
        // No active video_task found for this (group_id, tab) pair.
        // 'generating', 'complete', 'error' are always stale in this situation —
        // handleDone deletes video_tasks and resets tabs.status to 'idle' atomically,
        // so any non-idle/outline status without backing video_tasks is leaked state.
        // HOWEVER: if the tab was recently updated (within 60s), the backend may still
        // be inserting the placeholder row — don't reset yet.
        const tabAge = tab.lastActivity ? (Date.now() - new Date(tab.lastActivity).getTime()) : Infinity;
        if (tab.status && !['idle', 'outline'].includes(tab.status) && tabAge > 60000) {
          console.log(`[getUserActiveVideoTabs] Tab ${tab.tab} has stale status '${tab.status}' with no active video_task (age: ${Math.round(tabAge/1000)}s) — resetting to idle`);
          status = 'idle';
          // Reset in DB so subsequent polls and mounts see the correct state
          updateTabStatus(userId, 'video', tab.tab, 'idle')
            .then(success => {
              if (success) {
                console.log(`[getUserActiveVideoTabs] ✅ Reset stale status for tab ${tab.tab} to idle`);
              }
            })
            .catch(err => {
              console.error(`[getUserActiveVideoTabs] ❌ Error resetting stale status for tab ${tab.tab}:`, err);
            });
        } else if (tab.status && !['idle', 'outline'].includes(tab.status) && tabAge <= 60000) {
          console.log(`[getUserActiveVideoTabs] Tab ${tab.tab} has status '${tab.status}' with no video_task yet, but recently updated (${Math.round(tabAge/1000)}s ago) — keeping status`);
          status = tab.status as any;
          progress = 0;
        } else {
          console.log(`[getUserActiveVideoTabs] Tab ${tab.tab} has no active video_task, keeping database status: ${tab.status}`);
          status = tab.status as any;
        }
        progress = 0;
      }
      
      console.log(`[getUserActiveVideoTabs] Tab ${tab.tab} final status: ${status}, progress: ${progress}%`);
      
      // Update tab status in database if it changed
      if (tab.status !== status && videoTask) {
        console.log(`[getUserActiveVideoTabs] Updating tab ${tab.tab} status: ${tab.status} → ${status}`);
        updateTabStatus(userId, 'video', tab.tab, status, tab.groupId)
          .then(success => {
            if (success) {
              console.log(`[getUserActiveVideoTabs] ✅ Successfully updated tab ${tab.tab} to status: ${status}`);
            } else {
              console.error(`[getUserActiveVideoTabs] ❌ Failed to update tab ${tab.tab} status`);
            }
          })
          .catch(err => {
            console.error(`[getUserActiveVideoTabs] ❌ Error updating tab ${tab.tab} status:`, err);
          });
      }
      
      return {
        tab: tab.tab,
        groupId: tab.groupId,
        storyTitle: tab.storyTitle,
        status,
        progress,
        estimatedTokens: tab.estimateTokens || 0,
        tokensUsed: 0, // Video tasks don't track tokens
        createdAt: tab.createdAt,
        lastActivity: tab.lastActivity,
        totalBatches: 0, // Not applicable for video
        completedBatches: 0, // Not applicable for video
      };
    });
    
    return enrichedTabs;
  } catch (error) {
    console.error('[getUserActiveVideoTabs] Error:', error);
    return [];
  }
}

/**
 * Ensure user has at least one tab (create Tab 1 if none exist)
 */
export async function ensureTabExists(userId: string, page: string = 'story'): Promise<void> {
  try {
    // For image_prompt page, only check for standalone tabs (process_image=false or null)
    // This allows separate tab systems for ImagePrompts (standalone) and ImageGenerator (combined workflow)
    let query = supabase
      .from('tabs')
      .select('tab_number')
      .eq('user_id', userId)
      .eq('page', page);
    
    if (page === 'image_prompt') {
      // Only look for standalone tabs, not combined workflow tabs
      query = query.or('process_image.is.null,process_image.eq.false');
    }
    
    const { data: tabs, error } = await query.limit(1);
    
    if (error) throw error;
    
    if (!tabs || tabs.length === 0) {
      // Create tab with process_image=false for standalone workflows
      await createTab(userId, page, 1, undefined, undefined, undefined, false);
    }
  } catch (error) {
    console.error('Error ensuring tab exists:', error);
  }
}

/**
 * Get all active tabs for a user with enriched data from story_tasks or image_prompt_tasks
 */
export async function getUserActiveTabs(userId: string, page: string = 'story'): Promise<TabInfo[]> {
  try {
    // Handle image pages separately - both image_prompt and image use same logic
    if (page === 'image_prompt' || page === 'image') {
      return getUserActiveImageTabs(userId, page);
    }
    
    // Handle video page separately - use video_tasks.overall_status for completion
    if (page === 'video') {
      return getUserActiveVideoTabs(userId);
    }

    // Real Footage — enrich tabs from RF_tasks (exclude single-clip rows)
    if (page === 'rf') {
      const tabs = await getTabsForPage(userId, 'rf');
      if (tabs.length === 0) return [];

      const { data: tasks, error } = await supabase
        .from('RF_tasks')
        .select('tab, group_id, variant, status, progress, batch_number, total_batches, single_rf')
        .eq('user_id', userId)
        .eq('single_rf', false)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const tabGroups = new Map<number, typeof tasks>();
      (tasks ?? []).forEach(task => {
        if (!tabGroups.has(task.tab)) tabGroups.set(task.tab, []);
        tabGroups.get(task.tab)!.push(task);
      });

      return tabs.map(tab => {
        const allTabTasks = tabGroups.get(tab.tab) ?? [];
        let tabTasks = tab.groupId
          ? allTabTasks.filter(t => t.group_id === tab.groupId)
          : [];
        if (tabTasks.length > 0) {
          const maxVariant = Math.max(...tabTasks.map(t => t.variant || 1));
          tabTasks = tabTasks.filter(t => (t.variant || 1) === maxVariant);
        }

        if (!tab.groupId || tabTasks.length === 0) {
          return { ...tab, progress: 0, estimatedTokens: 0, tokensUsed: 0, totalBatches: 0, completedBatches: 0 };
        }

        const groupId = tabTasks[0].group_id;
        const errorTasks = tabTasks.filter(t => t.status === 'error');
        const allCompleted = tabTasks.every(t => t.status === 'completed' || t.status === 'completed_final');
        let status: TabInfo['status'];
        if (errorTasks.length > 0) status = 'error';
        else if (allCompleted) status = 'complete';
        else if (tabTasks.some(t => ['pending', 'queued', 'running'].includes(t.status))) status = 'generating';
        else status = 'idle';

        if (tab.status === 'generating' && status === 'complete') status = 'generating';
        else if (tab.status === 'complete' && status !== 'complete') status = 'complete';

        const progress = tabTasks.length > 0
          ? Math.round(tabTasks.reduce((sum, t) => sum + (t.progress || 0), 0) / tabTasks.length)
          : 0;
        const totalBatches = tabTasks[0].total_batches || tabTasks.length;
        const completedBatches = tabTasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;

        if (tab.status !== status || tab.groupId !== groupId) {
          updateTabStatus(userId, page, tab.tab, status, groupId).catch(() => {});
        }

        return {
          ...tab,
          groupId,
          status,
          progress,
          estimatedTokens: 0,
          tokensUsed: 0,
          totalBatches,
          completedBatches,
        };
      });
    }
    
    // Original story page logic follows
    console.log(`[getUserActiveTabs] Fetching tabs for user ${userId}, page: ${page}`);
    
    // Get tabs from tabs table
    const tabs = await getTabsForPage(userId, page);
    console.log(`[getUserActiveTabs] Found ${tabs.length} tabs from database:`, tabs.map(t => ({ tab: t.tab, status: t.status, groupId: t.groupId })));
    
    if (tabs.length === 0) return [];
    
    // Get tasks data for enrichment based on page
    // For audio page, query audio_tasks instead of story_tasks
    if (page === 'audio') {
      const { data: tasks, error } = await supabase
        .from('audio_tasks')
        .select('tab, group_id, variant, status, progress, batch_number, total_batches, created_at, updated_at')
        .eq('user_id', userId)
        .or('video_process.is.null,video_process.eq.false')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      
      console.log(`[getUserActiveTabs] Found ${tasks?.length || 0} tasks from audio_tasks`);
      
      // Group tasks by tab number
      const tabGroups = new Map<number, any[]>();
      if (tasks && tasks.length > 0) {
        tasks.forEach(task => {
          if (!tabGroups.has(task.tab)) {
            tabGroups.set(task.tab, []);
          }
          tabGroups.get(task.tab)!.push(task);
        });
        console.log(`[getUserActiveTabs] Tasks grouped by tab:`, Array.from(tabGroups.keys()));
      }
      
      // Enrich tabs with audio task data
      const enrichedTabs = tabs.map(tab => {
        const allTabTasks = tabGroups.get(tab.tab) || [];
        
        // Filter tasks by BOTH tab number AND the tab's current group_id
        let tabTasks = tab.groupId 
          ? allTabTasks.filter(task => task.group_id === tab.groupId)
          : [];
        
        // Filter to only the highest (most recent) variant to avoid mixing data
        if (tabTasks.length > 0) {
          const maxVariant = Math.max(...tabTasks.map(t => t.variant || 1));
          tabTasks = tabTasks.filter(t => (t.variant || 1) === maxVariant);
        }
        
        console.log(`[getUserActiveTabs] Processing audio tab ${tab.tab}: ${allTabTasks.length} total tasks, ${tabTasks.length} matching group_id: ${tab.groupId}`);
        
        // If tab has no group_id or no matching tasks, return tab with original database status
        if (!tab.groupId || tabTasks.length === 0) {
          console.log(`[getUserActiveTabs] Audio tab ${tab.tab} has no group_id or no matching tasks, keeping database status: ${tab.status}`);
          return {
            ...tab,
            progress: 0,
            estimatedTokens: 0,
            tokensUsed: 0,
            totalBatches: 0,
            completedBatches: 0,
          };
        }
        
        // Get the most recent group_id from tasks
        const groupId = tabTasks[0].group_id;
        
        // Determine audio status
        const errorTasks = tabTasks.filter(t => t.status === 'error');
        
        // All tasks must have status 'completed_final' for complete
        const allCompleted = tabTasks.length > 0 && tabTasks.every(t => t.status === 'completed_final' || t.status === 'completed');
        
        // Status logic for audio:
        // - Error if any error tasks exist
        // - Complete if all tasks are completed
        // - Generating if any tasks are pending/running
        // - Idle otherwise
        let status: 'idle' | 'outline' | 'generating' | 'error' | 'complete';
        if (errorTasks.length > 0) {
          status = 'error';
        } else if (allCompleted) {
          status = 'complete';
        } else if (tabTasks.some(t => t.status === 'pending' || t.status === 'queued' || t.status === 'running')) {
          status = 'generating';
        } else {
          status = 'idle';
        }
        
        // Calculate progress (average of all tasks)
        const progress = tabTasks.length > 0
          ? Math.round(tabTasks.reduce((sum, t) => sum + (t.progress || 0), 0) / tabTasks.length)
          : 0;
        
        // Count batches - filter completed tasks here
        const totalBatches = tabTasks[0].total_batches || 0;
        const completedBatches = tabTasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
        
        console.log(`[getUserActiveTabs] Audio tab ${tab.tab} calculated status: ${status}, progress: ${progress}%, batches: ${completedBatches}/${totalBatches}`);
        
        // Update tab status in database if it changed
        if (tab.status !== status || tab.groupId !== groupId) {
          console.log(`[TabManager] Updating audio tab ${tab.tab} status: ${tab.status} → ${status}, groupId: ${tab.groupId} → ${groupId}`);
          updateTabStatus(userId, page, tab.tab, status, groupId)
            .then(success => {
              if (success) {
                console.log(`[TabManager] ✅ Successfully updated audio tab ${tab.tab} to status: ${status}`);
              } else {
                console.error(`[TabManager] ❌ Failed to update audio tab ${tab.tab} status`);
              }
            })
            .catch(err => {
              console.error(`[TabManager] ❌ Error updating audio tab ${tab.tab} status:`, err);
            });
        }
        
        return {
          ...tab,
          groupId,
          status,
          progress,
          estimatedTokens: 0, // Audio doesn't have estimated tokens
          tokensUsed: 0, // Audio doesn't track tokens per task
          lastActivity: tabTasks[0].updated_at,
          totalBatches,
          completedBatches,
        };
      });
      
      return enrichedTabs;
    }
    
    // Original story tasks logic below
    // Get tasks data for enrichment
    // IMPORTANT: Don't select story_title, description, word_count, or model from story_tasks
    // These metadata fields should ONLY come from tabs table
    const { data: tasks, error } = await supabase
      .from('story_tasks')
      .select('tab, group_id, status, progress, batch_number, total_batches, estimated_tokens, input_tokens, output_tokens, created_at, updated_at')
      .eq('user_id', userId)
      .or('video_process.is.null,video_process.eq.false')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    console.log(`[getUserActiveTabs] Found ${tasks?.length || 0} tasks from story_tasks`);
    
    // Group tasks by tab number
    const tabGroups = new Map<number, any[]>();
    if (tasks && tasks.length > 0) {
      tasks.forEach(task => {
        if (!tabGroups.has(task.tab)) {
          tabGroups.set(task.tab, []);
        }
        tabGroups.get(task.tab)!.push(task);
      });
      console.log(`[getUserActiveTabs] Tasks grouped by tab:`, Array.from(tabGroups.keys()));
    }
    
    // Enrich tabs with task data
    const enrichedTabs = tabs.map(tab => {
      const allTabTasks = tabGroups.get(tab.tab) || [];
      
      // CRITICAL FIX: Filter tasks by BOTH tab number AND the tab's current group_id
      // This prevents showing tasks from previous generations on the same tab number
      const tabTasks = tab.groupId 
        ? allTabTasks.filter(task => task.group_id === tab.groupId)
        : [];
      
      console.log(`[getUserActiveTabs] Processing tab ${tab.tab}: ${allTabTasks.length} total tasks, ${tabTasks.length} matching group_id: ${tab.groupId}, current status: ${tab.status}`);
      
      // If tab has no group_id or no matching tasks, return tab with original database status
      // (don't override status - respect what's in the database)
      if (!tab.groupId || tabTasks.length === 0) {
        console.log(`[getUserActiveTabs] Tab ${tab.tab} has no group_id or no matching tasks, keeping database status: ${tab.status}`);
        return {
          ...tab,
          // Keep original tab.status from database (not forcing to 'idle')
          progress: 0,
          estimatedTokens: 0,
          tokensUsed: 0,
          totalBatches: 0,
          completedBatches: 0,
        };
      }
      
      // Get the most recent group_id from tasks
      // IMPORTANT: Never read title from tasks - always use tab.storyTitle from tabs table
      const groupId = tabTasks[0].group_id;
      
      // Determine status using the same logic as Generator.tsx
      // Check for pending/processing/retrying tasks
      const pendingTasks = tabTasks.filter(t => 
        t.status === 'pending' || t.status === 'processing' || t.status === 'retrying'
      );
      const completedTasks = tabTasks.filter(t => t.status === 'completed' || t.status === 'completed_final');
      const errorTasks = tabTasks.filter(t => t.status === 'error');
      const outlineTask = tabTasks.find(t => t.batch_number === 0);
      const batchTasks = tabTasks.filter(t => t.batch_number > 0); // Match Generator.tsx exactly - no total_batches check
      
      // Use the unified helper function to determine completion
      const isComplete = areStoryTasksComplete(tabTasks);
      
      // Debug logging to understand task statuses
      console.log(`[getUserActiveTabs] Tab ${tab.tab} task analysis:`, {
        totalTasks: tabTasks.length,
        outlineStatus: outlineTask?.status,
        batchCount: batchTasks.length,
        batchStatuses: batchTasks.map(t => ({ batch: t.batch_number, status: t.status })),
        isComplete
      });
      
      // Status logic:
      // - Error if any error tasks exist
      // - Complete if all batches are completed AND outline is completed
      // - Generating if outline is completed but batches are still processing
      // - Outline if outline is being generated
      // - Idle otherwise
      let status: 'idle' | 'outline' | 'generating' | 'error' | 'complete';
      if (errorTasks.length > 0) {
        status = 'error';
      } else if (isComplete) {
        status = 'complete';
      } else if (outlineTask?.status === 'completed' && batchTasks.length > 0) {
        status = 'generating';
      } else if (outlineTask && outlineTask.status !== 'completed') {
        status = 'outline';
      } else {
        status = 'idle';
      }
      
      // Trust the frontend's explicit status when it disagrees with task-derived status.
      // This prevents race conditions where polling overwrites frontend updates.
      // 1. Frontend set 'generating' (correction/comparison started) but tasks still show 'complete'
      //    → keep 'generating', frontend will update to 'complete' when operation finishes.
      // 2. Frontend set 'complete' but tasks-derived status shows 'generating'/'outline'/'idle'
      //    → keep 'complete', frontend explicitly acknowledged completion.
      if (tab.status === 'generating' && status === 'complete') {
        console.log(`[getUserActiveTabs] Tab ${tab.tab}: respecting frontend 'generating' status (tasks show complete but operation in progress)`);
        status = 'generating';
      } else if (tab.status === 'complete' && (status === 'generating' || status === 'outline' || status === 'idle')) {
        console.log(`[getUserActiveTabs] Tab ${tab.tab}: respecting frontend 'complete' status (tasks-derived status: ${status})`);
        status = 'complete';
      }
      
      // Calculate progress (average of all batch tasks, excluding outline)
      // batchTasks already declared above, reuse it
      const progress = batchTasks.length > 0
        ? Math.round(batchTasks.reduce((sum, t) => sum + (t.progress || 0), 0) / batchTasks.length)
        : 0;
      
      // Sum tokens used
      const tokensUsed = tabTasks.reduce((sum, t) => 
        sum + (t.input_tokens || 0) + (t.output_tokens || 0), 0
      );
      
      // Get estimated tokens from most recent task
      const estimatedTokens = tabTasks[0].estimated_tokens || 0;
      
      // Count batches
      const totalBatches = tabTasks[0].total_batches || 0;
      const completedBatches = tabTasks.filter(t => t.batch_number > 0 && t.status === 'completed').length;
      
      console.log(`[getUserActiveTabs] Tab ${tab.tab} calculated status: ${status}, progress: ${progress}%, batches: ${completedBatches}/${totalBatches}`);
      
      // Update tab status in database if it changed
      // IMPORTANT: Don't update title here - it should only be updated when user edits the form
      if (tab.status !== status || tab.groupId !== groupId) {
        console.log(`[TabManager] Updating tab ${tab.tab} status: ${tab.status} → ${status}, groupId: ${tab.groupId} → ${groupId}`);
        updateTabStatus(userId, page, tab.tab, status, groupId)
          .then(success => {
            if (success) {
              console.log(`[TabManager] ✅ Successfully updated tab ${tab.tab} to status: ${status}`);
            } else {
              console.error(`[TabManager] ❌ Failed to update tab ${tab.tab} status`);
            }
          })
          .catch(err => {
            console.error(`[TabManager] ❌ Error updating tab ${tab.tab} status:`, err);
          });
      } else {
        console.log(`[getUserActiveTabs] Tab ${tab.tab} status unchanged, no update needed`);
      }
      
      // Return enriched tab with progress/status from tasks
      // IMPORTANT: Don't overwrite tab metadata (title, description, wordCount, model)
      // Only enrich with progress/status data from story_tasks
      return {
        ...tab,
        groupId,
        // Keep tab.storyTitle from tabs table (don't overwrite)
        status,
        progress,
        estimatedTokens,
        tokensUsed,
        lastActivity: tabTasks[0].updated_at,
        totalBatches,
        completedBatches,
      };
    });
    
    return enrichedTabs;
  } catch (error) {
    console.error('Error fetching active tabs:', error);
    return [];
  }
}

/**
 * Get the count of active tabs for a user from tabs table
 */
export async function getActiveTabCount(userId: string, page: string = 'story'): Promise<number> {
  try {
    // For image_prompt page, only count standalone tabs (process_image=false or null)
    let query = supabase
      .from('tabs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('page', page);
    
    if (page === 'image_prompt') {
      query = query.or('process_image.is.null,process_image.eq.false');
    }
    
    const { count, error } = await query;
    
    if (error) throw error;
    return count || 0;
  } catch (error) {
    console.error('Error getting active tab count:', error);
    return 0;
  }
}

/**
 * Get the next available tab number (1-10) - alias for getNextAvailableTab
 */
export async function getNextTabNumber(userId: string, page: string = 'story'): Promise<number | null> {
  return getNextAvailableTab(userId, page);
}

/**
 * Get total estimated tokens across all active tabs
 */
export async function getTotalEstimatedTokens(userId: string): Promise<number> {
  try {
    const tabs = await getUserActiveTabs(userId);
    return tabs.reduce((sum, tab) => sum + tab.estimatedTokens, 0);
  } catch (error) {
    console.error('Error calculating total estimated tokens:', error);
    return 0;
  }
}

/**
 * Check if user can create a new tab
 */
export async function canCreateNewTab(userId: string, page: string = 'story'): Promise<{ canCreate: boolean; reason?: string }> {
  try {
    // Check if user has tabs feature (elite, ultimate, or enterprise)
    const isEnterprise = await checkIsEnterpriseUser(userId);
    if (!isEnterprise) {
      return { canCreate: false, reason: 'Only Elite, Ultimate, and Enterprise users can create multiple tabs' };
    }
    
    // Check tab count
    const tabCount = await getActiveTabCount(userId, page);
    if (tabCount >= 10) {
      return { canCreate: false, reason: 'Maximum 10 tabs allowed' };
    }
    
    return { canCreate: true };
  } catch (error) {
    console.error('Error checking if can create new tab:', error);
    return { canCreate: false, reason: 'Error checking tab limit' };
  }
}

/**
 * Delete a tab and all associated tasks
 */
export async function deleteTab(userId: string, tab: number, groupId: string, page: string = 'story'): Promise<boolean> {
  try {
    // Delete story tasks for this tab
    const { error: tasksError } = await supabase
      .from('story_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab);
    
    if (tasksError) throw tasksError;
    
    // Delete story documents for this tab
    const { error: docsError } = await supabase
      .from('story_documents')
      .delete()
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab);
    
    if (docsError) throw docsError;
    
    // Delete tab from tabs table
    await deleteTabFromDB(userId, page, tab);
    
    return true;
  } catch (error) {
    console.error('Error deleting tab:', error);
    return false;
  }
}

/**
 * Format number with commas
 */
export function formatTokenCount(tokens: number): string {
  return tokens.toLocaleString();
}

/**
 * Clamp tokens_used for display so the user never sees overage.
 * The DB allows tokens_used to exceed tokens_allocated + rollover_tokens
 * (the only pre-flight gate is the frontend estimate); we still want the
 * "used / total" UI to top out at the cap rather than showing e.g. 9.1M / 9M.
 * Use this ONLY for display — never for remaining-balance / gating math,
 * which should keep using the raw value so over-quota work is reflected.
 */
export function displayTokensUsed(tokensUsed: number, totalAvailable: number): number {
  return Math.min(Math.max(tokensUsed, 0), Math.max(totalAvailable, 0));
}

/**
 * Calculate token percentage used
 */
export function calculateTokenPercentage(tokensUsed: number, tokensAllocated: number): number {
  if (tokensAllocated === 0) return 0;
  return Math.round((tokensUsed / tokensAllocated) * 100);
}

/**
 * Check if story generation tasks are complete
 * Uses same logic as tab status 'complete' determination in getUserActiveTabs
 * @param tasks - Array of story tasks for a specific group
 * @returns true if all batch tasks are 'completed_final' AND outline is 'completed'
 */
export function areStoryTasksComplete(tasks: any[]): boolean {
  if (!tasks || tasks.length === 0) return false;
  
  const outlineTask = tasks.find((t: any) => t.batch_number === 0);
  const batchTasks = tasks.filter((t: any) => t.batch_number > 0);
  
  const allBatchesCompleted = batchTasks.length > 0 && batchTasks.every((t: any) => t.status === 'completed_final');
  const outlineCompleted = outlineTask?.status === 'completed';

  // If a corrected outline task exists, check if corrected batches are also done
  const hasCorrectedOutline = tasks.some((t: any) => t.batch_number === 0 && t.is_corrected === true);
  if (hasCorrectedOutline) {
    const correctedBatchTasks = batchTasks.filter((t: any) => t.is_corrected === true);
    // If corrected outline exists but no corrected batch tasks yet, correction is still starting
    if (correctedBatchTasks.length === 0) return false;
    // If corrected batch tasks exist but aren't all completed_final, still in progress
    const allCorrectedDone = correctedBatchTasks.every((t: any) => t.status === 'completed_final');
    if (!allCorrectedDone) return false;
  }
  
  return allBatchesCompleted && outlineCompleted;
}

/**
 * Check if adding new generation would exceed token limit
 */
export async function wouldExceedTokenLimit(
  userId: string,
  newEstimatedTokens: number
): Promise<{ wouldExceed: boolean; availableTokens: number }> {
  try {
    const plan = await getUserPlan(userId);
    if (!plan) {
      return { wouldExceed: true, availableTokens: 0 };
    }
    
    const availableTokens = plan.tokensAllocated - plan.tokensUsed;
    const wouldExceed = newEstimatedTokens > availableTokens;
    
    return { wouldExceed, availableTokens };
  } catch (error) {
    console.error('Error checking token limit:', error);
    return { wouldExceed: true, availableTokens: 0 };
  }
}

/**
 * Save video tab form inputs to database
 */
export async function saveVideoTabFormInputs(
  userId: string,
  tabNumber: number,
  formInputs: {
    title?: string;
    storyDescription?: string;
    wordCount?: number;
    language?: string;
    model?: string;
    storyModel?: string;
    imageModel?: string;
    style?: string;
    useCharacterDescriptions?: boolean;
    firstPageFrequency?: number;
    restFrequency?: number;
    selectedVoice?: string;
    speed?: number;
    volume?: number;
    preference?: string;
    removeTitleChapters?: boolean;
    modelVersion?: string;
    isCloneVoice?: boolean;
    cloneVoiceName?: string;
    cloneVoiceUrl?: string;
    cloneLanguage?: string;
    outputVideoName?: string;
    transitionType?: string;
    animationType?: string;
    effectsType?: string;
    bgMusicUrl?: string;
    bgMusicVolume?: number;
    videoLoopUrl?: string;
    loopTime?: number;
    video?: boolean;
    processStory?: boolean;
    processImages?: boolean;
    processAudio?: boolean;
    useExistingStory?: boolean;
    storyFilePath?: string;
    useExistingImages?: boolean;
    imagesFolderPath?: string;
    imagePromptPath?: string;
    useExistingAudio?: boolean;
    audioFilePath?: string;
    audioFolderPath?: string;
    // Runtime mode fields
    isRuntimeMode?: boolean;
    runtimeMinutes?: number | null;
    // Master prompt fields
    masterPromptEnabled?: boolean;
    masterPromptEnhanceAI?: boolean;
    masterPromptData?: any;
  }
): Promise<boolean> {
  try {
    const updates: any = {
      title: formInputs.title,
      story_description: formInputs.storyDescription,
      word_count: formInputs.wordCount,
      language: formInputs.language,
      model: formInputs.model,
      story_model: formInputs.storyModel,
        image_model: formInputs.imageModel,
        style: formInputs.style,
        use_character_descriptions: formInputs.useCharacterDescriptions,
        first_page_frequency: formInputs.firstPageFrequency,
        rest_frequency: formInputs.restFrequency,
        selected_voice: formInputs.selectedVoice,
        speed: formInputs.speed,
        volume: formInputs.volume,
        preference: formInputs.preference,
        remove_title_chapters: formInputs.removeTitleChapters,
        model_version: formInputs.modelVersion,
        is_clone_voice: formInputs.isCloneVoice,
        clone_voice_name: formInputs.cloneVoiceName,
        clone_voice_url: formInputs.cloneVoiceUrl,
        clone_language: formInputs.cloneLanguage,
        output_video_name: formInputs.outputVideoName,
        transition_type: formInputs.transitionType,
        animation_type: formInputs.animationType,
        effects_type: formInputs.effectsType,
        bg_music_url: formInputs.bgMusicUrl,
        bg_music_volume: formInputs.bgMusicVolume,
        video_loop_url: formInputs.videoLoopUrl,
        loop_time: formInputs.loopTime,
        video: formInputs.video,
        process_story: formInputs.processStory,
        process_images: formInputs.processImages,
        process_audio: formInputs.processAudio,
        use_existing_story: formInputs.useExistingStory,
        story_file_path: formInputs.storyFilePath,
        use_existing_images: formInputs.useExistingImages,
        images_folder_path: formInputs.imagesFolderPath,
        image_prompt_path: formInputs.imagePromptPath,
        use_existing_audio: formInputs.useExistingAudio,
        audio_file_path: formInputs.audioFilePath,
        audio_folder_path: formInputs.audioFolderPath,
        updated_at: new Date().toISOString(),
    };

    // Add runtime mode fields
    if (formInputs.isRuntimeMode !== undefined) {
      updates.is_runtime_mode = formInputs.isRuntimeMode;
    }
    if (formInputs.runtimeMinutes !== undefined) {
      updates.runtime_minutes = formInputs.runtimeMinutes;
    }

    // Add master prompt fields
    if (formInputs.masterPromptEnabled !== undefined) {
      updates.master_prompt = formInputs.masterPromptEnabled ? formInputs.masterPromptData : null;
    }
    if (formInputs.masterPromptEnhanceAI !== undefined) {
      updates.master_prompt_enhance_ai = formInputs.masterPromptEnhanceAI;
    }

    const { error } = await supabase
      .from('tabs')
      .update(updates)
      .eq('user_id', userId)
      .eq('page', 'video')
      .eq('tab_number', tabNumber);

    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error saving video tab form inputs:', error);
    return false;
  }
}

/**
 * Get video tab form inputs from database
 */
export async function getVideoTabFormInputs(
  userId: string,
  tabNumber: number
): Promise<any | null> {
  try {
    const { data, error } = await supabase
      .from('tabs')
      .select('*')
      .eq('user_id', userId)
      .eq('page', 'video')
      .eq('tab_number', tabNumber)
      .maybeSingle();

    if (error) throw error;
    
    return data ? {
      title: data.title || '',
      storyDescription: data.story_description || '',
      wordCount: data.word_count || null,
      language: data.language || 'english',
      model: data.model || 'sonnet',
      storyModel: data.story_model || 'sonnet',
      imageModel: data.image_model || 'gpt-image-1-mini',
      style: data.style || '',
      useCharacterDescriptions: data.use_character_descriptions ?? true,
      firstPageFrequency: data.first_page_frequency || 30,
      restFrequency: data.rest_frequency || 60,
      selectedVoice: data.selected_voice || 'core:lewis',
      speed: data.speed || 1.0,
      volume: data.volume || 1.0,
      preference: data.preference || 'merged',
      removeTitleChapters: data.remove_title_chapters ?? false,
      modelVersion: data.model_version || 'lemonfox',
      isCloneVoice: data.is_clone_voice ?? false,
      cloneVoiceName: data.clone_voice_name || '',
      cloneVoiceUrl: data.clone_voice_url || '',
      cloneLanguage: data.clone_language || '',
      outputVideoName: data.output_video_name || 'final_video.mp4',
      transitionType: data.transition_type || null,
      animationType: data.animation_type || 'drift',
      effectsType: data.effects_type || 'film_grain',
      bgMusicUrl: data.bg_music_url || '',
      bgMusicVolume: data.bg_music_volume || 1.0,
      videoLoopUrl: data.video_loop_url || '',
      loopTime: data.loop_time || null,
      video: data.video ?? true,
      processStory: data.process_story ?? true,
      processImages: data.process_images ?? true,
      processAudio: data.process_audio ?? true,
      useExistingStory: data.use_existing_story ?? false,
      storyFilePath: data.story_file_path || '',
      useExistingImages: data.use_existing_images ?? false,
      imagesFolderPath: data.images_folder_path || '',
      imagePromptPath: data.image_prompt_path || '',
      useExistingAudio: data.use_existing_audio ?? false,
      audioFilePath: data.audio_file_path || '',
      audioFolderPath: data.audio_folder_path || '',
      // Runtime mode fields
      is_runtime_mode: data.is_runtime_mode,
      runtime_minutes: data.runtime_minutes,
      // Master prompt fields
      master_prompt: data.master_prompt,
      master_prompt_enhance_ai: data.master_prompt_enhance_ai,
    } : null;
  } catch (error) {
    console.error('Error getting video tab form inputs:', error);
    return null;
  }
}

/**
 * Reset video tab to defaults
 */
export async function resetVideoTabToDefaults(
  userId: string,
  tabNumber: number
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('tabs')
      .update({
        title: null,
        story_description: null,
        word_count: 1250,
        language: 'english',
        model: 'sonnet',
        story_model: 'sonnet',
        image_model: 'gpt-image-1-mini',
        style: '',
        use_character_descriptions: true,
        first_page_frequency: 30,
        rest_frequency: 60,
        selected_voice: 'core:lewis',
        speed: 1.0,
        volume: 1.0,
        preference: 'merged',
        remove_title_chapters: false,
        model_version: 'lemonfox',
        is_clone_voice: false,
        clone_voice_name: null,
        clone_voice_url: null,
        clone_language: null,
        output_video_name: 'final_video.mp4',
        transition_type: null,
        animation_type: 'drift',
        effects_type: 'film_grain',
        bg_music_url: null,
        bg_music_volume: 1.0,
        video_loop_url: null,
        loop_time: null,
        video: true,
        process_story: true,
        process_images: true,
        process_audio: true,
        use_existing_story: false,
        story_file_path: null,
        use_existing_images: false,
        images_folder_path: null,
        image_prompt_path: null,
        use_existing_audio: false,
        audio_file_path: null,
        audio_folder_path: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('page', 'video')
      .eq('tab_number', tabNumber);

    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error resetting video tab to defaults:', error);
    return false;
  }
}

/**
 * Reset TTV (Text-To-Video) tab to defaults
 */
export async function resetTTVTabToDefaults(
  userId: string,
  tabNumber: number
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('tabs')
      .update({
        status: 'idle',
        group_id: null,
        title: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('page', 'ttv')
      .eq('tab_number', tabNumber);

    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error resetting TTV tab to defaults:', error);
    return false;
  }
}

/**
 * Stop video generation for a specific groupId - cleanup database tasks and storage files
 * This is called when closing a tab that's in 'generating' status
 */
export async function stopVideoGenerationForGroupId(
  userId: string,
  groupId: string
): Promise<boolean> {
  try {
    console.log(`[stopVideoGenerationForGroupId] Starting cleanup for user ${userId}, group ${groupId}`);
    
    const supabase = createClient(
      import.meta.env.SUPABASE_URL,
      import.meta.env.SUPABASE_PUBLISHABLE_KEY
    );

    // Check which phases have completed to determine what to preserve - CHECK ALL PHASES
    // Query all tasks first to determine if we should use doc_id filter
    const { data: allTasks } = await supabase
      .from('video_tasks')
      .select('story_status, image_prompt_status, image_generation_status, audio_status, video_creation_status, doc_id')
      .eq('user_id', userId)
      .eq('group_id', groupId);

    let videoTask = null;
    if (allTasks && allTasks.length === 1) {
      // Only one row - use it
      videoTask = allTasks[0];
      console.log('[stopVideoGenerationForGroupId] Found single video task, using it');
    } else if (allTasks && allTasks.length > 1) {
      // Multiple rows - prefer the canonical main (is_main = true), fall back to legacy doc_id IS NULL
      videoTask = allTasks.find(task => task.is_main) || allTasks.find(task => task.doc_id === null) || allTasks[0];
      console.log('[stopVideoGenerationForGroupId] Found multiple video tasks, using main task (is_main = true)');
    }

    const storyCompleted = videoTask?.story_status === 'completed' || videoTask?.story_status === 'completed_final';
    const imagePromptsCompleted = videoTask?.image_prompt_status === 'completed' || videoTask?.image_prompt_status === 'completed_final';
    const imageGenerationCompleted = videoTask?.image_generation_status === 'completed' || videoTask?.image_generation_status === 'completed_final';
    const audioCompleted = videoTask?.audio_status === 'completed' || videoTask?.audio_status === 'completed_final';
    const videoCreationCompleted = videoTask?.video_creation_status === 'completed' || videoTask?.video_creation_status === 'completed_final';

    console.log('[stopVideoGenerationForGroupId] Completion status:', {
      storyCompleted,
      imagePromptsCompleted,
      imageGenerationCompleted,
      audioCompleted,
      videoCreationCompleted
    });

    // Delete database tasks
    await Promise.all([
      supabase.from('video_tasks').delete().eq('user_id', userId).eq('group_id', groupId),
      supabase.from('story_tasks').delete().eq('user_id', userId).eq('group_id', groupId),
      supabase.from('image_prompt_tasks').delete().eq('user_id', userId).eq('group_id', groupId).eq('video_process', true),
      supabase.from('image_prompt_context').delete().eq('group_id', groupId),
      supabase.from('image_tasks').delete().eq('user_id', userId).eq('group_id', groupId),
      supabase.from('audio_tasks').delete().eq('user_id', userId).eq('group_id', groupId),
    ]);

    console.log('[stopVideoGenerationForGroupId] Deleted all database tasks');

    // Clean up storage files based on completion status
    const storageCleanupPromises: Promise<any>[] = [];

    // Clean up story files only if NOT completed
    if (!storyCompleted) {
      storageCleanupPromises.push(
        supabase.storage.from('stories').list(`documents/${userId}/${groupId}`, { limit: 1000, recursive: true }).then(async ({ data: files }) => {
          if (files && files.length > 0) {
            // Only delete .txt files (story content)
            const storyFilePaths = files.filter(f => f.name.endsWith('.txt')).map(f => `documents/${userId}/${groupId}/${f.name}`);
            if (storyFilePaths.length > 0) {
              await supabase.storage.from('stories').remove(storyFilePaths);
              console.log(`[stopVideoGenerationForGroupId] Deleted ${storyFilePaths.length} incomplete story files`);
            }
          }
        })
      );
    } else {
      console.log('[stopVideoGenerationForGroupId] Story completed - preserving story files');
    }

    // Clean up images only if NOT completed
    if (!imageGenerationCompleted) {
      storageCleanupPromises.push(
        supabase.storage.from('stories').list(`documents/${userId}/${groupId}`, { limit: 1000, recursive: true }).then(async ({ data: files }) => {
          if (files && files.length > 0) {
            // Only delete image files (not audio or other files)
            const imagePaths = files
              .filter(f => 
                f.name.endsWith('.png') || 
                f.name.endsWith('.jpg') || 
                f.name.endsWith('.jpeg') || 
                f.name.endsWith('.webp')
              )
              .map(f => `documents/${userId}/${groupId}/${f.name}`);
            if (imagePaths.length > 0) {
              await supabase.storage.from('stories').remove(imagePaths);
              console.log(`[stopVideoGenerationForGroupId] Deleted ${imagePaths.length} incomplete image files`);
            }
          }
        })
      );
    } else {
      console.log('[stopVideoGenerationForGroupId] Images completed - preserving image files');
    }

    // Clean up audio only if NOT completed
    if (!audioCompleted) {
      storageCleanupPromises.push(
        supabase.storage.from('audio').list(`${userId}/${groupId}`, { limit: 1000 }).then(async ({ data: files }) => {
          if (files && files.length > 0) {
            const audioPaths = files.map(f => `${userId}/${groupId}/${f.name}`);
            await supabase.storage.from('audio').remove(audioPaths);
            console.log(`[stopVideoGenerationForGroupId] Deleted ${audioPaths.length} incomplete audio files`);
          }
        })
      );
      
      // Also check stories bucket for audio
      storageCleanupPromises.push(
        supabase.storage.from('stories').list(`documents/${userId}/${groupId}`, { limit: 1000, recursive: true }).then(async ({ data: files }) => {
          if (files && files.length > 0) {
            const audioPaths = files.filter(f => f.name.endsWith('.wav') || f.name.endsWith('.mp3')).map(f => `documents/${userId}/${groupId}/${f.name}`);
            if (audioPaths.length > 0) {
              await supabase.storage.from('stories').remove(audioPaths);
              console.log(`[stopVideoGenerationForGroupId] Deleted ${audioPaths.length} incomplete audio files from stories bucket`);
            }
          }
        })
      );
    } else {
      console.log('[stopVideoGenerationForGroupId] Audio completed - preserving audio files');
    }

    // Clean up temporary video files only if video creation NOT completed
    if (!videoCreationCompleted) {
      storageCleanupPromises.push(
        supabase.storage.from('videos').list(`${userId}/${groupId}`, { limit: 1000 }).then(async ({ data: files }) => {
          if (files && files.length > 0) {
            const tempVideoPaths = files.filter(f => !f.name.includes('final_video')).map(f => `${userId}/${groupId}/${f.name}`);
            if (tempVideoPaths.length > 0) {
              await supabase.storage.from('videos').remove(tempVideoPaths);
              console.log(`[stopVideoGenerationForGroupId] Deleted ${tempVideoPaths.length} incomplete temporary video files`);
            }
          }
        })
      );
    } else {
      console.log('[stopVideoGenerationForGroupId] Video creation completed - preserving video files');
    }

    await Promise.all(storageCleanupPromises);

    console.log('[stopVideoGenerationForGroupId] Cleanup complete');
    return true;
  } catch (error) {
    console.error('[stopVideoGenerationForGroupId] Error:', error);
    return false;
  }
}

/**
 * Complete video cleanup for a specific groupId - preserve all completed artifacts, only delete database tasks
 * This is called when closing a tab that's in 'complete' status
 * IMPORTANT: When complete, we preserve story, images, audio, and final video - only clean up database state
 */
export async function completeVideoCleanupForGroupId(
  userId: string,
  groupId: string
): Promise<boolean> {
  try {
    console.log(`[completeVideoCleanupForGroupId] Starting cleanup for user ${userId}, group ${groupId}`);
    
    const supabase = createClient(
      import.meta.env.SUPABASE_URL,
      import.meta.env.SUPABASE_PUBLISHABLE_KEY
    );

    // Check which phases completed to verify what to preserve
    // Query all tasks first to determine if we should use doc_id filter
    const { data: allTasks } = await supabase
      .from('video_tasks')
      .select('story_status, image_prompt_status, image_generation_status, audio_status, video_creation_status, doc_id')
      .eq('user_id', userId)
      .eq('group_id', groupId);

    let videoTask = null;
    if (allTasks && allTasks.length === 1) {
      // Only one row - use it
      videoTask = allTasks[0];
      console.log('[completeVideoCleanupForGroupId] Found single video task, using it');
    } else if (allTasks && allTasks.length > 1) {
      // Multiple rows - prefer the canonical main (is_main = true), fall back to legacy doc_id IS NULL
      videoTask = allTasks.find(task => task.is_main) || allTasks.find(task => task.doc_id === null) || allTasks[0];
      console.log('[completeVideoCleanupForGroupId] Found multiple video tasks, using main task (is_main = true)');
    }

    const storyCompleted = videoTask?.story_status === 'completed' || videoTask?.story_status === 'completed_final';
    const imagePromptsCompleted = videoTask?.image_prompt_status === 'completed' || videoTask?.image_prompt_status === 'completed_final';
    const imageGenerationCompleted = videoTask?.image_generation_status === 'completed' || videoTask?.image_generation_status === 'completed_final';
    const audioCompleted = videoTask?.audio_status === 'completed' || videoTask?.audio_status === 'completed_final';
    const videoCreationCompleted = videoTask?.video_creation_status === 'completed' || videoTask?.video_creation_status === 'completed_final';

    console.log('[completeVideoCleanupForGroupId] Preserving completed phases:', {
      storyCompleted,
      imagePromptsCompleted,
      imageGenerationCompleted,
      audioCompleted,
      videoCreationCompleted
    });

    // Delete database tasks (to clean up state, but preserve storage files)
    await Promise.all([
      supabase.from('video_tasks').delete().eq('user_id', userId).eq('group_id', groupId),
      supabase.from('story_tasks').delete().eq('user_id', userId).eq('group_id', groupId),
      supabase.from('image_prompt_tasks').delete().eq('user_id', userId).eq('group_id', groupId).eq('video_process', true),
      supabase.from('image_prompt_context').delete().eq('group_id', groupId),
      supabase.from('image_tasks').delete().eq('user_id', userId).eq('group_id', groupId),
      supabase.from('audio_tasks').delete().eq('user_id', userId).eq('group_id', groupId),
    ]);

    console.log('[completeVideoCleanupForGroupId] Deleted all database tasks');

    // For complete status, we generally preserve all completed artifacts
    // Only clean up truly temporary files (individual videos, transition batches)
    const storageCleanupPromises: Promise<any>[] = [];

    // ONLY delete temporary video files that are NOT the final video or completed artifacts
    storageCleanupPromises.push(
      supabase.storage.from('videos').list(`${userId}/${groupId}`, { limit: 1000 }).then(async ({ data: files }) => {
        if (files && files.length > 0) {
          // Only delete temporary processing files, keep final_video and any completed artifacts
          const tempVideoPaths = files
            .filter(f => 
              !f.name.includes('final_video') && 
              (f.name.includes('temp_') || f.name.includes('processing_'))
            )
            .map(f => `${userId}/${groupId}/${f.name}`);
          if (tempVideoPaths.length > 0) {
            await supabase.storage.from('videos').remove(tempVideoPaths);
            console.log(`[completeVideoCleanupForGroupId] Deleted ${tempVideoPaths.length} temporary processing files`);
          }
        }
      })
    );

    await Promise.all(storageCleanupPromises);

    console.log('[completeVideoCleanupForGroupId] Cleanup complete');
    return true;
  } catch (error) {
    console.error('[completeVideoCleanupForGroupId] Error:', error);
    return false;
  }
}
