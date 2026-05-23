import { createClient } from '@supabase/supabase-js';
import { Segment } from './imagePromptsGenerator';
import { Chapter, Batch } from './generator';
import { v4 as uuidv4 } from 'uuid';
import { fetchWithFallback } from './fetchWithFallback';

// Initialize Supabase client
const SUPABASE_URL = import.meta.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.SUPABASE_PUBLISHABLE_KEY;
if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error('SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY is not set in environment variables');
}
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// Story Task for Story Generation
export interface StoryTask {
  id: string;
  user_id: string;
  group_id: string;
  batch: Chapter[];
  previous_content: string; // Path to cumulative story (e.g., partial/{user_id}/{group_id}/story.txt)
  total_word_count: number;
  batch_number: number;
  progress: number;
  status: 'pending' | 'processing' | 'completed' | 'error' | 'stopped';
  story_title: string;
  description: string;
  outline?: string | null;
  feedback?: string | null;
  total_batches: number;
  is_corrected: boolean;
  error?: string | null;
  file_path?: string | null; // Path to batch-specific file, if needed
  input_tokens?: number | null;
  output_tokens?: number | null;
  created_at: string;
  updated_at: string;
  doc_id?: string | null;
  is_main?: boolean | null;
  settings?: any;
  variant?: number;
  version?: number;
  stop_requested?: boolean;
  token_updated?: boolean; // Frontend-only, not in DB
}

// Image Prompt Task for Image Prompt Generation
export interface ImagePromptTask {
  id?: string;
  batch: Segment[];
  previous_content: string;
  total_prompts: number;
  batch_number: number;
  progress?: number;
  error?: string | null;
  status: 'pending' | 'processing' | 'completed' | 'error' | 'stopped';
  group_id?: string;
}

// Retry utility
const RETRY_DELAY = 2000;
const MAX_RETRIES = 5;

const withRetry = async <T>(operation: () => Promise<T>, operationName: string, maxRetries: number = MAX_RETRIES): Promise<T> => {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      if ((error.message.includes('Failed to fetch') || error.message.includes('rate limit')) && attempt < maxRetries) {
        console.warn(`Attempt ${attempt} failed for ${operationName}: ${error.message}. Retrying in ${RETRY_DELAY / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        throw error;
      }
    }
  }
  throw new Error(`Failed to complete ${operationName} after ${maxRetries} attempts: ${lastError.message}`);
};

// Fetch story tasks
export async function getTasks(userId: string, groupId: string, tab: number = 1): Promise<StoryTask[]> {
  try {
    const { data, error } = await withRetry(
      () =>
        supabase
          .from('story_tasks')
          .select('*')
          .eq('user_id', userId)
          .eq('group_id', groupId)
          .eq('tab', tab)
          .order('batch_number', { ascending: true }),
      'getTasks'
    );

    if (error) {
      console.error('Error fetching tasks:', error);
      throw new Error(`Failed to fetch tasks: ${error.message}`);
    }

    if (!data || data.length === 0) {
      console.warn(`No tasks found for user ${userId} and group ${groupId}`);
      return [];
    }

    return data.map((task: any) => ({
      id: task.id,
      user_id: task.user_id,
      group_id: task.group_id,
      batch: task.batch || [],
      previous_content: task.previous_content || null, // Default to cumulative path
      total_word_count: task.total_word_count,
      batch_number: task.batch_number,
      progress: task.progress || 0,
      status: task.status,
      story_title: task.story_title,
      description: task.description || '',
      outline: task.outline,
      feedback: task.feedback,
      total_batches: task.total_batches,
      is_corrected: task.is_corrected,
      error: task.error,
      file_path: task.file_path,
      input_tokens: task.input_tokens,
      output_tokens: task.output_tokens,
      created_at: task.created_at,
      updated_at: task.updated_at,
      doc_id: task.doc_id,
      settings: task.settings,
      variant: task.variant,
      version: task.version,
      stop_requested: task.stop_requested,
      token_updated: false, // Default to false, not stored in DB
    }));
  } catch (error: any) {
    console.error('Error in getTasks:', error);
    throw new Error(`Failed to retrieve tasks: ${error.message}`);
  }
}

// Save story tasks
export async function saveTasks(userId: string, groupId: string, tasks: StoryTask[], title: string, outline: string | null, tab: number = 1): Promise<StoryTask[]> {
  try {
    console.log('Saving tasks:', tasks.map(t => ({
      id: t.id,
      batch_number: t.batch_number,
      is_corrected: t.is_corrected,
      version: t.version,
      previous_content: t.previous_content,
      status: t.status,
      tab: tab,
    })));

    const tasksToSave = tasks.map(task => ({
      id: task.id,
      user_id: task.user_id,
      group_id: task.group_id,
      batch: task.batch || [],
      previous_content: task.is_corrected ? null : (task.previous_content || null),
      total_word_count: task.total_word_count,
      batch_number: task.batch_number,
      progress: task.progress || 0,
      status: task.status || 'pending',
      story_title: task.story_title || title,
      description: task.description || '',
      outline: task.outline || outline,
      feedback: task.feedback,
      total_batches: task.total_batches,
      is_corrected: task.is_corrected,
      version: task.is_corrected ? 2 : 1,
      error: task.error,
      file_path: task.file_path,
      input_tokens: task.input_tokens,
      output_tokens: task.output_tokens,
      created_at: task.created_at || new Date().toISOString(),
      updated_at: task.updated_at || new Date().toISOString(),
      doc_id: task.doc_id,
      settings: task.settings,
      variant: task.variant || 1,
      stop_requested: task.stop_requested || false,
      tab: tab,
    }));

    const { data, error } = await withRetry(
      () => supabase.from('story_tasks').upsert(tasksToSave, { onConflict: 'id' }).select(),
      'saveTasks'
    );

    if (error) {
      console.error('Error saving tasks:', error);
      throw new Error(`Failed to save tasks: ${error.message}`);
    }

    console.log(`Successfully saved ${tasks.length} tasks for group_id: ${groupId}`);
    return data as StoryTask[];
  } catch (error: any) {
    console.error('Error in saveTasks:', error);
    throw new Error(`Failed to save tasks: ${error.message}`);
  }
}

// Remove story tasks
export async function removeTasks(userId: string, groupId: string, tab: number = 1): Promise<void> {
  try {
    const { error } = await withRetry(
      () =>
        supabase
          .from('story_tasks')
          .delete()
          .eq('user_id', userId)
          .eq('group_id', groupId)
          .eq('tab', tab),
      'removeTasks'
    );

    if (error) {
      console.error('Error removing tasks:', error);
      throw new Error(`Failed to remove tasks: ${error.message}`);
    }

    console.log(`Successfully removed tasks for group_id: ${groupId}, tab: ${tab}`);
  } catch (error: any) {
    console.error('Error in removeTasks:', error);
    throw new Error(`Failed to remove tasks: ${error.message}`);
  }
}

// Update story task progress
export async function updateTaskProgress(userId: string, groupId: string, progress: number, batchNumber: number, tab: number = 1): Promise<void> {
  try {
    const { error } = await withRetry(
      () =>
        supabase
          .from('story_tasks')
          .update({
            progress,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
          .eq('group_id', groupId)
          .eq('batch_number', batchNumber)
          .eq('tab', tab),
      'updateTaskProgress'
    );

    if (error) {
      console.error('Error updating task progress:', error);
      throw new Error(`Failed to update task progress: ${error.message}`);
    }

    console.log(`Updated progress for batch ${batchNumber} to ${progress}% for group_id: ${groupId}, tab: ${tab}`);
  } catch (error: any) {
    console.error('Error in updateTaskProgress:', error);
    throw new Error(`Failed to update task progress: ${error.message}`);
  }
}

// Set story task error
export async function setTaskError(userId: string, groupId: string, errorMessage: string, taskId: string | null, tab: number = 1): Promise<void> {
  try {
    const query = supabase
      .from('story_tasks')
      .update({
        error: errorMessage,
        status: 'error',
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab);

    if (taskId) {
      query.eq('id', taskId);
    }

    const { error } = await withRetry(() => query, 'setTaskError');

    if (error) {
      console.error('Error setting task error:', error);
      throw new Error(`Failed to set task error: ${error.message}`);
    }

    console.log(`Set error for task${taskId ? ` ${taskId}` : ''}: ${errorMessage} for group_id: ${groupId}, tab: ${tab}`);
  } catch (error: any) {
    console.error('Error in setTaskError:', error);
    throw new Error(`Failed to set task error: ${error.message}`);
  }
}

// Clear story task error
export async function clearTaskError(userId: string, groupId: string, tab: number = 1): Promise<void> {
  try {
    const { error } = await withRetry(
      () =>
        supabase
          .from('story_tasks')
          .update({
            error: null,
            status: 'pending',
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
          .eq('group_id', groupId)
          .eq('tab', tab)
          .neq('status', 'completed')
          .neq('status', 'stopped'),
      'clearTaskError'
    );

    if (error) {
      console.error('Error clearing task error:', error);
      throw new Error(`Failed to clear task error: ${error.message}`);
    }

    console.log(`Cleared errors for tasks in group_id: ${groupId}, tab: ${tab}`);
  } catch (error: any) {
    console.error('Error in clearTaskError:', error);
    throw new Error(`Failed to clear task error: ${error.message}`);
  }
}

// Stop story tasks
export async function stopTasks(userId: string, groupId: string | null, tab: number | null = null): Promise<void> {
  try {
    // Delete all tasks for this user_id
    const { error: deleteError } = await withRetry(
      () => {
        const query = supabase
          .from('story_tasks')
          .delete()
          .eq('user_id', userId);
        
        // If groupId is provided, filter by it
        if (groupId) {
          query.eq('group_id', groupId);
        }
        
        // If tab is provided, filter by it (for tab-specific cleanup)
        if (tab !== null) {
          query.eq('tab', tab);
        }
        
        return query;
      },
      'stopTasks'
    );

    if (deleteError) {
      console.error('Error deleting tasks:', deleteError);
      throw new Error(`Failed to delete tasks: ${deleteError.message}`);
    }

    // Clean up partial files if groupId is provided
    if (groupId) {
      try {
        const partialPath = `partial/${userId}/${groupId}`;
        const { data: partialFiles, error: listError } = await supabase.storage.from('stories').list(partialPath);

        if (!listError && partialFiles && partialFiles.length > 0) {
          const filePaths = partialFiles.map(file => `${partialPath}/${file.name}`);
          await supabase.storage.from('stories').remove(filePaths);
        }
      } catch (fileError) {
        console.warn('Error cleaning up files (non-critical):', fileError);
        // Don't throw error for file cleanup issues
      }
    }

    console.log(`Successfully stopped and deleted tasks for user ${userId}${groupId ? `, group ${groupId}` : ''}${tab !== null ? `, tab ${tab}` : ''}`);
  } catch (error: any) {
    console.error('Error in stopTasks:', error);
    throw new Error(`Failed to stop tasks: ${error.message}`);
  }
}

// New function to ensure batch tasks exist based on outline
export async function ensureBatchTasks(
  userId: string, 
  groupId: string, 
  title: string, 
  description: string,
  tab: number = 1
): Promise<StoryTask[]> {
  try {
    // First, get the outline task
    const { data: tasks, error: fetchError } = await withRetry(
      () => 
        supabase
          .from('story_tasks')
          .select('*')
          .eq('user_id', userId)
          .eq('group_id', groupId)
          .eq('batch_number', 0)
          .eq('tab', tab)
          .limit(1),
      'fetchOutlineTask'
    );

    if (fetchError) {
      console.error('Error fetching outline task:', fetchError);
      throw new Error(`Failed to fetch outline task: ${fetchError.message}`);
    }

    if (!tasks || tasks.length === 0 || !tasks[0].outline) {
      console.error('No outline task found or outline is empty');
      
      // Try to create the outline task directly using the edge function
      try {
        console.log('Attempting to create outline task via edge function');
        const { data: { session: _tSession } } = await supabase.auth.getSession();
        const response = await fetchWithFallback('https://storyscriptai-outline.storyscriptai.deno.net', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_tSession?.access_token || ''}`,
            'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({
            title: title,
            description: description,
            wordCount: 200, // Default word count
            groupId: groupId,
            userId: userId
          }),
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `HTTP ${response.status}: Failed to generate outline`);
        }
        
        // Wait for the outline task to be created
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Try to fetch the outline task again
        const { data: retryTasks, error: retryError } = await supabase
          .from('story_tasks')
          .select('*')
          .eq('user_id', userId)
          .eq('group_id', groupId)
          .eq('batch_number', 0)
          .limit(1);
          
        if (retryError || !retryTasks || retryTasks.length === 0 || !retryTasks[0].outline) {
          throw new Error('Failed to create outline task via edge function');
        }
        
        // Use the newly created outline task
        const outlineTask = retryTasks[0];
        
        // Get all tasks after batch creation
        const { data: allTasks } = await supabase
          .from('story_tasks')
          .select('*')
          .eq('user_id', userId)
          .eq('group_id', groupId)
          .gt('batch_number', 0);
          
        return allTasks || [];
      } catch (edgeError: any) {
        console.error('Error creating tasks via edge function:', edgeError);
        throw new Error(`No outline task found and failed to create one: ${edgeError.message}`);
      }
    }

    const outlineTask = tasks[0];
    const outline = outlineTask.outline;
    
    // Get all existing batch tasks
    const { data: existingBatchTasks, error: batchFetchError } = await withRetry(
      () => 
        supabase
          .from('story_tasks')
          .select('batch_number')
          .eq('user_id', userId)
          .eq('group_id', groupId)
          .gt('batch_number', 0),
      'fetchExistingBatchTasks'
    );

    if (batchFetchError) {
      console.error('Error fetching existing batch tasks:', batchFetchError);
      throw new Error(`Failed to fetch existing batch tasks: ${batchFetchError.message}`);
    }
    
    // If there are already batch tasks, return empty array
    if (existingBatchTasks && existingBatchTasks.length > 0) {
      console.log(`Found ${existingBatchTasks.length} existing batch tasks, no need to create more`);
      return [];
    }

    // Read chapters and batches from the already-parsed outline task data
    console.log('Reading parsed batch data from outline task');
    let chapters: Chapter[] = [];
    let batches: Batch[] = [];

    if (outlineTask.batch) {
      try {
        const batchData = typeof outlineTask.batch === 'string' ? JSON.parse(outlineTask.batch) : outlineTask.batch;
        if (batchData.chapters && batchData.batches) {
          chapters = batchData.chapters;
          batches = batchData.batches;
        } else if (Array.isArray(batchData)) {
          batches = batchData;
        }
      } catch (e) {
        console.error('Error parsing batch data from outline task:', e);
      }
    }
    
    if (!batches || batches.length === 0) {
      console.error('No batches found in outline task batch data');
      throw new Error('No batches found in outline task. The outline may not have been parsed yet.');
    }
    
    console.log(`Found ${batches.length} batches in outline`);
    
    // Create tasks for all batches
    const newTasks: StoryTask[] = [];
    
    for (const batch of batches) {
      // Find the chapters for this batch
      const chapterIdentifiers = batch.chapter_identifiers || [];
      if (!chapterIdentifiers || chapterIdentifiers.length === 0) {
        console.warn(`Batch ${batch.batch_number} has no chapter identifiers`);
        continue;
      }
      
      // Get all chapters for this batch
      const batchChapters: Chapter[] = [];
      
      for (const identifier of chapterIdentifiers) {
        // Parse the chapter identifier
        let chapterNum: number;
        let part: string | null = null;
        
        if (typeof identifier === 'string' && identifier.includes('Part')) {
          const [num, partStr] = identifier.split(' Part ');
          chapterNum = parseInt(num, 10);
          part = `Part ${partStr}`;
        } else if (typeof identifier === 'string') {
          chapterNum = parseInt(identifier, 10);
        } else {
          console.warn(`Invalid chapter identifier: ${identifier}`);
          continue;
        }
        
        // Find the chapter for this identifier using flexible matching
        const chapterForBatch = chapters.find(ch => {
          // Try exact match
          if (ch.number === chapterNum && (part === null ? !ch.part : ch.part === part)) {
            return true;
          }
          
          // Try matching by index
          if (ch.index === chapterNum - 1) {
            return true;
          }
          
          // Try matching just by number if part is null
          if (part === null && !ch.part && ch.number === chapterNum) {
            return true;
          }
          
          // Try partial part matching
          if (part && ch.part && ch.number === chapterNum) {
            const normalizedPart = part.toLowerCase().replace(/\s+/g, '');
            const normalizedChPart = ch.part.toLowerCase().replace(/\s+/g, '');
            return normalizedPart === normalizedChPart;
          }
          
          return false;
        });
        
        if (chapterForBatch) {
          batchChapters.push(chapterForBatch);
        } else {
          console.warn(`No chapter found for identifier: ${identifier}`);
          // Create a placeholder chapter if none found
          batchChapters.push({
            index: chapterNum - 1,
            number: chapterNum,
            title: `Chapter ${chapterNum}${part ? ` ${part}` : ''}`,
            part: part,
            word_count: batch.total_words,
            summary: `Chapter ${chapterNum}${part ? ` ${part}` : ''} content`,
          });
        }
      }
      
      if (batchChapters.length === 0) {
        console.warn(`No chapters found for batch ${batch.batch_number}`);
        continue;
      }
      
      newTasks.push({
        id: uuidv4(),
        user_id: userId,
        group_id: groupId,
        batch: batchChapters,
        previous_content: null,
        total_word_count: batch.total_words,
        batch_number: batch.batch_number,
        progress: 0,
        status: 'pending',
        story_title: title || outlineTask.story_title,
        description: description || outlineTask.description || '',
        outline: outline,
        total_batches: batches.length,
        is_corrected: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        variant: outlineTask.variant || 1,
        stop_requested: false,
        token_updated: false,
      });
    }
    
    if (newTasks.length === 0) {
      console.log('No valid tasks to create after filtering');
      throw new Error('Failed to create any valid batch tasks');
    }
    
    // Save the new tasks
    const savedTasks = await saveTasks(userId, groupId, newTasks, title || outlineTask.story_title, outline);
    console.log(`Created ${savedTasks.length} batch tasks`);
    
    return savedTasks;
  } catch (error: any) {
    console.error('Error ensuring batch tasks:', error);
    throw new Error(`Failed to ensure batch tasks: ${error.message}`);
  }
}

// Fetch image prompt tasks
export async function getImagePromptTasks(userId: string, groupId: string): Promise<ImagePromptTask[]> {
  try {
    const { data, error } = await withRetry(
      () =>
        supabase
          .from('image_prompt_tasks')
          .select('*')
          .eq('user_id', userId)
          .eq('group_id', groupId)
          .in('status', ['pending', 'processing', 'error'])
          .order('batch_number', { ascending: true }),
      'getImagePromptTasks'
    );

    if (error) {
      console.error('Error fetching image prompt tasks:', error);
      throw new Error(`Failed to fetch image prompt tasks: ${error.message}`);
    }

    return data.map((task: any) => ({
      id: task.id,
      batch: task.batch ? JSON.parse(task.batch) : [],
      previous_content: task.previous_content || '',
      total_prompts: task.total_prompts,
      batch_number: task.batch_number,
      progress: task.progress || 0,
      error: task.error || null,
      status: task.status,
      group_id: task.group_id,
    }));
  } catch (error: any) {
    console.error('Error in getImagePromptTasks:', error);
    throw new Error(`Failed to retrieve image prompt tasks: ${error.message}`);
  }
}

// Save image prompt tasks
export async function saveImagePromptTasks(userId: string, groupId: string, tasks: ImagePromptTask[]): Promise<void> {
  try {
    const tasksToInsert = tasks.map(task => ({
      id: task.id || uuidv4(),
      user_id: userId,
      batch: task.batch.length > 0 ? JSON.stringify(task.batch) : null,
      previous_content: task.previous_content,
      total_prompts: task.total_prompts,
      batch_number: task.batch_number,
      progress: task.progress || 0,
      error: task.error || null,
      status: task.status,
      group_id: groupId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    const { error } = await withRetry(
      () => supabase.from('image_prompt_tasks').upsert(tasksToInsert, { onConflict: 'id' }),
      'saveImagePromptTasks'
    );

    if (error) {
      console.error('Error saving image prompt tasks:', error);
      throw new Error(`Failed to save image prompt tasks: ${error.message}`);
    }

    console.log(`Successfully saved ${tasks.length} image prompt tasks for group_id: ${groupId}`);
  } catch (error: any) {
    console.error('Error in saveImagePromptTasks:', error);
    throw new Error(`Failed to save image prompt tasks: ${error.message}`);
  }
}

// Remove image prompt tasks
export async function removeImagePromptTasks(userId: string, groupId: string): Promise<void> {
  try {
    const { error } = await withRetry(
      () =>
        supabase
          .from('image_prompt_tasks')
          .delete()
          .eq('user_id', userId)
          .eq('group_id', groupId),
      'removeImagePromptTasks'
    );

    if (error) {
      console.error('Error removing image prompt tasks:', error);
      throw new Error(`Failed to remove image prompt tasks: ${error.message}`);
    }

    console.log(`Successfully removed image prompt tasks for group_id: ${groupId}`);

    // Delete image_prompt_context for the same group
    const { error: contextError } = await withRetry(
      () =>
        supabase
          .from('image_prompt_context')
          .delete()
          .eq('group_id', groupId),
      'removeImagePromptContext'
    );

    if (contextError) {
      console.error('Error removing image prompt context:', contextError);
      throw new Error(`Failed to remove image prompt context: ${contextError.message}`);
    }

    console.log(`Successfully removed image prompt context for group_id: ${groupId}`);
  } catch (error: any) {
    console.error('Error in removeImagePromptTasks:', error);
    throw new Error(`Failed to remove image prompt tasks: ${error.message}`);
  }
}

// Update image prompt task progress
export async function updateImagePromptTaskProgress(userId: string, groupId: string, progress: number, batch_number: number): Promise<void> {
  try {
    const { error } = await withRetry(
      () =>
        supabase
          .from('image_prompt_tasks')
          .update({
            progress,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
          .eq('group_id', groupId)
          .eq('batch_number', batch_number),
      'updateImagePromptTaskProgress'
    );

    if (error) {
      console.error('Error updating image prompt task progress:', error);
      throw new Error(`Failed to update image prompt task progress: ${error.message}`);
    }

    console.log(`Updated progress for image prompt batch ${batch_number} to ${progress}% for group_id: ${groupId}`);
  } catch (error: any) {
    console.error('Error in updateImagePromptTaskProgress:', error);
    throw new Error(`Failed to update image prompt task progress: ${error.message}`);
  }
}

// Set image prompt task error
export async function setImagePromptTaskError(userId: string, groupId: string, errorMessage: string, taskId: string | null): Promise<void> {
  try {
    const query = supabase
      .from('image_prompt_tasks')
      .update({
        error: errorMessage,
        status: 'error',
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('group_id', groupId);

    if (taskId) {
      query.eq('id', taskId);
    }

    const { error } = await withRetry(() => query, 'setImagePromptTaskError');

    if (error) {
      console.error('Error setting image prompt task error:', error);
      throw new Error(`Failed to set image prompt task error: ${error.message}`);
    }

    console.log(`Set error for image prompt task${taskId ? ` ${taskId}` : ''}: ${errorMessage} for group_id: ${groupId}`);
  } catch (error: any) {
    console.error('Error in setImagePromptTaskError:', error);
    throw new Error(`Failed to set image prompt task error: ${error.message}`);
  }
}

// Clear image prompt task error
export async function clearImagePromptTaskError(userId: string, groupId: string): Promise<void> {
  try {
    const { error } = await withRetry(
      () =>
        supabase
          .from('image_prompt_tasks')
          .update({
            error: null,
            status: 'pending',
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
          .eq('group_id', groupId)
          .neq('status', 'completed')
          .neq('status', 'stopped'),
      'clearImagePromptTaskError'
    );

    if (error) {
      console.error('Error clearing image prompt task error:', error);
      throw new Error(`Failed to clear image prompt task error: ${error.message}`);
    }

    console.log(`Cleared errors for image prompt tasks in group_id: ${groupId}`);
  } catch (error: any) {
    console.error('Error in clearImagePromptTaskError:', error);
    throw new Error(`Failed to clear image prompt task error: ${error.message}`);
  }
}

// Stop image prompt tasks
export async function stopImagePromptTasks(userId: string, groupId: string): Promise<void> {
  try {
    const { error } = await withRetry(
      () =>
        supabase
          .from('image_prompt_tasks')
          .delete()
          .eq('user_id', userId)
          .eq('group_id', groupId),
      'stopImagePromptTasks'
    );

    if (error) {
      console.error('Error stopping image prompt tasks:', error);
      throw new Error(`Failed to stop image prompt tasks: ${error.message}`);
    }

    console.log(`Successfully stopped image prompt tasks for group_id: ${groupId}`);
  } catch (error: any) {
    console.error('Error in stopImagePromptTasks:', error);
    throw new Error(`Failed to stop image prompt tasks: ${error.message}`);
  }
}

