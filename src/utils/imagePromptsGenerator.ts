import * as mammoth from 'mammoth';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuid } from 'uuid';
import { fetchWithFallback } from './fetchWithFallback';

const TOKEN_PER_WORD = 1.33;

// Constants from Python (SSAIImagePrompt3.py)
export const CHARS_PER_SECOND = 13.67; // Updated to match Python
export const WORDS_PER_MINUTE = 125;
export const MIN_FREQUENCY_SECONDS = 5; // Minimum 5 seconds per image

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

const OPERATION_TIMEOUT = 3600000; // 1 hour

export interface Segment {
  text: string;
  start: number;
  is_first_page: boolean;
}

type ProgressCallback = (status: string, progress: number, totalBatches: number, currentBatch: number, details?: string) => void;

export function calculateWordCount(text: string): number {
  return text.split(/\s+/).filter(word => word.length > 0).length;
}

export function countWords(text: string): number {
  return calculateWordCount(text);
}

export function estimateTokens(text: string): number {
  return Math.ceil(countWords(text) * TOKEN_PER_WORD);
}

/**
 * Find optimal split point near target position, respecting sentence/paragraph boundaries
 */
function findOptimalSplitPoint(text: string, targetPos: number): number {
  if (targetPos >= text.length) {
    return text.length;
  }

  // Look for sentence boundaries within ±100 chars
  const searchRange = 100;
  for (let offset = 0; offset < searchRange; offset++) {
    // Check forward
    const posForward = targetPos + offset;
    if (posForward < text.length) {
      const chunk = text.slice(posForward - 1, posForward + 1);
      if (['. ', '! ', '? ', '.\n', '!\n', '?\n'].includes(chunk)) {
        return posForward;
      }
    }

    // Check backward
    const posBackward = targetPos - offset;
    if (posBackward > 0) {
      const chunk = text.slice(posBackward - 1, posBackward + 1);
      if (['. ', '! ', '? ', '.\n', '!\n', '?\n'].includes(chunk)) {
        return posBackward;
      }
    }
  }

  // Look for paragraph boundaries within ±200 chars
  const searchRange2 = 200;
  for (let offset = 0; offset < searchRange2; offset++) {
    // Check forward
    const posForward = targetPos + offset;
    if (posForward < text.length && text.slice(posForward - 1, posForward + 1) === '\n\n') {
      return posForward;
    }

    // Check backward
    const posBackward = targetPos - offset;
    if (posBackward > 0 && text.slice(posBackward - 1, posBackward + 1) === '\n\n') {
      return posBackward;
    }
  }

  // Fall back to word boundary
  let pos = targetPos;
  while (pos > 0 && pos < text.length && /[a-zA-Z0-9]/.test(text[pos])) {
    pos -= 1;
  }

  return pos > 0 ? pos : targetPos;
}

/**
 * Split text into exactly n segments using mathematical division
 */
function splitTextIntoNSegments(text: string, n: number): Segment[] {
  if (n <= 0 || !text.trim()) {
    return [];
  }

  if (n === 1) {
    return [{ text: text.trim(), start: 0, is_first_page: false }];
  }

  const segments: Segment[] = [];
  const textLength = text.length;
  const segmentSize = textLength / n;

  let currentPos = 0;

  for (let i = 0; i < n; i++) {
    if (i === n - 1) {
      // Last segment gets all remaining text
      const segmentText = text.slice(currentPos).trim();
      if (segmentText) {
        segments.push({
          text: segmentText,
          start: currentPos,
          is_first_page: false
        });
      }
    } else {
      // Find optimal split point near target
      const targetEnd = Math.floor(currentPos + segmentSize);
      const actualEnd = findOptimalSplitPoint(text, targetEnd);

      const segmentText = text.slice(currentPos, actualEnd).trim();
      if (segmentText) {
        segments.push({
          text: segmentText,
          start: currentPos,
          is_first_page: false
        });
      }

      currentPos = actualEnd;
    }
  }

  return segments;
}

/**
 * Create exactly the specified number of segments (count-based, not time-based)
 */
function createCountBasedSegments(text: string, totalImages: number, firstPageImages: number | null = null): Segment[] {
  if (!text || !text.trim()) {
    return [];
  }

  // Remove ALL chapter headers for count-based segmentation
  const lines = text.split('\n');
  const chapterPattern = /^\*\*Chapter \d+.*\*\*$/;
  const cleanedLines: string[] = [];
  let skipFirstTitle = true;

  for (const line of lines) {
    if (chapterPattern.test(line.trim())) {
      // Skip all chapter headers
      continue;
    } else if (skipFirstTitle && line.trim() && !line.trim().startsWith('**')) {
      // This might be the title line, skip it
      skipFirstTitle = false;
      continue;
    } else {
      skipFirstTitle = false;
      cleanedLines.push(line);
    }
  }

  const cleanedText = cleanedLines.join('\n').trim();

  if (firstPageImages === null) {
    // Consistent distribution - split entire text into totalImages segments
    return splitTextIntoNSegments(cleanedText, totalImages);
  } else {
    // First page vs rest distribution
    const segments: Segment[] = [];

    // Define first page as first 3000 characters
    const firstPageText = cleanedText.slice(0, 3000);
    const restText = cleanedText.length > 3000 ? cleanedText.slice(3000) : '';

    // Create first page segments
    if (firstPageImages > 0 && firstPageText.trim()) {
      const firstSegments = splitTextIntoNSegments(firstPageText, firstPageImages);
      for (const seg of firstSegments) {
        seg.is_first_page = true;
      }
      segments.push(...firstSegments);
    }

    // Create rest segments
    const restImages = totalImages - firstPageImages;
    if (restImages > 0 && restText.trim()) {
      const restSegments = splitTextIntoNSegments(restText, restImages);
      // Adjust start positions for rest segments
      for (const seg of restSegments) {
        seg.start += 3000;
        seg.is_first_page = false;
      }
      segments.push(...restSegments);
    }

    return segments;
  }
}

export async function extractTextFromDocx(file: File | Blob, progressCallback?: ProgressCallback): Promise<string> {
  if (progressCallback) progressCallback('Analyzing text', 0, 0, 0, 'Reading .docx file...');
  try {
    const arrayBuffer = await file.arrayBuffer();
    if (progressCallback) progressCallback('Analyzing text', 0, 0, 0, 'Extracting raw text...');
    const result = await mammoth.extractRawText({ arrayBuffer });
    const text = result.value.split('\n').filter(line => line.trim()).join('\n');
    if (progressCallback) progressCallback('Analyzing text', 0, 0, 0, `Extracted ${countWords(text)} words.`);
    return text;
  } catch (e: any) {
    throw new Error(`Error extracting text from .docx: ${e.message}`);
  }
}

export function splitTextIfLarge(text: string, progressCallback?: ProgressCallback, userTokenBalance?: number): string[] {
  const totalWords = countWords(text);
  const estimatedTokens = estimateTokens(text);
  
  if (progressCallback) progressCallback('Analyzing text', 0, 0, 0, `Text has ${totalWords} words.`);
  
  if (userTokenBalance !== undefined && estimatedTokens > userTokenBalance) {
    throw new Error(
      `Insufficient tokens to process text. ` +
      `Required: ${estimatedTokens.toLocaleString()} tokens, ` +
      `Available: ${userTokenBalance.toLocaleString()}`
    );
  }

  if (totalWords <= 15000) {
    if (progressCallback) progressCallback('Analyzing text', 0, 0, 0, 'Text under 15,000 words, keeping as single part.');
    return [text];
  }

  function recursiveSplit(text: string, parts: string[] = [], depth: number = 0): string[] {
    const totalWords = countWords(text);
    if (totalWords <= 15000) {
      parts.push(text);
      return parts;
    }
    const paragraphs = text.split('\n\n');
    const halfWords = Math.floor(totalWords / 2);
    let cumulativeWords = 0;
    let splitIdx = 0;
    for (let i = 0; i < paragraphs.length; i++) {
      cumulativeWords += countWords(paragraphs[i]);
      if (cumulativeWords >= halfWords) {
        splitIdx = i;
        break;
      }
    }
    const part1 = paragraphs.slice(0, splitIdx + 1).join('\n\n');
    const part2 = paragraphs.slice(splitIdx + 1).join('\n\n');
    if (progressCallback) progressCallback('Analyzing text', 0, 0, 0, `Split into: Part 1 (${countWords(part1)} words), Part 2 (${countWords(part2)} words).`);
    recursiveSplit(part1, parts, depth + 1);
    recursiveSplit(part2, parts, depth + 1);
    return parts;
  }

  const parts = recursiveSplit(text);
  if (progressCallback) progressCallback('Analyzing text', 0, 0, 0, `Final parts: ${parts.map(countWords).join(', ')} words.`);
  return parts;
}

export function segmentText(text: string, firstPageSeconds: number, restSeconds: number, progressCallback?: ProgressCallback, userTokenBalance?: number): Segment[] {
  const estimatedTokens = estimateTokens(text);
  if (userTokenBalance !== undefined && estimatedTokens > userTokenBalance) {
    throw new Error(
      `Insufficient tokens to segment text. ` +
      `Required: ${estimatedTokens.toLocaleString()} tokens, ` +
      `Available: ${userTokenBalance.toLocaleString()}`
    );
  }

  if (progressCallback) progressCallback('Analyzing text', 0, 0, 0, 'Calculating image count based on story length...');

  // Calculate total images based on story characteristics (matching Python logic)
  const wordCount = countWords(text);
  const charCount = text.length;
  
  // Calculate runtime based on reading speed
  const estimatedRuntime = charCount / CHARS_PER_SECOND;
  
  // Calculate images for first page (first 3000 chars)
  const firstPageChars = Math.min(3000, charCount);
  const firstPageRuntime = firstPageChars / CHARS_PER_SECOND;
  const firstPageImages = Math.max(1, Math.floor(firstPageRuntime / firstPageSeconds));
  
  // Calculate images for rest of story
  const restChars = Math.max(0, charCount - 3000);
  const restRuntime = restChars / CHARS_PER_SECOND;
  const restImages = restSeconds > 0 ? Math.floor(restRuntime / restSeconds) : 0;
  
  const totalImages = firstPageImages + restImages;
  
  if (progressCallback) {
    progressCallback('Analyzing text', 0, 0, 0, 
      `Story: ${wordCount} words, ${Math.floor(estimatedRuntime)}s runtime → ${totalImages} images (${firstPageImages} first page, ${restImages} rest)`);
  }

  // Use count-based segmentation to create exactly the calculated number of segments
  const segments = createCountBasedSegments(text, totalImages, firstPageImages);
  
  if (progressCallback) {
    progressCallback('Analyzing text', 0, 0, 0, 
      `Created ${segments.length} segments (${segments.filter(s => s.is_first_page).length} first page, ${segments.filter(s => !s.is_first_page).length} rest)`);
  }
  
  return segments;
}

export function determineBatchCount(segments: Segment[], text: string, progressCallback?: ProgressCallback, userTokenBalance?: number): [number, number, number] {
  const totalWords = countWords(text) + 150 * segments.length;
  const estimatedTokens = estimateTokens(text) + estimateTokens(JSON.stringify(segments));

  if (userTokenBalance !== undefined && estimatedTokens > userTokenBalance) {
    throw new Error(
      `Insufficient tokens to process batches. ` +
      `Required: ${estimatedTokens.toLocaleString()} tokens, ` +
      `Available: ${userTokenBalance.toLocaleString()}`
    );
  }

  const batchCount = Math.max(1, Math.ceil(totalWords / 900));
  if (progressCallback) progressCallback('Analyzing text', 0, 0, 0, `Calculated ${batchCount} batches for ${totalWords} words.`);
  return [batchCount, estimateTokens(text), estimateTokens(String(batchCount))];
}

export function assignBatches(segments: Segment[], batchCount: number, progressCallback?: ProgressCallback, userTokenBalance?: number): [number[][], number, number] {
  const totalWords = segments.reduce((sum, seg) => sum + countWords(seg.text), 0) + 150 * segments.length;
  const estimatedTokens = estimateTokens(JSON.stringify(segments));

  if (userTokenBalance !== undefined && estimatedTokens > userTokenBalance) {
    throw new Error(
      `Insufficient tokens to assign batches. ` +
      `Required: ${estimatedTokens.toLocaleString()} tokens, ` +
      `Available: ${userTokenBalance.toLocaleString()}`
    );
  }

  const targetWordsPerBatch = totalWords / batchCount;
  const batches: number[][] = Array.from({ length: batchCount }, () => []);
  let currentBatchIdx = 0;
  let currentWords = 0;

  if (progressCallback) progressCallback('Analyzing text', 0, 0, 0, 'Assigning segments to batches...');
  for (let i = 0; i < segments.length; i++) {
    const segWords = countWords(segments[i].text) + 150;
    if (currentBatchIdx < batchCount - 1 && currentWords + segWords > targetWordsPerBatch) {
      currentBatchIdx += 1;
      currentWords = 0;
    }
    batches[currentBatchIdx].push(i);
    currentWords += segWords;
    if (progressCallback) progressCallback('Analyzing text', 0, 0, 0, `Assigned ${i + 1} of ${segments.length} segments.`);
  }
  if (progressCallback) progressCallback('Analyzing text', 0, 0, 0, `Assigned ${segments.length} segments to ${batches.length} batches.`);
  return [batches, estimateTokens(JSON.stringify(segments)), estimateTokens(JSON.stringify(batches))];
}

export async function fetchTasks(userId: string, groupId: string, tab: number, variant?: number | null): Promise<any[]> {
  try {
    let query = supabase
      .from('image_prompt_tasks')
      .select('id,user_id,story_title,batch,text_part,total_batches,batch_number,progress,error,status,settings,group_id,variant,doc_id,file_path,input_tokens,output_tokens,updated_at,video_process,process_image')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .or('video_process.is.null,video_process.eq.false')
      .eq('process_image', false)
      .order('batch_number', { ascending: true });

    // Add variant filter if provided
    if (variant !== null && variant !== undefined) {
      query = query.eq('variant', variant);
    }

    const { data, error } = await query;

    if (error) throw new Error(`Failed to fetch tasks: ${error.message}`);
    return data || [];
  } catch (err: any) {
    console.error('Error fetching tasks:', err);
    throw err;
  }
}

export async function updateTaskStatus(taskId: string, status: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('image_prompt_tasks')
      .update({
        status,
        updated_at: new Date().toISOString(),
        error: null
      })
      .eq('id', taskId);

    if (error) throw new Error(`Failed to update task status: ${error.message}`);
  } catch (err: any) {
    console.error('Error updating task status:', err);
    throw err;
  }
}

export async function triggerNextBatch(groupId: string, userId: string, currentBatchNumber: number): Promise<any> {
  try {
    const { data: { session: _ipSession } } = await supabase.auth.getSession();
    const response = await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/trigger-image-next-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_ipSession?.access_token || ''}`,
        'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
      },
      body: JSON.stringify({
        group_id: groupId,
        user_id: userId,
        current_batch_number: currentBatchNumber
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to trigger next batch: HTTP ${response.status} - ${errorText}`);
    }

    return await response.json();
  } catch (err: any) {
    console.error('Error triggering next batch:', err);
    throw err;
  }
}

async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    const { error: dbError } = await supabase
      .from('error_logs')
      .insert({
        error_message: error.message || JSON.stringify(error),
        created_at: new Date().toISOString(),
      });
    if (dbError) {
      console.error('Failed to log error to database:', dbError);
    }
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

export async function setupImagePromptTasks(payload: {
  user_id: string;
  group_id: string;
  file_path: string;
  story_title: string;
  description: string;
  style: string;
  useCharacterDescriptions: boolean;
  firstPageFrequency: number | null;
  restFrequency: number;
  variant: number;
  doc_id: string;
  userTokenBalance: number;
  imageModel: 'standard' | 'plus' | 'premium' | 'spark' | 'grok' | 'prime' | 'genesis' | 'imagen-4-fast' | 'gpt-image-1-mini' | 'imagen-4-ultra' | 'flux-2-dev' | 'grok-imagine-image' | 'seedream-4.5' | 'nano-banana-pro';
  language: string;
  model: string;
  tab?: number;
  // Audio mode fields
  frequencyMode?: 'wordcount' | 'audio';
  frequencyType?: 'consistent' | 'variable';
  consistentFrequency?: number;
  audioFiles?: Array<{ path: string; name: string; duration: number; url?: string }>;
  totalAudioDuration?: number;
  imageAmount?: number;
  audioDistributionType?: 'consistent' | 'variable';
  audioFirstPageImageCount?: number;
  audioRestImageCount?: number;
  // V2 format fields
  masterPromptData?: {
    fullPrompt: string;
    environmentOnly: boolean;
    characters: Array<{ name: string; description: string }>;
    styleData: { style: string; description: string };
  };
  promptFormatVersion?: 1 | 2;
  // Custom character fields
  customCharactersEnabled?: boolean;
  customCharacters?: Array<{ name: string; description: string }>;
  customCharactersAIEnhance?: boolean;
}) {
  const startTime = Date.now();
  const maxRuntime = 300000; // 5 minutes

  try {
    console.log(`Received payload: ${JSON.stringify(payload, null, 2)}`);

    // Validate inputs
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!payload.user_id || !uuidRegex.test(payload.user_id)) throw new Error('Missing or invalid user_id');
    if (!payload.group_id || !uuidRegex.test(payload.group_id)) throw new Error('Missing or invalid group_id');
    if (!payload.doc_id || !uuidRegex.test(payload.doc_id)) throw new Error('Missing or invalid doc_id');
    if (!payload.file_path || typeof payload.file_path !== 'string') throw new Error('Missing or invalid file_path');
    if (!payload.story_title || typeof payload.story_title !== 'string') throw new Error('Missing or invalid story_title');
    if (!payload.description || typeof payload.description !== 'string') throw new Error('Missing or invalid description');
    if (!payload.style || typeof payload.style !== 'string') throw new Error('Missing or invalid style');
    if (typeof payload.useCharacterDescriptions !== 'boolean') throw new Error('Missing or invalid useCharacterDescriptions');
    
    // Validate frequency based on mode
    const frequencyMode = payload.frequencyMode || 'wordcount';
    const frequencyType = payload.frequencyType || 'variable';
    const audioDistributionType = payload.audioDistributionType || 'consistent';
    
    if (frequencyMode === 'audio') {
      // Audio mode validation based on distribution type
      if (audioDistributionType === 'consistent') {
        // Consistent distribution: requires imageAmount
        if (typeof payload.imageAmount !== 'number' || payload.imageAmount < 1) {
          throw new Error('Invalid imageAmount (must be at least 1)');
        }
      } else {
        // Variable distribution: requires first and rest image counts
        if (typeof payload.audioFirstPageImageCount !== 'number' || payload.audioFirstPageImageCount < 1) {
          throw new Error('First page image count must be at least 1');
        }
        if (typeof payload.audioRestImageCount !== 'number' || payload.audioRestImageCount < 1) {
          throw new Error('Rest image count must be at least 1');
        }
      }
      
      if (typeof payload.totalAudioDuration !== 'number' || payload.totalAudioDuration <= 0) {
        throw new Error('Invalid totalAudioDuration (must be greater than 0)');
      }
      if (!payload.audioFiles || !Array.isArray(payload.audioFiles) || payload.audioFiles.length === 0) {
        throw new Error('Missing or invalid audioFiles');
      }
    } else {
      // Word count mode validation
      if (frequencyType === 'consistent') {
        // Consistent mode: firstPageFrequency can be NULL, restFrequency holds the value
        if (typeof payload.consistentFrequency !== 'number' || payload.consistentFrequency < 5 || payload.consistentFrequency > 300) {
          throw new Error('Invalid consistentFrequency (must be 5–300)');
        }
        // Note: firstPageFrequency will be NULL in database, backend uses restFrequency
      } else {
        // Variable mode: both frequencies required
        if (typeof payload.firstPageFrequency !== 'number' || payload.firstPageFrequency < 5 || payload.firstPageFrequency > 120) {
          throw new Error('Invalid firstPageFrequency (must be 5–120)');
        }
        if (typeof payload.restFrequency !== 'number' || payload.restFrequency < 5 || payload.restFrequency > 240) {
          throw new Error('Invalid restFrequency (must be 5–240)');
        }
      }
    }
    
    if (typeof payload.variant !== 'number') throw new Error('Missing or invalid variant');
    if (typeof payload.userTokenBalance !== 'number') throw new Error('Missing or invalid userTokenBalance');
    if (!payload.imageModel || !['standard', 'plus', 'premium', 'spark', 'grok', 'prime', 'genesis', 'imagen-4-fast', 'gpt-image-1-mini', 'imagen-4-ultra', 'flux-2-dev', 'grok-imagine-image', 'seedream-4.5', 'nano-banana-pro'].includes(payload.imageModel)) {
      throw new Error('Missing or invalid imageModel');
    }
    if (!payload.language || typeof payload.language !== 'string') throw new Error('Missing or invalid language');
    if (!payload.model || typeof payload.model !== 'string') throw new Error('Missing or invalid model');

    const { 
      user_id, 
      group_id, 
      file_path, 
      story_title, 
      description, 
      style, 
      useCharacterDescriptions, 
      firstPageFrequency, 
      restFrequency, 
      variant, 
      doc_id, 
      userTokenBalance, 
      imageModel, 
      language, 
      model, 
      tab = 1,
      consistentFrequency,
      audioFiles,
      totalAudioDuration,
      imageAmount
    } = payload;

    // Use anon key from .env for Deno edge function
    console.log('Sending request to Deno edge function for processing...');
    const { data: { session: _ipSession } } = await supabase.auth.getSession();
    const denoResponse = await fetchWithFallback('https://storyscriptai-setup-prompt.storyscriptai.deno.net', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_ipSession?.access_token || ''}`,
        'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
      },
      body: JSON.stringify({
        user_id,
        group_id,
        file_path,
        story_title,
        description,
        style,
        useCharacterDescriptions,
        firstPageFrequency,
        restFrequency,
        variant,
        doc_id,
        userTokenBalance,
        imageModel,
        language,
        model,
        tab,
        // Audio mode fields
        frequencyMode,
        frequencyType,
        consistentFrequency,
        audioFiles,
        totalAudioDuration,
        imageAmount,
        audioDistributionType,
        audioFirstPageImageCount: payload.audioFirstPageImageCount,
        audioRestImageCount: payload.audioRestImageCount,
        // V2 format fields
        masterPromptData: payload.masterPromptData,
        promptFormatVersion: payload.promptFormatVersion || 2, // Default to V2
        // Custom character fields
        customCharactersEnabled: payload.customCharactersEnabled || false,
        customCharacters: payload.customCharacters || [],
        customCharactersAIEnhance: payload.customCharactersAIEnhance || false,
      }),
    });

    if (!denoResponse.ok) {
      const errorText = await denoResponse.text();
      const errorMsg = `Deno edge function failed: HTTP ${denoResponse.status} - ${errorText}`;
      console.error(errorMsg);
      await logError('Deno edge function error', new Error(errorMsg));
      throw new Error(errorMsg);
    }

    const { task_ids, total_batches, total_prompts, input_tokens, output_tokens, error } = await denoResponse.json();
    if (error) {
      const errorMsg = `Deno edge function error: ${error}`;
      console.error(errorMsg);
      await logError('Deno edge function error', new Error(errorMsg));
      throw new Error(errorMsg);
    }

    console.log(`Received from Deno: ${total_batches} batches, ${total_prompts} prompts, input_tokens=${input_tokens}, output_tokens=${output_tokens}`);

    // Check runtime
    if (Date.now() - startTime > maxRuntime) {
      const errorMsg = 'Function timed out after Deno processing';
      console.error(errorMsg);
      await logError('Function timeout', new Error(errorMsg));
      throw new Error(errorMsg);
    }

    return {
      task_ids,
      total_batches,
      total_prompts,
      input_tokens,
      output_tokens,
    };
  } catch (error: any) {
    console.error(`Error in setupImagePromptTasks: ${error.message}\nStack: ${error.stack}`);
    await logError('Error in setupImagePromptTasks', error);
    throw new Error(`Error: ${error.message || 'Internal Error'}`);
  }
}

/**
 * Calculate estimated image count from word count (matching Python logic)
 */
export function calculateEstimatedImageCountFromWordCount(
  wordCount: number,
  firstPageSeconds: number,
  restSeconds: number
): number {
  if (wordCount === 0) return 0;
  
  const totalChars = wordCount * 5; // Assume 5 characters per word
  
  // First page calculations (first ~3000 chars)
  const firstPageChars = 3000;
  const firstPageCharsPerSegment = Math.max(
    100, 
    Math.min(3000, Math.floor(firstPageSeconds * CHARS_PER_SECOND))
  );
  const firstPageSegments = Math.ceil(firstPageChars / firstPageCharsPerSegment);
  
  // Rest of pages calculations
  const remainingChars = Math.max(0, totalChars - 3000);
  const restCharsPerSegment = Math.max(100, Math.floor(restSeconds * CHARS_PER_SECOND));
  const restSegments = remainingChars > 0 ? Math.ceil(remainingChars / restCharsPerSegment) : 0;
  
  // Total image count with 18% increase (matching Python)
  const totalSegments = firstPageSegments + restSegments;
  return Math.floor(totalSegments * 1.18);
}

/**
 * Calculate estimated image count from consistent frequency
 */
export function calculateEstimatedImageCountConsistent(
  wordCount: number,
  consistentFrequencySeconds: number
): number {
  if (wordCount === 0) return 0;
  
  const totalChars = wordCount * 5; // Assume 5 characters per word
  const charsPerSegment = Math.max(100, Math.floor(consistentFrequencySeconds * CHARS_PER_SECOND));
  const segments = Math.ceil(totalChars / charsPerSegment);
  
  // Apply 18% increase (matching Python)
  return Math.floor(segments * 1.18);
}

/**
 * Calculate image limits based on audio duration
 */
export interface AudioImageLimits {
  min: number;
  max: number;
  recommended: number;
}

export function calculateAudioImageLimits(audioDurationSeconds: number): AudioImageLimits {
  if (audioDurationSeconds === 0) {
    return { min: 1, max: 1, recommended: 1 };
  }
  
  const maxImages = Math.floor(audioDurationSeconds / MIN_FREQUENCY_SECONDS);
  const recommendedImages = Math.floor(audioDurationSeconds / 10); // One image every 10 seconds
  
  return {
    min: 1,
    max: Math.max(1, maxImages),
    recommended: Math.max(1, recommendedImages)
  };
}

/**
 * Validate image amount for audio duration
 */
export function validateAudioImageAmount(
  audioDurationSeconds: number,
  imageAmount: number
): { valid: boolean; error?: string } {
  if (audioDurationSeconds === 0) {
    return { valid: false, error: 'Audio duration must be greater than 0' };
  }
  
  const limits = calculateAudioImageLimits(audioDurationSeconds);
  
  if (imageAmount < limits.min) {
    return { valid: false, error: `Minimum ${limits.min} image required` };
  }
  
  if (imageAmount > limits.max) {
    return { 
      valid: false, 
      error: `Maximum ${limits.max} images allowed (minimum ${MIN_FREQUENCY_SECONDS} seconds per image)` 
    };
  }
  
  return { valid: true };
}

/**
 * Calculate frequency in seconds for audio mode with consistent distribution
 */
export function calculateConsistentFrequencyFromAudio(
  audioDurationSeconds: number,
  imageAmount: number
): number {
  if (imageAmount === 0) return 0;
  return audioDurationSeconds / imageAmount;
}

/**
 * Estimate total tokens for audio-based image prompts (matching Python logic)
 */
export function estimateTotalTokensAudioBased(
  wordCount: number,
  totalImages: number,
  hasCharacters: boolean
): { inputTokens: number; outputTokens: number } {
  const numPrompts = totalImages;
  
  // Estimate number of batches
  const totalWordsWithPrompts = wordCount + 200 * numPrompts;
  const numBatches = Math.max(1, Math.ceil(totalWordsWithPrompts / 900));
  
  // Safety multipliers (from Python)
  const inputSafetyMultiplier = 1.25;
  const outputSafetyMultiplier = 1.0;
  
  let totalInputTokens: number;
  let totalOutputTokens: number;
  
  if (hasCharacters) {
    // Character extraction
    const charInputTokens = (wordCount + 100) * TOKEN_PER_WORD;
    const charOutputTokens = 133 * 5; // ~100 words for 5 characters
    
    // Prompt generation
    const promptInputTokens = numBatches * (wordCount + 1600) * TOKEN_PER_WORD;
    const promptOutputTokens = numPrompts * 800 * TOKEN_PER_WORD; // 800 words per prompt
    
    // Batch assignment
    const batchTokens = 665;
    
    totalInputTokens = charInputTokens + promptInputTokens + batchTokens;
    totalOutputTokens = charOutputTokens + promptOutputTokens;
  } else {
    // Prompt generation only
    const promptInputTokens = numBatches * (wordCount + 1100) * TOKEN_PER_WORD;
    const promptOutputTokens = numPrompts * 800 * TOKEN_PER_WORD; // 800 words per prompt
    
    // Batch assignment
    const batchTokens = 665;
    
    totalInputTokens = promptInputTokens + batchTokens;
    totalOutputTokens = promptOutputTokens;
  }
  
  // Apply safety multipliers
  totalInputTokens = Math.floor(totalInputTokens * inputSafetyMultiplier);
  totalOutputTokens = Math.floor(totalOutputTokens * outputSafetyMultiplier);
  
  return {
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens
  };
}




